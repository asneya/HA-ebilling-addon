"""Electrodomésticos medidos: lo que hacen ahora y lo que suele costarles un ciclo.

Un electrodoméstico aquí es un enchufe con nombre: un sensor de potencia que dice
lo que está haciendo ahora mismo y, opcionalmente, uno de energía con lo que ha
gastado hoy. Del histórico de la potencia se **aprende** el ciclo —cuánto dura y
cuántos kWh se lleva— en vez de pedirle al usuario que lo teclee, que es lo que
hacía la maqueta del diseño porque su prototipo no tenía telemetría.

Con el ciclo aprendido se puede contestar la pregunta del diseño: *¿me cabe en la
ventana de energía gratis?*, con sus tres veredictos —«Gratis», «Cabe justo» y lo
que costaría— y sus copias exactas.

Lo que **no** se hace: inventar. Un electrodoméstico sin histórico suficiente no
tiene ciclo, y sin ciclo no hay veredicto: se dice que aún se está aprendiendo. Un
número tecleado a ojo en la tarjeta que decide si pones la lavadora ahora o
después no vale más que un hueco.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta
from typing import Any

import planner
import series as series_mod

_LOGGER = logging.getLogger(__name__)

# Histórico que se pide para aprender los ciclos. El recorder guarda las
# estadísticas de cinco minutos unos diez días por defecto, así que pedir catorce
# es pedir todo lo que hay: los ciclos necesitan resolución fina —una lavadora de
# dos horas en medias horarias no se distingue de un frigorífico— y esa resolución
# solo está en la ventana corta del recorder.
_DIAS = 14
_PASO_MIN = 5

# Un ciclo tiene que durar algo y gastar algo: por debajo de esto es ruido del
# sensor o un encendido de un minuto para nada.
_MIN_MUESTRAS = 2          # 10 minutos
_MIN_KWH = 0.02
# Cuántas muestras por debajo del umbral se toleran dentro de un ciclo. Un
# lavavajillas baja a reposo entre el lavado y el secado; sin esta tolerancia un
# ciclo se contaba como tres, cada uno con un tercio de la duración.
_HUECO_TOLERADO = 3        # 15 minutos
# Con menos ciclos no se habla de «lo que suele durar»: se dice que se está
# aprendiendo.
_MIN_CICLOS = 2

# El margen del diseño entre «Gratis» y «Cabe justo»: quince minutos.
_MARGEN_H = 0.25

_cache: dict[str, Any] = {"key": None, "at": 0.0, "value": None}
_TTL = 1800.0


def _mediana(valores: list[float]) -> float:
    orden = sorted(valores)
    return orden[len(orden) // 2]


def _watts(state: dict[str, Any] | None) -> float | None:
    """Potencia en W del estado de un sensor, con su unidad."""
    if not state:
        return None
    raw = state.get("state")
    if raw in (None, "", "unknown", "unavailable"):
        return None
    try:
        valor = float(str(raw).replace(",", "."))
    except (TypeError, ValueError):
        return None
    unidad = ((state.get("attributes") or {}).get("unit_of_measurement") or "").strip().lower()
    if unidad == "kw":
        valor *= 1000.0
    # Un negativo en un enchufe es el signo al revés, no generación.
    return abs(valor)


def instantaneo(states: dict[str, Any], lista: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Lo que cada electrodoméstico está haciendo **ahora**, sin ninguna consulta.

    Sale del estado de los sensores que ya trae el payload, así que no cuesta
    nada y puede ir en /api/live, que se pide cada pocos segundos.
    """
    out = []
    for a in lista:
        entity = a.get("power_entity") or ""
        w = _watts(states.get(entity)) if entity else None
        umbral = float(a.get("standby_w") or 0)
        out.append({
            "id": a["id"], "name": a["name"], "color": a["color"], "icon": a["icon"],
            "power_entity": entity,
            "energy_entity": a.get("energy_entity") or "",
            "standby_w": umbral,
            "watts": None if w is None else round(w, 1),
            # «En marcha» y no «encendido»: un aparato enchufado consume dos o
            # tres vatios todo el día y eso no es estar funcionando.
            "running": bool(w is not None and w > umbral),
        })
    return out


def _ciclos_de(muestras: list[tuple[datetime, float]], umbral: float
               ) -> list[dict[str, Any]]:
    """Parte la curva de potencia en ciclos: tramos seguidos por encima del umbral.

    Devuelve, por ciclo, cuándo empezó, cuánto duró (horas) y cuántos kWh se
    llevó. El hueco tolerado permite que un programa con pausas cuente como uno.
    """
    paso_h = _PASO_MIN / 60.0
    ciclos: list[dict[str, Any]] = []
    actual: list[tuple[datetime, float]] = []
    hueco = 0

    def cerrar() -> None:
        nonlocal actual, hueco
        # Se recorta la cola: las muestras en reposo que hicieron falta para saber
        # que el ciclo había acabado no son parte del ciclo. Sin recortarlas, cada
        # ciclo salía quince minutos más largo de lo que duró —el horno de una
        # hora medía 1,25— y ese cuarto de hora es justo el margen con el que se
        # decide si algo cabe en la ventana.
        while actual and actual[-1][1] <= umbral:
            actual.pop()
        if actual:
            kwh = sum(w for _t, w in actual) * paso_h / 1000.0
            if len(actual) >= _MIN_MUESTRAS and kwh >= _MIN_KWH:
                ciclos.append({
                    "start": actual[0][0],
                    "end": actual[-1][0] + timedelta(minutes=_PASO_MIN),
                    "hours": len(actual) * paso_h,
                    "kwh": kwh,
                    "peak_w": max(w for _t, w in actual),
                })
        actual = []
        hueco = 0

    for moment, w in muestras:
        if w > umbral:
            actual.append((moment, w))
            hueco = 0
        elif actual:
            hueco += 1
            if hueco > _HUECO_TOLERADO:
                cerrar()
            else:
                # El hueco se queda dentro del ciclo: su consumo es el real (casi
                # cero), pero su tiempo cuenta, porque el programa sigue puesto.
                actual.append((moment, max(w, 0.0)))
    cerrar()
    return ciclos


def _resumen(ciclos: list[dict[str, Any]], dias: int) -> dict[str, Any] | None:
    """Lo que suele durar y gastar un ciclo: medianas, no medias.

    La mediana porque un día que la lavadora se quedó puesta el doble no tiene que
    alargar la previsión de todos los demás. ``None`` si aún no hay bastantes
    ciclos para decir «suele».
    """
    if len(ciclos) < _MIN_CICLOS:
        return None
    horas = _mediana([c["hours"] for c in ciclos])
    kwh = _mediana([c["kwh"] for c in ciclos])
    return {
        "hours": round(horas, 2),
        "kwh": round(kwh, 3),
        "peak_w": round(max(c["peak_w"] for c in ciclos), 0),
        "cycles": len(ciclos),
        "days": dias,
        # Cuándo suele ponerse: con eso el consejo puede decir «lo pones a las
        # 22 h y te sale a punta».
        "usual_hour": _mediana([c["start"].hour + c["start"].minute / 60 for c in ciclos]),
        "last": ciclos[-1]["start"].isoformat() if ciclos else None,
    }


async def learn(
    settings: dict[str, Any],
    states: dict[str, Any],
    lista: list[dict[str, Any]],
    tz,
    now: datetime,
) -> dict[str, dict[str, Any]]:
    """Aprende el ciclo típico de cada electrodoméstico, con caché.

    Una sola llamada a ``ws_statistics`` para todos: cada llamada abre un socket y
    se trae la lista entera de metadatos, así que pedir uno por aparato costaría
    tantas veces lo mismo como aparatos haya.
    """
    ids = [a["power_entity"] for a in lista if a.get("power_entity")]
    if not ids:
        return {}
    key = "|".join(sorted(ids)) + "@" + now.strftime("%Y-%m-%d-%H")
    if _cache["key"] == key and time.monotonic() - _cache["at"] < _TTL:
        return _cache["value"]

    medianoche = now.replace(hour=0, minute=0, second=0, microsecond=0)
    out: dict[str, dict[str, Any]] = {}
    try:
        results, units = await series_mod.ws_statistics(
            settings,
            [{"ids": list(dict.fromkeys(ids)),
              "start": medianoche - timedelta(days=_DIAS),
              "end": now, "period": "5minute", "types": ["mean"]}],
        )
        for a in lista:
            entity = a.get("power_entity") or ""
            if not entity:
                continue
            factor = series_mod._unit_factor(entity, states, "power", units)
            filas = series_mod._extract(results[0], entity, "mean", tz, factor)
            if not filas:
                continue
            muestras = [
                (datetime.fromisoformat(k), max(v, 0.0))
                for k, v in sorted(filas.items())
            ]
            ciclos = _ciclos_de(muestras, float(a.get("standby_w") or 0))
            resumen = _resumen(ciclos, _DIAS)
            hoy = [c for c in ciclos if c["start"] >= medianoche]
            out[a["id"]] = {
                "cycle": resumen,
                # Los ciclos de hoy, para el cierre del día: cuándo se puso cada
                # cosa y cuánto se llevó.
                "today": [
                    {"start": c["start"].isoformat(), "end": c["end"].isoformat(),
                     "hours": round(c["hours"], 2), "kwh": round(c["kwh"], 3)}
                    for c in hoy
                ],
                "today_kwh": round(sum(c["kwh"] for c in hoy), 3),
            }
    except Exception:  # noqa: BLE001 - sin histórico no hay consejo, y ya está
        _LOGGER.warning("No se pudieron aprender los ciclos", exc_info=True)
        return _cache["value"] or {}

    _cache.update({"key": key, "at": time.monotonic(), "value": out})
    return out


# Por debajo de esto, lo que no pone el sol no cambia el veredicto: son decenas
# de vatios-hora de redondeo entre dos maneras de contar la misma cosa.
_MIGAJA_KWH = 0.05


def _gratis_de_verdad(
    est: dict[str, Any] | None, price: float | None
) -> dict[str, Any]:
    """El veredicto de un ciclo puesto **ahora**, según de dónde saldría la energía.

    Existe por una queja con tres capturas. La tarjeta decía «A/C Dormitorios ·
    **Gratis** · ahora mismo» y dos líneas más arriba, ella misma: «1,66 de sol ·
    **1,1 kWh de batería**». Con la batería al 21 % y el inversor sin bajar del 20.
    Ni era gratis ni esos 1,1 kWh existían.

    El veredicto se decidía **solo con el reloj**: si el ciclo cabía en las horas
    que le quedaban a la ventana, «Gratis». La energía la calculaba `estimate`, al
    lado, y nadie las cruzaba — la misma enfermedad que el plan y la ventana tenían
    en la 0.48.0, en la misma pantalla y con dos números que se desmienten.

    Ahora el veredicto **es** el resumen de esa estimación:

      · el sol lo cubre → «Gratis», que es verdad
      · lo cubre el sol y la batería → «De la batería», con lo que costaría
        reponerla: gastarla ahora es comprarla esta noche
      · hace falta la red → lo que cuesta, en euros

    Sin estimación —sin previsión solar o sin perfil de la casa— no se puede
    contestar, y entonces se conserva el veredicto de siempre en vez de callar: que
    el ciclo quepa en la ventana sigue siendo cierto y sigue sirviendo.
    """
    if not est:
        return {"kind": "gratis", "value": "Gratis", "sub": "ahora mismo"}
    de_red = float(est.get("grid_kwh") or 0.0)
    de_bat = float(est.get("battery_kwh") or 0.0)
    total = float(est.get("total_kwh") or 0.0)
    del_sol = float(est.get("sun_kwh") or 0.0)
    pct_sol = round(del_sol / total * 100) if total > 0 else 0

    if de_red <= _MIGAJA_KWH and de_bat <= _MIGAJA_KWH:
        return {"kind": "gratis", "value": "Gratis", "sub": "lo pone el sol"}
    if de_red > _MIGAJA_KWH:
        # Hay que comprar. El precio de la batería es el mismo: lo que se saque de
        # ella hay que reponerlo, así que se suma en la cifra que se enseña.
        coste = None
        if price is not None:
            coste = round((de_red + de_bat) * price, 2)
        return {"kind": "parcial", "value": coste,
                "sub": (f"{pct_sol} % lo pone el sol" if pct_sol
                        else "el sol no llega a cubrirlo")}
    # Solo batería. No es gratis —se repone comprando— pero tampoco es comprar
    # ahora, y la diferencia importa: se puede decidir gastarla a sabiendas.
    return {
        "kind": "bateria",
        "value": None if price is None else round(de_bat * price, 2),
        "sub": (f"{pct_sol} % el sol, el resto de la batería" if pct_sol
                else "entero de la batería"),
    }


def verdict(
    cycle: dict[str, Any] | None,
    window: dict[str, Any] | None,
    now: datetime,
    price: float | None,
    est: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """¿Cabe el ciclo en la ventana, y de dónde saldría su energía?

    Las copias y el margen de quince minutos entre «Gratis» y «Cabe justo» son los
    de la maqueta. Lo que se ha añadido después es que **cuando la ventana ya está
    abierta, el veredicto lo decide la energía** (ver `_gratis_de_verdad`) y no solo
    que el ciclo quepa en el tiempo que queda.

    ``est`` es la estimación **del momento del que habla el veredicto**: si la
    ventana ya está abierta es la de ahora, y si abre más tarde es la de esa hora.
    Da igual cuál sea: lo que no puede volver a pasar es prometer «Gratis» sin
    haber mirado de dónde saldría la energía, ni antes ni dentro de dos horas.
    """
    if not cycle:
        return {"kind": "aprendiendo", "value": "—",
                "sub": "aún no hay ciclos suficientes"}
    hoy = (window or {}).get("today") or {}
    if not hoy.get("start") or not hoy.get("end"):
        return {"kind": "sin-ventana", "value": "—", "sub": "hoy no hay ventana"}

    inicio = datetime.fromisoformat(hoy["start"])
    fin = datetime.fromisoformat(hoy["end"])
    dur = float(cycle["hours"])
    kwh = float(cycle["kwh"])

    if now >= fin:
        # Cerrada: ya no es «cuánto te cabe» sino «cuánto te cuesta ahora».
        return {"kind": "cerrada",
                "value": None if price is None else round(kwh * price, 2),
                "sub": "la ventana ya cerró"}

    desde = max(now, inicio)
    queda = max(0.0, (fin - desde).total_seconds() / 3600.0)
    if dur <= queda - _MARGEN_H:
        fallo = _gratis_de_verdad(est, price)
        if now < inicio:
            # Cabe, pero desde que abra. Si la energía de esa hora no da para
            # llamarlo gratis, se dice igual: lo único que cambia es el «cuándo».
            if fallo["kind"] == "gratis":
                return {"kind": "gratis", "value": "Gratis",
                        "sub": f"desde las {inicio:%H:%M}"}
            return {**fallo, "sub": f"{fallo['sub']} · desde las {inicio:%H:%M}"}
        return fallo
    if dur <= queda:
        return {"kind": "justo", "value": "Cabe justo",
                "sub": "empieza ya" if now >= inicio else "sal puntual"}
    # No cabe entero: se paga la parte que se sale.
    fuera = 1.0 - (queda / dur if dur > 0 else 0.0)
    return {
        "kind": "parcial",
        "value": None if price is None else round(kwh * fuera * price, 2),
        "sub": f"{round(queda / dur * 100) if dur > 0 else 0} % gratis",
    }


def advice(
    lista: list[dict[str, Any]],
    aprendido: dict[str, dict[str, Any]],
    window: dict[str, Any] | None,
    now: datetime,
    price: float | None,
    fuentes: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """La tarjeta «Cabe en la ventana»: una fila por electrodoméstico.

    ``fuentes`` es lo que hace falta para estimar de dónde saldría la energía si
    se pusiera **ahora** —previsión de sol, consumo típico de la casa, carga de la
    batería y su capacidad—; sin ella las filas salen igual, solo sin ese renglón.

    ``None`` si no hay ningún electrodoméstico dado de alta: la tarjeta entera se
    esconde antes que enseñar una lista vacía.
    """
    if not lista:
        return None
    hoy = (window or {}).get("today") or {}
    fin = datetime.fromisoformat(hoy["end"]) if hoy.get("end") else None
    cerrada = bool(fin and now >= fin)
    # El momento del que habla el veredicto: ahora si la ventana está abierta, y
    # la hora de apertura si abre más tarde. Es el instante que hay que simular
    # para poder decir «Gratis» sin mentir.
    abre = datetime.fromisoformat(hoy["start"]) if hoy.get("start") else None
    del_veredicto = max(now, abre) if abre and abre > now else now
    filas = []
    for a in lista:
        datos = aprendido.get(a["id"]) or {}
        ciclo = datos.get("cycle")
        # La estimación **primero**, y el veredicto a partir de ella: así no pueden
        # discrepar por construcción, que es de lo que venía la queja.
        #
        # Dos, cuando la ventana abre más tarde: la de la fila habla de ponerlo
        # ahora —es lo que dice su renglón— y la del veredicto, de la hora que
        # propone. Con una sola, una de las dos frases sería falsa.
        est = estimate(ciclo, now, price, fuentes)
        est_ver = (est if del_veredicto == now
                   else estimate(ciclo, del_veredicto, price, fuentes))
        filas.append({
            "id": a["id"], "name": a["name"], "color": a["color"], "icon": a["icon"],
            "cycle": ciclo,
            "today_kwh": datos.get("today_kwh"),
            "runs_today": len(datos.get("today") or []),
            "verdict": verdict(ciclo, window, now, price, est_ver),
            "estimate": est,
        })
    # Primero lo que cabe gratis: es la respuesta que se ha venido a buscar.
    orden = {"gratis": 0, "bateria": 1, "justo": 2, "parcial": 3, "cerrada": 4,
             "sin-ventana": 5, "aprendiendo": 6}
    filas.sort(key=lambda f: (orden.get(f["verdict"]["kind"], 9), f["name"]))
    return {
        "title": "Lo que te costaría ahora" if cerrada else "Cabe en la ventana",
        "closed": cerrada,
        "rows": filas,
        # La reserva del inversor, para poder decirlo cuando está mordiendo. Es la
        # explicación de por qué una batería «al 21 %» no puede dar nada, y sin
        # enseñarla las cifras de arriba parecen equivocadas.
        "battery": _estado_bateria(fuentes),
    }


def _estado_bateria(fuentes: dict[str, Any] | None) -> dict[str, Any] | None:
    """Carga, reserva y lo que queda por encima de ella. ``None`` si no se sabe."""
    if not fuentes:
        return None
    soc = fuentes.get("soc")
    usable = fuentes.get("usable_kwh")
    if soc is None or usable is None:
        return None
    reserva = float(fuentes.get("reserve_pct") or 0.0)
    return {
        "soc": round(float(soc), 1),
        "reserve_pct": round(reserva, 1),
        "usable_kwh": round(float(usable), 2),
        # `True` cuando la reserva es la que manda: la batería figura con carga y
        # no puede entregar nada. Es el caso que hacía falta explicar.
        # Se mide en puntos de carga y no en kilovatios: el suelo está puesto en
        # porcentaje, y «al 21 % con el mínimo en el 20» es lo que cualquiera lee
        # como «está en su reserva». Un umbral en kWh diría otra cosa según la
        # capacidad. El caso de «queda poco pero algo» lo cuenta la propia cifra
        # de `usable_kwh`, que es más precisa que una etiqueta.
        "at_reserve": reserva > 0 and float(soc) <= reserva + 1.0,
    }


# Paso de la simulación de un ciclo. Cinco minutos es el paso de todo lo demás
# —las estadísticas, las curvas del flujo— y da de sobra para un ciclo de horas.
_PASO_SIM_H = 5 / 60


def estimate(
    cycle: dict[str, Any] | None,
    now: datetime,
    price: float | None,
    fuentes: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """De dónde saldría la energía de un ciclo puesto **ahora**: sol, batería o red.

    Contesta la pregunta que la ventana no contesta. «Cabe en la ventana» dice si
    hay hueco de sol; esto dice qué pasa con lo que el sol no cubra, que en una
    casa con batería no es lo mismo que comprarlo: sale de lo que tenías guardado
    para la noche. Y lo pone en euros al precio de importar, que es lo que ese
    kilovatio de batería vale — porque el que gastes ahora lo tendrás que comprar
    luego.

    Cómo se estima, minuto a minuto del ciclo:

      · el sol que se espera sale de la **previsión corregida con la producción
        real de ahora**: un día de nubes que la previsión no vio se lleva su
        factor de corrección, así que no promete un sol que no está;
      · el consumo de la casa, del perfil horario (la mediana de esa hora), que ya
        es lo que usa la ventana;
      · el aparato tira de su media (kWh del ciclo entre sus horas): no se finge
        conocer la forma de su programa;
      · lo que el sol no cubra lo pone la batería mientras le quede, y lo que no,
        la red. Si sobra sol por encima del aparato, la batería se **carga**, que
        es lo que pasaría de verdad y mejora la cuenta de una tarde soleada.

    ``None`` si no hay ciclo aprendido o no hay con qué estimar.
    """
    if not cycle or not fuentes:
        return None
    sol_at = fuentes.get("sol_at")
    casa_at = fuentes.get("casa_at")
    if not sol_at or not casa_at:
        return None

    horas = float(cycle["hours"])
    kwh = float(cycle["kwh"])
    if horas <= 0 or kwh <= 0:
        return None
    aparato_w = kwh * 1000.0 / horas

    capacidad = float(fuentes.get("capacity_kwh") or 0.0)
    # Lo que la batería puede dar ahora, en kWh: lo que hay **por encima de su
    # reserva**, que es lo único que el inversor va a entregar. Antes era la batería
    # entera, y con el estado de carga en la reserva se ofrecían kilovatios que no
    # existen: de ahí salía un «Gratis» con 1,1 kWh de una batería al 21 % que no
    # baja del 20. `None` = no se puede saber, y entonces batería y red van juntas.
    guardado = planner.guardado_utilizable(fuentes)
    reserva = float(fuentes.get("reserve_pct") or 0.0)
    # Y el techo de la batería para lo que se recargue durante el ciclo también
    # baja: por debajo de la reserva no se puede contar con nada.
    tope = capacidad * max(0.0, 100.0 - reserva) / 100.0

    del_sol = de_bat = de_red = 0.0
    restante = guardado
    pasos = max(1, int(round(horas / _PASO_SIM_H)))
    # El paso se reparte, no se fija: con uno fijo un ciclo de 1,9 h se simulaba
    # en ocho cuartos de hora —2,0 h— y la suma del reparto no cuadraba con la
    # energía aprendida, así que se veía «104 % lo pone el sol».
    paso_h = horas / pasos
    for i in range(pasos):
        momento = now + timedelta(hours=i * paso_h)
        sol = max(0.0, sol_at(momento))
        casa = max(0.0, casa_at(momento))
        sobra = max(0.0, sol - casa)
        sol_ap = min(aparato_w, sobra)
        falta = aparato_w - sol_ap
        del_sol += sol_ap * paso_h / 1000.0
        if falta <= 0:
            # Lo que sobre por encima del aparato carga la batería.
            if restante is not None and capacidad > 0:
                restante = min(tope, restante + (sobra - sol_ap) * paso_h / 1000.0)
            continue
        pide = falta * paso_h / 1000.0
        if restante is None:
            de_bat += pide            # sin capacidad: no se puede separar
        else:
            usa = min(pide, restante)
            de_bat += usa
            restante -= usa
            de_red += pide - usa

    total = del_sol + de_bat + de_red
    return {
        "sun_kwh": round(del_sol, 2),
        "battery_kwh": round(de_bat, 2),
        "grid_kwh": round(de_red, 2),
        # Qué parte de la batería es eso, para que el número signifique algo.
        "battery_pct": round(de_bat / capacidad * 100) if capacidad > 0 else None,
        # El equivalente en euros de lo que **no** pone el sol, al precio de
        # importar: es lo que costaría comprar eso mismo a la red.
        "battery_eur": None if price is None else round(de_bat * price, 2),
        "grid_eur": None if price is None else round(de_red * price, 2),
        # `False` cuando no hay capacidad configurada: entonces «batería» es en
        # realidad «batería o red» y la interfaz no puede decir cuál.
        "split": restante is not None,
        "total_kwh": round(total, 2),
    }


def del_cierre(
    lista: list[dict[str, Any]],
    aprendido: dict[str, dict[str, Any]],
    window: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """Qué se ha puesto hoy y cuánto de cada cosa cayó dentro de la ventana.

    Es la pregunta del cierre del día llevada al detalle: no solo «has aprovechado
    el 64 % del consumo» sino *qué* lo aprovechó y qué no. Se reparte cada ciclo
    por el solape con la ventana, en vez de mirar solo la hora de inicio: una
    lavadora que empieza dentro y acaba fuera no es ni todo gratis ni todo pagado.
    """
    hoy = (window or {}).get("today") or {}
    inicio = datetime.fromisoformat(hoy["start"]) if hoy.get("start") else None
    fin = datetime.fromisoformat(hoy["end"]) if hoy.get("end") else None
    filas = []
    for a in lista:
        ciclos = (aprendido.get(a["id"]) or {}).get("today") or []
        if not ciclos:
            continue
        total = 0.0
        dentro = 0.0
        for c in ciclos:
            kwh = float(c.get("kwh") or 0.0)
            total += kwh
            if not (inicio and fin):
                continue
            c0 = datetime.fromisoformat(c["start"])
            c1 = datetime.fromisoformat(c["end"])
            solape = (min(c1, fin) - max(c0, inicio)).total_seconds()
            largo = (c1 - c0).total_seconds()
            if solape > 0 and largo > 0:
                dentro += kwh * (solape / largo)
        filas.append({
            "id": a["id"], "name": a["name"], "color": a["color"], "icon": a["icon"],
            "runs": len(ciclos),
            "kwh": round(total, 2),
            "in_window_kwh": round(dentro, 2) if (inicio and fin) else None,
            "pct": round(dentro / total * 100) if total > 0 and inicio and fin else None,
        })
    filas.sort(key=lambda f: -f["kwh"])
    return filas

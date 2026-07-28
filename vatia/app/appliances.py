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


def verdict(
    cycle: dict[str, Any] | None,
    window: dict[str, Any] | None,
    now: datetime,
    price: float | None,
) -> dict[str, Any]:
    """¿Cabe el ciclo en la ventana? Los tres veredictos del diseño.

    Portado tal cual de la maqueta, incluidas las copias y el margen de quince
    minutos entre «Gratis» y «Cabe justo». Lo único que cambia es de dónde salen
    la duración y los kWh: allí se teclean, aquí se han medido.
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
        return {"kind": "gratis", "value": "Gratis",
                "sub": "ahora mismo" if now >= inicio else f"desde las {inicio:%H:%M}"}
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
) -> dict[str, Any] | None:
    """La tarjeta «Cabe en la ventana»: una fila por electrodoméstico.

    ``None`` si no hay ningún electrodoméstico dado de alta: la tarjeta entera se
    esconde antes que enseñar una lista vacía.
    """
    if not lista:
        return None
    hoy = (window or {}).get("today") or {}
    fin = datetime.fromisoformat(hoy["end"]) if hoy.get("end") else None
    cerrada = bool(fin and now >= fin)
    filas = []
    for a in lista:
        datos = aprendido.get(a["id"]) or {}
        ciclo = datos.get("cycle")
        filas.append({
            "id": a["id"], "name": a["name"], "color": a["color"], "icon": a["icon"],
            "cycle": ciclo,
            "today_kwh": datos.get("today_kwh"),
            "runs_today": len(datos.get("today") or []),
            "verdict": verdict(ciclo, window, now, price),
        })
    # Primero lo que cabe gratis: es la respuesta que se ha venido a buscar.
    orden = {"gratis": 0, "justo": 1, "parcial": 2, "cerrada": 3, "sin-ventana": 4,
             "aprendiendo": 5}
    filas.sort(key=lambda f: (orden.get(f["verdict"]["kind"], 9), f["name"]))
    return {
        "title": "Lo que te costaría ahora" if cerrada else "Cabe en la ventana",
        "closed": cerrada,
        "rows": filas,
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

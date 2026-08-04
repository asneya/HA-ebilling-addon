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
# sensor o un encendido de un minuto para nada. La duración va en minutos por lo
# mismo que la tolerancia: el paso ya no es siempre de cinco.
_MIN_DURACION_MIN = 10
_MIN_KWH = 0.02
# Cuánto reposo se tolera dentro de un ciclo. Un lavavajillas baja a reposo entre el
# lavado y el secado; sin esta tolerancia un ciclo se contaba como tres, cada uno con
# un tercio de la duración.
#
# Va en **minutos** y no en muestras porque el paso ya no es siempre de cinco: con
# InfluxDB se puede recorrer un mes entero con un paso más grueso, y una tolerancia
# contada en muestras valdría quince minutos con un paso y una hora con otro.
_HUECO_TOLERADO_MIN = 15
# Con menos ciclos no se habla de «lo que suele durar»: se dice que se está
# aprendiendo.
_MIN_CICLOS = 2

# El margen del diseño entre «Gratis» y «Cabe justo»: quince minutos.
_MARGEN_H = 0.25

_cache: dict[str, Any] = {"key": None, "at": 0.0, "value": None, "forced": 0.0}
_TTL = 1800.0
# Cada cuánto, como mucho, un arranque puede saltarse la caché. Ver
# `_ha_arrancado_algo`: sin este suelo, los primeros minutos de un ciclo —cuando
# todavía no hay ni un tramo de cinco minutos en las estadísticas— pedirían el
# histórico de catorce días en cada payload.
_MIN_ENTRE_FORZADOS = 180.0


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


def _ciclos_de(muestras: list[tuple[datetime, float]], umbral: float,
               paso_min: int = _PASO_MIN) -> list[dict[str, Any]]:
    """Parte la curva de potencia en ciclos: tramos seguidos por encima del umbral.

    Devuelve, por ciclo, cuándo empezó, cuánto duró (horas) y cuántos kWh se
    llevó. El hueco tolerado permite que un programa con pausas cuente como uno.

    El último puede venir con ``open`` en cierto: es el que **sigue en marcha**
    cuando se acaban las muestras. Se marca porque no es lo mismo que los demás y
    tratarlo igual era un fallo silencioso: una lavadora de dos horas que llevaba
    veinte minutos entraba en la lista como «un ciclo de veinte minutos» y de ahí
    salía la mediana de «lo que suele durar». Con seis ciclos en catorce días —una
    lavadora normal— la mediana es la media del tercero y el cuarto, así que uno
    truncado la mueve. Sus horas y sus kWh son los de **hasta ahora**, que es
    exactamente lo que hace falta para decir por dónde va.
    """
    paso_h = paso_min / 60.0
    # La tolerancia, del reposo que se aguanta a las muestras que son con este paso.
    # Al menos una: con un paso más grueso que la tolerancia, un hueco de una muestra
    # ya es más largo de lo que se tolera, y sin el suelo no se toleraría ninguno y un
    # programa con pausas volvería a contarse como varios ciclos.
    tolerado = max(1, round(_HUECO_TOLERADO_MIN / paso_min))
    minimas = max(1, round(_MIN_DURACION_MIN / paso_min))
    ciclos: list[dict[str, Any]] = []
    actual: list[tuple[datetime, float]] = []
    hueco = 0

    def cerrar(sigue: bool = False) -> None:
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
            if len(actual) >= minimas and kwh >= _MIN_KWH:
                ciclos.append({
                    "start": actual[0][0],
                    "end": actual[-1][0] + timedelta(minutes=paso_min),
                    "hours": len(actual) * paso_h,
                    "kwh": kwh,
                    "peak_w": max(w for _t, w in actual),
                    "open": sigue,
                })
        actual = []
        hueco = 0

    for moment, w in muestras:
        if w > umbral:
            actual.append((moment, w))
            hueco = 0
        elif actual:
            hueco += 1
            if hueco > tolerado:
                cerrar()
            else:
                # El hueco se queda dentro del ciclo: su consumo es el real (casi
                # cero), pero su tiempo cuenta, porque el programa sigue puesto.
                actual.append((moment, max(w, 0.0)))
    # Si al acabar las muestras queda algo abierto, es que sigue en marcha: el
    # último tramo caliente cae dentro del hueco tolerado desde el final. Los que
    # ya habían terminado cerraron dentro del bucle y aquí no queda nada de ellos.
    cerrar(sigue=True)
    return ciclos


def _resumen(ciclos: list[dict[str, Any]], dias: int) -> dict[str, Any] | None:
    """Lo que suele durar y gastar un ciclo: medianas, no medias.

    La mediana porque un día que la lavadora se quedó puesta el doble no tiene que
    alargar la previsión de todos los demás. ``None`` si aún no hay bastantes
    ciclos para decir «suele».

    **Solo con los ciclos terminados.** El que está en marcha no ha durado todavía
    lo que va a durar, así que meterlo aquí es meter un número que aún no existe:
    con una lavadora recién puesta, «suele durar 2 h» se convertía en «1 h 10».
    Por eso se filtra aquí, donde se calcula la mediana, y no en cada sitio que
    pide ciclos: el que reparte por horas o suma kWh de hoy **sí** los quiere
    todos, porque esa energía se ha gastado de verdad.
    """
    cerrados = [c for c in ciclos if not c.get("open")]
    if len(cerrados) < _MIN_CICLOS:
        return None
    horas = _mediana([c["hours"] for c in cerrados])
    kwh = _mediana([c["kwh"] for c in cerrados])
    return {
        "hours": round(horas, 2),
        "kwh": round(kwh, 3),
        "peak_w": round(max(c["peak_w"] for c in cerrados), 0),
        "cycles": len(cerrados),
        "days": dias,
        # Cuándo suele ponerse: con eso el consejo puede decir «lo pones a las
        # 22 h y te sale a punta».
        "usual_hour": _mediana([c["start"].hour + c["start"].minute / 60 for c in cerrados]),
        "last": cerrados[-1]["start"].isoformat(),
        # Lo corto y lo largo que llega a ser, que es lo que decide si de este
        # aparato se puede decir «termina a las 19:40» o solo «suele durar entre
        # una hora y dos y media». Una mediana sola no distingue un horno —siempre
        # lo mismo— de una lavadora con cinco programas.
        "hours_min": round(min(c["hours"] for c in cerrados), 2),
        "hours_max": round(max(c["hours"] for c in cerrados), 2),
    }


# ── Qué clase de aparato es ────────────────────────────────────────────────
#
# Tres formas de uso, porque son **tres preguntas distintas** y hasta ahora se les
# hacía la misma:
#
#   · `movible`  — lavadora, lavavajillas, coche. Tiene ciclo y se puede elegir
#     cuándo ponerlo, así que la pregunta es «¿a qué hora?».
#   · `fijo`     — el aire acondicionado. Tiene ciclo, pero no se mueve a
#     voluntad: lo quieres cuando hace calor, no a las 14:00 porque es cuando
#     pica el sol. La pregunta es «¿cuánto me cuesta ahora?», sin recomendar hora.
#   · `continuo` — nevera, congelador, router. No hay ciclo ni hora que elegir: la
#     pregunta es «¿cuánto lleva hoy y de dónde salió?».
#
# **Esto no era un hueco: estaba roto.** Una nevera de verdad (compresor 18 min sí,
# 27 no) produce 32 «ciclos» al día, y de ahí salía un ciclo típico de «0 h 20 min ·
# 0,03 kWh». Con eso la tarjeta decía «Nevera · Gratis · lo pone el sol» y el plan
# le calculaba una hora óptima para encender la nevera. No le faltaba información:
# contestaba con total confianza a una pregunta que no existe.
#
# Se detecta con dos señales medidas sobre siete días, y hacen falta las dos porque
# cada una se le escapa un caso:
#
#   nevera   32,00 ciclos/día · encendida el 44 % del tiempo
#   router    0,14 ciclos/día · encendido el 100 %
#   aire      3,00 ciclos/día · encendido el 17 %
#   lavadora  0,43 ciclos/día · encendida el  2 %
#
# Los ciclos por día cazan la nevera y se le escapa el router —un aparato de
# consumo constante da **un** ciclo de 168 horas—; el tiempo encendido caza el
# router. Y el corte en 6 cae en un hueco de 5× entre el aire (3) y la nevera (32).
#
# `fijo` **no se detecta**, y no es un olvido: no es una propiedad de la curva de
# potencia sino una decisión de quien vive en la casa. Sale de su ficha.
CICLOS_DIA_CONTINUO = 6.0
ENCENDIDO_CONTINUO = 0.9
FORMAS = ("movible", "fijo", "continuo")


def forma_de_uso(
    muestras: list[tuple[datetime, float]],
    umbral: float,
    ciclos: list[dict[str, Any]],
    dias: int,
) -> str:
    """``"continuo"`` o ``"movible"``, mirando la curva de potencia.

    Nunca devuelve ``"fijo"``: eso no se puede ver en los vatios (ver la nota de
    arriba). Con pocas muestras se dice `movible`, que es lo que la aplicación
    hacía siempre y deja la puerta abierta a aprender.

    Aquí los ciclos se cuentan **todos**, también el que sigue en marcha, y es a
    propósito: el ciclo del router es uno de 168 horas que nunca cierra, así que
    descontarlo lo dejaría en cero ciclos y se perdería el 0,14 al día que explica
    por qué esta señal sola no lo caza. Contar uno de más entre los 224 de una
    nevera no cambia nada.
    """
    if not muestras or dias <= 0:
        return "movible"
    encendido = sum(1 for _t, w in muestras if w > umbral) / len(muestras)
    por_dia = len(ciclos) / dias
    if encendido >= ENCENDIDO_CONTINUO or por_dia >= CICLOS_DIA_CONTINUO:
        return "continuo"
    return "movible"


def _por_horas_hoy(
    muestras: list[tuple[datetime, float]], desde: datetime, now: datetime
) -> dict[str, float]:
    """kWh hora a hora entre ``desde`` y ``now``, integrando la potencia.

    Para un aparato continuo esto **sustituye** a los ciclos: es lo que ha gastado
    de verdad, y con el reparto horario de la casa se le puede decir de dónde salió.
    Las claves van como texto porque el payload es JSON y ahí las claves numéricas
    no existen.

    Y por eso ``desde`` no puede ser anterior a la medianoche de hoy: la clave es
    la hora del día, así que las 23:00 de ayer y las de hoy caerían en el mismo
    sitio. Un ciclo que viene de ayer —un coche cargando de noche— solo puede
    contar con su parte de hoy, y quien lo llame se encarga de recortarlo.
    """
    paso_h = _PASO_MIN / 60.0
    out: dict[str, float] = {}
    for momento, w in muestras:
        if momento < desde or momento > now:
            continue
        clave = str(momento.hour)
        out[clave] = out.get(clave, 0.0) + max(w, 0.0) * paso_h / 1000.0
    return {k: round(v, 4) for k, v in out.items()}


def atribuir_por_horas(
    por_hora: dict[str, float] | None,
    reparto: dict[str, dict[str, float]] | None,
    precio_de: Any = None,
) -> dict[str, Any] | None:
    """De dónde salió, hora a hora, la energía que un aparato **ya ha gastado**.

    Lo que pasó no se puede simular, así que se **atribuye**: lo que la nevera
    gastó a las tres salió del mismo sitio que el resto de la casa a las tres, en
    la misma proporción. Es la única atribución defendible sin un contador de
    origen por aparato, y es la misma cuenta que necesitaría un desglose de la
    factura.

    Vale para las dos cosas que hay que contar hacia atrás, y es la misma cuenta:
    lo que lleva hoy un continuo —que no tiene «hora óptima» que recomendar, tiene
    consumo— y lo que lleva de este ciclo un aparato que está en marcha ahora
    mismo. Se llamaba `dia_de_un_continuo` cuando solo servía para lo primero.

    ``precio_de(iso)`` da el precio de esa hora, si se sabe. El coste se cobra
    **solo de la red**: lo que puso el sol no costó nada, y lo que puso la batería
    se valora aparte porque hay que reponerlo — igual que en la estimación de un
    ciclo.

    ``None`` si no hay consumo medido hoy o no hay reparto con el que atribuir.
    """
    if not por_hora or not reparto:
        return None
    # El reparto viene indexado por el ISO de la hora; se reindexa por hora del día
    # para poder cruzarlo con lo del aparato, que va por hora. Solo vale porque el
    # periodo es un día: ver `_por_horas_hoy`.
    de_la_casa: dict[str, dict[str, float]] = {}
    for iso, split in reparto.items():
        try:
            hora = str(datetime.fromisoformat(iso).hour)
        except ValueError:
            continue
        de_la_casa[hora] = split
    return atribuir(por_hora, de_la_casa, precio_de)


def atribuir(
    consumo: dict[str, float] | None,
    de_la_casa: dict[str, dict[str, float]] | None,
    precio_de: Any = None,
) -> dict[str, Any] | None:
    """La cuenta de la atribución, con las dos series indexadas **igual**.

    Se separó de `atribuir_por_horas` porque hay dos espacios de claves y una sola
    cuenta: la hora del día (0-23) mientras se habla de hoy, y el ISO de la hora
    cuando se reparte un ciclo de facturación entero, donde las 23:00 del día 3 y
    las del 4 son horas distintas. Quien llama decide el índice; lo que se hace con
    él es esto, en un solo sitio.
    """
    if not consumo or not de_la_casa:
        return None

    sol = bat = red = 0.0
    coste = 0.0
    con_precio = precio_de is not None
    sin_atribuir = 0.0
    for hora, kwh in consumo.items():
        split = de_la_casa.get(hora)
        casa = (split or {}).get("home_total") or 0.0
        if not split or casa <= 0:
            # Hay consumo del aparato en una hora de la que no hay reparto: se
            # declara en vez de repartirlo a ojo.
            sin_atribuir += kwh
            continue
        # Su parte de esa hora, sin pasar de uno: un contador que marca más que el
        # total de la casa es ruido de medida, no un aparato que consume de más.
        parte = min(kwh / casa, 1.0)
        s = (split.get("from_solar") or 0.0) * parte
        b = (split.get("from_battery") or 0.0) * parte
        r = (split.get("from_grid") or 0.0) * parte
        sol, bat, red = sol + s, bat + b, red + r
        if con_precio:
            p = precio_de(hora)
            if p is None:
                con_precio = False
            else:
                coste += r * p
    total = sum(consumo.values())
    return {
        "kwh": round(total, 3),
        "sun_kwh": round(sol, 3),
        "battery_kwh": round(bat, 3),
        "grid_kwh": round(red, 3),
        # Lo que se ha quedado sin origen: horas del aparato sin reparto de la casa.
        # Se dice, en vez de repartirlo por ahí.
        "unplaced_kwh": round(sin_atribuir, 3),
        "eur": round(coste, 2) if con_precio else None,
    }


def forma(aparato: dict[str, Any], aprendido: dict[str, Any] | None) -> str:
    """La forma que vale: la de su ficha si la tiene, y si no la detectada."""
    elegida = str((aparato or {}).get("kind") or "").strip()
    if elegida in FORMAS:
        return elegida
    return str((aprendido or {}).get("detected_kind") or "movible")


# ── Un ciclo que está en marcha ────────────────────────────────────────────
#
# Cuando algo ya está funcionando, «¿a qué hora lo pongo?» está contestada y deja
# de ser la pregunta: la que queda es «¿por dónde va y qué me está costando?».
#
# Dos decisiones sobre lo que se puede afirmar:
#
#   · **El progreso va por tiempo, no por energía.** En una lavadora el
#     calentamiento está al principio, así que el 70 % de los kWh se gastan en el
#     primer tercio del programa: una barra por energía diría «casi acabando»
#     cuando lleva veinte minutos. El tiempo es el eje honesto.
#   · **Y la duración típica es una mediana sobre programas distintos.** Un rápido
#     a 30° y un algodón a 60° son el mismo enchufe, así que la barra tiene que
#     poder pasarse: al superar lo habitual se dice, en vez de quedarse clavada en
#     el 100 % fingiendo que el final es inminente.
#
# De ahí la puerta de la dispersión: una hora de fin solo se promete si los ciclos
# de ese aparato se parecen entre sí. Un horno siempre tarda lo mismo y se le puede
# decir «termina a las 19:40»; una lavadora con cinco programas, no, y entonces se
# dice lo que se sabe: «suele durar entre 1 h y 2 h 30».
_FIABLE_CICLOS = 3          # con dos, el recorrido son esos dos y no dice nada
_FIABLE_DISPERSION = 0.3    # lo corto a lo largo, sobre la mediana
# Margen antes de decir «más de lo habitual»: cinco minutos, para no saltar en el
# 100,4 % y quedarse ahí el resto del ciclo.
_MARGEN_PASADO_H = 5 / 60


def hora_de_fin_fiable(ciclo: dict[str, Any] | None) -> bool:
    """¿Se puede prometer una hora de fin para este aparato?

    Solo si sus ciclos se parecen. Es la misma disciplina que con «fijo»: cuando el
    dato no sostiene la cifra, la cifra no se dice.
    """
    if not ciclo:
        return False
    tipico = float(ciclo.get("hours") or 0.0)
    corto, largo = ciclo.get("hours_min"), ciclo.get("hours_max")
    if tipico <= 0 or corto is None or largo is None:
        return False
    if int(ciclo.get("cycles") or 0) < _FIABLE_CICLOS:
        return False
    return (float(largo) - float(corto)) <= _FIABLE_DISPERSION * tipico


def progreso(
    abierto: dict[str, Any] | None, ciclo: dict[str, Any] | None, now: datetime
) -> dict[str, Any] | None:
    """Por dónde va el ciclo que está en marcha. ``None`` si no hay ninguno.

    Lo medido y lo estimado, separados: ``elapsed_h`` y ``kwh`` son lo que lleva
    —del reloj y del contador—, y ``ends_at``/``remaining_h`` son la mediana de sus
    propios ciclos, que solo aparecen si la dispersión los sostiene. Cuando no,
    queda ``range_h``, que es lo que sí se sabe.
    """
    if not abierto or not abierto.get("start"):
        return None
    inicio = datetime.fromisoformat(abierto["start"])
    # Del reloj, no de las muestras: «lleva 42 min» es tiempo transcurrido. Las
    # muestras van en pasos de cinco minutos y se recortan las pausas, que es lo
    # correcto para medir consumo y no para contar lo que se lleva esperando.
    llevan = max(0.0, (now - inicio).total_seconds() / 3600.0)
    tipico = float((ciclo or {}).get("hours") or 0.0)
    out: dict[str, Any] = {
        "start": abierto["start"],
        "elapsed_h": round(llevan, 2),
        "kwh": abierto.get("kwh"),
        "typical_h": tipico or None,
        "pct": None, "over": False,
        "ends_at": None, "remaining_h": None, "range_h": None,
    }
    if tipico <= 0:
        # En marcha, pero sin ciclo aprendido con el que decir «por dónde va». Se
        # enseña lo que lleva y nada más: es lo que hay.
        return out
    # Sin recortar al 100 %: un programa más largo de lo habitual tiene que poder
    # verse, y la tarjeta lo dibuja hasta el borde y lo dice con palabras.
    out["pct"] = round(llevan / tipico * 100)
    out["over"] = llevan > tipico + _MARGEN_PASADO_H
    if out["over"]:
        return out
    if hora_de_fin_fiable(ciclo):
        out["ends_at"] = (inicio + timedelta(hours=tipico)).isoformat()
        out["remaining_h"] = round(max(0.0, tipico - llevan), 2)
    else:
        out["range_h"] = [ciclo.get("hours_min"), ciclo.get("hours_max")]
    return out


def _ha_arrancado_algo(
    valor: dict[str, dict[str, Any]] | None,
    states: dict[str, Any],
    lista: list[dict[str, Any]],
) -> bool:
    """¿Hay algo en marcha de lo que lo aprendido no sabe nada?

    Lo aprendido se guarda media hora, y eso está bien para «lo que suele durar»
    —no cambia de un rato a otro— pero no para el ciclo que **acaba de empezar**:
    sin esto, una lavadora puesta a y cinco no enseñaba por dónde iba hasta media
    hora después, con el programa a medias. Cuando arranca algo, lo aprendido queda
    viejo y se vuelve a aprender: son dos o tres veces al día por aparato.

    Un continuo no cuenta: la nevera arranca el compresor treinta veces al día y su
    fila no habla de ciclos, así que invalidar por ella sería pedir el histórico de
    catorce días sesenta veces al día para nada. Y el suelo de tres minutos evita
    que los primeros minutos de un arranque —cuando aún no hay ni un tramo de cinco
    minutos en las estadísticas— se conviertan en una consulta por payload.
    """
    if time.monotonic() - float(_cache.get("forced") or 0.0) < _MIN_ENTRE_FORZADOS:
        return False
    for a in lista:
        datos = (valor or {}).get(a["id"])
        # Un aparato del que no se ha aprendido nada no entra aquí: si es nuevo, su
        # entidad cambia la clave de la caché y ya se vuelve a aprender por eso; y
        # si es que no tiene estadísticas, forzar no lo va a arreglar.
        if not datos or forma(a, datos) == "continuo":
            continue
        w = _watts(states.get(a.get("power_entity") or ""))
        if w is not None and w > float(a.get("standby_w") or 0) and not datos.get("open"):
            return True
    return False


def en_marcha(
    datos: dict[str, Any] | None, watts: float | None, umbral: float, now: datetime
) -> bool:
    """Si un aparato está funcionando **ahora**, con una sola noción de «en marcha».

    Había dos, y no coincidían. `instantaneo` mira la potencia de este segundo, sin
    ninguna tolerancia; el detector de ciclos tolera quince minutos de hueco, y por
    eso un lavavajillas cuenta como un ciclo y no como tres. Con las dos vivas a la
    vez, la pausa entre lavado y secado decía «terminado» durante un cuarto de hora
    y luego «en marcha» otra vez: la barra de progreso **retrocedía**.

    Así que manda el ciclo abierto, y la lectura de ahora solo lo sostiene: está en
    marcha si tiene un ciclo abierto y, o bien pasa del umbral en este momento, o
    bien su última muestra caliente cae dentro del hueco tolerado. Cuando lo
    aprendido va con retraso, la lectura instantánea es la que responde.
    """
    abierto = (datos or {}).get("open")
    if not abierto:
        return False
    if watts is not None and watts > umbral:
        return True
    try:
        fin = datetime.fromisoformat(abierto["end"])
    except (KeyError, TypeError, ValueError):
        return False
    # La misma tolerancia que el detector, y ahora directamente en minutos: era
    # `_HUECO_TOLERADO * _PASO_MIN`, que multiplicaba muestras por el paso para llegar
    # a los mismos quince. Con la constante ya en minutos la multiplicación sobraba.
    return (now - fin) <= timedelta(minutes=_HUECO_TOLERADO_MIN)


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
        if not _ha_arrancado_algo(_cache["value"], states, lista):
            return _cache["value"]
        _cache["forced"] = time.monotonic()

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
            umbral = float(a.get("standby_w") or 0)
            ciclos = _ciclos_de(muestras, umbral)
            detectada = forma_de_uso(muestras, umbral, ciclos, _DIAS)
            # Un continuo **no tiene ciclo**, y publicar el que sale de partir su
            # curva sería publicar «el ciclo típico de tu nevera son 20 minutos y
            # 0,03 kWh». Es cierto que el compresor hace eso, y no significa nada.
            resumen = None if detectada == "continuo" else _resumen(ciclos, _DIAS)
            hoy = [c for c in ciclos if c["start"] >= medianoche]
            # El que sigue en marcha, si lo hay. Un continuo está siempre «en
            # marcha» y eso no es noticia: su fila cuenta lo del día, no un ciclo.
            abierto = next((c for c in ciclos if c.get("open")), None)
            out[a["id"]] = {
                "cycle": resumen,
                # El ciclo en curso, para poder decir por dónde va: desde cuándo,
                # lo que lleva y lo que se ha llevado **hasta ahora**. No es el
                # ciclo típico ni pretende serlo.
                "open": None if (abierto is None or detectada == "continuo") else {
                    "start": abierto["start"].isoformat(),
                    "end": abierto["end"].isoformat(),
                    "hours": round(abierto["hours"], 2),
                    "kwh": round(abierto["kwh"], 3),
                    # Y su energía hora a hora, que es lo que permite decir de
                    # dónde ha salido **de verdad** en vez de simularlo: el mismo
                    # reparto horario que se le hace a un continuo.
                    "by_hour": _por_horas_hoy(
                        muestras, max(medianoche, abierto["start"]), now),
                },
                # Lo que la aplicación cree que es, para que su ficha lo pueda
                # enseñar y quien la lea pueda corregirlo. Detectar y callarlo es
                # lo que hace que una cifra rara parezca un error del programa.
                "detected_kind": detectada,
                # Energía de hoy hora a hora, que es lo que un continuo necesita:
                # no tiene «hora óptima», tiene consumo del día y un origen.
                "today_by_hour": _por_horas_hoy(muestras, medianoche, now),
                # Los ciclos de hoy, para el cierre del día: cuándo se puso cada
                # cosa y cuánto se llevó. Aquí el que está en marcha **sí** entra,
                # con lo que lleva: esa energía se ha gastado, y quitarla sería
                # esconder consumo del día. Va marcado para que quien hable de su
                # duración sepa que aún no ha acabado.
                "today": [
                    {"start": c["start"].isoformat(), "end": c["end"].isoformat(),
                     "hours": round(c["hours"], 2), "kwh": round(c["kwh"], 3),
                     "open": bool(c.get("open"))}
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


def etiqueta_de_origen(
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
    del_sol = float(est.get("sun_kwh") or 0.0)
    # El total se recompone si no viene: la fila del plan trae las tres partes
    # pero no su suma, y son la misma cosa.
    total = float(est.get("total_kwh") or 0.0) or (del_sol + de_bat + de_red)
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


def etiqueta_de_lo_gastado(cuenta: dict[str, Any] | None) -> dict[str, Any]:
    """Lo mismo, pero para energía que **ya se gastó**: un continuo, o lo que lleva
    un ciclo en marcha.

    Existe porque usar `etiqueta_de_origen` aquí daba una cifra falsa, y de una
    pregunta: *«¿qué significan los euros que salen junto al congelador? Me aparece
    que se alimenta solo de solar pero hay un coste»*. Medido en la nevera del banco:
    0,639 kWh el día —44 % sol, 46 % batería, 10 % red—, coste real **0,01 €** y en
    pantalla **0,07 €**. Siete veces, y las dos cifras salían del mismo payload.

    Tres errores en uno, y los tres vienen de tratar el pasado como una hipótesis:

    1. **La cuenta estaba hecha y se tiraba.** `atribuir` ya devuelve `eur`: hora a
       hora, cada hora a su precio, cobrando solo la red. `etiqueta_de_origen` lo
       ignoraba y multiplicaba de nuevo.
    2. **Al precio de ahora.** Lo que la nevera gastó a las tres de la mañana no
       cuesta lo que cuesta el kilovatio de este momento. Es exactamente el «kWh ×
       precio medio» que el desglose de la factura existe para no hacer.
    3. **Se cobraba la batería.** Y ahí es donde `etiqueta_de_origen` tiene razón
       *para lo que se escribió*: si pones la lavadora ahora, la batería que se coma
       la compras esta noche. Pero esto ya pasó. Esa batería se llenó antes —del sol,
       casi siempre—, y si se llenó de la red, ese dinero ya está contado en la hora
       en que se compró. Cobrarlo otra vez al gastarlo es contarlo dos veces.

    El punto 3 es además la convención que ya sigue el desglose de la factura, donde
    los kWh de batería de un aparato no se cobran y lo que la red metió en la batería
    tiene su propia línea. Las dos pantallas dicen ahora lo mismo, que es lo que
    permite sumarlas sin que se contradigan.

    Un continuo que tira del sol y de lo que había guardado sale **«Gratis»**: no es
    un adorno, es que a esa energía no le corresponde ni un céntimo de esta factura.
    """
    if not cuenta:
        return {"kind": "aprendiendo", "value": "—", "sub": "sin datos de hoy"}
    de_red = float(cuenta.get("grid_kwh") or 0.0)
    de_bat = float(cuenta.get("battery_kwh") or 0.0)
    del_sol = float(cuenta.get("sun_kwh") or 0.0)
    total = float(cuenta.get("kwh") or 0.0) or (del_sol + de_bat + de_red)
    pct_sol = round(del_sol / total * 100) if total > 0 else 0
    eur = cuenta.get("eur")

    if de_red <= _MIGAJA_KWH:
        # Ni un kilovatio de la red: no ha costado nada, y da igual que parte
        # viniera de la batería. Se dice de dónde salió para que el cero se entienda.
        return {
            "kind": "gratis", "value": "Gratis",
            "sub": "lo puso el sol" if de_bat <= _MIGAJA_KWH
                   else "del sol y de lo que tenías guardado",
        }
    return {
        "kind": "parcial",
        # El coste **atribuido**, no recalculado: es el único que sabe a qué precio
        # estaba cada hora de las que la nevera ha ido consumiendo.
        "value": eur,
        "sub": (f"{pct_sol} % lo puso el sol" if pct_sol
                else "todo de la red"),
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
    abierta, el veredicto lo decide la energía** (ver `etiqueta_de_origen`) y no solo
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
        fallo = etiqueta_de_origen(est, price)
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
        "battery": estado_bateria(fuentes),
    }


def estado_bateria(fuentes: dict[str, Any] | None) -> dict[str, Any] | None:
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

    La física —el sol primero, luego la batería mientras le quede, luego la red, y
    el excedente que sobra recargando— está en `planner.simular` y **aquí no se
    repite**. Estaba repetida, con distinto paso, y las dos tarjetas de
    electrodomésticos enseñaban cifras distintas del mismo instante: para el mismo
    horno a las 18:40, 0,36 kWh de red en una y 0,24 en la otra. Esta función pone
    encima lo que la física no da: el porcentaje de batería y los euros.

    Con lo que se cuenta:

      · el sol que se espera sale de la **previsión corregida con la producción
        real de ahora**: si el tejado se está desviando de lo previsto, la curva
        se lleva ese factor y no promete un sol que no está;
      · el consumo de la casa, del perfil horario (la mediana de esa hora), que ya
        es lo que usa la ventana;
      · el aparato tira de su media (kWh del ciclo entre sus horas): no se finge
        conocer la forma de su programa.

    ``None`` si no hay ciclo aprendido o no hay con qué estimar.
    """
    if not cycle or not fuentes:
        return None
    if not fuentes.get("sol_at") or not fuentes.get("casa_at"):
        return None

    horas = float(cycle["hours"])
    kwh = float(cycle["kwh"])
    if horas <= 0 or kwh <= 0:
        return None
    aparato_w = kwh * 1000.0 / horas
    capacidad = float(fuentes.get("capacity_kwh") or 0.0)

    del_sol, de_bat, de_red = planner.simular(
        now, horas, aparato_w, fuentes, planner.PASO_FINO
    )
    # `None` = no hay capacidad ni carga con que separar la batería de la red, y
    # entonces lo que se ha contado como batería es en realidad «batería o red».
    separable = planner.guardado_utilizable(fuentes) is not None
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
        "split": separable,
        "total_kwh": round(total, 2),
    }


def del_cierre(
    lista: list[dict[str, Any]],
    aprendido: dict[str, dict[str, Any]],
    window: dict[str, Any] | None,
    reparto: dict[str, dict[str, float]] | None = None,
) -> list[dict[str, Any]]:
    """Qué se ha puesto hoy, cuánto puso el sol y cuánto cayó dentro de la ventana.

    Es la pregunta del cierre del día llevada al detalle: no solo «has aprovechado
    el 64 % del consumo» sino *qué* lo aprovechó y qué no.

    **El «% con sol» se mide, no se deduce de la ventana.** Antes era el solape del
    ciclo con la ventana, y eso no es lo mismo: la ventana se calcula con la previsión
    solar y el consumo **típico** de la casa, así que un día en que la casa gastó más
    de lo normal la tenía dentro y la energía la puso en parte la red — y la tarjeta
    decía «100 % con sol» igual. Con el reparto medido del día, la cifra es lo que fue.

    Cuesta cero consultas: el reparto hora a hora ya viaja en el mismo payload, y la
    atribución es la de siempre —`atribuir_por_horas`, la misma que el desglose de la
    factura—, así que las dos pantallas no pueden discrepar del mismo aparato.

    Y **un continuo no se cuenta por veces.** Una nevera no «se usa dos veces»: está
    puesta. Sus arranques de compresor los detecta el mismo detector de ciclos que
    aprende una lavadora, y la fila decía «2 ciclos» de un aparato configurado como
    siempre encendido — de un aviso: *«dice que el frigorífico se ha usado en dos
    ciclos, cuando es un elemento que siempre está funcionando y así se ha configurado
    en el addon»*. En un continuo `runs` va a ``None`` y la tarjeta no dice nada: lo
    que hay que contar de él son kWh, no veces.

    Sin reparto se cae al solape con la ventana, que es lo que había.
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
        # Lo que puso el sol, medido. La batería va aparte a propósito: fue sol de
        # otra hora, no de esta, y meterla en el mismo porcentaje haría que «100 %
        # con sol» tapara un ciclo nocturno alimentado por la batería.
        origen = atribuir_por_horas(
            (aprendido.get(a["id"]) or {}).get("today_by_hour"), reparto)
        con_sol = None
        if origen and origen["kwh"] > 0:
            con_sol = round(origen["sun_kwh"] / origen["kwh"] * 100)
        elif total > 0 and inicio and fin:
            con_sol = round(dentro / total * 100)      # sin reparto, lo que había
        # Un continuo no tiene «veces»: está puesto. Su forma sale de la ficha o de lo
        # detectado, con `forma()`, que es la misma decisión que toma el resto de la
        # aplicación — no una segunda opinión escrita aquí.
        continuo = forma(a, aprendido.get(a["id"])) == "continuo"
        filas.append({
            "id": a["id"], "name": a["name"], "color": a["color"], "icon": a["icon"],
            "runs": None if continuo else len(ciclos),
            "kwh": round(total, 2),
            "in_window_kwh": round(dentro, 2) if (inicio and fin) else None,
            "pct": con_sol,
            # Y de dónde salió el resto, para que la fila pueda explicarse sin que
            # nadie tenga que restar: la batería no es la red.
            "battery_kwh": round(origen["battery_kwh"], 2) if origen else None,
            "grid_kwh": round(origen["grid_kwh"], 2) if origen else None,
        })
    filas.sort(key=lambda f: -f["kwh"])
    return filas

"""Cuándo poner cada cosa, y si compensa cargar la batería de la red.

La ventana contesta «¿ahora o luego?» y el consejo dice qué cabe dentro. Lo que
faltaba es la pregunta completa: **a qué hora exacta sale más barato cada
electrodoméstico**, mirando a la vez el sol que se espera, lo que la casa gasta
de normal, lo que hay en la batería y lo que cuesta la luz a cada hora.

Esto no es un modelo aprendido: es una **búsqueda**. Se prueban todos los
comienzos posibles de aquí a mañana, se simula el ciclo en cada uno con la
misma física que usa la tarjeta del consejo, y gana el más barato. Un plan que
sale de una búsqueda se puede explicar entero —«a las 14:00 el sol te cubre el
80 % y ahorras 0,42 €»— y un modelo entrenado, no. Para una decisión que cuesta
dinero, poder explicarla es parte del producto.

**Lo que vale un kilovatio de batería.** Gastar batería no es gratis: lo que
saques ahora lo tendrás que reponer. Pero tampoco cuesta el precio de la hora en
que lo gastas, que es lo que haría que mover un ciclo de las ocho a las tres
pareciera un ahorro cuando la energía es exactamente la misma. Se valora al
precio **más barato del horizonte**, que es lo que costaría reponerla: así el
plan no persigue ahorros que no existen y sigue prefiriendo, con razón, las
horas en que la cubre el sol.

**Cargar de la red en valle.** La otra mitad de la pregunta. Si mañana el sol no
va a llenar la batería y esta noche hay horas baratas, comprar barato para no
comprar caro sale a cuenta. Se compara lo que costaría llenar el hueco que el
sol no va a cubrir, a precio de valle, con lo que costaría esa misma energía a
las horas caras en que se va a necesitar. Solo se recomienda si la diferencia se
nota; por debajo de unos céntimos no merece la pena ciclar la batería.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Callable

_LOGGER = logging.getLogger(__name__)

# Horizonte y paso de la búsqueda. Un día por delante es lo que se puede
# prometer con una previsión solar, y quince minutos es más fino que la
# resolución de la previsión: bajar de ahí es fingir precisión.
HORIZONTE_H = 24.0
PASO_MIN = 15
# Paso de la simulación de dentro de un ciclo, en horas.
_PASO_SIM_H = 0.25
# Por debajo de esto no se dice nada: mover una lavadora para ahorrar dos
# céntimos es hacerle perder el tiempo a alguien.
MIN_AHORRO_EUR = 0.05
# Pero los euros no son lo único que se mira. Si esperar cambia **de dónde sale
# la energía** —de la batería o la red al sol— eso vale aunque en la factura sean
# céntimos: es el objetivo de tener placas, y es además lo que la tarjeta de la
# ventana ya está anunciando («gratis desde las 10:06»). Sin esto, las dos
# tarjetas de la misma pantalla se contradecían: una decía «espera a las 10:06» y
# la otra «ahora es su mejor hora», porque esperar solo ahorraba 1,3 céntimos.
#
# Veinte puntos y no menos: por debajo de ahí la diferencia cabe dentro del error
# de la propia previsión, y prometerla sería fingir una precisión que no hay.
MIN_GANANCIA_SOL_PCT = 20
# Y por debajo de esto no se recomienda cargar la batería de la red: ciclarla
# tiene un coste de vida útil que no está en ninguna cuenta de la luz.
MIN_AHORRO_BATERIA_EUR = 0.15


def _simular(
    inicio: datetime,
    horas: float,
    aparato_w: float,
    sol_at: Callable[[datetime], float],
    casa_at: Callable[[datetime], float],
    guardado: float | None,
    capacidad: float,
) -> tuple[float, float, float]:
    """Un ciclo puesto a `inicio`: (kWh de sol, de batería, de red).

    La misma física que `appliances.estimate`, que es lo que ya se enseña en la
    tarjeta: el sol cubre primero, lo que falte lo pone la batería mientras le
    quede y el resto la red; el sol que sobre por encima del aparato carga la
    batería, que es lo que pasaría de verdad.
    """
    del_sol = de_bat = de_red = 0.0
    restante = guardado
    pasos = max(1, int(round(horas / _PASO_SIM_H)))
    # El paso sale de repartir el ciclo, no al revés. Con un paso fijo, un ciclo
    # de 1,9 h se simulaba en ocho cuartos de hora —2,0 h— y la energía del
    # reparto no cuadraba con la aprendida: salía «104 % con sol».
    paso_h = horas / pasos
    for i in range(pasos):
        momento = inicio + timedelta(hours=i * paso_h)
        sobra = max(0.0, sol_at(momento) - max(0.0, casa_at(momento)))
        sol_ap = min(aparato_w, sobra)
        del_sol += sol_ap * paso_h / 1000.0
        falta = aparato_w - sol_ap
        if falta <= 0:
            if restante is not None and capacidad > 0:
                restante = min(
                    capacidad, restante + (sobra - sol_ap) * paso_h / 1000.0
                )
            continue
        pide = falta * paso_h / 1000.0
        if restante is None:
            de_bat += pide                 # sin capacidad no se pueden separar
        else:
            usa = min(pide, restante)
            de_bat += usa
            restante -= usa
            de_red += pide - usa
    return del_sol, de_bat, de_red


def _coste(
    de_red: float,
    de_bat: float,
    inicio: datetime,
    horas: float,
    precio_at: Callable[[datetime], float | None],
    valor_bateria: float | None,
) -> float | None:
    """Euros de un ciclo: la red al precio de sus horas y la batería, al de reponerla."""
    if valor_bateria is None:
        return None
    # El precio medio de las horas que dura el ciclo, que es a lo que se compra
    # lo que la red tenga que poner.
    muestras = []
    pasos = max(1, int(round(horas / _PASO_SIM_H)))
    for i in range(pasos):
        p = precio_at(inicio + timedelta(hours=i * _PASO_SIM_H))
        if p is not None:
            muestras.append(p)
    if not muestras:
        return None
    return de_red * (sum(muestras) / len(muestras)) + de_bat * valor_bateria


def _mejor_hora(
    ciclo: dict[str, Any],
    now: datetime,
    fuentes: dict[str, Any],
    precio_at: Callable[[datetime], float | None],
    valor_bateria: float | None,
) -> dict[str, Any] | None:
    """Prueba todos los comienzos del horizonte y devuelve el mejor y el de ahora."""
    horas = float(ciclo.get("hours") or 0.0)
    kwh = float(ciclo.get("kwh") or 0.0)
    if horas <= 0 or kwh <= 0:
        return None
    aparato_w = kwh * 1000.0 / horas
    capacidad = float(fuentes.get("capacity_kwh") or 0.0)
    soc = fuentes.get("soc")
    guardado = (
        capacidad * max(0.0, min(float(soc), 100.0)) / 100.0
        if capacidad > 0 and soc is not None else None
    )
    sol_at, casa_at = fuentes["sol_at"], fuentes["casa_at"]

    opciones = []
    pasos = int(HORIZONTE_H * 60 / PASO_MIN)
    for i in range(pasos):
        inicio = now + timedelta(minutes=i * PASO_MIN)
        # El ciclo tiene que caber entero dentro del horizonte: media lavadora
        # planificada no es un plan.
        if inicio + timedelta(hours=horas) > now + timedelta(hours=HORIZONTE_H):
            break
        sol, bat, red = _simular(
            inicio, horas, aparato_w, sol_at, casa_at, guardado, capacidad
        )
        opciones.append({
            "at": inicio, "sun_kwh": sol, "battery_kwh": bat, "grid_kwh": red,
            "eur": _coste(red, bat, inicio, horas, precio_at, valor_bateria),
        })
    if not opciones:
        return None

    ahora = opciones[0]
    # Sin precios se ordena por lo que **no** pone el sol, que es la mejor
    # aproximación posible: menos comprado es menos pagado.
    con_precio = all(o["eur"] is not None for o in opciones)
    clave = (lambda o: o["eur"]) if con_precio else (lambda o: o["grid_kwh"] + o["battery_kwh"])
    mejor = min(opciones, key=lambda o: (clave(o), o["at"]))

    ahorro = None
    if con_precio:
        ahorro = round(ahora["eur"] - mejor["eur"], 3)
    de_ahora, de_mejor = _opcion(ahora, kwh), _opcion(mejor, kwh)
    # Cuánto sol se gana esperando, en puntos del ciclo. Es la otra mitad de la
    # respuesta: «ahorras 0,01 €» no convence a nadie, «pasas del 60 % al 100 %
    # de sol» sí, y además es lo que de verdad cambia.
    gana_sol = de_mejor["sun_pct"] - de_ahora["sun_pct"]
    return {
        "hours": round(horas, 2),
        "kwh": round(kwh, 2),
        "now": de_ahora,
        "best": de_mejor,
        "saving_eur": ahorro,
        "sun_gain_pct": gana_sol,
        # `True` cuando esperar de verdad cambia algo: o el dinero se nota, o
        # cambia de dónde sale la energía. Si el mejor momento es ahora, ninguna
        # de las dos cosas puede pasar y no se pide esperar.
        "worth_waiting": bool(
            mejor["at"] > ahora["at"]
            and ((ahorro is None or ahorro >= MIN_AHORRO_EUR)
                 or gana_sol >= MIN_GANANCIA_SOL_PCT)
        ),
        "priced": con_precio,
    }


def _opcion(o: dict[str, Any], kwh: float) -> dict[str, Any]:
    return {
        "at": o["at"].isoformat(),
        "sun_kwh": round(o["sun_kwh"], 2),
        "battery_kwh": round(o["battery_kwh"], 2),
        "grid_kwh": round(o["grid_kwh"], 2),
        "sun_pct": round(o["sun_kwh"] / kwh * 100) if kwh > 0 else 0,
        "eur": None if o["eur"] is None else round(o["eur"], 2),
    }


def cargar_de_red(
    now: datetime,
    fuentes: dict[str, Any],
    precio_at: Callable[[datetime], float | None],
    manana: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """¿Compensa llenar la batería de la red en las horas baratas?

    Solo tiene sentido cuando **el sol no va a llenarla**: si mañana sobra de
    todas formas, comprar hoy es pagar por algo que iba a venir gratis. Se mira
    el hueco que el sol no cubrirá, lo que costaría comprarlo en la hora más
    barata que queda y lo que costaría esa misma energía en las horas caras, que
    es cuando se gastaría.

    ``None`` si no se puede contestar —sin capacidad, sin carga, sin precios— o
    si la respuesta es que no merece la pena.
    """
    capacidad = float(fuentes.get("capacity_kwh") or 0.0)
    soc = fuentes.get("soc")
    if capacidad <= 0 or soc is None:
        return None
    hueco = capacidad * max(0.0, 100.0 - float(soc)) / 100.0
    if hueco < 0.5:
        return None

    # Precios de las próximas horas, hora a hora.
    horas = []
    for i in range(int(HORIZONTE_H)):
        momento = (now + timedelta(hours=i)).replace(minute=0, second=0, microsecond=0)
        precio = precio_at(momento)
        if precio is not None:
            horas.append((momento, precio))
    if len(horas) < 6:
        return None

    # Lo que el sol le va a meter mañana: lo que sobre por encima de la casa.
    # Si con eso se llena, no hay nada que comprar.
    del_sol = float((manana or {}).get("kwh") or 0.0)
    falta = max(0.0, hueco - del_sol)
    if falta < 0.5:
        return None

    # La hora más barata que queda antes de que salga el sol, y las caras, que
    # son las que se evitan. «Caras» = la mitad superior de las que quedan.
    baratas = sorted(horas, key=lambda par: par[1])
    cara = sorted(p for _t, p in horas)[len(horas) // 2:]
    if not cara:
        return None
    precio_valle = baratas[0][1]
    precio_punta = sum(cara) / len(cara)
    ahorro = (precio_punta - precio_valle) * falta
    if ahorro < MIN_AHORRO_BATERIA_EUR:
        return None
    return {
        "kwh": round(falta, 2),
        "at": baratas[0][0].isoformat(),
        "valley_eur_kwh": round(precio_valle, 4),
        "peak_eur_kwh": round(precio_punta, 4),
        "cost_eur": round(falta * precio_valle, 2),
        "saving_eur": round(ahorro, 2),
        # Lo que el sol sí va a poner, para poder decir por qué falta el resto.
        "sun_kwh": round(min(del_sol, hueco), 2),
    }


def plan(
    lista: list[dict[str, Any]],
    aprendido: dict[str, dict[str, Any]],
    fuentes: dict[str, Any] | None,
    precio_at: Callable[[datetime], float | None] | None,
    now: datetime,
    manana: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """El plan del día: a qué hora cada aparato, y la batería.

    ``None`` cuando no hay con qué planificar: sin previsión y sin perfil de la
    casa no se puede simular nada, y un plan inventado es peor que ninguno.
    """
    if not fuentes or not fuentes.get("sol_at") or not fuentes.get("casa_at"):
        return None
    precio = precio_at or (lambda _t: None)

    # Lo que cuesta reponer un kilovatio de batería: la hora más barata del
    # horizonte. Ver la explicación de arriba: valorarla al precio de la hora en
    # que se gasta inventaría ahorros que no existen.
    precios = [
        p for p in (
            precio((now + timedelta(hours=i)).replace(minute=0, second=0, microsecond=0))
            for i in range(int(HORIZONTE_H))
        ) if p is not None
    ]
    valor_bateria = min(precios) if precios else None

    filas = []
    for a in lista or []:
        ciclo = (aprendido.get(a["id"]) or {}).get("cycle")
        mejor = _mejor_hora(ciclo, now, fuentes, precio, valor_bateria) if ciclo else None
        if not mejor:
            continue
        filas.append({
            "id": a["id"], "name": a["name"], "color": a["color"], "icon": a["icon"],
            **mejor,
        })
    # Primero lo que más se gana moviéndolo: es el orden en que se decide.
    filas.sort(key=lambda f: (-(f["saving_eur"] or 0.0), f["name"]))
    bateria = cargar_de_red(now, fuentes, precio, manana)
    if not filas and not bateria:
        return None
    return {
        "rows": filas,
        "battery": bateria,
        "horizon_h": HORIZONTE_H,
        # Con qué se ha valorado la batería, para poder explicarlo.
        "battery_eur_kwh": None if valor_bateria is None else round(valor_bateria, 4),
    }

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
# Paso de la simulación de dentro de un ciclo, en horas. Hay dos, y la diferencia
# es a propósito:
#
#   · **Para buscar**, `PASO_BUSCAR`. Se simulan 96 comienzos por aparato y solo
#     hace falta *ordenarlos*: el error del paso es el mismo en todos, así que se
#     cancela en la comparación. A paso fino cuesta el triple —85 ms con cuatro
#     aparatos, y sube con cada uno— en un endpoint que se pide cada veinte
#     segundos.
#   · **Para enseñar**, `PASO_FINO`. Las dos horas que acaban en pantalla —ahora y
#     la mejor— se vuelven a simular con el paso de todo lo demás en esta
#     aplicación, que es el de las estadísticas.
#
# Esto existe porque había **dos simuladores** de la misma física, uno aquí a 15
# minutos y otro en `appliances` a 5, y las dos tarjetas de electrodomésticos
# enseñaban números distintos del mismo instante: para el mismo horno a las 18:40,
# 0,36 kWh de red en una y 0,24 en la otra — once puntos de «% con sol». Ahora la
# física está en `simular` y nada más la implementa.
PASO_BUSCAR = 0.25
PASO_FINO = 5 / 60
_PASO_SIM_H = PASO_BUSCAR          # el de `_coste`, que muestrea precios
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


def guardado_utilizable(fuentes: dict[str, Any]) -> float | None:
    """Lo que la batería puede dar ahora, en kWh. ``None`` si no se puede saber.

    Lo normal es que venga ya calculado en ``usable_kwh`` (lo hace
    `live.bateria_usable`, que es quien tiene los sensores delante) y entonces se
    usa ese, sin recalcular nada.

    El respaldo existe para que **no se pueda perder el reparto en silencio**. Al
    pasar de «la batería entera» a «lo de encima de la reserva», los dos sitios que
    simulan un ciclo empezaron a leer `usable_kwh`; quien no lo trajera se quedaba
    sin poder separar la batería de la red y lo decía como si no hubiera capacidad
    configurada, que es otra cosa. Un banco lo cazó, pero podría no haberlo hecho.
    Con el respaldo, unas fuentes con carga y capacidad siempre dan un reparto.

    Vive aquí y no en los dos módulos que la usan porque tener la misma fórmula
    escrita dos veces es exactamente de donde han salido las incoherencias de esta
    aplicación.
    """
    if fuentes.get("usable_kwh") is not None:
        return float(fuentes["usable_kwh"])
    capacidad = float(fuentes.get("capacity_kwh") or 0.0)
    soc = fuentes.get("soc")
    if capacidad <= 0 or soc is None:
        return None
    reserva = float(fuentes.get("reserve_pct") or 0.0)
    return capacidad * max(0.0, min(float(soc), 100.0) - reserva) / 100.0


def simular(
    inicio: datetime,
    horas: float,
    aparato_w: float,
    fuentes: dict[str, Any],
    paso: float = PASO_BUSCAR,
) -> tuple[float, float, float]:
    """Un ciclo puesto a `inicio`: (kWh de sol, de batería, de red).

    **La única implementación de esta física en toda la aplicación.** El sol cubre
    primero, lo que falte lo pone la batería mientras le quede y el resto la red; el
    sol que sobre por encima del aparato carga la batería, que es lo que pasaría de
    verdad.

    Había dos —esta y una copia en `appliances`, con distinto paso— y las dos
    tarjetas de electrodomésticos enseñaban cifras distintas del mismo instante. Si
    alguien necesita esta cuenta en otro sitio, llama aquí; no la copia.

    Lo que la batería puede dar sale de `guardado_utilizable`, y la reserva del
    inversor baja también el techo de lo que se recargue durante el ciclo: por
    debajo de ese porcentaje el inversor no descarga, así que esa energía figura en
    el contador y no se puede gastar.
    """
    sol_at, casa_at = fuentes["sol_at"], fuentes["casa_at"]
    capacidad = float(fuentes.get("capacity_kwh") or 0.0)
    reserva = float(fuentes.get("reserve_pct") or 0.0)
    guardado = guardado_utilizable(fuentes)

    del_sol = de_bat = de_red = 0.0
    restante = guardado
    tope = capacidad * max(0.0, 100.0 - reserva) / 100.0
    pasos = max(1, int(round(horas / paso)))
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
                    tope, restante + (sobra - sol_ap) * paso_h / 1000.0
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


def _casa_con_lo_comprometido(
    casa_at: Callable[[datetime], float],
    tramos: list[tuple[datetime, datetime, float]],
) -> Callable[[datetime], float]:
    """El consumo de la casa **más** lo que el plan ya ha dado por gastado.

    El sol de una hora es uno, y hasta ahora cada aparato lo buscaba como si
    estuviera solo en la casa: `simular` recibe la potencia de **un** aparato y el
    perfil de la casa, y no sabe que hay otros dos a los que se les está
    recomendando la misma hora. Medido con tres aparatos de 2 kW y un tejado que da
    2,6 kW de sobrante: los tres decían «12:00 · 100 % con sol», sumaban 6,00 kWh de
    sol prometido sobre los 2,30 kWh que el tejado da en esa hora —2,6 veces— y la
    tarjeta anunciaba 1,08 € de ahorro que no existía. Es la misma enfermedad que ya
    se corrigió entre tarjetas, ahora entre filas de la misma tarjeta.

    Sumar el compromiso al consumo de la casa es la forma barata y exacta de que la
    física siga en un solo sitio: `simular` no se toca, y lo que ve como «lo que la
    casa está gastando a esa hora» incluye a los aparatos que ya tienen su hueco. El
    sobrante que le queda al siguiente es el de verdad, y su recarga de batería
    también, porque las dos salen de la misma resta.

    Un aviso que conviene tener escrito: el perfil de la casa es la **mediana** de
    esa hora, así que ya contiene a los aparatos en las horas en que suelen
    ponerse. Restarles su parte del perfil pediría un histórico por aparato dentro
    del perfil, que no está. Lo que este cambio arregla es lo que no admite dudas:
    dos aparatos no pueden llevarse el mismo kilovatio.
    """
    # Sin nada comprometido no hay nada que envolver, y devolver el perfil tal cual
    # importa: la envoltura se llama una vez por paso de simulación —96 comienzos por
    # aparato, por vuelta— y con un solo aparato en la casa el coste sería puro peaje.
    if not tramos:
        return casa_at

    def casa(t: datetime) -> float:
        extra = sum(w for ini, fin, w in tramos if ini <= t < fin)
        return max(0.0, casa_at(t)) + extra
    return casa


def _tramo_de(inicio: datetime, horas: float, kwh: float
              ) -> tuple[datetime, datetime, float] | None:
    """El hueco que ocupa un ciclo: desde cuándo, hasta cuándo y a qué potencia."""
    if horas <= 0 or kwh <= 0:
        return None
    return (inicio, inicio + timedelta(hours=horas), kwh * 1000.0 / horas)


def _mejor_hora(
    ciclo: dict[str, Any],
    now: datetime,
    fuentes: dict[str, Any],
    precio_at: Callable[[datetime], float | None],
    valor_bateria: float | None,
) -> dict[str, Any] | None:
    """Prueba todos los comienzos del horizonte y devuelve el mejor y el de ahora.

    Dos resoluciones, y la diferencia está en `PASO_BUSCAR` / `PASO_FINO`: los 96
    comienzos se simulan a paso grueso —solo hay que **ordenarlos**— y las dos horas
    que acaban en pantalla se vuelven a simular a paso fino. Así lo que se enseña
    tiene la precisión de las estadísticas sin pagar el triple por 94 comienzos que
    nadie va a ver.
    """
    horas = float(ciclo.get("hours") or 0.0)
    kwh = float(ciclo.get("kwh") or 0.0)
    if horas <= 0 or kwh <= 0:
        return None
    aparato_w = kwh * 1000.0 / horas

    def opcion_en(inicio: datetime, paso: float) -> dict[str, Any]:
        sol, bat, red = simular(inicio, horas, aparato_w, fuentes, paso)
        return {
            "at": inicio, "sun_kwh": sol, "battery_kwh": bat, "grid_kwh": red,
            "eur": _coste(red, bat, inicio, horas, precio_at, valor_bateria),
        }

    opciones = []
    pasos = int(HORIZONTE_H * 60 / PASO_MIN)
    for i in range(pasos):
        inicio = now + timedelta(minutes=i * PASO_MIN)
        # El ciclo tiene que caber entero dentro del horizonte: media lavadora
        # planificada no es un plan.
        if inicio + timedelta(hours=horas) > now + timedelta(hours=HORIZONTE_H):
            break
        opciones.append(opcion_en(inicio, PASO_BUSCAR))
    if not opciones:
        return None

    # Sin precios se ordena por lo que **no** pone el sol, que es la mejor
    # aproximación posible: menos comprado es menos pagado.
    con_precio = all(o["eur"] is not None for o in opciones)
    clave = (lambda o: o["eur"]) if con_precio else (lambda o: o["grid_kwh"] + o["battery_kwh"])
    elegida = min(opciones, key=lambda o: (clave(o), o["at"]))

    # Y ahora las dos que se van a enseñar, con el paso bueno. El ahorro sale de
    # estas dos y no de las gruesas: es la cifra que se lee, y tiene que ser la
    # diferencia entre los dos números que están al lado.
    ahora = opcion_en(now, PASO_FINO)
    mejor = ahora if elegida["at"] == now else opcion_en(elegida["at"], PASO_FINO)

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
    # Los huecos del sol que el plan ya ha dado por gastados, y de quién son. El
    # sol de una hora es uno: ver `_casa_con_lo_comprometido`.
    tramos: list[tuple[datetime, datetime, float]] = []
    dueños: list[tuple[datetime, datetime, str]] = []
    # Los movibles se planifican **después**, por turnos, compitiendo por lo que
    # quede: aquí solo se recogen.
    pendientes: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for a in lista or []:
        datos = aprendido.get(a["id"]) or {}
        # La forma de uso viene resuelta en `datos` —la ficha manda sobre lo
        # detectado— y la resuelve `live`, que es quien puede mirar a los dos:
        # `appliances` importa este módulo, así que aquí no se puede llamar allí.
        cual = str(datos.get("kind") or "movible")
        fila = {
            "id": a["id"], "name": a["name"], "color": a["color"], "icon": a["icon"],
            "kind": cual,
            # `True` cuando la forma la ha decidido la aplicación y no su ficha:
            # así la tarjeta puede decirlo y quien la lea puede corregirla.
            "kind_auto": not str(a.get("kind") or "").strip(),
            # Si está dando ahora mismo. Lo resuelve `live` —es quien tiene la
            # lectura del momento delante— y vale para las tres formas, así que va
            # aquí arriba y no en la rama de los movibles.
            "on": bool(datos.get("encendido")),
        }
        if cual == "continuo":
            # No tiene ciclo ni hora que elegir: lo que lleva hoy y de dónde salió.
            # Lo calcula quien tiene el reparto de la casa delante (`live`), que es
            # de donde sale la atribución; aquí solo se deja el hueco marcado.
            fila["today"] = datos.get("today_split")
            if not fila["today"]:
                continue
            filas.append(fila)
            continue
        # Lo que ya está funcionando no tiene hora que elegir: esa decisión está
        # tomada. La fila pasa a contar por dónde va, con lo que lleva medido y su
        # origen atribuido —también en `live`, que es quien tiene el reparto— y con
        # lo que le queda simulado. Sigue siendo un movible: mañana volverá a tener
        # su hora.
        if datos.get("progress"):
            fila.update({
                "running": datos["progress"],
                "so_far": datos.get("running_split"),
                "tail": datos.get("tail"),
                "best": None, "saving_eur": None, "sun_gain_pct": 0,
                "worth_waiting": False,
            })
            filas.append(fila)
            # Y lo que le queda por consumir **se aparta del sol de los demás**. Esto
            # no es una hipótesis como las horas que se proponen: el aparato está
            # dando ahora mismo, así que ese sobrante ya no está libre. Un coche
            # cargando se come el sol que el plan le estaba ofreciendo a la lavadora.
            marcha, ciclo = datos["progress"], datos.get("cycle") or {}
            queda_h = max(0.0, float(marcha.get("typical_h") or 0.0)
                          - float(marcha.get("elapsed_h") or 0.0))
            tramo = _tramo_de(now, queda_h, float(ciclo.get("kwh") or 0.0))
            if tramo:
                tramos.append(tramo)
                dueños.append((tramo[0], tramo[1], a["name"]))
            continue
        ciclo = datos.get("cycle")
        if not ciclo:
            continue
        if cual == "fijo":
            # Tiene ciclo y coste, pero **no se le propone hora**: el aire lo
            # quieres cuando hace calor, no a las 14:00 porque es cuando pica el
            # sol. Recomendar una hora que no se puede seguir es ruido con aire de
            # consejo, así que se calcula «ahora» y se calla el resto.
            #
            # Y por eso tampoco reserva sol: su cifra es un precio de «si lo pones
            # ahora», no un plan. Apartarle el sobrante a los movibles por una
            # hipótesis que puede no ocurrir sería inventarse una escasez.
            mejor = _mejor_hora(
                ciclo, now, {**fuentes, "casa_at": _casa_con_lo_comprometido(
                    fuentes["casa_at"], tramos)}, precio, valor_bateria)
            if not mejor:
                continue
            fila.update(mejor)
            fila.update({"best": None, "saving_eur": None, "sun_gain_pct": 0,
                         "worth_waiting": False})
            filas.append(fila)
            continue
        pendientes.append((fila, ciclo))

    # Y ahora los movibles, **en turnos y no a la vez**: el sol de una hora es uno.
    # Dos pasadas, y no una por aparato:
    #
    #   1. **A solas.** La hora que tendría cada uno si estuviera solo en la casa.
    #      Sirve para dos cosas: ordenar el turno en igualdad de condiciones, y poder
    #      decir después por qué la hora de uno es otra.
    #   2. **Por turno.** Se colocan en ese orden, y cada uno vuelve a buscar contra
    #      el sol que de verdad queda libre —los huecos ya dados, más lo que esté en
    #      marcha—. Así el que llega tarde ve su sobrante y no el del tejado entero.
    #
    # Se probó re-escaneando a todos en cada vuelta, que es algo mejor y cuesta n²
    # planes: 122 ms con ocho aparatos en un endpoint que se pide cada veinte
    # segundos. Con dos pasadas son 2n y hay además una razón que no es el coste: el
    # orden **no baila**. Ordenar por la ganancia recalculada hace que dos refrescos
    # seguidos, con la previsión moviéndose un poco, puedan cambiar el turno y con él
    # las horas de la tarjeta entera. Un plan que cambia solo mientras lo miras no se
    # puede seguir.
    #
    # El criterio del turno —el que más gana, primero— es el mismo con el que la
    # tarjeta ordena las filas y el que seguiría cualquiera a mano: si solo cabe uno
    # al mediodía, que sea el que más se ahorra. Sin precios se ordena por lo que
    # evita comprar, que es la misma idea con la única cifra que hay.
    def _gana(m: dict[str, Any]) -> float:
        ahorro = m.get("saving_eur")
        if ahorro is not None:
            return float(ahorro)
        return (m["now"]["grid_kwh"] + m["now"]["battery_kwh"]
                - m["best"]["grid_kwh"] - m["best"]["battery_kwh"])

    a_solas: dict[int, dict[str, Any]] = {}
    orden: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for fila, ciclo in pendientes:
        m = _mejor_hora(ciclo, now, fuentes, precio, valor_bateria)
        if not m:
            continue
        a_solas[id(fila)] = m
        orden.append((fila, ciclo))
    orden.sort(key=lambda par: (-_gana(a_solas[id(par[0])]), par[0]["name"]))

    for fila, ciclo in orden:
        casa = _casa_con_lo_comprometido(fuentes["casa_at"], tramos)
        # Sin nada comprometido, buscar otra vez daría lo mismo que la pasada a
        # solas: se reaprovecha. Es el caso del primero del turno y el del único
        # aparato de la casa, que es el más común de todos.
        if casa is fuentes["casa_at"]:
            mejor = a_solas[id(fila)]
        else:
            mejor = _mejor_hora(ciclo, now, {**fuentes, "casa_at": casa},
                                precio, valor_bateria)
            if not mejor:
                continue
        fila.update(mejor)
        # **Quién le ha quitado el sitio**, si alguien se lo ha quitado. Y no «con
        # quién comparte»: eso se escribió antes y contestaba a la pregunta que no
        # era, porque el turno casi nunca deja dos ciclos solapados —los separa— y
        # entonces salía vacío justo en el caso que hay que explicar. Lo que hace
        # falta saber es por qué la lavadora va a las 14:00 y no a las 13:30.
        horas = float(ciclo.get("hours") or 0.0)
        solo = a_solas[id(fila)]
        fila["displaced_by"] = []
        fila["alone_at"] = None
        if solo["best"]["at"] != mejor["best"]["at"]:
            queria = datetime.fromisoformat(solo["best"]["at"])
            hasta = queria + timedelta(hours=horas)
            fila["displaced_by"] = sorted({
                quien for ini, f, quien in dueños if ini < hasta and queria < f
            })
            # La hora que habría tenido, para poder decirla. Se publica solo cuando
            # de verdad la ha perdido por otro: si no, sería la misma y sobra.
            if fila["displaced_by"]:
                fila["alone_at"] = solo["best"]["at"]
        filas.append(fila)
        tramo = _tramo_de(datetime.fromisoformat(mejor["best"]["at"]), horas,
                          float(ciclo.get("kwh") or 0.0))
        if tramo:
            tramos.append(tramo)
            dueños.append((tramo[0], tramo[1], fila["name"]))
    # Primero lo que está pasando, que es lo único de la tarjeta que no es una
    # hipótesis; luego lo que más se gana moviéndolo; y los continuos al final: no
    # hay nada que decidir sobre ellos, están para saber lo que cuestan.
    orden = {"movible": 1, "fijo": 2, "continuo": 3}
    filas.sort(key=lambda f: (0 if f.get("running") else orden.get(f["kind"], 9),
                              -(f.get("saving_eur") or 0.0), f["name"]))
    bateria = cargar_de_red(now, fuentes, precio, manana)
    if not filas and not bateria:
        return None
    return {
        "rows": filas,
        "battery": bateria,
        "horizon_h": HORIZONTE_H,
        # Con qué se ha valorado la batería, para poder explicarlo.
        "battery_eur_kwh": None if valor_bateria is None else round(valor_bateria, 4),
        # Y cuánto se desvía hoy el tejado de lo previsto. Es el mismo objeto que
        # enseña la tarjeta de la ventana: si esta tarjeta promete un sol que el
        # tejado está desmintiendo, tiene que decirlo con las mismas palabras.
        "roof_today": fuentes.get("roof_today"),
        # Y el estado de la batería, que era lo único de la tarjeta que se ha
        # retirado y que hacía falta conservar: explica por qué una batería «al
        # 21 %» no aparece en ninguna cuenta.
        "battery_state": fuentes.get("battery_state"),
    }

"""Lo que había sobre la mesa: el mejor orden posible de un día que ya pasó.

Es el «perfect optimization» de EMHASS traído a lo que Vatia puede afirmar. Aquella
resuelve el óptimo del día para **mandar** consignas a los interruptores; esto lo
calcula sobre un día **ya cerrado**, con el sol, el consumo y los precios que de
verdad hubo, y no manda nada: mide.

Y esa es toda la diferencia que importa. Un plan del día que viene depende de una
previsión, y la previsión falla —el propio sesgo medido baja al 0,85 en días que se
desvían—. Un óptimo de ayer no depende de ninguna: los datos son los que salieron.
Por eso esto se puede decir sin condicionales, y por eso cierra el bucle que la
aplicación tenía abierto: hasta ahora prometía «gratis a las 13:00» y nunca volvía a
mirar si salió gratis.

**Se publica una diferencia, no una factura alternativa.** Es deliberado. Este módulo
usa un modelo más simple que el desglose de la factura —abajo se dice cuál— y si
publicara «tus aparatos costaron X» habría dos cifras del mismo día en dos pantallas,
que es justo el defecto que esta aplicación lleva corrigiendo desde la 0.48. Lo que
se publica es lo único que este modelo puede sostener: **cuánto costó de más ponerlos
donde se pusieron**, calculado dos veces con la misma cuenta —como se hizo y en el
mejor orden— y restado.

Y «de más», no «ahorro»: ahorrar es prospectivo y este día ya pasó. Lo que hay es un
sobrecoste que ya se pagó, y por eso la interfaz lo enseña con una flecha hacia arriba
y no con un signo más — un «+0,39 €» se lee como dinero que entró.

Lo que el modelo hace, hora a hora y sobre medidas:

    sobrante(h)  = solar real(h) − consumo del resto de la casa(h)
    de la red(h) = max(0, potencia colocada(h) − sobrante(h))
    coste        = Σ de la red(h) × precio real de esa hora

«El resto de la casa» es una resta, la misma que el desglose de la factura: el
consumo medido menos lo que sumaron los aparatos. Es lo que no se puede mover —las
luces, la nevera, la bomba— y por eso es el suelo contra el que se busca hueco.

Lo que el modelo **no** tiene, dicho:

- **La batería.** Mueve energía de una hora a otra, y meterla pediría simular su
  carga en las dos hipótesis. Sin ella, las dos cifras se calculan igual y su
  diferencia sigue valiendo; lo que no valdría es leer una de ellas como una
  factura.
- **La forma del programa.** Un ciclo se coloca como un rectángulo: su energía
  repartida por igual entre sus horas. En una lavadora el calentamiento va al
  principio, así que un hueco de sol a media tarde le vale algo más de lo que aquí
  sale. Es la misma aproximación que ya usa el planificador del día.
- **Las razones humanas.** Que el lavavajillas se pudiera poner a las tres de la
  madrugada no significa que se pudiera. Esto dice lo que había sobre la mesa, no lo
  que se hizo mal.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

_LOGGER = logging.getLogger(__name__)

# Por debajo de esto no se dice nada: señalar dos céntimos de un día que ya pasó es
# hacerle perder el tiempo a alguien. El mismo umbral que el plan del día.
MIN_EXTRA_EUR = 0.05
# Y un aparato que apenas gastó no entra en la cuenta.
_MIGAJA_KWH = 0.05


def _horas_del_dia(dia: datetime) -> list[str]:
    """Las 24 claves ISO del día, que es el índice de todo lo de aquí."""
    inicio = dia.replace(hour=0, minute=0, second=0, microsecond=0)
    return [(inicio + timedelta(hours=h)).isoformat() for h in range(24)]


def _rectangulo(consumo: dict[str, float]) -> tuple[int, float] | None:
    """De lo que un aparato consumió en el día, cuántas horas y cuánta potencia.

    Sale de **ese día** y no del ciclo típico aprendido: aquí no se está prediciendo
    nada, se está midiendo lo que pasó. Si el lavavajillas tardó tres horas ese día,
    tres son las que había que colocar.
    """
    activas = [h for h, k in consumo.items() if k > _MIGAJA_KWH / 24]
    total = sum(consumo.values())
    if not activas or total <= _MIGAJA_KWH:
        return None
    return len(activas), total / len(activas)


def _coste_de(
    inicio: int,
    largo: int,
    por_hora: float,
    sobrante: list[float],
    precio: list[float | None],
) -> tuple[float | None, float]:
    """Lo que costaría el rectángulo empezando en la hora ``inicio``.

    Devuelve (euros, kWh de red). Los euros son ``None`` si falta algún precio de las
    horas que ocupa: mejor no decirlo que decirlo a medias.
    """
    eur = 0.0
    red_total = 0.0
    sabido = True
    for i in range(largo):
        h = inicio + i
        if h >= len(sobrante):
            break
        red = max(0.0, por_hora - sobrante[h])
        red_total += red
        p = precio[h]
        if p is None:
            sabido = False
        else:
            eur += red * p
    return (eur if sabido else None), red_total


def _ocupar(sobrante: list[float], inicio: int, largo: int, por_hora: float) -> None:
    """Descuenta del sobrante lo que un rectángulo ya colocado se lleva."""
    for i in range(largo):
        h = inicio + i
        if h < len(sobrante):
            sobrante[h] = max(0.0, sobrante[h] - por_hora)


def _mejor_hueco(
    c: dict[str, Any], sobrante: list[float], precio: list[float | None]
) -> tuple[int, float | None, float]:
    """La hora más barata para el rectángulo de ``c``, y lo que cuesta ahí.

    Sin precios se ordena por los kWh que evita comprar, que es la misma idea con la
    única cifra que hay — igual que en el plan del día.

    **Se parte de la hora a la que se puso de verdad, y solo se cambia por una mejora
    estricta.** Sin eso un empate movía el aparato: en la salida del endpoint el horno
    decía «se puso a las 13:00, mejor a las 12:00» con 0,00 € de ahorro, porque las
    dos horas costaban lo mismo y el barrido empieza por la primera. Proponer un
    cambio que no gana nada es ruido con aire de consejo, y además deja «ya estaba
    donde tocaba» sin poder decirse nunca.
    """
    eur0, red0 = _coste_de(c["ran"], c["largo"], c["por_hora"], sobrante, precio)
    mejor = (c["ran"], eur0, red0)
    for h in range(max(1, 24 - c["largo"] + 1)):
        eur, red = _coste_de(h, c["largo"], c["por_hora"], sobrante, precio)
        clave = eur if eur is not None else red
        actual = mejor[1] if mejor[1] is not None else mejor[2]
        # El margen es de medio céntimo: por debajo de ahí la «mejora» es el redondeo
        # del reparto horario, no un hueco mejor.
        if clave < actual - 0.005:
            mejor = (h, eur, red)
    return mejor


def del_dia(
    lista: list[dict[str, Any]],
    dia: datetime,
    por_aparato: dict[str, dict[str, float]],
    reparto: dict[str, dict[str, float]],
    solar: dict[str, float],
    precio_de: Any,
) -> dict[str, Any] | None:
    """Cuánto costó de más poner los aparatos donde se pusieron, en un día ya cerrado.

    ``por_aparato`` es ``{id: {iso de la hora: kWh}}`` medido; ``reparto`` el origen
    del consumo hora a hora de ese día (de donde sale el consumo total de la casa) y
    ``solar`` los kWh que generó el tejado en cada hora. Todo medido: aquí no entra
    ninguna previsión.

    ``None`` cuando no hay con qué: sin solar no hay huecos que buscar, y sin
    aparatos medidos no hay nada que mover.
    """
    if not reparto or not por_aparato:
        return None
    horas = _horas_del_dia(dia)

    # **Solo lo que se puede mover.** `lista` trae los movibles y nada más, y quien
    # llama es el que resuelve la forma de uso. Lo demás —una nevera, un aire que se
    # pone cuando hace calor— no tiene hora que elegir, y ofrecerle una es el error
    # que esta aplicación decidió no cometer en la 0.52.0. Se vio en la salida del
    # endpoint: la nevera aparecía con «mejor a las 04:00».
    #
    # Y por eso el filtro va **aquí arriba y no solo al elegir candidatos**: si la
    # nevera se restara del consumo de la casa y luego no se colocara, su energía se
    # perdería del modelo. Quedándose fuera cae donde le toca, en el suelo que no se
    # puede mover.
    mueve = {a["id"] for a in lista}
    por_aparato = {i: c for i, c in por_aparato.items() if i in mueve}
    if not por_aparato:
        return None

    # El suelo: lo que la casa gastó y no fue ninguno de los aparatos movibles. La
    # misma resta que el desglose de la factura, y por el mismo motivo — es lo que
    # no se puede mover, la nevera incluida.
    medido = {h: 0.0 for h in horas}
    for consumo in por_aparato.values():
        for iso, kwh in consumo.items():
            if iso in medido:
                medido[iso] += kwh
    resto = []
    for h in horas:
        casa = (reparto.get(h) or {}).get("home_total") or 0.0
        resto.append(max(0.0, casa - medido[h]))

    sol = [max(0.0, solar.get(h, 0.0)) for h in horas]
    libre = [max(0.0, sol[i] - resto[i]) for i in range(24)]
    if sum(libre) <= _MIGAJA_KWH:
        return None
    precio = [precio_de(h) for h in horas]

    # Los rectángulos de ese día, y a qué hora empezaron de verdad.
    fichas = {a["id"]: a for a in lista}
    candidatos = []
    for ident, consumo in por_aparato.items():
        del_dia_ = {h: k for h, k in consumo.items() if h in medido}
        rect = _rectangulo(del_dia_)
        if not rect or ident not in fichas:
            continue
        largo, por_h = rect
        activas = sorted(h for h, k in del_dia_.items() if k > _MIGAJA_KWH / 24)
        candidatos.append({
            "id": ident, "name": fichas[ident]["name"],
            "color": fichas[ident].get("color"), "icon": fichas[ident].get("icon"),
            "largo": largo, "por_hora": por_h,
            "ran": horas.index(activas[0]),
            "kwh": round(sum(del_dia_.values()), 3),
        })
    if not candidatos:
        return None

    # Lo que costó **con el orden que hubo**, y con este mismo modelo: es la mitad de
    # la resta, y tiene que salir de la misma cuenta que la otra o la diferencia no
    # significaría nada.
    sobrante = list(libre)
    for c in sorted(candidatos, key=lambda c: c["ran"]):
        c["eur_real"], c["red_real"] = _coste_de(
            c["ran"], c["largo"], c["por_hora"], sobrante, precio)
        _ocupar(sobrante, c["ran"], c["largo"], c["por_hora"])

    # Y ahora el mejor orden. Dos pasadas, como en el plan del día: primero el hueco
    # que tendría cada uno **a solas**, que sirve para ordenar el turno en igualdad de
    # condiciones; y luego se colocan en ese orden contra lo que va quedando. Un óptimo
    # de verdad pediría probar todas las combinaciones —seis aparatos en 24 horas son
    # 191 millones— y el turno se queda a un pelo por muchísimo menos.
    def _de_mas(c: dict[str, Any]) -> float:
        _h, eur, red = _mejor_hueco(c, libre, precio)
        mio = eur if eur is not None else red
        real = c["eur_real"] if c["eur_real"] is not None else c["red_real"]
        return (real or 0.0) - (mio or 0.0)

    sobrante = list(libre)
    total_real = 0.0
    total_mejor = 0.0
    sabido = True
    filas = []
    for c in sorted(candidatos, key=lambda c: (-_de_mas(c), c["name"])):
        hueco, eur, red = _mejor_hueco(c, sobrante, precio)
        _ocupar(sobrante, hueco, c["largo"], c["por_hora"])
        if c["eur_real"] is None or eur is None:
            sabido = False
            extra = None
        else:
            total_real += c["eur_real"]
            total_mejor += eur
            extra = round(c["eur_real"] - eur, 2)
        filas.append({
            "id": c["id"], "name": c["name"], "color": c["color"], "icon": c["icon"],
            "kwh": c["kwh"],
            "hours": c["largo"],
            "ran_at": horas[c["ran"]],
            "best_at": horas[hueco],
            # Si le tocaba justo donde estuvo, se dice: pasa la mitad de las veces y
            # es la respuesta buena, no un hueco de la tarjeta.
            "already_best": hueco == c["ran"],
            "extra_eur": extra,
            "grid_kwh": round(c["red_real"], 3),
            "best_grid_kwh": round(red or 0.0, 3),
        })

    filas.sort(key=lambda f: -(f["extra_eur"] or 0.0))
    return {
        "date": horas[0][:10],
        "rows": filas,
        # La diferencia, que es lo único que este modelo sostiene. Nunca «lo que
        # gastaste»: para eso está el desglose de la factura, que tiene la batería
        # dentro y no puede dar la misma cifra.
        #
        # Y se llama `extra_eur` y no `saving_eur`, que es como estaba: **ahorrar es
        # prospectivo y este día ya pasó**. De una corrección: «la cifra de ahorro por
        # electrodoméstico no debería ser negativa?». Ninguna de las dos, en realidad:
        # no es un ahorro que hayas tenido ni una pérdida que se resta de nada, es lo
        # que pagaste **de más** de lo que la misma energía habría costado en su hueco.
        # Con el nombre viejo, un «+0,39 €» al lado de una flecha se lee como dinero
        # que ganaste, que es justo lo contrario de lo que pasó.
        "extra_eur": round(total_real - total_mejor, 2) if sabido else None,
        "sun_kwh": round(sum(sol), 2),
        "free_kwh": round(sum(libre), 2),
        "movable": len(filas),
    }

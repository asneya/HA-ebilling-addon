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

    sobrante(h) = solar real(h) − consumo del resto de la casa(h)
    coste       = Σ potencia colocada(h) × lo que costaba un kilovatio a esa hora

«El resto de la casa» es una resta, la misma que el desglose de la factura: el
consumo medido menos lo que sumaron los aparatos. Es lo que no se puede mover —las
luces, la nevera, la bomba— y por eso es el suelo contra el que se busca hueco.

**Y la batería está dentro**, que es lo que cambió en la 0.65.0. Antes no estaba, y
eso no era una simplificación inocente: el sobrante de mediodía no se tira, se
guarda, y una lavadora movida al sol no se ahorra el kilovatio entero de la noche.
Contra una simulación exacta de la batería, hora a hora, sobre el mismo día y el
mismo aparato (`tests/python/optimo.py` §7):

    día en que la batería se vació      lo cierto: 0,40 €   el modelo viejo: 0,60 €
    día en que le sobró energía         lo cierto: 0,00 €   el modelo viejo: 0,60 €

La segunda línea es la grave: el aparato **ya estaba en su mejor hueco** y la
tarjeta señalaba un sobrecoste de sesenta céntimos. Un consejo inventado sobre un
día que se hizo bien.

De dónde sale la batería sin pedir un sensor más: de las medidas del propio día,
que ya dicen cuánto sol entró en la batería, cuánto se vertió y cuánto salió de
ella para la casa. `_Huecos` lo explica escalón a escalón, y lo que separa los dos
casos de arriba —si la batería se llegó a vaciar— lo explica `_ato_la_bateria`.

Lo que el modelo **no** tiene, dicho:

- **La capacidad y la carga de la batería.** No se simula su estado: se **infiere**
  de cada hora si tenía sitio, mirando si a esa hora se estaba vertiendo, y del día
  entero si llegó a vaciarse, mirando si la red tomó el relevo. Son inferencias sobre
  medidas y no previsiones, pero son inferencias: un tope de potencia de carga se lee
  igual que una batería llena —a efectos de esta cuenta dan lo mismo, no cabía más—, y
  una casa que importa de noche por pedir más potencia de la que el inversor descarga
  se lee como una batería vacía.
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
# Lo que sale de la batería por cada kilovatio que entra. Es una constante y no una
# medida a propósito: medirla en **un** día pide que la carga del principio y la del
# final coincidan, y no coinciden — un día de sol acaba con la batería más llena que
# empezó y el cociente saldría 0,4. El término que multiplica es la diferencia entre
# consumir el sol y guardarlo, así que equivocarse un 5 % aquí mueve céntimos.
_RENDIMIENTO = 0.90


def _horas_del_dia(dia: datetime) -> list[str]:
    """Las 24 claves ISO del día, que es el índice de todo lo de aquí."""
    inicio = dia.replace(hour=0, minute=0, second=0, microsecond=0)
    return [(inicio + timedelta(hours=h)).isoformat() for h in range(24)]


class _Huecos:
    """El sol que sobraba a cada hora, separado por lo que se hacía con él.

    Cuatro escalones, y el orden es el orden en que un aparato colocado ahí los
    aprovecha. Lo que cuesta cada uno no es una tarifa inventada: es lo que ese
    kilovatio le quita a otro sitio.

    1. **Lo que se vertía.** Sol por encima de lo que la casa gastaba y de lo que la
       batería podía guardar. Consumirlo no le quita nada a nadie: sale gratis.
    2. **Lo que se guardaba.** Sol que entraba en la batería. Consumirlo aquí también
       aprovecha el sol, pero puede ser **a costa de la batería**: cada kilovatio que
       no entra es uno que luego no sale. Cuesta el rendimiento de ida y vuelta por lo
       que valía un kilovatio de batería ese día — y ese valor es **cero** los días en
       que la batería llegó a la mañana siguiente con energía sin gastar, porque
       entonces no le quitaba nada a nadie.
    3. **Lo que dio la batería a esa hora.** Si a esa hora la batería estaba
       alimentando la casa, también habría alimentado un kilovatio más: cuesta lo que
       valía su kilovatio. Y **hasta ahí**, que es lo que de verdad entregó: pasado ese
       tope no consta que pudiera dar más.
    4. **La red.** Lo que quede, al precio de la hora.

    Los escalones no van del más barato al más caro, van en el orden en que la
    instalación los usa: es un orden **físico**, no una elección. El tercero puede ser
    más caro que el cuarto —una madrugada barata con la batería descargando— y ahí el
    kilovatio de más lo pone la batería igual, porque el inversor no mira precios.

    De eso sale un resultado que parece un error y no lo es: en un día con la batería
    atada y una tarifa con madrugada barata, poner la lavadora a las tres de la mañana
    sale mejor que al sol. La batería ya convertía ese sol en energía de la noche a
    0,30 €/kWh, así que consumirlo directo solo se ahorra el 10 % de la ida y vuelta
    —tres céntimos— frente a los veinte de diferencia entre tarifas. Comprobado contra
    una simulación exacta en `tests/python/optimo.py` §8: 3,225 € por la madrugada
    contra 3,565 € por el sol.

    Un día **sin batería** tiene el segundo y el tercer escalón a cero en las 24 horas:
    entonces esto es exactamente el modelo de antes, sobrante gratis y precio de la
    hora, que para una casa sin batería era el correcto.
    """

    def __init__(
        self,
        vertido: list[float],
        guardado: list[float],
        dio: list[float],
        precio: list[float | None],
        valor: float | None,
        bateria: bool,
    ) -> None:
        self.vertido = list(vertido)
        self.guardado = list(guardado)
        self.dio = list(dio)
        self.precio = precio
        self.valor = valor
        self.bateria = bateria
        # Lo que cuesta el segundo escalón, ya con la ida y vuelta dentro.
        self.guardar = None if valor is None else _RENDIMIENTO * valor
        # Y si la batería tenía de sobra: entonces su kilovatio no vale nada ese día,
        # que es lo que dice un `valor` de cero. Un `valor` desconocido —sin precios—
        # no cuenta como suelta: no se sabe.
        self.suelta = valor == 0.0

    def copia(self) -> "_Huecos":
        """Otro reparto igual, para colocar una segunda hipótesis desde cero."""
        return _Huecos(self.vertido, self.guardado, self.dio, self.precio,
                       self.valor, self.bateria)

    def libre(self) -> float:
        """Todo el sol que sobraba, vertido o guardado."""
        return sum(self.vertido) + sum(self.guardado)

    def _tramos(self, h: int, kwh: float) -> tuple[float, float, float, float]:
        """En qué se parte consumir ``kwh`` a la hora ``h``, escalón a escalón."""
        gratis = min(kwh, self.vertido[h])
        resto = kwh - gratis
        del_guardado = min(resto, self.guardado[h])
        resto -= del_guardado
        de_bateria = min(resto, self.dio[h])
        return gratis, del_guardado, de_bateria, resto - de_bateria

    def coste(
        self, inicio: int, largo: int, por_hora: float
    ) -> tuple[float | None, float, float]:
        """Lo que costaría el rectángulo empezando en la hora ``inicio``.

        Devuelve (euros, kWh que hubo que pagar, peso). Los euros son ``None`` si
        falta el precio de alguna de las horas que ocupa: mejor no decirlo que decirlo
        a medias. El **peso** es con lo que se ordena cuando no hay euros —el
        kilovatio guardado pesa solo lo que la batería pierde al ir y volver—, y sin
        batería coincide con los kWh pagados, que es lo que se usaba antes.
        """
        eur = 0.0
        pagado = 0.0
        peso = 0.0
        sabido = True
        for i in range(largo):
            h = inicio + i
            if h >= len(self.vertido):
                break
            _gratis, del_guardado, de_bateria, de_red = self._tramos(h, por_hora)
            pagado += de_bateria + de_red
            if self.suelta:
                peso += de_red
            else:
                peso += de_red + de_bateria + (1.0 - _RENDIMIENTO) * del_guardado
            p = self.precio[h]
            falta_valor = (del_guardado + de_bateria) > 0 and self.valor is None
            if p is None or falta_valor:
                sabido = False
            else:
                # Los `or 0.0` no son por si acaso: sin batería en el día `valor` es
                # `None` y los dos escalones que la usan valen cero, así que el
                # producto no se llega a mirar — pero Python sí lo evalúa.
                eur += (de_red * p + de_bateria * (self.valor or 0.0)
                        + del_guardado * (self.guardar or 0.0))
        return (eur if sabido else None), pagado, peso

    def ocupar(self, inicio: int, largo: int, por_hora: float) -> None:
        """Descuenta lo que un rectángulo ya colocado se lleva de cada escalón."""
        for i in range(largo):
            h = inicio + i
            if h >= len(self.vertido):
                continue
            gratis, del_guardado, de_bateria, _de_red = self._tramos(h, por_hora)
            self.vertido[h] = max(0.0, self.vertido[h] - gratis)
            self.guardado[h] = max(0.0, self.guardado[h] - del_guardado)
            self.dio[h] = max(0.0, self.dio[h] - de_bateria)


def _hubo_bateria(horas: list[str], reparto: dict[str, dict[str, float]]) -> bool:
    """¿Se movió algo por la batería ese día?

    Es el interruptor entre los dos modelos, y tiene que ser esto y no el ajuste de
    capacidad: una casa sin batería con el ajuste puesto —o una batería apagada todo
    el día— tiene el sobrante de verdad vertido, y ahí el modelo viejo acierta.
    """
    total = 0.0
    for h in horas:
        v = reparto.get(h) or {}
        for clave in ("to_battery", "from_battery", "grid_to_battery",
                      "battery_to_grid"):
            total += max(0.0, v.get(clave) or 0.0)
    return total > _MIGAJA_KWH


def _ato_la_bateria(horas: list[str], reparto: dict[str, dict[str, float]]) -> bool:
    """¿Se quedó la batería sin nada y tuvo que entrar la red?

    Es la pregunta que decide **cuánto vale** un kilovatio de batería ese día, y la
    primera versión de esto no la hacía. Sin ella el modelo se equivocaba de signo, no
    de magnitud: en un día en que la batería llegó a la mañana siguiente con energía
    sin gastar, el kilovatio que un aparato le quita al mediodía no le quita nada a
    nadie —sobraba—, y el modelo lo cobraba igual. Salía «te costó 0,60 € de más» en un
    día en que la simulación exacta dice **cero**, porque el aparato ya estaba donde
    tocaba. Un consejo inventado sobre un día que se hizo bien.

    Si la batería se quedó vacía y la red tomó el relevo, lo contrario: cada kilovatio
    que no entró es uno que hubo que comprar.

    Se mira si la casa importó **después de la última hora en que la batería estaba
    cargando**, que es exactamente «se acabó y entró la red». Con lo que hay: no hay
    estado de carga en esta cuenta, ni hace falta.

    Un caso que esto llama atado sin estarlo: importar de noche porque la casa pedía
    más potencia de la que el inversor sabe descargar, con la batería todavía llena.
    Sobrestima el segundo escalón, que es el término pequeño.
    """
    ultima = -1
    for i, h in enumerate(horas):
        if ((reparto.get(h) or {}).get("to_battery") or 0.0) > _MIGAJA_KWH:
            ultima = i
    if ultima < 0:
        # No guardó nada: no hay energía guardada de la que discutir el valor, y el
        # segundo escalón está vacío. Da igual lo que se conteste aquí.
        return True
    despues = sum(
        max(0.0, (reparto.get(h) or {}).get("from_grid") or 0.0)
        for h in horas[ultima + 1:]
    )
    return despues > _MIGAJA_KWH


def _valor_bateria(
    horas: list[str], reparto: dict[str, dict[str, float]],
    precio: list[float | None],
) -> float | None:
    """Lo que valió un kilovatio de batería ese día: el precio de lo que evitó comprar.

    Medido, no supuesto: la media de los precios de las horas en las que la batería
    alimentó la casa, ponderada por lo que entregó en cada una. Si esa noche la
    batería tapó las horas caras, su kilovatio valió mucho; si se gastó de madrugada,
    poco. Es la misma idea que `planner.valor_bateria` pero al revés de mirar: allí es
    lo que costaría **reponerla** mañana —una decisión que aún se puede tomar—, aquí
    lo que **ya evitó** comprar.

    La media pondera y no busca la hora exacta del relevo, que es lo que de verdad se
    desplaza si la batería recibe un kilovatio menos. Un inversor voraz descarga
    seguido hasta vaciarse, así que esas horas son las de la noche y su media está en
    el orden de magnitud correcto — y este número multiplica el término pequeño.

    Sin descarga medida no hay nada que ponderar y se cae a la media del día.
    """
    peso = 0.0
    suma = 0.0
    for i, h in enumerate(horas):
        p = precio[i]
        if p is None:
            continue
        kwh = max(0.0, (reparto.get(h) or {}).get("from_battery") or 0.0)
        suma += kwh * p
        peso += kwh
    if peso > _MIGAJA_KWH:
        return suma / peso
    conocidos = [p for p in precio if p is not None]
    return sum(conocidos) / len(conocidos) if conocidos else None


def _huecos_del_dia(
    horas: list[str], libre: list[float],
    reparto: dict[str, dict[str, float]], precio: list[float | None],
) -> _Huecos:
    """Los escalones de cada hora, salidos de lo que los contadores vieron.

    El reparto del día ya trae, hora a hora, cuánto sol entró en la batería
    (`to_battery`), cuánto se vertió (`to_grid`) y con qué se alimentó la casa
    (`from_grid`, `from_battery`). Con eso basta: no hace falta ni la capacidad, ni el
    estado de carga, ni una simulación.

    La pieza fina es **cuánto de lo que un aparato se comió se habría guardado**, que
    es contrafactual y no está medido. Se decide con el vertido de esa hora, que es la
    huella que deja la respuesta:

    · **Se vertía** ⇒ la batería no daba para más, por llena o por potencia. El sol
      que el aparato se comió también se habría vertido, así que lo que se guardaba es
      lo que se guardó y ni un vatio más.
    · **No se vertía nada** ⇒ todo lo que sobró se guardó. Lo que el aparato se comió
      también habría cabido, así que el sobrante entero es del segundo escalón.

    El tercer escalón no se deduce, se lee: es `from_battery`, lo que la batería
    entregó a la casa a esa hora. Es un **tope medido** y por eso está ahí — sin él, un
    coche eléctrico colocado a las tres de la mañana se llevaba gratis diez kilovatios
    de una batería que a esa hora dio uno.

    Y el **valor** de un kilovatio de batería es cero si no se llegó a vaciar: ese día
    tenía de sobra y quitarle uno no obligaba a comprar nada. La misma cifra entra en
    los dos escalones que la usan, que es lo que hace que las dos hipótesis se puedan
    restar.
    """
    hay = _hubo_bateria(horas, reparto)
    valor = None
    if hay:
        valor = (_valor_bateria(horas, reparto, precio)
                 if _ato_la_bateria(horas, reparto) else 0.0)
    vertido: list[float] = []
    guardado: list[float] = []
    dio: list[float] = []
    for i, h in enumerate(horas):
        v = reparto.get(h) or {}
        if not hay:
            vertido.append(libre[i])
            guardado.append(0.0)
            dio.append(0.0)
            continue
        if (v.get("to_grid") or 0.0) > _MIGAJA_KWH:
            g = min(max(0.0, v.get("to_battery") or 0.0), libre[i])
        else:
            g = libre[i]
        guardado.append(g)
        vertido.append(max(0.0, libre[i] - g))
        dio.append(max(0.0, v.get("from_battery") or 0.0))
    return _Huecos(vertido, guardado, dio, precio, valor, hay)


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


def _mejor_hueco(
    c: dict[str, Any], huecos: _Huecos
) -> tuple[int, float | None, float, float]:
    """La hora más barata para el rectángulo de ``c``, y lo que cuesta ahí.

    Devuelve (hora, euros, kWh pagados, peso). Sin precios se ordena por el peso, que
    es la misma idea con la única cifra que hay — igual que en el plan del día.

    **Se parte de la hora a la que se puso de verdad, y solo se cambia por una mejora
    estricta.** Sin eso un empate movía el aparato: en la salida del endpoint el horno
    decía «se puso a las 13:00, mejor a las 12:00» con 0,00 € de ahorro, porque las
    dos horas costaban lo mismo y el barrido empieza por la primera. Proponer un
    cambio que no gana nada es ruido con aire de consejo, y además deja «ya estaba
    donde tocaba» sin poder decirse nunca.
    """
    mejor = (c["ran"], *huecos.coste(c["ran"], c["largo"], c["por_hora"]))
    for h in range(max(1, 24 - c["largo"] + 1)):
        eur, pagado, peso = huecos.coste(h, c["largo"], c["por_hora"])
        clave = eur if eur is not None else peso
        actual = mejor[1] if mejor[1] is not None else mejor[3]
        # El margen es de medio céntimo: por debajo de ahí la «mejora» es el redondeo
        # del reparto horario, no un hueco mejor.
        if clave < actual - 0.005:
            mejor = (h, eur, pagado, peso)
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
    # Los escalones del sobrante, con la batería dentro cuando el día la tuvo.
    huecos = _huecos_del_dia(horas, libre, reparto, precio)

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
    puestos = huecos.copia()
    for c in sorted(candidatos, key=lambda c: c["ran"]):
        c["eur_real"], c["pagado_real"], c["peso_real"] = puestos.coste(
            c["ran"], c["largo"], c["por_hora"])
        puestos.ocupar(c["ran"], c["largo"], c["por_hora"])

    # Y ahora el mejor orden. Dos pasadas, como en el plan del día: primero el hueco
    # que tendría cada uno **a solas**, que sirve para ordenar el turno en igualdad de
    # condiciones; y luego se colocan en ese orden contra lo que va quedando. Un óptimo
    # de verdad pediría probar todas las combinaciones —seis aparatos en 24 horas son
    # 191 millones— y el turno se queda a un pelo por muchísimo menos.
    def _de_mas(c: dict[str, Any]) -> float:
        _h, eur, _pagado, peso = _mejor_hueco(c, huecos)
        mio = eur if eur is not None else peso
        real = c["eur_real"] if c["eur_real"] is not None else c["peso_real"]
        return (real or 0.0) - (mio or 0.0)

    quedan = huecos.copia()
    total_real = 0.0
    total_mejor = 0.0
    sabido = True
    filas = []
    for c in sorted(candidatos, key=lambda c: (-_de_mas(c), c["name"])):
        hueco, eur, pagado, _peso = _mejor_hueco(c, quedan)
        quedan.ocupar(hueco, c["largo"], c["por_hora"])
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
            # Y esto **no** se llama `grid_kwh`, que es como estaba: con la batería
            # dentro, lo que un aparato no cubrió con el sobrante se lo dieron la red
            # y la batería a medias, y llamar red a la mitad que salió de la batería
            # sería la clase de cifra que esta aplicación lleva quitando. Es lo que
            # hubo que pagar, venga de donde venga.
            "paid_kwh": round(c["pagado_real"], 3),
            "best_paid_kwh": round(pagado or 0.0, 3),
        })

    filas.sort(key=lambda f: -(f["extra_eur"] or 0.0))
    return {
        "date": horas[0][:10],
        "rows": filas,
        # La diferencia, que es lo único que este modelo sostiene. Nunca «lo que
        # gastaste»: para eso está el desglose de la factura, que reparte la energía
        # entre orígenes medidos y no coloca rectángulos, y no puede dar la misma
        # cifra. Que la batería ya esté en las dos cuentas no las vuelve la misma.
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
        # El sobrante partido en dos, que es lo que explica una cifra pequeña: en una
        # casa con batería casi todo el sol que sobra se guarda, y entonces mover un
        # aparato al mediodía gana poco **porque ya lo estabas aprovechando**. Sin
        # esta separación la tarjeta solo podría decir «no había mucho que ganar», que
        # suena a que el día fue malo cuando fue justo lo contrario.
        "free_kwh": round(sum(huecos.vertido), 2),
        "stored_kwh": round(sum(huecos.guardado), 2),
        # Si la batería entra en la cuenta, y a cuánto se ha valorado su kilovatio.
        # Se publica para poder explicarlo: la tarjeta decía «la batería no entra en
        # esta cuenta» y ahora entra, así que el texto tiene que saberlo.
        "battery": huecos.bateria,
        "battery_eur_kwh": None if huecos.valor is None else round(huecos.valor, 4),
        "movable": len(filas),
    }

"""El óptimo de ayer: lo que había sobre la mesa, medido y no previsto.

Es el «perfect optimization» de EMHASS traído a lo que Vatia puede afirmar: sobre un
día **ya cerrado**, con el sol, el consumo y los precios que de verdad hubo. Y por eso
se puede decir sin condicionales — un plan del día que viene depende de una previsión
que falla; esto no depende de ninguna.

Lo delicado no es la cuenta, es **qué se publica**. El modelo de aquí es más simple que
el del desglose de la factura, así que publicar «tus aparatos costaron X» pondría dos
cifras del mismo día en dos pantallas — el defecto que esta aplicación lleva corrigiendo
desde la 0.48. Lo que se publica es una **diferencia**, calculada dos veces con la misma
cuenta y restada.

Lo que se comprueba, con un día hecho a mano para poder derivar la respuesta a mano:

  1. un aparato que se puso de noche, con sol de sobra al mediodía: costó de más, y lo
     que costó es lo que sale de multiplicar a mano
  2. uno que ya estaba en su mejor hueco: se dice, y su sobrecoste es cero
  3. dos aparatos no se llevan el mismo hueco (el turno, igual que en el plan)
  4. «el resto de la casa» es el suelo: si la casa ya se come el sol, no hay hueco
  5. sin sol, sin aparatos o sin precios no se inventa nada
  6. la cifra que se publica es la diferencia, y **no** hay ninguna que se pueda leer
     como «lo que gastaste» — ni como un ahorro, que es prospectivo y este día ya pasó
  7. **la batería** (0.65.0): el mismo día con el sobrante guardado en vez de vertido da
     un sobrecoste distinto, y cuál es lo dice una **simulación exacta** puesta al lado
     del modelo — a mano no se deriva una cuenta con estado
  7c. los cuatro escalones de una hora, de cerca: lo que la batería entregó es un tope
     medido y se gasta, no una barra libre
  8. y un resultado que parece un error y no lo es: con la batería atada y madrugada
     barata, las tres de la mañana **sí** pueden ganarle al sol. Está aquí para que
     nadie «arregle» el modelo hasta que deje de salir
"""
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

RAIZ = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(RAIZ / "vatia" / "app"))

import optimo  # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
DIA = datetime(2026, 8, 3, 0, 0, tzinfo=TZ)
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


def casi(a, b, tol=0.005):
    return a is not None and b is not None and abs(a - b) <= tol


def H(h):
    return DIA.replace(hour=h).isoformat()


# ── El día, hecho a mano ────────────────────────────────────────────────────
#
# El tejado: 3 kWh a las 12, 13 y 14, y nada el resto. El resto de la casa: 0,5 kWh
# fijos todo el día. Sobrante libre = 2,5 kWh en cada una de esas tres horas, cero en
# las demás.
#
# Precios: 0,10 € de noche (00-07) y 0,30 € el resto, para que mover algo de noche a
# mediodía no sea gratis por el precio sino **por el sol**, que es lo que se quiere
# comprobar.
SOLAR = {H(h): (3.0 if h in (12, 13, 14) else 0.0) for h in range(24)}
CASA_RESTO = 0.5
PRECIOS = {H(h): (0.10 if h < 8 else 0.30) for h in range(24)}
precio_de = PRECIOS.get

APARATOS = [
    {"id": "lava", "name": "Lavadora", "color": "#1", "icon": "lavadora"},
    {"id": "lavav", "name": "Lavavajillas", "color": "#2", "icon": "lavavajillas"},
]


def reparto_con(consumos):
    """El origen hora a hora del día: la casa es el resto más los aparatos."""
    out = {}
    for h in range(24):
        iso = H(h)
        aparatos = sum(c.get(iso, 0.0) for c in consumos.values())
        out[iso] = {"home_total": CASA_RESTO + aparatos,
                    "from_solar": 0.0, "from_battery": 0.0, "from_grid": 0.0}
    return out


print("1 · un aparato de noche con sol de sobra al mediodía")
# La lavadora: 2 kWh en dos horas (1 kWh/h) a las 22 y 23. De noche no hay sol, así
# que se compró todo: 2 kWh × 0,30 = 0,60 €. Al mediodía el sobrante son 2,5 kWh/h,
# así que le cabe entera y no cuesta nada. Ahorro esperado: 0,60 €.
solo_lava = {"lava": {H(22): 1.0, H(23): 1.0}}
d = optimo.del_dia(APARATOS, DIA, solo_lava, reparto_con(solo_lava), SOLAR, precio_de)
ok(d is not None, "sale la cuenta")
fila = d["rows"][0]
ok(casi(fila["extra_eur"], 0.60),
   f"costó de más lo que sale a mano: 2 kWh × 0,30 € ({fila['extra_eur']} €)")
ok(fila["best_at"][11:13] in ("12", "13"),
   f"y el mejor hueco es una hora de sol ({fila['best_at'][11:16]})")
ok(fila["ran_at"][11:13] == "22", f"con la hora a la que se puso ({fila['ran_at'][11:16]})")
ok(fila["already_best"] is False, "y no se dice que ya estuviera bien")
ok(casi(d["extra_eur"], 0.60), f"y el total es el mismo ({d['extra_eur']} €)")
ok(casi(d["free_kwh"], 7.5), f"con el sobrante libre del día ({d['free_kwh']} kWh)")

print("\n2 · uno que ya estaba en su mejor hueco")
ya = {"lava": {H(12): 1.0, H(13): 1.0}}
d2 = optimo.del_dia(APARATOS, DIA, ya, reparto_con(ya), SOLAR, precio_de)
f2 = d2["rows"][0]
ok(f2["already_best"] is True, "se dice que ya estaba donde tocaba")
ok(casi(f2["extra_eur"], 0.0), f"y su sobrecoste es cero ({f2['extra_eur']} €)")
ok(casi(d2["extra_eur"], 0.0), "y el del día también")

print("\n2b · un empate no mueve nada")
# Salió mirando la respuesta del endpoint: el horno decía «se puso a las 13:00, mejor
# a las 12:00» con 0,00 € de ahorro, porque las dos horas cuestan lo mismo y el
# barrido empieza por la primera. Un cambio que no gana nada es ruido.
empate = {"lava": {H(13): 1.0}}
d2b = optimo.del_dia(APARATOS, DIA, empate, reparto_con(empate), SOLAR, precio_de)
f2b = d2b["rows"][0]
ok(f2b["best_at"][11:13] == "13",
   f"se queda donde estaba si no hay mejora ({f2b['best_at'][11:16]})")
ok(f2b["already_best"] is True, "y se dice que ya estaba bien")

print("\n3 · dos aparatos no se llevan el mismo hueco")
# Los dos a 2 kWh/h durante dos horas: en el sobrante del mediodía (2,5 kWh/h) cabe
# uno y no dos. Al segundo, con el sol ya cogido, le sale mejor la madrugada barata
# (0,10 € frente a 0,30 €) que un mediodía en el que ya no queda sobrante — que es la
# respuesta correcta, y la que prueba que el turno descuenta de verdad.
gordos = {"lava": {H(22): 2.0, H(23): 2.0}, "lavav": {H(21): 2.0, H(22): 2.0}}
d3 = optimo.del_dia(APARATOS, DIA, gordos, reparto_con(gordos), SOLAR, precio_de)
horas3 = sorted(f["best_at"][11:13] for f in d3["rows"])
ok(len(set(horas3)) == 2, f"cada uno a un hueco distinto ({horas3})")
# Y el segundo no sale gratis: donde le toca hay que comprar, y se dice.
peor = min(d3["rows"], key=lambda f: f["extra_eur"] or 0)
ok(peor["best_paid_kwh"] > 0,
   f"al segundo le toca comprar algo, y se dice ({peor['best_paid_kwh']} kWh pagados)")

print("\n4 · «el resto de la casa» es el suelo")
# La casa se come el sol entero: 3 kWh de resto en las horas de sol. No queda hueco,
# así que no hay nada que ganar moviendo nada.
# `reparto_con` lee `CASA_RESTO` al llamarla, así que subirla aquí cambia el día.
CASA_RESTO = 3.0
d4 = optimo.del_dia(APARATOS, DIA, solo_lava, reparto_con(solo_lava), SOLAR, precio_de)
ok(d4 is None, "sin hueco libre no se dice nada, en vez de un ahorro inventado")
CASA_RESTO = 0.5

print("\n5 · sin datos no se inventa")
ok(optimo.del_dia(APARATOS, DIA, {}, reparto_con({}), SOLAR, precio_de) is None,
   "sin aparatos medidos, nada")
ok(optimo.del_dia(APARATOS, DIA, solo_lava, {}, SOLAR, precio_de) is None,
   "sin reparto de la casa, nada")
vacio = {H(h): 0.0 for h in range(24)}
ok(optimo.del_dia(APARATOS, DIA, solo_lava, reparto_con(solo_lava), vacio,
                  precio_de) is None,
   "y sin sol tampoco: no hay hueco que buscar")
sin_precio = optimo.del_dia(APARATOS, DIA, solo_lava, reparto_con(solo_lava), SOLAR,
                            lambda _h: None)
ok(sin_precio is not None and sin_precio["extra_eur"] is None,
   "sin precios se calla el euro en vez de inventarlo")
ok(sin_precio["rows"] and sin_precio["rows"][0]["best_at"],
   "pero el hueco sí se dice, que no necesita precios")

print("\n6 · se publica una diferencia, no una factura")
# Es la comprobación que impide que este módulo se convierta en una segunda opinión
# sobre lo que costó el día. Ninguna clave puede leerse como «lo que gastaste».
claves = set(d["rows"][0]) | set(d)
prohibidas = {k for k in claves if k in ("eur", "cost", "total_eur", "spent_eur")}
ok(not prohibidas, f"ninguna clave se puede leer como una factura ({prohibidas})")
# Y tampoco como un ahorro: ahorrar es prospectivo y este día ya pasó. La cifra es un
# sobrecoste que ya se pagó, y el nombre tiene que decirlo.
ok(not {k for k in claves if "saving" in k},
   f"ni como un ahorro ({sorted(k for k in claves if 'saving' in k)})")
ok("extra_eur" in d and "extra_eur" in d["rows"][0],
   "lo que se publica es lo que costó de más")

# ── La batería dentro del modelo (0.65.0) ──────────────────────────────────
#
# El mismo día de arriba pero con batería: el sol que sobra ya no se tira, se guarda.
# La respuesta correcta ya no es «te ahorrabas el kilovatio entero», y para saber cuál
# es se simula la batería **exacta**, hora a hora, con las tres hipótesis. Esa
# simulación está aquí abajo y es de veinte líneas: no vale derivar a mano una cuenta
# con estado, porque el estado es justo lo que se olvida.
#
# La batería voraz: guarda todo el sobrante y descarga en cuanto falta, con el 90 % de
# rendimiento a la salida. Sin topes de potencia ni de capacidad, que es el modelo del
# que habla `optimo`.


def coste_exacto(resto, wm_horas, wm_kwh_h, eta=0.90):
    """Lo que costó de verdad el día, con la lavadora puesta en `wm_horas`."""
    soc = coste = 0.0
    for h in range(24):
        sol = SOLAR[H(h)]
        carga = resto[h] + (wm_kwh_h if h in wm_horas else 0.0)
        neto = sol - carga
        if neto > 0:
            soc += neto * eta
        else:
            da = min(-neto, soc)
            soc -= da
            coste += (-neto - da) * PRECIOS[H(h)]
    return coste, soc


def reparto_bateria(resto, wm_horas, wm_kwh_h, eta=0.90):
    """El reparto hora a hora **medido** de ese día, que es lo que ve `optimo`.

    Sale de la misma simulación, así que el banco no le está dando a `optimo` un día
    inventado: le está dando lo que los contadores habrían publicado.
    """
    soc = 0.0
    out = {}
    for h in range(24):
        iso = H(h)
        sol = SOLAR[iso]
        carga = resto[h] + (wm_kwh_h if h in wm_horas else 0.0)
        neto = sol - carga
        fila = {"home_total": carga, "to_home": min(sol, carga), "to_grid": 0.0,
                "to_battery": 0.0, "from_solar": min(sol, carga),
                "from_battery": 0.0, "from_grid": 0.0, "grid_to_battery": 0.0,
                "battery_to_grid": 0.0}
        if neto > 0:
            fila["to_battery"] = neto
            soc += neto * eta
        else:
            da = min(-neto, soc)
            soc -= da
            fila["from_battery"] = da
            fila["from_grid"] = -neto - da
        out[iso] = fila
    return out


print("\n7 · la batería dentro: el sol que sobra no se tira, se guarda")
LLANO = [0.5] * 24
CARGADO = [0.5 if h < 18 else 2.0 for h in range(24)]
COMO_FUE = (22, 23)
# La lavadora: 1 kWh/h durante dos horas, igual que en §1.
lava_2h = {"lava": {H(22): 1.0, H(23): 1.0}}

for etiqueta, resto, esperado in (
    ("la batería se vació", CARGADO, 0.40),
    ("le sobró energía", LLANO, 0.00),
):
    # Lo cierto: el mejor de los tres sitios donde cabía, contra donde estuvo.
    real, _ = coste_exacto(resto, COMO_FUE, 1.0)
    opciones = {h: coste_exacto(resto, h, 1.0)[0]
                for h in (COMO_FUE, (12, 13), (0, 1))}
    cierto = real - min(opciones.values())
    ok(abs(cierto - esperado) < 0.005,
       f"{etiqueta}: la simulación exacta dice {cierto:.2f} € de más")
    d7 = optimo.del_dia(APARATOS, DIA, lava_2h,
                        reparto_bateria(resto, COMO_FUE, 1.0), SOLAR, precio_de)
    ok(d7 is not None and casi(d7["extra_eur"], esperado, 0.02),
       f"  y el modelo lo clava ({d7 and d7['extra_eur']} €)")
    ok(d7["battery"] is True, "  con la batería declarada dentro de la cuenta")

# Y el sesgo que esto corrige: el modelo sin batería —el mismo día sin nada en las
# claves de batería— canta 0,60 € en los dos casos. Es la cifra que se publicaba.
sin_bat = optimo.del_dia(APARATOS, DIA, lava_2h, reparto_con(lava_2h), SOLAR, precio_de)
ok(casi(sin_bat["extra_eur"], 0.60),
   f"sin batería en el día se sigue diciendo 0,60 € ({sin_bat['extra_eur']} €)")
ok(sin_bat["battery"] is False, "y se dice que la batería no está en esa cuenta")

print("\n7b · el día en que le sobró energía no se le echa nada en cara")
# El caso que se colaba: el aparato **ya estaba donde tocaba** —la simulación exacta
# dice que ponerlo al sol no habría cambiado un céntimo— y la tarjeta le señalaba un
# sobrecoste de sesenta céntimos. Si esto se rompe, se está aconsejando sobre un día
# que se hizo bien.
d7b = optimo.del_dia(APARATOS, DIA, lava_2h, reparto_bateria(LLANO, COMO_FUE, 1.0),
                     SOLAR, precio_de)
ok(d7b["rows"][0]["already_best"] is True, "se dice que ya estaba en su mejor hueco")
ok(casi(d7b["rows"][0]["extra_eur"], 0.0, 0.02),
   f"y su sobrecoste es cero ({d7b['rows'][0]['extra_eur']} €)")
ok(casi(d7b["battery_eur_kwh"], 0.0),
   f"porque el kilovatio de batería no valía nada ese día ({d7b['battery_eur_kwh']})")
ok(d7b["free_kwh"] == 0 and d7b["stored_kwh"] > 0,
   f"y el sobrante fue guardado, no vertido ({d7b['stored_kwh']} kWh)")

print("\n7c · lo que la batería dio a esa hora es un tope, no una barra libre")
# Los cuatro escalones, mirados de cerca: es la única parte del modelo que no se ve
# desde fuera con un día entero, porque a la hora en que un aparato estuvo de verdad el
# `from_battery` medido **ya lleva su consumo dentro** y el tope nunca aprieta. Donde
# aprieta es en las otras horas, que son las que el modelo propone.
#
# Una hora con: 1 kWh que se vertía, 2 kWh que se guardaban, 1,5 kWh que la batería
# entregó a la casa y un precio de 0,20 €. La batería vale 0,10 € el kilovatio.
UNA = optimo._Huecos([1.0], [2.0], [1.5], [0.20], 0.10, True)
eur, pagado, _peso = UNA.coste(0, [1.0])
ok(casi(eur, 0.0), f"el primer kilovatio es el vertido, y es gratis ({eur} €)")
eur, pagado, _peso = UNA.coste(0, [3.0])
# 1 gratis + 2 guardados × 0,9 × 0,10 = 0,18 €
ok(casi(eur, 0.18), f"los dos siguientes salen del guardado, a la ida y vuelta ({eur} €)")
eur, pagado, _peso = UNA.coste(0, [4.5])
# … + 1,5 de la batería × 0,10 = 0,33 €
ok(casi(eur, 0.33), f"y luego lo que la batería dio, a su valor ({eur} €)")
eur, pagado, _peso = UNA.coste(0, [10.0])
# … + 5,5 de la red × 0,20 = 1,43 €. **Sin el tope serían 0,33 €**: diez kilovatios
# gratis de una batería que a esa hora entregó uno y medio.
ok(casi(eur, 1.43), f"pasado el tope, lo pone la red y se paga ({eur} €)")
ok(casi(pagado, 7.0),
   f"y lo pagado son la batería y la red, no el sol ({pagado} kWh)")
# Y el tope se gasta: dos aparatos no se llevan el mismo kilovatio de batería.
UNA.ocupar(0, [4.5])
eur, _pagado, _peso = UNA.coste(0, [1.0])
ok(casi(eur, 0.20), f"colocado uno, al siguiente ya le toca la red ({eur} €)")

print("\n7d · «100 % con sol» y «0,02 € de más» no pueden salir juntos")
# De un aviso: *«el resumen del día dice que la lavadora ha usado 100 % con sol y me
# pone que ha gastado 0,02 € de más que si lo hubiera puesto a las 14h. Si ya fue todo
# sol, no es ya gratis?»*. Sí lo es, y las dos cifras eran ciertas a la vez: la culpa
# era de **aplanar el ciclo**.
#
# El día: la lavadora carga al principio —el calentamiento del agua— y baja al final.
# El sobrante de cada hora es justo lo suficiente para su forma real, y ni un vatio
# más. Aplanada, la parte de la cola se sale del sobrante de las 14:00 y el modelo
# cobra algo que la casa nunca pagó.
# Y con un hueco ancho por la mañana —tres horas con 1 kWh de sobrante— donde el
# rectángulo aplanado **sí** cabe entero: eso es lo que hacía que el modelo viejo
# propusiera otra hora y publicara un sobrecoste. Sin ese hueco la cifra salía cero
# igual y el banco no habría visto nada.
FORMA = {H(12): 0.90, H(13): 0.20, H(14): 0.05}
SOBRA = {9: 1.00, 10: 1.00, 11: 1.00, 12: 2.00, 13: 0.50, 14: 0.10}
# Solar = resto de la casa + el sobrante que se quiere en cada hora.
SOLAR_FORMA = {H(h): (CASA_RESTO + SOBRA[h] if h in SOBRA else 0.0) for h in range(24)}
lava_forma = {"lava": FORMA}
d7d = optimo.del_dia(APARATOS, DIA, lava_forma, reparto_con(lava_forma),
                     SOLAR_FORMA, precio_de)
f7d = d7d["rows"][0]
# A mano: con la forma medida, cada hora cabe en su sobrante (0,90 < 2,00 · 0,20 < 0,50
# · 0,05 < 0,10), así que el ciclo **no pagó nada**.
ok(casi(f7d["paid_kwh"], 0.0),
   f"con la forma medida el ciclo no pagó nada ({f7d['paid_kwh']} kWh)")
ok(casi(f7d["extra_eur"], 0.0),
   f"y por tanto no costó de más de lo que costó ({f7d['extra_eur']} €)")
ok(f7d["already_best"] is True, "se dice que ya estaba en su mejor hueco")
ok(casi(d7d["extra_eur"], 0.0), f"y el titular del día también ({d7d['extra_eur']} €)")
# Y la prueba de que el aplanado era el culpable: el mismo día con el mismo total
# repartido por igual entre las tres horas **sí** paga, porque la cola no cabe.
plano = round(sum(FORMA.values()) / 3, 4)
aplanado = {"lava": {h: plano for h in FORMA}}
d7dp = optimo.del_dia(APARATOS, DIA, aplanado, reparto_con(aplanado),
                      SOLAR_FORMA, precio_de)
ok(d7dp["rows"][0]["paid_kwh"] > 0.2,
   f"la misma energía aplanada sí se sale del sobrante "
   f"({d7dp['rows'][0]['paid_kwh']} kWh) — era el modelo, no el día")

print("\n7e · y por debajo de cinco céntimos no se propone hora")
# `MIN_EXTRA_EUR` estaba definido con su porqué escrito y **no se usaba en ningún
# sitio**: la tarjeta llevaba el 0,05 a mano para el titular del día y un `> 0` para
# las filas, así que una fila de dos céntimos traía consejo. Es la otra mitad del mismo
# aviso.
ok(optimo.MIN_EXTRA_EUR == 0.05, "el umbral sigue siendo el del plan del día")
# Un día en que mover la lavadora gana **algo** pero menos del umbral: 0,1 kWh de cola
# fuera del sobrante, a 0,30 € = 0,03 €.
SOBRA_JUSTO = {12: 2.00, 13: 0.50, 14: 0.0}
SOLAR_JUSTO = {H(h): (CASA_RESTO + SOBRA_JUSTO[h] if h in SOBRA_JUSTO else 0.0)
               for h in range(24)}
cola = {"lava": {H(12): 0.90, H(13): 0.20, H(14): 0.10}}
d7e = optimo.del_dia(APARATOS, DIA, cola, reparto_con(cola), SOLAR_JUSTO, precio_de)
f7e = d7e["rows"][0]
ok(casi(f7e["paid_kwh"], 0.10),
   f"la cola sí se paga: 0,10 kWh a 0,30 € = 0,03 € ({f7e['paid_kwh']} kWh)")
ok(casi(f7e["extra_eur"], 0.0),
   f"pero no se propone otra hora por tres céntimos ({f7e['extra_eur']} €)")
ok(f7e["already_best"] is True and f7e["best_at"] == f7e["ran_at"],
   "y la hora que se enseña es la suya, no una que no compensa")

print("\n8 · con la batería atada, la madrugada barata puede ganarle al sol")
# No es una rareza del modelo: la batería ya convertía el sol de mediodía en energía de
# la noche a 0,30 €/kWh, y consumirlo directo solo se ahorra el 10 % de la ida y vuelta
# —tres céntimos— frente a los veinte de diferencia entre tarifas. La simulación exacta
# lo confirma, y es lo que impide «corregir» el modelo para que nunca salga de noche.
por_sol, _ = coste_exacto(CARGADO, (12, 13), 1.0)
por_noche, _ = coste_exacto(CARGADO, (0, 1), 1.0)
ok(por_noche < por_sol,
   f"la simulación exacta prefiere la madrugada ({por_noche:.3f} € < {por_sol:.3f} €)")
d8 = optimo.del_dia(APARATOS, DIA, lava_2h,
                    reparto_bateria(CARGADO, COMO_FUE, 1.0), SOLAR, precio_de)
ok(d8["rows"][0]["best_at"][11:13] in ("00", "01"),
   f"y el modelo también, sin que nadie se lo diga ({d8['rows'][0]['best_at'][11:16]})")
# Lo que **no** puede pasar: que el vertido pierda contra cualquier cosa. Sol tirado a
# la red es el único kilovatio que de verdad es gratis, y ahí el orden es intocable.
vertiendo = reparto_bateria(CARGADO, COMO_FUE, 1.0)
for h in (12, 13, 14):
    vertiendo[H(h)]["to_grid"] = vertiendo[H(h)].pop("to_battery")
    vertiendo[H(h)]["to_battery"] = 0.0
d8b = optimo.del_dia(APARATOS, DIA, lava_2h, vertiendo, SOLAR, precio_de)
ok(d8b["rows"][0]["best_at"][11:13] in ("12", "13"),
   f"si el sol se vertía, gana el sol ({d8b['rows'][0]['best_at'][11:16]})")
ok(d8b["free_kwh"] > 0, f"y ese sobrante sí es gratis ({d8b['free_kwh']} kWh)")

print()
if fallos:
    print(f"{len(fallos)} fallos")
    sys.exit(1)
print("todo en verde")

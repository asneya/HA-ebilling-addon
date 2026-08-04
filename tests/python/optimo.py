"""El óptimo de ayer: lo que había sobre la mesa, medido y no previsto.

Es el «perfect optimization» de EMHASS traído a lo que Vatia puede afirmar: sobre un
día **ya cerrado**, con el sol, el consumo y los precios que de verdad hubo. Y por eso
se puede decir sin condicionales — un plan del día que viene depende de una previsión
que falla; esto no depende de ninguna.

Lo delicado no es la cuenta, es **qué se publica**. El modelo de aquí es más simple que
el del desglose de la factura (no tiene batería), así que publicar «tus aparatos
costaron X» pondría dos cifras del mismo día en dos pantallas — el defecto que esta
aplicación lleva corrigiendo desde la 0.48. Lo que se publica es una **diferencia**,
calculada dos veces con la misma cuenta y restada.

Lo que se comprueba, con un día hecho a mano para poder derivar la respuesta a mano:

  1. un aparato que se puso de noche, con sol de sobra al mediodía: hay ahorro, y es
     el que sale de multiplicar a mano
  2. uno que ya estaba en su mejor hueco: se dice, y su ahorro es cero
  3. dos aparatos no se llevan el mismo hueco (el turno, igual que en el plan)
  4. «el resto de la casa» es el suelo: si la casa ya se come el sol, no hay hueco
  5. sin sol, sin aparatos o sin precios no se inventa nada
  6. la cifra que se publica es la diferencia, y **no** hay ninguna que se pueda leer
     como «lo que gastaste»
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
ok(casi(fila["saving_eur"], 0.60),
   f"el ahorro es el que sale a mano: 2 kWh × 0,30 € ({fila['saving_eur']} €)")
ok(fila["best_at"][11:13] in ("12", "13"),
   f"y el mejor hueco es una hora de sol ({fila['best_at'][11:16]})")
ok(fila["ran_at"][11:13] == "22", f"con la hora a la que se puso ({fila['ran_at'][11:16]})")
ok(fila["already_best"] is False, "y no se dice que ya estuviera bien")
ok(casi(d["saving_eur"], 0.60), f"y el total es el mismo ({d['saving_eur']} €)")
ok(casi(d["free_kwh"], 7.5), f"con el sobrante libre del día ({d['free_kwh']} kWh)")

print("\n2 · uno que ya estaba en su mejor hueco")
ya = {"lava": {H(12): 1.0, H(13): 1.0}}
d2 = optimo.del_dia(APARATOS, DIA, ya, reparto_con(ya), SOLAR, precio_de)
f2 = d2["rows"][0]
ok(f2["already_best"] is True, "se dice que ya estaba donde tocaba")
ok(casi(f2["saving_eur"], 0.0), f"y su ahorro es cero ({f2['saving_eur']} €)")
ok(casi(d2["saving_eur"], 0.0), "y el del día también")

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
peor = min(d3["rows"], key=lambda f: f["saving_eur"] or 0)
ok(peor["best_grid_kwh"] > 0,
   f"al segundo le toca comprar algo, y se dice ({peor['best_grid_kwh']} kWh de red)")

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
ok(sin_precio is not None and sin_precio["saving_eur"] is None,
   "sin precios se calla el euro en vez de inventarlo")
ok(sin_precio["rows"] and sin_precio["rows"][0]["best_at"],
   "pero el hueco sí se dice, que no necesita precios")

print("\n6 · se publica una diferencia, no una factura")
# Es la comprobación que impide que este módulo se convierta en una segunda opinión
# sobre lo que costó el día. Ninguna clave puede leerse como «lo que gastaste».
claves = set(d["rows"][0]) | set(d)
prohibidas = {k for k in claves if k in ("eur", "cost", "total_eur", "spent_eur")}
ok(not prohibidas, f"ninguna clave se puede leer como una factura ({prohibidas})")
ok("saving_eur" in d and "saving_eur" in d["rows"][0],
   "lo que se publica es el ahorro que había sobre la mesa")

print()
if fallos:
    print(f"{len(fallos)} fallos")
    sys.exit(1)
print("todo en verde")

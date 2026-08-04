"""El desglose de la factura por electrodoméstico: que cuadre y que cobre por origen.

Un desglose de una factura tiene una sola obligación de verdad: **sumar la factura**.
Si las filas suman menos que el total, quien lo mira concluye que la aplicación no
sabe de dónde sale su dinero, y con razón. Y hay tres maneras de descuadrar que no
hacen ruido:

  · dejar fuera lo que no está medido —la cocina, las luces, la bomba de calor— y
    enseñar solo los enchufes con sensor;
  · repartir a prorrata de los kWh, que además borra el consejo de toda la
    aplicación: un aparato de mediodía y otro de las nueve de la noche gastan los
    mismos kilovatios y no cuestan lo mismo;
  · y olvidar que **la factura cobra lo importado, no lo que la casa consumió de la
    red**: lo que la red metió en la batería de madrugada está en la factura y no lo
    consumió ningún aparato a esa hora.

Lo que se comprueba, con cifras hechas a mano para poder derivar la respuesta a
mano en vez de comparar contra lo que salga:

  1. la identidad: Σ red(aparatos) + red(resto) + red→batería + sin asignar = importada
  2. «el resto de la casa» es la resta, hora a hora
  3. el coste va por origen: dos aparatos con los mismos kWh a horas distintas
     cuestan distinto, y ninguno paga por lo que puso el sol
  4. red→batería sale con su fila y a su precio
  5. «Sin asignar» aparece cuando el contador de la casa marca menos de lo que la
     red le entregó, y no aparece cuando los contadores se llevan bien
  6. dos enchufes que suman más que la casa se escalan, y el recorte se declara
  7. sin tarifa no hay euros inventados
  8. y al abrir una fila: los días, los tramos, el día más caro y a qué horas se pone
"""
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(RAIZ / "vatia" / "app"))

import desglose  # noqa: E402
import series as series_mod  # noqa: E402

fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


def casi(a, b, tol=0.005):
    return a is not None and b is not None and abs(a - b) <= tol


# ── El día de mentira, hecho a mano ─────────────────────────────────────────
#
# Tres horas que cubren los tres casos que importan. Las cifras son de contador,
# en kWh, y el reparto se construye con el mismo `split_flows` que usa la
# aplicación: si el banco montara los splits a mano estaría comprobando el banco.
#
#   03:00  noche: 2,0 importados, de los que 1,2 cargan la batería → 0,8 a la casa
#   13:00  mediodía: 4,0 de sol, la casa se lleva 2,5 y no se importa nada
#   21:00  noche: 3,0 importados, la casa se lleva 3,0, la batería aporta 0,5
H3, H13, H21 = "2026-03-10T03:00:00", "2026-03-10T13:00:00", "2026-03-10T21:00:00"

CONTADORES = {
    #      pv,  carga, vertido, importada, descarga, casa
    H3:  {"pv_energy": 0.0, "battery_charge_energy": 1.2, "grid_export_energy": 0.0,
          "grid_import_energy": 2.0, "battery_discharge_energy": 0.0,
          "home_energy": 0.8},
    H13: {"pv_energy": 4.0, "battery_charge_energy": 1.5, "grid_export_energy": 0.0,
          "grid_import_energy": 0.0, "battery_discharge_energy": 0.0,
          "home_energy": 2.5},
    H21: {"pv_energy": 0.0, "battery_charge_energy": 0.0, "grid_export_energy": 0.0,
          "grid_import_energy": 3.0, "battery_discharge_energy": 0.5,
          "home_energy": 3.5},
}


def reparto_de(contadores):
    return series_mod.reparto_por_horas(contadores, True, (False, False))


def importada_de(contadores):
    return {iso: v.get("grid_import_energy", 0.0) for iso, v in contadores.items()}


# Precios: valle de madrugada, llano al mediodía, punta por la noche. Elegidos
# distintos a propósito: con un precio plano el punto 3 no se podría distinguir.
PRECIOS = {H3: 0.08, H13: 0.15, H21: 0.30}
precio_de = PRECIOS.get

APARATOS = [
    {"id": "coche", "name": "Coche", "color": "#1", "icon": "coche-electrico"},
    {"id": "lava", "name": "Lavadora", "color": "#2", "icon": "lavadora"},
    {"id": "nevera", "name": "Nevera", "color": "#3", "icon": "nevera"},
]

# El coche carga de madrugada (0,6 de los 0,8 que la casa gastó a las 3), la
# lavadora al mediodía (1,0) y la nevera un poco a cada hora.
CONSUMO = {
    "coche": {H3: 0.6},
    "lava": {H13: 1.0},
    "nevera": {H3: 0.1, H13: 0.1, H21: 0.1},
}

print("1-2 · la identidad y la resta")
reparto = reparto_de(CONTADORES)
importada = importada_de(CONTADORES)
d = desglose.filas(APARATOS, CONSUMO, reparto, importada, precio_de)

por_id = {f["id"]: f for f in d["rows"]}
ok(d is not None and len(d["rows"]) >= 4, f"salen las filas ({len(d['rows'])})")
ok(desglose.ID_RESTO in por_id, "y entre ellas «el resto de la casa»")

# La resta, hora a hora: 0,8−0,7 a las 3; 2,5−1,1 al mediodía; 3,5−0,1 por la noche.
resto_esperado = (0.8 - 0.7) + (2.5 - 1.1) + (3.5 - 0.1)
ok(casi(por_id[desglose.ID_RESTO]["kwh"], resto_esperado),
   f"el resto es la resta: {por_id[desglose.ID_RESTO]['kwh']} = {round(resto_esperado, 3)}")

total_red = sum(f["grid_kwh"] for f in d["rows"])
ok(casi(total_red, d["imported_kwh"]),
   f"Σ red de las filas = importada del ciclo ({total_red} = {d['imported_kwh']})")
ok(casi(d["imported_kwh"], 5.0), f"y la importada es la de los contadores ({d['imported_kwh']})")

suma_casa = sum(f["kwh"] for f in d["rows"] if f["kind"] in ("aparato", "resto"))
ok(casi(suma_casa, d["home_kwh"]),
   f"y el consumo repartido = el de la casa ({suma_casa} = {d['home_kwh']})")

print("\n3 · el coste va por origen, no por kWh")
# La nevera gasta lo mismo (0,1) en las tres horas. Lo del mediodía no le cuesta
# nada —a las 13 la casa no importó un vatio— y lo de la noche le cuesta a 0,30.
nevera = por_id["nevera"]
ok(casi(nevera["kwh"], 0.3), f"la nevera gasta 0,3 en total ({nevera['kwh']})")
ok(nevera["sun_kwh"] > 0, f"y algo suyo lo puso el sol ({nevera['sun_kwh']} kWh)")
# A prorrata de los kWh sobre el término de energía, la nevera pagaría
# 0,3/6,8 × total. Se comprueba que **no** es eso.
energia_total = sum(PRECIOS[iso] * importada[iso] for iso in CONTADORES)
prorrata = nevera["kwh"] / d["home_kwh"] * energia_total
ok(not casi(nevera["eur"], prorrata, 0.01),
   f"y no paga a prorrata de los kWh ({nevera['eur']} € frente a {round(prorrata, 2)} €)")

# El coche y la lavadora: mismos kWh de aparato no, pero sí la comparación que
# importa —el coche se lleva red de madrugada y la lavadora sol de mediodía.
coche, lava = por_id["coche"], por_id["lava"]
ok(lava["grid_kwh"] == 0.0 and lava["eur"] == 0.0,
   f"la lavadora de mediodía no cuesta nada ({lava['eur']} €, {lava['grid_kwh']} kWh de red)")
ok(coche["eur"] > 0, f"y el coche de madrugada sí ({coche['eur']} €)")
# Su parte de la hora: 0,6 de los 0,8 de la casa, y a las 3 todo lo que la casa
# gastó vino de la red (0,8 de 0,8) → 0,6 kWh × 0,08 = 0,048 → 0,05 €.
ok(casi(coche["grid_kwh"], 0.6) and casi(coche["eur"], 0.05),
   f"y cuesta lo que sale de su hora y su precio ({coche['grid_kwh']} kWh × 0,08 = {coche['eur']} €)")

print("\n4 · la batería cargada de red")
bat = por_id.get(desglose.ID_BATERIA)
ok(bat is not None, "sale con su fila")
ok(bat and casi(bat["kwh"], 1.2), f"con lo que la red le metió ({bat and bat['kwh']})")
ok(bat and casi(bat["eur"], 1.2 * 0.08),
   f"y a su precio, no al medio ({bat and bat['eur']} = {round(1.2 * 0.08, 2)})")

print("\n5 · «Sin asignar»")
ok(desglose.ID_SIN_ASIGNAR not in por_id,
   "no aparece con contadores que se llevan bien")

# Ahora el contador de la casa marca menos de lo que la red le entregó a las 21:
# la red entregó 3,0 y la casa dice 1,0. Sobran 2,0 comprados que nadie colocó.
torcidos = {iso: dict(v) for iso, v in CONTADORES.items()}
torcidos[H21]["home_energy"] = 1.0
torcidos[H21]["battery_discharge_energy"] = 0.0
d2 = desglose.filas(APARATOS, CONSUMO, reparto_de(torcidos), importada_de(torcidos),
                    precio_de)
por_id2 = {f["id"]: f for f in d2["rows"]}
sin = por_id2.get(desglose.ID_SIN_ASIGNAR)
ok(sin is not None, "aparece cuando la casa marca menos de lo que la red le dio")
ok(sin and casi(sin["kwh"], 2.0), f"con lo que sobra ({sin and sin['kwh']})")
ok(casi(sum(f["grid_kwh"] for f in d2["rows"]), d2["imported_kwh"]),
   "y con ella la identidad se mantiene: sigue sumando la importada")

print("\n6 · dos enchufes que suman más que la casa")
# A las 13 la casa gastó 2,5 y los enchufes dicen 3,0: 0,5 de ruido de medida.
mucho = {"coche": {H3: 0.6}, "lava": {H13: 2.0}, "nevera": {H13: 1.0}}
d3 = desglose.filas(APARATOS, mucho, reparto, importada, precio_de)
por_id3 = {f["id"]: f for f in d3["rows"]}
ok(casi(d3["trimmed_kwh"], 0.5), f"se declara el recorte ({d3['trimmed_kwh']} kWh)")
ok(por_id3[desglose.ID_RESTO]["kwh"] >= 0, "el resto no sale negativo")
medido13 = sum(
    f["kwh"] for i, f in por_id3.items() if i in ("lava", "nevera"))
ok(casi(medido13, 2.5), f"y los dos, escalados, suman la casa de esa hora ({medido13})")
ok(casi(sum(f["grid_kwh"] for f in d3["rows"]), d3["imported_kwh"]),
   "la identidad aguanta el escalado")

print("\n7 · sin precios no hay euros")
d4 = desglose.filas(APARATOS, CONSUMO, reparto, importada, lambda _iso: None)
ok(d4["eur"] is None, "el total va sin euros")
ok(all(f["eur"] is None for f in d4["rows"]), "y ninguna fila se los inventa")
ok(casi(sum(f["grid_kwh"] for f in d4["rows"]), d4["imported_kwh"]),
   "pero los kWh y su origen siguen cuadrando")

print("\n8 · lo que la suma del mes esconde")
# Una fila que dice «7,2 kWh · 1,19 €» no deja hacer nada. Lo accionable es la hora, y
# para eso hace falta abrir la fila. Se comprueba con dos días hechos a mano: el
# lavavajillas a las 21 y 22 del día 10 y otra vez a las 13 del 11.
D10 = "2026-03-10T"
D11 = "2026-03-11T"
def hh(base, h):
    return f"{base}{h:02d}:00:00"

CONT2 = {}
for base in (D10, D11):
    for h in (13, 21, 22):
        CONT2[hh(base, h)] = {
            "pv_energy": 4.0 if h == 13 else 0.0,
            "battery_charge_energy": 0.0, "grid_export_energy": 0.0,
            "grid_import_energy": 0.0 if h == 13 else 3.0,
            "battery_discharge_energy": 0.0,
            "home_energy": 3.0,
        }
PRECIOS2 = {hh(D10, 13): 0.15, hh(D10, 21): 0.30, hh(D10, 22): 0.30,
            hh(D11, 13): 0.15, hh(D11, 21): 0.30, hh(D11, 22): 0.30}
LAVAV = [{"id": "lavav", "name": "Lavavajillas", "color": "#1", "icon": "lavavajillas"}]
# Día 10: dos horas seguidas de noche (caro). Día 11: una hora al mediodía (gratis).
USO = {"lavav": {hh(D10, 21): 1.0, hh(D10, 22): 1.0, hh(D11, 13): 1.0}}
d8 = desglose.filas(LAVAV, USO, reparto_de(CONT2), importada_de(CONT2), PRECIOS2.get)
# Por id y no por posición: las filas van ordenadas por lo que cuestan, y «el resto de
# la casa» puede ir primero — no lleva detalle, porque no es un aparato que se mueva.
por_id8 = {f["id"]: f for f in d8["rows"]}
ok("detail" not in por_id8.get(desglose.ID_RESTO, {}),
   "«el resto de la casa» no lleva detalle: no es algo que se pueda mover")
det = por_id8["lavav"]["detail"]
ok(det.get("days") == 2, f"cuenta los días que se usó ({det.get('days')})")
ok(det.get("runs") == 2,
   f"y los tramos, que no son ciclos: dos horas seguidas cuentan una vez ({det.get('runs')})")
peor = det.get("worst_day") or {}
ok(peor.get("date") == "2026-03-10",
   f"el día más caro es el de la noche ({peor.get('date')})")
# Las dos horas de noche: su parte es 1,0 de los 3,0 de la casa, y a esas horas la casa
# se lo lleva todo de la red → 2 × (1/3 × 3,0) × 0,30 = 0,60 €.
ok(casi(peor.get("eur"), 0.60), f"con lo que costó ese día ({peor.get('eur')} €)")
ok(det["by_hour"][21] > 0 and det["by_hour"][22] > 0 and det["by_hour"][13] > 0,
   "y a qué horas se pone, sumado por hora del día")
ok(sum(det["by_hour"]) > 2.9 and abs(sum(det["by_hour"]) - 3.0) < 0.01,
   f"que suma lo que gastó ({sum(det['by_hour'])} de 3,0 kWh)")
# Un tramo es horas **seguidas**: tres sueltas son tres tramos, no uno.
sueltas = {"lavav": {hh(D10, 13): 1.0, hh(D10, 21): 1.0, hh(D11, 13): 1.0}}
d8b = desglose.filas(LAVAV, sueltas, reparto_de(CONT2), importada_de(CONT2), PRECIOS2.get)
sueltos = {f["id"]: f for f in d8b["rows"]}["lavav"]["detail"]["runs"]
ok(sueltos == 3, f"horas sueltas son tramos sueltos ({sueltos})")

print()
if fallos:
    print(f"{len(fallos)} fallos")
    sys.exit(1)
print("todo en verde")

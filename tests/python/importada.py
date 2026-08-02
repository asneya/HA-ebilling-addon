"""La energía importada no puede desaparecer del resumen.

El fallo: el contador dice 6,2 kWh comprados a la compañía y la fila «Desde la
red» pone 0,3. La causa no era el reparto entre filas sino una **fuga**:

    grid_to_battery = max(carga - to_battery, 0)      <-- sin techo
    grid_home       = max(importado - grid_to_battery, 0)

`grid_to_battery` no estaba acotado por lo importado. En cuanto un intervalo
tenía el contador de exportación por delante del solar —entonces `pv - to_grid`
es cero y *toda* la carga parece de red— se inventaba una carga de red que
nadie compró, y el `max(…, 0)` de la línea siguiente borraba la importación
real de ese intervalo. No la cambiaba de fila: la borraba. Repetido a lo largo
de un día con nubes, 6,2 kWh salían como 0,3.

Y a cinco minutos eso pasa constantemente, porque los seis contadores son
estadísticas de sensores que no publican a la vez.

   1. lo importado se reparte entre la casa y la batería, sin fugas
   2. lo descargado, entre la casa y la red, sin fugas
   3. y sigue distinguiendo una carga de red de verdad
   4. un día entero: la noche gemela sale entera en «Desde la red»
   5. el desfase entre contadores ya no se lleva la importación por delante
   6. repartir por horas absorbe el desfase que cinco minutos no absorbe
   7. tras el ajuste al contador, la leyenda y el desglose dicen lo mismo
   8. la potencia instantánea tiene el mismo techo
   9. de punta a punta: /api/live no pierde ni un vatio-hora importado
"""
import json
import math
import os
import sys
import urllib.request

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
from series import (                                          # noqa: E402
    por_horas, power_flows, rescale_flows, split_flows,
)

fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


PASO = 5.0 / 60.0

print("1-3 · los dos techos que faltaban")
CASOS = [
    ("exportación por delante del solar",
     dict(pv=0.30, charge=0.25, export=0.32, imported=0.03, discharge=0.0)),
    ("carga por delante del solar",
     dict(pv=0.02, charge=0.25, export=0.0, imported=0.03, discharge=0.0)),
    ("carga de red de verdad, de noche",
     dict(pv=0.0, charge=0.25, export=0.0, imported=0.28, discharge=0.0)),
    ("la casa compra y punto",
     dict(pv=0.0, charge=0.0, export=0.0, imported=0.03, discharge=0.0)),
    ("mediodía de libro",
     dict(pv=0.40, charge=0.15, export=0.20, imported=0.0, discharge=0.0)),
]
for texto, kw in CASOS:
    r = split_flows(**kw)
    suma = r["from_grid"] + r["grid_to_battery"]
    ok(abs(suma - kw["imported"]) < 1e-9,
       f"lo importado se reparte entero · {texto} "
       f"({suma:.3f} = {kw['imported']:.3f})")

CASOS_BAT = [
    ("exportación por delante del solar, con la batería dando",
     dict(pv=0.30, charge=0.0, export=0.40, imported=0.0, discharge=0.05)),
    ("atardecer: la batería alimenta la casa",
     dict(pv=0.0, charge=0.0, export=0.0, imported=0.0, discharge=0.20)),
]
for texto, kw in CASOS_BAT:
    r = split_flows(**kw)
    suma = r["from_battery"] + r["battery_to_grid"]
    ok(abs(suma - kw["discharge"]) < 1e-9,
       f"lo descargado también · {texto} ({suma:.3f} = {kw['discharge']:.3f})")

# El techo no puede haberse comido la distinción que motiva todo el reparto.
noche = split_flows(pv=0.0, charge=0.25, export=0.0, imported=0.28, discharge=0.0)
ok(abs(noche["grid_to_battery"] - 0.25) < 1e-9,
   f"una carga de red de madrugada sigue siendo de red ({noche['grid_to_battery']:.3f})")
sol = split_flows(pv=0.40, charge=0.25, export=0.0, imported=0.0, discharge=0.0)
ok(sol["grid_to_battery"] == 0.0 and abs(sol["to_battery"] - 0.25) < 1e-9,
   "y una de sol sigue siendo de sol")


def dia(desfase=0, nubes=False):
    """Un día en buckets de cinco minutos (kWh), como el descrito.

    De noche la casa compra todo lo que gasta —las dos curvas, gemelas—, de
    madrugada la batería termina de vaciarse, y de día el sol carga la batería
    y vierte el sobrante.

    `desfase` retrasa el contador de **carga** N buckets respecto al solar, que
    es lo que pasa de verdad entre estadísticas de sensores distintos. Con
    `nubes`, el sol se cae a plomo cada pocos minutos: la casa compra ese rato
    y el contador de carga, retrasado, sigue apuntando la carga del rato de
    antes. Ese cruce —importación real y carga que el sol de *ese* bucket no
    explica— es exactamente donde la importación se perdía.
    """
    n = 288
    pv = [0.0] * n; carga = [0.0] * n; descarga = [0.0] * n
    exporta = [0.0] * n; importa = [0.0] * n; casa = [0.0] * n
    for i in range(n):
        h = i * 5 / 60.0
        w_casa = 350.0 if (h < 8 or h >= 20) else 500.0
        casa[i] = w_casa * PASO / 1000.0
        w_pv = 4500.0 * math.sin(math.pi * (h - 8) / 10.0) if 8 <= h < 18 else 0.0
        if nubes and 8 <= h < 18 and i % 3 == 0:
            w_pv = 0.0
        pv[i] = w_pv * PASO / 1000.0
        sobra = w_pv - w_casa
        if sobra > 0:
            w_carga = min(3000.0, sobra)
            # El contador de carga publica con retraso: el mismo vatio-hora cae
            # en un bucket posterior al del solar que lo produjo.
            carga[min(n - 1, i + desfase)] += w_carga * PASO / 1000.0
            exporta[i] = (sobra - w_carga) * PASO / 1000.0
        else:
            importa[i] = -sobra * PASO / 1000.0
    return dict(pv_energy=pv, battery_charge_energy=carga,
                grid_export_energy=exporta, grid_import_energy=importa,
                battery_discharge_energy=descarga, home_energy=casa)


def buckets_de(d):
    return {f"2026-08-02T{i // 12:02d}:{(i % 12) * 5:02d}:00+02:00":
            {k: v[i] for k, v in d.items()} for i in range(288)}


def reparte(d, agrupar, con_casa=False):
    per = buckets_de(d)
    if agrupar:
        per = por_horas(per)
    partes = [
        split_flows(v["pv_energy"], v["battery_charge_energy"],
                    v["grid_export_energy"], v["grid_import_energy"],
                    v["battery_discharge_energy"],
                    v["home_energy"] if con_casa else None)
        for v in per.values()
    ]
    return {k: sum(p[k] for p in partes) for k in partes[0]}


print("\n4-6 · un día entero")
for desfase, nubes, etiqueta in ((0, False, "cielo limpio, contadores en fase"),
                                 (1, False, "exportación 5 min por delante"),
                                 (2, True, "nubes y 10 min de desfase")):
    d = dia(desfase, nubes)
    imp = sum(d["grid_import_energy"])
    noche = sum(v for i, v in enumerate(d["grid_import_energy"]) if i * 5 / 60.0 < 8)
    fino = reparte(d, agrupar=False)
    hora = reparte(d, agrupar=True)
    ok(abs(fino["from_grid"] + fino["grid_to_battery"] - imp) < 1e-6,
       f"a 5 min no se pierde nada · {etiqueta} "
       f"({fino['from_grid'] + fino['grid_to_battery']:.3f} = {imp:.3f})")
    ok(hora["from_grid"] >= noche - 1e-6,
       f"y por horas la noche entera va a la casa · {etiqueta} "
       f"({hora['from_grid']:.3f} ≥ {noche:.3f})")
    ok(hora["from_grid"] >= fino["from_grid"] - 1e-9,
       f"agrupar por horas no empeora el reparto · {etiqueta} "
       f"({hora['from_grid']:.3f} ≥ {fino['from_grid']:.3f})")

# El caso que se reportó, con números redondos: 6,2 kWh comprados, casi todos
# de noche, y la batería cargada de sol.
d = dia(desfase=1, nubes=True)
imp = sum(d["grid_import_energy"])
r = reparte(d, agrupar=True)
ok(r["from_grid"] > imp * 0.9,
   f"el caso reportado: lo comprado llega a la casa "
   f"({r['from_grid']:.2f} de {imp:.2f} kWh)")

print("\n7 · el ajuste al contador del día")
totals = {"pv_energy": sum(d["pv_energy"]) * 1.02,
          "grid_import_energy": imp * 1.03,
          "battery_discharge_energy": 0.0,
          "battery_charge_energy": sum(d["battery_charge_energy"]),
          "grid_export_energy": sum(d["grid_export_energy"])}
aj = rescale_flows(r, totals)
suma = aj["from_grid"] + aj["grid_to_battery"]
ok(abs(suma - totals["grid_import_energy"]) < 1e-6,
   f"la leyenda y el desglose salen del mismo número "
   f"({suma:.3f} = {totals['grid_import_energy']:.3f})")
ok(aj["from_grid"] > totals["grid_import_energy"] * 0.9,
   f"y «Desde la red» no se aplasta ({aj['from_grid']:.2f} "
   f"de {totals['grid_import_energy']:.2f})")
gen = aj["to_home"] + aj["to_battery"] + aj["to_grid"]
ok(abs(gen - totals["pv_energy"]) < 1e-6,
   f"la generación sigue cuadrando con la suya ({gen:.3f})")

print("\n7b · la invariante, con contadores adversos")
# Lo que el usuario mira es la leyenda («Importada: 6,2 kWh») y el desglose
# («Desde la red»). La diferencia entre las dos tiene que ser exactamente lo que
# cargó la batería, pase lo que pase con los sensores. Se prueba con mil días
# aleatorios, incluidos los incoherentes: contadores que se contradicen es
# justo cuando el resumen tiene que seguir sumando.
import random                                                 # noqa: E402

random.seed(20260802)
peor = (0.0, None)
inventado = 0
for _ in range(1000):
    imp = round(random.uniform(0, 20), 3)
    crudo = {
        "to_home": random.uniform(0, 10), "to_battery": random.uniform(0, 8),
        "to_grid": random.uniform(0, 8), "from_solar": random.uniform(0, 10),
        "from_battery": random.uniform(0, 8), "from_grid": random.uniform(0, 20),
        "grid_to_battery": random.uniform(0, 8),
        "battery_to_grid": random.uniform(0, 5), "home_total": 0.0,
    }
    crudo["home_total"] = crudo["from_solar"] + crudo["from_battery"] + crudo["from_grid"]
    tot = {"pv_energy": round(random.uniform(0, 30), 3),
           "grid_import_energy": imp,
           "battery_discharge_energy": round(random.uniform(0, 10), 3),
           "home_energy": round(random.uniform(0, 30), 3)}
    if random.random() < 0.25:
        tot.pop("home_energy")           # contador de casa descartado
    r = rescale_flows(crudo, tot)
    suma = r["from_grid"] + r["grid_to_battery"]
    if suma < imp - 1e-6:                # importación perdida: nunca
        peor = max(peor, (imp - suma, tot), key=lambda t: t[0])
    if suma > imp + 1e-6:
        inventado += 1                   # solo el caso documentado
    if min(r["from_grid"], r["from_solar"], r["from_battery"],
           r["grid_to_battery"]) < -1e-9:
        peor = (999.0, tot)
ok(peor[1] is None,
   f"en 1000 días revueltos no se pierde ni un vatio-hora importado"
   f"{'' if peor[1] is None else f' (falta {peor[0]:.3f})'}")
print(f"        ({inventado} de 1000 apuntan a la red por encima de su contador,")
print("         que es la contradicción entre sensores que se enseña a propósito)")

print("\n8 · la potencia instantánea")
p = power_flows({"pv": 3000, "grid_export": 3200, "battery_charge": 2000,
                 "grid_import": 150, "battery_discharge": 0})
ok(abs(p["grid_home"] + p["grid_battery"] - 150) < 1e-9,
   f"con el sensor de exportación por delante, los 150 W siguen ahí "
   f"({p['grid_home']:.0f} + {p['grid_battery']:.0f})")
p2 = power_flows({"pv": 0, "grid_import": 2500, "battery_charge": 2000,
                  "grid_export": 0, "battery_discharge": 0})
ok(abs(p2["grid_battery"] - 2000) < 1e-9 and abs(p2["grid_home"] - 500) < 1e-9,
   f"y de noche la carga de red se ve entera ({p2['grid_battery']:.0f} W)")

BASE = os.environ.get("VATIA_BASE")
if BASE:
    print("\n9 · de punta a punta")
    with urllib.request.urlopen(BASE + "/api/live", timeout=30) as resp:
        e = json.load(resp)["energy"]
    m = e["meters"]
    fila = next(r for r in e["home"]["rows"] if r["key"] == "from_grid")
    importado, desde_red, a_bateria = m["grid_import"], fila["kwh"], m["grid_to_battery"]
    ok(abs(desde_red + a_bateria - importado) < 0.02,
       f"lo importado sale entero en el resumen "
       f"({desde_red} + {a_bateria} = {importado} kWh)")
    ok(importado <= 0.01 or desde_red > 0,
       f"y si se ha comprado algo, a la casa llega algo ({desde_red} kWh)")

    # Y el diagnóstico de Ajustes tiene que decir exactamente lo mismo: si las
    # dos pantallas discrepan, la que se mira no sirve para comprobar la otra.
    with urllib.request.urlopen(BASE + "/api/diagnostics", timeout=60) as resp:
        rep = json.load(resp)["reparto"]
    ok(rep is not None and abs(rep["grid"]["home"] - desde_red) < 0.02,
       f"el diagnóstico dice lo mismo que el resumen "
       f"({rep and rep['grid']['home']} = {desde_red})")
    # Lo importado sí cuadra siempre: el reparto lo garantiza y no hay ninguna
    # otra cosa que pueda recortarlo después.
    ok(rep is not None and rep["grid"]["unplaced"] == 0.0,
       f"y su reparto de la red cuadra con el contador, entero "
       f"({rep and rep['grid']['placed']} = {rep and rep['grid']['meter']})")
    # Lo descargado **puede** no cuadrar, y no por un fallo: si el contador de
    # la casa dice que consumió menos de lo que la batería asegura haberle dado,
    # esa parte no la coloca nadie. Lo que no puede es sobrar.
    b = rep and rep["battery"]
    ok(b is not None and b["placed"] <= b["meter"] + 0.02,
       f"y la batería nunca coloca más de lo que descargó "
       f"({b and b['placed']} ≤ {b and b['meter']})")
    ok(b is not None and abs(b["placed"] + b["unplaced"] - b["meter"]) < 0.02,
       f"y lo que no coloca se dice, en vez de callarlo "
       f"({b and b['placed']} + {b and b['unplaced']} = {b and b['meter']})")

print()
if fallos:
    print("--- fallos ---")
    for f in dict.fromkeys(fallos):
        print("  " + f)
print(f"{len(fallos)} fallos" if fallos else "todo en verde")
sys.exit(1 if fallos else 0)

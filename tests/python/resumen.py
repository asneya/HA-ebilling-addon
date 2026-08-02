"""El consumo de la casa en el resumen de energía.

Dos fallos, por orden de aparición:

**0.41.1** — «A la casa» (columna de generación) y «Desde solar» (columna de
consumo) son la misma energía vista desde los dos lados, y `rescale_flows`
escalaba cada columna con su propio factor. Con los contadores desfasados el
resumen enseñaba las dos cifras a la vez y distintas.

**0.41.2** — el arreglo anterior encajaba la red en «lo que quede» tras el sol.
Si el contador de la casa se queda corto, «Desde la red» se aplastaba (0,11 de
6,2 kWh importados) y el resto de la importación se atribuía a cargar la
batería, aunque las curvas enseñaran la batería cargándose de sol. Ahora la red
va primero y entera, como en `split_flows` y por lo mismo: es una entrega
medida por el contador de la compañía, ya descontada de lo que carga la batería
intervalo a intervalo.

  1. con los contadores desfasados, «A la casa» y «Desde solar» son una cifra
  2. y las filas de la casa suman su propio total
  3. la generación sigue cuadrando con su contador
  4. la red no se recorta nunca: si la casa mide poco, cede el sol
  5. el caso real: 6,2 kWh importados a la casa, batería cargada de sol
  6. sin contador de la casa, el total es la suma de las filas
  7. si la casa gastó más de lo que hay entre todos, el hueco va a la red
  8. la batería nunca da más de lo que descargó
  9. de punta a punta: /api/live dice lo mismo por los dos lados
"""
import json
import os
import sys
import urllib.request

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
from series import rescale_flows                             # noqa: E402

fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


def reparto(**kw):
    base = {"to_home": 0.0, "to_battery": 0.0, "to_grid": 0.0,
            "from_solar": 0.0, "from_battery": 0.0, "from_grid": 0.0,
            "home_total": 0.0}
    base.update(kw)
    return base


CRUDO = reparto(to_home=1000, to_battery=600, to_grid=400,
                from_solar=1000, from_battery=500, from_grid=500,
                home_total=2000)

print("1-3 · contadores desfasados: el sol y la casa miden distinto")
r = rescale_flows(CRUDO, {"pv_energy": 2200, "home_energy": 1900})
filas = r["from_solar"] + r["from_battery"] + r["from_grid"]
ok(abs(r["to_home"] - r["from_solar"]) < 1e-9,
   f"«A la casa» y «Desde solar» son el mismo número ({r['to_home']:.1f} Wh)")
ok(abs(r["from_grid"] - 500) < 1e-9,
   f"la red entra entera, sin recortar ({r['from_grid']:.1f} = 500)")
ok(abs(filas - r["home_total"]) < 1e-9,
   f"las filas de la casa suman su total ({filas:.1f} = {r['home_total']:.1f})")
ok(abs(r["home_total"] - 1900) < 1e-9, "y el total es el del contador (1900)")
ok(abs(r["from_battery"] - 300) < 1e-9,
   f"la deriva la absorbe la batería ({r['from_battery']:.1f} de 500)")
gen = r["to_home"] + r["to_battery"] + r["to_grid"]
ok(abs(gen - 2200) < 1e-9, f"la generación cuadra con el suyo ({gen:.1f} = 2200)")

print("\n4 · la casa mide menos que la red y el sol juntos")
r = rescale_flows(CRUDO, {"pv_energy": 2200, "home_energy": 900})
filas = r["from_solar"] + r["from_battery"] + r["from_grid"]
ok(abs(r["from_grid"] - 500) < 1e-9,
   f"la red sigue entera ({r['from_grid']:.1f} = 500)")
ok(abs(filas - 900) < 1e-9, f"y las filas suman lo medido ({filas:.1f} = 900)")
ok(min(r["from_solar"], r["from_battery"], r["from_grid"]) >= 0,
   "sin ninguna fila en negativo")
ok(r["from_solar"] < r["to_home"],
   f"cede el sol, y la contradicción queda a la vista ({r['from_solar']:.1f} < {r['to_home']:.1f})")

print("\n5 · el caso real: todo lo importado fue a la casa")
# 6,2 kWh importados sin cargar la batería (se cargó de sol), y un contador de
# casa que mide poco más que lo que el sol le dio. El 0.41.1 dejaba «Desde la
# red» en 0,11 y el resumen decía que 6,09 habían cargado la batería.
caso = reparto(to_home=10000, to_battery=4000, to_grid=1000,
               from_solar=10000, from_battery=0, from_grid=6200,
               home_total=16200)
caso["grid_to_battery"] = 0.0
r = rescale_flows(caso, {"pv_energy": 15000, "home_energy": 10310,
                         "grid_import_energy": 6200})
ok(abs(r["from_grid"] - 6200) < 1e-9,
   f"los 6,2 kWh importados se quedan en la casa ({r['from_grid']:.0f} Wh)")
implicita = 6200 - r["from_grid"]
ok(abs(implicita) < 1e-9,
   f"y no se atribuye nada a cargar la batería ({implicita:.0f} Wh)")
filas = r["from_solar"] + r["from_battery"] + r["from_grid"]
ok(abs(filas - 10310) < 1e-9, f"las filas suman el contador ({filas:.0f} = 10310)")
ok(r["from_battery"] == 0, "y la batería no se inventa nada (descargó 0)")

print("\n6 · sin contador de la casa")
r = rescale_flows(CRUDO, {"pv_energy": 2200})
filas = r["from_solar"] + r["from_battery"] + r["from_grid"]
ok(abs(r["to_home"] - r["from_solar"]) < 1e-9, "las dos cifras siguen siendo una")
ok(abs(filas - r["home_total"]) < 1e-9,
   f"y el total es la suma de las filas ({filas:.1f} = {r['home_total']:.1f})")

print("\n7-8 · la casa gastó más de lo que hay entre todos")
solo_sol = reparto(to_home=1000, to_battery=0, to_grid=0,
                   from_solar=1000, home_total=1000)
r = rescale_flows(solo_sol, {"pv_energy": 1000, "home_energy": 1400})
filas = r["from_solar"] + r["from_battery"] + r["from_grid"]
ok(abs(filas - 1400) < 1e-9, f"las filas siguen sumando el total ({filas:.1f} = 1400)")
ok(abs(r["from_grid"] - 400) < 1e-9,
   f"el hueco se apunta a la red ({r['from_grid']:.1f})")
ok(r["from_battery"] == 0, "y no a una batería que no descargó nada")

print("\n10 · el sensor de «casa» que en realidad es el autoconsumo (Sungrow)")
# El día real del 2 ago 2026: sol 5, carga 2,6 (de sol), descarga 2,7,
# importada 6,2, exportada 0. El contador «casa» marca 5,1 = solar→casa +
# batería→casa: es el autoconsumo, no el consumo total. La app oficial da
# casa 11,3 con 2,4 del sol, 2,7 de la batería y 6,2 de la red.
from series import casa_cuadra, split_flows                  # noqa: E402

contadores = {"pv_energy": 5000, "home_energy": 5100,
              "battery_charge_energy": 2600, "battery_discharge_energy": 2700,
              "grid_import_energy": 6200, "grid_export_energy": 0}
ok(not casa_cuadra(contadores),
   "el contador de casa se detecta incoherente (5,1 frente a un balance de 11,3)")
ok(casa_cuadra({**contadores, "home_energy": 11000}),
   "y uno que sí mide el consumo total se queda (11,0 frente a 11,3)")
ok(casa_cuadra({"home_energy": 5100}),
   "sin generación ni importación no hay balance: no se descarta a ciegas")

# El día por horas, como lo verían las estadísticas de 5 minutos (aquí en
# trozos gruesos, que para el reparto da igual): de noche y por la tarde se
# importa para la casa, al mediodía el sol cubre la casa y carga la batería,
# al anochecer la batería descarga.
horas = [
    # (pv, carga, exportada, importada, descarga)
    (0, 0, 0, 3000, 0),        # madrugada: la casa tira de la red
    (1200, 500, 0, 0, 0),      # mañana: sol para la casa y algo de carga
    (2600, 1700, 0, 0, 0),     # mediodía: el grueso de la carga, de sol
    (1200, 400, 0, 0, 0),      # tarde: últimas horas de sol
    (0, 0, 0, 1400, 1500),     # anochecer: batería y red a la vez
    (0, 0, 0, 1800, 1200),     # noche: se acaba la batería, sigue la red
]
casa_mal = contadores if casa_cuadra(contadores) else \
    {k: v for k, v in contadores.items() if k != "home_energy"}
acc = {k: 0.0 for k in ("to_home", "to_battery", "to_grid", "from_solar",
                         "from_battery", "from_grid", "home_total",
                         "grid_to_battery", "battery_to_grid")}
for pv, ch, ex, im, dis in horas:
    parte = split_flows(pv, ch, ex, im, dis, None)  # casa descartada → balance
    for k in acc:
        acc[k] += parte[k]
r = rescale_flows(acc, casa_mal)
esperado = {"to_home": 2400, "to_battery": 2600, "to_grid": 0,
            "from_solar": 2400, "from_battery": 2700, "from_grid": 6200,
            "home_total": 11300}
for k, v in esperado.items():
    ok(abs(r[k] - v) < 1, f"{k} = {r[k]:.0f} Wh (Sungrow: {v})")
nota = contadores["grid_import_energy"] - r["from_grid"]
ok(abs(nota) < 1, f"y la nota de importación a batería queda en {nota:.0f} Wh")

BASE = os.environ.get("VATIA_BASE")
if BASE:
    print("\n9 · de punta a punta")
    with urllib.request.urlopen(BASE + "/api/live", timeout=30) as f:
        e = json.load(f)["energy"]
    casa, gen = e["home"], e["generation"]
    m = e["meters"]
    suma = sum(x["kwh"] for x in casa["rows"])
    ok(abs(suma - casa["total"]) < 0.02,
       f"las filas de la casa suman su total ({suma:.2f} vs {casa['total']:.2f})")
    desde_sol = next((x["kwh"] for x in casa["rows"] if x["key"] == "from_solar"), None)
    a_casa = next((x["kwh"] for x in gen["rows"] if x["key"] in ("to_home", "to_load")), None)
    if desde_sol is not None and a_casa is not None:
        ok(abs(desde_sol - a_casa) < 0.02,
           f"«Desde solar» {desde_sol:.2f} = «A la casa» {a_casa:.2f}")
    else:
        print(f"  (sin las dos filas: desde_sol={desde_sol} a_casa={a_casa})")
    desde_red = next((x["kwh"] for x in casa["rows"] if x["key"] == "from_grid"), 0)
    ok(abs(m["grid_import"] - desde_red - m["grid_to_battery"]) < 0.03,
       f"importado = a la casa + a la batería ({m['grid_import']:.2f} = "
       f"{desde_red:.2f} + {m['grid_to_battery']:.2f})")
    ok(all(x["kwh"] >= -1e-9 for x in casa["rows"] + gen["rows"]), "ni un kWh negativo")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

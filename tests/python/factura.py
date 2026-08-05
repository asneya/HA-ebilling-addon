"""La factura simulada: que las cifras que se enseñan juntas cuadren entre sí.

`compute_bill` es el núcleo de la pantalla de Facturación y **no tenía banco ninguno**.
Por eso sobrevivieron dos errores que se tapaban el uno al otro en el mismo bloque de
cinco líneas, y que solo se vieron cuando alguien comparó esa tarjeta con el detalle:

  · el **término de energía** venía con los excedentes ya descontados, y debajo se
    restaba otra vez la «Compensación de excedentes»;
  · y el **impuesto eléctrico** estaba a la vez en «Cargos» y en «Impuestos».

Uno restaba de más y el otro sumaba de más, así que el total parecía plausible. Esa es
la forma que tienen los errores de sobrevivir: no la de dar un disparate, la de dar algo
razonable.

Lo que se comprueba, con una tarifa hecha a mano para derivar la respuesta a mano:

  1. los subtotales son **disjuntos y suman el total**
  2. el término de energía es el **bruto**, y la compensación va aparte
  3. las líneas del detalle también suman el total, que es la otra vista de lo mismo
  4. la compensación no puede pasarse del término de energía (lo dice la ley)
  5. y sin excedentes no hay línea de compensación que confunda
"""
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(RAIZ / "vatia" / "app"))

import billing  # noqa: E402

fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


def casi(a, b, tol=0.015):
    return a is not None and b is not None and abs(a - b) <= tol


# ── La tarifa, hecha a mano ─────────────────────────────────────────────────
#
# Todo con cifras redondas para poder seguir la cuenta con lápiz: 100 kWh de energía a
# 0,20 €, 30 kWh de excedentes a 0,10 €, potencia de 1 €/día, un cargo fijo de 3 €, un
# servicio de 5 €, impuesto eléctrico del 5 % e IVA del 21 %.
TARIFA = {
    "id": "t", "name": "La mía", "company": "Banco",
    "power_prices": {"p1": 0.05, "p2": 0.05},
    "energy": {"type": "schedule", "periods": [{"name": "Único", "price": 0.20}]},
    "fixed_daily": [{"name": "Cargo fijo", "price": 0.30}],
    "services": [{"name": "Mantenimiento", "price": 5.0}],
    "meter_rental": 0.0,
    "electricity_tax_pct": 5.0,
    "vat_energy_pct": 21.0,
    "vat_services_pct": 21.0,
}
DIAS = 10.0
POTENCIA = {"p1": 1.0, "p2": 1.0}

ENERGIA = billing.EnergyBreakdown(
    [{"name": "Energía Único", "kwh": 100.0, "price": 0.20, "cost": 20.0}])
EXCEDENTES = billing.EnergyBreakdown(
    [{"name": "Excedentes", "kwh": 30.0, "price": 0.10, "cost": 3.0}])


def factura(surplus=EXCEDENTES, energia=ENERGIA):
    return billing.compute_bill(TARIFA, energia, surplus, DIAS, POTENCIA)


print("1 · los subtotales son disjuntos y suman el total")
f = factura()
s = f["subtotals"]
suma = s["power"] + s["energy"] - s["surplus"] + s["charges"] + s["services"] + s["taxes"]
ok(casi(suma, f["total"]),
   f"suman la factura: {round(suma, 2)} € = {f['total']} €")
# Y que no cuadre por casualidad valiendo todo cero.
ok(f["total"] > 20.0, f"con una factura que no es cero ({f['total']} €)")
ok(s["energy"] > 0 and s["power"] > 0 and s["taxes"] > 0 and s["surplus"] > 0,
   "y con las cinco partidas con contenido, que si no no prueba nada")

print("\n2 · el término de energía es el bruto")
# 100 kWh × 0,20 € = 20,00 € de energía. Los 3,00 € de excedentes van **aparte**.
ok(casi(s["energy"], 20.0),
   f"el término de energía son los 20,00 € brutos ({s['energy']} €)")
ok(casi(s["surplus"], 3.0),
   f"y la compensación va en su propia partida ({s['surplus']} €)")
ok(not casi(s["energy"], 17.0),
   "y **no** es el neto de 17,00 €, que es lo que la tarjeta restaba dos veces")

print("\n3 · el impuesto eléctrico está en una sola partida")
# 5 % sobre (potencia 1,00 + energía neta 17,00 + fijo 3,00) = 5 % de 21,00 = 1,05 €.
# La clave es `electricity_tax_pct`: escrita mal, el impuesto se queda en el 0,5 % por
# defecto y esta sección pasaría sin comprobar nada. Lo escribí mal la primera vez.
electrico = 21.0 * 0.05
ok(casi(s["charges"], 3.0),
   f"«Cargos» es el cargo fijo y nada más ({s['charges']} €)")
ok(not casi(s["charges"], 3.0 + electrico),
   "y no lleva dentro el impuesto eléctrico, que se enseña debajo")
ok(s["taxes"] > electrico,
   f"que sí está en «Impuestos», con el IVA ({s['taxes']} €)")

print("\n4 · las líneas del detalle también suman el total")
# Es la otra vista de la misma factura: si las dos no dan lo mismo, una miente.
lineas = round(sum(l["amount"] for l in f["lines"]), 2)
ok(casi(lineas, f["total"]),
   f"las líneas del detalle suman la factura ({lineas} € = {f['total']} €)")

print("\n5 · la compensación no se pasa del término de energía")
# Lo dice la ley: los excedentes compensan hasta el término de energía y no más. Un
# día de mucho sol y poco consumo no genera saldo a favor en la factura.
mucho = billing.EnergyBreakdown(
    [{"name": "Excedentes", "kwh": 900.0, "price": 0.10, "cost": 90.0}])
f5 = factura(surplus=mucho)
ok(casi(f5["subtotals"]["surplus"], 20.0),
   f"se queda en el término de energía ({f5['subtotals']['surplus']} € de 20,00)")
ok(f5["total"] > 0, f"y la factura no sale negativa ({f5['total']} €)")
s5 = f5["subtotals"]
suma5 = (s5["power"] + s5["energy"] - s5["surplus"] + s5["charges"]
         + s5["services"] + s5["taxes"])
ok(casi(suma5, f5["total"]), f"y los subtotales siguen sumando ({round(suma5, 2)} €)")

print("\n6 · sin excedentes no hay compensación que enseñar")
f6 = factura(surplus=None)
ok(f6["subtotals"]["surplus"] == 0.0,
   f"la partida es cero, y la tarjeta la esconde ({f6['subtotals']['surplus']} €)")
s6 = f6["subtotals"]
suma6 = (s6["power"] + s6["energy"] - s6["surplus"] + s6["charges"]
         + s6["services"] + s6["taxes"])
ok(casi(suma6, f6["total"]), f"y la suma sigue cuadrando ({round(suma6, 2)} €)")

print()
if fallos:
    print(f"{len(fallos)} fallos")
    sys.exit(1)
print("todo en verde")

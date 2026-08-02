"""Los sensores de un Sungrow, que es el inversor que motivó tres arreglos.

El protocolo Modbus de los híbridos residenciales de Sungrow (V1.1.9) define,
entre otros:

    13002  Daily PV Generation            la generación
    13036  Daily Import Energy            lo comprado
    13045  Daily export energy            lo vertido, «through PV modules or batteries»
    13005  Daily export power from PV     de lo vertido, la parte que puso el sol
    13040  Daily Charge Energy            lo que se cargó la batería, de donde sea
    13012  Daily battery charge from PV   de esa carga, la parte que puso el sol
    13026  Daily battery discharge energy lo que descargó
    13017  Daily direct energy consumption «electricity taken from PV modules by loads»
    13008  Load power                     el consumo de la casa, en W

Dos cosas se siguen de ahí, y las dos son mejoras para Vatia.

**La trampa.** No hay ningún registro que dé el consumo total de la casa en kWh:
solo `Load power` en vatios. Lo que sí hay es 13017, que la integración de
Home Assistant publica como `sensor.daily_direct_energy_consumption`, y que
suena a consumo pero es el **autoconsumo**: lo que la casa toma del sol, sin lo
comprado. Ése es el sensor que estaba configurado como «consumo de la casa» y
que costó tres versiones detectar (0.41.3, `casa_cuadra`).

Y Vatia no es inocente: la casilla del consumo buscaba candidatos con la pista
«consum», que casa con `daily_direct_energy_consumption`. **Lo recomendaba.**

**Lo que se puede aprovechar.** 13012 y 13005 dan medido lo que Vatia deduce a
base de aritmética por intervalos y que provocó el fallo de la 0.46.1:

    red → batería  = 13040 − 13012
    batería → red  = 13045 − 13005

  1. la casilla del consumo ya no propone el autoconsumo
  2. y si está puesto, se avisa de qué mide en realidad
  3. las casillas legítimas de Sungrow se siguen proponiendo
  4. con la parte solar medida, el reparto la usa en vez de deducirla
  5. y entonces red→batería y batería→red son medidas, no estimaciones
  6. sin esos sensores, todo sigue como antes
  7. un día entero de Sungrow cuadra por los dos lados
"""
import sys

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)

import live                                                   # noqa: E402
from series import split_flows                                # noqa: E402

fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


def estado(entity, nombre, valor, unidad="kWh"):
    return (entity, {"state": str(valor), "attributes": {
        "friendly_name": nombre, "unit_of_measurement": unidad,
        "device_class": "energy" if unidad == "kWh" else "power"}})


# Los nombres que publica la integración de mkaiser, que es la que usa
# prácticamente todo el mundo con un Sungrow SHx.
SUNGROW = dict([
    estado("sensor.daily_pv_generation", "Daily PV generation", 33.9),
    estado("sensor.daily_imported_energy", "Daily imported energy", 6.2),
    estado("sensor.daily_exported_energy", "Daily exported energy", 10.6),
    estado("sensor.daily_exported_energy_from_pv", "Daily exported energy from PV", 9.1),
    estado("sensor.daily_battery_charge", "Daily battery charge", 15.9),
    estado("sensor.daily_battery_charge_from_pv", "Daily battery charge from PV", 14.4),
    estado("sensor.daily_battery_discharge", "Daily battery discharge", 2.3),
    estado("sensor.daily_direct_energy_consumption", "Daily direct energy consumption", 5.1),
    estado("sensor.load_power", "Load power", 320, "W"),
    estado("sensor.battery_level", "Battery level", 88, "%"),
])


def casilla(slot, ajustes=None):
    """La fila de una casilla en la pantalla de Sensores."""
    st = live.sensor_status(ajustes or {"energy_sensors": {}, "flow_sensors": {}},
                            SUNGROW)
    for grupo in st["groups"]:
        for fila in grupo["rows"]:
            if fila["slot"] == slot:
                return fila
    raise AssertionError(slot)


print("1-3 · la trampa de Sungrow en la pantalla de Sensores")
fila = casilla("home_energy")
propuestos = [s["entity_id"] for s in fila["suggestions"]]
ok("sensor.daily_direct_energy_consumption" not in propuestos,
   f"el autoconsumo ya no se propone como consumo de la casa ({propuestos})")

fila = casilla("home_energy", {
    "energy_sensors": {"home_energy": "sensor.daily_direct_energy_consumption"},
    "flow_sensors": {}})
ok(bool(fila.get("warning")), f"y si está puesto, se avisa («{fila.get('warning', '')[:60]}…»)")
ok("autoconsumo" in (fila.get("warning") or "").lower(),
   "diciendo que lo que mide es el autoconsumo")

fila = casilla("pv_energy")
ok("sensor.daily_pv_generation" in [s["entity_id"] for s in fila["suggestions"]],
   "la generación sí se propone")
fila = casilla("grid_import_energy")
ok("sensor.daily_imported_energy" in [s["entity_id"] for s in fila["suggestions"]],
   "y lo importado también")
fila = casilla("home_energy", {
    "energy_sensors": {"home_energy": "sensor.consumo_casa_hoy"}, "flow_sensors": {}})
ok(not fila.get("warning"), "y un contador normal no se marca")

print("\n4-5 · con la parte solar medida no hace falta deducirla")
# Un intervalo coherente de un cuarto de hora: el sol da 0,30, de los que 0,20
# van a la batería y 0,08 a la red; la batería recibe 0,03 más de la red y
# entrega 0,04 a la casa y 0,02 a la red.
intervalo = dict(pv=0.30, charge=0.23, export=0.10, imported=0.05, discharge=0.06)
medido = dict(charge_pv=0.20, export_pv=0.08)
sin_medir = split_flows(**intervalo)
con_medido = split_flows(**intervalo, **medido)
ok(abs(con_medido["to_battery"] - 0.20) < 1e-9,
   f"a la batería va lo que dice el inversor ({con_medido['to_battery']:.2f}, "
   f"no {sin_medir['to_battery']:.2f})")
ok(abs(con_medido["grid_to_battery"] - 0.03) < 1e-9,
   f"y red→batería es la resta medida, 0,23 − 0,20 ({con_medido['grid_to_battery']:.2f})")
ok(abs(con_medido["from_grid"] - 0.02) < 1e-9,
   f"así que a la casa llega el resto de lo comprado ({con_medido['from_grid']:.2f})")
ok(abs(con_medido["to_grid"] - 0.08) < 1e-9,
   f"lo vertido se parte por lo medido ({con_medido['to_grid']:.2f} de sol)")
ok(abs(con_medido["battery_to_grid"] - 0.02) < 1e-9,
   f"dejando el resto a la batería ({con_medido['battery_to_grid']:.2f})")
ok(abs(con_medido["to_home"] - 0.02) < 1e-9,
   f"y el sol que no fue ni a una ni a otra, a la casa ({con_medido['to_home']:.2f})")

# El sol no puede dar más de lo que generó, lo diga quien lo diga: si las dos
# partes medidas se pasaran, se recortan en vez de inventar generación.
imposible = split_flows(pv=0.30, charge=0.30, export=0.30, imported=0.0,
                        discharge=0.0, charge_pv=0.25, export_pv=0.30)
ok(imposible["to_battery"] + imposible["to_grid"] <= 0.30 + 1e-9,
   f"dos partes solares que no caben se recortan "
   f"({imposible['to_battery']:.2f} + {imposible['to_grid']:.2f} ≤ 0,30)")

# Los topes de la 0.46.1 siguen valiendo: lo medido tampoco puede pasarse.
raro = split_flows(pv=1.0, charge=0.5, export=0.2, imported=0.1, discharge=0.1,
                   charge_pv=99.0, export_pv=99.0)
ok(raro["to_battery"] <= 0.5 + 1e-9 and raro["to_grid"] <= 0.2 + 1e-9,
   f"un sensor que dice un disparate no se cree a ciegas "
   f"({raro['to_battery']}, {raro['to_grid']})")
ok(abs(raro["from_grid"] + raro["grid_to_battery"] - 0.1) < 1e-9,
   "y lo importado se sigue repartiendo entero")

print("\n6 · sin esos sensores, como antes")
ok(sin_medir == split_flows(**intervalo, charge_pv=None, export_pv=None),
   "pasar `None` es exactamente no pasar nada")

print("\n7 · el día de Sungrow, por los dos lados")
dia = split_flows(pv=33.9, charge=15.9, export=10.6, imported=6.2, discharge=2.3,
                  charge_pv=14.4, export_pv=9.1)
gen = dia["to_home"] + dia["to_battery"] + dia["to_grid"]
ok(abs(gen - 33.9) < 1e-9, f"la generación cuadra con su contador ({gen:.2f} = 33,90)")
ok(abs(dia["from_grid"] + dia["grid_to_battery"] - 6.2) < 1e-9,
   f"lo importado, con el suyo ({dia['from_grid']:.2f} + "
   f"{dia['grid_to_battery']:.2f} = 6,20)")
ok(abs(dia["from_battery"] + dia["battery_to_grid"] - 2.3) < 1e-9,
   f"y lo descargado, con el suyo ({dia['from_battery']:.2f} + "
   f"{dia['battery_to_grid']:.2f} = 2,30)")
ok(abs(dia["grid_to_battery"] - 1.5) < 1e-9,
   f"red→batería sale de la resta medida, 15,9 − 14,4 ({dia['grid_to_battery']:.2f})")
ok(abs(dia["battery_to_grid"] - 1.5) < 1e-9,
   f"y batería→red de 10,6 − 9,1 ({dia['battery_to_grid']:.2f})")
# Y el consumo deducido tiene que ser mayor que el «consumo directo» del
# inversor, que es justo lo que hace de aquél una trampa.
ok(dia["home_total"] > 5.1,
   f"el consumo real ({dia['home_total']:.2f}) es mayor que el «directo» (5,10)")

print()
if fallos:
    print("--- fallos ---")
    for f in dict.fromkeys(fallos):
        print("  " + f)
print(f"{len(fallos)} fallos" if fallos else "todo en verde")
sys.exit(1 if fallos else 0)

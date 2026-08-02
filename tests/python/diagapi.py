"""El diagnóstico de facturación dice en qué eslabón se rompe la cadena.

Contra un Home Assistant sin estadísticas para el contador y un InfluxDB que
filtra de verdad, que es el escenario en el que la facturación se queda vacía sin
dar ni un error.

  1. con todo bien, el veredicto lo dice y hay horas
  2. con la medida equivocada, dice en cuál está el contador de verdad
  3. con un sensor que no está en la base, lista los `entity_id` que sí hay
  4. con un sensor que no existe en Home Assistant, lo dice antes que nada
  5. sin contador asignado, manda a Ajustes → Sensores
"""
import json
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8363"
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


# Desde la 0.45 los ajustes de la casa piden rol de administrador. Se manda una
# cabecera de Ingress: como es el primero que entra en esta carpeta, lo será.
JEFE = "dd44444444444444444444444444444d"


def _con_jefe(req):
    req.add_header("X-Remote-User-Id", JEFE)
    req.add_header("X-Remote-User-Display-Name", "Diagnóstico")
    return req


def poner(**patch):
    req = urllib.request.Request(
        f"{BASE}/api/settings", method="PUT",
        data=json.dumps(patch).encode(),
        headers={"Content-Type": "application/json"})
    urllib.request.urlopen(_con_jefe(req), timeout=20).read()


def diag():
    req = _con_jefe(urllib.request.Request(f"{BASE}/api/diagnostics/billing"))
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


print("1 · con todo bien")
poner(influx={"measurement": "kWh"},
      energy_sensors={"grid_import_energy": "sensor.grid_import_hoy"})
d = diag()
ok(d["resultado"]["horas"] > 0, f"hay horas ({d['resultado']['horas']})")
ok(d["veredicto"].startswith("Todo correcto"), f"«{d['veredicto']}»")
ok(d["home_assistant"]["ficha"]["existe"] is True, "el sensor existe en HA")
ok(d["home_assistant"]["horas"] == 0,
   "y no tiene estadísticas: los datos salen del respaldo")
ok(d["influxdb"]["horas"] > 0, f"InfluxDB los sirve ({d['influxdb']['horas']} horas)")

print("\n2 · la medida equivocada")
poner(influx={"measurement": "W"})
d = diag()
ok("no en la medida «W»" in d["veredicto"], f"«{d['veredicto'][-120:]}»")
ok("está en kWh" in d["veredicto"], "y dice en cuál está de verdad")
ok("**" not in d["veredicto"], "sin asteriscos de más: se pinta como texto plano")

print("\n3 · un sensor que no está en la base")
poner(influx={"measurement": "kWh"},
      energy_sensors={"grid_import_energy": "sensor.fantasma"})
d = diag()
ok("grid_import_hoy" in d["veredicto"],
   "lista los entity_id que sí hay en InfluxDB")

print("\n4 · un sensor que no existe en Home Assistant")
ok(d["home_assistant"]["ficha"]["existe"] is False,
   f"la ficha lo dice: {d['home_assistant']['ficha']}")
ok(d["veredicto"].startswith("«sensor.fantasma» no existe en Home Assistant"),
   "y es lo primero que se lee, antes que las estadísticas")

print("\n5 · sin contador asignado")
poner(energy_sensors={"grid_import_energy": ""})
d = diag()
ok("Ajustes → Sensores" in d["veredicto"], f"«{d['veredicto']}»")
ok(d["resultado"].get("error"), "y el cálculo protesta en vez de callarse")

# Se deja como estaba.
poner(energy_sensors={"grid_import_energy": "sensor.grid_import_hoy"})
print("\n" + (f"{len(fallos)} fallos" if fallos else "todo en verde"))
sys.exit(1 if fallos else 0)

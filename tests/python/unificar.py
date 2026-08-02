"""La facturación lee los sensores de Sensores, y da lo mismo que antes.

Lo que se comprueba, contra un Home Assistant de mentira:
  1. la migración hereda los sensores viejos de las cuatro claves antiguas
  2. la serie horaria de facturación es **la misma** leyendo `ha_entity` (antes)
     que leyendo `energy_sensors.grid_import_energy` (ahora)
  3. sin sensor en Sensores se dice dónde ponerlo, no se falla en silencio
  4. `source: demo` sigue dando la casa de ejemplo
  5. el respaldo de InfluxDB solo entra si HA vuelve vacío
"""
import asyncio
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
import datasources as D                                       # noqa: E402
import storage                                                # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
HA = "http://127.0.0.1:8133"
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


print("1 · la migración hereda lo que ya estaba puesto")
viejo_ha = {
    "source": "homeassistant",
    "ha_entity": "sensor.grid_import_hoy",
    "ha_entity_export": "sensor.grid_export_hoy",
    "influx": {},
    "energy_sensors": {"grid_import_energy": "", "grid_export_energy": ""},
}
s = dict(viejo_ha, influx={}, energy_sensors=dict(viejo_ha["energy_sensors"]))
storage._migrar_fuente(s)
ok(s["energy_sensors"]["grid_import_energy"] == "sensor.grid_import_hoy",
   "el sensor de consumo pasa a Sensores")
ok(s["energy_sensors"]["grid_export_energy"] == "sensor.grid_export_hoy",
   "y el de vertido también")
ok("ha_entity" not in s and "ha_entity_export" not in s,
   "las claves viejas desaparecen: ya no hay dos sitios donde mirar")

viejo_ifx = {
    "source": "influxdb",
    "influx": {"url": "http://x", "entity_id": "sensor.desde_influx",
               "entity_id_export": "sensor.vertido_influx"},
    "energy_sensors": {},
}
storage._migrar_fuente(viejo_ifx)
ok(viejo_ifx["source"] == "homeassistant",
   "InfluxDB ya no es una fuente: pasa a Home Assistant")
ok(viejo_ifx["energy_sensors"]["grid_import_energy"] == "sensor.desde_influx",
   "y sus dos entity_id se heredan igual")
ok("entity_id" not in viejo_ifx["influx"],
   "sin dejar rastro en la sección de InfluxDB")
ok(viejo_ifx["influx"]["url"] == "http://x",
   "pero la conexión se queda: sigue dando el histórico largo")

# Lo que el usuario eligió en Sensores manda: no se pisa con lo viejo.
mano = {"source": "homeassistant", "ha_entity": "sensor.viejo", "influx": {},
        "energy_sensors": {"grid_import_energy": "sensor.el_bueno"}}
storage._migrar_fuente(mano)
ok(mano["energy_sensors"]["grid_import_energy"] == "sensor.el_bueno",
   "lo elegido en Sensores no lo pisa la clave antigua")

# Idempotente: cargar la configuración dos veces no cambia nada.
otra = dict(s, energy_sensors=dict(s["energy_sensors"]), influx=dict(s["influx"]))
storage._migrar_fuente(otra)
ok(otra == s, "y migrar dos veces da lo mismo que migrar una")


print("\n2 · la serie de facturación no cambia de números")
base = {"ha_url": HA, "ha_token": "x", "source": "homeassistant", "influx": {}}
fin = datetime.now(TZ).replace(minute=0, second=0, microsecond=0)
ini = fin - timedelta(hours=12)


async def serie(settings, kind="import"):
    return await D.get_hourly_consumption(settings, ini, fin, TZ, kind)


def cifras(rows):
    return [(r["start"].isoformat(), round(r["kwh"], 6)) for r in rows]


antes = asyncio.run(D.ha_hourly_consumption(
    base, ini, fin, TZ, "sensor.grid_import_hoy"))          # lo que leía `ha_entity`
ahora = asyncio.run(serie(dict(
    base, energy_sensors={"grid_import_energy": "sensor.grid_import_hoy"})))
ok(len(ahora) > 0, f"hay serie ({len(ahora)} horas)")
ok(cifras(antes) == cifras(ahora), "hora a hora, exactamente la misma serie")

vertido = asyncio.run(serie(dict(
    base, energy_sensors={"grid_import_energy": "sensor.grid_import_hoy",
                          "grid_export_energy": "sensor.grid_export_hoy"}), "export"))
ok(len(vertido) > 0,
   f"y el vertido ya sale sin configurar nada aparte ({len(vertido)} horas)")
ok(asyncio.run(serie(dict(base, energy_sensors={
    "grid_import_energy": "sensor.grid_import_hoy"}), "export")) == [],
   "sin sensor de vertido no hay excedentes, y no es un error")


print("\n3 · sin sensor, se dice dónde ponerlo")
try:
    asyncio.run(serie(dict(base, energy_sensors={})))
    ok(False, "debería haber protestado")
except D.SourceError as err:
    ok("Sensores" in str(err), f"«{err}»")


print("\n4 · demo sigue siendo demo")
d = asyncio.run(serie({"source": "demo"}))
ok(len(d) == 12, f"doce horas de la casa de ejemplo ({len(d)})")
ok(all(r["kwh"] >= 0 for r in d), "con consumo en todas")
ok(asyncio.run(serie({})) != [], "y sin `source` configurado también, que es el defecto")


print("\n5 · el respaldo de InfluxDB solo entra cuando HA no tiene nada")
# El fake siempre responde con filas, así que aquí se sustituyen las dos
# lecturas: lo que se mide es **qué se llama y cuándo**, que es la regla.
llamadas = []
DE_INFLUX = [{"start": ini, "kwh": 9.0}]
DE_HA = [{"start": ini, "kwh": 1.0}]


async def falso_ha(settings, s_, e_, tz_, entity):
    llamadas.append(("ha", entity))
    return list(vacio_ha[0])


async def falso_influx(settings, s_, e_, tz_, entity):
    llamadas.append(("influx", entity))
    return list(DE_INFLUX)


vacio_ha = [DE_HA]
D.ha_hourly_consumption, D.influx_hourly_consumption = falso_ha, falso_influx
con_influx = dict(base, energy_sensors={"grid_import_energy": "sensor.contador"},
                  influx={"url": "http://influx:8086"})

ok(asyncio.run(serie(con_influx)) == DE_HA, "con estadísticas en HA, se usan las de HA")
ok(llamadas == [("ha", "sensor.contador")], f"y no se toca InfluxDB ({llamadas})")

llamadas.clear(); vacio_ha[0] = []
ok(asyncio.run(serie(con_influx)) == DE_INFLUX,
   "si HA vuelve vacío, la serie sale de InfluxDB")
ok(llamadas == [("ha", "sensor.contador"), ("influx", "sensor.contador")],
   f"con el mismo entity_id, sin pedir otro ({llamadas})")

llamadas.clear()
ok(asyncio.run(serie(dict(base, energy_sensors={
    "grid_import_energy": "sensor.contador"}))) == [],
   "sin InfluxDB configurado, vacío es vacío")
ok(llamadas == [("ha", "sensor.contador")], f"y no se intenta nada más ({llamadas})")


async def influx_roto(settings, s_, e_, tz_, entity):
    raise D.SourceError("InfluxDB no responde")


D.influx_hourly_consumption = influx_roto
ok(asyncio.run(serie(con_influx)) == [],
   "si el respaldo falla, se devuelve el vacío de HA y no se propaga el error")

print("\n" + (f"{len(fallos)} fallos" if fallos else "todo en verde"))
sys.exit(1 if fallos else 0)

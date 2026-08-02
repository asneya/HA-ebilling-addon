"""La facturación contra un InfluxDB que se comporta como el de verdad.

El fallo: la integración de InfluxDB de Home Assistant guarda la etiqueta
`entity_id` **sin el dominio** (`grid_import_hoy`, no `sensor.grid_import_hoy`).
La consulta del perfil horario ya lo tenía en cuenta; la de facturación no. Como
hasta la 0.39 ese id se escribía a mano en Ajustes —y uno escribe lo que hay en
la base—, no se notaba. Al pasar a leer el sensor de Ajustes → Sensores, que sí
lleva el dominio, la consulta dejó de encontrar nada: ni error, ni filas.

Lo que se comprueba:
  1. las dos versiones encuentran la serie con el id completo
  2. y la siguen encontrando con el id pelado, por si la base está escrita así
  3. una medida equivocada no trae nada, y se dice en el log por qué
  4. un entity_id que no existe tampoco, y también se dice
  5. si Home Assistant no responde, el respaldo de InfluxDB entra igual
  6. y sin respaldo posible, se propaga la causa en vez de un vacío mudo
  7. el perfil horario sigue funcionando igual que antes
"""
import asyncio
import logging
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
import datasources as D                                       # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
IFX = "http://127.0.0.1:8187"      # el fake que filtra de verdad
HA_CAIDO = "http://127.0.0.1:1"    # nada escuchando
fallos = []
registro = []


class Captura(logging.Handler):
    def emit(self, record):
        registro.append(record.getMessage())


D._LOGGER.addHandler(Captura())
D._LOGGER.setLevel(logging.INFO)


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


fin = datetime.now(TZ).replace(minute=0, second=0, microsecond=0)
ini = fin - timedelta(days=3)


def ajustes(version=1, entity="sensor.grid_import_hoy", medida="kWh", ha=HA_CAIDO):
    return {
        "source": "homeassistant", "ha_url": ha, "ha_token": "x",
        "influx": {"version": version, "url": IFX, "database": "homeassistant",
                   "measurement": medida, "org": "casa", "token": "x"},
        "energy_sensors": {"grid_import_energy": entity},
    }


def serie(cfg, kind="import"):
    return asyncio.run(D.get_hourly_consumption(cfg, ini, fin, TZ, kind))


print("1 · el id completo encuentra la serie, que es lo que estaba roto")
for v in (1, 2):
    filas = asyncio.run(D.influx_hourly_consumption(
        ajustes(v), ini, fin, TZ, "sensor.grid_import_hoy"))
    total = sum(f["kwh"] for f in filas)
    ok(len(filas) > 60 and total > 20,
       f"v{v} con «sensor.grid_import_hoy»: {len(filas)} horas · {total:.2f} kWh")

print("\n2 · y el pelado también, por si la base está escrita así")
for v in (1, 2):
    filas = asyncio.run(D.influx_hourly_consumption(
        ajustes(v), ini, fin, TZ, "grid_import_hoy"))
    ok(len(filas) > 60, f"v{v} con «grid_import_hoy»: {len(filas)} horas")

def diagnostico(cfg):
    """Lo que la app dice cuando no hay datos: o el aviso del log, o el error.

    Con Home Assistant en pie y sin estadísticas, se registra un aviso y se
    devuelve vacío —un cero en la factura es un dato—; con Home Assistant caído
    **y** sin respaldo, se propaga, porque entonces no se sabe nada. En este
    banco HA no responde, así que lo que llega es lo segundo. Las dos ramas
    tienen que nombrar la causa; eso es lo que se comprueba.
    """
    registro.clear()
    try:
        vacio = serie(cfg) == []
        return " · ".join(registro) if vacio else "HAY DATOS"
    except D.SourceError as err:
        return str(err)


print("\n3 · una medida equivocada no trae nada, y se dice por qué")
d = diagnostico(ajustes(1, medida="W"))
ok("«W»" in d or "medida «W»" in d, f"la causa nombra la medida: «{d}»")
ok("grid_import_hoy" in d, "y el sensor que se buscó")

print("\n4 · un sensor que no está en la base tampoco")
d = diagnostico(ajustes(1, entity="sensor.no_existe"))
ok("no_existe" in d, f"la causa nombra el sensor: «{d}»")

print("\n5 · con Home Assistant caído, el respaldo entra igual")
registro.clear()
filas = serie(ajustes(1))
ok(len(filas) > 60, f"la facturación sale de InfluxDB: {len(filas)} horas")
registro.clear()
filas = serie(ajustes(2))
ok(len(filas) > 60, f"y en v2 también: {len(filas)} horas")
ok(any("desde InfluxDB" in m for m in registro), "con su rastro en el log")

print("\n6 · sin respaldo posible, la causa se propaga")
sin_ifx = ajustes(1)
sin_ifx["influx"] = {}
try:
    serie(sin_ifx)
    ok(False, "debería haber protestado")
except D.SourceError as err:
    ok("Home Assistant" in str(err), f"«{err}»")

sin_sensor = ajustes(1)
sin_sensor["energy_sensors"] = {}
try:
    serie(sin_sensor)
    ok(False, "debería haber protestado por el sensor")
except D.SourceError as err:
    ok("Sensores" in str(err), f"y sin sensor se dice dónde ponerlo: «{err}»")

ok(serie(sin_sensor.copy() | {"energy_sensors": {}}, "export") == [],
   "pero el vertido sin sensor sigue siendo una lista vacía, no un error")

print("\n7 · el perfil horario, que ya iba bien, sigue igual")
for v in (1, 2):
    filas = asyncio.run(D.influx_hourly_mean(
        ajustes(v), "sensor.grid_import_hoy", "kWh", ini, fin, TZ))
    ok(len(filas) > 60, f"v{v}: {len(filas)} horas")

print("\n" + (f"{len(fallos)} fallos" if fallos else "todo en verde"))
sys.exit(1 if fallos else 0)

"""InfluxDB de mentira que se comporta como uno de verdad con datos de HA.

El fake que había contestaba a cualquier consulta, así que no podía cazar un
filtro mal escrito. Este **sí filtra**, y guarda las series como las guarda la
integración de InfluxDB de Home Assistant:

  · la medida es la **unidad** del sensor: «kWh» para un contador de energía;
  · la etiqueta `entity_id` es el object_id **sin el dominio**: `grid_import`,
    no `sensor.grid_import`. Esto es lo importante: una consulta que pregunte
    por `sensor.grid_import` no encuentra nada, exactamente como aquí.

Sirve un contador acumulado que sube durante seis semanas, que es lo que la
facturación diferencia hora a hora.
"""
import json
import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from aiohttp import web

TZ = ZoneInfo("Europe/Madrid")
UTC = ZoneInfo("UTC")
DIAS = 45
# Lo que hay en la base: medida → {entity_id sin dominio: [(instante, valor)]}
ENTIDAD = "grid_import_hoy"
MEDIDA = "kWh"


def serie():
    """Contador acumulado, hora a hora. Sube más de día que de noche."""
    ahora = datetime.now(TZ).replace(minute=0, second=0, microsecond=0)
    acc, out = 1000.0, []
    for atras in range(DIAS * 24, -1, -1):
        t = ahora - timedelta(hours=atras)
        acc += 0.15 + (0.55 if 8 <= t.hour <= 22 else 0.05)
        out.append((t, round(acc, 3)))
    return out


def dentro(t, desde, hasta):
    return (desde is None or t >= desde) and (hasta is None or t < hasta)


def cuando(q, palabra):
    m = re.search(rf"time {palabra} '([^']+)'", q)
    if not m:
        return None
    return datetime.fromisoformat(m.group(1)).astimezone(TZ)


# Lo que hay en la base, además de la serie: sirve para que el diagnóstico pueda
# preguntar «¿qué contienes?» como se lo pregunta a uno de verdad.
MEDIDAS = ["kWh", "W", "%", "°C"]
ENTIDADES = ["grid_import_hoy", "grid_export_hoy", "pv_hoy", "home_power"]


async def v1(req):
    """InfluxQL. Devuelve vacío si la medida o el entity_id no son los suyos."""
    q = req.query.get("q", "")
    if q.startswith("SHOW MEASUREMENTS"):
        return web.json_response({"results": [{"series": [
            {"name": "measurements", "columns": ["name"],
             "values": [[m] for m in MEDIDAS]}]}]})
    if q.startswith("SHOW SERIES"):
        # Como uno de verdad: `medida,domain=sensor,entity_id=x`. Solo el
        # contador que existe, y solo en su medida.
        vals = [[f"{MEDIDA},domain=sensor,entity_id={ENTIDAD}"]] if ENTIDAD in q else []
        return web.json_response({"results": [{"series": [
            {"name": "series", "columns": ["key"], "values": vals}]}]} if vals
            else {"results": [{}]})
    if q.startswith("SHOW TAG VALUES"):
        return web.json_response({"results": [{"series": [
            {"name": MEDIDA, "columns": ["key", "value"],
             "values": [["entity_id", e] for e in ENTIDADES]}]}]})
    medida = re.search(r'FROM "([^"]+)"', q)
    entidad = re.search(r'"entity_id" = \'([^\']*)\'', q)
    print(f"  [v1] medida={medida.group(1) if medida else '—'} "
          f"entity_id={entidad.group(1) if entidad else '—'}", flush=True)
    if not medida or medida.group(1) != MEDIDA:
        return web.json_response({"results": [{}]})
    if entidad and entidad.group(1) != ENTIDAD:
        # Es lo que hace InfluxDB: no hay serie con esa etiqueta, no hay filas.
        return web.json_response({"results": [{}]})

    desde, hasta = cuando(q, ">="), cuando(q, "<")
    columna = "last" if "last(" in q else "mean"
    valores = [[t.astimezone(UTC).isoformat().replace("+00:00", "Z"), v]
               for t, v in serie() if dentro(t, desde, hasta)]
    if not valores:
        return web.json_response({"results": [{}]})
    return web.json_response({"results": [{"series": [
        {"name": MEDIDA, "columns": ["time", columna], "values": valores}]}]})


async def v2(req):
    """Flux. Mismo criterio: si el filtro no cuadra, no hay filas."""
    flux = await req.text()
    print(f"  [v2] {' '.join(flux.split())[:160]}", flush=True)
    m = re.search(r'_measurement"\] == "([^"]+)"', flux)
    if m and m.group(1) != MEDIDA:
        return web.Response(text="")
    ents = re.findall(r'entity_id"\] == "([^"]*)"', flux)
    if ents and ENTIDAD not in ents:
        return web.Response(text="")
    rango = re.search(r"range\(start: ([^,]+), stop: ([^)]+)\)", flux)
    desde = hasta = None
    if rango:
        desde = datetime.fromisoformat(rango.group(1)).astimezone(TZ)
        hasta = datetime.fromisoformat(rango.group(2)).astimezone(TZ)
    filas = ["#datatype,string,long,dateTime:RFC3339,double,string,string",
             ",result,table,_time,_value,_field,_measurement"]
    for t, v in serie():
        if not dentro(t, desde, hasta):
            continue
        filas.append(f",_result,0,{t.astimezone(UTC).isoformat().replace('+00:00', 'Z')}"
                     f",{v},value,{MEDIDA}")
    if len(filas) == 2:
        return web.Response(text="")
    return web.Response(text="\r\n".join(filas) + "\r\n")


app = web.Application()
app.router.add_get("/query", v1)
app.router.add_post("/api/v2/query", v2)
web.run_app(app, host="127.0.0.1", port=8187, print=None)

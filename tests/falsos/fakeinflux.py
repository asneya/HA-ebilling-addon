"""InfluxDB falso (v1 y v2) que sirve seis semanas de medias horarias.

Lo que aporta: comprobar que el perfil horario sale del histórico de Influx y no
del recorder, y que la casa que devuelve tiene forma —suelo, horno a la una,
cena— para que el perfil pueda distinguir una hora de otra.

  GET  /query          → InfluxQL (v1), respuesta JSON
  POST /api/v2/query   → Flux (v2), respuesta CSV anotada

Con `?vacio=1` en la URL de arranque no devuelve nada, para probar el respaldo.
"""
import json
import os
import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from aiohttp import web

TZ = ZoneInfo("Europe/Madrid")
DIAS = 42
VACIO = os.environ.get("INFLUX_VACIO") == "1"
CAE = os.environ.get("INFLUX_CAE") == "1"


def casa(h, laborable):
    """La misma casa que el HA falso: suelo, horno a la una, cena por la noche.
    El fin de semana come más tarde, para que el perfil tenga dos formas."""
    w = 320.0
    if laborable:
        if 13.0 <= h < 14.0:
            w += 2200.0
    else:
        if 14.0 <= h < 15.0:
            w += 2400.0
    if 21.0 <= h < 22.5:
        w += 900.0
    return w


def muestras():
    """[(instante UTC ISO, W)] hora a hora de las últimas seis semanas."""
    ahora = datetime.now(TZ).replace(minute=0, second=0, microsecond=0)
    out = []
    for atras in range(DIAS * 24, 0, -1):
        t = ahora - timedelta(hours=atras)
        out.append((t, casa(t.hour + 0.5, t.weekday() < 5)))
    return out


async def v1(req):
    if CAE:
        return web.Response(status=500, text="influx caído")
    q = req.query.get("q", "")
    if VACIO or "mean" not in q:
        return web.json_response({"results": [{}]})
    valores = [[t.astimezone(ZoneInfo("UTC")).isoformat().replace("+00:00", "Z"), w]
               for t, w in muestras()]
    return web.json_response({"results": [{"series": [
        {"name": "W", "columns": ["time", "mean"], "values": valores}]}]})


async def v2(req):
    if CAE:
        return web.Response(status=500, text="influx caído")
    if VACIO:
        return web.Response(text="")
    filas = ["#datatype,string,long,dateTime:RFC3339,double,string,string",
             ",result,table,_time,_value,_field,_measurement"]
    for t, w in muestras():
        iso = t.astimezone(ZoneInfo("UTC")).isoformat().replace("+00:00", "Z")
        filas.append(f",_result,0,{iso},{w},value,W")
    return web.Response(text="\r\n".join(filas) + "\r\n")


app = web.Application()
app.router.add_get("/query", v1)
app.router.add_post("/api/v2/query", v2)
web.run_app(app, host="127.0.0.1", port=8186, print=None)

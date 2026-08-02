"""Home Assistant que responde a todo **menos** a las estadísticas del contador.

Es el caso del usuario: HA en pie, el sensor existe y da su estado, pero el
recorder no tiene estadísticas de largo plazo suyas (le falta `state_class`, o
está excluido). Ahí es donde tiene que entrar el respaldo de InfluxDB.
"""
import json
from datetime import datetime
from zoneinfo import ZoneInfo
from aiohttp import web

TZ = ZoneInfo("Europe/Madrid")
ESTADOS = [
    {"entity_id": "sensor.grid_import_hoy", "state": "1234.5",
     "attributes": {"unit_of_measurement": "kWh", "device_class": "energy",
                    "friendly_name": "Red importada"}},
    {"entity_id": "sensor.grid_export_hoy", "state": "56.7",
     "attributes": {"unit_of_measurement": "kWh", "device_class": "energy",
                    "friendly_name": "Red exportada"}},
]

async def states(req):
    return web.json_response(ESTADOS)

async def one(req):
    for s in ESTADOS:
        if s["entity_id"] == req.match_info["eid"]:
            return web.json_response(s)
    # Como Home Assistant de verdad: una entidad que no existe es un 404.
    return web.json_response({"message": "Entity not found."}, status=404)

async def ws(req):
    w = web.WebSocketResponse(); await w.prepare(req)
    await w.send_json({"type": "auth_required"})
    async for m in w:
        d = json.loads(m.data)
        if d.get("type") == "auth":
            await w.send_json({"type": "auth_ok"}); continue
        if d.get("type") == "recorder/list_statistic_ids":
            # Ninguna estadística: es justo lo que pasa cuando el contador no
            # tiene `state_class`.
            await w.send_json({"id": d["id"], "type": "result",
                               "success": True, "result": []})
            continue
        if d.get("type") == "recorder/statistics_during_period":
            print(f"  [HA] estadísticas pedidas de {d['statistic_ids']} → vacío", flush=True)
            await w.send_json({"id": d["id"], "type": "result",
                               "success": True, "result": {}})
            continue
        await w.send_json({"id": d.get("id"), "type": "result", "success": True, "result": {}})
    return w

app = web.Application()
app.router.add_get("/api/states", states)
app.router.add_get("/api/states/{eid}", one)
app.router.add_post("/api/states/{eid}", lambda r: web.json_response({"ok": True}))
app.router.add_get("/api/websocket", ws)
web.run_app(app, host="127.0.0.1", port=8134, print=None)

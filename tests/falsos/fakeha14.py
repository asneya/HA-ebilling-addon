"""HA falso con previsión solar de verdad, para la ventana de energía gratis.

Lo que aporta sobre los otros fakes:

  - un sensor de previsión al estilo Solcast (`detailedForecast` con
    `pv_estimate` en kW) con hoy y mañana, media hora a media hora;
  - una semana de estadísticas horarias del consumo de la casa, para que el
    consumo típico (la mediana) salga de datos y no de un valor inventado;
  - `sun.sun` con elevación y amanecer/atardecer coherentes con la campana.

La hora se puede mover con `?h=18.5` en /api/states para probar los estados de
la ventana (antes, dentro, después) sin esperar al reloj. Mañana lleva la mitad
de pico: la ventana tiene que salir más corta.
"""
import json
import math
import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from aiohttp import web

TZ = ZoneInfo("Europe/Madrid")
PICO_HOY = 5200.0        # W
PICO_MANANA = 2600.0     # nubes
CENTRO, ANCHO = 14.2, 5.6
BASE_CASA = 320.0        # suelo de consumo de la casa (W)

# Hora simulada: la fija el arranque (VATIA_HORA) o cada petición (?h=).
HORA_FIJA = float(os.environ.get("VATIA_HORA", "0") or 0) or None


def ahora(req=None):
    hoy = datetime.now(TZ).replace(minute=0, second=0, microsecond=0, hour=0)
    h = HORA_FIJA
    if req is not None and req.query.get("h"):
        h = float(req.query["h"])
    if h is None:
        return datetime.now(TZ)
    return hoy + timedelta(hours=h)


def pv(h, pico):
    """Campana solar en W a la hora decimal `h`."""
    x = (h - CENTRO) / ANCHO
    return round(max(0.0, pico * math.cos(x * math.pi / 2)), 1) if abs(x) < 1 else 0.0


def soc(h):
    """Estado de carga (%) a la hora decimal `h`: se vacía de noche y carga con
    el sol. Es la forma que tiene una batería doméstica en un día claro."""
    if h < 7.0:                       # de madrugada alimenta la casa
        return max(18.0, 55.0 - h * 5.0)
    if h < 9.0:                       # amanece y aún no compensa
        return 20.0 + (h - 7.0) * 3.0
    if h < 15.0:                      # carga con el excedente
        return min(98.0, 26.0 + (h - 9.0) * 12.5)
    if h < 21.0:                      # se mantiene y empieza a ceder
        return 98.0 - (h - 15.0) * 3.5
    return 77.0 - (h - 21.0) * 7.0


def casa(h):
    """Consumo de la casa: el suelo, más el horno de 13 a 14 y la cena."""
    w = BASE_CASA
    if 13.0 <= h < 14.0:
        w += 2200.0
    if 21.0 <= h < 22.5:
        w += 900.0
    return w


def detallado():
    """`detailedForecast` de hoy y mañana, cada media hora."""
    hoy = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    filas = []
    for dia, pico in ((0, PICO_HOY), (1, PICO_MANANA)):
        h = 0.0
        while h < 24:
            filas.append({
                "period_start": (hoy + timedelta(days=dia, hours=h)).isoformat(),
                "pv_estimate": round(pv(h, pico) / 1000.0, 4),   # Solcast: kW
            })
            h += 0.5
    return filas


S = lambda eid, st, unit=None, dc=None, name=None, **x: {"entity_id": eid, "state": str(st),
    "attributes": {**({"unit_of_measurement": unit} if unit else {}), **({"device_class": dc} if dc else {}),
                   **({"friendly_name": name} if name else {}), **x}}

CLAVES = ["pv", "grid_import", "grid_export", "batt_charge", "batt_discharge", "home"]


async def states(req):
    t = ahora(req)
    h = t.hour + t.minute / 60.0
    p_pv, p_casa = pv(h, PICO_HOY), casa(h)
    sobra = p_pv - p_casa
    live = {
        "pv": p_pv,
        "grid_import": max(0.0, -sobra) if sobra < 0 else 0.0,
        "grid_export": max(0.0, sobra * 0.4) if sobra > 0 else 0.0,
        "batt_charge": max(0.0, sobra * 0.6) if sobra > 0 else 0.0,
        "batt_discharge": 0.0,
        "home": p_casa,
    }
    # Antes del amanecer la casa tira de la batería, no de la red.
    if sobra < 0 and 0 <= h < 7:
        live["batt_discharge"] = live.pop("grid_import")
        live["grid_import"] = 0.0
    # Energía del día hasta la hora simulada (integral de las campanas).
    dia = {k: 0.0 for k in CLAVES}
    x = 0.0
    while x < h:
        pp, pc = pv(x, PICO_HOY), casa(x)
        s = pp - pc
        dia["pv"] += pp / 12
        dia["home"] += pc / 12
        if s > 0:
            dia["grid_export"] += s * 0.4 / 12
            dia["batt_charge"] += s * 0.6 / 12
        elif x < 7:
            dia["batt_discharge"] += -s / 12
        else:
            dia["grid_import"] += -s / 12
        x += 1 / 12

    out = []
    for k in CLAVES:
        out.append(S(f"sensor.{k}_hoy", round(dia[k] / 1000, 3), "kWh", "energy", f"{k} hoy"))
        out.append(S(f"sensor.{k}_power", round(live.get(k, 0.0), 1), "W", "power", f"{k} potencia"))
    elev = round(60 * math.cos(((h - CENTRO) / 7.6) * math.pi / 2), 1) if abs(h - CENTRO) < 7.6 else -20.0
    out.append(S("sensor.batt_soc", round(soc(h), 1), "%", "battery", "SOC"))
    # Meteorología, para la pastilla de la Home: temperatura con decimal (como
    # la maqueta, «28,6°») y condición en el vocabulario de Home Assistant.
    out.append(S("sensor.exterior_temp", round(18.0 + 10.6 * max(0.0, math.cos(((h - 15) / 9) * math.pi / 2)), 1),
                 "°C", "temperature", "Temperatura exterior"))
    out.append(S("sensor.exterior_condition", "sunny" if elev > 3 else "clear-night",
                 name="Condición exterior"))
    out.append(S("sun.sun", "above_horizon" if elev > 0 else "below_horizon", name="Sol",
                 elevation=elev, rising=h < CENTRO,
                 next_setting=(t.replace(hour=21, minute=14, second=0, microsecond=0)).isoformat(),
                 next_rising=(t.replace(hour=7, minute=6, second=0, microsecond=0)).isoformat()))
    out.append(S("sensor.solcast_pv_forecast", round(sum(
        f["pv_estimate"] for f in detallado()[:48]) / 2, 2), "kWh", "energy",
        "Solcast previsión", detailedForecast=detallado()))
    # La entidad del tiempo. **Sin atributo `forecast`**, como las de Home
    # Assistant desde 2024.4: la previsión horaria solo se consigue llamando al
    # servicio `weather.get_forecasts`, y este fake lo exige para que el banco no
    # pueda pasar leyendo un atributo que en una casa de verdad no está.
    out.append(S("weather.casa", "sunny" if elev > 3 else "clear-night",
                 name="El tiempo en casa",
                 temperature=round(18.0 + 10.6 * max(
                     0.0, math.cos(((h - 15) / 9) * math.pi / 2)), 1),
                 cloud_coverage=nubes(h)))
    return web.json_response(out)


def nubes(h):
    """Nubosidad prevista (%) a la hora decimal `h`.

    Sube por la tarde: así el banco puede comprobar que la nubosidad y el sol se
    leen como dos columnas distintas —a las 17:00 hay nubes **y** todavía sol— en
    vez de una derivada de la otra.
    """
    if h < 12:
        return round(10 + h)
    return min(95, round(22 + (h - 12) * 9))


def prevision_horaria(t0):
    """Las 48 horas siguientes, como las da `weather.get_forecasts`."""
    filas = []
    for i in range(48):
        t = t0.replace(minute=0, second=0, microsecond=0) + timedelta(hours=i)
        h = t.hour
        nube = nubes(h)
        filas.append({
            "datetime": t.isoformat(),
            "condition": ("cloudy" if nube >= 70 else
                          "partlycloudy" if nube >= 30 else "sunny"),
            "temperature": round(18.0 + 10.6 * max(
                0.0, math.cos(((h - 15) / 9) * math.pi / 2)), 1),
            "cloud_coverage": nube,
            "precipitation_probability": max(0, nube - 40),
        })
    return filas


async def one(req):
    for s in json.loads((await states(req)).body):
        if s["entity_id"] == req.match_info["eid"]:
            return web.json_response(s)
    return web.json_response({"state": "unknown", "attributes": {}})


async def post(req):
    return web.json_response({"ok": True})


async def ws(req):
    w = web.WebSocketResponse(); await w.prepare(req)
    await w.send_json({"type": "auth_required"})
    async for m in w:
        d = json.loads(m.data)
        if d.get("type") == "auth":
            await w.send_json({"type": "auth_ok"}); continue
        if d.get("type") == "call_service":
            # Solo el que se usa, y con la envoltura de verdad: la respuesta llega
            # dentro de `response` y por entidad, que es donde se equivocaría
            # cualquiera que lo escribiera de memoria.
            if (d.get("domain"), d.get("service")) != ("weather", "get_forecasts"):
                await w.send_json({"id": d["id"], "type": "result", "success": False,
                                   "error": {"message": "servicio no simulado"}})
                continue
            eid = (d.get("target") or {}).get("entity_id") or ""
            await w.send_json({"id": d["id"], "type": "result", "success": True,
                               "result": {"response": {
                                   eid: {"forecast": prevision_horaria(ahora())}}}})
            continue
        if d.get("type") == "recorder/list_statistic_ids":
            await w.send_json({"id": d["id"], "type": "result", "success": True, "result":
                [{"statistic_id": f"sensor.{k}_{suf}",
                  "statistics_unit_of_measurement": "kWh" if suf == "hoy" else "W"}
                 for k in CLAVES for suf in ("hoy", "power")]})
            continue
        if d.get("type") == "recorder/statistics_during_period":
            start = datetime.fromisoformat(d["start_time"]).astimezone(TZ)
            end = min(datetime.fromisoformat(d["end_time"]).astimezone(TZ), ahora())
            period, types, res = d["period"], d["types"], {}
            step = {"5minute": timedelta(minutes=5), "hour": timedelta(hours=1),
                    "day": timedelta(days=1), "month": timedelta(days=30)}[period]
            for eid in d["statistic_ids"]:
                clave = eid.replace("sensor.", "").replace("_hoy", "").replace("_power", "")
                rows, t = [], start
                while t < end and len(rows) < 4000:
                    h = t.hour + t.minute / 60.0
                    pp, pc = pv(h, PICO_HOY), casa(h)
                    s = pp - pc
                    vals = {"pv": pp, "home": pc, "batt_soc": soc(h),
                            "grid_export": max(0.0, s * 0.4), "batt_charge": max(0.0, s * 0.6),
                            "grid_import": max(0.0, -s) if h >= 7 else 0.0,
                            "batt_discharge": max(0.0, -s) if h < 7 else 0.0}
                    watts = vals.get(clave, 0.0)
                    horas = step.total_seconds() / 3600
                    if "mean" in types:
                        rows.append({"start": t.isoformat(), "mean": watts})
                    else:
                        rows.append({"start": t.isoformat(), "change": watts * horas / 1000})
                    t += step
                res[eid] = rows
            await w.send_json({"id": d["id"], "type": "result", "success": True, "result": res})
    return w


app = web.Application()
app.router.add_get("/api/states", states)
app.router.add_get("/api/states/{eid}", one)
app.router.add_post("/api/states/{eid}", post)
app.router.add_get("/api/websocket", ws)
web.run_app(app, host="127.0.0.1", port=8132, print=None)

"""Fuentes de datos de consumo: Home Assistant, InfluxDB y modo demo.

Todas devuelven una serie horaria: lista de {"start": datetime local tz-aware,
"kwh": float} con el consumo (delta) de cada hora del rango pedido.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
from datetime import datetime, timedelta
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)


class SourceError(Exception):
    """Error recuperable al consultar una fuente de datos."""


# ---------------------------------------------------------------------------
# Home Assistant
# ---------------------------------------------------------------------------


def _ha_endpoints(settings: dict[str, Any]) -> tuple[str, str, str]:
    """Devuelve (base REST, URL websocket, token) según el entorno.

    Dentro del add-on se usa el proxy del Supervisor con SUPERVISOR_TOKEN;
    fuera (desarrollo) se usan ha_url/ha_token de los ajustes.
    """
    supervisor_token = os.environ.get("SUPERVISOR_TOKEN")
    if supervisor_token:
        return (
            "http://supervisor/core/api",
            "ws://supervisor/core/websocket",
            supervisor_token,
        )
    ha_url = (settings.get("ha_url") or "").rstrip("/")
    token = settings.get("ha_token") or ""
    if not ha_url or not token:
        raise SourceError(
            "Configura la URL y el token de Home Assistant (o ejecuta como add-on)."
        )
    ws_url = ha_url.replace("https://", "wss://").replace("http://", "ws://")
    return f"{ha_url}/api", f"{ws_url}/api/websocket", token


async def ha_list_energy_entities(settings: dict[str, Any]) -> list[dict[str, Any]]:
    """Lista sensores de energía (kWh / device_class energy) vía REST."""
    base, _, token = _ha_endpoints(settings)
    headers = {"Authorization": f"Bearer {token}"}
    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.get(f"{base}/states", timeout=aiohttp.ClientTimeout(total=15)) as resp:
            if resp.status != 200:
                raise SourceError(f"Home Assistant respondió {resp.status} al listar entidades.")
            states = await resp.json()
    entities = []
    for state in states:
        attrs = state.get("attributes") or {}
        unit = (attrs.get("unit_of_measurement") or "").lower()
        if attrs.get("device_class") == "energy" or unit in ("kwh", "wh", "mwh"):
            entities.append(
                {
                    "entity_id": state["entity_id"],
                    "name": attrs.get("friendly_name") or state["entity_id"],
                    "unit": attrs.get("unit_of_measurement") or "",
                    "state_class": attrs.get("state_class") or "",
                }
            )
    entities.sort(key=lambda e: e["name"].lower())
    return entities


async def ha_hourly_consumption(
    settings: dict[str, Any], start: datetime, end: datetime, tz, entity: str
) -> list[dict[str, Any]]:
    """Consumo horario desde las estadísticas de largo plazo de HA.

    Usa el comando websocket ``recorder/statistics_during_period`` con
    periodo horario y el campo ``change`` (delta de energía por hora).
    """
    if not entity:
        raise SourceError("Selecciona un sensor de energía en Ajustes.")
    _, ws_url, token = _ha_endpoints(settings)

    payload = {
        "id": 1,
        "type": "recorder/statistics_during_period",
        "start_time": start.isoformat(),
        "end_time": end.isoformat(),
        "statistic_ids": [entity],
        "period": "hour",
        "types": ["change"],
    }

    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(ws_url, timeout=aiohttp.ClientTimeout(total=20)) as ws:
            msg = await ws.receive_json()  # auth_required
            if msg.get("type") == "auth_required":
                await ws.send_json({"type": "auth", "access_token": token})
                msg = await ws.receive_json()
                if msg.get("type") != "auth_ok":
                    raise SourceError("Autenticación websocket rechazada por Home Assistant.")
            await ws.send_json(payload)
            while True:
                msg = await ws.receive_json()
                if msg.get("id") == 1 and msg.get("type") == "result":
                    if not msg.get("success"):
                        raise SourceError(
                            f"Error de Home Assistant: {msg.get('error', {}).get('message')}"
                        )
                    result = msg.get("result") or {}
                    break

    rows = result.get(entity) or []
    unit_factor = 1.0
    # Las estadísticas se devuelven en la unidad del sensor; Wh → kWh.
    series: list[dict[str, Any]] = []
    for row in rows:
        raw_start = row.get("start")
        if isinstance(raw_start, (int, float)):
            dt = datetime.fromtimestamp(raw_start / 1000.0, tz)
        else:
            dt = datetime.fromisoformat(str(raw_start)).astimezone(tz)
        change = row.get("change")
        if change is None:
            continue
        series.append({"start": dt, "kwh": max(0.0, float(change) * unit_factor)})
    return series


# ---------------------------------------------------------------------------
# InfluxDB (v1 InfluxQL y v2 Flux)
# ---------------------------------------------------------------------------


async def influx_hourly_consumption(
    settings: dict[str, Any], start: datetime, end: datetime, tz, entity: str
) -> list[dict[str, Any]]:
    influx = dict(settings.get("influx") or {})
    influx["entity_id"] = entity
    version = int(influx.get("version") or 2)
    if version == 1:
        cumulative = await _influx_v1_hourly(influx, start, end)
    else:
        cumulative = await _influx_v2_hourly(influx, start, end)
    return _diff_cumulative(cumulative, tz)


async def _influx_v1_hourly(
    influx: dict[str, Any], start: datetime, end: datetime
) -> list[tuple[str, float]]:
    url = (influx.get("url") or "").rstrip("/")
    if not url:
        raise SourceError("Configura la URL de InfluxDB.")
    measurement = influx.get("measurement") or "kWh"
    entity = influx.get("entity_id") or ""
    query = (
        f'SELECT last("value") FROM "{measurement}" '
        f"WHERE time >= '{start.isoformat()}' AND time < '{end.isoformat()}'"
    )
    if entity:
        query += f" AND \"entity_id\" = '{entity}'"
    query += " GROUP BY time(1h) fill(previous)"

    params = {"db": influx.get("database") or "homeassistant", "q": query}
    auth = None
    if influx.get("username"):
        auth = aiohttp.BasicAuth(influx["username"], influx.get("password") or "")
    async with aiohttp.ClientSession(auth=auth) as session:
        async with session.get(
            f"{url}/query", params=params, timeout=aiohttp.ClientTimeout(total=30)
        ) as resp:
            if resp.status != 200:
                raise SourceError(f"InfluxDB respondió {resp.status}: {await resp.text()}")
            data = await resp.json()
    try:
        values = data["results"][0]["series"][0]["values"]
    except (KeyError, IndexError):
        return []
    return [(ts, val) for ts, val in values if val is not None]


async def _influx_v2_hourly(
    influx: dict[str, Any], start: datetime, end: datetime
) -> list[tuple[str, float]]:
    url = (influx.get("url") or "").rstrip("/")
    if not url:
        raise SourceError("Configura la URL de InfluxDB.")
    bucket = influx.get("database") or "homeassistant"
    measurement = influx.get("measurement") or "kWh"
    entity = influx.get("entity_id") or ""
    entity_filter = (
        f' and r["entity_id"] == "{entity}"' if entity else ""
    )
    flux = f"""
from(bucket: "{bucket}")
  |> range(start: {start.isoformat()}, stop: {end.isoformat()})
  |> filter(fn: (r) => r["_measurement"] == "{measurement}" and r["_field"] == "value"{entity_filter})
  |> aggregateWindow(every: 1h, fn: last, createEmpty: false)
"""
    headers = {
        "Authorization": f"Token {influx.get('token') or ''}",
        "Content-Type": "application/vnd.flux",
        "Accept": "application/csv",
    }
    params = {"org": influx.get("org") or ""}
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{url}/api/v2/query",
            params=params,
            data=flux,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            if resp.status != 200:
                raise SourceError(f"InfluxDB respondió {resp.status}: {await resp.text()}")
            text = await resp.text()

    values: list[tuple[str, float]] = []
    columns: dict[str, int] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        cells = line.split(",")
        if "_time" in cells and "_value" in cells:
            columns = {name: idx for idx, name in enumerate(cells)}
            continue
        if not columns:
            continue
        try:
            ts = cells[columns["_time"]]
            val = float(cells[columns["_value"]])
        except (KeyError, IndexError, ValueError):
            continue
        values.append((ts, val))
    values.sort(key=lambda item: item[0])
    return values


def _diff_cumulative(values: list[tuple[str, float]], tz) -> list[dict[str, Any]]:
    """Convierte lecturas acumuladas horarias en deltas de consumo.

    Los reinicios de contador (delta negativo) se tratan como 0.
    """
    series: list[dict[str, Any]] = []
    prev: float | None = None
    for ts, val in values:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(tz)
        if prev is not None:
            delta = val - prev
            series.append({"start": dt, "kwh": delta if delta > 0 else 0.0})
        prev = val
    return series


# ---------------------------------------------------------------------------
# Demo: perfil sintético reproducible para probar la interfaz sin conexión
# ---------------------------------------------------------------------------


def demo_hourly_consumption(
    start: datetime, end: datetime, tz, kind: str = "import"
) -> list[dict[str, Any]]:
    series: list[dict[str, Any]] = []
    current = start.astimezone(tz).replace(minute=0, second=0, microsecond=0)
    end = end.astimezone(tz)
    while current < end:
        h = current.hour
        seed = hashlib.md5(current.strftime(f"%Y%m%d%H{kind}").encode()).digest()[0] / 255.0
        if kind == "export":
            # Vertido solar: campana centrada a mediodía.
            base = 0.9 * math.exp(-((h - 13) ** 2) / 7.0)
            kwh = base * (0.6 + 0.8 * seed) if 8 <= h <= 20 else 0.0
        else:
            base = 0.12
            # Picos de mañana y noche, más consumo en fin de semana a mediodía.
            base += 0.35 * math.exp(-((h - 9) ** 2) / 6.0)
            base += 0.55 * math.exp(-((h - 21) ** 2) / 5.0)
            if current.weekday() >= 5:
                base += 0.25 * math.exp(-((h - 14) ** 2) / 8.0)
            kwh = base * (0.75 + 0.5 * seed)
        series.append({"start": current, "kwh": round(kwh, 3)})
        current += timedelta(hours=1)
    return series


# ---------------------------------------------------------------------------
# Punto de entrada común
# ---------------------------------------------------------------------------


async def get_hourly_consumption(
    settings: dict[str, Any],
    start: datetime,
    end: datetime,
    tz,
    kind: str = "import",
) -> list[dict[str, Any]]:
    """Serie horaria de energía importada (kind="import") o vertida ("export").

    Para "export", si no hay sensor configurado se devuelve una lista vacía
    (no es un error: simplemente no hay excedentes que compensar).
    """
    source = settings.get("source") or "demo"
    if source == "homeassistant":
        entity = settings.get("ha_entity_export" if kind == "export" else "ha_entity") or ""
        if kind == "export" and not entity:
            return []
        return await ha_hourly_consumption(settings, start, end, tz, entity)
    if source == "influxdb":
        influx = settings.get("influx") or {}
        entity = influx.get("entity_id_export" if kind == "export" else "entity_id") or ""
        if kind == "export" and not entity:
            return []
        return await influx_hourly_consumption(settings, start, end, tz, entity)
    return demo_hourly_consumption(start, end, tz, kind)

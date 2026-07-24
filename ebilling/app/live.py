"""Estado en vivo desde Home Assistant para la pantalla Home.

Reúne en una sola llamada: potencias instantáneas y flujos entre solar, red,
batería y casa; el resumen de energía del día (generación y consumo de la casa
por fuente); la meteorología (condición y temperatura exterior) y el momento
del día, para el fondo dinámico.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import aiohttp

import datasources

_LOGGER = logging.getLogger(__name__)

POWER_KEYS = (
    "pv",
    "grid_import",
    "grid_export",
    "battery_charge",
    "battery_discharge",
    "home",
)
ENERGY_KEYS = (
    "pv_energy",
    "grid_import_energy",
    "grid_export_energy",
    "battery_charge_energy",
    "battery_discharge_energy",
)


def _num(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # descarta NaN


def _convert(state: dict[str, Any] | None, kind: str) -> float | None:
    """Convierte el estado a W (kind='power') o Wh (kind='energy')."""
    if not state:
        return None
    raw = state.get("state")
    if raw in (None, "unknown", "unavailable", ""):
        return None
    value = _num(raw)
    if value is None:
        return None
    unit = ((state.get("attributes") or {}).get("unit_of_measurement") or "").lower()
    if kind == "power":
        if unit == "kw":
            return value * 1000.0
        if unit == "mw":
            return value * 1e6
        return value
    if unit == "wh":
        return value
    if unit == "mwh":
        return value * 1e6
    return value * 1000.0  # kWh por defecto


async def fetch_states(settings: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Descarga todos los estados de HA indexados por entity_id."""
    base, _ws, token = datasources._ha_endpoints(settings)
    headers = {"Authorization": f"Bearer {token}"}
    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.get(
            f"{base}/states", timeout=aiohttp.ClientTimeout(total=15)
        ) as resp:
            if resp.status != 200:
                raise datasources.SourceError(
                    f"Home Assistant respondió {resp.status} al leer los estados."
                )
            data = await resp.json()
    return {item["entity_id"]: item for item in data if item.get("entity_id")}


def _day_phase(states: dict[str, Any], now: datetime) -> str:
    """night | dawn | day | sunset, a partir de sun.sun (o de la hora local)."""
    sun = states.get("sun.sun")
    if sun:
        attrs = sun.get("attributes") or {}
        elevation = _num(attrs.get("elevation"))
        rising = bool(attrs.get("rising"))
        if elevation is not None:
            if elevation > 10:
                return "day"
            if elevation > -6:
                return "dawn" if rising else "sunset"
            return "night"
    hour = now.hour
    if 7 <= hour < 9:
        return "dawn"
    if 9 <= hour < 19:
        return "day"
    if 19 <= hour < 21:
        return "sunset"
    return "night"


def _weather(states: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
    entity = settings.get("weather_entity") or ""
    if not entity or entity not in states:
        entity = next((eid for eid in sorted(states) if eid.startswith("weather.")), "")
    condition = None
    temperature = None
    if entity and entity in states:
        state = states[entity]
        condition = state.get("state")
        temperature = _num((state.get("attributes") or {}).get("temperature"))
    # Un sensor de temperatura propio tiene prioridad sobre el de weather.*
    sensor = settings.get("temperature_sensor") or ""
    if sensor and sensor in states:
        value = _num(states[sensor].get("state"))
        if value is not None:
            temperature = value
    return {"entity": entity, "condition": condition, "temperature": temperature}


def _flows(power: dict[str, float]) -> dict[str, float]:
    """Reparte la potencia instantánea entre los seis flujos posibles."""
    pv = max(power.get("pv") or 0.0, 0.0)
    gi = max(power.get("grid_import") or 0.0, 0.0)
    ge = max(power.get("grid_export") or 0.0, 0.0)
    bc = max(power.get("battery_charge") or 0.0, 0.0)
    bd = max(power.get("battery_discharge") or 0.0, 0.0)
    solar_grid = min(ge, pv)
    rest = max(pv - solar_grid, 0.0)
    solar_battery = min(bc, rest)
    rest -= solar_battery
    solar_home = rest
    grid_battery = max(bc - solar_battery, 0.0)
    grid_home = max(gi - grid_battery, 0.0)
    return {
        "solar_home": solar_home,
        "solar_grid": solar_grid,
        "solar_battery": solar_battery,
        "grid_home": grid_home,
        "grid_battery": grid_battery,
        "battery_home": bd,
    }


def _energy_summary(energy: dict[str, float]) -> dict[str, Any]:
    """Resumen del día: generación y consumo de la casa, por destino/origen.

    Modelo equivalente al de las apps de inversores: lo vertido y lo que carga
    la batería se atribuyen a la generación, y el resto de la generación va a
    la casa.
    """
    gen_total = max(energy.get("pv_energy") or 0.0, 0.0)
    to_battery = max(energy.get("battery_charge_energy") or 0.0, 0.0)
    to_grid = max(energy.get("grid_export_energy") or 0.0, 0.0)
    to_load = max(gen_total - to_battery - to_grid, 0.0)

    from_solar = to_load
    from_battery = max(energy.get("battery_discharge_energy") or 0.0, 0.0)
    from_grid = max(energy.get("grid_import_energy") or 0.0, 0.0)
    home_total = from_solar + from_battery + from_grid

    def _rows(total: float, items: list[tuple[str, str, float]]) -> list[dict[str, Any]]:
        return [
            {
                "key": key,
                "label": label,
                "kwh": round(value / 1000.0, 2),
                "pct": round((value / total) * 100) if total > 0 else 0,
            }
            for key, label, value in items
        ]

    return {
        "generation": {
            "total": round(gen_total / 1000.0, 2),
            "rows": _rows(
                gen_total,
                [
                    ("to_load", "A la casa", to_load),
                    ("to_battery", "A la batería", to_battery),
                    ("to_grid", "A la red", to_grid),
                ],
            ),
        },
        "home": {
            "total": round(home_total / 1000.0, 2),
            "rows": _rows(
                home_total,
                [
                    ("from_solar", "Desde solar", from_solar),
                    ("from_battery", "Desde batería", from_battery),
                    ("from_grid", "Desde la red", from_grid),
                ],
            ),
        },
    }


async def build(settings: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Payload de /api/live."""
    flow_cfg = settings.get("flow_sensors") or {}
    energy_cfg = settings.get("energy_sensors") or {}
    configured = any(flow_cfg.get(k) for k in POWER_KEYS)

    states = await fetch_states(settings)

    power: dict[str, float] = {}
    for key in POWER_KEYS:
        entity = flow_cfg.get(key)
        value = _convert(states.get(entity), "power") if entity else None
        if value is not None:
            power[key] = value

    energy: dict[str, float] = {}
    for key in ENERGY_KEYS:
        entity = energy_cfg.get(key)
        value = _convert(states.get(entity), "energy") if entity else None
        if value is not None:
            energy[key] = value

    soc_entity = flow_cfg.get("battery_soc")
    soc = _num((states.get(soc_entity) or {}).get("state")) if soc_entity else None

    flows = _flows(power)
    home_power = power.get("home")
    if home_power is None:
        home_power = flows["solar_home"] + flows["grid_home"] + flows["battery_home"]

    return {
        "configured": configured,
        "power": {
            **{k: round(v, 1) for k, v in power.items()},
            "home": round(home_power, 1),
            "battery_soc": round(soc, 1) if soc is not None else None,
        },
        "flows": {k: round(v, 1) for k, v in flows.items()},
        "energy": _energy_summary(energy),
        "has_battery": bool(
            flow_cfg.get("battery_charge") or flow_cfg.get("battery_discharge")
        ),
        "weather": _weather(states, settings),
        "phase": _day_phase(states, now),
        "generated_at": now.isoformat(),
    }


def list_entities(states: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
    """Agrupa las entidades por tipo para los selectores de Ajustes."""
    groups: dict[str, list[dict[str, str]]] = {
        "power": [],
        "energy": [],
        "percent": [],
        "temperature": [],
        "weather": [],
    }
    for entity_id, state in states.items():
        attrs = state.get("attributes") or {}
        unit = (attrs.get("unit_of_measurement") or "").lower()
        device_class = attrs.get("device_class")
        name = attrs.get("friendly_name") or entity_id
        item = {
            "entity_id": entity_id,
            "name": name,
            "unit": attrs.get("unit_of_measurement") or "",
        }
        if entity_id.startswith("weather."):
            groups["weather"].append(item)
            continue
        if not entity_id.startswith("sensor."):
            continue
        if device_class == "power" or unit in ("w", "kw", "mw"):
            groups["power"].append(item)
        if device_class == "energy" or unit in ("wh", "kwh", "mwh"):
            groups["energy"].append(item)
        if device_class == "battery" or unit == "%":
            groups["percent"].append(item)
        if device_class == "temperature" or unit in ("°c", "°f"):
            groups["temperature"].append(item)
    for key in groups:
        groups[key].sort(key=lambda item: item["name"].lower())
    return groups

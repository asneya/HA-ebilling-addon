"""Persistencia de configuración y tarifas en /data (JSON)."""

from __future__ import annotations

import json
import os
import threading
import uuid
from typing import Any

DATA_DIR = os.environ.get("DATA_DIR", "/data")
CONFIG_PATH = os.path.join(DATA_DIR, "ebilling.json")

_lock = threading.Lock()

DEFAULT_SETTINGS: dict[str, Any] = {
    "source": "demo",  # demo | homeassistant | influxdb
    "ha_entity": "",
    "ha_url": "",  # solo para uso fuera del supervisor
    "ha_token": "",
    "influx": {
        "version": 2,  # 1 | 2
        "url": "http://a0d7b954-influxdb:8086",
        "database": "homeassistant",  # v1: database · v2: bucket
        "org": "",
        "token": "",
        "username": "",
        "password": "",
        "measurement": "kWh",
        "entity_id": "",
    },
    "contracted_power": {"p1": 4.6, "p2": 4.6},
    "billing_day": 1,
    "timezone": "Europe/Madrid",
    "holidays": [
        "01-01",
        "01-06",
        "05-01",
        "08-15",
        "10-12",
        "11-01",
        "12-06",
        "12-08",
        "12-25",
    ],
}

# Tarifa de referencia extraída de una factura real de Iberdrola (2.0TD,
# marzo 2026) y un ejemplo de tarifa plana para poder comparar desde el
# primer arranque.
DEFAULT_TARIFFS: list[dict[str, Any]] = [
    {
        "id": "iberdrola-plan-estable",
        "name": "Plan Estable",
        "company": "Iberdrola",
        "color": "#00a443",
        "power_prices": {"p1": 0.091074, "p2": 0.013483},
        "energy_prices": {"punta": 0.203912, "llano": 0.161451, "valle": 0.129779},
        "fixed_daily": [{"name": "Financiación bono social", "price": 0.019121}],
        "meter_rental_daily": 0.02663,
        "services_monthly": [{"name": "Asistente Smart", "price": 1.04}],
        "electricity_tax_pct": 0.5,
        "vat_energy_pct": 10.0,
        "vat_services_pct": 21.0,
    },
    {
        "id": "ejemplo-tarifa-plana",
        "name": "Tarifa plana (ejemplo)",
        "company": "Competencia",
        "color": "#4a6cf7",
        "power_prices": {"p1": 0.0838, "p2": 0.0838},
        "energy_prices": {"punta": 0.149, "llano": 0.149, "valle": 0.149},
        "fixed_daily": [{"name": "Financiación bono social", "price": 0.019121}],
        "meter_rental_daily": 0.02663,
        "services_monthly": [],
        "electricity_tax_pct": 0.5,
        "vat_energy_pct": 10.0,
        "vat_services_pct": 21.0,
    },
]


def _default_config() -> dict[str, Any]:
    return {
        "settings": json.loads(json.dumps(DEFAULT_SETTINGS)),
        "tariffs": json.loads(json.dumps(DEFAULT_TARIFFS)),
    }


def load() -> dict[str, Any]:
    with _lock:
        if not os.path.exists(CONFIG_PATH):
            config = _default_config()
            _write(config)
            return config
        try:
            with open(CONFIG_PATH, encoding="utf-8") as fh:
                config = json.load(fh)
        except (OSError, ValueError):
            config = _default_config()
            _write(config)
            return config
        # Completa claves nuevas que falten tras una actualización.
        merged = _default_config()
        merged_settings = merged["settings"]
        merged_settings.update(config.get("settings") or {})
        for key, value in merged["settings"]["influx"].items():
            (config.get("settings") or {}).setdefault("influx", {}).setdefault(key, value)
        merged_settings["influx"] = (config.get("settings") or {}).get(
            "influx", merged["settings"]["influx"]
        )
        return {
            "settings": merged_settings,
            "tariffs": config.get("tariffs", merged["tariffs"]),
        }


def _write(config: dict[str, Any]) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(config, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)


def save(config: dict[str, Any]) -> None:
    with _lock:
        _write(config)


def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    config = load()
    settings = config["settings"]
    for key, value in patch.items():
        if key == "influx" and isinstance(value, dict):
            settings.setdefault("influx", {}).update(value)
        else:
            settings[key] = value
    save(config)
    return settings


def add_tariff(tariff: dict[str, Any]) -> dict[str, Any]:
    config = load()
    tariff = dict(tariff)
    tariff["id"] = tariff.get("id") or uuid.uuid4().hex[:12]
    config["tariffs"].append(tariff)
    save(config)
    return tariff


def update_tariff(tariff_id: str, tariff: dict[str, Any]) -> dict[str, Any] | None:
    config = load()
    for idx, existing in enumerate(config["tariffs"]):
        if existing.get("id") == tariff_id:
            tariff = dict(tariff)
            tariff["id"] = tariff_id
            config["tariffs"][idx] = tariff
            save(config)
            return tariff
    return None


def delete_tariff(tariff_id: str) -> bool:
    config = load()
    before = len(config["tariffs"])
    config["tariffs"] = [t for t in config["tariffs"] if t.get("id") != tariff_id]
    if len(config["tariffs"]) != before:
        save(config)
        return True
    return False

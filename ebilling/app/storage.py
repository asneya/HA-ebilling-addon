"""Persistencia de configuración y tarifas en /data (JSON)."""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from typing import Any

import tariffs as tariffs_mod

_LOGGER = logging.getLogger(__name__)

DATA_DIR = os.environ.get("DATA_DIR", "/data")
CONFIG_PATH = os.path.join(DATA_DIR, "ebilling.json")

_lock = threading.Lock()

DEFAULT_SETTINGS: dict[str, Any] = {
    "source": "demo",  # demo | homeassistant | influxdb
    "ha_entity": "",
    "ha_entity_export": "",  # sensor de energía vertida (excedentes), opcional
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
        "entity_id_export": "",
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
    "export_sensors": True,
    "sensor_update_minutes": 5,
    # Intervalo de trabajo fijado por el usuario ({start,end} en YYYY-MM-DD,
    # fin inclusivo). Si está definido, es el periodo por defecto de todos los
    # cálculos (comparativa, detalle y sensores). null = ciclo automático.
    "working_period": None,
}

# Tarifas de arranque: la de referencia extraída de una factura real de
# Iberdrola (2.0TD, marzo 2026), una plana con excedentes y una PVPC.
DEFAULT_TARIFFS: list[dict[str, Any]] = [
    {
        "id": "iberdrola-plan-estable",
        "name": "Plan Estable",
        "company": "Iberdrola",
        "color": "#00a443",
        "energy": {
            "type": "schedule",
            "preset": "td3",
            "periods": [
                {"name": "Punta", "price": 0.203912, "schedule": "L-V 10-14,18-22"},
                {"name": "Llano", "price": 0.161451, "schedule": "L-V 8-10,14-18,22-24"},
                {"name": "Valle", "price": 0.129779, "schedule": ""},
            ],
            "pvpc_margin": 0.0,
        },
        "surplus": {"type": "none", "price": 0.0, "periods": []},
        "power_prices": {"p1": 0.091074, "p2": 0.013483},
        "fixed_daily": [{"name": "Financiación bono social", "price": 0.019121}],
        "meter_rental_daily": 0.02663,
        "services_monthly": [{"name": "Asistente Smart", "price": 1.04}],
        "electricity_tax_pct": 0.5,
        "vat_energy_pct": 10.0,
        "vat_services_pct": 21.0,
    },
    {
        "id": "ejemplo-tarifa-plana",
        "name": "Tarifa plana + excedentes (ejemplo)",
        "company": "Competencia",
        "color": "#4a6cf7",
        "energy": {
            "type": "schedule",
            "preset": None,
            "periods": [{"name": "Único", "price": 0.149, "schedule": ""}],
            "pvpc_margin": 0.0,
        },
        "surplus": {"type": "flat", "price": 0.06, "periods": []},
        "power_prices": {"p1": 0.0838, "p2": 0.0838},
        "fixed_daily": [{"name": "Financiación bono social", "price": 0.019121}],
        "meter_rental_daily": 0.02663,
        "services_monthly": [],
        "electricity_tax_pct": 0.5,
        "vat_energy_pct": 10.0,
        "vat_services_pct": 21.0,
    },
    {
        "id": "ejemplo-pvpc",
        "name": "PVPC (regulada)",
        "company": "Mercado regulado",
        "color": "#f59f00",
        "energy": {
            "type": "pvpc",
            "preset": None,
            "periods": [],
            "pvpc_margin": 0.0,
        },
        "surplus": {"type": "none", "price": 0.0, "periods": []},
        "power_prices": {"p1": 0.083775, "p2": 0.013027},
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


def _normalize_tariffs(raw_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for raw in raw_list:
        try:
            tariff = tariffs_mod.normalize_tariff(raw)
            tariff["id"] = raw.get("id") or uuid.uuid4().hex[:12]
            normalized.append(tariff)
        except tariffs_mod.TariffError:
            _LOGGER.warning("Tarifa inválida ignorada: %s", raw.get("name"), exc_info=True)
    return normalized


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
        # Completa claves nuevas que falten tras una actualización y migra
        # tarifas del formato antiguo al canónico.
        defaults = _default_config()
        settings = defaults["settings"]
        stored_settings = config.get("settings") or {}
        stored_influx = dict(stored_settings.get("influx") or {})
        settings.update(stored_settings)
        merged_influx = dict(defaults["settings"]["influx"])
        merged_influx.update(stored_influx)
        settings["influx"] = merged_influx
        return {
            "settings": settings,
            "tariffs": _normalize_tariffs(config.get("tariffs", defaults["tariffs"])),
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
    tariff = tariffs_mod.normalize_tariff(tariff)
    config = load()
    tariff["id"] = tariff.get("id") or uuid.uuid4().hex[:12]
    config["tariffs"].append(tariff)
    save(config)
    return tariff


def update_tariff(tariff_id: str, tariff: dict[str, Any]) -> dict[str, Any] | None:
    tariff = tariffs_mod.normalize_tariff(tariff)
    config = load()
    for idx, existing in enumerate(config["tariffs"]):
        if existing.get("id") == tariff_id:
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

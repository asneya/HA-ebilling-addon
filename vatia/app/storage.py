"""Persistencia de configuración y tarifas (JSON).

El fichero vive en la carpeta del add-on que el Supervisor expone en
``/addon_configs/<slug>/``, con una copia en ``/data`` como red de seguridad
para las copias de seguridad del add-on.
"""

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
# La configuración vive en la carpeta del add-on (`map: addon_config`), que el
# Supervisor expone en `/addon_configs/<slug>/`: se ve desde Samba, el File
# Editor o Studio Code Server, así que se puede leer, editar y respaldar sin
# entrar por SSH. `/data` es almacenamiento interno y no está compartido, que es
# donde estaba antes y por lo que costaba tanto llegar a ella.
CONFIG_DIR = os.environ.get("CONFIG_DIR") or (
    "/config" if os.path.isdir("/config") else DATA_DIR
)
CONFIG_PATH = os.path.join(CONFIG_DIR, "vatia.json")
# Copia en `/data`: es lo que archiva el Supervisor al hacer una copia de
# seguridad del add-on, así que un restaurado que solo traiga `/data` no se
# queda sin configuración. Manda siempre la de `CONFIG_DIR`.
MIRROR_PATH = os.path.join(DATA_DIR, "vatia.json")
# Sitios de los que se adopta la configuración si aún no está en su sitio
# nuevo: la copia interna, y el fichero de cuando el add-on se llamaba
# «eBilling» (al cambiar el slug, Home Assistant le dio un /data vacío y hay que
# traerlo a mano; si aparece se adopta tal cual, sin editar nada dentro).
LEGACY_PATHS = (
    MIRROR_PATH,
    os.path.join(CONFIG_DIR, "ebilling.json"),
    os.path.join(DATA_DIR, "ebilling.json"),
)

_lock = threading.Lock()

# Ajustes cuyo valor es un diccionario: se combinan con los valores por
# defecto al cargar y se actualizan por claves (no se reemplazan enteros).
NESTED_SETTINGS = ("influx", "flow_sensors", "energy_sensors", "contracted_power")

DEFAULT_SETTINGS: dict[str, Any] = {
    # De dónde salen los datos de **toda** la app: la Home, Energía, el flujo y
    # la facturación. Los sensores concretos se eligen en Ajustes → Sensores,
    # una sola vez y para todo (antes la facturación pedía los suyos aparte).
    "source": "demo",  # demo | homeassistant
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
    # Sensores del diagrama de flujo (potencia instantánea, W/kW) y del
    # resumen de energía del día (kWh), usados por la pantalla Home.
    "flow_sensors": {
        "pv": "",
        "grid_import": "",
        "grid_export": "",
        "battery_charge": "",
        "battery_discharge": "",
        "home": "",
        "battery_soc": "",
    },
    "energy_sensors": {
        "pv_energy": "",
        "grid_import_energy": "",
        "grid_export_energy": "",
        "battery_charge_energy": "",
        "battery_discharge_energy": "",
        # Opcional: si no se define, el consumo de la casa se mide integrando
        # su sensor de potencia (flow_sensors.home).
        "home_energy": "",
    },
    # Qué miden los contadores de energía anteriores:
    #   auto     → se detecta comparando el estado con el incremento del día
    #   daily    → ya son del día en curso: se lee su estado tal cual
    #   lifetime → acumulados: se calcula el incremento desde la medianoche
    "energy_counters": "auto",
    # Capacidad de la batería en kWh. Sirve para poner en kilovatios el estado de
    # carga —que llega en porcentaje— y así poder decir cuánta batería se llevaría
    # un electrodoméstico. 0 = sin configurar: entonces no se puede separar lo que
    # saldría de la batería de lo que saldría de la red, y se dice así.
    "battery_kwh": 0.0,
    # Meteorología del fondo de la Home: dos sensores independientes, uno con
    # la condición (texto) y otro con la temperatura exterior.
    "condition_sensor": "",
    "temperature_sensor": "",
    # Sensor de previsión de generación solar (Solcast, Forecast.Solar…). Se usa
    # para dibujar el forecast punteado en la pantalla de Energía cuando el
    # intervalo incluye tiempo futuro.
    "solar_forecast_sensor": "",
    # Apariencia: «auto» sigue al sistema (el modo oscuro del móvil o del
    # navegador), «light» y «dark» lo fuerzan.
    "theme": "auto",
    # Fondo de la Home según la hora y el tiempo. Quien prefiera una superficie
    # lisa —o tenga un móvil justo— lo puede apagar sin perder nada del dato.
    "dynamic_background": True,
    # Qué componente dibuja el flujo en tiempo real, de la galería de Ajustes.
    # No son dos estéticas del mismo dibujo: el Sankey mide caudales (px por kW)
    # y la órbita enseña el sitio de la casa, así que la elección es de fondo.
    #   sankey → <vatia-flow>, el diseño «Flujo de energía v2»
    #   orbita → <vatia-orbit>, la casa en el centro y las fuentes alrededor
    "flow_style": "sankey",
    # La tarifa contratada («la mía»): el id de una de las tarifas guardadas.
    # La comparativa sigue tratándolas a todas igual; esta solo añade lo que
    # ninguna comparación puede dar, el ahorro del día en euros.
    "my_tariff_id": "",
    # Intervalo de trabajo fijado por el usuario ({start,end} en YYYY-MM-DD,
    # fin inclusivo). Si está definido, es el periodo por defecto de todos los
    # cálculos (comparativa, detalle y sensores). null = ciclo automático.
    "working_period": None,
}

# Electrodomésticos medidos. Cada uno es un enchufe con nombre: su potencia dice
# lo que está haciendo ahora y su energía, lo que ha gastado hoy. Del histórico
# de la potencia se aprende cuánto dura y cuánto gasta un ciclo suyo, que es lo
# que permite contestar «¿me cabe en la ventana?» sin que nadie teclee un dato.
DEFAULT_APPLIANCES: list[dict[str, Any]] = []

# Glifos disponibles para un electrodoméstico (los del sprite) y color por
# defecto. Los cuatro primeros vienen dibujados del prototipo del diseño.
APPLIANCE_ICONS = ("lavadora", "lavavajillas", "horno", "coche", "potencia")
APPLIANCE_COLOR = "#0f7d8a"

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
        "appliances": json.loads(json.dumps(DEFAULT_APPLIANCES)),
    }


def normalize_appliance(raw: dict[str, Any]) -> dict[str, Any]:
    """Un electrodoméstico con lo que hace falta y nada más.

    Tolerante a propósito con lo que falta —el fichero se puede editar a mano—
    pero no con el nombre: sin nombre no hay fila que enseñar. El umbral de
    reposo separa «en marcha» de «enchufado»: un lavavajillas apagado marca dos
    o tres vatios y sin umbral cada minuto del día contaría como ciclo.
    """
    nombre = str(raw.get("name") or "").strip()
    if not nombre:
        raise ValueError("Un electrodoméstico necesita un nombre.")
    icono = str(raw.get("icon") or "").strip()
    try:
        umbral = float(raw.get("standby_w", 15))
    except (TypeError, ValueError):
        umbral = 15.0
    return {
        "id": str(raw.get("id") or "").strip() or uuid.uuid4().hex[:12],
        "name": nombre[:40],
        "color": str(raw.get("color") or APPLIANCE_COLOR).strip() or APPLIANCE_COLOR,
        "icon": icono if icono in APPLIANCE_ICONS else APPLIANCE_ICONS[-1],
        "power_entity": str(raw.get("power_entity") or "").strip(),
        "energy_entity": str(raw.get("energy_entity") or "").strip(),
        "standby_w": max(0.0, min(umbral, 5000.0)),
    }


def _normalize_appliances(raw_list: Any) -> list[dict[str, Any]]:
    out = []
    for raw in raw_list if isinstance(raw_list, list) else []:
        if not isinstance(raw, dict):
            continue
        try:
            out.append(normalize_appliance(raw))
        except ValueError:
            _LOGGER.warning("Electrodoméstico sin nombre ignorado: %s", raw)
    return out


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


def _read(path: str) -> dict[str, Any] | None:
    """Lee un JSON de configuración; ``None`` si no vale.

    El fichero está en una carpeta compartida y se puede editar a mano, así que
    un JSON roto es un caso previsible, no una anomalía. Se aparta con la
    extensión ``.invalido`` en lugar de sobreescribirlo —el trabajo de quien lo
    editó no se tira— y se sigue buscando en los demás sitios.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            config = json.load(fh)
    except OSError:
        return None
    except ValueError:
        _LOGGER.warning("Configuración ilegible en %s: se aparta y se ignora", path)
        try:
            os.replace(path, path + ".invalido")
        except OSError:
            _LOGGER.warning("Tampoco se pudo apartar %s", path, exc_info=True)
        return None
    return config if isinstance(config, dict) else None


def load() -> dict[str, Any]:
    with _lock:
        config = None
        for candidate in (CONFIG_PATH, *LEGACY_PATHS):
            config = _read(candidate)
            if config is not None:
                if candidate != CONFIG_PATH:
                    _LOGGER.info("Adoptando la configuración de %s", candidate)
                path = candidate
                break
        if config is None:
            config = _default_config()
            _write(config)
            return config
        # Completa claves nuevas que falten tras una actualización y migra
        # tarifas del formato antiguo al canónico.
        defaults = _default_config()
        settings = defaults["settings"]
        stored_settings = config.get("settings") or {}
        stored_nested = {
            key: dict(stored_settings.get(key) or {}) for key in NESTED_SETTINGS
        }
        settings.update(stored_settings)
        # Los diccionarios anidados se combinan con sus valores por defecto,
        # para que las claves nuevas aparezcan tras una actualización.
        for key in NESTED_SETTINGS:
            merged = dict(defaults["settings"][key])
            merged.update(stored_nested[key])
            settings[key] = merged
        _migrar_fuente(settings)
        merged_config = {
            "settings": settings,
            "tariffs": _normalize_tariffs(config.get("tariffs", defaults["tariffs"])),
            "appliances": _normalize_appliances(config.get("appliances", [])),
        }
        if path != CONFIG_PATH:
            # Se ha adoptado de otro sitio: se guarda ya en el suyo para no
            # volver a leerla de ahí.
            _write(merged_config)
        return merged_config


def _migrar_fuente(settings: dict[str, Any]) -> None:
    """Una sola fuente y unos solos sensores, para toda la app.

    Hasta la 0.38 la facturación se configuraba por su cuenta: `ha_entity` y
    `ha_entity_export` si la fuente era Home Assistant, `influx.entity_id` y
    `entity_id_export` si era InfluxDB. Eran **los mismos dos contadores** que
    ya se piden en Ajustes → Sensores, así que ahora se leen de allí y estas
    cuatro claves solo sirven para heredar lo que el usuario ya tenía puesto.

    InfluxDB deja de ser una «fuente»: es el histórico largo del consumo, que
    es lo único para lo que hace falta (las estadísticas horarias de Home
    Assistant no se purgan nunca, así que la facturación no lo necesita).
    """
    energia = settings.get("energy_sensors") or {}
    influx = settings.get("influx") or {}
    heredables = (
        ("grid_import_energy", settings.get("ha_entity"), influx.get("entity_id")),
        ("grid_export_energy", settings.get("ha_entity_export"), influx.get("entity_id_export")),
    )
    for destino, de_ha, de_influx in heredables:
        if not (energia.get(destino) or "").strip():
            viejo = (de_ha or de_influx or "").strip()
            if viejo:
                energia[destino] = viejo
                _LOGGER.info("Sensor de facturación adoptado en Sensores: %s", viejo)
    settings["energy_sensors"] = energia
    if settings.get("source") == "influxdb":
        settings["source"] = "homeassistant"
    for clave in ("ha_entity", "ha_entity_export"):
        settings.pop(clave, None)
    for clave in ("entity_id", "entity_id_export"):
        influx.pop(clave, None)


def _write(config: dict[str, Any]) -> None:
    texto = json.dumps(config, ensure_ascii=False, indent=2)
    for destino in (CONFIG_PATH, MIRROR_PATH):
        try:
            os.makedirs(os.path.dirname(destino), exist_ok=True)
            tmp = destino + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(texto)
            os.replace(tmp, destino)   # atómico: nunca se lee a medias
        except OSError:
            # La copia de /data es una red de seguridad, no un requisito: si no
            # se puede escribir (permisos, disco), el fichero bueno ya está.
            if destino is CONFIG_PATH:
                raise
            _LOGGER.warning("No se pudo guardar la copia en %s", destino, exc_info=True)


def save(config: dict[str, Any]) -> None:
    with _lock:
        _write(config)


def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    config = load()
    settings = config["settings"]
    for key, value in patch.items():
        if key in NESTED_SETTINGS and isinstance(value, dict):
            settings.setdefault(key, {}).update(value)
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


def add_appliance(raw: dict[str, Any]) -> dict[str, Any]:
    aparato = normalize_appliance(raw)
    config = load()
    config["appliances"].append(aparato)
    save(config)
    return aparato


def update_appliance(appliance_id: str, raw: dict[str, Any]) -> dict[str, Any] | None:
    aparato = normalize_appliance(raw)
    config = load()
    for idx, existing in enumerate(config["appliances"]):
        if existing.get("id") == appliance_id:
            aparato["id"] = appliance_id
            config["appliances"][idx] = aparato
            save(config)
            return aparato
    return None


def delete_appliance(appliance_id: str) -> bool:
    config = load()
    before = len(config["appliances"])
    config["appliances"] = [a for a in config["appliances"] if a.get("id") != appliance_id]
    if len(config["appliances"]) != before:
        save(config)
        return True
    return False

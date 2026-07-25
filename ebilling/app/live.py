"""Estado en vivo desde Home Assistant para la pantalla Home.

Reúne en una sola llamada: potencias instantáneas y flujos entre solar, red,
batería y casa; el resumen de energía del día (generación y consumo de la casa
por fuente); la meteorología (condición y temperatura exterior) y el momento
del día, para el fondo dinámico.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

import aiohttp

import datasources
import series as series_mod

_LOGGER = logging.getLogger(__name__)

POWER_KEYS = (
    "pv",
    "grid_import",
    "grid_export",
    "battery_charge",
    "battery_discharge",
    "home",
)
ENERGY_KEYS = series_mod.ENERGY_KEYS


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
    """Condición y temperatura exterior desde dos sensores independientes.

    El sensor de condición puede contener cualquier texto (los estados de HA
    tipo ``partlycloudy`` o descripciones en castellano); el frontend lo
    normaliza para elegir el icono y el fondo.
    """
    condition_sensor = settings.get("condition_sensor") or ""
    temperature_sensor = settings.get("temperature_sensor") or ""
    condition = None
    temperature = None
    if condition_sensor and condition_sensor in states:
        raw = states[condition_sensor].get("state")
        if raw not in (None, "", "unknown", "unavailable"):
            condition = raw
    if temperature_sensor and temperature_sensor in states:
        temperature = _num(states[temperature_sensor].get("state"))
    return {
        "condition": condition,
        "temperature": temperature,
        "condition_sensor": condition_sensor,
        "temperature_sensor": temperature_sensor,
    }


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


def _energy_summary(
    energy: dict[str, float], flows: dict[str, float] | None = None
) -> dict[str, Any]:
    """Resumen del día: generación y consumo de la casa, por destino/origen.

    ``energy`` son los totales del día en Wh y ``flows`` el reparto ya sumado
    bucket a bucket (lo normal). Si no hay reparto por buckets se calcula sobre
    los totales, que es menos preciso cuando la batería se carga de la red a
    horas en las que también hay sol.
    """
    gen_total = max(energy.get("pv_energy") or 0.0, 0.0)
    if flows is None:
        flows = series_mod.split_flows(
            gen_total,
            energy.get("battery_charge_energy") or 0.0,
            energy.get("grid_export_energy") or 0.0,
            energy.get("grid_import_energy") or 0.0,
            energy.get("battery_discharge_energy") or 0.0,
            energy.get("home_energy"),
        )
    else:
        # El reparto por buckets suma lo mismo que el total del día salvo los
        # últimos minutos (el estado del sensor va por delante de las
        # estadísticas). Se reescala para que cada columna cuadre exactamente
        # con su contador, que es con lo que el usuario compara.
        #
        # Si los buckets se quedan muy por debajo del total (estadísticas
        # incompletas o inexistentes para algún sensor), reescalar daría una
        # falsa precisión: se vuelve al reparto sobre los totales.
        bucket_gen = flows["to_home"] + flows["to_battery"] + flows["to_grid"]
        if gen_total > 0 and bucket_gen < gen_total * 0.5:
            return _energy_summary(energy, None)
        flows = dict(flows)

        def _rescale(parts: tuple[str, ...], target: float | None) -> float:
            total = sum(flows[key] for key in parts)
            if target is not None and target > 0 and total > 0:
                factor = target / total
                for key in parts:
                    flows[key] *= factor
                return target
            return total

        _rescale(("to_home", "to_battery", "to_grid"), gen_total if gen_total > 0 else None)
        flows["home_total"] = _rescale(
            ("from_solar", "from_battery", "from_grid"), energy.get("home_energy")
        )
    to_load = flows["to_home"]
    to_battery = flows["to_battery"]
    to_grid = flows["to_grid"]
    from_solar = flows["from_solar"]
    from_battery = flows["from_battery"]
    from_grid = flows["from_grid"]
    home_total = flows["home_total"]

    # Lecturas del día tal cual, sin reparto: son lo que muestran los nodos del
    # diagrama de flujo (un nodo representa un contador, no una atribución).
    def _kwh(key: str) -> float:
        return round(max(energy.get(key) or 0.0, 0.0) / 1000.0, 2)

    meters = {
        "pv": round(gen_total / 1000.0, 2),
        "grid_import": _kwh("grid_import_energy"),
        "grid_export": _kwh("grid_export_energy"),
        "battery_charge": _kwh("battery_charge_energy"),
        "battery_discharge": _kwh("battery_discharge_energy"),
    }
    if energy.get("home_energy") is not None:
        meters["home"] = _kwh("home_energy")
    # Lo importado que fue a la batería y lo vertido que salió de ella: son la
    # diferencia entre los contadores de la red y el reparto del consumo.
    meters["grid_to_battery"] = round(flows["grid_to_battery"] / 1000.0, 2)
    meters["battery_to_grid"] = round(flows["battery_to_grid"] / 1000.0, 2)

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
        "meters": meters,
    }


# Las estadísticas del día solo cambian cada 5 minutos: se cachean para no
# abrir un websocket a HA en cada refresco de la Home (cada 20 s).
_DAILY_TTL = 120.0
_daily_cache: dict[str, Any] = {"key": None, "at": 0.0, "value": {}}


def _same_day_total(state_value: float, computed: float) -> bool:
    """¿El estado del sensor es ya el total del día?

    Un contador del día marca prácticamente lo mismo que el incremento
    calculado (solo difieren en lo consumido en los últimos minutos, que las
    estadísticas aún no han consolidado). Uno acumulado marca mucho más.
    """
    margin = max(computed * 0.25, 300.0)  # 25 % o 0,3 kWh
    return state_value <= computed + margin


def _states_energy(
    energy_cfg: dict[str, str], states: dict[str, Any]
) -> dict[str, float]:
    """Energía (Wh) leyendo el estado de cada contador tal cual."""
    out: dict[str, float] = {}
    for key in ENERGY_KEYS:
        entity = energy_cfg.get(key)
        if not entity:
            continue
        value = _convert(states.get(entity), "energy")
        if value is not None:
            out[key] = value
    return out


def _accumulate_flows(
    buckets: dict[str, dict[str, float]], measured_home: bool
) -> dict[str, float] | None:
    """Reparte cada bucket por separado y suma los resultados (Wh).

    Hacer el reparto una sola vez sobre el total del día pierde la correlación
    temporal: si la batería se carga de la red de madrugada y hay sol al
    mediodía, sobre los totales esa carga parece solar. Bucket a bucket (5
    minutos) las dos cosas no se solapan y el reparto sale bien. Los datos ya
    vienen descargados, así que no cuesta ninguna petición extra.
    """
    if not buckets:
        return None
    keys = ("to_home", "to_battery", "to_grid", "from_solar", "from_battery",
            "from_grid", "home_total", "grid_to_battery", "battery_to_grid")
    acc = dict.fromkeys(keys, 0.0)
    for values in buckets.values():
        split = series_mod.split_flows(
            values.get("pv_energy", 0.0),
            values.get("battery_charge_energy", 0.0),
            values.get("grid_export_energy", 0.0),
            values.get("grid_import_energy", 0.0),
            values.get("battery_discharge_energy", 0.0),
            values.get("home_energy") if measured_home else None,
        )
        for key in keys:
            acc[key] += split[key]
    return {key: value * 1000.0 for key, value in acc.items()}  # kWh → Wh


async def daily_energy(
    settings: dict[str, Any], states: dict[str, Any], tz, now: datetime
) -> dict[str, Any]:
    """Energía de hoy: ``{"totals": Wh por clave, "flows": reparto en Wh}``.

    Los totales, según el ajuste ``energy_counters``:

    - ``daily``: los sensores ya miden el día en curso, así que se lee su
      estado directamente, que va al segundo.
    - ``lifetime``: son contadores acumulados desde el inicio del histórico
      (``total_increasing``), así que se pide el incremento (``change``) desde
      la medianoche local, en pasos de 5 minutos y con el bucket diario como
      respaldo.
    - ``auto`` (por defecto): se calcula el incremento y se compara con el
      estado; si coinciden, el sensor ya es del día y se usa su estado.

    El **reparto** (qué parte de la generación va a cada sitio y de dónde viene
    el consumo) no lo mide ningún sensor: no existe un contador «solar→casa».
    Se deduce, y se hace bucket a bucket para no perder la hora a la que ocurre
    cada cosa. ``flows`` es ``None`` si no hay estadísticas con las que hacerlo.
    """
    energy_cfg = settings.get("energy_sensors") or {}
    flow_cfg = settings.get("flow_sensors") or {}
    mode = settings.get("energy_counters") or "auto"
    ids = [energy_cfg.get(k) for k in ENERGY_KEYS if energy_cfg.get(k)]
    # Sin contador propio del consumo de la casa, se mide integrando su sensor
    # de potencia (que ya está configurado en el flujo de energía).
    home_power = "" if energy_cfg.get("home_energy") else (flow_cfg.get("home") or "")
    if not ids and not home_power:
        return {"totals": {}, "flows": None}

    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    cache_key = f"{mode}|{start.isoformat()}|{','.join(ids)}|{home_power}"
    if (
        _daily_cache["key"] == cache_key
        and time.monotonic() - _daily_cache["at"] < _DAILY_TTL
    ):
        cached = {"totals": dict(_daily_cache["value"]["totals"]),
                  "flows": _daily_cache["value"]["flows"]}
        if mode == "daily":
            # El estado va al segundo; el reparto viene cacheado.
            cached["totals"].update(_states_energy(energy_cfg, states))
        return cached

    requests: list[dict[str, Any]] = []
    if ids:
        # Los buckets de 5 minutos se piden también en modo «daily»: los
        # totales salen del estado, pero el reparto necesita el detalle.
        requests.append(
            {"ids": ids, "start": start, "end": now, "period": "5minute", "types": ["change"]}
        )
        requests.append(
            {"ids": ids, "start": start, "end": now, "period": "day", "types": ["change"]}
        )
    power_index = None
    if home_power:
        power_index = len(requests)
        requests.append(
            {"ids": [home_power], "start": start, "end": now,
             "period": "5minute", "types": ["mean"]}
        )

    results: list[dict[str, Any]] = [{} for _ in requests]
    units: dict[str, str] = {}
    try:
        results, units = await series_mod.ws_statistics(settings, requests)
    except Exception:  # noqa: BLE001 - se degrada al estado actual del sensor
        _LOGGER.warning("No se pudieron leer las estadísticas del día", exc_info=True)

    detailed = results[0] if ids else {}
    coarse = results[1] if ids else {}

    # Incremento por bucket de cada contador (kWh). Los pares que comparten un
    # sensor bidireccional se reparten por signo: su estado (un contador neto)
    # no sirve para ninguna de las dos direcciones.
    by_key: dict[str, dict[str, float]] = {}
    for key in ENERGY_KEYS:
        entity = energy_cfg.get(key)
        if entity:
            factor = series_mod._unit_factor(entity, states, "energy", units)
            by_key[key] = series_mod._extract(detailed, entity, "change", tz, factor)
    series_mod.split_signed_buckets(by_key, energy_cfg, series_mod.ENERGY_PAIRS)
    series_mod.clamp_buckets(by_key)
    signed_keys = {
        key
        for pos, neg in series_mod.ENERGY_PAIRS
        if series_mod.shares_sensor(energy_cfg, pos, neg)
        for key in (pos, neg)
    }

    out: dict[str, float] = {}
    per_bucket: dict[str, dict[str, float]] = {}
    for key in ENERGY_KEYS:
        entity = energy_cfg.get(key)
        if not entity:
            continue
        buckets = by_key.get(key) or {}
        for iso, value in buckets.items():
            per_bucket.setdefault(iso, {})[key] = value
        if key in signed_keys:
            # Solo las estadísticas separan las dos direcciones.
            if buckets:
                out[key] = sum(buckets.values()) * 1000.0
            continue
        state_value = _convert(states.get(entity), "energy")
        if mode == "daily":
            if state_value is not None:
                out[key] = state_value
            continue
        if not buckets:
            factor = series_mod._unit_factor(entity, states, "energy", units)
            buckets = series_mod._extract(coarse, entity, "change", tz, factor)
        if not buckets:
            if state_value is not None:
                out[key] = state_value
            continue
        computed = sum(buckets.values()) * 1000.0  # kWh → Wh
        # En automático, si el estado coincide con el incremento del día es que
        # el sensor ya mide el día en curso: se usa su estado, más fresco que
        # las estadísticas (que van con hasta 5 minutos de retraso).
        if mode == "auto" and state_value is not None and _same_day_total(state_value, computed):
            out[key] = state_value
        else:
            out[key] = computed

    # Consumo de la casa por integración de su potencia media (Wh).
    if power_index is not None and power_index < len(results):
        factor = series_mod._unit_factor(home_power, states, "power", units)
        means = series_mod._extract(results[power_index], home_power, "mean", tz, factor)
        # Si el sensor está invertido (integral negativa) no vale como medida:
        # se deja sin poner y el consumo se deduce por balance más abajo. Si
        # solo hay algún bucket negativo, se recorta para que no reste.
        if means and sum(means.values()) > 0:
            means = {iso: max(watts, 0.0) for iso, watts in means.items()}
            out["home_energy"] = sum(means.values()) * (5.0 / 60.0)
            for iso, watts in means.items():
                per_bucket.setdefault(iso, {})["home_energy"] = watts * (5.0 / 60.0) / 1000.0

    # Último filtro: un contador puede dar un total negativo (sensor con el
    # signo invertido, o un reinicio que las estadísticas cuentan como
    # incremento negativo). La energía es una magnitud: nunca es negativa.
    #
    # El consumo de la casa se puede deducir por balance, así que un contador
    # que no suma nada se descarta y lo calcula el reparto (mejor que un cero
    # que no cuadraría con el resumen): una casa que no consume nada en todo el
    # día no existe, y a las 00:05 el balance da lo mismo, casi nada. Los demás
    # no tienen alternativa: a cero.
    if (out.get("home_energy") or 0.0) <= 0:
        out.pop("home_energy", None)
    out = {key: max(value, 0.0) for key, value in out.items()}

    flows = _accumulate_flows(per_bucket, out.get("home_energy") is not None)
    value = {"totals": out, "flows": flows}
    _daily_cache.update({"key": cache_key, "at": time.monotonic(),
                         "value": {"totals": dict(out), "flows": flows}})
    return value


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
    # Un medidor bidireccional asignado a las dos casillas se reparte por signo.
    series_mod.split_signed_values(power, flow_cfg, series_mod.POWER_PAIRS)
    # Ninguna de estas magnitudes puede ser negativa: la casa no genera, el
    # sol no consume. Un valor negativo es un sensor con el signo invertido o
    # un medidor neto puesto en una sola casilla, y se recorta a cero antes de
    # que llegue a pantalla.
    power = {k: max(v, 0.0) for k, v in power.items()}

    # Totales del día y reparto por buckets (el estado del sensor no vale como
    # total cuando el contador es acumulado).
    daily = await daily_energy(settings, states, now.tzinfo, now)
    energy = daily["totals"]

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
        "energy": _energy_summary(energy, daily["flows"]),
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
        # «any» incluye cualquier sensor (más las entidades weather.*), para el
        # selector del sensor de condición meteorológica, que puede ser un
        # sensor de texto cualquiera.
        "any": [],
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
            groups["any"].append(item)
            continue
        if not entity_id.startswith("sensor."):
            continue
        groups["any"].append(item)
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

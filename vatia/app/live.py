"""Estado en vivo desde Home Assistant para la pantalla Home.

Reúne en una sola llamada: potencias instantáneas y flujos entre solar, red,
batería y casa; el resumen de energía del día (generación y consumo de la casa
por fuente); la meteorología (condición y temperatura exterior) y el momento
del día, para el fondo dinámico.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta
from typing import Any

import aiohttp

import appliances as appliances_mod
import billing
import datasources
import planner
import prevision
import pvpc
import series as series_mod
import storage

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
# Sensor de potencia del que se puede deducir cada contador si el contador no
# existe o no tiene estadísticas.
POWER_FOR_ENERGY = {
    "pv_energy": "pv",
    "grid_import_energy": "grid_import",
    "grid_export_energy": "grid_export",
    "battery_charge_energy": "battery_charge",
    "battery_discharge_energy": "battery_discharge",
    "home_energy": "home",
}


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


def reparto_del_dia(
    energy: dict[str, float], flows: dict[str, float] | None
) -> dict[str, float]:
    """El reparto definitivo del día, en Wh: el que se enseña.

    Una sola función porque lo miran dos pantallas —el resumen de la Home y el
    diagnóstico de Ajustes— y en cuanto cada una hiciera su cuenta darían
    cifras distintas del mismo día, que es exactamente la clase de
    contradicción que este resumen ya ha tenido bastante.

    ``energy`` son los totales del día y ``flows`` el reparto sumado intervalo a
    intervalo (lo normal). Sin reparto por intervalos se calcula sobre los
    totales, que es menos preciso cuando la batería se carga de la red a horas
    en las que también hay sol.
    """
    gen_total = max(energy.get("pv_energy") or 0.0, 0.0)
    if flows is None:
        return series_mod.split_flows(
            gen_total,
            energy.get("battery_charge_energy") or 0.0,
            energy.get("grid_export_energy") or 0.0,
            energy.get("grid_import_energy") or 0.0,
            energy.get("battery_discharge_energy") or 0.0,
            energy.get("home_energy"),
        )
    # El reparto por intervalos suma lo mismo que el total del día salvo los
    # últimos minutos (el estado del sensor va por delante de las estadísticas).
    # Se reescala para que cada columna cuadre exactamente con su contador, que
    # es con lo que el usuario compara.
    #
    # Si los intervalos se quedan muy por debajo del total (estadísticas
    # incompletas o inexistentes para algún sensor), reescalar daría una falsa
    # precisión: se vuelve al reparto sobre los totales.
    bucket_gen = flows["to_home"] + flows["to_battery"] + flows["to_grid"]
    if gen_total > 0 and bucket_gen < gen_total * 0.5:
        return reparto_del_dia(energy, None)
    # El mismo ajuste que aplica la pantalla de Energía, compartido para que las
    # dos den la misma cifra.
    return series_mod.rescale_flows(flows, energy)


def _energy_summary(
    energy: dict[str, float], flows: dict[str, float] | None = None
) -> dict[str, Any]:
    """Resumen del día: generación y consumo de la casa, por destino/origen."""
    flows = reparto_del_dia(energy, flows)
    gen_total = max(energy.get("pv_energy") or 0.0, 0.0)
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
        "pv": _kwh("pv_energy"),
        "grid_import": _kwh("grid_import_energy"),
        "grid_export": _kwh("grid_export_energy"),
        "battery_charge": _kwh("battery_charge_energy"),
        "battery_discharge": _kwh("battery_discharge_energy"),
    }
    if energy.get("home_energy") is not None:
        meters["home"] = _kwh("home_energy")
    else:
        # Sin contador de casa que valga (no configurado, o descartado por
        # contradecir el balance), la casa de la fila de contadores es la que
        # deduce el reparto: la fila la enseña siempre, y un 0 fijo parecería
        # una casa apagada.
        meters["home"] = round(home_total / 1000.0, 2)
    # Lo importado que fue a la batería y lo vertido que salió de ella: son la
    # diferencia entre los contadores de la red y el reparto del consumo.
    #
    # Se calculan **restando del contador** en lugar de sumar el reparto por
    # intervalos, para que las tres cifras que se ven en pantalla cuadren entre
    # sí: el nodo de la red (el contador), la fila «Desde la red» (lo que
    # consumió la casa) y la nota. Sumando el reparto por su cuenta se separaban
    # de la lectura del contador y quedaba un hueco sin explicar.
    meters["grid_to_battery"] = round(
        max(meters["grid_import"] * 1000.0 - from_grid, 0.0) / 1000.0, 2
    )
    meters["battery_to_grid"] = round(
        max(meters["grid_export"] * 1000.0 - to_grid, 0.0) / 1000.0, 2
    )

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


def _prefer_power(totals: dict[str, float], power_totals: dict[str, float]) -> None:
    """Un contador a cero no manda sobre una potencia que sí está midiendo.

    Un contador que marca 0 mientras su sensor de potencia lleva horas dando
    cientos de vatios no está midiendo, o todavía no ha empezado. Es la misma
    regla que con un contador sin estadísticas: «cero» y «sin dato» no son lo
    mismo, y un cero falso no se queda quieto —el reparto lo da por bueno y le
    echa la culpa al residuo—.
    """
    for key, integral in power_totals.items():
        if integral > 0 and not totals.get(key):
            totals[key] = integral


# El aviso del contador de casa descartado, una vez por arranque y no cada dos
# minutos que se recalcula la caché del día.
_CASA_AVISADA: set[str] = set()


def _avisar_casa_descartada(out: dict[str, float], sensor: str) -> None:
    if sensor in _CASA_AVISADA:
        return
    _CASA_AVISADA.add(sensor)
    balance = (
        (out.get("pv_energy") or 0.0)
        + (out.get("grid_import_energy") or 0.0)
        + (out.get("battery_discharge_energy") or 0.0)
        - (out.get("grid_export_energy") or 0.0)
        - (out.get("battery_charge_energy") or 0.0)
    )
    _LOGGER.warning(
        "El contador de la casa (%s) marca %.1f kWh pero el balance de los "
        "demás contadores da %.1f: no mide el consumo total (¿es el sensor de "
        "autoconsumo del inversor?). Se descarta y el consumo se deduce del "
        "balance.",
        sensor,
        (out.get("home_energy") or 0.0) / 1000.0,
        balance / 1000.0,
    )


MODOS_CONTADOR = ("auto", "daily", "lifetime")


def modo_contador(settings: dict[str, Any], key: str) -> str:
    """Qué mide **este** contador: `auto`, `daily` o `lifetime`.

    Antes era un único ajuste para los seis, y una instalación normal los tiene
    mezclados: el de la red viene totalizado desde que se instaló y los de la
    batería son del día. Con un solo interruptor, la mitad se leía mal y no
    había manera de arreglarlo sin estropear la otra mitad.

    `energy_counter_kinds` guarda la excepción de cada casilla; lo que no tenga
    excepción sigue al ajuste general, que es lo que ya había configurado.
    """
    propio = (settings.get("energy_counter_kinds") or {}).get(key)
    if propio in MODOS_CONTADOR:
        return propio
    general = settings.get("energy_counters")
    return general if general in MODOS_CONTADOR else "auto"


def _states_energy(
    energy_cfg: dict[str, str], states: dict[str, Any], solo: set[str] | None = None
) -> dict[str, float]:
    """Energía (Wh) leyendo el estado de cada contador tal cual.

    `solo` acota a las casillas que de verdad son del día: en la caché rápida
    solo esas pueden refrescarse con el estado.
    """
    out: dict[str, float] = {}
    for key in ENERGY_KEYS:
        entity = energy_cfg.get(key)
        if not entity or (solo is not None and key not in solo):
            continue
        value = _convert(states.get(entity), "energy")
        if value is not None:
            out[key] = value
    return out


def _accumulate_flows(
    buckets: dict[str, dict[str, float]], measured_home: bool
) -> dict[str, float] | None:
    """Reparte hora a hora y suma los resultados (Wh).

    Hacer el reparto una sola vez sobre el total del día pierde la correlación
    temporal: si la batería se carga de la red de madrugada y hay sol al
    mediodía, sobre los totales esa carga parece solar. Repartir por intervalos
    las separa. Los datos ya vienen descargados, así que no cuesta ninguna
    petición extra.

    Los intervalos son de **una hora** y no de cinco minutos, que es como
    llegan: seis contadores distintos no publican a la vez, y a cinco minutos
    ese desfase se leía como carga que el sol no explica. Los buckets finos
    siguen saliendo enteros de ``daily_energy`` para el cierre del día.
    """
    if not buckets:
        return None
    keys = ("to_home", "to_battery", "to_grid", "from_solar", "from_battery",
            "from_grid", "home_total", "grid_to_battery", "battery_to_grid")
    acc = dict.fromkeys(keys, 0.0)
    for values in series_mod.por_horas(buckets).values():
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
    modo = {key: modo_contador(settings, key) for key in ENERGY_KEYS}
    del_dia = {k for k, v in modo.items() if v == "daily"}
    ids = [energy_cfg.get(k) for k in ENERGY_KEYS if energy_cfg.get(k)]
    # Respaldo: el contador que no exista —o que no tenga estadísticas— se mide
    # integrando su sensor de potencia, que ya está configurado en el flujo de
    # energía. Sin esto, esa magnitud valdría cero y el reparto se lo achacaría
    # al residuo: se vería «0 importada» y a la vez «4,2 kWh desde la red».
    power_of = {
        key: flow_cfg.get(POWER_FOR_ENERGY[key]) or "" for key in ENERGY_KEYS
    }
    power_ids = list(dict.fromkeys(s for s in power_of.values() if s))
    if not ids and not power_ids:
        return {"totals": {}, "flows": None, "sources": {}, "buckets": {}}

    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    firma_modo = ",".join(f"{k}={modo[k]}" for k in ENERGY_KEYS)
    cache_key = f"{firma_modo}|{start.isoformat()}|{','.join(ids)}|{','.join(power_ids)}"
    if (
        _daily_cache["key"] == cache_key
        and time.monotonic() - _daily_cache["at"] < _DAILY_TTL
    ):
        cached = {"totals": dict(_daily_cache["value"]["totals"]),
                  "flows": _daily_cache["value"]["flows"],
                  "sources": dict(_daily_cache["value"].get("sources") or {}),
                  "buckets": _daily_cache["value"].get("buckets") or {}}
        if del_dia:
            # El estado va al segundo; el reparto viene cacheado. El estado
            # tampoco manda si marca cero y la potencia dice otra cosa.
            frescos = _states_energy(energy_cfg, states, del_dia)
            if "home_energy" not in _daily_cache["value"]["totals"]:
                # El contador de la casa se descartó al calcular (no cuadraba
                # con el balance): su estado fresco tampoco vale.
                frescos.pop("home_energy", None)
            cached["totals"].update(frescos)
            _prefer_power(cached["totals"], _daily_cache["value"].get("power") or {})
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
    if power_ids:
        power_index = len(requests)
        requests.append(
            {"ids": power_ids, "start": start, "end": now,
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
            rows = series_mod._extract(detailed, entity, "change", tz, factor)
            if rows:
                by_key[key] = rows
    series_mod.split_signed_buckets(by_key, energy_cfg, series_mod.ENERGY_PAIRS)
    series_mod.clamp_buckets(by_key)

    # Curvas de potencia (W por bucket de 5 min) para el respaldo.
    curves: dict[str, dict[str, float]] = {}
    if power_index is not None and power_index < len(results):
        for key, entity in power_of.items():
            if not entity:
                continue
            factor = series_mod._unit_factor(entity, states, "power", units)
            curves[POWER_FOR_ENERGY[key]] = series_mod._extract(
                results[power_index], entity, "mean", tz, factor
            )
        series_mod.split_signed_buckets(curves, flow_cfg, series_mod.POWER_PAIRS)
        curves = {
            k: {i: max(w, 0.0) for i, w in data.items()} for k, data in curves.items()
        }
    signed_keys = {
        key
        for pos, neg in series_mod.ENERGY_PAIRS
        if series_mod.shares_sensor(energy_cfg, pos, neg)
        for key in (pos, neg)
    }

    out: dict[str, float] = {}
    # De dónde ha salido cada cifra, para poder enseñarlo en el diagnóstico.
    sources: dict[str, str] = {}
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
                sources[key] = "estadisticas"
            continue
        state_value = _convert(states.get(entity), "energy")
        if modo[key] == "daily":
            if state_value is not None:
                out[key] = state_value
                sources[key] = "estado"
            continue
        if not buckets:
            factor = series_mod._unit_factor(entity, states, "energy", units)
            buckets = series_mod._extract(coarse, entity, "change", tz, factor)
        if not buckets:
            if state_value is not None:
                out[key] = state_value
                sources[key] = "estado"
            continue
        computed = sum(buckets.values()) * 1000.0  # kWh → Wh
        # En automático, si el estado coincide con el incremento del día es que
        # el sensor ya mide el día en curso: se usa su estado, más fresco que
        # las estadísticas (que van con hasta 5 minutos de retraso).
        if modo[key] == "auto" and state_value is not None and _same_day_total(state_value, computed):
            out[key] = state_value
            sources[key] = "estado"
        else:
            out[key] = computed
            sources[key] = "estadisticas"

    # Integral de cada potencia (Wh). Sustituye al contador que no ha dado nada
    # —o que marca cero mientras su potencia sí mide— y aporta el detalle por
    # bucket cuando el contador no tiene estadísticas. Una media negativa
    # (sensor invertido) no resta; si toda la curva es negativa, el sensor no
    # vale y esa magnitud se queda sin dato.
    power_totals: dict[str, float] = {}
    for key, entity in power_of.items():
        if not entity:
            continue
        means = curves.get(POWER_FOR_ENERGY[key]) or {}
        integral = sum(means.values()) * (5.0 / 60.0) if means else 0.0
        if integral <= 0:
            continue
        power_totals[key] = integral
        if not out.get(key):
            out[key] = integral
            sources[key] = "potencia"
        if sum((by_key.get(key) or {}).values()) <= 0:
            # Sin buckets del contador (o todos a cero), el reparto usa los de
            # la potencia: si no, repartiría sobre un cero que no es real.
            for iso, watts in means.items():
                per_bucket.setdefault(iso, {})[key] = watts * (5.0 / 60.0) / 1000.0

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
        sources.pop("home_energy", None)
    out = {key: max(value, 0.0) for key, value in out.items()}

    # Y un contador de casa que contradice el balance de los otros cinco
    # tampoco reparte: no mide el consumo total (el caso visto: el sensor de
    # «consumo» de un Sungrow que en realidad es el autoconsumo, sin lo
    # importado). Forzar el total a ese contador escondía la importación en una
    # carga de batería que las curvas no vieron.
    if out.get("home_energy") is not None and not series_mod.casa_cuadra(out):
        _avisar_casa_descartada(out, energy_cfg.get("home_energy") or "?")
        out.pop("home_energy")
        sources["home_energy"] = "balance"

    flows = _accumulate_flows(per_bucket, out.get("home_energy") is not None)
    # Los buckets salen fuera para poder cruzarlos con la ventana en el cierre
    # del día: ya están descargados, así que no cuesta ninguna petición extra.
    value = {"totals": out, "flows": flows, "sources": sources, "buckets": per_bucket}
    _daily_cache.update({"key": cache_key, "at": time.monotonic(),
                         "value": {"totals": dict(out), "flows": flows,
                                   "power": dict(power_totals),
                                   "sources": dict(sources),
                                   "buckets": per_bucket}})
    return value


_DIAG_LABELS = {
    "pv_energy": ("Generación solar", "entra"),
    "grid_import_energy": ("Importada de la red", "entra"),
    "battery_discharge_energy": ("Descarga de la batería", "entra"),
    "home_energy": ("Consumo de la casa", "sale"),
    "grid_export_energy": ("Exportada a la red", "sale"),
    "battery_charge_energy": ("Carga de la batería", "sale"),
}
_DIAG_SOURCES = {
    "estado": "estado del sensor",
    "estadisticas": "estadísticas",
    "potencia": "integral de su potencia",
    # El contador está configurado pero contradice el balance de los demás:
    # se descarta y la cifra que se enseña se deduce de los otros cinco.
    "balance": "descartado: contradice el balance (¿mide el autoconsumo?)",
}


async def diagnostics(
    settings: dict[str, Any], states: dict[str, Any], tz, now: datetime
) -> dict[str, Any]:
    """Balance de energía del día, sensor a sensor.

    Todo lo que entra en la instalación tiene que salir por algún sitio: lo
    generado, lo importado y lo que descarga la batería frente a lo que consume
    la casa, lo vertido y lo que carga la batería. Si no cuadra, uno de los
    sensores miente, y el reparto de la Home no puede hacer magia con eso: lo
    único honesto es enseñar la diferencia y de dónde sale cada cifra.
    """
    energy_cfg = settings.get("energy_sensors") or {}
    flow_cfg = settings.get("flow_sensors") or {}
    daily = await daily_energy(settings, states, tz, now)
    totals, sources = daily["totals"], daily.get("sources") or {}

    rows: list[dict[str, Any]] = []
    sums = {"entra": 0.0, "sale": 0.0}
    for key, (label, side) in _DIAG_LABELS.items():
        value = totals.get(key)
        source = sources.get(key)
        sensor = energy_cfg.get(key) or ""
        if source == "potencia" or (value is not None and not sensor):
            sensor = flow_cfg.get(POWER_FOR_ENERGY[key]) or ""
        if value is not None:
            sums[side] += value
        rows.append({
            "key": key,
            "label": label,
            "side": side,
            "kwh": None if value is None else round(value / 1000.0, 2),
            "sensor": sensor,
            "source": _DIAG_SOURCES.get(source or "", "sin dato"),
        })

    entra, sale = sums["entra"] / 1000.0, sums["sale"] / 1000.0
    diff = entra - sale
    mayor = max(entra, sale)
    # Un 5 % de margen absorbe el desfase normal entre contadores y el retraso
    # de las estadísticas; por encima de eso hay un sensor que no cuadra.
    cuadra = mayor <= 0 or abs(diff) <= max(mayor * 0.05, 0.1)
    # De dónde sale el consumo típico con el que se calcula la ventana. Aquí y
    # no en la tarjeta: la pregunta «¿está usando mi InfluxDB?» es de esta
    # pantalla, y la tarjeta tiene que decir horas, no procedencias.
    perfil = await _house_profile(settings, states, tz, now)
    # A dónde fue lo que entró por la red y lo que salió de la batería. No lo
    # mide ningún sensor —no existe un contador «red→batería»—, se deduce hora a
    # hora, y es la parte del resumen que más veces ha estado mal. Enseñarla
    # aquí, junto a los contadores de los que sale, es lo que permite mirar el
    # reparto y el contador a la vez en lugar de sospechar de la cifra final.
    # El **mismo** reparto que enseña el resumen de la Home, no una cuenta
    # paralela: si aquí saliera otra cifra, el diagnóstico dejaría de servir
    # para diagnosticar el resumen.
    flows = reparto_del_dia(totals, daily.get("flows")) if totals else {}

    def _kwh(clave: str) -> float:
        return round((flows.get(clave) or 0.0) / 1000.0, 2)

    def _par(casa: str, otro: str, contador: str) -> dict[str, float]:
        """Un origen partido entre sus dos destinos, y lo que no llega a cuadrar.

        Lo importado siempre suma su contador: el reparto lo garantiza. Lo
        descargado no siempre, y no por un fallo: si el contador de la casa dice
        que consumió menos de lo que la batería asegura haberle dado, hay una
        parte de la descarga que **ningún sensor coloca**. Se enseña tal cual, en
        su propia fila, en vez de callarla o de acusar al reparto de no cuadrar:
        el descuadre es entre sensores, y esta pantalla está para verlo.
        """
        medido = round(max(totals.get(contador) or 0.0, 0.0) / 1000.0, 2)
        a, b = _kwh(casa), _kwh(otro)
        return {
            "home": a,
            "other": b,
            "placed": round(a + b, 2),
            "meter": medido,
            "unplaced": round(max(medido - a - b, 0.0), 2),
        }

    reparto = {
        "grid": _par("from_grid", "grid_to_battery", "grid_import_energy"),
        "battery": _par("from_battery", "battery_to_grid",
                        "battery_discharge_energy"),
    } if flows else None
    return {
        "rows": rows,
        "entra": round(entra, 2),
        "sale": round(sale, 2),
        "diferencia": round(diff, 2),
        "cuadra": cuadra,
        "reparto": reparto,
        "profile": perfil.payload() if perfil else None,
        "generated_at": now.isoformat(),
    }


# Consumo típico de la casa y ventana de energía gratis. El histórico es caro
# para un endpoint que se pide cada pocos segundos, así que se guarda un rato.
_baseline_cache: dict[str, Any] = {"key": None, "at": 0.0, "value": None}
_BASELINE_TTL = 1800.0

# Días de histórico que se piden. Al recorder se le piden pocos porque por
# defecto solo guarda diez; a InfluxDB, muchos más, que es justo lo que aporta:
# con seis semanas el perfil ya distingue el laborable del fin de semana sin que
# un día raro lo desvíe.
_DIAS_RECORDER = 14
_DIAS_INFLUX = 42
# Muestras mínimas para creerse una casilla del perfil. Con menos se cae al
# escalón de al lado, y en último término a una sola cifra para todo el día.
_MIN_MUESTRAS_HORA = 3
_MIN_MUESTRAS_TOTAL = 24


class HouseProfile:
    """Consumo habitual de la casa, hora a hora.

    El umbral de la ventana era una sola cifra —la mediana de la semana— y eso
    la hacía mentir justo cuando importa: con 320 W de mediana y el horno puesto
    a la una, la app decía «ahora es gratis» mientras la casa pedía 2.500 W. El
    perfil guarda una cifra por hora y por tipo de día, así que a la una el
    umbral es el de la una.

    Se usa la **mediana** y no la media: un día con el horno tres horas subiría
    la media y acortaría la ventana de todos los demás días. Lo que interesa es
    lo que la casa gasta de normal a esa hora.
    """

    def __init__(self, por_hora: dict[tuple[bool, int], float], plano: float,
                 origen: str, dias: int):
        self._por_hora = por_hora
        self.plano = plano
        self.origen = origen          # «influxdb» o «recorder»
        self.dias = dias
        # ¿Hay bastantes casillas para que el perfil aporte algo? Con cuatro
        # horas medidas no se puede hablar de perfil, y es más honesto decir que
        # se está usando una sola cifra.
        self.por_horas = len(por_hora) >= 12

    def at(self, moment: datetime) -> float:
        """Umbral a esa hora. Cae al escalón vecino y luego a la cifra plana."""
        if not self.por_horas:
            return self.plano
        laborable = moment.weekday() < 5
        hora = moment.hour
        for clave in ((laborable, hora), (not laborable, hora)):
            if clave in self._por_hora:
                return self._por_hora[clave]
        # Sin dato ni para esa hora ni para el otro tipo de día: la hora de al
        # lado antes que la cifra de todo el día.
        for salto in (1, -1, 2, -2):
            clave = (laborable, (hora + salto) % 24)
            if clave in self._por_hora:
                return self._por_hora[clave]
        return self.plano

    def payload(self) -> dict[str, Any]:
        """Lo que se enseña de él: de dónde sale y cómo es el día medio."""
        laborable = [
            round(self._por_hora.get((True, h), self._por_hora.get((False, h), self.plano)), 1)
            for h in range(24)
        ]
        return {
            "source": self.origen,
            "days": self.dias,
            "hourly": self.por_horas,
            "flat_w": round(self.plano, 1),
            "weekday_w": laborable,
            "min_w": round(min(laborable), 1),
            "max_w": round(max(laborable), 1),
        }


def _perfil_de(muestras: list[tuple[datetime, float]], origen: str, dias: int
               ) -> HouseProfile | None:
    """Agrupa las muestras horarias en un perfil por (tipo de día, hora)."""
    if len(muestras) < _MIN_MUESTRAS_TOTAL:
        return None
    cubos: dict[tuple[bool, int], list[float]] = {}
    todas: list[float] = []
    for moment, watts in muestras:
        w = max(watts, 0.0)
        cubos.setdefault((moment.weekday() < 5, moment.hour), []).append(w)
        todas.append(w)
    por_hora = {
        clave: sorted(v)[len(v) // 2]
        for clave, v in cubos.items()
        if len(v) >= _MIN_MUESTRAS_HORA
    }
    todas.sort()
    return HouseProfile(por_hora, todas[len(todas) // 2], origen, dias)


async def _house_profile(
    settings: dict[str, Any], states: dict[str, Any], tz, now: datetime
) -> HouseProfile | None:
    """Perfil de consumo de la casa, de InfluxDB si está o del recorder si no.

    InfluxDB primero porque guarda meses donde el recorder guarda diez días, y
    el perfil mejora con el histórico: con dos semanas cada casilla tiene dos
    muestras, con seis tiene seis y un día raro deja de desviarla. Si InfluxDB
    no está configurado o no responde, se sigue con el recorder — que es lo que
    había — sin que se note más que en la letra pequeña de la tarjeta.
    """
    entity = (settings.get("flow_sensors") or {}).get("home") or ""
    if not entity:
        return None
    influx_url = ((settings.get("influx") or {}).get("url") or "").strip()
    key = f"{entity}|{influx_url}|{now.strftime('%Y-%m-%d-%H')}"
    if (
        _baseline_cache["key"] == key
        and time.monotonic() - _baseline_cache["at"] < _BASELINE_TTL
    ):
        return _baseline_cache["value"]

    medianoche = now.replace(hour=0, minute=0, second=0, microsecond=0)
    perfil: HouseProfile | None = None

    if influx_url:
        try:
            unidad = ((states.get(entity, {}).get("attributes") or {})
                      .get("unit_of_measurement") or "")
            factor = 1000.0 if unidad.lower() == "kw" else 1.0
            crudo = await datasources.influx_hourly_mean(
                settings, entity, unidad,
                medianoche - timedelta(days=_DIAS_INFLUX), now, tz,
            )
            perfil = _perfil_de(
                [(t, w * factor) for t, w in crudo], "influxdb", _DIAS_INFLUX
            )
        except Exception:  # noqa: BLE001 - se sigue con el recorder
            _LOGGER.info("InfluxDB no pudo dar el histórico del consumo", exc_info=True)

    if perfil is None:
        try:
            results, units = await series_mod.ws_statistics(
                settings,
                [{"ids": [entity],
                  "start": medianoche - timedelta(days=_DIAS_RECORDER),
                  "end": now, "period": "hour", "types": ["mean"]}],
            )
            factor = series_mod._unit_factor(entity, states, "power", units)
            rows = series_mod._extract(results[0], entity, "mean", tz, factor)
            perfil = _perfil_de(
                [(datetime.fromisoformat(k), v) for k, v in rows.items()],
                "recorder", _DIAS_RECORDER,
            )
        except Exception:  # noqa: BLE001 - sin histórico no hay ventana, y ya está
            _LOGGER.warning("No se pudo calcular el consumo típico", exc_info=True)

    _baseline_cache.update({"key": key, "at": time.monotonic(), "value": perfil})
    return perfil


# El sesgo del tejado no se recalcula en cada refresco —la Home pide
# `/api/live` cada veinte segundos— pero tampoco se caduca por reloj: se cachea
# contra el sello del fichero, así que aparece en cuanto hay dato nuevo y no
# cuando toque. La anotación sí lleva su propio reloj: escribe.
_sesgo_cache: dict[str, Any] = {"sello": None, "value": None}
_anotado: dict[str, Any] = {"dia": None, "at": 0.0}
_ANOTAR_CADA = 1800.0


def _sesgo_tejado() -> prevision.Sesgo:
    sello = prevision.version(storage.CONFIG_DIR)
    if _sesgo_cache["value"] is None or _sesgo_cache["sello"] != sello:
        _sesgo_cache.update({
            "value": prevision.aprender(storage.CONFIG_DIR), "sello": sello,
        })
    return _sesgo_cache["value"]


def _anotar_prevision(
    puntos: list[tuple[datetime, float]],
    buckets: dict[str, dict[str, float]] | None,
    now: datetime,
) -> None:
    """Apunta lo previsto y lo producido de las horas de hoy que ya han pasado.

    Es la única manera de tener pares: Home Assistant no guarda las previsiones
    de ayer —son un atributo, y los atributos no van a las estadísticas—, pero
    la previsión de hoy sí incluye las horas que ya pasaron, y lo producido en
    ellas está en los buckets que la Home ya se ha descargado.

    Solo se apuntan las horas **cerradas**: la que está en curso va a medias y
    daría un cociente bajo todos los días a la misma hora.
    """
    if not buckets:
        return
    if (_anotado["dia"] == now.date()
            and time.monotonic() - _anotado["at"] < _ANOTAR_CADA):
        return
    previsto = {
        h: wh for h, wh in prevision.por_horas(
            [(t, w) for t, w in puntos if t.date() == now.date()]
        ).items() if h < now.hour
    }
    real: dict[int, float] = {}
    for iso, valores in buckets.items():
        pv = valores.get("pv_energy")
        if pv is None:
            continue
        try:
            momento = datetime.fromisoformat(iso)
        except ValueError:
            continue
        if momento.date() != now.date() or momento.hour >= now.hour:
            continue
        real[momento.hour] = real.get(momento.hour, 0.0) + pv * 1000.0
    if not previsto or not real:
        return
    prevision.registrar(storage.CONFIG_DIR, now.date(), previsto, real)
    _anotado.update({"dia": now.date(), "at": time.monotonic()})


def _hueco_bateria(
    settings: dict[str, Any], states: dict[str, Any]
) -> float | None:
    """Lo que le cabe todavía a la batería, en Wh. ``None`` si no se sabe.

    Hace falta la capacidad (que se teclea en Ajustes, no la dice ningún sensor)
    y el estado de carga. Sin una de las dos no se descuenta nada: es mejor
    prometer un excedente de más y decir con qué se ha contado que restar una
    cifra inventada.
    """
    capacidad = float(settings.get("battery_kwh") or 0.0)
    entidad = (settings.get("flow_sensors") or {}).get("battery_soc") or ""
    soc = _num((states.get(entidad) or {}).get("state")) if entidad else None
    if capacidad <= 0 or soc is None:
        return None
    return max(0.0, min(100.0 - soc, 100.0)) / 100.0 * capacidad * 1000.0


async def free_energy(
    settings: dict[str, Any],
    states: dict[str, Any],
    tz,
    now: datetime,
    buckets: dict[str, dict[str, float]] | None = None,
) -> dict[str, Any] | None:
    """La ventana de energía gratis de hoy y de mañana, con su estado.

    ``None`` cuando falta con qué calcularla: sin previsión solar no hay ventana
    que enseñar, y es mejor no enseñar nada que inventarse una hora.

    ``buckets`` es el detalle del día que ya trae `daily_energy`: sirve para
    comparar lo previsto con lo producido de verdad y aprender el sesgo del
    tejado. Sin ellos la ventana sale igual, solo sin corregir.
    """
    points = series_mod.forecast_power(
        series_mod._forecast_states(settings, states), tz
    )
    if not points:
        return None
    # El sesgo del tejado: lo que la previsión se pasa o se queda corta a cada
    # hora, aprendido de los días anteriores. Se aplica antes que nada, porque
    # todo lo que viene detrás —la ventana, el consejo, el reparto— tiene que
    # partir de la mejor curva que se tenga, no de la cruda.
    _anotar_prevision(points, buckets, now)
    sesgo = _sesgo_tejado()
    points = sesgo.aplicar(points)
    perfil = await _house_profile(settings, states, tz, now)
    if perfil is None:
        return None

    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    hueco = _hueco_bateria(settings, states)
    today = series_mod.free_window(points, perfil.at, midnight, hueco)
    # Mañana **sin** descontar la batería: cómo estará mañana por la mañana no
    # se sabe, y suponerlo sería inventar. Así además `kwh` de hoy y de mañana
    # siguen siendo la misma magnitud y se pueden comparar en la nota.
    tomorrow = series_mod.free_window(points, perfil.at, midnight + timedelta(days=1))

    # Eje de la línea de tiempo: las horas de luz de hoy, sacadas de la propia
    # previsión, así no hace falta el sensor del sol. Es la misma cuenta que la
    # ventana pero con el umbral a cero —«cuándo hay algo de sol»—, y por eso el
    # eje contiene siempre a la ventana: subir el umbral solo puede acortarla.
    lit = series_mod.free_window(points, 0.0, midnight)
    daylight = {"from": lit["start"], "to": lit["end"]} if lit else None

    # pre: aún no ha abierto · open: está abierta · post: ya cerró · none: hoy
    # no sobra nada (un día de nubes) y solo queda mirar a mañana.
    #
    # Con el perfil horario la ventana puede tener huecos —la hora del horno—, y
    # entonces «abierta» no puede salir de estar entre el primer y el último
    # corte: tiene que ser dentro de un tramo. Estando en un hueco el estado
    # vuelve a «pre», con la hora del tramo siguiente, que es exactamente lo que
    # hay que decir: «ahora no, a partir de las 14:00 sí».
    state = "none"
    left_h = 0.0
    reopens: str | None = None
    if today:
        tramos = [
            (datetime.fromisoformat(s["start"]), datetime.fromisoformat(s["end"]))
            for s in today["spans"]
        ]
        fin = tramos[-1][1]
        dentro = next(((a, b) for a, b in tramos if a <= now < b), None)
        if dentro:
            state = "open"
            # Lo que queda de excedente hoy: este tramo y los que vengan detrás.
            left_h = (dentro[1] - now).total_seconds() / 3600.0 + sum(
                (b - a).total_seconds() / 3600.0 for a, b in tramos if a > now
            )
        elif now >= fin:
            state = "post"
        else:
            state = "pre"
            siguiente = next((a for a, _b in tramos if a > now), tramos[0][0])
            reopens = siguiente.isoformat()
            left_h = sum(
                (b - a).total_seconds() / 3600.0 for a, b in tramos if a >= siguiente
            )
    return {
        # Se conserva `baseline_w` —la cifra plana— porque es lo que se enseña
        # como «consumo típico»; el perfil va aparte, con su procedencia.
        "baseline_w": round(perfil.plano, 1),
        "profile": perfil.payload(),
        "today": today,
        "tomorrow": tomorrow,
        "daylight": daylight,
        "state": state,
        "hours_left": round(left_h, 3),
        # Cuándo vuelve a haber excedente, si estamos en un hueco de la ventana.
        "reopens_at": reopens,
        # Con qué se ha contado la batería, para poder decirlo en la tarjeta en
        # vez de restar en silencio. `null` = no se ha descontado nada.
        "battery_room_kwh": None if hueco is None else round(hueco / 1000.0, 2),
        # Y lo que se le ha corregido a la previsión, por lo mismo: una curva
        # que no es la del sensor tiene que decir que no lo es.
        "bias": sesgo.payload(),
    }


def _sunset(states: dict[str, Any], now: datetime) -> datetime | None:
    """Puesta de sol de hoy, de ``sun.sun``."""
    attrs = (states.get("sun.sun") or {}).get("attributes") or {}
    moment = series_mod._parse_dt(attrs.get("next_setting"), now.tzinfo)
    if moment is None:
        return None
    # `next_setting` es la *próxima*: si cae mañana, la de hoy ya pasó y se
    # obtiene restando un día. Entre dos puestas seguidas hay un par de minutos
    # de diferencia, y aquí solo sirve para redactar una frase.
    while moment.date() > now.date():
        moment -= timedelta(days=1)
    return moment


def _bucket_home_kwh(values: dict[str, float]) -> float | None:
    """Consumo de la casa en un bucket (kWh), medido o derivado del balance."""
    home = values.get("home_energy")
    if home is not None:
        return max(home, 0.0)
    keys = ("pv_energy", "grid_import_energy", "battery_discharge_energy",
            "grid_export_energy", "battery_charge_energy")
    if not any(key in values for key in keys):
        return None
    entra = (values.get("pv_energy") or 0.0) + (values.get("grid_import_energy") or 0.0) \
        + (values.get("battery_discharge_energy") or 0.0)
    sale = (values.get("grid_export_energy") or 0.0) \
        + (values.get("battery_charge_energy") or 0.0)
    return max(entra - sale, 0.0)


async def day_savings(
    settings: dict[str, Any],
    tariffs: list[dict[str, Any]] | None,
    buckets: dict[str, dict[str, float]],
    tz,
    now: datetime,
) -> dict[str, Any] | None:
    """Lo que la instalación te ha ahorrado hoy, con la tarifa contratada.

    La cuenta es la diferencia entre dos días: el que has tenido y el que
    habrías tenido sin placas ni batería, con el mismo consumo comprado entero
    a la red. Se hace bucket a bucket porque el precio cambia con la hora, y
    ahorrar a mediodía (valle) no vale lo mismo que ahorrar a las ocho (punta).

    ``None`` si no hay tarifa marcada como «la mía», no hay buckets, o falta el
    precio de alguna hora (un PVPC sin publicar): antes que estimar la cifra
    que más se mira, no se da.
    """
    my_id = settings.get("my_tariff_id") or ""
    tariff = next((t for t in tariffs or [] if t.get("id") == my_id), None)
    if not tariff or not buckets:
        return None
    holidays = set(settings.get("holidays") or [])
    pvpc_prices = None
    if tariff["energy"]["type"] == "pvpc":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        try:
            pvpc_prices = await pvpc.get_prices(start, now, tz)
        except Exception:  # noqa: BLE001 - sin precios no hay ahorro que dar
            _LOGGER.warning("Sin precios PVPC para el ahorro del día", exc_info=True)
            return None

    base = 0.0        # lo que habría costado el día comprándolo todo
    imported = 0.0    # lo que ha costado lo importado
    surplus = 0.0     # lo que compensa lo exportado
    for iso, values in buckets.items():
        home = _bucket_home_kwh(values)
        if home is None:
            continue
        moment = datetime.fromisoformat(iso)
        price, _name = billing.price_now(tariff, moment, holidays, pvpc_prices)
        if price is None:
            return None
        base += home * price
        imported += (values.get("grid_import_energy") or 0.0) * price
        sp = billing.surplus_price_now(tariff, moment, holidays)
        if sp:
            surplus += (values.get("grid_export_energy") or 0.0) * sp
    # La compensación de excedentes no puede dejar el término de energía en
    # negativo (así lo liquidan las comercializadoras); el día tampoco.
    actual = max(imported - min(surplus, imported), 0.0)
    return {
        "eur": round(max(base - actual, 0.0), 2),
        "base_eur": round(base, 2),
        "actual_eur": round(actual, 2),
        "tariff_id": tariff.get("id"),
        "tariff_name": tariff.get("name"),
    }


def day_close(
    states: dict[str, Any],
    energy: dict[str, Any],
    buckets: dict[str, dict[str, float]],
    window: dict[str, Any] | None,
    now: datetime,
    savings: dict[str, Any] | None = None,
    appliance_list: list[dict[str, Any]] | None = None,
    aprendido: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """El cierre del día, al anochecer. ``None`` mientras haya sol.

    Cuando el sol se pone ya no queda nada que decidir: el día está hecho, y lo
    que toca es contarlo. Sale de datos que ya están en el payload, así que no
    cuesta ninguna petición.

    Lo que no lleva y podría parecer que falta: el ahorro en euros y la racha de
    días. El ahorro necesitaría una tarifa «la mía», y la app justamente compara
    tarifas sin elegir ninguna; la racha necesitaría guardar un histórico propio
    que hoy no existe. Ponerlos a ojo sería inventarse la cifra que más se mira.
    """
    sunset = _sunset(states, now)
    if sunset is None or now < sunset:
        return None

    home = energy.get("home") or {}
    generation = energy.get("generation") or {}
    consumed = float(home.get("total") or 0.0)
    from_grid = next(
        (float(r["kwh"]) for r in home.get("rows") or [] if r["key"] == "from_grid"), 0.0
    )
    # Autosuficiencia: la parte del consumo que no ha venido de la red. Sin
    # consumo medido no hay porcentaje que dar.
    self_pct = round((1 - from_grid / consumed) * 100) if consumed > 0 else None

    # Cuánto de lo que gastó la casa cayó dentro de la ventana. Es el número que
    # dice si el día se aprovechó o no, y sale de cruzar los buckets de 5
    # minutos —ya descargados— con las horas de la ventana.
    today = (window or {}).get("today")
    in_window = None
    if today and buckets:
        start = datetime.fromisoformat(today["start"])
        end = datetime.fromisoformat(today["end"])
        total = 0.0
        inside = 0.0
        for iso, values in buckets.items():
            kwh = values.get("home_energy")
            if kwh is None:
                continue
            total += kwh
            moment = datetime.fromisoformat(iso)
            if start <= moment < end:
                inside += kwh
        if total > 0:
            in_window = {
                "kwh": round(inside, 2),
                "pct": round(inside / total * 100),
            }

    return {
        "date": now.date().isoformat(),
        "sunset": sunset.isoformat(),
        "minutes_since": max(1, round((now - sunset).total_seconds() / 60)),
        "produced": round(float(generation.get("total") or 0.0), 2),
        "consumed": round(consumed, 2),
        "self_pct": self_pct,
        "in_window": in_window,
        "saved": savings,
        "appliances": appliances_mod.del_cierre(
            appliance_list or [], aprendido or {}, window
        ),
        "tomorrow": (window or {}).get("tomorrow"),
    }


async def build(
    settings: dict[str, Any],
    now: datetime,
    tariffs: list[dict[str, Any]] | None = None,
    appliance_list: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
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

    flows = series_mod.power_flows(power)
    home_power = power.get("home")
    if home_power is None:
        home_power = flows["solar_home"] + flows["grid_home"] + flows["battery_home"]

    energy_summary = _energy_summary(energy, daily["flows"])
    buckets = daily.get("buckets") or {}
    # Los buckets van a la ventana para poder comparar lo previsto de hoy con
    # lo producido de verdad, que es de donde sale el sesgo del tejado.
    window = await free_energy(settings, states, now.tzinfo, now, buckets)
    # El ahorro solo hace falta cuando el cierre va a salir: tras la puesta de
    # sol. Calcularlo a mediodía sería trabajo (y PVPC) tirado a la basura.
    sunset = _sunset(states, now)
    savings = None
    if sunset is not None and now >= sunset:
        savings = await day_savings(settings, tariffs, buckets, now.tzinfo, now)

    # Electrodomésticos. Lo que hacen ahora sale del estado que ya está aquí y no
    # cuesta nada; el ciclo típico viene del histórico y se guarda media hora,
    # igual que el perfil de la casa, para que este endpoint siga siendo rápido.
    aparatos = appliance_list or []
    ahora_aparatos = appliances_mod.instantaneo(states, aparatos)
    aprendido: dict[str, dict[str, Any]] = {}
    consejo = None
    plan = None
    if aparatos:
        aprendido = await appliances_mod.learn(settings, states, aparatos, now.tzinfo, now)
        fuentes = await _fuentes(settings, states, power, soc, now.tzinfo, now)
        consejo = appliances_mod.advice(
            aparatos, aprendido, window, now,
            _precio_tras_ventana(settings, tariffs, window, now),
            fuentes,
        )
        # El plan del día: a qué hora sale más barato cada aparato y si
        # compensa cargar la batería de la red. Comparte las fuentes con el
        # consejo, así que no cuesta ninguna petición más que los precios.
        plan = planner.plan(
            aparatos, aprendido, fuentes,
            await _precio_por_hora(settings, tariffs, now), now,
            (window or {}).get("tomorrow"),
        )
        for fila in ahora_aparatos:
            datos = aprendido.get(fila["id"]) or {}
            fila["cycle"] = datos.get("cycle")
            fila["today_kwh"] = datos.get("today_kwh")

    return {
        "configured": configured,
        "power": {
            **{k: round(v, 1) for k, v in power.items()},
            "home": round(home_power, 1),
            "battery_soc": round(soc, 1) if soc is not None else None,
        },
        "flows": {k: round(v, 1) for k, v in flows.items()},
        "energy": energy_summary,
        "has_battery": bool(
            flow_cfg.get("battery_charge") or flow_cfg.get("battery_discharge")
        ),
        "weather": _weather(states, settings),
        "phase": _day_phase(states, now),
        "window": window,
        "appliances": ahora_aparatos,
        "advice": consejo,
        "plan": plan,
        "close": day_close(
            states, energy_summary, buckets, window, now, savings, aparatos, aprendido
        ),
        "generated_at": now.isoformat(),
    }


async def _fuentes(
    settings: dict[str, Any],
    states: dict[str, Any],
    power: dict[str, float],
    soc: float | None,
    tz,
    now: datetime,
) -> dict[str, Any] | None:
    """Con qué se estima de dónde saldría la energía de un ciclo puesto ahora.

    Las dos curvas son las mismas que usa la ventana —la previsión solar y el
    perfil horario de la casa—, así que no cuesta ninguna petición más: el perfil
    está en caché y la previsión sale de los atributos del sensor que ya está en
    `states`.

    La previsión se **corrige con la producción real de este momento**. Es lo que
    la hace utilizable: un día de nubes que la previsión no vio prometería un sol
    que no está, y la estimación diría «lo pone el sol» mientras la casa tira de
    la batería. El factor se recorta entre 0,2 y 1,5 para que un desajuste puntual
    —una nube justo encima del panel a mediodía— no lleve la corrección al absurdo.
    """
    puntos = series_mod.forecast_power(
        series_mod._forecast_states(settings, states), tz
    )
    if not puntos:
        return None
    perfil = await _house_profile(settings, states, tz, now)
    if perfil is None:
        return None

    # El sesgo del tejado primero y el factor en vivo después, en este orden:
    # el sesgo es la diferencia constante entre lo que promete la previsión y
    # lo que da este tejado, y el factor es cuánto se desvía **hoy** de eso. Al
    # revés se contarían dos veces, porque el factor se mediría contra una curva
    # que ya se sabe que miente.
    puntos = _sesgo_tejado().aplicar(puntos)

    previsto_ahora = series_mod.forecast_at(puntos, now)
    real_ahora = max(power.get("pv") or 0.0, 0.0)
    factor = 1.0
    if previsto_ahora and previsto_ahora > 50:
        factor = max(0.2, min(real_ahora / previsto_ahora, 1.5))

    return {
        "sol_at": lambda momento: series_mod.forecast_at(puntos, momento) * factor,
        "casa_at": perfil.at,
        "soc": soc,
        "capacity_kwh": float(settings.get("battery_kwh") or 0.0),
        "factor": round(factor, 2),
    }


async def _precio_por_hora(
    settings: dict[str, Any],
    tariffs: list[dict[str, Any]] | None,
    now: datetime,
) -> Any:
    """Una función `precio(momento) → €/kWh` para las próximas 24 horas.

    Devuelve una que siempre da ``None`` cuando no se puede saber: sin tarifa
    «la mía» elegida no hay un precio que sea *el tuyo*, y planificar con el de
    otra tarifa sería aconsejar sobre una factura que no es la que pagas.

    Con PVPC se bajan los precios de hoy y mañana de una vez —una petición, con
    caché en disco— en vez de por hora. Los de mañana no se publican hasta la
    tarde: si faltan, esas horas salen `None` y el plan se queda en las que hay.
    """
    my_id = settings.get("my_tariff_id") or ""
    tariff = next((t for t in tariffs or [] if t.get("id") == my_id), None)
    if not tariff:
        return lambda _momento: None
    festivos = set(settings.get("holidays") or [])
    precios_pvpc: dict[str, float] | None = None
    if tariff["energy"]["type"] == "pvpc":
        try:
            precios_pvpc = await pvpc.get_prices(
                now, now + timedelta(hours=int(planner.HORIZONTE_H) + 1), now.tzinfo
            )
        except Exception:  # noqa: BLE001 - sin PVPC el plan sale sin euros
            _LOGGER.info("Sin precios PVPC para el plan del día", exc_info=True)
            return lambda _momento: None

    def precio(momento: datetime) -> float | None:
        valor, _nombre = billing.price_now(tariff, momento, festivos, precios_pvpc)
        return valor

    return precio


def _precio_tras_ventana(
    settings: dict[str, Any],
    tariffs: list[dict[str, Any]] | None,
    window: dict[str, Any] | None,
    now: datetime,
) -> float | None:
    """€/kWh de la parte que **no** cabe en la ventana.

    Es el precio del momento en que se empieza a pagar: al cerrarse la ventana, o
    ahora mismo si ya está cerrada. La maqueta usaba una constante de punta; con
    la tarifa de verdad, la hora manda. ``None`` sin tarifa «la mía»: antes que
    estimar el euro que decide si pones la lavadora, no se da.
    """
    my_id = settings.get("my_tariff_id") or ""
    tariff = next((t for t in tariffs or [] if t.get("id") == my_id), None)
    if not tariff or tariff["energy"]["type"] == "pvpc":
        # El PVPC de las horas que quedan puede no estar publicado, y pedirlo aquí
        # costaría una petición de red en cada /api/live.
        return None
    hoy = (window or {}).get("today") or {}
    momento = now
    if hoy.get("end"):
        momento = max(now, datetime.fromisoformat(hoy["end"]))
    precio, _nombre = billing.price_now(
        tariff, momento, set(settings.get("holidays") or []), None
    )
    return precio


async def flow_day(
    settings: dict[str, Any],
    now: datetime,
    tariffs: list[dict[str, Any]] | None = None,
    appliance_list: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Payload de /api/flowday: el día entero listo para recorrerlo.

    El diseño del flujo v2 deja arrastrar la hora y reproducir el día completo.
    Su prototipo lo simula con fórmulas; aquí va con lo medido, que es lo que el
    propio diseño pide para producción: «solo cambia el origen de pv, house y
    soc». Por eso el reparto de flujos se hace con la misma función que la
    tarjeta de «Ahora mismo» —``series.power_flows``— muestra a muestra.

    Columnar y no una lista de objetos: son 288 muestras y repetir doce nombres
    de clave en cada una multiplicaba por tres el tamaño de la respuesta.

    El precio de cada hora sale de la tarifa marcada como «la mía». Sin ella no
    hay coste que dar, y se devuelve ``null`` en vez de una cifra inventada.
    """
    tz = now.tzinfo
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    states = await fetch_states(settings)
    # Los electrodomésticos van en la misma consulta que las seis potencias: su
    # curva es la que permite partir la casa por dentro en el diagrama detallado.
    aparatos = [a for a in (appliance_list or []) if a.get("power_entity")]
    curvas = await series_mod.flow_curves(
        settings, states, start, end, tz,
        extra={f"ap:{a['id']}": a["power_entity"] for a in aparatos},
    )

    x = curvas["x"]
    power = curvas["power"]
    columna = lambda clave: power.get(clave) or [None] * len(x)  # noqa: E731
    pv_c, home_c = columna("pv"), columna("home")
    bc_c, bd_c = columna("battery_charge"), columna("battery_discharge")
    gi_c, ge_c = columna("grid_import"), columna("grid_export")

    claves = ("solar_home", "solar_grid", "solar_battery",
              "grid_home", "grid_battery", "battery_home")
    flujos: dict[str, list[float | None]] = {k: [] for k in claves}
    pv_out: list[float | None] = []
    casa_out: list[float | None] = []
    # Índice de la última muestra con algo medido: es «ahora» para el diagrama, y
    # con él el frontend abre en el presente sin tener que adivinar dónde acaba
    # el día. Buscarlo aquí evita mandar 288 muestras vacías de la noche futura.
    ultima = -1
    for i in range(len(x)):
        muestra = {
            "pv": pv_c[i], "home": home_c[i],
            "battery_charge": bc_c[i], "battery_discharge": bd_c[i],
            "grid_import": gi_c[i], "grid_export": ge_c[i],
        }
        if all(v is None for v in muestra.values()):
            for k in claves:
                flujos[k].append(None)
            pv_out.append(None)
            casa_out.append(None)
            continue
        ultima = i
        reparto = series_mod.power_flows({k: v or 0.0 for k, v in muestra.items()})
        for k in claves:
            flujos[k].append(round(reparto[k], 1))
        pv_out.append(round(muestra["pv"] or 0.0, 1))
        casa = muestra["home"]
        if casa is None:
            casa = reparto["solar_home"] + reparto["grid_home"] + reparto["battery_home"]
        casa_out.append(round(casa, 1))

    # Precio por muestra. Se resuelve una vez por hora —dentro de la hora no
    # cambia en ninguna tarifa— y se reparte a las doce muestras.
    my_id = settings.get("my_tariff_id") or ""
    tariff = next((t for t in tariffs or [] if t.get("id") == my_id), None)
    precio: list[float | None] = [None] * len(x)
    excedente: list[float | None] = [None] * len(x)
    nombre = None
    if tariff:
        nombre = tariff.get("name")
        holidays = set(settings.get("holidays") or [])
        pvpc_prices = None
        if tariff["energy"]["type"] == "pvpc":
            try:
                pvpc_prices = await pvpc.get_prices(start, end, tz)
            except Exception:  # noqa: BLE001 - sin precios se queda sin coste
                _LOGGER.warning("Sin precios PVPC para el flujo del día", exc_info=True)
        por_hora: dict[int, tuple[float | None, float | None]] = {}
        for i, iso in enumerate(x):
            moment = datetime.fromisoformat(iso)
            if moment.hour not in por_hora:
                p, _n = billing.price_now(tariff, moment, holidays, pvpc_prices)
                por_hora[moment.hour] = (p, billing.surplus_price_now(tariff, moment, holidays))
            precio[i], excedente[i] = por_hora[moment.hour]

    return {
        "date": start.date().isoformat(),
        "step_min": 5,
        "x": x,
        "now": ultima,
        "pv": pv_out,
        "house": casa_out,
        "soc": [None if v is None else round(v, 1) for v in curvas["soc"]]
        if curvas["soc"] else None,
        "flows": flujos,
        "price": precio,
        "surplus_price": excedente,
        "tariff_name": nombre,
        # La casa por dentro: una curva por electrodoméstico medido. El diagrama
        # detallado parte con ellas el nodo de la casa, y lo que no cubre ninguno
        # se queda como «resto de la casa».
        "appliances": [
            {"id": a["id"], "name": a["name"], "color": a["color"], "icon": a["icon"],
             "watts": [None if v is None else round(v, 1)
                       for v in (power.get(f"ap:{a['id']}") or [None] * len(x))]}
            for a in aparatos
        ],
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


# ---------------------------------------------------------------------------
# Estado de las casillas de sensor, para Ajustes
# ---------------------------------------------------------------------------
# La pantalla de sensores del diseño no enseña desplegables sino filas: qué
# entidad tiene cada casilla, cuánto marca ahora mismo y si responde. Y para la
# que está vacía, un puñado de candidatos en vez de una lista de trescientos.
#
# Se agrupan por función —lo que significan— y no por tipo de magnitud, que es
# como están guardados: quien configura piensa «la batería», no «los sensores de
# potencia».
SENSOR_GROUPS: list[dict[str, Any]] = [
    {"key": "solar", "name": "Producción solar", "icon": "solar", "rows": [
        ("flow", "pv", "Potencia instantánea", "power", ("pv", "solar", "fotovolt", "inverter")),
        ("energy", "pv_energy", "Energía del día", "energy", ("pv", "solar", "fotovolt")),
    ]},
    {"key": "battery", "name": "Batería", "icon": "bateria", "rows": [
        ("flow", "battery_soc", "Estado de carga", "percent", ("soc", "bateria", "battery")),
        ("flow", "battery_charge", "Potencia de carga", "power", ("charg", "carga", "bateria", "battery")),
        ("flow", "battery_discharge", "Potencia de descarga", "power", ("discharg", "descarga", "bateria", "battery")),
        ("energy", "battery_charge_energy", "Energía cargada", "energy", ("charg", "carga", "bateria", "battery")),
        ("energy", "battery_discharge_energy", "Energía descargada", "energy", ("discharg", "descarga", "bateria", "battery")),
    ]},
    {"key": "grid", "name": "Red", "icon": "red", "rows": [
        ("flow", "grid_import", "Importada", "power", ("import", "compra", "grid", "red")),
        ("flow", "grid_export", "Exportada", "power", ("export", "vertid", "grid", "red")),
        ("energy", "grid_import_energy", "Energía importada", "energy", ("import", "compra", "grid", "red")),
        ("energy", "grid_export_energy", "Energía exportada", "energy", ("export", "vertid", "grid", "red")),
    ]},
    {"key": "home", "name": "Casa", "icon": "casa", "rows": [
        ("flow", "home", "Consumo instantáneo", "power", ("casa", "home", "load", "consum")),
        ("energy", "home_energy", "Consumo del día", "energy", ("casa", "home", "load", "consum")),
    ]},
]
# Casillas sin las que la app funciona: no cuentan como pendientes ni tiñen su
# fila. Cada una dice por qué es opcional, y no todas lo son por lo mismo —el
# consumo de la casa se deduce del balance, el estado de carga **no se deduce de
# nada**—. Decirlo importa: con el texto genérico «se deduce del balance» en
# todas, la casilla del estado de carga parecía resuelta y no había motivo para
# tocarla, cuando en realidad sin ella falta su gráfico.
OPTIONAL_SLOTS = {"home", "home_energy", "battery_soc"}
OPTIONAL_NOTES = {
    "home": "Opcional · se deduce del balance",
    "home_energy": "Opcional · se deduce del balance",
    "battery_soc": "Opcional · sin él no hay gráfico de carga",
}


def _slot_state(
    entity: str, states: dict[str, Any], kind: str
) -> tuple[bool, float | None, str]:
    """(responde, valor, unidad) de la entidad de una casilla."""
    state = states.get(entity)
    if not state:
        return False, None, ""
    raw = state.get("state")
    if raw in (None, "", "unknown", "unavailable"):
        return False, None, ""
    unit = (state.get("attributes") or {}).get("unit_of_measurement") or ""
    return True, _num(raw), unit


def sensor_status(
    settings: dict[str, Any], states: dict[str, Any]
) -> dict[str, Any]:
    """Cada casilla de sensor con su entidad, su valor de ahora y su estado."""
    cfg = {"flow": settings.get("flow_sensors") or {},
           "energy": settings.get("energy_sensors") or {}}
    catalogo = list_entities(states)

    def sugerencias(kind: str, pistas: tuple[str, ...], usados: set[str]) -> list[dict[str, str]]:
        """Candidatos para una casilla vacía: del tipo correcto y con el nombre
        a favor, sin repetir los que ya están puestos en otra casilla."""
        out = []
        for item in catalogo.get(kind, []):
            if item["entity_id"] in usados:
                continue
            texto = f"{item['entity_id']} {item['name']}".lower()
            if any(p in texto for p in pistas):
                out.append(item)
        return out[:5]

    usados = {v for grupo in cfg.values() for v in grupo.values() if v}
    grupos, total, asignados = [], 0, 0
    for grupo in SENSOR_GROUPS:
        filas = []
        for donde, slot, label, kind, pistas in grupo["rows"]:
            entity = (cfg[donde].get(slot) or "").strip()
            opcional = slot in OPTIONAL_SLOTS
            total += 1
            responde, valor, unidad = (False, None, "")
            if entity:
                asignados += 1
                # Un medidor bidireccional puede ir en las dos casillas, y una
                # casilla admite varias entidades separadas por comas.
                primera = entity.split(",")[0].strip()
                responde, valor, unidad = _slot_state(primera, states, kind)
            fila = {
                "slot": slot, "group": donde, "label": label, "kind": kind,
                "entity": entity, "optional": opcional,
                "note": OPTIONAL_NOTES.get(slot, ""),
                "responds": responde, "value": valor, "unit": unidad,
                "suggestions": [] if entity else sugerencias(kind, pistas, usados),
            }
            if donde == "energy":
                # Qué mide este contador, y si es suyo o heredado del ajuste
                # general. Lo segundo importa para la interfaz: no es lo mismo
                # «lo has puesto tú» que «te ha tocado por defecto».
                propio = (settings.get("energy_counter_kinds") or {}).get(slot)
                fila["counter"] = modo_contador(settings, slot)
                fila["counter_own"] = propio in MODOS_CONTADOR
            filas.append(fila)
        grupos.append({"key": grupo["key"], "name": grupo["name"],
                       "icon": grupo["icon"], "rows": filas})
    # Los que faltan y no son opcionales: es lo que decide si la configuración
    # está completa o a medias.
    pendientes = [
        f["slot"] for g in grupos for f in g["rows"]
        if not f["entity"] and not f["optional"]
    ]
    caidos = [f["slot"] for g in grupos for f in g["rows"]
              if f["entity"] and not f["responds"]]
    return {
        "groups": grupos,
        "total": total,
        "assigned": asignados,
        "missing": pendientes,
        "down": caidos,
    }

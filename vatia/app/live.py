"""Estado en vivo desde Home Assistant para la pantalla Home.

Reúne en una sola llamada: potencias instantáneas y flujos entre solar, red,
batería y casa; el resumen de energía del día (generación y consumo de la casa
por fuente); la meteorología (condición y temperatura exterior) y el momento
del día, para el fondo dinámico.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta
from typing import Any

import aiohttp

import appliances as appliances_mod
import optimo
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
# Partes medidas de otro contador (la carga que puso el sol, lo vertido que
# puso el sol). Se piden y se reparten con los demás, pero no cuentan en el
# balance ni tienen sensor de potencia del que deducirlas.
ENERGY_PARTES = series_mod.ENERGY_PARTES
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
    sin_explicar = flows.get("unexplained") or 0.0

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
                    # Energía que el contador de la casa dice haber consumido y
                    # que ningún origen entregó. Solo aparece si es de verdad
                    # (50 Wh); por debajo es la deriva normal entre contadores y
                    # una fila más sería ruido.
                    *([("unexplained", "Sin explicar", sin_explicar)]
                      if sin_explicar >= 50.0 else []),
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
    por_hora: dict[str, dict[str, float]] | None,
) -> dict[str, float] | None:
    """Suma el reparto de cada hora (Wh).

    Hacer el reparto una sola vez sobre el total del día pierde la correlación
    temporal: si la batería se carga de la red de madrugada y hay sol al
    mediodía, sobre los totales esa carga parece solar. Repartir por intervalos
    las separa; el reparto lo hace `series.reparto_por_horas` y esto solo lo suma, para que
    el detalle por horas se pueda usar también en otro sitio —atribuirle un origen
    a un aparato continuo— sin repetir la cuenta.
    """
    if por_hora is None:
        return None
    keys = ("to_home", "to_battery", "to_grid", "from_solar", "from_battery",
            "from_grid", "home_total", "grid_to_battery", "battery_to_grid")
    acc = dict.fromkeys(keys, 0.0)
    for split in por_hora.values():
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
    ids = [energy_cfg.get(k) for k in ENERGY_KEYS + ENERGY_PARTES
           if energy_cfg.get(k)]
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
                  "buckets": _daily_cache["value"].get("buckets") or {},
                  # El reparto hora a hora también: se guarda, y al servir de la
                  # caché se quedaba fuera. Dos minutos después de arrancar, la fila
                  # de la nevera desaparecía de la tarjeta —un continuo sin reparto
                  # no se publica, y con razón— y volvía sola al caducar la caché.
                  # Con la aplicación recién levantada no se veía nunca.
                  "flows_by_hour": _daily_cache["value"].get("flows_by_hour") or {}}
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
    for key in ENERGY_KEYS + ENERGY_PARTES:
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
    # Las partes solo van al reparto: en `out` descuadrarían el balance del
    # diagnóstico, porque su energía ya está contada en el total del que son
    # parte.
    for key in ENERGY_PARTES:
        for iso, value in (by_key.get(key) or {}).items():
            per_bucket.setdefault(iso, {})[key] = value
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

    # Una parte solo se usa si de verdad tiene datos: con ceros mentiría
    # diciendo «el sol no puso nada de esa carga».
    partes = tuple(
        any(v.get(k) for v in per_bucket.values()) for k in ENERGY_PARTES
    )
    # El reparto hora a hora, que sale de aquí porque este es el sitio que sabe si
    # el consumo está medido y qué partes tienen datos. Se usa dos veces: sumado,
    # para el resumen del día; y por horas, para atribuirle un origen a lo que ha
    # gastado un aparato continuo.
    por_hora = series_mod.reparto_por_horas(
        per_bucket, out.get("home_energy") is not None, partes
    )
    flows = _accumulate_flows(por_hora)
    # Los buckets salen fuera para poder cruzarlos con la ventana en el cierre
    # del día: ya están descargados, así que no cuesta ninguna petición extra.
    value = {"totals": out, "flows": flows, "sources": sources,
             "buckets": per_bucket, "flows_by_hour": por_hora}
    _daily_cache.update({"key": cache_key, "at": time.monotonic(),
                         "value": {"totals": dict(out), "flows": flows,
                                   "power": dict(power_totals),
                                   "sources": dict(sources),
                                   "buckets": per_bucket,
                                   "flows_by_hour": por_hora}})
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
                 origen: str, dias: int, error: dict[str, Any] | None = None):
        self._por_hora = por_hora
        self.plano = plano
        self.origen = origen          # «influxdb» o «recorder»
        self.dias = dias
        # Cuánto se equivoca, medido contra un día que no vio al construirse. Ver
        # `_desviacion_de`. `None` cuando no hay histórico para dejar un día fuera.
        self.error = error
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
            # Lo que le falta a todo lo demás de esta ficha: **cuánto se equivoca**.
            # La previsión solar aprende su sesgo y publica su desvío del día; el
            # perfil decía de dónde sale y cómo es, y nada de cuánto acierta, así que
            # no había forma de saber cuánto fiarse de la ventana que sale de él.
            "error": self.error,
        }


def _cubos_de(muestras: list[tuple[datetime, float]]
              ) -> tuple[dict[tuple[bool, int], float], float]:
    """La mediana por (tipo de día, hora) y la mediana de todo, de unas muestras."""
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
    return por_hora, (todas[len(todas) // 2] if todas else 0.0)


def _desviacion_de(
    muestras: list[tuple[datetime, float]], origen: str, dias: int
) -> dict[str, Any] | None:
    """Cuánto se equivoca el perfil, medido **contra un día que no ha visto**.

    Es la idea que sí valía del forecaster de EMHASS: no el modelo —sus variables de
    calendario ya las tiene este perfil, y a 24 h un modelo recursivo acumula error
    donde una mediana no acumula nada— sino **el número que reporta**. Un perfil que
    dice de dónde sale y cómo es, pero no cuánto acierta, no deja saber cuánto fiarse
    de la ventana que se calcula con él.

    Y se mide fuera de muestra, que es la única forma de que el número signifique
    algo: se aparta el último día completo del histórico, se construye el perfil con
    lo demás y se compara contra el día apartado. Medirlo contra los mismos datos con
    que se construyó daría un error bonito y falso — la mediana pasa por medio de sus
    propios puntos por definición.

    Se publica el **error absoluto medio** en vatios y como porcentaje del consumo
    medio de ese día. No el porcentaje del error de cada punto: a las cuatro de la
    mañana la casa gasta 90 W y equivocarse en 45 es un 50 % que no significa nada.
    """
    if not muestras:
        return None
    dias_vistos = sorted({m.date() for m, _w in muestras})
    if len(dias_vistos) < 3:
        # Con dos días, el «día apartado» es la mitad del histórico y el perfil que
        # queda no es el que se usa. Mejor no dar el número.
        return None
    fuera = dias_vistos[-1]
    entrenamiento = [(m, w) for m, w in muestras if m.date() != fuera]
    prueba = [(m, w) for m, w in muestras if m.date() == fuera]
    if len(entrenamiento) < _MIN_MUESTRAS_TOTAL or not prueba:
        return None
    por_hora, plano = _cubos_de(entrenamiento)
    reducido = HouseProfile(por_hora, plano, origen, dias)
    errores = [abs(max(w, 0.0) - reducido.at(m)) for m, w in prueba]
    real = [max(w, 0.0) for _m, w in prueba]
    medio = sum(real) / len(real)
    mae = sum(errores) / len(errores)
    return {
        "mae_w": round(mae, 1),
        # Sobre el consumo medio del día, no punto a punto: ver arriba.
        "mae_pct": round(mae / medio * 100) if medio > 0 else None,
        "day": fuera.isoformat(),
        "hours": len(prueba),
        "mean_w": round(medio, 1),
    }


def _perfil_de(muestras: list[tuple[datetime, float]], origen: str, dias: int
               ) -> HouseProfile | None:
    """Agrupa las muestras horarias en un perfil por (tipo de día, hora)."""
    if len(muestras) < _MIN_MUESTRAS_TOTAL:
        return None
    por_hora, plano = _cubos_de(muestras)
    return HouseProfile(por_hora, plano, origen, dias,
                        _desviacion_de(muestras, origen, dias))


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


def _pares_de_hoy(
    puntos: list[tuple[datetime, float]],
    buckets: dict[str, dict[str, float]] | None,
    now: datetime,
) -> tuple[dict[int, float], dict[int, float]]:
    """Lo previsto y lo producido en las horas de hoy que ya han cerrado, en Wh.

    Solo horas **cerradas**: la que está en curso va a medias y daría un cociente
    bajo siempre, a cualquier hora del día.

    Sirve para dos cosas distintas y hay que pasarle la curva que toca en cada
    una. Para **aprender el sesgo** del tejado va la curva tal y como la da el
    sensor. Para **medir el desvío de hoy** va la curva ya corregida con el sesgo,
    porque lo que se quiere saber es cuánto se aparta hoy de lo que este tejado da
    normalmente, no de lo que prometió quien todavía no lo conocía.
    """
    previsto = {
        h: wh for h, wh in prevision.por_horas(
            [(t, w) for t, w in puntos if t.date() == now.date()]
        ).items() if h < now.hour
    }
    real: dict[int, float] = {}
    for iso, valores in (buckets or {}).items():
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
    return previsto, real


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
    """
    if not buckets:
        return
    if (_anotado["dia"] == now.date()
            and time.monotonic() - _anotado["at"] < _ANOTAR_CADA):
        return
    previsto, real = _pares_de_hoy(puntos, buckets, now)
    if not previsto or not real:
        return
    prevision.registrar(storage.CONFIG_DIR, now.date(), previsto, real)
    _anotado.update({"dia": now.date(), "at": time.monotonic()})


def reserva_pct(settings: dict[str, Any], states: dict[str, Any]) -> float:
    """La reserva del inversor, en % de carga. 0 si no se sabe.

    Manda el sensor si está asignado —así sigue solo cuando se cambia el mínimo en
    el inversor— y si no, el número de Ajustes. Se recorta a [0, 95]: una reserva
    del 100 % sería una batería que no se puede usar, y eso es un dato mal puesto,
    no una configuración.
    """
    entidad = (settings.get("flow_sensors") or {}).get("battery_reserve_soc") or ""
    del_sensor = _num((states.get(entidad) or {}).get("state")) if entidad else None
    valor = del_sensor if del_sensor is not None else settings.get("battery_reserve_pct")
    return max(0.0, min(float(valor or 0.0), 95.0))


def bateria_usable(
    settings: dict[str, Any], states: dict[str, Any], soc: float | None
) -> tuple[float | None, float]:
    """Lo que la batería puede dar **de verdad** ahora, en kWh, y su reserva en %.

    Existe por una queja con tres capturas: la tarjeta decía «A/C · Gratis» y dos
    líneas más arriba, ella misma, «1,1 kWh de batería» — con la batería al 21 % y
    el inversor sin descargar por debajo del 20 %. Esos 1,1 kWh no existían.

    La cuenta de antes era ``capacidad × soc / 100``: la batería entera, como si el
    inversor la fuera a vaciar hasta cero. Ninguno lo hace. Lo utilizable es lo que
    hay **por encima de la reserva**, y cuando el estado de carga está en la
    reserva —o por debajo— la respuesta correcta es **cero**, no «poca».

    Devuelve ``(None, reserva)`` cuando no se puede saber: sin capacidad tecleada o
    sin sensor de carga no hay manera, y entonces quien lo use no puede separar la
    batería de la red y tiene que decirlo así.
    """
    reserva = reserva_pct(settings, states)
    capacidad = float(settings.get("battery_kwh") or 0.0)
    if capacidad <= 0 or soc is None:
        return None, reserva
    encima = max(0.0, min(float(soc), 100.0) - reserva)
    return capacidad * encima / 100.0, reserva


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


def lo_medido(
    buckets: dict[str, dict[str, float]] | None,
    power: dict[str, float],
    casa_w: float,
    now: datetime,
) -> dict[str, Any]:
    """Lo que de verdad ha hecho el día hasta ahora: sol y casa, en W.

    De una pregunta que hacía falta: *«¿no debería la forma de hoy representar la
    realidad hasta el momento actual y la previsión desde el momento actual, a pesar
    de que el pasado ya ha pasado y lo conocemos?»*. Pues sí. La tarjeta dibujaba
    **previsión las veinticuatro horas**, también las que ya habían pasado y de las
    que hay medida — que es la misma clase de error que enseñar un cociente donde
    hay un contador.

    Dos resoluciones, y las dos son las que hay:

      · **las horas cerradas**, de los `buckets` que la Home ya se ha descargado.
        Vienen en tramos de **cinco minutos** —así los pide `daily_energy`— y hay
        que **sumarlos** dentro de su hora: quedándose con el último de cada hora, la
        cifra sale doce veces más pequeña y la mañana se dibuja plana. Sumados, los
        Wh de la hora son su potencia media, que va colocada en el **centro** de la
        hora porque es donde vive una media;
      · **este instante**, de los sensores de potencia. Sirve para que la curva
        acabe exactamente donde el diagrama del caudal dice que está la casa: dos
        dibujos de la misma pantalla no pueden discrepar sobre *ahora*.

    La hora en curso no tiene bucket cerrado, así que entre la última hora medida y
    ahora la curva simplemente une los dos puntos. No se inventa nada en medio.
    """
    sol: dict[int, float] = {}
    casa: dict[int, float] = {}
    for iso, valores in (buckets or {}).items():
        try:
            momento = datetime.fromisoformat(iso)
        except ValueError:
            continue
        if momento.date() != now.date() or momento.hour >= now.hour:
            continue
        pv = valores.get("pv_energy")
        if pv is not None:
            sol[momento.hour] = sol.get(momento.hour, 0.0) + max(pv, 0.0) * 1000.0
        de_la_casa = _bucket_home_kwh(valores)
        if de_la_casa is not None:
            casa[momento.hour] = (
                casa.get(momento.hour, 0.0) + max(de_la_casa, 0.0) * 1000.0
            )
    return {
        "sol": sol,
        "casa": casa,
        "ahora": (max(power.get("pv") or 0.0, 0.0), max(casa_w, 0.0)),
        "at": now,
    }


def curva_solar(
    settings: dict[str, Any],
    states: dict[str, Any],
    power: dict[str, float],
    buckets: dict[str, dict[str, float]] | None,
    tz,
    now: datetime,
    casa_w: float = 0.0,
) -> dict[str, Any] | None:
    """La curva de sol de la que salen **todas** las respuestas del día.

    Existe por una queja, y la queja tenía razón: la ventana calculaba el sol con
    la previsión corregida solo con el sesgo del tejado, y el plan con esa misma
    previsión corregida además con la producción de este momento. Dos curvas
    distintas en la misma pantalla, así que la ventana prometía «gratis desde las
    10:06» mientras el plan, mirando el tejado, ya sabía que no. *«Parecen estar
    trabajando sobre dos modelos diferentes»* — eran dos, literalmente.

    Ahora hay una, y las dos correcciones se aplican aquí en este orden:

    1. **El sesgo del tejado**, aprendido de los días anteriores: la sombra de la
       chimenea a las nueve, los paneles sin limpiar. Es sistemático.
    2. **El desvío de hoy**, medido en el tejado: cuánto se aparta hoy de esa
       curva. Va después, porque medirlo contra la curva sin corregir contaría el
       sesgo dos veces. Ojo con el nombre: la previsión de Solcast ya lleva la
       meteorología dentro, así que este número **no es nubosidad** — es el residuo,
       y su causa (suciedad, una sombra, el inversor recortando, la previsión
       fallando) no se puede saber desde aquí y no se nombra.

    El desvío de hoy se aplica **solo a hoy**. Lo que hoy se desvíe no dice nada de
    mañana, y de mañana ya opina la previsión.

    ``None`` cuando no hay previsión solar: sin ella no hay curva, y las dos
    tarjetas que dependen de esto desaparecen en vez de inventarse una hora.
    """
    puntos = series_mod.forecast_power(
        series_mod._forecast_states(settings, states), tz
    )
    if not puntos:
        return None
    # Aprender el sesgo va con la curva **cruda**: es la diferencia entre lo que
    # promete el sensor y lo que da este tejado, y midiéndola contra la curva ya
    # corregida saldría siempre 1.
    _anotar_prevision(puntos, buckets, now)
    sesgo = _sesgo_tejado()
    puntos = sesgo.aplicar(puntos)

    previsto, real = _pares_de_hoy(puntos, buckets, now)
    previsto_ahora = series_mod.forecast_at(puntos, now)
    desvio = prevision.factor_hoy(
        previsto, real,
        (previsto_ahora, max(power.get("pv") or 0.0, 0.0))
        if previsto_ahora else None,
    )
    factor = (desvio or {}).get("factor") or 1.0
    if factor != 1.0:
        puntos = [
            (t, w * factor if t.date() == now.date() else w) for t, w in puntos
        ]
    return {
        "points": puntos,
        "bias": sesgo.payload(),
        "roof_today": desvio,
        # Y lo que ya ha pasado, medido. La curva de previsión sigue entera —el plan
        # simula horas futuras y la necesita— y esto se usa solo para **dibujar** el
        # día: hasta ahora, lo que fue; desde ahora, lo que se espera.
        "medido": lo_medido(buckets, power, casa_w, now),
    }


# Por debajo de esto la hora se da a secas: la previsión llega cada media hora o cada
# hora, así que anunciar «±3 min» sería precisión inventada por el otro lado.
_HOLGURA_MINIMA_MIN = 5


def _holgura_de(
    perfil: "HouseProfile", ventana: dict[str, Any], cuando: str, borde: str
) -> int | None:
    """Cuánto puede moverse la hora de un corte de la ventana, en minutos.

    Es el paso que le faltaba al error del perfil para servir de algo. El perfil ya
    medía cuánto se equivoca —`_desviacion_de`, fuera de muestra— y ese número vivía
    en la letra pequeña de Ajustes, en vatios. Pero la ventana no habla de vatios,
    habla de **horas**: «tu ventana abre a las 11:40». Un error de 300 W no dice nada
    sobre las 11:40 hasta que se divide por la pendiente con la que la curva del sol
    cruza el umbral en ese punto:

        minutos = error del umbral (W) / pendiente del cruce (W/h) × 60

    Y el resultado cambia muchísimo de un día a otro, que es la razón de hacerlo. Una
    mañana clara cruza subiendo 3.000 W/h y 300 W de error son **seis minutos** —cinco
    al redondear—: la hora es fina y se puede decir sin más. Un día de nubes en el que
    la curva apenas roza el umbral cruza a 200 W/h, y los mismos 300 W son **hora y
    media**. La tarjeta decía las dos con el mismo aplomo.

    ``None`` cuando no se puede saber, y entonces no se dice nada:

    · sin histórico para apartar un día no hay error medido (`perfil.error`);
    · un extremo que no es un cruce sino el borde de la previsión no tiene pendiente;
    · y una pendiente de cero daría holgura infinita, que no es una cifra.

    Lo que esta cifra **no** incluye, y conviene tener claro: el error del sol. La
    previsión solar tiene el suyo —para eso están el sesgo del tejado y el desvío del
    día— y no se publica como una desviación que se pueda sumar aquí. Así que esto es
    la parte de la duda que pone **el consumo de la casa**, no toda la duda.

    Y de ahí que solo se calcule para **hoy**, aunque la tarjeta también diga a qué
    hora abre mañana y los tramos de mañana traigan su pendiente igual. A un día de
    distancia el que manda es el error del sol, no el del perfil: poner un «±10 min»
    en la hora de mañana sería enseñar el término pequeño y callar el grande, que es
    peor que no decir nada.
    """
    error = (perfil.error or {}).get("mae_w")
    if not error or not ventana:
        return None
    tramo = next((s for s in ventana.get("spans") or []
                  if s.get(borde) == cuando), None)
    if not tramo:
        return None
    pendiente = tramo.get(f"{borde}_slope_w_h")
    if not pendiente or pendiente <= 0:
        return None
    minutos = float(error) / float(pendiente) * 60.0
    if minutos < _HOLGURA_MINIMA_MIN:
        return None
    # Redondeado a cinco minutos: la cifra es una estimación de una estimación y
    # «±23 min» le daría un aire de exactitud que no tiene.
    return int(round(minutos / 5.0) * 5)


async def free_energy(
    curva: dict[str, Any] | None,
    settings: dict[str, Any],
    states: dict[str, Any],
    tz,
    now: datetime,
) -> dict[str, Any] | None:
    """La ventana de energía gratis de hoy y de mañana, con su estado.

    ``None`` cuando falta con qué calcularla: sin previsión solar no hay ventana
    que enseñar, y es mejor no enseñar nada que inventarse una hora.

    La curva se la dan hecha —ver `curva_solar`— y no la calcula ella: es lo que
    garantiza que esta tarjeta y la del plan hablen del mismo sol.
    """
    if not curva:
        return None
    points = curva["points"]
    perfil = await _house_profile(settings, states, tz, now)
    if perfil is None:
        return None

    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    hueco = _hueco_bateria(settings, states)
    # Solo hoy lleva lo medido: de mañana no hay nada que medir, y el eje de luz
    # es la geometría del día, que no la cambia lo que haya hecho el tejado.
    today = series_mod.free_window(
        points, perfil.at, midnight, hueco, curva.get("medido"), ahora=now
    )
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
    holgura: int | None = None
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
            holgura = _holgura_de(perfil, today, dentro[1].isoformat(), "end")
        elif now >= fin:
            state = "post"
        else:
            state = "pre"
            siguiente = next((a for a, _b in tramos if a > now), tramos[0][0])
            reopens = siguiente.isoformat()
            left_h = sum(
                (b - a).total_seconds() / 3600.0 for a, b in tramos if a >= siguiente
            )
            holgura = _holgura_de(perfil, today, reopens, "start")
    return {
        # Se conserva `baseline_w` —la cifra plana— porque es lo que se enseña
        # como «consumo típico»; el perfil va aparte, con su procedencia.
        "baseline_w": round(perfil.plano, 1),
        "profile": perfil.payload(),
        "today": today,
        "tomorrow": tomorrow,
        # **Si de mañana se sabe algo o no**, que no es lo mismo que si sobra.
        # `tomorrow` en nulo tenía dos causas —la previsión no llega a mañana, o
        # llega y no sobra— y la tarjeta las decía igual: «mañana no se espera
        # excedente». Con un sensor de Solcast que solo publica hoy, eso salía
        # todos los días, afirmando sobre un día del que no había ni un dato.
        "tomorrow_forecast": any(
            midnight + timedelta(days=1) <= t < midnight + timedelta(days=2)
            for t, _w in points
        ),
        "daylight": daylight,
        "state": state,
        "hours_left": round(left_h, 3),
        # Cuándo vuelve a haber excedente, si estamos en un hueco de la ventana.
        "reopens_at": reopens,
        # Cuánto puede moverse **la hora que la tarjeta va a decir**. Ver
        # `_holgura_de`: es el error del consumo típico traducido a minutos por la
        # pendiente del corte. `null` cuando no se puede saber, y entonces la
        # tarjeta da la hora a secas como hasta ahora.
        "slack_min": holgura,
        # Con qué se ha contado la batería, para poder decirlo en la tarjeta en
        # vez de restar en silencio. `null` = no se ha descontado nada.
        "battery_room_kwh": None if hueco is None else round(hueco / 1000.0, 2),
        # Y lo que se le ha corregido a la previsión, por lo mismo: una curva
        # que no es la del sensor tiene que decir que no lo es. `bias` es lo que
        # corrige el tejado siempre; `roof_today`, cuánto se desvía hoy de eso.
        "bias": curva["bias"],
        "roof_today": curva["roof_today"],
    }


# La previsión del tiempo se guarda un cuarto de hora. La Home pide `/api/live`
# cada veinte segundos y la previsión horaria no cambia en ese rato: pedirla en
# cada refresco sería abrir un websocket a Home Assistant tres veces por minuto
# para releer lo mismo.
_tiempo_cache: dict[str, Any] = {"key": None, "at": 0.0, "value": None}
_TIEMPO_TTL = 900.0


async def weather_hours(
    settings: dict[str, Any],
    curva: dict[str, Any] | None,
    now: datetime,
) -> dict[str, Any] | None:
    """El tiempo hora a hora de **las horas de sol que quedan hoy**.

    Ni el día entero ni las próximas veinticuatro: en una aplicación de energía
    las once de la noche no cambian ninguna decisión, y las horas que ya pasaron
    tampoco. El corte de arriba sale de la propia curva del sol —la última hora en
    la que la previsión da algo— y no de la puesta de sol de `sun.sun`, para que la
    tarjeta acabe donde acaba lo que se puede aprovechar.

    Cada hora lleva lo que dice el tiempo y lo que eso significa para el tejado: la
    nubosidad al lado del sol previsto para esa hora, sacado de la misma curva que
    la ventana y el plan. Es lo que convierte «40 % de nubes» en algo sobre lo que
    decidir.

    ``None`` cuando no se puede saber: sin entidad configurada, sin previsión del
    tiempo, o de noche —cuando ya no quedan horas de sol—. La tarjeta desaparece
    en vez de enseñar una fila vacía.
    """
    entidad = settings.get("weather_entity") or ""
    if not entidad or not curva:
        return None

    # Hasta dónde llega el día: la última hora de hoy con algo de sol previsto.
    # Da igual el desvío de hoy: lo que se busca es la geometría del día —a qué
    # hora se pone el sol— y esa no la mueve lo que el tejado esté rindiendo.
    del_dia = [(t, w) for t, w in curva["points"] if t.date() == now.date()]
    con_sol = [t for t, w in del_dia if w > 0]
    if not con_sol:
        return None
    ultima = max(con_sol)
    if now >= ultima:
        return None

    ahora_key = (entidad, now.date().isoformat(), now.hour)
    if (_tiempo_cache["key"] != ahora_key
            or time.monotonic() - _tiempo_cache["at"] >= _TIEMPO_TTL):
        try:
            filas = await datasources.ha_weather_hourly(settings, entidad)
        except (datasources.SourceError, aiohttp.ClientError,
                asyncio.TimeoutError) as err:
            _LOGGER.info("Sin previsión del tiempo de «%s»: %s", entidad, err)
            filas = None
        if filas is not None:
            _tiempo_cache.update(
                {"key": ahora_key, "at": time.monotonic(), "value": filas}
            )
    filas = _tiempo_cache["value"] if _tiempo_cache["key"] == ahora_key else None
    if not filas:
        return None

    # La hora en curso cuenta: quedan minutos suyos por delante. Se compara con el
    # comienzo de esta hora y no con `now`, que si no la fila de las 11 desaparece
    # a las 11:01.
    desde = now.replace(minute=0, second=0, microsecond=0)
    horas = []
    for fila in filas:
        momento = series_mod._parse_dt(fila.get("datetime"), now.tzinfo)
        if momento is None or not (desde <= momento <= ultima):
            continue
        if momento.date() != now.date():
            continue
        sol = series_mod.forecast_at(curva["points"], momento)
        nubes = fila.get("cloud_coverage")
        horas.append({
            "at": momento.isoformat(),
            "condition": fila.get("condition"),
            "temperature": _num(fila.get("temperature")),
            # `cloud_coverage` no lo dan todas las integraciones (AEMET sí,
            # algunas no): `null` significa «no se sabe» y la tarjeta se calla esa
            # columna, en vez de dibujar un cero que se leería como «despejado».
            "cloud_pct": None if nubes is None else round(float(nubes)),
            "sun_w": round(sol, 1),
        })
    if not horas:
        return None
    pico = max(h["sun_w"] for h in horas)
    return {
        "entity": entidad,
        "hours": horas,
        # El pico de lo que queda, para que la barra de sol de cada fila se pueda
        # dibujar en proporción a algo que está en la propia tarjeta.
        "peak_w": pico,
        "until": ultima.isoformat(),
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
    por_horas: dict[str, dict[str, float]] | None = None,
    precio_at: Any = None,
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
        # El reparto va también aquí para que el «% con sol» de cada fila sea **lo
        # medido** y no el solape con la ventana, que se calcula con el consumo típico
        # y podía decir «100 % con sol» un día en que parte la puso la red.
        "appliances": appliances_mod.del_cierre(
            appliance_list or [], aprendido or {}, window, por_horas
        ),
        # Lo que había sobre la mesa: el mejor orden posible del día que se acaba.
        # Va aquí y no en su propia petición porque **todo lo que necesita ya está
        # en este payload**: el reparto hora a hora del día (`por_horas`), lo que
        # cada aparato ha gastado en cada hora (`today_by_hour`, que `learn` ya
        # publica) y los precios. Ni una consulta más, y solo se calcula después de
        # la puesta de sol, que es cuando esta tarjeta existe — y cuando el sol del
        # día ya no va a cambiar, que es lo que hace que la cuenta sea una medición
        # y no una previsión.
        "best": _lo_que_habia(appliance_list, aprendido, por_horas, precio_at, now),
        "tomorrow": (window or {}).get("tomorrow"),
    }


def _lo_que_habia(
    lista: list[dict[str, Any]] | None,
    aprendido: dict[str, dict[str, Any]] | None,
    por_horas: dict[str, dict[str, float]] | None,
    precio_at: Any,
    now: datetime,
) -> dict[str, Any] | None:
    """Prepara lo que `optimo.del_dia` necesita, con lo que ya hay en el payload.

    Tres traducciones y ninguna consulta:

    · **Solo los movibles.** A una nevera no hay hora que proponerle y a un fijo
      tampoco; lo demás es el suelo contra el que se busca hueco. La forma de uso
      ya está resuelta en `datos["kind"]`, que la pone el bucle de `build`.
    · **De hora del día a hora con fecha.** `today_by_hour` va indexado por la hora
      (0-23) porque solo habla de hoy; `por_horas` va por el ISO de la hora. Aquí se
      llevan las dos al mismo índice, que es lo que `optimo` espera.
    · **El sol de cada hora** sale del propio reparto: `to_home + to_battery +
      to_grid` **es** lo que generó el tejado. Pedirlo aparte sería tener dos cifras
      del mismo tejado.
    """
    if not lista or not aprendido or not por_horas:
        return None
    medianoche = now.replace(hour=0, minute=0, second=0, microsecond=0)
    movibles = [
        a for a in lista
        if (aprendido.get(a["id"]) or {}).get("kind") == "movible"
    ]
    if not movibles:
        return None
    por_aparato: dict[str, dict[str, float]] = {}
    for a in movibles:
        crudo = (aprendido.get(a["id"]) or {}).get("today_by_hour") or {}
        if not crudo:
            continue
        por_aparato[a["id"]] = {
            medianoche.replace(hour=int(h)).isoformat(): kwh
            for h, kwh in crudo.items() if str(h).isdigit()
        }
    solar = {
        iso: (v.get("to_home") or 0.0) + (v.get("to_battery") or 0.0)
             + (v.get("to_grid") or 0.0)
        for iso, v in por_horas.items()
    }
    def precio_de(iso: str) -> float | None:
        if precio_at is None:
            return None
        try:
            return precio_at(datetime.fromisoformat(iso))
        except ValueError:
            return None
    return optimo.del_dia(movibles, medianoche, por_aparato, por_horas, solar,
                          precio_de)


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
    # Una sola curva de sol para todo el payload. Los buckets entran aquí porque
    # es donde se compara lo previsto de hoy con lo producido de verdad: de ahí
    # sale el sesgo del tejado y también el desvío de hoy.
    curva = curva_solar(
        settings, states, power, buckets, now.tzinfo, now, home_power
    )
    # La ventana y el tiempo, a la vez: la ventana espera al perfil de la casa y
    # el tiempo a Home Assistant, y son esperas independientes. En serie, la más
    # lenta se suma a la otra en un endpoint que se pide cada veinte segundos.
    window, tiempo = await asyncio.gather(
        free_energy(curva, settings, states, now.tzinfo, now),
        weather_hours(settings, curva, now),
    )
    # Lo que valen los kWh que quedan por sobrar: aquí, que es donde están las
    # tarifas, y no en la tarjeta. Es lo que convierte «te sobran 2,7 kW» —una
    # potencia media que no es de nadie— en una decisión.
    _valorar_lo_que_queda(window, settings, tariffs, now)
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
    plan = None
    # Estas dos salen del bloque de abajo y las usa además el cierre del día, así
    # que se inicializan aquí: sin aparatos configurados el bloque no corre y el
    # payload entero se caía con un `UnboundLocalError`. Lo cazó la regresión, que
    # levanta instancias sin aparatos; con la fixture que sí los tiene no se veía.
    por_horas: dict[str, dict[str, float]] | None = None
    precio_at = None
    if aparatos:
        aprendido = await appliances_mod.learn(settings, states, aparatos, now.tzinfo, now)
        fuentes = await _fuentes(curva, settings, states, soc, now.tzinfo, now)
        if fuentes is not None:
            fuentes["battery_state"] = appliances_mod.estado_bateria(fuentes)
        precio_at = await _precio_por_hora(settings, tariffs, now)
        # La forma de uso de cada aparato se resuelve **aquí y una sola vez**: la
        # ficha manda sobre lo que la aplicación detecta, y este es el único sitio
        # que puede mirar las dos cosas (`appliances` importa `planner`, así que
        # allí no se puede resolver sin un ciclo de imports).
        #
        # Y a los continuos se les calcula aquí su día, porque la atribución del
        # origen necesita el reparto horario de la casa, que está en este alcance.
        por_horas = daily.get("flows_by_hour")
        precio_de_la_hora = (
            (lambda h: precio_at(
                now.replace(hour=int(h), minute=0, second=0, microsecond=0)))
            if precio_at else None
        )
        vatios = {f["id"]: f.get("watts") for f in ahora_aparatos}
        for a in aparatos:
            datos = aprendido.setdefault(a["id"], {})
            datos["kind"] = appliances_mod.forma(a, datos)
            umbral = float(a.get("standby_w") or 0)
            w = vatios.get(a["id"])
            # **Si está dando ahora mismo**, que es lo que la tarjeta rodea de verde.
            # Es más ancho que «tiene un ciclo abierto»: vale para las tres formas y
            # se sostiene en la lectura de este momento, así que aparece en cuanto el
            # enchufe tira aunque el histórico aún no lo sepa.
            #
            # Un continuo va rodeado **siempre**, y no es una excepción caprichosa:
            # una nevera está en marcha, y su compresor entrando y saliendo cada
            # veinte minutos no es encenderse y apagarse. Hacer parpadear el aro con
            # el ciclo del compresor sería ruido, y de la misma familia que publicar
            # «el ciclo típico de tu nevera son 20 minutos».
            datos["encendido"] = (
                datos["kind"] == "continuo"
                or appliances_mod.en_marcha(datos, w, umbral, now)
                or (w is not None and w > umbral)
            )
            if datos["kind"] == "continuo":
                datos["today_split"] = appliances_mod.atribuir_por_horas(
                    datos.get("today_by_hour"), por_horas, precio_de_la_hora)
                continue
            # Y lo que está en marcha: por dónde va, de dónde ha salido lo que
            # lleva —atribuido, porque ya pasó— y de dónde saldrá lo que le queda,
            # que eso sí se puede simular. Las dos mitades del mismo ciclo con la
            # cuenta que le toca a cada una.
            if not appliances_mod.en_marcha(datos, w, umbral, now):
                continue
            marcha = appliances_mod.progreso(datos.get("open"), datos.get("cycle"), now)
            if not marcha:
                continue
            datos["progress"] = marcha
            datos["running_split"] = appliances_mod.atribuir_por_horas(
                (datos.get("open") or {}).get("by_hour"), por_horas, precio_de_la_hora)
            datos["tail"] = _cola_del_ciclo(marcha, fuentes, now)
        # Una sola tarjeta para los electrodomésticos: de dónde saldría la energía
        # si se pone ahora, lo que costaría, y la hora óptima de los que se pueden
        # mover. Antes eran dos —«Cabe en la ventana» y «El plan de hoy»— con dos
        # simulaciones distintas del mismo instante que llegaban a discrepar en once
        # puntos de «% con sol» para el mismo aparato.
        plan = planner.plan(
            aparatos, aprendido, fuentes, precio_at, now,
            (window or {}).get("tomorrow"),
            # Y **si de mañana se sabe algo**, que no es lo mismo que si sobra. Sin
            # esto, una integración solar que solo publica el día en curso hacía que
            # el plan leyera «mañana no habrá sol» y recomendara comprar de la red
            # energía que al día siguiente iba a llegar gratis.
            bool((window or {}).get("tomorrow_forecast")),
        )
        # Y la etiqueta de cada fila —«Gratis», «De la batería», los euros— se pone
        # aquí, a partir del reparto que trae la propia fila. No es una segunda
        # opinión: es una lectura del mismo número, que es lo que impide que vuelva
        # a pasar lo del «Gratis» con 1,1 kWh de batería debajo.
        precio_ahora = _precio_tras_ventana(settings, tariffs, window, now)
        for fila in (plan or {}).get("rows") or []:
            # Y hay **dos** etiquetas, no una, porque hay dos preguntas: lo que
            # costaría poner un ciclo (una hipótesis, que se simula y en la que la
            # batería sí se cobra porque habrá que reponerla) y lo que ya ha costado
            # lo que está gastado (medido y atribuido hora a hora, donde la batería
            # no se cobra porque se llenó antes). Usar la primera para lo segundo
            # daba siete veces el coste real de una nevera; ver
            # `appliances.etiqueta_de_lo_gastado`.
            #
            # Cada forma de fila trae exactamente uno de los tres repartos, así que
            # no hay ambigüedad: `now` en un movible o un fijo, `today` en un
            # continuo y `so_far` en uno en marcha.
            gastado = fila.get("today") or fila.get("so_far")
            fila["verdict"] = (
                appliances_mod.etiqueta_de_lo_gastado(gastado) if gastado
                else appliances_mod.etiqueta_de_origen(fila.get("now"), precio_ahora)
            )
        for fila in ahora_aparatos:
            datos = aprendido.get(fila["id"]) or {}
            fila["cycle"] = datos.get("cycle")
            fila["today_kwh"] = datos.get("today_kwh")
            fila["kind"] = datos.get("kind")

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
        "weather_hours": tiempo,
        "phase": _day_phase(states, now),
        "window": window,
        "appliances": ahora_aparatos,
        "plan": plan,
        "close": day_close(
            states, energy_summary, buckets, window, now, savings, aparatos, aprendido,
            por_horas, precio_at,
        ),
        "generated_at": now.isoformat(),
    }


async def _fuentes(
    curva: dict[str, Any] | None,
    settings: dict[str, Any],
    states: dict[str, Any],
    soc: float | None,
    tz,
    now: datetime,
) -> dict[str, Any] | None:
    """Con qué se estima de dónde saldría la energía de un ciclo puesto ahora.

    Las dos curvas son las mismas que usa la ventana —la del sol y el perfil
    horario de la casa—, y ahora lo son de verdad y no de palabra: la del sol se
    la dan hecha (`curva_solar`), en vez de recalcularla aquí con otras
    correcciones. Ahí estaba el defecto que hacía que las dos tarjetas de la Home
    se contradijeran.

    No cuesta ninguna petición: el perfil está en caché y la curva ya se ha
    calculado para la ventana.
    """
    if not curva:
        return None
    puntos = curva["points"]
    perfil = await _house_profile(settings, states, tz, now)
    if perfil is None:
        return None
    usable, reserva = bateria_usable(settings, states, soc)
    return {
        "sol_at": lambda momento: series_mod.forecast_at(puntos, momento),
        "casa_at": perfil.at,
        "soc": soc,
        "capacity_kwh": float(settings.get("battery_kwh") or 0.0),
        # Lo que la batería puede dar **por encima de su reserva**, que es lo que
        # hay que gastar en las simulaciones. Se calcula aquí y una sola vez: con
        # cada consumidor haciendo su cuenta volvería a pasar lo de siempre, que
        # dos partes de la misma pantalla dicen cifras distintas.
        "usable_kwh": usable,
        "reserve_pct": reserva,
        # Se lleva al plan para poder decirlo en la tarjeta: es el mismo objeto
        # que enseña la ventana, así que las dos no pueden discrepar.
        "roof_today": curva["roof_today"],
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


def _cola_del_ciclo(
    marcha: dict[str, Any],
    fuentes: dict[str, Any] | None,
    now: datetime,
) -> dict[str, Any] | None:
    """De dónde saldrá lo que le queda al ciclo que ya está en marcha.

    Un ciclo en marcha tiene dos mitades y cada una se cuenta como le toca: la que
    ya pasó se **atribuye** con el reparto de la casa —está medida—, y esta se
    **simula** con el mismo `planner.simular` que contesta «¿y si lo pongo ahora?».
    Es lo único de esta fila que un medidor de enchufe no puede decir: que los
    veinte minutos que le quedan van a caer ya con el sol bajando.

    La potencia es la **suya de hoy** —lo que lleva gastado partido por lo que lleva
    puesto—, no la del ciclo típico: si hoy va con un programa más flojo, es el de
    hoy el que va a terminar. Y sin una duración en la que se confíe no hay cola:
    no se puede decir de dónde saldrá algo cuyo final no se sabe.
    """
    quedan = marcha.get("remaining_h") or 0.0
    llevan = marcha.get("elapsed_h") or 0.0
    kwh = marcha.get("kwh") or 0.0
    if not fuentes or quedan <= 0 or llevan <= 0 or kwh <= 0:
        return None
    vatios = kwh / llevan * 1000.0
    sol, bat, red = planner.simular(now, quedan, vatios, fuentes, planner.PASO_FINO)
    total = sol + bat + red
    return {
        "hours": round(quedan, 2),
        "sun_kwh": round(sol, 3),
        "battery_kwh": round(bat, 3),
        "grid_kwh": round(red, 3),
        # El «% con sol», aquí y no en la tarjeta: es la misma cifra que llevan las
        # horas que propone el plan y tiene que salir de la misma cuenta. Calcularla
        # otra vez en el JavaScript es cómo empezaron las dos que discrepaban.
        "sun_pct": round(sol / total * 100) if total > 0 else 0,
    }


def _valorar_lo_que_queda(
    window: dict[str, Any] | None,
    settings: dict[str, Any],
    tariffs: list[dict[str, Any]] | None,
    now: datetime,
) -> None:
    """Pone en `window['today']` lo que valen los kWh que quedan por sobrar.

    Dos cifras, y son las dos caras de la misma decisión:

      · `left_saving_eur` — lo que **ahorras** si los gastas, a los precios de las
        horas que quedan: es un kWh que no compras;
      · `left_export_eur` — lo que te **pagan** si se van a la red.

    La diferencia entre las dos es el motivo de la tarjeta, y es grande: en una
    2.0TD con excedentes a 0,05 €, cada kWh gastado vale cuatro veces lo que
    vendido. Decirlo en euros es lo que hace que «te sobran 2,7 kW» pase de dato a
    decisión.

    Sin tarifa elegida no se inventan: se quedan en `None` y la tarjeta habla solo
    de kWh, que es lo que sabe.
    """
    hoy = (window or {}).get("today") or {}
    kwh = hoy.get("left_spendable_kwh")
    if not kwh or kwh <= 0:
        return
    my_id = settings.get("my_tariff_id") or ""
    tariff = next((t for t in tariffs or [] if t.get("id") == my_id), None)
    if not tariff or tariff["energy"]["type"] == "pvpc":
        # El PVPC de las horas que quedan puede no estar publicado, y pedirlo aquí
        # costaría una petición de red en cada /api/live.
        return
    fin = datetime.fromisoformat(hoy["end"]) if hoy.get("end") else None
    if fin is None or fin <= now:
        return
    festivos = set(settings.get("holidays") or [])
    # El precio de las horas que quedan, no el de ahora: la ventana puede cruzar un
    # cambio de periodo y valorarla entera al precio de este minuto sería una cifra
    # que no le corresponde a ninguna hora.
    horas, precios, excedentes = 0, [], []
    momento = now.replace(minute=0, second=0, microsecond=0)
    while momento < fin and horas < 24:
        precio, _nombre = billing.price_now(tariff, momento, festivos, None)
        if precio is not None:
            precios.append(precio)
        sp = billing.surplus_price_now(tariff, momento, festivos)
        if sp is not None:
            excedentes.append(sp)
        momento += timedelta(hours=1)
        horas += 1
    if precios:
        hoy["left_saving_eur"] = round(kwh * (sum(precios) / len(precios)), 2)
    if excedentes:
        hoy["left_export_eur"] = round(kwh * (sum(excedentes) / len(excedentes)), 2)


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
        # Y «weather», solo las entidades `weather.*`: son las únicas que tienen
        # previsión horaria, así que ofrecer trescientos sensores en ese
        # desplegable sería ofrecer trescientas maneras de equivocarse.
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
            groups["any"].append(item)
            groups["weather"].append(item)
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
        ("flow", "battery_reserve_soc", "Reserva mínima (%)", "percent", ("min soc", "min_soc", "reserved soc", "reserva")),
        ("flow", "battery_charge", "Potencia de carga", "power", ("charg", "carga", "bateria", "battery")),
        ("flow", "battery_discharge", "Potencia de descarga", "power", ("discharg", "descarga", "bateria", "battery")),
        ("energy", "battery_charge_energy", "Energía cargada", "energy", ("charg", "carga", "bateria", "battery")),
        ("energy", "battery_charge_pv_energy", "De la carga, lo que puso el sol", "energy", ("charge from pv", "carga solar", "charge_from_pv")),
        ("energy", "battery_discharge_energy", "Energía descargada", "energy", ("discharg", "descarga", "bateria", "battery")),
    ]},
    {"key": "grid", "name": "Red", "icon": "red", "rows": [
        ("flow", "grid_import", "Importada", "power", ("import", "compra", "grid", "red")),
        ("flow", "grid_export", "Exportada", "power", ("export", "vertid", "grid", "red")),
        ("energy", "grid_import_energy", "Energía importada", "energy", ("import", "compra", "grid", "red")),
        ("energy", "grid_export_energy", "Energía exportada", "energy", ("export", "vertid", "grid", "red")),
        ("energy", "grid_export_pv_energy", "De lo exportado, lo que puso el sol", "energy", ("export from pv", "exported_energy_from_pv", "vertido solar")),
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
OPTIONAL_SLOTS = {
    "home", "home_energy", "battery_soc", "battery_reserve_soc",
    "battery_charge_pv_energy", "grid_export_pv_energy",
}
OPTIONAL_NOTES = {
    "home": "Opcional · se deduce del balance",
    "home_energy": "Opcional · se deduce del balance",
    "battery_soc": "Opcional · sin él no hay gráfico de carga",
    # La reserva del inversor: por debajo de ese porcentaje **no descarga**, así
    # que esa energía existe en el contador y no en la práctica. Se puede teclear
    # en Ajustes, pero teniendo el sensor se sigue sola cuando se cambia en el
    # inversor. Un Sungrow la da como `sensor.battery_min_soc`.
    "battery_reserve_soc":
        "Opcional · si no, se teclea en Ajustes → Batería",
    # Estas dos no arreglan un hueco: **sustituyen una deducción por una
    # medida**. Vatia sabe repartir sin ellas, pero teniéndolas no tiene que
    # adivinar cuánto de la carga vino de la red, que es lo que más veces ha
    # salido mal. Un Sungrow las da; otros inversores, no.
    "battery_charge_pv_energy":
        "Opcional · si lo tienes, red→batería se mide en vez de deducirse",
    "grid_export_pv_energy":
        "Opcional · si lo tienes, batería→red se mide en vez de deducirse",
}

# Sensores que **suenan** a lo que pide la casilla y miden otra cosa. Ni se
# proponen ni se dan por buenos si ya están puestos.
#
# El caso que costó tres versiones detectar: en un Sungrow, el registro 13017
# —«Daily direct energy consumption», que Home Assistant publica como
# `sensor.daily_direct_energy_consumption`— es lo que la casa toma **del sol**,
# no su consumo total. Y la casilla del consumo buscaba candidatos con la pista
# «consum», así que Vatia lo recomendaba: el fallo del resumen empezaba en la
# propia pantalla de configuración.
#
# Es además un sensor traicionero, porque los días sin importar cuadra casi
# exacto y solo se despega cuando se compra algo. Se avisa aquí, que es donde se
# elige, y no solo cuando `casa_cuadra()` lo descarta días después.
TRAMPAS: dict[str, tuple[tuple[str, str], ...]] = {
    "home_energy": (
        ("direct_energy_consumption",
         "Este sensor mide el **autoconsumo** —lo que la casa toma del sol y de "
         "la batería—, no su consumo total: le falta todo lo que se compra a la "
         "red. Sungrow no publica ningún contador del consumo total; déjalo "
         "vacío y Vatia lo deduce del balance, o intégralo de «Load power»."),
        ("self_consumption",
         "Esto es el autoconsumo, no el consumo de la casa. Déjalo vacío y "
         "Vatia deduce el consumo del balance de los otros contadores."),
    ),
}


def trampa(slot: str, entity: str) -> str:
    """El aviso de la casilla, si la entidad elegida no mide lo que parece."""
    texto = entity.lower()
    for patron, aviso in TRAMPAS.get(slot, ()):
        if patron in texto:
            return aviso
    return ""


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

    def sugerencias(slot: str, kind: str, pistas: tuple[str, ...],
                    usados: set[str]) -> list[dict[str, str]]:
        """Candidatos para una casilla vacía: del tipo correcto y con el nombre
        a favor, sin repetir los que ya están puestos en otra casilla y **sin
        las trampas**, que son justo las que mejor casan con las pistas."""
        out = []
        for item in catalogo.get(kind, []):
            if item["entity_id"] in usados:
                continue
            texto = f"{item['entity_id']} {item['name']}".lower()
            if any(p in texto for p in pistas) and not trampa(slot, texto):
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
                "warning": trampa(slot, entity) if entity else "",
                "responds": responde, "value": valor, "unit": unidad,
                "suggestions": [] if entity else sugerencias(slot, kind, pistas, usados),
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

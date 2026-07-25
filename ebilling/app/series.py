"""Series temporales para la pantalla «Energía».

Construye los datos de los gráficos a partir de las estadísticas de largo
plazo de Home Assistant:

  - Rango **día**: potencia media (W) de los sensores de potencia, en pasos de
    5 minutos, con la curva del día anterior como comparación.
  - Rangos **semana / mes**: energía (kWh) por día.
  - Rango **año**: energía (kWh) por mes.
  - Rango **total**: energía (kWh) por año.

Cada vista (general, solar, casa, batería, red) elige qué series se dibujan y
qué desglose se muestra debajo.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any

import aiohttp

import datasources

_LOGGER = logging.getLogger(__name__)

MESES = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
         "agosto", "septiembre", "octubre", "noviembre", "diciembre")
MESES_ABR = ("ene", "feb", "mar", "abr", "may", "jun", "jul",
             "ago", "sep", "oct", "nov", "dic")

RANGES = ("day", "week", "month", "year", "total")
VIEWS = ("overview", "solar", "home", "battery", "grid")

# Contadores de energía configurables. «home_energy» es opcional: si no está,
# el consumo de la casa se mide integrando su sensor de potencia o, en último
# término, se deduce por balance.
ENERGY_KEYS = (
    "pv_energy",
    "grid_import_energy",
    "grid_export_energy",
    "battery_charge_energy",
    "battery_discharge_energy",
    "home_energy",
)

COLORS = {
    "solar": "#f5a524",
    "home": "#c9c443",
    "battery": "#10b981",
    "grid": "#6b8afd",
    "battery_charge": "#10b981",
    "battery_discharge": "#5eead4",
    "grid_import": "#6b8afd",
    "grid_export": "#a78bfa",
    "yesterday": "#5ab8b0",
    "forecast": "#ffc94d",
    "to_home": "#c9c443",
    "to_battery": "#61b87f",
    "to_grid": "#7d92f0",
    "from_solar": "#eea154",
    "from_battery": "#61b87f",
    "from_grid": "#7d92f0",
}


# ---------------------------------------------------------------------------
# Acceso a las estadísticas
# ---------------------------------------------------------------------------


async def ws_statistics(
    settings: dict[str, Any], requests: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Ejecuta varias consultas de estadísticas en una sola conexión.

    Cada petición es {"ids": [...], "start": dt, "end": dt, "period": str,
    "types": [...]}. Devuelve (resultados en el mismo orden, unidades de cada
    estadística), porque la unidad de la estadística puede no coincidir con la
    del estado actual del sensor.
    """
    if not requests:
        return [], {}
    _base, ws_url, token = datasources._ha_endpoints(settings)
    results: dict[int, dict[str, Any]] = {}
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(
            ws_url, timeout=aiohttp.ClientTimeout(total=30)
        ) as ws:
            msg = await ws.receive_json()
            if msg.get("type") == "auth_required":
                await ws.send_json({"type": "auth", "access_token": token})
                msg = await ws.receive_json()
                if msg.get("type") != "auth_ok":
                    raise datasources.SourceError(
                        "Autenticación websocket rechazada por Home Assistant."
                    )
            pending = set()
            for index, req in enumerate(requests, start=1):
                pending.add(index)
                await ws.send_json(
                    {
                        "id": index,
                        "type": "recorder/statistics_during_period",
                        "start_time": req["start"].isoformat(),
                        "end_time": req["end"].isoformat(),
                        "statistic_ids": req["ids"],
                        "period": req["period"],
                        "types": req["types"],
                    }
                )
            meta_id = len(requests) + 1
            pending.add(meta_id)
            await ws.send_json({"id": meta_id, "type": "recorder/list_statistic_ids"})
            meta: list[dict[str, Any]] = []
            while pending:
                msg = await ws.receive_json()
                mid = msg.get("id")
                if mid not in pending or msg.get("type") != "result":
                    continue
                if mid == meta_id:
                    meta = msg.get("result") or [] if msg.get("success") else []
                else:
                    results[mid] = msg.get("result") or {} if msg.get("success") else {}
                pending.discard(mid)
    units = {
        item.get("statistic_id"): (
            item.get("statistics_unit_of_measurement")
            or item.get("unit_of_measurement")
            or ""
        )
        for item in meta
        if item.get("statistic_id")
    }
    return [results.get(i, {}) for i in range(1, len(requests) + 1)], units


def _row_time(raw: Any, tz) -> datetime:
    if isinstance(raw, (int, float)):
        return datetime.fromtimestamp(raw / 1000.0, tz)
    return datetime.fromisoformat(str(raw)).astimezone(tz)


def _num(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None  # descarta NaN


def _parse_dt(raw: Any, tz) -> datetime | None:
    """Fecha de un atributo de forecast (ISO, «YYYY-MM-DD HH:MM:SS» o epoch)."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return datetime.fromtimestamp(float(raw), tz)
    text = str(raw).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    if " " in text and "T" not in text:
        text = text.replace(" ", "T", 1)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return parsed.astimezone(tz)


def _unit_factor(
    entity: str, states: dict[str, Any], kind: str, units: dict[str, str] | None = None
) -> float:
    """Factor para llevar el valor a W (potencia) o kWh (energía).

    Se prioriza la unidad declarada por la propia estadística; si no está, se
    usa la del estado actual del sensor.
    """
    unit = ((units or {}).get(entity) or "").lower()
    if not unit:
        unit = ((states.get(entity, {}).get("attributes") or {}).get("unit_of_measurement") or "").lower()
    if kind == "power":
        return {"kw": 1000.0, "mw": 1e6}.get(unit, 1.0)
    return {"wh": 0.001, "mwh": 1000.0}.get(unit, 1.0)


def _extract(
    result: dict[str, Any],
    entity: str,
    field: str,
    tz,
    factor: float,
) -> dict[str, float]:
    """{clave_de_bucket_iso: valor} para una entidad."""
    out: dict[str, float] = {}
    for row in result.get(entity) or []:
        value = row.get(field)
        if value is None:
            continue
        try:
            number = float(value) * factor
        except (TypeError, ValueError):
            continue
        out[_row_time(row.get("start"), tz).isoformat()] = number
    return out


# ---------------------------------------------------------------------------
# Previsión de generación solar
# ---------------------------------------------------------------------------

# Claves de valor de potencia habituales en los atributos de forecast, con el
# factor para llevarlas a W.
_FORECAST_POWER_KEYS = (
    ("pv_estimate", 1000.0),   # Solcast (kW)
    ("pv_estimate50", 1000.0),
    ("watts", 1.0),            # Forecast.Solar (W)
    ("power", 1.0),
    ("power_kw", 1000.0),
)


def _forecast_states(settings: dict[str, Any], states: dict[str, Any]) -> list[dict[str, Any]]:
    """Estados de los sensores de previsión configurados (hoy y mañana).

    Se admite una lista de sensores separados por comas para poder encadenar
    «hoy» y «mañana», como los exponen Solcast o Forecast.Solar.
    """
    raw = settings.get("solar_forecast_sensor") or ""
    ids = [item.strip() for item in str(raw).split(",") if item.strip()]
    return [states[i] for i in ids if i in states]


def forecast_power(states_list: list[dict[str, Any]], tz) -> list[tuple[datetime, float]]:
    """Curva de potencia prevista (W), ordenada por hora."""
    points: dict[datetime, float] = {}
    for state in states_list:
        attrs = state.get("attributes") or {}
        for key in ("detailedForecast", "detailedHourly", "forecast"):
            rows = attrs.get(key)
            if not isinstance(rows, list):
                continue
            for row in rows:
                if not isinstance(row, dict):
                    continue
                moment = _parse_dt(
                    row.get("period_start")
                    or row.get("datetime")
                    or row.get("period")
                    or row.get("start"),
                    tz,
                )
                if moment is None:
                    continue
                for name, factor in _FORECAST_POWER_KEYS:
                    value = _num(row.get(name))
                    if value is not None:
                        points.setdefault(moment, value * factor)
                        break
        watts = attrs.get("watts")
        if isinstance(watts, dict):
            for raw_key, raw_value in watts.items():
                moment = _parse_dt(raw_key, tz)
                value = _num(raw_value)
                if moment is not None and value is not None:
                    points.setdefault(moment, value)
    return sorted(points.items())


def forecast_daily(states_list: list[dict[str, Any]], tz) -> dict[datetime, float]:
    """Energía prevista por día (kWh), indexada por medianoche local."""
    out: dict[datetime, float] = {}
    for state in states_list:
        attrs = state.get("attributes") or {}
        days = attrs.get("wh_days")
        if isinstance(days, dict):
            for raw_key, raw_value in days.items():
                moment = _parse_dt(raw_key, tz)
                value = _num(raw_value)
                if moment is not None and value is not None:
                    out.setdefault(_midnight(moment), value / 1000.0)
    if out:
        return out
    # Sin wh_days: se integra la curva de potencia por días.
    points = forecast_power(states_list, tz)
    for index, (moment, watts) in enumerate(points):
        if index + 1 < len(points):
            hours = (points[index + 1][0] - moment).total_seconds() / 3600.0
        else:
            hours = 0.5
        hours = min(max(hours, 0.0), 3.0)
        day = _midnight(moment)
        out[day] = out.get(day, 0.0) + watts * hours / 1000.0
    return out


def _midnight(moment: datetime) -> datetime:
    return moment.replace(hour=0, minute=0, second=0, microsecond=0)


def _interpolate(points: list[tuple[datetime, float]], grid: list[datetime]) -> dict[str, float]:
    """Interpola la curva de previsión sobre la rejilla del eje X."""
    if not points:
        return {}
    out: dict[str, float] = {}
    index = 0
    for moment in grid:
        if moment < points[0][0] or moment > points[-1][0]:
            continue
        while index + 1 < len(points) and points[index + 1][0] < moment:
            index += 1
        left_t, left_v = points[index]
        if index + 1 >= len(points):
            out[moment.isoformat()] = left_v
            continue
        right_t, right_v = points[index + 1]
        span = (right_t - left_t).total_seconds()
        ratio = 0.0 if span <= 0 else (moment - left_t).total_seconds() / span
        out[moment.isoformat()] = left_v + (right_v - left_v) * max(min(ratio, 1.0), 0.0)
    return out


def _day_grid(start: datetime, end: datetime) -> list[datetime]:
    """Medianoches locales de [start, end) (robusto ante cambios de hora)."""
    out: list[datetime] = []
    day = _midnight(start)
    while day < end:
        out.append(day)
        day = _midnight(day + timedelta(hours=27))
    return out


def _grid(start: datetime, end: datetime, minutes: int) -> list[datetime]:
    """Rejilla regular de buckets [start, end)."""
    out: list[datetime] = []
    step = timedelta(minutes=minutes)
    moment = start
    while moment < end:
        out.append(moment)
        moment += step
    return out


# ---------------------------------------------------------------------------
# Ventanas de tiempo
# ---------------------------------------------------------------------------


def window(range_key: str, offset: int, tz, now: datetime) -> tuple[datetime, datetime, str, str]:
    """(inicio, fin, periodo_estadístico, etiqueta) del rango pedido."""
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if range_key == "day":
        start = today + timedelta(days=offset)
        return start, start + timedelta(days=1), "5minute", f"{start.day} {MESES_ABR[start.month - 1]} {start.year}"
    if range_key == "week":
        monday = today - timedelta(days=today.weekday()) + timedelta(weeks=offset)
        end = monday + timedelta(days=7)
        last = end - timedelta(days=1)
        return monday, end, "day", (
            f"{monday.day} {MESES_ABR[monday.month - 1]} – "
            f"{last.day} {MESES_ABR[last.month - 1]} {last.year}"
        )
    if range_key == "month":
        base = today.replace(day=1)
        month = base.month - 1 + offset
        year = base.year + month // 12
        start = base.replace(year=year, month=month % 12 + 1)
        end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        return start, end, "day", f"{MESES[start.month - 1].capitalize()} {start.year}"
    if range_key == "year":
        start = today.replace(month=1, day=1, year=today.year + offset)
        return start, start.replace(year=start.year + 1), "month", str(start.year)
    # total: desde hace 10 años, agrupado por año
    start = today.replace(month=1, day=1, year=today.year - 9)
    return start, today + timedelta(days=1), "month", "Total"


# ---------------------------------------------------------------------------
# Construcción del payload
# ---------------------------------------------------------------------------


def _series(
    key: str,
    label: str,
    values: list[float | None],
    total: float | None = None,
    *,
    total_unit: str = "kWh",
    dashed: bool = False,
    legend: bool = True,
) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "color": COLORS.get(key, "#8e97ad"),
        "values": [None if v is None else round(v, 3) for v in values],
        "total": None if total is None else round(total, 2),
        "total_unit": total_unit,
        "dashed": dashed,
        "legend": legend,
    }


def _align(x_keys: list[str], data: dict[str, float]) -> list[float | None]:
    return [data.get(k) for k in x_keys]


def _sorted_keys(keys) -> list[str]:
    """Ordena claves ISO por instante real (los cambios de hora varían el UTC
    offset, así que ordenar el texto no siempre coincide).

    En el rango «total» las claves son años («2026»): se ordenan como texto.
    """
    def key(item: str):
        try:
            return (0, datetime.fromisoformat(item).timestamp())
        except ValueError:
            return (1, item)

    return sorted(keys, key=key)


def _sum(values: list[float | None]) -> float:
    return sum(v for v in values if v is not None)


def split_flows(
    pv: float,
    charge: float,
    export: float,
    imported: float,
    discharge: float,
    home_measured: float | None = None,
) -> dict[str, float]:
    """Reparte la energía de un periodo entre destinos y orígenes.

    Modelo de las apps de inversores: de la generación se atribuye primero lo
    vertido y lo que carga la batería, y el resto va a la casa; lo que carga la
    batería por encima de lo generado viene de la red.

    Si hay una **medida directa del consumo de la casa** (``home_measured``) se
    usa como total y los orígenes se reparten hasta cubrirlo, de modo que las
    filas siempre suman exactamente el total. Sin ella, el consumo se deduce
    por balance.

    Todas las magnitudes en la misma unidad (kWh o Wh).
    """
    pv = max(pv or 0.0, 0.0)
    charge = max(charge or 0.0, 0.0)
    export = max(export or 0.0, 0.0)
    imported = max(imported or 0.0, 0.0)
    discharge = max(discharge or 0.0, 0.0)

    to_grid = min(export, pv)
    to_battery = min(charge, max(pv - to_grid, 0.0))
    to_home = max(pv - to_grid - to_battery, 0.0)
    grid_to_battery = max(charge - to_battery, 0.0)

    if home_measured is not None and home_measured > 0:
        home_total = home_measured
        from_solar = min(to_home, home_total)
        from_battery = min(discharge, max(home_total - from_solar, 0.0))
        from_grid = max(home_total - from_solar - from_battery, 0.0)
    else:
        from_solar = to_home
        from_battery = discharge
        from_grid = max(imported - grid_to_battery, 0.0)
        home_total = from_solar + from_battery + from_grid

    return {
        "to_home": to_home,
        "to_battery": to_battery,
        "to_grid": to_grid,
        "from_solar": from_solar,
        "from_battery": from_battery,
        "from_grid": from_grid,
        "home_total": home_total,
        # Partes que no pasan por la casa ni por la generación, y que explican
        # la diferencia entre los contadores de la red y el reparto:
        # lo importado que acaba en la batería y lo vertido que no es solar.
        "grid_to_battery": grid_to_battery,
        "battery_to_grid": max(export - to_grid, 0.0),
    }



def _breakdown_rows(view: str, flows: list[dict[str, float]]) -> list[tuple[str, str, float]]:
    """Filas del desglose según la vista (vacío para batería y red)."""
    def total(key: str) -> float:
        return sum(item[key] for item in flows)

    if view == "solar":
        return [
            ("to_home", "A la casa", total("to_home")),
            ("to_battery", "A la batería", total("to_battery")),
            ("to_grid", "A la red", total("to_grid")),
        ]
    if view in ("home", "overview"):
        return [
            ("from_solar", "Desde solar", total("from_solar")),
            ("from_battery", "Desde batería", total("from_battery")),
            ("from_grid", "Desde la red", total("from_grid")),
        ]
    return []


def _make_breakdown(rows: list[tuple[str, str, float]]) -> dict[str, Any] | None:
    if not rows:
        return None
    total = sum(v for _k, _l, v in rows)
    return {
        "total": round(total, 2),
        "unit": "kWh",
        "rows": [
            {
                "key": key,
                "label": label,
                "color": COLORS.get(key, "#8e97ad"),
                "kwh": round(value, 2),
                "pct": round((value / total) * 100) if total > 0 else 0,
            }
            for key, label, value in rows
        ],
    }


async def build(
    settings: dict[str, Any],
    states: dict[str, Any],
    view: str,
    range_key: str,
    offset: int,
    tz,
    now: datetime,
) -> dict[str, Any]:
    view = view if view in VIEWS else "overview"
    range_key = range_key if range_key in RANGES else "day"
    start, end, period, label = window(range_key, offset, tz, now)

    flow = settings.get("flow_sensors") or {}
    energy = settings.get("energy_sensors") or {}

    if range_key == "day":
        payload = await _build_power(settings, states, view, flow, start, end, tz, now)
    else:
        payload = await _build_energy(
            settings, states, view, energy, start, end, period, range_key, tz, now
        )

    payload.update(
        {
            "view": view,
            "range": range_key,
            "offset": offset,
            "label": label,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "can_next": offset < 0,
        }
    )
    return payload


async def _build_power(
    settings: dict[str, Any],
    states: dict[str, Any],
    view: str,
    flow: dict[str, str],
    start: datetime,
    end: datetime,
    tz,
    now: datetime,
) -> dict[str, Any]:
    """Vista de día: potencia media en W, con la curva de ayer."""
    wanted: list[tuple[str, str, str]] = []  # (clave, etiqueta, sensor)
    if view in ("overview", "solar"):
        wanted.append(("solar", "Solar", flow.get("pv", "")))
    if view in ("overview", "home"):
        wanted.append(("home", "Casa", flow.get("home", "")))
    if view in ("overview", "battery"):
        wanted.append(("battery_charge", "Carga", flow.get("battery_charge", "")))
        wanted.append(("battery_discharge", "Descarga", flow.get("battery_discharge", "")))
    if view in ("overview", "grid"):
        wanted.append(("grid_import", "Importada", flow.get("grid_import", "")))
        wanted.append(("grid_export", "Exportada", flow.get("grid_export", "")))

    # Previsión de generación: solo si el intervalo alcanza tiempo futuro.
    forecast_points: list[tuple[datetime, float]] = []
    if view == "solar" and end > now:
        forecast_points = forecast_power(_forecast_states(settings, states), tz)
        forecast_points = [p for p in forecast_points if start <= p[0] <= end]

    ids = [sensor for _k, _l, sensor in wanted if sensor]
    if not ids and not forecast_points:
        return {"unit": "W", "chart": "line", "x": [], "series": [], "breakdown": None}

    if not ids:
        grid = _grid(start, end, 5)
        values = _interpolate(forecast_points, grid)
        x_keys = [moment.isoformat() for moment in grid]
        forecast = _series(
            "forecast", "Previsión", _align(x_keys, values),
            dashed=True, legend=False, total_unit="kWh",
        )
        return {"unit": "W", "chart": "line", "x": x_keys,
                "series": [forecast], "breakdown": None}

    requests = [
        {"ids": ids, "start": start, "end": end, "period": "5minute", "types": ["mean"]}
    ]
    show_yesterday = view in ("solar", "home")
    if show_yesterday:
        requests.append(
            {
                "ids": ids[:1],
                "start": start - timedelta(days=1),
                "end": end - timedelta(days=1),
                "period": "5minute",
                "types": ["mean"],
            }
        )
    # Energía del día, para el desglose que acompaña al gráfico.
    energy_cfg = settings.get("energy_sensors") or {}
    energy_keys = ENERGY_KEYS
    energy_ids = [energy_cfg.get(k) for k in energy_keys if energy_cfg.get(k)]
    energy_index = None
    # El día en curso se resuelve con los mismos totales que la Home (más
    # abajo); para días pasados se piden aquí, en pasos de 5 minutos (no el
    # bucket diario, que se consolida por horas).
    is_today = end > now
    wants_breakdown = bool(energy_ids) and view in ("solar", "home", "overview")
    if wants_breakdown and not is_today:
        energy_index = len(requests)
        requests.append(
            {"ids": energy_ids, "start": start, "end": end,
             "period": "5minute", "types": ["change"]}
        )

    results, units = await ws_statistics(settings, requests)
    main = results[0]

    extracted: list[tuple[str, str, dict[str, float]]] = []
    for key, label_s, sensor in wanted:
        if not sensor:
            continue
        factor = _unit_factor(sensor, states, "power", units)
        extracted.append((key, label_s, _extract(main, sensor, "mean", tz, factor)))

    # El eje cubre el día completo (00–24) aunque falten datos futuros.
    keys = {moment.isoformat() for moment in _grid(start, end, 5)}
    keys.update(k for _k, _l, data in extracted for k in data)
    x_keys = _sorted_keys(keys)
    series = [
        _series(key, label_s, _align(x_keys, data))
        for key, label_s, data in extracted
    ]

    if show_yesterday and len(results) > 1 and ids:
        factor = _unit_factor(ids[0], states, "power", units)
        yday = _extract(results[1], ids[0], "mean", tz, factor)
        # Se desplaza un día para superponerla sobre el mismo eje horario.
        shifted = {
            (datetime.fromisoformat(k) + timedelta(days=1)).isoformat(): v
            for k, v in yday.items()
        }
        series.append(_series("yesterday", "Ayer", _align(x_keys, shifted)))

    # El total de la leyenda es la energía del periodo (integral de la potencia
    # media de cada bucket de 5 minutos), no el máximo.
    for item in series:
        energy_kwh = _sum(item["values"]) * (5.0 / 60.0) / 1000.0
        item["total"] = round(energy_kwh, 2)
        item["total_label"] = "total"
        item["total_unit"] = "kWh"

    if forecast_points:
        grid = [datetime.fromisoformat(k) for k in x_keys]
        values = _interpolate(forecast_points, grid)
        # Solo la parte futura (desde el bucket en curso, para que la línea
        # punteada enlace con la real); del pasado ya informa la serie medida.
        cut = now - timedelta(
            minutes=now.minute % 5, seconds=now.second, microseconds=now.microsecond
        )
        future = {
            moment.isoformat(): values[moment.isoformat()]
            for moment in grid
            if moment >= cut and moment.isoformat() in values
        }
        if future:
            series.append(
                _series(
                    "forecast", "Previsión", _align(x_keys, future),
                    total=_sum(_align(x_keys, future)) * (5.0 / 60.0) / 1000.0,
                    dashed=True, legend=False,
                )
            )

    # El reparto se hace bucket a bucket: sobre el total del día se perdería a
    # qué hora ocurre cada cosa (una carga de red de madrugada parecería solar).
    flows: dict[str, float] | None = None
    if energy_index is not None:
        raw = results[energy_index]
        per_bucket: dict[str, dict[str, float]] = {}
        for key in energy_keys:
            sensor = energy_cfg.get(key)
            if not sensor:
                continue
            factor = _unit_factor(sensor, states, "energy", units)
            for iso, value in _extract(raw, sensor, "change", tz, factor).items():
                per_bucket.setdefault(iso, {})[key] = value
        measured = bool(energy_cfg.get("home_energy"))
        parts = [
            split_flows(
                v.get("pv_energy", 0.0), v.get("battery_charge_energy", 0.0),
                v.get("grid_export_energy", 0.0), v.get("grid_import_energy", 0.0),
                v.get("battery_discharge_energy", 0.0),
                v.get("home_energy") if measured else None,
            )
            for v in per_bucket.values()
        ]
        if parts:
            flows = {k: sum(p[k] for p in parts) for k in parts[0]}
    elif wants_breakdown and is_today:
        # Mismo reparto que la Home (cacheado allí), para que las dos pantallas
        # muestren exactamente lo mismo. Import local: `live` importa este módulo.
        import live  # noqa: PLC0415

        daily = await live.daily_energy(settings, states, tz, now)
        if daily["flows"]:
            flows = {k: v / 1000.0 for k, v in daily["flows"].items()}

    breakdown = _make_breakdown(_breakdown_rows(view, [flows])) if flows else None

    return {"unit": "W", "chart": "line", "x": x_keys, "series": series, "breakdown": breakdown}


async def _build_energy(
    settings: dict[str, Any],
    states: dict[str, Any],
    view: str,
    energy: dict[str, str],
    start: datetime,
    end: datetime,
    period: str,
    range_key: str,
    tz,
    now: datetime,
) -> dict[str, Any]:
    """Semana / mes / año / total: energía en kWh por bucket."""
    keys = ENERGY_KEYS
    ids = [energy.get(k) for k in keys if energy.get(k)]
    if not ids:
        return {"unit": "kWh", "chart": "line", "x": [], "series": [], "breakdown": None}

    requests = [
        {"ids": ids, "start": start, "end": end, "period": period, "types": ["change"]}
    ]
    # El desglose se reparte por horas, no por el bucket del gráfico: con
    # buckets de un día, una carga de batería desde la red de madrugada se
    # confunde con la solar del mediodía. En año y total serían miles de
    # buckets, así que ahí se reparte con el mismo bucket del gráfico.
    fine_index = None
    if view in ("solar", "home", "overview") and range_key in ("week", "month"):
        fine_index = len(requests)
        requests.append(
            {"ids": ids, "start": start, "end": end, "period": "hour", "types": ["change"]}
        )

    results, units = await ws_statistics(settings, requests)
    raw = results[0]

    data: dict[str, dict[str, float]] = {}
    for key in keys:
        sensor = energy.get(key)
        if not sensor:
            data[key] = {}
            continue
        factor = _unit_factor(sensor, states, "energy", units)
        data[key] = _extract(raw, sensor, "change", tz, factor)

    # En «total» los meses se agrupan por año.
    if range_key == "total":
        grouped: dict[str, dict[str, float]] = {}
        for key, buckets in data.items():
            acc: dict[str, float] = {}
            for iso, value in buckets.items():
                year = iso[:4]
                acc[year] = acc.get(year, 0.0) + value
            grouped[key] = acc
        data = grouped

    # Previsión de generación para los buckets futuros (solo semana y mes, que
    # es el alcance de los integradores de forecast).
    fc_daily: dict[str, float] = {}
    if view == "solar" and end > now and range_key in ("week", "month"):
        for day, kwh in forecast_daily(_forecast_states(settings, states), tz).items():
            if start <= day < end and day >= _midnight(now):
                fc_daily[day.isoformat()] = kwh

    # Buckets con datos reales: el resto del eje queda como hueco (None) para no
    # dibujar ceros en los días que aún no han ocurrido.
    known = {k for buckets in data.values() for k in buckets}
    bucket_keys = set(known)
    bucket_keys.update(fc_daily)
    if range_key in ("week", "month"):
        # Eje completo: la semana o el mes entero, aunque aún no haya datos.
        bucket_keys.update(moment.isoformat() for moment in _day_grid(start, end))
    x_keys = _sorted_keys(bucket_keys)

    def get(key: str) -> list[float]:
        return [max(data.get(key, {}).get(x, 0.0), 0.0) for x in x_keys]

    pv, gi, ge, bc, bd, home_e = (get(k) for k in keys)
    # Reparto por bucket con el mismo modelo que la Home. Si hay contador de
    # consumo de la casa, se usa como medida directa del total.
    measured = bool(energy.get("home_energy"))
    flows = [
        split_flows(p, c, e, i, d, h if measured else None)
        for p, c, e, i, d, h in zip(pv, bc, ge, gi, bd, home_e)
    ]
    home_total = [item["home_total"] for item in flows]

    series: list[dict[str, Any]] = []
    # Para el desglose se usa el reparto horario si se ha pedido; si no, el del
    # propio bucket del gráfico.
    fine_flows = flows
    if fine_index is not None:
        hourly: dict[str, dict[str, float]] = {}
        for key in keys:
            sensor = energy.get(key)
            if not sensor:
                continue
            factor = _unit_factor(sensor, states, "energy", units)
            for iso, value in _extract(results[fine_index], sensor, "change", tz, factor).items():
                hourly.setdefault(iso, {})[key] = value
        if hourly:
            fine_flows = [
                split_flows(
                    v.get("pv_energy", 0.0), v.get("battery_charge_energy", 0.0),
                    v.get("grid_export_energy", 0.0), v.get("grid_import_energy", 0.0),
                    v.get("battery_discharge_energy", 0.0),
                    v.get("home_energy") if measured else None,
                )
                for v in hourly.values()
            ]
    breakdown_rows = _breakdown_rows(view, fine_flows)

    mask = [x in known for x in x_keys]

    def line(key: str, label: str, values: list[float]) -> dict[str, Any]:
        gaps = [v if ok else None for v, ok in zip(values, mask)]
        return _series(key, label, gaps, _sum(values))

    if view == "solar":
        series = [line("solar", "Solar", pv)]
    elif view == "home":
        series = [line("home", "Casa", home_total)]
    elif view == "battery":
        series = [
            line("battery_charge", "Carga", bc),
            line("battery_discharge", "Descarga", bd),
        ]
    elif view == "grid":
        series = [
            line("grid_import", "Importada", gi),
            line("grid_export", "Exportada", ge),
        ]
    else:  # overview
        series = [
            line("solar", "Solar", pv),
            line("home", "Casa", home_total),
            line("grid_import", "Importada", gi),
            line("grid_export", "Exportada", ge),
        ]

    breakdown = _make_breakdown(breakdown_rows)

    for item in series:
        item["total_label"] = "total"
        item["total_unit"] = "kWh"

    if fc_daily:
        series.append(
            _series(
                "forecast", "Previsión", _align(x_keys, fc_daily),
                total=_sum(_align(x_keys, fc_daily)), dashed=True, legend=False,
            )
        )

    return {"unit": "kWh", "chart": "line", "x": x_keys, "series": series,
            "breakdown": breakdown}

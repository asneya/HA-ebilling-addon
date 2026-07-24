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


def _series(key: str, label: str, values: list[float | None], total: float | None = None) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "color": COLORS.get(key, "#8e97ad"),
        "values": [None if v is None else round(v, 3) for v in values],
        "total": None if total is None else round(total, 2),
    }


def _align(x_keys: list[str], data: dict[str, float]) -> list[float | None]:
    return [data.get(k) for k in x_keys]


def _sum(values: list[float | None]) -> float:
    return sum(v for v in values if v is not None)



def _breakdown_rows(
    view: str,
    to_home: list[float],
    to_battery: list[float],
    to_grid: list[float],
    discharge: list[float],
    from_grid: list[float],
) -> list[tuple[str, str, float]]:
    """Filas del desglose según la vista (vacío para batería y red)."""
    if view == "solar":
        return [
            ("to_home", "A la casa", _sum(to_home)),
            ("to_battery", "A la batería", _sum(to_battery)),
            ("to_grid", "A la red", _sum(to_grid)),
        ]
    if view in ("home", "overview"):
        return [
            ("from_solar", "Desde solar", _sum(to_home)),
            ("from_battery", "Desde batería", _sum(discharge)),
            ("from_grid", "Desde la red", _sum(from_grid)),
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
        payload = await _build_power(settings, states, view, flow, start, end, tz, label)
    else:
        payload = await _build_energy(
            settings, states, view, energy, start, end, period, range_key, tz, label
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
    label: str,
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

    ids = [sensor for _k, _l, sensor in wanted if sensor]
    if not ids:
        return {"unit": "W", "chart": "line", "x": [], "series": [], "breakdown": None}

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
    energy_keys = ("pv_energy", "grid_import_energy", "grid_export_energy",
                   "battery_charge_energy", "battery_discharge_energy")
    energy_ids = [energy_cfg.get(k) for k in energy_keys if energy_cfg.get(k)]
    energy_index = None
    if energy_ids and view in ("solar", "home", "overview"):
        energy_index = len(requests)
        requests.append(
            {"ids": energy_ids, "start": start, "end": end, "period": "day", "types": ["change"]}
        )

    results, units = await ws_statistics(settings, requests)
    main = results[0]

    extracted: list[tuple[str, str, dict[str, float]]] = []
    for key, label_s, sensor in wanted:
        if not sensor:
            continue
        factor = _unit_factor(sensor, states, "power", units)
        extracted.append((key, label_s, _extract(main, sensor, "mean", tz, factor)))

    x_keys = sorted({k for _k, _l, data in extracted for k in data})
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

    # Los totales de la leyenda en vista de día son la media/última potencia:
    # se muestra el valor del punto seleccionado en el frontend.
    for item in series:
        values = [v for v in item["values"] if v is not None]
        item["total"] = round(max(values), 1) if values else 0.0
        item["total_label"] = "máx."

    breakdown = None
    if energy_index is not None:
        raw = results[energy_index]
        totals: dict[str, float] = {}
        for key in energy_keys:
            sensor = energy_cfg.get(key)
            if not sensor:
                totals[key] = 0.0
                continue
            factor = _unit_factor(sensor, states, "energy", units)
            totals[key] = sum(_extract(raw, sensor, "change", tz, factor).values())
        pv_e = max(totals["pv_energy"], 0.0)
        to_grid = min(max(totals["grid_export_energy"], 0.0), pv_e)
        to_battery = min(max(totals["battery_charge_energy"], 0.0), max(pv_e - to_grid, 0.0))
        to_home = max(pv_e - to_grid - to_battery, 0.0)
        grid_to_battery = max(max(totals["battery_charge_energy"], 0.0) - to_battery, 0.0)
        from_grid = max(max(totals["grid_import_energy"], 0.0) - grid_to_battery, 0.0)
        discharge = max(totals["battery_discharge_energy"], 0.0)
        breakdown = _make_breakdown(
            _breakdown_rows(view, [to_home], [to_battery], [to_grid], [discharge], [from_grid])
        )

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
    label: str,
) -> dict[str, Any]:
    """Semana / mes / año / total: energía en kWh por bucket."""
    keys = ("pv_energy", "grid_import_energy", "grid_export_energy",
            "battery_charge_energy", "battery_discharge_energy")
    ids = [energy.get(k) for k in keys if energy.get(k)]
    if not ids:
        return {"unit": "kWh", "chart": "bar", "x": [], "series": [], "breakdown": None}

    results, units = await ws_statistics(
        settings,
        [{"ids": ids, "start": start, "end": end, "period": period, "types": ["change"]}],
    )
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

    x_keys = sorted({k for buckets in data.values() for k in buckets})

    def get(key: str) -> list[float]:
        return [max(data.get(key, {}).get(x, 0.0), 0.0) for x in x_keys]

    pv, gi, ge, bc, bd = (get(k) for k in keys)
    # Reparto por bucket con el mismo modelo que la Home.
    to_grid = [min(g, p) for g, p in zip(ge, pv)]
    to_battery = [min(c, max(p - tg, 0.0)) for c, p, tg in zip(bc, pv, to_grid)]
    to_home = [max(p - tg - tb, 0.0) for p, tg, tb in zip(pv, to_grid, to_battery)]
    from_grid = [max(i - max(c - tb, 0.0), 0.0) for i, c, tb in zip(gi, bc, to_battery)]
    home_total = [a + b + c for a, b, c in zip(to_home, bd, from_grid)]

    series: list[dict[str, Any]] = []
    breakdown_rows = _breakdown_rows(view, to_home, to_battery, to_grid, bd, from_grid)

    if view == "solar":
        series = [_series("solar", "Solar", pv, _sum(pv))]
    elif view == "home":
        series = [_series("home", "Casa", home_total, _sum(home_total))]
    elif view == "battery":
        series = [
            _series("battery_charge", "Carga", bc, _sum(bc)),
            _series("battery_discharge", "Descarga", bd, _sum(bd)),
        ]
    elif view == "grid":
        series = [
            _series("grid_import", "Importada", gi, _sum(gi)),
            _series("grid_export", "Exportada", ge, _sum(ge)),
        ]
    else:  # overview
        series = [
            _series("solar", "Solar", pv, _sum(pv)),
            _series("home", "Casa", home_total, _sum(home_total)),
            _series("grid_import", "Importada", gi, _sum(gi)),
            _series("grid_export", "Exportada", ge, _sum(ge)),
        ]

    breakdown = _make_breakdown(breakdown_rows)

    for item in series:
        item["total_label"] = "total"
    return {"unit": "kWh", "chart": "bar", "x": x_keys, "series": series, "breakdown": breakdown}

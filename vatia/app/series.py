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
from collections.abc import Callable
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


def forecast_at(points: list[tuple[datetime, float]], moment: datetime) -> float:
    """W previstos en un instante, interpolando entre los dos puntos vecinos.

    Cero fuera del rango de la previsión: de noche no hay sol que prometer, y
    extrapolar por los bordes daría producción a las tres de la mañana.
    """
    if not points or moment < points[0][0] or moment > points[-1][0]:
        return 0.0
    lo, hi = 0, len(points) - 1
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if points[mid][0] <= moment:
            lo = mid
        else:
            hi = mid
    t0, v0 = points[lo]
    t1, v1 = points[min(lo + 1, len(points) - 1)]
    span = (t1 - t0).total_seconds()
    if span <= 0:
        return max(v0, 0.0)
    ratio = max(0.0, min((moment - t0).total_seconds() / span, 1.0))
    return max(v0 + (v1 - v0) * ratio, 0.0)


def _midnight(moment: datetime) -> datetime:
    return moment.replace(hour=0, minute=0, second=0, microsecond=0)


# ---------------------------------------------------------------------------
# La ventana de energía gratis
# ---------------------------------------------------------------------------
# El tramo del día en el que la previsión solar da más de lo que la casa gasta
# de normal. Lo que se ponga a funcionar dentro de la ventana lo paga el sol:
# fuera, lo paga la red. Es la pregunta que la app tiene que contestar sin que
# nadie la haga —«¿ahora o luego?»— y de ahí que la ventana salga en Inicio.
#
# El umbral no es cero sino el consumo típico de la casa: con 200 W de nevera y
# 150 W de sol no sobra nada, aunque el panel esté generando.

def free_window(
    points: list[tuple[datetime, float]],
    baseline: float | Callable[[datetime], float],
    day: datetime,
) -> dict[str, Any] | None:
    """Ventana de un día concreto, o ``None`` si ese día no sobra nada.

    ``points`` es la curva de previsión completa (``forecast_power``) y ``day``
    la medianoche local del día que interesa. Los cortes se interpolan entre
    puntos: la previsión viene cada media hora o cada hora, y decir «abre a las
    12:00» cuando abre a las 11:40 es media hora de energía regalada.

    ``baseline`` puede ser una cifra —el consumo típico de la casa, plano— o una
    función de la hora. Con el perfil horario deja de ser plano, y entonces la
    ventana puede **partirse**: si a la una pones el horno, esa hora no sobra
    nada aunque el sol siga dando. Por eso se devuelven además los `spans` (los
    tramos en los que de verdad sobra) y los `gaps` (los huecos de en medio):
    `start` y `end` son el primero y el último corte, y el kWh es la integral
    real del excedente, que ya descuenta los huecos.
    """
    umbral = baseline if callable(baseline) else (lambda _t: float(baseline))
    end_of_day = day + timedelta(days=1)
    curve = [(t, w) for t, w in points if day <= t < end_of_day]
    if len(curve) < 2:
        return None

    # Cruce de dos rectas: la previsión entre dos puntos y el umbral entre esos
    # mismos dos instantes. Con umbral plano se reduce al caso de siempre.
    def cross(a: tuple[datetime, float], b: tuple[datetime, float]) -> datetime:
        d0, d1 = a[1] - umbral(a[0]), b[1] - umbral(b[0])
        span = d1 - d0
        if span == 0:
            return a[0]
        ratio = max(min(-d0 / span, 1.0), 0.0)
        return a[0] + (b[0] - a[0]) * ratio

    # Tramos con excedente. Se recorre la curva marcando dónde entra y dónde sale
    # de por encima del umbral; con el perfil horario puede entrar y salir varias
    # veces en el mismo día.
    spans: list[tuple[datetime, datetime]] = []
    abierto: datetime | None = None
    if curve[0][1] > umbral(curve[0][0]):
        abierto = curve[0][0]
    for index in range(len(curve) - 1):
        left, right = curve[index], curve[index + 1]
        sube = left[1] <= umbral(left[0]) and right[1] > umbral(right[0])
        baja = left[1] > umbral(left[0]) and right[1] <= umbral(right[0])
        if sube and abierto is None:
            abierto = cross(left, right)
        elif baja and abierto is not None:
            spans.append((abierto, cross(left, right)))
            abierto = None
    # La previsión puede acabar aún por encima (curva recortada, o un día en el
    # que se pone el sol generando).
    if abierto is not None:
        spans.append((abierto, curve[-1][0]))
    spans = [(a, b) for a, b in spans if b > a]
    if not spans:
        return None

    start, end = spans[0][0], spans[-1][1]

    # Energía que sobra: la integral del excedente dentro de cada tramo, con los
    # extremos interpolados para no contar de más ni de menos.
    def integrar(a: datetime, b: datetime) -> tuple[float, float]:
        dentro = [(t, w) for t, w in curve if a < t < b]
        shape = [(a, umbral(a))] + dentro + [(b, umbral(b))]
        wh = 0.0
        alto = 0.0
        for i in range(len(shape) - 1):
            (t0, w0), (t1, w1) = shape[i], shape[i + 1]
            horas = (t1 - t0).total_seconds() / 3600.0
            sobre0 = max(w0 - umbral(t0), 0.0)
            sobre1 = max(w1 - umbral(t1), 0.0)
            wh += (sobre0 + sobre1) / 2.0 * horas
            alto = max(alto, sobre0, sobre1)
        return wh, alto

    detalle = []
    surplus_wh = 0.0
    peak = 0.0
    for a, b in spans:
        wh, alto = integrar(a, b)
        surplus_wh += wh
        peak = max(peak, alto)
        detalle.append({
            "start": a.isoformat(), "end": b.isoformat(),
            "hours": round((b - a).total_seconds() / 3600.0, 3),
            "kwh": round(wh / 1000.0, 3),
        })

    gaps = [
        {"start": spans[i][1].isoformat(), "end": spans[i + 1][0].isoformat(),
         "hours": round((spans[i + 1][0] - spans[i][1]).total_seconds() / 3600.0, 3)}
        for i in range(len(spans) - 1)
    ]

    # `hours` es el hueco de punta a punta —lo que dice la tarjeta— y `net_hours`
    # el tiempo en el que de verdad sobra. Sin huecos son lo mismo.
    hours = (end - start).total_seconds() / 3600.0
    net_hours = sum(item["hours"] for item in detalle)
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "hours": round(hours, 3),
        "net_hours": round(net_hours, 3),
        "kwh": round(surplus_wh / 1000.0, 3),
        # La media es lo que se puede enchufar y mantener; el pico, lo que cabe
        # en el mejor momento. La media se saca del tiempo con excedente, no del
        # hueco entero: si no, un día con un agujero de dos horas saldría más
        # flojo de lo que es.
        "surplus_w": round(surplus_wh / net_hours, 1) if net_hours > 0 else 0.0,
        "peak_w": round(peak, 1),
        "spans": detalle,
        "gaps": gaps,
    }


# ---------------------------------------------------------------------------
# Estado de carga de la batería
# ---------------------------------------------------------------------------
# Va en un gráfico propio debajo del de potencia y no como una serie más: un
# porcentaje no comparte eje con los vatios, y meterlo en el mismo eje dejaría
# la curva del 0 al 100 pegada al suelo frente a picos de 3.000 W.


def _soc_block(
    result: dict[str, Any],
    entity: str,
    tz,
    x_keys: list[str],
) -> dict[str, Any] | None:
    """Bloque `soc` del payload, o ``None`` si el sensor no tiene datos.

    Comparte el eje X con el gráfico de arriba —los mismos `x_keys`— para que
    las dos curvas se lean a la misma altura del día.
    """
    if not entity:
        return None
    rows = _extract(result, entity, "mean", tz, 1.0)
    if not rows:
        return None
    # Un porcentaje fuera de 0–100 es un sensor mal escalado, no un dato: se
    # recorta en vez de deformar el eje.
    rows = {k: min(max(v, 0.0), 100.0) for k, v in rows.items()}
    values = _align(x_keys, rows)
    medidos = [v for v in values if v is not None]
    if not medidos:
        return None
    return {
        "unit": "%",
        "series": [_series("battery_soc", "Carga", values)],
        "min": round(min(medidos), 1),
        "max": round(max(medidos), 1),
        "last": round(medidos[-1], 1),
        "avg": round(sum(medidos) / len(medidos), 1),
    }


async def flow_curves(
    settings: dict[str, Any],
    states: dict[str, Any],
    start: datetime,
    end: datetime,
    tz,
    extra: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Las seis potencias del día y el estado de carga, en pasos de 5 minutos.

    Es lo que necesita el diagrama del flujo para poder recorrer el día: en cada
    muestra hay que repartir la potencia entre los seis enlaces, y para eso hacen
    falta las seis curvas a la vez sobre el **mismo eje**. Una sola llamada a
    ``ws_statistics``: cada llamada abre un socket y se trae la lista entera de
    metadatos, así que pedirlas por separado costaría siete veces lo mismo.

    ``extra`` son curvas de potencia adicionales (clave → entidad): los
    electrodomésticos, que van en la **misma** petición por lo mismo.

    Devuelve ``{"x": [iso…], "power": {clave: [W|None]}, "soc": [%|None]}``.
    """
    flow = settings.get("flow_sensors") or {}
    pares = [
        ("pv", flow.get("pv", "")),
        ("home", flow.get("home", "")),
        ("battery_charge", flow.get("battery_charge", "")),
        ("battery_discharge", flow.get("battery_discharge", "")),
        ("grid_import", flow.get("grid_import", "")),
        ("grid_export", flow.get("grid_export", "")),
    ]
    pares += [(clave, entidad) for clave, entidad in (extra or {}).items() if entidad]
    soc_entity = flow.get("battery_soc") or ""
    ids = list(dict.fromkeys([s for _k, s in pares if s] + ([soc_entity] if soc_entity else [])))
    x_keys = [moment.isoformat() for moment in _grid(start, end, 5)]
    if not ids:
        return {"x": x_keys, "power": {}, "soc": None}

    results, units = await ws_statistics(
        settings,
        [{"ids": ids, "start": start, "end": end, "period": "5minute", "types": ["mean"]}],
    )
    main = results[0]
    curves: dict[str, dict[str, float]] = {}
    for key, sensor in pares:
        if not sensor:
            continue
        curves[key] = _extract(main, sensor, "mean", tz, _unit_factor(sensor, states, "power", units))
    # Un medidor bidireccional en las dos casillas se reparte por signo; en el
    # resto, un negativo no es una magnitud válida (la casa no genera).
    split_signed_buckets(curves, flow, POWER_PAIRS)
    curves = {k: {t: max(v, 0.0) for t, v in data.items()} for k, data in curves.items()}

    soc = None
    if soc_entity:
        rows = _extract(main, soc_entity, "mean", tz, 1.0)
        if rows:
            soc = _align(x_keys, {t: min(max(v, 0.0), 100.0) for t, v in rows.items()})
    return {
        "x": x_keys,
        "power": {k: _align(x_keys, data) for k, data in curves.items() if data},
        "soc": soc,
    }


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


def _group_buckets(
    buckets: dict[str, float], period: str, range_key: str
) -> dict[str, float]:
    """Agrupa buckets finos en los del gráfico (día, mes o año)."""
    out: dict[str, float] = {}
    for iso, value in buckets.items():
        if range_key == "total":
            key = iso[:4]
        else:
            moment = _midnight(datetime.fromisoformat(iso))
            key = (moment.replace(day=1) if period == "month" else moment).isoformat()
        out[key] = out.get(key, 0.0) + value
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


# Pares de sentido opuesto. Muchos medidores e inversores exponen un único
# sensor con signo (+ importa / − exporta, + carga / − descarga) en lugar de dos
# sensores separados: si el mismo sensor está en las dos casillas, se reparte
# por signo en vez de leerlo dos veces.
POWER_PAIRS = (("grid_import", "grid_export"), ("battery_charge", "battery_discharge"))
ENERGY_PAIRS = (
    ("grid_import_energy", "grid_export_energy"),
    ("battery_charge_energy", "battery_discharge_energy"),
)


# Contador de energía que corresponde a cada serie de potencia: el total de la
# leyenda sale de ahí, no de integrar la curva.
SERIES_COUNTER = {
    "solar": "pv_energy",
    "home": "home_energy",
    "battery_charge": "battery_charge_energy",
    "battery_discharge": "battery_discharge_energy",
    "grid_import": "grid_import_energy",
    "grid_export": "grid_export_energy",
}
# El mismo mapa al revés: de qué curva de potencia se puede sacar cada contador
# cuando el contador no tiene estadísticas.
COUNTER_SERIES = {energy: key for key, energy in SERIES_COUNTER.items()}


def shares_sensor(cfg: dict[str, str], pos: str, neg: str) -> bool:
    """¿Las dos direcciones del par salen del mismo sensor?"""
    return bool(cfg.get(pos)) and cfg.get(pos) == cfg.get(neg)


def split_signed_buckets(
    data: dict[str, dict[str, float]], cfg: dict[str, str], pairs
) -> None:
    """Reparte por signo, bucket a bucket, los pares que comparten sensor."""
    for pos, neg in pairs:
        if not shares_sensor(cfg, pos, neg):
            continue
        buckets = dict(data.get(pos) or {})
        if not buckets:
            # Sin datos no hay nada que repartir, y crear las dos claves vacías
            # haría pasar por «cero medido» lo que en realidad es «sin datos».
            continue
        data[pos] = {k: (v if v > 0 else 0.0) for k, v in buckets.items()}
        data[neg] = {k: (-v if v < 0 else 0.0) for k, v in buckets.items()}


def clamp_buckets(data: dict[str, dict[str, float]]) -> None:
    """Recorta a cero los incrementos negativos de los contadores.

    Un `change` negativo no es energía negativa: es un contador que se ha
    reiniciado (los diarios lo hacen a medianoche) o un sensor que ha dado un
    valor menor que el anterior. Si se sumara, restaría del total. Los pares
    bidireccionales tienen que haberse repartido por signo **antes** de esto.
    """
    for key, buckets in data.items():
        data[key] = {k: (v if v > 0 else 0.0) for k, v in buckets.items()}


def split_signed_values(values: dict[str, float], cfg: dict[str, str], pairs) -> None:
    """Igual que ``split_signed_buckets`` pero con un único valor por clave."""
    for pos, neg in pairs:
        if not shares_sensor(cfg, pos, neg):
            continue
        raw = values.get(pos)
        if raw is None:
            continue
        values[pos] = raw if raw > 0 else 0.0
        values[neg] = -raw if raw < 0 else 0.0


def power_flows(power: dict[str, float]) -> dict[str, float]:
    """Reparte la potencia instantánea entre los seis flujos posibles.

    Vive aquí y no en ``live`` porque la usan los dos: la tarjeta de «Ahora
    mismo», con la potencia del estado de los sensores, y el diagrama del día,
    con cada muestra de cinco minutos del histórico. El diseño del flujo v2
    deriva el reparto de la producción y el consumo porque su prototipo no tiene
    telemetría; aquí no hace falta deducirlo, porque los seis contadores están
    medidos. Con dos consecuencias buenas: sale un enlace más que el prototipo
    no puede producir (red→batería, cargar de red de noche) y no hay que
    integrar el estado de carga para saber si la batería podía dar o recibir.

    Todas las magnitudes en W.
    """
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
    filas suman exactamente el total. El orden importa cuando los contadores no
    cuadran entre sí: **la red va primero y entera**, porque lo importado que no
    ha cargado la batería no tiene otro sitio al que ir y lo mide el contador de
    la compañía; el sol y la batería se reparten el resto a prorrata. Sin medida
    directa (``None``), el consumo se deduce por balance.

    Un cero **sí** es una medida: si en ese intervalo el contador dice que la
    casa no ha consumido, no hay que deducir nada. Deducirlo hacía que la suma
    de los intervalos se pasara del total del contador. Quien llama es el que
    decide si el contador sirve, y pasa ``None`` cuando no.

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
    battery_to_grid = max(export - to_grid, 0.0)

    # Lo que cada origen entregó a la casa, por eliminación: lo que salió de ese
    # punto y no fue a ningún otro sitio medido.
    grid_home = max(imported - grid_to_battery, 0.0)
    battery_home = max(discharge - battery_to_grid, 0.0)

    if home_measured is not None and home_measured >= 0:
        home_total = home_measured
        # La red va primero, y entera. Lo importado que no ha cargado la batería
        # no tiene otro sitio al que ir: es una entrega **medida** por el
        # contador de la compañía, no una estimación, y el reparto intervalo a
        # intervalo ya descuenta los tramos en los que sí carga la batería.
        # Ponerla a competir con los demás la dejaba corta —o a cero— cuando los
        # contadores no cuadran, que es justo cuando más se mira.
        from_grid = min(grid_home, home_total)
        rest = max(home_total - from_grid, 0.0)
        # El sol y la batería se reparten lo que queda a prorrata de lo que cada
        # uno pudo aportar. Con contadores coherentes la suma es exactamente ese
        # resto, el factor vale 1 y esto no cambia nada.
        supply = (to_home, battery_home)
        offered = sum(supply)
        if offered > rest and offered > 0:
            factor = rest / offered
            from_solar, from_battery = (part * factor for part in supply)
        else:
            # Ni con todo se cubre el consumo medido: el hueco entra por la red,
            # que es lo único que puede aportar sin que lo vea otro contador.
            from_solar, from_battery = supply
            from_grid = max(home_total - offered, 0.0)
    else:
        from_solar = to_home
        from_battery = battery_home
        from_grid = grid_home
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
        "battery_to_grid": battery_to_grid,
    }



def rescale_flows(flows: dict[str, float], totals: dict[str, float]) -> dict[str, float]:
    """Escala el reparto para que cada columna cuadre con su contador.

    El reparto se calcula sobre las estadísticas, que van con hasta cinco
    minutos de retraso respecto al estado del sensor. Sin este ajuste, el total
    del desglose y el del contador —que es lo que enseña la leyenda, y con lo
    que el usuario compara— se separan. ``flows`` y ``totals`` en la misma
    unidad.
    """
    out = dict(flows)

    def fit(parts: tuple[str, ...], target: float | None) -> float:
        total = sum(out[key] for key in parts)
        if target is not None and target > 0 and total > 0:
            factor = target / total
            for key in parts:
                out[key] *= factor
            return target
        return total

    fit(("to_home", "to_battery", "to_grid"), totals.get("pv_energy"))
    out["home_total"] = fit(
        ("from_solar", "from_battery", "from_grid"), totals.get("home_energy")
    )
    return out


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

    # Previsión de generación: solo si el intervalo alcanza tiempo futuro. Va
    # tanto en la vista general como en la de solar, que es como está en la
    # maqueta: la general del día lleva la punteada de las horas que quedan.
    forecast_points: list[tuple[datetime, float]] = []
    if view in ("overview", "solar") and end > now:
        forecast_points = forecast_power(_forecast_states(settings, states), tz)
        forecast_points = [p for p in forecast_points if start <= p[0] <= end]

    # Lo que se dibuja depende de la vista, pero el reparto necesita todas las
    # magnitudes. Se piden todas las potencias configuradas (va en la misma
    # petición) y se dibujan solo las de la vista.
    all_power = [
        ("solar", flow.get("pv", "")),
        ("home", flow.get("home", "")),
        ("battery_charge", flow.get("battery_charge", "")),
        ("battery_discharge", flow.get("battery_discharge", "")),
        ("grid_import", flow.get("grid_import", "")),
        ("grid_export", flow.get("grid_export", "")),
    ]
    ids = [sensor for _k, _l, sensor in wanted if sensor]
    power_ids = list(dict.fromkeys(sensor for _k, sensor in all_power if sensor))
    # El estado de carga va en su propio gráfico, debajo del de potencia: es un
    # porcentaje y no comparte eje con los vatios. Se pide en la misma consulta.
    soc_entity = (flow.get("battery_soc") or "") if view == "battery" else ""
    if soc_entity:
        power_ids = list(dict.fromkeys(power_ids + [soc_entity]))
    if not ids and not forecast_points and not soc_entity:
        return {"unit": "W", "chart": "line", "x": [], "series": [],
                "breakdown": None, "soc": None}

    if not ids and not soc_entity:
        grid = _grid(start, end, 5)
        values = _interpolate(forecast_points, grid)
        x_keys = [moment.isoformat() for moment in grid]
        forecast = _series(
            "forecast", "Previsión", _align(x_keys, values),
            dashed=True, legend=False, total_unit="kWh",
        )
        return {"unit": "W", "chart": "line", "x": x_keys,
                "series": [forecast], "breakdown": None, "soc": None}

    requests = [
        {"ids": power_ids, "start": start, "end": end, "period": "5minute", "types": ["mean"]}
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
    # Energía del día: para el desglose y, sobre todo, para los totales de la
    # leyenda. La curva del gráfico es potencia, pero su total en kWh tiene que
    # ser el del contador, no la integral de la potencia (que es una
    # aproximación y no coincidiría con el sensor ni con los demás rangos).
    energy_cfg = settings.get("energy_sensors") or {}
    energy_keys = ENERGY_KEYS
    energy_ids = [energy_cfg.get(k) for k in energy_keys if energy_cfg.get(k)]
    energy_index = None
    yesterday_index = None
    # El día en curso se resuelve con los mismos totales que la Home (más
    # abajo); para días pasados se piden aquí, en pasos de 5 minutos (no el
    # bucket diario, que se consolida por horas).
    is_today = end > now
    if energy_ids and not is_today:
        energy_index = len(requests)
        requests.append(
            {"ids": energy_ids, "start": start, "end": end,
             "period": "5minute", "types": ["change"]}
        )
    if energy_ids and show_yesterday:
        yesterday_index = len(requests)
        requests.append(
            {"ids": energy_ids, "start": start - timedelta(days=1),
             "end": end - timedelta(days=1), "period": "5minute", "types": ["change"]}
        )

    results, units = await ws_statistics(settings, requests)
    main = results[0]

    # Un sensor bidireccional en las dos casillas se reparte por signo; en el
    # resto, un valor negativo no es una magnitud válida y se trata como cero
    # (si no, el gráfico y su total saldrían por debajo de cero).
    curves: dict[str, dict[str, float]] = {}
    for key, sensor in all_power:
        if not sensor:
            continue
        factor = _unit_factor(sensor, states, "power", units)
        curves[key] = _extract(main, sensor, "mean", tz, factor)
    split_signed_buckets(curves, flow, POWER_PAIRS)
    curves = {
        key: {k: max(v, 0.0) for k, v in data.items()} for key, data in curves.items()
    }
    drawn = [(key, label_s) for key, label_s, sensor in wanted if sensor]

    # El eje cubre el día completo (00–24) aunque falten datos futuros.
    keys = {moment.isoformat() for moment in _grid(start, end, 5)}
    keys.update(k for key, _l in drawn for k in curves.get(key) or {})
    x_keys = _sorted_keys(keys)
    series = [
        _series(key, label_s, _align(x_keys, curves.get(key) or {}))
        for key, label_s in drawn
    ]

    if show_yesterday and len(results) > 1 and ids:
        factor = _unit_factor(ids[0], states, "power", units)
        yday = _extract(results[1], ids[0], "mean", tz, factor)
        # Se desplaza un día para superponerla sobre el mismo eje horario.
        shifted = {
            (datetime.fromisoformat(k) + timedelta(days=1)).isoformat(): max(v, 0.0)
            for k, v in yday.items()
        }
        series.append(_series("yesterday", "Ayer", _align(x_keys, shifted)))

    for item in series:
        item["total_label"] = "total"
        item["total_unit"] = "kWh"

    if forecast_points:
        grid = [datetime.fromisoformat(k) for k in x_keys]
        values = _interpolate(forecast_points, grid)
        # Solo la parte futura; del pasado ya informa la serie medida. La
        # maqueta pide que la punteada «arranque exactamente en el último punto
        # real», así que el corte es ese punto y no la hora del reloj: el
        # estadístico del recorder va unos minutos por detrás, y cortando por el
        # reloj quedaba un hueco entre la línea continua y la punteada.
        cut = now - timedelta(
            minutes=now.minute % 5, seconds=now.second, microseconds=now.microsecond
        )
        medidos = curves.get("solar") or {}
        if medidos:
            # `min` y no el último punto a secas: si el sensor va *adelantado*
            # respecto al reloj, la previsión no debe empezar más tarde que
            # ahora y dejar el tramo de en medio sin nada.
            cut = min(cut, datetime.fromisoformat(max(medidos)))
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

    def counters(result: dict[str, Any]) -> tuple[dict[str, float], dict[str, dict[str, float]]]:
        """(total por clave, valor por bucket) de los contadores de energía.

        Solo aparecen las claves con estadísticas. Un contador **sin datos** no
        es un contador que marque cero: si se colara como cero, se enseñaría
        como un dato medido («ayer no importaste nada») y taparía el respaldo.
        """
        by_key: dict[str, dict[str, float]] = {}
        for key in energy_keys:
            sensor = energy_cfg.get(key)
            if not sensor:
                continue
            factor = _unit_factor(sensor, states, "energy", units)
            rows = _extract(result, sensor, "change", tz, factor)
            if rows:
                by_key[key] = rows
        split_signed_buckets(by_key, energy_cfg, ENERGY_PAIRS)
        clamp_buckets(by_key)
        return ({k: sum(v.values()) for k, v in by_key.items() if v}, by_key)

    def with_power(by_key: dict[str, dict[str, float]]) -> dict[str, dict[str, float]]:
        """Rellena los contadores sin estadísticas integrando su potencia.

        Si no, el reparto daría ese origen por cero y le echaría la culpa al
        residuo: se veía «0 importada» en la leyenda y «4,2 kWh desde la red»
        en el desglose, dos cifras que se contradicen. Con el respaldo, las dos
        salen del mismo sitio.
        """
        out = dict(by_key)
        for energy_key, series_key in COUNTER_SERIES.items():
            if sum((out.get(energy_key) or {}).values()) > 0:
                continue
            curve = curves.get(series_key)
            if not curve:
                continue
            out[energy_key] = {
                iso: watts * (5.0 / 60.0) / 1000.0 for iso, watts in curve.items()
            }
        return out

    def flows_from(by_key: dict[str, dict[str, float]]) -> dict[str, float] | None:
        """Reparto sumado a partir de los incrementos por bucket."""
        per_bucket: dict[str, dict[str, float]] = {}
        for key, buckets in by_key.items():
            for iso, value in buckets.items():
                per_bucket.setdefault(iso, {})[key] = value
        # El contador de la casa sirve si suma algo en el periodo. Si no (no está
        # configurado, o el sensor está invertido y se ha recortado a cero), el
        # consumo se deduce por balance en todos los intervalos, no en unos sí y
        # en otros no: mezclar las dos cosas descuadraba el total.
        measured = sum((by_key.get("home_energy") or {}).values()) > 0
        parts = [
            split_flows(
                v.get("pv_energy", 0.0), v.get("battery_charge_energy", 0.0),
                v.get("grid_export_energy", 0.0), v.get("grid_import_energy", 0.0),
                v.get("battery_discharge_energy", 0.0),
                v.get("home_energy") if measured else None,
            )
            for v in per_bucket.values()
        ]
        if not parts:
            return None
        return {k: sum(p[k] for p in parts) for k in parts[0]}

    # El reparto se hace bucket a bucket: sobre el total del día se perdería a
    # qué hora ocurre cada cosa (una carga de red de madrugada parecería solar).
    flows: dict[str, float] | None = None
    totals: dict[str, float] = {}
    if energy_index is not None:
        totals, by_key = counters(results[energy_index])
        flows = flows_from(with_power(by_key))
        if flows:
            flows = rescale_flows(flows, totals)
    elif energy_ids and is_today:
        # Mismos totales y mismo reparto que la Home (cacheados allí), para que
        # las dos pantallas coincidan. Import local: `live` importa este módulo.
        import live  # noqa: PLC0415

        daily = await live.daily_energy(settings, states, tz, now)
        totals = {k: v / 1000.0 for k, v in daily["totals"].items()}
        if daily["flows"]:
            # El mismo ajuste que hace la Home, para que las dos pantallas den
            # la misma cifra: el contador manda sobre las estadísticas.
            flows = rescale_flows(
                {k: v / 1000.0 for k, v in daily["flows"].items()}, totals
            )
    else:
        # Sin contadores de energía, el reparto sale de integrar las potencias.
        flows = flows_from(with_power({}))

    # Total de la leyenda, por orden de preferencia:
    #
    #  1. El contador de esa magnitud.
    #  2. Para la casa sin contador (o con uno inservible), el total que deduce
    #     el reparto por balance: es el mismo que muestra «Origen del consumo»
    #     justo debajo, así que las dos cifras coinciden.
    #  3. La integral de la potencia, que es una aproximación y solo queda para
    #     la previsión (no hay contador de algo que aún no ha pasado).
    yesterday_totals: dict[str, float] = {}
    yesterday_flows: dict[str, float] | None = None
    if yesterday_index is not None:
        yesterday_totals, yesterday_by_key = counters(results[yesterday_index])
        yesterday_flows = flows_from(yesterday_by_key)
    for item in series:
        integral = _sum(item["values"]) * (5.0 / 60.0) / 1000.0
        is_yesterday = item["key"] == "yesterday"
        base = wanted[0][0] if is_yesterday else item["key"]
        source = yesterday_totals if is_yesterday else totals
        key = SERIES_COUNTER.get(base)
        counter = source.get(key) if key else None
        if not counter:
            # Un contador a cero no manda sobre una curva que sí mide: o no
            # está midiendo, o todavía no ha empezado. Se cae al respaldo.
            counter = None
            if base == "home":
                deduced = (yesterday_flows if is_yesterday else flows) or {}
                counter = deduced.get("home_total") or None
        if counter is None and not any(v is not None for v in item["values"]):
            # Ni contador ni curva: no hay dato. Un cero aquí sería inventárselo.
            item["total"] = None
            continue
        item["total"] = round(counter if counter is not None else integral, 2)

    breakdown = _make_breakdown(_breakdown_rows(view, [flows])) if flows else None

    return {"unit": "W", "chart": "line", "x": x_keys, "series": series,
            "breakdown": breakdown, "soc": _soc_block(main, soc_entity, tz, x_keys)}


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
        return {"unit": "kWh", "chart": "line", "x": [], "series": [],
                "breakdown": None, "soc": None}

    requests = [
        {"ids": ids, "start": start, "end": end, "period": period, "types": ["change"]}
    ]
    # El estado de carga, para el gráfico de debajo. Aquí la media del bucket es
    # justo lo que interesa: dice si la batería cicla a fondo o se queda arriba.
    # En «total» los buckets del gráfico son años y los de la consulta meses: no
    # se pueden alinear, y una media anual de carga no dice nada. Se omite.
    soc_entity = ((settings.get("flow_sensors") or {}).get("battery_soc") or "") \
        if view == "battery" and range_key != "total" else ""
    soc_index = None
    if soc_entity:
        soc_index = len(requests)
        requests.append(
            {"ids": [soc_entity], "start": start, "end": end,
             "period": period, "types": ["mean"]}
        )
    # Buckets más finos que los del gráfico. Hacen falta para dos cosas:
    #
    #  - El desglose: con buckets de un día, una carga de batería desde la red
    #    de madrugada se confunde con la solar del mediodía.
    #  - Los sensores bidireccionales: en un bucket de un día un contador neto
    #    ya viene sumado (+6 = 18 importados − 12 exportados) y el signo ya no
    #    permite separar las dos direcciones.
    #
    # En año y total, una resolución horaria serían miles de buckets, así que se
    # baja solo a día (mejor que el mes del gráfico, aunque no exacto).
    signed = any(shares_sensor(energy, pos, neg) for pos, neg in ENERGY_PAIRS)
    wants_fine = signed or view in ("solar", "home", "overview")
    fine_period = None
    if wants_fine and range_key in ("week", "month"):
        fine_period = "hour"
    elif signed and range_key == "year":
        fine_period = "hour"   # ~8.760 buckets: es el precio de separar el signo
    elif signed and range_key == "total":
        fine_period = "day"    # 10 años por horas serían inviables: aproximado
    fine_index = None
    if fine_period:
        fine_index = len(requests)
        requests.append(
            {"ids": ids, "start": start, "end": end, "period": fine_period, "types": ["change"]}
        )

    results, units = await ws_statistics(settings, requests)
    raw = results[0]

    def extract_all(result: dict[str, Any]) -> dict[str, dict[str, float]]:
        out: dict[str, dict[str, float]] = {}
        for key in keys:
            sensor = energy.get(key)
            if not sensor:
                out[key] = {}
                continue
            factor = _unit_factor(sensor, states, "energy", units)
            out[key] = _extract(result, sensor, "change", tz, factor)
        split_signed_buckets(out, energy, ENERGY_PAIRS)
        clamp_buckets(out)
        return out

    fine = extract_all(results[fine_index]) if fine_index is not None else {}
    data = extract_all(raw)
    if signed and fine:
        # Con sensor bidireccional, el gráfico se construye agrupando los
        # buckets finos ya separados por signo (el bucket grueso no sirve).
        data = {
            key: _group_buckets(buckets, period, range_key)
            for key, buckets in fine.items()
        }

    # En «total» los meses se agrupan por año (ya hecho si venían de los finos).
    if range_key == "total" and not (signed and fine):
        data = {key: _group_buckets(buckets, period, range_key)
                for key, buckets in data.items()}

    # Previsión de generación para los buckets futuros (solo semana y mes, que
    # es el alcance de los integradores de forecast).
    fc_daily: dict[str, float] = {}
    if view in ("overview", "solar") and end > now and range_key in ("week", "month"):
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
    # Reparto por bucket con el mismo modelo que la Home. El contador de la casa
    # se usa como medida directa del total si suma algo en el periodo; si no (no
    # está configurado, o el sensor está invertido y se ha recortado a cero), el
    # consumo se deduce por balance en todos los intervalos por igual.
    measured = sum(home_e) > 0
    flows = [
        split_flows(p, c, e, i, d, h if measured else None)
        for p, c, e, i, d, h in zip(pv, bc, ge, gi, bd, home_e)
    ]

    # Si se han pedido buckets finos, el reparto se hace sobre ellos y luego se
    # agrupa en los buckets del gráfico: es más exacto (una carga de red de
    # madrugada no se confunde con el sol del mediodía) y, sobre todo, la línea
    # de la casa sale del **mismo** reparto que el desglose, así que su total
    # coincide con «Origen del consumo» en lugar de contradecirlo.
    fine_flows = flows
    fine_home: dict[str, float] | None = None
    if fine:
        by_moment: dict[str, dict[str, float]] = {}
        for key, buckets in fine.items():
            for iso, value in buckets.items():
                by_moment.setdefault(iso, {})[key] = max(value, 0.0)
        if by_moment:
            per_moment = {
                iso: split_flows(
                    v.get("pv_energy", 0.0), v.get("battery_charge_energy", 0.0),
                    v.get("grid_export_energy", 0.0), v.get("grid_import_energy", 0.0),
                    v.get("battery_discharge_energy", 0.0),
                    v.get("home_energy") if measured else None,
                )
                for iso, v in by_moment.items()
            }
            fine_flows = list(per_moment.values())
            fine_home = _group_buckets(
                {iso: f["home_total"] for iso, f in per_moment.items()}, period, range_key
            )

    if fine_home is not None:
        home_total = [fine_home.get(x, 0.0) for x in x_keys]
    else:
        home_total = [item["home_total"] for item in flows]

    series: list[dict[str, Any]] = []
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
            "breakdown": breakdown,
            "soc": _soc_block(results[soc_index], soc_entity, tz, x_keys)
                   if soc_index is not None else None}

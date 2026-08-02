"""Fuentes de datos de consumo: Home Assistant, InfluxDB y modo demo.

Todas devuelven una serie horaria: lista de {"start": datetime local tz-aware,
"kwh": float} con el consumo (delta) de cada hora del rango pedido.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)


class SourceError(Exception):
    """Error recuperable al consultar una fuente de datos."""


# ---------------------------------------------------------------------------
# Home Assistant
# ---------------------------------------------------------------------------


def _ha_endpoints(settings: dict[str, Any]) -> tuple[str, str, str]:
    """Devuelve (base REST, URL websocket, token) según el entorno.

    Dentro del add-on se usa el proxy del Supervisor con SUPERVISOR_TOKEN;
    fuera (desarrollo) se usan ha_url/ha_token de los ajustes.
    """
    supervisor_token = os.environ.get("SUPERVISOR_TOKEN")
    if supervisor_token:
        return (
            "http://supervisor/core/api",
            "ws://supervisor/core/websocket",
            supervisor_token,
        )
    ha_url = (settings.get("ha_url") or "").rstrip("/")
    token = settings.get("ha_token") or ""
    if not ha_url or not token:
        raise SourceError(
            "Configura la URL y el token de Home Assistant (o ejecuta como add-on)."
        )
    ws_url = ha_url.replace("https://", "wss://").replace("http://", "ws://")
    return f"{ha_url}/api", f"{ws_url}/api/websocket", token


async def ha_hourly_consumption(
    settings: dict[str, Any], start: datetime, end: datetime, tz, entity: str
) -> list[dict[str, Any]]:
    """Consumo horario desde las estadísticas de largo plazo de HA.

    Usa el comando websocket ``recorder/statistics_during_period`` con
    periodo horario y el campo ``change`` (delta de energía por hora).
    """
    if not entity:
        raise SourceError(
            "Falta el contador de energía importada de la red: "
            "elígelo en Ajustes → Sensores."
        )
    base, ws_url, token = _ha_endpoints(settings)

    payload = {
        "id": 1,
        "type": "recorder/statistics_during_period",
        "start_time": start.isoformat(),
        "end_time": end.isoformat(),
        "statistic_ids": [entity],
        "period": "hour",
        "types": ["change", "state"],
    }

    result: dict[str, Any] = {}
    stat_ids: list[dict[str, Any]] = []
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(ws_url, timeout=aiohttp.ClientTimeout(total=20)) as ws:
            msg = await ws.receive_json()  # auth_required
            if msg.get("type") == "auth_required":
                await ws.send_json({"type": "auth", "access_token": token})
                msg = await ws.receive_json()
                if msg.get("type") != "auth_ok":
                    raise SourceError("Autenticación websocket rechazada por Home Assistant.")
            await ws.send_json(payload)
            # Pedimos también la unidad de la estadística para convertir a kWh.
            await ws.send_json({"id": 2, "type": "recorder/list_statistic_ids"})
            pending = {1, 2}
            while pending:
                msg = await ws.receive_json()
                mid = msg.get("id")
                if mid not in pending or msg.get("type") != "result":
                    continue
                if mid == 1:
                    if not msg.get("success"):
                        raise SourceError(
                            f"Error de Home Assistant: {msg.get('error', {}).get('message')}"
                        )
                    result = msg.get("result") or {}
                elif mid == 2 and msg.get("success"):
                    stat_ids = msg.get("result") or []
                pending.discard(mid)

    # Factor de conversión a kWh según la unidad real de la estadística.
    unit = ""
    for item in stat_ids:
        if item.get("statistic_id") == entity:
            unit = (
                item.get("statistics_unit_of_measurement")
                or item.get("unit_of_measurement")
                or ""
            )
            break
    unit_factor = {"Wh": 0.001, "MWh": 1000.0}.get(unit, 1.0)

    rows = result.get(entity) or []
    series: list[dict[str, Any]] = []
    last_state: float | None = None
    for row in rows:
        raw_start = row.get("start")
        if isinstance(raw_start, (int, float)):
            dt = datetime.fromtimestamp(raw_start / 1000.0, tz)
        else:
            dt = datetime.fromisoformat(str(raw_start)).astimezone(tz)
        if row.get("state") is not None:
            last_state = float(row["state"])
        change = row.get("change")
        if change is None:
            continue
        series.append({"start": dt, "kwh": max(0.0, float(change) * unit_factor)})

    # Las estadísticas horarias van por detrás del estado en vivo del sensor
    # (la hora en curso aún no está consolidada). Añadimos esa "cola" leyendo
    # el estado actual, para que el total cuadre con lo que se ve en HA.
    # Solo aplica al ciclo actual: si se consulta un periodo pasado, el estado
    # en vivo no corresponde a ese tramo y no debe sumarse.
    now_local = datetime.now(tz)
    if end.astimezone(tz) >= now_local - timedelta(hours=1):
        tail = await _ha_live_tail(base, token, entity, last_state, unit_factor)
        if tail > 0:
            hour = now_local.replace(minute=0, second=0, microsecond=0)
            series.append({"start": hour, "kwh": tail})
    return series


async def _ha_live_tail(
    base: str, token: str, entity: str, last_state: float | None, unit_factor: float
) -> float:
    """kWh consumidos desde la última hora consolidada hasta el estado actual.

    Devuelve 0 si no se puede leer el estado, si el sensor se reinició
    (delta negativo) o si no hay estadística previa con la que comparar.
    """
    if last_state is None:
        return 0.0
    try:
        headers = {"Authorization": f"Bearer {token}"}
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.get(
                f"{base}/states/{entity}", timeout=aiohttp.ClientTimeout(total=10)
            ) as resp:
                if resp.status != 200:
                    return 0.0
                state = (await resp.json()).get("state")
        live = float(state)
    except (aiohttp.ClientError, ValueError, TypeError, asyncio.TimeoutError):
        return 0.0
    delta = (live - last_state) * unit_factor
    # Descarta reinicios de contador o saltos absurdos (> 100 kWh/hora).
    if delta <= 0 or delta > 100:
        return 0.0
    return delta


# ---------------------------------------------------------------------------
# InfluxDB (v1 InfluxQL y v2 Flux)
# ---------------------------------------------------------------------------


def _ids(entity: str) -> tuple[str, str]:
    """Las dos formas del `entity_id`, porque InfluxDB guarda una y HA usa otra.

    La integración de InfluxDB de Home Assistant escribe la etiqueta `entity_id`
    con el **object_id pelado**: `grid_import`, no `sensor.grid_import`. Una
    consulta que pregunte por el id completo no encuentra nada — ni un error, ni
    una fila: nada. Se piden las dos y así vale igual si alguien tiene la base
    escrita de otra manera.
    """
    corto = entity.split(".", 1)[1] if "." in entity else entity
    return corto, entity


async def influx_hourly_consumption(
    settings: dict[str, Any], start: datetime, end: datetime, tz, entity: str
) -> list[dict[str, Any]]:
    influx = dict(settings.get("influx") or {})
    influx["entity_id"] = entity
    version = int(influx.get("version") or 2)
    if version == 1:
        cumulative = await _influx_v1_hourly(influx, start, end)
    else:
        cumulative = await _influx_v2_hourly(influx, start, end)
    return _diff_cumulative(cumulative, tz)


async def _influx_v1_hourly(
    influx: dict[str, Any], start: datetime, end: datetime
) -> list[tuple[str, float]]:
    url = (influx.get("url") or "").rstrip("/")
    if not url:
        raise SourceError("Configura la URL de InfluxDB.")
    measurement = influx.get("measurement") or "kWh"
    entity = influx.get("entity_id") or ""
    query = (
        f'SELECT last("value") FROM "{measurement}" '
        f"WHERE time >= '{start.isoformat()}' AND time < '{end.isoformat()}'"
    )
    if entity:
        corto, largo = _ids(entity)
        query += f" AND (\"entity_id\" = '{corto}' OR \"entity_id\" = '{largo}')"
    query += " GROUP BY time(1h) fill(previous)"

    params = {"db": influx.get("database") or "homeassistant", "q": query}
    auth = None
    if influx.get("username"):
        auth = aiohttp.BasicAuth(influx["username"], influx.get("password") or "")
    async with aiohttp.ClientSession(auth=auth) as session:
        async with session.get(
            f"{url}/query", params=params, timeout=aiohttp.ClientTimeout(total=30)
        ) as resp:
            if resp.status != 200:
                raise SourceError(f"InfluxDB respondió {resp.status}: {await resp.text()}")
            data = await resp.json()
    try:
        values = data["results"][0]["series"][0]["values"]
    except (KeyError, IndexError):
        return []
    return [(ts, val) for ts, val in values if val is not None]


async def _influx_v2_hourly(
    influx: dict[str, Any], start: datetime, end: datetime
) -> list[tuple[str, float]]:
    url = (influx.get("url") or "").rstrip("/")
    if not url:
        raise SourceError("Configura la URL de InfluxDB.")
    bucket = influx.get("database") or "homeassistant"
    measurement = influx.get("measurement") or "kWh"
    entity = influx.get("entity_id") or ""
    corto, largo = _ids(entity)
    entity_filter = (
        f' and (r["entity_id"] == "{corto}" or r["entity_id"] == "{largo}")'
        if entity else ""
    )
    flux = f"""
from(bucket: "{bucket}")
  |> range(start: {start.isoformat()}, stop: {end.isoformat()})
  |> filter(fn: (r) => r["_measurement"] == "{measurement}" and r["_field"] == "value"{entity_filter})
  |> aggregateWindow(every: 1h, fn: last, createEmpty: false)
"""
    headers = {
        "Authorization": f"Token {influx.get('token') or ''}",
        "Content-Type": "application/vnd.flux",
        "Accept": "application/csv",
    }
    params = {"org": influx.get("org") or ""}
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{url}/api/v2/query",
            params=params,
            data=flux,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            if resp.status != 200:
                raise SourceError(f"InfluxDB respondió {resp.status}: {await resp.text()}")
            text = await resp.text()

    values: list[tuple[str, float]] = []
    columns: dict[str, int] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        cells = line.split(",")
        if "_time" in cells and "_value" in cells:
            columns = {name: idx for idx, name in enumerate(cells)}
            continue
        if not columns:
            continue
        try:
            ts = cells[columns["_time"]]
            val = float(cells[columns["_value"]])
        except (KeyError, IndexError, ValueError):
            continue
        values.append((ts, val))
    values.sort(key=lambda item: item[0])
    return values


# ---------------------------------------------------------------------------
# Media horaria de un sensor instantáneo
# ---------------------------------------------------------------------------
# Lo de arriba lee un **contador** y lo diferencia. Esto lee la **media por
# hora** de un sensor de potencia, que es otra agregación: sirve para el perfil
# de consumo de la casa, y se pide a InfluxDB porque guarda meses donde el
# recorder de Home Assistant guarda diez días por defecto.


async def influx_hourly_mean(
    settings: dict[str, Any], entity: str, unit: str, start: datetime, end: datetime, tz
) -> list[tuple[datetime, float]]:
    """[(hora local, media)] de un sensor instantáneo, hora a hora.

    ``unit`` es la unidad del sensor: la integración de InfluxDB de Home
    Assistant usa la unidad como nombre de la medida («W» para una potencia),
    así que es lo que hay que buscar. En Flux se filtra además por `entity_id`,
    que es lo que de verdad identifica la serie.
    """
    influx = dict(settings.get("influx") or {})
    if not (influx.get("url") or "").strip():
        return []
    version = int(influx.get("version") or 2)
    if version == 1:
        crudo = await _influx_v1_mean(influx, entity, unit, start, end)
    else:
        crudo = await _influx_v2_mean(influx, entity, unit, start, end)
    out: list[tuple[datetime, float]] = []
    for ts, value in crudo:
        try:
            moment = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        except ValueError:
            continue
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        out.append((moment.astimezone(tz), value))
    out.sort(key=lambda item: item[0])
    return out


async def _influx_v1_mean(
    influx: dict[str, Any], entity: str, unit: str, start: datetime, end: datetime
) -> list[tuple[str, float]]:
    url = (influx.get("url") or "").rstrip("/")
    # La medida es la unidad del sensor. Si no se conoce se prueba con «W», que
    # es la de cualquier sensor de potencia.
    measurement = (unit or "W").replace('"', "")
    query = (
        f'SELECT mean("value") FROM "{measurement}" '
        f"WHERE time >= '{start.isoformat()}' AND time < '{end.isoformat()}'"
        f" AND \"entity_id\" = '{entity.replace('sensor.', '')}'"
        " GROUP BY time(1h)"
    )
    params = {"db": influx.get("database") or "homeassistant", "q": query}
    auth = None
    if influx.get("username"):
        auth = aiohttp.BasicAuth(influx["username"], influx.get("password") or "")
    async with aiohttp.ClientSession(auth=auth) as session:
        async with session.get(
            f"{url}/query", params=params, timeout=aiohttp.ClientTimeout(total=30)
        ) as resp:
            if resp.status != 200:
                raise SourceError(f"InfluxDB respondió {resp.status}: {await resp.text()}")
            data = await resp.json()
    try:
        values = data["results"][0]["series"][0]["values"]
    except (KeyError, IndexError):
        return []
    return [(ts, float(val)) for ts, val in values if val is not None]


async def _influx_v2_mean(
    influx: dict[str, Any], entity: str, unit: str, start: datetime, end: datetime
) -> list[tuple[str, float]]:
    url = (influx.get("url") or "").rstrip("/")
    bucket = influx.get("database") or "homeassistant"
    # Aquí no hace falta acertar con la medida: basta con `entity_id`, que es lo
    # que identifica la serie. Se filtra por medida solo si se conoce la unidad,
    # para no barrer el bucket entero.
    medida = f' r["_measurement"] == "{unit}" and' if unit else ""
    corto = entity.replace("sensor.", "")
    flux = f"""
from(bucket: "{bucket}")
  |> range(start: {start.isoformat()}, stop: {end.isoformat()})
  |> filter(fn: (r) =>{medida} r["_field"] == "value"
       and (r["entity_id"] == "{corto}" or r["entity_id"] == "{entity}"))
  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)
"""
    headers = {
        "Authorization": f"Token {influx.get('token') or ''}",
        "Content-Type": "application/vnd.flux",
        "Accept": "application/csv",
    }
    params = {"org": influx.get("org") or ""}
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{url}/api/v2/query", params=params, data=flux, headers=headers,
            timeout=aiohttp.ClientTimeout(total=30),
        ) as resp:
            if resp.status != 200:
                raise SourceError(f"InfluxDB respondió {resp.status}: {await resp.text()}")
            text = await resp.text()
    return _parse_flux_csv(text)


def _parse_flux_csv(text: str) -> list[tuple[str, float]]:
    values: list[tuple[str, float]] = []
    columns: dict[str, int] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        cells = line.split(",")
        if "_time" in cells and "_value" in cells:
            columns = {name: idx for idx, name in enumerate(cells)}
            continue
        if not columns:
            continue
        try:
            values.append((cells[columns["_time"]], float(cells[columns["_value"]])))
        except (KeyError, IndexError, ValueError):
            continue
    return values


def _diff_cumulative(values: list[tuple[str, float]], tz) -> list[dict[str, Any]]:
    """Convierte lecturas acumuladas horarias en deltas de consumo.

    Los reinicios de contador (delta negativo) se tratan como 0.
    """
    series: list[dict[str, Any]] = []
    prev: float | None = None
    for ts, val in values:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(tz)
        if prev is not None:
            delta = val - prev
            series.append({"start": dt, "kwh": delta if delta > 0 else 0.0})
        prev = val
    return series


# ---------------------------------------------------------------------------
# Demo: perfil sintético reproducible para probar la interfaz sin conexión
# ---------------------------------------------------------------------------


def demo_hourly_consumption(
    start: datetime, end: datetime, tz, kind: str = "import"
) -> list[dict[str, Any]]:
    series: list[dict[str, Any]] = []
    current = start.astimezone(tz).replace(minute=0, second=0, microsecond=0)
    end = end.astimezone(tz)
    while current < end:
        h = current.hour
        seed = hashlib.md5(current.strftime(f"%Y%m%d%H{kind}").encode()).digest()[0] / 255.0
        if kind == "export":
            # Vertido solar: campana centrada a mediodía.
            base = 0.9 * math.exp(-((h - 13) ** 2) / 7.0)
            kwh = base * (0.6 + 0.8 * seed) if 8 <= h <= 20 else 0.0
        else:
            base = 0.12
            # Picos de mañana y noche, más consumo en fin de semana a mediodía.
            base += 0.35 * math.exp(-((h - 9) ** 2) / 6.0)
            base += 0.55 * math.exp(-((h - 21) ** 2) / 5.0)
            if current.weekday() >= 5:
                base += 0.25 * math.exp(-((h - 14) ** 2) / 8.0)
            kwh = base * (0.75 + 0.5 * seed)
        series.append({"start": current, "kwh": round(kwh, 3)})
        current += timedelta(hours=1)
    return series


# ---------------------------------------------------------------------------
# Punto de entrada común
# ---------------------------------------------------------------------------


async def get_hourly_consumption(
    settings: dict[str, Any],
    start: datetime,
    end: datetime,
    tz,
    kind: str = "import",
) -> list[dict[str, Any]]:
    """Serie horaria de energía importada (kind="import") o vertida ("export").

    Los dos contadores son los mismos que usa el resto de la app: los de
    Ajustes → Sensores. No hay sensores «de facturación» aparte.

    Para "export", si no hay sensor configurado se devuelve una lista vacía
    (no es un error: simplemente no hay excedentes que compensar).
    """
    if (settings.get("source") or "demo") != "homeassistant":
        return demo_hourly_consumption(start, end, tz, kind)

    energia = settings.get("energy_sensors") or {}
    clave = "grid_export_energy" if kind == "export" else "grid_import_energy"
    entity = (energia.get(clave) or "").strip()
    if not entity:
        if kind == "export":
            return []
        raise SourceError(
            "Falta el contador de energía importada de la red: "
            "elígelo en Ajustes → Sensores."
        )

    # Si Home Assistant no contesta, esto **no** es el final del camino: puede
    # haber un InfluxDB con la misma serie. Antes el error salía disparado de
    # aquí y el respaldo no llegaba a intentarse.
    serie: list[dict[str, Any]] = []
    fallo_ha: Exception | None = None
    try:
        serie = await ha_hourly_consumption(settings, start, end, tz, entity)
    except (SourceError, aiohttp.ClientError, asyncio.TimeoutError) as err:
        fallo_ha = err
    if serie:
        return serie

    # Las estadísticas horarias de Home Assistant no se purgan, así que lo normal
    # es que respondan. Vacío significa que el contador nunca las generó —le falta
    # `state_class`, o se excluyó del recorder—, y entonces el mismo `entity_id`
    # en InfluxDB sí tiene la serie.
    influx = settings.get("influx") or {}
    if not (influx.get("url") or "").strip():
        if fallo_ha is not None:
            # Sin respaldo y con HA caído, la causa es esa y hay que decirla: un
            # cero en la factura y un error son cosas muy distintas.
            raise SourceError(f"Home Assistant no ha dado los datos: {fallo_ha}")
        _LOGGER.warning(
            "Sin datos de facturación (%s): «%s» no tiene estadísticas horarias en "
            "Home Assistant y no hay InfluxDB configurado de donde sacarlas. "
            "Comprueba que el sensor tenga `state_class: total` o "
            "`total_increasing`, o configura InfluxDB en Ajustes.",
            kind, entity,
        )
        return serie
    try:
        respaldo = await influx_hourly_consumption(settings, start, end, tz, entity)
    except SourceError as err:
        # Que no se quede en un vacío mudo: es lo que hacía imposible saber por
        # qué la facturación no traía nada teniendo la conexión establecida.
        _LOGGER.warning(
            "Sin datos de facturación (%s): «%s» no tiene estadísticas en Home "
            "Assistant y el respaldo de InfluxDB ha fallado: %s",
            kind, entity, err,
        )
        return serie
    if not respaldo and fallo_ha is not None:
        raise SourceError(
            f"Home Assistant no ha dado los datos ({fallo_ha}) y en InfluxDB no hay "
            f"ninguna fila para «{entity}» en la medida "
            f"«{influx.get('measurement') or 'kWh'}»."
        )
    if not respaldo:
        _LOGGER.warning(
            "Sin datos de facturación (%s): «%s» no tiene estadísticas en Home "
            "Assistant, y en InfluxDB no hay ninguna fila con ese entity_id en la "
            "medida «%s» de la base «%s». Revisa que la medida sea la **unidad** "
            "del contador (kWh, Wh…) en Ajustes → InfluxDB.",
            kind, entity, influx.get("measurement") or "kWh",
            influx.get("database") or "homeassistant",
        )
    else:
        _LOGGER.info(
            "Facturación (%s): «%s» sin estadísticas en Home Assistant, %d horas "
            "servidas desde InfluxDB.", kind, entity, len(respaldo),
        )
    return respaldo

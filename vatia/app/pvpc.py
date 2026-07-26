"""Precios horarios PVPC desde el archivo público de ESIOS (REE).

Usa el endpoint sin autenticación ``archives/70/download_json`` (el mismo que
emplean otras integraciones de la comunidad) y cachea cada día en /data para
no repetir descargas. Los precios se devuelven en €/kWh indexados por el
instante UTC de inicio de cada hora.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)

ESIOS_URL = "https://api.esios.ree.es/archives/70/download_json"
CACHE_PATH = os.path.join(os.environ.get("DATA_DIR", "/data"), "pvpc_cache.json")
MAX_CACHE_DAYS = 450


class PVPCError(Exception):
    """No se pudieron obtener los precios PVPC."""


_cache: dict[str, dict[str, float]] | None = None
_lock = asyncio.Lock()


def _load_cache() -> dict[str, dict[str, float]]:
    global _cache
    if _cache is None:
        try:
            with open(CACHE_PATH, encoding="utf-8") as fh:
                _cache = json.load(fh)
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save_cache() -> None:
    if _cache is None:
        return
    while len(_cache) > MAX_CACHE_DAYS:
        _cache.pop(min(_cache), None)
    try:
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        tmp = CACHE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_cache, fh)
        os.replace(tmp, CACHE_PATH)
    except OSError:  # pragma: no cover
        _LOGGER.warning("No se pudo escribir la caché PVPC", exc_info=True)


def _parse_day(payload: dict[str, Any], day: date, tz) -> dict[str, float]:
    """Convierte la respuesta de ESIOS en {iso_utc_hora: €/kWh}."""
    rows = payload.get("PVPC") or []
    midnight = datetime.combine(day, time.min, tzinfo=tz).astimezone(timezone.utc)
    prices: dict[str, float] = {}
    for idx, row in enumerate(rows):
        raw = row.get("PCB") or row.get("GEN")
        if raw is None:
            continue
        try:
            if isinstance(raw, (int, float)):
                eur_mwh = float(raw)
            else:
                # Formato español: "1.254,23" → 1254.23
                eur_mwh = float(raw.replace(".", "").replace(",", "."))
        except ValueError:
            continue
        instant = midnight + timedelta(hours=idx)
        prices[instant.isoformat()] = round(eur_mwh / 1000.0, 6)
    return prices


async def _fetch_day(session: aiohttp.ClientSession, day: date, tz) -> dict[str, float]:
    params = {"locale": "es", "date": day.isoformat()}
    async with session.get(
        ESIOS_URL, params=params, timeout=aiohttp.ClientTimeout(total=20)
    ) as resp:
        if resp.status != 200:
            raise PVPCError(f"ESIOS respondió {resp.status} para {day.isoformat()}")
        payload = await resp.json(content_type=None)
    prices = _parse_day(payload, day, tz)
    if not prices:
        raise PVPCError(f"ESIOS no devolvió precios PVPC para {day.isoformat()}")
    return prices


async def get_prices(start: datetime, end: datetime, tz) -> dict[str, float]:
    """Precios PVPC (€/kWh) por hora UTC para el rango [start, end)."""
    async with _lock:
        cache = _load_cache()
        result: dict[str, float] = {}
        missing: list[date] = []
        day = start.astimezone(tz).date()
        last_day = (end.astimezone(tz) - timedelta(seconds=1)).date()
        while day <= last_day:
            key = day.isoformat()
            if key in cache:
                result.update(cache[key])
            else:
                missing.append(day)
            day += timedelta(days=1)

        if missing:
            errors: list[str] = []
            async with aiohttp.ClientSession() as session:
                for day in missing:
                    try:
                        prices = await _fetch_day(session, day, tz)
                        cache[day.isoformat()] = prices
                        result.update(prices)
                    except (PVPCError, aiohttp.ClientError, asyncio.TimeoutError) as err:
                        errors.append(str(err))
            _save_cache()
            # Días sin publicar (p. ej. mañana) no bloquean la simulación; si
            # no se pudo obtener NINGÚN dato, sí es un error.
            if not result:
                raise PVPCError(
                    "No se pudieron descargar los precios PVPC: " + "; ".join(errors[:3])
                )
        return result


def price_at(prices: dict[str, float], dt: datetime) -> float | None:
    key = dt.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return prices.get(key.isoformat())

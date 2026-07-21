"""API y servidor web del add-on eBilling."""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import billing
import datasources
import storage

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "info").upper())
_LOGGER = logging.getLogger("ebilling")

app = FastAPI(title="eBilling", docs_url=None, redoc_url=None)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# Caché breve de la serie de consumo para no golpear la fuente en cada refresco.
_cache: dict[str, tuple[float, list]] = {}
CACHE_TTL = 300  # segundos


def _tz(settings: dict) -> ZoneInfo:
    try:
        return ZoneInfo(settings.get("timezone") or "Europe/Madrid")
    except Exception:
        return ZoneInfo("Europe/Madrid")


def _cycle_bounds(settings: dict, now: datetime) -> tuple[datetime, datetime]:
    """Inicio y fin del ciclo de facturación que contiene ``now``."""
    day = max(1, min(28, int(settings.get("billing_day") or 1)))
    if now.day >= day:
        start = now.replace(day=day, hour=0, minute=0, second=0, microsecond=0)
    else:
        prev_month = (now.replace(day=1) - timedelta(days=1)).replace(day=day)
        start = prev_month.replace(hour=0, minute=0, second=0, microsecond=0)
    if start.month == 12:
        end = start.replace(year=start.year + 1, month=1)
    else:
        end = start.replace(month=start.month + 1)
    return start, end


async def _consumption(settings: dict, start: datetime, end: datetime, tz):
    key = f"{settings.get('source')}|{settings.get('ha_entity')}|{start.isoformat()}|{end.isoformat()}"
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < CACHE_TTL:
        return cached[1]
    series = await datasources.get_hourly_consumption(settings, start, end, tz)
    _cache[key] = (time.monotonic(), series)
    if len(_cache) > 32:
        oldest = min(_cache, key=lambda k: _cache[k][0])
        _cache.pop(oldest, None)
    return series


# ---------------------------------------------------------------------------
# Configuración y tarifas
# ---------------------------------------------------------------------------


@app.get("/api/config")
async def get_config():
    config = storage.load()
    settings = dict(config["settings"])
    # No exponer secretos completos al frontend.
    if settings.get("ha_token"):
        settings["ha_token"] = "********"
    if settings.get("influx", {}).get("token"):
        settings["influx"] = {**settings["influx"], "token": "********"}
    if settings.get("influx", {}).get("password"):
        settings["influx"] = {**settings["influx"], "password": "********"}
    return {
        "settings": settings,
        "tariffs": config["tariffs"],
        "supervisor": bool(os.environ.get("SUPERVISOR_TOKEN")),
    }


@app.put("/api/settings")
async def put_settings(patch: dict = Body(...)):
    # Los campos enmascarados no sobreescriben el secreto guardado.
    current = storage.load()["settings"]
    if patch.get("ha_token") == "********":
        patch["ha_token"] = current.get("ha_token", "")
    influx_patch = patch.get("influx")
    if isinstance(influx_patch, dict):
        for secret in ("token", "password"):
            if influx_patch.get(secret) == "********":
                influx_patch[secret] = current.get("influx", {}).get(secret, "")
    settings = storage.update_settings(patch)
    _cache.clear()
    return {"ok": True, "settings": settings}


@app.post("/api/tariffs")
async def post_tariff(tariff: dict = Body(...)):
    return storage.add_tariff(tariff)


@app.put("/api/tariffs/{tariff_id}")
async def put_tariff(tariff_id: str, tariff: dict = Body(...)):
    updated = storage.update_tariff(tariff_id, tariff)
    if not updated:
        raise HTTPException(404, "Tarifa no encontrada")
    return updated


@app.delete("/api/tariffs/{tariff_id}")
async def remove_tariff(tariff_id: str):
    if not storage.delete_tariff(tariff_id):
        raise HTTPException(404, "Tarifa no encontrada")
    return {"ok": True}


@app.get("/api/entities")
async def list_entities():
    settings = storage.load()["settings"]
    try:
        return await datasources.ha_list_energy_entities(settings)
    except datasources.SourceError as err:
        raise HTTPException(502, str(err)) from err
    except Exception as err:  # pragma: no cover - errores de red
        raise HTTPException(502, f"No se pudo conectar con Home Assistant: {err}") from err


# ---------------------------------------------------------------------------
# Simulación
# ---------------------------------------------------------------------------


@app.get("/api/simulate")
async def simulate(
    start: str | None = Query(None),
    end: str | None = Query(None),
    cycles_back: int = Query(0, ge=0, le=24),
):
    config = storage.load()
    settings = config["settings"]
    tz = _tz(settings)
    now = datetime.now(tz)

    if start and end:
        try:
            cycle_start = datetime.fromisoformat(start).replace(tzinfo=tz)
            cycle_end = datetime.fromisoformat(end).replace(tzinfo=tz)
        except ValueError as err:
            raise HTTPException(400, f"Fechas no válidas: {err}") from err
    else:
        cycle_start, cycle_end = _cycle_bounds(settings, now)
        for _ in range(cycles_back):
            cycle_end = cycle_start
            cycle_start, _unused = _cycle_bounds(
                settings, cycle_start - timedelta(days=1)
            )

    fetch_end = min(cycle_end, now)
    if fetch_end <= cycle_start:
        raise HTTPException(400, "El periodo pedido está en el futuro.")

    try:
        hourly = await _consumption(settings, cycle_start, fetch_end, tz)
    except datasources.SourceError as err:
        raise HTTPException(502, str(err)) from err
    except HTTPException:
        raise
    except Exception as err:  # pragma: no cover - errores de red
        _LOGGER.exception("Error consultando la fuente de datos")
        raise HTTPException(502, f"Error consultando la fuente de datos: {err}") from err

    holidays = set(settings.get("holidays") or [])
    summary, daily = billing.summarize_consumption(hourly, holidays)

    elapsed_days = max((fetch_end - cycle_start).total_seconds() / 86400.0, 1 / 24)
    cycle_days = (cycle_end - cycle_start).total_seconds() / 86400.0
    contracted = settings.get("contracted_power") or {}

    bills = []
    for tariff in config["tariffs"]:
        current = billing.compute_bill(tariff, summary, elapsed_days, contracted)
        projection_factor = cycle_days / elapsed_days
        projected = billing.compute_bill(
            tariff, summary.scaled(projection_factor), cycle_days, contracted
        )
        current["projected_total"] = projected["total"]
        current["projected"] = projected
        bills.append(current)

    bills.sort(key=lambda b: b["total"])
    cheapest = bills[0]["total"] if bills else 0.0
    for bill in bills:
        bill["extra_cost"] = round(bill["total"] - cheapest, 2)

    return {
        "period": {
            "start": cycle_start.isoformat(),
            "end": cycle_end.isoformat(),
            "elapsed_days": round(elapsed_days, 2),
            "cycle_days": round(cycle_days, 2),
            "is_current": not (start and end) and cycles_back == 0,
        },
        "consumption": {
            "kwh": {p: round(v, 2) for p, v in summary.kwh.items()},
            "total": round(summary.total, 2),
            "daily": daily,
        },
        "source": settings.get("source"),
        "bills": bills,
        "generated_at": now.isoformat(),
    }


@app.get("/api/health")
async def health():
    return {"ok": True}


# ---------------------------------------------------------------------------
# Frontend (rutas relativas para funcionar detrás del Ingress de HA)
# ---------------------------------------------------------------------------


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

"""API y servidor web del add-on eBilling."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

import billing
import datasources
import pvpc
import sensors
import storage
import tariffs as tariffs_mod

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "info").upper())
_LOGGER = logging.getLogger("ebilling")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# Caché breve de series de consumo para no golpear la fuente en cada refresco.
_cache: dict[str, tuple[float, list]] = {}
CACHE_TTL = 300  # segundos


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_sensor_publisher_loop())
    yield
    task.cancel()


app = FastAPI(title="eBilling", docs_url=None, redoc_url=None, lifespan=lifespan)


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


async def _consumption(settings: dict, start: datetime, end: datetime, tz, kind: str):
    key = "|".join(
        [
            settings.get("source") or "",
            settings.get("ha_entity") or "",
            settings.get("ha_entity_export") or "",
            kind,
            start.isoformat(),
            end.isoformat(),
        ]
    )
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < CACHE_TTL:
        return cached[1]
    series = await datasources.get_hourly_consumption(settings, start, end, tz, kind)
    _cache[key] = (time.monotonic(), series)
    if len(_cache) > 64:
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
    try:
        return storage.add_tariff(tariff)
    except tariffs_mod.TariffError as err:
        raise HTTPException(400, str(err)) from err


@app.put("/api/tariffs/{tariff_id}")
async def put_tariff(tariff_id: str, tariff: dict = Body(...)):
    try:
        updated = storage.update_tariff(tariff_id, tariff)
    except tariffs_mod.TariffError as err:
        raise HTTPException(400, str(err)) from err
    if not updated:
        raise HTTPException(404, "Tarifa no encontrada")
    return updated


@app.delete("/api/tariffs/{tariff_id}")
async def remove_tariff(tariff_id: str):
    if not storage.delete_tariff(tariff_id):
        raise HTTPException(404, "Tarifa no encontrada")
    return {"ok": True}


@app.get("/api/tariffs/template.csv")
async def tariff_template():
    return PlainTextResponse(
        tariffs_mod.template_csv(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="plantilla_tarifa_ebilling.csv"'},
    )


@app.get("/api/tariffs/{tariff_id}/export.csv")
async def tariff_export(tariff_id: str):
    config = storage.load()
    tariff = next((t for t in config["tariffs"] if t.get("id") == tariff_id), None)
    if not tariff:
        raise HTTPException(404, "Tarifa no encontrada")
    filename = f"tarifa_{tariffs_mod.slugify(tariff['name'])}.csv"
    return PlainTextResponse(
        tariffs_mod.tariff_to_csv(tariff),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/tariffs/import")
async def tariff_import(request: Request):
    raw = await request.body()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    try:
        tariff = tariffs_mod.tariff_from_csv(text)
    except tariffs_mod.TariffError as err:
        raise HTTPException(400, str(err)) from err
    except Exception as err:
        raise HTTPException(400, f"No se pudo interpretar el CSV: {err}") from err
    return storage.add_tariff(tariff)


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


async def _run_simulation(
    cycles_back: int = 0,
    start: str | None = None,
    end: str | None = None,
) -> dict:
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
            cycle_start, _unused = _cycle_bounds(settings, cycle_start - timedelta(days=1))

    fetch_end = min(cycle_end, now)
    if fetch_end <= cycle_start:
        raise HTTPException(400, "El periodo pedido está en el futuro.")

    tariff_list = config["tariffs"]
    needs_pvpc = any(t["energy"]["type"] == "pvpc" for t in tariff_list)
    needs_export = any(t["surplus"]["type"] != "none" for t in tariff_list)

    try:
        hourly = await _consumption(settings, cycle_start, fetch_end, tz, "import")
    except datasources.SourceError as err:
        raise HTTPException(502, str(err)) from err
    except HTTPException:
        raise
    except Exception as err:  # pragma: no cover - errores de red
        _LOGGER.exception("Error consultando la fuente de datos")
        raise HTTPException(502, f"Error consultando la fuente de datos: {err}") from err

    export_hourly: list = []
    if needs_export:
        try:
            export_hourly = await _consumption(settings, cycle_start, fetch_end, tz, "export")
        except Exception:
            _LOGGER.warning("No se pudo obtener la serie de excedentes", exc_info=True)

    pvpc_prices = None
    pvpc_error = None
    if needs_pvpc:
        try:
            pvpc_prices = await pvpc.get_prices(cycle_start, fetch_end, tz)
        except pvpc.PVPCError as err:
            pvpc_error = str(err)
        except Exception as err:  # pragma: no cover
            pvpc_error = f"Error PVPC: {err}"

    holidays = set(settings.get("holidays") or [])
    kwh_20td, daily = billing.summarize_consumption(hourly, holidays)

    elapsed_days = max((fetch_end - cycle_start).total_seconds() / 86400.0, 1 / 24)
    cycle_days = (cycle_end - cycle_start).total_seconds() / 86400.0
    contracted = settings.get("contracted_power") or {}
    projection_factor = cycle_days / elapsed_days

    bills = []
    errors = []
    for tariff in tariff_list:
        try:
            energy_bd, kwh_no_price = billing.energy_breakdown(
                tariff, hourly, holidays, pvpc_prices
            )
            surplus_bd = billing.surplus_breakdown(tariff, export_hourly, holidays)
        except tariffs_mod.TariffError as err:
            detail = str(err)
            if tariff["energy"]["type"] == "pvpc" and pvpc_error:
                detail = pvpc_error
            errors.append({"tariff": tariff["name"], "error": detail})
            continue
        current = billing.compute_bill(tariff, energy_bd, surplus_bd, elapsed_days, contracted)
        projected = billing.compute_bill(
            tariff,
            energy_bd.scaled(projection_factor),
            surplus_bd.scaled(projection_factor) if surplus_bd else None,
            cycle_days,
            contracted,
        )
        current["projected_total"] = projected["total"]
        current["projected"] = projected
        current["energy_type"] = tariff["energy"]["type"]
        if kwh_no_price > 0.05:
            current["warning"] = (
                f"{kwh_no_price:.1f} kWh sin precio PVPC disponible (no incluidos)"
            )
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
            "kwh": {p: round(v, 2) for p, v in kwh_20td.items()},
            "total": round(sum(kwh_20td.values()), 2),
            "export_total": round(sum(float(p["kwh"] or 0) for p in export_hourly), 2),
            "daily": daily,
        },
        "source": settings.get("source"),
        "bills": bills,
        "errors": errors,
        "generated_at": now.isoformat(),
    }


@app.get("/api/simulate")
async def simulate(
    start: str | None = Query(None),
    end: str | None = Query(None),
    cycles_back: int = Query(0, ge=0, le=24),
):
    return await _run_simulation(cycles_back=cycles_back, start=start, end=end)


@app.get("/api/health")
async def health():
    return {"ok": True}


# ---------------------------------------------------------------------------
# Publicación periódica de sensores en Home Assistant
# ---------------------------------------------------------------------------


async def _sensor_payload() -> dict | None:
    config = storage.load()
    settings = config["settings"]
    if not settings.get("export_sensors", True):
        return None
    tz = _tz(settings)
    now = datetime.now(tz)
    holidays = set(settings.get("holidays") or [])

    sim = await _run_simulation(cycles_back=0)

    pvpc_prices = None
    if any(t["energy"]["type"] == "pvpc" for t in config["tariffs"]):
        try:
            pvpc_prices = await pvpc.get_prices(now - timedelta(hours=2), now + timedelta(hours=2), tz)
        except Exception:
            pvpc_prices = None

    by_id = {t["id"]: t for t in config["tariffs"]}
    items = []
    for bill in sim["bills"]:
        tariff = by_id.get(bill["tariff_id"])
        if not tariff:
            continue
        price, period_name = billing.price_now(tariff, now, holidays, pvpc_prices)
        items.append(
            {
                "slug": tariffs_mod.slugify(tariff["name"]),
                "name": tariff["name"],
                "company": tariff["company"],
                "price": price,
                "period": period_name,
                "surplus_price": billing.surplus_price_now(tariff, now, holidays),
                "cycle_cost": bill["total"],
                "projected_cost": bill["projected_total"],
                "kwh": bill["kwh_total"],
            }
        )
    if not items:
        return None
    best = min(items, key=lambda i: i["cycle_cost"])
    worst = max(items, key=lambda i: i["cycle_cost"])
    return {
        "cycle_start": sim["period"]["start"],
        "cycle_end": sim["period"]["end"],
        "tariffs": items,
        "best": best,
        "potential_saving": round(worst["cycle_cost"] - best["cycle_cost"], 2),
        "totals": {i["name"]: i["cycle_cost"] for i in items},
    }


async def _sensor_publisher_loop() -> None:
    await asyncio.sleep(10)  # deja arrancar el servidor
    while True:
        minutes = 5
        try:
            settings = storage.load()["settings"]
            minutes = max(1, int(settings.get("sensor_update_minutes") or 5))
            payload = await _sensor_payload()
            if payload:
                await sensors.publish(settings, payload)
        except asyncio.CancelledError:
            raise
        except Exception:
            _LOGGER.warning("Fallo publicando sensores", exc_info=True)
        await asyncio.sleep(minutes * 60)


# ---------------------------------------------------------------------------
# Frontend (rutas relativas para funcionar detrás del Ingress de HA)
# ---------------------------------------------------------------------------


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

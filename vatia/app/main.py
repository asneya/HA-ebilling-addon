"""API y servidor web del add-on Vatia."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

import billing
import datasources
import live
import pvpc
import sensors
import series
import storage
import tariffs as tariffs_mod

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "info").upper())
_LOGGER = logging.getLogger("vatia")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# Caché breve de series de consumo para no golpear la fuente en cada refresco.
_cache: dict[str, tuple[float, list]] = {}
CACHE_TTL = 60  # segundos (refresco casi en tiempo real)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_sensor_publisher_loop())
    yield
    task.cancel()


app = FastAPI(title="Vatia", docs_url=None, redoc_url=None, lifespan=lifespan)


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


def _resolve_period(
    settings: dict,
    now: datetime,
    cycles_back: int,
    start: str | None,
    end: str | None,
) -> tuple[datetime, datetime, bool]:
    """Devuelve (inicio, fin, es_ciclo_actual) del periodo a calcular.

    Prioridad: 1) start/end explícitos (uso puntual); 2) intervalo de trabajo
    fijado por el usuario (settings.working_period), salvo que se esté
    navegando por ciclos; 3) ciclo de facturación automático (con cycles_back).
    """
    tz = _tz(settings)
    if start and end:
        try:
            return (
                datetime.fromisoformat(start).replace(tzinfo=tz),
                datetime.fromisoformat(end).replace(tzinfo=tz),
                False,
            )
        except ValueError as err:
            raise HTTPException(400, f"Fechas no válidas: {err}") from err

    wp = settings.get("working_period")
    if not cycles_back and wp and wp.get("start") and wp.get("end"):
        try:
            s = datetime.fromisoformat(wp["start"]).replace(tzinfo=tz)
            # ``end`` es inclusivo: el límite del cálculo es el día siguiente.
            e = datetime.fromisoformat(wp["end"]).replace(tzinfo=tz) + timedelta(days=1)
            if e > s:
                return s, e, False
        except ValueError:
            pass

    cycle_start, cycle_end = _cycle_bounds(settings, now)
    for _ in range(cycles_back):
        cycle_end = cycle_start
        cycle_start, _unused = _cycle_bounds(settings, cycle_start - timedelta(days=1))
    return cycle_start, cycle_end, cycles_back == 0


async def _consumption(settings: dict, start: datetime, end: datetime, tz, kind: str):
    energia = settings.get("energy_sensors") or {}
    key = "|".join(
        [
            settings.get("source") or "",
            energia.get("grid_import_energy") or "",
            energia.get("grid_export_energy") or "",
            kind,
            start.isoformat(),
            end.isoformat(),
        ]
    )
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < CACHE_TTL:
        return cached[1]
    hourly = await datasources.get_hourly_consumption(settings, start, end, tz, kind)
    _cache[key] = (time.monotonic(), hourly)
    if len(_cache) > 64:
        oldest = min(_cache, key=lambda k: _cache[k][0])
        _cache.pop(oldest, None)
    return hourly


# ---------------------------------------------------------------------------
# Configuración y tarifas
# ---------------------------------------------------------------------------


def _version() -> str:
    """Versión del add-on (una sola vez), para enseñarla en Ajustes.

    Se busca en este orden, porque el sitio depende de cómo se haya construido:

    1. ``VATIA_VERSION``, que el Dockerfile fija desde ``BUILD_VERSION``.
    2. ``addon.yaml`` junto a la aplicación: el ``config.yaml`` copiado dentro
       de la imagen. Un build local puede no pasar el argumento anterior.
    3. ``../config.yaml``, que es donde está al ejecutar desde el repositorio.
    """
    global _VERSION
    if _VERSION is not None:
        return _VERSION
    _VERSION = (os.environ.get("VATIA_VERSION") or "").strip()
    if _VERSION:
        return _VERSION
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (
        os.path.join(here, "addon.yaml"),
        os.path.join(os.path.dirname(here), "config.yaml"),
    ):
        try:
            with open(path, encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("version:"):
                        _VERSION = line.split(":", 1)[1].strip().strip('"').strip("'")
                        break
        except OSError:
            continue
        if _VERSION:
            break
    return _VERSION


_VERSION: str | None = None


MASKED = "********"


def _unmask(patch: dict, current: dict) -> None:
    """Los campos enmascarados no sobreescriben el secreto guardado."""
    if patch.get("ha_token") == MASKED:
        patch["ha_token"] = current.get("ha_token", "")
    influx = patch.get("influx")
    if isinstance(influx, dict):
        for secret in ("token", "password"):
            if influx.get(secret) == MASKED:
                influx[secret] = current.get("influx", {}).get(secret, "")


@app.get("/api/config")
async def get_config():
    config = storage.load()
    settings = dict(config["settings"])
    # No exponer secretos completos al frontend.
    if settings.get("ha_token"):
        settings["ha_token"] = MASKED
    if settings.get("influx", {}).get("token"):
        settings["influx"] = {**settings["influx"], "token": MASKED}
    if settings.get("influx", {}).get("password"):
        settings["influx"] = {**settings["influx"], "password": MASKED}
    return {
        "settings": settings,
        "tariffs": config["tariffs"],
        "appliances": config["appliances"],
        "supervisor": bool(os.environ.get("SUPERVISOR_TOKEN")),
        "version": _version(),
    }


@app.put("/api/settings")
async def put_settings(patch: dict = Body(...)):
    _unmask(patch, storage.load()["settings"])
    settings = storage.update_settings(patch)
    _cache.clear()
    return {"ok": True, "settings": settings}


@app.get("/api/config/export")
async def export_config():
    """Descarga los ajustes y las tarifas en un JSON.

    Sirve de copia de seguridad, para mover la instalación a otro Home Assistant
    y para volver atrás si algo se rompe. Incluye los secretos (el token de HA y
    las credenciales de InfluxDB) porque si no, no restaura del todo: la interfaz
    avisa de que el fichero hay que tratarlo como una contraseña.
    """
    config = storage.load()
    payload = {
        "app": "vatia",
        "version": _version(),
        "exported_at": datetime.now(_tz(config["settings"])).isoformat(),
        "settings": config["settings"],
        "tariffs": config["tariffs"],
        "appliances": config["appliances"],
    }
    return Response(
        json.dumps(payload, ensure_ascii=False, indent=2),
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="vatia-config.json"'},
    )


@app.post("/api/config/import")
async def import_config(payload: dict = Body(...)):
    """Restaura ajustes y tarifas desde un JSON.

    Acepta tanto el fichero de ``/api/config/export`` como la respuesta de
    ``/api/config`` —que es la que se puede copiar del add-on antiguo desde el
    navegador—, así que las claves que sobran (``version``, ``supervisor``…) se
    ignoran y los secretos enmascarados conservan el valor que ya hubiera.
    """
    settings = payload.get("settings")
    tariffs = payload.get("tariffs")
    if (not isinstance(settings, dict) and not isinstance(tariffs, list)
            and not isinstance(payload.get("appliances"), list)):
        raise HTTPException(
            400,
            "El fichero no parece una configuración de Vatia: "
            "se esperaba un objeto con «settings» o «tariffs».",
        )

    resumen = {"settings": 0, "tariffs": 0, "appliances": 0}
    if isinstance(settings, dict):
        patch = dict(settings)
        _unmask(patch, storage.load()["settings"])
        storage.update_settings(patch)
        resumen["settings"] = len(patch)
    if isinstance(tariffs, list):
        # `normalize_tariff` es deliberadamente tolerante (rellena lo que falta
        # para poder migrar formatos antiguos), así que aquí hace falta un
        # filtro propio: importar sustituye **todas** las tarifas, y un pegado
        # equivocado no puede llevarse por delante las que ya están.
        candidatos = [
            t for t in tariffs
            if isinstance(t, dict) and isinstance(t.get("name"), str) and t["name"].strip()
        ]
        if tariffs and not candidatos:
            raise HTTPException(
                400,
                "Ninguna de las tarifas del fichero es válida: a cada una le "
                "hace falta al menos un nombre.",
            )
        normalized = []
        for raw in candidatos:
            try:
                tariff = tariffs_mod.normalize_tariff(raw)
            except tariffs_mod.TariffError:
                _LOGGER.warning("Tarifa ignorada al importar: %s", raw.get("name"))
                continue
            tariff["id"] = raw.get("id") or tariffs_mod.slugify(tariff["name"])
            normalized.append(tariff)
        if not normalized:
            raise HTTPException(400, "Ninguna de las tarifas del fichero es válida.")
        config = storage.load()
        config["tariffs"] = normalized
        storage.save(config)
        resumen["tariffs"] = len(normalized)
    aparatos = payload.get("appliances")
    if isinstance(aparatos, list):
        # Sustituyen a los que hubiera, como las tarifas. Los que no valen se
        # descartan uno a uno: un electrodoméstico sin nombre no puede tumbar la
        # restauración entera de una copia de seguridad.
        buenos = []
        for raw in aparatos:
            if not isinstance(raw, dict):
                continue
            try:
                buenos.append(storage.normalize_appliance(raw))
            except ValueError:
                _LOGGER.warning("Electrodoméstico ignorado al importar: %s", raw)
        config = storage.load()
        config["appliances"] = buenos
        storage.save(config)
        resumen["appliances"] = len(buenos)
    _cache.clear()
    return {"ok": True, "imported": resumen}


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


@app.post("/api/appliances")
async def post_appliance(appliance: dict = Body(...)):
    try:
        return storage.add_appliance(appliance)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err


@app.put("/api/appliances/{appliance_id}")
async def put_appliance(appliance_id: str, appliance: dict = Body(...)):
    try:
        updated = storage.update_appliance(appliance_id, appliance)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    if not updated:
        raise HTTPException(404, "Electrodoméstico no encontrado")
    return updated


@app.delete("/api/appliances/{appliance_id}")
async def remove_appliance(appliance_id: str):
    if not storage.delete_appliance(appliance_id):
        raise HTTPException(404, "Electrodoméstico no encontrado")
    return {"ok": True}


@app.get("/api/tariffs/template.csv")
async def tariff_template():
    return PlainTextResponse(
        tariffs_mod.template_csv(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="plantilla_tarifa_vatia.csv"'},
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


@app.get("/api/entities/grouped")
async def list_entities_grouped():
    """Entidades de HA agrupadas por tipo, para los selectores de Ajustes."""
    settings = storage.load()["settings"]
    try:
        states = await live.fetch_states(settings)
    except datasources.SourceError as err:
        raise HTTPException(502, str(err)) from err
    except Exception as err:  # pragma: no cover - errores de red
        raise HTTPException(502, f"No se pudo conectar con Home Assistant: {err}") from err
    return live.list_entities(states)


@app.get("/api/sensors")
async def sensors_status():
    """Estado de cada casilla de sensor, para la pantalla de Sensores.

    Devuelve, por función, qué entidad tiene cada casilla, cuánto marca ahora y
    si responde; y para las vacías, unos pocos candidatos con el nombre a favor.
    Es lo que permite enseñar filas con valor en vivo en vez de catorce
    desplegables con trescientas entradas cada uno.
    """
    settings = storage.load()["settings"]
    try:
        states = await live.fetch_states(settings)
    except datasources.SourceError as err:
        raise HTTPException(502, str(err)) from err
    except Exception as err:  # pragma: no cover - errores de red
        raise HTTPException(502, f"No se pudo conectar con Home Assistant: {err}") from err
    return live.sensor_status(settings, states)


@app.get("/api/series")
async def get_series(
    view: str = Query("overview"),
    range: str = Query("day"),
    offset: int = Query(0, ge=-120, le=0),
):
    """Series para la pantalla Energía (día/semana/mes/año/total)."""
    settings = storage.load()["settings"]
    tz = _tz(settings)
    try:
        states = await live.fetch_states(settings)
        return await series.build(
            settings, states, view, range, offset, tz, datetime.now(tz)
        )
    except datasources.SourceError as err:
        raise HTTPException(502, str(err)) from err
    except Exception as err:  # pragma: no cover - errores de red
        _LOGGER.warning("Error construyendo las series", exc_info=True)
        raise HTTPException(502, f"No se pudieron obtener las series: {err}") from err


@app.get("/api/live")
async def get_live():
    """Flujo de energía, resumen del día y meteorología para la Home."""
    config = storage.load()
    settings = config["settings"]
    tz = _tz(settings)
    try:
        return await live.build(
            settings, datetime.now(tz), config["tariffs"], config["appliances"]
        )
    except datasources.SourceError as err:
        raise HTTPException(502, str(err)) from err
    except Exception as err:  # pragma: no cover - errores de red
        _LOGGER.warning("Error leyendo el estado en vivo", exc_info=True)
        raise HTTPException(502, f"No se pudo leer el estado de Home Assistant: {err}") from err


@app.get("/api/flowday")
async def get_flow_day():
    """El día entero del flujo de energía, para recorrerlo hora a hora."""
    config = storage.load()
    settings = config["settings"]
    tz = _tz(settings)
    try:
        return await live.flow_day(
            settings, datetime.now(tz), config["tariffs"], config["appliances"]
        )
    except datasources.SourceError as err:
        raise HTTPException(502, str(err)) from err
    except Exception as err:  # pragma: no cover - errores de red
        _LOGGER.warning("Error construyendo el flujo del día", exc_info=True)
        raise HTTPException(502, f"No se pudo obtener el flujo del día: {err}") from err


@app.get("/api/diagnostics/billing")
async def diagnostics_billing():
    """Por qué la facturación trae —o no trae— datos, paso a paso.

    Una consulta que no encuentra su serie **no falla**: devuelve cero filas. Con
    eso, desde fuera, es imposible distinguir «no has gastado nada» de «estoy
    mirando donde no es». Esto recorre la cadena entera y dice en qué eslabón se
    rompe, con lo que la base contiene de verdad.
    """
    settings = storage.load()["settings"]
    tz = _tz(settings)
    now = datetime.now(tz)
    start, end, _actual = _resolve_period(settings, now, 0, None, None)
    energia = settings.get("energy_sensors") or {}
    entity = (energia.get("grid_import_energy") or "").strip()

    fuera: dict[str, Any] = {
        "source": settings.get("source") or "demo",
        "periodo": {"start": start.isoformat(), "end": end.isoformat(),
                    "fijado_a_mano": bool(settings.get("working_period"))},
        "sensor_import": entity,
        "sensor_export": (energia.get("grid_export_energy") or "").strip(),
    }

    # 1 · Home Assistant: ¿existe siquiera el sensor, y trae estadísticas?
    paso: dict[str, Any] = {"intentado": fuera["source"] == "homeassistant"}
    if paso["intentado"]:
        paso["ficha"] = await datasources.ha_ficha(settings, entity)
        try:
            filas = await datasources.ha_hourly_consumption(settings, start, end, tz, entity)
            paso.update(horas=len(filas), kwh=round(sum(f["kwh"] for f in filas), 3))
        except Exception as err:  # noqa: BLE001 - aquí interesa el motivo, sea cual sea
            paso["error"] = str(err)
    fuera["home_assistant"] = paso

    # 2 · InfluxDB: qué contiene y qué devuelve para este sensor
    inv = await datasources.influx_inventario(settings, entity)
    if inv.get("configurado") and entity:
        corto, largo = datasources._ids(entity)
        ents = inv.get("entidades") or []
        inv["encuentra_el_sensor"] = corto in ents or largo in ents
        # La pregunta buena no es «¿existe la medida?» sino «¿está mi contador
        # dentro de ella?». Un `kWh` en la base con el sensor guardado en `Wh` da
        # las dos respuestas por separado en verde y la consulta vacía.
        suyas = inv.get("medidas_del_sensor")
        if suyas is not None:
            inv["medida_correcta"] = inv["measurement_configurada"] in suyas
        try:
            filas = await datasources.influx_hourly_consumption(
                settings, start, end, tz, entity)
            inv.update(horas=len(filas), kwh=round(sum(f["kwh"] for f in filas), 3))
        except Exception as err:  # noqa: BLE001
            inv["error_consulta"] = str(err)
    fuera["influxdb"] = inv

    # 3 · Lo que de verdad acaba usando la facturación
    try:
        serie = await _consumption(settings, start, end, tz, "import")
        fuera["resultado"] = {"horas": len(serie),
                              "kwh": round(sum(float(f["kwh"] or 0) for f in serie), 3)}
    except Exception as err:  # noqa: BLE001
        fuera["resultado"] = {"error": str(err)}

    fuera["veredicto"] = _veredicto_facturacion(fuera)
    return fuera


def _veredicto_facturacion(d: dict[str, Any]) -> str:
    """La conclusión en una frase, que es lo que hay que leer primero."""
    if d["source"] != "homeassistant":
        return ("La fuente está en «Demostración»: la facturación usa una casa de "
                "ejemplo. Cámbiala en Ajustes → Fuente de datos.")
    if not d["sensor_import"]:
        return ("No hay contador de energía importada. Elígelo en "
                "Ajustes → Sensores.")
    if (d.get("resultado") or {}).get("horas"):
        return f"Todo correcto: {d['resultado']['horas']} horas con datos."

    ha = d["home_assistant"]
    ifx = d["influxdb"]
    ficha = ha.get("ficha") or {}
    if ficha.get("existe") is False:
        # El caso que no se estaba mirando: el sensor de Ajustes no está en HA.
        pistas = [f"«{d['sensor_import']}» {ficha.get('motivo', 'no está')}. "
                  "Revisa el contador en Ajustes → Sensores."]
    elif ha.get("error"):
        pistas = [f"Home Assistant no ha dado las estadísticas: {ha['error']}"]
    elif ficha.get("existe") and not ficha.get("state_class"):
        pistas = [f"«{d['sensor_import']}» existe y marca "
                  f"{ficha.get('estado')} {ficha.get('unidad')}, pero no tiene "
                  "`state_class`, así que Home Assistant no le guarda "
                  "estadísticas de largo plazo y la facturación no puede "
                  "diferenciarlo hora a hora."]
    else:
        pistas = [f"«{d['sensor_import']}» no tiene estadísticas horarias en Home "
                  "Assistant en este periodo, aunque su `state_class` es "
                  f"«{ficha.get('state_class') or '—'}»."]
    if not ifx.get("configurado"):
        pistas.append("No hay InfluxDB configurado del que sacarlas.")
    elif ifx.get("error"):
        pistas.append(f"InfluxDB no responde: {ifx['error']}")
    elif ifx.get("encuentra_el_sensor") is False:
        ents = ", ".join((ifx.get("entidades") or [])[:8]) or "ninguna"
        pistas.append(f"Y en InfluxDB no hay ningún `entity_id` que se le parezca. "
                      f"Los que hay: {ents}…")
    elif ifx.get("medida_correcta") is False:
        suyas = ", ".join(ifx.get("medidas_del_sensor") or []) or "ninguna"
        pistas.append(f"El sensor sí está en InfluxDB, pero no en la medida "
                      f"«{ifx['measurement_configurada']}»: está en {suyas}. La "
                      f"medida es la unidad del contador; pon esa en "
                      f"Ajustes → InfluxDB.")
    elif ifx.get("error_consulta"):
        pistas.append(f"La consulta a InfluxDB ha fallado: {ifx['error_consulta']}")
    elif not ifx.get("horas"):
        pistas.append("El sensor y la medida están en InfluxDB, pero no hay filas "
                      "en el periodo del ciclo. ¿Empieza el ciclo antes de que la "
                      "base tuviera datos?")
    return " ".join(pistas)


@app.get("/api/diagnostics")
async def get_diagnostics():
    """Balance de energía del día, sensor a sensor, para Ajustes."""
    settings = storage.load()["settings"]
    tz = _tz(settings)
    now = datetime.now(tz)
    try:
        states = await live.fetch_states(settings)
        return await live.diagnostics(settings, states, tz, now)
    except datasources.SourceError as err:
        raise HTTPException(502, str(err)) from err
    except Exception as err:  # pragma: no cover - errores de red
        _LOGGER.warning("Error calculando el diagnóstico", exc_info=True)
        raise HTTPException(502, f"No se pudo leer el estado de Home Assistant: {err}") from err


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

    cycle_start, cycle_end, is_current = _resolve_period(settings, now, cycles_back, start, end)

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
            "is_current": is_current,
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


async def _run_detail(
    cycles_back: int = 0, start: str | None = None, end: str | None = None
) -> dict:
    """Desglose detallado de consumo (importada) y vertido (exportada).

    Devuelve totales, serie diaria por periodo 2.0TD y la serie horaria
    completa, para el gráfico de detalle y su drill-down por día/hora.
    """
    config = storage.load()
    settings = config["settings"]
    tz = _tz(settings)
    now = datetime.now(tz)

    cycle_start, cycle_end, is_current = _resolve_period(settings, now, cycles_back, start, end)

    fetch_end = min(cycle_end, now)
    if fetch_end <= cycle_start:
        raise HTTPException(400, "El periodo pedido está en el futuro.")

    try:
        imp = await _consumption(settings, cycle_start, fetch_end, tz, "import")
    except datasources.SourceError as err:
        raise HTTPException(502, str(err)) from err
    except HTTPException:
        raise
    except Exception as err:  # pragma: no cover - errores de red
        _LOGGER.exception("Error consultando la fuente de datos")
        raise HTTPException(502, f"Error consultando la fuente de datos: {err}") from err

    exp: list = []
    try:
        exp = await _consumption(settings, cycle_start, fetch_end, tz, "export")
    except Exception:
        _LOGGER.warning("No se pudo obtener la serie de excedentes", exc_info=True)

    holidays = set(settings.get("holidays") or [])
    by_hour: dict[str, dict] = {}

    def _bucket(dt) -> dict:
        ts = dt.isoformat()
        item = by_hour.get(ts)
        if item is None:
            item = {
                "ts": ts,
                "date": dt.strftime("%Y-%m-%d"),
                "hour": dt.hour,
                "kwh": 0.0,
                "export": 0.0,
                "period": billing.classify_hour(dt, holidays),
            }
            by_hour[ts] = item
        return item

    for point in imp:
        _bucket(point["start"])["kwh"] += float(point["kwh"] or 0.0)
    for point in exp:
        _bucket(point["start"])["export"] += float(point["kwh"] or 0.0)

    hours = []
    for ts in sorted(by_hour):
        h = by_hour[ts]
        hours.append({**h, "kwh": round(h["kwh"], 3), "export": round(h["export"], 3)})

    days: dict[str, dict] = {}
    tot = {"punta": 0.0, "llano": 0.0, "valle": 0.0, "import": 0.0, "export": 0.0}
    for h in by_hour.values():
        d = days.setdefault(
            h["date"],
            {"date": h["date"], "punta": 0.0, "llano": 0.0, "valle": 0.0, "import": 0.0, "export": 0.0},
        )
        d[h["period"]] += h["kwh"]
        d["import"] += h["kwh"]
        d["export"] += h["export"]
        tot[h["period"]] += h["kwh"]
        tot["import"] += h["kwh"]
        tot["export"] += h["export"]

    daily = [
        {k: (v if k == "date" else round(v, 3)) for k, v in days[d].items()}
        for d in sorted(days)
    ]

    return {
        "period": {
            "start": cycle_start.isoformat(),
            "end": cycle_end.isoformat(),
            "elapsed_days": round(max((fetch_end - cycle_start).total_seconds() / 86400.0, 1 / 24), 2),
            "cycle_days": round((cycle_end - cycle_start).total_seconds() / 86400.0, 2),
            "is_current": is_current,
        },
        "totals": {k: round(v, 2) for k, v in tot.items()},
        "days": daily,
        "hours": hours,
        "source": settings.get("source"),
        "has_export": bool(exp),
    }


@app.get("/api/detail")
async def detail(
    start: str | None = Query(None),
    end: str | None = Query(None),
    cycles_back: int = Query(0, ge=0, le=24),
):
    return await _run_detail(cycles_back=cycles_back, start=start, end=end)


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
                "color": tariff.get("color"),
                "price": price,
                "period": period_name,
                "surplus_price": billing.surplus_price_now(tariff, now, holidays),
                "cycle_cost": bill["total"],
                "projected_cost": bill["projected_total"],
                "kwh": bill["kwh_total"],
                "virtual_wallet": bill.get("virtual_wallet", False),
                "wallet_credit": bill.get("wallet_credit", 0.0),
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


# La página con el sprite de iconos ya incrustado. Se arma una vez y se guarda:
# `<use href="fichero.svg#id">` no funciona en WebKit —que es el motor de la app
# de Home Assistant en iOS—, y una petición aparte solo para los iconos haría
# que la primera pintada saliera sin ellos.
_INDEX_CACHE: dict[str, str] = {}


def _index_html() -> str:
    if "html" not in _INDEX_CACHE:
        with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as fh:
            html = fh.read()
        try:
            with open(os.path.join(STATIC_DIR, "iconos.svg"), encoding="utf-8") as fh:
                sprite = fh.read()
        except OSError:
            # Sin sprite la app sigue en pie: se ven huecos donde los iconos.
            _LOGGER.warning("No se pudo leer el sprite de iconos", exc_info=True)
            sprite = ""
        _INDEX_CACHE["html"] = html.replace("<!--ICONOS-->", sprite)
    return _INDEX_CACHE["html"]


@app.get("/")
async def index():
    # Sin caché, y a propósito. El documento es lo único que sabe cómo se carga
    # la app —con `type="module"` desde que está repartida en core/ y
    # screens/—, así que un index.html viejo guardado por el navegador junto a
    # un app.js nuevo daría una pantalla en blanco tras actualizar el add-on.
    return HTMLResponse(_index_html(), headers={"Cache-Control": "no-store"})


class _EstaticosFrescos(StaticFiles):
    """Estáticos que **se revalidan siempre**.

    Aquí había una suposición equivocada que costó cara: «los estáticos llevan su
    ETag y se revalidan solos». No es verdad. Sin `Cache-Control`, un navegador
    aplica *caché heurística* —del orden del 10 % del tiempo que lleva sin
    cambiar el fichero— y sirve el JavaScript de su copia **sin preguntar**. Para
    un fichero que lleva semanas quieto, eso son días.

    El resultado tras actualizar el add-on es de los peores que hay: el
    `index.html` llega fresco (va con `no-store`) y el JavaScript, viejo. La
    pantalla enseña lo nuevo y no responde, porque quien tenía que escuchar el
    clic está en la versión anterior. Ni un error en la consola.

    `no-cache` no quiere decir «no guardes»: quiere decir «guarda, pero pregunta
    antes de usarlo». Lo que no cambia se responde con un 304 de unos pocos
    bytes, y en una red local eso no se nota. Que una actualización se vea
    entera, sí.

    Versionar la URL del `app.js` no serviría: los `import` de un módulo se
    resuelven contra la URL del módulo **sin heredar su query**, así que
    `app.js?v=2` seguiría cargando un `core/dom.js` viejo.
    """

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/static", _EstaticosFrescos(directory=STATIC_DIR), name="static")

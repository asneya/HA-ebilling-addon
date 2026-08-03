"""La tarjeta del tiempo hora a hora.

Se enseñan **solo las horas de sol que quedan del día en curso**: en una
aplicación de energía, ni las once de la noche ni las horas que ya pasaron
cambian ninguna decisión.

Dos partes, y la primera existe por una razón concreta. Lo natural sería
comprobarlo todo contra el servidor, pero entonces el banco solo cubriría algo
**mientras quede sol**: a las nueve de la noche no hay horas que enseñar y no
habría nada que mirar. El CI corre a cualquier hora, así que la parte que de
verdad importa se comprueba con una hora fijada, y la del servidor queda como
prueba de que las piezas encajan de verdad.

A · con la hora fijada, que corre siempre:

  1. la franja empieza en la hora en curso y no en la siguiente
  2. acaba con el sol y no a medianoche
  3. no se cuela ninguna hora de otro día
  4. de noche no hay tarjeta
  5. sin entidad configurada tampoco
  6. cada hora trae el tiempo y el sol de esa hora
  7. el sol de cada fila es el de la curva, no una previsión aparte
  8. la nubosidad que no venga se queda en `null`, no en cero
  9. el pico declarado es el de lo que queda
 10. la previsión se pide con el servicio, no leyendo un atributo

B · contra el servidor, cuando queda sol:

 11. las piezas encajan de punta a punta

El punto 10 es el que menos se ve y el que más importa: desde Home Assistant
2024.4 las entidades del tiempo **ya no publican** su previsión en el atributo
`forecast`, hay que pedirla con `weather.get_forecasts`. Los HA de mentira de este
banco sirven su `weather.casa` sin el atributo a propósito, así que si alguien
reescribiera esto leyendo atributos, el banco se pondría rojo en vez de pasar aquí
y fallar en las casas.
"""
import asyncio
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
import datasources                                            # noqa: E402
import live                                                   # noqa: E402
import series as S                                            # noqa: E402

BASE = os.environ.get("VATIA_BASE", "http://127.0.0.1:8402")
TZ = ZoneInfo("Europe/Madrid")
DIA = datetime(2026, 8, 3, tzinfo=TZ)
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


# ── A · con la hora fijada ──────────────────────────────────────────────────

def campana(dia):
    """Previsión solar de un día: campana de 8 a 20 con 5 kW de pico."""
    filas = []
    for h in range(24):
        for m in (0, 30):
            t = dia.replace(hour=h, minute=m)
            x = (h + m / 60.0 - 14.0) / 6.0
            filas.append({"period_start": t.isoformat(),
                          "pv_estimate": max(0.0, 5000.0 * (1.0 - x * x)) / 1000.0})
    return filas


AJUSTES = {
    "solar_forecast_sensor": "sensor.prevision",
    "weather_entity": "weather.casa",
    "battery_kwh": 0.0,
    "flow_sensors": {"pv": "sensor.pv_power"},
}
ESTADOS = {
    "sensor.prevision": {"state": "30.0", "attributes": {
        "detailedForecast": campana(DIA) + campana(DIA + timedelta(days=1))}},
    # La entidad del tiempo, **sin** atributo `forecast`: igual que Home Assistant
    # desde 2024.4. Si `weather_hours` lo leyera de aquí, no encontraría nada.
    "weather.casa": {"state": "sunny", "attributes": {"temperature": 26.0}},
}


def horario(dia, nubes=True):
    """Previsión horaria como la da `weather.get_forecasts`, 48 horas."""
    filas = []
    for i in range(48):
        t = dia.replace(hour=0, minute=0) + timedelta(hours=i)
        nube = min(95, 10 + t.hour * 4)
        filas.append({
            "datetime": t.isoformat(),
            "condition": "cloudy" if nube >= 70 else "sunny",
            "temperature": 20.0 + t.hour * 0.4,
            **({"cloud_coverage": nube} if nubes else {}),
        })
    return filas


# Se sustituye la llamada a Home Assistant, que es lo único que aquí no hay. El
# resto —la curva, el recorte, el cruce con el sol— es el código de la casa.
PEDIDAS = []


def falso_ha(nubes=True):
    async def pide(_settings, entidad):
        PEDIDAS.append(entidad)
        return horario(DIA, nubes)
    return pide


def curva(ahora):
    """La curva del día, con el tejado cumpliendo lo prometido.

    La potencia solar que se pasa **importa**: `curva_solar` corrige la previsión
    con lo que el tejado está dando (el desvio de hoy de la 0.48.0), así que con
    `pv: 0` el factor se iría al suelo y toda la curva quedaría al 5 %. El banco
    seguiría en verde, pero midiendo un día encapotado que aquí no se ha pedido:
    se le da la potencia que la previsión promete para esa hora, y así el sol de
    la tarjeta es el de la campana.
    """
    prevista = S.forecast_at(
        S.forecast_power([ESTADOS["sensor.prevision"]], TZ), ahora)
    return live.curva_solar(AJUSTES, ESTADOS, {"pv": prevista}, {}, TZ, ahora)


def tarjeta(ahora, ajustes=None, nubes=True):
    datasources.ha_weather_hourly = falso_ha(nubes)
    live._tiempo_cache.update({"key": None, "at": 0.0, "value": None})
    return asyncio.run(live.weather_hours(
        ajustes if ajustes is not None else AJUSTES, curva(ahora), ahora))


print("A · con la hora fijada")
print("\n1-3 · la franja")
t = tarjeta(DIA.replace(hour=11, minute=40))
ok(t is not None, "a las 11:40 hay tarjeta")
horas = [datetime.fromisoformat(h["at"]) for h in t["hours"]]
ok(horas[0].hour == 11,
   f"empieza en la hora en curso y no en la siguiente ({horas[0]:%H:%M})")
fin = datetime.fromisoformat(t["until"])
ok(horas[-1] <= fin, f"y acaba con el sol ({horas[-1]:%H:%M} de {fin:%H:%M})")
ok(fin.hour < 21, f"que no es medianoche ({fin:%H:%M})")
ok(all(h.date() == DIA.date() for h in horas), "ninguna hora de otro día")
ok(horas == sorted(set(horas)), "en orden y sin repetir")

print("\n4-5 · cuando no hay tarjeta")
ok(tarjeta(DIA.replace(hour=23, minute=0)) is None,
   "de noche no queda sol y no se enseña nada")
ok(tarjeta(DIA.replace(hour=11), ajustes={**AJUSTES, "weather_entity": ""}) is None,
   "y sin entidad configurada tampoco")
ok(asyncio.run(live.weather_hours(AJUSTES, None, DIA.replace(hour=11))) is None,
   "ni sin previsión solar, que es de donde sale la franja")

print("\n6-7 · qué trae cada hora")
ok(all("condition" in h and "sun_w" in h and "temperature" in h for h in t["hours"]),
   "el tiempo y el sol en la misma fila")
# El sol de cada fila tiene que ser **el de la curva**, no una previsión aparte:
# si esta tarjeta se sacara su propia cuenta, volvería la incoherencia de la 0.48.0.
puntos = curva(DIA.replace(hour=11, minute=40))["points"]
desvios = [abs(h["sun_w"] - S.forecast_at(puntos, datetime.fromisoformat(h["at"])))
           for h in t["hours"]]
ok(max(desvios) <= 0.05,
   f"y el sol es exactamente el de la curva (desvío máximo {max(desvios):.3f} W)")

print("\n8 · la nubosidad que no viene")
ok(all(h["cloud_pct"] is not None for h in t["hours"]),
   "cuando la integración la da, está")
sin = tarjeta(DIA.replace(hour=11, minute=40), nubes=False)
ok(all(h["cloud_pct"] is None for h in sin["hours"]),
   "y cuando no, se queda en null y no en cero")
ok(all(h["sun_w"] for h in sin["hours"]),
   "sin que se pierda el sol, que es lo que se venía a ver")

print("\n9 · el pico declarado")
ok(abs(t["peak_w"] - max(h["sun_w"] for h in t["hours"])) < 0.01,
   f"es el de lo que queda ({t['peak_w']} W)")
# Y es el pico de la campana de verdad, no una curva machacada: si esta cifra
# saliera en centenares de vatios con 5 kW previstos, sería que el desvio de hoy
# está corrigiendo cuando no se le ha pedido.
ok(t["peak_w"] > 4000,
   f"y con el tejado cumpliendo, es el de la campana ({t['peak_w']} W de 5.000)")
# A última hora el pico es pequeño: si fuera el del día, las barras de la tarjeta
# serían todas un hilo y no se compararía nada con nada.
tarde = tarjeta(DIA.replace(hour=18, minute=10))
ok(tarde and tarde["peak_w"] < t["peak_w"],
   f"y a las 18:10 es menor que a las 11:40 ({tarde and tarde['peak_w']} < {t['peak_w']})")

print("\n10 · pedida con el servicio")
ok(PEDIDAS and all(e == "weather.casa" for e in PEDIDAS),
   f"se le pide a Home Assistant por su entidad ({len(PEDIDAS)} veces)")
ok("forecast" not in (ESTADOS["weather.casa"]["attributes"]),
   "y la entidad no tiene atributo `forecast`, como desde 2024.4")

# ── B · contra el servidor ──────────────────────────────────────────────────

print("\nB · contra el servidor")


def pide(ruta):
    with urllib.request.urlopen(BASE + ruta, timeout=40) as r:
        return json.load(r)


d = pide("/api/live")
api = d.get("weather_hours")
ahora = datetime.fromisoformat(d["generated_at"])
if api is None:
    # No es un fallo: a esta hora ya no quedan horas de sol y `None` es la
    # respuesta correcta. Se dice, para que nadie lo confunda con una
    # comprobación que ha pasado.
    print(f"  (ya no queda sol hoy: son las {ahora:%H:%M}, nada que servir)")
    print("\ntodo en verde" if not fallos else f"\n{len(fallos)} fallos")
    sys.exit(1 if fallos else 0)

print("\n11 · las piezas encajan")
ok(api["entity"].startswith("weather."),
   f"con una entidad del tiempo de verdad ({api['entity']})")
ok(bool(api["hours"]), f"y con horas ({len(api['hours'])})")
suyas = [datetime.fromisoformat(h["at"]) for h in api["hours"]]
ok(suyas[0].hour == ahora.hour,
   f"desde la hora en curso ({suyas[0]:%H:%M}, y son las {ahora:%H:%M})")
ok(all(h.date() == ahora.date() for h in suyas), "todas de hoy")
ok(any(h["cloud_pct"] is not None for h in api["hours"]),
   "con la nubosidad que da el fake")

# El sol de esta tarjeta y el que dibuja la de la ventana tienen que ser el mismo
# número: las dos salen de `curva_solar`, y esa es la invariante que costó la 0.48.0.
#
# **No** se compara con la serie `forecast` de `/api/series`, que fue el primer
# intento y se puso rojo con razón: esa serie es la previsión **cruda** del sensor,
# sin el sesgo del tejado ni el desvio de hoy. Con el tejado dando más de lo
# prometido, esta tarjeta se pasa de esa cifra con todo el derecho, así que la
# comparación no medía una incoherencia sino una corrección funcionando.
forma = ((d.get("window") or {}).get("today") or {}).get("shape") or {}
en_la_ventana = {}
for iso, w in zip(forma.get("t") or [], forma.get("sol") or []):
    # Solo el tramo previsto: en el medido la ventana dibuja lo que pasó, y esta
    # tarjeta habla del futuro, así que ahí no hay nada que comparar.
    if not forma.get("real_until") or iso >= forma["real_until"]:
        en_la_ventana[iso] = w
comunes = [(h, en_la_ventana[h["at"]]) for h in api["hours"] if h["at"] in en_la_ventana]
ok(bool(comunes), f"hay instantes en las dos tarjetas ({len(comunes)})")
discrepan = [(h["at"][11:16], h["sun_w"], w) for h, w in comunes
             if abs(h["sun_w"] - w) > 0.15]
ok(not discrepan,
   f"y el sol es el mismo en las dos ({discrepan[:3] or 'sin discrepancias'})")
grupos = pide("/api/entities/grouped")
ok(any(e["entity_id"] == api["entity"] for e in grupos.get("weather", [])),
   "la entidad sale en el grupo «weather» de los desplegables")
ok(all(e["entity_id"].startswith("weather.") for e in grupos.get("weather", [])),
   "que solo contiene entidades del tiempo")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

"""El perfil horario del consumo, comprobado contra la cifra plana.

  1. el perfil sale de InfluxDB cuando está configurado (v1 y v2)
  2. si Influx no responde o viene vacío, se cae al recorder sin romperse
  3. el umbral de cada hora se parece al consumo real de esa hora
  4. distingue laborable de fin de semana
  5. con perfil, la ventana promete lo que hay: menos kWh y con sus huecos
  6. el hueco pone el estado en «pre» con la hora de reapertura
  7. free_window con umbral plano sigue dando exactamente lo de antes
"""
import asyncio
import math
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
import live as L                                            # noqa: E402
import series as S                                          # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
fallos = []


def comprobar(ok, texto):
    if not ok:
        fallos.append(texto)
    print(("  ok    " if ok else "  FALLA ") + texto)


def casa(h, laborable=True):
    w = 320.0
    if laborable:
        if 13.0 <= h < 14.0:
            w += 2200.0
    else:
        if 14.0 <= h < 15.0:
            w += 2400.0
    if 21.0 <= h < 22.5:
        w += 900.0
    return w


def pv(h, pico, centro=14.2, ancho=5.6):
    x = (h - centro) / ancho
    return max(0.0, pico * math.cos(x * math.pi / 2)) if abs(x) < 1 else 0.0


ESTADOS = {"sensor.home_power": {"attributes": {"unit_of_measurement": "W"}}}


def ajustes(version, url="http://127.0.0.1:8186"):
    return {
        "flow_sensors": {"home": "sensor.home_power"},
        "influx": {"version": version, "url": url, "database": "homeassistant",
                   "measurement": "W", "org": "casa", "token": "x"},
        "ha_url": "http://127.0.0.1:8132", "ha_token": "x",
    }


async def main():
    ahora = datetime.now(TZ).replace(minute=0, second=0, microsecond=0)
    medianoche = ahora.replace(hour=0)

    # --- 1: de InfluxDB, v1 y v2 -------------------------------------------
    print("\n1 · el histórico sale de InfluxDB")
    perfiles = {}
    for version in (1, 2):
        L._baseline_cache.update({"key": None, "at": 0.0, "value": None})
        p = await L._house_profile(ajustes(version), ESTADOS, TZ, ahora)
        perfiles[version] = p
        comprobar(p is not None and p.origen == "influxdb",
                  f"v{version}: origen «{p.origen if p else '—'}» · {p.dias if p else 0} días")
        comprobar(p is not None and p.por_horas, f"v{version}: es un perfil por horas")

    # --- 2: respaldo ---------------------------------------------------------
    print("\n2 · respaldo cuando Influx no da nada")
    for etiqueta, url in (("URL que no responde", "http://127.0.0.1:8199"),
                          ("sin Influx configurado", "")):
        L._baseline_cache.update({"key": None, "at": 0.0, "value": None})
        cfg = ajustes(2, url)
        p = await L._house_profile(cfg, ESTADOS, TZ, ahora)
        # El HA falso del banco sí responde, así que debe caer al recorder.
        comprobar(p is not None and p.origen == "recorder",
                  f"{etiqueta} → origen «{p.origen if p else '—'}»")

    # --- 3 y 4: el umbral de cada hora --------------------------------------
    print("\n3 · el umbral de cada hora se parece al consumo de esa hora")
    p = perfiles[2]
    lunes = medianoche - timedelta(days=medianoche.weekday())      # un lunes
    sabado = lunes + timedelta(days=5)
    for h in (0, 9, 13, 21):
        real = casa(h + 0.5, True)
        dado = p.at(lunes + timedelta(hours=h))
        comprobar(abs(dado - real) < real * 0.1 + 20,
                  f"laborable {h:02d}h: perfil {dado:7.0f} W · real {real:7.0f} W")
    print("\n4 · distingue laborable de fin de semana")
    l14 = p.at(lunes + timedelta(hours=14))
    s14 = p.at(sabado + timedelta(hours=14))
    comprobar(s14 > l14 * 1.5,
              f"a las 14h: laborable {l14:.0f} W · sábado {s14:.0f} W (el sábado come más tarde)")

    # --- 5: la ventana con perfil -------------------------------------------
    print("\n5 · la ventana promete lo que hay")
    for nombre, pico in (("día claro   ", 5200), ("con nubes   ", 1800)):
        pts = [(medianoche + timedelta(hours=k / 2), pv(k / 2, pico)) for k in range(48)]
        plana = S.free_window(pts, p.plano, medianoche)
        fina = S.free_window(pts, p.at, medianoche)
        comprobar(fina is not None and fina["kwh"] <= plana["kwh"],
                  f"{nombre}: plano {plana['kwh']:5.2f} kWh → perfil {fina['kwh']:5.2f} kWh")
        if pico == 1800:
            comprobar(len(fina["gaps"]) >= 1,
                      f"{nombre}: la ventana se parte en {len(fina['spans'])} tramos "
                      f"({len(fina['gaps'])} hueco)")
            g = fina["gaps"][0]
            comprobar(11 <= datetime.fromisoformat(g["start"]).hour <= 14,
                      f"{nombre}: y el hueco cae en la hora del horno "
                      f"({g['start'][11:16]}–{g['end'][11:16]})")
            comprobar(abs(fina["net_hours"] - sum(s["hours"] for s in fina["spans"])) < 1e-6
                      and fina["net_hours"] < fina["hours"],
                      f"{nombre}: {fina['net_hours']:.2f} h netas de {fina['hours']:.2f} h de punta a punta")

    # --- 6: el estado dentro del hueco --------------------------------------
    print("\n6 · dentro del hueco el estado es «pre», con hora de vuelta")
    pts = [(medianoche + timedelta(hours=k / 2), pv(k / 2, 1800)) for k in range(48)]
    fina = S.free_window(pts, p.at, medianoche)
    hueco = fina["gaps"][0]
    dentro = datetime.fromisoformat(hueco["start"]) + timedelta(minutes=10)
    tramos = [(datetime.fromisoformat(s["start"]), datetime.fromisoformat(s["end"]))
              for s in fina["spans"]]
    esta = next(((a, b) for a, b in tramos if a <= dentro < b), None)
    comprobar(esta is None, f"a las {dentro.strftime('%H:%M')} no se está en ningún tramo")
    siguiente = next((a for a, _ in tramos if a > dentro), None)
    comprobar(siguiente is not None and siguiente.isoformat() == hueco["end"],
              f"y el siguiente abre a las {siguiente.strftime('%H:%M') if siguiente else '—'}")

    # --- 7: el umbral plano no cambia ---------------------------------------
    print("\n7 · con umbral plano, lo de siempre")
    pts = [(medianoche + timedelta(hours=k / 2), pv(k / 2, 5200)) for k in range(48)]
    v = S.free_window(pts, 320.0, medianoche)
    comprobar(len(v["spans"]) == 1 and not v["gaps"],
              f"un solo tramo sin huecos: {v['start'][11:16]}–{v['end'][11:16]}")
    comprobar(abs(v["net_hours"] - v["hours"]) < 1e-6,
              f"y las horas netas son las de punta a punta ({v['hours']:.2f} h)")
    # Monotonía: subir el umbral no puede alargar la ventana ni dar más kWh.
    anterior = None
    for umbral in (0.0, 200.0, 400.0, 800.0, 1600.0):
        w = S.free_window(pts, umbral, medianoche)
        if anterior is not None:
            comprobar(w["kwh"] <= anterior["kwh"] + 1e-9 and w["net_hours"] <= anterior["net_hours"] + 1e-9,
                      f"umbral {umbral:6.0f} W → {w['net_hours']:5.2f} h · {w['kwh']:6.2f} kWh")
        anterior = w

    print("\n" + (f"{len(fallos)} comprobaciones fallidas" if fallos else "todo en verde"))
    return 1 if fallos else 0


sys.exit(asyncio.run(main()))

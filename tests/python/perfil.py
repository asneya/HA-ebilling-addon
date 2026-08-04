"""El perfil horario del consumo, comprobado contra la cifra plana.

  1. el perfil sale de InfluxDB cuando está configurado (v1 y v2)
  2. si Influx no responde o viene vacío, se cae al recorder sin romperse
  3. el umbral de cada hora se parece al consumo real de esa hora
  4. distingue laborable de fin de semana
  5. con perfil, la ventana promete lo que hay: menos kWh y con sus huecos
  6. el hueco pone el estado en «pre» con la hora de reapertura
  7. free_window con umbral plano sigue dando exactamente lo de antes
  8. el perfil dice cuánto se equivoca, medido contra un día que no vio
  9. y ese error se traduce a **minutos** por la pendiente del cruce: los mismos
     vatios valen cinco minutos en una mañana clara y hora y media con nubes
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

    print("\n8 · cuánto se equivoca el perfil, y medido fuera de muestra")
    # Lo que sí valía del forecaster de EMHASS: no el modelo —sus variables de
    # calendario ya las tiene este perfil— sino **el número que reporta**. Un perfil
    # que dice de dónde sale pero no cuánto acierta no deja saber cuánto fiarse de la
    # ventana que se calcula con él.
    #
    # Cinco días a 500 W y el último a 800: el perfil de la medida se construye con los
    # cuatro primeros (mediana 500) y se compara contra el quinto. Error esperado:
    # |800 − 500| = 300 W, y el 38 % de los 800 de ese día. Salen a mano.
    dia0 = medianoche - timedelta(days=4)
    muestras = []
    for d in range(5):
        for h in range(24):
            momento = dia0 + timedelta(days=d, hours=h)
            muestras.append((momento, 800.0 if d == 4 else 500.0))
    perfil = L._perfil_de(muestras, "recorder", 5)
    e = perfil.error
    comprobar(e is not None, "el perfil publica su desviación")
    comprobar(e and abs(e["mae_w"] - 300.0) < 0.5,
              f"con el error que sale a mano ({e and e['mae_w']} W de 300)")
    comprobar(e and e["mae_pct"] == 38,
              f"y en porcentaje del consumo del día, no punto a punto ({e and e['mae_pct']} %)")
    # El día apartado es el último, y **solo** ese: si alguien midiera contra todo el
    # histórico, `hours` serían las 120 muestras y no las 24 de un día.
    comprobar(e and e["day"] == (dia0 + timedelta(days=4)).date().isoformat(),
              f"medido contra el último día ({e and e['day']})")
    comprobar(e and e["hours"] == 24,
              f"y solo contra ese día, no contra el histórico entero ({e and e['hours']} h)")
    # Y el perfil que **se usa** sigue construido con todo: la desviación es una
    # medida sobre un perfil reducido, no un cambio en el que decide la ventana.
    comprobar(abs(perfil.at(dia0 + timedelta(days=4, hours=3)) - 500.0) < 0.5,
              f"el perfil que decide sigue hecho con todo ({perfil.at(dia0 + timedelta(days=4, hours=3)):.0f} W)")

    # Con dos días no se da número: el «día apartado» sería la mitad del histórico y el
    # perfil que queda no se parece al que se usa. Callar es más honesto.
    cortas = [(dia0 + timedelta(days=d, hours=h), 500.0)
              for d in range(2) for h in range(24)]
    comprobar(L._perfil_de(cortas, "recorder", 2).error is None,
              "con dos días de histórico no se publica desviación")

    print("\n9 · el error del perfil, traducido a minutos por la pendiente del cruce")
    # El paso que le faltaba al número de §8 para servir de algo. La ventana no habla
    # de vatios, habla de horas: «tu ventana abre a las 11:40». Un error de 300 W no
    # dice nada sobre las 11:40 hasta que se divide por la pendiente con la que el sol
    # cruza el umbral, y **esa pendiente cambia muchísimo de un día a otro**, que es
    # justo la razón de hacer la cuenta.
    #
    # Dos días con el mismo perfil (500 W planos) y el mismo error medido (300 W):
    #
    #   · mañana clara: la curva sube 3.000 W/h ⇒ 300/3000 × 60 = 6 min → 5 (redondeo)
    #   · día de nubes: sube 200 W/h           ⇒ 300/200  × 60 = 90 min
    #
    # Las dos cuentas salen a mano, y la segunda es la que importa: ese día la tarjeta
    # daba la hora con el mismo aplomo que la mañana clara.
    plano = L.HouseProfile({}, 500.0, "recorder", 5,
                           {"mae_w": 300.0, "mae_pct": 12, "day": "2026-08-03",
                            "hours": 24, "mean_w": 2500.0})

    def curva(subida, arranque):
        """Una rampa de `subida` W/h desde `arranque` W a las 08:00, y de vuelta."""
        pts = []
        for k in range(48):
            h = k / 2
            if h < 8.0:
                w = 0.0
            elif h <= 14.0:
                w = arranque + subida * (h - 8.0)
            else:
                w = max(0.0, arranque + subida * 6.0 - subida * (h - 14.0) * 3)
            pts.append((medianoche + timedelta(hours=h), w))
        return pts

    for etiqueta, subida, arranque, espera in (
        ("mañana clara", 3000.0, 0.0, 5),
        ("día de nubes", 200.0, 400.0, 90),
    ):
        v = S.free_window(curva(subida, arranque), plano.at, medianoche)
        tramo = v["spans"][0]
        comprobar(abs(tramo["start_slope_w_h"] - subida) < 1.0,
                  f"{etiqueta}: la pendiente del corte es la de la rampa "
                  f"({tramo['start_slope_w_h']} W/h de {subida:.0f})")
        holgura = L._holgura_de(plano, v, tramo["start"], "start")
        comprobar(holgura == espera,
                  f"{etiqueta}: 300 W de error son {holgura} min ({espera} a mano)")

    # Y cuándo **no** se dice: sin error medido no hay nada que traducir, y un extremo
    # que no es un cruce sino el borde de la previsión no tiene pendiente. Decir cero
    # ahí sería decir «holgura infinita».
    v = S.free_window(curva(200.0, 400.0), plano.at, medianoche)
    sin_error = L.HouseProfile({}, 500.0, "recorder", 5, None)
    comprobar(L._holgura_de(sin_error, v, v["spans"][0]["start"], "start") is None,
              "sin desviación medida no se dice holgura, en vez de una inventada")
    # Un día que amanece ya por encima del umbral: el primer extremo es el borde de la
    # previsión, no un cruce.
    amanece = [(medianoche + timedelta(hours=k / 2), 2000.0 if k / 2 < 20 else 0.0)
               for k in range(48)]
    va = S.free_window(amanece, plano.at, medianoche)
    comprobar(va["spans"][0]["start_slope_w_h"] is None,
              "un extremo que no es un cruce no lleva pendiente")
    comprobar(L._holgura_de(plano, va, va["spans"][0]["start"], "start") is None,
              "y entonces tampoco holgura")

    print("\n" + (f"{len(fallos)} comprobaciones fallidas" if fallos else "todo en verde"))
    return 1 if fallos else 0


sys.exit(asyncio.run(main()))

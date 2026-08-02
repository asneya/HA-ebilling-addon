"""Detección de ciclos, contra una curva de la que se sabe la respuesta.

Lo que se comprueba:
  1. un ciclo limpio mide lo que duró, ni un minuto más
  2. una pausa a media faena no parte el ciclo en tres
  3. una parada de verdad sí lo parte
  4. el ruido por debajo del umbral no es un ciclo
  5. la mediana no la mueve un día raro
  6. los veredictos del diseño, con sus copias
  7. el reparto del cierre del día, por solape con la ventana
"""
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
import appliances as A                                        # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


def curva(tramos, dia="2026-07-20"):
    """[(desde_h, hasta_h, watts)] → muestras de cinco minutos de todo el día."""
    base = datetime.fromisoformat(dia + "T00:00:00").replace(tzinfo=TZ)
    out = []
    for i in range(288):
        h = i * 5 / 60
        w = 0.0
        for d, f, watts in tramos:
            if d <= h < f:
                w = watts
        out.append((base + timedelta(minutes=5 * i), w))
    return out


print("1 · un ciclo limpio mide lo que duró")
c = A._ciclos_de(curva([(10, 12, 2000)]), 15)
ok(len(c) == 1, f"un solo ciclo ({len(c)})")
ok(abs(c[0]["hours"] - 2.0) < 0.01, f"dura 2 h exactas ({c[0]['hours']:.2f} h)")
ok(abs(c[0]["kwh"] - 4.0) < 0.05, f"y se lleva 4 kWh ({c[0]['kwh']:.2f})")
ok(c[0]["start"].hour == 10, f"empieza a las 10 ({c[0]['start']:%H:%M})")
ok(c[0]["end"].hour == 12, f"y acaba a las 12 ({c[0]['end']:%H:%M})")

print("\n2 · una pausa a media faena no parte el ciclo")
# Lavavajillas: lava, descansa 10 min, seca.
c = A._ciclos_de(curva([(22, 22.75, 1500), (22.9, 23.5, 900)]), 15)
ok(len(c) == 1, f"sigue siendo un ciclo ({len(c)})")
ok(abs(c[0]["hours"] - 1.5) < 0.09, f"y dura lo que va de punta a punta ({c[0]['hours']:.2f} h)")

print("\n3 · una parada de verdad sí lo parte")
c = A._ciclos_de(curva([(10, 11, 2000), (14, 15, 2000)]), 15)
ok(len(c) == 2, f"dos ciclos ({len(c)})")
ok(all(abs(x["hours"] - 1.0) < 0.01 for x in c),
   f"de una hora cada uno ({[round(x['hours'], 2) for x in c]})")

print("\n4 · el reposo no es un ciclo")
ok(A._ciclos_de(curva([(0, 24, 3)]), 15) == [], "un enchufe a 3 W todo el día no da ningún ciclo")
ok(A._ciclos_de(curva([(10, 10.04, 2000)]), 15) == [],
   "ni un pico de una sola muestra: por debajo de diez minutos no es un ciclo")
ok(len(A._ciclos_de(curva([(10, 10.15, 2000)]), 15)) == 1,
   "diez minutos sí, que es el mínimo (un hervidor no se programa, una lavadora sí)")
ok(len(A._ciclos_de(curva([(10, 12, 2000), (3, 5, 8)]), 15)) == 1,
   "y el ruido de madrugada no cuenta")

print("\n5 · la mediana no la mueve un día raro")
muestras = []
for i, largo in enumerate([2, 2, 2, 2, 8]):        # un día se quedó puesta 8 h
    muestras += curva([(10, 10 + largo, 2000)], f"2026-07-{10 + i:02d}")
c = A._ciclos_de(muestras, 15)
r = A._resumen(c, 14)
ok(len(c) == 5, f"cinco ciclos ({len(c)})")
ok(abs(r["hours"] - 2.0) < 0.01,
   f"y «lo que suele durar» son 2 h, no la media de 3,2 ({r['hours']:.2f} h)")
ok(r["cycles"] == 5 and r["peak_w"] == 2000, "con su recuento y su pico")
ok(A._resumen(c[:1], 14) is None, "con un solo ciclo no se habla de «suele»")

print("\n6 · los veredictos del diseño")
ventana = {"today": {"start": "2026-07-20T11:40:00+02:00", "end": "2026-07-20T16:20:00+02:00"}}
ciclo = lambda h, kwh: {"hours": h, "kwh": kwh}    # noqa: E731


def v(hora, h, kwh=1.0, precio=0.2481):
    return A.verdict(ciclo(h, kwh), ventana,
                     datetime.fromisoformat(f"2026-07-20T{hora}:00+02:00"), precio)


r = v("12:00", 2.0)
ok(r["kind"] == "gratis" and r["value"] == "Gratis" and r["sub"] == "ahora mismo",
   f"dentro y de sobra: «{r['value']}» · «{r['sub']}»")
r = v("09:00", 2.0)
ok(r["kind"] == "gratis" and r["sub"] == "desde las 11:40",
   f"antes de abrir dice desde cuándo: «{r['sub']}»")
r = v("14:30", 1.8)
ok(r["kind"] == "justo" and r["value"] == "Cabe justo" and r["sub"] == "empieza ya",
   f"cabe pelado: «{r['value']}» · «{r['sub']}»")
r = v("09:00", 4.6)
ok(r["kind"] == "justo" and r["sub"] == "sal puntual",
   f"pelado y aún sin abrir: «{r['sub']}»")
r = v("15:00", 4.0, kwh=2.0)
ok(r["kind"] == "parcial" and "% gratis" in r["sub"],
   f"no cabe entero: {r['value']} € · «{r['sub']}»")
ok(r["value"] == round(2.0 * (1 - 1.3333 / 4.0) * 0.2481, 2),
   f"y se paga solo la parte de fuera ({r['value']} €)")
r = v("18:00", 1.0, kwh=2.0)
ok(r["kind"] == "cerrada" and r["sub"] == "la ventana ya cerró" and r["value"] == 0.5,
   f"cerrada, lo que cuesta ahora: {r['value']} € · «{r['sub']}»")
ok(v("12:00", 2.0, precio=None)["kind"] == "gratis", "sin precio, «Gratis» sigue siendo gratis")
ok(v("18:00", 1.0, precio=None)["value"] is None, "pero un coste sin precio no se inventa")
ok(A.verdict(None, ventana, datetime.now(TZ), 0.2)["kind"] == "aprendiendo",
   "sin ciclo aprendido no hay veredicto")
ok(A.verdict(ciclo(1, 1), None, datetime.now(TZ), 0.2)["kind"] == "sin-ventana",
   "y sin ventana tampoco")

print("\n7 · el cierre reparte cada ciclo por su solape con la ventana")
lista = [{"id": "a", "name": "Lavadora", "color": "#4a4ee0", "icon": "lavadora"}]
# Un ciclo de 11:40 a 13:40: entero dentro. Otro de 15:20 a 17:20: mitad fuera.
aprendido = {"a": {"today": [
    {"start": "2026-07-20T11:40:00+02:00", "end": "2026-07-20T13:40:00+02:00", "kwh": 2.0},
    {"start": "2026-07-20T15:20:00+02:00", "end": "2026-07-20T17:20:00+02:00", "kwh": 2.0},
]}}
filas = A.del_cierre(lista, aprendido, ventana)
ok(len(filas) == 1 and filas[0]["runs"] == 2, f"dos ciclos hoy ({filas[0]['runs']})")
ok(filas[0]["kwh"] == 4.0, f"cuatro kWh en total ({filas[0]['kwh']})")
ok(abs(filas[0]["in_window_kwh"] - 3.0) < 0.02,
   f"tres dentro de la ventana: el primero entero y medio del segundo ({filas[0]['in_window_kwh']})")
ok(filas[0]["pct"] == 75, f"o sea el 75 % ({filas[0]['pct']} %)")
ok(A.del_cierre(lista, {"a": {"today": []}}, ventana) == [],
   "y lo que no se ha puesto no sale")


print("\n8 · de dónde saldría la energía de un ciclo puesto ahora")
AHORA = datetime.fromisoformat("2026-07-20T12:00:00+02:00")
ciclo2h = {"hours": 2.0, "kwh": 2.0}          # 1.000 W de media


def fuentes(sol, casa=300.0, soc=100.0, cap=7.5):
    return {"sol_at": lambda m: sol, "casa_at": lambda m: casa,
            "soc": soc, "capacity_kwh": cap}


e = A.estimate(ciclo2h, AHORA, 0.20, fuentes(sol=3000.0))
ok(abs(e["sun_kwh"] - 2.0) < 0.02 and e["battery_kwh"] == 0 and e["grid_kwh"] == 0,
   f"con sol de sobra lo pone el sol entero (sol {e['sun_kwh']} · bat {e['battery_kwh']})")
ok(e["battery_eur"] == 0.0, "y no cuesta nada de batería")

e = A.estimate(ciclo2h, AHORA, 0.20, fuentes(sol=0.0))
ok(abs(e["battery_kwh"] - 2.0) < 0.02 and e["grid_kwh"] == 0,
   f"de noche lo pone la batería (bat {e['battery_kwh']} de 7,5 kWh)")
ok(e["battery_pct"] == 27, f"y es el 27 % de la batería ({e['battery_pct']} %)")
ok(abs(e["battery_eur"] - 0.40) < 0.01,
   f"valorado al precio de importar: {e['battery_eur']} € (2 kWh × 0,20)")

# Sol a 800 W con la casa en 300: sobran 500 de los 1.000 que pide el aparato.
e = A.estimate(ciclo2h, AHORA, 0.20, fuentes(sol=800.0))
ok(abs(e["sun_kwh"] - 1.0) < 0.03 and abs(e["battery_kwh"] - 1.0) < 0.03,
   f"a medias: {e['sun_kwh']} kWh de sol y {e['battery_kwh']} de batería")

# Batería casi vacía: 6 % de 7,5 kWh son 0,45 kWh; el resto, red.
e = A.estimate(ciclo2h, AHORA, 0.20, fuentes(sol=0.0, soc=6.0))
ok(abs(e["battery_kwh"] - 0.45) < 0.03 and abs(e["grid_kwh"] - 1.55) < 0.03,
   f"con la batería casi vacía entra la red ({e['battery_kwh']} bat · {e['grid_kwh']} red)")
ok(abs((e["battery_eur"] + e["grid_eur"]) - 0.40) < 0.02,
   f"y el total en euros no cambia: {e['battery_eur']} + {e['grid_eur']}")

# Sin capacidad configurada no se puede separar, y se dice.
e = A.estimate(ciclo2h, AHORA, 0.20, fuentes(sol=0.0, cap=0.0))
ok(e["split"] is False, "sin capacidad configurada, `split` es falso")
ok(e["battery_pct"] is None, "y no se finge un porcentaje de batería")
ok(abs(e["battery_kwh"] - 2.0) < 0.02, f"pero el total sigue estando ({e['battery_kwh']} kWh)")

# La suma siempre es la energía del ciclo, se reparta como se reparta.
for sol in (0.0, 400.0, 900.0, 5000.0):
    e = A.estimate(ciclo2h, AHORA, 0.20, fuentes(sol=sol))
    ok(abs(e["total_kwh"] - 2.0) < 0.05,
       f"con {sol:.0f} W de sol la suma sigue siendo el ciclo ({e['total_kwh']} kWh)")

ok(A.estimate(None, AHORA, 0.20, fuentes(0.0)) is None, "sin ciclo no hay estimación")
ok(A.estimate(ciclo2h, AHORA, 0.20, None) is None, "y sin fuentes tampoco")
e = A.estimate(ciclo2h, AHORA, None, fuentes(sol=0.0))
ok(e["battery_eur"] is None, "sin precio, los kWh sí y los euros no")

print("\n" + (f"{len(fallos)} fallos" if fallos else "todo en verde"))
sys.exit(1 if fallos else 0)

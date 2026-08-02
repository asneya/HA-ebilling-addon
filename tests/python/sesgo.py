"""El sesgo del tejado: lo que la previsión se pasa o se queda corta, por hora.

  1. se apuntan los pares (previsto, real) de las horas cerradas de hoy
  2. y solo esas: la hora en curso va a medias y sesgaría todos los días
  3. con pocos días no se corrige nada, que es lo honesto
  4. con días de sobra sale la mediana, no la media
  5. un día raro no desplaza la corrección
  6. el factor se recorta arriba y abajo
  7. una desviación de nada no se corrige: ensuciaría la explicación
  8. una previsión casi a cero no genera cociente
  9. `aplicar` corrige la curva hora a hora
 10. el histórico se poda a los días que se guardan
 11. `por_horas` integra la curva de potencia en Wh por hora
"""
import json
import os
import shutil
import sys
import tempfile
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
import prevision as P                                        # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


DIR = tempfile.mkdtemp(prefix="sesgo-")


def limpiar():
    for f in os.listdir(DIR):
        os.remove(os.path.join(DIR, f))


def sembrar(dias, factores, desde=date(2026, 7, 1)):
    """`dias` jornadas en las que la hora h produce `factores[h] × previsto`."""
    for d in range(dias):
        prev = {h: 1000.0 for h in factores}
        real = {h: 1000.0 * f for h, f in factores.items()}
        P.registrar(DIR, desde + timedelta(days=d), prev, real)


print("1-3 · hacen falta días")
limpiar()
sembrar(P.MIN_DIAS - 1, {9: 0.6, 14: 1.0})
s = P.aprender(DIR)
ok(not s, f"con {P.MIN_DIAS - 1} días no se corrige nada (bool={bool(s)})")
ok(s.factor(datetime(2026, 8, 2, 9, tzinfo=TZ)) == 1.0, "y el factor es 1")

print("\n4-5 · la mediana, no la media")
limpiar()
sembrar(6, {9: 0.6})
# Un día raro: a las nueve produce el triple de lo previsto.
P.registrar(DIR, date(2026, 7, 20), {9: 1000.0}, {9: 3000.0})
s = P.aprender(DIR)
f9 = s.factor(datetime(2026, 8, 2, 9, tzinfo=TZ))
ok(abs(f9 - 0.6) < 0.01, f"a las 9 el tejado da el 60 % ({f9:.2f})")
ok(f9 < 1.0, "un día suelto de tres veces lo previsto no lo mueve")

print("\n6 · el recorte")
limpiar()
sembrar(6, {10: 0.05, 11: 9.0})
s = P.aprender(DIR)
ok(s.factor(datetime(2026, 8, 2, 10, tzinfo=TZ)) == P.MIN_FACTOR,
   f"por abajo se recorta a {P.MIN_FACTOR}")
ok(s.factor(datetime(2026, 8, 2, 11, tzinfo=TZ)) == P.MAX_FACTOR,
   f"y por arriba a {P.MAX_FACTOR}")

print("\n7-8 · lo que no se corrige")
limpiar()
sembrar(6, {12: 0.98})
ok(not P.aprender(DIR), "una desviación del 2 % se deja estar")
limpiar()
for d in range(6):
    # Previsión por debajo del suelo: no da para un cociente.
    P.registrar(DIR, date(2026, 7, 1) + timedelta(days=d),
                {6: P.MIN_PREVISTO_WH - 1}, {6: 500.0})
ok(not P.aprender(DIR), "una previsión casi a cero tampoco genera factor")

print("\n9 · aplicar a la curva")
limpiar()
sembrar(6, {9: 0.5, 14: 1.2})
s = P.aprender(DIR)
curva = [(datetime(2026, 8, 2, h, tzinfo=TZ), 1000.0) for h in (9, 12, 14)]
corregida = dict((t.hour, w) for t, w in s.aplicar(curva))
ok(abs(corregida[9] - 500.0) < 1, f"las 9 se corrigen a la mitad ({corregida[9]:.0f} W)")
ok(abs(corregida[14] - 1200.0) < 1, f"las 14 suben un 20 % ({corregida[14]:.0f} W)")
ok(corregida[12] == 1000.0, "y una hora sin dato se queda como está")
pay = s.payload()
ok(pay["horas"] == 2 and pay["dias"] == 6,
   f"el resumen dice qué corrige ({pay['horas']} horas, {pay['dias']} días)")
ok(pay["peor"]["hora"] == 9, f"y cuál es la que más se desvía ({pay['peor']})")

print("\n10 · se poda el histórico")
limpiar()
sembrar(P.DIAS + 10, {9: 0.6})
with open(os.path.join(DIR, "vatia-prevision.json"), encoding="utf-8") as fh:
    guardado = json.load(fh)["dias"]
ok(len(guardado) == P.DIAS, f"se guardan {P.DIAS} días ({len(guardado)})")
ok(max(guardado) > min(guardado), "y son los últimos, no los primeros")

print("\n11 · Wh por hora")
# Una hora a 1.000 W en dos tramos de media hora = 1.000 Wh.
puntos = [(datetime(2026, 8, 2, 9, m, tzinfo=TZ), 1000.0) for m in (0, 30)]
puntos.append((datetime(2026, 8, 2, 10, 0, tzinfo=TZ), 1000.0))
wh = P.por_horas(puntos)
ok(abs(wh[9] - 1000.0) < 1, f"1.000 W durante una hora son 1.000 Wh ({wh[9]:.0f})")
# Una rampa de 0 a 1.000 en una hora son 500 Wh.
rampa = [(datetime(2026, 8, 2, 8, tzinfo=TZ), 0.0),
         (datetime(2026, 8, 2, 9, tzinfo=TZ), 1000.0)]
ok(abs(P.por_horas(rampa)[8] - 500.0) < 1, "y una rampa, la mitad")

shutil.rmtree(DIR, ignore_errors=True)
print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

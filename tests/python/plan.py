"""El planificador del día: cuándo cada aparato y si cargar la batería en valle.

  1. con sol a mediodía, el mejor momento es a mediodía
  2. y se dice cuánto se ahorra frente a ponerlo ahora
  3. sin nada que ganar, no se pide esperar
  4. la batería se valora a lo que cuesta reponerla, no al precio de la hora
  5. sin precios el plan sale igual, ordenado por lo que no pone el sol
  6. un ciclo que no cabe en el horizonte no se planifica
  7. las filas van por lo que más se gana moviéndolas
  8. cargar de la red: solo si el sol no va a llenar la batería
  9. y solo si el ahorro se nota
 10. sin capacidad o sin carga no se contesta
 11. sin fuentes no hay plan, en vez de un plan inventado
"""
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
import planner as P                                          # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


AHORA = datetime(2026, 8, 2, 6, 0, tzinfo=TZ)


def sol(t):
    """Campana con la punta a las 14:00 y 5 kW; de noche, nada."""
    h = t.hour + t.minute / 60.0
    if t.date() > AHORA.date():
        h += 24
        if h > 38:
            return 0.0
        h -= 24
    if h < 8 or h > 20:
        return 0.0
    return max(0.0, 5000.0 * (1 - ((h - 14.0) / 6.0) ** 2))


def casa(_t):
    return 300.0


def precio(t):
    """Valle de 00 a 08 (0,08 €) y punta el resto (0,25 €)."""
    return 0.08 if t.hour < 8 else 0.25


FUENTES = {"sol_at": sol, "casa_at": casa, "soc": 50.0, "capacity_kwh": 10.0}
LAVADORA = {"id": "l", "name": "Lavadora", "color": "#4a4ee0", "icon": "lavadora"}
APRENDIDO = {"l": {"cycle": {"hours": 2.0, "kwh": 1.4}}}

print("1-3 · a qué hora sale más barato")
p = P.plan([LAVADORA], APRENDIDO, FUENTES, precio, AHORA)
fila = p["rows"][0]
mejor = datetime.fromisoformat(fila["best"]["at"])
# El **primero** que sale gratis, no el del mediodía: si a las 8:45 el sol ya
# cubre el ciclo entero, mandar a esperar cinco horas para lo mismo sería peor
# consejo. Los empates se rompen por la hora más temprana, a propósito.
ok(8 <= mejor.hour <= 15, f"el mejor momento es con sol ({mejor:%H:%M})")
ok(fila["best"]["sun_pct"] >= 95,
   f"y ahí lo cubre el sol casi entero ({fila['best']['sun_pct']} %)")
ok(fila["now"]["sun_pct"] == 0, f"mientras que ahora, a las 6, nada ({fila['now']['sun_pct']} %)")
ok(fila["saving_eur"] > 0, f"se ahorra esperando ({fila['saving_eur']} €)")
ok(fila["worth_waiting"] is True, "así que sí merece la pena esperar")
ok(fila["priced"] is True, "y la cuenta va en euros")

# Puesto ya a mediodía, no hay nada que ganar.
mediodia = AHORA.replace(hour=13)
p2 = P.plan([LAVADORA], APRENDIDO, FUENTES, precio, mediodia)
f2 = p2["rows"][0]
ok(not f2["worth_waiting"] or (f2["saving_eur"] or 0) >= P.MIN_AHORRO_EUR,
   f"a mediodía no se pide esperar por nada ({f2['saving_eur']} €)")

print("\n4 · lo que vale la batería")
ok(abs(p["battery_eur_kwh"] - 0.08) < 1e-9,
   f"se repone al precio más barato del horizonte ({p['battery_eur_kwh']} €/kWh)")
# Si se valorase a precio de la hora, mover un ciclo de noche a otra hora de
# noche cambiaría el coste; con el valor de reposición, no.
sin_sol = {**FUENTES, "sol_at": lambda _t: 0.0, "soc": 100.0}
p3 = P.plan([LAVADORA], APRENDIDO, sin_sol, precio, AHORA)
f3 = p3["rows"][0]
ok(abs((f3["saving_eur"] or 0)) < 1e-6,
   f"de noche y con batería llena, da igual la hora ({f3['saving_eur']} €)")

print("\n5-6 · sin precios y ciclos largos")
p4 = P.plan([LAVADORA], APRENDIDO, FUENTES, None, AHORA)
f4 = p4["rows"][0]
ok(f4["priced"] is False, "sin tarifa «la mía» no hay euros")
ok(f4["saving_eur"] is None, "ni ahorro que prometer")
ok(8 <= datetime.fromisoformat(f4["best"]["at"]).hour <= 15,
   f"pero el mejor momento sigue siendo con sol ({f4['best']['at'][11:16]})")
ok(f4["best"]["sun_pct"] >= 95,
   f"y se elige por lo que no hay que comprar ({f4['best']['sun_pct']} % de sol)")
largo = {"l": {"cycle": {"hours": 30.0, "kwh": 10.0}}}
# Sin filas, pero el consejo de la batería se sostiene solo: el plan no es
# `None` por eso, y no debe serlo.
ok(P.plan([LAVADORA], largo, FUENTES, precio, AHORA)["rows"] == [],
   "un ciclo que no cabe en 24 h no se planifica")

print("\n6b · el reparto suma lo que dice el ciclo")
# Un ciclo de 1,9 h no cae en cuartos de hora: con un paso fijo la simulación
# duraba 2,0 h y el «% con sol» pasaba del 100.
raro = {"l": {"cycle": {"hours": 1.9, "kwh": 1.33}}}
fr = P.plan([LAVADORA], raro, FUENTES, precio, AHORA)["rows"][0]
for cual in ("now", "best"):
    o = fr[cual]
    suma = o["sun_kwh"] + o["battery_kwh"] + o["grid_kwh"]
    ok(abs(suma - fr["kwh"]) < 0.02,
       f"{cual}: sol+batería+red = el ciclo ({suma:.2f} vs {fr['kwh']})")
    ok(o["sun_pct"] <= 100, f"{cual}: el sol no pasa del 100 % ({o['sun_pct']} %)")

print("\n7 · el orden")
dos = [LAVADORA, {"id": "h", "name": "Horno", "color": "#8a5a2b", "icon": "horno"}]
apr = {"l": {"cycle": {"hours": 2.0, "kwh": 1.4}},
       "h": {"cycle": {"hours": 1.0, "kwh": 2.2}}}
filas = P.plan(dos, apr, FUENTES, precio, AHORA)["rows"]
ok(len(filas) == 2, f"una fila por aparato ({len(filas)})")
ok(filas[0]["saving_eur"] >= filas[1]["saving_eur"],
   f"y primero lo que más se gana moviéndolo ({filas[0]['name']} {filas[0]['saving_eur']} € "
   f"≥ {filas[1]['name']} {filas[1]['saving_eur']} €)")

print("\n8-10 · cargar la batería de la red")
# Mañana no sobra nada y la batería está a la mitad: comprar barato compensa.
b = P.cargar_de_red(AHORA, FUENTES, precio, {"kwh": 0.0})
ok(b is not None, "con la batería a medias y sin sol mañana, se recomienda")
ok(b and abs(b["kwh"] - 5.0) < 1e-6, f"por lo que le falta ({b['kwh']} kWh)")
ok(b and b["at"][11:13] < "08", f"en una hora de valle ({b['at'][11:16]})")
ok(b and b["saving_eur"] > P.MIN_AHORRO_BATERIA_EUR,
   f"y se dice cuánto ahorra ({b['saving_eur']} €)")
ok(P.cargar_de_red(AHORA, FUENTES, precio, {"kwh": 20.0}) is None,
   "si mañana el sol la va a llenar, no se compra nada")
ok(P.cargar_de_red(AHORA, {**FUENTES, "soc": 98.0}, precio, {"kwh": 0.0}) is None,
   "casi llena, tampoco")
ok(P.cargar_de_red(AHORA, {**FUENTES, "capacity_kwh": 0.0}, precio, None) is None,
   "sin capacidad configurada no se contesta")
ok(P.cargar_de_red(AHORA, {**FUENTES, "soc": None}, precio, None) is None,
   "ni sin saber la carga")
ok(P.cargar_de_red(AHORA, FUENTES, lambda _t: 0.20, {"kwh": 0.0}) is None,
   "con el precio plano no hay valle que aprovechar")

print("\n11 · sin con qué planificar")
ok(P.plan([LAVADORA], APRENDIDO, None, precio, AHORA) is None, "sin fuentes, no hay plan")
ok(P.plan([LAVADORA], {}, FUENTES, precio, AHORA)["rows"] == [],
   "y sin ciclo aprendido tampoco se inventa uno")
# Y sin nada que decir por ninguno de los dos lados, `None`: una tarjeta vacía
# es peor que ninguna tarjeta.
ok(P.plan([LAVADORA], {}, {**FUENTES, "capacity_kwh": 0.0}, precio, AHORA) is None,
   "sin filas y sin batería que aconsejar, no hay tarjeta")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

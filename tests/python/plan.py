"""El planificador del día: cuándo cada aparato y si cargar la batería en valle.

  1. con sol a mediodía, el mejor momento es a mediodía
  2. y se dice cuánto se ahorra frente a ponerlo ahora
  3. sin nada que ganar, no se pide esperar
  4. la batería se valora a lo que cuesta reponerla, no al precio de la hora
  5. sin precios el plan sale igual, ordenado por lo que no pone el sol
  6. un ciclo que no cabe en el horizonte no se planifica
  7. las filas van por lo que más se gana moviéndolas
 7b. y dos aparatos no se llevan el mismo kilovatio de sol
  8. cargar de la red: solo si el sol no va a llenar la batería
  9. y solo si el ahorro se nota
 10. sin capacidad o sin carga no se contesta
 11. sin fuentes no hay plan, en vez de un plan inventado
 12. la mañana del 3 de agosto: esperar media hora cambia el sol de 60 % a 100 %

El punto 12 sale de una queja, y es el que más importa. A las 9:47 la tarjeta de
la ventana decía «Lavadora · gratis **desde las 10:06**» y la del plan decía
«Lavadora · **ahora** · ahora mismo · 99 % con sol · es su mejor hora». Dos
tarjetas de la misma pantalla contradiciéndose sobre el mismo instante.

Dos causas, las dos aquí:

  · `worth_waiting` solo miraba euros, y esperar media hora ahorraba 1,3
    céntimos. Pero cambiaba de dónde sale la energía —de la batería al sol—, que
    es justo lo que la otra tarjeta estaba anunciando a gritos;
  · y la tarjeta, al no pedir esperar, seguía enseñando el porcentaje de sol de
    la **mejor** hora con la etiqueta «ahora mismo». El 99 % era de las 10:17.
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

print("\n7b · el sol de una hora es uno")
# De la pregunta sobre el modelo de EMHASS, que resuelve todas las cargas contra un
# **único** balance de potencia. Aquí cada aparato buscaba su hora como si estuviera
# solo en la casa —`simular` recibe la potencia de uno y el perfil, y no sabe de los
# demás—, así que tres aparatos iguales se llevaban los tres el mismo hueco.
#
# Medido antes del arreglo con estas cifras: los tres a las 13:30 con «100 % con sol»,
# 6,00 kWh de sol prometido sobre los 5,76 kWh que el tejado da en todo el día.
#
# El tejado es estrecho a propósito: con uno de sobra los tres cabrían y el banco no
# diría nada de lo que se quiere comprobar.
def techo_corto(t):
    h = t.hour + t.minute / 60.0
    return max(0.0, 2400.0 * (1 - ((h - 14.0) / 2.2) ** 2))


ESTRECHO = {"sol_at": techo_corto, "casa_at": lambda _t: 300.0,
            "capacity_kwh": 0.0, "reserve_pct": 0.0, "soc_pct": 0.0}
CICLO_2K = {"hours": 1.0, "kwh": 2.0, "cycles": 6, "days": 14}
TRES = [{"id": f"a{i}", "name": f"Aparato {i}", "color": "#08f", "icon": "potencia"}
        for i in (1, 2, 3)]
p7 = P.plan(TRES, {f"a{i}": {"kind": "movible", "cycle": CICLO_2K} for i in (1, 2, 3)},
            ESTRECHO, lambda t: 0.30 if 18 <= t.hour < 22 else 0.20,
            datetime(2026, 8, 4, 9, 0, tzinfo=TZ))
horas7 = [f["best"]["at"][11:16] for f in p7["rows"]]
ok(len(set(horas7)) == 3, f"tres aparatos no se llevan la misma hora ({horas7})")

# El invariante que de verdad importa, y que se comprueba paso a paso: la potencia
# que el plan coloca en cada instante no puede pasarse del sobrante, porque si se
# pasa el sol que cada fila se promete no se puede entregar.
puestos = [(datetime.fromisoformat(f["best"]["at"]), f["hours"], f["kwh"])
           for f in p7["rows"]]
ARRANQUE = datetime(2026, 8, 4, 9, 0, tzinfo=TZ)
peor = 0.0
paso = timedelta(minutes=5)
t = ARRANQUE
while t < ARRANQUE + timedelta(hours=24):
    carga = sum(k * 1000.0 / h for ini, h, k in puestos
                if ini <= t < ini + timedelta(hours=h))
    sobra = max(0.0, techo_corto(t) - 300.0)
    # Solo es sobrepaso si lo que se coloca ahí se está cobrando como sol: por encima
    # del sobrante la energía sale de la red, y eso el plan lo dice en su cifra.
    peor = max(peor, carga - max(sobra, 0.0))
    t += paso
prometido = sum(f["best"]["sun_kwh"] for f in p7["rows"])
disponible = sum(max(0.0, techo_corto(ARRANQUE + timedelta(minutes=m)) - 300.0)
                 for m in range(0, 24 * 60, 5)) * (5 / 60) / 1000
ok(prometido <= disponible + 0.05,
   f"el sol prometido cabe en el que hay ({prometido:.2f} de {disponible:.2f} kWh)")
ok(any(f["best"]["sun_pct"] < 100 for f in p7["rows"]),
   "y al que llega tarde se le dice que no le toca todo el sol, en vez de prometerlo")

# Y por qué su hora es otra, que sin decirlo parece un error del programa.
movidos = [f for f in p7["rows"] if f.get("displaced_by")]
ok(len(movidos) == 2, f"los dos desplazados lo dicen ({len(movidos)})")
# `movidos and all(...)`, no `all(...)`: sobre una lista vacía `all` es cierto, así
# que sin el `and` estas dos se ponían verdes justo cuando el arreglo no estaba —
# comprobado quitándolo.
ok(bool(movidos) and all(f.get("alone_at") for f in movidos),
   "con la hora que habrían tenido a solas")
ok(bool(movidos) and all(
       f["displaced_by"] and f["displaced_by"][0] in [g["name"] for g in p7["rows"]]
       for f in movidos),
   f"y quién se la quitó ({[(f['name'], f['displaced_by']) for f in movidos]})")
primero = [f for f in p7["rows"] if not f.get("displaced_by")]
ok(len(primero) == 1 and primero[0]["best"]["sun_pct"] == 100,
   "el que llega primero se lleva el mejor hueco y no dice que le hayan movido")

# Un aparato **en marcha** también aparta el sol: no es una hipótesis, está dando.
EN_MARCHA = {
    "coche": {"kind": "movible", "cycle": CICLO_2K,
              "progress": {"elapsed_h": 0.0, "typical_h": 1.0, "pct": 0, "over": False}},
    "lava": {"kind": "movible", "cycle": CICLO_2K},
}
DOS = [{"id": "coche", "name": "Coche", "color": "#08f", "icon": "coche-electrico"},
       {"id": "lava", "name": "Lavadora", "color": "#0a0", "icon": "lavadora"}]
MEDIODIA = datetime(2026, 8, 4, 13, 0, tzinfo=TZ)
pm = P.plan(DOS, EN_MARCHA, ESTRECHO, lambda t: 0.20, MEDIODIA)
lava = next(f for f in pm["rows"] if f["name"] == "Lavadora")
libre = P.plan([DOS[1]], {"lava": {"kind": "movible", "cycle": CICLO_2K}},
               ESTRECHO, lambda t: 0.20, MEDIODIA)["rows"][0]
ok(lava["best"]["at"] != libre["best"]["at"],
   f"con el coche cargando, la lavadora va a otra hora "
   f"({lava['best']['at'][11:16]} en vez de {libre['best']['at'][11:16]})")
ok(lava["best"]["sun_kwh"] < libre["best"]["sun_kwh"],
   f"y con menos sol, que es el que el coche se está llevando "
   f"({lava['best']['sun_kwh']:.2f} < {libre['best']['sun_kwh']:.2f} kWh)")
ok(lava.get("displaced_by") == ["Coche"],
   f"y se dice quién ({lava.get('displaced_by')})")

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

print("\n10b · «de mañana no se sabe» no es «mañana no sobra»")
# De un aviso: *«recomienda cargar la batería de noche cuando todos los días estoy
# cargando la batería al 100 % sin problemas, y el pronóstico de sol de mañana es muy
# bueno»*. Con una integración solar que solo publica el día en curso —bastantes lo
# hacen— a partir del anochecer no hay curva de mañana, `free_window` devuelve `None`,
# y esto lo tomaba por un día sin sol: aconsejaba **comprar** energía que al día
# siguiente iba a llegar gratis.
#
# Sin `manana` y sin saber si la hay, no se aconseja: la premisa de toda esta cuenta
# es «el sol no va a llenarla», y eso es justo lo que no se sabe.
ok(P.cargar_de_red(AHORA, FUENTES, precio, None, False) is None,
   "sin previsión de mañana no se recomienda comprar")
# Y **sí** cuando se sabe que mañana no sobra: es el caso de arriba, que no se pierde.
ok(P.cargar_de_red(AHORA, FUENTES, precio, None, True) is not None,
   "pero sabiendo que mañana no sobra, se sigue recomendando")
ok(P.cargar_de_red(AHORA, FUENTES, precio, {"kwh": 0.0}, False) is not None,
   "y con dato de mañana el flag no estorba")
# Lo mismo por la puerta de `plan`, que es la que usa la aplicación: si el flag no se
# propagara, el banco de arriba pasaría y el usuario seguiría viendo el consejo.
sin_saber = P.plan([LAVADORA], APRENDIDO, FUENTES, precio, AHORA, None, False)
ok((sin_saber or {}).get("battery") is None,
   "y el plan tampoco lo trae cuando de mañana no se sabe nada")
sabiendo = P.plan([LAVADORA], APRENDIDO, FUENTES, precio, AHORA, None, True)
ok((sabiendo or {}).get("battery") is not None,
   "mientras que sabiéndolo sigue estando")

print("\n11 · sin con qué planificar")
ok(P.plan([LAVADORA], APRENDIDO, None, precio, AHORA) is None, "sin fuentes, no hay plan")
ok(P.plan([LAVADORA], {}, FUENTES, precio, AHORA)["rows"] == [],
   "y sin ciclo aprendido tampoco se inventa uno")
# Y sin nada que decir por ninguno de los dos lados, `None`: una tarjeta vacía
# es peor que ninguna tarjeta.
ok(P.plan([LAVADORA], {}, {**FUENTES, "capacity_kwh": 0.0}, precio, AHORA) is None,
   "sin filas y sin batería que aconsejar, no hay tarjeta")

print("\n12 · la mañana del 3 de agosto, que es de donde viene la queja")
MANANA = datetime(2026, 8, 3, 9, 47, tzinfo=TZ)


def sol_manana(m):
    """Sin sol hasta las 10:06, y a partir de ahí de sobra. El día real."""
    h = m.hour + m.minute / 60
    return 3000.0 if 10.1 <= h < 18 else 0.0


F_MANANA = {"sol_at": sol_manana, "casa_at": lambda _m: 350.0,
            "soc": 90.0, "capacity_kwh": 10.0, "factor": 1.0}
caro = lambda m: 0.17 if 10 <= m.hour < 22 else 0.10          # noqa: E731

r = P._mejor_hora({"hours": 1.17, "kwh": 0.32}, MANANA, F_MANANA, caro, 0.10)
ok(r["now"]["sun_pct"] < r["best"]["sun_pct"],
   f"ahora el sol cubre menos que en la mejor hora "
   f"({r['now']['sun_pct']} % contra {r['best']['sun_pct']} %)")
ok(r["saving_eur"] < P.MIN_AHORRO_EUR,
   f"y en euros la diferencia es calderilla ({r['saving_eur']} €)")
# Lo que motiva el arreglo: aun siendo calderilla, esperar media hora cambia de
# dónde sale la energía, y eso es lo que el usuario ve en la otra tarjeta.
ok(r["worth_waiting"],
   f"pero aun así compensa esperar, porque cambia el sol "
   f"({r['now']['sun_pct']} % → {r['best']['sun_pct']} %)")
ok(r["sun_gain_pct"] >= P.MIN_GANANCIA_SOL_PCT,
   f"y se dice cuánto sol se gana esperando ({r['sun_gain_pct']} puntos)")

# Y al revés: si esperar no cambia ni los euros ni el sol, no se pide esperar.
r2 = P._mejor_hora({"hours": 1.17, "kwh": 0.32},
                   datetime(2026, 8, 3, 12, 0, tzinfo=TZ), F_MANANA, caro, 0.10)
ok(not r2["worth_waiting"],
   f"a mediodía, con el sol ya dando, no se pide esperar "
   f"(sol ahora {r2['now']['sun_pct']} %, se gana {r2['sun_gain_pct']})")
ok(r2["now"]["sun_pct"] == 100,
   f"y «ahora» dice el sol de ahora, que es el 100 % ({r2['now']['sun_pct']} %)")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

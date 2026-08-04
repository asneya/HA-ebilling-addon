"""Una tarjeta para los aparatos, con tres formas de fila.

De una queja: *«la info de electrodomésticos de la home me parece redundante y eso
no debería ocurrir, menos en una home»*. Y era peor que redundancia visual: «Cabe en
la ventana» y «El plan de hoy» simulaban **el mismo instante dos veces**, a 5 y a 15
minutos, y llegaban a discrepar en once puntos de «% con sol» para el mismo horno.

Y había un caso roto de raíz. Una nevera de verdad (compresor 18 min sí, 27 no) da 32
«ciclos» al día, así que la aplicación le publicaba un ciclo típico de «0 h 20 min ·
0,03 kWh», decía «Nevera · Gratis · lo pone el sol» y le calculaba una hora óptima
para encenderla. No le faltaba información: contestaba con confianza a una pregunta
que no existe.

  1. una sola física: la tarjeta y el plan dan lo mismo para el mismo instante
  2. la forma de uso se detecta de la curva de potencia
  3. y la ficha manda sobre lo detectado
  4. «fijo» no se detecta nunca: no está en los vatios
  5. un continuo no publica ciclo, que sería publicar una mentira medida
  6. un movible trae su hora óptima
  7. un fijo trae coste pero **no** hora
  8. un continuo trae lo que lleva hoy, con su origen atribuido
  9. y lo que no se puede atribuir se declara, no se reparte a ojo
 10. las filas se ordenan por lo que hay que decidir
 11. lo que ya está en marcha no tiene hora que elegir
 12. una sola noción de «en marcha», la que tolera las pausas
 13. y una hora de fin solo si sus ciclos se parecen
 14. de punta a punta: la segunda llamada dice lo mismo que la primera
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
import appliances as A                                        # noqa: E402
import planner as P                                           # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
AHORA = datetime(2026, 8, 3, 11, 0, tzinfo=TZ)
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


# ── Curvas de potencia de verdad, en pasos de cinco minutos ─────────────────

def curva(patron, dias=7):
    inicio = AHORA.replace(hour=0, minute=0) - timedelta(days=dias)
    out, t = [], inicio
    for i in range(dias * 24 * 12):
        out.append((t, patron(t, i)))
        t += timedelta(minutes=5)
    return out


NEVERA = (lambda t, i: 90.0 if (i * 5) % 45 < 18 else 1.0, 2.0)
ROUTER = (lambda t, i: 8.0, 2.0)
LAVADORA = (lambda t, i: 280.0 if (t.day % 2 == 0 and t.hour == 10 and t.minute < 70)
            else 0.5, 15.0)
AIRE = (lambda t, i: (1500.0 if (i * 5) % 30 < 20 else 40.0)
        if t.hour in (14, 15, 22, 23, 3, 4) else 2.0, 50.0)

print("1 · una sola física")
# La cuenta de «si lo pongo ahora» estaba escrita dos veces. Ahora `planner.simular`
# es la única, y esto lo comprueba con la batería casi vacía para que las tres
# partes salgan del cero: si el sol lo cubriera todo, coincidirían sin decir nada.
fuentes = {"sol_at": (lambda _t: 1800.0), "casa_at": (lambda _t: 450.0),
           "capacity_kwh": 10.0, "usable_kwh": 0.1, "reserve_pct": 20.0, "soc": 21.0}
horno = {"hours": 1.0, "kwh": 1.6}
e = A.estimate(horno, AHORA, None, fuentes)
sol, bat, red = P.simular(AHORA, 1.0, 1600.0, fuentes, P.PASO_FINO)
ok(abs(e["sun_kwh"] - round(sol, 2)) < 0.01
   and abs(e["battery_kwh"] - round(bat, 2)) < 0.01
   and abs(e["grid_kwh"] - round(red, 2)) < 0.01,
   f"la tarjeta y el plan dan lo mismo (sol {e['sun_kwh']}/{sol:.2f}, "
   f"bat {e['battery_kwh']}/{bat:.2f}, red {e['grid_kwh']}/{red:.2f})")
ok(red > 0.05, f"y con la red dentro, que es donde el paso importaba ({red:.2f} kWh)")

print("\n2-4 · la forma de uso")
for nombre, (patron, umbral), esperada in (
        ("nevera", NEVERA, "continuo"), ("router", ROUTER, "continuo"),
        ("lavadora", LAVADORA, "movible"), ("aire", AIRE, "movible")):
    m = curva(patron)
    d = A.forma_de_uso(m, umbral, A._ciclos_de(m, umbral), 7)
    ok(d == esperada, f"{nombre} → {d}")
ok(A.forma({"kind": "fijo"}, {"detected_kind": "continuo"}) == "fijo",
   "la ficha manda sobre lo detectado")
ok(A.forma({}, {"detected_kind": "continuo"}) == "continuo",
   "y sin elección, lo detectado")
ok(A.forma({}, None) == "movible", "sin nada, movible: es la puerta a aprender")
# `fijo` no puede salir de la detección en ningún caso: no está en los vatios.
detectadas = {A.forma_de_uso(curva(p), u, A._ciclos_de(curva(p), u), 7)
              for p, u in (NEVERA, ROUTER, LAVADORA, AIRE)}
ok("fijo" not in detectadas,
   f"«fijo» no se detecta nunca, es una decisión de la casa ({sorted(detectadas)})")

print("\n5 · un continuo no publica ciclo")
muestras, umbral = curva(NEVERA[0]), NEVERA[1]
ciclos = A._ciclos_de(muestras, umbral)
ok(len(ciclos) / 7 > 20, f"la nevera da decenas de «ciclos» al día ({len(ciclos)/7:.0f})")
bogus = A._resumen(ciclos, 7)
ok(bogus and bogus["hours"] < 0.6,
   f"y de ahí saldría un «ciclo típico» de {bogus['hours']} h · {bogus['kwh']} kWh")
ok(A.forma_de_uso(muestras, umbral, ciclos, 7) == "continuo",
   "que es justo por lo que se detecta como continuo y no se publica")

print("\n6-7 · movible y fijo")
APARATOS = [
    {"id": "lav", "name": "Lavadora", "color": "#0f7d8a", "icon": "lavadora"},
    {"id": "aire", "name": "Aire", "color": "#f0f", "icon": "potencia", "kind": "fijo"},
]
ciclo = {"hours": 1.2, "kwh": 0.4}
aprendido = {
    "lav": {"cycle": ciclo, "kind": "movible"},
    "aire": {"cycle": {"hours": 2.0, "kwh": 2.4}, "kind": "fijo"},
}
# Con el sol subiendo por la mañana, la mejor hora del movible es más tarde.
subiendo = {**fuentes, "sol_at": (lambda t: max(0.0, (t.hour - 8) * 700.0)),
            "usable_kwh": 0.5, "soc": 25.0}
plan = P.plan(APARATOS, aprendido, subiendo, lambda _t: 0.19, AHORA)
filas = {f["name"]: f for f in plan["rows"]}
ok(filas["Lavadora"]["kind"] == "movible" and filas["Lavadora"].get("best"),
   f"la lavadora trae su hora óptima ({filas['Lavadora']['best']['at'][11:16]})")
ok(filas["Lavadora"]["kind_auto"] is True, "y dice que la forma la ha puesto la app")
ok(filas["Aire"]["kind"] == "fijo" and filas["Aire"]["best"] is None,
   "el aire no trae hora: no se le propone una que no se puede seguir")
ok(filas["Aire"]["now"] and filas["Aire"]["now"]["eur"] is not None,
   f"pero sí lo que cuesta ahora ({filas['Aire']['now']['eur']} €)")
ok(filas["Aire"]["kind_auto"] is False, "y que «fijo» lo ha elegido la casa")
ok(filas["Aire"]["worth_waiting"] is False, "un fijo nunca pide esperar")

print("\n8-9 · el día de un continuo")
# La casa: de la red por la mañana, del sol al mediodía, de la batería de noche.
reparto = {}
for h, (s, b, r) in {8: (0.0, 0.0, 1.0), 13: (2.0, 0.0, 0.0), 22: (0.0, 1.5, 0.0)}.items():
    reparto[AHORA.replace(hour=h).isoformat()] = {
        "from_solar": s, "from_battery": b, "from_grid": r, "home_total": s + b + r}
d = A.atribuir_por_horas({"8": 0.09, "13": 0.09, "22": 0.09}, reparto,
                         precio_de=lambda _h: 0.20)
ok(abs(d["kwh"] - 0.27) < 0.001, f"suma lo del día ({d['kwh']} kWh)")
ok(abs(d["grid_kwh"] - 0.09) < 0.001 and abs(d["sun_kwh"] - 0.09) < 0.001
   and abs(d["battery_kwh"] - 0.09) < 0.001,
   f"con el origen de cada hora, no una media ({d})")
ok(abs(d["eur"] - 0.02) < 0.005,
   f"y solo se cobra la red: 0,09 × 0,20 ({d['eur']} €)")
# Una hora del aparato sin reparto de la casa: se declara.
d2 = A.atribuir_por_horas({"8": 0.09, "3": 0.5}, reparto, precio_de=lambda _h: 0.20)
ok(abs(d2["unplaced_kwh"] - 0.5) < 0.001,
   f"lo que no se puede atribuir se dice ({d2['unplaced_kwh']} kWh sin colocar)")
ok(d2["sun_kwh"] + d2["battery_kwh"] + d2["grid_kwh"] < d2["kwh"],
   "y no se reparte a ojo para que cuadre")
# Un contador que marca más que la casa entera es ruido, no un aparato glotón.
d3 = A.atribuir_por_horas({"8": 5.0}, reparto)
ok(abs(d3["grid_kwh"] - 1.0) < 0.001,
   f"su parte no puede pasar del total de la casa ({d3['grid_kwh']} de 1,0)")
ok(A.atribuir_por_horas({"8": 0.09}, None) is None, "sin reparto no se inventa")
ok(A.atribuir_por_horas({}, reparto) is None, "y sin consumo tampoco")

print("\n10 · el orden de las filas")
tres = APARATOS + [{"id": "nev", "name": "Nevera", "color": "#08f", "icon": "potencia"}]
aprendido["nev"] = {"kind": "continuo", "today_split": d}
plan3 = P.plan(tres, aprendido, subiendo, lambda _t: 0.19, AHORA)
formas = [f["kind"] for f in plan3["rows"]]
ok(formas == ["movible", "fijo", "continuo"],
   f"primero lo que se decide, y los continuos al final ({formas})")

print("\n11 · lo que ya está en marcha")
# Una lavadora puesta hace 40 minutos, de un ciclo que suele durar 1 h 30.
suele = {"hours": 1.5, "kwh": 0.9, "cycles": 6, "days": 14,
         "hours_min": 1.45, "hours_max": 1.6, "peak_w": 2100}
abierto = {"start": (AHORA - timedelta(minutes=40)).isoformat(),
           "end": AHORA.isoformat(), "hours": 0.67, "kwh": 0.42,
           "by_hour": {"10": 0.25, "11": 0.17}}
p = A.progreso(abierto, suele, AHORA)
ok(abs(p["elapsed_h"] - 0.67) < 0.01, f"lleva lo que dice el reloj ({p['elapsed_h']} h)")
ok(p["pct"] == 44, f"y va por el 44 % del tiempo, no de los kWh ({p['pct']} %)")
ok(p["ends_at"][11:16] == "11:50",
   f"con su hora de fin ({p['ends_at'][11:16]}), que es el número accionable")
ok(abs(p["remaining_h"] - 0.83) < 0.02, f"y lo que le queda ({p['remaining_h']} h)")
ok(p["over"] is False, "sin pasarse de lo habitual")

# En el plan: sigue siendo movible, pero ya no se le propone hora.
aprendido["lav"] = {"cycle": suele, "kind": "movible", "open": abierto,
                    "progress": p, "running_split": d,
                    "tail": {"hours": 0.83, "sun_kwh": 0.8, "battery_kwh": 0.0,
                             "grid_kwh": 0.0, "sun_pct": 100}}
plan4 = P.plan(tres, aprendido, subiendo, lambda _t: 0.19, AHORA)
fila = next(f for f in plan4["rows"] if f["name"] == "Lavadora")
ok(fila["kind"] == "movible" and fila.get("running"),
   "sigue siendo movible: mañana volverá a tener su hora")
ok(fila["best"] is None, "pero ahora no se le propone ninguna, que ya está puesta")
ok(fila["worth_waiting"] is False, "y no pide esperar a lo que ya está en marcha")
ok(fila["so_far"] and fila["tail"], "trae lo que lleva y de dónde saldrá la cola")
ok(plan4["rows"][0]["name"] == "Lavadora",
   f"y va primero: es lo único que está pasando ({plan4['rows'][0]['name']})")

# Pasarse de lo habitual se dice, en vez de clavar la barra en el 100 %.
tarde = A.progreso({**abierto, "start": (AHORA - timedelta(hours=2)).isoformat()},
                   suele, AHORA)
ok(tarde["over"] is True and tarde["pct"] > 100,
   f"un programa más largo se pasa del 100 % ({tarde['pct']} %)")
ok(tarde["ends_at"] is None,
   "y entonces no se promete una hora de fin que ya ha pasado")

print("\n12 · una sola noción de «en marcha»")
datos = {"open": {**abierto, "end": (AHORA - timedelta(minutes=10)).isoformat()}}
ok(A.en_marcha(datos, 1800.0, 15.0, AHORA) is True, "con el aparato tirando, sí")
ok(A.en_marcha(datos, 1.0, 15.0, AHORA) is True,
   "y en una pausa de diez minutos también: es la que hace que un lavavajillas "
   "sea un ciclo y no tres")
frio = {"open": {**abierto, "end": (AHORA - timedelta(minutes=40)).isoformat()}}
ok(A.en_marcha(frio, 1.0, 15.0, AHORA) is False,
   "pasado el hueco tolerado y sin consumo, ya no")
ok(A.en_marcha(frio, 1800.0, 15.0, AHORA) is True,
   "aunque lo aprendido vaya con retraso, la lectura de ahora responde")
ok(A.en_marcha({"open": None}, 1800.0, 15.0, AHORA) is False,
   "y sin ciclo abierto no se inventa uno")

print("\n13 · la hora de fin solo si sus ciclos se parecen")
ok(A.hora_de_fin_fiable(suele) is True, "un ciclo que siempre dura lo mismo, sí")
variado = {**suele, "hours_min": 0.9, "hours_max": 2.4}
ok(A.hora_de_fin_fiable(variado) is False,
   "una lavadora con varios programas, no: 0,9–2,4 h no es una hora de fin")
pv = A.progreso(abierto, variado, AHORA)
ok(pv["ends_at"] is None and pv["range_h"] == [0.9, 2.4],
   f"y se dice lo que sí se sabe ({pv['range_h']})")
ok(A.hora_de_fin_fiable({**suele, "cycles": 2}) is False,
   "con dos ciclos el recorrido son esos dos y no dice nada")
ok(A.hora_de_fin_fiable(None) is False, "y sin ciclo aprendido no hay nada que prometer")
sin_ciclo = A.progreso(abierto, None, AHORA)
ok(sin_ciclo["pct"] is None and sin_ciclo["elapsed_h"] > 0,
   "en marcha sin ciclo aprendido: se dice lo que lleva y no se dibuja progreso")
ok(A.progreso(None, suele, AHORA) is None, "y sin ciclo abierto no hay progreso")

BASE = os.environ.get("VATIA_BASE")
if BASE:
    print("\n14 · de punta a punta, dos veces")
    # Este banco existe por un fallo que ninguno de los de arriba podía ver: el
    # reparto hora a hora se calculaba bien y se guardaba en la caché del día, pero
    # el camino que **sirve** de esa caché no lo devolvía. Dos minutos después de
    # arrancar la aplicación, la fila de la nevera desaparecía de la tarjeta —un
    # continuo sin reparto no se publica, y así tiene que ser— y volvía sola al
    # caducar la caché. Con la aplicación recién levantada no se veía nunca, y
    # probando las funciones por separado, tampoco.
    #
    # De ahí la forma de este banco: **la misma pregunta dos veces**. La segunda
    # respuesta tiene que ser la primera.
    def filas():
        with urllib.request.urlopen(BASE + "/api/live", timeout=30) as f:
            plan = json.load(f).get("plan") or {}
        return {r["name"]: r for r in plan.get("rows") or []}

    una, otra = filas(), filas()
    ok(set(una) == set(otra),
       f"las dos llamadas traen los mismos aparatos ({sorted(una)})")
    continuos = [n for n, r in una.items() if r["kind"] == "continuo"]
    ok(bool(continuos), f"con algún continuo entre ellos ({continuos})")
    for n in continuos:
        ok(bool(otra.get(n, {}).get("today")),
           f"y {n} sigue trayendo su día en la segunda, no solo en la primera")
    # Lo que valga para cualquiera que esté en marcha, para todos: en un día par el
    # Home Assistant falso también pone la lavadora, y dar por hecho que solo hay uno
    # ponía este banco en rojo por el calendario y no por el código.
    marcha = [n for n, r in una.items() if r.get("running")]
    ok(bool(marcha), f"y algo en marcha, que si no este camino no se prueba ({marcha})")
    for n in marcha:
        r = una[n]
        ok(bool(otra[n].get("so_far")),
           f"{n} en marcha: su origen medido aguanta la caché")
        ok(r["best"] is None and not r["worth_waiting"],
           f"y a {n} no se le propone hora ni se le pide esperar")
    # Y las cifras, atadas al coche, que es el único que el falso garantiza en marcha
    # a cualquier hora: arrancó hace 40 minutos, siempre, de un ciclo de una hora.
    coche = una.get("Coche", {}).get("running")
    ok(bool(coche), "el coche está cargando, que es el que el falso garantiza")
    if coche:
        ok(abs(coche["elapsed_h"] - 0.67) < 0.09,
           f"lleva los 40 min que lleva ({coche['elapsed_h']} h)")
        ok(coche["typical_h"] and abs(coche["typical_h"] - 1.0) < 0.2,
           f"con el ciclo típico de los días anteriores, no el de hoy a medias "
           f"({coche['typical_h']} h)")
        ok(coche["over"] is False and 50 < coche["pct"] < 85,
           f"y va por el {coche['pct']} %")
    # El aro verde: lo llevan los que están dando ahora, y **también los continuos**.
    encendidos = [n for n, r in una.items() if r.get("on")]
    ok("Coche" in encendidos, f"el coche va rodeado ({encendidos})")
    ok(all(n in encendidos for n in continuos),
       f"y los de siempre encendido también, que es lo que se pidió ({continuos})")
    apagados = [n for n, r in una.items() if not r.get("on")]
    ok(bool(apagados), f"y los que no están dando, no ({apagados})")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

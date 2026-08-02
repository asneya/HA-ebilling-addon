"""El sesgo del tejado, de punta a punta contra el servidor.

  1. arrancando de cero, la app apunta los pares de las horas cerradas de hoy
  2. y no guarda las horas de noche, que nunca darán cociente
  3. sin días suficientes no corrige, y lo dice
  4. sembrando un histórico con sombra a primera hora, la corrección aparece
  5. la ventana lo cuenta en su payload
  6. y la previsión que se dibuja va ya corregida
"""
import json
import os
import sys
import urllib.request
from datetime import date, timedelta

BASE = os.environ.get("VATIA_BASE", "http://127.0.0.1:8406")
CONFIG = os.environ["VATIA_CONFIG"]
HIST = os.path.join(CONFIG, "vatia-prevision.json")

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
import prevision as P                                        # noqa: E402

fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


def live():
    with urllib.request.urlopen(BASE + "/api/live", timeout=40) as r:
        return json.load(r)


def hist():
    try:
        with open(HIST, encoding="utf-8") as fh:
            return json.load(fh)["dias"]
    except (OSError, ValueError):
        return {}


# El banco se puede repetir: se borra lo aprendido en la pasada anterior, que
# si no el punto 3 —«con un solo día no se corrige nada»— parte con historia.
try:
    os.remove(HIST)
except OSError:
    pass
urllib.request.urlopen(BASE + "/api/live", timeout=40).read()

print("1-2 · la app apunta sola")
d = live()
w = d.get("window")
if not w:
    print("  (sin ventana: el fake no da previsión solar)")
    sys.exit(0)
dias = hist()
hoy = max(dias) if dias else None
ok(bool(dias), f"hay histórico ({len(dias)} día(s))")
ok(hoy is not None and len(dias[hoy]) > 0,
   f"con las horas cerradas de hoy ({len(dias.get(hoy, {}))} horas)")
ok(all(float(par[0]) >= P.MIN_PREVISTO_WH for par in dias[hoy].values()),
   "y ninguna hora de noche, que no daría cociente")

print("\n3 · sin días, sin corrección")
ok(w["bias"]["horas"] == 0,
   f"con un solo día no se corrige nada ({w['bias']['horas']} horas)")

print("\n4-6 · con histórico, corrige")
# Se siembra un tejado con sombra: a las 9 da la mitad de lo prometido. Se
# escribe con la misma función que usa la app, no a mano.
horas_reales = sorted(int(h) for h in dias[hoy])
sombra = horas_reales[0]
for i in range(P.MIN_DIAS + 2):
    dia = date.fromisoformat(hoy) - timedelta(days=i + 1)
    P.registrar(CONFIG, dia,
                {h: 2000.0 for h in horas_reales},
                {h: (1000.0 if h == sombra else 2000.0) for h in horas_reales})

antes = w["today"]["shape"]["sol"][:]
d2 = live()
w2 = d2["window"]
b = w2["bias"]
ok(b["horas"] >= 1, f"ahora sí corrige ({b['horas']} hora(s))")
ok(b["peor"]["hora"] == sombra,
   f"y la peor es la de la sombra ({b['peor']})")
ok(0.45 <= b["peor"]["factor"] <= 0.55,
   f"con el factor aprendido, no uno inventado ({b['peor']['factor']})")
ok(b["dias"] >= P.MIN_DIAS, f"diciendo de cuántos días sale ({b['dias']})")

# La curva dibujada tiene que haber bajado en la hora de la sombra.
def a_las(shape, hora):
    for iso, w_ in zip(shape["t"], shape["sol"]):
        if int(iso[11:13]) == hora:
            return w_
    return None


despues = w2["today"]["shape"]
sol_antes = a_las({"t": w["today"]["shape"]["t"], "sol": antes}, sombra)
sol_despues = a_las(despues, sombra)
if sol_antes and sol_despues:
    ok(sol_despues < sol_antes * 0.75,
       f"la curva que se dibuja baja a esa hora ({sol_antes:.0f} → {sol_despues:.0f} W)")
else:
    print(f"  (la hora {sombra} no está en la curva dibujada)")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

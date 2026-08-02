"""La forma del día y el excedente que la batería no se lleva.

  1. `shape` trae la previsión y el consumo típico en los mismos instantes
  2. y se recorta a un número razonable de puntos
  3. `peak_at` cae donde de verdad está el máximo del excedente
  4. la batería se descuenta: gastable = bruto − lo que le cabe
  5. si le cabe más que el excedente entero, no queda nada que gastar
  6. sin batería (o sin saber el SOC) no se descuenta nada
  7. `kwh` sigue siendo el bruto, para poder comparar hoy con mañana
  8. el hueco de la batería sale de capacidad y SOC
  9. y no se calcula sin una de las dos
"""
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
import live as L                                             # noqa: E402
import series as S                                           # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


DIA = datetime(2026, 8, 2, tzinfo=TZ)


def curva():
    """Un día de sol con la punta a las 14:00, cada media hora."""
    puntos = []
    for paso in range(0, 48):
        t = DIA + timedelta(minutes=30 * paso)
        h = paso / 2.0
        if h < 7 or h > 21:
            w = 0.0
        else:
            # Campana con el máximo a las 14, de 4.500 W.
            w = max(0.0, 4500.0 * (1 - ((h - 14.0) / 7.0) ** 2))
        puntos.append((t, w))
    return puntos


def casa(t):
    """320 W de fondo y el horno de 13 a 14, que parte la ventana."""
    return 2600.0 if t.hour == 13 else 320.0


PUNTOS = curva()

print("1-2 · la forma del día")
w = S.free_window(PUNTOS, casa, DIA)
forma = w["shape"]
ok(set(forma) == {"t", "sol", "casa"}, f"trae las tres columnas ({sorted(forma)})")
ok(len(forma["t"]) == len(forma["sol"]) == len(forma["casa"]),
   f"del mismo largo ({len(forma['t'])})")
ok(2 <= len(forma["t"]) <= 96, f"y con puntos suficientes, sin pasarse ({len(forma['t'])})")
i13 = [i for i, iso in enumerate(forma["t"]) if iso[11:16] == "13:00"][0]
ok(forma["casa"][i13] == 2600.0,
   f"el consumo típico es el de esa hora, no una media ({forma['casa'][i13]} W a las 13:00)")
ok(forma["sol"][0] == 0 and forma["sol"][-1] == 0,
   "la curva arranca y acaba en el suelo")
ok(forma["t"][0][11:16] >= "06:00" and forma["t"][-1][11:16] <= "22:00",
   f"y solo trae las horas de luz ({forma['t'][0][11:16]} → {forma['t'][-1][11:16]})")
# Muchos puntos: se recorta.
finos = [(DIA + timedelta(minutes=2 * i), 1000.0) for i in range(720)]
ok(len(S.free_window(finos, 100.0, DIA)["shape"]["t"]) <= 96,
   "una previsión de resolución fina se recorta a 96 puntos")

print("\n3 · dónde está el pico")
pico = datetime.fromisoformat(w["peak_at"])
ok(pico.hour == 14 and pico.minute == 0, f"a las 14:00 ({pico:%H:%M})")
ok(abs(w["peak_w"] - (4500.0 - 320.0)) < 1,
   f"y vale el excedente de ese momento ({w['peak_w']} W)")
ok(w["peak_w"] > w["surplus_w"], "el pico está por encima de la media, que es el punto")

print("\n4-7 · la batería se lleva lo suyo")
bruto = w["kwh"]
con_bat = S.free_window(PUNTOS, casa, DIA, bateria_wh=5000.0)
ok(abs(con_bat["kwh"] - bruto) < 1e-6,
   f"el bruto no cambia: es lo que compara hoy con mañana ({con_bat['kwh']} kWh)")
ok(abs(con_bat["battery_kwh"] - 5.0) < 1e-6,
   f"la batería se lleva sus 5 kWh ({con_bat['battery_kwh']})")
ok(abs(con_bat["spendable_kwh"] - (bruto - 5.0)) < 1e-3,
   f"y queda el resto para gastar ({con_bat['spendable_kwh']} de {bruto})")
ok(con_bat["spendable_w"] < con_bat["surplus_w"],
   f"la media gastable baja ({con_bat['spendable_w']} < {con_bat['surplus_w']} W)")
llena = S.free_window(PUNTOS, casa, DIA, bateria_wh=999_000.0)
ok(llena["spendable_kwh"] == 0 and abs(llena["battery_kwh"] - bruto) < 1e-3,
   f"si le cabe todo, no queda nada que gastar ({llena['spendable_kwh']} kWh)")
ok(llena["spendable_w"] == 0, "y la media gastable es cero, no negativa")
sin = S.free_window(PUNTOS, casa, DIA, bateria_wh=None)
ok(sin["battery_kwh"] == 0 and abs(sin["spendable_kwh"] - bruto) < 1e-6,
   "sin batería no se descuenta nada")

print("\n8-9 · el hueco de la batería")
estados = {"sensor.soc": {"state": "40"}}
cfg = {"battery_kwh": 10.0, "flow_sensors": {"battery_soc": "sensor.soc"}}
ok(abs(L._hueco_bateria(cfg, estados) - 6000.0) < 1e-6,
   f"al 40 % de 10 kWh le caben 6 kWh ({L._hueco_bateria(cfg, estados)} Wh)")
ok(L._hueco_bateria({**cfg, "battery_kwh": 0.0}, estados) is None,
   "sin capacidad tecleada no se supone nada")
ok(L._hueco_bateria(cfg, {}) is None, "y sin SOC tampoco")
ok(L._hueco_bateria(cfg, {"sensor.soc": {"state": "100"}}) == 0.0,
   "llena, no le cabe nada")
ok(L._hueco_bateria(cfg, {"sensor.soc": {"state": "unknown"}}) is None,
   "un SOC ilegible es no saberlo, no un cero")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

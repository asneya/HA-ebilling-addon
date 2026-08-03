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

Y lo que se dibuja del día que ya ha pasado:

 10. con lo medido, las horas cerradas llevan **su medida** y no la previsión
 11. la potencia media de una hora va en el centro de la hora
 12. la curva acaba en el instante de ahora, y con lo que marcan los sensores
 13. desde ahora en adelante, previsión
 14. `real_until` dice dónde está la costura
 15. sin nada medido, todo previsión y ninguna costura
 16. y los números de la ventana **no** cambian: siguen siendo del día previsto

Y lo que queda por sobrar de aquí al cierre, que es lo único sobre lo que se puede
decidir algo:

 17. a media mañana queda menos que el día entero, y no todo
 18. al cerrar la ventana no queda nada
 19. antes de abrir queda el día entero
 20. la batería se descuenta también de lo que queda
 21. y sin decir qué hora es no se inventa un «resto»
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
ok(set(forma) == {"t", "sol", "casa", "real_until"},
   f"trae las tres columnas y la costura ({sorted(forma)})")
ok(forma["real_until"] is None, "sin nada medido no hay costura")
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

# ── 10-16 · lo que fue y lo que se espera ───────────────────────────────────
#
# De una pregunta: «¿no debería la forma de hoy representar la realidad hasta el
# momento actual y la previsión desde el momento actual, a pesar de que el pasado
# ya ha pasado y lo conocemos?». Pues sí: la tarjeta dibujaba previsión las
# veinticuatro horas, también las que ya habían pasado y de las que hay medida.

print("\n10-14 · lo medido hasta ahora")
AHORA = DIA.replace(hour=12, minute=20)
# Los buckets vienen en tramos de **cinco minutos**, que es como los pide
# `daily_energy`, y no uno por hora. Se le dan así a propósito: con uno por hora el
# banco pasaba igual y no habría cazado que el código se quedaba con el último tramo
# de cada hora en vez de sumarlos —doce veces menos, y la mañana dibujada plana—.
# Doce tramos de 1/12 kWh son 1 kWh a la hora: 1.000 W de media.
medido = L.lo_medido(
    {DIA.replace(hour=h, minute=m).isoformat():
        {"pv_energy": 1.0 / 12, "home_energy": 0.4 / 12}
     for h in range(8, 12) for m in range(0, 60, 5)},
    {"pv": 900.0}, 500.0, AHORA,
)
wm = S.free_window(PUNTOS, casa, DIA, medido=medido)
fm = wm["shape"]
ok(fm["real_until"] == AHORA.isoformat(),
   f"la costura está en ahora ({fm['real_until']})")

horas = [datetime.fromisoformat(x) for x in fm["t"]]
antes = [(t, s, c) for t, s, c in zip(horas, fm["sol"], fm["casa"]) if t < AHORA]
ok(all(t.minute == 30 for t, _s, _c in antes[:-1] if t != AHORA),
   f"las horas medidas van en el centro de su hora ({[f'{t:%H:%M}' for t, _s, _c in antes]})")
ok(all(abs(s - 1000.0) < 0.1 for _t, s, _c in antes),
   f"con la potencia media del bucket, 1.000 W ({[s for _t, s, _c in antes]})")
ok(all(abs(c - 400.0) < 0.1 for _t, _s, c in antes),
   f"y el consumo medido, no el perfil ({[c for _t, _s, c in antes]})")
# Sin lo medido, esas mismas horas llevaban la previsión. Es la comprobación que
# da sentido a las de arriba: si la previsión y la medida coincidieran, dibujar una
# u otra daría igual y este banco no estaría comprobando nada.
i830 = [i for i, iso in enumerate(forma["t"]) if iso[11:16] == "08:30"][0]
previsto830 = forma["sol"][i830]
ok(previsto830 > 1500.0,
   f"la previsión de esa hora era otra cosa ({previsto830} W a las 08:30)")
ok(abs(previsto830 - 1000.0) > 500.0,
   f"y se separa de lo medido de sobra ({previsto830} previsto · 1.000 medido)")

ultimo = horas[[i for i, t in enumerate(horas) if t <= AHORA][-1]]
ok(ultimo == AHORA, f"la curva llega hasta ahora ({ultimo:%H:%M})")
i_ahora = horas.index(AHORA)
ok(fm["sol"][i_ahora] == 900.0 and fm["casa"][i_ahora] == 500.0,
   f"con lo que marcan los sensores ({fm['sol'][i_ahora]} W · {fm['casa'][i_ahora]} W)")
despues = [t for t in horas if t > AHORA]
ok(despues and despues[0] > AHORA, f"y sigue con la previsión ({despues[0]:%H:%M})")
i15 = [i for i, t in enumerate(horas) if t.hour == 15 and t.minute == 0]
ok(i15 and fm["sol"][i15[0]] > 3000.0,
   f"que a las 15:00 sigue siendo la campana ({fm['sol'][i15[0]] if i15 else None} W)")
ok(horas == sorted(horas), "los instantes van en orden")

print("\n15 · mañana, todo previsión")
manana = S.free_window(PUNTOS, casa, DIA)
ok(manana["shape"]["real_until"] is None,
   "un día sin medida no tiene costura y se dibuja entero previsto")

print("\n16 · los números de la ventana no cambian")
# A propósito: `kwh` es con lo que se compara hoy con mañana en la nota de la
# tarjeta, y mezclando medida y previsión dejaría de ser comparable. El dibujo
# dice lo que ha pasado; el titular, lo que se espera del día.
ok(wm["kwh"] == w["kwh"] and wm["start"] == w["start"] and wm["end"] == w["end"],
   f"start, end y kwh siguen siendo los del día previsto ({wm['kwh']} kWh)")
ok(wm["peak_at"] == w["peak_at"], "y el pico también")

print("\n17-21 · lo que queda de aquí al cierre")
# El excedente del día entero incluye la mañana, que ya pasó: el titular de la
# tarjeta decía «te sobran 2,7 kW» —una potencia media que no es de ningún aparato—
# y con esto puede decir los kWh que quedan y lo que valen, que sí es una decisión.
abre = datetime.fromisoformat(w["start"])
cierra = datetime.fromisoformat(w["end"])
media = abre + (cierra - abre) / 2
mitad = S.free_window(PUNTOS, casa, DIA, ahora=media)
ok(0 < mitad["left_kwh"] < mitad["kwh"],
   f"a mitad de ventana queda parte, no todo ({mitad['left_kwh']} de {mitad['kwh']} kWh)")
# La tarde de esta curva es simétrica a la mañana salvo el hueco del horno, que cae
# antes del medio: lo que queda tiene que ser algo más de la mitad.
ok(abs(mitad["left_kwh"] / mitad["kwh"] - 0.5) < 0.15,
   f"y del orden de la mitad ({mitad['left_kwh'] / mitad['kwh']:.0%})")
tarde = S.free_window(PUNTOS, casa, DIA, ahora=cierra + timedelta(minutes=1))
ok(tarde["left_kwh"] == 0.0 and tarde["left_spendable_kwh"] == 0.0,
   f"cerrada la ventana no queda nada ({tarde['left_kwh']} kWh)")
pronto = S.free_window(PUNTOS, casa, DIA, ahora=abre - timedelta(hours=1))
ok(abs(pronto["left_kwh"] - pronto["kwh"]) < 0.02,
   f"antes de abrir queda el día entero ({pronto['left_kwh']} de {pronto['kwh']})")
# La batería se lleva lo suyo también de lo que queda, y con el mismo hueco: es lo
# que le cabe **ahora**, así que aplicado al futuro es lo correcto.
conbat = S.free_window(PUNTOS, casa, DIA, bateria_wh=3000.0, ahora=media)
ok(abs(conbat["left_battery_kwh"] - 3.0) < 0.01,
   f"la batería se descuenta de lo que queda ({conbat['left_battery_kwh']} kWh)")
ok(abs(conbat["left_spendable_kwh"]
       - (conbat["left_kwh"] - conbat["left_battery_kwh"])) < 0.01,
   f"y lo gastable es la resta ({conbat['left_spendable_kwh']} kWh)")
ok(conbat["left_spendable_kwh"] < mitad["left_spendable_kwh"],
   "así que con batería que llenar queda menos para enchufar algo")
ok(w["left_kwh"] is None and w["left_spendable_kwh"] is None,
   "y sin decir qué hora es no se devuelve un «resto» inventado")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

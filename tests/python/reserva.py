"""La reserva de la batería, y un «Gratis» que no lo era.

De una queja con tres capturas, a las 11:52. La tarjeta decía:

    A/C Dormitorios · 5 h 10 min · 2,76 kWh
    1,66 de sol · 1,1 kWh de batería (11 % de carga)
    ≈ 0,21 € si lo compraras                          → **Gratis**, ahora mismo

Con el sol dando 805 W, la casa 450 y **la batería al 21 %, que es su suelo de
protección**. Tres cosas mal a la vez:

  · esos 1,1 kWh de batería **no existían**: el inversor no descarga por debajo
    del 20 %, así que de un 21 % lo utilizable era 0,1 kWh, no 2,1;
  · el veredicto se decidía **solo con el reloj** —si el ciclo cabía en las horas
    que le quedaban a la ventana— y no miraba de dónde iba a salir la energía, así
    que decía «Gratis» mientras la fila de encima, en la misma tarjeta, admitía
    1,1 kWh de batería;
  · y la reserva no se enseñaba en ningún sitio, así que una batería «al 21 %» que
    no aparecía en ninguna cuenta parecía un error de la aplicación.

Lo que se comprueba:

  1. lo utilizable es lo que hay por encima de la reserva
  2. en la reserva, o por debajo, es cero y no «poco»
  3. sin reserva declarada se cuenta la batería entera, como antes
  4. manda el sensor del inversor sobre el número tecleado
  5. la reserva se recorta a un rango con sentido
  6. la simulación no gasta lo que no se puede gastar
  7. ni recarga por encima del techo útil
  8. el veredicto de la queja: eso **no** es «Gratis»
  9. y con sol de sobra sí lo es
 10. cuando solo hace falta batería, se dice, y con su precio
 11. cuando hace falta la red, se dice lo que cuesta
 12. la tarjeta lleva el estado de la batería para poder explicarlo
 13. el veredicto y la estimación no pueden discrepar
"""
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
import appliances as A                                        # noqa: E402
import live                                                   # noqa: E402
import planner as P                                           # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
AHORA = datetime(2026, 8, 3, 11, 52, tzinfo=TZ)
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


# ── 1-5 · lo utilizable ─────────────────────────────────────────────────────

def usable(soc, *, reserva_pct=0.0, sensor=None, capacidad=10.0):
    ajustes = {"battery_kwh": capacidad, "battery_reserve_pct": reserva_pct,
               "flow_sensors": {"battery_reserve_soc": "sensor.min_soc"} if sensor is not None else {}}
    estados = ({"sensor.min_soc": {"state": str(sensor)}} if sensor is not None else {})
    return live.bateria_usable(ajustes, estados, soc)


print("1-3 · lo utilizable es lo de encima de la reserva")
kwh, res = usable(21.0, reserva_pct=20.0)
# La instalación de la queja: 10 kWh, al 21 %, con el suelo en el 20.
ok(abs(kwh - 0.1) < 0.001,
   f"al 21 % con reserva del 20 quedan 0,1 kWh y no 2,1 ({kwh:.2f})")
ok(res == 20.0, f"y se dice cuál es la reserva ({res})")
ok(abs(usable(50.0, reserva_pct=20.0)[0] - 3.0) < 0.001,
   f"al 50 % quedan 3,0 kWh ({usable(50.0, reserva_pct=20.0)[0]:.2f})")
ok(usable(20.0, reserva_pct=20.0)[0] == 0.0,
   "justo en la reserva es cero, no «poco»")
ok(usable(12.0, reserva_pct=20.0)[0] == 0.0,
   "y por debajo tampoco es negativo")
ok(abs(usable(21.0)[0] - 2.1) < 0.001,
   f"sin reserva declarada se cuenta la batería entera ({usable(21.0)[0]:.2f})")
ok(usable(21.0, capacidad=0.0)[0] is None,
   "sin capacidad tecleada no se puede saber, y se dice con None")
ok(usable(None, reserva_pct=20.0)[0] is None, "ni sin estado de carga")

print("\n4-5 · el sensor manda, y el rango se respeta")
ok(usable(21.0, reserva_pct=5.0, sensor=20)[1] == 20.0,
   "el sensor del inversor gana al número tecleado")
ok(abs(usable(21.0, reserva_pct=5.0, sensor=20)[0] - 0.1) < 0.001,
   "y la cuenta sale con el del sensor")
ok(usable(21.0, reserva_pct=5.0, sensor="unavailable")[1] == 5.0,
   "un sensor que no contesta cae al número tecleado")
ok(usable(50.0, reserva_pct=150.0)[1] == 95.0,
   "una reserva imposible se recorta al 95 %")
ok(usable(50.0, reserva_pct=-10.0)[1] == 0.0, "y una negativa, a cero")

# ── 6-7 · la simulación ─────────────────────────────────────────────────────

print("\n6-7 · la simulación no gasta lo que no hay")
# El día de la queja: sol 805 W, casa 450 → 355 W de excedente. El A/C pide
# 2,76 kWh en 5 h 10 → 534 W de media, así que le faltan ~180 W cada instante.
SOL, CASA = 805.0, 450.0
sol_at = lambda _t: SOL          # noqa: E731 - constante a propósito
casa_at = lambda _t: CASA        # noqa: E731
AC = {"hours": 5.17, "kwh": 2.76}
aparato_w = AC["kwh"] * 1000.0 / AC["hours"]

def fisica(sol, usable, reserva=20.0, horas=AC["hours"], w=None, capacidad=10.0):
    """`planner.simular` con estas fuentes. Una sola física en toda la aplicación."""
    f = {"sol_at": (lambda _t: sol), "casa_at": casa_at,
         "capacity_kwh": capacidad, "usable_kwh": usable, "reserve_pct": reserva,
         "soc": reserva + usable / capacidad * 100.0}
    return P.simular(AHORA, horas, w if w is not None else aparato_w, f, P.PASO_FINO)


sol_e, bat_e, red_e = fisica(SOL, 0.1)
ok(bat_e <= 0.11,
   f"con 0,1 kWh utilizables, la batería pone 0,1 y no 1,1 ({bat_e:.2f})")
ok(red_e > 0.7, f"y el resto lo pone la red, que es la verdad ({red_e:.2f} kWh)")
ok(abs(sol_e + bat_e + red_e - AC["kwh"]) < 0.02,
   f"y las tres suman el ciclo ({sol_e + bat_e + red_e:.2f} de {AC['kwh']})")

# Antes: con la batería entera (2,1 kWh) la red no aparecía casi.
_s, bat_viejo, red_viejo = fisica(SOL, 2.1, reserva=0.0)
ok(bat_viejo > bat_e and red_viejo < red_e,
   f"contando la batería entera salía otra cosa ({bat_viejo:.2f} de batería, "
   f"{red_viejo:.2f} de red)")

# El techo de la recarga también baja: con sol de sobra, la batería no puede
# subir por encima de lo que el inversor va a poder devolver.
_s2, bat2, red2 = fisica(6000.0, 8.0, horas=1.0, w=300.0)
ok(bat2 == 0.0 and red2 == 0.0, "con sol de sobra no se toca la batería")

# Y la tarjeta y el plan tienen que dar **lo mismo** para el mismo instante: es
# la contradicción que se midió antes de fusionarlos (0,36 kWh de red en una y
# 0,24 en la otra para el mismo horno). Si alguien vuelve a copiar la física, aquí
# se ve.
# Con la batería casi vacía, para que las tres partes salgan del cero: si el sol
# lo cubriera todo, las dos coincidirían sin haber comprobado nada.
f_mismo = {"sol_at": (lambda _t: 1800.0), "casa_at": casa_at, "capacity_kwh": 10.0,
           "usable_kwh": 0.1, "reserve_pct": 20.0, "soc": 21.0}
horno = {"hours": 1.0, "kwh": 1.6}
e_tarjeta = A.estimate(horno, AHORA, None, f_mismo)   # sin precio: se comparan kWh
s_plan, b_plan, r_plan = P.simular(
    AHORA, horno["hours"], horno["kwh"] * 1000.0, f_mismo, P.PASO_FINO)
ok(abs(e_tarjeta["sun_kwh"] - round(s_plan, 2)) < 0.01
   and abs(e_tarjeta["grid_kwh"] - round(r_plan, 2)) < 0.01,
   f"la tarjeta y el plan simulan lo mismo (sol {e_tarjeta['sun_kwh']}/{s_plan:.2f}, "
   f"red {e_tarjeta['grid_kwh']}/{r_plan:.2f})")

print("\n8-9 · el veredicto de la queja")
VENTANA = {"today": {"start": AHORA.replace(hour=9, minute=0).isoformat(),
                     "end": AHORA.replace(hour=20, minute=30).isoformat()}}
PRECIO = 0.19


def fuentes(usable_kwh, reserva=20.0, sol=SOL, capacidad=10.0):
    """Las fuentes de un momento, con la carga **derivada** de lo utilizable.

    La carga no se puede poner a mano: `usable = capacidad × (soc − reserva) / 100`,
    así que un 21 % con la reserva en el 20 no puede tener 5 kWh por encima. La
    primera versión de este banco los ponía y salía un aviso de «está en su
    reserva» con la batería medio llena — un caso que no existe en ninguna casa.
    """
    soc = reserva + usable_kwh / capacidad * 100.0
    return {"sol_at": lambda _t: sol, "casa_at": casa_at,
            "soc": round(min(soc, 100.0), 1), "capacity_kwh": capacidad,
            "usable_kwh": usable_kwh, "reserve_pct": reserva}


est = A.estimate(AC, AHORA, PRECIO, fuentes(0.1))
v = A.verdict(AC, VENTANA, AHORA, PRECIO, est)
ok(v["kind"] != "gratis",
   f"con 805 W de sol y la batería en su reserva, no es «Gratis» ({v['kind']})")
ok(v["kind"] == "parcial" and v["value"] and v["value"] > 0.1,
   f"es lo que cuesta, en euros ({v['value']} €)")
ok("% lo pone el sol" in (v["sub"] or ""),
   f"diciendo cuánto pone el sol («{v['sub']}»)")

# Y con sol de sobra sí es gratis, que si no habríamos roto lo que funcionaba.
est_sol = A.estimate(AC, AHORA, PRECIO, fuentes(0.1, sol=6000.0))
v_sol = A.verdict(AC, VENTANA, AHORA, PRECIO, est_sol)
ok(v_sol["kind"] == "gratis" and v_sol["value"] == "Gratis",
   f"con sol de sobra sigue siendo «Gratis» ({v_sol['kind']})")
ok(est_sol["grid_kwh"] == 0.0 and est_sol["battery_kwh"] == 0.0,
   "y entonces no hace falta ni batería ni red")

print("\n10-11 · los dos casos intermedios")
# Batería con hueco de sobra: lo cubre el sol y la batería, sin red.
est_bat = A.estimate(AC, AHORA, PRECIO, fuentes(5.0))
v_bat = A.verdict(AC, VENTANA, AHORA, PRECIO, est_bat)
ok(est_bat["grid_kwh"] < 0.05 and est_bat["battery_kwh"] > 0.5,
   f"con 5 kWh utilizables lo pone la batería ({est_bat})")
ok(v_bat["kind"] == "bateria",
   f"y el veredicto lo dice, sin llamarlo gratis ({v_bat['kind']})")
ok(v_bat["value"] and v_bat["value"] > 0,
   f"con lo que costaría reponerla ({v_bat['value']} €)")

print("\n12 · la tarjeta lleva el estado de la batería")
tarjeta = A.advice([{"id": "ac", "name": "A/C", "color": "#f0f", "icon": "potencia"}],
                   {"ac": {"cycle": AC}}, VENTANA, AHORA, PRECIO, fuentes(0.1))
b = tarjeta["battery"]
ok(b is not None, "viene en el payload")
ok(b["at_reserve"] is True,
   f"y dice que la reserva es la que manda ({b})")
ok(b["reserve_pct"] == 20.0 and b["soc"] == 21.0,
   "con la carga y la reserva, para poder explicarlo")
suelta = A.advice([{"id": "ac", "name": "A/C", "color": "#f0f", "icon": "potencia"}],
                  {"ac": {"cycle": AC}}, VENTANA, AHORA, PRECIO, fuentes(5.0))
ok(suelta["battery"]["at_reserve"] is False,
   "y con batería de sobra no se avisa de nada")
ok(A.advice([{"id": "ac", "name": "A/C", "color": "#f0f", "icon": "potencia"}],
            {"ac": {"cycle": AC}}, VENTANA, AHORA, PRECIO, None)["battery"] is None,
   "sin fuentes no se inventa un estado")

print("\n13 · el veredicto y la estimación no pueden discrepar")
# La comprobación de fondo, la que habría cazado la queja. Se barre el día entero
# —también las horas de antes de que abra la ventana, que es donde el defecto
# quedaba aplazado— y se pasa por `advice`, que es el camino de verdad: en ninguna
# combinación puede salir «Gratis» con la estimación de ese mismo momento pidiendo
# batería o red.
APARATOS = [{"id": "ac", "name": "A/C", "color": "#f0f", "icon": "potencia"}]
malos = []
casos = 0
for hora in range(6, 22):
    for u in (0.0, 0.1, 1.0, 5.0):
        for s in (200.0, 805.0, 2000.0, 6000.0):
            casos += 1
            momento = AHORA.replace(hour=hora, minute=0)
            f = fuentes(u, sol=s)
            fila = A.advice(APARATOS, {"ac": {"cycle": AC}},
                            VENTANA, momento, PRECIO, f)["rows"][0]
            if fila["verdict"]["kind"] != "gratis":
                continue
            # La estimación del momento del que habla el veredicto, que con la
            # ventana cerrada por delante no es la de ahora.
            abre = datetime.fromisoformat(VENTANA["today"]["start"])
            e = A.estimate(AC, max(momento, abre), PRECIO, f)
            if e and (e["battery_kwh"] > 0.05 or e["grid_kwh"] > 0.05):
                malos.append((hora, u, s, e["battery_kwh"], e["grid_kwh"]))
ok(not malos,
   f"en {casos} combinaciones de hora, batería y sol, ninguna miente ({malos[:2]})")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

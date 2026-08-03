"""Una sola curva de sol para toda la pantalla, y el cielo de hoy dentro.

De una queja del 3 de agosto, con dos capturas de la misma pantalla: la tarjeta
de la ventana decía «Lavadora · gratis **desde las 10:06**» y la del plan decía
«ahora · es su mejor hora». Y después, la puntilla: *«además está nublado ahora
mismo y la producción real es bajísima»*.

Eran dos defectos encadenados. El de la redacción se arregló en la 0.47.1. El de
debajo era peor: **las dos tarjetas calculaban el sol con curvas distintas**.
`_fuentes` corregía la previsión con la producción real del momento; `free_energy`
solo con el sesgo histórico del tejado. Así que la ventana prometía una hora
sacada de la previsión casi cruda mientras el plan, mirando el tejado, ya sabía
que no.

Lo que se comprueba aquí:

  1. la curva se construye una vez y las dos consumidoras leen esa
  2. sin previsión no hay curva, y las dos tarjetas desaparecen en vez de inventar
  3. un cielo encapotado rebaja la curva de hoy
  4. y **no** la de mañana, que hoy no se sabe
  5. el sol que ve el plan es exactamente el de la curva, sin correcciones propias
  6. la ventana y el plan enseñan el mismo `sky`: no pueden discrepar
  7. con el cielo despejado no se corrige nada y no se dice nada
  8. la ventana se acorta cuando el cielo la desmiente
"""
import asyncio
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)
import live                                                  # noqa: E402
import prevision as P                                         # noqa: E402
import series as S                                            # noqa: E402

TZ = ZoneInfo("Europe/Madrid")
AHORA = datetime(2026, 8, 3, 11, 40, tzinfo=TZ)
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


# Un día de previsión generosa: campana de 8 a 20, con 5 kW de pico, hoy y
# mañana iguales. Así cualquier diferencia entre los dos días sale de lo que se
# le aplique a uno y no al otro.
def campana(dia):
    filas = []
    for h in range(24):
        for m in (0, 30):
            t = datetime(dia.year, dia.month, dia.day, h, m, tzinfo=TZ)
            x = (h + m / 60.0 - 14.0) / 6.0
            w = max(0.0, 5000.0 * (1.0 - x * x))
            filas.append({"period_start": t.isoformat(), "pv_estimate": w / 1000.0})
    return filas


def estados(pv_w):
    return {
        "sensor.prevision": {
            "state": "30.0",
            "attributes": {
                "detailedForecast": campana(AHORA.date()) + campana(
                    AHORA.date() + timedelta(days=1)
                ),
            },
        },
        "sensor.pv_power": {"state": str(pv_w), "attributes": {"unit_of_measurement": "W"}},
        "sensor.casa": {"state": "600", "attributes": {"unit_of_measurement": "W"}},
    }


AJUSTES = {
    "solar_forecast_sensor": "sensor.prevision",
    "battery_kwh": 0.0,
    "flow_sensors": {"pv": "sensor.pv_power", "home": "sensor.casa"},
}


def buckets_de_hoy(fraccion):
    """Lo producido hoy por hora, como `fraccion` de lo previsto (kWh)."""
    previsto = P.por_horas([
        (t, w) for t, w in S.forecast_power([estados(0)["sensor.prevision"]], TZ)
        if t.date() == AHORA.date()
    ])
    return {
        datetime(AHORA.year, AHORA.month, AHORA.day, h, tzinfo=TZ).isoformat():
            {"pv_energy": wh * fraccion / 1000.0}
        for h, wh in previsto.items() if h < AHORA.hour
    }


def curva(pv_w, fraccion):
    return live.curva_solar(
        AJUSTES, estados(pv_w), {"pv": float(pv_w)},
        buckets_de_hoy(fraccion), TZ, AHORA,
    )


# El perfil de la casa se pide a Home Assistant, y aquí no hay ninguno: se planta
# uno plano de 600 W con la clase de verdad, no con un doble, para que si su
# interfaz cambia este banco se entere. Es lo único que se sustituye; todo lo
# demás —la curva, la ventana, el plan— es el código que corre en la casa.
PERFIL = live.HouseProfile({}, 600.0, "banco", 7)


async def _perfil_de_banco(*_a, **_k):
    return PERFIL


live._house_profile = _perfil_de_banco


print("1-2 · una curva, y ninguna si no hay previsión")
c = curva(4200, 1.0)
ok(c is not None and c["points"], f"la curva sale ({c and len(c['points'])} puntos)")
ok(set(c) == {"points", "bias", "sky"}, f"con lo que hace falta y nada más ({sorted(c)})")
vacia = live.curva_solar(
    {**AJUSTES, "solar_forecast_sensor": "sensor.no_existe"},
    estados(0), {"pv": 0.0}, {}, TZ, AHORA,
)
ok(vacia is None, "sin previsión no hay curva")
ok(asyncio.run(live.free_energy(None, AJUSTES, estados(0), TZ, AHORA)) is None,
   "y entonces la ventana no se enseña")
ok(asyncio.run(live._fuentes(None, AJUSTES, estados(0), None, TZ, AHORA)) is None,
   "ni el plan se planifica")

print("\n3-4 · el cielo de hoy rebaja hoy, no mañana")
# Encapotado: hoy se ha producido el 15 % de lo previsto, y ahora mismo también.
previsto_ahora = S.forecast_at(
    S.forecast_power([estados(0)["sensor.prevision"]], TZ), AHORA
)
gris = curva(round(previsto_ahora * 0.15), 0.15)
ok(gris["sky"] and gris["sky"]["factor"] <= 0.2,
   f"el factor baja al {gris['sky'] and gris['sky']['factor']}")
ok(gris["sky"]["hour_ratio"] is not None and gris["sky"]["now_ratio"] is not None,
   f"con los dos testigos ({gris['sky']})")
# El viejo suelo era 0,2: un 15 % real se quedaba prometiendo el 20 %.
ok(gris["sky"]["factor"] < 0.2,
   f"y pasa por debajo del suelo viejo de 0,2 ({gris['sky']['factor']})")


def a_las(puntos, momento):
    return S.forecast_at(puntos, momento)


claro = curva(round(previsto_ahora), 1.0)
tarde_hoy = AHORA.replace(hour=15, minute=0)
tarde_manana = tarde_hoy + timedelta(days=1)
ok(a_las(gris["points"], tarde_hoy) < a_las(claro["points"], tarde_hoy) * 0.3,
   f"esta tarde se rebaja ({a_las(gris['points'], tarde_hoy):.0f} W frente a "
   f"{a_las(claro['points'], tarde_hoy):.0f})")
ok(abs(a_las(gris["points"], tarde_manana)
       - a_las(claro["points"], tarde_manana)) < 1.0,
   f"y mañana se queda igual ({a_las(gris['points'], tarde_manana):.0f} W frente a "
   f"{a_las(claro['points'], tarde_manana):.0f})")

print("\n5-6 · las dos tarjetas, la misma curva")
fuentes = asyncio.run(live._fuentes(gris, AJUSTES, estados(0), 50.0, TZ, AHORA))
ok(fuentes is not None, "el plan tiene con qué")
# El sol que el plan usa para simular tiene que ser el de la curva, punto por
# punto: cualquier corrección propia aquí es la vuelta al defecto de partida.
desvios = [
    abs(fuentes["sol_at"](tarde_hoy.replace(hour=h)) - a_las(gris["points"], tarde_hoy.replace(hour=h)))
    for h in range(8, 21)
]
ok(max(desvios) < 1e-9,
   f"y su sol es exactamente el de la curva (desvío máximo {max(desvios):.2e} W)")
ventana = asyncio.run(live.free_energy(gris, AJUSTES, estados(0), TZ, AHORA))
ok(ventana is not None and ventana["sky"] == gris["sky"],
   f"la ventana enseña el cielo de la curva ({ventana and ventana['sky']})")
ok(fuentes["sky"] == ventana["sky"],
   "y es el mismo que se lleva el plan: no pueden discrepar")

print("\n7 · con el cielo despejado no se inventa nada")
ok(claro["sky"] is not None and claro["sky"]["factor"] >= 0.95,
   f"el factor se queda en uno ({claro['sky'] and claro['sky']['factor']})")
sin_nada = live.curva_solar(AJUSTES, estados(0), {"pv": 0.0}, {}, TZ, AHORA)
ok(sin_nada["sky"] is None or sin_nada["sky"]["hour_ratio"] is None,
   "y sin horas cerradas medidas no hay testigo de la hora")

print("\n8 · la ventana se acorta cuando el cielo la desmiente")
v_claro = asyncio.run(live.free_energy(claro, AJUSTES, estados(0), TZ, AHORA))
kwh_claro = (v_claro["today"] or {}).get("kwh")
kwh_gris = (ventana["today"] or {}).get("kwh", 0.0) if ventana["today"] else 0.0
ok(kwh_claro and kwh_claro > 0, f"con sol hay ventana ({kwh_claro} kWh)")
ok(kwh_gris < kwh_claro * 0.5,
   f"y con nubes se queda en mucho menos ({kwh_gris} frente a {kwh_claro} kWh)")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

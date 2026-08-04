"""Quién se ha gastado la factura: el ciclo repartido por electrodoméstico.

La comparativa contesta *cuánto* cuesta el ciclo con cada tarifa. Esto contesta la
siguiente pregunta, que es la que uno se hace mirándola: **de eso, qué parte es de
cada cosa**. Y contestarla bien tiene tres condiciones que este módulo respeta, y
sin las cuales el desglose es un adorno:

1. **Está «el resto de la casa».** Un desglose que solo enseña los enchufes medidos
   deja fuera casi todo —la cocina, las luces, la bomba de calor, el ordenador que
   nadie midió— y quien lo mira concluye que su factura no cuadra. El resto se
   calcula como una **resta**: el consumo de la casa esa hora menos lo que sumaron
   los aparatos medidos. No se estima; sale de lo que ya está medido.

2. **Cuadra.** Precisamente por ser una resta, las filas suman el total del ciclo
   por construcción y no por suerte. Lo que no cuadre —y puede no cuadrar, porque
   los contadores no son perfectos— sale en su propia fila con su nombre, en vez de
   repartirse por ahí para que la tabla parezca limpia.

3. **El coste va por origen, no por kWh × precio medio.** Un aparato que solo se
   pone al mediodía no cuesta lo mismo que uno que se pone a las nueve de la noche,
   aunque gasten los mismos kilovatios: el primero se lo lleva del sol y el segundo
   de la red. Repartir la factura a prorrata de los kWh borra justo el consejo que
   da toda la aplicación. Así que cada hora se reparte con **su** origen y **su**
   precio, y solo se cobra lo que salió de la red.

Y una cuarta cosa, que es la que hace que la suma llegue al término de energía de
la factura: **la factura no cobra lo que la casa consumió de la red, cobra lo
importado**, y no es lo mismo. Los kilovatios que la red metió en la batería de
madrugada están en la factura y ningún aparato los consumió a esa hora. Van en su
propia fila. Sin ella el desglose siempre sumaría de menos y parecería un error.

Alcance: la energía por aparato sale de las estadísticas **horarias** de su sensor
de potencia, que Home Assistant guarda indefinidamente. Los ciclos de cinco minutos
que aprende `appliances` solo cubren unos diez días; un ciclo de facturación es un
mes, así que aquí se pide la hora, que es además el grano al que se reparte el
origen.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import appliances as appliances_mod
import datasources
import series as series_mod

_LOGGER = logging.getLogger(__name__)

# Por debajo de esto una fila no se publica: es ruido de medida, y una tabla con
# doce filas de «0,00 €» esconde las tres que importan.
_MIGAJA_KWH = 0.05

# Nombres de las filas que no son un aparato. Están aquí y no repartidos por el
# código porque la interfaz las distingue por el `id`, no por el texto.
ID_RESTO = "__resto__"
ID_BATERIA = "__bateria_red__"
ID_SIN_ASIGNAR = "__sin_asignar__"


async def por_horas_de_aparatos(
    settings: dict[str, Any],
    states: dict[str, Any],
    lista: list[dict[str, Any]],
    tz,
    start: datetime,
    end: datetime,
) -> dict[str, dict[str, float]]:
    """kWh por hora de cada aparato: ``{id: {iso de la hora: kwh}}``.

    Una sola llamada para todos, por lo mismo que `appliances.learn`: cada una abre
    un socket y se trae la lista entera de metadatos.

    La media horaria de la potencia por una hora **es** la energía de esa hora, y es
    la cuenta correcta aunque el aparato solo estuviera en marcha veinte minutos: la
    media ya lo tiene en cuenta. No hace falta el sensor de energía del aparato, que
    además muchos enchufes no tienen.
    """
    ids = [a["power_entity"] for a in lista if a.get("power_entity")]
    if not ids:
        return {}
    out: dict[str, dict[str, float]] = {}
    results, units = await series_mod.ws_statistics(
        settings,
        [{"ids": list(dict.fromkeys(ids)), "start": start, "end": end,
          "period": "hour", "types": ["mean"]}],
    )
    for a in lista:
        entity = a.get("power_entity") or ""
        if not entity:
            continue
        factor = series_mod._unit_factor(entity, states, "power", units)
        filas = series_mod._extract(results[0], entity, "mean", tz, factor)
        if not filas:
            continue
        # W medios × 1 h ÷ 1000 = kWh. El reposo cuenta: son vatios que la casa
        # gastó, y descontarlos aquí los mandaría a «el resto de la casa».
        out[a["id"]] = {iso: max(w, 0.0) / 1000.0 for iso, w in filas.items()}
    return out


# Paso con el que se recorre el mes cuando hay InfluxDB. Quince minutos y no cinco:
# un mes a cinco son 8.640 puntos por aparato y no compra nada —una lavadora de hora y
# media se resuelve igual de bien a cuarto de hora, y dos ciclos cortos en la misma hora
# siguen distinguiéndose, que es lo que las estadísticas horarias no podían—.
PASO_INFLUX_MIN = 15


async def ciclos_del_periodo(
    settings: dict[str, Any],
    states: dict[str, Any],
    lista: list[dict[str, Any]],
    tz,
    start: datetime,
    end: datetime,
) -> dict[str, list[dict[str, Any]]] | None:
    """Los ciclos de verdad de cada aparato en el periodo, si hay con qué.

    De una corrección: *«HA guarda un mes pero ojo que tb tenemos el influx. Si un
    usuario usa influx, puedes hacer análisis más profundos»*. Y es cierto — el
    desglose contaba **tramos de hora** porque las estadísticas de Home Assistant es
    lo único que guardan de un mes entero, pero quien tenga InfluxDB tiene meses de
    datos finos, y ahí un ciclo es un ciclo.

    Devuelve ``None`` cuando no hay InfluxDB configurado, que es la señal de que hay
    que quedarse con los tramos. No es un fallo: es que con esos datos no se puede
    saber más, y decirlo es mejor que fingir un recuento.

    El detector es el de `appliances`, con su paso: uno solo, para que un ciclo aquí y
    un ciclo en la Home sean la misma cosa.
    """
    if not ((settings.get("influx") or {}).get("url") or "").strip():
        return None
    out: dict[str, list[dict[str, Any]]] = {}
    for a in lista:
        entity = a.get("power_entity") or ""
        if not entity:
            continue
        unidad = ((states.get(entity, {}).get("attributes") or {})
                  .get("unit_of_measurement") or "")
        try:
            crudo = await datasources.influx_hourly_mean(
                settings, entity, unidad, start, end, tz, PASO_INFLUX_MIN)
        except Exception:  # noqa: BLE001 - sin Influx se sigue con los tramos
            _LOGGER.warning("InfluxDB no dio la curva de %s", entity, exc_info=True)
            return None
        if not crudo:
            continue
        factor = 1000.0 if unidad.strip().lower() == "kw" else 1.0
        muestras = [(m, max(w, 0.0) * factor) for m, w in crudo]
        umbral = float(a.get("standby_w") or 0)
        ciclos = appliances_mod._ciclos_de(muestras, umbral, PASO_INFLUX_MIN)
        # El último puede estar abierto solo si el periodo llega hasta ahora; en un
        # ciclo cerrado del pasado no hay nada en marcha, y contarlo como tal daría
        # un ciclo a medias en la mediana de «lo que suele durar».
        out[a["id"]] = [c for c in ciclos if not c.get("open")] or ciclos
    return out or None


async def reparto_del_periodo(
    settings: dict[str, Any],
    states: dict[str, Any],
    tz,
    start: datetime,
    end: datetime,
) -> tuple[dict[str, dict[str, float]] | None, dict[str, float]]:
    """El origen del consumo, hora a hora, de un periodo cualquiera.

    Lo mismo que hace la Home con el día, con el mismo constructor: se piden los seis
    contadores por horas, se separan los pares que comparten sensor y se recortan los
    reinicios, y `series.reparto_por_horas` los reparte.

    El contador de la casa se usa como medida directa del total si suma algo en el
    periodo; si no suma nada —no está configurado, o el sensor está invertido y se ha
    recortado a cero— el consumo se deduce por balance, que es la regla que ya sigue
    el gráfico de Energía.

    Devuelve también **lo importado hora a hora**, que el reparto no lleva dentro:
    `split_flows` publica en qué se partió (`from_grid`, `grid_to_battery`) pero no
    la cifra del contador de la que se partió, y sin ella no hay forma de saber si
    el reparto se dejó algo por el camino.
    """
    energy_cfg = settings.get("energy_sensors") or {}
    ids = [energy_cfg.get(k) for k in series_mod.ENERGY_KEYS + series_mod.ENERGY_PARTES
           if energy_cfg.get(k)]
    if not ids:
        return None, {}
    results, units = await series_mod.ws_statistics(
        settings,
        [{"ids": list(dict.fromkeys(ids)), "start": start, "end": end,
          "period": "hour", "types": ["change"]}],
    )
    by_key: dict[str, dict[str, float]] = {}
    for key in series_mod.ENERGY_KEYS + series_mod.ENERGY_PARTES:
        entity = energy_cfg.get(key)
        if not entity:
            continue
        factor = series_mod._unit_factor(entity, states, "energy", units)
        filas = series_mod._extract(results[0], entity, "change", tz, factor)
        if filas:
            by_key[key] = filas
    series_mod.split_signed_buckets(by_key, energy_cfg, series_mod.ENERGY_PAIRS)
    series_mod.clamp_buckets(by_key)

    per_bucket: dict[str, dict[str, float]] = {}
    for key, filas in by_key.items():
        for iso, value in filas.items():
            per_bucket.setdefault(iso, {})[key] = value
    medida = sum((by_key.get("home_energy") or {}).values()) > 0
    partes = tuple(
        any(v.get(k) for v in per_bucket.values()) for k in series_mod.ENERGY_PARTES
    )
    reparto = series_mod.reparto_por_horas(per_bucket, medida, partes)
    # Por horas también lo importado, con el mismo agrupado, para que las claves
    # sean exactamente las mismas que las del reparto.
    importada = {
        iso: valores.get("grid_import_energy") or 0.0
        for iso, valores in series_mod.por_horas(per_bucket).items()
    }
    return reparto, importada


def _escalar(
    por_aparato: dict[str, dict[str, float]],
    reparto: dict[str, dict[str, float]],
) -> tuple[dict[str, dict[str, float]], float]:
    """Que los aparatos de una hora no sumen más que la casa en esa hora.

    Puede pasar, y no significa que un enchufe consuma de más: son contadores
    distintos, con cadencias distintas y errores propios. Si se deja pasar, dos
    cosas se rompen a la vez —«el resto de la casa» saldría negativo y la suma de
    las filas se pasaría del total— y la tabla dejaría de cuadrar justo cuando más
    se mira.

    Así que en esa hora se escalan **todos** a la baja por igual, y lo que se
    recorta se cuenta para poder decirlo. Escalar y no recortar al mayor: no hay
    motivo para creer que el error es de un enchufe en concreto.

    Una hora con la casa a cero no se escala: ahí no hay proporción que aplicar, y
    dejarlo pasar hace que `appliances.atribuir` lo declare sin origen, que es lo
    que es.
    """
    total_h: dict[str, float] = {}
    for consumo in por_aparato.values():
        for iso, kwh in consumo.items():
            total_h[iso] = total_h.get(iso, 0.0) + kwh
    factor: dict[str, float] = {}
    recortado = 0.0
    for iso, medido in total_h.items():
        casa = (reparto.get(iso) or {}).get("home_total") or 0.0
        if casa <= 0 or medido <= casa:
            continue
        factor[iso] = casa / medido
        recortado += medido - casa
    if not factor:
        return por_aparato, 0.0
    escalado = {
        ident: {iso: kwh * factor.get(iso, 1.0) for iso, kwh in consumo.items()}
        for ident, consumo in por_aparato.items()
    }
    return escalado, recortado


def _detalle(
    consumo: dict[str, float],
    reparto: dict[str, dict[str, float]],
    precio_de: Any,
    ciclos: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Lo que la suma del mes esconde: cuándo se usó y qué día salió caro.

    Una fila que dice «lavavajillas · 7,2 kWh · 1,19 €» no deja hacer nada con la
    información. Lo que se puede cambiar es **la hora**, y para verlo hace falta
    abrir la fila.

    Tres cosas, y las tres medidas:

    · **Los días que se usó** y **en cuántos tramos**. Y tramos, no ciclos: aquí la
      resolución es la hora —es lo que Home Assistant guarda para un mes entero— así
      que un tramo son horas seguidas con consumo. Dos lavados cortos en la misma
      hora son un tramo, y uno que cruza una hora sin gastar son dos. Llamarlos
      ciclos sería publicar un recuento que estos datos no sostienen.
    · **El día que más costó**, que es donde se ve si fue una vez o es la costumbre.
    · **A qué horas se pone**, sumado por hora del día. Es la cifra accionable: un
      lavavajillas con todo su bulto a las 22:00 tiene un problema que se arregla
      tocando un botón, y en el total del mes no se ve.

    El coste por día sale de `appliances.atribuir`, la misma función que da el de la
    fila entera: aquí solo se le pasan las horas de un día. Repetir la cuenta habría
    sido tener dos cifras del mismo lavavajillas.
    """
    con_algo = {iso: k for iso, k in consumo.items() if k > _MIGAJA_KWH / 24}
    if not con_algo:
        return {}
    horas = sorted(con_algo)

    # Tramos: horas seguidas. El salto de una hora es lo que los separa.
    tramos = 1
    for antes, ahora in zip(horas, horas[1:]):
        try:
            a, b = datetime.fromisoformat(antes), datetime.fromisoformat(ahora)
        except ValueError:
            continue
        if (b - a).total_seconds() > 3600 + 1:
            tramos += 1

    por_dia: dict[str, dict[str, float]] = {}
    por_hora = [0.0] * 24
    # Y de eso, cuánto lo puso el sol. Sin esta pieza la tira de horas dice **cuándo**
    # se usó y no **cuándo salió gratis**, que es la mitad que da el consejo: dos barras
    # iguales a las 13 y a las 22 no cuestan lo mismo, y la tira lo tiene que enseñar
    # sin que haya que leer nada. La fracción es la del reparto de esa hora, la misma
    # que usa `atribuir`: la parte del aparato es proporcional a la de la casa.
    sol_por_hora = [0.0] * 24
    for iso, kwh in con_algo.items():
        por_dia.setdefault(iso[:10], {})[iso] = kwh
        try:
            h = datetime.fromisoformat(iso).hour
        except ValueError:
            continue
        por_hora[h] += kwh
        split = reparto.get(iso) or {}
        casa = split.get("home_total") or 0.0
        if casa > 0:
            limpio = (split.get("from_solar") or 0.0) + (split.get("from_battery") or 0.0)
            sol_por_hora[h] += kwh * min(limpio / casa, 1.0)

    peor = None
    for dia, horas_del_dia in por_dia.items():
        cuenta = appliances_mod.atribuir(horas_del_dia, reparto, precio_de)
        if not cuenta:
            continue
        clave = cuenta["eur"] if cuenta["eur"] is not None else cuenta["grid_kwh"]
        if peor is None or clave > peor[0]:
            peor = (clave, {"date": dia, "eur": cuenta["eur"],
                            "kwh": cuenta["kwh"], "grid_kwh": cuenta["grid_kwh"]})
    # Y si hay InfluxDB, los ciclos de verdad en vez del recuento de tramos: cuántos,
    # lo que suele durar uno y a qué hora se suelen poner. Lo último es más accionable
    # que la tira de kWh, porque es la hora del botón y no la del consumo.
    de_ciclos: dict[str, Any] = {}
    if ciclos:
        horas_c = sorted(float(c["hours"]) for c in ciclos)
        arranques = [0] * 24
        for c in ciclos:
            arranques[c["start"].hour] += 1
        de_ciclos = {
            "cycles": len(ciclos),
            "median_h": round(horas_c[len(horas_c) // 2], 2),
            "starts_by_hour": arranques,
        }
    return {
        "days": len(por_dia),
        "runs": tramos,
        **de_ciclos,
        "worst_day": peor[1] if peor else None,
        "by_hour": [round(v, 3) for v in por_hora],
        # La parte de cada hora que no hubo que comprar: sol y batería juntos, que es
        # lo que la fila ya trata igual —ninguno de los dos se cobra— y lo que hace que
        # la barra se lea de un golpe.
        "free_by_hour": [round(v, 3) for v in sol_por_hora],
    }


def filas(
    lista: list[dict[str, Any]],
    por_aparato: dict[str, dict[str, float]],
    reparto: dict[str, dict[str, float]] | None,
    importada: dict[str, float],
    precio_de: Any,
    ciclos: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any] | None:
    """Las filas del desglose, con su total y lo que no se ha podido colocar.

    ``precio_de(iso)`` da el precio del término de energía de esa hora, o ``None``
    si no se sabe (un PVPC sin precios, por ejemplo): entonces se publican los kWh
    y no los euros, en vez de inventarse un precio medio.

    La identidad que esto mantiene, y que el banco comprueba:

        Σ red(aparatos) + red(resto) + red→batería + sin asignar = importada

    Las tres primeras son consumo repartido; la cuarta es lo que el reparto no pudo
    colocar. Cuadra por construcción porque «el resto» es una resta y porque nada se
    escala sin contarlo, no porque las cifras salgan redondas.
    """
    if not reparto:
        return None

    ajustado, recortado = _escalar(por_aparato, reparto)

    medido_por_hora: dict[str, float] = {}
    for consumo in ajustado.values():
        for iso, kwh in consumo.items():
            medido_por_hora[iso] = medido_por_hora.get(iso, 0.0) + kwh

    # El resto de la casa: la resta. Ya no puede salir negativa —`_escalar` se
    # encarga— y el `max` que queda es contra el error de coma flotante.
    resto_por_hora = {
        iso: max((split.get("home_total") or 0.0) - medido_por_hora.get(iso, 0.0), 0.0)
        for iso, split in reparto.items()
    }

    out: list[dict[str, Any]] = []
    for a in lista:
        cuenta = appliances_mod.atribuir(ajustado.get(a["id"]) or {}, reparto, precio_de)
        if not cuenta or cuenta["kwh"] < _MIGAJA_KWH:
            continue
        out.append({
            "id": a["id"], "name": a["name"],
            "color": a["color"], "icon": a["icon"],
            "kind": "aparato", **cuenta,
            # Lo que la suma del mes esconde, para cuando se abre la fila.
            "detail": _detalle(ajustado.get(a["id"]) or {}, reparto, precio_de,
                               (ciclos or {}).get(a["id"])),
        })

    resto = appliances_mod.atribuir(resto_por_hora, reparto, precio_de)
    if resto and resto["kwh"] >= _MIGAJA_KWH:
        out.append({
            "id": ID_RESTO, "name": "El resto de la casa",
            "color": None, "icon": "casa", "kind": "resto", **resto,
        })

    # Por lo que cuesta, que es de lo que va la pantalla. Sin precios, por lo que
    # se llevó de la red, que es lo único que cuesta dinero.
    out.sort(key=lambda f: -(f["eur"] if f["eur"] is not None else f["grid_kwh"]))

    def _sumar(kwh_de) -> tuple[float, float | None]:
        """kWh y euros de una magnitud horaria, cobrando cada hora a su precio."""
        kwh = 0.0
        eur = 0.0
        con_precio = True
        for iso in reparto:
            parte = kwh_de(iso)
            if parte <= 0:
                continue
            kwh += parte
            p = precio_de(iso)
            if p is None:
                con_precio = False
            else:
                eur += parte * p
        return kwh, (round(eur, 2) if con_precio else None)

    # Lo importado que cargó la batería: está en la factura y no lo consumió ningún
    # aparato a esa hora. Va al final, porque no es consumo de nadie: es energía
    # comprada y guardada, que se gastará —y aparecerá como batería en las filas de
    # arriba— más tarde, puede que otro día.
    bat_kwh, bat_eur = _sumar(
        lambda iso: (reparto[iso].get("grid_to_battery") or 0.0))
    if bat_kwh >= _MIGAJA_KWH:
        out.append({
            "id": ID_BATERIA, "name": "Cargar la batería desde la red",
            "color": None, "icon": "bateria", "kind": "bateria",
            "kwh": round(bat_kwh, 3), "sun_kwh": 0.0, "battery_kwh": 0.0,
            "grid_kwh": round(bat_kwh, 3), "unplaced_kwh": 0.0, "eur": bat_eur,
        })

    # Y el cuadre. Lo importado de una hora se parte en lo que llegó a la casa y lo
    # que cargó la batería; si el contador de la casa marca menos de lo que la red
    # le entregó, sobra energía comprada que ningún origen colocó. No se reparte
    # entre las filas para que la tabla parezca limpia: se dice.
    def _sobra(iso: str) -> float:
        split = reparto[iso]
        return max(
            importada.get(iso, 0.0)
            - (split.get("from_grid") or 0.0)
            - (split.get("grid_to_battery") or 0.0),
            0.0,
        )

    sin_kwh, sin_eur = _sumar(_sobra)
    if sin_kwh >= _MIGAJA_KWH:
        out.append({
            "id": ID_SIN_ASIGNAR, "name": "Sin asignar",
            "color": None, "icon": "aviso", "kind": "descuadre",
            "kwh": round(sin_kwh, 3), "sun_kwh": 0.0, "battery_kwh": 0.0,
            "grid_kwh": round(sin_kwh, 3), "unplaced_kwh": 0.0, "eur": sin_eur,
        })

    total_eur = None
    if out and all(f["eur"] is not None for f in out):
        total_eur = round(sum(f["eur"] for f in out), 2)
    return {
        "rows": out,
        "grid_kwh": round(sum(f["grid_kwh"] for f in out), 2),
        "home_kwh": round(sum(s.get("home_total") or 0.0 for s in reparto.values()), 2),
        "imported_kwh": round(sum(importada.values()), 2),
        "eur": total_eur,
        # Sobre cuántas horas se ha repartido, que es el grano de la cuenta: la
        # interfaz lo dice, porque «hora a hora» sin decir cuántas es una promesa
        # sin comprobar.
        "hours": len(reparto),
        # Lo que `_escalar` tuvo que recortar. Cero mientras los contadores se
        # lleven bien; si no, sale en la interfaz en vez de quedarse aquí.
        "trimmed_kwh": round(recortado, 2),
        # Si los tramos son ciclos de verdad, para que la interfaz no los llame de una
        # manera cuando son de la otra.
        "cycles": bool(ciclos),
    }

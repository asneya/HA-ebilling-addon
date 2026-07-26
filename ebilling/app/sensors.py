"""Publicación de sensores en Home Assistant vía la API de estados.

Por cada tarifa se exponen:

  - sensor.ebilling_<tarifa>_precio         €/kWh del término de energía ahora
  - sensor.ebilling_<tarifa>_precio_excedente  €/kWh de compensación (si aplica)
  - sensor.ebilling_<tarifa>_coste_ciclo    € acumulados del ciclo actual
  - sensor.ebilling_<tarifa>_proyeccion     € estimados a fin de ciclo

Y dos sensores globales:

  - sensor.ebilling_mejor_tarifa            nombre de la tarifa más barata
  - sensor.ebilling_ahorro_potencial        € de diferencia entre la tarifa
                                            actualmente más cara y la más barata
"""

from __future__ import annotations

import logging
from typing import Any

import aiohttp

import datasources

_LOGGER = logging.getLogger(__name__)


async def _post_state(
    session: aiohttp.ClientSession,
    base: str,
    entity_id: str,
    state: Any,
    attributes: dict[str, Any],
) -> None:
    url = f"{base}/states/{entity_id}"
    async with session.post(
        url,
        json={"state": state, "attributes": attributes},
        timeout=aiohttp.ClientTimeout(total=10),
    ) as resp:
        if resp.status not in (200, 201):
            _LOGGER.warning(
                "No se pudo publicar %s (HTTP %s): %s",
                entity_id,
                resp.status,
                await resp.text(),
            )


async def publish(settings: dict[str, Any], payload: dict[str, Any]) -> None:
    """Publica los sensores. ``payload`` viene de main._sensor_payload()."""
    try:
        base, _, token = datasources._ha_endpoints(settings)
    except datasources.SourceError:
        _LOGGER.debug("Sin conexión con HA: no se publican sensores.")
        return

    headers = {"Authorization": f"Bearer {token}"}
    common = {"attribution": "eBilling add-on"}
    async with aiohttp.ClientSession(headers=headers) as session:
        for item in payload["tariffs"]:
            slug = item["slug"]
            base_attrs = {
                **common,
                "tarifa": item["name"],
                "compania": item["company"],
                "color": item.get("color"),
                "ciclo_inicio": payload["cycle_start"],
                "ciclo_fin": payload["cycle_end"],
            }
            if item.get("price") is not None:
                await _post_state(
                    session,
                    base,
                    f"sensor.ebilling_{slug}_precio",
                    round(item["price"], 6),
                    {
                        **base_attrs,
                        "friendly_name": f"eBilling {item['name']} precio",
                        "unit_of_measurement": "€/kWh",
                        "icon": "mdi:currency-eur",
                        "tramo": item.get("period"),
                    },
                )
            if item.get("surplus_price") is not None:
                await _post_state(
                    session,
                    base,
                    f"sensor.ebilling_{slug}_precio_excedente",
                    round(item["surplus_price"], 6),
                    {
                        **base_attrs,
                        "friendly_name": f"eBilling {item['name']} precio excedente",
                        "unit_of_measurement": "€/kWh",
                        "icon": "mdi:solar-power",
                    },
                )
            await _post_state(
                session,
                base,
                f"sensor.ebilling_{slug}_coste_ciclo",
                item["cycle_cost"],
                {
                    **base_attrs,
                    "friendly_name": f"eBilling {item['name']} coste ciclo",
                    "unit_of_measurement": "EUR",
                    "device_class": "monetary",
                    "icon": "mdi:receipt-text-outline",
                    "kwh_ciclo": item["kwh"],
                },
            )
            await _post_state(
                session,
                base,
                f"sensor.ebilling_{slug}_proyeccion",
                item["projected_cost"],
                {
                    **base_attrs,
                    "friendly_name": f"eBilling {item['name']} proyección ciclo",
                    "unit_of_measurement": "EUR",
                    "device_class": "monetary",
                    "icon": "mdi:chart-line",
                },
            )
            if item.get("virtual_wallet"):
                await _post_state(
                    session,
                    base,
                    f"sensor.ebilling_{slug}_monedero",
                    item.get("wallet_credit", 0.0),
                    {
                        **base_attrs,
                        "friendly_name": f"eBilling {item['name']} monedero virtual",
                        "unit_of_measurement": "EUR",
                        "device_class": "monetary",
                        "icon": "mdi:wallet-outline",
                    },
                )

        best = payload.get("best")
        if best:
            await _post_state(
                session,
                base,
                "sensor.ebilling_mejor_tarifa",
                best["name"],
                {
                    **common,
                    "friendly_name": "eBilling mejor tarifa",
                    "icon": "mdi:trophy-outline",
                    "coste_ciclo": best["cycle_cost"],
                    "totales": payload.get("totals"),
                },
            )
            await _post_state(
                session,
                base,
                "sensor.ebilling_ahorro_potencial",
                payload.get("potential_saving", 0.0),
                {
                    **common,
                    "friendly_name": "eBilling ahorro potencial",
                    "unit_of_measurement": "EUR",
                    "device_class": "monetary",
                    "icon": "mdi:piggy-bank-outline",
                },
            )

        # Borra de HA los sensores de tarifas que ya no existen (evita que
        # queden entidades huérfanas visibles, p. ej. en la tarjeta).
        expected = {"sensor.ebilling_mejor_tarifa", "sensor.ebilling_ahorro_potencial"}
        for item in payload["tariffs"]:
            slug = item["slug"]
            for suffix in ("precio", "precio_excedente", "coste_ciclo", "proyeccion"):
                expected.add(f"sensor.ebilling_{slug}_{suffix}")
            if item.get("virtual_wallet"):
                expected.add(f"sensor.ebilling_{slug}_monedero")
        await _cleanup_stale(session, base, expected)


async def _cleanup_stale(
    session: aiohttp.ClientSession,
    base: str,
    expected: set[str],
) -> None:
    """Elimina las entidades sensor.ebilling_* que ya no correspondan."""
    try:
        async with session.get(
            f"{base}/states", timeout=aiohttp.ClientTimeout(total=15)
        ) as resp:
            if resp.status != 200:
                return
            states = await resp.json()
    except (aiohttp.ClientError, ValueError):
        return
    for state in states:
        entity_id = state.get("entity_id", "")
        if entity_id.startswith("sensor.ebilling_") and entity_id not in expected:
            try:
                async with session.delete(
                    f"{base}/states/{entity_id}",
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status not in (200, 404):
                        _LOGGER.debug("No se pudo borrar %s (HTTP %s)", entity_id, resp.status)
                    else:
                        _LOGGER.info("Sensor huérfano eliminado: %s", entity_id)
            except aiohttp.ClientError:
                _LOGGER.debug("Error borrando %s", entity_id, exc_info=True)

"""Volver a inscribir el panel de Vatia en la barra lateral de Home Assistant.

El problema, contado entero porque el arreglo no se entiende sin él.

`config.yaml` trae `panel_admin: false` desde la 0.44.1, que es lo que hace que
Vatia salga en la barra lateral de todo el mundo y no solo de los
administradores. La cadena es:

    config.yaml (panel_admin)
      → Supervisor: GET /ingress/panels devuelve {"admin": panel_admin}
      → Core, componente `hassio`, addon_panel.py:
            frontend.async_register_built_in_panel(..., require_admin=data.admin)

Y ahí está el problema: **esa inscripción no se rehace al actualizar el
add-on**. En el Supervisor, `update_hass_panel()` —lo único que empuja el panel
a Core— se llama en tres sitios: al restaurar una copia, al desinstalar, y
cuando alguien mueve el interruptor «Mostrar en la barra lateral». `update()` no
lo llama. Así que Core se queda con el `require_admin` que le dieron **la primera
vez que se instaló el add-on**, que era `true`, y ahí sigue por muchas versiones
que pasen. Del otro lado, Core solo relee todos los paneles en el arranque
(`EVENT_HOMEASSISTANT_START`).

O sea que el ajuste estaba bien puesto y sin efecto, y la única salida era
reiniciar Home Assistant Core o mover el interruptor a mano. Ninguna de las dos
es algo que se pueda pedir a quien solo ha pulsado «actualizar».

Lo que se hace aquí es exactamente lo que hace ese interruptor, pero solo:
`POST /addons/self/options` con `ingress_panel`. Al Supervisor le basta con que
la clave **venga en el cuerpo** para llamar a `update_hass_panel()`, aunque el
valor no cambie, y entonces Core reinscribe el panel leyendo el `panel_admin` de
ahora.

Dos cuidados:

  · se lee antes el valor actual y se reenvía **ese mismo**. Si alguien ha
    escondido Vatia de la barra lateral a propósito, se respeta: el Supervisor
    manda un DELETE y sigue escondida. Forzar `true` sería arreglar una cosa
    pisando la decisión de otro;
  · si algo falla —no hay Supervisor porque esto corre fuera del add-on, la
    llamada da error, lo que sea— se anota y ya está. El panel es cosa de la
    barra lateral; la aplicación funciona igual y no hay por qué no arrancar.

`/addons/self/options` y `/addons/self/info` están en la lista de rutas que el
Supervisor deja pasar sin comprobar rol (`api_bypass` en su middleware de
seguridad), así que el SUPERVISOR_TOKEN del add-on basta y no hace falta pedir
`hassio_role`.
"""

from __future__ import annotations

import asyncio
import logging
import os

import aiohttp

_LOGGER = logging.getLogger("vatia")

_SUPERVISOR = "http://supervisor"
_TIMEOUT = aiohttp.ClientTimeout(total=15)


async def reinscribir() -> bool:
    """Pide al Supervisor que vuelva a inscribir el panel. ``True`` si se hizo.

    Silenciosa a propósito cuando no hay Supervisor: en desarrollo se arranca
    la app a mano y no hay panel ninguno que inscribir.
    """
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return False

    cabeceras = {"Authorization": f"Bearer {token}"}
    try:
        async with aiohttp.ClientSession(headers=cabeceras, timeout=_TIMEOUT) as sesion:
            async with sesion.get(f"{_SUPERVISOR}/addons/self/info") as resp:
                if resp.status != 200:
                    _LOGGER.debug(
                        "No se pudo leer la info del add-on (%s); "
                        "el panel se queda como esté", resp.status,
                    )
                    return False
                datos = (await resp.json()).get("data") or {}

            visible = datos.get("ingress_panel")
            if visible is None:
                # Sin ingress no hay panel. No debería pasar —`ingress: true`
                # está en config.yaml— pero no es motivo para inventarse nada.
                return False

            async with sesion.post(
                f"{_SUPERVISOR}/addons/self/options",
                json={"ingress_panel": bool(visible)},
            ) as resp:
                if resp.status not in (200, 201):
                    _LOGGER.warning(
                        "Home Assistant no ha recargado el panel de la barra "
                        "lateral (%s). Si no lo ves con tu usuario, reinicia "
                        "Home Assistant Core.", resp.status,
                    )
                    return False
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
        _LOGGER.warning(
            "No se pudo refrescar el panel de la barra lateral (%s). Si Vatia "
            "no le sale a quien no es administrador, reinicia Home Assistant "
            "Core una vez.", err,
        )
        return False

    _LOGGER.info(
        "Panel de la barra lateral reinscrito en Home Assistant "
        "(visible: %s, para todo el mundo y no solo administradores)", visible,
    )
    return True

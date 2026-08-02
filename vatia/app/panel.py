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
que pasen. Del otro lado, Core solo relee todos los paneles en su arranque.

Y hay un segundo detalle, que es el que echó abajo el primer intento de arreglo
(0.46.2): **volver a inscribir un panel que ya existe no lo actualiza, revienta**.
`async_register_built_in_panel` acepta un `update=True` para reemplazar, y el
componente `hassio` no lo pasa:

    if not update and panel.frontend_url_path in panels:
        raise ValueError(f"Overwriting panel {panel.frontend_url_path}")

O sea que pedir la reinscripción a secas, con el panel puesto, solo consigue un
500. Por eso el interruptor de la interfaz sí funciona: apagarlo **borra** el
panel y encenderlo lo crea de cero.

Así que eso es lo que se hace aquí, contra el propio Core y en dos pasos:

    DELETE /api/hassio_push/panel/<slug>    → Core lo quita
    POST   /api/hassio_push/panel/<slug>    → Core lo crea leyendo el panel_admin de ahora

Se va por el proxy del Supervisor (`http://supervisor/core/api/…`, que ya se usa
para todo lo demás y solo necesita `homeassistant_api: true`) y no por
`/addons/self/options`. La diferencia importa: `options` **persiste** el estado
del interruptor, así que un fallo entre los dos pasos dejaría a Vatia escondida
de verdad y para siempre. Estas dos llamadas solo tocan la memoria de Core: en
el peor caso el panel falta hasta el siguiente arranque, y la preferencia del
usuario no se toca nunca.

Cuidados:

  · si el interruptor está en «escondido», no se hace nada: quien lo apagó a
    propósito no quiere que se lo enciendan;
  · los dos pasos van juntos bajo `asyncio.shield`, para que apagar el add-on
    justo en medio no deje el panel borrado;
  · Core puede no estar listo cuando arranca el add-on, así que se reintenta un
    rato antes de rendirse;
  · si aun así no se puede, se anota qué hacer a mano y ya está. El panel es
    cosa de la barra lateral; la aplicación funciona igual.
"""

from __future__ import annotations

import asyncio
import logging
import os

import aiohttp

_LOGGER = logging.getLogger("vatia")

_SUPERVISOR = "http://supervisor"
_TIMEOUT = aiohttp.ClientTimeout(total=15)
# Core tarda en levantar, y el add-on puede arrancar antes. Las esperas suman
# poco más de un minuto, que es de sobra para un arranque normal y no tanto como
# para que una instalación sin Core se quede reintentando toda la tarde.
_ESPERAS = (2, 5, 10, 20, 30)

_A_MANO = (
    "Si Vatia no le aparece en la barra lateral a quien no es administrador, "
    "reinicia Home Assistant Core una vez (Ajustes → Sistema → Reiniciar), o "
    "apaga y enciende «Mostrar en la barra lateral» en la página del add-on."
)


async def _rehacer(sesion: aiohttp.ClientSession, slug: str) -> bool:
    """Borra el panel y lo vuelve a crear. Los dos pasos o ninguno."""
    url = f"{_SUPERVISOR}/core/api/hassio_push/panel/{slug}"
    async with sesion.delete(url) as resp:
        if resp.status not in (200, 201):
            # Lo normal aquí es que Core aún no conteste. No se ha borrado nada,
            # así que se puede reintentar sin dejar nada a medias.
            _LOGGER.debug("Core no acepta quitar el panel todavía (%s)", resp.status)
            return False
    async with sesion.post(url) as resp:
        if resp.status not in (200, 201):
            # Sin gritar aquí: se reintenta el par entero, y avisar en cada
            # vuelta llenaría el registro de seis copias del mismo susto. El
            # aviso, una vez, lo da quien se rinde.
            _LOGGER.debug("Core no ha vuelto a poner el panel (%s)", resp.status)
            return False
    return True


async def reinscribir() -> bool:
    """Rehace la inscripción del panel en Core. ``True`` si se consiguió.

    Silenciosa a propósito cuando no hay Supervisor: en desarrollo se arranca la
    app a mano y no hay panel ninguno que inscribir.
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
                        "No se pudo leer la info del add-on (%s); el panel se "
                        "queda como esté", resp.status,
                    )
                    return False
                datos = (await resp.json()).get("data") or {}

            if not datos.get("ingress_panel"):
                # O no hay ingress, o alguien escondió Vatia de la barra lateral
                # a propósito. En los dos casos no hay nada que rehacer.
                return False
            slug = datos.get("slug") or "vatia"

            for espera in (0, *_ESPERAS):
                if espera:
                    await asyncio.sleep(espera)
                # Los dos pasos, blindados: si el add-on se apaga justo en medio,
                # que al menos termine de poner el panel de vuelta.
                if await asyncio.shield(_rehacer(sesion, slug)):
                    _LOGGER.info(
                        "Panel de la barra lateral reinscrito en Home Assistant: "
                        "visible para todo el mundo, no solo administradores",
                    )
                    return True
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
        _LOGGER.warning("No se pudo refrescar el panel de la barra lateral (%s). %s",
                        err, _A_MANO)
        return False

    _LOGGER.warning(
        "Home Assistant no ha aceptado refrescar el panel de la barra lateral. "
        "Puede que Vatia no aparezca en ella hasta el próximo arranque. %s",
        _A_MANO,
    )
    return False

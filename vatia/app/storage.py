"""Persistencia de configuración y tarifas (JSON).

El fichero vive en la carpeta del add-on que el Supervisor expone en
``/addon_configs/<slug>/``, con una copia en ``/data`` como red de seguridad
para las copias de seguridad del add-on.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import tariffs as tariffs_mod

_LOGGER = logging.getLogger(__name__)

DATA_DIR = os.environ.get("DATA_DIR", "/data")
# La configuración vive en la carpeta del add-on (`map: addon_config`), que el
# Supervisor expone en `/addon_configs/<slug>/`: se ve desde Samba, el File
# Editor o Studio Code Server, así que se puede leer, editar y respaldar sin
# entrar por SSH. `/data` es almacenamiento interno y no está compartido, que es
# donde estaba antes y por lo que costaba tanto llegar a ella.
CONFIG_DIR = os.environ.get("CONFIG_DIR") or (
    "/config" if os.path.isdir("/config") else DATA_DIR
)
CONFIG_PATH = os.path.join(CONFIG_DIR, "vatia.json")
# Copia en `/data`: es lo que archiva el Supervisor al hacer una copia de
# seguridad del add-on, así que un restaurado que solo traiga `/data` no se
# queda sin configuración. Manda siempre la de `CONFIG_DIR`.
MIRROR_PATH = os.path.join(DATA_DIR, "vatia.json")
# Sitios de los que se adopta la configuración si aún no está en su sitio
# nuevo: la copia interna, y el fichero de cuando el add-on se llamaba
# «eBilling» (al cambiar el slug, Home Assistant le dio un /data vacío y hay que
# traerlo a mano; si aparece se adopta tal cual, sin editar nada dentro).
LEGACY_PATHS = (
    MIRROR_PATH,
    os.path.join(CONFIG_DIR, "ebilling.json"),
    os.path.join(DATA_DIR, "ebilling.json"),
)

_lock = threading.Lock()

# Ajustes cuyo valor es un diccionario: se combinan con los valores por
# defecto al cargar y se actualizan por claves (no se reemplazan enteros).
NESTED_SETTINGS = ("influx", "flow_sensors", "energy_sensors", "contracted_power",
                   "energy_counter_kinds")

# Ajustes que son de **quien mira**, no de la casa.
#
# Home Assistant dice quién es a través de Ingress (la cabecera
# `X-Remote-User-Id`), así que dos personas de la misma casa pueden tener la
# Home en distinto orden y ver el caudal con distinto componente sin pisarse.
# Todo lo demás —los sensores, las tarifas, InfluxDB— es de la instalación y
# sigue siendo uno para todos: son datos de la casa, no gustos de nadie.
#
# El valor de `DEFAULT_SETTINGS` hace de valor compartido: es lo que ve quien
# no ha tocado nada, y lo que hereda un usuario nuevo. Así una instalación que
# venía de antes no nota el cambio.
#
# Esta lista es además **la frontera de los permisos**: quien no es
# administrador puede escribir esto y nada más. La apariencia entró aquí por
# eso: el tema era de la casa, y dejar que lo tocara quien no administra —que es
# lo razonable, es su pantalla— se lo habría cambiado a todo el mundo. Así la
# regla cabe en una frase: **puedes escribir lo tuyo y nada más**.
#
# Y lo de siempre sobre de dónde sale la identidad: la cabecera solo llega por
# Ingress, donde la pone Home Assistant, pero la puede escribir cualquiera que
# alcance el puerto directamente. Los roles valen dentro de Ingress; el puerto
# sigue sin poder exponerse.
PREFS_USUARIO = ("home_order", "home_hidden", "flow_style",
                 "theme", "dynamic_background")

# Lo que se sabe de cada persona que ha entrado. No son gustos: es el registro
# de quién es quién, y por eso lo edita un administrador y no el propio
# interesado.
FICHA_USUARIO = ("role", "name", "first_seen", "last_seen")
CLAVES_USUARIO = PREFS_USUARIO + FICHA_USUARIO

# `admin` toca los ajustes de la casa; `viewer` solo mira y se configura lo
# suyo. No hay más: tres roles serían dos más de los que una casa necesita.
ROLES = ("admin", "viewer")
ROL_POR_DEFECTO = "viewer"

# Con qué rol se reconoce a quien entra por primera vez. Se elige en las
# opciones del add-on, en la pestaña de Configuración de Home Assistant, porque
# ahí solo llega un administrador de Home Assistant: es el único sitio desde el
# que se puede arrancar el sistema de permisos sin que sea el propio permiso lo
# que haga falta para llegar.
#
#   primero → el primero que entra es administrador y el resto, no. Lo normal.
#   admin   → todo el que entra es administrador (una casa de plena confianza,
#             o para repartir permisos deprisa y volver a «primero» después).
#   viewer  → nadie es administrador por entrar. Para cerrar la puerta cuando
#             ya están repartidos los permisos.
ARRANQUES = ("primero", "admin", "viewer")


def arranque() -> str:
    """El rol de bienvenida configurado en las opciones del add-on."""
    valor = (os.environ.get("VATIA_FIRST_USER_ROLE") or "").strip().lower()
    return valor if valor in ARRANQUES else "primero"


DEFAULT_SETTINGS: dict[str, Any] = {
    # De dónde salen los datos de **toda** la app: la Home, Energía, el flujo y
    # la facturación. Los sensores concretos se eligen en Ajustes → Sensores,
    # una sola vez y para todo (antes la facturación pedía los suyos aparte).
    "source": "demo",  # demo | homeassistant
    "ha_url": "",  # solo para uso fuera del supervisor
    "ha_token": "",
    "influx": {
        "version": 2,  # 1 | 2
        "url": "http://a0d7b954-influxdb:8086",
        "database": "homeassistant",  # v1: database · v2: bucket
        "org": "",
        "token": "",
        "username": "",
        "password": "",
        "measurement": "kWh",
    },
    "contracted_power": {"p1": 4.6, "p2": 4.6},
    "billing_day": 1,
    "timezone": "Europe/Madrid",
    "holidays": [
        "01-01",
        "01-06",
        "05-01",
        "08-15",
        "10-12",
        "11-01",
        "12-06",
        "12-08",
        "12-25",
    ],
    "export_sensors": True,
    "sensor_update_minutes": 5,
    # Sensores del diagrama de flujo (potencia instantánea, W/kW) y del
    # resumen de energía del día (kWh), usados por la pantalla Home.
    "flow_sensors": {
        "pv": "",
        "grid_import": "",
        "grid_export": "",
        "battery_charge": "",
        "battery_discharge": "",
        "home": "",
        "battery_soc": "",
    },
    "energy_sensors": {
        "pv_energy": "",
        "grid_import_energy": "",
        "grid_export_energy": "",
        "battery_charge_energy": "",
        "battery_discharge_energy": "",
        # Opcional: si no se define, el consumo de la casa se mide integrando
        # su sensor de potencia (flow_sensors.home).
        "home_energy": "",
    },
    # Qué miden los contadores de energía anteriores:
    #   auto     → se detecta comparando el estado con el incremento del día
    #   daily    → ya son del día en curso: se lee su estado tal cual
    #   lifetime → acumulados: se calcula el incremento desde la medianoche
    # Es el valor **por defecto** de los seis. Una instalación normal los tiene
    # mezclados —el de la red totalizado desde que se instaló, los de la batería
    # del día—, así que cada casilla puede llevar la contraria aquí abajo.
    "energy_counters": "auto",
    # La excepción de cada contador, por casilla. Lo que no esté aquí sigue al
    # ajuste general. Se guarda aparte y no dentro de `energy_sensors` porque
    # eso es «qué entidad», y esto es «qué mide».
    "energy_counter_kinds": {},
    # Capacidad de la batería en kWh. Sirve para poner en kilovatios el estado de
    # carga —que llega en porcentaje— y así poder decir cuánta batería se llevaría
    # un electrodoméstico. 0 = sin configurar: entonces no se puede separar lo que
    # saldría de la batería de lo que saldría de la red, y se dice así.
    "battery_kwh": 0.0,
    # Reserva del inversor, en % de carga: por debajo de ahí **no descarga**, y
    # esa energía figura en el contador pero no se puede usar. Sin esto, Vatia
    # contaba como disponible la batería entera y decía «Gratis» ofreciendo
    # kilovatios que el inversor no iba a entregar. 0 = sin reserva declarada.
    #
    # Si el inversor publica su mínimo en un sensor (un Sungrow lo hace, en
    # `sensor.battery_min_soc`), se asigna en Sensores → Batería y manda ese: así
    # sigue solo cuando se cambia en el inversor. Este número es el respaldo.
    "battery_reserve_pct": 0.0,
    # Meteorología del fondo de la Home: dos sensores independientes, uno con
    # la condición (texto) y otro con la temperatura exterior.
    "condition_sensor": "",
    "temperature_sensor": "",
    # Entidad `weather.*` para la tarjeta del tiempo hora a hora. Es otra cosa que
    # los dos sensores de arriba: aquellos dicen cómo está **ahora** y esta trae la
    # previsión horaria, que hay que pedir con el servicio `weather.get_forecasts`
    # porque desde 2024.4 ya no viene en los atributos. Vacío = sin tarjeta.
    "weather_entity": "",
    # Sensor de previsión de generación solar (Solcast, Forecast.Solar…). Se usa
    # para dibujar el forecast punteado en la pantalla de Energía cuando el
    # intervalo incluye tiempo futuro.
    "solar_forecast_sensor": "",
    # Apariencia: «auto» sigue al sistema (el modo oscuro del móvil o del
    # navegador), «light» y «dark» lo fuerzan.
    "theme": "auto",
    # Fondo de la Home según la hora y el tiempo. Quien prefiera una superficie
    # lisa —o tenga un móvil justo— lo puede apagar sin perder nada del dato.
    "dynamic_background": True,
    # Qué componente dibuja el flujo en tiempo real, de la galería de Ajustes.
    # No son tres estéticas del mismo dibujo: cada uno dice algo que los otros
    # no dicen, así que la elección es de fondo y no de gusto.
    #   sankey → <vatia-flow>, el diseño «Flujo de energía v2»: px por kW
    #   cruz   → <vatia-cross>, el clásico que tenía la app: nodos y cables
    #   orbita → <vatia-orbit>, la casa en el centro y las fuentes alrededor
    "flow_style": "sankey",
    # Las tarjetas de la pantalla de inicio, en el orden en que se pintan. Es
    # una preferencia de quien mira (ver `PREFS_USUARIO`), y esto es el orden
    # que ve quien no la ha tocado: el caudal primero, que es a lo que se
    # entra; el cierre del día cuando toca; la ventana con su consejo pegado
    # debajo —primero cuánto sobra, luego qué hacer con ello—; el tiempo hora a
    # hora, que es de dónde va a salir ese sol; y el resumen.
    # Las claves que no estén en la lista se pintan detrás, en este mismo
    # orden, para que una tarjeta nueva no desaparezca de las Homes ya
    # ordenadas a mano.
    "home_order": ["ahora", "cierre", "ventana", "plan", "tiempo", "resumen"],
    # Tarjetas que quien mira ha decidido no ver. Ocultar no es apagar: lo que
    # hay detrás se sigue calculando, porque otras pantallas lo usan.
    "home_hidden": [],
    # La tarifa contratada («la mía»): el id de una de las tarifas guardadas.
    # La comparativa sigue tratándolas a todas igual; esta solo añade lo que
    # ninguna comparación puede dar, el ahorro del día en euros.
    "my_tariff_id": "",
    # Intervalo de trabajo fijado por el usuario ({start,end} en YYYY-MM-DD,
    # fin inclusivo). Si está definido, es el periodo por defecto de todos los
    # cálculos (comparativa, detalle y sensores). null = ciclo automático.
    "working_period": None,
}

# Electrodomésticos medidos. Cada uno es un enchufe con nombre: su potencia dice
# lo que está haciendo ahora y su energía, lo que ha gastado hoy. Del histórico
# de la potencia se aprende cuánto dura y cuánto gasta un ciclo suyo, que es lo
# que permite contestar «¿me cabe en la ventana?» sin que nadie teclee un dato.
DEFAULT_APPLIANCES: list[dict[str, Any]] = []

# Glifos disponibles para un electrodoméstico (los del sprite) y color por
# defecto. Los cuatro primeros vienen dibujados del prototipo del diseño.
APPLIANCE_ICONS = ("lavadora", "lavavajillas", "horno", "coche", "potencia")
APPLIANCE_COLOR = "#0f7d8a"

# Tarifas de arranque: la de referencia extraída de una factura real de
# Iberdrola (2.0TD, marzo 2026), una plana con excedentes y una PVPC.
DEFAULT_TARIFFS: list[dict[str, Any]] = [
    {
        "id": "iberdrola-plan-estable",
        "name": "Plan Estable",
        "company": "Iberdrola",
        "color": "#00a443",
        "energy": {
            "type": "schedule",
            "preset": "td3",
            "periods": [
                {"name": "Punta", "price": 0.203912, "schedule": "L-V 10-14,18-22"},
                {"name": "Llano", "price": 0.161451, "schedule": "L-V 8-10,14-18,22-24"},
                {"name": "Valle", "price": 0.129779, "schedule": ""},
            ],
            "pvpc_margin": 0.0,
        },
        "surplus": {"type": "none", "price": 0.0, "periods": []},
        "power_prices": {"p1": 0.091074, "p2": 0.013483},
        "fixed_daily": [{"name": "Financiación bono social", "price": 0.019121}],
        "meter_rental_daily": 0.02663,
        "services_monthly": [{"name": "Asistente Smart", "price": 1.04}],
        "electricity_tax_pct": 0.5,
        "vat_energy_pct": 10.0,
        "vat_services_pct": 21.0,
    },
    {
        "id": "ejemplo-tarifa-plana",
        "name": "Tarifa plana + excedentes (ejemplo)",
        "company": "Competencia",
        "color": "#4a6cf7",
        "energy": {
            "type": "schedule",
            "preset": None,
            "periods": [{"name": "Único", "price": 0.149, "schedule": ""}],
            "pvpc_margin": 0.0,
        },
        "surplus": {"type": "flat", "price": 0.06, "periods": []},
        "power_prices": {"p1": 0.0838, "p2": 0.0838},
        "fixed_daily": [{"name": "Financiación bono social", "price": 0.019121}],
        "meter_rental_daily": 0.02663,
        "services_monthly": [],
        "electricity_tax_pct": 0.5,
        "vat_energy_pct": 10.0,
        "vat_services_pct": 21.0,
    },
    {
        "id": "ejemplo-pvpc",
        "name": "PVPC (regulada)",
        "company": "Mercado regulado",
        "color": "#f59f00",
        "energy": {
            "type": "pvpc",
            "preset": None,
            "periods": [],
            "pvpc_margin": 0.0,
        },
        "surplus": {"type": "none", "price": 0.0, "periods": []},
        "power_prices": {"p1": 0.083775, "p2": 0.013027},
        "fixed_daily": [{"name": "Financiación bono social", "price": 0.019121}],
        "meter_rental_daily": 0.02663,
        "services_monthly": [],
        "electricity_tax_pct": 0.5,
        "vat_energy_pct": 10.0,
        "vat_services_pct": 21.0,
    },
]


def _default_config() -> dict[str, Any]:
    return {
        "settings": json.loads(json.dumps(DEFAULT_SETTINGS)),
        "tariffs": json.loads(json.dumps(DEFAULT_TARIFFS)),
        "appliances": json.loads(json.dumps(DEFAULT_APPLIANCES)),
        # Preferencias por usuario de Home Assistant, indexadas por el id que
        # trae Ingress. Solo lleva las claves que alguien ha tocado: lo que no
        # está sale de `settings`, que hace de valor compartido.
        "users": {},
    }


def normalize_appliance(raw: dict[str, Any]) -> dict[str, Any]:
    """Un electrodoméstico con lo que hace falta y nada más.

    Tolerante a propósito con lo que falta —el fichero se puede editar a mano—
    pero no con el nombre: sin nombre no hay fila que enseñar. El umbral de
    reposo separa «en marcha» de «enchufado»: un lavavajillas apagado marca dos
    o tres vatios y sin umbral cada minuto del día contaría como ciclo.
    """
    nombre = str(raw.get("name") or "").strip()
    if not nombre:
        raise ValueError("Un electrodoméstico necesita un nombre.")
    icono = str(raw.get("icon") or "").strip()
    try:
        umbral = float(raw.get("standby_w", 15))
    except (TypeError, ValueError):
        umbral = 15.0
    return {
        "id": str(raw.get("id") or "").strip() or uuid.uuid4().hex[:12],
        "name": nombre[:40],
        "color": str(raw.get("color") or APPLIANCE_COLOR).strip() or APPLIANCE_COLOR,
        "icon": icono if icono in APPLIANCE_ICONS else APPLIANCE_ICONS[-1],
        "power_entity": str(raw.get("power_entity") or "").strip(),
        "energy_entity": str(raw.get("energy_entity") or "").strip(),
        "standby_w": max(0.0, min(umbral, 5000.0)),
    }


def _normalize_appliances(raw_list: Any) -> list[dict[str, Any]]:
    out = []
    for raw in raw_list if isinstance(raw_list, list) else []:
        if not isinstance(raw, dict):
            continue
        try:
            out.append(normalize_appliance(raw))
        except ValueError:
            _LOGGER.warning("Electrodoméstico sin nombre ignorado: %s", raw)
    return out


def _normalize_tariffs(raw_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for raw in raw_list:
        try:
            tariff = tariffs_mod.normalize_tariff(raw)
            tariff["id"] = raw.get("id") or uuid.uuid4().hex[:12]
            normalized.append(tariff)
        except tariffs_mod.TariffError:
            _LOGGER.warning("Tarifa inválida ignorada: %s", raw.get("name"), exc_info=True)
    return normalized


def _normalize_users(raw: Any) -> dict[str, dict[str, Any]]:
    """Las preferencias por usuario, con solo las claves que son de usuario.

    Se criba al leer y no al escribir: un fichero editado a mano —que se puede,
    vive en `/addon_configs/` para eso— no debe poder colar un ajuste de la
    casa dentro del cajón de una persona, donde nadie lo encontraría después.
    """
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for uid, prefs in raw.items():
        if not isinstance(prefs, dict):
            continue
        limpio = {k: v for k, v in prefs.items() if k in CLAVES_USUARIO}
        # Un rol que no existe es un rol que no vale. El fichero se puede editar
        # a mano y `role: "superadmin"` no puede acabar dando permisos por no
        # ser ninguno de los dos que hay.
        if limpio.get("role") not in ROLES:
            limpio.pop("role", None)
        if limpio:
            out[str(uid)] = limpio
    return out


def _read(path: str) -> dict[str, Any] | None:
    """Lee un JSON de configuración; ``None`` si no vale.

    El fichero está en una carpeta compartida y se puede editar a mano, así que
    un JSON roto es un caso previsible, no una anomalía. Se aparta con la
    extensión ``.invalido`` en lugar de sobreescribirlo —el trabajo de quien lo
    editó no se tira— y se sigue buscando en los demás sitios.
    """
    try:
        with open(path, encoding="utf-8") as fh:
            config = json.load(fh)
    except OSError:
        return None
    except ValueError:
        _LOGGER.warning("Configuración ilegible en %s: se aparta y se ignora", path)
        try:
            os.replace(path, path + ".invalido")
        except OSError:
            _LOGGER.warning("Tampoco se pudo apartar %s", path, exc_info=True)
        return None
    return config if isinstance(config, dict) else None


def load() -> dict[str, Any]:
    with _lock:
        return _cargar()


def _cargar() -> dict[str, Any]:
    """`load()` sin tomar el candado, para poder usarlo desde dentro.

    `_lock` es un `threading.Lock` y no es reentrante: llamar a `load()` desde
    una función que ya lo tiene cogido se queda ahí colgado para siempre.
    """
    if True:
        config = None
        for candidate in (CONFIG_PATH, *LEGACY_PATHS):
            config = _read(candidate)
            if config is not None:
                if candidate != CONFIG_PATH:
                    _LOGGER.info("Adoptando la configuración de %s", candidate)
                path = candidate
                break
        if config is None:
            config = _default_config()
            _write(config)
            return config
        # Completa claves nuevas que falten tras una actualización y migra
        # tarifas del formato antiguo al canónico.
        defaults = _default_config()
        settings = defaults["settings"]
        stored_settings = config.get("settings") or {}
        stored_nested = {
            key: dict(stored_settings.get(key) or {}) for key in NESTED_SETTINGS
        }
        settings.update(stored_settings)
        # Los diccionarios anidados se combinan con sus valores por defecto,
        # para que las claves nuevas aparezcan tras una actualización.
        for key in NESTED_SETTINGS:
            merged = dict(defaults["settings"][key])
            merged.update(stored_nested[key])
            settings[key] = merged
        _migrar_fuente(settings)
        merged_config = {
            "settings": settings,
            "tariffs": _normalize_tariffs(config.get("tariffs", defaults["tariffs"])),
            "appliances": _normalize_appliances(config.get("appliances", [])),
            "users": _normalize_users(config.get("users")),
        }
        if path != CONFIG_PATH:
            # Se ha adoptado de otro sitio: se guarda ya en el suyo para no
            # volver a leerla de ahí.
            _write(merged_config)
        return merged_config


def _migrar_fuente(settings: dict[str, Any]) -> None:
    """Una sola fuente y unos solos sensores, para toda la app.

    Hasta la 0.38 la facturación se configuraba por su cuenta: `ha_entity` y
    `ha_entity_export` si la fuente era Home Assistant, `influx.entity_id` y
    `entity_id_export` si era InfluxDB. Eran **los mismos dos contadores** que
    ya se piden en Ajustes → Sensores, así que ahora se leen de allí y estas
    cuatro claves solo sirven para heredar lo que el usuario ya tenía puesto.

    InfluxDB deja de ser una «fuente»: es el histórico largo del consumo, que
    es lo único para lo que hace falta (las estadísticas horarias de Home
    Assistant no se purgan nunca, así que la facturación no lo necesita).
    """
    energia = settings.get("energy_sensors") or {}
    influx = settings.get("influx") or {}
    heredables = (
        ("grid_import_energy", settings.get("ha_entity"), influx.get("entity_id")),
        ("grid_export_energy", settings.get("ha_entity_export"), influx.get("entity_id_export")),
    )
    for destino, de_ha, de_influx in heredables:
        if not (energia.get(destino) or "").strip():
            viejo = (de_ha or de_influx or "").strip()
            if viejo:
                energia[destino] = viejo
                _LOGGER.info("Sensor de facturación adoptado en Sensores: %s", viejo)
    settings["energy_sensors"] = energia
    if settings.get("source") == "influxdb":
        settings["source"] = "homeassistant"
    for clave in ("ha_entity", "ha_entity_export"):
        settings.pop(clave, None)
    for clave in ("entity_id", "entity_id_export"):
        influx.pop(clave, None)


def _write(config: dict[str, Any]) -> None:
    texto = json.dumps(config, ensure_ascii=False, indent=2)
    for destino in (CONFIG_PATH, MIRROR_PATH):
        try:
            os.makedirs(os.path.dirname(destino), exist_ok=True)
            tmp = destino + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(texto)
            os.replace(tmp, destino)   # atómico: nunca se lee a medias
        except OSError:
            # La copia de /data es una red de seguridad, no un requisito: si no
            # se puede escribir (permisos, disco), el fichero bueno ya está.
            if destino is CONFIG_PATH:
                raise
            _LOGGER.warning("No se pudo guardar la copia en %s", destino, exc_info=True)


def save(config: dict[str, Any]) -> None:
    with _lock:
        _write(config)


def settings_para(config: dict[str, Any], usuario: str) -> dict[str, Any]:
    """Los ajustes tal y como los ve `usuario`: los de la casa, con lo suyo encima.

    Devuelve una copia. Quien no haya tocado nada —o quien entre sin Ingress, y
    entonces `usuario` es la cadena vacía— ve exactamente los de la casa, que es
    lo que se veía antes de que esto existiera.
    """
    settings = dict(config["settings"])
    settings.update((config.get("users") or {}).get(usuario) or {})
    return settings


# Cada cuánto se refresca en disco la última visita. La Home pide `/api/live`
# cada veinte segundos: sin esto, «quién ha entrado» costaría una escritura del
# fichero de configuración cada veinte segundos y por persona.
_REFRESCO_VISITA_S = 300


def _hace_un_rato() -> str:
    return (datetime.now(timezone.utc)
            - timedelta(seconds=_REFRESCO_VISITA_S)).replace(microsecond=0).isoformat()


def hay_admin(config: dict[str, Any]) -> bool:
    return any(
        (ficha or {}).get("role") == "admin"
        for ficha in (config.get("users") or {}).values()
    )


def rol_de(config: dict[str, Any], usuario: str) -> str:
    """El rol de quien mira. Sin identificar, `viewer`.

    Quien entra por el puerto directamente —sin Ingress, y entonces `usuario` es
    la cadena vacía— no es nadie, así que no manda: si no, saltarse los permisos
    sería tan fácil como no mandar la cabecera.
    """
    if not usuario:
        return ROL_POR_DEFECTO
    ficha = (config.get("users") or {}).get(usuario) or {}
    return ficha.get("role") or ROL_POR_DEFECTO


def visto(usuario: str, nombre: str = "") -> dict[str, Any]:
    """Apunta que esta persona ha entrado y devuelve su ficha.

    Es donde se reparte el rol de bienvenida, una sola vez por persona: en
    cuanto tiene uno, no se vuelve a tocar aquí —cambiarlo es cosa de un
    administrador desde Ajustes—.

    **Nunca se puede quedar la casa sin administrador.** Si no hay ninguno, el
    siguiente que entre lo es, diga lo que diga el arranque configurado. Es la
    red de seguridad que hace imposible el bloqueo: sin ella, poner el arranque
    en «viewer» antes de nombrar a nadie dejaría la sección de usuarios
    inalcanzable para siempre, y con ella la única salida sería reinstalar.
    """
    if not usuario:
        return {"role": ROL_POR_DEFECTO}
    ahora = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    with _lock:
        config = _cargar()
        usuarios = config.setdefault("users", {})
        ficha = usuarios.setdefault(usuario, {})
        nuevo = "role" not in ficha
        # Se llama en cada petición para que el alta ocurra al primer contacto,
        # sea cual sea: si solo se hiciera en `/api/config`, quien empezara por
        # otra ruta se encontraría sin rol y sin manera de tenerlo. Pero
        # escribir el fichero en cada petición sería absurdo, así que solo se
        # guarda cuando hay algo nuevo que guardar.
        fresco = (ficha.get("last_seen") or "") > _hace_un_rato()
        if not nuevo and fresco and (not nombre or ficha.get("name") == nombre):
            ficha["last_seen"] = ahora
            return dict(ficha)
        if nuevo:
            ficha["first_seen"] = ahora
            modo = arranque()
            if modo == "admin" or not hay_admin(config):
                ficha["role"] = "admin"
            elif modo == "primero":
                # «El primero» ya se ha cumplido: había admin, así que este no.
                ficha["role"] = "viewer"
            else:
                ficha["role"] = "viewer"
        # El nombre se refresca: en Home Assistant se puede cambiar, y la lista
        # de Ajustes tiene que enseñar el de ahora y no el del primer día.
        if nombre:
            ficha["name"] = nombre
        ficha["last_seen"] = ahora
        _write(config)
        if nuevo:
            _LOGGER.info(
                "Nuevo usuario en Vatia: %s (%s) entra como «%s»",
                nombre or "sin nombre", usuario[:8], ficha["role"],
            )
        return dict(ficha)


def lista_usuarios(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Quién ha entrado, el que más recientemente primero."""
    filas = [
        {"id": uid, "name": (ficha.get("name") or "").strip(),
         "role": ficha.get("role") or ROL_POR_DEFECTO,
         "first_seen": ficha.get("first_seen"), "last_seen": ficha.get("last_seen")}
        for uid, ficha in (config.get("users") or {}).items()
        # Quien solo tiene preferencias guardadas y ninguna visita apuntada
        # viene de antes de que esto existiera: se enseña igual, que también
        # es alguien que ha entrado.
        if ficha
    ]
    filas.sort(key=lambda f: (f["last_seen"] or "", f["name"]), reverse=True)
    return filas


class UltimoAdmin(Exception):
    """Se ha intentado dejar la casa sin ningún administrador."""


def poner_rol(usuario: str, rol: str) -> dict[str, Any]:
    """Cambia el rol de alguien. No deja quitar el último administrador."""
    if rol not in ROLES:
        raise ValueError(f"Rol desconocido: {rol}")
    with _lock:
        config = _cargar()
        usuarios = config.setdefault("users", {})
        ficha = usuarios.setdefault(usuario, {})
        if ficha.get("role") == "admin" and rol != "admin":
            otros = [
                uid for uid, f in usuarios.items()
                if uid != usuario and (f or {}).get("role") == "admin"
            ]
            if not otros:
                raise UltimoAdmin(
                    "No se puede quitar el último administrador: alguien tiene "
                    "que poder entrar aquí. Nombra antes a otro."
                )
        ficha["role"] = rol
        _write(config)
        return dict(ficha)


def olvidar_usuario(usuario: str) -> bool:
    """Borra a alguien del registro. Vuelve a entrar como nuevo si aparece.

    Con la misma protección: el último administrador no se borra, que sería
    quedarse fuera por otra puerta.
    """
    with _lock:
        config = _cargar()
        usuarios = config.get("users") or {}
        if usuario not in usuarios:
            return False
        if (usuarios[usuario] or {}).get("role") == "admin" and not any(
            uid != usuario and (f or {}).get("role") == "admin"
            for uid, f in usuarios.items()
        ):
            raise UltimoAdmin(
                "No se puede borrar el último administrador: nombra antes a otro."
            )
        del usuarios[usuario]
        _write(config)
        return True


def update_settings(patch: dict[str, Any], usuario: str | None = "") -> dict[str, Any]:
    """Guarda el parche y devuelve los ajustes como los ve `usuario`.

    El parche se parte en dos: lo que es de quien mira va a su cajón y lo demás
    a los ajustes de la casa. Así el frontend guarda igual que siempre, sin
    saber de quién es cada clave, y no hay dos maneras de guardar un ajuste.

    ``usuario=None`` lo manda todo a los ajustes de la casa, sin partir. Es lo
    que necesita restaurar una copia de seguridad: lo que trae el fichero son
    los valores compartidos, y meterlos en el cajón de nadie los dejaría fuera
    del alcance de quien sí entra identificado.
    """
    config = load()
    settings = config["settings"]
    prefs = (
        {} if usuario is None
        else config.setdefault("users", {}).setdefault(usuario, {})
    )
    for key, value in patch.items():
        if usuario is not None and key in PREFS_USUARIO:
            prefs[key] = value
        elif key in NESTED_SETTINGS and isinstance(value, dict):
            settings.setdefault(key, {}).update(value)
        else:
            settings[key] = value
    if usuario is not None and not prefs:
        # Sin nada dentro no se deja el cajón vacío: ensucia el fichero y
        # confunde a quien lo abre a mano.
        config["users"].pop(usuario, None)
    save(config)
    return settings_para(config, usuario or "")


def add_tariff(tariff: dict[str, Any]) -> dict[str, Any]:
    tariff = tariffs_mod.normalize_tariff(tariff)
    config = load()
    tariff["id"] = tariff.get("id") or uuid.uuid4().hex[:12]
    config["tariffs"].append(tariff)
    save(config)
    return tariff


def update_tariff(tariff_id: str, tariff: dict[str, Any]) -> dict[str, Any] | None:
    tariff = tariffs_mod.normalize_tariff(tariff)
    config = load()
    for idx, existing in enumerate(config["tariffs"]):
        if existing.get("id") == tariff_id:
            tariff["id"] = tariff_id
            config["tariffs"][idx] = tariff
            save(config)
            return tariff
    return None


def delete_tariff(tariff_id: str) -> bool:
    config = load()
    before = len(config["tariffs"])
    config["tariffs"] = [t for t in config["tariffs"] if t.get("id") != tariff_id]
    if len(config["tariffs"]) != before:
        save(config)
        return True
    return False


def add_appliance(raw: dict[str, Any]) -> dict[str, Any]:
    aparato = normalize_appliance(raw)
    config = load()
    config["appliances"].append(aparato)
    save(config)
    return aparato


def update_appliance(appliance_id: str, raw: dict[str, Any]) -> dict[str, Any] | None:
    aparato = normalize_appliance(raw)
    config = load()
    for idx, existing in enumerate(config["appliances"]):
        if existing.get("id") == appliance_id:
            aparato["id"] = appliance_id
            config["appliances"][idx] = aparato
            save(config)
            return aparato
    return None


def delete_appliance(appliance_id: str) -> bool:
    config = load()
    before = len(config["appliances"])
    config["appliances"] = [a for a in config["appliances"] if a.get("id") != appliance_id]
    if len(config["appliances"]) != before:
        save(config)
        return True
    return False

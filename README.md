# eBilling — Add-on de Home Assistant

Simulación **en tiempo real** de tu factura de la luz a partir de tus datos de
consumo, con **comparativa de tarifas en paralelo** (distintas compañías) y el
desglose completo de una factura española: término de potencia, energía por
periodos 2.0TD (punta/llano/valle), financiación del bono social, impuesto
especial sobre la electricidad, alquiler de contador, servicios adicionales e
IVA por grupos.

![Peaje 2.0TD](https://img.shields.io/badge/peaje-2.0TD-blue)
![Arquitecturas](https://img.shields.io/badge/arch-amd64%20%7C%20aarch64%20%7C%20armv7-lightgrey)

## Instalación

Pulsa este botón para añadir el repositorio a tu tienda de complementos:

[![Añadir repositorio de add-ons a mi Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fasneya%2FHA-ebilling-addon)

Y este otro para abrir directamente la página del add-on e instalarlo:

[![Abrir el add-on eBilling en mi Home Assistant](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=6c61fa46_ebilling&repository_url=https%3A%2F%2Fgithub.com%2Fasneya%2FHA-ebilling-addon)

Después pulsa **Instalar**, arranca el add-on y abre la interfaz desde la
barra lateral (**eBilling**) — funciona vía Ingress, sin abrir puertos.

<details>
<summary>Instalación manual (sin botones)</summary>

1. En Home Assistant ve a **Ajustes → Complementos → Tienda de complementos**.
2. Menú ⋮ → **Repositorios** y añade:

   ```
   https://github.com/asneya/HA-ebilling-addon
   ```

3. Instala el add-on **eBilling** y arráncalo.

</details>

> **Nota sobre HACS**: HACS distribuye integraciones personalizadas, tarjetas
> Lovelace y temas, pero **no add-ons**. Los add-ons se instalan siempre desde
> la tienda de complementos del Supervisor; los botones de arriba automatizan
> ese proceso en un clic (requiere Home Assistant OS o Supervised).

## Características

- **Fuentes de datos**: estadísticas de energía de Home Assistant (websocket,
  el mismo dato del panel de Energía), InfluxDB 1.x/2.x, o modo demo con datos
  sintéticos para probar la interfaz.
- **Tarifas con cualquier estructura**: 1 a 6 tramos con horario libre por día
  y hora, precio único, tarifa indexada **PVPC** (precios horarios de ESIOS) y
  **compensación de excedentes** (plana o por tramos) para autoconsumo solar.
- **Tarifas en paralelo**: crea todas las que quieras y compáralas sobre tu
  consumo real. La más barata se marca automáticamente y el resto muestran el
  sobrecoste.
- **Importación/exportación CSV** de tarifas, con plantilla de ejemplo
  descargable desde la interfaz.
- **Factura detallada**: cada tarifa genera una factura simulada línea a
  línea, con la misma estructura que la factura real de tu comercializadora.
- **Sensores en Home Assistant**: precio actual €/kWh, coste del ciclo,
  proyección y mejor tarifa, para automatizaciones y paneles.
- **Proyección fin de ciclo**: además del acumulado, estima el total de la
  factura al cierre del ciclo.
- **Ciclo de facturación configurable**: día de inicio, zona horaria y
  festivos nacionales.
- Interfaz moderna, responsive y con modo oscuro automático.

## Actualizaciones

Home Assistant detecta automáticamente las nuevas versiones comparando la
versión publicada en este repositorio con la instalada. Cuando publiques o
recibas una versión superior, aparecerá el aviso de actualización en el
add-on (puedes forzar la comprobación con **⋮ → Buscar actualizaciones** en la
tienda de complementos). El detalle de cada versión está en
[`ebilling/CHANGELOG.md`](ebilling/CHANGELOG.md) y HA lo muestra en el diálogo
de actualización.

## Sensores expuestos

Con los sensores activados (Ajustes), por cada tarifa se publican
`sensor.ebilling_<tarifa>_precio`, `_precio_excedente`, `_coste_ciclo` y
`_proyeccion`, más los globales `sensor.ebilling_mejor_tarifa` y
`sensor.ebilling_ahorro_potencial`. Ver [`ebilling/DOCS.md`](ebilling/DOCS.md).

## Tarjeta Lovelace

En [`lovelace/`](lovelace/) tienes una tarjeta personalizada
`custom:ebilling-card` que muestra la comparativa de tarifas en tu panel
(mejor tarifa, ahorro, coste y proyección por tarifa, precio actual y
excedentes), con tema claro/oscuro y conmutador acumulado/fin de ciclo.
Instrucciones de instalación en [`lovelace/README.md`](lovelace/README.md).

## Estructura del repositorio

```
repository.yaml        Metadatos del repositorio de add-ons
ebilling/              El add-on
  config.yaml          Configuración del add-on (version, ingress, permisos)
  CHANGELOG.md         Historial de versiones (mostrado por HA al actualizar)
  Dockerfile           Imagen (Python 3.12 sobre base Alpine de HA)
  app/                 Backend FastAPI + frontend estático
    billing.py         Motor de facturación (tramos, PVPC, excedentes, IVA)
    tariffs.py         Modelo de tarifas, horarios y CSV
    pvpc.py            Descarga y caché de precios PVPC (ESIOS)
    datasources.py     Conectores HA / InfluxDB / demo
    sensors.py         Publicación de sensores en Home Assistant
    storage.py         Persistencia de tarifas y ajustes en /data
    main.py            API REST
    static/            Interfaz web
```

## Desarrollo local

```bash
cd ebilling/app
pip install -r requirements.txt
DATA_DIR=/tmp/ebilling-data python3 -m uvicorn main:app --port 8099
# abre http://localhost:8099 (arranca en modo demo)
```

Para conectar con un Home Assistant externo en desarrollo, configura la URL y
un token de larga duración en **Ajustes → Fuente de datos**.

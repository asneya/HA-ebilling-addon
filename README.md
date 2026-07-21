# eBilling — Add-on de Home Assistant

Simulación **en tiempo real** de tu factura de la luz a partir de tus datos de
consumo, con **comparativa de tarifas en paralelo** (distintas compañías) y el
desglose completo de una factura española: término de potencia, energía por
periodos 2.0TD (punta/llano/valle), financiación del bono social, impuesto
especial sobre la electricidad, alquiler de contador, servicios adicionales e
IVA por grupos.

![Peaje 2.0TD](https://img.shields.io/badge/peaje-2.0TD-blue)

## Instalación

1. En Home Assistant ve a **Ajustes → Complementos → Tienda de complementos**.
2. Menú ⋮ → **Repositorios** y añade:

   ```
   https://github.com/asneya/HA-ebilling-addon
   ```

3. Instala el add-on **eBilling** y arráncalo.
4. Abre la interfaz desde la barra lateral (**eBilling**) — funciona vía
   Ingress, sin abrir puertos.

## Características

- **Fuentes de datos**: estadísticas de energía de Home Assistant (websocket,
  el mismo dato del panel de Energía), InfluxDB 1.x/2.x, o modo demo con datos
  sintéticos para probar la interfaz.
- **Tarifas en paralelo**: crea todas las tarifas que quieras (precios de
  potencia y energía por periodo, cargos, servicios, impuestos) y compáralas
  sobre tu consumo real. La más barata se marca automáticamente y el resto
  muestran el sobrecoste.
- **Factura detallada**: cada tarifa genera una factura simulada línea a
  línea, con la misma estructura que la factura real de tu comercializadora.
- **Proyección fin de ciclo**: además del acumulado, estima el total de la
  factura al cierre del ciclo.
- **Ciclo de facturación configurable**: día de inicio, zona horaria y
  festivos nacionales (valle todo el día en 2.0TD).
- Interfaz moderna, responsive y con modo oscuro automático.

## Estructura del repositorio

```
repository.yaml        Metadatos del repositorio de add-ons
ebilling/              El add-on
  config.yaml          Configuración del add-on (ingress, puertos, permisos)
  Dockerfile           Imagen (Python 3.12 sobre base Alpine de HA)
  app/                 Backend FastAPI + frontend estático
    billing.py         Motor de facturación (2.0TD, impuestos, IVA)
    datasources.py     Conectores HA / InfluxDB / demo
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

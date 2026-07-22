# eBilling — Documentación

## Primeros pasos

Al arrancar, el add-on funciona en **modo demo** con datos sintéticos para que
puedas explorar la interfaz. Para usar tu consumo real:

1. Abre **eBilling** en la barra lateral.
2. Ve a **Ajustes → Fuente de datos** y elige *Home Assistant*.
3. Pulsa **Buscar sensores** y selecciona tu sensor de energía acumulada
   (kWh, normalmente el mismo que usas en el panel de Energía).
4. Ajusta la potencia contratada (P1/P2), el día de inicio de tu ciclo de
   facturación (aparece en tu factura) y guarda.

## Fuentes de datos

### Home Assistant (recomendada)

Usa las **estadísticas de largo plazo** del recorder vía websocket
(`recorder/statistics_during_period`, periodo horario, campo `change`), por lo
que obtiene exactamente los mismos datos que el panel de Energía y no depende
del tiempo de retención del historial.

Requisitos del sensor: unidad kWh (o Wh/MWh) y `state_class`
`total_increasing` (contador acumulado).

### InfluxDB

Compatible con InfluxDB **1.x** (InfluxQL) y **2.x** (Flux). El add-on
consulta el último valor acumulado de cada hora y calcula los deltas de
consumo (los reinicios de contador se tratan como 0). Parámetros:

| Campo | 1.x | 2.x |
|---|---|---|
| URL | ✓ | ✓ |
| Base de datos / bucket | database | bucket |
| Measurement | p. ej. `kWh` | p. ej. `kWh` |
| entity_id consumo | tag | tag |
| entity_id excedentes | tag (opcional) | tag (opcional) |
| Credenciales | usuario/contraseña | org + token |

### Excedentes (autoconsumo solar)

Si tienes placas y alguna tarifa compensa excedentes, configura un segundo
sensor con la **energía vertida** a la red (kWh acumulados). En Home Assistant
se selecciona en Ajustes; en InfluxDB es el campo *entity_id excedentes*.

## Tarifas

Cada tarifa define un **término de energía**, opcionalmente una
**compensación de excedentes**, y los conceptos comunes de la factura.

### Estructura del término de energía

Puedes elegir entre tres estructuras por tarifa:

1. **3 tramos 2.0TD estándar** (punta/llano/valle): el editor rellena los
   horarios oficiales automáticamente; solo introduces los tres precios.
2. **Tramos personalizados (1 a 6)**: cada tramo tiene nombre, precio (€/kWh)
   y un horario libre. Sirve para tarifas de 1, 2 o 3 tramos con horarios
   propios, tarifas nocturnas, etc. Para un **precio único** crea un solo
   tramo y deja el horario vacío.
3. **PVPC (precio horario indexado)**: los precios se descargan de ESIOS
   (REE) hora a hora y se cachean localmente. Puedes añadir un **margen** en
   €/kWh (p. ej. el que aplica tu comercializadora sobre el PVPC).

### Sintaxis de horarios

Un horario es una o varias reglas separadas por `|`. Cada regla es
`DÍAS HORAS`:

- **Días**: `L M X J V S D` (lunes a domingo) y `F` (festivo). Admite sueltos
  y rangos: `L-V`, `S-D`, `L,X,V`.
- **Horas**: rangos `inicio-fin` (fin **exclusivo**) separados por comas:
  `10-14,18-22`.

Ejemplos:

| Horario | Significado |
|---|---|
| `L-V 10-14,18-22` | Laborables de 10 a 14 y de 18 a 22 |
| `L-D 8-22 \| F 8-22` | Todos los días (incluidos festivos) de 8 a 22 |
| *(vacío)* | Tramo comodín: todas las horas no cubiertas por otros tramos |

El tramo sin horario actúa como comodín (el «valle» que recoge el resto). Si
ninguna regla usa `F`, los festivos se tratan como domingo.

### Compensación de excedentes

- **Plana**: un único precio €/kWh para toda la energía vertida.
- **Por tramos**: mismo sistema de horarios que la energía.

El abono se limita al importe del término de energía del periodo
(compensación simplificada, según normativa).

### Conceptos comunes

- **Término de potencia** (€/kW·día) para P1 (punta) y P2 (valle).
- **Financiación del bono social** (€/día).
- **Alquiler de contador** (€/día).
- **Servicios adicionales** (€/mes), p. ej. mantenimiento.
- **Impuesto especial sobre la electricidad** (%). La base es potencia +
  energía (tras excedentes) + cargos, igual que en la factura real.
- **IVA de energía** (aplicado a potencia + energía + cargos + impuesto
  eléctrico + alquiler de contador) e **IVA de servicios**, por si tienen
  tipos distintos (p. ej. 10% reducido y 21% general).

El add-on incluye de serie una tarifa real de referencia (Iberdrola Plan
Estable, 2.0TD), una tarifa plana con excedentes y una PVPC; edítalas o
elimínalas.

### Importar y exportar (CSV)

Desde la pestaña **Tarifas**:

- **Plantilla CSV**: descarga un CSV comentado con todos los campos.
- **Importar CSV**: abre un diálogo donde puedes **pegar** el contenido del
  CSV en un cuadro de texto o **cargar un archivo** (que se vuelca al cuadro
  para revisarlo antes de importar). Separador `;` o `,`, decimales con `.`
  o `,`.
- **CSV** (en cada tarifa): exporta esa tarifa para editarla o compartirla.

## Discriminación horaria 2.0TD

El calendario 2.0TD (usado en las tarjetas de resumen del panel y en el
preset de 3 tramos) es:

- Sábados, domingos y festivos nacionales: **valle** todo el día.
- Laborables: 00–08 valle · 08–10 llano · 10–14 **punta** · 14–18 llano ·
  18–22 **punta** · 22–24 llano.

Los festivos son configurables en Ajustes (formato `MM-DD`).

## Sensores en Home Assistant

Si activas **Publicar sensores** en Ajustes, el add-on crea y actualiza
(vía la API de estados de HA) estas entidades:

| Entidad | Descripción |
|---|---|
| `sensor.ebilling_<tarifa>_precio` | Precio del término de energía **ahora** (€/kWh) |
| `sensor.ebilling_<tarifa>_precio_excedente` | Precio de compensación ahora (si aplica) |
| `sensor.ebilling_<tarifa>_coste_ciclo` | Coste acumulado del ciclo actual (€) |
| `sensor.ebilling_<tarifa>_proyeccion` | Coste estimado a fin de ciclo (€) |
| `sensor.ebilling_mejor_tarifa` | Nombre de la tarifa más barata |
| `sensor.ebilling_ahorro_potencial` | Diferencia € entre la más cara y la más barata |

`<tarifa>` es el nombre de la tarifa en minúsculas y sin espacios. El
intervalo de actualización es configurable (por defecto 5 minutos). Con estos
sensores puedes crear automatizaciones (p. ej. avisar cuando el precio PVPC
esté por debajo de un umbral) o tarjetas en tu panel.

## Detalle (drill-down)

La pestaña **Detalle** muestra el desglose del consumo del ciclo:

- **Totales de energía importada y exportada** del periodo, pensados para
  comparar directamente con tus sensores de Home Assistant.
- **Gráfico diario** con la energía importada apilada por periodo 2.0TD
  (punta/llano/valle) y la exportada en una barra aparte.
- **Drill-down por horas**: pulsa un día para ver el desglose de sus 24 horas
  (gráfico + tabla con importada, exportada y periodo de cada hora).

Es también útil para diagnosticar diferencias: si un total no cuadra, el
detalle por día/hora deja ver exactamente dónde.

## Simulación

- **Acumulado**: coste desde el inicio del ciclo hasta ahora.
- **Proyección fin de ciclo**: extrapola el consumo por periodo al ciclo
  completo y aplica los términos fijos sobre todos los días del ciclo.
- Puedes navegar a ciclos anteriores con las flechas ‹ › y la vista se
  actualiza sola cada 5 minutos.

## Opciones del add-on

| Opción | Descripción |
|---|---|
| `log_level` | `debug`, `info`, `warning` o `error` |

Toda la configuración funcional (fuente, tarifas, contrato) se gestiona desde
la propia interfaz y se guarda en `/data/ebilling.json`.

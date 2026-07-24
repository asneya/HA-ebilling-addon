# Changelog

Todas las versiones relevantes del add-on eBilling.

## 0.11.0

### Cambios

- **Rediseño de la tarjeta `ebilling-power-flow`** con disposición en **cruz**
  (Solar arriba, Red izquierda, Casa derecha, Batería abajo), más cercana a las
  apps de inversores:
  - Iconos y valores **centrados y alineados** dentro de cada círculo (se
    corrigió el descuadre de iconos y textos).
  - Círculos más grandes; el de la **Casa** lleva el anillo multicolor del
    reparto diario como borde, con el total (kWh) y la potencia debajo.
  - Red con **← / →** y Batería con **↓ / ↑**, coloreando el sentido «hacia la
    casa».
  - Líneas curvas en las esquinas y rectas en la cruz, con una bola por línea.

## 0.10.0

### Nuevo

- Tarjeta `ebilling-power-flow`:
  - En el círculo de la **casa** se muestra el **total consumido hoy** (kWh) y,
    debajo, la potencia instantánea.
  - **Tooltip al pulsar** cada sección del anillo (fuente · kWh · %).
  - En **red** y **batería**, dos valores con flecha: **← feed-in**
    (exportar / cargar) y **→ hacia la casa** (importar / descargar). Usan los
    totales de energía diaria si están configurados; si no, la potencia actual.

## 0.9.0

### Nuevo

- **Releases automáticas**: cada cambio de versión publica una release en
  GitHub (workflow de Actions), para que HACS ofrezca la actualización de la
  tarjeta Lovelace automáticamente (antes había que redescargarla a mano).

### Corregido

- En el editor de la tarjeta `ebilling-power-flow`, el sensor de **estado de
  carga de batería (%)** no aparecía en su desplegable porque se filtraba por
  unidades de potencia (W/kW). Ahora ese campo se filtra por porcentaje (`%` /
  `device_class: battery`).

## 0.8.1

### Nuevo

- La tarjeta `ebilling-power-flow` permite configurar **sensores de energía
  diaria** (kWh) por fuente (producción solar, importada/exportada de red,
  carga/descarga de batería). Cuando se definen, el **anillo de la casa** se
  pinta con esos totales reales del día; si no, se mantiene el cálculo
  aproximado en el navegador. El editor visual incluye ahora ese grupo de
  sensores.

## 0.8.0

### Cambios

- **Tarjeta `ebilling-power-flow` rediseñada** con nueva disposición (solar
  arriba, casa en el centro, batería abajo-izquierda, red abajo-derecha):
  - **Una sola bola** viajando por cada línea activa (antes eran varios
    puntos), con velocidad proporcional a la potencia y etiqueta del valor.
  - **Colores configurables** por elemento (selector de color en el editor
    visual o clave `colors` en YAML).
  - **Anillo en la casa** (donut) que muestra cuánta energía ha consumido la
    casa hoy de cada fuente —solar, red, batería—, con su color. Se acumula en
    el navegador mientras la tarjeta está visible (orientativo, se reinicia a
    diario).

## 0.7.1

### Cambios

- El **intervalo de trabajo** ahora **se guarda** y pasa a ser el periodo por
  defecto de todos los cálculos (comparativa, detalle y sensores): la app
  trabaja siempre sobre el último intervalo indicado y sobrevive a recargas y
  reinicios. La vista se **refresca automáticamente cada minuto** (antes 5) y
  el refresco alcanza también a la pestaña Detalle cuando está abierta.

## 0.7.0

### Nuevo

- **Periodo de facturación personalizado (escenario)**: botón «📅 Periodo» en
  Simulación y Detalle para fijar un inicio y un fin cualesquiera y recalcular
  al instante la comparativa y el detalle sobre ese rango. «Volver al ciclo»
  restaura el ciclo automático.

### Cambios

- **Tarjeta `ebilling-power-flow` rediseñada**: iconos vectoriales (sol, red,
  batería, casa), líneas curvas que convergen en la casa sin cruzarse, puntos
  de energía animados con brillo y velocidad proporcional a la potencia. Ahora
  se actualiza en tiempo real con cada cambio de los sensores (se eliminó el
  filtrado que suprimía cambios pequeños).

## 0.6.0

### Nuevo

- **Monedero / batería virtual** en el comparador de tarifas: el valor de los
  excedentes que supera el tope legal de compensación (la energía consumida de
  la red) se computa **aparte** como saldo acumulable, en lugar de perderse.
  Se activa por tarifa (en Compensación de excedentes) y aparece como `+X €`
  en la tarjeta y en la factura detallada, sin alterar el total del ciclo. En
  las tarifas sin monedero, ese importe se muestra como *excedente no
  compensado* (informativo). Soportado también en importación/exportación CSV
  (`monedero_virtual: si/no`) y, si publicas sensores, en
  `sensor.ebilling_<tarifa>_monedero`.

## 0.5.0

### Nuevo

- **Nueva tarjeta Lovelace `custom:ebilling-power-flow`** (en
  `dist/ebilling-power-flow.js`): diagrama **animado** del flujo de potencia
  instantánea entre **solar, red, batería y casa**, con el sentido de cada
  flujo y editor visual para asignar los sensores (producción PV, importación
  y exportación de red, carga y descarga de batería, consumo de la casa y,
  opcional, el % de batería). No depende del add-on; usa tus sensores de
  potencia. Requiere añadir su recurso Lovelace aparte (ver `lovelace/README.md`).

## 0.4.3

### Nuevo

- En la pestaña **Detalle**, gráficos de **evolución acumulada** (totalizada)
  de la energía importada y exportada: uno a lo largo del ciclo (por días) y
  otro a lo largo del día seleccionado (por horas). Reproduce la curva
  creciente del sensor, útil para comparar de un vistazo con su historial en
  Home Assistant.

## 0.4.2

### Nuevo

- **Pestaña «Detalle»** con desglose y drill-down: totales de energía
  importada y exportada del ciclo (para comparar con tus sensores de HA),
  gráfico de consumo diario por periodo 2.0TD con la exportada aparte, y al
  pulsar un día, el desglose de sus 24 horas (gráfico + tabla). Sirve también
  para localizar dónde difiere un total respecto a Home Assistant.

## 0.4.1

### Corregido

- **Consumo de HA no cuadraba con el sensor**: las estadísticas horarias van
  por detrás del estado en vivo (la hora en curso no está consolidada). Ahora
  el add-on añade esa «cola» leyendo el estado actual del sensor, de modo que
  el total del ciclo coincide con lo que muestra Home Assistant. Solo se
  aplica al ciclo actual, no al consultar ciclos pasados.
- **Unidades**: se lee la unidad real de la estadística y se convierte a kWh
  (sensores en Wh/MWh daban totales erróneos).
- **La tarjeta mostraba tarifas ya borradas**: los sensores de tarifas
  eliminadas quedaban huérfanos en Home Assistant. Ahora el add-on los elimina
  automáticamente en cada actualización de sensores.

### Otros

- Corregido el enlace de instalación por HACS del README (categoría `plugin`).

## 0.4.0

### Nuevo

- **Importar tarifa pegando un CSV**: el botón «Importar CSV» abre un diálogo
  donde puedes pegar directamente el contenido del CSV en un cuadro de texto,
  además de cargar un archivo (que se vuelca al cuadro para revisarlo antes de
  importar). Ambas vías usan el mismo importador y muestran errores claros.

## 0.3.0

### Nuevo

- **Tarjeta Lovelace** `custom:ebilling-card` (servida en `dist/`,
  **instalable por HACS** como plugin de panel): comparativa visual de
  tarifas con mejor tarifa, ahorro potencial, coste acumulado y proyección,
  precio actual y excedentes. Descubre los sensores automáticamente, respeta
  el tema claro/oscuro y usa el color de cada tarifa. Incluye conmutador
  acumulado/fin de ciclo.
- Los sensores de tarifa incluyen ahora el atributo `color`, para que la
  tarjeta (y otras integraciones) usen el color de cada tarifa.

## 0.2.0

### Nuevo

- **Estructuras de tarifa flexibles**: cada tarifa puede tener de 1 a 6 tramos
  de energía con horario libre por día de la semana, hora y festivos
  (sintaxis tipo `L-V 10-14,18-22`). Incluye editor visual de tramos.
- **PVPC**: tarifa indexada con precios horarios descargados de ESIOS (REE),
  cacheados en disco, con margen configurable en €/kWh.
- **Compensación de excedentes** (autoconsumo solar): plana (€/kWh) o por
  tramos horarios, con el tope legal (el abono no supera el término de
  energía).
- **Importación y exportación CSV** de tarifas, con plantilla de ejemplo
  descargable desde la interfaz. Compatible con separador `;` y decimales
  en formato español.
- **Sensores en Home Assistant** por tarifa (precio actual €/kWh, precio de
  excedentes, coste del ciclo y proyección) más sensores globales de mejor
  tarifa y ahorro potencial. Intervalo de actualización configurable.
- Segundo sensor de energía para leer los excedentes vertidos (HA e InfluxDB).

### Cambios

- El motor de facturación se ha reescrito para soportar tramos arbitrarios y
  precios horarios, manteniendo el desglose completo (potencia, energía,
  cargos, impuesto eléctrico, alquiler de contador, servicios e IVA por
  grupos).
- Migración automática de las tarifas del formato 0.1.0 al nuevo formato.

## 0.1.0

### Nuevo

- Primera versión: simulación en tiempo real de la factura eléctrica 2.0TD.
- Fuentes de datos: Home Assistant (estadísticas de energía), InfluxDB
  1.x/2.x y modo demo.
- Comparativa de tarifas en paralelo con la más barata destacada y factura
  detallada línea a línea.
- Proyección a fin de ciclo, gráfico de consumo diario e interfaz responsive
  con modo oscuro, servida vía Ingress.

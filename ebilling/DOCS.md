# eBilling — Documentación

## La aplicación

La interfaz está organizada en tres pestañas, con estética de app iOS
(superficies translúcidas «glass») y fondo dinámico. Usa la tipografía **Inter**
(SIL OFL), empaquetada con el add-on y servida en local, y una paleta cuyos
contrastes están verificados para superar el nivel **AA** (4,5:1) sobre
cualquiera de los fondos, tanto en modo claro como oscuro:

- **Home** — el diagrama de **flujo de energía** en vivo (solar, red, batería y
  casa) y debajo el **resumen de energía del día**: generación repartida en «a
  la casa / a la batería / a la red» y consumo de la casa en «desde solar /
  desde batería / desde la red», con barras y porcentajes.

  Dentro de cada círculo del diagrama se muestra su **potencia instantánea** en
  grande y **el contador del día de ese mismo punto** en pequeño: en la red,
  `←` la energía exportada y `→` la importada; en la batería, `↑` la descarga
  (en rojo, sale de la batería) y `↓` la carga (en verde, entra). Son las lecturas de tus sensores, sin reparto. El **reparto por
  fuentes** (de dónde viene el consumo, a dónde va la generación) está en el
  anillo alrededor de la casa y en el resumen de energía.

  Ojo con una diferencia que despista: en el resumen, **«Desde la red» no es lo
  que marca tu contador de importada** (que tienes en el nodo de la red, justo
  encima), sino la parte de esa importación que ha consumido la casa. Si parte de
  lo importado ha ido a **cargar la batería**, esa parte no la consume la casa y
  la diferencia es justo esa. Cuando ocurre, al pie del resumen aparece la frase
  que lo explica («1,09 kWh de lo importado fue a cargar la batería, así que no
  lo consumió la casa»).

### Medidores bidireccionales

Muchos inversores y medidores dan un **único sensor con signo** en lugar de dos:
la red en **+ importación / − exportación** y la batería en **+ carga /
− descarga**. En ese caso, **asigna el mismo sensor a las dos casillas del par**
(tanto en el flujo de energía como en los contadores): el add-on separa las dos
direcciones por el signo.

Con un **contador neto** de energía hay un detalle importante: su estado (el
neto) no sirve para ninguna de las dos direcciones, así que los totales salen
siempre de las estadísticas y el reparto por signo se hace **antes** de agrupar
(en un bucket de un día el neto ya está sumado y el signo se pierde). Por eso,
con un contador así, semana, mes y año se calculan con resolución horaria. En
**Total** (diez años) se reparte por días y las cifras son aproximadas.

### Cuando falta un dato

«Sin datos» y «cero» no son lo mismo, y el add-on no los confunde. Si un
contador está configurado pero **no tiene estadísticas** para el periodo que
estás mirando (el `recorder` no las guarda, el sensor es nuevo, o no tiene
`state_class`) —o si **marca cero** mientras su sensor de potencia lleva horas
midiendo—, esa lectura no se enseña como un dato:

1. Se deduce **integrando el sensor de potencia** de esa misma magnitud, el que
   ya tienes en «Flujo de energía». Es una aproximación, pero es un dato.
2. Si tampoco hay potencia, la leyenda muestra **«--»**.

Esto importa porque un cero falso no se queda quieto: el reparto lo da por
bueno y le echa la culpa al residuo, y acabas viendo «0 importada» arriba y
«4,2 kWh desde la red» abajo. Con el respaldo, las dos cifras salen del mismo
sitio.

Si una magnitud sale como «--» o muy por debajo de lo que esperas, mira si su
sensor aparece en **Ajustes › Desarrollador › Estadísticas** de Home Assistant:
un sensor sin `state_class` no genera estadísticas y solo se puede leer por su
potencia.

### Valores negativos

La potencia y la energía que muestra el add-on son **magnitudes**: nunca son
negativas. Un valor negativo en un sensor significa otra cosa y se trata como
tal:

- En un **par bidireccional** (el mismo sensor en las dos casillas) el signo es
  la dirección y se usa para separarlas, como se explica arriba.
- Fuera de un par, un valor negativo es un **sensor con el signo invertido** o un
  medidor neto puesto en una sola casilla: **se recorta a cero**, porque la casa
  no genera ni el sol consume.
- Un **incremento negativo de un contador** no es energía negativa: es un
  contador que se ha **reiniciado** (los diarios lo hacen cada medianoche) o que
  ha dado una lectura menor que la anterior. También se recorta a cero; si se
  sumara, restaría del total del día.
- Si el **contador del consumo de la casa** resulta inservible (no suma nada en
  el periodo, porque no está configurado o porque el sensor está invertido y se
  ha recortado a cero), se descarta y el consumo se **deduce por balance**. Esa
  decisión se toma **una vez por periodo**, no intervalo a intervalo: o manda el
  contador en todos, o se deduce en todos. Así el círculo de la casa, el resumen
  y el total del gráfico dicen siempre lo mismo.

Si ves un cero donde esperas consumo, revisa el signo del sensor en Ajustes: casi
siempre es un sensor de la casa o de la red configurado al revés.

### Cómo se calcula el reparto

Los contadores dan lo que entra y sale por cada punto, pero **ninguno mide el
reparto**: no existe un sensor «solar → casa». Hay que deducirlo, y el resultado
depende de *cuándo* pasa cada cosa, así que el reparto se hace **intervalo a
intervalo** y luego se suma:

| Pantalla | Resolución del reparto |
|---|---|
| Home y rango de día | 5 minutos |
| Semana y mes | 1 hora |
| Año y total | el bucket del gráfico (mes o año) |

Hacerlo de una vez sobre el total del día da resultados muy distintos y peores.
Ejemplo real: batería cargada **de la red** de 00:00 a 03:00 (6 kWh) y sol de
10:00 a 16:00 (24 kWh, de los que 12 se vierten). Sobre el total del día el
reparto cree que la batería la cargó el sol («a la batería 6 kWh, desde la red
7,5 kWh»); intervalo a intervalo sale lo que de verdad pasó: «a la batería 0,
desde solar 12, desde la red 1,5» y «6 kWh de lo importado fue a cargar la
batería».

Esa resolución vale tanto para el desglose como para **la línea del consumo de la
casa** del gráfico: se reparte con el intervalo fino y se agrupa después en los
buckets del gráfico. Por eso el total de la leyenda y el del desglose son la
misma cifra.

#### Cuando los contadores no cuadran entre sí

Con un **contador del consumo de la casa**, ese total manda y los tres orígenes
se reparten hasta cubrirlo, **a prorrata de lo que cada contador dice haber
aportado**: el sol que no se vertió ni cargó la batería, toda la descarga, y lo
importado que no acabó en la batería.

Si los sensores son coherentes, esas tres cantidades suman exactamente el
consumo y cada origen se lleva justo lo suyo. Si no lo son —pasa: un sensor de
la casa que no cubre todos los circuitos, una descarga que se contabiliza de más
al vuelo— el desajuste se reparte **entre los tres**. Antes se rellenaba en
orden (sol, batería y la red con el resto), y eso tenía un efecto feo: si el sol
y la batería ya cubrían el consumo, **la red se quedaba a cero aunque su
contador dijera que habías importado 2 kWh**, y esos kWh no aparecían por ningún
lado.

Si los contadores se quedan **cortos** para el consumo medido, el hueco se le
atribuye a la red: es lo único que puede aportar energía sin que se vea en
ningún otro contador.

  El **fondo representa el momento del día** (noche, amanecer, día, atardecer,
  a partir de `sun.sun`) y las **condiciones meteorológicas** (nubes, lluvia,
  nieve, niebla). En la esquina superior se muestra el **icono del tiempo** y la
  **temperatura exterior**.
- **Energía** (al pulsar el resumen de la Home) — pantalla de análisis con
  rangos **Día · Semana · Mes · Año · Total** y cinco vistas por iconos:
  **general, solar, casa, batería y red**. Ver la sección
  [Pantalla «Energía»](#pantalla-energía).
- **Facturación** — el simulador: comparativa de tarifas, **Detalle** con el
  desglose por día y hora, y gestión de **Tarifas** (crear, editar, CSV).
- **Ajustes** — un **índice por categorías** (como los Ajustes de iOS), cada una
  con su propia pantalla:

  | Sección | Categorías |
  |---|---|
  | Datos | Fuente de datos |
  | Sensores | Flujo de energía · Contadores de energía · Previsión solar · Meteorología |
  | Facturación | Tarifas · Contrato y ciclo |
  | Integración | Sensores en Home Assistant |

  Cada fila resume lo que hay configurado. Las tarifas se gestionan tanto aquí
  como desde Facturación (es la misma lista).

Al abrir el add-on se muestra una **pantalla de carga** mientras se leen la
configuración y los sensores; desaparece en cuanto llegan los datos.

### Sensores que necesita la Home

En **Ajustes** pulsa **Buscar entidades** y asigna:

| Grupo | Sensores |
|---|---|
| Flujo de energía (W/kW) | producción solar, importación y exportación de red, carga y descarga de batería, consumo de la casa (opcional) y % de batería (opcional) |
| Contadores de energía (kWh) | solar, importada, exportada, carga, descarga y **casa** (opcional) |
| Meteorología | **dos sensores independientes**: uno con la **condición** (acepta los estados de HA como `sunny`/`partlycloudy`/`rainy`, o texto en castellano como «Parcialmente nuboso») y otro con la **temperatura exterior** |
| Previsión solar (opcional) | sensor de **Solcast** o **Forecast.Solar** para dibujar la previsión de generación |

Los contadores de energía pueden ser **sensores del día en curso** («Solar hoy»,
«Importada hoy»…) o **contadores acumulados** desde el inicio del histórico
(`total_increasing`). Lo eliges en *Contadores de energía → Qué miden*:

| Opción | Qué hace |
|---|---|
| **Detectarlo automáticamente** (por defecto) | Calcula el incremento del día y lo compara con el estado del sensor; si coinciden, el sensor ya es diario y se usa su estado, que va al segundo |
| **Ya son del día en curso** | Lee los estados tal cual, sin consultar estadísticas |
| **Son acumulados** | Calcula el **incremento desde la medianoche** con las estadísticas de largo plazo (en pasos de 5 minutos) |

Si un contador no tiene estadísticas, se usa su estado actual como último
recurso.

El **consumo de la casa** se toma, por este orden:

1. Su **contador de energía** (kWh), si lo indicas en *Contadores de energía →
   Casa*.
2. La **integral de su sensor de potencia**, el que ya configuras en el flujo de
   energía: no hace falta ningún ajuste extra.
3. Por **balance**, si no tienes ninguno de los dos.

El reparto atribuye a la generación lo vertido y lo que carga la batería, y el
resto a la casa (mismo modelo que las apps de inversores); lo que carga la
batería por encima de lo generado se atribuye a la red. Cuando el consumo está
medido, los orígenes (solar, batería, red) se reparten hasta cubrir exactamente
ese total, así que los porcentajes siempre suman 100 %. Es el mismo cálculo en la
Home y en la pantalla de Energía.

## Pantalla «Energía»

Se abre pulsando el **resumen de energía** de la Home.

- **Rango**: Día · Semana · Mes · Año · Total. Las flechas ‹ › van al periodo
  anterior o siguiente y el **rótulo del periodo es pulsable**: abre el control
  de fecha del sistema y, al elegir un día, se muestra el día, la semana, el mes
  o el año que lo contiene según el rango activo.
- **Vista** (iconos): general, solar, casa, batería y red.
- **Gráfico**: en el rango de día, la **potencia media (W)** cada 5 minutos con
  la curva de **ayer** como comparación; en el resto, la **energía (kWh)** por
  día, mes o año. Todas las series se dibujan como **línea con su área
  translúcida**. El eje llega hasta el final del periodo: los buckets que aún no
  han ocurrido quedan como hueco.
- **Leyenda**: cada serie se activa y desactiva pulsándola, y muestra el
  **total de energía del periodo**, tomado del **contador** de esa magnitud (el
  mismo número que ves en tus sensores y en los demás rangos), no de integrar la
  curva de potencia. Si una serie no tiene contador configurado —el consumo de la
  casa, por ejemplo— sí se integra su potencia, y la previsión solar siempre se
  integra. Al **pulsar un punto del gráfico** todas
  pasan a mostrar el valor de ese instante; el botón **Totales** vuelve a los
  totales del periodo.
- **Zoom del eje del tiempo**: pellizca con dos dedos (o `⌘`/`Ctrl` + rueda del
  ratón) para estirar el eje X; el zoom sigue a los dedos de forma continua.
  Arrastra con un dedo para desplazarte por el eje y pulsa el indicador `1.0×`
  para restablecerlo; también hay botones **−** y **+**. El eje Y se mantiene
  fijo. Con ratón, arrastrar recorre los puntos.
- **Previsión de generación**: en la vista solar, si el intervalo incluye horas
  futuras y has configurado un sensor de previsión, se dibuja como **línea
  punteada** (sin entrada en la leyenda). Se admiten los atributos de **Solcast**
  (`detailedForecast`, `detailedHourly`, con `pv_estimate` en kW) y de
  **Forecast.Solar** (`watts` en W y `wh_days` en Wh).
- **Reparto del periodo**: debajo del gráfico, el origen del consumo o el
  destino de la generación, con barra apilada y porcentajes. En el día en curso
  son exactamente los mismos totales que muestra la Home.

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

#### Monedero / batería virtual

En España la compensación de excedentes tiene un **tope legal**: el abono no
puede superar el coste de la energía consumida de la red. El valor de los
excedentes que supera ese tope normalmente **se pierde**, salvo que tu tarifa
ofrezca un **monedero o batería virtual**, que lo acumula como saldo para usar
en otras facturas.

Activa la casilla **Monedero / batería virtual** en la tarifa (dentro de
Compensación de excedentes) y eBilling calculará ese «exceso de excedentes»
**aparte**: aparece como un saldo (`+X €`) en la tarjeta y en la factura
detallada, sin reducir el total de la factura del ciclo. Si la tarifa no tiene
monedero, ese mismo importe se muestra como *excedente no compensado*
(informativo, se pierde).

Si publicas sensores, las tarifas con monedero exponen además
`sensor.ebilling_<tarifa>_monedero` con el saldo generado en el ciclo.

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
- **Intervalo de trabajo fijo**: con el botón **📅 Periodo** puedes fijar un
  inicio y un fin cualesquiera. Ese intervalo **se guarda** y pasa a ser el
  periodo por defecto de **todos** los cálculos (comparativa, detalle y también
  los sensores publicados en Home Assistant): la app trabaja siempre sobre el
  último intervalo que hayas indicado, y se **refresca automáticamente** (~cada
  minuto) sobre él. Sobrevive a recargas y reinicios. Pulsa **Volver al ciclo**
  para regresar al ciclo de facturación automático.

## Opciones del add-on

| Opción | Descripción |
|---|---|
| `log_level` | `debug`, `info`, `warning` o `error` |

Toda la configuración funcional (fuente, tarifas, contrato) se gestiona desde
la propia interfaz y se guarda en `/data/ebilling.json`.

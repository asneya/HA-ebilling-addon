# Vatia — Documentación

> **Antes se llamaba eBilling.** Si vienes de ahí, mira
> [Venir de eBilling](#venir-de-ebilling) antes de nada: Home Assistant trata
> Vatia como un add-on nuevo y hay tres cosas que mover.

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

Con un **contador del consumo de la casa**, ese total manda y los orígenes se
reparten hasta cubrirlo. Cada origen aporta lo que salió de su punto y no fue a
ningún otro sitio medido:

| Origen | Lo que entregó a la casa |
|---|---|
| Solar | lo generado menos lo vertido y lo que cargó la batería |
| Batería | la descarga menos lo que se vertió a la red |
| Red | lo importado menos lo que cargó la batería |

**La red va primero, y entera.** Lo importado que no ha cargado la batería no
tiene otro sitio al que ir, y además lo mide el contador de la compañía: es una
entrega, no una estimación. El sol y la batería se reparten el resto a prorrata.

Si los sensores son coherentes, las tres cantidades suman exactamente el consumo
y cada origen se lleva justo lo suyo, en cualquier orden. El orden solo importa
cuando **no** cuadran —pasa: un sensor de la casa que no cubre todos los
circuitos, una descarga que se contabiliza de más—, y ahí lo que no puede ser es
que la cifra que te cuesta dinero se quede corta o a cero.

Nada de esto confunde una **carga desde la red** con consumo de la casa: el
reparto se hace intervalo a intervalo, así que en los tramos en los que la
batería sí carga de la red esa parte se descuenta antes (es la frase «X kWh de
lo importado fue a cargar la batería»).

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
  | Sensores | Flujo de energía · Contadores de energía · Electrodomésticos · Previsión solar · Meteorología |
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
| Batería (opcional) | **reserva mínima (%)**: el porcentaje por debajo del cual tu inversor no descarga. Un Sungrow lo publica en `sensor.battery_min_soc` |
| Meteorología | **dos sensores independientes**: uno con la **condición** (acepta los estados de HA como `sunny`/`partlycloudy`/`rainy`, o texto en castellano como «Parcialmente nuboso») y otro con la **temperatura exterior** |
| Previsión solar (opcional) | sensor de **Solcast** o **Forecast.Solar**. Admite **varios separados por comas**: muchas integraciones publican hoy y mañana en dos sensores distintos, y sin el de mañana la ventana no puede comparar los dos días |
| El tiempo hora a hora (opcional) | una entidad **`weather.*`** (AEMET, Met.no, OpenWeatherMap…) para la tarjeta del tiempo de la Home |

La **reserva mínima** importa más de lo que parece. Ningún inversor vacía la
batería: por debajo de un porcentaje —el «Min SOC» o la reserva de respaldo— deja
de descargar. Esa energía figura en el contador y **no se puede gastar**. Sin
declararla, Vatia contaba la batería entera como disponible y llegaba a decir
«Gratis» ofreciendo kilovatios que el inversor no iba a entregar: con la batería
al 21 % y el suelo en el 20, lo utilizable son 0,1 kWh de un depósito de 10, no
2,1. Se teclea en *Ajustes → La batería*, o se asigna el sensor en *Sensores →
Batería* y entonces sigue solo cuando lo cambies en el inversor.

La entidad `weather.*` es **otra cosa** que los dos sensores de meteorología:
aquellos dicen cómo está *ahora* —son los que ponen el fondo y la pastilla de la
cabecera— y esta trae la **previsión horaria**, que es lo que pinta la tarjeta.
Sin asignarla, esa tarjeta no sale.

La previsión se pide con el servicio `weather.get_forecasts` y no leyendo un
atributo: desde Home Assistant 2024.4 las entidades del tiempo **ya no publican**
su previsión en el atributo `forecast`. La **nubosidad** de cada hora depende de la
integración —AEMET y Met.no la dan, otras no—; cuando no viene, esa columna se
calla en vez de dibujar un cero que se leería como «despejado».

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

### Si tienes un Sungrow

Los híbridos residenciales de Sungrow, con la
[integración Modbus de mkaiser](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant),
publican todo lo que Vatia necesita. La correspondencia:

| Casilla de Vatia | Entidad | Registro |
|---|---|---|
| Solar · energía del día | `sensor.daily_pv_generation` | 13002 |
| Red · energía importada | `sensor.daily_imported_energy` | 13036 |
| Red · energía exportada | `sensor.daily_exported_energy` | 13045 |
| Batería · energía cargada | `sensor.daily_battery_charge` | 13040 |
| Batería · energía descargada | `sensor.daily_battery_discharge` | 13026 |
| Casa · consumo instantáneo | `sensor.load_power` | 13008 |
| Batería · estado de carga | `sensor.battery_level` | 13023 |
| Batería · reserva mínima | `sensor.battery_min_soc` | (holding) |

Y dos opcionales que **sustituyen una deducción por una medida**:

| Casilla de Vatia | Entidad | Registro |
|---|---|---|
| De la carga, lo que puso el sol | `sensor.daily_battery_charge_from_pv` | 13012 |
| De lo exportado, lo que puso el sol | `sensor.daily_exported_energy_from_pv` | 13005 |

Con esas dos, «cuánto de la carga de la batería vino de la red» y «cuánto de lo
vertido salió de la batería» dejan de deducirse: salen de restar dos medidas del
propio inversor. Es justo la parte del reparto que más veces ha estado mal, así
que si las tienes, ponlas.

#### Ojo con el «consumo directo»

**Sungrow no publica ningún contador del consumo total de la casa en kWh.** Solo
da `Load power` en vatios. Lo que sí publica es
`sensor.daily_direct_energy_consumption` (registro 13017), que suena a consumo y
**no lo es**: es el *autoconsumo*, lo que la casa toma del sol, sin nada de lo
que se compra a la red.

Es un sensor traicionero porque los días sin importar cuadra casi exacto y solo
se despega cuando compras algo. Puesto en la casilla del consumo de la casa,
hace que el resumen atribuya a la batería toda la importación que ese sensor no
ve. Vatia ya no lo propone y avisa si lo encuentra puesto, pero conviene saberlo.

Deja la casilla del consumo **vacía** —Vatia lo deduce del balance de los otros
cinco contadores— o crea un contador de verdad integrando `Load power` con el
[helper de suma de Riemann](https://www.home-assistant.io/integrations/integration/)
de Home Assistant.

Y ojo también con `sensor.daily_consumed_energy`, que la propia integración
define: es **el mismo balance que hace Vatia**, no una medida independiente.
Ponerlo en esa casilla sería devolverle su propia cuenta disfrazada de lectura, y
perdería el contraste entre las dos que permite detectar un sensor que miente.

El diccionario completo de registros y entidades, con las tres trampas y los
detalles de escala, signo y cadencia, está en
[`docs/sungrow-modbus.md`](../docs/sungrow-modbus.md).

### La ventana de energía gratis

Mientras está abierta, la tarjeta dice **lo que queda por sobrar de aquí al cierre**
—no una potencia media— y lo que vale por los dos lados:

> **Hasta las 19:32 te sobran 8,4 kWh.**
> Gastarlos te ahorra 1,71 €; si no, se van a la red por 0,42 €.

**«Sobra» es lo que no consume la casa y tampoco hace falta para llenar la batería
al 100 %.** Después de servir a la casa, la prioridad del inversor es cargar, así
que ese trozo no se puede gastar en otra cosa: se descuenta y se dice aparte al pie,
con la hora a partir de la cual empieza a sobrar de verdad («no sobra nada que gastar
hasta las 12:40»). El hueco de la batería sale de su capacidad y del estado de carga
de **ahora**, así que la cifra crece a medida que la batería se llena. Los euros salen de los precios de las horas que quedan (no del precio
de este minuto, que la ventana puede cruzar un cambio de periodo) y de la
compensación de excedentes de tu tarifa. **Sin tarifa elegida** en Ajustes no se
inventan: la tarjeta habla solo de energía.

Esa diferencia entre las dos cifras es el motivo de la tarjeta. En una 2.0TD con
excedentes a 0,05 €, un kWh gastado en casa vale cuatro veces lo que vendido.

### Tus aparatos

Cada electrodoméstico que declares en *Ajustes → Electrodomésticos* —un nombre, un
icono, un color y **su sensor de potencia**— aparece en una fila de la tarjeta
**«Tus aparatos»** de la Home. Nada se describe a mano: la duración del ciclo y su
consumo se **aprenden** de la curva de potencia de los últimos días.

Cada fila lleva una **barra segmentada del origen** de su energía (sol, batería y
red, con los mismos colores que el resumen del día) y, a la derecha, **lo que
cuesta** en euros o «Gratis» si no hay que comprar nada. Barra e importe salen del
mismo reparto: si la barra no tiene rojo, el importe es cero.

Al lado del nombre, un **glifo dice de qué va la fila** —pasa el dedo o el ratón por
encima y lo pone en palabras—, y un **aro verde alrededor del icono** señala lo que
está dando ahora mismo:

| | Qué dice |
|---|---|
| 🕐 reloj | hay una hora que elegir (movible) |
| 🏠 casa | la hora la manda la casa, no el sol (fijo) |
| ⚡ rayo | siempre encendido (continuo) |
| aro verde | está dando ahora mismo |

El aro lo llevan también los de **siempre encendido**, y de forma permanente: una
nevera está en marcha, y su compresor entrando y saliendo cada veinte minutos no es
encenderse y apagarse. Aparece en cuanto el sensor ve consumo, aunque el histórico aún
no lo sepa, y aguanta las pausas de un programa —el reposo de un lavavajillas entre el
lavado y el secado no lo apaga—.

Lo que cambia de una fila a otra es **la pregunta que contesta**, y eso depende de
la forma de uso:

| Forma | La pregunta | Qué muestra |
|---|---|---|
| **Puedo elegir la hora** (movible) | ¿a qué hora lo pongo? | el origen y el coste si arranca **ahora**, más la **hora óptima** y lo que se gana esperando |
| **Tiene ciclo, pero no lo muevo** (fijo) | ¿cuánto me cuesta ahora? | lo mismo, **sin** proponer hora |
| **Siempre encendido** (continuo) | ¿cuánto lleva hoy y de dónde salió? | los kWh del día y su origen hora a hora |

### Cuando algo está en marcha

Un movible que **ya está funcionando** cambia de pregunta: «¿a qué hora?» está
contestada, la decisión está tomada. Su fila pasa a decir por dónde va, y la barra
del origen se convierte además en la del progreso: se rellena hasta donde va el
ciclo y el resto queda de carril.

Lo medido y lo estimado no se mezclan en la misma cifra:

| | De dónde sale |
|---|---|
| Que está en marcha y **desde cuándo** | del detector de ciclos, con su misma tolerancia a las pausas |
| Lo que **lleva** de tiempo y de kWh | del reloj y del contador |
| **De dónde ha salido** lo que lleva, y lo que ha costado | atribución hora a hora, como en un continuo |
| Cuándo **termina** | la mediana de sus propios ciclos |
| De dónde saldrá **lo que le queda** | simulado, con la potencia que está dando hoy |

El progreso va **por tiempo, no por energía**. En una lavadora el calentamiento
está al principio: el 70 % de los kWh se gastan en el primer tercio del programa,
así que una barra por energía diría «casi acabando» a los veinte minutos.

Y la duración típica es una mediana **sobre programas distintos** —un rápido a 30°
y un algodón a 60° son el mismo enchufe—, así que la barra **puede pasarse**: al
superar lo habitual se dice («más de lo habitual») en vez de quedarse clavada en el
100 % fingiendo que el final es inminente.

Por lo mismo, la **hora de fin solo se promete si sus ciclos se parecen**: hacen
falta al menos tres terminados y que entre el más corto y el más largo no haya más
de un 30 % de la mediana. Un horno tarda siempre lo mismo y se le puede decir
«~termina a las 19:40»; una lavadora con cinco programas, no, y entonces se dice lo
que sí se sabe: «suele durar entre 55 min y 2 h 25 min».

Un ciclo en curso **no cuenta** para calcular «lo que suele durar»: todavía no ha
durado lo que va a durar. Sus kWh sí cuentan para el consumo del día, porque esa
energía se ha gastado de verdad.

Vatia **detecta** «siempre encendido» de la curva de potencia: una nevera enciende
y apaga el compresor decenas de veces al día y un router no se apaga nunca, y eso
se ve en los vatios. Lo que **no** se puede saber mirando el sensor es si algo
tiene un ciclo y aun así no lo mueves —el aire lo quieres cuando hace calor, no
cuando pica el sol—, así que **«fijo» no se detecta jamás**: se elige en la ficha.
Lo que elijas manda siempre sobre lo detectado, y cuando ha decidido la aplicación
la tarjeta lo dice al pie.

Un continuo **no publica ciclo típico**. Antes sí, y era una cifra medida que
mentía: de una nevera con el compresor 18 minutos sí y 27 no salían «32 ciclos al
día», un ciclo típico de «0 h 20 min · 0,03 kWh» y una hora óptima para
encenderla. No faltaba información; se contestaba con confianza a una pregunta que
no existe.

El origen de un continuo se atribuye **hora a hora**: su parte de cada hora por el
reparto de la casa en esa misma hora, no los kWh del día por un precio medio. Su
parte nunca puede pasar del total de la casa de esa hora, y lo que cae en una hora
sin reparto **se declara como no atribuido** en vez de repartirse a ojo para que
cuadre.

Las filas se ordenan por lo que hay que decidir, con lo que **está pasando** por
delante: primero lo que esté en marcha, luego los movibles (por ahorro
descendente), después los fijos y al final los continuos.

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

## Diagnóstico

En **Ajustes → Diagnóstico** está el **balance de energía del día**: todo lo que
entra en la instalación frente a todo lo que sale.

| Entra | Sale |
|---|---|
| Generación solar | Consumo de la casa |
| Importada de la red | Exportada a la red |
| Descarga de la batería | Carga de la batería |

Las dos columnas tienen que sumar lo mismo: la energía no desaparece. Junto a
cada cifra se indica **qué sensor** la ha dado y **de dónde sale** (el estado del
sensor, sus estadísticas del `recorder`, o la integral de su potencia cuando no
hay contador que leer).

Si no cuadra, el add-on lo dice y con qué signo:

- **Entra más de lo que sale**: o el sensor del consumo de la casa se queda corto
  —es lo más común: una pinza que no cubre todos los circuitos—, o la descarga de
  la batería y la importación se están contando de más.
- **Sale más de lo que entra**: o el consumo de la casa se pasa, o la generación
  y la importación se cuentan de menos.

Esto importa porque **ningún reparto puede arreglar un sensor que no mide lo que
crees**: el add-on ajusta las filas para que sumen el total de su contador, así
que si un contador miente el error se reparte entre los orígenes. El diagnóstico
es el sitio donde se ve la causa en lugar del síntoma. Un margen de hasta el 5 %
se considera normal (los contadores no son idénticos y las estadísticas van con
unos minutos de retraso).

## Dónde está la configuración

En **`/addon_configs/<slug>_vatia/vatia.json`** (el `<slug>` exacto lo ves
listando `/addon_configs/`; en una instalación local es `local_vatia`). Esa
carpeta la crea el Supervisor porque el add-on declara `map: addon_config`, y se
ve desde:

- el add-on **Samba share** (recurso `addon_configs`),
- **File Editor** o **Studio Code Server**,
- **Terminal & SSH**, el oficial, sin desactivar el modo protegido.

Puedes leerla, editarla a mano y respaldarla. Un par de advertencias:

- **Edita con el add-on parado**, o usa la pantalla de *Copia de seguridad*: si
  el add-on guarda mientras editas, tu cambio se pierde.
- Si el JSON queda mal, el add-on **no lo sobreescribe**: lo aparta como
  `vatia.json.invalido` y recupera la copia interna de `/data`. Revisa el registro
  del add-on si algo no aparece como esperabas.

Hay una **copia en `/data`**, que es lo que archiva el Supervisor en las copias
de seguridad del add-on; si restauras y solo viene `/data`, la configuración
sigue ahí. Manda siempre la de la carpeta compartida. La caché de precios PVPC se
queda también en `/data`: es caché, no configuración.

## Copia de seguridad

En **Ajustes → Copia de seguridad** puedes:

- **Exportar**: descarga un `vatia-config.json` con todos tus ajustes y tus
  tarifas. Guárdalo antes de tocar nada gordo, para mudarte a otro Home
  Assistant, o simplemente como respaldo.
  **Contiene el token de Home Assistant**, así que trátalo como una contraseña.
- **Importar**: pega el contenido del JSON o elige el fichero. Sustituye los
  ajustes y **reemplaza todas las tarifas** por las del fichero.

Los secretos que vengan **enmascarados** (`********`) conservan el valor que ya
tuvieras, así que importar la respuesta de `api/config` —que es la que se puede
copiar del navegador— no te borra el token: simplemente no lo trae, y lo vuelves
a poner en *Fuente de datos*. Esa es la vía para
[venir de eBilling](#venir-de-ebilling) sin tocar ficheros del sistema.

## Apariencia

En **Ajustes → Apariencia** eliges el tema:

| Opción | Qué hace |
|---|---|
| **Automático** (por defecto) | Sigue al sistema: cambia solo cuando tu móvil o tu ordenador entran en modo oscuro, sin recargar la página. |
| **Claro** | Fuerza el tema claro aunque el sistema esté en oscuro. |
| **Oscuro** | Fuerza el tema oscuro aunque el sistema esté en claro. |

Se aplica al instante y se guarda en el add-on, así que es el mismo tema en
todos tus dispositivos. En esa misma pantalla se muestra la **versión del
add-on**, útil para comprobar qué versión está corriendo de verdad después de
una actualización (Home Assistant necesita reiniciar el add-on para aplicarla).

## Venir de eBilling

El add-on se llamaba **eBilling**. Home Assistant identifica los add-ons por su
`slug`, así que al cambiarlo lo trata como un add-on **nuevo**: no llega como
actualización y no se lleva nada consigo. Hay tres cosas que mover.

**1. La configuración.** La forma fácil, sin tocar ficheros del sistema:

1. Abre **eBilling** y, en la pestaña donde se ve su interfaz, añade
   `api/config` al final de la dirección. Sale un JSON con todos tus ajustes y
   tus tarifas.
2. Cópialo entero y pégalo en **Vatia → Ajustes → Copia de seguridad →
   Importar**.
3. Vuelve a poner el **token de Home Assistant** en *Fuente de datos*: es el
   único dato que no viaja, porque la API lo enmascara por seguridad.

Si prefieres el fichero, copia `ebilling.json` del directorio de datos del
add-on antiguo al del nuevo. En HAOS ese directorio no está compartido por
Samba, así que hace falta el add-on **Advanced SSH & Web Terminal** con el *modo
protegido* desactivado; está en
`/mnt/data/supervisor/addons/data/local_ebilling/`. Vatia reconoce el fichero
por su nombre de antes, **lo adopta tal cual** y lo reescribe como `vatia.json`.

Y si no te importa volver a configurarlo, son cuatro pantallas de selectores;
las tarifas se mueven una a una con el botón **CSV** de cada una.

**2. Los sensores.** Pasan de `sensor.ebilling_*` a `sensor.vatia_*`. Los
antiguos desaparecen solos al reiniciar Home Assistant, porque se publican por
la API de estados y no quedan registrados. Si los usas en automatizaciones,
plantillas o tarjetas, cambia el nombre.

**3. Las tarjetas Lovelace.** El fichero cambia: actualiza el recurso a
`vatia-power-flow.js` y `vatia-card.js` en *Ajustes → Paneles → Recursos*. **Las
tarjetas que ya tengas puestas siguen funcionando**: los nombres antiguos
(`ebilling-power-flow` y `ebilling-card`) se mantienen como alias precisamente
para no tener que editarlas una a una. Para las nuevas, usa los nuevos.

Cuando compruebes que todo está en su sitio, desinstala eBilling.

## Primeros pasos

Al arrancar, el add-on funciona en **modo demo** con datos sintéticos para que
puedas explorar la interfaz. Para usar tu consumo real:

1. Abre **Vatia** en la barra lateral.
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
Compensación de excedentes) y Vatia calculará ese «exceso de excedentes»
**aparte**: aparece como un saldo (`+X €`) en la tarjeta y en la factura
detallada, sin reducir el total de la factura del ciclo. Si la tarifa no tiene
monedero, ese mismo importe se muestra como *excedente no compensado*
(informativo, se pierde).

Si publicas sensores, las tarifas con monedero exponen además
`sensor.vatia_<tarifa>_monedero` con el saldo generado en el ciclo.

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
| `sensor.vatia_<tarifa>_precio` | Precio del término de energía **ahora** (€/kWh) |
| `sensor.vatia_<tarifa>_precio_excedente` | Precio de compensación ahora (si aplica) |
| `sensor.vatia_<tarifa>_coste_ciclo` | Coste acumulado del ciclo actual (€) |
| `sensor.vatia_<tarifa>_proyeccion` | Coste estimado a fin de ciclo (€) |
| `sensor.vatia_mejor_tarifa` | Nombre de la tarifa más barata |
| `sensor.vatia_ahorro_potencial` | Diferencia € entre la más cara y la más barata |

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

## Quién ve Vatia y quién puede configurarla

Vatia sale en la barra lateral de **todos** los usuarios de Home Assistant, no
solo de los administradores: lo que cuenta —lo que gasta la casa, a qué hora
sale barato poner la lavadora— le sirve a quien vive en ella tenga o no permisos
para administrar el sistema.

Dentro hay dos roles, que son de Vatia y no de Home Assistant:

- **Administrador** — configura la casa: sensores, tarifas, InfluxDB, copia de
  seguridad. Y nombra a otros administradores en **Ajustes → Usuarios**.
- **El resto** — ve todos los datos, con la misma frescura, y configura **lo
  suyo**: el tema, el orden de las tarjetas de inicio y el diagrama del caudal.

Con qué rol se recibe a quien entra por primera vez se decide en las opciones
del add-on (`first_user_role`, abajo). Si en algún momento no queda ningún
administrador, el siguiente que entre lo será: no hay manera de quedarse fuera.

### Si no te sale en la barra lateral

Si actualizaste desde una versión anterior a la 0.44.1 y a los usuarios que no
son administradores les sigue sin aparecer, es un detalle de cómo funciona el
Supervisor, no de la configuración.

Home Assistant apunta si un panel es solo para administradores **cuando el
add-on se instala**, y el Supervisor no vuelve a decírselo al actualizar: solo
lo hace al restaurar una copia, al desinstalar y cuando alguien mueve el
interruptor «Mostrar en la barra lateral». Así que el ajuste cambia y Core sigue
con el de antes.

Desde la 0.46.3 Vatia lo rehace **al arrancar** —quita el panel y lo vuelve a
poner, que es lo único que Home Assistant admite: volver a inscribir un panel que
ya existe no lo actualiza—, así que basta con reiniciar el add-on una vez. Si aun
así no aparece, cualquiera de estas dos cosas hace lo mismo a mano:

- **Ajustes → Sistema → Reiniciar → Reiniciar Home Assistant Core.**
- En la página del add-on, apagar y volver a encender **«Mostrar en la barra
  lateral»**.

Ten en cuenta lo que implica que lo vea todo el mundo: Vatia **no tiene
contraseña propia** y por Ingress entra cualquier usuario de Home Assistant. Los
roles limitan lo que se puede tocar dentro, pero el panel es para gente de
confianza, y su puerto no debe exponerse fuera de casa.

## Opciones del add-on

| Opción | Descripción |
|---|---|
| `log_level` | `debug`, `info`, `warning` o `error` |
| `first_user_role` | Con qué rol se recibe a quien entra por primera vez: `primero` (el primero es administrador y el resto no), `admin` (todo el que entre lo es) o `viewer` (nadie lo es por entrar) |

Está aquí, en las opciones del add-on, y no dentro de la aplicación, porque a
esta pantalla solo llega un administrador de Home Assistant: es el único sitio
desde el que se puede arrancar el reparto de permisos sin necesitar ya un
permiso para llegar. Cambiarlo no toca a quien ya tiene rol.

Toda la configuración funcional (fuente, tarifas, contrato) se gestiona desde
la propia interfaz y se guarda en `/data/vatia.json`.

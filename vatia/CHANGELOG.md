# Changelog

Todas las versiones relevantes del add-on Vatia.

## 0.73.0

Tres huecos que salieron de repasar la aplicación entera contra la guía de diseño, los
tres del mismo tipo: cosas que el diseño da por hechas y que no estaban.

### Las hojas salen por donde entraron

Cerrar una hoja era `display: none`. Entraba subiendo en tres décimas y **desaparecía de
golpe**, sin salida ninguna, las seis. Lo que se esfuma por donde no entró se lee como un
fallo, no como una decisión, y deja al ojo sin saber adónde ha ido lo que estaba mirando.

Ahora la salida es el camino de ida del revés, y con ese detalle:

- la curva es la **inversa exacta** de la de entrada. `cubic-bezier(x1,y1,x2,y2)` se
  invierte con `(1−x2, 1−y2, 1−x1, 1−y1)`, así que de `(.2,.9,.3,1)` sale `(0,0,.8,.1)`;
- el velo tarda dos décimas de las tres, con una de retraso: al entrar aparece él primero
  y la hoja llega después, así que al salir se va el último;
- y la hoja se desvanece además de bajar, porque si no el último fotograma es la hoja a
  plena opacidad sobre un velo que ya no está, o sea un corte. Por simetría, la entrada
  gana el mismo desvanecido;
- sin movimiento (`prefers-reduced-motion`) se cruza solo la opacidad.

Esto no puede ser solo CSS: hay que esperar a que la animación termine antes de poner
`display: none`. Van dos funciones, `abrirHoja` y `cerrarHoja`, en el módulo común, y las
dieciséis llamadas sueltas que había repartidas por cuatro pantallas pasan por ellas. Si
reabres a media salida, manda la apertura y la hoja se queda.

### Dieciséis pulsables que no acusaban recibo

Tenían `cursor: pointer` y al tocarlos no pasaba **nada** hasta que respondía la pantalla:
`.tf-btn`, `.srow`, `.gal-tile`, `.ap-ico`, `.ap-color`, `.sheet-act`, los pasos del editor
de tarifa, los renglones de las listas de elegir… Es el mismo agujero que se tapó en las
pestañas en la 0.72: decir «te he oído» no depende de nadie y no tiene por qué esperar.

Agrupados por lo que se aprieta, que es lo que decide la respuesta:

| Qué es | Qué hace al apretar |
|---|---|
| Fichas, cuadros de color, botones pequeños, tarjetas | Se encoge, como si cediera bajo el dedo |
| Renglones de ancho completo | Se tiñe; encogerlos los despega de sus vecinos |
| Texto suelto haciendo de botón | Se apaga; es lo único que se puede hacer sin deformar la letra |

No entran tres, y por qué: las pestañas y los segmentados ya mueven la marca en
`pointerdown` y ese movimiento **es** el acuse —añadirle un encogido sería contarlo dos
veces—; el interruptor ya responde con su propia perilla; y el campo de fecha del selector
de periodo es un campo de escribir, no un botón.

### Interlínea propia en las cifras grandes

Cinco reglas —el total del resumen, el de la factura, el kWh de cada origen, el euro por
hora del flujo— heredaban el `1,5` del cuerpo, que es interlínea de párrafo. En un número
de 30 px eso son 45 px de caja para una línea, o sea quince píxeles de aire justo donde el
diseño quiere apretar. La interlínea va al revés que el tamaño; 1,1 es lo que ya usaban
las que sí la tenían.

### Lo que no se ha hecho, y por qué

- **Arrastrar la hoja para cerrarla.** El asa que dibujan tres hojas sigue sin ser
  agarrable. Queda pendiente; es el trabajo que traería muelles, traspaso de velocidad y
  proyección de inercia a la aplicación.
- **Rebote del gráfico en los bordes.** Al llegar al final del periodo se queda clavado en
  vez de resistir. Pendiente.
- **Háptica y sonido.** La Vibration API no existe en el WebKit de iOS, que es como se usa
  esto de verdad; sería código muerto en medio parque.

Banco nuevo, `tests/navegador/acuse.js`: que la hoja siga en pantalla a mitad de la salida,
que baje —no que encoja ni se vaya de lado—, que la curva sea la espejo, que acabe
escondida de verdad sin bloquear la pantalla, que reabrir a media salida gane, que los
trece pulsables respondan cada uno como le toca, y que las cifras grandes midan por debajo
de 1,3 de interlínea. Con el cierre instantáneo de antes, tres de esas comprobaciones
salen en rojo.

## 0.72.0

Cuatro arreglos salidos de auditar la aplicación contra la guía de diseño de Apple. Dos
de ellos destaparon animaciones que estaban **escritas y no corrían**, que es la clase de
fallo que sobrevive años porque nadie lo ve fallar: no hay error, simplemente no pasa
nada donde tenía que pasar algo.

### El acuse de recibo, al apretar y no al soltar

Marcar la pestaña elegida iba en `click`, que se dispara al **levantar** el dedo. Todo ese
módulo existe para que la marca no espere al servidor, y estaba esperando al final del
propio toque: en un toque tranquilo son 80-150 ms de nada, justo el hueco que hace dudar
de si ha entrado. Ahora va en `pointerdown`, más `keydown` con Enter o Espacio para quien
navega con teclado, que con `click` lo tenía gratis y con `pointerdown` se habría quedado
sin acuse.

### La barra de progreso, sin rehacer la maqueta en cada fotograma

La barra del ciclo de un electrodoméstico se rellenaba animando su **anchura**, y eso
obliga al navegador a recalcular la maqueta del documento en cada fotograma. Medido en la
propia aplicación, diez transiciones: por anchura, 300 pasadas de maqueta y 59 ms; con
`transform: scaleX`, **1 pasada y 0,2 ms**.

El escalado tenía una pega real, y por eso hacía falta medir antes de escribir: dentro del
relleno van los tramos de origen —sol, batería, red—, y un tramo diminuto lo sostenía un
mínimo de 2 px. Escalados al 20 %, esos 2 px son 0,4 px, o sea nada. El mínimo pasa a ser
`calc(2px / var(--p))`: se piden 10 px antes de escalar para que queden 2 después. Hay
banco nuevo que lo comprueba con un tramo del 0,6 % dentro de un ciclo al 10 %, y sin la
división mide 0,2 px.

La otra barra —la del resumen de energía— **se queda con la anchura, a propósito**. Sus
tramos son hermanos de flex, así que la posición de cada uno depende de la anchura del
anterior y escalar uno no mueve al siguiente; y son píldoras de 26 px con 7 px de radio,
que `scaleX(0,3)` convierte en rectángulos. Lo que se compraría son 0,2 ms de maqueta por
fotograma en un dibujo que se rehace cada 20 segundos. No compensa deformarlas.

### El interletraje, en proporción y no en píxeles

Trece declaraciones de `letter-spacing` iban en píxeles. Un titular de 30 px quiere
apretarse y una etiqueta de 11 px en versales quiere soltarse: eso es una proporción del
tamaño, no una distancia fija. En píxeles deja de serlo en cuanto el tamaño cambia —zoom
del navegador, preferencia de texto del teléfono—, y un titular al 200 % se queda con el
apretado de uno al 100 %. Convertidas dividiendo cada una por su propio tamaño, así que a
tamaño normal no se mueve nada: la mayor diferencia es de una centésima de píxel. Los
componentes ya lo hacían así.

### El fondo: una animación que no corría y otra que corría de más

Dos hallazgos, los dos comprobados en el navegador y no razonados:

**El cielo no se fundía.** Tenía escrito un `transition: background 1.2s`, y un degradado
solo se interpola con otro del mismo número de paradas: los cuatro momentos del día tienen
tres, cuatro, cuatro y tres. A los 300 ms de una transición de 1.200 el valor calculado ya
era el de destino y `getAnimations()` devolvía cero. El amanecer llevaba desde siempre
pegando un corte de plano. Ahora son cuatro capas que se cruzan por opacidad, igual que ya
hacían el sol y las estrellas de al lado.

**El velo sí se animaba, y era lo caro.** Al cambiar de pestaña, su desenfoque crecía de 0
a 34 px: desenfocar la pantalla entera otra vez en cada fotograma, con un radio distinto
cada vez, en el gesto más repetido de la aplicación. Ahora son dos velos superpuestos que
se cruzan por opacidad; el desenfoque se calcula a un único radio y lo que se mueve es la
composición. Las fotos de antes y después son idénticas píxel a píxel en los dos extremos.

De paso, el velo desenfocado tenía la propiedad sin prefijar: en el WebKit de la
aplicación de Home Assistant anterior a iOS 18 no se desenfocaba nada. Y ahora respeta
«reducir transparencia» —se queda el oscurecido, que es lo que hace legible el texto, y se
va el desenfoque, que es el efecto— y «reducir movimiento» en el cielo.

### Los gestos de los gráficos

La inercia que la guía pide para un arrastre **no se ha puesto, y a propósito**: el gesto
de un dedo sobre estos gráficos no desplaza el lienzo, mueve la selección al punto que hay
bajo el dedo. La inercia es de un desplazamiento: se suelta el dedo y el contenido sigue
por donde iba. Aquí eso sería soltar el dedo y ver cómo la selección se va del punto que
se acababa de elegir.

Lo que sí había eran dos defectos de verdad en ese mismo sitio:

- **La holgura era de 6 px y estaba escrita dos veces**, con la cifra copiada a mano en
  cada gráfico. A 6 px la dirección se decide con tan poco recorrido que manda el temblor
  de la mano: un dedo que va a bajar por la pantalla empieza casi siempre con dos o tres
  píxeles de lado, y si caen en horizontal, el gráfico se queda el gesto y la página no
  baja. Pasa a 10 px —la holgura con la que Apple separa un toque de un arrastre— y a
  vivir en un solo sitio, `components/gesto.js`.
- **El arrastre del eje corría a distinta velocidad en cada aparato.** Al llegar al borde
  con zoom, el eje avanzaba un 4 % **por evento**, y `pointermove` se dispara a la
  frecuencia de la pantalla: con el dedo exactamente igual de quieto, un iPad de 120 Hz
  movía el eje al doble de rápido que un móvil de 60. Ahora se mide con el reloj —un 240 %
  de la ventana por segundo, los mismos 4 % a 60 Hz— y se recorta a 100 ms por paso, para
  que volver de segundo plano no pegue un salto de todo el eje.

Banco nuevo (`tests/navegador/gesto.js`) que sujeta las dos cosas: la regla del anillo con
sus cuatro casos, que ninguno de los dos gráficos conserve su copia, y el eje recorrido
con el mismo tiempo y cuatro veces más eventos. Con el código de antes esa última da una
razón de 4,12; con el de ahora, 1,05.

## 0.71.0

### Seis glifos más de electrodoméstico

Pedidos por nombre: thermomix, tostadora, Alexa, plancha, aspiradora y
caldera/calentador. **Microondas ya estaba**, así que son seis y no siete. El catálogo
pasa de 58 a 64 glifos y el selector, de 17 a 23 iconos.

| Se ofrece como | El identificador es |
|---|---|
| Robot de cocina (Thermomix) | `robot-cocina` |
| Tostadora | `tostadora` |
| Altavoz inteligente (Alexa) | `altavoz` |
| Plancha | `plancha` |
| Aspiradora | `aspiradora` |
| Caldera o calentador | `caldera` |

El identificador es **genérico y la marca va en el rótulo**: quien busca su Thermomix la
reconoce por el nombre, y el glifo sigue valiendo para cualquier robot de cocina el día
que sea otro. Es el mismo criterio que con el coche, que se pidió como «Enyaq».

### Dibujar es mirar, no acertar a la primera

La regla de este set es que los glifos se distingan **por la forma**: el nombre solo
aparece en el rótulo al pasar por encima, así que dos cajas parecidas son dos iconos que
no se pueden usar a la vez. Se dibujaron, se pintaron a 44 px y al tamaño real de la fila
—21 px— y se miraron. **Dos de los seis no valían**:

- la tostadora, con las ranuras dentro del cuerpo, se leía como **un enchufe**; con el
  pan asomando por arriba no se puede leer como otra cosa;
- y la aspiradora de trineo —cápsula, dos ruedas y manguera— se leía como **unas gafas
  con rabo**. Es vertical, con la boquilla plana pegada al suelo.

También se probaron y descartaron un vaso con asa (era una taza de café), una tostadora
con banda de ranuras (una radio) y un bidón con ruedas (un carrito de la compra).

Del **robot de cocina** se dibujaron dos: el del pedestal —tapa, vaso y base con su
rueda de mandos— y una batidora de cintura estrecha. A mí la segunda me parecía más
legible a 21 px; se eligió la primera, y va la primera. Queda anotado en el código
porque es una **preferencia y no un defecto**: quien la vea escrita no debería
«arreglarla».

### Y una cifra del encabezado que ya no puede mentir

El comentario del sprite decía cuántos glifos van dibujados a mano, y se había quedado
viejo **las tres veces** que se han añadido. Ahora sale de `len(A_MANO)`: un encabezado
que miente sobre su propio fichero es peor que no tenerlo.

## 0.70.0

### La lista de electrodomésticos, por nombre y con el aro de la Home

Dos peticiones, y una tercera cosa que apareció al comprobarlas.

**Ordenados por nombre.** Iban en el orden en que se dieron de alta. Con dos o tres da
igual; con ocho, buscar «Lavadora» en una lista ordenada por antigüedad es leerla entera.
Se ordena en la pantalla y no en la configuración, que el orden de alta es un dato que no
hay por qué perder — y la Home ordena por otra cosa: allí manda lo que está en marcha y lo
que se puede mover, que es una decisión y no un índice.

**Y el aro verde de los encendidos**, el mismo que la Home. Literalmente el mismo: la
regla de CSS es una y sirve a las dos pantallas, y el dato (`on`) lo calcula el servidor
una vez y las dos lo leen. Decidirlo en la pantalla a partir de los vatios habría sido una
segunda definición de «encendido», y con eso vuelven las dos respuestas para el mismo
aparato en dos sitios.

### Y la nevera que decía «en reposo» con el aro puesto

Se vio en la primera captura después de poner el aro: la fila del frigorífico salía
rodeada de verde y a la vez diciendo «en reposo · aprendiendo su ciclo». Dos cosas
contradiciéndose a un centímetro, y las dos por lo mismo — el texto miraba `running`, que
es «tiene un ciclo abierto», y en una nevera eso es falso entre arranques del compresor.

Ahora la fila de un continuo dice **«encendida · 90 W · 0,54 kWh hoy»**: el estado sale del
mismo dato que el aro, y de un continuo no se habla de ciclos. Es lo que ya hacía su fila
en la Home y lo que la 0.68.0 arregló en el cierre del día. «Aprendiendo su ciclo» en una
nevera es una promesa que no se va a cumplir nunca.

### El banco que no había

`tests/navegador/ajustesap.js`. Esa pantalla —por la que se pasa a dar de alta un aparato
y a comprobar que el sensor es el correcto— no tenía ninguno. Comprueba el orden, que el
aro esté exactamente en los que el servidor dice encendidos, y que **ninguna fila se
contradiga**: nada rodeado de verde puede decir «en reposo». Compara contra `/api/live` y
no contra una lista escrita en el banco, que se quedaría vieja al cambiar la fixture.

## 0.69.0

### El término de energía llevaba los excedentes descontados dos veces

De un diagnóstico exacto: *«cuando pulso en la tarjeta de la tarifa, por un lado veo el
término de energía y por otro la compensación de excedentes. Esto es visualmente correcto
si no fuera porque al término de energía le has descontado ya los excedentes»*. Así era.
`subtotals.energy` era el término de energía **ya neto**, y debajo se restaba otra vez la
compensación.

Y al ir a arreglarlo apareció un segundo error en las mismas cinco líneas: **el impuesto
eléctrico estaba en dos partidas a la vez**, dentro de «Cargos y servicios» y dentro de
«Impuestos».

Los dos tiraban en direcciones contrarias —uno restaba de más, el otro sumaba de más— así
que el total de las cinco líneas quedaba plausible y ninguno saltaba a la vista. Sobre las
cifras del banco: las líneas sumaban 22,65 € en una factura de 25,54 €, y la diferencia
era exactamente la compensación menos el impuesto eléctrico.

Ahora las cinco partidas son **disjuntas y suman el total**:

| | |
|---|---|
| Término de energía | el **bruto**, como en el detalle de la factura |
| Término de potencia | igual |
| Cargos y servicios | sin el impuesto eléctrico |
| Compensación de excedentes | su propia partida, a restar |
| Impuestos | el impuesto eléctrico y el IVA |

Y la compensación sale ahora del mismo sitio que las demás líneas, así que con la
proyección puesta es la proyectada y no la acumulada.

### Y el banco que faltaba

`compute_bill` es el núcleo de la pantalla de Facturación y **no tenía banco ninguno**.
Por eso dos errores en un bloque de cinco líneas sobrevivieron a todas las versiones.
`tests/python/factura.py` comprueba ahora lo que nadie comprobaba: que los subtotales sean
disjuntos y sumen el total, que las líneas del detalle sumen ese mismo total —es la otra
vista de la misma factura—, y que la compensación no se pase del término de energía, que
lo dice la ley.

## 0.68.0

### Cuatro cosas que la aplicación decía y no eran

De un aviso con cuatro observaciones. Las cuatro tenían razón, y ninguna era la misma
causa.

### 1. «Mañana no habrá excedentes» y «carga la batería de noche»

*«Recomienda cargar la batería de noche cuando todos los días estoy cargando la batería
al 100 % sin problemas, y el pronóstico de sol de mañana es muy bueno.»* Y es el mismo
fallo dos veces: **«de mañana no se sabe nada» se estaba leyendo como «mañana no sobra
nada»**.

Bastantes integraciones solares publican solo el día en curso. A partir del anochecer no
hay curva de mañana, la ventana de mañana sale vacía, y:

- el planificador la tomaba por un día sin sol y aconsejaba **comprar de la red** energía
  que al día siguiente iba a llegar gratis — un consejo que cuesta dinero;
- y la tarjeta, en el estado «ventana cerrada», afirmaba «mañana no se espera excedente».

La distinción existía en el payload desde la 0.53 (`tomorrow_forecast`), y era esa rama de
la tarjeta la única que no la miraba — mientras el planificador no la recibía siquiera.
Ahora, sin saber qué trae mañana, no se aconseja comprar y la tarjeta dice que no hay
previsión.

### 2. El frigorífico «se ha usado en dos ciclos»

Una nevera no se usa dos veces: está puesta. Sus arranques de compresor los detecta el
mismo detector que aprende una lavadora, y la fila del cierre los contaba como usos sin
mirar la forma de uso configurada. En un continuo ya no se cuentan veces — lo que se
cuenta de él son kWh.

### 3. «El día más caro fue el 3 de agosto (0,00 €)»

*«Esto no tiene sentido. Si siempre fue cero, no hay un día más caro.»* Exacto: era el
máximo de una lista plana a cero, que siempre devuelve algo. Un aparato que va entero con
sol es justo el caso. Ahora, si ningún día costó nada, no se nombra ninguno.

### 4. El término de energía y el desglose de la misma pantalla

Aquí había dos módulos calculando lo mismo por caminos distintos —`billing` sobre la serie
horaria de lo importado, `desglose` sobre el reparto hora a hora— y **nada comprobaba que
llegaran al mismo número**. Ahora sí: `tests/python/desglose.py` §10 los enfrenta sobre el
mismo periodo y la misma tarifa. Coinciden (1,06 € por los dos caminos), así que la cuenta
no es el problema.

Lo que sí estaba mal es la tarjeta: con la **proyección** puesta, el titular era la factura
proyectada y las líneas de debajo —término de energía incluido— el acumulado, sin decirlo.
Cuatro cifras que no suman a la quinta en la misma tarjeta, y la explicación más probable
de que el término de energía no cuadrara con un desglose que siempre es del periodo
transcurrido. Ahora los subtotales son los de lo que se está enseñando.

## 0.67.0

### «100 % con sol» y «0,02 € de más» ya no pueden salir juntos

De un aviso: *«el resumen del día dice que la lavadora ha usado 100 % con sol y me pone
que ha gastado 0,02 € de más que si lo hubiera puesto a las 14h. Si ya fue todo sol, no
es ya gratis?»*. Sí lo es. Y las dos cifras eran ciertas a la vez, lo que quiere decir
que había **tres** cosas mal, no una.

### 1. El modelo aplanaba el ciclo

Para colocar una lavadora en otra hora, el óptimo del día la trataba como un
rectángulo: su energía repartida por igual entre sus horas. Pero una lavadora carga al
principio —el calentamiento del agua— y baja al final:

| | 12:00 | 13:00 | 14:00 |
|---|---|---|---|
| lo que gastó (medido) | 0,90 kWh | 0,20 | 0,05 |
| el sobrante de esa hora | 2,00 kWh | 0,50 | 0,10 |
| aplanado a la media | 0,38 kWh | 0,38 | 0,38 |

Con la forma medida cada hora cabe en su sobrante y el ciclo costó **cero**. Aplanado, a
las 14:00 no caben 0,38 en 0,10 y el modelo cobraba unos céntimos que la casa **nunca
pagó** — y luego colocaba ese mismo rectángulo donde sí cabía y publicaba la diferencia
como un sobrecoste.

Ahora la forma medida **se desliza entera**, sin aplanarla. Arregla las dos hipótesis a
la vez y con una sola cuenta: si el ciclo fue gratis donde estuvo, el «como se hizo» sale
cero y no hay nada que restar. Y de paso se retira una de las salvedades del modelo: lo
único que sigue suponiéndose es que el programa gasta lo mismo a cualquier hora, y eso en
una lavadora es verdad.

### 2. El umbral de cinco céntimos estaba escrito y no se usaba

`MIN_EXTRA_EUR = 0.05` llevaba desde la 0.61.0 con su porqué al lado —«señalar dos
céntimos de un día que ya pasó es hacerle perder el tiempo a alguien»— y **no se leía en
ningún sitio**: la tarjeta llevaba el 0,05 a mano para el titular del día y un `> 0` para
las filas. Así que una fila de dos céntimos traía su «mejor a las 14:00».

Ahora la búsqueda sigue siendo fina —el turno se ordena con la diferencia exacta— y lo
que se corta es el **consejo**, que es lo que se lee. Y el titular del día pasa a ser la
suma de las filas publicadas, no la resta de los dos totales: si no, diría una cifra que
ninguna fila explica.

### 3. Y el «% con sol» no medía el sol

Salía del **solape del ciclo con la ventana**, y la ventana se calcula con la previsión
solar y el consumo **típico** de la casa. Un día en que la casa gastó más de lo normal, el
ciclo seguía «dentro» aunque parte la pusiera la red — y la tarjeta decía «100 % con sol»
igual. Ahora sale del reparto **medido** de esas horas, con la misma atribución que usa el
desglose de la factura, así que las dos pantallas no pueden discrepar del mismo aparato.
Cada fila publica además lo que puso la batería y lo que puso la red, para que no haya que
restar.

Sin reparto —un payload viejo— se cae al solape, que es lo que había.

### Y una cosa que quitamos

**armv7.** El add-on declaraba las tres arquitecturas y Supervisor tiene la de 32 bits
deprecada. Quedan `aarch64` y `amd64`.

## 0.66.0

### La ventana dice cuánto puede moverse su hora

En la 0.61.0 el perfil de consumo empezó a medir **cuánto se equivoca**, fuera de
muestra, y ese número se quedó donde nació: en la letra pequeña de Ajustes, en vatios.
Pero la ventana no habla de vatios. Habla de horas — «tu ventana abre a las 11:40» — y
300 W no dicen nada sobre las 11:40 hasta que se dividen por la **pendiente con la que la
curva del sol cruza tu consumo** en ese punto:

    minutos = error del consumo típico (W) ÷ pendiente del cruce (W/h) × 60

Y ahí está lo interesante: con el mismo perfil y el mismo error, el resultado cambia de
un día a otro por un factor de quince.

| El día | Pendiente del cruce | 300 W de error son |
|---|---|---|
| mañana clara | 3.000 W/h | **5 min** — la hora es fina |
| día de nubes | 200 W/h | **1 h 30 min** |

La tarjeta daba las dos con el mismo aplomo. Ahora, cuando la holgura pasa del cuarto de
hora, lo dice: *«Esa hora puede irse ±30 min: es lo que la mueve lo que varía tu
consumo.»* Y si pasa de los tres cuartos, que hoy esa hora no vale y por qué — el sol
cruza el consumo casi de lado, así que un poco más o menos de gasto la mueve mucho.

### Y por debajo del cuarto de hora se calla

A propósito. Una mañana clara cruza subiendo tres kilovatios por hora casi todos los
días, así que decirlo entonces sería una coletilla fija cuyo contenido es «la hora está
bien» — exactamente de lo que ya se quejó esta tarjeta una vez: *«aburre ver siempre lo
mismo»*. Además la previsión llega cada media hora, así que anunciar «±6 min» sería
precisión inventada por el otro lado.

Tampoco se dice nada cuando no se puede saber, y son tres casos distintos que antes no
existían y ahora hay que separar: sin histórico para apartar un día no hay error medido;
un extremo de la ventana que no es un cruce sino el borde de la previsión —un día que
amanece ya generando de sobra— no tiene pendiente; y una pendiente de cero daría holgura
infinita, que no es una cifra.

### Lo que esta cifra no incluye

**El error del sol.** La previsión solar tiene el suyo —para eso están el sesgo del tejado
y el desvío del día— y no se publica como una desviación que se pueda sumar a esta. Así
que la holgura es la parte de la duda que pone **el consumo de la casa**, no toda la duda.
Está dicho en la documentación y en el código, porque es la clase de cosa que se lee como
«±30 min y ya está».

Por dentro, la geometría y el error siguen separados: `series.free_window` publica la
pendiente de cada corte, que es lo único que sabe —está en el mismo par de puntos con el
que interpola la hora—, y quien conoce el error del perfil hace la división. Así no hay
dos sitios calculando el mismo cruce.

## 0.65.0

### La batería entra en «lo que había sobre la mesa»

La tarjeta del cierre del día dice cuánto costó de más poner los electrodomésticos a la
hora a la que se pusieron. Su cuenta **no tenía batería dentro**, y eso lo advertía la
propia tarjeta — pero una advertencia no arregla una cifra mal. El sobrante de mediodía
no se tira: se guarda. Una lavadora movida al sol no se ahorra el kilovatio entero de la
noche, porque ese kilovatio la batería ya lo estaba guardando para la noche.

Cuánto se equivocaba, contra una simulación exacta de la batería hora a hora sobre el
mismo día y el mismo aparato:

| El día | Lo cierto | Lo que se publicaba |
|---|---|---|
| la batería se vació y entró la red | 0,40 € de más | 0,60 € |
| a la batería le sobró energía | **0,00 €** | 0,60 € |

La segunda línea es la grave: el aparato **ya estaba en su mejor hueco** —moverlo al sol
no habría cambiado un céntimo— y la tarjeta le señalaba un sobrecoste de sesenta
céntimos. Un consejo inventado sobre un día que se hizo bien.

Ahora el modelo parte cada hora en cuatro escalones, y el precio de cada uno es lo que
ese kilovatio le quita a otro sitio:

1. **lo que se vertía** — sale gratis: no le quita nada a nadie;
2. **lo que se guardaba** — cuesta la ida y vuelta de la batería, porque el kilovatio que
   no entra es uno que luego no sale;
3. **lo que la batería entregó a esa hora** — cuesta lo que valía su kilovatio, y **solo
   hasta lo que entregó**: pasado ese tope no consta que pudiera dar más. Sin ese tope,
   un coche colocado a las tres de la mañana se llevaba gratis diez kilovatios de una
   batería que a esa hora dio uno y medio;
4. **la red** — lo que quede, al precio de la hora.

No van del más barato al más caro: van en el orden en que la instalación los usa, que es
un orden físico y no una elección.

### Y lo que decide entre las dos líneas de la tabla

**Si la batería se llegó a vaciar.** Si llegó a la mañana siguiente con energía sin
gastar, un kilovatio suyo no valía nada ese día y el segundo escalón sale gratis; si se
quedó vacía y la red tomó el relevo, cada kilovatio que no entró hubo que comprarlo. Se
mira sin estado de carga y sin un sensor nuevo: si la casa importó **después de la última
hora en que la batería estaba cargando**.

Sin esa pregunta el modelo se equivocaba de signo, no de magnitud. Fue el fallo de mi
primera versión de esto, y lo cazó una simulación exacta puesta en el banco al lado del
modelo — a mano no se deriva una cuenta con estado, porque el estado es justo lo que se
olvida.

### Un resultado que parece un error y no lo es

En un día con la batería atada y una tarifa con madrugada barata, el modelo puede decir
que **las tres de la mañana era mejor hora que el mediodía**. Y tiene razón: la batería
ya convertía ese sol en energía de la noche, así que consumirlo directo solo se ahorra el
10 % de la ida y vuelta —tres céntimos— frente a los veinte de diferencia entre tarifas.
La simulación exacta lo confirma (3,225 € por la madrugada contra 3,565 € por el sol), y
está en el banco justamente para que nadie «corrija» el modelo para que nunca salga de
noche.

### Lo que la tarjeta dice ahora

La coletilla decía «la batería no entra en esta cuenta». Ahora entra, y lo dice. Y
cuando el sobrecoste baja de cinco céntimos **porque el sol que sobraba se guardó**, se
dice también: sin eso, «no había nada que ganar» se lee como que el día salió flojo, y
fue justo lo contrario.

Una cifra que ya no se publica con ese nombre: `grid_kwh` por fila pasa a `paid_kwh`. Con
la batería dentro, lo que un aparato no cubrió con el sobrante se lo dieron la red y la
batería a medias, y llamar red a la mitad que salió de la batería sería la clase de cifra
que este proyecto lleva quitando.

## 0.64.0

### Con InfluxDB, ciclos de verdad en vez de tramos de hora

De una corrección a la 0.63.0: *«HA guarda un mes pero ojo que tb tenemos el influx. Si
un usuario usa influx, puedes hacer análisis más profundos»*. Y es exacto — el desglose
contaba tramos de hora porque las estadísticas de Home Assistant es lo único que guardan
de un mes entero, pero quien tenga InfluxDB tiene **meses de datos finos**, y ahí un ciclo
es un ciclo.

Ahora, con InfluxDB configurado, la fila abierta dice «**5 ciclos de 1 h 50 min de
media**» en vez de «5 tramos», y con la hora a la que se arrancan — que es la del botón,
no la del consumo, y por tanto la accionable. Sin InfluxDB se queda como estaba, y **la
tarjeta dice cuál de las dos cosas está contando**: llamarlos igual sería prometer con
unos datos lo que solo sostienen los otros.

| | Resolución de un mes | Qué se cuenta |
|---|---|---|
| Estadísticas de Home Assistant | la hora | tramos: horas seguidas con consumo |
| InfluxDB | cuarto de hora | ciclos, con su duración típica |

### Un solo detector, con el paso abierto

El detector de ciclos es **el mismo** que aprende los de la Home. Escribir un segundo
habría hecho que un ciclo en el desglose y un ciclo en la Home fueran cosas distintas, que
es el defecto que este proyecto lleva corrigiendo toda la vida. Lo que se ha abierto es su
paso, y con él dos constantes que estaban **contadas en muestras**:

- la tolerancia al reposo dentro de un ciclo (un lavavajillas baja entre lavado y secado);
- y la duración mínima para que algo cuente como ciclo.

Contadas en muestras valían quince minutos con un paso y una hora con otro. Ahora van en
minutos, y con el paso por defecto el resultado es idéntico — los bancos de ciclos y de
forma de uso lo confirman sin tocar una cifra.

Cuarto de hora y no cinco minutos: un mes a cinco son 8.640 puntos por aparato y no compra
nada. Y **lo que cuesta el paso grueso está medido**, no supuesto: sobre una lavadora de
dos horas con una pausa de diez minutos, el paso fino clava la integral (3,30 kWh) y el de
cuarto de hora se queda en 3,15 — un 4,5 % corto, y corto y no largo, porque la pausa cae
dentro de una ventana cuya media baja. Es el precio de poder recorrer un mes entero, y el
banco lo deja escrito con el número.

### Y una función que estaba dos veces

`dur()` —«2 h 10 min», redondeado a cinco minutos— estaba escrita **idéntica, carácter por
carácter**, en la Home y en el editor de electrodomésticos, y el desglose iba a ser la
tercera copia. Ahora vive en `core/format.js` y las tres la importan.

### Un fallo de mi propia comprobación

Al mover la tolerancia a minutos comprobé con `grep -c '_HUECO_TOLERADO\b'` que no
quedaban usos, y salió 1 — la definición. Pero `\b` casa también dentro de
`_HUECO_TOLERADO_MIN`, así que el recuento escondía un segundo uso en `en_marcha`, que
multiplicaba muestras por el paso para llegar a los mismos quince minutos. Lo cazó la
regresión con un `NameError`; la comprobación estaba mal, no el código.

## 0.63.0

### Al abrir una fila del desglose, lo que la suma del mes esconde

Una fila que dice «lavavajillas · 7,2 kWh · 1,19 €» no deja hacer nada con la
información. Lo que se puede cambiar es **la hora**, y para verla hay que abrirla:

- cuántos **días** se usó y en cuántos **tramos**;
- qué **día salió más caro**, que es donde se ve si fue una vez o es la costumbre;
- y una **tira de 24 barras** con lo que gastó a cada hora del día.

La tira es la pieza accionable de toda la pantalla. Con los datos del banco, el
lavavajillas tiene todo su bulto en las 21 y 22 h: eso se ve de un golpe, y en el total
del mes no se veía.

### Cada barra va partida por origen

Primero la escribí solo con el «cuándo», y al mirarla salió que era media respuesta: dos
barras iguales a las 13 y a las 22 dicen lo mismo y no cuestan lo mismo. Ahora cada barra
lleva en ámbar lo que puso el sol o la batería y en azul lo comprado, con la fracción del
reparto de esa hora —la misma que usa la atribución de la fila, no una segunda cuenta—.

De paso, la tira lleva línea de base: sin ella las horas vacías se leían como una tira a
medio pintar en vez de como «aquí no se usó».

### «Tramos», no «ciclos», y eso es una decisión

A esta resolución —la hora, que es lo que Home Assistant guarda de un mes entero— **no se
puede contar ciclos**. Dos lavados en la misma hora son un tramo, y uno que cruza una hora
sin gastar son dos. El recuento se publica con el nombre de lo que es, y la nota al pie lo
dice, en vez de llamarlos ciclos y publicar una cifra que estos datos no sostienen.

Los ciclos de verdad se aprenden con estadísticas de cinco minutos, que el recorder guarda
unos diez días: sirven para la Home, no para un mes.

### Y «el resto de la casa» no se abre

No es algo que se pueda mover a otra hora, así que no tiene detalle que enseñar. El banco
lo comprueba, porque una fila que se abre para no decir nada es peor que una que no se abre.

## 0.62.0

### «De más» y no «ahorro»

De una corrección a la 0.61.0: *«la cifra de ahorro por electrodoméstico no debería ser
negativa?»*. Ninguna de las dos, pero el problema era real: **ahorrar es prospectivo y
ese día ya pasó**, así que el «↑ mejor a las 10:00 (+0,39 €)» que salió se lee como
dinero que entró, cuando es dinero que salió. Negativa tampoco, porque no se resta de
ningún saldo: es un **sobrecoste ya pagado**.

La fila pasa a decirlo con el importe delante y la hora como el porqué, que es lo que se
pedía:

```
● Lavavajillas ▬▭▭▭ 2,4 kWh · 12 % con sol
  ↑ 0,39 € de más · mejor a las 10:00
```

Y el pie: «entre todos, **0,58 € de más** de lo que la misma energía habría costado en su
hueco». El campo del payload pasa de `saving_eur` a `extra_eur`, y el banco comprueba que
no quede ninguna clave con «saving» dentro — para que el nombre no arrastre otra vez el
significado viejo.

### El perfil de la casa ya dice cuánto se equivoca

Era lo que quedaba apuntado del forecaster de EMHASS en la 0.61.0, y era un hueco raro: la
previsión solar aprende su sesgo y publica su desvío del día, mientras el perfil de la casa
publicaba de dónde sale, cuántos días lleva y su mínimo y su máximo, pero **nada sobre
cuánto acierta**. Con la ventana de energía gratis calculada a partir de él, no había forma
de saber cuánto fiarse de la hora que propone.

Ahora publica su **error absoluto medio** —lo que EMHASS reporta como MAE— y en Ajustes se
lee en una frase: «se desvía 67 W de media (9 % del consumo del día), medido contra el 4 de
agosto, que es un día que este cálculo no había visto».

**Medido fuera de muestra, que es la única forma de que el número signifique algo.** Se
aparta el último día completo del histórico, se construye un perfil con lo demás y se
compara contra el día apartado. Medirlo contra los mismos datos con que se construyó daría
un error bonito y falso: la mediana pasa por medio de sus propios puntos por definición. Y
no es una diferencia teórica — está medida. Con el banco de cinco días (cuatro a 500 W y el
último a 800), fuera de muestra el error son **300 W**, los que salen a mano; midiéndolo
por dentro, **60 W**. Cinco veces menos, y ninguno de los dos números habría dado un aviso.

Dos detalles que también son decisiones:

- **El porcentaje es del consumo medio del día, no punto a punto.** A las cuatro de la
  mañana la casa gasta 90 W y equivocarse en 45 es un 50 % que no dice nada de nada.
- **Con menos de tres días no se publica.** Con dos, el «día apartado» es la mitad del
  histórico y el perfil que queda no se parece al que decide la ventana. Callar es más
  honesto que dar un número que mide otra cosa.

Y el perfil que **se usa** sigue construido con todo el histórico: la desviación es una
medida *sobre* un perfil reducido, no un cambio en el que decide la ventana. El banco lo
comprueba, porque confundir las dos cosas habría empeorado la ventana para poder medirla.

## 0.61.0

### Lo que había sobre la mesa, en el resumen del final del día

Es el «perfect optimization» de EMHASS traído a lo que Vatia puede afirmar. Aquella
resuelve el óptimo del día para **mandar** consignas a los interruptores; esto lo
calcula sobre un día **ya cerrado**, con el sol, el consumo y los precios que de verdad
hubo, y no manda nada: mide.

Y va en el **resumen del final del día**, colgado de «Lo que se puso hoy», porque es su
momento: la tarjeta del cierre sale sola al anochecer, cuando el sol ya se ha puesto,
el día está hecho y lo único que queda es contarlo. Cada ciclo dice ahí mismo a qué
hora habría salido más barato, y el pie resume lo que había en total.

Eso trae además una ventaja que no se buscaba: **no cuesta ninguna consulta**. Todo lo
que la cuenta necesita —el reparto hora a hora del día, lo que cada aparato gastó en
cada hora (`today_by_hour`, que ya se publicaba) y los precios— estaba en el mismo
payload con el que se dibuja la Home. El endpoint que se había escrito para esto se
retira, con su import: un endpoint que nadie llama es peso muerto.

Y esa es toda la diferencia que importa. Un plan del día que viene depende de una
previsión, y la previsión falla —el propio sesgo medido baja al 0,85 en días que se
desvían—. Un repaso de ayer no depende de ninguna. Por eso se puede decir sin
condicionales, y por eso cierra el bucle que la aplicación tenía abierto desde el
principio: prometía «gratis a las 13:00» y nunca volvía a mirar si salió gratis.

Con los datos del banco: el lavavajillas dice «↑ mejor a las 10:00 (+0,39 €)» debajo de
su fila, el coche «↑ mejor a las 11:00 (+0,19 €)», el horno no dice nada porque ya
estaba donde tocaba, y el pie remata: *«puestos en su mejor hueco te habrías ahorrado
0,58 €»*.

Solo hablan las filas que ganaban algo. Poner «ya era su mejor hueco» en cinco filas
seguidas sería ruido, y además el pie ya lo resume — cuando no había nada que ganar lo
dice él: «aprovechaste el sol prácticamente todo lo que se podía».

### Se publica una diferencia, y eso es deliberado

El modelo de esta tarjeta es más simple que el del desglose de la factura: **no tiene
batería**. Publicar «tus aparatos costaron X» pondría dos cifras del mismo día en dos
pantallas, que es exactamente el defecto que esta aplicación lleva corrigiendo desde la
0.48 —y que la 0.59.1 volvió a encontrar en la nevera—. Así que se publica lo único que
este modelo sostiene: **cuánto había que ganar moviéndolos**, calculado dos veces con la
misma cuenta y restado.

El banco lo vigila: comprueba que ninguna clave del payload se pueda leer como una
factura, y en la pantalla, que en ningún sitio se afirme lo que se gastó.

### Dos defectos que salieron de mirar la respuesta, no de planearla

**Le proponía una hora mejor a la nevera.** Un continuo no tiene hora que elegir —eso
se decidió en la 0.52.0— y ahí estaba, con «mejor a las 04:00». Ahora solo entran los
movibles, y el filtro va **antes de restar**: si la nevera se descontara del consumo de
la casa y luego no se colocara, su energía se perdería del modelo. Quedándose fuera cae
donde le toca, en el suelo que no se puede mover.

**Un empate movía el aparato.** El horno decía «mejor a las 12:00» habiéndose puesto a las 13:00
con 0,00 € de ahorro, porque las dos horas costaban lo mismo y el barrido empieza por la
primera. Ahora se parte de la hora a la que se puso de verdad y solo se cambia por una
mejora estricta —con medio céntimo de margen, que por debajo de ahí es el redondeo del
reparto horario y no un hueco mejor—. De paso, «ya era su mejor hueco» puede decirse,
que antes no salía nunca.

### Y un tercero que cazó la regresión, no yo

Al mover la cuenta al payload de la Home, las dos piezas que necesita —el reparto
horario y los precios— salen de un bloque que **solo corre si hay aparatos
configurados**. Sin ellos quedaban sin asignar y `/api/live` se caía entero con un
`UnboundLocalError`: la Home en blanco, no solo esta tarjeta. Con la fixture que tiene
aparatos no se veía; la regresión levanta instancias que no los tienen y ahí salió.

### Del forecaster de EMHASS: casi nada, y por buenas razones

Se miró también [su forecaster de aprendizaje automático](https://emhass.readthedocs.io/en/latest/mlforecaster.html)
—lags autorregresivos, variables de calendario, doce regresores de scikit-learn y
ajuste bayesiano con optuna— y la conclusión honesta es que **lo que propone ya está
hecho, más simple**:

- Las **variables de calendario** que su modelo aprende, el perfil de la casa ya las
  tiene por construcción: se agrupa por `(laborable o fin de semana, hora)` con
  mediana, y con respaldos al otro tipo de día y a las horas de al lado. Fui a añadir
  el día de la semana y ya estaba.
- El **horizonte largo** juega en nuestra contra, no a favor: su propia documentación
  avisa de que un modelo recursivo multipaso acumula error a 24 h o más, que es
  justo nuestro horizonte. Una mediana no acumula nada.
- Y **doce regresores con ajuste bayesiano** son `scikit-learn` + `optuna` dentro de un
  add-on que hoy es FastAPI y JavaScript vendorizado, con ejecuciones de tuning de
  quince a veinte minutos que su documentación llama «computing intense».

Lo único que sí falta de esa página, y queda apuntado: **el perfil de la casa no mide su
propio error**. La previsión solar sí aprende su sesgo y publica su desvío del día; el
perfil publica de dónde sale, cuántos días lleva y su mínimo y su máximo, pero nada
sobre cuánto se equivoca. Un backtest con su error medio —lo que EMHASS reporta como
MAE— diría cuánto hay que fiarse del plan, y hoy no hay forma de saberlo.

## 0.60.0

### El sol de una hora es uno

De una pregunta sobre [el modelo de EMHASS](https://emhass.readthedocs.io/en/latest/advanced_math_model.html),
que resuelve todas las cargas contra un **único balance de potencia**. Comparándolo
con lo nuestro salió que ahí faltaba algo, y no en abstracto: cada aparato buscaba su
hora **como si estuviera solo en la casa**. `simular` recibe la potencia de uno y el
perfil de la casa, y no sabe que hay otros dos a los que se les está recomendando la
misma hora.

Medido, con tres aparatos de 2 kW y un tejado que da 2,6 kW de sobrante:

```
Aparato 1: mejor 12:00 · 2.00 kWh de sol (100 %) · 0.000 €
Aparato 2: mejor 12:00 · 2.00 kWh de sol (100 %) · 0.000 €
Aparato 3: mejor 12:00 · 2.00 kWh de sol (100 %) · 0.000 €

Sol prometido por las filas: 6,00 kWh
Sobrante del tejado:         2,30 kWh en esa hora  → 2,6 veces
«Ahorras … esperando»:       1,08 € que no existían
```

Si seguías los tres consejos, ninguno cumplía. Es la misma enfermedad que ya se
corrigió dos veces —dos cuentas del mismo instante que se desmienten— pero entre filas
de una tarjeta en vez de entre tarjetas.

Ahora el plan las coloca **por turnos**: lo que está en marcha aparta su sol primero
—no es una hipótesis, está gastando—, y los movibles van después, el que más se ahorra
primero, buscando cada uno contra el sobrante que de verdad queda. Un fijo no reserva
nada, porque su cifra no es un plan sino un precio de «si lo pones ahora».

Con las mismas cifras de arriba y un tejado estrecho, las tres filas pasan a 13:30 al
100 %, 14:30 al 80 % y 12:30 al 76 %: 5,12 kWh de sol prometido sobre los 5,76 que hay.
Cabe, y a los que llegan tarde se les dice que no les toca todo el sol en vez de
prometérselo.

### Y por qué tu lavadora va a las 14:00 y no a las 13:30

Se dice, con la hora que habría tenido y quién tiene el hueco: «la Lavadora iría a las
13:30, pero el Coche ya tiene ese hueco». Sin eso, la hora recomendada cambia de un día
para otro y en la tarjeta no hay nada que lo explique — el tipo de cifra que parece un
error del programa.

Va en la nota de la tarjeta y no en la fila, por lo que ya se pidió una vez: las filas
tenían «mucha información larga y pequeña», y esto no es un dato de la fila sino del
reparto.

El primer intento publicaba «con quién comparte el sol», y contestaba a la pregunta que
no era: el turno casi nunca deja dos ciclos solapados —los separa—, así que salía vacío
justo en el caso que hay que explicar.

### El turno no baila, y eso vale más que el último céntimo

La primera versión recalculaba la ganancia de todos en cada vuelta. Sale algo mejor y
cuesta n² planes: **122 ms con ocho aparatos** en un endpoint que se pide cada veinte
segundos. Con dos pasadas son 2n y **43 ms**, y con un solo aparato en la casa —el caso
más común— vuelve a costar exactamente lo que costaba antes: 2,1 ms.

Pero el motivo de fondo no es el coste. Ordenar el turno por la ganancia recalculada
hace que dos refrescos seguidos puedan cambiar el orden, y con él las horas de la
tarjeta entera, porque la previsión se ha movido un poco. **Un plan que cambia solo
mientras lo miras no se puede seguir.**

### Qué se ha tomado de EMHASS y qué no

Se ha tomado la idea que arreglaba algo: el balance compartido. **No se ha tomado el
solver.** Un MILP con `pulp` y CBC compra los últimos puntos de optimalidad sobre una
previsión que trae mucho más error que el hueco que cierra —el propio sesgo medido baja
al 0,85 en días que se desvían—, y además produce consignas para accionar
interruptores. Vatia aconseja y no acciona: un óptimo que dice «lavadora de 13:35 a
15:05» está bien como consigna y es inservible como consejo humano.

Tampoco se ha tocado la batería como variable de decisión: en un Sungrow la prioridad
la manda el inversor —casa primero y luego llenar al 100 %— y Vatia lo **modela**
deliberadamente en vez de mandarlo.

### Lo que esto no arregla, dicho

El perfil de la casa es la **mediana** de esa hora, así que ya contiene a los aparatos
en las horas en que suelen ponerse. Separarlo pediría un histórico por aparato dentro
del perfil, que no está. Lo que se corrige es lo que no admite dudas: dos aparatos no
pueden llevarse el mismo kilovatio.

## 0.59.1

### Los euros de la nevera eran siete veces los de verdad

De una pregunta: *«¿qué significan los euros que salen junto al congelador o al
frigorífico? Me aparece que se alimentan solo de solar pero hay un coste»*. Medido en
la nevera del banco: 0,639 kWh en el día —44 % sol, 46 % batería, 10 % red—, coste
real **0,01 €** y en pantalla **0,07 €**. Y las dos cifras salían del mismo payload.

Eran tres errores, y los tres de tratar el pasado como si fuera una hipótesis:

1. **La cuenta estaba hecha y se tiraba.** La atribución ya devuelve el coste: hora a
   hora, cada hora a su precio, cobrando solo la red. La etiqueta lo ignoraba y
   multiplicaba otra vez.
2. **Al precio de ahora.** Lo que la nevera gastó a las tres de la mañana no cuesta lo
   que cuesta el kilovatio de este momento. Es exactamente el «kWh × precio medio» que
   el desglose de la factura de la 0.59.0 existe para no hacer, en la pantalla de al
   lado.
3. **Se cobraba la batería.** Y aquí es donde la etiqueta tenía razón *para lo que se
   escribió*: si pones la lavadora ahora, la batería que se coma la compras esta
   noche. Pero esto ya pasó. Esa batería se llenó antes —del sol, casi siempre—, y si
   la llenó la red, ese dinero ya está contado en la hora en que se compró. Cobrarlo
   otra vez al gastarlo es contarlo dos veces.

Ahora hay **dos etiquetas y no una**, porque hay dos preguntas: lo que costaría poner
un ciclo (una hipótesis, donde la batería sí se cobra) y lo que ya ha costado lo que
está gastado (medido y atribuido, donde no). Un continuo que tira del sol y de lo que
había guardado sale **«Gratis»**, y eso no es un adorno: a esa energía no le
corresponde ni un céntimo de esta factura. Es además la convención que ya seguía el
desglose de la factura, así que las dos pantallas dicen por fin lo mismo.

### Y la barra escondía justo lo que costaba dinero

Los tramos por debajo del **4 %** no se dibujaban, así que una nevera al 98,5 % de sol
y 1,5 % de red pintaba una barra ámbar entera y a la vez enseñaba euros: parecía cobrar
por el sol. Era la mitad visual de la misma queja.

Ahora se dibuja todo lo que existe, y a los tramos diminutos los sostiene un mínimo de
2 px. Va como mínimo de flex y no como anchura: así el tramo grande cede esos dos
píxeles en vez de que la barra desborde el carril, que con `overflow: hidden` habría
recortado **justo el tramo pequeño** —la red va al final— y no habría arreglado nada.

### Un banco que no habría visto ninguno de los dos

Los dos arreglos se han comprobado reventándolos, y de ahí salieron dos huecos:

- El banco de navegador **inyecta el plan entero, veredicto incluido**, así que con el
  fallo puesto de vuelta seguía en verde: comprueba que la pantalla pinte lo que se le
  da, no que el servidor elija bien. El cableado se comprueba ahora contra el payload
  de verdad, en `aparatos.py`, y con el fallo de vuelta salen dos rojos.
- El primer caso que escribí para la barra usaba un tramo del 1,5 %, que a esa anchura
  ya son 2,7 px: **salía verde sin el mínimo**. Las cifras son ahora las de un coche
  cargando —10 kWh con 0,06 de la red, un 0,6 % que sin el mínimo mide 1,06 px— que es
  donde el arreglo hace algo y donde el tramo escondido sí cuesta dinero.

## 0.59.0

### Quién se ha gastado la factura

La comparativa contesta *cuánto* cuesta el ciclo con cada tarifa. Esta tarjeta
contesta la siguiente pregunta, que es la que uno se hace mirándola: **de eso, qué
parte es de cada cosa**. Una fila por electrodoméstico medido, con la energía, de
dónde salió y lo que costó.

Contestarla bien tenía tres condiciones, y las tres estaban en el enunciado desde
que se aplazó esta pantalla:

**Está «el resto de la casa».** Un desglose que solo enseña los enchufes medidos
deja fuera casi todo —la cocina, las luces, la bomba de calor— y quien lo mira
concluye que la aplicación no sabe de dónde sale su dinero. El resto se calcula
como una **resta**: el consumo de la casa esa hora menos lo que sumaron los
aparatos. No se estima, sale de lo que ya está medido.

**Cuadra por construcción, no por suerte.** Precisamente por ser una resta, las
filas suman el total. La identidad que se mantiene, y que el banco comprueba
reventándola de cuatro maneras distintas:

    Σ red(aparatos) + red(el resto) + red→batería + sin asignar = energía importada

**El coste va por origen, no por kWh × precio medio.** Cada hora se reparte con su
origen y su precio, y solo se cobra lo que salió de la red. Un horno de mediodía
puede gastar más kilovatios que la lavadora de la noche y costar cero; a prorrata
de los kWh los dos pagarían lo mismo, y eso borra el consejo que da toda la
aplicación. Es la misma atribución que ya hacía la Home con lo que lleva hoy una
nevera —de hecho es literalmente la misma función—, aplicada al ciclo entero.

### Y una cuarta cosa, sin la que el desglose sumaría siempre de menos

**La factura no cobra lo que la casa consumió de la red: cobra lo importado.** No
es lo mismo, y la diferencia tiene nombre: los kilovatios que la red metió en la
batería de madrugada. Están en la factura y ningún aparato los consumió a esa hora
—se gastarán más tarde, puede que otro día, y entonces salen como batería en las
demás filas—. Van en su propia fila.

Y otra fila, **«Sin asignar»**, para cuando el contador de la casa marca menos de lo
que la red le entregó. Podría no aparecer nunca y estaría bien; lo que no puede
pasar es que ese sobrante se reparta entre las demás filas para que la tabla parezca
limpia. Si sobra energía comprada que el reparto no coloca, se dice.

### Dos decisiones de la tarjeta que salieron de mirarla

**La barra es energía y no dinero.** Se probaron los euros, que era lo que parecía
pedir una pantalla que se titula «quién se ha gastado la factura», y se leen mal: un
horno que gasta 8,8 kWh de sol cuesta 0,00 €, y con la barra en euros salía un muñón
de tres píxeles al lado de un coche de 4,8 kWh. El ojo lee el muñón como «no ha
gastado nada», que es lo contrario de lo que pasó. Con la barra en energía la fila
cuenta la historia entera: barra larga y ámbar, cero euros.

**Los euros son de una tarifa**, la marcada como «la mía», porque un precio por hora
es de una tarifa y no de todas. Sin ninguna marcada se enseñan la energía y su
origen —que ya es media respuesta— y la tarjeta dice por qué no hay euros, en vez de
poner los de una tarifa cualquiera.

### Una cuenta que estaba escrita cuatro veces

Al construir el reparto horario del ciclo salió que la misma cuenta estaba escrita
en tres sitios a mano: en `live` para el día, dentro de `series._build_energy` para
el gráfico del mes y su «Origen del consumo», y habría sido la cuarta aquí. Tres
copias que, si alguien cambia una, dejan de coincidir sin que nada avise: el gráfico
del mes y el desglose de la factura dirían cifras distintas del mismo mes.

Ahora hay **una**, `series.reparto_por_horas`, y las tres la llaman.

### Alcance

La energía por aparato sale de las estadísticas **horarias** de su sensor de
potencia, que Home Assistant guarda indefinidamente. Los ciclos de cinco minutos que
aprende la Home solo cubren unos diez días —el recorder no guarda más— y un ciclo de
facturación es un mes. La hora es además el grano al que se reparte el origen, así
que no se pierde nada por el camino.

## 0.58.0

### El horno era una casa

De una observación al ver la lista de glifos: *«ok arregla ese icono»*. El `horno` venía
extraído del prototipo del diseño y era, trazo por trazo, **la misma casa** que el glifo
`casa`: tejado a dos aguas y una puerta. En un catálogo de electrodomésticos eso no dice
«horno», dice «casa», y con la insignia de la forma de uso al lado se leía como un error
del programa.

Redibujado con lo que distingue a un horno de todo lo demás: cuerpo, el panel de mandos
arriba con sus dos ruedas y la ventana ancha de la puerta. Es justo lo que lo separa del
`microondas`, donde el panel va al lado y la puerta no ocupa el ancho.

Es la primera vez que se descarta un glifo del handoff, así que se ha hecho **con
nombre**: `tools/generar-sprite.py` lleva un conjunto `REDIBUJADOS` con un solo id, y el
glifo nuevo vive en `A_MANO` como los demás dibujados a mano. El resto del prototipo se
sigue extrayendo tal cual, y una regeneración del sprite ya no puede traer la casa de
vuelta. Una excepción con nombre, no una puerta abierta a redibujar lo que apetezca.

### Y una nevera, que es distinta de un congelador

*«Y mete otro de nevera»*. Sube a dieciséis el catálogo del selector, y es un hueco que
se notaba: la nevera es el aparato continuo por excelencia —el que sale en la fila con
el aro permanente— y hasta ahora había que representarla con el congelador o con el rayo
genérico.

El nombre del glifo solo aparece en el rótulo al pasar por encima, así que la nevera
tenía que distinguirse del congelador **por la forma**, no por la etiqueta: el
congelador lleva un copo en el cuerpo grande; la nevera, los dos tiradores. Uno dice
«frío» y el otro «se abre», que es la diferencia que hay entre los dos aparatos.
Comprobado a 21 px, que es el tamaño en el que se ve en la fila.

### Y un coche que es un coche, porque el que había era la batería

*«Añade también el glifo para un coche eléctrico»*. Al ir a dibujarlo salió lo mismo que
con el horno: **el glifo `coche` del prototipo es el glifo `bateria`** —caja, borne y
línea de nivel— con los números movidos dos décimas. Puestos uno al lado del otro no
hay forma de decir cuál es cuál.

Este se queda, porque ahí sí dice algo: en el diseño se llamaba «cargar el coche», y una
batería llenándose es una manera razonable de decirlo. Lo que se corrige es la etiqueta,
que prometía otra cosa: pasa de «Coche» a **«Carga del coche»**. Y al lado va el coche de
verdad, `coche-electrico`: perfil de todocamino con el invernadero grande y los pilares
verticales, que es la silueta que lo separa de una berlina.

Sin rayo dentro, y no por pereza: probado, a 21 px un rayo en la ventanilla es un borrón,
y el enchufe colgando por detrás desequilibra la silueta y a ese tamaño parece un bulto
en el techo. Lo eléctrico lo dicen la etiqueta y la batería de al lado.

Las tres listas —sprite, selector y lista blanca del servidor— se han movido juntas en
los tres casos, y `tests/python/glifos.py` lo verifica: quitando uno de los nuevos de
una de ellas sale en rojo por dos vías.

## 0.57.0

### Un aro verde alrededor del icono, en vez de un punto que late

De una petición: *«en cuanto a los electrodomésticos en funcionamiento, prefiero verlos
en la tabla con un borde verde brillante semigrueso alrededor del icono. Esto incluye a
los que están siempre en marcha»*.

Hecho, y es mejor que el punto: un aro se lee en la fila entera sin buscarlo, no tapa
parte del glifo, y sin animación no pide la atención que la fila no necesita. Va en
`box-shadow` y no en `border` porque un borde de verdad empujaría el contenido del chip
dos píxeles y el glifo bailaría al arrancar el aparato.

**Y lo llevan también los de siempre encendido**, que antes se quedaban fuera. Es de
las dos cosas que se pedían y la que tenía más fondo: hasta ahora «en marcha» quería
decir «tiene un ciclo abierto», y un continuo no tiene ciclos —eso se decidió en la
0.52.0 y sigue en pie—, así que una nevera nunca aparecía como encendida aunque lo esté
siempre. Ahora la marca es más ancha que el ciclo: dice **si está dando ahora mismo**,
vale para las tres formas, aparece en cuanto el sensor ve consumo aunque el histórico
aún no lo sepa, y aguanta las pausas de un programa.

En un continuo el aro es permanente, y no por comodidad: su compresor entrando y
saliendo cada veinte minutos no es encenderse y apagarse, y hacer parpadear el aro con
él sería ruido de la misma familia que publicar «el ciclo típico de tu nevera son 20
minutos».

### Los diez glifos nuevos ya estaban, pero nadie los vigilaba

De una duda: *«he añadido glifos nuevos de electrodomésticos que no aparecen disponibles
para seleccionar»*. Están conectados desde la 0.56.0 —el editor ofrece los quince y se
dibujan todos—, así que era cuestión de reiniciar el add-on. Pero al comprobarlo salió
algo que sí faltaba: **nada mantenía en su sitio las tres listas**.

El sprite, la lista del selector y la lista blanca del servidor se escriben a mano en
tres ficheros distintos, y las tres formas de desparejarse fallan calladas:

- un id en el selector que no está dibujado pinta un **botón vacío**;
- uno que el servidor no acepta se guarda como «potencia» al grabar, **sin decir nada**;
- y un glifo de aparato dibujado y no ofrecido no aparece por ningún sitio, que es
  justo lo que se temía.

El banco nuevo `tests/python/glifos.py` cruza las tres, leyendo los diez dibujados a
mano del propio generador del sprite para no crear un cuarto sitio con la misma lista.
Comprobado que tiene dientes: quitando un glifo del selector sale en rojo por dos vías.

### Y un banco que medía un estado imposible

El de los huecos entre tarjetas (0.55.1) forzaba visible la tarjeta del cierre para
poder medirla de día, y de día esa tarjeta **no tiene datos**: dibuja nada, mide cero, y
un hijo de altura cero en un contenedor con `gap` se come dos huecos. Salía un 28 que en
la aplicación no existe, porque ahí una tarjeta vacía siempre va con `hidden` —fuera del
flujo—. Ahora se le inyecta el cierre en el payload, que es el estado de verdad.

## 0.56.0

### Diez glifos más para «Tus aparatos»

El editor de electrodomésticos solo traía cinco iconos —lavadora, lavavajillas, horno,
coche y un rayo genérico para «otro»—, los cuatro que venían dibujados en el prototipo
del diseño más el comodín. Cualquier aparato distinto se quedaba con el rayo, así que
un aire acondicionado y una freidora de aire se veían idénticos en la lista.

Se añaden diez: aire acondicionado, ordenador, móvil, congelador, iluminación,
cortacésped, microondas, televisión, freidora de aire y ventilador. No vienen de
ningún handoff del diseño —el prototipo solo trae los cuatro de siempre—, así que se
han dibujado a mano con el mismo trazo de 1,75 y la misma caja de 24, y
`tools/generar-sprite.py` los añade después de leer los documentos para que una
regeneración del sprite no se los lleve por delante.

## 0.55.1

### La tarjeta del cierre se quedaba pegada a la siguiente

De una queja, con esa tarjeta puesta arriba: *«parece que le falta el margen inferior
con la siguiente tarjeta»*.

Le faltaba, y la causa es una sola línea de hace muchas versiones: la separación entre
tarjetas la ponía el `margin-bottom` de `.panel`, y **la del cierre es la única que no
es un `.panel`** —lleva su propio fondo de degradado—, así que nunca ha tenido hueco
debajo. Con ella en el último puesto no se notaba; en cuanto tiene una tarjeta detrás,
sí. En el orden de fábrica el cierre va segundo, así que al ponerse el sol se pegaba a
«Tus aparatos» igual, solo que menos a la vista.

Ahora el hueco lo pone el **contenedor** (`gap`), no cada tarjeta. Además de arreglar
el caso, quita dos trampas de las que la primera ya había saltado: que el hueco dependa
de qué clase lleve cada tarjeta, y que dependa del **orden del documento** cuando las
tarjetas se reordenan con `order` —un margen de un hijo se cuenta en el orden en que
está escrito, no en el que se ve—. De paso, la última ya no arrastra un margen que
sobra.

### Y las demás, medidas

Se han medido de verdad, del borde de una al borde de la siguiente y en el orden en que
se ven, las cuatro pantallas: **todos los pares tarjeta-tarjeta están a 14 px**. Los
únicos ceros son cabecera→primera tarjeta, que es como manda la maqueta («el caudal va
pegado a la cabecera»). Y con el scroll al final queda entre 30 y 44 px por encima de
la barra de pestañas en todas, así que no hay nada que se quede tapado.

El banco `tarjetas.js` §13 mide esos huecos con la tarjeta del cierre forzada y en dos
órdenes distintos; sin el arreglo sale en rojo con el par exacto de la queja.

## 0.55.0

### «VÃ­ctor»

Una cabecera HTTP es **latin-1** por norma (RFC 7230), y Home Assistant manda el
nombre de la persona en UTF-8. Así que la í de «Víctor» —los bytes `C3 AD`— llegaba
leída como dos caracteres latin-1 y se enseñaba **«VÃ­ctor»**, tanto en la cabecera
de Ajustes como en la lista de usuarios.

Se rehace el camino: a bytes con latin-1 y a texto con UTF-8, que es lo que eran. Y
es seguro porque falla justo cuando no toca —un nombre en ASCII sale igual, uno que
de verdad viniera en latin-1 no es UTF-8 válido, y uno que ya llegara bien no cabe en
latin-1—, así que en los tres casos se devuelve lo que había. El nombre guardado se
corrige solo en la siguiente visita.

### «Siempre encendido» y «en marcha» eran etiquetas ocupando el sitio de los datos

De una queja: *«la nueva sección de "Tus Aparatos" tiene mucha información larga y
pequeña. Quedaría mejor reemplazar algunos mensajes por iconos»*.

Ahora, al lado del nombre, **un glifo dice de qué va la fila** —y lo pone en palabras
al pasar por encima—, con los iconos del propio sistema de diseño y eligiendo en cada
caso **la pregunta** de esa fila, que es lo que de verdad las distingue:

| | Qué dice |
|---|---|
| reloj | hay una hora que elegir (movible) |
| casa | la hora la manda la casa, no el sol (fijo) |
| rayo | siempre encendido (continuo) |

Y «en marcha» pasa a ser un **punto verde que late** sobre el icono del aparato: el
mismo lenguaje que la pastilla de la cabecera, se ve sin leer y funciona encima de
cualquiera de las tres formas.

Con eso se caen dos renglones y se recorta el tercero: la nota de los continuos
detectados pasa de tres líneas a una («la forma de uso de Nevera la ha deducido Vatia
de su histórico»), porque lo que explicaba ya lo dice la insignia. Y la hora propuesta
pierde el «a las», que delante de un reloj de cuatro cifras no añade nada y era lo que
mandaba el renglón a una tercera línea.

### «Mañana no se espera excedente», todos los días

De una queja: *«siempre aparece en la sección de Hoy un mensaje de que mañana no habrá
excedentes que no tengo idea de a qué se refiere porque todos los días se exporta
algo»*. Tenía razón, y no era una previsión: era un hueco.

Sin datos de mañana la tarjeta decía lo mismo que cuando sí los hay y no sobra, y con
un sensor de previsión que solo publica el día en curso eso salía **cada día**. Ahora
son dos cosas distintas:

> De **mañana todavía no hay previsión**. Si tu integración publica el día siguiente
> en otro sensor, puedes poner los dos separados por comas en Ajustes → Previsión
> solar.

Y de paso se leen también los atributos `detailedForecastTomorrow` y compañía, que es
como algunas integraciones de Solcast publican el día siguiente **en el mismo sensor**;
con ese montaje la aplicación no tenía ni un punto de mañana.

### Qué es «sobra», y desde cuándo

De una duda: *«cuando dices que sobran, espero que estés contemplando que sobra todo
aquello que no consume la casa y que excede el 100 % de la batería, porque la prioridad
después de servir a la casa es llevar la batería a ese 100 % antes de que se ponga el
sol»*.

Sí: se descuenta el hueco que le queda a la batería hasta el 100 %, calculado con su
capacidad y el estado de carga de ahora. Lo que **no** se decía es *cuándo*: el total
estaba bien, pero restarlo del día entero deja creer que se puede gastar un poco a
todas horas, cuando en realidad las primeras horas de excedente van enteras a cargar.
Ahora se dice:

> No sobra nada que gastar **hasta las 12:40**: hasta esa hora el sol que pasa de la
> casa va entero a la batería.

La hora sale de recorrer la curva dando prioridad a la batería y buscando el instante
en que se llena, no de una regla de tres.

### Y un error de cálculo que encontró el banco al comprobarlo

Midiendo lo anterior salió que la integral del excedente ponía **el umbral** en los
extremos del tramo que se le pedía. En un corte de la ventana eso es correcto —ahí la
curva vale exactamente el umbral—, pero en un instante cualquiera de en medio fuerza
excedente cero justo ahí y pierde medio paso de área: «lo que queda de ahora al cierre»
salía **0,8 kWh corto** de lo que decía la propia integral. Los extremos van ahora con
la previsión interpolada.

## 0.54.0

Cuatro defectos de una lista, y ninguno estaba donde parecía.

### El diagrama del caudal se salía de la pantalla

*«El flujo de caudales pintado en vertical, cuando hay detalle de electrodomésticos,
hace overflow por la derecha saliéndose de su tarjeta y de la pantalla, sin poder ver
todo lo que representa.»*

Eran **dos** cosas, y las dos medidas. El presupuesto del dibujo descontaba dos
huecos entre segmentos, que son los que hay con los tres nodos del diseño; con la
casa partida por dentro puede haber ocho, y los seis huecos de más se comían 84 px
que nadie había reservado —las barras llegaban a `[-17, 365]` sobre un lienzo de
348—. Y el antirreapilado de etiquetas, al no caber, empujaba el grupo entero a la
derecha **sin tope**: la última acabó medida en x = 563 con la pantalla en 414. Con
`overflow: visible` eso no se recorta, se pinta fuera de la tarjeta y del borde,
donde no hay ni scroll con el que llegar.

Ahora el presupuesto cuenta los huecos que hay, el reapilado son dos pasadas con los
dos bordes y, cuando de verdad no caben, se reparten a partes iguales en vez de
apilarse al final. Y las etiquetas de un lado poblado van en **dos filas alternas**,
que dobla el sitio de cada una, con su guía a la barra; el sufijo («carga»,
«excedente», «de la casa») se cae ahí, porque pesa el triple que la cifra y dice lo
que ya dicen el nombre, el color y el sitio. Con tres nodos por lado no cambia nada.

El banco nuevo `tests/navegador/lienzo.js` mide las barras, el texto y los solapes
con cero, dos, tres y cinco aparatos, en las dos orientaciones.

### «Load failed» al volver de segundo plano

*«A veces el gráfico de flujo en tiempo real de la home no aparece al volver a la app
de segundo plano y se ve un mensaje de Load failed.»*

«Load failed» es lo que dice Safari por dentro cuando un `fetch` no llega a hablar, y
es lo que le pasa en iOS a la petición que estaba en vuelo al dormir la aplicación.
No era un error de la casa ni del servidor, y aun así se enseñaba **tal cual**; peor,
el caudal que estaba pintado se tiraba entero por ese fallo de un segundo, dejando un
hueco donde había un dibujo que veinte segundos antes era verdad. Y no se
reintentaba: había que esperar el siguiente latido.

Tres arreglos:

- una lectura que falla **no borra la anterior**: el caudal se queda, atenuado, y la
  cabecera dice «sin conexión · reintentando…»;
- se reintenta en dos segundos, en vez de esperar los veinte del latido;
- y **al volver de segundo plano se pide dato nuevo en cuanto se vuelve**, que es lo
  que faltaba: un `setInterval` no corre con la aplicación dormida, así que lo que se
  veía al volver era de hacía horas.

El hueco con mensaje se queda solo para cuando no hay nada que conservar —al
arrancar—, y con las palabras de quien lo lee: «No se ha podido hablar con Home
Assistant. Reintentando…».

### La lista de tarjetas describía la aplicación de hace tres versiones

*«La lista de tarjetas en el menú de configuración de pantalla de inicio no está
actualizada ni en ítems ni en nombre.»*

Cierto: el catálogo seguía diciendo «El plan de hoy · a qué hora sale más barato cada
electrodoméstico» desde la 0.49.0, cuando esa tarjeta ya se llama **«Tus aparatos»** y
cuenta bastante más; y la ventana prometía «cuánto sobra y qué te cabe dentro», que es
lo que se movió a la otra tarjeta en la 0.52.0. Nadie lo notaba porque la Home se
pinta con los `data-card` y no con estos nombres: el catálogo solo se lee en Ajustes.

Arreglados los dos, con su icono, y el banco `tarjetas.js` compara ahora cada nombre
del catálogo con el título que la tarjeta lleva de verdad en la Home.

### «Te sobran 2,7 kW durante 4 h 20 min» no era una decisión

*«El mensaje de "te sobran X kW hasta las X h" no me parece nada práctico. Además,
aburre ver siempre lo mismo.»*

Las dos cosas con la misma raíz. Nadie tiene un aparato de 2,7 kW, así que para
decidir algo había que hacer una cuenta aparte; y la frase no dependía de nada que
cambiara salvo el número, así que se leía igual a las diez que a las siete. Aburrir
era el síntoma, no la enfermedad: el mensaje no informaba.

Ahora dice **lo que está en juego**:

> **Hasta las 19:32 te sobran 8,4 kWh.**
> Gastarlos te ahorra 1,71 €; si no, se van a la red por 0,42 €.

Los kWh son los que quedan de aquí al cierre —no los del día entero, que incluyen la
mañana— y son los **gastables**: lo que la batería se va a llevar sigue diciéndose
aparte. Los euros salen de los precios de las horas que quedan y de la compensación de
excedentes de la tarifa, calculados en el servidor, que es donde viven los precios. Sin
tarifa elegida no se inventan y la tarjeta habla solo de energía.

Y encoge sola con el día, así que no dice dos veces lo mismo. De paso se cae una frase
que se contradecía con la siguiente: decía «es el mejor momento del día para gastar»
siempre que la ventana estaba abierta y acto seguido «el mejor rato es sobre las
14:00». A las nueve de la mañana las dos no podían ser verdad.

### Y un banco que no puede volver a medir a ciegas

`tests/run.py` adoptaba lo que hubiera escuchando en los puertos de los falsos.
Ahora, además de abortar (0.53.0), la regresión trae **13 bancos de navegador**: los
nuevos `lienzo.js` y `vuelta.js`, y el Home Assistant de mentira acepta
`?aparatos=N` para pedir de uno a cinco enchufes medidos.

## 0.53.0

### Lo que está en marcha deja de preguntar a qué hora ponerlo

De una idea: *«para los electrodomésticos movibles podría ser detectar si están en
funcionamiento en ese instante e indicar algo tipo tiempo restante o porcentaje de
ejecución, barra de progreso…»*.

Un movible que **ya está funcionando** tiene otra pregunta. «¿A qué hora lo pongo?»
está contestada —la decisión está tomada— y proponerle una hora óptima es tan
inútil como calcularle una a la nevera. Su fila pasa a decir por dónde va:

> **Lavadora** · en marcha · lleva 40 min · lo que queda, 98 % con sol
> ▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯▯▯▯   **Gratis** · ~termina a las 18:35

La **barra del origen es también la del progreso**: se rellena hasta donde va el
ciclo y el resto queda de carril. Una segunda barra debajo habría sido ruido, y así
la de arriba dice las dos cosas de una vez —por dónde va y de dónde ha salido lo
que lleva— y crece con el ciclo.

Lo medido y lo estimado, separados y sin mezclarse en la misma cifra:

| | De dónde sale |
|---|---|
| Desde cuándo está en marcha | del detector de ciclos, con su misma tolerancia a las pausas |
| Lo que lleva de tiempo y de kWh | del reloj y del contador |
| De dónde ha salido lo que lleva, y su coste | atribución hora a hora, como en un continuo |
| Cuándo termina | la mediana de sus propios ciclos |
| De dónde saldrá lo que le queda | simulado, con la potencia que está dando hoy |

Y lo único de esta fila que un medidor de enchufe no puede decir: **la cola se
simula**. Los veinte minutos que le quedan se pasan por el mismo
`planner.simular` que contesta «¿y si lo pongo ahora?», con la potencia que el
aparato está dando hoy —no la del ciclo típico—, porque si hoy va con un programa
más flojo es el de hoy el que va a terminar.

### Tres cosas que se han decidido no afirmar

**El progreso va por tiempo, no por energía.** En una lavadora el calentamiento
está al principio: el 70 % de los kWh se gastan en el primer tercio del programa,
así que una barra por energía diría «casi acabando» a los veinte minutos.

**Y la barra puede pasarse del 100 %.** La duración típica es una mediana sobre
programas distintos —un rápido a 30° y un algodón a 60° son el mismo enchufe—, así
que al superar lo habitual se dice («más de lo habitual (1 h 30 min)») en vez de
quedarse clavada al final fingiendo que el final es inminente.

**La hora de fin solo se promete si sus ciclos se parecen**: tres terminados como
mínimo y no más de un 30 % de la mediana entre el más corto y el más largo. Un
horno tarda siempre lo mismo y se le puede decir «~termina a las 19:40»; una
lavadora con cinco programas, no, y entonces se dice lo que sí se sabe: «suele durar
entre 55 min y 2 h 25 min». Es la misma disciplina que con «fijo»: cuando el dato no
sostiene la cifra, la cifra no se dice.

### Un ciclo a medias se estaba contando como uno terminado

Buscando dónde encajar lo anterior salió un fallo de fondo. `_ciclos_de` cerraba el
tramo abierto al acabar las muestras, así que **el ciclo que estaba corriendo entraba
en la lista como si hubiera acabado**: una lavadora de dos horas puesta hacía veinte
minutos figuraba como «un ciclo de veinte minutos» y de ahí salía la mediana de «lo
que suele durar». Con seis ciclos en catorce días —una lavadora normal— la mediana
es la media del tercero y el cuarto, así que uno truncado la mueve.

Ahora el abierto va marcado y **fuera de las medianas**, que es donde estaba el
daño; sus kWh **sí** cuentan para el consumo del día, porque esa energía se ha
gastado de verdad. En la instalación de prueba: ciclo típico 1 h, sacado de los
días anteriores, con el de hoy a los 40 minutos y sin contaminarlo.

### Y una sola noción de «en marcha»

Había dos, y no coincidían: la lectura instantánea no tolera ningún hueco y el
detector de ciclos tolera quince minutos —que es lo que hace que un lavavajillas
cuente como un ciclo y no como tres—. Con las dos vivas, la pausa entre lavado y
secado habría dicho «terminado» durante un cuarto de hora y luego «en marcha» otra
vez: **la barra de progreso habría retrocedido**. Ahora manda el ciclo abierto y la
lectura de ahora solo lo sostiene, que además es lo que responde cuando lo aprendido
va con retraso.

Y como lo aprendido se guarda media hora, un arranque **invalida la caché**: sin eso
una lavadora puesta a y cinco no habría enseñado por dónde iba hasta media hora
después, con el programa a medias. Los continuos no cuentan para esto —la nevera
arranca el compresor treinta veces al día— y hay un suelo de tres minutos entre
invalidaciones.

### La fila de la nevera desaparecía a los dos minutos (0.52.0)

Un fallo de la versión anterior, encontrado al verificar esto de punta a punta. El
reparto hora a hora se calculaba bien y se guardaba en la caché del día, pero **el
camino que sirve de esa caché no lo devolvía**. Dos minutos después de arrancar el
add-on, la fila de la nevera desaparecía de la tarjeta —un continuo sin reparto no
se publica, y así debe ser— y volvía sola al caducar la caché. Con la aplicación
recién levantada no se veía nunca, y probando las funciones por separado, tampoco.

De ahí la forma del banco nuevo: **la misma pregunta dos veces**, y la segunda
respuesta tiene que ser la primera. Y el Home Assistant de mentira tiene ahora un
coche que **está siempre cargando** —arrancó hace cuarenta minutos, siempre—, por el
mismo motivo por el que tiene una nevera: un camino sin datos que lo recorran es
donde viven los fallos.

### El banco que corría contra el servidor de otro

Y una tarde perdida que no se va a repetir. `tests/run.py` adoptaba lo que
encontrara escuchando en los puertos de los falsos —ahorra un segundo de arranque—,
así que un Home Assistant de mentira parcheado a mano en una prueba anterior se
quedó pegado al 8133 y **la regresión entera corrió contra sus datos**, en verde y
midiendo otra cosa. Ahora un puerto ocupado aborta con su explicación: un banco que
mide contra un servidor que no es el suyo no está en verde, está mudo.

## 0.52.0

### Dos tarjetas de lo mismo, y una de ellas contestando a una pregunta que no existe

De una queja: *«la info de electrodomésticos de la home me parece redundante y eso
no debería ocurrir, menos en una home»*. Lo era, y era peor que redundancia visual.
**«Cabe en la ventana» y «El plan de hoy» simulaban el mismo instante dos veces**,
con dos funciones distintas y a dos resoluciones distintas —5 y 15 minutos—, y
llegaban a discrepar en **once puntos de «% con sol» para el mismo horno**. Dos
respuestas a la misma pregunta, una encima de la otra, en la pantalla de inicio.

Ahora hay una tarjeta, **«Tus aparatos»**, y una sola física: `planner.simular`.
`appliances.estimate` la llama en vez de repetirla, y el banco lo comprueba con la
batería en su reserva para que las tres partes salgan del cero —si el sol lo
cubriera todo, coincidirían sin decir nada.

Cada fila lleva ahora una **barra segmentada del origen** de su energía —sol,
batería y red, con los colores del resumen del día— y a la derecha **lo que
cuesta**, en euros o «Gratis». Salen del mismo reparto: si en la barra no hay rojo,
el importe es cero, y ya no se puede leer una cosa arriba y otra a la derecha.

### Y la nevera a la que se le calculaba su mejor hora

El caso que estaba roto de raíz. Una nevera de verdad —compresor 18 minutos sí, 27
no— da **32 «ciclos» al día**, así que la aplicación le publicaba un ciclo típico
de **«0 h 20 min · 0,03 kWh»**, la etiquetaba **«Gratis · lo pone el sol»** y le
proponía una hora óptima para encenderla. No le faltaba información: contestaba con
confianza a una pregunta que no existe.

Los aparatos tienen ahora **tres formas de uso**, porque son tres preguntas
distintas:

| Forma | La pregunta | La fila |
|---|---|---|
| **Puedo elegir la hora** | ¿a qué hora? | origen y coste si arranca ahora, más la hora óptima |
| **Tiene ciclo, pero no lo muevo** | ¿cuánto cuesta ahora? | lo mismo, **sin** hora propuesta |
| **Siempre encendido** | ¿cuánto lleva hoy y de dónde salió? | los kWh del día con su origen |

«Siempre encendido» **se detecta de la curva de potencia**, y los números de las
curvas reales dejan poco margen: la nevera da 32 ciclos al día y está encendida el
44 % del tiempo, el router 0,14 y el **100 %**; el aire 3,0 y el 17 %, la lavadora
0,43 y el 2 %. Los umbrales quedan en 6 ciclos/día y 90 % de encendido, con cinco
veces de hueco a cada lado.

**«Fijo» no se detecta nunca**, y eso es parte del diseño: que quieras el aire
cuando hace calor y no cuando pica el sol **no está en los vatios**. Es una
decisión de la casa y solo se elige en la ficha, donde lo que elijas manda siempre
sobre lo detectado. Cuando ha decidido la aplicación, la tarjeta lo dice al pie y
señala dónde cambiarlo.

Un continuo ya **no publica ciclo típico**: publicarlo era publicar una mentira
medida.

### El día de un continuo, hora a hora

Lo que lleva hoy una nevera no se puede repartir con el reparto del día: de noche
sale de la batería y al mediodía del sol. Se atribuye **hora a hora** —su parte de
cada hora por el reparto de la casa de esa misma hora— y solo se cobra la red. En
la instalación real: `0,669 kWh hoy · sol 0,311 · batería 0,296 · red 0,062 ·
0,01 €`.

Con dos límites que evitan las dos formas de mentir aquí. Su parte **no puede pasar
del total de la casa** de esa hora (un contador que marca más que la casa entera es
ruido, no un aparato glotón), y lo que cae en una hora **sin reparto se declara
como no atribuido** en vez de repartirse a ojo para que cuadre.

Las filas se ordenan por **lo que hay que decidir**: primero los movibles, por
ahorro descendente; luego los fijos; los continuos al final.

### Detalles

- La nota de la **reserva de la batería** venía de la tarjeta retirada y se
  conserva en la nueva: explica por qué una batería «al 21 %» no aparece en
  ninguna de las barras, que si no parece un error del programa.
- Los trozos de la barra por debajo del **4 %** no se dibujan —a esa anchura solo
  ensucian el borde entre sus dos vecinos—, pero su cifra sigue en el título.
- La búsqueda de la mejor hora rastrea las **96 posibilidades del día a 15
  minutos** y **solo afina a 5** las dos que se publican, «ahora» y «la mejor».
  Con cuatro aparatos movibles el plan completo tarda **7,5 ms**; afinarlo entero
  son 14,1, el doble, para mover cifras que no se enseñan.
- El banco nuevo (`tests/python/aparatos.py`, diez secciones) y las secciones 8-9
  de `tests/navegador/planui.js` fijan la barra, la fila de un continuo y que
  «fijo» no salga jamás de la detección.
- El Home Assistant falso guardaba **4000 filas** por sensor, y catorce días a
  cinco minutos son 4224: el día en curso se caía por el otro extremo y la nevera
  aparecía sin datos de hoy. Subido a 6000.

## 0.51.1

### «Hoy el cielo no acompaña» era afirmar lo que no se sabe

De una corrección, y con razón: *«la producción prevista por Solcast ya tiene
información de mi tejado (azimut, inclinación, capacidad nominal) y de mi ubicación
por lo que tiene en cuenta la meteorología, así que no es "en crudo"»*.

Exacto, y eso cambia lo que significa la corrección que la 0.48.0 introdujo. Si la
previsión **ya lleva las nubes dentro**, entonces un tejado al 60 % de lo previsto
no dice que haya nubes —ya estaban contadas— sino que **algo se desvía de un modelo
que ya las tenía en cuenta**. Puede ser suciedad, una sombra nueva, un panel o un
string caído, el inversor recortando, o la previsión equivocándose hoy. Vatia mide
el cuánto; el por qué no lo puede saber desde dos sensores.

Y la tarjeta lo estaba afirmando: *«Hoy el cielo no acompaña…»*. Ahora dice lo que
mide y nada más:

> Hoy **tu tejado** va al **15 %** de lo previsto, así que la hora de arriba ya va
> rebajada — medido con la hora de las 10:00, en la que dio el 15 %, y con lo que
> está dando ahora mismo, el 15 %. Si remonta, esto se corrige solo en cuanto el
> tejado lo note.

Lo mismo en la tarjeta del plan. Los números no cambian: cambia lo que se afirma
sobre ellos.

### Y el nombre, en el código también

Un nombre que miente vuelve a generar la copia que miente, así que la clave del
payload pasa de `sky` a **`roof_today`**, la función de la tarjeta de `_cielo` a
`_desvio`, y los bancos de `cielo.py` / `cieloui.js` a `desvio.py` / `desvioui.js`
(con `git mv`, para no perder la historia). Los docstrings de `prevision.py`,
`live.py`, `series.py` y `appliances.py` que hablaban de «las nubes que la previsión
no vio» dicen ahora lo que ocurre, y llevan la advertencia explícita de que **este
número no es un factor de nubosidad**.

También se corrige la cabecera de `prevision.py`, que empezaba diciendo «ninguna
previsión solar sabe de tu casa». Sí sabe: la ubicación, el azimut, la inclinación,
la potencia nominal y la meteorología del sitio. Lo que no sabe es la chimenea que
da sombra hasta las diez ni los paneles sin limpiar — que es exactamente lo que el
sesgo aprende, y el motivo de que el sesgo tenga sentido.

Sin cambios de comportamiento: mismas cifras, mismas decisiones, y la regresión
completa en verde (22 bancos de Python y 11 de navegador).


## 0.51.0

### La forma de hoy: lo que fue hasta ahora, lo previsto desde ahora

De una pregunta que hacía falta: *«¿no debería la forma de hoy representar la
realidad hasta el momento actual y la previsión desde el momento actual, a pesar de
que el pasado ya ha pasado y lo conocemos?»*.

Pues sí. La tarjeta dibujaba **previsión las veinticuatro horas**, también las que
ya habían pasado y de las que hay medida. Es la misma clase de error que enseñar un
cociente donde hay un contador — y el dato estaba ya en casa: los mismos `buckets`
horarios que la tarjeta recibe para aprender el sesgo del tejado.

Ahora el dibujo tiene dos mitades y ninguna finge ser la otra:

- **Las horas cerradas**, con lo que de verdad dieron el sol y gastó la casa. Son
  energía por tramo, así que su potencia media va colocada en el **centro** de la
  hora, que es donde vive una media.
- **Este instante**, de los sensores de potencia. Sirve para que la curva acabe
  exactamente donde el diagrama del caudal dice que está la casa: dos dibujos de la
  misma pantalla no pueden discrepar sobre *ahora*.
- **Desde ahora**, la previsión, que es lo único que hay.

### El trazo dice de dónde sale el número

Continuo lo medido, a rayas lo previsto. Antes la raya significaba «la casa» y el
continuo «el sol», así que no había manera de distinguir una medida de una
predicción; ahora la raya significa **una sola cosa** y el sol y la casa se
distinguen por color y grosor, que es lo que ya hacían las leyendas. La leyenda de
«previsto» solo sale cuando hay las dos mitades: si todo es previsión, no distingue
nada.

Y el punto del pico desaparece cuando ya ha pasado. Sale de la curva de previsión,
así que un pico pasado se dibujaría a la altura que se **predijo** encima de una
línea que ahora enseña lo que **ocurrió**: dos alturas para el mismo instante. La
etiqueta ya se callaba por eso; el punto seguía ahí.

### Lo que a propósito no cambia

`start`, `end`, `kwh` y los tramos de la ventana siguen saliendo de la curva de
previsión —ya corregida con el tejado y con el cielo de hoy—. `kwh` es la magnitud
con la que la nota de la tarjeta compara hoy con mañana, y mezclando medida y
previsión dejaría de ser comparable. **El dibujo dice lo que ha pasado; el titular,
lo que se espera del día.** Está escrito en el código y comprobado en el banco, no
dejado a la suerte.

### Banco

- `tests/python/forma.py`, secciones 10-16: que las horas cerradas llevan su medida
  y no la previsión, que la media va en el centro de la hora, que la curva acaba en
  el instante con lo que marcan los sensores, y que los números de la ventana no se
  mueven.
- `tests/navegador/forma.js`, secciones 10-11: los cuatro trazos, cuál va continuo y
  cuál a rayas, y la leyenda que solo sale cuando hay algo que distinguir.

Con un fallo encontrado a mano y no por el banco, que conviene contar: los
`buckets` vienen en tramos de **cinco minutos**, no uno por hora. La primera versión
se quedaba con el último tramo de cada hora, así que las cifras salían **doce veces
más pequeñas** y la mañana se dibujaba plana. Se vio comparando la salida de la
aplicación de verdad con lo que marcaba el diagrama del caudal —26,7 W de casa donde
había 320—. El banco pasaba porque le estaba dando un bucket por hora; ahora se le
dan de cinco minutos, como los de verdad.

Y una comprobación del banco que estaba mal planteada, que el CI destapó: la sección
del servidor de `tiempo.py` comparaba el sol de la tarjeta del tiempo con la serie
`forecast` de `/api/series`, que es la previsión **cruda del sensor** —sin el sesgo
del tejado ni el cielo de hoy—. Con el tejado dando más de lo prometido, la tarjeta
se pasa de esa cifra con todo el derecho: el banco no medía una incoherencia, medía
una corrección funcionando. Ahora se compara con la tarjeta de la **ventana**, que sí
sale de la misma curva, y esa sí es la invariante que importa.


## 0.50.0

### La reserva de la batería, y un «Gratis» que no lo era

De una queja con tres capturas, a las 11:52:

> A/C Dormitorios · 5 h 10 min · 2,76 kWh
> 1,66 de sol · **1,1 kWh de batería** (11 % de carga)
> ≈ 0,21 € si lo compraras — **Gratis**, ahora mismo

Con el sol dando 805 W, la casa 450, y **la batería al 21 %, que es su suelo de
protección**. *«No entiendo. Me dice que el aire acondicionado me sale gratis…»*.
Tres cosas mal a la vez, y la tarjeta contradiciéndose consigo misma en dos líneas
seguidas.

**Esos 1,1 kWh no existían.** Ningún inversor vacía la batería: por debajo de un
porcentaje —el «Min SOC» o la reserva de respaldo— deja de descargar. La cuenta
era `capacidad × carga / 100`, la batería entera, como si fuera a bajar hasta cero.
Con 10 kWh al 21 % y el suelo en el 20, lo utilizable son **0,1 kWh**, no 2,1.

Se declara en **Ajustes → La batería → Reserva mínima**, o mejor: se asigna el
sensor en **Sensores → Batería → Reserva mínima** y entonces sigue solo cuando se
cambie en el inversor. Un Sungrow lo publica como `sensor.battery_min_soc`.

**El veredicto no miraba la energía, solo el reloj.** Si el ciclo cabía en las horas
que le quedaban a la ventana, «Gratis». De dónde iba a salir esa energía lo
calculaba otra función, al lado, en la misma fila — y nadie las cruzaba. Es la
misma enfermedad que el plan y la ventana tenían en la 0.48.0, dos números que se
desmienten en la misma pantalla.

Ahora el veredicto **es** el resumen de esa estimación, así que no pueden discrepar
por construcción:

| Lo que pasa | Lo que dice |
|---|---|
| El sol lo cubre | **Gratis** · lo pone el sol |
| Lo cubren el sol y la batería | **De la batería**, con lo que costaría reponerla |
| Hace falta la red | lo que cuesta, en euros, y qué % pone el sol |

«De la batería» no es gratis —lo que gastes ahora lo compras esta noche— pero
tampoco es comprar ahora, y la diferencia importa: se puede decidir gastarla a
sabiendas. Lleva el color de la batería, no el verde de lo gratuito.

El cruce vale también **antes de que abra la ventana**, donde el defecto quedaba
aplazado: «Gratis desde las 09:00» se afirmaba sin mirar la energía de las 09:00.
Ahora se simula esa hora y, si no da, se dice igual.

**Y la reserva se explica.** Una batería «al 21 %» que no aparece en ninguna cuenta
parece un error de la aplicación. Cuando la reserva es la que manda, la tarjeta lo
dice: *«La batería está en su reserva (21 % de carga, mínimo 20 %): el inversor no
baja de ahí, así que ahora mismo no puede dar nada y lo que el sol no cubra sale de
la red.»*

### Y que no se pueda perder el reparto en silencio

Al pasar de «la batería entera» a «lo de encima de la reserva», los dos sitios que
simulan un ciclo —la tarjeta y el plan— empezaron a leer el valor ya calculado.
Quien no lo trajera se quedaba sin poder separar la batería de la red, y lo decía
como si no hubiera capacidad configurada: otra cosa muy distinta. Un banco lo cazó,
pero podría no haberlo hecho.

Ahora la fórmula vive en un solo sitio (`planner.guardado_utilizable`) con respaldo:
unas fuentes con carga y capacidad siempre dan un reparto. Tener la misma cuenta
escrita dos veces es exactamente de donde han salido las incoherencias de esta
aplicación.

### Banco

- `tests/python/reserva.py` (nuevo): la instalación de la queja con sus números
  exactos —10 kWh al 21 % con el suelo en el 20— y el veredicto que ya no miente.
  Con una comprobación de fondo: **256 combinaciones** de hora, batería utilizable
  y sol, y en ninguna puede salir «Gratis» si la estimación de ese mismo momento
  pide batería o red.
- `tests/python/ciclos.py`: que la reserva se respeta también por el camino del
  respaldo, y que en la reserva la batería no pone nada sin dejar de poder
  separarse de la red.


## 0.49.0

### El tiempo hora a hora, en la Home

Una tarjeta nueva, ordenable y ocultable como las demás, con **las horas de sol
que quedan del día en curso**. Ni el día entero ni las próximas veinticuatro: en
una aplicación de energía las once de la noche no cambian ninguna decisión, y las
horas que ya pasaron tampoco. El corte de arriba sale de la propia curva del sol
—la última hora en que la previsión da algo— y no de la puesta de sol, para que la
tarjeta acabe donde acaba lo aprovechable.

Cada fila lleva la hora, el icono de su condición, la temperatura, la nubosidad y
**el sol previsto para esa hora**, con una barra proporcional al pico de lo que
queda. Poner la nube al lado del sol es lo que distingue esta tarjeta de un widget
del tiempo: se lee del tirón, «a las dos, 45 % de nubes, y aun así 5 kW».

El sol de la columna de la derecha es el de la **misma curva** de la que salen la
ventana y el plan —la de la 0.48.0, con el sesgo del tejado y el cielo de hoy ya
aplicados—, y la tarjeta lo dice, que es la regla de la casa: una cifra que no es
la del sensor tiene que declararlo.

### La previsión se pide con el servicio, no leyendo un atributo

Es el detalle que decide si esto funciona. Hasta Home Assistant 2024.3 las
entidades del tiempo publicaban su previsión en el atributo `forecast`; en 2024.4
se retiró, y ahora hay que llamar a **`weather.get_forecasts`**. Se pide por
websocket —`call_service` con respuesta lleva ahí desde antes que el
`?return_response` de la API REST, así que funciona en más versiones— por la misma
conexión que ya se usa para las estadísticas, y se guarda un cuarto de hora: la
Home pide `/api/live` cada veinte segundos y la previsión horaria no cambia en ese
rato.

Los Home Assistant de mentira del banco sirven su `weather.casa` **sin** el
atributo, a propósito: si alguien reescribiera esto leyendo atributos, el banco se
pondría rojo en vez de pasar y fallar en las casas.

### Configuración

En **Ajustes → El tiempo hora a hora** se elige una entidad `weather.*` (AEMET,
Met.no, OpenWeatherMap…). Es otra cosa que los dos sensores de meteorología que ya
había: aquellos dicen cómo está *ahora* —ponen el fondo y la pastilla de la
cabecera— y esta trae la previsión. Sin asignarla, la tarjeta no sale.

El desplegable ofrece **solo entidades `weather.*`**, que son las únicas con
previsión horaria: ofrecer trescientos sensores ahí sería ofrecer trescientas
maneras de equivocarse.

La **nubosidad** depende de la integración —AEMET y Met.no la dan, otras no—.
Cuando no viene, esa columna se calla en vez de dibujar un cero que se leería como
«despejado».

### Banco

- `tests/python/tiempo.py` (nuevo): la franja —empieza en la hora en curso, acaba
  con el sol, ni una hora de otro día— y que el sol de cada fila no promete más
  que la curva del día. De noche declara que no puede comprobar nada, en vez de dar
  por hecho que es de día.
- `tests/navegador/tiempoui.js` (nuevo): las filas, la barra proporcional, los
  vatios por debajo del kilovatio, la nubosidad ausente, la tarjeta que no sale
  sin entidad, que es ordenable, y que cabe a 320 px.
- `tests/navegador/tarjetas.js`: tenía las cinco tarjetas escritas a mano y añadir
  una sexta lo ponía en rojo sin que nada estuviera roto. Ahora lee el catálogo de
  la propia aplicación, que es lo que comprueba de verdad —el mecanismo, no cuáles
  son—, y la sección de «ocultarlo todo» recorre el catálogo en vez de una lista
  fija, así que una tarjeta nueva entra sola.
- `tests/python/fixtures.py`: **ninguna fixture puede repetir una clave.** Salió de
  perder media hora con esto — las fixtures ya arrastraban un `weather_entity`
  vacío de una configuración vieja, al final del bloque de ajustes. `json.loads`
  acepta la clave dos veces y se queda con la última, sin decir nada, así que el
  valor bueno quedaba anulado en silencio y la tarjeta no salía en el banco. Un
  fichero que dice dos cosas de lo mismo no se puede leer, y quien lo abra no lo va
  a ver.


## 0.48.0

### Una sola curva de sol, y el cielo de hoy dentro

La 0.47.1 arregló la redacción de la tarjeta del plan. Lo que quedaba debajo era
peor, y salió con la segunda mitad de la misma queja: *«además está nublado ahora
mismo y la producción real es bajísima»*. Con la tarjeta prometiendo «gratis desde
las 10:06».

**Las dos tarjetas calculaban el sol con curvas distintas.** `_fuentes` —la del
plan— corregía la previsión con la producción real del momento. `free_energy` —la
de la ventana— solo con el sesgo histórico del tejado, que es la sombra de la
chimenea, no las nubes de hoy. Así que la ventana prometía una hora sacada de la
previsión prácticamente cruda mientras el plan, mirando el tejado, ya sabía que
no. El comentario del propio código decía *«las dos curvas son las mismas que usa
la ventana»*: lo eran de palabra, no de hecho.

Ahora hay **una** (`curva_solar`), se calcula una vez por refresco y la consumen
las dos. Las correcciones se aplican ahí, en este orden y por este motivo:

1. **El sesgo del tejado**, aprendido de los días anteriores: sistemático.
2. **El cielo de hoy**, medido en el tejado: lo que nadie vio venir. Va después,
   porque medirlo contra la curva cruda contaría el sesgo dos veces.

Y **solo a hoy**: que hoy esté encapotado no dice nada de mañana.

### El cielo de hoy se mide con dos testigos

El factor viejo miraba solo la potencia de este instante, y por eso tenía que
recortarse a **0,2** como suelo: un instante puede ser una nube de paso, y creerse
que el día entero va a ser así sería peor. El problema es que un día encapotado de
verdad da menos del 10 % de lo prometido, así que ese suelo seguía prometiendo
tres o cuatro veces el sol que había — exactamente lo que pasó.

Ahora se miran dos cosas, porque cada una falla donde la otra acierta:

- **La última hora cerrada**, en energía. Una hora entera de kWh medidos ya lleva
  dentro las nubes que pasaron por ella, así que no la despeina una sola. Pero
  llega hasta una hora tarde.
- **Este instante**, en potencia. Reacciona al segundo, y por eso mismo confunde
  una nube con un día gris.

La media de las dos reacciona en minutos sin que una nube suelta la mande al
suelo, y por eso el suelo puede bajar a **0,05**: cuando el número viene de una
hora de energía medida, el 6 % es el 6 %. La última hora cerrada y no la media del
día, además: si el frente entró a las once, las horas claras de antes solo
servirían para diluirlo.

Lo que **no** hace, y conviene saberlo: adivinar cuándo se despeja. Si las nubes se
van a mediodía, la corrección tarda hasta una hora en enterarse. Para saber que se
van hay que mirar el cielo, y eso es trabajo de la previsión.

### Y las dos tarjetas lo dicen

Una cifra corregida en silencio es la misma desconfianza por otro camino: parece
la de la previsión y no cuadra con lo que se ve por la ventana. Es la regla que la
tarjeta ya cumplía con el sesgo del tejado y que con el cielo de hoy no cumplía —
el factor se calculaba, se aplicaba, y no llegaba al payload.

Ahora las dos enseñan **el mismo objeto**, así que no pueden discrepar: *«Hoy el
cielo no acompaña: el tejado va al 15 % de lo previsto, así que la hora de arriba
ya va rebajada — medido con la hora de las 10:00, en la que dio el 15 %, y con lo
que está dando ahora mismo, el 15 %. Si se despeja, esto se corrige solo en cuanto
el tejado lo note.»* Por encima del 85 % no se dice nada: no cambiaría ninguna
decisión y solo sería ruido.

### Banco

- `tests/python/sesgo.py`, secciones 12-19: el estimador, con la nube de paso, el
  día encapotado, el frente que entra a última hora y los dos recortes.
- `tests/python/cielo.py` (nuevo): la invariante de verdad, extremo a extremo —
  que el sol que usa el plan es **exactamente** el de la curva, y que las dos
  tarjetas enseñan el mismo cielo. Verificado con dientes: devolviéndole a
  `_fuentes` una corrección propia, el banco se pone rojo.
- `tests/navegador/cieloui.js` (nuevo) y la sección 7 de `planui.js`: que las dos
  tarjetas lo dicen, con un testigo o con los dos, y que se callan cuando el cielo
  cumple.


## 0.47.1

### El plan y la ventana dejan de contradecirse

De una queja, con las dos capturas al lado: a las 9:47, la tarjeta de la ventana
decía «Lavadora · gratis **desde las 10:06**» y justo debajo la del plan decía
«Lavadora · **ahora** · ahora mismo · 99 % con sol · **es su mejor hora**».
Literalmente: *«parecen estar trabajando sobre dos modelos diferentes, es
confuso y genera desconfianza»*. Y tenía razón, porque eran tres errores
distintos apilados.

**El 99 % no era de ahora.** La fila leía siempre el porcentaje de la mejor hora,
también cuando no pedía esperar, y le pegaba encima la etiqueta «ahora mismo».
A las 9:47 el sol cubría el 60 % de la lavadora; el 99 % era de las 10:17. La
cifra era correcta y la etiqueta mentía sobre a qué momento pertenecía.

**«Es su mejor hora» se afirmaba sin saberlo.** Era el texto por defecto de
cualquier fila que no pidiera esperar — incluidas las que sí tenían una hora
mejor más tarde, solo que la diferencia en euros no llegaba al umbral de los 5
céntimos. Ahora, cuando la mejor hora es más tarde pero da casi igual, se dice
eso: **«esperar apenas cambia nada»**, y el titular dice **«da casi igual
cuándo»** en vez de afirmar que ya están todos colocados.

**Y esperar no se mide solo en euros.** Es la raíz de las otras dos: si pasar de
las 9:47 a las 10:17 mueve la lavadora del 60 % al 100 % de sol, eso vale aunque
en la factura sean 1,3 céntimos — es el objetivo de tener placas, y es lo que la
tarjeta de la ventana ya estaba anunciando. Se añade un segundo motivo para
recomendar esperar: **una ganancia de 20 puntos de sol**, y el porqué se explica
con el sol («pasa a 100 % con sol») en vez de prometer un ahorro que no existe.
Veinte puntos y no menos, porque por debajo de eso la diferencia cabe dentro del
error de la propia previsión.

Con esto las dos tarjetas hablan del mismo día: si la ventana dice que a las
10:06 sale gratis, el plan propone las 10:06.

Al banco de pruebas se le añaden la sección 12 de `plan.py` —que reproduce la
mañana del 3 de agosto con sus números exactos— y `planui.js`, trece
comprobaciones de que la tarjeta no atribuye un porcentaje a un momento que no
es el suyo.


## 0.47.0

### «Desde la red» ya no se pasa del contador de la compañía

Lo encontró el CI, y solo a ciertas horas. Cuando el contador de la casa
reclamaba más energía de la que el sol, la batería y la red podían haber
entregado, ese hueco se le apuntaba entero a la red. Resultado: «Desde la red:
1,13 kWh» justo al lado del nodo de la red diciendo «1,05». Dos cifras que se
contradicen en la misma pantalla, sin ninguna explicación — y encima tapaba la
nota de red→batería, que se calcula restando, así que el descuadre desaparecía
sin dejar rastro.

Ahora la red se queda en su contador y lo que sobra sale en una fila propia,
**«Sin explicar»**, en ámbar y a partir de 50 Wh. Es el mismo criterio que la
0.46.1 aplicó al diagnóstico con la descarga de la batería: si ningún contador
entregó esa energía, se dice, en vez de repartirla donde menos se note.

Con un matiz: **sin contador de importación no hay techo**. Si nadie desmiente a
la red, puede seguir cubriendo el hueco; inventar una contradicción que no
existe sería el error contrario.


### Sungrow: dejar de deducir lo que el inversor ya mide

Leyendo el protocolo Modbus de los híbridos residenciales de Sungrow salen dos
cosas, y las dos tocan de lleno los fallos del resumen de este mes.

**La trampa, y que Vatia la recomendaba.** Sungrow no publica ningún contador
del consumo total de la casa en kWh: solo `Load power`, en vatios. Lo que sí
publica es el registro 13017, «Daily direct energy consumption», que suena a
consumo y es el **autoconsumo**: lo que la casa toma del sol, sin nada de lo
comprado. Ése es el sensor que costó tres versiones detectar.

Y no era mala suerte: la casilla del consumo buscaba candidatos con la pista
«consum», que casa con `daily_direct_energy_consumption`, así que **la aplicación
lo proponía**. El fallo del resumen empezaba en la propia pantalla de
configuración. Ya no se propone, y si está puesto la fila sale marcada en ámbar
explicando qué mide en realidad y qué hacer en su lugar.

**Lo que se puede aprovechar.** El inversor mide, además de los totales, la
parte de cada uno que puso el sol: cuánto de la carga de la batería (13012) y
cuánto de lo vertido (13005). Con esas dos cifras, las dos que a Vatia más le
ha costado deducir salen de una resta entre medidas:

    red → batería  = lo cargado − lo cargado por el sol
    batería → red  = lo vertido − lo vertido por el sol

Hay dos casillas nuevas y opcionales para ellas, en Batería y en Red. No
arreglan ningún hueco —sin ellas todo sigue igual—: **sustituyen una deducción
por una medida**, justo en la parte del reparto que más veces ha estado mal. Se
siguen aplicando los topes de la 0.46.1, así que un sensor mal elegido no puede
inventarse generación.

En `DOCS.md` hay ahora una tabla con la correspondencia completa entre las
casillas de Vatia y las entidades de la integración Modbus de Sungrow, y en
`docs/sungrow-modbus.md` el **diccionario entero**: los 99 sensores con su
número de registro, las tres trampas —además del autoconsumo, el «consumo
calculado» que es el mismo balance que hace Vatia, y el 5003 que suma sol y
descarga—, y los detalles de escala, signo y cadencia.

De ahí sale además el dato que más justifica el reparto por horas de la
0.46.1: la integración refresca las potencias **cada 5 segundos** y los
contadores de energía **cada 600**.

## 0.46.3

### El arreglo de la barra lateral, esta vez de verdad

Lo que hacía la 0.46.2 no podía funcionar, y conviene decir por qué.

Pedía al Supervisor que volviera a inscribir el panel. El Supervisor obedecía y
se lo pedía a Home Assistant… que **no actualiza un panel que ya existe: se
niega**. El componente que registra los paneles de los add-ons llama a la
función de Home Assistant sin el permiso de reemplazo, y ésa levanta un error si
el panel ya está puesto. Así que la petición terminaba en un 500 y no cambiaba
nada. Funcionaba solo en el caso que no importa: cuando el panel estaba
escondido y por tanto no había nada que reemplazar.

Por eso el interruptor «Mostrar en la barra lateral» sí arregla el problema:
apagarlo **borra** el panel, y encenderlo lo crea de cero con el ajuste de ahora.

Vatia hace ahora exactamente eso, en dos pasos y contra Home Assistant
directamente: quita el panel y lo vuelve a poner. Sigue bastando con reiniciar
el add-on una vez.

Con tres cuidados que la versión anterior no necesitaba:

- **no se toca el interruptor del Supervisor**, que guarda su estado en disco.
  Si un fallo pillara la operación a medias, lo peor que puede pasar es que el
  panel falte hasta el siguiente arranque; la preferencia de quien lo escondió
  no se toca nunca;
- los dos pasos van **juntos y blindados**, para que apagar el add-on justo en
  medio no deje el panel borrado;
- Home Assistant puede no estar listo cuando arranca el add-on, así que se
  reintenta poco más de un minuto antes de rendirse. Y si se rinde, lo dice una
  sola vez y explica qué hacer a mano.

## 0.46.2

### Vatia sale de verdad en la barra lateral de quien no es administrador

Desde la 0.44.1 el `config.yaml` lleva `panel_admin: false`, que es lo que hace
que el panel salga en la barra lateral de todo el mundo. Estaba bien puesto y no
tenía ningún efecto.

Home Assistant apunta si un panel es solo para administradores **cuando el
add-on se instala**, y el Supervisor no vuelve a decírselo al actualizar: solo
empuja el panel a Core al restaurar una copia, al desinstalar, y cuando alguien
mueve el interruptor «Mostrar en la barra lateral». Su función `update()` no lo
hace. Así que Core se quedaba con el «solo administradores» de la instalación
original, por muchas versiones que pasaran por encima. La única salida era
reiniciar Home Assistant Core o mover ese interruptor a mano — ninguna de las
dos es algo que se le pueda pedir a quien solo ha pulsado «actualizar».

Ahora Vatia se lo pide ella al arrancar, con exactamente la misma llamada que
hace ese interruptor: lee su estado actual y lo reenvía. Al Supervisor le basta
con que la clave venga en la petición para reinscribir el panel, y Core lo
vuelve a registrar leyendo el ajuste de ahora. **Basta con reiniciar el add-on
una vez.**

Se reenvía el valor que ya había, no un «visible» a la fuerza: si escondiste
Vatia de la barra lateral a propósito, sigue escondida. Y si el Supervisor no
contesta, se anota en el registro y la aplicación arranca igual.

En `DOCS.md` hay ahora una sección **«Quién ve Vatia y quién puede
configurarla»** con los dos roles, la opción `first_user_role` —que faltaba en
la tabla de opciones— y qué hacer si aun así no aparece.

### El diagnóstico dice qué parte no coloca ningún sensor

Ajuste del bloque que estrenó la 0.46.1. Daba por hecho que las dos partes de
cada origen tienen que sumar su contador y marcaba en ámbar el que no. Para lo
importado es cierto y el reparto lo garantiza; para la descarga de la batería no
tiene por qué serlo: si el contador de la casa dice que consumió menos de lo que
la batería asegura haberle dado, hay una parte de la descarga que **ningún
sensor coloca**, y eso no es un fallo del reparto sino un descuadre entre
sensores.

Ahora esa parte sale en su propia fila, **«Sin colocar»**, con una explicación de
lo que significa, y solo cuando pasa de 50 Wh: por debajo es la deriva normal
entre contadores y avisar sería ruido.

## 0.46.1

### La energía importada ya no puede desaparecer del resumen

El resumen decía «Desde la red: 0,3 kWh» con 6,2 kWh en el contador de la
compañía, casi todos de noche, con la curva de consumo y la de importación
gemelas. No era un problema de reparto entre filas: era una **fuga**.

El reparto calculaba, en cada intervalo:

```
grid_to_battery = max(carga − lo_que_el_sol_explica, 0)     ← sin techo
grid_home       = max(importado − grid_to_battery, 0)
```

`grid_to_battery` no estaba acotado por lo importado. Basta un intervalo con el
contador de exportación por delante del solar —entonces «lo que el sol explica»
es cero y *toda* la carga de la batería parece venir de la red— para que la
segunda línea reste una cifra inventada de lo importado, y el `max(…, 0)` borre
el resto. La importación de ese intervalo no cambiaba de fila: **desaparecía**.
Repetido a lo largo de un día con nubes, 6,2 kWh comprados salían como 0,3.

Se añaden los dos topes que faltaban, que no son un ajuste sino física:

- la red no puede haber cargado la batería con más de lo que la red entregó;
- la batería no puede haber vertido más de lo que se descargó.

Con ellos, lo importado se reparte **entero** entre la casa y la batería, y lo
descargado entre la casa y la red. La atribución puede seguir siendo discutible
—no hay ningún sensor que mida «red→batería», se deduce—, pero la energía ya no
puede dejar de existir por el camino.

Lo mismo en el diagrama de flujo en tiempo real, que tenía la misma cuenta.

### Y el reparto se hace por horas, no cada cinco minutos

Los seis contadores son estadísticas de sensores distintos, con cadencias
distintas: el mismo vatio-hora de sol cae en el bucket de las 12:05 en un
contador y en el de las 12:10 en otro. Repartiendo cada cinco minutos, ese
desfase se leía como carga que el sol no explica.

Una hora es más larga que cualquier desfase entre contadores y sigue siendo lo
bastante corta para lo que el reparto por intervalos existe: distinguir una
carga de red de madrugada del sol del mediodía. Es además el grano que ya usaban
las vistas de semana y mes, así que ahora las tres dan la misma cifra. En un día
de nubes de prueba, esto solo recupera 1,5 kWh que se estaban atribuyendo mal.

Las curvas del gráfico y del diagrama del día siguen a cinco minutos: ahí esa
resolución es justo lo que se quiere ver.

### El diagnóstico enseña a dónde fue cada cosa

En **Ajustes → Diagnóstico**, debajo del balance, hay ahora un bloque nuevo: lo
importado, partido entre lo que consumió la casa y lo que cargó la batería, y lo
descargado, partido entre la casa y lo vertido. Cada par se enseña al lado del
contador del que sale, y si no suman, la cifra medida se marca en ámbar.

Es la parte del resumen que no mide ningún sensor y la que más veces ha estado
mal. Ahora se puede mirar el reparto y el contador a la vez en lugar de tener
que deducir el fallo desde la tarjeta de la Home. Sale del **mismo** cálculo que
el resumen, no de una cuenta paralela: si las dos pantallas pudieran discrepar,
esta no serviría para comprobar aquella.

## 0.46.0

### El botón responde antes de que lleguen los datos

Al tocar una pestaña, la selección se movía **al terminar de cargar la pantalla**.
En una casa con InfluxDB al otro lado de la red eso son varios cientos de
milisegundos en los que se ha pulsado y no ha pasado nada visible: no se sabe si
el toque ha entrado, y se vuelve a pulsar.

Ahora la marca se mueve **en el mismo instante del toque**, antes de que la carga
arranque siquiera. El dato tarda lo que tarda; decir que se ha recibido la orden
no tiene por qué tardar nada. Medido en el banco: **menos de 10 ms**, con la
respuesta del servidor retrasada medio segundo a propósito.

Afecta a los tres sitios donde hay botones que se turnan: la barra de pestañas
de abajo, el selector de tipo de análisis en Energía y los selectores de periodo.
La pantalla sigue teniendo la última palabra —si la carga acabara en otro sitio,
o fallara, la marca se corrige sola—, pero ya no es ella quien la mueve primero.

De paso, en los selectores de periodo la marca **se desliza** de una opción a la
siguiente en vez de apagarse aquí y encenderse allí, que es lo que hace legible
de un vistazo hacia dónde se ha ido.

### El detalle del flujo, sin lo que no servía

La pantalla llevaba una botonera con cuatro franjas fijas —Amanecer, Mediodía,
Tarde, Noche— y un «Ver el día entero» que animaba la jornada. Venían del
prototipo del diseño y no resolvían nada que el deslizador no resuelva mejor: las
franjas caen en horas arbitrarias que rara vez son la que se busca, y la
animación se mira una vez.

Queda **un solo botón, «Volver a ahora»**, y ya no en un panel suelto en lo alto
sino dentro de la tarjeta del día, pegado al deslizador que lo hace falta. Está
apagado mientras se mira el presente, así que además dice, sin etiquetas, dónde
está la lectura.

Y el reloj de la tarjeta ha dejado de mentir: arrastrado a las nueve de la
mañana ponía «Ahora · 09:00». Ahora pone «Hoy · 09:00», y reserva el «Ahora» para
cuando de verdad lo es.

## 0.45.0

### Quién entra en Vatia, y quién puede configurarla

Desde la versión anterior el panel lo ve todo el mundo. Ahora, además, **no todo
el mundo puede tocarlo todo**.

Hay dos roles y no más:

- **Administrador** — configura la casa: los sensores, las tarifas, InfluxDB, la
  copia de seguridad. Y nombra a otros administradores.
- **El resto** — ve todos los datos, con la misma frescura, y se configura **lo
  suyo**: el tema, el orden de las tarjetas de inicio y el diagrama del caudal.

En **Ajustes → Usuarios** (solo la ven los administradores) sale todo el que ha
abierto Vatia alguna vez, con su nombre de Home Assistant, cuándo se le vio por
última vez y un interruptor para nombrarlo administrador.

**Cómo arranca esto sin que nadie se quede fuera.** En las opciones del add-on
—Ajustes de Home Assistant → Complementos → Vatia → Configuración, donde solo
llega un administrador de Home Assistant— hay un desplegable, `first_user_role`,
que dice con qué rol se recibe a quien entra por primera vez: **primero** (el
primero que entre manda, el resto no), **admin** (todos) o **viewer** (nadie).
Cambiarlo no toca a quien ya tiene rol asignado.

Encima de eso hay tres cerrojos para que el bloqueo sea imposible:

- si **no queda ningún administrador**, el siguiente que entre lo será, diga lo
  que diga esa opción;
- **no se puede quitar el último administrador**, ni degradándolo ni borrándolo;
- y el rol vive en el fichero de configuración, que se puede editar a mano desde
  Samba o el File Editor si todo lo demás falla.

**La apariencia pasa a ser de cada uno.** El tema y el fondo dinámico eran de la
casa; ahora son personales, como ya lo eran el orden de las tarjetas y el
diagrama del caudal. Sin eso, dejar que los cambiara quien no administra —que es
lo razonable, es su pantalla— se los habría cambiado a todos. De paso, la regla
de permisos cabe en una frase: **puedes escribir lo tuyo y nada más**.

Lo que ya tenías configurado no cambia: quien no haya tocado nada sigue viendo
los valores de la casa.

**Dónde está de verdad el candado.** En el servidor, no en la interfaz.
Esconderle a alguien la sección de sensores solo le ahorra el chasco; lo que
impide que la toque es que la petición se rechaza con un 403, venga de donde
venga. Se comprueba en un único sitio para toda la API, así que un endpoint
nuevo nace protegido en vez de olvidado. La copia de seguridad —que lleva las
credenciales de InfluxDB— también pasa a ser solo para administradores, que era
el agujero que dejaba abierto la versión anterior.

**Entrar sin pasar por Home Assistant.** Si se llega al puerto directamente, sin
Ingress, no hay cabecera que diga quién eres y por tanto no hay rol: se mira y
poco más. Es a propósito —si no, saltarse los permisos sería tan fácil como no
mandar la cabecera— y significa que el puerto sigue sin poder exponerse. Para
desarrollar fuera del Supervisor, el rol se puede poner a mano en el
`vatia.json` de la carpeta del add-on.

## 0.44.1

### Vatia en la barra lateral de todos, no solo de los administradores

Por defecto, el Supervisor solo enseña el panel de un add-on a los usuarios
administradores (`panel_admin: true`). Vatia cuenta lo que gasta la casa y a qué
hora conviene poner la lavadora: eso le sirve a quien vive en ella, tenga o no
permisos para administrar Home Assistant. Y desde la 0.42 cada persona tiene su
propio orden de tarjetas y su propio diagrama de caudal, que solo tiene sentido
si puede entrar.

Nada más cambia: la app habla con Home Assistant por el token del Supervisor, no
por el de quien mira, así que un usuario sin permisos ve exactamente los mismos
datos y con la misma frescura.

**Lo que hay que saber antes de actualizar.** El add-on no tiene autenticación
propia: dentro está todo el mundo por igual. Con el panel abierto a todos,
cualquier usuario de Home Assistant puede además **cambiar los ajustes de la
casa** —los sensores, las tarifas, la conexión a InfluxDB— y **descargar la copia
de seguridad**, que lleva las credenciales de InfluxDB en claro (y el token de
Home Assistant, si se ha configurado uno a mano para usar la app fuera del
Supervisor). Con esto puesto, el panel es para gente de confianza. Si en tu casa
hay cuentas que no deberían tocar nada, dilo y se añade un modo de solo lectura.

## 0.44.0

### El plan de hoy: a qué hora poner cada cosa

Una tarjeta nueva en la pantalla de inicio que contesta la pregunta entera. La
ventana dice cuánto sobra y «Cabe en la ventana» dice qué entra ahora; esto dice
**a qué hora exacta** sale más barato cada electrodoméstico de aquí a mañana, y
si compensa cargar la batería de la red en las horas de valle.

No es un modelo entrenado: es una búsqueda. Se prueban todos los comienzos
posibles en las próximas 24 horas, cada uno se simula con la misma física que ya
usaba el consejo —el sol previsto, lo que tu casa gasta a esa hora, lo que hay en
la batería— y gana el más barato. Un plan que sale de una búsqueda se puede
explicar entero: «a las 13:30, el 96 % lo pone el sol, ahorras 0,31 €». Uno
entrenado, no; y para una decisión que cuesta dinero, poder explicarla es parte
del producto.

Dos decisiones que cambian los consejos y conviene saber:

- **Gastar batería no cuesta el precio de la hora en que la gastas**, sino lo que
  cuesta reponerla. Valorarla a precio de la hora haría que mover un ciclo de las
  ocho a las tres pareciera un ahorro cuando la energía es exactamente la misma.
- **Si ya estás en tu mejor hora, no se te pide esperar.** Y si el ahorro son
  cuatro céntimos, tampoco: mover una lavadora por eso es hacer perder el tiempo.

Lo de la batería sale solo cuando el sol **no** va a llenarla: comprar barato
para no comprar caro tiene sentido; comprar lo que mañana iba a venir gratis, no.
Y solo si el ahorro se nota, porque ciclar la batería tiene un coste de vida útil
que no aparece en ninguna factura.

Sin la tarifa «la mía» elegida en Ajustes el plan sigue saliendo, ordenado por lo
que no habría que comprar, y lo dice en vez de inventar euros.

### La previsión, corregida con lo que da tu tejado

Ninguna previsión solar sabe de tu casa: no conoce la chimenea que da sombra
hasta las diez ni el árbol del vecino. Eso es un sesgo sistemático —aparece a la
misma hora todos los días— y por eso se puede aprender.

Vatia guarda ahora, cada día, lo que la previsión prometió para cada hora y lo
que se produjo de verdad, y saca la mediana del cociente. Un 0,6 a las nueve
significa «a las nueve tu tejado da el 60 % de lo que promete la previsión», y la
curva se corrige antes de calcular nada. La tarjeta lo explica en letra pequeña:
qué horas corrige, cuánto y de cuántos días lo ha sacado.

Home Assistant no guarda las previsiones pasadas —son un atributo, y los
atributos no van a las estadísticas—, así que los pares salen de mirar hacia
atrás dentro del propio día: la previsión de hoy incluye las horas que ya han
pasado, y lo producido en ellas está en las estadísticas. Hace falta un mínimo de
días por hora antes de corregir nada; con menos, esa hora se queda como viene.
Y no corrige el tiempo: si hoy hay nubes que la previsión no vio, de eso sigue
encargándose el ajuste en vivo con la producción de este momento.

### Además

- El reparto de un ciclo entre sol, batería y red podía sumar más de lo que el
  ciclo gasta —se veía «104 % lo pone el sol»— porque la simulación redondeaba la
  duración a cuartos de hora. Ahora el paso se reparte y las tres cifras suman
  exactamente el ciclo.

## 0.43.0

### La ventana enseña la forma del día, y cuenta con la batería

Dos cosas que hacían que la tarjeta de «te sobran X vatios» fuera rara de leer.

**Enseñaba una media y escondía el día.** «Te sobran 2,4 kW durante 6 h» no
distingue una meseta plana de una punta de veinte minutos, y esa diferencia es
justo la que decide a qué hora se pone la lavadora. Ahora la tarjeta dibuja el
día: la previsión del sol, el consumo típico de tu casa hora a hora, y el
excedente como el área de entre las dos. Los huecos —la hora en que la casa
gasta más de lo que da el sol— se ven como un corte en el área, no como una
nota al pie. El mejor momento va marcado con su hora, y el titular lo dice:
«el mejor rato es sobre las 14:30, con 4,2 kW».

**Prometía energía que la batería se iba a llevar.** El excedente se calculaba
como sol menos casa, ignorando que un inversor en autoconsumo carga la batería
con lo que sobra **antes** de exportar. Con la batería a medias, la tarjeta
ofrecía un par de kW que al enchufar algo no estaban. Ahora se descuenta lo que
le cabe a la batería —capacidad × lo que le falta de carga— y se dice en voz
alta: «de lo que da el sol hoy, 4,2 kWh van a llenar la batería antes de que
sobre nada». Sin capacidad configurada o sin sensor de carga no se descuenta
nada: es mejor prometer de más que restar una cifra inventada.

La comparación con mañana sigue haciéndose con el excedente bruto, que es la
misma magnitud los dos días. A mañana no se le descuenta batería porque cómo
estará por la mañana no se sabe, y suponerlo sería inventar.

## 0.42.0

### Cada uno con su Home

La pantalla de inicio se ordena a gusto de cada persona, y el orden es **suyo**:
en una casa con varias cuentas de Home Assistant, mover una tarjeta no le
descoloca la app a nadie más. El componente que dibuja el caudal —la galería de
flujos— pasa a ser también de cada uno.

Funciona porque Home Assistant dice quién está mirando: el Supervisor añade la
cabecera `X-Remote-User-Id` a todo lo que pasa por Ingress. Entrando desde la
barra lateral de Home Assistant, las preferencias son tuyas; entrando al puerto
por tu cuenta no se sabe quién eres y se comparten, y las dos pantallas de
Ajustes lo dicen en vez de dejarlo a la imaginación.

En **Ajustes → Pantalla de inicio** hay una fila por tarjeta con dos flechas
para moverla y un interruptor para verla o no. Flechas y no arrastrar: en un
móvil, dentro de una página que ya hace scroll vertical, arrastrar pelea con el
scroll y con teclado o lector de pantalla no hay por dónde cogerlo.

Detalles que importan:

- **Todo lo demás sigue siendo de la casa.** Sensores, tarifas, InfluxDB,
  contadores: son datos de la instalación, no gustos de nadie, y se ven igual
  desde todas las cuentas.
- **Lo que ya tenías no cambia.** El valor compartido de siempre es lo que hereda
  quien no toca nada, así que una instalación que venía de antes se ve igual.
- **El cierre del día y la ventana** se mueven con lo suyo pegado: el cierre
  lleva su fila de recuperarlo y la ventana lleva el consejo de «Cabe en la
  ventana», que es lo que la convierte en una respuesta —primero cuánto sobra,
  luego qué hacer con ello— y no en dos tarjetas sueltas.
- **Se puede ocultar todo**, y entonces se dice qué ha pasado y por dónde se
  deshace, en vez de dejar una pantalla en blanco que parece una app rota.
- **La copia de seguridad** se lleva las preferencias de todos, y al restaurar
  los valores compartidos vuelven a donde se ven.

Esto es personalización, no permisos: la cabecera solo llega por Ingress y la
puede escribir cualquiera que alcance el puerto, que por eso no debe exponerse.
Decide gustos y nada más.

## 0.41.3

### El contador de casa que no mide la casa se detecta y se descarta

El consumo de la casa está sobredeterminado: además de su contador, se calcula
con los otros cinco (generación + importada + descarga − exportada − carga).
Ahora las dos cifras se comparan, y si se contradicen de verdad —un tercio o
más, no la deriva de minutos— el contador configurado como «casa» se descarta y
el consumo se deduce del balance, intervalo a intervalo.

El caso que lo destapó: el sensor de «consumo» de un inversor Sungrow que en
realidad es el **autoconsumo** diario (lo que la casa toma del sol y de la
batería, sin contar lo importado). Es traicionero porque los días sin
importación cuadra casi exacto, y en cuanto se importa se queda corto justo en
lo importado: marcaba 5,1 kWh con un balance de 11,3. Forzar el resumen a ese
total obligaba a esconder 6,1 kWh de importación en una «carga de batería» que
las curvas no habían visto. Con el contador descartado, el resumen reproduce el
de la app oficial al vatio: casa 11,3 = 2,4 del sol + 2,7 de la batería + 6,2
de la red.

Se aplica en la Home, en la pantalla de Energía (hoy, días pasados y el ayer de
la comparativa) y en la fila de contadores, donde «Casa» pasa a enseñar el
consumo deducido en vez de un cero o la cifra del sensor equivocado. El
diagnóstico de sensores lo dice con las palabras justas: «descartado:
contradice el balance (¿mide el autoconsumo?)», y el log explica los números.
Un contador de casa que sí cuadra con el balance se sigue usando tal cual.

## 0.41.2

### La red no se recorta: lo importado que fue a la casa es una medida

El arreglo de la 0.41.1 dejaba fijo el sol que va a la casa y encajaba la
batería y la red en «lo que quede» hasta el contador de la casa. Si ese
contador se queda corto, «Desde la red» se aplastaba —0,11 de 6,2 kWh
importados— y, como la nota de la importación se calcula restando, el resumen
acababa diciendo que casi toda la importación había cargado la batería, aunque
las curvas del día enseñaran la batería cargándose de sol.

El reparto por intervalos de cinco minutos ya sabe a dónde fue cada cosa: lo
importado que no estaba cargando la batería en ese momento fue a la casa, y lo
mide el contador de la compañía. Eso no se negocia. El ajuste al contador de la
casa sigue ahora el mismo orden que el reparto:

1. la generación, a su contador: «A la casa» queda fijo;
2. la red, primero y entera, con su contador de importación como techo;
3. «Desde solar» es el mismo número que «A la casa», hasta donde el contador
   de la casa dé;
4. la batería absorbe la deriva, con su contador de descarga como techo.

Si los contadores se contradicen —la casa mide menos que la red y el sol
juntos— cede el sol y la diferencia con «A la casa» queda a la vista, que es la
manera honesta de enseñar una contradicción: nunca se recorta la red ni se
inventa una carga desde la red que las curvas no vieron.

## 0.41.1

### El consumo de la casa no cuadraba consigo mismo

En el resumen de energía, «A la casa» (en la columna de generación) y «Desde
solar» (en la de consumo) son **la misma energía** contada desde los dos lados.
Pues salían dos números distintos.

El motivo: cada columna se ajustaba a su propio contador con su propio factor —la
generación al contador solar, la casa al de la casa—, y como los dos contadores
casi nunca van sincronizados, el mismo vatio acababa escrito de dos formas. Con
un ejemplo real: 1.100 Wh por un lado y 950 Wh por el otro.

Ahora se ajusta en orden: primero la generación a su contador, con lo que el sol
que va a la casa queda fijo; ese número **es** «Desde solar», tal cual; y la
batería y la red se reparten lo que falte hasta el contador de la casa. Las dos
columnas dicen lo mismo y las filas suman su propio total.

Si los contadores se contradicen de verdad —la casa mide menos de lo que el sol
solo le entregó— se escalan los tres a lo medido, como antes: preferible a una
fila en negativo. Y si mide de más sin que el reparto sepa de dónde, la
diferencia se apunta a la red, que es la única fuente que siempre puede darla.

### Las cintas del caudal salen y llegan sin escalón

En el diagrama de caudales la cinta nacía a un 72 % de opacidad justo al lado de
una barra opaca, y llegaba al otro extremo a un 50 %: en las dos junturas había
un escalón de color que se veía, sobre todo en el tema oscuro.

Ahora cada cinta nace y muere en el color exacto de su rectángulo y a opacidad
llena, así que parece salir de él en lugar de estar pegada. La traslucidez se
guarda para el centro —que es donde las cintas se cruzan y hace falta ver por
debajo— y el cambio de color se confina al tramo del medio, lejos de los dos
contactos, para que cada extremo se lea del color de su nodo y no de una mezcla.

## 0.41.0

### Qué mide cada contador, uno por uno

«Qué miden los contadores» era **un solo ajuste para los seis**: o todos del día,
o todos totalizados, o todos automáticos. Y una instalación normal los tiene
mezclados —el de la red viene totalizado desde que se instaló y los de la batería
son del día—, así que arreglar la mitad estropeaba la otra, y no había manera de
salir de ahí.

Ahora cada contador puede llevar la contraria. Se elige **en la misma hoja donde
se elige el sensor**, que es donde tiene sentido: al ponerlo ya sabes lo que mide.

- **Automático** — se detecta comparando su estado con lo que ha subido hoy.
- **Del día** — se pone a cero cada noche: se lee su valor tal cual.
- **Total** — sube desde que se instaló: se resta el valor de medianoche.

Lo que no toques sigue al ajuste general, así que lo que ya tenías configurado
queda igual. Y la fila de Sensores lo dice sin entrar: leer un total como si fuera
del día no da un error, da una cifra absurda, y así se ve de un vistazo.

## 0.40.4

### Tras actualizar, la app se quedaba a medias

El fallo que explica los «le doy al botón y no pasa nada», y probablemente unos
cuantos «he actualizado y sigue igual».

El `index.html` se sirve con `Cache-Control: no-store`, así que llega siempre
fresco. Los ficheros de `/static/` no llevaban ninguna cabecera de caché, y aquí
había una suposición equivocada escrita en el propio código: «los estáticos
llevan su ETag y se revalidan solos». **No es verdad.** Sin `Cache-Control`, el
navegador aplica *caché heurística* —del orden del 10 % del tiempo que el fichero
lleva sin cambiar— y sirve el JavaScript de su copia **sin preguntar**. Para un
fichero que lleva semanas quieto, eso son días.

El resultado tras actualizar el add-on es de los peores que hay: el documento
llega nuevo y el JavaScript, viejo. La pantalla enseña lo nuevo y no responde,
porque quien tenía que escuchar el clic está en la versión anterior. Y ni un
error en la consola.

Ahora `/static/` va con `no-cache`, que no quiere decir «no guardes» sino
«guarda, pero pregunta antes de usarlo». Lo que no ha cambiado se responde con un
304 de unos pocos bytes; en una red local no se nota, y que una actualización se
vea entera, sí.

Versionar la URL del `app.js` no habría servido: los `import` de un módulo se
resuelven contra la URL del módulo **sin heredar su query**, así que
`app.js?v=2` seguiría cargando un `core/dom.js` viejo.

### El diagnóstico, en paralelo

Las tres consultas de inventario a InfluxDB —medidas, `entity_id` y en qué medida
está el contador— son independientes y se hacían en serie. Con una base lenta el
diagnóstico se acercaba al minuto, que es justo cuando más falta hace. Ahora van
a la vez, y si una falla las otras siguen: cada una responde una pregunta
distinta y con cualquiera se avanza.

## 0.40.3

### El diagnóstico mira primero si el sensor existe

Faltaba la pregunta más obvia. «No tiene estadísticas horarias» puede querer
decir dos cosas muy distintas: que al contador le falta `state_class` —lo normal
en un ayudante o una plantilla— o que **la entidad no existe**, que se arregla en
otro sitio. Ahora se consulta su ficha en Home Assistant antes que nada y el
veredicto empieza por ahí:

- si no existe, o está en `unknown` / `unavailable`, lo dice y manda a
  Ajustes → Sensores;
- si existe pero no tiene `state_class`, lo dice con su estado y su unidad, que
  es la pista para arreglarlo;
- y si lo tiene, lo nombra, para no acusar en falso.

### Un resto de la reorganización de Sensores

La barra de «Guardar ajustes» seguía recogiendo los catorce sensores de unos
elementos `[data-flow]` y `[data-energy]` que **ya no existen**: la pantalla de
Sensores dejó de ser un formulario de desplegables y pasó a ser una lista de
filas que se guardan una a una al asignarlas.

No rompía nada —el servidor fusiona por claves, y fusionar con vacío no cambia
nada—, pero mandaba `flow_sensors: {}` y `energy_sensors: {}` en cada guardado, y
el día que un PUT reemplazase en vez de fusionar se llevaba por delante los
catorce sensores de una vez. Fuera.

## 0.40.2

### «¿De dónde salen los datos de facturación?», en Diagnóstico

Un botón que recorre la cadena entera y dice **en qué eslabón se rompe**.

Hacía falta porque el fallo típico aquí es mudo: una consulta que no encuentra su
serie no falla, devuelve cero filas. Desde fuera no hay manera de distinguir «no
has gastado nada» de «estoy mirando donde no es», y cada pieza por separado
parece correcta — la conexión con InfluxDB establecida, el histórico del consumo
funcionando, y la facturación en blanco.

Lo primero que se enseña es la conclusión en una frase. Debajo, los eslabones,
para poder comprobarla en vez de creérsela: la fuente, el periodo del ciclo, qué
contador se está usando, cuántas horas devuelven las estadísticas de Home
Assistant y —si hay InfluxDB— **qué contiene la base de verdad**.

Eso último es lo que resuelve el caso: en vez de adivinar, se le pregunta.

- **En qué medidas está tu contador.** Saber que «kWh» existe en la base no sirve
  de nada; lo que hace falta saber es si el contador está ahí dentro. Si vive en
  «Wh» y la medida configurada es «kWh», por separado todo parece bien y la
  consulta viene vacía. Ahora lo dice de una vez: «está en Wh, pon esa».
- **Qué `entity_id` hay escritos**, si el tuyo no aparece. Con la lista delante se
  ve al momento si es cuestión del prefijo, de un renombrado o de otra cosa.
- Y las medidas de la base entera, por si el problema es la base equivocada.

Con eso, un «no me salen datos» se contesta sin salir de la app.

## 0.40.1

### La facturación no traía datos de InfluxDB

Un fallo introducido en la 0.39.0. La integración de InfluxDB de Home Assistant
guarda la etiqueta `entity_id` **sin el dominio**: `grid_import`, no
`sensor.grid_import`. La consulta del histórico del consumo ya lo tenía en cuenta
y le quitaba el prefijo; la de facturación, no.

Hasta la 0.39 eso no se notaba, porque ese `entity_id` se escribía a mano en
Ajustes → InfluxDB y uno escribe lo que hay en la base. Al unificar la
configuración, la facturación pasó a leer el sensor de Ajustes → Sensores, que sí
lleva el dominio, y la consulta dejó de encontrar nada.

Lo que lo hacía indetectable es que **InfluxDB no falla**: contesta correctamente
que no hay ninguna serie con esa etiqueta. Cero filas y cero error, con la
conexión establecida y el histórico del consumo funcionando — y el estado que
muestra la página de InfluxDB sale del histórico, así que decía la verdad y aun
así despistaba.

Ahora las dos consultas piden **las dos formas** del identificador, así que da
igual cómo esté escrita la base.

### Y cuando no haya datos, que se diga por qué

El respaldo se tragaba su propio fallo: si InfluxDB no respondía, se devolvía la
lista vacía de Home Assistant sin más. Un cero en la factura y «no he podido
leerlo» son cosas muy distintas y se veían igual.

- Si el contador no tiene estadísticas en Home Assistant y en InfluxDB tampoco
  aparece, el log dice **qué sensor** se buscó, en **qué medida** y en **qué
  base**, y recuerda que la medida es la unidad del contador (`kWh`, `Wh`…).
- Si Home Assistant no responde y **no** hay InfluxDB configurado, el error sube a
  la pantalla en vez de dejar un vacío mudo.
- Y si Home Assistant no responde pero sí hay InfluxDB, ahora se intenta el
  respaldo: antes el error de conexión salía disparado y no llegaba a probarse.

Comprobado contra un InfluxDB de mentira que **filtra de verdad** por medida y por
`entity_id`, y que guarda las series como las guarda Home Assistant. El que había
contestaba a cualquier consulta, y por eso no cazó esto.

## 0.40.0

### El flujo clásico, el que tenía la app

La galería que estrenó la 0.39.0 traía dos opciones, y una de las dos no era la
que se pidió: «uno más clásico de flujos **como el que existía previamente**».
Puse la órbita del diseño descartado, que es otra cosa. El que existía era la
**cruz** —Solar arriba, Red a la izquierda, Casa a la derecha, Batería abajo,
cables ortogonales y una bola corriendo por cada uno—, y ahora está en la
galería, recuperado de su propio código.

Se conserva la geometría entera: radio 46, centro en (200, 212), carriles a 18 px
y esquinas de 16, con los seis caminos y sus posiciones de etiqueta. Y se conserva
lo que decía y los otros dos no dicen:

- el **contador del día en cada nodo**: lo generado, lo comprado y lo vendido por
  separado en la red, lo que entró y lo que salió de la batería;
- el **anillo del reparto** alrededor del nodo de la casa: de qué fuente vino cada
  kWh que ha gastado hoy;
- el **nivel de carga dentro del icono** de la batería.

Lo que no dice, y conviene saberlo antes de elegirlo: todos los cables miden lo
mismo, así que 200 W se ven igual que 5 kW. La velocidad de la bola es la única
pista de intensidad. Para comparar caudales está «Caudales».

Cuatro cambios sobre el original, los cuatro porque era código de una pantalla y
ahora es un componente que comparten dos:

- los colores salen de los tokens del tema, no de los literales del prototipo;
- vale con solo un reparto de corrientes, sin el resto del payload, que es lo que
  necesita la pantalla del día. Sin él, las potencias de los nodos se deducen de
  las propias corrientes y **los contadores del día no se enseñan**, porque ahí no
  se saben;
- los electrodomésticos medidos, como anillo por dentro del nodo de la casa;
- la bola es SMIL (`animateMotion`), que no obedece a `prefers-reduced-motion` por
  CSS: con el ajuste puesto, no se dibuja.

### Un fallo del original, arreglado al recuperarlo

El anillo del reparto del día dibujaba un **arco de un punto a sí mismo** cuando
toda la energía venía de una sola fuente, y un arco así no pinta nada: en vez de
la vuelta entera se veía un puntito de color. Y ese es el caso más común —una
noche entera tirando de la batería, un mediodía entero de sol—. Ahora un tramo de
360° se dibuja como el círculo que es.

## 0.39.0

### Una sola fuente de datos, y unos solos sensores

«Fuente de datos» prometía algo que no cumplía. Ofrecía tres opciones —demo,
Home Assistant, InfluxDB— pero solo la **facturación** las miraba: la pantalla de
inicio, Energía y el flujo leían de Home Assistant siempre, dijera lo que dijera
ese desplegable. Y para colmo pedía **dos sensores de energía que ya estaban
configurados** en Ajustes → Sensores: el contador de importada y el de vertida,
los mismos dos, en dos sitios, y podían no coincidir.

Ahora la pregunta es una sola: **¿datos de verdad o datos de ejemplo?** Los
sensores se eligen una vez, en Sensores, y valen para toda la app.

- Los dos desplegables «Energía consumida» / «Energía vertida» y su botón
  «Buscar sensores» desaparecen; la facturación usa
  `grid_import_energy` / `grid_export_energy`, los de Sensores.
- Los dos `entity_id` «solo para facturación desde InfluxDB» también
  desaparecen.
- **InfluxDB deja de ser una fuente** y se queda con lo que ya hacía y solo él
  puede hacer: el histórico largo del consumo, que es lo que permite calcular el
  consumo típico de la casa hora a hora en vez de con una sola cifra. Las
  estadísticas horarias de Home Assistant no se purgan nunca, así que la
  facturación no necesita InfluxDB para mirar atrás.
- Como respaldo, si un contador **no generó estadísticas** en Home Assistant —le
  falta `state_class`, o se excluyó del recorder— su serie se busca en InfluxDB
  con el mismo `entity_id`. Es el caso de quien tenía InfluxDB como fuente.

Nada que reconfigurar: al arrancar, `ha_entity` y `ha_entity_export` (o los dos
`entity_id` de InfluxDB) pasan a Sensores si esas casillas estaban vacías, y una
fuente `influxdb` pasa a `homeassistant`. Lo que ya estuviera elegido en Sensores
manda. Comprobado que la serie horaria de facturación es **exactamente la misma**
antes y después del cambio, hora a hora.

De paso, quien tenía sensor de vertido en Sensores pero no en la casilla de
facturación ahora ve su compensación de excedentes sin tocar nada.

### Galería de flujos en tiempo real

En Ajustes → Apariencia, una rejilla para elegir **qué componente dibuja el
caudal**, con un icono vectorial por tipo de diagrama. Dos, por ahora:

- **Caudales** — el Sankey de dos columnas del diseño «Flujo de energía v2», el
  de siempre. Cada cinta mide su potencia en píxeles por kilovatio de verdad, y
  es el único que parte la casa en electrodomésticos con su nombre y su valor.
- **Órbita** — la casa en el centro y las fuentes alrededor. Es la primera
  versión del diseño, la que se descartó al elegir el Sankey: el consumo en
  grande, un anillo de mezcla diciendo de quién es cada trozo y el arco de carga
  en el nodo de la batería. Los electrodomésticos salen como anillo por dentro
  del núcleo, sin nombre.

No son dos estilos del mismo dibujo: uno mide caudales y el otro enseña el sitio
de la casa. El cambio se aplica al momento en la pantalla de inicio y en la del
día, sin recargar.

De la órbita se porta la geometría del diseño sin retocar. Cambian tres cosas,
las tres porque aquello era una maqueta en oscuro y esto es una app con dos temas:
los colores salen de los tokens del tema; se añade la cinta **red → batería**, que
la maqueta no dibujaba porque su física de juguete no cargaba de la red; y el
resplandor de la casa pasa a estar **detrás** del anillo de mezcla — encima, sobre
la tarjeta blanca del tema claro, teñía el anillo y el azul de la red se leía
morado.

### Esquinas en ángulo en el diagrama de caudales

Las barras que identifican cada fuente y cada destino tenían las esquinas
redondeadas y parecían pastillas sueltas en vez de los extremos de una cinta: la
banda sale recta del borde y el redondeo dejaba un hueco claro justo ahí, además
de comerse la punta de los segmentos finos, que son los que ya cuestan de ver. La
muestra de color de la leyenda, que es una barra en miniatura, también es
cuadrada.

## 0.38.1

### La hoja de electrodoméstico no cabía en un móvil

Había que **girar el teléfono** para llegar al botón de Guardar. En una pantalla
de 320 px la hoja salía de 393 y el botón quedaba 58 px fuera, literalmente
inalcanzable.

La causa no era de esa hoja sino de **todas**: `.modal` es una rejilla, y su
única columna implícita se dimensionaba por el *max-content* de la hoja —lo que
mide su cabecera con el título sin partir—, así que el `100 %` de la hoja se
resolvía contra esa columna desbordada en vez de contra la pantalla. Atada la
columna al ancho de la ventana, el título vuelve a partirse con sus puntos
suspensivos y el botón entra. El editor de tarifa tenía el mismo defecto
esperando un título lo bastante largo.

Comprobado en las cuatro hojas de la app a 320 px: ninguna se sale, ninguna pide
scroll horizontal y todos sus botones se pueden pulsar.

### Cuánta batería se llevaría cada electrodoméstico

La tarjeta de la Home ya decía si un ciclo cabe en la ventana. Ahora dice también
**de qué depósito saldría** si lo pusieras ahora, que es la otra mitad de la
pregunta: en una casa con batería, lo que el sol no cubre no es lo mismo que
comprarlo — sale de lo que tenías guardado para la noche.

Cada fila añade un renglón: *«2,1 kWh de batería (28 % de carga)»*, y el
equivalente en euros al precio de importar, porque el kilovatio de batería que
gastes ahora lo tendrás que comprar luego. La estimación va minuto a minuto del
ciclo con:

- **la previsión solar corregida con la producción real de este momento** — un
  día de nubes que la previsión no vio prometería un sol que no está;
- el consumo típico de la casa a esa hora, el mismo perfil que usa la ventana;
- lo que el sol no cubra lo pone la batería mientras le quede, y lo que no, la
  red. Si sobra sol por encima del aparato, la batería **se carga**, que es lo que
  pasaría de verdad y mejora la cuenta de una tarde soleada.

Para poder decirlo en kilovatios hace falta la **capacidad de la batería** —el
estado de carga llega en porcentaje—, que se pone en Ajustes → Sensores. Sin ella
la estimación no se calla ni se inventa el reparto: dice «batería o red» con el
total, que es lo que se sabe.

El importe no se repite: cuando el veredicto ya es una cifra en euros —con la
ventana cerrada— el renglón se queda solo con los kilovatios.

### Y la tarjeta ya no desaparece al anochecer

Se escondía junto con la ventana, y el diseño tiene un estado propio para esa
hora —«Lo que te costaría ahora»— que no se llegaba a ver nunca. Es justo cuando
más sirve: de noche lo que pongas sale de la batería o de la red.

## 0.38.0

### Electrodomésticos: los que se miden, no los que se describen

Nueva sección **Ajustes → Electrodomésticos**: se da de alta un aparato con su
sensor de potencia y, si lo tiene, el de energía. Y ahí acaba lo que hay que
teclear — **no se pide ninguna duración ni ningún consumo**.

Es la diferencia de fondo con la maqueta. El prototipo del diseño lleva esta
función desde el principio, con la tarjeta «Cabe en la ventana» y sus veredictos,
pero allí cada electrodoméstico es un número escrito a mano: «Lavadora, 2 h 10
min, 0,9 kWh». Aquí el ciclo se **aprende del histórico** del propio enchufe:

- se parte la curva de potencia de catorce días en ciclos —tramos por encima de
  su umbral de reposo—, y de ellos salen la duración y los kWh **típicos**;
- por **mediana** y no por media: el día que la lavadora se quedó puesta el doble
  no puede alargar la previsión de todos los demás;
- una pausa a media faena no parte el ciclo (un lavavajillas baja a reposo entre
  el lavado y el secado; sin tolerarlo, un ciclo contaba como tres);
- y con menos de dos ciclos **no se dice nada**: la fila pone «aprendiendo de su
  histórico». Un número a ojo en la tarjeta que decide si pones la lavadora ahora
  o después no vale más que un hueco.

El umbral de reposo es el único ajuste fino: un aparato enchufado consume dos o
tres vatios todo el día y eso no es estar funcionando.

### «Cabe en la ventana», en la Home

Debajo de la ventana de energía gratis, una fila por electrodoméstico con lo que
tarda, lo que gasta y el veredicto del diseño: **Gratis**, **Cabe justo**, o lo
que costaría la parte que se sale, al precio de tu tarifa a la hora en que se
pagaría. Lo que entra gratis va primero, que es la respuesta que se ha venido a
buscar. Cuando la ventana se cierra la tarjeta cambia de pregunta —«Lo que te
costaría ahora»— y las cifras pasan a euros.

### El diagrama detallado parte la casa por dentro

En **Flujo de energía** —la pantalla del día, no la tarjeta de la Home— el nodo
«Casa» deja de ser uno y pasa a ser uno por electrodoméstico medido, más «Resto
de la casa». Cada corriente que llegaba a la casa se reparte entre ellos de forma
**proporcional**: por el cable no viene marcado qué vatio fue a la lavadora y cuál
a la nevera, así que atribuir el sol al aparato y la red al resto sería inventarse
un dato. Si los enchufes sumaran más que el consumo de la casa se recortan a
prorrata, para que el «resto» nunca salga negativo.

La alternativa textual del Sankey también lo dice: «La casa por dentro: Horno,
2,2 kW; resto de la casa, 320 W».

### Y el cierre del día dice qué se puso

El cierre ya decía qué parte del consumo cayó en la ventana; ahora dice **qué**
la aprovechó, que es lo único que se puede hacer distinto mañana. Cada ciclo se
reparte por su solape con la ventana, así que una lavadora que empieza dentro y
acaba fuera no cuenta como todo gratis ni como todo pagado.

### Debajo

- `appliances.py`: detección de ciclos, medianas y los veredictos. El histórico
  se pide en **una sola** llamada para todos los aparatos y se guarda media hora,
  como el perfil de la casa, para que `/api/live` siga siendo rápido.
- Los electrodomésticos son configuración, así que **entran en la copia de
  seguridad** y vuelven con sus mismos ids: el ciclo aprendido sigue valiendo.
- El sprite pasa a **46 glifos**: los cuatro de electrodoméstico salen dibujados
  del prototipo del diseño, no redibujados a ojo. El generador ahora comprueba
  que un glifo sean formas y nada más — la primera extracción se trajo un
  `onClick` de la plantilla dentro de un `<symbol>`.
- Las entidades de Home Assistant se piden una vez por sesión desde `core/`, que
  es lo que permite que dos pantallas tengan desplegables de sensores sin pedir
  la lista dos veces.

## 0.37.0

### El flujo de energía, como lo dibujó el diseño

Implementado el diseño **«Flujo de energía v2»**. La especificación está en
`docs/design/`, junto al código.

**El cambio de fondo es la escala.** El diagrama de antes normalizaba: repartía
el alto de la banda entre las corrientes, así que 200 W a las tres de la mañana
se dibujaban con el mismo grosor que 5 kW a mediodía y el Sankey solo decía
*proporciones*. Ahora la escala es **píxeles por kilovatio de verdad** —46 px/kW
hasta 5,4 kW y a partir de ahí normalizada para no desbordar—, así que a las
horas de poco caudal las cintas son finas de verdad. Eso es la mitad de la
información y no estaba.

Con ello llega el resto de la geometría de la maqueta: barras de 54 px con radio
8, separación de 14, degradado del color del origen al del destino (.72 → .5),
partículas de `2 26` a 3,4 s con grosor proporcional, el valor **dentro** de la
cinta cuando pasa de 17 px, `Entra` / `Va a`, el pie con el caudal total, y las
etiquetas con nombre y valor **antirreapiladas**: paso mínimo entre centros y
línea guía al color del nodo cuando una se separa más de 6 px de su barra. Los
sufijos son parte del nombre —`Batería · descarga`, `Red · excedente`— porque sin
ellos la misma palabra nombraba dos cosas contrarias.

**Dos orientaciones**, con el corte que da el propio diseño en 600 px: en tablet
las columnas van a los lados, tal cual la maqueta; en el móvil pasan a entradas
arriba y salidas abajo, con las cintas giradas 90°. Y se construye en píxeles y
no en un `viewBox` fijo: las medidas del diseño son píxeles, y escalando un
lienzo de 976 al ancho de la tarjeta la letra de 14 se dibujaba a 10.

### Una pantalla para recorrer el día

La tarjeta de «Ahora mismo» ahora se puede tocar, y lleva a **Flujo de energía**:
el mismo diagrama con el día entero por delante.

- **Deslizador de hora** y arrastre directo sobre la franja del día, que es lo
  que se intenta hacer al verla.
- **«Ver el día entero»**: el día pasa completo en unos segundos.
- **La franja del día**: el sol producido en área y el consumo de la casa en
  línea, con el cabezal de lectura.
- **Cuatro tarjetas de métricas**: autoconsumo del instante, batería, red y el
  **coste de esta hora** con el precio de tu tarifa.
- **La píldora de estado** y el **titular** —«El sol cubre la casa, llena la
  batería y aún sobra: 2,0 kW se van a la red»— con las ocho copias del diseño en
  su orden de prioridad, que también salen en la Home. El titular es una región
  `aria-live`, y el Sankey lleva la lista de pares origen→destino que pide el
  diseño para quien no lo ve.

El prototipo simulaba el día con fórmulas; esto va con **lo medido**, que es lo
que el propio diseño pide para producción: el reparto de cada muestra de cinco
minutos lo hace el servidor con la misma función que la tarjeta de la Home.

### Lo que se ha hecho distinto, y por qué

- **La casa sigue siendo rosa.** El diseño la pinta gris neutro (`#D3DCE6`); en
  Vatia ese color es el de la casa en las cuatro pantallas y además el del tramo
  punta. Cambiarlo aquí solo habría hecho que el mismo dato tuviera dos colores.
- **La maqueta es de tema oscuro** y aquí hay dos temas, así que las superficies
  y la tinta salen de los tokens de la app. No es una traducción libre: en oscuro
  los tokens *son* los valores del diseño —`#F2F6FA` de tinta, `#F5A93C` el sol,
  `#35D69B` la batería—.
- **Los vatios se siguen escribiendo en vatios** por debajo del kilovatio, como en
  el resto de la app, en vez de «0,32 kW».
- **Una pastilla «Ahora»** que la maqueta no tiene, porque con datos de verdad hay
  un presente al que volver; y reproducir **da la vuelta al llegar a ahora**, no a
  las 24 h: del futuro no hay medidas.
- **El techo de la franja sale del día**, no de los 6 kW fijos del prototipo, que
  en una casa de 10 kW recortaba la campana.
- **Aparece un enlace que el prototipo no puede producir**: red → batería. Su
  reparto se deduce de producción y consumo; el nuestro sale de seis contadores
  medidos, así que cargar la batería de la red de noche se ve, y tiene su titular.
- No se han añadido los tres parámetros de la maqueta (`showParticles`,
  `showValues`, `batteryKwh`): son mandos de prototipo. El movimiento reducido ya
  apaga las partículas, y la capacidad de la batería la dice el sensor.

## 0.36.0

### «Ahora mismo», siempre lo primero

El caudal de energía va **pegado a la cabecera**, como en la maqueta. Antes lo
empujaban hacia abajo el cierre del día, la fila de recuperarlo y la ventana de
energía gratis, así que la tarjeta que se viene a mirar aparecía a media pantalla
o fuera de ella según el momento del día. Ahora nada de lo que hay debajo la
mueve, y se ha comprobado en los cuatro casos: sola, con la ventana, con el
cierre y con la fila de recuperar.

### InfluxDB se puede configurar, por fin

El histórico del consumo de la 0.34.0 —el que da el **perfil hora a hora** de la
ventana— era **inalcanzable**. Los campos de InfluxDB vivían dentro de «Fuente de
datos» y se escondían salvo que la fuente fuese InfluxDB, así que quien lee de
Home Assistant (lo normal) no tenía dónde escribir la URL, y el perfil se quedaba
con los 14 días del recorder sin manera de saber por qué.

Ahora InfluxDB es **su propia sección** en Ajustes, siempre visible, y dice para
qué sirve cada cosa:

- se usa para **dos cosas independientes** —la facturación y el histórico del
  consumo— y la sección lo explica: los dos `entity_id` van en su grupo, marcados
  como «solo para facturación desde InfluxDB»;
- el índice resume el estado sin entrar: «Sin configurar · el histórico sale del
  recorder», o «v2 · histórico del consumo»;
- y dentro se dice **de dónde sale de verdad** el perfil, leyendo lo que reporta
  la app: «El histórico sale de InfluxDB: 42 días, y el consumo típico se calcula
  hora a hora», o que sale de las estadísticas de Home Assistant si Influx no
  responde.

La página de «Fuente de datos» conserva un aviso que apunta allí.

### Un ajuste que no se podía guardar

«Qué miden los contadores» está en Ajustes → Sensores, una página **sin barra de
guardar** porque todo lo suyo se guarda al tocarlo. El desplegable, en cambio,
solo se leía al pulsar «Guardar ajustes» —que ahí no existe—: se elegía la opción,
no pasaba nada y al volver a entrar seguía la de antes. Ahora se guarda él, como
las asignaciones de sensores de arriba, lo dice, y los totales del día se
recalculan en el sitio.

## 0.35.1

### La pastilla del tiempo, a la maqueta

Estaba a **46 px de alto con cristal oscuro** y la maqueta la dibuja a 34 px con
cristal blanco. Casi el doble de alta, y se comía la cabecera. Ahora coincide
medida a medida: alto 34, relleno 0/12, hueco de 7, desenfoque de 14 px, sin
sombra de caja, icono de 17 px con trazo 1,9 y la temperatura a 14 px con peso
600 y cifras tabulares. El suelo tiene sus dos variantes, blanco al 22 % sobre el
cielo claro y al 10 % sobre el oscuro.

Y la temperatura **recupera su decimal**: la maqueta pone «28,6°» y nosotros
redondeábamos a «29°», que además dejaba sin sentido las cifras tabulares.

### Un detalle que la maqueta no podía prever

La maqueta le pone tinta blanca, pero dibuja **un solo cielo**: uno azul y
saturado. El del tema claro es casi blanco en las cuatro fases, y medido daba
**1,16:1** — la temperatura era invisible. Se conserva el material de la maqueta y
se adapta la tinta al tema: en claro la del tema (**12,2:1**), en oscuro blanca
(**8,6:1**). Comprobado en las ocho combinaciones de tema y fase leyendo el píxel
compuesto de verdad, no una cuenta teórica.

De paso, en `prefers-contrast: more` el suelo se vuelve opaco y la pastilla
quedaba **blanco sobre blanco**, es decir ilegible justo para quien pide más
contraste. Ahora lleva la tinta del tema (19,1:1).

## 0.35.0

### El catálogo de componentes, cerrado

Los dos que faltaban del §04.

**El esqueleto de carga.** No es un remolino en el centro: imita la **forma** del
contenido que va a llegar —una curva con silueta de serie donde irá el gráfico,
cuatro filas de leyenda, las marcas del eje— para que el salto al dato real no
mueva nada de sitio. Como pide el documento:

- **pulso de 1,4 s en un barrido diagonal**, no en la opacidad de cada bloque: un
  bloque que late parece roto, un barrido parece que carga;
- **tras 8 s** aparece «Está tardando más de lo normal» con opción de cancelar, y
  cancelar no es un error: no sale ningún aviso rojo, se queda lo que hubiera;
- se anima **solo mientras se ve**, con `IntersectionObserver` y
  `visibilitychange` (§07): nada animado en segundo plano.

Sustituye al gráfico en vez de ponerse encima, para que no se vea debajo el dato
del periodo anterior — que es peor que un hueco. Y la lista de tarifas de
Facturación, que en la primera carga entraba en blanco, también lo estrena.

**El estado «Guardando».** Un guardado lento no daba ninguna señal: el botón se
quedaba igual y se volvía a pulsar. Ahora el botón gira mientras espera y el
interruptor que guarda solo hace lo que pide el catálogo al pie de la letra: **el
pulgar se detiene a medio camino y gira hasta la respuesta**. Con un umbral de
140 ms, para que un guardado de 40 ms no dé un parpadeo — que se lee como un
fallo, no como una respuesta.

### Dos desvíos que salieron al repasar el catálogo entero

Al comprobar el §04 completo —y no solo los dos huecos— aparecieron dos cosas que
llevaban tiempo mal:

- El **foco de teclado** iba desplazado 2 px y el §04 pide 3 px «en todos los
  controles»; en los campos de texto no estaba desplazado en absoluto.
- El botón grande de guardar tenía **radio 14 px** en vez de cápsula. El 14 es de
  «fila y campo» según el §02; un botón es un control, y los controles son
  cápsulas.

## 0.34.0

### La ventana deja de mentir a la hora del horno

El umbral con el que se calcula la ventana de energía gratis era **una sola
cifra**: la mediana de la última semana. Con 320 W de mediana y el horno puesto a
la una, la app decía «ahora es gratis» mientras la casa pedía 2.500 W. Ahora hay
**una cifra por hora y por tipo de día**, así que a la una el umbral es el de la
una.

Consecuencias, medidas con una casa de suelo 320 W, horno de 13 a 14 y cena a las
nueve:

- El excedente que se promete baja entre un **7 y un 18 %** según la instalación:
  con paneles grandes casi no cambia, con una instalación modesta o un día de
  nubes es donde estaba el error.
- Y la ventana **puede partirse**. Con 1.800 W de sol, la de antes decía
  «09:14–19:09, 9,4 kWh» de un tirón; ahora dice lo mismo pero con **un hueco de
  12:48 a 13:40** y 7,8 kWh. En ese hueco la app decía «sí» y la respuesta era
  «no».

La tarjeta lo cuenta sin cambiar de forma: el riel pinta **una barra por tramo**,
la cabecera añade las horas netas, y dentro de un tramo avisa de a qué hora se
corta. Si estás **dentro** del hueco, la píldora pasa a «VUELVE EN…» y el titular
dice a qué hora vuelve a sobrar, que es exactamente lo que hay que decir.

### El histórico, de InfluxDB si lo tienes

El perfil mejora con el histórico, y el recorder de Home Assistant guarda **diez
días** por defecto. Si tienes InfluxDB configurado se le piden **seis semanas** en
vez de dos: con seis muestras por casilla, un día raro deja de desviarla, y hay
para distinguir el laborable del fin de semana. Funciona con v1 (InfluxQL) y v2
(Flux).

Si InfluxDB no está, no responde o viene vacío, se sigue con las estadísticas de
Home Assistant como hasta ahora. **Ajustes → Diagnóstico** dice de cuál de las dos
sale y con qué forma, porque «¿está usando mi InfluxDB?» no se podía saber de
ninguna manera.

### Y el sensor de estado de carga se puede configurar

Toda casilla opcional vacía decía «Opcional · **se deduce del balance**». Para el
consumo de la casa es verdad; para el **estado de carga** es falso —no se deduce
de nada— y ese texto te decía que no hacía falta tocarla, cuando sin ella falta
su gráfico. Ahora cada casilla dice lo que se pierde sin ella. De paso, el
selector de entidad ya no dice «1 entidades».

## 0.33.0

### El estado de carga, debajo del de potencia

La vista de batería enseña un segundo gráfico con el **estado de carga**, bajo el
de carga y descarga. Va aparte y no como una serie más porque un porcentaje no
comparte eje con los vatios: metido en el mismo eje, la curva del 0 al 100
quedaría pegada al suelo frente a picos de 3.000 W.

- **Comparte el eje del tiempo** con el gráfico de arriba, así que las dos curvas
  se leen a la misma altura del día: se ve de un vistazo que la batería empieza a
  subir cuando la carga arranca.
- **El eje vertical va de 0 a 100 fijo**, no al recorrido del día. Si se ajustara,
  la misma batería parecería vaciarse más un día que otro solo porque el eje se
  ha reencuadrado.
- Encima, la **última lectura del periodo** con el mínimo, el máximo y la media,
  que es lo que dice si la batería ha ciclado a fondo o se ha quedado arriba.
- Deslizar el dedo dice la carga de ese momento; en las horas que aún no han
  pasado lo dice también —«sin lectura»— en vez de callarse.
- Está en **día, semana, mes y año**: en los rangos agregados es la media del
  bucket. En «total» no sale, porque los buckets del gráfico son años y una media
  anual de carga no informa de nada.
- **Sin sensor de estado de carga la tarjeta entera se esconde**, como la ventana
  de energía: mejor no enseñar nada que un eje vacío.

De paso, los puntos de las líneas de lectura recuperan su color: `chartColor`
buscaba un token con el nombre de la clave y, al no encontrarlo, caía al gris de
respaldo. Los dos acumulados de Facturación llevaban el gris desde que se
migraron a uPlot.

## 0.32.0

### El dedo recorre el gráfico

- **La selección sigue al dedo.** Antes solo cambiaba al tocar, y no era un
  descuido: uPlot solo escucha el ratón, y arrastrar un dedo **no genera
  `mousemove`**, así que el cursor no se movía por más que deslizases. Ahora el
  componente coloca el punto él mismo desde los eventos de puntero: un arrastre
  de un dedo publica un punto por muestra, en orden, y al levantar se queda
  donde lo dejes.
- **La raya vertical se pega al punto.** uPlot ponía la raya donde estaba el
  dedo y los círculos donde estaba el dato, así que se separaban. No se veía en
  el rango de día —288 muestras en 294 px, medio píxel—, pero en **mes** las
  muestras están a 9,7 px y la raya caía hasta **4,5 px** del punto; con zoom 4×,
  a 1,9 px. Ahora la raya va al píxel exacto de la muestra: **0 px** medidos en
  los tres casos.
- **Hay salida a los totales.** El chip «Totales» solo aparecía con un punto
  *fijado*, y en el móvil eso dejaba sin salida: al levantar el dedo no hay
  `mouseleave` que devuelva el cursor, así que la leyenda se quedaba con los
  valores del instante para siempre. Ahora sale con cualquier punto a la vista y
  suelta también el del gráfico.
- **Las barras de Facturación** tenían el mismo defecto por la misma razón, y se
  arreglan igual: deslizar el dedo recorre los días y las horas.

El reparto de gestos cambia, y conviene saberlo: **un dedo recorre** y **dos
dedos pellizcan y desplazan el eje**. El recorrido de un dedo con zoom no se
pierde: al llegar al borde, el eje sigue al dedo, así que con un solo dedo se
alcanza todo el periodo sin soltar. El desplazamiento vertical de la página
sigue siendo del navegador: si el gesto arranca claramente vertical, se suelta.

## 0.31.0

### El frontal, repartido en módulos

No cambia nada de lo que se ve. Cambia que `app.js` eran **2.189 líneas** con las
cinco pantallas dentro, y a partir de aquí eso solo iba a ir a peor: cada pantalla
nueva —el catálogo de electrodomésticos, sin ir más lejos— se sumaba al mismo
fichero, y cualquier cambio obligaba a leerlo entero para saber a quién estabas
pisando.

Ahora son diecisiete ficheros: `core/` con lo que no es de nadie (DOM, red,
formato, colores, navegación, tema y los gráficos que comparten dos pantallas) y
`screens/` con una pantalla por fichero. La mayor pasa de 2.189 a 464 líneas.

Lo que de verdad sostiene el reparto no es la carpeta, es **quitar el ovillo**.
Antes la navegación llamaba a los cargadores de las cinco pantallas y las cinco
pantallas llamaban a la navegación: un ciclo, así que no había forma de tocar una
sin arriesgar otra. Ahora la navegación y el tema **anuncian** —cinco eventos, ni
uno más— y cada pantalla escucha lo suyo. Ninguna pantalla importa a otra, y eso
se comprueba con una prueba que rechaza el ciclo si algún día alguien lo mete.

De regalo salieron dos cosas: **la Home ya no pide dos veces el gráfico de
Energía** al entrar desde el resumen (llamaba al cargador y además lo disparaba la
navegación), y se van dos formateadores que llevaban tiempo sin usarse.

El documento pasa a servirse con `Cache-Control: no-store`. Es lo único que sabe
cómo se carga la app —ahora con `type="module"`—, y un `index.html` viejo guardado
por el navegador junto a un `app.js` nuevo dejaría la pantalla en blanco después
de actualizar. Los estáticos se siguen cacheando con su ETag.

## 0.30.1

### La previsión aparece donde la maqueta la pone

No se pintaba, y no era un fallo de dibujo: **la vista general no la pedía**. El
servidor solo añadía la serie de previsión en la vista de solar, y la general es
la que se abre al entrar en Energía, así que lo normal era no verla nunca. La
maqueta dice lo contrario —«rango día, vista general, con la previsión punteada
en las horas futuras y ayer como referencia»— y ahora va en las dos, también en
los rangos de semana y mes.

Ya puestos, la línea se ajusta a lo que dice el sistema de diseño:

- **Color propio**: `#B87A10` en claro y `#F5C46B` en oscuro, en vez del ámbar
  del solar. Importa justo ahora: en la vista general la punteada continúa a la
  continua, y con el mismo color no se veía dónde acaba lo medido.
- **Punteada 6/5**, y escalada a la densidad de la pantalla. uPlot escala el
  grosor pero pasa el guion tal cual al lienzo, así que en un móvil 2× el patrón
  salía a mitad de tamaño y la línea parecía casi continua.
- **Arranca en el último punto real** y no en la hora del reloj. El estadístico
  del recorder va unos minutos por detrás, y cortando por el reloj quedaba un
  hueco entre la línea y la punteada.

## 0.30.0

### Repaso de uso

Ocho cosas que solo se ven usando la app en el móvil, no leyendo el código. Las
tres primeras eran fallos míos del cambio a uPlot:

- **No se podía bajar por la pantalla con el dedo sobre un gráfico.** Para
  recibir el pellizco había puesto `touch-action: none`, y con eso me quedé
  también el desplazamiento vertical, que es de la página. Ahora es `pan-y`: el
  navegador conserva el vertical y el componente solo el horizontal.
- **Con zoom no se podía recorrer el eje.** Solo había pellizco de dos dedos, así
  que al ampliar te quedabas mirando ese trozo. Un dedo en horizontal lo recorre,
  y solo si el gesto es claramente horizontal; si no, se deja pasar y la página se
  desplaza.
- **El punto fijado se perdía al ampliar.** uPlot recoloca su cursor cuando
  cambia el rango, y la leyenda se quedaba sin valores. El punto se guarda ahora
  en el componente y se vuelve a marcar tras cada cambio de eje; si queda fuera de
  lo que se ve, el eje se trae hasta él en vez de perderlo.
- **Los gráficos de Facturación no decían nada al tocarlos.** Respondían al dedo
  pero no había dónde leer el resultado, que es peor que no responder. Cada uno
  estrena su línea de lectura, con los valores del punto y el color de su tramo, y
  un aviso de que se puede tocar mientras está vacía, para que el hueco no parezca
  un fallo.

Y cuatro de maqueta:

- **Energía era una pantalla apilada y en la maqueta es una pestaña.** Ahora la
  navegación tiene cuatro, con su icono, y desaparece el botón de volver.
- **La Home llevaba un titular que la maqueta no tiene** —y encima decía
  «Energía», que es el nombre de otra pantalla—. Abre directamente con el caudal,
  cuya banda estrena el punto que respira, el «AHORA MISMO» y el pie que dice qué
  está pasando con la red.
- Los titulares de pantalla pasan de 32 a los **26 px** de la maqueta.
- **El cierre del día se podía perder para siempre.** Al descartarlo queda una
  fila que lo devuelve.

Del catálogo de controles del §04 faltaban cinco; se añaden tres: el interruptor
deshabilitado, el **buscador del selector de entidad** —que es lo que el
documento destaca, porque con trescientas entidades un desplegable no se recorre
pero escribir «solar» sí acota— y el **«Reintentar»** de los avisos de error, que
hasta ahora decían qué había pasado sin ofrecer salida. Quedan dos: el estado
«Guardando» de los botones y el esqueleto de carga.

## 0.29.0

### Y los gráficos de Facturación también

En la versión anterior migré el de Energía y me dejé los de Facturación, que
resultaron ser **cinco** y no cuatro (al revisarlo apareció también el de la
Simulación). Ya no queda ni un gráfico dibujado a mano en la app.

- **El consumo diario se apila de verdad**, como en el prototipo: una barra por
  día repartida por tramo, en vez de tres rectángulos sueltos con la exportada
  al lado. Sigue eligiéndose el día pulsando su barra, y el elegido se resalta
  detrás.
- **El desglose por horas** sale con el color del tramo al que pertenece cada
  hora, y el cursor lo sigue diciendo.
- **Los dos acumulados** reaprovechan el componente de Energía.

## 0.28.0

### El gráfico de Energía, sobre uPlot

Era la última pieza grande del rediseño y la que lo motivaba. El gráfico se
dibujaba regenerando el SVG entero, que creaba **unos 1.700 nodos por
repintado**: el pellizco iba a tirones porque el navegador tenía que rehacer el
documento en cada fotograma. Ahora es un lienzo y el mismo gráfico —288 puntos,
seis series— deja **15 nodos**.

Lo que cambia al usarlo:

- **El pellizco y el zoom mueven el rango del eje** en vez de estirar el gráfico
  y desplazarlo. El gesto se agarra al punto que queda entre los dedos.
- **La leyenda sigue al dedo**: al pasar por encima enseña los valores de ese
  instante, sin tener que fijar el punto.
- El eje del tiempo va en la **hora de tu casa**, no en la del navegador.

Se conserva todo lo de antes: área translúcida bajo cada línea, previsión
punteada, «ayer» al fondo, huecos sin interpolar (un hueco sigue significando
«no hay dato» y no «hay un cero») y el techo del eje redondeado.

uPlot va **copiado dentro del add-on** como las tipografías: 53 kB en total,
licencia MIT, sin dependencias y sin una sola petición externa. Se descargó del
registro de npm y se verificó su firma sha512 antes de usarlo.

## 0.27.0

### Crear una tarifa deja de ser un formulario de veinticinco campos

- **El editor son ahora cinco pasos plegables** — Identidad, Energía,
  Excedentes, Potencia, Impuestos — y se lee de arriba abajo como una lista de
  comprobación: cada paso cerrado **resume su contenido en una línea**, y el que
  está incompleto lo dice ahí («Falta el precio de P1 y P2») sin que haya que
  abrirlo para enterarse. Se abre siempre el primero que falta, así que una
  tarifa nueva empieza por el nombre y una que ya funciona no abre ninguno.
  **Guardar vive en la cabecera**, siempre alcanzable, y Cancelar solo pregunta
  si hay cambios que perder.
- **La sintaxis de horarios desaparece.** «L-V 10-14,18-22» había que
  aprendérsela; ahora hay una **rejilla semanal que se pinta arrastrando**, con
  un color por tramo. Tocar la letra de un día lo pinta entero, hay cuatro
  atajos (copiar a L–V, fin de semana, festivos = domingo, vaciar) y la cadena
  equivalente sigue a la vista para quien ya sabía leerla. Las horas que no se
  pintan caen en el tramo por defecto, así que **es imposible dejar una hora sin
  precio**. Incluye la fila de festivos, que es lo que el motor entiende como
  día especial.
- El preajuste 2.0TD ya se puede editar: llevaba los horarios escritos en el
  código y la rejilla no habría podido cambiarlos.

### Revisión de la navegación y de Facturación

Repaso de la app contra la auditoría de Liquid Glass del diseño, regla a regla:

- **Los botones eran rectángulos** de radio 12 y la guía los quiere en cápsula
  de 44 px; los de icono, circulares.
- **La cabecera no era capa de navegación**: el botón de volver era un glifo
  sobre un cuadrado y ahora es un control circular de 40 px con su propio
  material, legible sobre cualquier cielo.
- **Borde al desplazar**, que faltaba: un degradado de 24 px que aparece solo
  cuando el contenido se ha movido, no una línea permanente.
- **Contraste alto** (`prefers-contrast: more`), que no estaba: fondo casi
  plano, borde visible en todos los controles y tinta al nivel 1.
- Dos textos por debajo del mínimo de 11 px, la escala de radios del sistema
  (22/16/14) y zonas táctiles de 44 px en los controles pequeños.
- En Facturación, el aviso de error era translúcido y el cielo se colaba por
  detrás: ahora es opaco. Y el interruptor de proyección pasa a su propia fila,
  con la explicación de qué hace.

## 0.26.0

### Los iconos del diseño, y Ajustes deja de ser catorce desplegables ciegos

**Configurar los sensores era lo que más dolía**, y es lo que más cambia. Las
catorce casillas dejan de ser catorce desplegables con trescientas entradas cada
uno y pasan a ser **filas que dicen qué entidad tienen, cuánto marca ahora mismo
y si responde**:

- Se agrupan **por función** (solar, batería, red, casa), que es como se piensa
  en ellas, y no por el tipo de magnitud con el que están guardadas. Las dos
  páginas de antes —potencia en una, contadores en otra— se unen en una sola:
  preguntaban lo mismo dos veces cuando lo que se configura es un aparato.
- **El punto verde** indica que la entidad contesta. Uno rojo no bloquea el
  cálculo: la serie se dibuja con hueco y la factura avisa.
- **Una casilla vacía tiñe su fila** y ofrece los candidatos con el nombre a
  favor: asignar un sensor son tres toques. Las opcionales (consumo de la casa,
  su contador y el % de batería) se distinguen, porque la app las deduce del
  balance si faltan.
- **El índice informa**: cada fila lleva su estado resuelto en la línea de
  abajo — «12 de 13 asignados», «3 tarifas», la potencia contratada — sin tener
  que entrar a comprobarlo.

**Apariencia baja al índice**, desplegada, y trae un ajuste nuevo: **«Fondo según
la hora»**, para dejar la Home en superficie lisa si el cielo estorba o el móvil
va justo. El material traslúcido sigue al ajuste del sistema, así que su fila
solo informa de cómo está.

**Los 42 iconos del set propio del diseño** entran como un sprite de 6,7 kB, con
su trazo de 1,75 uniforme (antes había cinco grosores distintos, de 1,4 a 2,2).
Va incrustado en la página y no como fichero aparte, porque las referencias
externas no funcionan en el navegador de la app de Home Assistant en iOS. Los
ocho glifos del tiempo mapean ya uno a uno con la condición meteorológica: antes
el viento se enseñaba como nubes parciales y el granizo como nieve.

Y dos correcciones del cristal contra la guía de Apple: el desenfoque pasa de 26
a **30 px**, y **los botones y los avisos dejan de llevar material** — es para la
capa que flota sobre el contenido, no para el contenido.

## 0.25.0

### Tu tarifa, y el resto de la app al lenguaje del prototipo

- **Ya puedes marcar una tarifa como «la mía»**, desde su tarjeta en la
  comparativa. La comparativa no cambia por eso —sigue tratándolas a todas
  igual—: existe para lo único que ninguna comparación puede dar, **el ahorro
  del día en euros**, que aparece en el cierre del día. La cuenta es la
  diferencia entre el día que has tenido y el que habrías tenido sin placas ni
  batería, comprando el mismo consumo entero a la red; hora a hora, porque
  ahorrar a mediodía no vale lo mismo que ahorrar en punta. Si falta el precio
  de alguna hora (un PVPC sin publicar) no se estima: no se da la cifra.
- **Tarjetas de tarifa nuevas** en la comparativa, las del prototipo: barra de
  color, total grande, «MÁS BARATA» flotante y el desglose plegado, que se abre
  al tocar. Dentro están «Ver la factura» y el marcado de la tuya, que también
  asoma en la lista de Tarifas y en Ajustes.
- **Las gráficas de Facturación ya siguen al tema.** Sus colores estaban
  escritos a mano, así que las barras no coincidían con los puntos de su propia
  leyenda: la de «Exportada» llegaba a decir morado con la barra naranja. Ahora
  salen de los tokens, y cambiar de tema las repinta.
- **La batería estrena un segundo color para la salida.** Es un nodo con dos
  sentidos, como la red, y con uno solo «Descarga» y «Exportada» compartían el
  morado en la misma leyenda de Energía.
- **Maquetación**: rótulos de sección en versalitas y legibles sobre el cielo
  (el «· pulsa un día» iba con la tinta de las tarjetas y quedaba casi
  invisible), tarjetas de cifra con el número grande y cifras de ancho fijo, el
  selector de vista de Energía en negativo como el chip del prototipo, la tabla
  de la factura cerrada con una línea y los importes a favor en verde. La
  leyenda de vertido solo sale si hay vertido.

Queda la fase 3 del rediseño: los electrodomésticos, cuando estén sus sensores.

## 0.24.0

### La Home nueva (fase 2 de 3)

La segunda pasada del rediseño: la pantalla de inicio deja de ser un panel de
cifras y pasa a contar el día. Tres piezas, y las tres estrenan el formato de
componente web (shadow DOM, estilo encapsulado), pensando en que algún día la
app viva fuera del add-on.

- **El caudal** sustituye al diagrama de nodos: cada corriente es una cinta
  cuyo ancho es su potencia, con los orígenes a la izquierda y los destinos a
  la derecha. Por debajo del kilovatio se enseñan vatios —«0,0 kW» con la cinta
  dibujada parecía un error— y los contadores del día pasan a una fila propia
  que hace también de leyenda.
- **La ventana de energía gratis**: el tramo del día en el que la previsión
  solar da más de lo que la casa gasta de normal. Dentro, lo que se enchufe lo
  paga el sol; fuera, la red. El umbral es el consumo típico de la casa (la
  mediana de la última semana, no la media) y los cortes se interpolan entre
  puntos de la previsión: decir «abre a las 12:00» cuando abre a las 11:40 es
  media hora regalada. Necesita el sensor de previsión solar de Ajustes; sin
  él, la tarjeta no aparece.
- **El cierre del día**: con la puesta de sol, la ventana deja paso a un
  resumen — lo producido, lo consumido, la autosuficiencia y qué parte del
  consumo cayó dentro de la ventana. «Ver el día completo» lo despide hasta
  la noche siguiente.
- Las horas de la ventana se enseñan **en la hora de la casa**, no en la del
  navegador: mirándola de viaje ya no sale desplazada.

Del prototipo quedan fuera, a conciencia, el ahorro en euros y la racha de
días: pedirían una tarifa «la mía» y un histórico propio que hoy no existen, y
antes que inventar la cifra que más se mira, no se enseña. La fase 3 (los
electrodomésticos, con sus sensores) sigue pendiente.

## 0.23.0

### El sistema visual del prototipo (fase 1 de 3)

Primera pasada del rediseño de Claude Design: los cimientos del lenguaje visual,
aplicados a las pantallas que ya existen. Las funciones no cambian.

- **Tipografía nueva**: **Geist** para todo el texto e **Instrument Serif** para
  la marca, que es la voz editorial del sistema. Van empaquetadas en el add-on
  como iba Inter —el prototipo las cargaba de Google Fonts, y aquí no se hacen
  peticiones externas—. Juntas ocupan 50 kB: **15 kB menos** que la Inter que
  sustituyen.
- **Paleta del prototipo**, con los dos temas completos: superficies, tintas,
  separaciones, pistas de los controles y **colores de serie que cambian con el
  tema** (saturados sobre blanco, aclarados sobre negro). Antes los mandaba el
  servidor, que no sabe qué tema tienes puesto; ahora salen de los tokens.
- **Componentes al milímetro del diseño**: barra de pestañas de 58 px con la
  píldora activa de 46, control segmentado de 32, interruptores de 48×29,
  tarjetas sólidas.
- **El material traslúcido se retira del contenido** y queda solo en la capa de
  navegación —barra de pestañas y chip del tiempo—, como manda la revisión del
  prototipo contra la guía de Apple. Respeta `prefers-reduced-transparency`.
- **Velo de desvanecido** sobre la barra de pestañas: sin él, el texto se
  transparentaba a través del material y no se leía.

Quedan la fase 2 (Home nueva: el caudal, la ventana de energía gratis y el
cierre del día) y la fase 3 (electrodomésticos).

## 0.22.0

### La configuración ya está en una carpeta que puedes ver

Hasta ahora vivía en `/data`, que es almacenamiento interno del add-on y **no
está compartido**: para leerla hacía falta el add-on avanzado de SSH con el modo
protegido desactivado. Por eso costaba tanto llegar a ella.

Vatia declara ahora `map: addon_config`, así que el Supervisor le da una carpeta
propia y la expone en **`/addon_configs/<slug>/vatia.json`**, visible desde
**Samba, el File Editor, Studio Code Server** o el add-on de *Terminal & SSH*.
Se puede leer, editar a mano y respaldar sin trucos.

- **Se migra sola**: si la configuración está todavía en `/data` —o es el
  `ebilling.json` de antes del cambio de nombre, ahí o en la carpeta nueva— se
  adopta al arrancar y se reescribe en su sitio. No hay que hacer nada.
- **Queda una copia en `/data`**, que es lo que archiva el Supervisor al hacer
  una copia de seguridad del add-on: si restauras y solo viene `/data`, la
  configuración sigue ahí. Manda siempre la de la carpeta compartida.
- **Un JSON roto ya no borra la configuración.** Ahora que se puede editar a
  mano, una coma de más es un caso previsible: el fichero se aparta como
  `vatia.json.invalido` —tu edición no se tira— y se recupera la copia de
  `/data`; si tampoco hay, se parte de los valores por defecto.

La caché de precios PVPC se queda en `/data`, que es su sitio: es caché, no
configuración.

## 0.21.1

### Novedades

- **Copia de seguridad** en *Ajustes › Aplicación*: un botón descarga un
  `vatia-config.json` con tus ajustes y tus tarifas, y otro lo restaura pegando
  el contenido o eligiendo el fichero. Sirve de respaldo, para mudarse a otro
  Home Assistant y para volver atrás si algo se rompe.
- **Y resuelve la migración desde eBilling sin tocar ficheros del sistema.** La
  importación acepta también la respuesta de `api/config` del add-on antiguo,
  que se puede copiar desde el navegador: entra todo menos el token de Home
  Assistant, que va enmascarado y hay que volver a poner. Hasta ahora la única
  forma de recuperar la configuración era llegar a `/data` por SSH, que en HAOS
  requiere el add-on avanzado con el modo protegido desactivado.
- Los secretos enmascarados (`********`) conservan el valor que ya hubiera, así
  que importar dos veces no borra el token.

### Detalles

- Importar **reemplaza todas las tarifas**, así que se exige que cada una traiga
  al menos un nombre. `normalize_tariff` es deliberadamente tolerante para poder
  migrar formatos antiguos y aceptaba objetos vacíos: un pegado equivocado se
  habría llevado por delante las tarifas buenas.
- El fichero exportado incluye los secretos, porque si no no restaura del todo.
  La pantalla lo advierte: hay que tratarlo como una contraseña.

## 0.21.0

### El add-on ahora se llama Vatia

«eBilling» describía lo que fue al principio —un simulador de factura— y no lo
que es: un monitor de energía en tiempo real con reparto por origen, batería,
previsión solar y diagnóstico de sensores, donde la factura es una pantalla de
tres. Y era un nombre en inglés, genérico (así llaman las eléctricas a la
factura electrónica) e imposible de buscar. **Vatia** viene de «vatio».

El cambio es completo: el add-on, su interfaz, los sensores que publica, las
tarjetas Lovelace y la documentación.

### Qué tienes que hacer al actualizar

Home Assistant identifica los add-ons por su `slug`, así que al cambiarlo lo
trata como un add-on **nuevo**. No es una actualización automática:

1. **Instala Vatia** desde la tienda de complementos (el repositorio es el
   mismo) y **desinstala eBilling** cuando hayas terminado.
2. **Tu configuración**: copia el fichero `ebilling.json` de los datos del
   add-on antiguo a los del nuevo. Vatia lo reconoce por su nombre de antes, lo
   adopta tal cual y lo reescribe como `vatia.json`; no hay que editar nada. Si
   prefieres no tocar ficheros, vuelve a configurarlo: son cuatro pantallas.
3. **Los sensores** pasan de `sensor.ebilling_*` a `sensor.vatia_*`. Los
   antiguos desaparecen solos al reiniciar Home Assistant (se publican por la
   API de estados, no quedan registrados). Si los usas en automatizaciones o
   dashboards, actualiza el nombre.
4. **Las tarjetas Lovelace** cambian de fichero: actualiza el recurso a
   `vatia-power-flow.js` y `vatia-card.js`. **No hace falta editar las tarjetas
   que ya tengas puestas**: los nombres antiguos (`ebilling-power-flow` y
   `ebilling-card`) siguen funcionando como alias. Para las nuevas, usa los
   nuevos.

## 0.20.0

### Novedades

- **Diagnóstico** en *Ajustes › Aplicación*: el **balance de energía del día**,
  sensor a sensor. Todo lo que entra (generación, importación, descarga) frente a
  todo lo que sale (consumo de la casa, exportación, carga), con el nombre de
  cada sensor, de dónde sale su cifra —el estado, las estadísticas o la integral
  de su potencia— y la diferencia.
- Si el balance **no cuadra**, lo dice y explica qué significa: sobra energía
  cuando el consumo de la casa se queda corto o cuando la descarga y la
  importación se cuentan de más, y falta al contrario. Ningún reparto puede
  arreglar un sensor que no mide lo que crees, así que lo único honesto es
  enseñar la diferencia y de dónde sale cada cifra.

### Corregido

- **El contador de la red queda explicado del todo.** La nota del resumen («X kWh
  de lo importado fue a cargar la batería») se calculaba sumando el reparto por
  intervalos, por su cuenta, así que podía separarse de la lectura del contador y
  quedaba un hueco: el nodo decía 8,0 importados, la fila «Desde la red» 1,5 y la
  nota 6,0, y eso son 7,5. Ahora se calcula **restando del contador**, de modo
  que el nodo, la fila y la nota cuadran siempre entre sí. Lo mismo con lo
  vertido y la parte que sale de la batería.

## 0.19.2

### Corregido

- **La versión del add-on salía como «—» en Ajustes.** Se leía del `config.yaml`
  en la ruta que tiene en el repositorio, pero dentro del contenedor la
  aplicación vive en `/opt/app` y ese fichero no está un nivel por encima, así
  que no se encontraba nunca en una instalación real.
- Ahora se busca en tres sitios, por orden: la variable `VATIA_VERSION` que
  el `Dockerfile` fija desde el `BUILD_VERSION` que pasa Home Assistant, el
  `config.yaml` copiado dentro de la imagen, y la ruta del repositorio para
  cuando se ejecuta en desarrollo.

## 0.19.1

### Corregido

- **La energía importada aparece entera como origen del consumo.** La versión
  anterior ya no se la tragaba, pero la repartía a prorrata con el sol y la
  batería, y se quedaba corta: con 2,15 kWh importados enseñaba 1,39. Lo
  importado que **no ha cargado la batería** no tiene otro sitio al que ir: es
  una entrega medida por el contador de la compañía, no una estimación. Ahora se
  atribuye entera y el sol y la batería se reparten el resto.
- Esto no confunde una carga desde la red con consumo de la casa: el reparto se
  hace **intervalo a intervalo**, así que en los tramos en los que la batería sí
  carga de la red esa parte se descuenta antes (es la fila «de lo importado fue
  a cargar la batería»).
- **La descarga que se vierte a la red ya no cuenta como consumo de la casa.**
  Si se exporta más de lo que ha generado el sol, la diferencia sale de la
  batería y no la ha consumido la casa; antes se atribuía igualmente.

## 0.19.0

### Novedades

- **Tema claro, oscuro o automático**, en *Ajustes › Aplicación › Apariencia*.
  «Automático» sigue al sistema y cambia solo cuando el móvil entra en modo
  oscuro, sin recargar. La elección se guarda en el add-on, así que es la misma
  en todos tus dispositivos, y se aplica **antes del primer pintado**: no hay
  destello del tema contrario al abrir.
- **La versión del add-on se ve dentro de la app**, en esa misma pantalla. Sirve
  para comprobar de un vistazo qué versión está corriendo de verdad cuando algo
  no cuadra tras actualizar.

### Corregido

- **En el día en curso, el desglose no cuadraba con la leyenda.** La leyenda
  toma el contador y el desglose salía de las estadísticas, que van con hasta
  cinco minutos de retraso: «Casa 0,67 kWh» arriba y 0,75 en «Origen del
  consumo». La Home ya ajustaba el reparto al contador; ahora ese ajuste es
  **el mismo código** para las dos pantallas, así que no pueden separarse.

## 0.18.9

### Corregido

- **La energía importada desaparecía del origen del consumo.** El nodo de la red
  mostraba 2,15 kWh importados y, justo debajo, el anillo de la casa no tenía
  tramo azul y el resumen decía «Desde la red 0 kWh». No era un contador mal
  leído: era el modelo, que se tragaba la importación.
- Cuando hay **contador del consumo de la casa**, los orígenes se rellenaban en
  orden —primero el sol, luego la batería y **la red al final, con el resto**—.
  Si el sol y la batería ya cubrían el consumo, a la red le tocaba cero **diga
  lo que diga su contador**: `imported` ni siquiera se leía en ese camino.
- Ahora los tres orígenes se reparten **a prorrata de lo que cada contador dice
  haber aportado** (el sol que no se vertió ni cargó la batería, toda la
  descarga, y lo importado que no acabó en la batería). Con contadores
  coherentes la oferta es exactamente el consumo, el factor vale 1 y **no cambia
  nada**; cuando no cuadran, el desajuste se reparte entre los tres en vez de
  caerle entero al último de la cola.
- Si los contadores se quedan **cortos** para el consumo medido, el hueco sigue
  siendo de la red, que es lo único que puede aportar sin que lo veamos.

## 0.18.8

### Corregido

- **Un contador que marca cero tampoco manda sobre una potencia que sí mide.**
  La 0.18.7 arregló el cero que venía de unas estadísticas vacías, pero quedaba
  el otro camino: un contador cuyo **estado** dice 0 (o cuyas estadísticas suman
  0). Se veía «Importada 0 kWh» justo encima de una curva de importación de
  900 W durante cinco horas: la leyenda y su propio gráfico contradiciéndose.
- Ahora, en cualquiera de los tres sitios donde se lee un contador —el estado,
  las estadísticas y el estado recacheado del modo «diario»—, un cero cede ante
  la integral de su sensor de potencia. Un contador a cero mientras su potencia
  lleva horas midiendo no está midiendo, o todavía no ha empezado.
- El **reparto** usa esos mismos buckets de potencia cuando el contador no
  aporta ninguno o los aporta todos a cero. Antes repartía sobre un cero que no
  era real y la diferencia acababa en el residuo.

## 0.18.7

### Corregido

- **Un contador sin estadísticas se enseñaba como un cero medido.** Si un sensor
  de energía está configurado pero el `recorder` no guarda estadísticas suyas
  para ese periodo, la lectura salía como `0` y se presentaba con la misma
  autoridad que un dato real: la leyenda decía «Importada 0 kWh» mientras el
  desglose, justo debajo, repartía kWh «desde la red». Dos cifras que se
  contradicen. Ahora **«sin datos» y «cero» son cosas distintas**.
- **Respaldo desde la potencia.** En el rango de día y en la Home, el contador
  que no tenga estadísticas se deduce **integrando su sensor de potencia**, que
  ya está configurado en el flujo de energía. Así la leyenda y el reparto salen
  de la misma cifra en lugar de que una valga cero y la otra tenga que
  inventarse un residuo. Se piden todas las potencias configuradas, no solo las
  de la vista, para que el reparto no dependa de qué gráfico estés mirando.
- **Si no hay nada que leer, no se enseña un número.** Una magnitud sin contador
  y sin sensor de potencia muestra «--» en la leyenda en vez de un cero.
- Con solo sensores de **potencia** y ningún contador de energía, el rango de
  día ya muestra el desglose (antes se quedaba vacío).

## 0.18.6

### Corregido

- **El total de la casa en los gráficos no coincidía con «Origen del consumo»**,
  que sí estaba bien. Eran dos causas distintas:
  - En el **rango de día**, el total de la leyenda caía a la integral de la curva
    de potencia cuando no había contador del consumo (o el sensor estaba
    invertido), y esa integral es cero. Ahora usa el total que deduce el reparto
    por balance, el mismo que muestra el desglose: la leyenda decía 0 kWh y el
    desglose 3,17.
  - En **semana y mes**, la línea de la casa se calculaba sobre los buckets del
    gráfico (días) mientras el desglose usaba los finos (horas). Dos repartos
    distintos, dos cifras distintas: 336 kWh frente a 105. Ahora la línea sale
    del reparto fino y se agrupa después, así que es la misma cifra —y más
    exacta, que es la razón de repartir intervalo a intervalo—.
- **Un cero del contador de la casa ya cuenta como medida.** Antes, en un
  intervalo en el que el contador decía 0 se deducía el consumo por balance, lo
  que inventaba consumo y hacía que la suma se pasara del contador (19,04 kWh
  frente a los 18,48 del sensor). Ahora la decisión se toma una vez por periodo:
  si el contador suma algo, manda el contador en todos los intervalos; si no
  suma nada (no está configurado o el sensor está invertido), se deduce por
  balance en todos por igual, sin mezclar.
- Con esto, **el total de la casa coincide en los cinco rangos** con el desglose
  y, cuando hay contador, es exactamente el del contador.

## 0.18.5

### Corregido

- **La casa aparecía en negativo.** La potencia y la energía son magnitudes: no
  pueden ser negativas. Salían de tres sitios y los tres estaban abiertos:
  - la **potencia** se mostraba tal cual la daba el sensor, así que un sensor
    con el signo invertido (o un medidor neto puesto en la casilla del consumo)
    pintaba «−1,42 kW» en el círculo de la casa;
  - un **incremento negativo de un contador** —que no es energía negativa, es un
    contador que se ha reiniciado, algo que los diarios hacen cada medianoche—
    se sumaba al total y lo restaba;
  - el consumo calculado **integrando la potencia de la casa** arrastraba el
    signo de las medias negativas.
- Ahora se recorta a cero en los tres caminos, y si el contador del consumo de
  la casa resulta inservible (total negativo) se **descarta y el consumo se
  deduce por balance**, que es lo que ya hacía el resumen: así el círculo de la
  casa y el resumen dicen lo mismo en lugar de un 0 que no cuadraba.
- Comprobado con un Home Assistant de prueba que mete negativos a propósito
  (sensor de la casa invertido y contadores que se reinician tres veces al día):
  ni un solo número por debajo de cero en la Home ni en los cinco rangos del
  gráfico de energía, con las cinco vistas.

## 0.18.4

### Corregido

- **En el rango de día, los totales de la leyenda no salían de tus contadores**:
  se calculaban **integrando la curva de potencia** en pasos de 5 minutos, que es
  una aproximación (las medias se comen los picos y cualquier hueco del sensor se
  pierde). Por eso la generación solar del gráfico no coincidía con el sensor —ni
  con lo que mostraban semana o mes, que sí usan el contador—. Medido con un
  contador un 12 % por encima de la integral: la leyenda decía 24,0 kWh y el
  sensor 26,88.
- Ahora **cada serie del rango de día toma su total del contador que le
  corresponde** (solar, importada, exportada, carga, descarga y casa), incluida
  la curva de **ayer**, que usa el contador del día anterior. La curva sigue
  siendo la potencia y el valor de un punto seleccionado sigue en W.
- Si una serie no tiene contador configurado (el consumo de la casa, por
  ejemplo), se integra su potencia como antes; la previsión solar siempre se
  integra, porque no hay contador de algo que no ha pasado.

## 0.18.3

### Cambios

- El resumen de energía **ya no repite los contadores de la red**: sus lecturas
  están en el nodo de la red del diagrama, justo encima. Al pie solo queda la
  frase que explica la diferencia cuando existe («1,09 kWh de lo importado fue a
  cargar la batería, así que no lo consumió la casa»), y si no hay diferencia no
  se muestra nada.

## 0.18.2

### Cambios

- En el círculo de la batería del flujo de energía, **las flechas estaban al
  revés**: ahora la **descarga apunta hacia arriba y en rojo** (energía que sale
  de la batería hacia otro elemento) y la **carga hacia abajo y en verde**
  (energía que entra). Corregido en la Home del add-on y en la **tarjeta de
  Lovelace**.

## 0.18.1

### Corregido

- **Sensores bidireccionales**: muchos medidores e inversores dan un **único
  sensor con signo** (+ importa / − exporta, + carga / − descarga) en vez de dos
  separados. Al asignarlo a las dos casillas, el add-on lo leía **dos veces** y
  recortaba los negativos a cero, de modo que importación y exportación salían
  **idénticas** y aparecían **cifras negativas** en los gráficos. Reproducido con
  un medidor de red bidireccional: `grid_import` y `grid_export` daban ambos
  −2.000 W y 0,5 kWh. Ahora se **reparte por signo** en toda la cadena (flujo,
  resumen, contadores y los cinco rangos del gráfico): con un día real de 18 kWh
  importados y 12 exportados, todas las pantallas muestran 18 y 12.
  - Con un **contador neto** de energía, el estado del sensor (el neto) no sirve
    para ninguna de las dos direcciones: los totales salen siempre de las
    estadísticas, y el reparto por signo se hace **antes** de agrupar en el
    bucket del gráfico (un bucket de un día ya viene sumado y el signo se
    pierde). Por eso semana, mes y año bajan a horas. En **Total** (diez años) se
    reparte por días, así que ahí las cifras son aproximadas.
- **Nunca se dibujan magnitudes negativas** en los gráficos: un valor negativo en
  un sensor de un solo sentido se trata como cero, en lugar de restar del total
  de la leyenda.
- **Las filas del resumen suman exactamente su total**, que a su vez es el del
  contador: el reparto por intervalos se reescala para absorber los minutos que
  las estadísticas van por detrás del estado. Si las estadísticas cubren menos de
  la mitad del total (recorder incompleto), se vuelve al reparto sobre totales en
  vez de dar una precisión falsa.

## 0.18.0

### Cambios

- **El reparto de energía se calcula intervalo a intervalo, no sobre el total
  del día.** Los contadores dicen lo que entra y sale por cada punto, pero
  ninguno mide el reparto (no existe un sensor «solar → casa»): hay que
  deducirlo, y el resultado depende de *cuándo* pasa cada cosa. Hacerlo una sola
  vez sobre los totales del día perdía esa información.

  Ejemplo medido: batería cargada **de la red** de 00:00 a 03:00 (6 kWh) y sol de
  10:00 a 16:00 (24 kWh, 12 vertidos).

  | | Sobre el total del día | Intervalo a intervalo |
  |---|---|---|
  | Generación → a la casa | 6,0 kWh | **12,0 kWh** |
  | Generación → a la batería | 6,0 kWh | **0,0 kWh** |
  | Casa ← desde solar | 6,0 kWh | **12,0 kWh** |
  | Casa ← desde la red | 7,5 kWh | **1,6 kWh** |
  | Importado que fue a la batería | 0,0 kWh | **6,0 kWh** |

  Resolución del reparto: **5 minutos** en la Home y en el rango de día, **1
  hora** en semana y mes, y el bucket del gráfico en año y total (donde serían
  miles de intervalos). No supone ninguna petición extra a Home Assistant en la
  Home ni en el rango de día: esos datos ya se descargaban y se estaban
  desaprovechando al sumarlos antes de repartir.
- En el modo **«los contadores ya son del día en curso»**, los totales siguen
  saliendo del estado del sensor (van al segundo) y ahora se piden además las
  estadísticas para poder repartir con detalle.

## 0.17.5

### Cambios

- **El resumen de energía deja claro por qué «Desde la red» no es el contador de
  importada.** No era un error de cálculo: la columna reparte el consumo de la
  casa por origen, y «Desde la red» es solo la parte de la importación que ha
  consumido la casa; lo que se importa para **cargar la batería** no lo consume
  la casa. Auditado con datos coherentes (entra 10 solar + 5 importada +
  2 descarga = sale 8 exportada + 3 carga + 6 casa): el reparto es exacto y la
  diferencia de 1 kWh es justo lo que la red cargó en la batería.
- Al pie del resumen se muestran ahora los **contadores de red del día**
  (importada y exportada) y, cuando no cuadran con el reparto, **la frase que lo
  explica** («1 kWh de lo importado fue a cargar la batería», «X kWh de lo
  vertido salió de la batería»). `api/live` expone esos residuos en
  `energy.meters.grid_to_battery` y `energy.meters.battery_to_grid`.

## 0.17.4

### Corregido

- **En el círculo de la red, el valor de energía importada no era el de tu
  contador.** Los dos números del nodo venían del *reparto* del consumo por
  fuentes: `←` coincidía con el sensor de exportada (porque casi siempre lo
  vertido es menor que lo generado), pero `→` mostraba «cuánta de la energía que
  ha consumido la casa venía de la red», que puede ser muy distinto de lo que ha
  cruzado el contador (la importación que va a cargar la batería, por ejemplo, no
  la consume la casa). Auditado con contadores del día de valores conocidos y
  distintos: con 4 kWh exportados y 3 importados, el círculo mostraba `← 4` y
  `→ 1`.
- Ahora **cada círculo muestra el contador del día de su propio punto**: red `←`
  exportada y `→` importada, batería `↑` carga y `↓` descarga, solar su
  generación y casa su consumo. El **reparto por fuentes** sigue donde
  corresponde: el anillo de la casa y el resumen de energía. `api/live` expone
  las lecturas del día en `energy.meters`.

## 0.17.3

### Corregido

- **El interruptor de «Publicar sensores» (y el de «Proyección fin de ciclo») se
  veía roto**: una regla genérica `input[type="checkbox"] { width: 18px; height:
  18px }` ganaba en especificidad y aplastaba la pista a 18 px, con lo que el
  círculo de 22 px se salía y parecía un elemento a medio cargar. Además, la
  pista apagada usaba un negro al 12 % que sobre la superficie clara no se veía.
  Ahora el interruptor mide 46×28, la pista apagada tiene color propio en claro y
  oscuro, y el círculo responde al pulsarlo.

## 0.17.2

### Cambios

- En el **círculo de la casa** del flujo de energía, la **potencia instantánea**
  pasa a ser el dato grande y el acumulado del día el pequeño, igual que en el
  de generación: el dato principal de un diagrama de flujo es el instantáneo.
  Corregido tanto en la Home del add-on como en la **tarjeta de Lovelace**.

## 0.17.1

### Cambios

- **Tipografía propia**: la interfaz usa **Inter** (SIL OFL), empaquetada con el
  add-on como subconjunto latino de 64 kB y servida en local, sin depender de la
  fuente del sistema ni de ninguna petición externa. Cuerpo base de 15 → **16 px**
  con interlineado 1,5, y jerarquía revisada: títulos algo menores y mejor
  compensados de espaciado, y **todo el texto pequeño más grande** (etiquetas de
  campo 13,5 → 15 px, notas 12 → 13 px, ejes de los gráficos 10-11 → 11,5 px).
  Cifras con ancho fijo (`tabular-nums`) en ejes y leyendas.
- **Contraste corregido en toda la app**, con los valores medidos sobre los
  píxeles reales compuestos. Los problemas eran:
  - **Texto blanco sobre el cielo**: daba **1,3:1** con el cielo claro del
    mediodía (el mínimo legible es 4,5:1). El velo del fondo pasa a ser
    permanente y **más fuerte donde el cielo es claro** (arriba y abajo del
    degradado): el peor caso queda en **4,6:1** y el cielo se compensa con más
    saturación para no perder el color de la hora.
  - **Etiquetas de los controles segmentados**: eran blancas sobre una pista
    clara. Ahora van en tinta oscura, como en iOS (**9:1**).
  - **Grises secundarios**: `#7c869e` sobre las tarjetas daba 2,8:1; ahora
    `#566072` y superficies más opacas (0,62 → 0,88) dan **≥4,9:1** con
    cualquiera de los fondos, incluido el nocturno con el sistema en modo claro.
  - **Chip de meteorología**: llevaba texto blanco sobre superficie clara; ahora
    tiene su propia superficie oscura (**18,9:1**).
  - **Ejes de los gráficos**: usaban `currentColor` al 55 %; ahora un color
    propio con contraste garantizado.
  - La **marca de verificación** de la leyenda se pinta oscura sobre las series
    de color claro (ámbar, oliva, turquesa), donde en blanco no se veía.

## 0.17.0

### Corregido

- **El zoom con los dedos ya es fluido.** Los gestos estaban enlazados al `<svg>`
  del gráfico, que se recrea en cada dibujado: el primer paso del pellizco lo
  sustituía y el gesto se perdía, así que cada pellizco daba un único salto de
  zoom. Ahora viven en el contenedor, que persiste, el zoom sigue a los dedos de
  forma continua (y al juntarlos vuelve a reducirse) y el redibujado se agrupa en
  un frame de animación. Arrastrar con un dedo desplaza el eje y una pulsación
  limpia sigue seleccionando el punto.
- **Facturación aparece con la simulación cargada** sin pulsar su segmento. El
  listener de subvistas se aplicaba a *todos* los `.seg`, incluidos los del rango
  de la pantalla de Energía: usar «Semana» o «Mes» desactivaba las subvistas de
  Facturación y la dejaba en blanco.

### Nuevo

- **Pantalla de carga inicial**: mientras se leen la configuración y los
  sensores, la app muestra una tarjeta «glass» con el logo, un indicador de
  progreso circular y el paso en curso, en lugar de dejar ver las tarjetas a
  medio construir. Desaparece con una transición cuando llegan los datos.
- **Ajustes organizados por niveles**, al estilo de los Ajustes de iOS: un índice
  con cuatro secciones (Datos · Sensores · Facturación · Integración) y ocho
  categorías, cada una con su propia pantalla y su botón de volver. Cada fila
  muestra un resumen de lo que hay configurado (fuente activa, número de tarifas,
  potencias y día de ciclo, estado de los sensores publicados).
- La **barra de guardar** queda adherida sobre la barra de pestañas, siempre
  visible y sin quedar tapada por ella.

## 0.16.1

### Nuevo

- **Si tus sensores ya miden el día en curso, se usan tal cual.** Nuevo ajuste
  *Contadores de energía → Qué miden*:
  - **Detectarlo automáticamente** (por defecto): compara el estado del sensor
    con el incremento del día; si coinciden, el sensor ya es diario y se usa su
    estado, que va al segundo en vez de esperar a las estadísticas.
  - **Ya son del día en curso**: se leen los estados directamente, sin consultar
    estadísticas.
  - **Son acumulados**: se calcula el incremento desde la medianoche.

### Cambios

- El **desglose del día** de la pantalla de Energía usa exactamente los mismos
  totales que la Home (antes los recalculaba por su cuenta y podían diferir unos
  minutos). Los días pasados siguen saliendo de las estadísticas.

## 0.16.0

### Corregido

- **Los totales del día se calculan, no se leen del sensor**: el flujo de
  energía y el resumen de la Home tomaban el estado de los sensores de energía,
  que normalmente son **contadores acumulados desde el inicio del histórico**
  (`total_increasing`). Ahora el add-on pide a las estadísticas el
  **incremento desde la medianoche local** de cada contador (y solo usa el
  estado como último recurso, si el sensor no tiene estadísticas).
- Las series de semana, mes y año ya no dibujan **ceros en los buckets
  futuros**: el eje llega hasta el final del periodo, pero los días sin datos
  quedan como hueco.
- Los valores guardados en los selectores de sensores se conservan aunque la
  entidad no esté en la lista (no disponible en ese momento).
- El **consumo de la casa se mide, no se deduce**: si tienes configurado su
  sensor de potencia (en el flujo de energía) se integra para obtener los kWh
  del día; si además tienes un contador de consumo en kWh, puedes indicarlo en
  *Contadores de energía → Casa*. Solo se deduce por balance cuando no hay
  ninguno de los dos.
- El **reparto** ya no puede sumar más que el total: lo que carga la batería por
  encima de lo generado se atribuye a la red y los orígenes del consumo se
  reparten hasta cubrir exactamente el total (antes, con contadores diarios
  reales, los porcentajes podían pasar del 100 %). El modelo es ahora **el mismo
  en la Home y en la pantalla de Energía** (`series.split_flows`).
- Los totales del día se leen del periodo de **5 minutos** (así van casi al día,
  sin esperar a que se consolide la hora) y se **cachean 2 minutos**, para no
  abrir una conexión con Home Assistant en cada refresco de la Home.

### Nuevo

- **Previsión de generación solar** en el gráfico de la vista solar: cuando el
  intervalo incluye horas futuras se dibuja como **línea punteada y sin
  leyenda**. Se configura en **Ajustes → Previsión solar** y es compatible con
  **Solcast** (`detailedForecast` / `detailedHourly`) y **Forecast.Solar**
  (`watts`, `wh_days`).
- **Zoom del eje del tiempo** en todos los gráficos de Energía: pellizca con
  dos dedos (o `⌘`/`Ctrl` + rueda), arrastra para desplazarte y pulsa el
  indicador `1.0×` para restablecerlo. El eje Y se queda fijo al desplazarse.
- **Selector de periodo pulsable**: el rótulo del intervalo abre el **control
  de fecha del sistema**; al elegir un día se muestra el día, la semana, el mes
  o el año que lo contiene, según el rango activo.
- Botón **Totales** para deshacer la selección de un punto y volver a los
  totales del periodo.

### Cambios

- Las leyendas muestran el **total de energía del periodo** de cada serie
  (antes, en la vista de día, mostraban el máximo de potencia).
- Al entrar en cualquier gráfico **todas las series están visibles** y sin
  punto seleccionado.
- Todas las series con leyenda se dibujan como **línea con su área
  translúcida** (también en semana, mes, año y total, que antes eran barras).
  La curva de **ayer** va al fondo y con un área más tenue.
- **Guías de Apple (HIG)**: zonas interactivas de al menos 44 px (iconos de
  vista, segmentos de rango, flechas, barra de pestañas), tipografía y
  jerarquía revisadas, **indicador de progreso** superior mientras se cargan
  datos y **spinner** sobre el gráfico, foco visible con teclado y respeto por
  `prefers-reduced-motion`.

## 0.15.0

### Nuevo

- **Pantalla «Energía»**: al pulsar el resumen de energía de la Home se abre una
  vista de análisis con:
  - Selector de rango **Día · Semana · Mes · Año · Total** y navegación al
    periodo anterior.
  - Selector de vista por iconos: **general, solar, casa, batería y red**.
  - En **día**, curvas de **potencia (W)** cada 5 minutos con la serie de
    **ayer** como comparación; en el resto, **energía (kWh)** por día, mes o
    año en barras.
  - **Leyenda interactiva**: cada serie se activa o desactiva y muestra el
    total del periodo o, al **pulsar un punto del gráfico**, el valor de ese
    instante (doble pulsación para deseleccionar).
  - Tarjeta de **reparto del periodo** (origen del consumo o destino de la
    generación) con barra apilada y porcentajes.
- Nuevo endpoint `/api/series`, que lee las **estadísticas de largo plazo** de
  Home Assistant y toma las unidades de los metadatos de cada estadística.

## 0.14.0

### Cambios

- **Meteorología con sensores independientes**: la condición y la temperatura
  exterior se toman de **dos sensores** que eliges en Ajustes, en lugar de una
  entidad `weather.*`. El sensor de condición acepta los estados de HA
  (`sunny`, `partlycloudy`, `rainy`…) o **texto en castellano** («Parcialmente
  nuboso», «Lluvia débil», «Cielo despejado»…): se interpreta para elegir el
  icono y el fondo.
- **Las tarifas se gestionan desde los dos sitios**: la lista completa (crear,
  editar, duplicar, CSV, eliminar) está ahora también en **Ajustes → Tarifas**,
  además de en Facturación.
- Al abrir **Ajustes** las entidades de Home Assistant se cargan solas, sin
  tener que pulsar «Buscar entidades».

## 0.13.0

### Nuevo

- **Rediseño completo de la aplicación** con estética de app web iOS
  («glass»): superficies translúcidas, tipografía del sistema, hojas
  modales y **barra de navegación inferior** con tres secciones.
- **Home**: el diagrama de **flujo de energía en vivo** (leído ahora por el
  propio add-on desde tus sensores de HA) y, debajo, el **resumen de energía
  del día** con generación (a la casa / a la batería / a la red) y consumo de
  la casa (desde solar / desde batería / desde la red), con barras apiladas y
  porcentajes.
- **Fondo dinámico** según el **momento del día** (noche, amanecer, día,
  atardecer, a partir de `sun.sun`) y las **condiciones meteorológicas**
  (nubes, lluvia, nieve, niebla), más **icono del tiempo y temperatura
  exterior** en la cabecera, tomados de una entidad `weather.*` (autodetectada)
  y, opcionalmente, de un sensor de temperatura propio.
- **Facturación** agrupa el simulador, el detalle por día/hora y la gestión de
  tarifas en un control segmentado.
- **Ajustes** reorganizados en secciones tipo lista de iOS: fuente de datos,
  sensores del flujo, sensores de energía del día, meteorología, contrato y
  publicación de sensores.
- Nuevo endpoint `/api/live` (flujos, resumen del día, tiempo y fase del día) y
  `/api/entities/grouped` para los selectores de Ajustes.

## 0.12.0

### Corregido

- **Regresión**: al rediseñar la tarjeta en 0.11.0 desaparecieron los **valores
  de potencia por línea**. Vuelven, colocados sobre cada carril con halo.
- Las constantes del módulo se declaraban en el **ámbito global** (`S`, `R`,
  `CX`…), lo que podía colisionar con otras tarjetas del panel: todo el archivo
  va ahora dentro de un IIFE y no se redefine si el recurso se carga dos veces.
- Las **secciones del anillo** tenían un área de pulsación de 4,5 px (casi
  imposible de acertar en móvil): ahora 20 px, además de foco por teclado.

### Cambios

- **Enrutado ortogonal** de las líneas, con carriles paralelos y esquinas
  redondeadas, en lugar de arcos sueltos.
- Las **líneas activas se colorean** con el color de su origen (las inactivas
  quedan en gris tenue), de modo que el flujo se entiende sin mirar las bolas.
- **Iconos rediseñados**: panel solar con retícula, torre de alta tensión, casa
  en silueta y batería cuyo **relleno refleja el estado de carga**.
- El color de la **casa** por defecto es neutro (hereda el del tema), en vez de
  repetir el ámbar del solar.
- Cifras con **numeración tabular**, mensaje de ayuda si no hay sensores
  asignados, `aria-label` descriptivo y menos escrituras en `localStorage`.

## 0.11.0

### Cambios

- **Rediseño de la tarjeta `vatia-power-flow`** con disposición en **cruz**
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

- Tarjeta `vatia-power-flow`:
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

- En el editor de la tarjeta `vatia-power-flow`, el sensor de **estado de
  carga de batería (%)** no aparecía en su desplegable porque se filtraba por
  unidades de potencia (W/kW). Ahora ese campo se filtra por porcentaje (`%` /
  `device_class: battery`).

## 0.8.1

### Nuevo

- La tarjeta `vatia-power-flow` permite configurar **sensores de energía
  diaria** (kWh) por fuente (producción solar, importada/exportada de red,
  carga/descarga de batería). Cuando se definen, el **anillo de la casa** se
  pinta con esos totales reales del día; si no, se mantiene el cálculo
  aproximado en el navegador. El editor visual incluye ahora ese grupo de
  sensores.

## 0.8.0

### Cambios

- **Tarjeta `vatia-power-flow` rediseñada** con nueva disposición (solar
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

- **Tarjeta `vatia-power-flow` rediseñada**: iconos vectoriales (sol, red,
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
  `sensor.vatia_<tarifa>_monedero`.

## 0.5.0

### Nuevo

- **Nueva tarjeta Lovelace `custom:vatia-power-flow`** (en
  `dist/vatia-power-flow.js`): diagrama **animado** del flujo de potencia
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

- **Tarjeta Lovelace** `custom:vatia-card` (servida en `dist/`,
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

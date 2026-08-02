# Changelog

Todas las versiones relevantes del add-on Vatia.

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

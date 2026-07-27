# Changelog

Todas las versiones relevantes del add-on Vatia.

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

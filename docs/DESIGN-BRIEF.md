# Brief para Claude Design — rediseño completo de eBilling

> Cópialo entero como prompt. Está escrito para que quien lo lea no necesite ver
> el código: incluye el contexto, las restricciones duras del entorno, los datos
> reales que se pintan, los defectos medidos y el entregable esperado.

---

## 1. Tu papel

Actúa como **diseñador de producto y de interacción senior** especializado en
apps móviles nativas (iOS/iPadOS) y en visualización de datos energéticos.
Quiero una **propuesta de diseño completa** para rehacer la interfaz de una
aplicación que hoy existe y funciona, pero cuya interfaz «se nota demasiado que
es web»: torpe, con animaciones y gestos que no se sienten nativos, un efecto de
cristal pobre y controles que parecen rotos.

No estás diseñando desde cero un producto nuevo: la lógica de negocio, los datos
y las pantallas ya existen y son correctas. Lo que hay que rehacer es **la capa
de interfaz, interacción y movimiento**, y el sistema de diseño que la sostiene.

---

## 2. Qué es el producto

**eBilling** es un add-on de Home Assistant que simula **en tiempo real la
factura de la luz** de una vivienda española con autoconsumo solar, y compara
varias tarifas eléctricas en paralelo.

Usuario: propietario de una instalación fotovoltaica doméstica en España, con
Home Assistant ya montado. Perfil técnico medio-alto, pero la app la abre desde
el móvil, muchas veces varias veces al día, para dos cosas:

1. **«¿Qué está pasando ahora en mi casa?»** → consulta rápida, de segundos, al
   flujo de energía y al consumo del día.
2. **«¿Cuánto voy a pagar y con qué tarifa me conviene estar?»** → consulta más
   pausada, de análisis.

El producto tiene **tres artefactos** que deben compartir sistema de diseño:

| Artefacto | Dónde vive | Notas |
|---|---|---|
| **App del add-on** | Panel lateral de Home Assistant, dentro de un iframe (Ingress) | Es el 90 % del trabajo |
| **Tarjeta de flujo de energía** | Dashboard de Home Assistant (tarjeta Lovelace) | Debe respetar el tema del usuario de HA |
| **Tarjeta de comparativa de tarifas** | Dashboard de Home Assistant | Idem |

---

## 3. Restricciones duras del entorno (no negociables)

Esto condiciona el diseño más que cualquier otra cosa. Diseña **sabiendo** esto:

1. **Se ejecuta dentro de un iframe** en Home Assistant (mecanismo «Ingress»).
   Todas las URLs deben ser **relativas**. No hay control de la barra de estado,
   ni gestos de navegación del sistema, ni transiciones entre pantallas del SO.
2. **El usuario lo abre casi siempre desde la app móvil de Home Assistant**
   (WebView: WKWebView en iOS, Chrome WebView en Android), y a veces desde el
   navegador de escritorio. El «marco» de la app de HA ya pone su propia barra
   inferior: nuestra interfaz vive dentro de ese marco.
3. **Sin red externa en tiempo de ejecución.** Muchas instalaciones de HA están
   en redes sin salida a internet o con DNS filtrado. Nada de CDNs, Google
   Fonts, tiles de mapas ni telemetría. **Todo activo (fuentes, iconos,
   librerías) va empaquetado y servido por el propio add-on.**
4. **Sin proceso de build obligatorio.** Hoy el frontend es HTML + CSS + JS
   vanilla servido tal cual por un backend Python (FastAPI). Se puede aceptar un
   paso de build si el beneficio es grande, pero cada dependencia hay que
   justificarla: el add-on se distribuye como imagen Docker para tres
   arquitecturas (amd64, aarch64, armv7) y a veces corre en una Raspberry Pi.
5. **Presupuesto de peso**: el frontend actual son ~4.100 líneas (HTML+CSS+JS) y
   una fuente de 64 kB. Objetivo: **≤ 400 kB** de assets totales sin comprimir
   para la app, y **≤ 60 kB** por tarjeta de Lovelace.
6. **Presupuesto de rendimiento**: 60 fps sostenidos en un móvil de gama media
   (equivalente a CPU 4× más lenta que un portátil). Ver §5 para el problema
   actual medido.
7. **Idioma**: interfaz **en español de España**. Números en formato español
   (coma decimal, punto de millares), unidades kW/kWh/€. No hace falta i18n ni
   RTL.
8. **Tema claro y oscuro obligatorios**, siguiendo `prefers-color-scheme`. El
   usuario puede tener el sistema en claro y estar mirando la app de noche (y
   viceversa): el diseño no puede dar por hecho que «de noche = tema oscuro».
9. **Accesibilidad**: contraste **AA (4,5:1)** verificado para todo el texto,
   zonas táctiles ≥ 44×44 pt, foco visible con teclado, `prefers-reduced-motion`
   respetado, etiquetas para lector de pantalla.

---

## 4. Inventario de pantallas y datos reales

La app tiene hoy **cuatro pantallas** (tres pestañas + una apilada) y varios
modales. Estos son los datos reales que llegan del backend; úsalos como
contenido de tus maquetas en lugar de texto de relleno.

### 4.1 Home — «¿qué está pasando ahora?»

Contenido actual:

- **Cabecera**: título, momento del día y hora («Día · 09:52»), y en la esquina
  un icono del tiempo con la temperatura exterior («☀ 29°»).
- **Fondo dinámico** que representa el momento del día (noche, amanecer, día,
  atardecer, a partir de la elevación solar) y las condiciones meteorológicas
  (nubes, lluvia, nieve, niebla). Es un rasgo de identidad del producto: quiero
  conservar la idea, pero mucho mejor ejecutada.
- **Diagrama de flujo de energía en vivo**: cuatro nodos (Solar arriba, Red
  izquierda, Casa derecha, Batería abajo) unidos por líneas por las que viaja
  una bola animada cuando hay potencia, más rápida a más potencia. Cada nodo
  muestra su **potencia instantánea en grande** y su **energía acumulada del día
  en pequeño**. Alrededor de la casa, un anillo tipo donut reparte de qué fuente
  ha consumido hoy (solar / batería / red).
- **Resumen de energía del día**: dos columnas, «Generación» y «Consumo de la
  casa», cada una con su total en kWh, una barra apilada y tres filas con el
  reparto y su porcentaje. Toda la tarjeta es pulsable y navega a Energía.

Payload real (`GET api/live`, refresco cada 20 s):

```json
{
  "configured": true,
  "power": { "pv": 3420.0, "grid_import": 0.0, "grid_export": 1150.0,
             "battery_charge": 850.0, "battery_discharge": 0.0,
             "home": 1420.0, "battery_soc": 68.0 },
  "flows": { "solar_home": 1420.0, "solar_grid": 1150.0, "solar_battery": 850.0,
             "grid_home": 0.0, "grid_battery": 0.0, "battery_home": 0.0 },
  "energy": {
    "generation": { "total": 17.64, "rows": [
      {"key": "to_load", "label": "A la casa", "kwh": 3.92, "pct": 22},
      {"key": "to_battery", "label": "A la batería", "kwh": 5.91, "pct": 34},
      {"key": "to_grid", "label": "A la red", "kwh": 7.81, "pct": 44}]},
    "home": { "total": 7.51, "rows": [
      {"key": "from_solar", "label": "Desde solar", "kwh": 3.92, "pct": 52},
      {"key": "from_battery", "label": "Desde batería", "kwh": 0.02, "pct": 0},
      {"key": "from_grid", "label": "Desde la red", "kwh": 3.56, "pct": 48}]}
  },
  "has_battery": true,
  "weather": { "condition": "Cielo despejado", "temperature": 28.6 },
  "phase": "day",
  "generated_at": "2026-07-25T09:52:11+02:00"
}
```

### 4.2 Energía — pantalla de análisis (se apila sobre Home)

- Selector de **rango**: Día · Semana · Mes · Año · Total.
- Flechas ‹ › al periodo anterior/siguiente y **rótulo del periodo pulsable**
  que abre un selector de fecha del sistema.
- Selector de **vista** por iconos: general, solar, casa, batería, red.
- **Gráfico**: en rango de día, potencia media (W) cada 5 minutos (288 puntos,
  hasta 6 series) con la curva de ayer como comparación y la **previsión solar
  como línea punteada** para las horas futuras; en el resto, energía (kWh) por
  día, mes o año. Series como línea con área translúcida.
- **Leyenda interactiva** en dos columnas: cada serie se activa/desactiva y
  muestra el total de energía del periodo; al pulsar un punto del gráfico todas
  pasan a mostrar el valor de ese instante, con un botón para volver a totales.
- **Zoom del eje del tiempo** por pellizco, con desplazamiento horizontal.
- **Reparto del periodo** debajo, con barra apilada y porcentajes.

Payload real (`GET api/series?view=&range=&offset=`):

```json
{
  "unit": "W", "chart": "line",
  "x": ["2026-07-25T00:00:00+02:00", "2026-07-25T00:05:00+02:00", "…288 valores"],
  "series": [
    { "key": "solar", "label": "Solar", "color": "#f5a524",
      "values": [0, 0, null, 3420.5, "…"], "total": 4.95, "total_unit": "kWh",
      "total_label": "total", "dashed": false, "legend": true },
    { "key": "forecast", "label": "Previsión", "color": "#ffc94d",
      "values": [null, "…"], "total": 22.38, "dashed": true, "legend": false }
  ],
  "breakdown": { "total": 7.51, "unit": "kWh", "rows": [
    {"key": "from_solar", "label": "Desde solar", "color": "#eea154", "kwh": 3.92, "pct": 52}]},
  "view": "overview", "range": "day", "offset": 0, "label": "25 jul 2026",
  "start": "2026-07-25T00:00:00+02:00", "end": "2026-07-26T00:00:00+02:00",
  "can_next": false
}
```

Claves de serie posibles y sus colores actuales: `solar` `#f5a524`, `home`
`#c9c443`, `battery_charge` `#10b981`, `battery_discharge` `#5eead4`,
`grid_import` `#6b8afd`, `grid_export` `#a78bfa`, `yesterday` `#5ab8b0`,
`forecast` `#ffc94d`. **Puedes proponer otra paleta**, pero tiene que funcionar
con 6 series simultáneas sobre superficie clara y oscura.

### 4.3 Facturación

Tres subvistas en un control segmentado:

- **Simulación**: barra de periodo con navegación por ciclos y un botón para
  fijar un intervalo cualquiera; interruptor «Proyección fin de ciclo»; cinco
  tarjetas de estadística (consumo total, punta, llano, valle, excedentes);
  **comparativa de tarifas** (una tarjeta por tarifa con su color de marca, el
  total en €, el desglose por conceptos y la etiqueta de «más barata»); gráfico
  de consumo diario apilado por periodo tarifario.
- **Detalle**: totales del periodo, gráfico diario apilado y drill-down por
  horas al pulsar un día (gráfico + tabla de 24 filas).
- **Tarifas**: lista de tarifas con acciones (editar, duplicar, exportar CSV,
  eliminar), importar CSV pegando texto o subiendo archivo, y un **editor de
  tarifa** largo (hoy un modal con ~25 campos: nombre, compañía, color,
  estructura del término de energía —3 tramos 2.0TD / 1-6 tramos libres / PVPC
  indexado—, horarios en una sintaxis propia, compensación de excedentes,
  monedero virtual, términos de potencia P1/P2, bono social, alquiler de
  contador, servicios, impuesto eléctrico e IVA).

Datos reales de una factura simulada (`GET api/simulate`):

```json
{
  "period": {"start": "2026-07-01T00:00:00+02:00", "end": "2026-08-01T00:00:00+02:00",
             "elapsed_days": 24.48, "cycle_days": 31.0, "is_current": true},
  "consumption": {"kwh": {"punta": 0.0, "llano": 2.7, "valle": 27.15},
                  "total": 29.85, "export_total": 210.07,
                  "daily": [{"date": "2026-07-01", "punta": 0.0, "llano": 0.1, "valle": 1.2}]},
  "bills": [{"tariff_id": "iberdrola-plan-estable", "name": "Plan Estable",
             "company": "Iberdrola", "color": "#00a443", "days": 24.48,
             "kwh_total": 29.85, "surplus_kwh": 210.07, "surplus_credit": 6.12,
             "surplus_excess": 12.4, "virtual_wallet": true, "wallet_credit": 12.4,
             "total": 18.44, "lines": [{"label": "Término de energía", "amount": 6.12}],
             "subtotals": {"energia": 6.12, "potencia": 6.9, "impuestos": 3.1}}],
  "errors": [{"tariff": "PVPC (regulada)", "error": "No se pudieron descargar los precios"}]
}
```

### 4.4 Ajustes

Índice por categorías (estilo Ajustes de iOS) con cuatro secciones y ocho
categorías, cada una en su propia pantalla:

| Sección | Categorías |
|---|---|
| Datos | Fuente de datos (demo / Home Assistant / InfluxDB, con sus credenciales) |
| Sensores | Flujo de energía (7 selectores) · Contadores de energía (6 selectores + un modo) · Previsión solar · Meteorología |
| Facturación | Tarifas · Contrato y ciclo (potencias P1/P2, día de ciclo, zona horaria, festivos) |
| Integración | Sensores publicados en Home Assistant (interruptor + intervalo) |

Cada fila del índice muestra un resumen («Home Assistant», «3 tarifas», «4,6 /
4,6 kW · ciclo el día 1», «Cada 5 min»). Hay una barra de guardado adherida
sobre la barra de pestañas.

**Los selectores de sensores son el punto más doloroso de la configuración
inicial**: son `<select>` nativos con cientos de entidades de Home Assistant, y
el usuario tiene que asignar hasta 14. Merece un rediseño específico (búsqueda,
sugerencias por nombre/unidad, validación, estado «asignado/sin asignar»).

### 4.5 Estado inicial y estados vacíos

- Al abrir, la app tarda 1-3 s en tener datos (dos llamadas al backend, que a su
  vez habla con Home Assistant). Hoy se cubre con una pantalla de carga.
- Si no hay sensores configurados, la Home no puede pintar el flujo.
- Si la fuente de datos es «demo», todo funciona con datos sintéticos y hay que
  comunicarlo sin ensuciar la interfaz.
- Errores frecuentes y visibles: ESIOS (precios PVPC) no responde; un sensor
  está `unavailable`; el recorder de HA no tiene estadísticas de un contador.

---

## 5. Defectos concretos que hay que resolver (medidos, no impresiones)

Estos son los que han disparado el rediseño. La propuesta tiene que atacarlos
explícitamente.

### 5.1 El zoom del gráfico va a tirones

El gráfico se redibuja regenerando el SVG entero en cada frame del gesto.
Medido con la CPU limitada a ¼ (equivalente a móvil de gama media), en el
gráfico de día (288 puntos × 6 series):

- **13,7 ms de mediana** por redibujado, **21,8 ms** en el peor caso.
- El presupuesto para 60 fps es **16,7 ms por frame**, y en ese presupuesto
  también tiene que caber el trabajo del compositor.

Conclusión: la arquitectura de dibujado actual (construir una cadena de SVG y
asignarla a `innerHTML`) **no puede** dar un pellizco fluido. Hace falta otro
enfoque: dibujado en canvas, o transformar la vista durante el gesto y
redibujar solo al terminar, o una librería de gráficos pensada para esto.
**Quiero tu recomendación razonada** (ver §8).

Además, el gesto en sí necesita: **inercia** al soltar, **límites elásticos**
(rubber-banding) en los extremos, doble toque para restablecer, y que el
pellizco ancle el punto que está entre los dedos.

### 5.2 El «liquid glass» es pobre

Hoy es `backdrop-filter: blur(26px) saturate(180%)` sobre superficies
translúcidas. Resultado: un desenfoque plano, sin refracción, sin brillo
especular en los bordes, sin reacción a la luz ni al movimiento. Además, para
garantizar el contraste del texto hemos tenido que subir la opacidad de las
tarjetas al 88 %, con lo que el efecto casi desaparece.

Quiero que resuelvas la tensión de fondo: **el material tiene que ser bonito y
el texto tiene que ser legible sobre un fondo que cambia de color a lo largo del
día**. Si propones ir más allá de CSS (una capa de canvas/WebGL con un shader de
refracción sobre una instantánea del fondo), especifica el coste y una **ruta de
degradación**: qué se ve si el shader no está disponible, si el dispositivo es
lento o si el usuario ha pedido menos movimiento.

### 5.3 Controles que parecen rotos

Ejemplo concreto y verificado: el interruptor de «Publicar sensores» (y el de
«Proyección fin de ciclo») es un `<input type=checkbox>` con
`appearance: none`, cuyo **estado apagado usa como pista un negro al 12 %**
sobre una superficie ya clara. En pantalla no se ve la pista: solo se ve el
círculo blanco flotando, y parece un elemento roto o a medio cargar. El estado
encendido sí se ve (verde).

Es el síntoma de un problema más general: **no hay una biblioteca de controles
propia**. Los `select`, `input`, `checkbox`, botones y campos numéricos son
elementos nativos con un poco de CSS por encima, y se ven de tres formas
distintas según el navegador. Necesito el catálogo completo de controles
diseñado: interruptor, selector, desplegable con búsqueda, campo de texto,
campo numérico con unidad, selector de color, control segmentado, botones
(primario / secundario / destructivo / icono), casilla, campo de fecha, chips.

### 5.4 «Se nota que es web»

Síntomas que ha señalado el usuario: transiciones entre pantallas que no se
sienten nativas, ausencia de gesto de «volver» por arrastre, scroll sin
rebote/inercia percibida, listas que aparecen de golpe, no hay respuesta táctil
al pulsar (ni escala, ni resalte), y el teclado tapa los campos al escribir.

---

## 6. Qué quiero que diseñes (entregable)

1. **Concepto y dirección de arte** (1 página): en qué se convierte eBilling,
   qué se conserva de la identidad (el fondo que representa la hora del día, el
   flujo de energía animado) y qué se tira.
2. **Sistema de diseño**:
   - Escala tipográfica completa (familia, tamaños, pesos, interlineado,
     espaciado, y qué se usa para cifras).
   - Paleta: superficies, texto, acentos, colores semánticos (bien/aviso/mal),
     y la **paleta de series de datos** para 6 series simultáneas, en claro y
     oscuro, con los contrastes indicados.
   - Materiales: definición exacta de cada superficie (opacidad, desenfoque,
     borde, sombra, brillo) en claro y oscuro, y **cómo garantiza el contraste
     del texto sobre un fondo que cambia**.
   - Rejilla, espaciado, radios, elevación.
   - Iconografía: estilo, grosor, tamaños, y el set completo que necesitamos
     (solar, red, batería, casa, factura, ajustes, tiempo —8 estados—, flechas,
     cinco vistas de la pantalla de Energía…).
3. **Catálogo de componentes** con todos sus estados (normal, pulsado,
   deshabilitado, foco, error, cargando, vacío): los controles de §5.3, más
   tarjeta, fila de lista, cabecera, barra de pestañas, control segmentado,
   modal/hoja, banner, tarjeta de estadística, leyenda, tabla, chip, barra
   apilada, anillo/donut, y el propio **gráfico** (ejes, rejilla, cursor,
   tooltip, selección, estado sin datos).
4. **Maquetas de todas las pantallas** de §4, en claro y oscuro, con los datos
   reales de los ejemplos: Home, Energía (los cinco rangos y las cinco vistas
   relevantes), Facturación (las tres subvistas + el editor de tarifa + el
   modal de factura detallada), Ajustes (índice + al menos tres categorías,
   incluida la de selección de sensores rediseñada), pantalla de carga y estados
   vacíos y de error.
5. **Especificación de movimiento e interacción**: para cada transición y gesto,
   duración, curva y qué propiedad se anima. Cubre al menos: cambio de pestaña,
   apilado y vuelta (con gesto de arrastre desde el borde), apertura de hoja
   modal, cambio de rango en el gráfico, pellizco y desplazamiento del gráfico,
   selección de un punto, respuesta al pulsar cualquier control, aparición de
   listas y del contenido al cargar, y qué cambia con `prefers-reduced-motion`.
6. **Especificación de las dos tarjetas de Lovelace**, que viven dentro del tema
   del usuario de Home Assistant: qué variables de tema hay que respetar
   (`--primary-text-color`, `--secondary-text-color`, `--card-background-color`,
   `--primary-color`…), cómo se comporta el diseño cuando el usuario tiene un
   tema propio, y en qué se diferencian de la app.
7. **Plan de implementación por fases**, ordenado por relación
   impacto/esfuerzo, indicando en cada fase qué se puede hacer con CSS y qué
   exige librería o cambio de arquitectura. Necesito poder empezar por lo que
   más se note sin reescribir todo.

---

## 7. Requisitos de interacción y movimiento

- **Todo lo que se pulsa responde**: cambio de estado inmediato (< 100 ms),
  escala o resalte, y si la acción es lenta, indicador de progreso en el propio
  control.
- **Nunca un salto**: las transiciones de pantalla y los cambios de datos se
  animan; los valores numéricos que cambian en vivo interpolan en lugar de
  saltar.
- **Gestos**: arrastre desde el borde para volver en las pantallas apiladas,
  pellizco y desplazamiento en los gráficos, arrastre para recorrer los puntos,
  y toque largo donde aporte algo.
- **El dato en vivo se percibe vivo**: el flujo de energía es el corazón de la
  app y se refresca cada 20 s; tiene que respirar sin distraer y sin quemar
  batería. Especifica qué se anima siempre, qué solo cuando la pantalla está
  visible, y qué se detiene.
- **Curvas y duraciones concretas**, no «suave». Y la variante para
  `prefers-reduced-motion: reduce`.
- **El teclado no puede tapar el campo activo** en los formularios largos
  (editor de tarifa, credenciales).

---

## 8. Decisiones abiertas: quiero recomendación razonada

Para cada una, dame **una recomendación con alternativas descartadas y por qué**,
teniendo en cuenta las restricciones de §3 (sin CDN, peso, ARM, sin build
obligatorio):

1. **Motor de gráficos**: ¿seguimos con SVG propio corrigiendo la arquitectura
   de dibujado, o adoptamos una librería? Si la adoptamos, ¿cuál y por qué?
   Requisitos: 288 puntos × 6 series a 60 fps con pellizco e inercia; líneas con
   área, series punteadas sin leyenda, huecos (`null`) sin interpolar, cursor
   compartido, eje temporal en zona horaria fija, tema claro/oscuro, ~50-250 kB,
   funciona sin build, licencia permisiva.
2. **Material de cristal**: ¿hasta dónde merece la pena llegar? Si la respuesta
   es una capa de canvas/WebGL con refracción, especifica el enfoque, el coste
   en CPU/GPU/batería, cómo se comporta dentro de un iframe y la degradación
   a CSS. Si la respuesta es que con CSS bien hecho basta, demuéstralo.
3. **Arquitectura del frontend**: ¿mantenemos JS vanilla (hoy 1.700 líneas en un
   fichero) o introducimos un framework/compilador (por ejemplo algo que compile
   a JS mínimo)? Valora el coste de mantenimiento frente al beneficio de
   interfaz.
4. **Tipografía**: hoy empaquetamos Inter variable (subconjunto latino, 64 kB).
   ¿Es la mejor elección para cifras densas y para el aire nativo que buscamos?
5. **Densidad y jerarquía**: la app se usa en móvil pero también en escritorio
   ancho dentro del panel de HA. ¿Una sola disposición adaptable o dos
   disposiciones distintas?

---

## 9. Lo que NO quiero

- Que se pierda el **fondo que representa la hora del día y el tiempo**: es
  identidad del producto, hay que mejorarlo, no eliminarlo.
- Bonito pero ilegible: ningún texto por debajo de 4,5:1 de contraste, en
  ninguna de las cuatro fases del fondo ni en ninguna combinación de tema.
- Efectos que solo funcionan en un dispositivo caro.
- Dependencias que se cargan de internet.
- Densidad de tablero de control profesional: el usuario quiere entender su
  consumo en cinco segundos, no pilotar una central.
- Cambiar la lógica de negocio, los cálculos de facturación ni los nombres de
  los conceptos de la factura (son términos legales españoles: término de
  potencia, peaje 2.0TD, punta/llano/valle, compensación simplificada de
  excedentes, impuesto especial sobre la electricidad, bono social).

---

## 10. Formato de la respuesta

1. Concepto y dirección de arte.
2. Sistema de diseño (tokens y materiales, en tabla, con valores exactos y sus
   contrastes).
3. Catálogo de componentes con estados.
4. Maquetas por pantalla, en claro y oscuro, con anotaciones de medidas,
   comportamiento y qué dato del payload alimenta cada elemento.
5. Especificación de movimiento e interacción.
6. Especificación de las tarjetas de Lovelace.
7. Recomendaciones razonadas de §8.
8. Plan de implementación por fases con estimación relativa de esfuerzo.

Cuando una decisión dependa de algo que no está en este brief, **dilo
explícitamente y propón el valor por defecto** en lugar de dejarlo abierto.

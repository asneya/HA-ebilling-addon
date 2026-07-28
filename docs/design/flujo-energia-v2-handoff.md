# Handoff: eBilling — Flujo de energía

## Overview
Vista de flujo de energía en tiempo real para eBilling (app de consumo eléctrico doméstico con autoconsumo solar + batería). Responde a una sola pregunta: **de dónde sale y a dónde va cada kilovatio ahora mismo**, y cuánto cuesta este instante. El diagrama es un Sankey de dos columnas donde el grosor de cada cinta es potencia real, de modo que la comparación es geométrica y no requiere leer cifras.

Se entrega junto al resto del sistema de eBilling (prototipo navegable, sistema visual, alma del producto y decisiones abiertas) porque esta vista se integra como una sección de la app existente.

## About the Design Files
**Los archivos de este paquete son referencias de diseño escritas en HTML.** Son prototipos que muestran aspecto y comportamiento previstos, **no código de producción para copiar tal cual**. Usan un runtime propio de prototipado (`support.js`, etiquetas `<x-dc>`, plantillas con `{{ }}`) que no debe portarse al producto.

La tarea es **recrear estos diseños en el entorno del codebase de destino** (React, Vue, SwiftUI, Compose, nativo…) con sus patrones y librerías ya establecidos. Si aún no hay entorno, elige el marco más apropiado para el proyecto e implementa ahí.

Lo que sí debe portarse literalmente: la geometría del Sankey, la lógica de reparto de flujos, los tokens de color/tipografía y las copias exactas.

## Fidelity
**Alta fidelidad (hifi).** Colores, tipografía, espaciado, radios y transiciones son finales. Recrear la UI con precisión usando las librerías del codebase. La única parte deliberadamente abierta es el ancho móvil: el diseño está resuelto a ancho escritorio/tablet (≥600 px de columna central) y la adaptación a móvil está especificada como texto más abajo, no maquetada.

---

## Screens / Views

### 1. Flujo de energía (vista principal)
**Purpose:** el usuario ve el reparto instantáneo de energía, arrastra la hora para entender su día y pulsa reproducir para ver las 24 h como animación.

**Layout:**
- Página: `min-height:100vh`, fondo `#080C11`, padding `44px 48px 64px`, columna flex con `gap:28px`, color de texto base `#F2F6FA`.
- **Cabecera:** fila flex, `align-items:flex-end`, `justify-content:space-between`, `gap:40px`, `flex-wrap:wrap`. Bloque de texto `max-width:600px`. A la derecha, columna con los cuatro chips de hora (fila, `gap:8px`) y debajo el botón de reproducir.
- **Cuerpo:** fila flex, `gap:30px`, `align-items:flex-start`, `flex-wrap:wrap`.
  - **Tarjeta del diagrama:** `flex:1 1 700px; min-width:600px`.
  - **Columna de métricas:** `flex:0 1 320px; min-width:290px`, columna flex `gap:14px`.

**Componentes de la cabecera:**
- Eyebrow: 11px / peso 600 / `letter-spacing:.16em` / mayúsculas / `#F0A22E`. Texto: `Flujo de energía · propuesta 2`.
- Titular: 34px / peso 600 / `line-height:1.06` / `letter-spacing:-.035em` / `#F2F6FA`. Texto: `De dónde sale y a dónde va, en una sola lectura`.
- Entradilla: 14px / `line-height:1.62` / `#8B98A5` / `text-wrap:pretty`. Texto: `Izquierda lo que entra, derecha lo que se usa. El grosor de cada cinta es potencia real, así que la comparación es geométrica: no hace falta leer un número para ver que hoy el sol cubre la casa entera. Dale a reproducir y el día pasa entero.`
- **Chips de hora** (`Amanecer` 8.4 h, `Mediodía` 13.2 h, `Tarde` 19.6 h, `Noche` 23.2 h): padding `9px 15px`, `border-radius:999px`, 12.5px / peso 500, cursor pointer.
  - Inactivo: fondo `rgba(255,255,255,.05)`, texto `#C3D0DE`, borde `1px solid rgba(255,255,255,.1)`.
  - Activo (hora actual a menos de 0,35 h del valor del chip): fondo `#F5F8FC`, texto `#0B1016`, borde `1px solid #F5F8FC`.
- **Botón reproducir:** padding `10px 18px`, `border-radius:999px`, 12.5px / peso 600, fila flex `gap:9px`, con glifo `▶` / `❚❚` a 11px.
  - Parado: fondo `rgba(255,255,255,.06)`, texto `#F2F6FA`, borde `1px solid rgba(255,255,255,.12)`, copia `Ver el día entero`.
  - Reproduciendo: fondo `rgba(245,169,60,.18)`, texto `#F5A93C`, borde `1px solid rgba(245,169,60,.34)`, copia `Pausar el día`.

**Tarjeta del diagrama:**
- `border-radius:32px`, padding `24px 28px 20px`, borde `1px solid rgba(255,255,255,.08)`, sombra `0 40px 90px rgba(0,0,0,.55)`, fondo `radial-gradient(130% 100% at 50% 0%, #141C26 0%, #0C1218 60%, #0A0F15 100%)`.
- Fila superior: a la izquierda etiqueta `Ahora · HH:MM` (12px / peso 600 / `letter-spacing:.07em` / mayúsculas / `#8B98A5`) y debajo el titular dinámico (15px / `#C3D0DE`); a la derecha la píldora de estado.
- **Píldora de estado:** padding `8px 14px`, `border-radius:999px`, 12.5px / peso 600, `white-space:nowrap`. Tres estados:
  - `Vendiendo a la red` — fondo `rgba(127,166,255,.16)`, texto `#9CBBFF`, borde `rgba(127,166,255,.3)`.
  - `Comprando de la red` — fondo `rgba(255,138,138,.14)`, texto `#FF9E9E`, borde `rgba(255,138,138,.28)`.
  - `Independiente` — fondo `rgba(53,214,155,.15)`, texto `#4FE0AC`, borde `rgba(53,214,155,.3)`.
- Debajo, el **SVG del Sankey** (ver sección propia) y luego la **franja del día**, separada por `border-top:1px solid rgba(255,255,255,.07)` con `padding-top:16px`.
- Encabezado de la franja: `El día completo` (11px / mayúsculas / `letter-spacing:.07em` / `#8B98A5` / peso 600) y a la derecha `Sol producido · casa consumida` (11.5px / `#68747F`).
- **Deslizador de hora:** fila con `00` y `24` (11px, `#68747F`, tabular) y un `range` de 0 a 23.9 paso 0.1 que ocupa el resto.

**Columna de métricas (cuatro tarjetas, de arriba a abajo):**
1. **Autoconsumo ahora** — padding `20px 22px`, `border-radius:26px`, fondo `linear-gradient(160deg, rgba(245,169,60,.14), rgba(245,169,60,.03))`, borde `1px solid rgba(245,169,60,.22)`. Rótulo 11px mayúsculas `#F0A22E`; cifra 44px / peso 600 / `letter-spacing:-.04em` / tabular / `line-height:1`; pie 12.5px `#B9A177`, copia `de lo que gasta la casa lo pones tú`.
2. **Rejilla de dos tarjetas** (`grid-template-columns:1fr 1fr`, `gap:12px`), cada una padding `16px 17px`, `border-radius:20px`, fondo `rgba(255,255,255,.035)`, borde `1px solid rgba(255,255,255,.07)`:
   - **Batería** — cifra 23px peso 600 `#35D69B` con el % de carga; pie 11.5px `#68747F` con `cargando a X kW` / `dando X kW a la casa` / `llena, en reposo` / `en reposo`.
   - **De la red / A la red** (el título cambia según se exporte) — cifra 23px peso 600: `#9CBBFF` exportando, `#FF9E9E` comprando, `#68747F` sin intercambio; pie con `cuesta X €/h` / `compensa X €/h` / `sin intercambio`.
3. **Coste de este instante** — padding `18px 20px`, `border-radius:22px`, mismo fondo/borde neutro. Rótulo a la izquierda, precio `0,242 €/kWh` a la derecha (11px `#68747F` tabular). Cifra 32px peso 600 tabular (`#4FE0AC` si ≤0, `#FF9E9E` si >0,4 €, `#F2F6FA` en el resto) seguida de `/hora` (13px `#68747F`). Nota 12px `#8B98A5`.
4. **Leyenda** — cuatro filas con muestra de color de `20×8px` radio 4 y texto 12.5px `#C3D0DE`: `Sol · lo que producen las placas`, `Batería · carga y descarga`, `Red · compra y excedentes`, `Casa · el consumo real`.

---

## El diagrama Sankey (especificación geométrica)

Todo en coordenadas de un SVG con `viewBox="-108 0 976 352"` y `width:100%` (el `viewBox` se extiende a ambos lados del área de cintas para alojar las etiquetas laterales; no recortar).

**Constantes:** eje vertical del diagrama `MID = 176`; borde derecho de la columna de entrada `X1 = 168`; borde izquierdo de la columna de salida `X2 = 592`; ancho de barra `BW = 54`; control horizontal de las curvas `CX = (X1+X2)/2 = 380`.

**Escala:** `scale = min(46, 250 / max(1.2, caudalTotal))` px por kW. Es decir, escala fija de 46 px/kW mientras el caudal total sea pequeño, y a partir de ~5,4 kW se normaliza para que el diagrama nunca desborde los 250 px de alto. Consecuencia buscada: a horas de poco caudal las cintas son finas de verdad.

**Columnas:** en cada lado se apilan los segmentos con `GAP = 14` px entre ellos y el bloque completo se centra en `MID`.
- Orden de entrada (arriba→abajo): `sol`, `bat` (descarga), `red` (compra).
- Orden de salida: `casa`, `bat` (carga), `red` (excedente).
- Cada barra es un `rect` de ancho `BW`, radio 8, alto `max(3, kW·scale)`, relleno del color plano del nodo. La de entrada se dibuja en `x = X1-BW`; la de salida en `x = X2`.

**Cintas:** una por par origen→destino. Para evitar cruces, cada barra reparte su altura con un cursor: los enlaces de un origen se ordenan por el orden de destinos, y los de un destino por el orden de orígenes. Path de cada cinta (dos cúbicas y cierre):

```
M X1,sy0  C CX,sy0  CX,dy0  X2,dy0
L X2,dy1  C CX,dy1  CX,sy1  X1,sy1  Z
```

Relleno: `linearGradient` horizontal del color del origen (opacidad .72) al color del destino (opacidad .5).

**Partículas:** por cada cinta de más de 5 px de grosor, una línea central (la misma cúbica sin cerrar, entre los centros de origen y destino) con `stroke:#FFFFFF`, `stroke-width: min(3.4, grosor·0.26)`, `stroke-linecap:round`, `stroke-dasharray:"2 26"`, `opacity:.5` y animación `dashoffset` de 0 a −320 en 3,4 s lineal infinita. Es lo que da el sentido de la corriente; debe apagarse con `prefers-reduced-motion`.

**Valor dentro de la cinta:** si el grosor es ≥17 px, texto centrado en `CX` a la altura media de la cinta, 12px peso 600, color `#0B1016` (oscuro sobre la cinta), tabular.

**Etiquetas laterales (importante):** nombre (14px peso 600 `#F2F6FA`) y valor (12.5px peso 500, color del nodo, tabular) apilados, anclados a 16 px por fuera de la barra — `text-anchor:end` a la izquierda, `start` a la derecha. Los sufijos son parte del nombre: `Batería · descarga`, `Red · compra` a la izquierda; `Batería · carga`, `Red · excedente` a la derecha; `Sol` y `Casa` van sin sufijo.
- **Antirreapilado:** el bloque de etiquetas mide ~34 px, así que en segmentos finos se solaparían. Se impone un paso mínimo de 40 px entre centros de etiqueta consecutivos del mismo lado, empujando hacia abajo; si el último se sale de `y=322` se desplaza todo el conjunto hacia arriba y se reequilibra hacia atrás. Cuando una etiqueta se separa más de 6 px del centro real de su barra, se dibuja una línea guía de 1 px al color del nodo con opacidad .4 desde la etiqueta hasta el centro de la barra.

**Rótulos y pie:** `Entra` en `x=-100` y `Va a` en `x=860`, ambos en `y=20`, 10.5px peso 600 mayúsculas `letter-spacing:.13em` `#68747F`. Al pie, centrado en `CX`, `y=340`: `Caudal total X,XX kW` (12px `#68747F` tabular).

---

## La franja del día

SVG `viewBox="0 0 760 74"`, `width:100%`. Escala: `x(t) = t/24·760`, `y(v) = 74-8-(v/6)·(74-18)` (máximo del eje 6 kW).
- Área de producción solar: recorrido de 0 a 24 h en pasos de 0,25 h, relleno `linearGradient` vertical `#F5A93C` de opacidad .5 a .04.
- Línea de consumo de la casa: mismo muestreo, `stroke:#D3DCE6`, ancho 1,6, opacidad .75, sin relleno.
- Cabezal de lectura: línea vertical de `y=2` a `y=68` en `#F5F8FC` ancho 1,5, más un círculo de radio 4,5 en la curva solar, relleno `#F5A93C` con borde `#0A0F15` de 2 px.

---

## Interactions & Behavior
- **Chips de hora:** fijan la hora (8.4 / 13.2 / 19.6 / 23.2) y **detienen** la reproducción.
- **Deslizador:** fija la hora en continuo (paso 0,1 h) y detiene la reproducción. En producción debería además permitir arrastre directo sobre la franja del día, no solo el `range`.
- **Reproducir:** avanza la hora 0,14 h cada 45 ms y da la vuelta al pasar de 24 (un día completo en ~7,7 s). Al pausar, la hora se queda donde está. Limpiar el intervalo al desmontar.
- **Transiciones:** todo el diagrama se recalcula por hora; no hay animación explícita de morfeo entre estados porque el paso de tiempo es lo bastante fino. Si el codebase lo permite, interpolar altura y path de las cintas con una transición de ~120 ms mejora la sensación al usar los chips (salto grande de hora).
- **Estados vacíos:** de noche `sol = 0` y su barra desaparece por completo (no se dibuja un segmento de altura cero); el diagrama queda con una sola cinta. Es el comportamiento correcto.
- **Movimiento reducido:** con `prefers-reduced-motion: reduce`, detener las partículas y no autoreproducir.
- **Accesibilidad:** el Sankey necesita alternativa textual — una tabla o lista oculta con los pares origen→destino y sus kW; el titular dinámico ya describe el estado en prosa y debe anunciarse en una región `aria-live` cortés.
- **Responsive:** por debajo de ~600 px de ancho de la columna central, las dos columnas del Sankey pasan a **arriba/abajo**: entradas en la fila superior, salidas en la inferior, cintas verticales con el mismo esquema de cúbicas girado 90°, etiquetas horizontales debajo de cada barra. La columna de métricas pasa a rejilla de 2×2 bajo el diagrama.

## State Management
Estado local, sin datos remotos en el prototipo:
- `hour: number` (0–24, decimal) — hora mostrada. Fuente única de verdad de todo el render.
- `playing: boolean` — reproducción activa; gobierna el intervalo.

Todo lo demás es derivado y debe calcularse en la capa de presentación a partir de `hour`. En producción, `hour` se sustituye por la hora real (con la posibilidad de retroceder en el día) y las curvas simuladas por telemetría del inversor: producción, consumo y estado de carga muestreados. **La lógica de reparto de flujos y el diagrama no cambian**; solo cambia el origen de `pv`, `house` y `soc`.

### Modelo de simulación del prototipo (a sustituir por datos reales)
- Producción solar: campana `pv(h) = 5.4·sin(π·(h−6.3)/11.8)^1.35` entre 6,3 h y 18,1 h, cero fuera.
- Consumo: base 0,32 kW más gaussianas en 8,1 h (pico 1,05, ancho 1,15), 14 h (0,75 / 1,5) y 20,6 h (2,35 / 1,9), más 3,1 kW constantes entre 1,5 h y 5 h (carga del coche).
- Batería: capacidad 7,5 kWh (parámetro), estado inicial 34 %, integración en pasos de 0,1 h, carga máxima 3,0 kW, descarga máxima 3,5 kW, sin pérdidas.
- Precio: 0,094 €/kWh de 0 a 8 h; 0,242 €/kWh de 10 a 14 h y de 18 a 22 h; 0,158 €/kWh el resto. Excedente retribuido a 0,06 €/kWh.

### Reparto de flujos (portar tal cual)
```
si pv >= house:
  sol→casa = house
  sobrante = pv − house
  sol→bat  = (soc >= cap−0.05) ? 0 : min(sobrante, 3.0)
  sol→red  = sobrante − sol→bat
si no:
  sol→casa = pv
  falta    = house − pv
  bat→casa = (soc <= 0.15) ? 0 : min(falta, 3.5)
  red→casa = falta − bat→casa
```
Descartar todo enlace por debajo de 0,01 kW para que no aparezcan cintas fantasma.

**Derivados:**
- Autoconsumo `%` = `(sol→casa + bat→casa) / house`, redondeado; 100 % si `house ≈ 0`.
- Coste instantáneo `€/h` = `red→casa · precio(h) − sol→red · 0,06`.
- Caudal total = suma de los kW de todos los enlaces.

### Titular dinámico (copias exactas, en este orden de prioridad)
1. Exporta y carga batería: `El sol cubre la casa, llena la batería y aún sobra: X kW se van a la red.`
2. Solo exporta: `Batería llena y casa cubierta. Todo el excedente, X kW, sale a la red.`
3. Solo carga batería: `Sobra sol y va entero a la batería: X kW guardados para la noche.`
4. Batería sola, sin sol: `Sin nada de sol, la batería lleva la casa sola con X kW.`
5. Sol + batería, sin red: `El sol pone X kW y la batería remata los Y kW que faltan: cero red.`
6. Batería + red: `La batería aporta X kW y la red completa los Y kW que faltan.`
7. Sol + red: `El sol cubre X kW y la red pone los Y kW restantes.`
8. Solo red: `Toda la casa va con red: X kW comprados a 0,242 €/kWh.`

El orden importa: las ramas de batería exigen que la red no aporte nada, y la rama 4 exige además que el sol sea cero. Si se relaja (p. ej. dejar que la rama 4 salte con cualquier aporte de batería), el titular acaba contradiciendo el diagrama a horas en que el sol cubre el 90 % y la batería remata el resto.

Nota de coste: si el coste es ≤0, `A esta hora la casa no te cuesta nada: los excedentes te abonan.`; si no, `Solo pagas los X kW que vienen de la red; el resto ya está en casa.`

### Parámetros expuestos como ajustes
`showParticles` (booleano, por defecto sí), `showValues` (valor dentro de las cintas, por defecto sí), `batteryKwh` (2–20 kWh, paso 0,5, por defecto 7,5).

## Design Tokens

**Colores de nodo (los cuatro colores semánticos del flujo):**
| Nodo | Hex |
|---|---|
| Sol | `#F5A93C` |
| Batería | `#35D69B` |
| Red | `#7FA6FF` |
| Casa | `#D3DCE6` |

**Superficies y texto:**
| Uso | Valor |
|---|---|
| Fondo de página | `#080C11` |
| Fondo de tarjeta | `radial-gradient(130% 100% at 50% 0%, #141C26, #0C1218 60%, #0A0F15)` |
| Superficie neutra | `rgba(255,255,255,.035)` |
| Borde neutro | `rgba(255,255,255,.07)` — `.08` en tarjeta grande, `.12` en botón |
| Texto primario | `#F2F6FA` |
| Texto secundario | `#C3D0DE` |
| Texto terciario | `#8B98A5` |
| Texto de apoyo | `#68747F` |
| Ámbar de acento (eyebrow) | `#F0A22E` |
| Verde positivo | `#4FE0AC` |
| Rojo de gasto | `#FF9E9E` |
| Azul de red | `#9CBBFF` |
| Oro sobre ámbar | `#B9A177` |
| Texto sobre cinta | `#0B1016` |

**Tipografía:** familia `Geist` (pesos 400/500/600/700), con `system-ui, sans-serif` de reserva. Escala usada: 44 / 34 / 32 / 24 / 23 / 15 / 14 / 13 / 12.5 / 12 / 11.5 / 11 / 10.5 px. Cifras siempre con `font-variant-numeric: tabular-nums`. `letter-spacing`: −.04em en la cifra grande, −.035em en titulares, −.03em en cifras medianas, .06–.16em en rótulos en mayúsculas. Suavizado `-webkit-font-smoothing:antialiased`.

**Radios:** 32 (tarjeta principal) · 26 (tarjeta destacada) · 22 · 20 · 18 · 12 · 8 (barras del Sankey) · 4 (muestras de leyenda) · 999 (píldoras).

**Espaciado:** múltiplos observados de 2/4 px — 44/48/64 en padding de página; 30/28/24/22/20/18/17/16/14/12/11/10/9/8/6 en tarjetas y filas. Separación entre segmentos del Sankey: 14 px. Paso mínimo entre etiquetas laterales: 40 px.

**Sombras:** tarjeta principal `0 40px 90px rgba(0,0,0,.55)`; pulgar del deslizador `0 2px 10px rgba(0,0,0,.55)`.

**Deslizador:** pista de 4 px radio 2 en `rgba(255,255,255,.14)`; pulgar de 18 px en `#F5F8FC`; alto del control 26 px; cursor `grab`.

## Assets
Ninguno externo. No hay imágenes ni iconos: los cuatro nodos se identifican por color y etiqueta, y los glifos de reproducción son caracteres tipográficos (`▶`, `❚❚`) — en producción conviene sustituirlos por los iconos del sistema del codebase. Única dependencia externa: la fuente **Geist** desde Google Fonts (pesos 400, 500, 600, 700); usar la copia local del codebase si ya existe.

## Files
En este paquete:
- `eBilling - Flujo de energía v2.dc.html` — **el diseño a implementar.** Sankey de dos columnas, franja del día, métricas.
- `eBilling - Flujo de energía v1 (descartada).dc.html` — primera propuesta (diagrama orbital con la casa en el centro). Se incluye solo como historial: **no implementar.**
- `eBilling - Prototipo.dc.html` — app navegable: cuatro pestañas, gráficos, tema y material, hoja de tarifas con editor completo y hoja de electrodoméstico. Es el contexto donde vive esta vista.
- `eBilling - Sistema y maquetas.dc.html` — sistema visual y maquetas de referencia.
- `eBilling - Alma.dc.html` — la propuesta de producto: la ventana de horas libres y el cierre del día.
- `eBilling - Decisiones abiertas.dc.html` — decisiones cerradas y sus alternativas razonadas.
- `support.js` — runtime del prototipo. **No portar.** Solo está para que los HTML abran.

### Pendiente conocido, fuera de este diseño
- Pellizco/zoom en los gráficos de la pestaña Energía del prototipo.
- El listado de tarifas y el desglose de factura viven en JS en el prototipo; en producción vienen de datos.
- Falta probar la lógica de «cabe gratis» del prototipo en escenarios límite (ventana muy corta, electrodoméstico más largo que la ventana, dos electrodomésticos solapados).

# eBilling Card (tarjeta Lovelace)

Tarjeta personalizada para visualizar en tu panel la **comparativa de tarifas**
del add-on eBilling: mejor tarifa, ahorro potencial, coste acumulado y proyección
de cada tarifa, precio actual €/kWh y compensación de excedentes.

Se adapta al tema (claro/oscuro) de Home Assistant y usa el color que hayas
asignado a cada tarifa en el add-on.

![Requiere el add-on eBilling](https://img.shields.io/badge/requiere-add--on%20eBilling-4a6cf7)

## Requisitos

En el add-on eBilling, ve a **Ajustes → Sensores** y activa **Publicar
sensores en Home Assistant**. La tarjeta lee esas entidades
(`sensor.ebilling_*`).

## Instalación con HACS (recomendada)

Este repositorio es compatible con HACS como plugin de panel. Como no está en
la tienda por defecto, se añade como **repositorio personalizado**:

[![Abrir en HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=asneya&repository=HA-ebilling-addon&category=plugin)

1. HACS → menú **⋮ → Repositorios personalizados**.
2. **Repositorio**: `https://github.com/asneya/HA-ebilling-addon` ·
   **Tipo/Categoría**: `Dashboard` (o *Lovelace/Plugin*).
3. Añade, abre *eBilling Card* y pulsa **Descargar**.
4. HACS registra el recurso automáticamente. Recarga el navegador
   (Ctrl/Cmd + Shift + R) y añade la tarjeta a tu panel.

> **Actualizaciones**: el repositorio publica *releases* con cada versión, así
> que HACS te avisará cuando haya una nueva y la actualizarás con un clic (más
> una recarga forzada del navegador). Tras actualizar, si tienes también la
> tarjeta de flujo (`ebilling-power-flow.js`) como recurso aparte, recarga
> igualmente para que el navegador coja la versión nueva.

> El botón de arriba abre directamente el diálogo de repositorio en tu HACS.

## Instalación manual (sin HACS)

1. Copia [`dist/ebilling-card.js`](../dist/ebilling-card.js) a la carpeta
   `www` de tu configuración: `/config/www/ebilling-card.js`.
   (Puedes usar el complemento *File editor* o *Samba/SSH*.)
2. Ve a **Ajustes → Paneles**, menú **⋮ → Recursos → Añadir recurso**:
   - **URL**: `/local/ebilling-card.js`
   - **Tipo**: `Módulo de JavaScript`
3. Recarga el navegador (Ctrl/Cmd + Shift + R).
4. Edita tu panel, **Añadir tarjeta**, busca *eBilling — Comparativa de
   tarifas* (o usa el YAML de abajo).

## Uso

Lo más sencillo — descubre los sensores automáticamente:

```yaml
type: custom:ebilling-card
```

Con opciones:

```yaml
type: custom:ebilling-card
title: Mi comparativa de luz
mode: cycle          # cycle (acumulado, por defecto) | projection (fin de ciclo)
entities:            # opcional: fija qué tarifas mostrar (sus sensores de coste)
  - sensor.ebilling_plan_estable_coste_ciclo
  - sensor.ebilling_pvpc_regulada_coste_ciclo
```

| Opción | Por defecto | Descripción |
|---|---|---|
| `title` | «Comparativa de tarifas» | Encabezado de la tarjeta |
| `mode` | `cycle` | Vista inicial: acumulado o proyección a fin de ciclo (se puede cambiar con el botón de la tarjeta) |
| `entities` | *(auto)* | Lista de sensores `..._coste_ciclo` a incluir; si se omite, se descubren todos |

## Alternativa sin recurso personalizado

Si prefieres no instalar la tarjeta, puedes montar algo parecido con tarjetas
integradas. Ejemplo con una `entities` y un `gauge`:

```yaml
type: vertical-stack
cards:
  - type: entity
    entity: sensor.ebilling_mejor_tarifa
    name: Mejor tarifa
    icon: mdi:trophy-outline
  - type: entities
    title: Coste del ciclo por tarifa
    entities:
      - sensor.ebilling_plan_estable_coste_ciclo
      - sensor.ebilling_tarifa_plana_excedentes_ejemplo_coste_ciclo
      - sensor.ebilling_pvpc_regulada_coste_ciclo
  - type: gauge
    entity: sensor.ebilling_ahorro_potencial
    name: Ahorro potencial
    unit: EUR
    needle: true
    severity:
      green: 0
      yellow: 5
      red: 15
```

---

# eBilling Power Flow (flujo de energía)

Segunda tarjeta del repositorio: `custom:ebilling-power-flow`. Muestra de
forma **animada** la potencia instantánea que viaja entre **solar, red,
batería y casa**, con la potencia de cada nodo y el sentido de cada flujo.
No depende del add-on: funciona con tus propios sensores de potencia (W/kW).

## Instalación del segundo recurso

La tarjeta vive en un archivo aparte, así que hay que añadir **un recurso
más** (HACS solo registra automáticamente el primero):

- **Con HACS** (tras descargar el repositorio como en la tarjeta anterior):
  **Ajustes → Paneles → ⋮ → Recursos → Añadir recurso**
  - **URL**: `/hacsfiles/HA-ebilling-addon/ebilling-power-flow.js`
  - **Tipo**: `Módulo de JavaScript`
- **Manual**: copia [`dist/ebilling-power-flow.js`](../dist/ebilling-power-flow.js)
  a `/config/www/` y añade el recurso `/local/ebilling-power-flow.js`.

Recarga el navegador (Ctrl/Cmd + Shift + R) después.

## Uso

Puedes configurarla con el **editor visual** de la tarjeta (dropdowns para
cada sensor) o por YAML:

```yaml
type: custom:ebilling-power-flow
title: Flujo de energía
entities:
  pv: sensor.produccion_solar          # producción fotovoltaica
  grid_import: sensor.importacion_red   # potencia importada de la red
  grid_export: sensor.exportacion_red   # potencia exportada a la red
  battery_charge: sensor.carga_bateria  # potencia de carga de batería
  battery_discharge: sensor.descarga_bateria  # potencia de descarga
  home: sensor.consumo_casa             # opcional (si falta, se calcula)
  battery_soc: sensor.bateria_soc       # opcional (muestra el % de batería)
  # Energía diaria (kWh) para el anillo de la casa (opcional pero recomendado):
  pv_energy: sensor.solar_hoy
  grid_import_energy: sensor.red_importada_hoy
  grid_export_energy: sensor.red_exportada_hoy
  battery_charge_energy: sensor.bateria_carga_hoy
  battery_discharge_energy: sensor.bateria_descarga_hoy
colors:                                 # opcional (o con el picker del editor)
  solar: '#f6a609'
  grid: '#e5484d'
  battery: '#12b886'
  home: '#4a6cf7'
```

Disposición: **solar arriba**, **casa en el centro**, **batería abajo a la
izquierda** y **red abajo a la derecha**. En cada línea con potencia viaja
**una sola bola** (más rápida cuanto mayor es la potencia) y una etiqueta con
el valor.

**Anillo de la casa**: alrededor del nodo de la casa se dibuja un donut que
representa cuánta energía ha **consumido la casa hoy de cada fuente** (solar,
red, batería), con el color de cada una. Para que sea **exacto**, asigna los
**sensores de energía diaria** (kWh) en el editor (grupo «Sensores de energía
diaria»). Si no los defines, el anillo se calcula de forma aproximada
integrando la potencia en el navegador mientras la tarjeta está visible.

Notas:

- Los sensores son de **potencia instantánea** (unidad `W` o `kW`; se detecta
  y se muestra en kW/W automáticamente).
- Los **colores** de cada elemento son configurables (editor visual con
  selector de color, o clave `colors` en YAML).
- Si no tienes batería, deja `battery_charge`/`battery_discharge` sin asignar
  y esos flujos no aparecen. Igual con la exportación si no viertes a la red.
- El **consumo de la casa** se calcula a partir del balance
  (solar + importada + descarga − exportada − carga) si no defines `home`.
- El anillo diario usa los **sensores de energía** si los defines (exacto); si
  no, se **acumula en el navegador** (localStorage) integrando la potencia
  mientras la tarjeta está visible (orientativo, se reinicia cada día).
- La animación respeta `prefers-reduced-motion`.

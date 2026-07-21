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

# eBilling — Documentación

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
| entity_id | tag | tag |
| Credenciales | usuario/contraseña | org + token |

## Tarifas

Cada tarifa define:

- **Término de potencia** (€/kW·día) para P1 (punta) y P2 (valle).
- **Término de energía** (€/kWh) por periodo punta/llano/valle. Para tarifas
  de precio fijo, usa el mismo precio en los tres periodos.
- **Financiación del bono social** (€/día).
- **Alquiler de contador** (€/día).
- **Servicios adicionales** (€/mes), p. ej. mantenimiento.
- **Impuesto especial sobre la electricidad** (%). La base es potencia +
  energía + cargos, igual que en la factura real.
- **IVA de energía** (aplicado a potencia + energía + cargos + impuesto
  eléctrico + alquiler de contador) e **IVA de servicios**, por si tienen
  tipos distintos (p. ej. 10% reducido y 21% general).

El add-on incluye de serie una tarifa real de referencia (Iberdrola Plan
Estable, 2.0TD) y una tarifa plana de ejemplo; edítalas o elimínalas.

## Discriminación horaria 2.0TD

- Sábados, domingos y festivos nacionales: **valle** todo el día.
- Laborables: 00–08 valle · 08–10 llano · 10–14 **punta** · 14–18 llano ·
  18–22 **punta** · 22–24 llano.

Los festivos son configurables en Ajustes (formato `MM-DD`).

## Simulación

- **Acumulado**: coste desde el inicio del ciclo hasta ahora.
- **Proyección fin de ciclo**: extrapola el consumo por periodo al ciclo
  completo y aplica los términos fijos sobre todos los días del ciclo.
- Puedes navegar a ciclos anteriores con las flechas ‹ › y la vista se
  actualiza sola cada 5 minutos.

## Opciones del add-on

| Opción | Descripción |
|---|---|
| `log_level` | `debug`, `info`, `warning` o `error` |

Toda la configuración funcional (fuente, tarifas, contrato) se gestiona desde
la propia interfaz y se guarda en `/data/ebilling.json`.

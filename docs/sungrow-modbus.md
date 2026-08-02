# Diccionario Modbus de los Sungrow SHx

Los registros de los híbridos residenciales de Sungrow y las entidades que
publican en Home Assistant, con lo que hace falta saber para configurar Vatia
con uno.

Sale de dos sitios:

- **«Communication Protocol of Residential Hybrid Inverter», V1.1.9**
  (2025-06-20), que es la especificación del fabricante.
- **[Sungrow-SHx-Inverter-Modbus-Home-Assistant](https://github.com/mkaiser/Sungrow-SHx-Inverter-Modbus-Home-Assistant)**
  de mkaiser, que es la integración que usa prácticamente todo el mundo y la que
  decide **cómo se llaman** las entidades.

Los `entity_id` de este documento son los que Home Assistant genera a partir del
nombre de la integración. Si has renombrado alguna entidad, el tuyo será otro:
lo que manda es el número de registro.

## Índice

- [Antes de nada: hace falta un contador inteligente](#antes-de-nada-hace-falta-un-contador-inteligente)
- [Cómo se configura Vatia con un Sungrow](#cómo-se-configura-vatia-con-un-sungrow)
- [Tres sensores que engañan](#tres-sensores-que-engañan)
- [Diccionario completo](#diccionario-completo)
- [Sensores calculados de la integración](#sensores-calculados-de-la-integración)
- [Cómo se leen los registros](#cómo-se-leen-los-registros)

## Antes de nada: hace falta un contador inteligente

La nota 1 del protocolo, que es fácil pasar por alto y lo explica casi todo:

> *Data related to the grid or load is only valid when the inverter is directly
> connected to a smart energy meter.*

Es decir: **sin un contador inteligente conectado al inversor, todo lo que tenga
que ver con la red o con el consumo no vale nada.** Afecta a estos registros,
que son justo los que Vatia más necesita:

| Registro | Qué es |
|---|---|
| 13005 / 13006 | Vertido a la red procedente del sol |
| 13008 | Potencia consumida por la casa |
| 13010 | Potencia entregada a la red |
| 13018 | Consumo directo acumulado |
| 13045 / 13046 | Vertido a la red |

Sin contador, el inversor sabe lo que produce y lo que hace su batería, pero no
sabe qué pasa en el cuadro de la casa. Si esas cifras salen a cero o disparatadas,
el problema está en la instalación y no en la configuración.

## Cómo se configura Vatia con un Sungrow

### Lo necesario

| Casilla de Vatia | Entidad | Reg. |
|---|---|---|
| Solar · Potencia instantánea | `sensor.total_dc_power` | 5017 |
| Solar · Energía del día | `sensor.daily_pv_generation` | 13002 |
| Red · Energía importada | `sensor.daily_imported_energy` | 13036 |
| Red · Energía exportada | `sensor.daily_exported_energy` | 13045 |
| Batería · Energía cargada | `sensor.daily_battery_charge` | 13040 |
| Batería · Energía descargada | `sensor.daily_battery_discharge` | 13026 |
| Batería · Estado de carga | `sensor.battery_level` | 13023 |
| Casa · Consumo instantáneo | `sensor.load_power` | 13008 |

En **Ajustes → Sensores → Qué miden los contadores**, elige **«Ya son del día en
curso»**: todos los `daily_*` se reinician a medianoche.

### Lo que conviene añadir

Las potencias de red y batería vienen con signo en un solo registro, y la
integración las separa en dos entidades cada una. Vatia acepta las dos formas:

| Casilla de Vatia | Entidad | Origen |
|---|---|---|
| Red · Importada (W) | `sensor.import_power` | plantilla, de 13010 |
| Red · Exportada (W) | `sensor.export_power` | plantilla, de 13010 |
| Batería · Potencia de carga | `sensor.battery_charging_power` | plantilla, de 5214 |
| Batería · Potencia de descarga | `sensor.battery_discharging_power` | plantilla, de 5214 |

### Y dos opcionales que valen mucho

| Casilla de Vatia | Entidad | Reg. |
|---|---|---|
| Batería · De la carga, lo que puso el sol | `sensor.daily_battery_charge_from_pv` | 13012 |
| Red · De lo exportado, lo que puso el sol | `sensor.daily_exported_energy_from_pv` | 13005 |

Estas dos no rellenan ningún hueco: **sustituyen una deducción por una medida.**
Con ellas, las dos cifras que Vatia más difícil tiene de deducir salen de una
resta entre lecturas del propio inversor:

```
red → batería  = daily_battery_charge   − daily_battery_charge_from_pv
batería → red  = daily_exported_energy  − daily_exported_energy_from_pv
```

Es justo la parte del reparto que más veces ha estado mal. Si las tienes, ponlas.

### El consumo de la casa: déjalo vacío

Sungrow **no publica ningún contador del consumo total de la casa en kWh**. Solo
`Load power` (13008), en vatios. Deja la casilla *Casa → Consumo del día* vacía
y Vatia deduce el consumo del balance de los otros cinco contadores.

Si prefieres tener un contador de verdad, la única forma honesta es integrar
`sensor.load_power` con el
[helper de suma de Riemann](https://www.home-assistant.io/integrations/integration/)
de Home Assistant y un `utility_meter` diario encima.

## Tres sensores que engañan

Los tres suenan a lo que buscas y miden otra cosa. Los tres cuadran casi exacto
en algunos días, que es lo que los hace peligrosos.

### 1. `daily_direct_energy_consumption` no es el consumo (reg. 13017)

El protocolo lo define así:

> *Daily electricity taken from PV modules by loads.*

Es el **autoconsumo**: lo que la casa toma del sol, **sin nada de lo comprado a
la red**. Puesto en la casilla del consumo de la casa, el resumen atribuye a la
batería toda la importación que ese sensor no ve.

Es traicionero porque un día sin importar cuadra casi exacto, y solo se despega
cuando compras algo. Vatia lo detecta y avisa desde la 0.47.0 —y, hasta esa
versión, era él quien lo proponía—.

### 2. `daily_consumed_energy` no es una medida (plantilla)

La integración define esta plantilla:

```jinja
daily_pv_generation − daily_exported_energy + daily_imported_energy
                    − daily_battery_charge  + daily_battery_discharge
```

Es **exactamente el mismo balance que calcula Vatia**. Ponerlo en la casilla del
consumo no añade información: le estarías devolviendo a Vatia su propia cuenta
disfrazada de medida, y con ella perdería el contraste entre las dos —que es lo
que permite detectar que un sensor miente—.

Su propia definición avisa de que el valor puede **bajar**, porque los cinco
contadores se leen en momentos distintos; por eso lleva `state_class: total` y no
`total_increasing`, y por eso la integración ofrece además una versión filtrada
con media móvil.

### 3. `daily_pv_generation_battery_discharge` no es solo el sol (reg. 5003)

El nombre del protocolo es «Daily Output Energy», y la definición:

> *Power generation of active output (including PV power generation and battery
> discharge).*

Es lo que el inversor **saca**, sumando el sol y lo que descarga la batería. Para
la casilla solar hay que usar 13002 (`daily_pv_generation`), que sí es solo
generación fotovoltaica.

## Diccionario completo

99 entidades de Modbus. La columna «Reg.» es el número del protocolo; un guion
significa que la entidad es de escritura o derivada y no tiene registro de
lectura directo en la integración.

### Energía

| Reg. | Entidad | Unidad | Tipo |
|---|---|---|---|
| 5003 | `sensor.daily_pv_generation_battery_discharge` | kWh | uint16 |
| 5004 | `sensor.total_pv_generation_battery_discharge` | kWh | uint32 |
| 13002 | `sensor.daily_pv_generation` | kWh | uint16 |
| 13003 | `sensor.total_pv_generation` | kWh | uint32 |
| 13005 | `sensor.daily_exported_energy_from_pv` | kWh | uint16 |
| 13006 | `sensor.total_exported_energy_from_pv` | kWh | uint32 |
| 13012 | `sensor.daily_battery_charge_from_pv` | kWh | uint16 |
| 13013 | `sensor.total_battery_charge_from_pv` | kWh | uint32 |
| 13017 | `sensor.daily_direct_energy_consumption` | kWh | uint16 |
| 13018 | `sensor.total_direct_energy_consumption` | kWh | uint32 |
| 13026 | `sensor.daily_battery_discharge` | kWh | uint16 |
| 13027 | `sensor.total_battery_discharge` | kWh | uint32 |
| 13036 | `sensor.daily_imported_energy` | kWh | uint16 |
| 13037 | `sensor.total_imported_energy` | kWh | uint32 |
| 13040 | `sensor.daily_battery_charge` | kWh | uint16 |
| 13041 | `sensor.total_battery_charge` | kWh | uint32 |
| 13045 | `sensor.daily_exported_energy` | kWh | uint16 |
| 13046 | `sensor.total_exported_energy` | kWh | uint32 |
| — | `sensor.battery_capacity_high_precision` | kWh | uint16 |

### Potencia

| Reg. | Entidad | Unidad | Tipo |
|---|---|---|---|
| 5001 | `sensor.inverter_rated_output` | W | uint16 |
| 5017 | `sensor.total_dc_power` | W | uint32 |
| 5033 | `sensor.reactive_power` | var ¹ | int32 |
| 5214 | `sensor.battery_power` | W | int32 |
| 5601 | `sensor.meter_active_power` | W | int32 |
| 5603 | `sensor.meter_phase_a_active_power` | W | int32 |
| 5605 | `sensor.meter_phase_b_active_power` | W | int32 |
| 5607 | `sensor.meter_phase_c_active_power` | W | int32 |
| 5622 | `sensor.export_power_limit_min` | W | uint16 |
| 5623 | `sensor.export_power_limit_max` | W | uint16 |
| 5628 | `sensor.bdc_rated_power` | W | uint16 |
| 5723 | `sensor.backup_phase_a_power` | W | int16 |
| 5724 | `sensor.backup_phase_b_power` | W | int16 |
| 5725 | `sensor.backup_phase_c_power` | W | int16 |
| 5726 | `sensor.total_backup_power` | W | int32 |
| 13008 | `sensor.load_power` | W | int32 |
| 13010 | `sensor.export_power_raw` | W | int32 |
| 13034 | `sensor.total_active_power` | W | int32 |
| — | `sensor.battery_forced_charge_discharge_power` | W | uint16 |
| — | `sensor.export_power_limit` | W | uint16 |
| — | `sensor.battery_max_charge_power` | W | uint16 |
| — | `sensor.battery_max_discharge_power` | W | uint16 |
| — | `sensor.battery_charging_start_power` | W | uint16 |
| — | `sensor.battery_discharging_start_power` | W | uint16 |

¹ El protocolo la da en `var`; la integración la publica etiquetada como `W`.

### Batería

| Reg. | Entidad | Unidad | Tipo |
|---|---|---|---|
| 5635 | `sensor.bms_max_charging_current` | A | uint16 |
| 5636 | `sensor.bms_max_discharging_current` | A | uint16 |
| 13020 | `sensor.battery_voltage` | V | uint16 |
| 13021 | `sensor.battery_current` | A | int16 |
| 13023 | `sensor.battery_level` | % | uint16 |
| 13024 | `sensor.battery_state_of_health` | % | uint16 |
| 13025 | `sensor.battery_temperature` | °C | int16 |
| 13280 | `sensor.battery_firmware_version` | — | string |
| — | `sensor.battery_forced_charge_discharge_cmd_raw` | — | uint16 |
| — | `sensor.battery_max_soc` | % | uint16 |
| — | `sensor.battery_min_soc` | % | uint16 |
| — | `sensor.battery_reserved_soc_for_backup` | % | uint16 |

### Tensiones, corrientes y temperaturas

| Reg. | Entidad | Unidad | Tipo |
|---|---|---|---|
| 5008 | `sensor.inverter_temperature` | °C | int16 |
| 5011 | `sensor.mppt1_voltage` | V | uint16 |
| 5012 | `sensor.mppt1_current` | A | uint16 |
| 5013 | `sensor.mppt2_voltage` | V | uint16 |
| 5014 | `sensor.mppt2_current` | A | uint16 |
| 5015 | `sensor.mppt3_voltage` | V | uint16 |
| 5016 | `sensor.mppt3_current` | A | uint16 |
| 5019 | `sensor.phase_a_voltage` | V | uint16 |
| 5020 | `sensor.phase_b_voltage` | V | uint16 |
| 5021 | `sensor.phase_c_voltage` | V | uint16 |
| 5115 | `sensor.mppt4_voltage` | V | uint16 |
| 5116 | `sensor.mppt4_current` | A | uint16 |
| 5242 | `sensor.grid_frequency` | Hz | uint16 |
| 5741 | `sensor.meter_phase_a_voltage` | V | int16 |
| 5742 | `sensor.meter_phase_b_voltage` | V | int16 |
| 5743 | `sensor.meter_phase_c_voltage` | V | int16 |
| 5744 | `sensor.meter_phase_a_current` | A | uint16 |
| 5745 | `sensor.meter_phase_b_current` | A | uint16 |
| 5746 | `sensor.meter_phase_c_current` | A | uint16 |
| 13031 | `sensor.phase_a_current` | A | int16 |
| 13032 | `sensor.phase_b_current` | A | int16 |
| 13033 | `sensor.phase_c_current` | A | int16 |
| — | `sensor.active_power_limitation_ratio_raw` | % | uint16 |

### Identificación y estado

| Reg. | Entidad | Tipo |
|---|---|---|
| 2582 | `sensor.sungrow_version_1` | string |
| 2597 | `sensor.sungrow_version_2` | string |
| 2613 | `sensor.sungrow_version_3` | string |
| 2629 | `sensor.sungrow_version_4_sungrow_battery` | string |
| 4954 | `sensor.sungrow_arm_software` | string |
| 4969 | `sensor.sungrow_dsp_software` | string |
| 4990 | `sensor.sungrow_inverter_serial` | string |
| 5000 | `sensor.sungrow_device_type_code` | uint16 |
| 5035 | `sensor.power_factor` | int16 |
| 5952 | `sensor.sungrow_protocol_version` | uint32 |
| 13001 | `sensor.power_flow_status` | uint16 |
| 13250 | `sensor.inverter_firmware_version` | string |
| 13265 | `sensor.communication_module_firmware_version` | string |
| — | `sensor.running_state_raw` | uint16 |
| — | `sensor.ems_mode_selection_raw` | uint16 |
| — | `sensor.backup_mode_raw` | uint16 |
| — | `sensor.export_power_limit_mode_raw` | uint16 |
| — | `sensor.active_power_limitation_raw` | uint16 |
| — | `sensor.apl_shutdown_at_zero_raw` | uint16 |
| — | `sensor.load_adjustment_mode_selection_raw` | uint16 |
| — | `sensor.load_adjustment_mode_enable_raw` | uint16 |

Los `*_raw` son códigos numéricos; la integración los traduce a texto en
plantillas como `sensor.sungrow_inverter_state`.

## Sensores calculados de la integración

No son registros: los calcula Home Assistant a partir de ellos. Los que importan
para Vatia:

| Entidad | Qué hace |
|---|---|
| `sensor.import_power` / `sensor.export_power` | Parten 13010 por el signo en dos entidades siempre positivas |
| `sensor.battery_charging_power` / `sensor.battery_discharging_power` | Lo mismo con 5214 |
| `sensor.daily_consumed_energy` | El balance de los cinco contadores — **no una medida**, ver arriba |
| `sensor.total_consumed_energy` | Igual, con los acumulados |
| `sensor.sungrow_inverter_state` | El estado de marcha en texto |
| `binary_sensor.pv_generating`, `battery_charging`, `battery_discharging` | Si cada cosa está pasando ahora |

Que la integración parta los sensores con signo en dos es lo cómodo. Si prefieres
usar el registro con signo directamente, Vatia también lo admite: pon la **misma
entidad en las dos casillas** del par y él la separa por el signo (Ajustes →
Sensores lo explica en «Medidor bidireccional»).

## Cómo se leen los registros

**Direcciones.** El protocolo numera desde 1 y Modbus desde 0, así que en la
configuración de Home Assistant la dirección es **el registro menos uno**: el
13002 del protocolo se pide como `address: 13001`. En este documento la columna
«Reg.» es siempre la del protocolo, que es la del manual de Sungrow.

**Escala.** Casi todo viene en décimas: `0.1kWh`, `0.1V`, `0.1A`, `0.1℃`, `0.1%`.
La potencia va en vatios enteros. La integración ya aplica el `scale`.

**Tamaño.** `U16`/`uint16` es un registro; `U32`/`uint32` son dos consecutivos y
hay que leerlos con `swap: word`. Los diarios son de 16 bits y los acumulados de
32, que es lo lógico: un contador diario nunca llega a 6.553,5 kWh.

**Signo.** Los `S16`/`S32` llevan signo, y ahí está el convenio importante:

- **13010, potencia de red** — positivo exportando, negativo importando.
- **5214, potencia de batería** — positivo cargando, negativo descargando.
- **13008, potencia de la casa** — normalmente positivo; puede salir negativo un
  instante cuando los contadores no están en fase.

**Cadencia, que es lo que más sorprende.** La integración agrupa los registros en
cuatro tandas con periodos muy distintos:

| Tanda | Cada | Qué lleva |
|---|---|---|
| `realtime` | 5 s | `load_power` |
| `fast` | 10 s | `battery_power`, potencias de fase |
| `medium` | 60 s | tensiones, corrientes, temperaturas |
| `slowest` | **600 s** | **todos los contadores de energía** |

O sea que las potencias se refrescan cada cinco segundos y los contadores
diarios **cada diez minutos**. Y no todos en el mismo instante: cada tanda
arranca cuando le toca.

Eso tiene una consecuencia directa para cualquiera que haga cuentas con estos
sensores, y es la razón por la que Vatia reparte los flujos **por horas** y no
por intervalos de cinco minutos: entre dos contadores puede haber minutos de
desfase, y ese desfase no debe leerse como energía que apareció de la nada. Un
intervalo en el que la carga de la batería ya se ha actualizado y la generación
solar todavía no parece una carga que el sol no explica —y de ahí a decir que la
puso la red hay un paso—.

"""Modelo de tarifas flexible: tramos personalizados, PVPC y excedentes.

Una tarifa normalizada tiene esta forma::

    {
      "id": "...", "name": "...", "company": "...", "color": "#rrggbb",
      "energy": {
        "type": "schedule" | "pvpc",
        "preset": "td3" | None,          # editor simplificado 2.0TD
        "periods": [                      # 1..6 tramos (solo type=schedule)
          {"name": "Punta", "price": 0.20, "schedule": "L-V 10-14,18-22"},
          ...
        ],
        "pvpc_margin": 0.0,               # €/kWh sobre PVPC (type=pvpc)
      },
      "surplus": {                        # compensación de excedentes
        "type": "none" | "flat" | "schedule",
        "price": 0.06,                    # type=flat
        "periods": [...],                 # type=schedule, igual que energía
      },
      "power_prices": {"p1": ..., "p2": ...},       # €/kW·día
      "fixed_daily": [{"name": ..., "price": ...}],  # €/día
      "meter_rental_daily": 0.02663,
      "services_monthly": [{"name": ..., "price": ...}],
      "electricity_tax_pct": 0.5,
      "vat_energy_pct": 10.0,
      "vat_services_pct": 21.0,
    }

Sintaxis de horarios: reglas separadas por "|"; cada regla es "DÍAS HORAS".
DÍAS: L M X J V S D (lunes..domingo) y F (festivo), sueltos o en rangos
("L-V", "S-D", "L,X,V"). HORAS: rangos "a-b" (b exclusivo) separados por
comas: "10-14,18-22". El tramo sin horario actúa como comodín para las horas
no cubiertas; si no lo hay, se usa el último tramo. Si ninguna regla usa "F",
los festivos se comportan como domingo.
"""

from __future__ import annotations

import csv
import io
import json
import re
from typing import Any

DAY_TOKENS = {"L": 0, "M": 1, "X": 2, "J": 3, "V": 4, "S": 5, "D": 6, "F": 7}
MAX_PERIODS = 6

TD3_PERIODS = [
    {"name": "Punta", "schedule": "L-V 10-14,18-22"},
    {"name": "Llano", "schedule": "L-V 8-10,14-18,22-24"},
    {"name": "Valle", "schedule": ""},  # comodín: noches, fines de semana y festivos
]


class TariffError(ValueError):
    """Error de validación de una tarifa (mensaje apto para el usuario)."""


# ---------------------------------------------------------------------------
# Horarios
# ---------------------------------------------------------------------------


def _parse_days(token: str) -> set[int]:
    days: set[int] = set()
    for part in token.split(","):
        part = part.strip().upper()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            if a not in DAY_TOKENS or b not in DAY_TOKENS:
                raise TariffError(f"Día no reconocido en «{part}» (usa L M X J V S D F)")
            ia, ib = DAY_TOKENS[a], DAY_TOKENS[b]
            if ia > ib:
                raise TariffError(f"Rango de días invertido: «{part}»")
            days.update(range(ia, ib + 1))
        else:
            if part not in DAY_TOKENS:
                raise TariffError(f"Día no reconocido: «{part}» (usa L M X J V S D F)")
            days.add(DAY_TOKENS[part])
    return days


def _parse_hours(token: str) -> set[int]:
    hours: set[int] = set()
    for part in token.split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d{1,2})\s*-\s*(\d{1,2})", part)
        if not m:
            raise TariffError(f"Horas no reconocidas: «{part}» (usa p. ej. 10-14)")
        a, b = int(m.group(1)), int(m.group(2))
        if not (0 <= a < b <= 24):
            raise TariffError(f"Rango horario no válido: «{part}» (entre 0 y 24)")
        hours.update(range(a, b))
    return hours


def parse_schedule(text: str) -> set[tuple[int, int]]:
    """Convierte un horario textual en celdas (día 0-7, hora 0-23)."""
    cells: set[tuple[int, int]] = set()
    for rule in (text or "").split("|"):
        rule = rule.strip()
        if not rule:
            continue
        parts = rule.split(None, 1)
        if len(parts) != 2:
            raise TariffError(
                f"Regla de horario no válida: «{rule}» (formato: DÍAS HORAS, p. ej. L-V 10-14)"
            )
        days = _parse_days(parts[0])
        hours = _parse_hours(parts[1])
        if not days or not hours:
            raise TariffError(f"Regla de horario vacía: «{rule}»")
        cells.update((d, h) for d in days for h in hours)
    return cells


def compile_matrix(periods: list[dict[str, Any]]) -> list[list[int]]:
    """Matriz 8×24 (L..D + festivo) con el índice de tramo de cada hora."""
    if not periods:
        raise TariffError("La tarifa necesita al menos un tramo de energía.")
    if len(periods) > MAX_PERIODS:
        raise TariffError(f"Máximo {MAX_PERIODS} tramos de energía.")
    matrix: list[list[int | None]] = [[None] * 24 for _ in range(8)]
    default_idx: int | None = None
    for idx, period in enumerate(periods):
        schedule = (period.get("schedule") or "").strip()
        if not schedule:
            if default_idx is None:
                default_idx = idx
            continue
        for day, hour in parse_schedule(schedule):
            if matrix[day][hour] is None:
                matrix[day][hour] = idx
    if default_idx is None:
        default_idx = len(periods) - 1
    # Festivos sin reglas propias se comportan como domingo.
    if all(cell is None for cell in matrix[7]):
        matrix[7] = list(matrix[6])
    return [[cell if cell is not None else default_idx for cell in row] for row in matrix]


def period_index_at(matrix: list[list[int]], dt, holidays: set[str]) -> int:
    day = 7 if dt.strftime("%m-%d") in holidays else dt.weekday()
    return matrix[day][dt.hour]


# ---------------------------------------------------------------------------
# Normalización y migración
# ---------------------------------------------------------------------------


def _num(value: Any, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    if isinstance(value, str):
        value = value.replace(",", ".")
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_tariff(raw: dict[str, Any]) -> dict[str, Any]:
    """Devuelve la tarifa en formato canónico, migrando el formato antiguo."""
    tariff = dict(raw)

    energy = tariff.get("energy")
    if not energy:
        # Migración desde el formato v1 (energy_prices punta/llano/valle).
        old = tariff.pop("energy_prices", None) or {}
        energy = {
            "type": "schedule",
            "preset": "td3",
            "periods": [
                {**p, "price": _num(old.get(p["name"].lower()))} for p in TD3_PERIODS
            ],
            "pvpc_margin": 0.0,
        }
    energy.setdefault("type", "schedule")
    energy.setdefault("preset", None)
    energy.setdefault("pvpc_margin", 0.0)
    energy["pvpc_margin"] = _num(energy.get("pvpc_margin"))
    periods = []
    for idx, period in enumerate(energy.get("periods") or []):
        name = (period.get("name") or f"P{idx + 1}").strip()
        periods.append(
            {
                "name": name,
                "price": _num(period.get("price")),
                "schedule": (period.get("schedule") or "").strip(),
            }
        )
    energy["periods"] = periods
    if energy["type"] == "schedule":
        compile_matrix(periods)  # valida horarios
    tariff["energy"] = energy

    surplus = tariff.get("surplus") or {"type": "none"}
    surplus.setdefault("type", "none")
    surplus["price"] = _num(surplus.get("price"))
    surplus["virtual_wallet"] = bool(surplus.get("virtual_wallet"))
    surplus_periods = []
    for idx, period in enumerate(surplus.get("periods") or []):
        surplus_periods.append(
            {
                "name": (period.get("name") or f"E{idx + 1}").strip(),
                "price": _num(period.get("price")),
                "schedule": (period.get("schedule") or "").strip(),
            }
        )
    surplus["periods"] = surplus_periods
    if surplus["type"] == "schedule":
        compile_matrix(surplus_periods)
    tariff["surplus"] = surplus

    power = tariff.get("power_prices") or {}
    tariff["power_prices"] = {"p1": _num(power.get("p1")), "p2": _num(power.get("p2"))}
    tariff["fixed_daily"] = [
        {"name": item.get("name") or "Cargo fijo", "price": _num(item.get("price"))}
        for item in tariff.get("fixed_daily") or []
    ]
    tariff["meter_rental_daily"] = _num(tariff.get("meter_rental_daily"))
    tariff["services_monthly"] = [
        {"name": item.get("name") or "Servicio", "price": _num(item.get("price"))}
        for item in tariff.get("services_monthly") or []
    ]
    tariff["electricity_tax_pct"] = _num(tariff.get("electricity_tax_pct"), 0.5)
    tariff["vat_energy_pct"] = _num(tariff.get("vat_energy_pct"), 10.0)
    tariff["vat_services_pct"] = _num(tariff.get("vat_services_pct"), 21.0)
    tariff["name"] = (tariff.get("name") or "Tarifa sin nombre").strip()
    tariff["company"] = (tariff.get("company") or "").strip()
    tariff["color"] = tariff.get("color") or "#4a6cf7"
    return tariff


# ---------------------------------------------------------------------------
# CSV: plantilla, exportación e importación
# ---------------------------------------------------------------------------

CSV_HEADER = ("campo", "valor")


def template_csv() -> str:
    """Plantilla comentada con todos los campos soportados."""
    rows = [
        CSV_HEADER,
        ("# Campos generales — tipo_energia: tramos | pvpc", ""),
        ("nombre", "Mi tarifa"),
        ("compania", "Mi comercializadora"),
        ("color", "#4a6cf7"),
        ("tipo_energia", "tramos"),
        ("# Tramos de energía (1 a 6). Horario: reglas 'DÍAS HORAS' separadas por '|'.", ""),
        ("# Días: L M X J V S D y F (festivo); rangos L-V. Horas: 10-14,18-22 (fin exclusivo).", ""),
        ("# Deja el horario vacío en el tramo comodín (resto de horas).", ""),
        ("tramo_1_nombre", "Punta"),
        ("tramo_1_precio", "0.203912"),
        ("tramo_1_horario", "L-V 10-14,18-22"),
        ("tramo_2_nombre", "Llano"),
        ("tramo_2_precio", "0.161451"),
        ("tramo_2_horario", "L-V 8-10,14-18,22-24"),
        ("tramo_3_nombre", "Valle"),
        ("tramo_3_precio", "0.129779"),
        ("tramo_3_horario", ""),
        ("# Solo para tipo_energia=pvpc: margen en €/kWh sobre el precio horario", ""),
        ("pvpc_margen", "0"),
        ("# Término de potencia (€/kW·día)", ""),
        ("potencia_p1", "0.091074"),
        ("potencia_p2", "0.013483"),
        ("# Cargos y servicios", ""),
        ("bono_social_dia", "0.019121"),
        ("alquiler_contador_dia", "0.02663"),
        ("servicio_nombre", ""),
        ("servicio_mes", "0"),
        ("# Impuestos", ""),
        ("impuesto_electricidad_pct", "0.5"),
        ("iva_energia_pct", "10"),
        ("iva_servicios_pct", "21"),
        ("# Compensación de excedentes — excedentes_tipo: no | plana | tramos", ""),
        ("excedentes_tipo", "no"),
        ("excedentes_precio", "0.06"),
        ("# monedero_virtual (si/no): acumula como saldo el valor de los", ""),
        ("# excedentes que superan el tope legal en vez de perderlo", ""),
        ("monedero_virtual", "no"),
        ("excedente_1_nombre", ""),
        ("excedente_1_precio", ""),
        ("excedente_1_horario", ""),
    ]
    out = io.StringIO()
    writer = csv.writer(out, delimiter=";", lineterminator="\n")
    writer.writerows(rows)
    return out.getvalue()


def tariff_to_csv(tariff: dict[str, Any]) -> str:
    tariff = normalize_tariff(tariff)
    energy = tariff["energy"]
    surplus = tariff["surplus"]
    rows: list[tuple[str, str]] = [CSV_HEADER]
    rows += [
        ("nombre", tariff["name"]),
        ("compania", tariff["company"]),
        ("color", tariff["color"]),
        ("tipo_energia", "pvpc" if energy["type"] == "pvpc" else "tramos"),
    ]
    for idx, period in enumerate(energy["periods"], start=1):
        rows += [
            (f"tramo_{idx}_nombre", period["name"]),
            (f"tramo_{idx}_precio", f"{period['price']:g}"),
            (f"tramo_{idx}_horario", period["schedule"]),
        ]
    rows += [
        ("pvpc_margen", f"{energy['pvpc_margin']:g}"),
        ("potencia_p1", f"{tariff['power_prices']['p1']:g}"),
        ("potencia_p2", f"{tariff['power_prices']['p2']:g}"),
        ("bono_social_dia", f"{(tariff['fixed_daily'][0]['price'] if tariff['fixed_daily'] else 0):g}"),
        ("alquiler_contador_dia", f"{tariff['meter_rental_daily']:g}"),
        ("servicio_nombre", tariff["services_monthly"][0]["name"] if tariff["services_monthly"] else ""),
        ("servicio_mes", f"{(tariff['services_monthly'][0]['price'] if tariff['services_monthly'] else 0):g}"),
        ("impuesto_electricidad_pct", f"{tariff['electricity_tax_pct']:g}"),
        ("iva_energia_pct", f"{tariff['vat_energy_pct']:g}"),
        ("iva_servicios_pct", f"{tariff['vat_services_pct']:g}"),
        ("excedentes_tipo", {"none": "no", "flat": "plana", "schedule": "tramos"}[surplus["type"]]),
        ("excedentes_precio", f"{surplus['price']:g}"),
        ("monedero_virtual", "si" if surplus.get("virtual_wallet") else "no"),
    ]
    for idx, period in enumerate(surplus["periods"], start=1):
        rows += [
            (f"excedente_{idx}_nombre", period["name"]),
            (f"excedente_{idx}_precio", f"{period['price']:g}"),
            (f"excedente_{idx}_horario", period["schedule"]),
        ]
    out = io.StringIO()
    writer = csv.writer(out, delimiter=";", lineterminator="\n")
    writer.writerows(rows)
    return out.getvalue()


def tariff_from_csv(text: str) -> dict[str, Any]:
    """Construye una tarifa a partir de un CSV campo;valor (o campo,valor)."""
    text = text.lstrip("﻿")
    first_line = text.splitlines()[0] if text.splitlines() else ""
    delimiter = ";" if ";" in first_line else ","
    fields: dict[str, str] = {}
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    for row in reader:
        if not row:
            continue
        key = (row[0] or "").strip().lower()
        if not key or key.startswith("#") or key == "campo":
            continue
        fields[key] = (row[1] if len(row) > 1 else "").strip()

    if not fields:
        raise TariffError("El CSV está vacío o no tiene el formato campo;valor.")

    def collect_periods(prefix: str) -> list[dict[str, Any]]:
        periods = []
        for idx in range(1, MAX_PERIODS + 1):
            price = fields.get(f"{prefix}_{idx}_precio", "")
            name = fields.get(f"{prefix}_{idx}_nombre", "")
            schedule = fields.get(f"{prefix}_{idx}_horario", "")
            if price == "" and name == "" and schedule == "":
                continue
            if price == "":
                raise TariffError(f"Falta el precio del tramo {prefix}_{idx}.")
            periods.append({"name": name or f"P{idx}", "price": price, "schedule": schedule})
        return periods

    energy_type = fields.get("tipo_energia", "tramos").lower()
    if energy_type not in ("tramos", "pvpc"):
        raise TariffError("tipo_energia debe ser «tramos» o «pvpc».")
    energy_periods = collect_periods("tramo")
    if energy_type == "tramos" and not energy_periods:
        raise TariffError("Define al menos un tramo de energía (tramo_1_precio...).")

    surplus_type = fields.get("excedentes_tipo", "no").lower()
    surplus_map = {"no": "none", "plana": "flat", "tramos": "schedule"}
    if surplus_type not in surplus_map:
        raise TariffError("excedentes_tipo debe ser «no», «plana» o «tramos».")
    surplus_periods = collect_periods("excedente")
    if surplus_map[surplus_type] == "schedule" and not surplus_periods:
        raise TariffError("excedentes_tipo=tramos requiere excedente_1_precio...")

    raw = {
        "name": fields.get("nombre") or "Tarifa importada",
        "company": fields.get("compania", ""),
        "color": fields.get("color") or "#4a6cf7",
        "energy": {
            "type": "pvpc" if energy_type == "pvpc" else "schedule",
            "preset": None,
            "periods": energy_periods,
            "pvpc_margin": fields.get("pvpc_margen", "0"),
        },
        "surplus": {
            "type": surplus_map[surplus_type],
            "price": fields.get("excedentes_precio", "0"),
            "periods": surplus_periods,
            "virtual_wallet": fields.get("monedero_virtual", "no").strip().lower()
            in ("si", "sí", "true", "1", "yes"),
        },
        "power_prices": {
            "p1": fields.get("potencia_p1", "0"),
            "p2": fields.get("potencia_p2", "0"),
        },
        "fixed_daily": (
            [{"name": "Financiación bono social", "price": fields.get("bono_social_dia")}]
            if _num(fields.get("bono_social_dia")) > 0
            else []
        ),
        "meter_rental_daily": fields.get("alquiler_contador_dia", "0"),
        "services_monthly": (
            [{"name": fields.get("servicio_nombre") or "Servicios", "price": fields.get("servicio_mes")}]
            if _num(fields.get("servicio_mes")) > 0
            else []
        ),
        "electricity_tax_pct": fields.get("impuesto_electricidad_pct", "0.5"),
        "vat_energy_pct": fields.get("iva_energia_pct", "10"),
        "vat_services_pct": fields.get("iva_servicios_pct", "21"),
    }
    return normalize_tariff(raw)


def slugify(name: str) -> str:
    """Slug apto para entity_id de Home Assistant."""
    slug = name.lower()
    for a, b in (("á", "a"), ("é", "e"), ("í", "i"), ("ó", "o"), ("ú", "u"), ("ñ", "n"), ("ü", "u")):
        slug = slug.replace(a, b)
    slug = re.sub(r"[^a-z0-9]+", "_", slug).strip("_")
    return slug or "tarifa"

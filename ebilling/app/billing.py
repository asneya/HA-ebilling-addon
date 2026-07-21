"""Motor de facturación eléctrica.

Modela una factura española de electricidad (peaje 2.0TD) a partir de una
serie horaria de consumo (kWh) y una definición de tarifa:

  - Término de potencia por periodo (P1 punta / P2 valle), en €/kW·día.
  - Término de energía por periodo horario (punta / llano / valle), en €/kWh.
  - Conceptos fijos diarios (p. ej. financiación del bono social), en €/día.
  - Alquiler de equipos de medida, en €/día.
  - Servicios adicionales, en €/mes.
  - Impuesto especial sobre la electricidad (porcentaje configurable).
  - IVA por grupos: tipo reducido/general para el bloque de energía y tipo
    para servicios.

La discriminación horaria 2.0TD es:
  - Sábados, domingos y festivos nacionales: valle todo el día.
  - Laborables: 00-08 valle · 08-10 llano · 10-14 punta · 14-18 llano ·
    18-22 punta · 22-24 llano.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

PERIODS = ("punta", "llano", "valle")


def classify_hour(dt: datetime, holidays: set[str]) -> str:
    """Clasifica una hora local en punta / llano / valle según 2.0TD."""
    if dt.weekday() >= 5 or dt.strftime("%m-%d") in holidays:
        return "valle"
    h = dt.hour
    if h < 8:
        return "valle"
    if 10 <= h < 14 or 18 <= h < 22:
        return "punta"
    return "llano"


@dataclass
class ConsumptionSummary:
    kwh: dict[str, float] = field(default_factory=lambda: {p: 0.0 for p in PERIODS})

    @property
    def total(self) -> float:
        return sum(self.kwh.values())

    def scaled(self, factor: float) -> "ConsumptionSummary":
        return ConsumptionSummary({p: v * factor for p, v in self.kwh.items()})


def summarize_consumption(
    hourly: list[dict[str, Any]], holidays: set[str]
) -> tuple[ConsumptionSummary, list[dict[str, Any]]]:
    """Agrega la serie horaria por periodo tarifario y por día.

    ``hourly`` es una lista de {"start": datetime local, "kwh": float}.
    Devuelve el resumen por periodos y una serie diaria para gráficos.
    """
    summary = ConsumptionSummary()
    daily: dict[str, dict[str, float]] = {}
    for point in hourly:
        dt: datetime = point["start"]
        kwh = float(point["kwh"] or 0.0)
        period = classify_hour(dt, holidays)
        summary.kwh[period] += kwh
        day = dt.strftime("%Y-%m-%d")
        bucket = daily.setdefault(day, {p: 0.0 for p in PERIODS})
        bucket[period] += kwh
    daily_series = [
        {"date": day, **{p: round(v[p], 3) for p in PERIODS}}
        for day, v in sorted(daily.items())
    ]
    return summary, daily_series


def _round2(x: float) -> float:
    return round(x + 1e-9, 2)


def compute_bill(
    tariff: dict[str, Any],
    consumption: ConsumptionSummary,
    days: float,
    contracted_power: dict[str, float],
) -> dict[str, Any]:
    """Calcula la factura simulada de una tarifa para un periodo dado.

    Devuelve las líneas de detalle (equivalentes a las de una factura real),
    los subtotales por bloque, impuestos y el total.
    """
    lines: list[dict[str, Any]] = []

    # --- Término de potencia -------------------------------------------------
    power_prices = tariff.get("power_prices") or {}
    p1_kw = float(contracted_power.get("p1", 0.0))
    p2_kw = float(contracted_power.get("p2", p1_kw))
    power_total = 0.0
    for label, kw, price in (
        ("Potencia punta (P1)", p1_kw, float(power_prices.get("p1", 0.0))),
        ("Potencia valle (P2)", p2_kw, float(power_prices.get("p2", 0.0))),
    ):
        amount = kw * days * price
        power_total += amount
        lines.append(
            {
                "group": "power",
                "concept": label,
                "detail": f"{kw:g} kW × {round(days, 2):g} días × {price:.6f} €/kW·día",
                "amount": _round2(amount),
            }
        )

    # --- Término de energía --------------------------------------------------
    energy_prices = tariff.get("energy_prices") or {}
    energy_total = 0.0
    for period in PERIODS:
        kwh = consumption.kwh.get(period, 0.0)
        price = float(energy_prices.get(period, 0.0))
        amount = kwh * price
        energy_total += amount
        lines.append(
            {
                "group": "energy",
                "concept": f"Energía {period}",
                "detail": f"{kwh:.2f} kWh × {price:.6f} €/kWh",
                "amount": _round2(amount),
            }
        )

    # --- Cargos y conceptos fijos diarios (bono social, etc.) ---------------
    fixed_total = 0.0
    for item in tariff.get("fixed_daily") or []:
        price = float(item.get("price", 0.0))
        amount = days * price
        fixed_total += amount
        lines.append(
            {
                "group": "charges",
                "concept": item.get("name", "Cargo fijo"),
                "detail": f"{round(days, 2):g} días × {price:.6f} €/día",
                "amount": _round2(amount),
            }
        )

    # --- Impuesto especial sobre la electricidad -----------------------------
    # Base: potencia + energía + cargos (excluye alquiler de contador y
    # servicios), igual que en la factura real.
    elec_tax_pct = float(tariff.get("electricity_tax_pct", 0.5))
    elec_tax_base = power_total + energy_total + fixed_total
    elec_tax = elec_tax_base * elec_tax_pct / 100.0
    lines.append(
        {
            "group": "charges",
            "concept": "Impuesto sobre electricidad",
            "detail": f"{elec_tax_pct:g}% s/ {_round2(elec_tax_base):.2f} €",
            "amount": _round2(elec_tax),
        }
    )

    # --- Alquiler de equipos de medida ---------------------------------------
    meter_rental = float(tariff.get("meter_rental_daily", 0.0)) * days
    if meter_rental:
        lines.append(
            {
                "group": "services",
                "concept": "Alquiler equipos de medida",
                "detail": f"{round(days, 2):g} días × {float(tariff.get('meter_rental_daily', 0.0)):.5f} €/día",
                "amount": _round2(meter_rental),
            }
        )

    # --- Servicios adicionales (€/mes, prorrateados por días) ----------------
    services_total = 0.0
    months = days / 30.0
    for item in tariff.get("services_monthly") or []:
        price = float(item.get("price", 0.0))
        amount = months * price
        services_total += amount
        lines.append(
            {
                "group": "services",
                "concept": item.get("name", "Servicio"),
                "detail": f"{months:.2f} meses × {price:.2f} €/mes",
                "amount": _round2(amount),
            }
        )

    # --- IVA -----------------------------------------------------------------
    # Grupo energía (IVA reducido en la factura de referencia): potencia +
    # energía + cargos + impuesto eléctrico + alquiler de contador.
    # Grupo servicios (IVA general): servicios adicionales.
    vat_energy_pct = float(tariff.get("vat_energy_pct", 21.0))
    vat_services_pct = float(tariff.get("vat_services_pct", 21.0))
    vat_energy_base = elec_tax_base + elec_tax + meter_rental
    vat_services_base = services_total
    vat_energy = vat_energy_base * vat_energy_pct / 100.0
    vat_services = vat_services_base * vat_services_pct / 100.0
    lines.append(
        {
            "group": "vat",
            "concept": f"IVA {vat_energy_pct:g}%",
            "detail": f"{vat_energy_pct:g}% s/ {_round2(vat_energy_base):.2f} €",
            "amount": _round2(vat_energy),
        }
    )
    if vat_services_base > 0:
        lines.append(
            {
                "group": "vat",
                "concept": f"IVA {vat_services_pct:g}%",
                "detail": f"{vat_services_pct:g}% s/ {_round2(vat_services_base):.2f} €",
                "amount": _round2(vat_services),
            }
        )

    total = vat_energy_base + vat_services_base + vat_energy + vat_services

    return {
        "tariff_id": tariff.get("id"),
        "name": tariff.get("name"),
        "company": tariff.get("company"),
        "color": tariff.get("color"),
        "days": round(days, 2),
        "kwh": {p: round(consumption.kwh.get(p, 0.0), 2) for p in PERIODS},
        "kwh_total": round(consumption.total, 2),
        "lines": lines,
        "subtotals": {
            "power": _round2(power_total),
            "energy": _round2(energy_total),
            "charges": _round2(fixed_total + elec_tax),
            "services": _round2(meter_rental + services_total),
            "taxes": _round2(elec_tax + vat_energy + vat_services),
        },
        "total": _round2(total),
    }

"""Motor de facturación eléctrica.

Calcula la factura simulada de una tarifa a partir de la serie horaria de
consumo (y opcionalmente de excedentes vertidos). Soporta:

  - Tramos de energía arbitrarios (1..6) con horario libre por día de la
    semana, hora y festivos (ver tariffs.parse_schedule).
  - PVPC: precio horario indexado (ESIOS) más margen opcional.
  - Compensación de excedentes plana o por tramos, con el tope legal: el
    abono no puede superar el importe del término de energía.
  - Término de potencia P1/P2 (€/kW·día), cargos fijos diarios, alquiler de
    contador, servicios mensuales, impuesto eléctrico e IVA por grupos.

La clasificación 2.0TD estándar (punta/llano/valle) se mantiene para las
estadísticas globales de consumo del panel.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import tariffs as tariffs_mod
from pvpc import price_at as pvpc_price_at

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


def summarize_consumption(
    hourly: list[dict[str, Any]], holidays: set[str]
) -> tuple[dict[str, float], list[dict[str, Any]]]:
    """Resumen global 2.0TD (para las tarjetas y el gráfico del panel)."""
    kwh = {p: 0.0 for p in PERIODS}
    daily: dict[str, dict[str, float]] = {}
    for point in hourly:
        dt: datetime = point["start"]
        value = float(point["kwh"] or 0.0)
        period = classify_hour(dt, holidays)
        kwh[period] += value
        bucket = daily.setdefault(dt.strftime("%Y-%m-%d"), {p: 0.0 for p in PERIODS})
        bucket[period] += value
    daily_series = [
        {"date": day, **{p: round(v[p], 3) for p in PERIODS}}
        for day, v in sorted(daily.items())
    ]
    return kwh, daily_series


def _round2(x: float) -> float:
    return round(x + 1e-9, 2)


# ---------------------------------------------------------------------------
# Desglose de energía por tarifa
# ---------------------------------------------------------------------------


@dataclass
class EnergyBreakdown:
    """kWh y coste de energía por tramo, ya al precio de la tarifa."""

    items: list[dict[str, Any]] = field(default_factory=list)
    # item: {"name", "kwh", "cost", "price" (None si es precio variable)}

    @property
    def total_kwh(self) -> float:
        return sum(i["kwh"] for i in self.items)

    @property
    def total_cost(self) -> float:
        return sum(i["cost"] for i in self.items)

    def scaled(self, factor: float) -> "EnergyBreakdown":
        return EnergyBreakdown(
            [
                {**i, "kwh": i["kwh"] * factor, "cost": i["cost"] * factor}
                for i in self.items
            ]
        )


def _schedule_breakdown(
    periods: list[dict[str, Any]],
    hourly: list[dict[str, Any]],
    holidays: set[str],
    label_prefix: str,
) -> EnergyBreakdown:
    matrix = tariffs_mod.compile_matrix(periods)
    sums = [0.0] * len(periods)
    for point in hourly:
        idx = tariffs_mod.period_index_at(matrix, point["start"], holidays)
        sums[idx] += float(point["kwh"] or 0.0)
    items = []
    for idx, period in enumerate(periods):
        price = float(period["price"])
        items.append(
            {
                "name": f"{label_prefix} {period['name']}",
                "kwh": sums[idx],
                "price": price,
                "cost": sums[idx] * price,
            }
        )
    return EnergyBreakdown(items)


def _pvpc_breakdown(
    hourly: list[dict[str, Any]],
    prices: dict[str, float],
    margin: float,
    label: str,
) -> tuple[EnergyBreakdown, float]:
    """Coste con precio horario. Devuelve también los kWh sin precio."""
    cost = 0.0
    kwh_total = 0.0
    kwh_missing = 0.0
    for point in hourly:
        kwh = float(point["kwh"] or 0.0)
        price = pvpc_price_at(prices, point["start"])
        if price is None:
            kwh_missing += kwh
            continue
        kwh_total += kwh
        cost += kwh * (price + margin)
    avg = cost / kwh_total if kwh_total else None
    return (
        EnergyBreakdown([{"name": label, "kwh": kwh_total, "price": avg, "cost": cost}]),
        kwh_missing,
    )


def energy_breakdown(
    tariff: dict[str, Any],
    hourly: list[dict[str, Any]],
    holidays: set[str],
    pvpc_prices: dict[str, float] | None,
) -> tuple[EnergyBreakdown, float]:
    """Desglose del término de energía. Devuelve (desglose, kWh sin precio)."""
    energy = tariff["energy"]
    if energy["type"] == "pvpc":
        if pvpc_prices is None:
            raise tariffs_mod.TariffError("Precios PVPC no disponibles.")
        return _pvpc_breakdown(
            hourly, pvpc_prices, float(energy.get("pvpc_margin") or 0.0), "Energía PVPC"
        )
    return _schedule_breakdown(energy["periods"], hourly, holidays, "Energía"), 0.0


def surplus_breakdown(
    tariff: dict[str, Any],
    export_hourly: list[dict[str, Any]],
    holidays: set[str],
) -> EnergyBreakdown | None:
    """Abono por excedentes (importes positivos; el signo se aplica al facturar)."""
    surplus = tariff.get("surplus") or {}
    stype = surplus.get("type", "none")
    if stype == "none" or not export_hourly:
        return None
    if stype == "flat":
        price = float(surplus.get("price") or 0.0)
        kwh = sum(float(p["kwh"] or 0.0) for p in export_hourly)
        return EnergyBreakdown(
            [{"name": "Excedentes", "kwh": kwh, "price": price, "cost": kwh * price}]
        )
    return _schedule_breakdown(surplus["periods"], export_hourly, holidays, "Excedentes")


# ---------------------------------------------------------------------------
# Precio instantáneo (para los sensores)
# ---------------------------------------------------------------------------


def price_now(
    tariff: dict[str, Any],
    dt: datetime,
    holidays: set[str],
    pvpc_prices: dict[str, float] | None,
) -> tuple[float | None, str]:
    """(€/kWh del término de energía en ``dt``, nombre del tramo)."""
    energy = tariff["energy"]
    if energy["type"] == "pvpc":
        base = pvpc_price_at(pvpc_prices or {}, dt)
        if base is None:
            return None, "PVPC"
        return base + float(energy.get("pvpc_margin") or 0.0), "PVPC"
    periods = energy["periods"]
    matrix = tariffs_mod.compile_matrix(periods)
    idx = tariffs_mod.period_index_at(matrix, dt, holidays)
    return float(periods[idx]["price"]), periods[idx]["name"]


def surplus_price_now(
    tariff: dict[str, Any], dt: datetime, holidays: set[str]
) -> float | None:
    surplus = tariff.get("surplus") or {}
    stype = surplus.get("type", "none")
    if stype == "none":
        return None
    if stype == "flat":
        return float(surplus.get("price") or 0.0)
    periods = surplus["periods"]
    matrix = tariffs_mod.compile_matrix(periods)
    idx = tariffs_mod.period_index_at(matrix, dt, holidays)
    return float(periods[idx]["price"])


# ---------------------------------------------------------------------------
# Factura completa
# ---------------------------------------------------------------------------


def compute_bill(
    tariff: dict[str, Any],
    energy_bd: EnergyBreakdown,
    surplus_bd: EnergyBreakdown | None,
    days: float,
    contracted_power: dict[str, float],
) -> dict[str, Any]:
    """Calcula la factura simulada (líneas, subtotales, impuestos y total)."""
    lines: list[dict[str, Any]] = []
    days_txt = f"{round(days, 2):g}"

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
                "detail": f"{kw:g} kW × {days_txt} días × {price:.6f} €/kW·día",
                "amount": _round2(amount),
            }
        )

    # --- Término de energía --------------------------------------------------
    energy_total = energy_bd.total_cost
    for item in energy_bd.items:
        price_txt = (
            f"{item['price']:.6f} €/kWh"
            if item.get("price") is not None
            else "precio horario"
        )
        if item.get("price") is not None and item["name"].endswith("PVPC"):
            price_txt = f"{item['price']:.6f} €/kWh medio"
        lines.append(
            {
                "group": "energy",
                "concept": item["name"],
                "detail": f"{item['kwh']:.2f} kWh × {price_txt}",
                "amount": _round2(item["cost"]),
            }
        )

    # --- Compensación de excedentes ------------------------------------------
    # Tope legal (compensación simplificada): el abono no puede superar el
    # importe del término de energía del periodo.
    surplus_credit = 0.0
    if surplus_bd is not None and surplus_bd.total_kwh > 0:
        raw_credit = surplus_bd.total_cost
        surplus_credit = min(raw_credit, energy_total)
        capped = raw_credit > energy_total + 1e-9
        for item in surplus_bd.items:
            share = item["cost"] / raw_credit if raw_credit else 0.0
            amount = -surplus_credit * share
            price_txt = (
                f"{item['price']:.6f} €/kWh" if item.get("price") is not None else ""
            )
            detail = f"{item['kwh']:.2f} kWh × {price_txt}".strip()
            if capped:
                detail += " (limitado al término de energía)"
            lines.append(
                {
                    "group": "energy",
                    "concept": f"Compensación {item['name'].lower()}",
                    "detail": detail,
                    "amount": _round2(amount),
                }
            )
    energy_after_surplus = energy_total - surplus_credit

    # --- Cargos y conceptos fijos diarios ------------------------------------
    fixed_total = 0.0
    for item in tariff.get("fixed_daily") or []:
        price = float(item.get("price", 0.0))
        amount = days * price
        fixed_total += amount
        lines.append(
            {
                "group": "charges",
                "concept": item.get("name", "Cargo fijo"),
                "detail": f"{days_txt} días × {price:.6f} €/día",
                "amount": _round2(amount),
            }
        )

    # --- Impuesto especial sobre la electricidad -----------------------------
    # Base: potencia + energía (tras compensación) + cargos; excluye alquiler
    # de contador y servicios, igual que en la factura real.
    elec_tax_pct = float(tariff.get("electricity_tax_pct", 0.5))
    elec_tax_base = max(power_total + energy_after_surplus + fixed_total, 0.0)
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
    meter_daily = float(tariff.get("meter_rental_daily", 0.0))
    meter_rental = meter_daily * days
    if meter_rental:
        lines.append(
            {
                "group": "services",
                "concept": "Alquiler equipos de medida",
                "detail": f"{days_txt} días × {meter_daily:.5f} €/día",
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
        "kwh_total": round(energy_bd.total_kwh, 2),
        "kwh_periods": [
            {"name": i["name"], "kwh": round(i["kwh"], 2)} for i in energy_bd.items
        ],
        "surplus_kwh": round(surplus_bd.total_kwh, 2) if surplus_bd else 0.0,
        "surplus_credit": _round2(surplus_credit),
        "lines": lines,
        "subtotals": {
            "power": _round2(power_total),
            "energy": _round2(energy_after_surplus),
            "charges": _round2(fixed_total + elec_tax),
            "services": _round2(meter_rental + services_total),
            "taxes": _round2(elec_tax + vat_energy + vat_services),
        },
        "total": _round2(total),
    }

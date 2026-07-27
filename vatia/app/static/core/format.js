/* Cómo se escribe un número en esta app. Todo en es-ES y en un solo sitio. */

export const fmtEUR = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
export const fmtNum = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });
// Precios unitarios: cuatro decimales y sin símbolo, que la unidad va aparte.
export const nf4 = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

export function num6(v) {
  return v == null ? "—" : Number(v).toLocaleString("es-ES", { maximumFractionDigits: 6 });
}

/* Potencia o energía, con la unidad que toque. */
export function fmtValue(v, unit) {
  if (v == null) return "--";
  if (unit === "W") {
    return Math.abs(v) >= 1000 ? `${fmtNum.format(v / 1000)} kW` : `${Math.round(v)} W`;
  }
  return `${fmtNum.format(v)} kWh`;
}

const MESES_ABR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/* Etiqueta del eje X. Se lee del propio ISO para respetar la zona horaria del
   add-on (usar Date lo desplazaría a la del navegador). */
export function xLabel(iso, range) {
  if (range === "total") return iso;
  if (range === "day") return iso.slice(11, 16);
  const m = Number(iso.slice(5, 7)) - 1;
  if (range === "year") return MESES_ABR[m] || "";
  return `${Number(iso.slice(8, 10))} ${MESES_ABR[m] || ""}`;
}

/* Marca de tiempo completa del punto seleccionado. */
export function stampLabel(iso, range) {
  if (range === "total") return iso;
  const day = Number(iso.slice(8, 10));
  const mes = MESES_ABR[Number(iso.slice(5, 7)) - 1] || "";
  const year = iso.slice(0, 4);
  if (range === "day") return `${day} ${mes} ${year}, ${iso.slice(11, 16)}`;
  if (range === "year") return `${mes} ${year}`;
  return `${day} ${mes} ${year}`;
}

export function fmtDay(iso, withYear = true) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-ES", {
    day: "numeric", month: "short", timeZone: "UTC",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

/* Etiqueta corta para la barra de periodo (omite el año si es el mismo). */
export function periodShort(startISO, endISO) {
  const sameYear = startISO.slice(0, 4) === endISO.slice(0, 4);
  return `${fmtDay(startISO, false)} → ${fmtDay(endISO, !sameYear)}`;
}

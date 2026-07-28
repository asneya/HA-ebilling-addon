/*
 * Los colores de las series y de los flujos salen de los tokens del tema, no
 * del servidor: en claro van saturados para leerse sobre blanco y en oscuro se
 * aclaran, y el servidor no sabe qué tema tienes puesto. Se resuelven contra
 * :root para poder pintarlos dentro de un SVG o de un lienzo, donde `var()` no
 * llega a los atributos de presentación.
 */

const SERIES_VAR = {
  solar: "--s-solar", home: "--s-home", grid: "--s-grid",
  grid_import: "--s-grid", grid_export: "--s-exp",
  battery: "--s-batt", battery_charge: "--s-batt", battery_discharge: "--s-batt-out",
  battery_soc: "--s-batt",
  yesterday: "--ink-3", forecast: "--s-forecast",
  to_load: "--s-home", to_battery: "--s-batt", to_grid: "--s-exp",
  from_solar: "--s-solar", from_battery: "--s-batt", from_grid: "--s-grid",
};

let memoria = {};

function token(name) {
  if (memoria[name] === undefined) {
    memoria[name] = getComputedStyle(document.documentElement)
      .getPropertyValue(name).trim() || "#8e97ad";
  }
  return memoria[name];
}

export function seriesColor(key) { return token(SERIES_VAR[key] || "--ink-3"); }

/* Al cambiar de tema los tokens cambian: hay que olvidar lo memorizado. */
export function forgetTokens() { memoria = {}; }

/* El token tal cual, sin color de respaldo: sirve para saber si existe. */
function leer(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* Los gráficos de Facturación van por tramo (`punta`, `llano`…), cuyo token se
   llama igual que la clave. Si no hay token con ese nombre se cae a la tabla de
   series: así los acumulados y el estado de carga dejan de salir con el gris de
   respaldo y llevan el color que les toca. */
export function chartColor(key) {
  if (key.startsWith("--")) return token(key);
  if (memoria[key] === undefined) memoria[key] = leer(`--${key}`) || seriesColor(key);
  return memoria[key];
}

/* El color de una serie o de un token, que es lo que esperan los componentes. */
export function colorForSeries(key) {
  return key.startsWith("--") ? token(key) : seriesColor(key);
}

export const SUM_COLORS = new Proxy({}, { get: (_t, k) => seriesColor(k) });

/* Sobre los colores claros (ámbar, oliva, turquesa) la marca de verificación
   blanca casi no se ve: se decide por luminancia relativa. */
export function isLightColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2] > 0.42;
}

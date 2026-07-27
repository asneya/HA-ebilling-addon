/* Vatia — app web (rutas relativas para funcionar tras el Ingress de HA) */
"use strict";

const state = {
  config: null,
  simulation: null,
  detail: null,
  live: null,
  cyclesBack: 0,
  detailCyclesBack: 0,
  projection: false,
  selectedDay: null,
  editingTariffId: null,
  grouped: null,
  view: "home",
};

const fmtEUR = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const fmtEUR4 = new Intl.NumberFormat("es-ES", {
  style: "currency", currency: "EUR", minimumFractionDigits: 4, maximumFractionDigits: 4,
});
const fmtNum = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });
const fmtKwh = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// Indicador de progreso global: una barra fina en la parte superior mientras
// haya alguna petición en vuelo (HIG: dar señal de espera en toda operación).
let pending = 0;

function setBusy(delta) {
  pending = Math.max(0, pending + delta);
  document.documentElement.classList.toggle("busy", pending > 0);
}

async function api(path, options = {}) {
  setBusy(1);
  try {
    const resp = await fetch(`api/${path}`, { headers: { "Content-Type": "application/json" }, ...options });
    if (!resp.ok) {
      let detail = `Error ${resp.status}`;
      try { detail = (await resp.json()).detail || detail; } catch (_) { /* noop */ }
      throw new Error(detail);
    }
    return resp.json();
  } finally {
    setBusy(-1);
  }
}

function esc(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/* ========================= navegación ========================= */

$$(".tab").forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));
// Solo los segmentos que cambian de subvista (los del rango de Energía también
// son «.seg» y no deben tocar las subvistas de Facturación).
$$(".seg[data-sub]").forEach((seg) => seg.addEventListener("click", () => showSub(seg.dataset.sub)));

function showView(name) {
  state.view = name;
  document.body.dataset.view = name;
  // «energy» es una pantalla apilada sobre Home: no tiene pestaña propia.
  const tabFor = name === "energy" ? "home" : name;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === tabFor));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "home") loadLive();
  if (name === "billing") {
    // Facturación entra siempre con una subvista activa (Simulación por
    // defecto), sin tener que pulsar su segmento.
    if (!$(".subview.active")) showSub(state.sub || "sim");
    if (!state.simulation) loadSimulation();
  }
  if (name === "settings") {
    fillSettings();
    showSettingsPage(null);
  }
}

function showSub(name) {
  state.sub = name;
  $$(".seg[data-sub]").forEach((s) => s.classList.toggle("active", s.dataset.sub === name));
  $$(".subview").forEach((v) => v.classList.toggle("active", v.id === `sub-${name}`));
  if (name === "detail" && !state.detail) loadDetail();
  if (name === "tariffs") renderTariffsList();
}

/* Ajustes por niveles: índice → categoría. */
function showSettingsPage(page) {
  state.settingsPage = page || null;
  $$("#view-settings .settings-page").forEach((p) => {
    p.classList.toggle("active", p.id === `sp-${page || "root"}`);
  });
  // El botón de guardar no tiene sentido en el índice, en la lista de tarifas,
  // en apariencia (el tema se aplica y se guarda al pulsarlo) ni en el
  // diagnóstico, que solo lee.
  const hideSave = !page || ["tariffs", "appearance", "diagnostics", "backup"].includes(page);
  $("#settings-save-bar").classList.toggle("hidden", hideSave);
  $("#settings-status").textContent = "";
  if (page === "tariffs") renderTariffsList();
  if (page === "diagnostics") loadDiagnostics();
  window.scrollTo(0, 0);
}

/* ========================= copia de seguridad ========================= */

$("#import-config-file").addEventListener("click", () => $("#import-config-input").click());
$("#import-config-input").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  $("#import-config-text").value = await file.text();
  ev.target.value = "";
  $("#import-config-status").textContent = `Fichero cargado (${esc(file.name)}). Pulsa «Importar».`;
});

$("#import-config-btn").addEventListener("click", async () => {
  const status = $("#import-config-status");
  const raw = $("#import-config-text").value.trim();
  if (!raw) { status.textContent = "Pega el JSON o elige un fichero."; return; }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    status.textContent = `No es un JSON válido: ${err.message}`;
    return;
  }
  try {
    const r = await api("config/import", { method: "POST", body: JSON.stringify(payload) });
    await reloadConfig();
    fillSettings();
    loadSimulation();
    loadLive();
    const t = r.imported.tariffs;
    status.textContent = `✓ Importado: ${r.imported.settings} ajustes` +
      (t ? ` y ${t} ${t === 1 ? "tarifa" : "tarifas"}` : " (ninguna tarifa en el fichero)") +
      ". Revisa el token en Fuente de datos.";
    $("#import-config-text").value = "";
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
});

/* ========================= diagnóstico ========================= */

async function loadDiagnostics() {
  const body = $("#diag-body");
  body.innerHTML = `<p class="li-note">Leyendo los sensores…</p>`;
  let d;
  try {
    d = await api("diagnostics");
  } catch (err) {
    body.innerHTML = `<p class="li-note">No se pudo calcular: ${esc(err.message)}</p>`;
    return;
  }
  const fila = (r) => `
    <div class="li diag-row">
      <span class="diag-txt">
        <b>${esc(r.label)}</b>
        <small>${r.sensor ? esc(r.sensor) : "sin sensor"} · ${esc(r.source)}</small>
      </span>
      <span class="diag-kwh ${r.kwh == null ? "muted" : ""}">${
        r.kwh == null ? "--" : `${fmtNum.format(r.kwh)} kWh`
      }</span>
    </div>`;
  const lado = (side, titulo, total) => `
    <div class="diag-side">
      <div class="diag-head"><span>${titulo}</span><b>${fmtNum.format(total)} kWh</b></div>
      ${d.rows.filter((r) => r.side === side).map(fila).join("")}
    </div>`;
  const diff = d.diferencia;
  const veredicto = d.cuadra
    ? `Cuadra: la diferencia (${fmtNum.format(Math.abs(diff))} kWh) entra dentro
       del margen normal entre contadores.`
    : `<b>No cuadra por ${fmtNum.format(Math.abs(diff))} kWh.</b> ${
        diff > 0
          ? "Entra más de lo que sale: o el consumo de la casa se queda corto, o la descarga de la batería y la importación se están contando de más."
          : "Sale más de lo que entra: o el consumo de la casa se pasa, o la generación y la importación se están contando de menos."
      }`;
  body.innerHTML = `
    ${lado("entra", "Entra", d.entra)}
    ${lado("sale", "Sale", d.sale)}
    <p class="li-note diag-verdict ${d.cuadra ? "ok" : "warn"}">${veredicto}</p>`;
}

$$("[data-settings-page]").forEach((row) =>
  row.addEventListener("click", () => showSettingsPage(row.dataset.settingsPage)));
$$(".settings-back").forEach((b) =>
  b.addEventListener("click", () => showSettingsPage(null)));

/* ========================= HOME: meteorología y fondo ========================= */

/* El sensor de condición puede traer los estados de HA (`partlycloudy`) o
   texto libre en castellano («Parcialmente nuboso»). Se normaliza a las
   familias que usan el icono y el fondo. */
function weatherFamily(raw) {
  if (!raw) return "clear";
  const s = String(raw).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const has = (...keys) => keys.some((k) => s.includes(k));
  if (has("lightning", "thunder", "tormenta", "electric")) return "lightning";
  if (has("pouring", "chubasc", "diluv", "heavy rain", "lluvia fuerte")) return "pouring";
  if (has("rain", "lluvia", "llov", "drizzle", "llovizna", "shower")) return "rainy";
  if (has("snow", "niev", "nieve", "hail", "granizo")) return "snowy";
  if (has("fog", "niebla", "neblina", "mist", "bruma", "haze", "calima")) return "fog";
  if (has("partlycloudy", "partly", "parcial", "poco nub", "intervalos nub")) return "partlycloudy";
  if (has("cloud", "nub", "cubierto", "overcast")) return "cloudy";
  if (has("wind", "viento")) return "partlycloudy";
  return "clear";
}

function weatherIcon(condition, phase) {
  const night = phase === "night";
  const O = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">`;
  const sun = `<circle cx="12" cy="12" r="4.2"/>` + Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return `<line x1="${(12 + Math.cos(a) * 6.6).toFixed(1)}" y1="${(12 + Math.sin(a) * 6.6).toFixed(1)}" x2="${(12 + Math.cos(a) * 9.4).toFixed(1)}" y2="${(12 + Math.sin(a) * 9.4).toFixed(1)}"/>`;
  }).join("");
  const moon = `<path d="M15.6 3.6a8.4 8.4 0 1 0 4.8 12.2A9 9 0 0 1 15.6 3.6Z"/>`;
  const cloud = `<path d="M7.2 18h9.4a3.4 3.4 0 0 0 .3-6.8 5.2 5.2 0 0 0-10-1.4A3.6 3.6 0 0 0 7.2 18Z"/>`;
  const smallSun = `<circle cx="16.6" cy="7.4" r="2.8"/><path d="M16.6 2.6v1.4M21.4 7.4H20M19.9 4.1l-1 1M19.9 10.7l-1-1"/>`;
  const smallMoon = `<path d="M17.9 4.2a3.4 3.4 0 1 0 2 4.9 3.6 3.6 0 0 1-2-4.9Z"/>`;

  switch (weatherFamily(condition)) {
    case "clear": return O + (night ? moon : sun) + `</svg>`;
    case "partlycloudy": return O + (night ? smallMoon : smallSun) + cloud + `</svg>`;
    case "cloudy": return O + cloud + `</svg>`;
    case "fog": return O + cloud + `<path d="M5 20.6h9M8 22.8h8"/></svg>`;
    case "rainy": return O + cloud + `<path d="M9 20.4l-.8 2M13 20.4l-.8 2M17 20.4l-.8 2"/></svg>`;
    case "pouring": return O + cloud + `<path d="M8.4 19.8l-1.2 3.2M12.4 19.8l-1.2 3.2M16.4 19.8l-1.2 3.2"/></svg>`;
    case "lightning": return O + cloud + `<path d="M13 19.6l-3 3.2h2.6l-.6 2.4 3-3.4h-2.4Z"/></svg>`;
    case "snowy": return O + cloud + `<path d="M9 21.6h.01M13 21.6h.01M17 21.6h.01M11 23.4h.01M15 23.4h.01"/></svg>`;
    default: return O + sun + `</svg>`;
  }
}

const PHASE_TEXT = { night: "Noche", dawn: "Amanecer", day: "Día", sunset: "Atardecer" };

async function loadLive() {
  try {
    state.live = await api("live");
  } catch (err) {
    // Sin conexión con HA seguimos mostrando la interfaz; solo avisamos.
    state.live = null;
    $("#flow-empty").textContent = err.message;
    $("#flow-empty").classList.remove("hidden");
    $("#flow").innerHTML = "";
    return;
  }
  renderLive();
}

function renderLive() {
  const live = state.live;
  if (!live) return;

  // Fondo y cabecera
  const bg = $("#bg");
  bg.dataset.phase = live.phase || "day";
  bg.dataset.weather = weatherFamily(live.weather.condition);

  const temp = live.weather.temperature;
  $("#weather-temp").textContent = temp != null ? `${Math.round(temp)}°` : "—";
  $("#weather-icon").innerHTML = weatherIcon(live.weather.condition, live.phase);
  $("#weather").title = live.weather.condition
    ? `${live.weather.condition} · ${PHASE_TEXT[live.phase] || ""}`
    : "Asigna los sensores de condición y temperatura en Ajustes";

  const now = new Date(live.generated_at);
  $("#home-sub").textContent =
    `${PHASE_TEXT[live.phase] || ""} · ${now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`;

  // El cierre del día sale con la puesta de sol y sustituye a la ventana. Al
  // descartarlo («Ver el día completo») se recuerda la fecha, para que no
  // vuelva a asomar esa misma noche pero sí a la siguiente.
  const closing = live.close && localStorage.getItem("vatia-close-seen") !== live.close.date;
  $("#close").data = closing ? live.close : null;
  $("#close-panel").classList.toggle("hidden", !closing);

  // Ventana de energía gratis. Sin previsión solar no hay ventana que enseñar,
  // y una tarjeta vacía es peor que ninguna: se esconde la tarjeta entera.
  $("#window").data = closing ? null : live.window || null;
  $("#window-panel").classList.toggle("hidden", closing || !live.window);

  // Flujo
  const configured = live.configured;
  $("#flow-empty").classList.toggle("hidden", configured);
  $("#flow").classList.toggle("hidden", !configured);
  if (configured) renderFlow(live);

  // Resumen
  const gen = live.energy.generation, home = live.energy.home;
  const hasEnergy = gen.total > 0 || home.total > 0;
  $("#summary-empty").classList.toggle("hidden", hasEnergy);
  $("#summary").classList.toggle("hidden", !hasEnergy);
  if (hasEnergy) renderSummary(gen, home, live.energy.meters);
}

/* ------------- tabla «Resumen de energía» ------------- */

/* Los colores de las series y de los flujos salen de los tokens del tema, no
   del servidor: en claro van saturados para leerse sobre blanco y en oscuro se
   aclaran, y el servidor no sabe qué tema tienes puesto. Se resuelven contra
   :root para poder pintarlos dentro de un SVG, donde `var()` no llega a los
   atributos de presentación. */
const SERIES_VAR = {
  solar: "--s-solar", home: "--s-home", grid: "--s-grid",
  grid_import: "--s-grid", grid_export: "--s-exp",
  battery: "--s-batt", battery_charge: "--s-batt", battery_discharge: "--s-exp",
  yesterday: "--ink-3", forecast: "--s-solar",
  to_load: "--s-home", to_battery: "--s-batt", to_grid: "--s-exp",
  from_solar: "--s-solar", from_battery: "--s-batt", from_grid: "--s-grid",
};
let _tokenCache = {};
function token(name) {
  if (_tokenCache[name] === undefined) {
    _tokenCache[name] = getComputedStyle(document.documentElement)
      .getPropertyValue(name).trim() || "#8e97ad";
  }
  return _tokenCache[name];
}
function seriesColor(key) { return token(SERIES_VAR[key] || "--ink-3"); }
// Al cambiar de tema los tokens cambian: hay que olvidar lo memorizado.
function forgetTokens() { _tokenCache = {}; }

const SUM_COLORS = new Proxy({}, { get: (_t, k) => seriesColor(k) });


function summaryColumn(title, block) {
  const rows = block.rows;
  const total = rows.reduce((s, r) => s + r.kwh, 0) || 1;
  const bar = rows
    .filter((r) => r.kwh > 0)
    .map((r) => `<i style="width:${(r.kwh / total) * 100}%;background:${SUM_COLORS[r.key]}"></i>`)
    .join("");
  const list = rows.map((r) => `
    <div class="sum-row">
      <div class="sum-label"><i style="background:${SUM_COLORS[r.key]}"></i>${esc(r.label)}</div>
      <div class="sum-line">
        <b>${fmtNum.format(r.kwh)}</b><span class="u">kWh</span>
        <span class="leader"></span><span class="pct">${r.pct}%</span>
      </div>
    </div>`).join("");
  return `
    <div class="sum-col">
      <div class="sum-title">${title}</div>
      <div class="sum-total"><b>${fmtNum.format(block.total)}</b><span>kWh</span></div>
      <div class="sum-bar">${bar}</div>
      <div class="sum-rows">${list}</div>
    </div>`;
}

function renderSummary(gen, home, meters) {
  $("#summary").innerHTML =
    summaryColumn("Generación", gen) + summaryColumn("Consumo de la casa", home);
  renderSummaryMeters(home, meters);
}

/* Las columnas reparten la energía por origen y destino, y «Desde la red» es
   solo la parte de la importación que ha consumido la casa: si parte de lo
   importado ha ido a cargar la batería, no cuadra con el contador. Las lecturas
   de la red ya están en el nodo de la red del diagrama, justo encima, así que
   aquí solo se explica la diferencia cuando existe. */
function renderSummaryMeters(home, meters) {
  const box = $("#summary-meters");
  const notes = [];
  if ((meters?.grid_to_battery || 0) >= 0.05) {
    notes.push(`${fmtNum.format(meters.grid_to_battery)} kWh de lo importado fue a cargar la batería, así que no lo consumió la casa`);
  }
  if ((meters?.battery_to_grid || 0) >= 0.05) {
    notes.push(`${fmtNum.format(meters.battery_to_grid)} kWh de lo vertido salió de la batería`);
  }
  box.classList.toggle("hidden", !notes.length);
  box.innerHTML = notes.length
    ? `<p class="sum-meters-note">${esc(notes.join(" · "))}</p>`
    : "";
}

/* ------------- caudal en tiempo real ------------- */

/* El diagrama de nodos lo sustituye <vatia-flow>, que dibuja un Sankey: el
   ancho de cada corriente es su potencia. La composición del consumo la expresa
   el propio haz, así que el anillo que llevaba el nodo de la casa ya no hace
   falta. El componente vive en static/components/ y se encarga de su estilo. */
function renderFlow(live) {
  const host = $("#flow");
  let node = host.querySelector("vatia-flow");
  if (!node) {
    host.textContent = "";
    node = document.createElement("vatia-flow");
    host.appendChild(node);
  }
  node.data = live;
}

/* ========================= ENERGÍA (pantalla de detalle) ========================= */

const eState = {
  range: "day",
  view: "overview",
  offset: 0,
  data: null,
  hidden: new Set(),
  cursor: null,
  zoom: 1,        // estiramiento del eje X (1 = ancho del panel)
  keepScroll: 0,  // scrollLeft a restaurar tras redibujar
};
const E_ZOOM_MAX = 12;

async function loadEnergy() {
  const banner = $("#e-error");
  banner.classList.add("hidden");
  $("#e-busy").classList.remove("hidden");
  try {
    eState.data = await api(`series?view=${eState.view}&range=${eState.range}&offset=${eState.offset}`);
    // Al entrar en un gráfico todas las series están visibles y sin punto
    // seleccionado: se muestran los totales del periodo.
    eState.hidden.clear();
    eState.cursor = null;
    renderEnergy();
  } catch (err) {
    banner.textContent = err.message;
    banner.classList.remove("hidden");
    $("#e-chart").innerHTML = "";
  } finally {
    $("#e-busy").classList.add("hidden");
  }
}

function fmtValue(v, unit) {
  if (v == null) return "--";
  if (unit === "W") {
    return Math.abs(v) >= 1000 ? `${fmtNum.format(v / 1000)} kW` : `${Math.round(v)} W`;
  }
  return `${fmtNum.format(v)} kWh`;
}

const MESES_ABR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// Etiqueta del eje X. Se lee del propio ISO para respetar la zona horaria del
// add-on (usar Date lo desplazaría a la del navegador).
function xLabel(iso, range) {
  if (range === "total") return iso;
  if (range === "day") return iso.slice(11, 16);
  const m = Number(iso.slice(5, 7)) - 1;
  if (range === "year") return MESES_ABR[m] || "";
  return `${Number(iso.slice(8, 10))} ${MESES_ABR[m] || ""}`;
}

// Marca de tiempo completa del punto seleccionado.
function stampLabel(iso, range) {
  if (range === "total") return iso;
  const day = Number(iso.slice(8, 10));
  const mes = MESES_ABR[Number(iso.slice(5, 7)) - 1] || "";
  const year = iso.slice(0, 4);
  if (range === "day") return `${day} ${mes} ${year}, ${iso.slice(11, 16)}`;
  if (range === "year") return `${mes} ${year}`;
  return `${day} ${mes} ${year}`;
}

function renderEnergy() {
  const d = eState.data;
  if (!d) return;
  $("#e-label").textContent = d.label;
  $("#e-next").disabled = !d.can_next;
  $("#e-unit").textContent = d.unit;
  $$(".seg[data-range]").forEach((s) => s.classList.toggle("active", s.dataset.range === eState.range));
  $$(".vt").forEach((v) => v.classList.toggle("active", v.dataset.eview === eState.view));
  syncPeriodPicker();
  syncZoomControls();

  const hasData = d.x.length && d.series.some((s) => s.values.some((v) => v != null));
  $("#e-empty").classList.toggle("hidden", !!hasData);
  $(".e-chart-wrap").classList.toggle("hidden", !hasData);
  $(".e-zoom-hint").classList.toggle("hidden", !hasData);

  // Marca de tiempo: el punto seleccionado o el periodo completo.
  const idx = eState.cursor;
  const picked = idx != null && d.x[idx];
  $("#e-stamp").textContent = picked ? stampLabel(d.x[idx], eState.range) : d.label;
  $("#e-clear").classList.toggle("hidden", !picked);

  renderEnergyLegend();
  if (hasData) renderEnergyChart();
  renderEnergyBreakdown();
}

// Sobre los colores claros (ámbar, oliva, turquesa) la marca de verificación
// blanca casi no se ve: se decide por luminancia relativa.
function isLightColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2] > 0.42;
}

function renderEnergyLegend() {
  const d = eState.data;
  const idx = eState.cursor;
  // El forecast no tiene leyenda (legend === false).
  const shown = d.series.filter((s) => s.legend !== false);
  $("#e-legend").innerHTML = shown.map((s) => {
    const off = eState.hidden.has(s.key);
    // Con punto seleccionado se muestra su valor instantáneo; si no, el total
    // de energía del periodo para esa serie.
    const value = idx != null
      ? fmtValue(s.values[idx], d.unit)
      : fmtValue(s.total, s.total_unit || d.unit);
    return `
      <button class="e-serie ${off ? "off" : ""}" data-serie="${esc(s.key)}"
              aria-pressed="${!off}" title="Mostrar u ocultar ${esc(s.label)}">
        <span class="n">${esc(s.label)}</span>
        <span class="v">
          <span class="check ${isLightColor(seriesColor(s.key)) ? "on-light" : ""}"
                style="background:${esc(seriesColor(s.key))}">${off ? "" : "✓"}</span>
          <span class="num">${value}</span>
        </span>
      </button>`;
  }).join("");
  $$("#e-legend [data-serie]").forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.serie;
    if (eState.hidden.has(key)) eState.hidden.delete(key); else eState.hidden.add(key);
    renderEnergy();
  }));
}

/* --- Selector de periodo con controles nativos --- */

function syncPeriodPicker() {
  const d = eState.data;
  const input = $("#e-date");
  const picker = $("#e-picker");
  const enabled = eState.range !== "total";
  picker.classList.toggle("disabled", !enabled);
  input.disabled = !enabled;
  if (!enabled || !d) return;
  // El valor del control es un día del periodo mostrado; el máximo, hoy.
  input.value = (d.start || "").slice(0, 10);
  input.max = todayISO();
}

function todayISO() {
  const now = new Date();
  const p = (v) => String(v).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// Desplazamiento (en unidades del rango) entre la fecha elegida y hoy.
function offsetForDate(value, range) {
  const [y, m, dd] = value.split("-").map(Number);
  if (!y || !m || !dd) return null;
  const picked = new Date(y, m - 1, dd);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "day") {
    return Math.round((picked - today) / 86400000);
  }
  if (range === "week") {
    const monday = (dt) => {
      const out = new Date(dt);
      out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
      return out;
    };
    return Math.round((monday(picked) - monday(today)) / (7 * 86400000));
  }
  if (range === "month") {
    return (picked.getFullYear() - today.getFullYear()) * 12 + (picked.getMonth() - today.getMonth());
  }
  if (range === "year") return picked.getFullYear() - today.getFullYear();
  return 0;
}

/* --- Zoom del eje X --- */

function syncZoomControls() {
  $("#e-zoom-val").textContent = `${eState.zoom < 10 ? eState.zoom.toFixed(1) : Math.round(eState.zoom)}×`;
  $("#e-zoom-out").disabled = eState.zoom <= 1.001;
  $("#e-zoom-in").disabled = eState.zoom >= E_ZOOM_MAX - 0.001;
}

// Cambia el zoom manteniendo fijo el punto del eje que está bajo `focusRatio`
// (0–1 del ancho visible), como hace el pinch de iOS. El redibujado se agrupa
// en un frame de animación: durante un pellizco llegan decenas de eventos y
// rehacer el gráfico en cada uno lo dejaría a tirones.
let zoomFrame = 0;

function setZoom(next, focusRatio) {
  const box = $("#e-chart");
  const clamped = Math.max(1, Math.min(E_ZOOM_MAX, next));
  if (Math.abs(clamped - eState.zoom) < 0.002) return;
  const view = box.clientWidth || 1;
  const ratio = focusRatio == null ? 0.5 : focusRatio;
  const anchor = (box.scrollLeft + view * ratio) / (view * eState.zoom);
  eState.zoom = clamped;
  eState.keepScroll = Math.max(0, anchor * view * clamped - view * ratio);
  if (zoomFrame) return;
  zoomFrame = requestAnimationFrame(() => {
    zoomFrame = 0;
    syncZoomControls();
    // Solo el gráfico: la leyenda y el desglose no dependen del zoom.
    if (eState.data) renderEnergyChart();
  });
}

// Tramos contiguos de valores no nulos: [[indice, valor], …] por tramo.
function seriesSegments(values) {
  const out = [];
  let run = [];
  values.forEach((v, i) => {
    if (v == null) { if (run.length) out.push(run); run = []; return; }
    run.push([i, v]);
  });
  if (run.length) out.push(run);
  return out;
}

const E_GUTTER = 46;   // ancho reservado al eje Y (fijo, no se desplaza)
const E_HEIGHT = 268;  // alto del área de gráfico, en px

function renderEnergyChart() {
  const d = eState.data;
  const box = $("#e-chart");
  const visible = d.series.filter((s) => !eState.hidden.has(s.key));
  const H = E_HEIGHT, padT = 16, padB = 26, padR = 14, plotL = E_GUTTER;
  const viewW = Math.max(240, box.clientWidth || 320);
  const W = Math.round(viewW * eState.zoom);
  const plotR = Math.max(plotL + 40, W - padR);

  const values = visible.flatMap((s) => s.values.filter((v) => v != null));
  const rawMax = Math.max(...values, 0.1) * 1.06;
  // Paso redondeado para que el eje no muestre cifras arbitrarias.
  const pow = Math.pow(10, Math.floor(Math.log10(rawMax / 4)));
  const yStep = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
    .map((m) => m * pow).find((v) => v * 4 >= rawMax) || pow * 10;
  const max = yStep * 4;
  const n = d.x.length;
  const X = (i) => plotL + (n <= 1 ? 0 : (i * (plotR - plotL)) / (n - 1));
  const Y = (v) => H - padB - (v / max) * (H - padT - padB);
  const base = (H - padB).toFixed(1);

  let defs = "";
  let svg = "";
  for (let i = 0; i <= 4; i++) {
    const y = Y((max / 4) * i);
    svg += `<line x1="${plotL}" y1="${y.toFixed(1)}" x2="${plotR}" y2="${y.toFixed(1)}" stroke="currentColor" opacity="0.12"/>`;
  }

  // Todas las series se pintan como línea con su área translúcida debajo; solo
  // la previsión va punteada y sin relleno. «Ayer» se dibuja al fondo, con un
  // área más tenue, para no tapar la curva del día.
  const ordered = visible.filter((s) => s.key === "yesterday")
    .concat(visible.filter((s) => s.key !== "yesterday"));
  ordered.forEach((s, si) => {
    const dashed = !!s.dashed;  // solo la previsión: el resto, línea con área
    const faint = s.key === "yesterday";
    const gid = `eg${si}`;
    if (!dashed) {
      defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${esc(seriesColor(s.key))}" stop-opacity="${faint ? 0.16 : 0.34}"/>
        <stop offset="100%" stop-color="${esc(seriesColor(s.key))}" stop-opacity="0.02"/>
      </linearGradient>`;
    }
    seriesSegments(s.values).forEach((seg) => {
      const line = seg
        .map(([i, v], k) => `${k ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`)
        .join(" ");
      if (seg.length === 1) {
        svg += `<circle cx="${X(seg[0][0]).toFixed(1)}" cy="${Y(seg[0][1]).toFixed(1)}" r="2.8" fill="${esc(seriesColor(s.key))}"/>`;
        return;
      }
      if (!dashed) {
        svg += `<path d="${line} L${X(seg[seg.length - 1][0]).toFixed(1)},${base} L${X(seg[0][0]).toFixed(1)},${base} Z" fill="url(#${gid})" stroke="none"/>`;
      }
      svg += `<path d="${line}" fill="none" stroke="${esc(seriesColor(s.key))}" stroke-width="${dashed || faint ? 1.8 : 2.2}"${dashed ? ' stroke-dasharray="2.5 4.5"' : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
    });
  });

  // Cursor: línea vertical con la etiqueta del punto.
  const idx = eState.cursor;
  if (idx != null && d.x[idx]) {
    const x = X(idx);
    svg += `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${H - padB}" stroke="currentColor" opacity="0.55" stroke-width="1.4"/>`;
    visible.forEach((s) => {
      const v = s.values[idx];
      if (v != null) svg += `<circle cx="${x.toFixed(1)}" cy="${Y(v).toFixed(1)}" r="4" fill="${esc(s.color)}" stroke="var(--glass)" stroke-width="2"/>`;
    });
    const anchor = x > W - 90 ? "end" : "start";
    svg += `<text class="e-cursor-label" x="${(x + (anchor === "end" ? -8 : 8)).toFixed(1)}" y="${padT + 11}" text-anchor="${anchor}">${esc(xLabel(d.x[idx], eState.range))}</text>`;
  }

  // Etiquetas del eje X: tantas como quepan sin apelotonarse.
  const slots = Math.max(2, Math.floor((plotR - plotL) / 58));
  const step = Math.max(1, Math.ceil(n / slots));
  d.x.forEach((iso, i) => {
    if (i % step && i !== n - 1) return;
    svg += `<text class="e-axis" x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(xLabel(iso, eState.range))}</text>`;
  });

  box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Gráfico de ${esc(eState.view)}"><defs>${defs}</defs>${svg}</svg>`;
  box.scrollLeft = eState.keepScroll;

  // Eje Y en una capa fija, para que no se desplace con el zoom.
  let gut = "";
  for (let i = 0; i <= 4; i++) {
    const y = Y((max / 4) * i);
    gut += `<text class="e-ylabel" x="${E_GUTTER - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${fmtNum.format((max / 4) * i)}</text>`;
  }
  $("#e-gutter").innerHTML =
    `<svg width="${E_GUTTER}" height="${H}" viewBox="0 0 ${E_GUTTER} ${H}">${gut}</svg>`;

  // La geometría se guarda para los gestos, que están enlazados una sola vez
  // al contenedor (el <svg> se recrea en cada dibujado).
  chartGeo = { plotL, plotR, n };
}

let chartGeo = { plotL: E_GUTTER, plotR: 0, n: 0 };

// Pulsación para seleccionar un punto, arrastre horizontal para desplazarse y
// pinza (o ⌘/Ctrl + rueda) para estirar el eje del tiempo. Se enlaza una única
// vez sobre `#e-chart`, que persiste entre dibujados: si los gestos vivieran en
// el <svg> se perderían en cuanto el primer paso del pellizco lo sustituyera.
function initChartGestures() {
  const box = $("#e-chart");
  const pointers = new Map();
  let pinch = null;
  let drag = null;

  const pick = (clientX) => {
    const svgEl = box.querySelector("svg");
    if (!svgEl || chartGeo.n < 1) return;
    const rect = svgEl.getBoundingClientRect();
    const span = Math.max(chartGeo.plotR - chartGeo.plotL, 1);
    let i = Math.round(((clientX - rect.left - chartGeo.plotL) / span) * (chartGeo.n - 1));
    i = Math.max(0, Math.min(chartGeo.n - 1, i));
    if (i !== eState.cursor) { eState.cursor = i; renderEnergy(); }
  };

  const distance = () => {
    const xs = [...pointers.values()];
    return Math.max(Math.abs(xs[0] - xs[1]), 1);
  };

  box.addEventListener("pointerdown", (ev) => {
    pointers.set(ev.pointerId, ev.clientX);
    if (pointers.size === 2) {
      const xs = [...pointers.values()];
      pinch = { dist: distance(), zoom: eState.zoom, center: (xs[0] + xs[1]) / 2 };
      drag = null;
      return;
    }
    if (pointers.size > 2) return;
    drag = { x: ev.clientX, scroll: box.scrollLeft, moved: false };
    try { box.setPointerCapture(ev.pointerId); } catch (_) { /* no crítico */ }
  });

  box.addEventListener("pointermove", (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, ev.clientX);
    if (pinch && pointers.size >= 2) {
      const rect = box.getBoundingClientRect();
      setZoom(pinch.zoom * (distance() / pinch.dist), (pinch.center - rect.left) / rect.width);
      return;
    }
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    if (Math.abs(dx) > 6) drag.moved = true;
    if (ev.pointerType === "mouse") {
      if (ev.buttons) pick(ev.clientX);  // con ratón, arrastrar recorre los puntos
    } else if (drag.moved) {
      box.scrollLeft = drag.scroll - dx;  // con el dedo, arrastrar desplaza el eje
    }
  });

  const release = (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved && !pointers.size) pick(ev.clientX);  // pulsación, no arrastre
  };
  box.addEventListener("pointerup", release);
  box.addEventListener("pointercancel", (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    drag = null;
  });

  box.addEventListener("wheel", (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;  // rueda normal: desplazamiento
    ev.preventDefault();
    const rect = box.getBoundingClientRect();
    setZoom(eState.zoom * Math.exp(-ev.deltaY / 180), (ev.clientX - rect.left) / rect.width);
  }, { passive: false });

  box.addEventListener("scroll", () => { eState.keepScroll = box.scrollLeft; });
}

function renderEnergyBreakdown() {
  const bd = eState.data.breakdown;
  const panel = $("#e-breakdown-panel");
  if (!bd || !bd.rows.length) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  $("#e-breakdown-title").textContent =
    eState.view === "solar" ? "Reparto de la generación" : "Origen del consumo";
  $("#e-bd-total").textContent = fmtNum.format(bd.total);
  $("#e-bd-unit").textContent = bd.unit;
  const total = bd.rows.reduce((s, r) => s + r.kwh, 0) || 1;
  $("#e-bd-bar").innerHTML = bd.rows.filter((r) => r.kwh > 0)
    .map((r) => `<i style="width:${(r.kwh / total) * 100}%;background:${esc(seriesColor(r.key))}"></i>`).join("");
  $("#e-bd-rows").innerHTML = bd.rows.map((r) => `
    <div class="e-bd-row">
      <div class="l" style="color:${esc(seriesColor(r.key))}">${esc(r.label)}</div>
      <div class="p">${r.pct}%</div>
      <div class="k">${fmtNum.format(r.kwh)} kWh</div>
    </div>`).join("");
}

function openEnergy() {
  showView("energy");
  loadEnergy();
}

// «Ver el día completo»: se apunta la fecha para que el cierre no vuelva esa
// noche, y se repinta la Home con lo último recibido.
$("#close").addEventListener("dismiss", () => {
  const c = $("#close").data;
  if (c) localStorage.setItem("vatia-close-seen", c.date);
  if (state.live) renderLive();
});

$("#summary-panel").addEventListener("click", openEnergy);
$("#summary-panel").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEnergy(); }
});
$("#energy-back").addEventListener("click", () => showView("home"));
$$(".seg[data-range]").forEach((b) => b.addEventListener("click", () => {
  eState.range = b.dataset.range;
  eState.offset = 0;
  resetZoom();
  loadEnergy();
}));
$$(".vt").forEach((b) => b.addEventListener("click", () => {
  eState.view = b.dataset.eview;
  resetZoom();
  loadEnergy();
}));
$("#e-prev").addEventListener("click", () => { eState.offset -= 1; loadEnergy(); });
$("#e-next").addEventListener("click", () => { if (eState.offset < 0) { eState.offset += 1; loadEnergy(); } });

function resetZoom() {
  eState.zoom = 1;
  eState.keepScroll = 0;
}

// Volver a los totales del periodo tras seleccionar un punto.
$("#e-clear").addEventListener("click", () => { eState.cursor = null; renderEnergy(); });

// Zoom del eje del tiempo.
$("#e-zoom-in").addEventListener("click", () => setZoom(eState.zoom * 1.6));
$("#e-zoom-out").addEventListener("click", () => setZoom(eState.zoom / 1.6));
$("#e-zoom-val").addEventListener("click", () => { resetZoom(); renderEnergy(); });
initChartGestures();

// Selector de periodo: control nativo de fecha.
$("#e-date").addEventListener("change", (ev) => {
  const offset = offsetForDate(ev.target.value, eState.range);
  if (offset == null || offset > 0) return;
  eState.offset = offset;
  resetZoom();
  loadEnergy();
});
$("#e-picker").addEventListener("click", () => {
  const input = $("#e-date");
  if (input.disabled) return;
  // En escritorio hay que pedir el calendario explícitamente.
  try { input.showPicker(); } catch (_) { input.focus(); }
});

/* ========================= BILLING: simulación ========================= */

function workingPeriod() {
  return (state.config && state.config.settings && state.config.settings.working_period) || null;
}

async function loadSimulation() {
  const banner = $("#error-banner");
  banner.classList.add("hidden");
  try {
    state.simulation = await api(`simulate?cycles_back=${state.cyclesBack}`);
    renderSimulation();
  } catch (err) {
    banner.textContent = err.message;
    banner.classList.remove("hidden");
  }
}

function fmtDay(iso, withYear = true) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-ES", {
    day: "numeric", month: "short", timeZone: "UTC",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

// Etiqueta corta para la barra de periodo (omite el año si es el mismo).
function periodShort(startISO, endISO) {
  const sameYear = startISO.slice(0, 4) === endISO.slice(0, 4);
  return `${fmtDay(startISO, false)} → ${fmtDay(endISO, !sameYear)}`;
}

function renderSimulation() {
  const sim = state.simulation;
  if (!sim) return;
  $("#demo-banner").classList.toggle("hidden", sim.source !== "demo");
  if (sim.errors && sim.errors.length) {
    $("#error-banner").innerHTML = sim.errors
      .map((e) => `<div><b>${esc(e.tariff)}</b>: ${esc(e.error)}</div>`).join("");
    $("#error-banner").classList.remove("hidden");
  }
  const custom = !!workingPeriod();
  $("#period-label").textContent = periodShort(sim.period.start, sim.period.end) +
    (custom ? " · fijo" : sim.period.is_current ? " · actual" : "");
  $("#bill-sub").textContent = `${fmtDay(sim.period.start)} → ${fmtDay(sim.period.end)}`;
  $("#prev-cycle").disabled = custom;
  $("#next-cycle").disabled = custom || state.cyclesBack === 0;

  const c = sim.consumption;
  const tile = (l, v, s, cls = "") =>
    `<div class="stat glass"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const pct = (part, total) => (total ? `${Math.round((part / total) * 100)}% del total` : "0%");
  let tiles = tile("Consumo total", `${fmtNum.format(c.total)} kWh`,
    `${fmtNum.format(sim.period.elapsed_days)} de ${fmtNum.format(sim.period.cycle_days)} días`);
  tiles += tile("Punta", `${fmtNum.format(c.kwh.punta)} kWh`, pct(c.kwh.punta, c.total), "punta")
    .replace('class="stat glass"', 'class="stat glass punta"');
  tiles += tile("Llano", `${fmtNum.format(c.kwh.llano)} kWh`, pct(c.kwh.llano, c.total))
    .replace('class="stat glass"', 'class="stat glass llano"');
  tiles += tile("Valle", `${fmtNum.format(c.kwh.valle)} kWh`, pct(c.kwh.valle, c.total))
    .replace('class="stat glass"', 'class="stat glass valle"');
  if (c.export_total > 0) {
    tiles += tile("Excedentes", `${fmtNum.format(c.export_total)} kWh`, "energía vertida")
      .replace('class="stat glass"', 'class="stat glass export"');
  }
  $("#stats-row").innerHTML = tiles;

  renderBills(sim);
  renderDailyChart(sim.consumption.daily);
}

function renderBills(sim) {
  const grid = $("#bills-grid");
  const projected = state.projection;
  const bills = [...sim.bills];
  if (projected) bills.sort((a, b) => a.projected_total - b.projected_total);
  if (!bills.length) { grid.innerHTML = `<p class="empty">No hay tarifas que simular.</p>`; return; }
  const cheapest = projected ? bills[0].projected_total : bills[0].total;

  grid.innerHTML = bills.map((bill, i) => {
    const total = projected ? bill.projected_total : bill.total;
    const extra = total - cheapest;
    const badge = i === 0
      ? `<span class="badge best">✓ más barata</span>`
      : `<span class="badge extra">+${fmtEUR.format(extra)}</span>`;
    const type = bill.energy_type === "pvpc" ? `<span class="badge">PVPC</span>` : "";
    const s = bill.subtotals;
    const tot = s.power + s.energy + s.charges + s.services || 1;
    const seg = (v, c) => `<i style="width:${(Math.max(v, 0) / tot) * 100}%;background:${c}"></i>`;
    const shown = projected ? bill.projected : bill;
    const wallet = shown && shown.wallet_credit > 0
      ? `<span class="pill solar">🔋 Monedero +${fmtEUR.format(shown.wallet_credit)}</span>` : "";
    const surplus = bill.surplus_credit > 0 ? `<span>Excedentes −${fmtEUR.format(bill.surplus_credit)}</span>` : "";
    return `
    <div class="bill glass">
      <span class="stripe" style="background:${esc(bill.color || "#0a84ff")}"></span>
      <div class="bill-head">
        <div>
          <div class="bill-co">${esc(bill.company || "")}</div>
          <div class="bill-name">${esc(bill.name || "Tarifa")}</div>
        </div>
        <div class="badges">${type}${badge}</div>
      </div>
      <div class="bill-total">${fmtEUR.format(total)} <small>${projected ? "estim. ciclo" : "acumulado"}</small></div>
      <div class="bill-sub">${projected ? `Acumulado: ${fmtEUR.format(bill.total)}` : `Proyección: ${fmtEUR.format(bill.projected_total)}`}</div>
      <div class="bars">${seg(s.power, "#7c5cff")}${seg(s.energy, "#0a84ff")}${seg(s.charges, "#ff9f0a")}${seg(s.services, "#8e97ad")}</div>
      <div class="chips">
        <span>Potencia ${fmtEUR.format(s.power)}</span><span>Energía ${fmtEUR.format(s.energy)}</span>
        <span>Cargos ${fmtEUR.format(s.charges)}</span><span>Impuestos ${fmtEUR.format(s.taxes)}</span>
        ${surplus}${wallet}
      </div>
      ${bill.warning ? `<div class="soft" style="font-size:12px;margin-top:6px">⚠ ${esc(bill.warning)}</div>` : ""}
      <div class="bill-actions"><button class="btn subtle" data-bill="${esc(bill.tariff_id)}">Ver factura</button></div>
    </div>`;
  }).join("");

  grid.querySelectorAll("[data-bill]").forEach((b) =>
    b.addEventListener("click", () => openBillDetail(b.dataset.bill)));
}

function openBillDetail(tariffId) {
  const bill = state.simulation.bills.find((b) => b.tariff_id === tariffId);
  if (!bill) return;
  const shown = state.projection ? bill.projected : bill;
  $("#bill-modal-title").textContent =
    `${bill.name} · ${state.projection ? "proyección" : "acumulado"}`;
  const groups = [["power", "Término de potencia"], ["energy", "Término de energía"],
    ["charges", "Cargos e impuesto eléctrico"], ["services", "Servicios"], ["vat", "IVA"]];
  let rows = "";
  for (const [key, label] of groups) {
    const lines = shown.lines.filter((l) => l.group === key);
    if (!lines.length) continue;
    rows += `<tr class="group-row"><td colspan="2">${label}</td></tr>`;
    rows += lines.map((l) =>
      `<tr><td>${esc(l.concept)}<div class="detail">${esc(l.detail)}</div></td><td>${fmtEUR.format(l.amount)}</td></tr>`).join("");
  }
  rows += `<tr class="total-row"><td>TOTAL (${fmtNum.format(shown.days)} días · ${fmtNum.format(shown.kwh_total)} kWh)</td><td>${fmtEUR.format(shown.total)}</td></tr>`;
  let extra = "";
  if (shown.wallet_credit > 0) {
    extra = `<tr class="group-row"><td colspan="2">Aparte — no afecta al total</td></tr>
      <tr><td>🔋 Monedero / batería virtual<div class="detail">excedentes por encima del tope legal, acumulados como saldo</div></td><td>+${fmtEUR.format(shown.wallet_credit)}</td></tr>`;
  } else if (shown.surplus_lost > 0) {
    extra = `<tr class="group-row"><td colspan="2">Informativo</td></tr>
      <tr><td>Excedente no compensado<div class="detail">valor vertido por encima del tope legal que se pierde</div></td><td>${fmtEUR.format(shown.surplus_lost)}</td></tr>`;
  }
  $("#bill-modal-body").innerHTML = `<table class="table">${rows}${extra}</table>`;
  $("#bill-modal").classList.remove("hidden");
}

/* ------------- gráficos ------------- */

const PCOLOR = { punta: "#ff6b81", llano: "#ffcf5c", valle: "#34d399" };
const ECOLOR = "#ff9f0a";

function gridAxis(max, padL, padB, padT, width, height) {
  let svg = "";
  for (let i = 0; i <= 4; i++) {
    const val = (max / 4) * i;
    const y = height - padB - (val / max) * (height - padT - padB);
    svg += `<line x1="${padL}" y1="${y}" x2="${width}" y2="${y}" stroke="currentColor" opacity="0.12"/>`;
    svg += `<text x="${padL - 6}" y="${y + 4}" class="c-axis" text-anchor="end">${val.toFixed(1)}</text>`;
  }
  return svg;
}

function renderDailyChart(daily) {
  const c = $("#daily-chart");
  if (!daily || !daily.length) { c.innerHTML = `<p class="empty">Sin datos.</p>`; return; }
  const bw = 26, gap = 8, padL = 42, padB = 26, padT = 12, height = 220;
  const width = padL + daily.length * (bw + gap) + 10;
  const max = Math.max(...daily.map((d) => d.punta + d.llano + d.valle), 0.1);
  const scale = (height - padT - padB) / max;
  let svg = gridAxis(max, padL, padB, padT, width, height);
  daily.forEach((d, i) => {
    const x = padL + i * (bw + gap);
    let y = height - padB;
    for (const p of ["valle", "llano", "punta"]) {
      const h = d[p] * scale; y -= h;
      svg += `<rect class="bar-seg" x="${x}" y="${y}" width="${bw}" height="${Math.max(h, 0)}" rx="3" fill="${PCOLOR[p]}"><title>${d.date} · ${p}: ${fmtNum.format(d[p])} kWh</title></rect>`;
    }
    if (daily.length <= 31 || i % 2 === 0) {
      svg += `<text x="${x + bw / 2}" y="${height - 8}" class="c-axis" text-anchor="middle">${d.date.slice(8)}</text>`;
    }
  });
  c.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${svg}</svg>`;
}

/* ========================= BILLING: detalle ========================= */

async function loadDetail() {
  const banner = $("#d-error");
  banner.classList.add("hidden");
  try {
    state.detail = await api(`detail?cycles_back=${state.detailCyclesBack}`);
    renderDetail();
  } catch (err) {
    banner.textContent = err.message;
    banner.classList.remove("hidden");
  }
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const custom = !!workingPeriod();
  $("#d-period").textContent = periodShort(d.period.start, d.period.end) +
    (custom ? " · fijo" : d.period.is_current ? " · actual" : "");
  $("#d-prev").disabled = custom;
  $("#d-next").disabled = custom || state.detailCyclesBack === 0;

  const t = d.totals;
  const tile = (l, v, s, cls = "") =>
    `<div class="stat glass ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const pct = (p, tot) => (tot ? `${Math.round((p / tot) * 100)}% del total` : "0%");
  let tiles = tile("Importada", `${fmtNum.format(t.import)} kWh`, "compara con tu sensor");
  if (d.has_export || t.export > 0) tiles += tile("Exportada", `${fmtNum.format(t.export)} kWh`, "energía vertida", "export");
  tiles += tile("Punta", `${fmtNum.format(t.punta)} kWh`, pct(t.punta, t.import), "punta");
  tiles += tile("Llano", `${fmtNum.format(t.llano)} kWh`, pct(t.llano, t.import), "llano");
  tiles += tile("Valle", `${fmtNum.format(t.valle)} kWh`, pct(t.valle, t.import), "valle");
  $("#d-stats").innerHTML = tiles;

  renderDailyDetail(d.days);
  renderMonthlyCumulative(d.days);
  if (state.selectedDay && d.days.some((x) => x.date === state.selectedDay)) renderHourly(state.selectedDay);
  else { state.selectedDay = null; $("#d-hourly-wrap").classList.add("hidden"); }
}

function renderDailyDetail(days) {
  const c = $("#d-daily");
  if (!days || !days.length) { c.innerHTML = `<p class="empty">Sin datos.</p>`; return; }
  const gw = 30, gap = 12, padL = 44, padB = 28, padT = 10, height = 240;
  const width = padL + days.length * (gw + gap) + 10;
  const max = Math.max(...days.map((d) => Math.max(d.import, d.export)), 0.1);
  const scale = (height - padT - padB) / max;
  const iw = 17, ew = 9;
  let svg = gridAxis(max, padL, padB, padT, width, height);
  days.forEach((d, i) => {
    const x = padL + i * (gw + gap);
    if (state.selectedDay === d.date) {
      svg += `<rect x="${x - gap / 2}" y="${padT}" width="${gw + gap}" height="${height - padT - padB}" fill="currentColor" opacity="0.07" rx="5"/>`;
    }
    let y = height - padB;
    for (const p of ["valle", "llano", "punta"]) {
      const h = d[p] * scale; y -= h;
      svg += `<rect class="bar-seg" data-day="${d.date}" x="${x}" y="${y}" width="${iw}" height="${Math.max(h, 0)}" rx="3" fill="${PCOLOR[p]}" style="cursor:pointer"><title>${d.date} · ${p}: ${fmtNum.format(d[p])} kWh</title></rect>`;
    }
    const eh = d.export * scale;
    svg += `<rect class="bar-seg" data-day="${d.date}" x="${x + iw + 2}" y="${height - padB - eh}" width="${ew}" height="${Math.max(eh, 0)}" rx="3" fill="${ECOLOR}" style="cursor:pointer"><title>${d.date} · exportada: ${fmtNum.format(d.export)} kWh</title></rect>`;
    if (days.length <= 31 || i % 2 === 0) {
      svg += `<text x="${x + gw / 2}" y="${height - 8}" class="c-axis" text-anchor="middle">${d.date.slice(8)}</text>`;
    }
  });
  c.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${svg}</svg>`;
  c.querySelectorAll("[data-day]").forEach((el) =>
    el.addEventListener("click", () => selectDay(el.getAttribute("data-day"))));
}

function cumulativeChart(container, points, step) {
  if (!points || !points.length) { container.innerHTML = `<p class="empty">Sin datos.</p>`; return; }
  const height = 220, padL = 44, padB = 26, padT = 14, padR = 50;
  const width = padL + (points.length - 1) * step + padR;
  const last = points[points.length - 1];
  const max = Math.max(last.import, last.export, 0.1);
  const X = (i) => padL + i * step;
  const Y = (v) => height - padB - (v / max) * (height - padT - padB);
  let svg = gridAxis(max, padL, padB, padT, width, height);
  const line = (key, color) => {
    let path = "";
    points.forEach((p, i) => { path += `${i ? "L" : "M"}${X(i)},${Y(p[key])} `; });
    let s = `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>`;
    points.forEach((p, i) => {
      s += `<circle cx="${X(i)}" cy="${Y(p[key])}" r="2.5" fill="${color}"><title>${p.label} · ${fmtNum.format(p[key])} kWh</title></circle>`;
    });
    s += `<text x="${X(points.length - 1) + 6}" y="${Y(last[key]) + 4}" font-size="10.5" fill="${color}" font-weight="700">${fmtNum.format(last[key])}</text>`;
    return s;
  };
  svg += line("import", "#0a84ff");
  if (last.export > 0) svg += line("export", ECOLOR);
  points.forEach((p, i) => {
    if (points.length <= 31 || i % 2 === 0) {
      svg += `<text x="${X(i)}" y="${height - 8}" class="c-axis" text-anchor="middle">${p.label}</text>`;
    }
  });
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${svg}</svg>`;
}

function renderMonthlyCumulative(days) {
  let ci = 0, ce = 0;
  cumulativeChart($("#d-cum-month"), days.map((d) => {
    ci += d.import; ce += d.export;
    return { label: d.date.slice(8), import: ci, export: ce };
  }), 42);
}

function selectDay(date) {
  state.selectedDay = date;
  renderDailyDetail(state.detail.days);
  renderHourly(date);
  $("#d-hourly-wrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderHourly(date) {
  const d = state.detail;
  const map = {};
  d.hours.filter((h) => h.date === date).forEach((h) => (map[h.hour] = h));
  const hours = Array.from({ length: 24 }, (_, hh) => map[hh] || { hour: hh, kwh: 0, export: 0, period: null });
  $("#d-hourly-wrap").classList.remove("hidden");
  const [y, m, dd] = date.split("-").map(Number);
  $("#d-hourly-title").textContent = "Desglose por horas · " +
    new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

  const bw = 15, gap = 6, group = 2 * bw + 3, padL = 44, padB = 26, padT = 10, height = 200;
  const width = padL + 24 * (group + gap) + 10;
  const max = Math.max(...hours.map((h) => Math.max(h.kwh, h.export)), 0.1);
  const scale = (height - padT - padB) / max;
  let svg = gridAxis(max, padL, padB, padT, width, height);
  hours.forEach((h, i) => {
    const x = padL + i * (group + gap);
    const ih = h.kwh * scale;
    svg += `<rect class="bar-seg" x="${x}" y="${height - padB - ih}" width="${bw}" height="${Math.max(ih, 0)}" rx="3" fill="${h.period ? PCOLOR[h.period] : "#8e97ad"}"><title>${String(h.hour).padStart(2, "0")}:00 · ${fmtNum.format(h.kwh)} kWh</title></rect>`;
    const eh = h.export * scale;
    svg += `<rect class="bar-seg" x="${x + bw + 3}" y="${height - padB - eh}" width="${bw}" height="${Math.max(eh, 0)}" rx="3" fill="${ECOLOR}"><title>${String(h.hour).padStart(2, "0")}:00 · exportada ${fmtNum.format(h.export)} kWh</title></rect>`;
    if (i % 2 === 0) svg += `<text x="${x + group / 2}" y="${height - 8}" class="c-axis sm" text-anchor="middle">${h.hour}</text>`;
  });
  $("#d-hourly").innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${svg}</svg>`;

  let ci = 0, ce = 0;
  cumulativeChart($("#d-cum-day"), hours.map((h) => {
    ci += h.kwh; ce += h.export;
    return { label: String(h.hour), import: ci, export: ce };
  }), 34);

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "—");
  $("#d-hourly-table").innerHTML =
    `<tr class="group-row"><td>Hora</td><td>Periodo</td><td>Importada</td><td>Exportada</td></tr>` +
    hours.map((h) => `<tr><td>${String(h.hour).padStart(2, "0")}:00</td><td>${cap(h.period)}</td><td>${fmtNum.format(h.kwh)} kWh</td><td>${fmtNum.format(h.export)} kWh</td></tr>`).join("");
}

/* ========================= tarifas ========================= */

function num6(v) {
  return v == null ? "—" : Number(v).toLocaleString("es-ES", { maximumFractionDigits: 6 });
}

function describeTariff(t) {
  const e = t.energy || {};
  if (e.type === "pvpc") {
    const m = Number(e.pvpc_margin || 0);
    return `PVPC${m ? ` +${num6(m)}` : ""}`;
  }
  const n = (e.periods || []).length;
  return n === 1 ? "Precio único" : `${n} tramos`;
}

// Se pinta en Facturación → Tarifas y también en Ajustes → Tarifas.
function renderTariffsList() {
  const targets = [$("#tariffs-list"), $("#tariffs-list-settings")].filter(Boolean);
  const tariffs = state.config?.tariffs || [];
  if (!tariffs.length) {
    targets.forEach((el) => { el.innerHTML = `<p class="empty">No hay tarifas. Crea la primera o importa un CSV.</p>`; });
    return;
  }
  const html = tariffs.map((t) => {
    const e = t.energy || {};
    const chips = e.type === "pvpc"
      ? `<div class="price"><div class="pl">Energía</div><div class="pv">PVPC</div></div>`
      : (e.periods || []).map((p) =>
          `<div class="price"><div class="pl">${esc(p.name)}</div><div class="pv">${num6(p.price)}</div></div>`).join("");
    const surplus = t.surplus && t.surplus.type !== "none"
      ? `<span>☀ ${t.surplus.type === "flat" ? `${num6(t.surplus.price)} €/kWh` : "por tramos"}${t.surplus.virtual_wallet ? " · monedero" : ""}</span>` : "";
    return `
    <div class="bill glass">
      <span class="stripe" style="background:${esc(t.color || "#0a84ff")}"></span>
      <div class="bill-head">
        <div><div class="bill-co">${esc(t.company || "")}</div><div class="bill-name">${esc(t.name)}</div></div>
        <span class="badge">${esc(describeTariff(t))}</span>
      </div>
      <div class="prices">${chips}</div>
      <div class="chips">
        <span>P1 ${num6(t.power_prices?.p1)}</span><span>P2 ${num6(t.power_prices?.p2)}</span>
        <span>IVA ${t.vat_energy_pct ?? 21}%</span>${surplus}
      </div>
      <div class="bill-actions">
        <button class="btn subtle" data-edit="${esc(t.id)}">Editar</button>
        <button class="btn subtle" data-clone="${esc(t.id)}">Duplicar</button>
        <a class="btn subtle" href="api/tariffs/${esc(t.id)}/export.csv" download>CSV</a>
        <button class="btn subtle danger" data-del="${esc(t.id)}">Eliminar</button>
      </div>
    </div>`;
  }).join("");
  targets.forEach((el) => {
    el.innerHTML = html;
    el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openTariffModal(b.dataset.edit)));
    el.querySelectorAll("[data-clone]").forEach((b) => b.addEventListener("click", () => cloneTariff(b.dataset.clone)));
    el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteTariff(b.dataset.del)));
  });
}

function periodRow(container, period = {}) {
  const row = document.createElement("div");
  row.className = "period-row";
  row.innerHTML = `
    <input class="pr-name" placeholder="Nombre" value="${esc(period.name || "")}">
    <input class="pr-price" type="number" step="0.000001" min="0" placeholder="€/kWh" value="${period.price ?? ""}">
    <input class="pr-schedule" placeholder="L-V 10-14,18-22 (vacío = resto)" value="${esc(period.schedule || "")}">
    <button class="icon-btn pr-del" title="Quitar">✕</button>`;
  row.querySelector(".pr-del").addEventListener("click", () => row.remove());
  container.appendChild(row);
}

function readPeriodRows(container) {
  return Array.from(container.querySelectorAll(".period-row")).map((row, i) => ({
    name: row.querySelector(".pr-name").value.trim() || `P${i + 1}`,
    price: parseFloat(row.querySelector(".pr-price").value) || 0,
    schedule: row.querySelector(".pr-schedule").value.trim(),
  }));
}

function updateEditorVisibility() {
  const etype = $("#t-etype").value;
  $("#t-etype-td3").classList.toggle("hidden", etype !== "td3");
  $("#t-etype-custom").classList.toggle("hidden", etype !== "custom");
  $("#t-etype-pvpc").classList.toggle("hidden", etype !== "pvpc");
  const stype = $("#t-surplus-type").value;
  $("#t-surplus-flat").classList.toggle("hidden", stype !== "flat");
  $("#t-surplus-custom").classList.toggle("hidden", stype !== "schedule");
  $("#t-wallet-wrap").classList.toggle("hidden", stype === "none");
}

function openTariffModal(tariffId = null) {
  state.editingTariffId = tariffId;
  const t = tariffId ? state.config.tariffs.find((x) => x.id === tariffId) : null;
  $("#tariff-modal-title").textContent = t ? `Editar · ${t.name}` : "Nueva tarifa";
  $("#tariff-error").textContent = "";
  $("#t-name").value = t?.name || "";
  $("#t-company").value = t?.company || "";
  $("#t-color").value = t?.color || "#0a84ff";
  const energy = t?.energy || { type: "schedule", preset: "td3", periods: [], pvpc_margin: 0 };
  $("#t-etype").value = energy.type === "pvpc" ? "pvpc" : (energy.preset === "td3" || !t ? "td3" : "custom");
  const byName = {};
  (energy.periods || []).forEach((p) => { byName[p.name.toLowerCase()] = p.price; });
  $("#t-td3-punta").value = byName.punta ?? "";
  $("#t-td3-llano").value = byName.llano ?? "";
  $("#t-td3-valle").value = byName.valle ?? "";
  const box = $("#t-periods"); box.innerHTML = "";
  (energy.type === "schedule" && energy.periods?.length ? energy.periods : [{}]).forEach((p) => periodRow(box, p));
  $("#t-pvpc-margin").value = energy.pvpc_margin ?? 0;
  const surplus = t?.surplus || { type: "none", price: 0, periods: [] };
  $("#t-surplus-type").value = surplus.type || "none";
  $("#t-surplus-price").value = surplus.price ?? "";
  $("#t-virtual-wallet").checked = !!surplus.virtual_wallet;
  const sbox = $("#t-surplus-periods"); sbox.innerHTML = "";
  (surplus.periods?.length ? surplus.periods : [{}]).forEach((p) => periodRow(sbox, p));
  $("#t-power-p1").value = t?.power_prices?.p1 ?? "";
  $("#t-power-p2").value = t?.power_prices?.p2 ?? "";
  $("#t-bono").value = t?.fixed_daily?.[0]?.price ?? 0.019121;
  $("#t-meter").value = t?.meter_rental_daily ?? 0.02663;
  $("#t-services").value = t?.services_monthly?.[0]?.price ?? "";
  $("#t-services-name").value = t?.services_monthly?.[0]?.name ?? "";
  $("#t-elec-tax").value = t?.electricity_tax_pct ?? 0.5;
  $("#t-vat-energy").value = t?.vat_energy_pct ?? 10;
  $("#t-vat-services").value = t?.vat_services_pct ?? 21;
  updateEditorVisibility();
  $("#tariff-modal").classList.remove("hidden");
}

function tariffFromForm() {
  const num = (sel, def = 0) => { const v = parseFloat($(sel).value); return Number.isFinite(v) ? v : def; };
  const etype = $("#t-etype").value;
  let energy;
  if (etype === "pvpc") energy = { type: "pvpc", preset: null, periods: [], pvpc_margin: num("#t-pvpc-margin") };
  else if (etype === "td3") energy = {
    type: "schedule", preset: "td3", pvpc_margin: 0,
    periods: [
      { name: "Punta", price: num("#t-td3-punta"), schedule: "L-V 10-14,18-22" },
      { name: "Llano", price: num("#t-td3-llano"), schedule: "L-V 8-10,14-18,22-24" },
      { name: "Valle", price: num("#t-td3-valle"), schedule: "" },
    ],
  };
  else energy = { type: "schedule", preset: null, periods: readPeriodRows($("#t-periods")), pvpc_margin: 0 };
  const stype = $("#t-surplus-type").value;
  const services = num("#t-services", 0);
  return {
    name: $("#t-name").value.trim() || "Tarifa sin nombre",
    company: $("#t-company").value.trim(),
    color: $("#t-color").value,
    energy,
    surplus: {
      type: stype, price: num("#t-surplus-price"),
      periods: stype === "schedule" ? readPeriodRows($("#t-surplus-periods")) : [],
      virtual_wallet: stype !== "none" && $("#t-virtual-wallet").checked,
    },
    power_prices: { p1: num("#t-power-p1"), p2: num("#t-power-p2") },
    fixed_daily: num("#t-bono") > 0 ? [{ name: "Financiación bono social", price: num("#t-bono") }] : [],
    meter_rental_daily: num("#t-meter"),
    services_monthly: services > 0
      ? [{ name: $("#t-services-name").value.trim() || "Servicios", price: services }] : [],
    electricity_tax_pct: num("#t-elec-tax", 0.5),
    vat_energy_pct: num("#t-vat-energy", 10),
    vat_services_pct: num("#t-vat-services", 21),
  };
}

async function saveTariff() {
  const tariff = tariffFromForm();
  $("#tariff-error").textContent = "";
  try {
    if (state.editingTariffId) await api(`tariffs/${state.editingTariffId}`, { method: "PUT", body: JSON.stringify(tariff) });
    else await api("tariffs", { method: "POST", body: JSON.stringify(tariff) });
    $("#tariff-modal").classList.add("hidden");
    await reloadConfig();
    renderTariffsList();
    loadSimulation();
  } catch (err) { $("#tariff-error").textContent = err.message; }
}

async function cloneTariff(id) {
  const t = state.config.tariffs.find((x) => x.id === id);
  if (!t) return;
  const copy = JSON.parse(JSON.stringify(t));
  delete copy.id;
  copy.name = `${copy.name} (copia)`;
  await api("tariffs", { method: "POST", body: JSON.stringify(copy) });
  await reloadConfig(); renderTariffsList(); loadSimulation();
}

async function deleteTariff(id) {
  const t = state.config.tariffs.find((x) => x.id === id);
  if (!t || !confirm(`¿Eliminar la tarifa «${t.name}»?`)) return;
  await api(`tariffs/${id}`, { method: "DELETE" });
  await reloadConfig(); renderTariffsList(); loadSimulation();
}

/* ------------- importar CSV ------------- */

function openImportModal() {
  $("#import-textarea").value = "";
  $("#import-error").textContent = "";
  $("#import-modal").classList.remove("hidden");
  setTimeout(() => $("#import-textarea").focus(), 60);
}

async function doImport() {
  const text = $("#import-textarea").value.trim();
  const err = $("#import-error");
  err.textContent = "";
  if (!text) { err.textContent = "Pega el CSV o carga un archivo."; return; }
  const btn = $("#do-import-btn");
  btn.disabled = true;
  try {
    const resp = await fetch("api/tariffs/import", {
      method: "POST", headers: { "Content-Type": "text/csv" }, body: text,
    });
    if (!resp.ok) {
      let detail = `Error ${resp.status}`;
      try { detail = (await resp.json()).detail || detail; } catch (_) { /* noop */ }
      throw new Error(detail);
    }
    const tariff = await resp.json();
    $("#import-modal").classList.add("hidden");
    $("#import-status").textContent = `✓ Tarifa «${tariff.name}» importada.`;
    await reloadConfig(); renderTariffsList(); loadSimulation();
  } catch (e) { err.textContent = `✗ ${e.message}`; } finally { btn.disabled = false; }
}

/* ========================= AJUSTES ========================= */

const FLOW_FIELDS = [
  ["pv", "Producción solar", "power"],
  ["grid_import", "Importación de red", "power"],
  ["grid_export", "Exportación a red", "power"],
  ["battery_charge", "Carga de batería", "power"],
  ["battery_discharge", "Descarga de batería", "power"],
  ["home", "Consumo de la casa", "power"],
  ["battery_soc", "Batería (%)", "percent"],
];
const ENERGY_FIELDS = [
  ["pv_energy", "Solar", "energy"],
  ["grid_import_energy", "Importada", "energy"],
  ["grid_export_energy", "Exportada", "energy"],
  ["battery_charge_energy", "Carga", "energy"],
  ["battery_discharge_energy", "Descarga", "energy"],
  ["home_energy", "Casa (opcional)", "energy"],
];

function optionsFor(kind, selected) {
  const list = (state.grouped && state.grouped[kind]) || [];
  let html = `<option value="">— sin asignar —</option>`;
  // Se conserva el valor guardado aunque no esté en la lista (entidad no
  // disponible ahora, o varios sensores separados por comas).
  if (selected && !list.some((e) => e.entity_id === selected))
    html += `<option value="${esc(selected)}" selected>${esc(selected)}</option>`;
  html += list.map((e) =>
    `<option value="${esc(e.entity_id)}" ${e.entity_id === selected ? "selected" : ""}>${esc(e.name)}${e.unit ? ` (${esc(e.unit)})` : ""}</option>`).join("");
  return html;
}

function renderSensorLists() {
  const s = state.config.settings;
  $("#flow-sensor-list").innerHTML = FLOW_FIELDS.map(([key, label, kind]) => `
    <label class="li"><span class="li-label">${label}</span>
      <select data-flow="${key}">${optionsFor(kind, (s.flow_sensors || {})[key] || "")}</select></label>`).join("");
  $("#energy-sensor-list").innerHTML = ENERGY_FIELDS.map(([key, label, kind]) => `
    <label class="li"><span class="li-label">${label}</span>
      <select data-energy="${key}">${optionsFor(kind, (s.energy_sensors || {})[key] || "")}</select></label>`).join("");
  $("#s-condition").innerHTML = optionsFor("any", s.condition_sensor || "");
  $("#s-temp").innerHTML = optionsFor("temperature", s.temperature_sensor || "");
  $("#s-forecast").innerHTML = optionsFor("any", s.solar_forecast_sensor || "");
}

// Resumen de cada categoría en el índice de Ajustes.
function renderSettingsIndex(s) {
  const SOURCES = { demo: "Demostración", homeassistant: "Home Assistant", influxdb: "InfluxDB" };
  $("#nav-sub-source").textContent = SOURCES[s.source] || "Sin configurar";
  const n = (state.config?.tariffs || []).length;
  $("#nav-sub-tariffs").textContent = n === 1 ? "1 tarifa" : `${n} tarifas`;
  $("#nav-sub-contract").textContent =
    `${fmtNum.format(s.contracted_power?.p1 ?? 0)} / ${fmtNum.format(s.contracted_power?.p2 ?? 0)} kW · ciclo el día ${s.billing_day ?? 1}`;
  $("#nav-sub-publish").textContent = s.export_sensors === false
    ? "Desactivado"
    : `Cada ${s.sensor_update_minutes ?? 5} min`;
  $("#nav-sub-theme").textContent = THEMES[s.theme] || THEMES.auto;
  $("#about-version").textContent = state.config?.version
    ? `v${state.config.version}` : "—";
}

function fillSettings() {
  const s = state.config?.settings;
  if (!s) return;
  $("#s-source").value = s.source || "demo";
  $("#s-ha-url").value = s.ha_url || "";
  $("#s-ha-token").value = s.ha_token || "";
  $("#s-p1").value = s.contracted_power?.p1 ?? 4.6;
  $("#s-p2").value = s.contracted_power?.p2 ?? 4.6;
  $("#s-billing-day").value = s.billing_day ?? 1;
  $("#s-timezone").value = s.timezone || "Europe/Madrid";
  $("#s-holidays").value = (s.holidays || []).join(", ");
  $("#s-export-sensors").checked = s.export_sensors !== false;
  $("#s-sensor-minutes").value = s.sensor_update_minutes ?? 5;
  $("#s-energy-counters").value = s.energy_counters || "auto";
  applyTheme(s.theme);
  renderSettingsIndex(s);
  const ifx = s.influx || {};
  $("#s-ifx-version").value = String(ifx.version ?? 2);
  $("#s-ifx-url").value = ifx.url || "";
  $("#s-ifx-db").value = ifx.database || "";
  $("#s-ifx-measurement").value = ifx.measurement || "kWh";
  $("#s-ifx-entity").value = ifx.entity_id || "";
  $("#s-ifx-entity-export").value = ifx.entity_id_export || "";
  $("#s-ifx-org").value = ifx.org || "";
  $("#s-ifx-token").value = ifx.token || "";
  $("#s-ifx-user").value = ifx.username || "";
  $("#s-ifx-pass").value = ifx.password || "";
  $("#s-ha-entity").innerHTML = s.ha_entity
    ? `<option value="${esc(s.ha_entity)}">${esc(s.ha_entity)}</option>`
    : `<option value="">— pulsa «Buscar sensores» —</option>`;
  $("#s-ha-entity-export").innerHTML = `<option value="">— ninguno —</option>` +
    (s.ha_entity_export ? `<option value="${esc(s.ha_entity_export)}" selected>${esc(s.ha_entity_export)}</option>` : "");
  renderSensorLists();
  renderTariffsList();
  updateSourceVisibility();
  ensureGroupedEntities();
}

function updateSourceVisibility() {
  const source = $("#s-source").value;
  $("#ha-fields").classList.toggle("hidden", source !== "homeassistant");
  $("#influx-fields").classList.toggle("hidden", source !== "influxdb");
  $("#ha-external").classList.toggle("hidden", !!state.config?.supervisor);
  const v2 = $("#s-ifx-version").value === "2";
  $$(".ifx-v2").forEach((el) => el.classList.toggle("hidden", !v2));
  $$(".ifx-v1").forEach((el) => el.classList.toggle("hidden", v2));
}

// Carga silenciosa de entidades al abrir Ajustes: evita tener que pulsar
// «Buscar entidades» para ver los desplegables poblados.
async function ensureGroupedEntities() {
  if (state.grouped) return;
  try {
    state.grouped = await api("entities/grouped");
    renderSensorLists();
  } catch (_) { /* sin conexión con HA: se mantiene el valor guardado */ }
}

async function loadGroupedEntities() {
  const btn = $("#load-grouped-btn");
  btn.disabled = true; btn.textContent = "Buscando…";
  try {
    await saveSettings(true);
    state.grouped = await api("entities/grouped");
    renderSensorLists();
    $("#settings-status").textContent = "✓ Entidades cargadas";
  } catch (err) {
    $("#settings-status").textContent = `Error: ${err.message}`;
  } finally { btn.disabled = false; btn.textContent = "Buscar entidades"; }
}

async function loadEntities() {
  const btn = $("#load-entities-btn");
  btn.disabled = true; btn.textContent = "Buscando…";
  try {
    await saveSettings(true);
    const entities = await api("entities");
    const cur = state.config?.settings?.ha_entity || "";
    const curExp = state.config?.settings?.ha_entity_export || "";
    const opts = (sel) => entities.map((e) =>
      `<option value="${esc(e.entity_id)}" ${e.entity_id === sel ? "selected" : ""}>${esc(e.name)}</option>`).join("");
    $("#s-ha-entity").innerHTML = opts(cur) || `<option value="">Sin sensores de energía</option>`;
    $("#s-ha-entity-export").innerHTML = `<option value="">— ninguno —</option>` + opts(curExp);
  } catch (err) { alert(err.message); } finally {
    btn.disabled = false; btn.textContent = "Buscar sensores";
  }
}

function settingsFromForm() {
  const flow = {}; const energy = {};
  $$("[data-flow]").forEach((el) => { flow[el.dataset.flow] = el.value; });
  $$("[data-energy]").forEach((el) => { energy[el.dataset.energy] = el.value; });
  return {
    source: $("#s-source").value,
    ha_entity: $("#s-ha-entity").value,
    ha_entity_export: $("#s-ha-entity-export").value,
    ha_url: $("#s-ha-url").value.trim(),
    ha_token: $("#s-ha-token").value,
    contracted_power: { p1: parseFloat($("#s-p1").value) || 0, p2: parseFloat($("#s-p2").value) || 0 },
    billing_day: parseInt($("#s-billing-day").value, 10) || 1,
    timezone: $("#s-timezone").value.trim() || "Europe/Madrid",
    holidays: $("#s-holidays").value.split(",").map((x) => x.trim()).filter(Boolean),
    export_sensors: $("#s-export-sensors").checked,
    sensor_update_minutes: parseInt($("#s-sensor-minutes").value, 10) || 5,
    flow_sensors: flow,
    energy_sensors: energy,
    energy_counters: $("#s-energy-counters").value,
    condition_sensor: $("#s-condition").value,
    temperature_sensor: $("#s-temp").value,
    solar_forecast_sensor: $("#s-forecast").value,
    influx: {
      version: parseInt($("#s-ifx-version").value, 10) || 2,
      url: $("#s-ifx-url").value.trim(),
      database: $("#s-ifx-db").value.trim(),
      measurement: $("#s-ifx-measurement").value.trim() || "kWh",
      entity_id: $("#s-ifx-entity").value.trim(),
      entity_id_export: $("#s-ifx-entity-export").value.trim(),
      org: $("#s-ifx-org").value.trim(),
      token: $("#s-ifx-token").value,
      username: $("#s-ifx-user").value.trim(),
      password: $("#s-ifx-pass").value,
    },
  };
}

async function saveSettings(silent = false) {
  const status = $("#settings-status");
  try {
    const result = await api("settings", { method: "PUT", body: JSON.stringify(settingsFromForm()) });
    state.config.settings = { ...state.config.settings, ...result.settings };
    if (!silent) {
      status.textContent = "✓ Ajustes guardados";
      setTimeout(() => (status.textContent = ""), 3000);
      loadSimulation();
      loadLive();
    }
  } catch (err) {
    if (!silent) status.textContent = `Error: ${err.message}`; else throw err;
  }
}

/* ========================= periodo de trabajo ========================= */

function reloadPeriodViews() {
  loadSimulation();
  if (state.detail !== null) loadDetail();
}

async function applyCustomPeriod() {
  const s = $("#cp-start").value, e = $("#cp-end").value;
  const err = $("#cp-error");
  err.textContent = "";
  if (!s || !e) { err.textContent = "Indica inicio y fin."; return; }
  if (s >= e) { err.textContent = "El inicio debe ser anterior al fin."; return; }
  try {
    await api("settings", { method: "PUT", body: JSON.stringify({ working_period: { start: s, end: e } }) });
    await reloadConfig();
    reloadPeriodViews();
  } catch (e2) { err.textContent = e2.message; }
}

async function clearCustomPeriod() {
  try {
    await api("settings", { method: "PUT", body: JSON.stringify({ working_period: null }) });
    await reloadConfig();
    reloadPeriodViews();
  } catch (_) { /* noop */ }
}

function prefillCustom() {
  const wp = workingPeriod();
  if (wp) { $("#cp-start").value = wp.start; $("#cp-end").value = wp.end; return; }
  const sim = state.simulation;
  if (sim?.period) {
    $("#cp-start").value = sim.period.start.slice(0, 10);
    const [y, m, d] = sim.period.end.slice(0, 10).split("-").map(Number);
    $("#cp-end").value = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  }
}

/* ========================= eventos ========================= */

$("#prev-cycle").addEventListener("click", () => { state.cyclesBack += 1; loadSimulation(); });
$("#next-cycle").addEventListener("click", () => { if (state.cyclesBack > 0) { state.cyclesBack -= 1; loadSimulation(); } });
$("#refresh-btn").addEventListener("click", loadSimulation);
$("#projection-toggle").addEventListener("change", (e) => { state.projection = e.target.checked; renderBills(state.simulation); });
$("#goto-settings").addEventListener("click", (e) => { e.preventDefault(); showView("settings"); });
$("#cp-toggle").addEventListener("click", () => {
  const p = $("#custom-period");
  p.classList.toggle("hidden");
  if (!p.classList.contains("hidden")) prefillCustom();
});
$("#cp-apply").addEventListener("click", applyCustomPeriod);
$("#cp-clear").addEventListener("click", () => { $("#cp-error").textContent = ""; clearCustomPeriod(); });

$("#d-prev").addEventListener("click", () => { state.detailCyclesBack += 1; state.selectedDay = null; loadDetail(); });
$("#d-next").addEventListener("click", () => { if (state.detailCyclesBack > 0) { state.detailCyclesBack -= 1; state.selectedDay = null; loadDetail(); } });
$("#d-refresh").addEventListener("click", loadDetail);

$("#add-tariff-btn").addEventListener("click", () => openTariffModal(null));
$("#save-tariff-btn").addEventListener("click", saveTariff);
$("#cancel-tariff-btn").addEventListener("click", () => $("#tariff-modal").classList.add("hidden"));
$("#close-tariff-modal").addEventListener("click", () => $("#tariff-modal").classList.add("hidden"));
$("#close-bill-modal").addEventListener("click", () => $("#bill-modal").classList.add("hidden"));
$$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.classList.add("hidden"); }));
$("#t-etype").addEventListener("change", updateEditorVisibility);
$("#t-surplus-type").addEventListener("change", updateEditorVisibility);
$("#t-add-period").addEventListener("click", () => periodRow($("#t-periods")));
$("#t-add-surplus-period").addEventListener("click", () => periodRow($("#t-surplus-periods")));

$("#import-csv-btn").addEventListener("click", openImportModal);
$("#import-csv-btn-2").addEventListener("click", openImportModal);
$("#add-tariff-btn-2").addEventListener("click", () => openTariffModal(null));
$("#close-import-modal").addEventListener("click", () => $("#import-modal").classList.add("hidden"));
$("#cancel-import-btn").addEventListener("click", () => $("#import-modal").classList.add("hidden"));
$("#do-import-btn").addEventListener("click", doImport);
$("#import-clear").addEventListener("click", () => { $("#import-textarea").value = ""; $("#import-error").textContent = ""; });
$("#import-load-file").addEventListener("click", () => $("#import-csv-input").click());
$("#import-csv-input").addEventListener("change", async (e) => {
  if (e.target.files.length) {
    try { $("#import-textarea").value = await e.target.files[0].text(); }
    catch (err) { $("#import-error").textContent = err.message; }
  }
  e.target.value = "";
});

$("#s-source").addEventListener("change", updateSourceVisibility);
$("#s-ifx-version").addEventListener("change", updateSourceVisibility);
$("#load-entities-btn").addEventListener("click", loadEntities);
$("#load-grouped-btn").addEventListener("click", loadGroupedEntities);
$("#save-settings-btn").addEventListener("click", () => saveSettings(false));

async function reloadConfig() {
  state.config = await api("config");
  applyTheme(state.config?.settings?.theme);
}

/* ========================= tema ========================= */

const THEMES = { auto: "Automático", light: "Claro", dark: "Oscuro" };

// El tema vive en Ajustes (servidor) y se refleja en localStorage para que el
// script de la cabecera pueda aplicarlo antes del primer pintado. «auto» se
// resuelve aquí: en el CSS `data-theme` siempre vale «light» o «dark».
function applyTheme(pref) {
  const choice = THEMES[pref] ? pref : "auto";
  const dark = choice === "dark" || (choice !== "light" && prefersDark());
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  forgetTokens();          // los colores de las series cambian con el tema
  if (state.live) renderFlow(state.live);
  if (eState.data) renderEnergy();
  try { localStorage.setItem("vatia-theme", choice); } catch (e) { /* modo privado */ }
  $$("#theme-seg .seg").forEach((b) => b.classList.toggle("active", b.dataset.themeOpt === choice));
  const sub = $("#nav-sub-theme");
  if (sub) sub.textContent = THEMES[choice];
}

function prefersDark() {
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

$$("#theme-seg .seg").forEach((button) =>
  button.addEventListener("click", async () => {
    const pref = button.dataset.themeOpt;
    applyTheme(pref);                       // inmediato, sin esperar al servidor
    if (state.config?.settings) state.config.settings.theme = pref;
    try {
      await api("settings", { method: "PUT", body: JSON.stringify({ theme: pref }) });
    } catch (err) {
      $("#settings-status").textContent = `No se pudo guardar el tema: ${err.message}`;
    }
  }));

// Con «automático», seguir al sistema cuando cambia sin recargar la página.
if (window.matchMedia) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const follow = () => {
    if ((state.config?.settings?.theme || "auto") === "auto") applyTheme("auto");
  };
  if (query.addEventListener) query.addEventListener("change", follow);
  else if (query.addListener) query.addListener(follow);
}

/* ========================= arranque ========================= */

function hideBoot() {
  const boot = $("#boot");
  if (!boot || boot.classList.contains("done")) return;
  boot.classList.add("done");
  // Se retira del árbol al acabar la transición, para no capturar pulsaciones.
  setTimeout(() => boot.remove(), 600);
}

(async function init() {
  document.body.dataset.view = "home";
  try {
    $("#boot-text").textContent = "Cargando la configuración…";
    await reloadConfig();
  } catch (err) {
    $("#boot-text").textContent = `No se pudo cargar la configuración: ${err.message}`;
    $("#flow-empty").textContent = `No se pudo cargar la configuración: ${err.message}`;
    $("#flow-empty").classList.remove("hidden");
    setTimeout(hideBoot, 2500);
    return;
  }
  $("#boot-text").textContent = "Leyendo los sensores…";
  await loadLive();
  hideBoot();
  loadSimulation();
  // Refresco en vivo: la Home cada 20 s, el resto cada minuto.
  setInterval(() => { if (state.view === "home") loadLive(); }, 20000);
  setInterval(() => {
    if (state.view === "billing") {
      loadSimulation();
      if ($("#sub-detail").classList.contains("active")) loadDetail();
    }
  }, 60000);
})();

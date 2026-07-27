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
// Precios unitarios: cuatro decimales y sin símbolo, que la unidad va aparte.
const nf4 = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

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
    // El recuento de sensores del índice necesita el estado, y el índice tiene
    // que informar sin que haya que entrar en la sección.
    refreshSensorCount();
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
  const hideSave = !page ||
    ["tariffs", "about", "diagnostics", "backup", "sensors"].includes(page);
  $("#settings-save-bar").classList.toggle("hidden", hideSave);
  $("#settings-status").textContent = "";
  if (page === "tariffs") renderTariffsList();
  if (page === "diagnostics") loadDiagnostics();
  // Los sensores se asignan tocando su fila, no rellenando un formulario: la
  // barra de guardar no aplica y cada cambio se guarda solo.
  if (page === "sensors") loadSensors();
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
  if (has("hail", "granizo", "pedrisc")) return "hail";
  if (has("snow", "niev", "nieve")) return "snowy";
  if (has("fog", "niebla", "neblina", "mist", "bruma", "haze", "calima")) return "fog";
  if (has("partlycloudy", "partly", "parcial", "poco nub", "intervalos nub")) return "partlycloudy";
  if (has("cloud", "nub", "cubierto", "overcast")) return "cloudy";
  if (has("wind", "viento")) return "windy";
  return "clear";
}

/* Los ocho glifos del tiempo del sprite mapean uno a uno con las familias de
   `weather.condition`, como manda el diseño. Antes se dibujaban a mano aquí y
   dos familias se perdían por el camino: el viento se enseñaba como nubes
   parciales y el granizo como nieve. Ahora cada una tiene el suyo.

   La única excepción es la luna: el set no trae glifo nocturno, así que el
   despejado de noche conserva el trazo de siempre en vez de enseñar un sol a
   las tres de la mañana. */
const WEATHER_GLYPH = {
  clear: "solar", partlycloudy: "parcial", cloudy: "nubes", fog: "niebla",
  rainy: "lluvia", pouring: "lluvia", lightning: "tormenta",
  snowy: "nieve", hail: "granizo", windy: "viento",
};

function weatherIcon(condition, phase) {
  const family = weatherFamily(condition);
  if (family === "clear" && phase === "night") {
    return `<svg class="i" aria-hidden="true" viewBox="0 0 24 24"><path
      d="M15.6 3.6a8.4 8.4 0 1 0 4.8 12.2A9 9 0 0 1 15.6 3.6Z"/></svg>`;
  }
  return `<svg class="i" aria-hidden="true"><use href="#i-${
    WEATHER_GLYPH[family] || "solar"}"/></svg>`;
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
  battery: "--s-batt", battery_charge: "--s-batt", battery_discharge: "--s-batt-out",
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
  hover: null,    // punto bajo el dedo, sin fijar
  zoomed: false,  // el eje no está al completo
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
  // Manda el punto fijado; si no hay, el que esté bajo el dedo.
  const idx = eState.cursor != null ? eState.cursor : eState.hover;
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

/* --- Zoom del eje X ---
   Ya no estira el DOM: el componente mueve el rango del eje, así que aquí solo
   quedan los botones y el indicador. El factor se deduce del rango visible
   frente al total, que es la definición honesta de «cuánto estoy ampliando». */

function zoomFactor() {
  const p = $("#e-chart");
  const s = p && p._plot && p._plot.scales.x;
  const xs = p && p._plot && p._plot.data[0];
  if (!s || !xs || xs.length < 2) return 1;
  const total = xs[xs.length - 1] - xs[0];
  const visto = s.max - s.min;
  return visto > 0 ? Math.max(1, total / visto) : 1;
}

function syncZoomControls() {
  const z = zoomFactor();
  $("#e-zoom-val").textContent = `${z < 10 ? z.toFixed(1) : Math.round(z)}×`;
  $("#e-zoom-out").disabled = z <= 1.001;
  $("#e-zoom-in").disabled = z >= E_ZOOM_MAX - 0.001;
}

/* Acerca o aleja alrededor del centro de lo que se está viendo. */
function setZoom(mult) {
  const p = $("#e-chart");
  const plot = p && p._plot;
  if (!plot) return;
  const xs = plot.data[0];
  const total = xs[xs.length - 1] - xs[0];
  const s = plot.scales.x;
  const centro = (s.min + s.max) / 2;
  const medio = Math.min(total, (s.max - s.min) / mult) / 2;
  if (total / (medio * 2) > E_ZOOM_MAX) return;
  let min = centro - medio, max = centro + medio;
  // No se sale del periodo: se empuja hacia dentro en vez de dejar hueco.
  if (min < xs[0]) { max += xs[0] - min; min = xs[0]; }
  if (max > xs[xs.length - 1]) { min -= max - xs[xs.length - 1]; max = xs[xs.length - 1]; }
  plot.setScale("x", { min: Math.max(min, xs[0]), max: Math.min(max, xs[xs.length - 1]) });
  syncZoomControls();
}


/* El gráfico lo dibuja <vatia-chart> sobre uPlot. Aquí solo se le pasan los
   datos, los colores del tema y el formato del eje: el zoom, el cursor y el
   pellizco viven dentro, y ya no ensanchan el DOM para desplazarlo. */
function renderEnergyChart() {
  const box = $("#e-chart");
  box.colorFor = (key) => (key.startsWith("--") ? token(key) : seriesColor(key));
  box.formatX = (ms) => xLabel(new Date(ms).toISOString(), eState.range);
  box.hidden = eState.hidden;
  box.data = eState.data;
}

/* Los gestos y el cursor los publica el componente; aquí solo se recogen. */
function initChartGestures() {
  const box = $("#e-chart");
  // Fijar un punto rellena la leyenda con los valores de ese instante.
  box.addEventListener("pick", (ev) => {
    eState.cursor = ev.detail.index;
    renderEnergyLegend();
    const d = eState.data;
    const picked = eState.cursor != null && d && d.x[eState.cursor];
    $("#e-stamp").textContent = picked ? stampLabel(d.x[eState.cursor], eState.range) : (d ? d.label : "—");
    $("#e-clear").classList.toggle("hidden", !picked);
  });
  // Al mover el dedo por encima, la leyenda sigue al cursor sin fijarlo.
  box.addEventListener("hover", (ev) => {
    if (ev.detail.index == null && eState.cursor != null) return;
    eState.hover = ev.detail.index;
    renderEnergyLegend();
  });
  // El rango del eje decide si los controles de zoom están activos.
  box.addEventListener("range", (ev) => {
    eState.zoomed = !ev.detail.full;
    syncZoomControls();
  });
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
  const p = $("#e-chart");
  if (p && p.resetZoom) p.resetZoom();
}

// Volver a los totales del periodo tras seleccionar un punto.
$("#e-clear").addEventListener("click", () => { eState.cursor = null; renderEnergy(); });

// Zoom del eje del tiempo.
$("#e-zoom-in").addEventListener("click", () => setZoom(1.6));
$("#e-zoom-out").addEventListener("click", () => setZoom(1 / 1.6));
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

/* La tarjeta de tarifa del prototipo: barra de color, total grande y el resto
   plegado. Se despliega al tocar, de una en una, y ahí viven el desglose y las
   acciones — entre ellas, marcar la tarifa como «la mía», que es la que da el
   ahorro del día en el cierre. */
let openBillId = null;

function renderBills(sim) {
  const grid = $("#bills-grid");
  const projected = state.projection;
  const bills = [...sim.bills];
  if (projected) bills.sort((a, b) => a.projected_total - b.projected_total);
  if (!bills.length) { grid.innerHTML = `<p class="empty">No hay tarifas que simular.</p>`; return; }
  const cheapest = projected ? bills[0].projected_total : bills[0].total;
  const myId = state.config?.settings?.my_tariff_id || "";

  grid.innerHTML = bills.map((bill, i) => {
    const total = projected ? bill.projected_total : bill.total;
    const extra = total - cheapest;
    const open = bill.tariff_id === openBillId;
    const mine = bill.tariff_id === myId;
    const color = esc(bill.color || "#4d7cba");
    const s = bill.subtotals;
    const shown = projected ? bill.projected : bill;
    const co = [bill.company, bill.energy_type === "pvpc" ? "PVPC" : null,
      `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 })
        .format(shown?.days ?? bill.days ?? 0)} días`].filter(Boolean).join(" · ");
    const sub = i === 0
      ? `${fmtEUR.format(projected ? bill.total : bill.projected_total)} ${projected ? "acumulado" : "proyectado"}`
      : `+${fmtEUR.format(extra)} vs. la mejor`;

    const rows = [
      ["Término de energía", s.energy], ["Término de potencia", s.power],
      ["Cargos y servicios", s.charges + s.services],
      bill.surplus_credit > 0 ? ["Compensación de excedentes", -bill.surplus_credit] : null,
      ["Impuestos", s.taxes],
    ].filter(Boolean).map(([label, v]) =>
      `<div class="tf-row"><span>${label}</span><b class="${v < 0 ? "neg" : ""}">${
        v < 0 ? "−" : ""}${fmtEUR.format(Math.abs(v))}</b></div>`).join("");
    const wallet = shown && shown.wallet_credit > 0
      ? `<div class="tf-row"><span>🔋 Monedero de excedentes</span><b class="neg">+${fmtEUR.format(shown.wallet_credit)}</b></div>` : "";

    return `
    <div class="tf ${open ? "open" : ""}" data-tf="${esc(bill.tariff_id)}" style="--tfc:${color}">
      ${i === 0 ? `<span class="tf-float best">MÁS BARATA</span>` : ""}
      ${mine ? `<span class="tf-float mine">LA MÍA</span>` : ""}
      <div class="tf-head">
        <span class="tf-bar"></span>
        <div class="tf-id">
          <div class="tf-name">${esc(bill.name || "Tarifa")}</div>
          <div class="tf-co">${esc(co)}</div>
        </div>
        <div class="tf-tot">
          <div class="tf-eur">${fmtEUR.format(total)}</div>
          <div class="tf-sub ${i === 0 ? "" : "worse"}">${sub}</div>
        </div>
      </div>
      ${open ? `<div class="tf-more">
        ${rows}${wallet}
        ${bill.warning ? `<div class="tf-warn">⚠ ${esc(bill.warning)}</div>` : ""}
        <div class="tf-actions">
          <button class="tf-btn" data-bill="${esc(bill.tariff_id)}">Ver la factura</button>
          <button class="tf-btn ${mine ? "on" : ""}" data-mine="${esc(bill.tariff_id)}">${
            mine ? "✓ Es la mía" : "Marcarla como mía"}</button>
        </div>
      </div>` : ""}
    </div>`;
  }).join("");

  grid.querySelectorAll(".tf").forEach((card) =>
    card.addEventListener("click", () => {
      const id = card.dataset.tf;
      openBillId = openBillId === id ? null : id;
      renderBills(state.simulation);
    }));
  grid.querySelectorAll("[data-bill]").forEach((b) =>
    b.addEventListener("click", (ev) => { ev.stopPropagation(); openBillDetail(b.dataset.bill); }));
  grid.querySelectorAll("[data-mine]").forEach((b) =>
    b.addEventListener("click", (ev) => { ev.stopPropagation(); setMyTariff(b.dataset.mine); }));
}

/* Marca (o desmarca, tocando la que ya lo es) la tarifa contratada. La
   comparativa no cambia con esto: solo existe para poder decir cuánto te has
   ahorrado hoy en euros, en el cierre del día. */
async function setMyTariff(tariffId) {
  const current = state.config?.settings?.my_tariff_id || "";
  const next = current === tariffId ? "" : tariffId;
  await api("settings", { method: "PUT", body: JSON.stringify({ my_tariff_id: next }) });
  await reloadConfig();
  if (state.simulation) renderBills(state.simulation);
  renderTariffsList();
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
      `<tr><td>${esc(l.concept)}<div class="detail">${esc(l.detail)}</div></td><td class="${
        l.amount < 0 ? "credit" : ""}">${fmtEUR.format(l.amount)}</td></tr>`).join("");
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

function renderDailyChart(daily) {
  const c = $("#daily-chart");
  if (!daily || !daily.length) { c.innerHTML = `<p class="empty">Sin datos.</p>`; return; }
  const bars = ensureBars(c, 220);
  bars.data = {
    labels: daily.map((d) => d.date.slice(8)),
    stack: [
      { key: "valle", label: "Valle", values: daily.map((d) => d.valle) },
      { key: "llano", label: "Llano", values: daily.map((d) => d.llano) },
      { key: "punta", label: "Punta", values: daily.map((d) => d.punta) },
    ],
    side: [],
    unit: "kWh",
  };
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

  // La leyenda de vertido solo si hay vertido: prometer un color que no
  // aparece en ninguna barra hace dudar de si falta un dato o no hay ninguno.
  const hasExport = d.has_export || t.export > 0;
  $$(".leg-export").forEach((el) => el.classList.toggle("hidden", !hasExport));

  renderDailyDetail(d.days);
  renderMonthlyCumulative(d.days);
  if (state.selectedDay && d.days.some((x) => x.date === state.selectedDay)) renderHourly(state.selectedDay);
  else { state.selectedDay = null; $("#d-hourly-wrap").classList.add("hidden"); }
}

/* Los cuatro gráficos de Facturación, sobre uPlot igual que el de Energía. Los
   dos de barras usan <vatia-bars>, que apila; los dos acumulados, <vatia-chart>
   con el eje por índice, porque no van sobre el reloj sino sobre una lista de
   días o de horas. */
function chartColor(key) {
  return key.startsWith("--") ? token(key) : token(`--${key}`);
}

function renderDailyDetail(days) {
  const c = $("#d-daily");
  if (!days || !days.length) { c.innerHTML = `<p class="empty">Sin datos.</p>`; return; }
  const bars = ensureBars(c, 240);
  bars.data = {
    labels: days.map((d) => d.date.slice(8)),
    // El orden es el de apilado, de abajo arriba.
    stack: [
      { key: "valle", label: "Valle", values: days.map((d) => d.valle) },
      { key: "llano", label: "Llano", values: days.map((d) => d.llano) },
      { key: "punta", label: "Punta", values: days.map((d) => d.punta) },
    ],
    side: [{ key: "exp", label: "Exportada", values: days.map((d) => d.export) }],
    unit: "kWh",
    selected: days.findIndex((d) => d.date === state.selectedDay),
  };
  bars.onpick = (i) => selectDay(days[i].date);
}

/* Crea el componente una vez y lo reutiliza: rehacerlo en cada dibujado
   destruiría el lienzo y perdería el cursor. */
function ensureBars(host, alto) {
  let el = host.querySelector("vatia-bars");
  if (!el) {
    host.textContent = "";
    el = document.createElement("vatia-bars");
    el.height = alto;
    el.colorFor = chartColor;
    el.addEventListener("pick", (ev) => { if (el.onpick) el.onpick(ev.detail.index); });
    host.appendChild(el);
  }
  return el;
}

function ensureLines(host) {
  let el = host.querySelector("vatia-chart");
  if (!el) {
    host.textContent = "";
    el = document.createElement("vatia-chart");
    el.xMode = "index";
    el.colorFor = (key) => (key.startsWith("--") ? token(key) : seriesColor(key));
    host.appendChild(el);
  }
  return el;
}

/* Acumulado: dos líneas que solo crecen. Se le pasa al mismo componente que la
   pantalla de Energía, con el eje por índice. */
function cumulativeChart(container, points) {
  if (!points || !points.length) { container.innerHTML = `<p class="empty">Sin datos.</p>`; return; }
  const last = points[points.length - 1];
  const el = ensureLines(container);
  el.data = {
    x: points.map((p) => p.label),
    series: [
      { key: "grid_import", label: "Importada", values: points.map((p) => p.import) },
      ...(last.export > 0
        ? [{ key: "grid_export", label: "Exportada", values: points.map((p) => p.export) }]
        : []),
    ],
  };
}

function renderMonthlyCumulative(days) {
  let ci = 0, ce = 0;
  cumulativeChart($("#d-cum-month"), days.map((d) => {
    ci += d.import; ce += d.export;
    return { label: d.date.slice(8), import: ci, export: ce };
  }));
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

  // Cada hora cae en un tramo de la tarifa, así que en vez de apilar tres
  // series se apila una sola por tramo: la hora aporta a la suya y cero a las
  // demás. Así la barra sale del color de su periodo y el cursor sigue diciendo
  // a qué tramo pertenece.
  const TRAMOS = ["punta", "llano", "valle"];
  const bars = ensureBars($("#d-hourly"), 200);
  bars.data = {
    labels: hours.map((h) => String(h.hour)),
    stack: TRAMOS.map((t) => ({
      key: t, label: t[0].toUpperCase() + t.slice(1),
      values: hours.map((h) => (h.period === t ? h.kwh : 0)),
    })).concat([{
      key: "ink-3", label: "Sin periodo",
      values: hours.map((h) => (h.period ? 0 : h.kwh)),
    }]),
    side: [{ key: "exp", label: "Exportada", values: hours.map((h) => h.export) }],
    unit: "kWh",
  };

  let ci = 0, ce = 0;
  cumulativeChart($("#d-cum-day"), hours.map((h) => {
    ci += h.kwh; ce += h.export;
    return { label: String(h.hour), import: ci, export: ce };
  }));

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
        <div class="badges">${t.id === (state.config?.settings?.my_tariff_id || "")
          ? `<span class="badge mine">La mía</span>` : ""}<span class="badge">${esc(describeTariff(t))}</span></div>
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
  // El horario arranca del que ya tenga la tarifa; `null` significa «el del
   // preajuste», que es lo que quiere una tarifa nueva.
  editorState.schedules = (energy.periods || []).length
    ? energy.periods.map((x) => x.schedule || "") : null;
  editorState.dirty = false;
  updateEditorVisibility();
  openFirstIncompleteStep();
  $("#tariff-modal").classList.remove("hidden");
}

/* Se abre siempre el primer paso incompleto: en una tarifa nueva es el 1, y al
   editar una que ya funciona no se abre ninguno y la hoja se lee de un vistazo. */
function openFirstIncompleteStep() {
  const res = refreshStepSummaries();
  const orden = ["id", "energy", "surplus", "power", "taxes"];
  const primero = orden.find((k) => res[k] && !res[k].ok);
  orden.forEach((k) => {
    const step = $(`#step-${k}`);
    if (step) step.open = k === primero;
  });
}

/* Horarios del editor. Con el preajuste 2.0TD venían fijos en el código, así
   que la rejilla no habría podido cambiarlos: ahora se guardan aquí en cuanto
   se toca el horario, y `tariffFromForm` los usa si existen. */
const TD3_SCHEDULES = ["L-V 10-14,18-22", "L-V 8-10,14-18,22-24", ""];
const editorState = { schedules: null };

/* Los periodos tal y como están ahora en el formulario, que es lo que la rejilla
   necesita para pintarse. */
function editorPeriods() {
  const etype = $("#t-etype").value;
  if (etype === "pvpc") return [];
  if (etype === "td3") {
    const h = editorState.schedules || TD3_SCHEDULES;
    return ["Punta", "Llano", "Valle"].map((name, i) => ({ name, schedule: h[i] ?? "" }));
  }
  const filas = readPeriodRows($("#t-periods"));
  return filas.map((p, i) => ({
    ...p,
    schedule: editorState.schedules ? (editorState.schedules[i] ?? "") : p.schedule,
  }));
}

/* El resumen de cada paso cerrado. Es lo que convierte la hoja en una lista de
   comprobación: se ve qué falta sin abrir nada, y el paso incompleto lo dice en
   su propia línea en vez de esperar al error de guardar. */
function stepSummaries() {
  const val = (sel) => $(sel).value.trim();
  const num = (sel) => { const v = parseFloat($(sel).value); return Number.isFinite(v) ? v : null; };
  const eur = (v) => nf4.format(v) + " €/kWh";
  const etype = $("#t-etype").value;
  const out = {};

  // 1 · Identidad
  const nombre = val("#t-name");
  out.id = nombre
    ? { txt: [val("#t-company") || "sin compañía",
              $("#t-virtual-wallet").checked ? "monedero activo" : null]
             .filter(Boolean).join(" · "), ok: true }
    : { txt: "Falta el nombre", ok: false };

  // 2 · Energía
  if (etype === "pvpc") {
    const m = num("#t-pvpc-margin") || 0;
    out.energy = { txt: `PVPC${m ? ` · margen ${eur(m)}` : " sin margen"}`, ok: true };
  } else if (etype === "td3") {
    const faltan = ["Punta", "Llano", "Valle"]
      .filter((k) => !(num(`#t-td3-${k.toLowerCase()}`) > 0));
    out.energy = faltan.length
      ? { txt: `Falta el precio de ${faltan.join(", ")}`, ok: false }
      : { txt: `Punta ${eur(num("#t-td3-punta"))} · 3 tramos`, ok: true };
  } else {
    const filas = readPeriodRows($("#t-periods")).filter((r) => r.name);
    const sinPrecio = filas.filter((r) => !(r.price > 0));
    out.energy = !filas.length ? { txt: "Sin tramos", ok: false }
      : sinPrecio.length ? { txt: `Falta el precio de ${sinPrecio.map((r) => r.name).join(", ")}`, ok: false }
      : { txt: `${filas.length} tramo${filas.length === 1 ? "" : "s"}`, ok: true };
  }

  // 3 · Excedentes
  const stype = $("#t-surplus-type").value;
  out.surplus = stype === "none" ? { txt: "Sin compensación", ok: true }
    : stype === "flat"
      ? (num("#t-surplus-price") > 0
        ? { txt: `Compensación simplificada · ${eur(num("#t-surplus-price"))}`, ok: true }
        : { txt: "Falta el precio del excedente", ok: false })
      : { txt: "Por tramos", ok: true };

  // 4 · Potencia
  const p1 = num("#t-power-p1"), p2 = num("#t-power-p2");
  const faltaP = [p1 > 0 ? null : "P1", p2 > 0 ? null : "P2"].filter(Boolean);
  out.power = faltaP.length
    ? { txt: `Falta el precio de ${faltaP.join(" y ")}`, ok: false }
    : { txt: `P1 ${nf4.format(p1)} · P2 ${nf4.format(p2)} €/kW·día`, ok: true };

  // 5 · Impuestos y cargos
  const serv = num("#t-services");
  out.taxes = {
    txt: [`IE ${fmtNum.format(num("#t-elec-tax") ?? 0)} %`,
          `IVA ${fmtNum.format(num("#t-vat-energy") ?? 0)} %`,
          num("#t-meter") ? `contador ${fmtNum.format(num("#t-meter") * 30)} €/mes` : null,
          serv ? `servicios ${fmtNum.format(serv)} €/mes` : null]
      .filter(Boolean).join(" · "),
    ok: true,
  };
  return out;
}

function refreshStepSummaries() {
  const res = stepSummaries();
  for (const [key, r] of Object.entries(res)) {
    const el = $(`#sum-${key}`);
    const step = $(`#step-${key}`);
    if (el) el.textContent = r.txt;
    if (step) {
      step.classList.toggle("bad", !r.ok);
      step.classList.toggle("done", r.ok);
    }
  }
  // El resumen del horario, en el paso 2.
  const periodos = editorPeriods();
  const linea = periodos.filter((p) => (p.schedule || "").trim())
    .map((p) => `${p.name} ${p.schedule.replace(/\s*\|\s*/g, " y ")}`).join(" · ");
  const resto = periodos.find((p) => !(p.schedule || "").trim());
  $("#t-grid-sum").textContent = periodos.length
    ? (linea || "Un solo tramo, todas las horas") +
      (resto && linea ? ` · resto ${resto.name}` : "")
    : "Los precios los marca el mercado hora a hora.";
  return res;
}

function openGridSheet() {
  const periods = editorPeriods();
  if (!periods.length) return;
  $("#grid-editor").periods = periods;
  $("#grid-modal").classList.remove("hidden");
}

/* «Hecho» se queda con los horarios que haya pintado la rejilla. */
function closeGridSheet(guardar) {
  if (guardar) {
    editorState.schedules = $("#grid-editor").periods.map((p) => p.schedule);
    refreshStepSummaries();
  }
  $("#grid-modal").classList.add("hidden");
}

function tariffFromForm() {
  const num = (sel, def = 0) => { const v = parseFloat($(sel).value); return Number.isFinite(v) ? v : def; };
  const etype = $("#t-etype").value;
  let energy;
  if (etype === "pvpc") energy = { type: "pvpc", preset: null, periods: [], pvpc_margin: num("#t-pvpc-margin") };
  else if (etype === "td3") energy = {
    type: "schedule", preset: "td3", pvpc_margin: 0,
    periods: ["punta", "llano", "valle"].map((k, i) => ({
      name: k[0].toUpperCase() + k.slice(1),
      price: num(`#t-td3-${k}`),
      schedule: (editorState.schedules || TD3_SCHEDULES)[i] ?? "",
    })),
  };
  else energy = { type: "schedule", preset: null, pvpc_margin: 0,
    periods: readPeriodRows($("#t-periods")).map((p, i) => ({
      ...p,
      schedule: editorState.schedules ? (editorState.schedules[i] ?? p.schedule) : p.schedule,
    })) };
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

/* ---------------- Sensores, por función ----------------

   El diseño cambia catorce desplegables ciegos por catorce filas que dicen qué
   entidad tienen, cuánto marca ahora y si responde. Una casilla vacía tiñe su
   fila y ofrece los candidatos con el nombre a favor, así que asignar un sensor
   son tres toques y no buscar entre trescientas entradas.

   Los datos vienen de /api/sensors, que ya trae valor en vivo y sugerencias. */
/* El recuento del índice, en segundo plano: si falla no se dice nada, que el
   índice siga enseñando su descripción es mejor que un error por algo que solo
   es un contador. */
async function refreshSensorCount() {
  try {
    sensorState.data = await api("sensors");
    if (state.config) renderSettingsIndex(state.config.settings);
  } catch (_) { /* sin conexión con HA */ }
}

async function loadSensors() {
  const box = $("#sensors-groups");
  if (!sensorState.data) box.innerHTML = `<div class="panel glass"><p class="empty">Leyendo los sensores…</p></div>`;
  try {
    sensorState.data = await api("sensors");
  } catch (err) {
    box.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    return;
  }
  renderSensors();
}

const sensorState = { data: null, picking: null };

function renderSensors() {
  const d = sensorState.data;
  if (!d) return;
  $("#sensors-count").textContent = `${d.assigned} de ${d.total}`;

  $("#sensors-groups").innerHTML = d.groups.map((g) => `
    <div class="panel glass sgroup">
      <div class="sgroup-head"><svg class="i"><use href="#i-${esc(g.icon)}"/></svg>
        <b>${esc(g.name)}</b></div>
      ${g.rows.map((r) => sensorRow(r)).join("")}
    </div>`).join("");

  $$("#sensors-groups .srow").forEach((el) =>
    el.addEventListener("click", () => openSensorPicker(el.dataset.slot)));
  $$("#sensors-groups .srow-assign").forEach((el) =>
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openSensorPicker(el.closest(".srow").dataset.slot);
    }));
}

function sensorRow(r) {
  const clases = ["srow"];
  if (!r.entity) clases.push("empty");
  else if (!r.responds) clases.push("down");
  if (r.optional) clases.push("optional");

  // Segunda línea: la entidad y su lectura, que es lo que permite comprobar de
  // un vistazo que la casilla tiene el sensor correcto y no otro parecido.
  let sub;
  if (!r.entity) {
    const n = r.suggestions.length;
    sub = r.optional ? "Opcional · se deduce del balance"
      : `Sin asignar${n ? ` · ${n} sugerencia${n === 1 ? "" : "s"}` : ""}`;
  } else {
    const corto = r.entity.replace(/^sensor\./, "").split(",")[0];
    sub = r.responds ? `${corto} · ${fmtNum.format(r.value ?? 0)} ${r.unit}`
                     : `${corto} · no disponible`;
  }
  return `
    <div class="${clases.join(" ")}" data-slot="${esc(r.slot)}" role="button" tabindex="0">
      <span class="srow-dot"></span>
      <span class="srow-txt"><b>${esc(r.label)}</b><small>${esc(sub)}</small></span>
      ${r.entity ? `<svg class="i nav-chev"><use href="#i-chevron"/></svg>`
                 : `<button type="button" class="srow-assign">Asignar</button>`}
    </div>`;
}

/* Hoja de asignación: primero los candidatos y detrás la lista entera, por si
   el nombre del sensor no se parece a nada. */
async function openSensorPicker(slot) {
  const d = sensorState.data;
  const fila = d.groups.flatMap((g) => g.rows).find((r) => r.slot === slot);
  if (!fila) return;
  sensorState.picking = fila;

  $("#pick-title").textContent = fila.label;
  const sugerencias = fila.suggestions.length
    ? `<div class="pick-sugg">${fila.suggestions.map((e) => `
        <button type="button" data-pick="${esc(e.entity_id)}">
          <b>${esc(e.name)}</b><code>${esc(e.entity_id)}</code>
          ${e.unit ? `<small>${esc(e.unit)}</small>` : ""}
        </button>`).join("")}</div>`
    : "";
  if (!state.grouped) await loadGrouped();
  $("#pick-body").innerHTML = `
    ${sugerencias}
    <label class="li"><span class="li-label">Todas las entidades</span>
      <select id="pick-select">${optionsFor(fila.kind, fila.entity)}</select></label>
    <p class="li-note">Se puede poner el <b>mismo sensor en las dos casillas</b>
      de un par si es bidireccional: se separa por el signo.</p>`;

  $$("#pick-body [data-pick]").forEach((b) =>
    b.addEventListener("click", () => assignSensor(slot, b.dataset.pick)));
  $("#pick-select").addEventListener("change", (ev) => assignSensor(slot, ev.target.value));
  $("#pick-modal").classList.remove("hidden");
}

async function assignSensor(slot, entity) {
  const fila = sensorState.picking;
  if (!fila) return;
  const grupo = fila.group === "flow" ? "flow_sensors" : "energy_sensors";
  await api("settings", { method: "PUT",
    body: JSON.stringify({ [grupo]: { [slot]: entity } }) });
  $("#pick-modal").classList.add("hidden");
  await reloadConfig();
  await loadSensors();
}

// Resumen de cada categoría en el índice de Ajustes.
function renderSettingsIndex(s) {
  const SOURCES = { demo: "Demostración", homeassistant: "Home Assistant", influxdb: "InfluxDB" };
  $("#nav-sub-source").textContent = SOURCES[s.source] || "Sin configurar";
  const n = (state.config?.tariffs || []).length;
  // Se nombra la tarifa contratada: es la que decide el ahorro del cierre, y
  // conviene poder comprobar de un vistazo que está bien elegida.
  const mine = (state.config?.tariffs || []).find((t) => t.id === s.my_tariff_id);
  $("#nav-sub-tariffs").textContent = (n === 1 ? "1 tarifa" : `${n} tarifas`) +
    (mine ? ` · la tuya es ${mine.name}` : "");
  $("#nav-sub-contract").textContent =
    `${fmtNum.format(s.contracted_power?.p1 ?? 0)} / ${fmtNum.format(s.contracted_power?.p2 ?? 0)} kW · ciclo el día ${s.billing_day ?? 1}`;
  $("#nav-sub-publish").textContent = s.export_sensors === false
    ? "Desactivado"
    : `Cada ${s.sensor_update_minutes ?? 5} min`;
  $("#nav-sub-about").textContent = state.config?.version
    ? `Versión ${state.config.version}` : "Versión del add-on";
  // «13 de 13 asignados»: el índice tiene que decir si está bien sin entrar.
  const sd = sensorState.data;
  $("#nav-sub-sensors").textContent = sd
    ? `${sd.assigned} de ${sd.total} asignados` +
      (sd.down.length ? ` · ${sd.down.length} sin responder` : "")
    : "Potencia y energía del día";
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
  applyBackground(s.dynamic_background !== false);
  // El material traslúcido no es un ajuste nuestro: la guía dice que sigue al
  // del sistema, así que aquí solo se informa de cómo está.
  const reduce = window.matchMedia &&
    window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
  $("#material-state").textContent = reduce ? "Reducido" : "Activo";
  fillEntitySelects();
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
    fillEntitySelects();
  } catch (_) { /* sin conexión con HA: se mantiene el valor guardado */ }
}

/* Los selectores que siguen siendo un desplegable: previsión solar y los dos de
   meteorología. Son de uno en uno y opcionales, así que no piden la pantalla de
   filas con valor en vivo que sí necesitan los catorce del balance. */
function fillEntitySelects() {
  const s = state.config?.settings;
  if (!s) return;
  $("#s-condition").innerHTML = optionsFor("any", s.condition_sensor || "");
  $("#s-temp").innerHTML = optionsFor("temperature", s.temperature_sensor || "");
  $("#s-forecast").innerHTML = optionsFor("any", s.solar_forecast_sensor || "");
}

async function loadGrouped() {
  try {
    state.grouped = await api("entities/grouped");
  } catch (_) { /* sin conexión: la hoja enseña solo lo guardado */ }
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
// Un solo paso abierto: al abrir uno se cierran los demás (§05).
$$("#tariff-modal .step").forEach((step) =>
  step.addEventListener("toggle", () => {
    if (!step.open) return;
    $$("#tariff-modal .step").forEach((otro) => { if (otro !== step) otro.open = false; });
  }));
// Los resúmenes se refrescan mientras se escribe, no al guardar.
$("#tariff-modal").addEventListener("input", () => {
  editorState.dirty = true;
  refreshStepSummaries();
});
$("#tariff-modal").addEventListener("change", () => {
  editorState.dirty = true;
  refreshStepSummaries();
});
$("#t-open-grid").addEventListener("click", openGridSheet);
$("#grid-back").addEventListener("click", () => closeGridSheet(false));
$("#grid-done").addEventListener("click", () => closeGridSheet(true));
$("#grid-editor").addEventListener("change", () => { editorState.dirty = true; });

$("#cancel-tariff-btn").addEventListener("click", () => {
  // Cancelar pregunta solo si hay algo que perder.
  if (editorState.dirty &&
      !confirm("Se descartarán los cambios de esta tarifa. ¿Salir?")) return;
  $("#tariff-modal").classList.add("hidden");
});
$("#s-dynamic-bg").addEventListener("change", (ev) => setBackground(ev.target.checked));
$("#close-pick-modal").addEventListener("click", () => $("#pick-modal").classList.add("hidden"));
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
$("#save-settings-btn").addEventListener("click", () => saveSettings(false));

async function reloadConfig() {
  state.config = await api("config");
  applyTheme(state.config?.settings?.theme);
  // El fondo, junto al tema y no al abrir Ajustes: si está apagado tiene que
  // estarlo desde la primera pintada, no a partir de que se visite la sección.
  applyBackground(state.config?.settings?.dynamic_background !== false);
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
  // Todo lo pintado a mano con colores de token hay que volverlo a pintar: el
  // SVG lleva los colores en atributos, y esos no los alcanza `var()`.
  if (state.live) renderFlow(state.live);
  if (eState.data) renderEnergy();
  if (state.simulation) renderSimulation();
  if (state.detail) renderDetail();
  // Los gráficos de Facturación son lienzos: hay que rehacerlos con los
  // colores nuevos, igual que el de Energía.
  $$("vatia-bars, vatia-chart").forEach((el) => el.repaint && el.repaint());
  try { localStorage.setItem("vatia-theme", choice); } catch (e) { /* modo privado */ }
  $$("#theme-seg .seg").forEach((b) => b.classList.toggle("active", b.dataset.themeOpt === choice));
}

/* El fondo dinámico se apaga poniendo `data-bg="flat"` en <body>: el CSS se
   encarga, así que no hay que desmontar nada ni tocar el DOM del cielo. */
function applyBackground(on) {
  document.body.dataset.bg = on ? "sky" : "flat";
  const sw = $("#s-dynamic-bg");
  if (sw) sw.checked = !!on;
}

async function setBackground(on) {
  applyBackground(on);
  await api("settings", { method: "PUT",
    body: JSON.stringify({ dynamic_background: !!on }) });
  if (state.config) state.config.settings.dynamic_background = !!on;
}

/* El borde de la cabecera solo existe cuando hay contenido por encima. Se
   marca en <body> y el CSS hace el resto. */
function watchScroll() {
  const marcar = () => document.body.classList.toggle("scrolled", window.scrollY > 8);
  addEventListener("scroll", marcar, { passive: true });
  marcar();
}
watchScroll();

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

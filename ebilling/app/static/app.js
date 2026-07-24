/* eBilling — app web (rutas relativas para funcionar tras el Ingress de HA) */
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

async function api(path, options = {}) {
  const resp = await fetch(`api/${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  if (!resp.ok) {
    let detail = `Error ${resp.status}`;
    try { detail = (await resp.json()).detail || detail; } catch (_) { /* noop */ }
    throw new Error(detail);
  }
  return resp.json();
}

function esc(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/* ========================= navegación ========================= */

$$(".tab").forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));
$$(".seg").forEach((seg) => seg.addEventListener("click", () => showSub(seg.dataset.sub)));

function showView(name) {
  state.view = name;
  document.body.dataset.view = name;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "home") loadLive();
  if (name === "billing" && !state.simulation) loadSimulation();
  if (name === "settings") fillSettings();
}

function showSub(name) {
  $$(".seg").forEach((s) => s.classList.toggle("active", s.dataset.sub === name));
  $$(".subview").forEach((v) => v.classList.toggle("active", v.id === `sub-${name}`));
  if (name === "detail" && !state.detail) loadDetail();
  if (name === "tariffs") renderTariffsList();
}

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
  if (hasEnergy) renderSummary(gen, home);
}

/* ------------- tabla «Resumen de energía» ------------- */

const SUM_COLORS = {
  to_load: "#c9c443", to_battery: "#61b87f", to_grid: "#7d92f0",
  from_solar: "#eea154", from_battery: "#61b87f", from_grid: "#7d92f0",
};

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

function renderSummary(gen, home) {
  $("#summary").innerHTML =
    summaryColumn("Generación", gen) + summaryColumn("Consumo de la casa", home);
}

/* ------------- diagrama de flujo ------------- */

const FLOW_COLORS = { solar: "#f5a524", grid: "#6b8afd", battery: "#10b981" };
const NR = 46, FCX = 200, FCY = 212, LANE = 18, CORN = 16;
const EXT = Math.sqrt(NR * NR - LANE * LANE);
const LT = FCY - LANE, LB = FCY + LANE, LL = FCX - LANE, LR = FCX + LANE;
const FN = {
  solar: { x: FCX, y: 76, label: "Solar", above: true },
  grid: { x: 76, y: FCY, label: "Red" },
  home: { x: 324, y: FCY, label: "Casa" },
  battery: { x: FCX, y: 348, label: "Batería" },
};
const FLOW_PATHS = [
  ["solar_battery", "solar", `M${FCX},${FN.solar.y + NR} V${FN.battery.y - NR}`, [FCX, 162]],
  ["grid_home", "grid", `M${FN.grid.x + NR},${FCY} H${FN.home.x - NR}`, [252, 206]],
  ["solar_grid", "solar", `M${LL},${FN.solar.y + EXT} V${LT - CORN} Q${LL},${LT} ${LL - CORN},${LT} H${FN.grid.x + EXT}`, [142, LT - 8]],
  ["solar_home", "solar", `M${LR},${FN.solar.y + EXT} V${LT - CORN} Q${LR},${LT} ${LR + CORN},${LT} H${FN.home.x - EXT}`, [258, LT - 8]],
  ["grid_battery", "grid", `M${FN.grid.x + EXT},${LB} H${LL - CORN} Q${LL},${LB} ${LL},${LB + CORN} V${FN.battery.y - EXT}`, [142, LB + 15]],
  ["battery_home", "battery", `M${LR},${FN.battery.y - EXT} V${LB + CORN} Q${LR},${LB} ${LR + CORN},${LB} H${FN.home.x - EXT}`, [258, LB + 15]],
];

function pW(w) {
  const a = Math.abs(w);
  return a >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`;
}
function polar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}
function fIcon(cx, cy, type, color, s = 1) {
  const open = `<g transform="translate(${(cx - 12 * s).toFixed(2)},${(cy - 12 * s).toFixed(2)}) scale(${s})" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">`;
  if (type === "solar") {
    return open + `<path d="M4.5,16.5 L8.2,7.5 H20 L17,16.5 Z"/><path d="M12.2,7.5 L9.6,16.5 M16.1,7.5 L13.3,16.5"/><path d="M6.6,12 H18.6"/><path d="M11,16.5 V19.5 M8.5,19.5 H13.5"/></g>`;
  }
  if (type === "grid") {
    return open + `<path d="M9.2,4.5 H14.8"/><path d="M12,4.5 L6.6,19.5 M12,4.5 L17.4,19.5"/><path d="M9.9,10.4 H14.1 M8.8,13.8 H15.2 M7.7,17 H16.3"/></g>`;
  }
  if (type === "battery") {
    return open + `<path d="M10.2,3.6 H13.8"/><rect x="7.8" y="5.4" width="8.4" height="14.6" rx="1.8"/><rect class="bat-fill" x="9.3" y="18.5" width="5.4" height="0" rx="0.9" fill="${color}" stroke="none"/></g>`;
  }
  return `<g transform="translate(${(cx - 12 * s).toFixed(2)},${(cy - 12 * s).toFixed(2)}) scale(${s})"><path d="M12,4.2 L21,12.4 h-2.6 V20 H5.6 V12.4 H3 Z" fill="${color}"/></g>`;
}

function renderFlow(live) {
  const f = live.flows, p = live.power, e = live.energy;
  const inkColor = "currentColor";
  let lines = "", balls = "", labels = "";
  for (const [id, from, d, pos] of FLOW_PATHS) {
    const color = FLOW_COLORS[from];
    const w = f[id] || 0, on = w > 5;
    const dur = on ? Math.max(0.6, Math.min(3.4, Math.round((3000 / w) * 5) / 5)) : 2;
    lines += `<path class="pf-base" d="${d}"/>`;
    lines += `<path class="pf-live" d="${d}" stroke="${color}" style="opacity:${on ? 0.5 : 0}"/>`;
    if (on) {
      balls += `<g><circle r="5" fill="${color}" style="filter:drop-shadow(0 0 3px ${color})"/>
        <animateMotion dur="${dur}s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1" keyTimes="0;1" path="${d}"/></g>`;
      labels += `<text class="pf-flowval" x="${pos[0]}" y="${pos[1]}" text-anchor="middle">${pW(w)}</text>`;
    }
  }

  // Anillo de la casa: reparto del consumo del día por fuente.
  const rows = e.home.rows.filter((r) => r.kwh > 0);
  const totalRing = rows.reduce((s, r) => s + r.kwh, 0);
  let ring = `<circle cx="${FN.home.x}" cy="${FN.home.y}" r="${NR}" fill="none" stroke="${inkColor}" stroke-opacity="0.14" stroke-width="5"/>`;
  if (totalRing > 0) {
    const RING_COLOR = { from_solar: FLOW_COLORS.solar, from_grid: FLOW_COLORS.grid, from_battery: FLOW_COLORS.battery };
    let ang = 0;
    const gap = rows.length > 1 ? 5 : 0;
    for (const r of rows) {
      const span = (r.kwh / totalRing) * 360;
      const a0 = ang + gap / 2, a1 = ang + span - gap / 2;
      if (a1 > a0) {
        const [x0, y0] = polar(FN.home.x, FN.home.y, NR, a0);
        const [x1, y1] = polar(FN.home.x, FN.home.y, NR, a1);
        ring += `<path d="M${x0.toFixed(2)},${y0.toFixed(2)} A${NR},${NR} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}" fill="none" stroke="${RING_COLOR[r.key]}" stroke-width="5" stroke-linecap="round"><title>${esc(r.label)}: ${fmtNum.format(r.kwh)} kWh (${r.pct}%)</title></path>`;
      }
      ang += span;
    }
  }

  const kwhOf = (block, key) => {
    const row = block.rows.find((r) => r.key === key);
    return row ? `${fmtNum.format(row.kwh)} kWh` : "0 kWh";
  };
  const soc = p.battery_soc;
  const fill = soc != null ? (12.6 * Math.max(0, Math.min(100, soc))) / 100 : 0;

  const svg = `
    <svg viewBox="0 0 400 420" role="img" aria-label="Flujo de energía en vivo">
      ${lines}${balls}
      <g>
        <circle cx="${FN.solar.x}" cy="${FN.solar.y}" r="${NR}" fill="none" stroke="${FLOW_COLORS.solar}" stroke-width="2.5"/>
        ${fIcon(FN.solar.x, FN.solar.y - 14, "solar", FLOW_COLORS.solar, 1.05)}
        <text class="pf-val" x="${FN.solar.x}" y="${FN.solar.y + 9}" text-anchor="middle">${pW(p.pv || 0)}</text>
        <text class="pf-io" style="fill:var(--ink-3)" x="${FN.solar.x}" y="${FN.solar.y + 24}" text-anchor="middle">${fmtNum.format(e.generation.total)} kWh</text>
      </g>
      <g>
        <circle cx="${FN.grid.x}" cy="${FN.grid.y}" r="${NR}" fill="none" stroke="${FLOW_COLORS.grid}" stroke-width="2.5"/>
        ${fIcon(FN.grid.x, FN.grid.y - 20, "grid", FLOW_COLORS.grid, 0.95)}
        <text class="pf-io" style="fill:var(--ink-3)" x="${FN.grid.x}" y="${FN.grid.y + 3}" text-anchor="middle">← ${kwhOf(e.generation, "to_grid")}</text>
        <text class="pf-io" style="fill:${FLOW_COLORS.grid}" x="${FN.grid.x}" y="${FN.grid.y + 20}" text-anchor="middle">→ ${kwhOf(e.home, "from_grid")}</text>
      </g>
      <g>
        <circle cx="${FN.battery.x}" cy="${FN.battery.y}" r="${NR}" fill="none" stroke="${FLOW_COLORS.battery}" stroke-width="2.5"/>
        ${fIcon(FN.battery.x, FN.battery.y - 20, "battery", FLOW_COLORS.battery, 0.95)}
        <text class="pf-io" style="fill:${FLOW_COLORS.battery}" x="${FN.battery.x}" y="${FN.battery.y + 3}" text-anchor="middle">↓ ${kwhOf(e.home, "from_battery")}</text>
        <text class="pf-io" style="fill:var(--ink-3)" x="${FN.battery.x}" y="${FN.battery.y + 20}" text-anchor="middle">↑ ${kwhOf(e.generation, "to_battery")}</text>
      </g>
      <g>
        ${ring}
        ${fIcon(FN.home.x, FN.home.y - 16, "home", inkColor, 0.95)}
        <text class="pf-val" x="${FN.home.x}" y="${FN.home.y + 8}" text-anchor="middle">${fmtNum.format(e.home.total)} kWh</text>
        <text class="pf-io" style="fill:var(--ink-3)" x="${FN.home.x}" y="${FN.home.y + 24}" text-anchor="middle">${pW(p.home || 0)}</text>
      </g>
      <text class="pf-lbl" x="${FN.solar.x}" y="${FN.solar.y - NR - 11}" text-anchor="middle">Solar</text>
      <text class="pf-lbl" x="${FN.grid.x}" y="${FN.grid.y + NR + 20}" text-anchor="middle">Red</text>
      <text class="pf-lbl" x="${FN.home.x}" y="${FN.home.y + NR + 20}" text-anchor="middle">Casa</text>
      <text class="pf-lbl" x="${FN.battery.x}" y="${FN.battery.y + NR + 20}" text-anchor="middle">${soc != null ? `Batería · ${Math.round(soc)}%` : "Batería"}</text>
      ${labels}
    </svg>`;
  $("#flow").innerHTML = svg;
  const bf = $("#flow .bat-fill");
  if (bf) { bf.setAttribute("height", fill.toFixed(2)); bf.setAttribute("y", (18.5 - fill).toFixed(2)); }
}

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
    svg += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.55">${val.toFixed(1)}</text>`;
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
      svg += `<text x="${x + bw / 2}" y="${height - 8}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">${d.date.slice(8)}</text>`;
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
      svg += `<text x="${x + gw / 2}" y="${height - 8}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">${d.date.slice(8)}</text>`;
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
      svg += `<text x="${X(i)}" y="${height - 8}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">${p.label}</text>`;
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
    if (i % 2 === 0) svg += `<text x="${x + group / 2}" y="${height - 8}" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.55">${h.hour}</text>`;
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
  ["pv_energy", "Solar hoy", "energy"],
  ["grid_import_energy", "Importada hoy", "energy"],
  ["grid_export_energy", "Exportada hoy", "energy"],
  ["battery_charge_energy", "Carga hoy", "energy"],
  ["battery_discharge_energy", "Descarga hoy", "energy"],
];

function optionsFor(kind, selected) {
  const list = (state.grouped && state.grouped[kind]) || [];
  let html = `<option value="">— sin asignar —</option>`;
  if (!list.length && selected) html += `<option value="${esc(selected)}" selected>${esc(selected)}</option>`;
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
    condition_sensor: $("#s-condition").value,
    temperature_sensor: $("#s-temp").value,
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

async function reloadConfig() { state.config = await api("config"); }

/* ========================= arranque ========================= */

(async function init() {
  document.body.dataset.view = "home";
  try {
    await reloadConfig();
  } catch (err) {
    $("#flow-empty").textContent = `No se pudo cargar la configuración: ${err.message}`;
    $("#flow-empty").classList.remove("hidden");
    return;
  }
  await loadLive();
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

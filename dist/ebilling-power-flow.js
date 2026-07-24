/*
 * eBilling Power Flow — tarjeta Lovelace de flujo de energía fotovoltaica
 * Diagrama animado en tiempo real: solar (arriba), casa (centro), batería
 * (abajo izq.) y red (abajo der.). Una bola por línea, colores configurables
 * y anillo en la casa con el reparto de energía consumida hoy por fuente.
 *
 * Instalación:
 *   - HACS: recurso /hacsfiles/HA-ebilling-addon/ebilling-power-flow.js
 *   - Manual: copia a /config/www/ y añade /local/ebilling-power-flow.js
 *
 * Uso (o con el editor visual de la tarjeta):
 *   type: custom:ebilling-power-flow
 *   title: Flujo de energía
 *   entities:
 *     pv: sensor.produccion_solar
 *     grid_import: sensor.importacion_red
 *     grid_export: sensor.exportacion_red
 *     battery_charge: sensor.carga_bateria
 *     battery_discharge: sensor.descarga_bateria
 *     home: sensor.consumo_casa          # opcional (si falta, se calcula)
 *     battery_soc: sensor.bateria_soc    # opcional (% de batería)
 *   colors:
 *     solar: '#f6a609'
 *     grid: '#e5484d'
 *     battery: '#12b886'
 *     home: '#4a6cf7'
 */

const PF_DEFAULT_COLORS = { solar: "#f6a609", grid: "#e5484d", battery: "#12b886", home: "#4a6cf7" };

// Geometría (viewBox 360x372). r = radio visual del nodo para enganchar líneas.
const PF_NODES = {
  solar: { x: 180, y: 60, r: 32, label: "Solar" },
  home: { x: 180, y: 184, r: 48, label: "Casa" }, // 48 incluye el anillo
  battery: { x: 72, y: 306, r: 32, label: "Batería" },
  grid: { x: 288, y: 306, r: 32, label: "Red" },
};
const PF_HOME_DISC = 36; // disco interior opaco
const PF_HOME_RING = 42; // radio del anillo (donut de energía diaria)

// flujo: id, origen, destino, punto de control de la curva
const PF_FLOWS = [
  ["solar_home", "solar", "home", [180, 122]],
  ["solar_grid", "solar", "grid", [318, 132]],
  ["solar_battery", "solar", "battery", [42, 132]],
  ["grid_home", "grid", "home", [262, 250]],
  ["battery_home", "battery", "home", [98, 250]],
  ["grid_battery", "grid", "battery", [180, 348]],
];

const POWER_SLOTS = [
  ["pv", "Producción solar (PV)"],
  ["grid_import", "Importación de red"],
  ["grid_export", "Exportación a red"],
  ["battery_charge", "Carga de batería"],
  ["battery_discharge", "Descarga de batería"],
  ["home", "Consumo de la casa (opcional)"],
];
// El SOC va aparte: es un sensor de porcentaje (%), no de potencia.
const SOC_SLOTS = [["battery_soc", "Estado de carga batería % (opcional)"]];

// Sensores de energía diaria (kWh) para pintar el anillo de la casa con datos
// reales en vez del cálculo aproximado en el navegador.
const ENERGY_SLOTS = [
  ["pv_energy", "Producción solar hoy"],
  ["grid_import_energy", "Importada de red hoy"],
  ["grid_export_energy", "Exportada a red hoy"],
  ["battery_charge_energy", "Carga de batería hoy"],
  ["battery_discharge_energy", "Descarga de batería hoy"],
];

function pfFmt(w) {
  const a = Math.abs(w);
  if (a >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
}

function pfPolar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function pfEdge(node, ctrl) {
  const dx = ctrl[0] - node.x, dy = ctrl[1] - node.y;
  const len = Math.hypot(dx, dy) || 1;
  return [node.x + (dx / len) * node.r, node.y + (dy / len) * node.r];
}

function pfIcon(cx, cy, type, color) {
  const g = (inner, fill) =>
    `<g transform="translate(${cx - 12},${cy - 19}) scale(0.8)" fill="${fill || "none"}" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
  if (type === "solar") {
    let rays = "";
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      rays += `<line x1="${12 + Math.cos(a) * 7}" y1="${12 + Math.sin(a) * 7}" x2="${12 + Math.cos(a) * 10.5}" y2="${12 + Math.sin(a) * 10.5}"/>`;
    }
    return g(`<circle cx="12" cy="12" r="4.5"/>${rays}`);
  }
  if (type === "grid") return g(`<path d="M13 2 L5 13 h5 l-1 9 8-12 h-5 z"/>`, color);
  if (type === "battery")
    return g(`<rect x="4" y="8" width="14" height="9" rx="1.6"/><line x1="20" y1="11" x2="20" y2="14"/>`);
  return g(`<path d="M4 12 L12 5 L20 12"/><path d="M6.5 10.5 V20 H17.5 V10.5"/>`); // home
}

class EBillingPowerFlow extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign({ title: "Flujo de energía", entities: {}, colors: {} }, config || {});
    this._built = false;
    this._dur = {};
  }
  set hass(hass) { this._hass = hass; this._update(); }
  getCardSize() { return 7; }
  static getStubConfig() { return { title: "Flujo de energía", entities: {}, colors: {} }; }
  static getConfigElement() { return document.createElement("ebilling-power-flow-editor"); }

  _color(key) { return (this._config.colors || {})[key] || PF_DEFAULT_COLORS[key]; }

  _watts(key) {
    const id = (this._config.entities || {})[key];
    if (!id || !this._hass) return null;
    const st = this._hass.states[id];
    if (!st || st.state === "unavailable" || st.state === "unknown") return null;
    const v = parseFloat(st.state);
    if (!isFinite(v)) return null;
    const unit = (st.attributes.unit_of_measurement || "").toLowerCase();
    if (unit === "kw") return v * 1000;
    if (unit === "mw") return v * 1e6;
    return v;
  }

  // Lee un sensor de energía en Wh (kWh→Wh, MWh→Wh). null si no está.
  _energy(key) {
    const id = (this._config.entities || {})[key];
    if (!id || !this._hass) return null;
    const st = this._hass.states[id];
    if (!st || st.state === "unavailable" || st.state === "unknown") return null;
    const v = parseFloat(st.state);
    if (!isFinite(v)) return null;
    const unit = (st.attributes.unit_of_measurement || "").toLowerCase();
    if (unit === "wh") return v;
    if (unit === "mwh") return v * 1e6;
    return v * 1000; // kWh por defecto
  }

  // Reparto real del consumo de la casa por fuente a partir de los sensores de
  // energía diaria, si están configurados. Devuelve {solar,grid,battery} o null.
  _energyMix() {
    const pv = this._energy("pv_energy");
    const gi = this._energy("grid_import_energy");
    const bd = this._energy("battery_discharge_energy");
    if (pv == null && gi == null && bd == null) return null; // no configurados
    const P = Math.max(pv || 0, 0);
    const GI = Math.max(gi || 0, 0);
    const GE = Math.max(this._energy("grid_export_energy") || 0, 0);
    const BC = Math.max(this._energy("battery_charge_energy") || 0, 0);
    const BD = Math.max(bd || 0, 0);
    const sToG = Math.min(GE, P);
    let rem = Math.max(P - sToG, 0);
    const sToB = Math.min(BC, rem);
    rem -= sToB;
    const gToB = Math.max(BC - sToB, 0);
    return { solar: rem, grid: Math.max(GI - gToB, 0), battery: BD };
  }

  _flows() {
    const pv = Math.max(this._watts("pv") || 0, 0);
    const gi = Math.max(this._watts("grid_import") || 0, 0);
    const ge = Math.max(this._watts("grid_export") || 0, 0);
    const bc = Math.max(this._watts("battery_charge") || 0, 0);
    const bd = Math.max(this._watts("battery_discharge") || 0, 0);

    const solarToGrid = Math.min(ge, pv);
    let rem = Math.max(pv - solarToGrid, 0);
    const solarToBatt = Math.min(bc, rem);
    rem -= solarToBatt;
    const solarToHome = rem;
    const gridToBatt = Math.max(bc - solarToBatt, 0);
    const gridToHome = Math.max(gi - gridToBatt, 0);
    const battToHome = bd;
    const homeSensor = this._watts("home");
    const home = homeSensor != null ? Math.max(homeSensor, 0) : solarToHome + gridToHome + battToHome;

    return {
      values: {
        solar_home: solarToHome, solar_grid: solarToGrid, solar_battery: solarToBatt,
        grid_home: gridToHome, grid_battery: gridToBatt, battery_home: battToHome,
      },
      nodes: {
        solar: { power: pv },
        grid: { power: Math.abs(gi - ge), dir: gi - ge > 1 ? "in" : (ge - gi > 1 ? "out" : "idle") },
        battery: { power: Math.abs(bc - bd), dir: bc - bd > 1 ? "in" : (bd - bc > 1 ? "out" : "idle") },
        home: { power: home },
      },
    };
  }

  // Integra el consumo de la casa por fuente a lo largo del día (Wh),
  // guardándolo en localStorage para el anillo. Aproximado: solo acumula
  // mientras la tarjeta está visible.
  _accumulate(v) {
    let d;
    try { d = JSON.parse(localStorage.getItem("ebilling_pf_daily") || "{}"); } catch (_) { d = {}; }
    const today = new Date().toLocaleDateString("sv");
    if (d.date !== today) d = { date: today, solar: 0, grid: 0, battery: 0, ts: Date.now() };
    const now = Date.now();
    const dtH = (now - (d.ts || now)) / 3600000;
    if (dtH > 0 && dtH < 0.2) {
      d.solar += (v.solar_home || 0) * dtH;
      d.grid += (v.grid_home || 0) * dtH;
      d.battery += (v.battery_home || 0) * dtH;
    }
    d.ts = now;
    try { localStorage.setItem("ebilling_pf_daily", JSON.stringify(d)); } catch (_) { /* noop */ }
    return d;
  }

  _update() {
    if (!this._hass || !this._config) return;
    if (!this._built) this._build();
    const f = this._flows();
    // Anillo: usa los sensores de energía diaria si están; si no, integra la
    // potencia en el navegador (aproximado).
    const mix = this._energyMix() || this._accumulate(f.values);

    for (const key of Object.keys(PF_NODES)) {
      const n = f.nodes[key];
      if (this._els[`val_${key}`]) this._els[`val_${key}`].textContent = pfFmt(n.power);
      const sub = this._els[`sub_${key}`];
      if (sub) {
        if (key === "grid") sub.textContent = n.dir === "in" ? "importa" : n.dir === "out" ? "exporta" : PF_NODES.grid.label;
        else if (key === "battery") {
          const soc = this._watts("battery_soc");
          const st = n.dir === "in" ? "carga" : n.dir === "out" ? "descarga" : PF_NODES.battery.label;
          sub.textContent = soc != null ? `${st} · ${Math.round(soc)}%` : st;
        }
      }
    }

    const THRESH = 5;
    for (const [id] of PF_FLOWS) {
      const grp = this._els[`ball_${id}`];
      const lbl = this._els[`plabel_${id}`];
      const w = f.values[id] || 0;
      const on = w > THRESH;
      if (grp) grp.style.display = on ? "" : "none";
      if (lbl) { lbl.style.display = on ? "" : "none"; if (on) lbl.textContent = pfFmt(w); }
      if (on) {
        const dur = Math.max(0.6, Math.min(3.4, Math.round((3000 / w) * 5) / 5));
        if (this._dur[id] !== dur) {
          this._dur[id] = dur;
          const anim = this._els[`anim_${id}`];
          if (anim) {
            anim.setAttribute("dur", `${dur}s`);
            try { anim.beginElement(); } catch (_) { /* SMIL no soportado */ }
          }
        }
      }
    }

    this._renderRing(mix);
  }

  _renderRing(mix) {
    const el = this._els.ring;
    if (!el) return;
    const cx = PF_NODES.home.x, cy = PF_NODES.home.y, r = PF_HOME_RING;
    const parts = [
      ["solar", mix.solar, this._color("solar")],
      ["grid", mix.grid, this._color("grid")],
      ["battery", mix.battery, this._color("battery")],
    ].filter((p) => p[1] > 0);
    const total = parts.reduce((s, p) => s + p[1], 0);
    let svg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--primary-text-color)" stroke-opacity="0.10" stroke-width="7"/>`;
    if (total > 0) {
      const gap = parts.length > 1 ? 4 : 0;
      let ang = 0;
      for (const [, val, color] of parts) {
        const span = (val / total) * 360;
        const a0 = ang + gap / 2, a1 = ang + span - gap / 2;
        if (a1 > a0) {
          const [x0, y0] = pfPolar(cx, cy, r, a0);
          const [x1, y1] = pfPolar(cx, cy, r, a1);
          const large = a1 - a0 > 180 ? 1 : 0;
          svg += `<path d="M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"/>`;
        }
        ang += span;
      }
    }
    el.innerHTML = svg;
  }

  _build() {
    this._built = true;
    this._els = {};
    const card = document.createElement("ha-card");

    let lines = "", balls = "", labels = "", nodes = "";
    for (const [id, from, to, ctrl] of PF_FLOWS) {
      const color = this._color(from);
      const [sx, sy] = pfEdge(PF_NODES[from], ctrl);
      const [ex, ey] = pfEdge(PF_NODES[to], ctrl);
      const d = `M${sx.toFixed(1)},${sy.toFixed(1)} Q${ctrl[0]},${ctrl[1]} ${ex.toFixed(1)},${ey.toFixed(1)}`;
      lines += `<path class="pf-base" d="${d}"/>`;
      balls += `<g class="pf-ball" data-id="${id}" style="display:none">
          <circle r="5.5" fill="${color}" style="filter:drop-shadow(0 0 3px ${color})"/>
          <animateMotion data-id="${id}" dur="1.6s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1" keyTimes="0;1" path="${d}"/>
        </g>`;
      // etiqueta de potencia en el punto medio de la curva (t=0.5)
      const mx = 0.25 * sx + 0.5 * ctrl[0] + 0.25 * ex;
      const my = 0.25 * sy + 0.5 * ctrl[1] + 0.25 * ey;
      labels += `<text class="pf-plabel" data-id="${id}" x="${mx.toFixed(1)}" y="${my.toFixed(1)}" text-anchor="middle" style="display:none"></text>`;
    }

    for (const key of Object.keys(PF_NODES)) {
      const n = PF_NODES[key];
      const color = this._color(key);
      if (key === "home") {
        nodes += `
          <g>
            <circle cx="${n.x}" cy="${n.y}" r="${PF_HOME_DISC}" fill="var(--card-background-color)"/>
            <g class="pf-ring" data-key="home"></g>
            ${pfIcon(n.x, n.y - 4, "home", color)}
            <text class="pf-val" data-key="home" x="${n.x}" y="${n.y + 15}" text-anchor="middle">—</text>
            <text class="pf-sub" data-key="home" x="${n.x}" y="${n.y + PF_HOME_RING + 15}" text-anchor="middle">${n.label}</text>
          </g>`;
      } else {
        nodes += `
          <g>
            <circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="var(--card-background-color)" stroke="${color}" stroke-width="2.5"/>
            ${pfIcon(n.x, n.y, key, color)}
            <text class="pf-val" data-key="${key}" x="${n.x}" y="${n.y + 13}" text-anchor="middle">—</text>
            <text class="pf-sub" data-key="${key}" x="${n.x}" y="${n.y + n.r + 13}" text-anchor="middle">${n.label}</text>
          </g>`;
      }
    }

    card.innerHTML = `
      <style>${EBillingPowerFlow.styles}</style>
      <div class="pf-wrap">
        ${this._config.title ? `<div class="pf-title">${this._esc(this._config.title)}</div>` : ""}
        <svg viewBox="0 0 360 372" class="pf-svg">
          ${lines}
          ${balls}
          ${labels}
          ${nodes}
        </svg>
      </div>`;
    this.innerHTML = "";
    this.appendChild(card);

    for (const [id] of PF_FLOWS) {
      this._els[`ball_${id}`] = card.querySelector(`.pf-ball[data-id="${id}"]`);
      this._els[`anim_${id}`] = card.querySelector(`animateMotion[data-id="${id}"]`);
      this._els[`plabel_${id}`] = card.querySelector(`.pf-plabel[data-id="${id}"]`);
    }
    card.querySelectorAll(".pf-val").forEach((el) => (this._els[`val_${el.dataset.key}`] = el));
    card.querySelectorAll(".pf-sub").forEach((el) => (this._els[`sub_${el.dataset.key}`] = el));
    this._els.ring = card.querySelector(".pf-ring");
  }

  _esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }
}

EBillingPowerFlow.styles = `
  .pf-wrap { padding: 12px 10px 10px; }
  .pf-title { font-size: 1.05rem; font-weight: 600; color: var(--primary-text-color); padding: 2px 6px 6px; }
  .pf-svg { width: 100%; height: auto; max-width: 440px; display: block; margin: 0 auto; }
  .pf-base { fill: none; stroke: var(--primary-text-color); opacity: 0.12; stroke-width: 2.5; stroke-linecap: round; }
  .pf-val { fill: var(--primary-text-color); font-size: 12px; font-weight: 700; font-family: inherit; }
  .pf-sub { fill: var(--secondary-text-color); font-size: 9px; font-family: inherit; }
  .pf-plabel {
    fill: var(--primary-text-color); font-size: 10.5px; font-weight: 700; font-family: inherit;
    paint-order: stroke; stroke: var(--card-background-color); stroke-width: 3px; stroke-linejoin: round;
  }
  @media (prefers-reduced-motion: reduce) { .pf-ball animateMotion { display: none; } }
`;

/* ------------------------- editor visual ------------------------- */

class EBillingPowerFlowEditor extends HTMLElement {
  setConfig(config) { this._config = Object.assign({ entities: {}, colors: {} }, config || {}); this._render(); }
  set hass(hass) { this._hass = hass; this._render(); }

  _sensorsBy(kind) {
    if (!this._hass) return [];
    const all = Object.keys(this._hass.states).filter((id) => id.startsWith("sensor."));
    const cfg = {
      energy: { units: ["wh", "kwh", "mwh"], dc: "energy" },
      percent: { units: ["%"], dc: "battery" },
      power: { units: ["w", "kw", "mw"], dc: "power" },
    }[kind] || { units: [], dc: null };
    const match = all.filter((id) => {
      const a = this._hass.states[id].attributes || {};
      const u = (a.unit_of_measurement || "").toLowerCase();
      return a.device_class === cfg.dc || cfg.units.includes(u);
    });
    return (match.length ? match : all).sort();
  }

  _render() {
    if (!this._hass || !this._config || this._built) return;
    this._built = true;
    const power = this._sensorsBy("power");
    const energy = this._sensorsBy("energy");
    const percent = this._sensorsBy("percent");
    const opt = (list, sel) =>
      `<option value="">— sin asignar —</option>` +
      list.map((id) => `<option value="${id}" ${id === sel ? "selected" : ""}>${id}</option>`).join("");
    const rowsFor = (slots, list) => slots.map(([key, label]) => `
      <div class="pfe-row"><label>${label}</label>
        <select data-key="${key}">${opt(list, (this._config.entities || {})[key] || "")}</select></div>`).join("");
    const rows = rowsFor(POWER_SLOTS, power) + rowsFor(SOC_SLOTS, percent);
    const energyRows = rowsFor(ENERGY_SLOTS, energy);
    const colorRow = (key, label) => `
      <div class="pfe-color"><input type="color" data-color="${key}" value="${(this._config.colors || {})[key] || PF_DEFAULT_COLORS[key]}"><span>${label}</span></div>`;

    this.innerHTML = `
      <style>
        .pfe { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
        .pfe-row { display: flex; flex-direction: column; gap: 4px; }
        .pfe-row label { font-size: 12px; color: var(--secondary-text-color); }
        .pfe-row select, .pfe-row input { padding: 8px 10px; border-radius: 8px;
          border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color);
          color: var(--primary-text-color); font: inherit; }
        .pfe-colors { display: flex; flex-wrap: wrap; gap: 14px; padding-top: 4px; }
        .pfe-color { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--secondary-text-color); }
        .pfe-color input[type=color] { width: 34px; height: 28px; padding: 0; border: none; background: none; }
        .pfe-h { font-size: 12.5px; font-weight: 600; color: var(--primary-text-color); margin-top: 6px; }
        .pfe-note { font-size: 11px; color: var(--secondary-text-color); margin-top: -4px; }
      </style>
      <div class="pfe">
        <div class="pfe-row"><label>Título</label>
          <input id="pfe-title" type="text" value="${(this._config.title || "").replace(/"/g, "&quot;")}"></div>
        <div class="pfe-h">Sensores de potencia (flujos)</div>
        ${rows}
        <div class="pfe-h">Sensores de energía diaria (anillo de la casa)</div>
        <div class="pfe-note">Opcional. Si los defines, el anillo usa estos totales del día; si no, se calcula de forma aproximada.</div>
        ${energyRows}
        <div class="pfe-h">Colores</div>
        <div class="pfe-colors">
          ${colorRow("solar", "Solar")}${colorRow("home", "Casa")}${colorRow("battery", "Batería")}${colorRow("grid", "Red")}
        </div>
      </div>`;

    this.querySelector("#pfe-title").addEventListener("input", (e) => {
      this._config = { ...this._config, title: e.target.value }; this._emit();
    });
    this.querySelectorAll("select[data-key]").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const entities = { ...(this._config.entities || {}) };
        if (e.target.value) entities[e.target.dataset.key] = e.target.value;
        else delete entities[e.target.dataset.key];
        this._config = { ...this._config, entities }; this._emit();
      });
    });
    this.querySelectorAll("input[data-color]").forEach((inp) => {
      inp.addEventListener("input", (e) => {
        const colors = { ...(this._config.colors || {}) };
        colors[e.target.dataset.color] = e.target.value;
        this._config = { ...this._config, colors }; this._emit();
      });
    });
  }

  _emit() {
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config }, bubbles: true, composed: true,
    }));
  }
}

customElements.define("ebilling-power-flow", EBillingPowerFlow);
customElements.define("ebilling-power-flow-editor", EBillingPowerFlowEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ebilling-power-flow",
  name: "eBilling — Flujo de energía",
  description: "Diagrama animado del flujo de potencia entre solar, red, batería y casa.",
  preview: true,
});

console.info("%c eBilling-power-flow %c v0.8 ", "background:#f6a609;color:#000;border-radius:3px 0 0 3px;padding:2px 4px", "background:#12b886;color:#fff;border-radius:0 3px 3px 0;padding:2px 4px");

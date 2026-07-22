/*
 * eBilling Power Flow — tarjeta Lovelace de flujo de energía fotovoltaica
 * Muestra, de forma animada, la potencia instantánea que viaja entre solar,
 * red eléctrica, batería y casa.
 *
 * Instalación (misma que la otra tarjeta):
 *   - HACS: el recurso se sirve en /hacsfiles/HA-ebilling-addon/ebilling-power-flow.js
 *   - Manual: copia dist/ebilling-power-flow.js a /config/www/ y añade el recurso
 *             /local/ebilling-power-flow.js  (tipo: Módulo de JavaScript)
 *
 * Uso (o configúralo con el editor visual de la tarjeta):
 *   type: custom:ebilling-power-flow
 *   title: Flujo de energía
 *   entities:
 *     pv: sensor.produccion_solar
 *     grid_import: sensor.importacion_red
 *     grid_export: sensor.exportacion_red
 *     battery_charge: sensor.carga_bateria
 *     battery_discharge: sensor.descarga_bateria
 *     home: sensor.consumo_casa          # opcional (si falta, se calcula)
 *     battery_soc: sensor.bateria_soc    # opcional (muestra el % de la batería)
 */

const PF_NODES = {
  solar: { x: 170, y: 48, color: "#f9a825", icon: "☀️", label: "Solar" },
  grid: { x: 48, y: 150, color: "#e5484d", icon: "🗼", label: "Red" },
  battery: { x: 292, y: 150, color: "#12b886", icon: "🔋", label: "Batería" },
  home: { x: 170, y: 252, color: "#4a6cf7", icon: "🏠", label: "Casa" },
};
const NODE_R = 30;

// flujos: id, origen, destino (el color del flujo = color del origen)
const PF_FLOWS = [
  ["solar_home", "solar", "home"],
  ["solar_grid", "solar", "grid"],
  ["solar_battery", "solar", "battery"],
  ["grid_home", "grid", "home"],
  ["grid_battery", "grid", "battery"],
  ["battery_home", "battery", "home"],
];

const SENSOR_SLOTS = [
  ["pv", "Producción solar (PV)"],
  ["grid_import", "Importación de red"],
  ["grid_export", "Exportación a red"],
  ["battery_charge", "Carga de batería"],
  ["battery_discharge", "Descarga de batería"],
  ["home", "Consumo de la casa (opcional)"],
  ["battery_soc", "Estado de carga batería % (opcional)"],
];

function pfEdge(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x1: a.x + (dx / len) * NODE_R, y1: a.y + (dy / len) * NODE_R,
    x2: b.x - (dx / len) * NODE_R, y2: b.y - (dy / len) * NODE_R,
  };
}

function pfFmt(w) {
  const a = Math.abs(w);
  if (a >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
}

class EBillingPowerFlow extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign({ title: "Flujo de energía", entities: {} }, config || {});
    this._built = false;
    this._sig = null;
  }
  set hass(hass) { this._hass = hass; this._update(); }
  getCardSize() { return 6; }
  static getStubConfig() { return { title: "Flujo de energía", entities: {} }; }
  static getConfigElement() { return document.createElement("ebilling-power-flow-editor"); }

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
    return v; // W por defecto
  }

  _flows() {
    const pv = Math.max(this._watts("pv") || 0, 0);
    const gi = Math.max(this._watts("grid_import") || 0, 0);
    const ge = Math.max(this._watts("grid_export") || 0, 0);
    const bc = Math.max(this._watts("battery_charge") || 0, 0);
    const bd = Math.max(this._watts("battery_discharge") || 0, 0);

    const solarToGrid = Math.min(ge, pv);
    let solarRem = Math.max(pv - solarToGrid, 0);
    const solarToBatt = Math.min(bc, solarRem);
    solarRem -= solarToBatt;
    const solarToHome = solarRem;
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
        solar: { power: pv, dir: pv > 1 ? "out" : "idle" },
        grid: { power: Math.abs(gi - ge), dir: gi - ge > 1 ? "in" : (ge - gi > 1 ? "out" : "idle") },
        battery: { power: Math.abs(bc - bd), dir: bc - bd > 1 ? "in" : (bd - bc > 1 ? "out" : "idle") },
        home: { power: home, dir: "in" },
      },
    };
  }

  _update() {
    if (!this._hass || !this._config) return;
    const f = this._flows();
    const sig = JSON.stringify([
      Object.values(f.values).map((v) => Math.round(v / 20)),
      Object.entries(f.nodes).map(([k, v]) => [Math.round(v.power / 20), v.dir]),
      this._darkKey(),
    ]);
    if (sig === this._sig) return;
    this._sig = sig;
    if (!this._built) this._build();

    // nodos
    for (const key of Object.keys(PF_NODES)) {
      const n = f.nodes[key];
      const valEl = this._els[`val_${key}`];
      const subEl = this._els[`sub_${key}`];
      if (valEl) valEl.textContent = pfFmt(n.power);
      if (subEl) {
        if (key === "grid") subEl.textContent = n.dir === "in" ? "importando" : n.dir === "out" ? "exportando" : "—";
        else if (key === "battery") {
          const soc = this._watts("battery_soc");
          const socTxt = soc != null ? ` · ${Math.round(soc)}%` : "";
          subEl.textContent = (n.dir === "in" ? "cargando" : n.dir === "out" ? "descargando" : "en reposo") + socTxt;
        } else subEl.textContent = PF_NODES[key].label;
      }
    }

    // flujos
    const THRESH = 5; // W
    for (const [id] of PF_FLOWS) {
      const el = this._els[`flow_${id}`];
      if (!el) continue;
      const w = f.values[id] || 0;
      const on = w > THRESH;
      el.classList.toggle("on", on);
      if (on) {
        const dur = Math.max(0.4, Math.min(3, 3000 / w));
        el.style.setProperty("--dur", `${dur.toFixed(2)}s`);
      }
    }
  }

  _darkKey() {
    if (this._hass && this._hass.themes && typeof this._hass.themes.darkMode === "boolean") {
      return this._hass.themes.darkMode;
    }
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  _build() {
    this._built = true;
    this._els = {};
    const card = document.createElement("ha-card");

    let flows = "";
    for (const [id, from, to] of PF_FLOWS) {
      const e = pfEdge(PF_NODES[from], PF_NODES[to]);
      const color = PF_NODES[from].color;
      const d = `M${e.x1},${e.y1} L${e.x2},${e.y2}`;
      flows += `<path class="pf-base" d="${d}"/>`;
      flows += `<path class="pf-flow" data-id="${id}" d="${d}" stroke="${color}"/>`;
    }

    let nodes = "";
    for (const key of Object.keys(PF_NODES)) {
      const n = PF_NODES[key];
      nodes += `
        <g class="pf-node">
          <circle cx="${n.x}" cy="${n.y}" r="${NODE_R}" fill="var(--card-background-color)" stroke="${n.color}" stroke-width="2.5"/>
          <text x="${n.x}" y="${n.y - 2}" text-anchor="middle" font-size="20">${n.icon}</text>
          <text class="pf-val" data-key="${key}" x="${n.x}" y="${n.y + 16}" text-anchor="middle">—</text>
          <text class="pf-sub" data-key="${key}" x="${n.x}" y="${n.y + NODE_R + 16}" text-anchor="middle">${n.label}</text>
        </g>`;
    }

    card.innerHTML = `
      <style>${EBillingPowerFlow.styles}</style>
      <div class="pf-wrap">
        ${this._config.title ? `<div class="pf-title">${this._esc(this._config.title)}</div>` : ""}
        <svg viewBox="0 0 340 300" class="pf-svg">
          ${flows}
          ${nodes}
        </svg>
      </div>`;
    this.innerHTML = "";
    this.appendChild(card);

    for (const [id] of PF_FLOWS) this._els[`flow_${id}`] = card.querySelector(`.pf-flow[data-id="${id}"]`);
    card.querySelectorAll(".pf-val").forEach((el) => (this._els[`val_${el.dataset.key}`] = el));
    card.querySelectorAll(".pf-sub").forEach((el) => (this._els[`sub_${el.dataset.key}`] = el));
  }

  _esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }
}

EBillingPowerFlow.styles = `
  .pf-wrap { padding: 12px 8px 6px; }
  .pf-title { font-size: 1.05rem; font-weight: 600; color: var(--primary-text-color); padding: 4px 10px 0; }
  .pf-svg { width: 100%; height: auto; max-width: 420px; display: block; margin: 0 auto; }
  .pf-base { fill: none; stroke: var(--primary-text-color); opacity: 0.12; stroke-width: 3; stroke-linecap: round; }
  .pf-flow {
    fill: none; stroke-width: 3.4; stroke-linecap: round;
    stroke-dasharray: 2 8; stroke-dashoffset: 0; opacity: 0;
  }
  .pf-flow.on { opacity: 1; animation: pf-march var(--dur, 2s) linear infinite; }
  @keyframes pf-march { to { stroke-dashoffset: -10; } }
  .pf-val { fill: var(--primary-text-color); font-size: 11px; font-weight: 700; font-family: inherit; }
  .pf-sub { fill: var(--secondary-text-color); font-size: 8.5px; font-family: inherit; }
  @media (prefers-reduced-motion: reduce) { .pf-flow.on { animation: none; } }
`;

/* ------------------------- editor visual ------------------------- */

class EBillingPowerFlowEditor extends HTMLElement {
  setConfig(config) { this._config = Object.assign({ entities: {} }, config || {}); this._render(); }
  set hass(hass) { this._hass = hass; this._render(); }

  _powerSensors() {
    if (!this._hass) return [];
    const all = Object.keys(this._hass.states).filter((id) => id.startsWith("sensor."));
    const power = all.filter((id) => {
      const a = this._hass.states[id].attributes || {};
      const u = (a.unit_of_measurement || "").toLowerCase();
      return a.device_class === "power" || u === "w" || u === "kw" || u === "mw";
    });
    return (power.length ? power : all).sort();
  }

  _render() {
    if (!this._hass || !this._config || this._built) return;
    this._built = true;
    const sensors = this._powerSensors();
    const opt = (sel) =>
      `<option value="">— sin asignar —</option>` +
      sensors.map((id) => `<option value="${id}" ${id === sel ? "selected" : ""}>${id}</option>`).join("");

    const rows = SENSOR_SLOTS.map(([key, label]) => `
      <div class="pfe-row">
        <label>${label}</label>
        <select data-key="${key}">${opt((this._config.entities || {})[key] || "")}</select>
      </div>`).join("");

    this.innerHTML = `
      <style>
        .pfe { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
        .pfe-row { display: flex; flex-direction: column; gap: 4px; }
        .pfe-row label { font-size: 12px; color: var(--secondary-text-color); }
        .pfe-row select, .pfe-row input {
          padding: 8px 10px; border-radius: 8px; border: 1px solid var(--divider-color, #ccc);
          background: var(--card-background-color); color: var(--primary-text-color); font: inherit;
        }
      </style>
      <div class="pfe">
        <div class="pfe-row">
          <label>Título</label>
          <input id="pfe-title" type="text" value="${(this._config.title || "").replace(/"/g, "&quot;")}">
        </div>
        ${rows}
        <div class="pfe-hint" style="font-size:11.5px;color:var(--secondary-text-color)">
          Selecciona sensores de potencia (W/kW). El consumo de la casa se calcula si lo dejas sin asignar.
        </div>
      </div>`;

    this.querySelector("#pfe-title").addEventListener("input", (e) => {
      this._config = { ...this._config, title: e.target.value };
      this._emit();
    });
    this.querySelectorAll("select[data-key]").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const entities = { ...(this._config.entities || {}) };
        const v = e.target.value;
        if (v) entities[e.target.dataset.key] = v;
        else delete entities[e.target.dataset.key];
        this._config = { ...this._config, entities };
        this._emit();
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

console.info("%c eBilling-power-flow %c cargada ", "background:#f9a825;color:#000;border-radius:3px 0 0 3px;padding:2px 4px", "background:#12b886;color:#fff;border-radius:0 3px 3px 0;padding:2px 4px");

/*
 * eBilling Power Flow — tarjeta Lovelace de flujo de energía fotovoltaica
 * Muestra, de forma animada y en tiempo real, la potencia instantánea que
 * viaja entre solar, red eléctrica, batería y casa.
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
 */

const PF_NODES = {
  solar: { x: 80, y: 54, r: 30, color: "#f6a609", label: "Solar" },
  grid: { x: 80, y: 132, r: 30, color: "#e5484d", label: "Red" },
  battery: { x: 80, y: 210, r: 30, color: "#12b886", label: "Batería" },
  home: { x: 268, y: 132, r: 34, color: "#4a6cf7", label: "Casa" },
};

// flujo: id, origen, destino, punto de control de la curva
const PF_FLOWS = [
  ["solar_home", "solar", "home", [186, 54]],
  ["grid_home", "grid", "home", [186, 132]],
  ["battery_home", "battery", "home", [186, 210]],
  ["solar_grid", "solar", "grid", [52, 93]],
  ["grid_battery", "grid", "battery", [52, 171]],
  ["solar_battery", "solar", "battery", [18, 132]],
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

function pfFmt(w) {
  const a = Math.abs(w);
  if (a >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  if (a >= 100) return `${Math.round(w)} W`;
  return `${w.toFixed(a >= 10 ? 0 : 1)} W`;
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

function pfPath(from, to, ctrl) {
  const a = PF_NODES[from], b = PF_NODES[to];
  return `M${a.x},${a.y} Q${ctrl[0]},${ctrl[1]} ${b.x},${b.y}`;
}

class EBillingPowerFlow extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign({ title: "Flujo de energía", entities: {} }, config || {});
    this._built = false;
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
    return v;
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

  _update() {
    if (!this._hass || !this._config) return;
    if (!this._built) this._build();
    const f = this._flows();

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
      const el = this._els[`flow_${id}`];
      if (!el) continue;
      const w = f.values[id] || 0;
      const on = w > THRESH;
      el.classList.toggle("on", on);
      if (on) {
        // velocidad ∝ potencia (a más potencia, más rápido), en pasos de 0.2s
        const dur = Math.max(0.5, Math.min(3, Math.round((2600 / w) * 5) / 5));
        el.style.setProperty("--dur", `${dur}s`);
      }
    }
  }

  _build() {
    this._built = true;
    this._els = {};
    const card = document.createElement("ha-card");

    let defs = "", lines = "", dots = "", nodes = "";
    for (const [id, from, to, ctrl] of PF_FLOWS) {
      const color = PF_NODES[from].color;
      const d = pfPath(from, to, ctrl);
      lines += `<path class="pf-base" d="${d}"/>`;
      dots += `<path class="pf-flow" data-id="${id}" d="${d}" stroke="${color}" style="color:${color}"/>`;
    }
    for (const key of Object.keys(PF_NODES)) {
      const n = PF_NODES[key];
      nodes += `
        <g>
          <circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="var(--card-background-color)" stroke="${n.color}" stroke-width="2.5"/>
          ${pfIcon(n.x, n.y, key, n.color)}
          <text class="pf-val" data-key="${key}" x="${n.x}" y="${n.y + 13}" text-anchor="middle">—</text>
          <text class="pf-sub" data-key="${key}" x="${n.x}" y="${n.y + n.r + 12}" text-anchor="middle">${n.label}</text>
        </g>`;
    }

    card.innerHTML = `
      <style>${EBillingPowerFlow.styles}</style>
      <div class="pf-wrap">
        ${this._config.title ? `<div class="pf-title">${this._esc(this._config.title)}</div>` : ""}
        <svg viewBox="0 0 348 268" class="pf-svg">
          <defs>${defs}</defs>
          ${lines}
          ${dots}
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
  .pf-wrap { padding: 12px 10px 10px; }
  .pf-title { font-size: 1.05rem; font-weight: 600; color: var(--primary-text-color); padding: 2px 6px 6px; }
  .pf-svg { width: 100%; height: auto; max-width: 460px; display: block; margin: 0 auto; }
  .pf-base { fill: none; stroke: var(--primary-text-color); opacity: 0.10; stroke-width: 3; stroke-linecap: round; }
  .pf-flow {
    fill: none; stroke-width: 5; stroke-linecap: round;
    stroke-dasharray: 0.1 13; stroke-dashoffset: 0; opacity: 0;
    transition: opacity .35s ease;
  }
  .pf-flow.on {
    opacity: 0.95;
    animation: pf-march var(--dur, 1.6s) linear infinite;
    filter: drop-shadow(0 0 2.5px currentColor);
  }
  @keyframes pf-march { to { stroke-dashoffset: -13; } }
  .pf-val { fill: var(--primary-text-color); font-size: 11.5px; font-weight: 700; font-family: inherit; }
  .pf-sub { fill: var(--secondary-text-color); font-size: 9px; font-family: inherit; }
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
      <div class="pfe-row"><label>${label}</label>
        <select data-key="${key}">${opt((this._config.entities || {})[key] || "")}</select></div>`).join("");

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
        <div class="pfe-row"><label>Título</label>
          <input id="pfe-title" type="text" value="${(this._config.title || "").replace(/"/g, "&quot;")}"></div>
        ${rows}
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

console.info("%c eBilling-power-flow %c cargada ", "background:#f6a609;color:#000;border-radius:3px 0 0 3px;padding:2px 4px", "background:#12b886;color:#fff;border-radius:0 3px 3px 0;padding:2px 4px");

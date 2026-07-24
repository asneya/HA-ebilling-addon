/*
 * eBilling Power Flow — tarjeta Lovelace de flujo de energía fotovoltaica
 * Layout en cruz: Solar (arriba), Red (izq.), Casa (der.), Batería (abajo).
 * Una bola por línea, colores configurables, anillo de reparto diario en la
 * casa y tooltip al pulsar cada sección del anillo.
 *
 * Instalación:
 *   - HACS: recurso /hacsfiles/HA-ebilling-addon/ebilling-power-flow.js
 *   - Manual: copia a /config/www/ y añade /local/ebilling-power-flow.js
 */

const PF_DEFAULT_COLORS = { solar: "#f6a609", grid: "#5b8def", battery: "#12b886", home: "#f6a609" };

// Geometría (viewBox 400x408). Nodos en cruz.
const PF_NODES = {
  solar: { x: 200, y: 80, r: 50, label: "Solar", labelPos: "top" },
  grid: { x: 80, y: 204, r: 50, label: "Red", labelPos: "bottom" },
  home: { x: 320, y: 204, r: 50, label: "Casa", labelPos: "bottom" },
  battery: { x: 200, y: 328, r: 50, label: "Batería", labelPos: "bottom" },
};
const PF_RING = 50; // radio del anillo (borde) de la casa

// flujo: id, nodo origen (color), start[x,y], control[x,y], end[x,y]
const PF_FLOWS = [
  ["solar_battery", "solar", [200, 130], [200, 204], [200, 278]],
  ["grid_home", "grid", [130, 204], [200, 204], [270, 204]],
  ["solar_grid", "solar", [165, 115], [150, 154], [115, 169]],
  ["solar_home", "solar", [235, 115], [250, 154], [285, 169]],
  ["grid_battery", "grid", [115, 239], [150, 254], [165, 293]],
  ["battery_home", "battery", [235, 293], [250, 254], [285, 239]],
];

const POWER_SLOTS = [
  ["pv", "Producción solar (PV)"],
  ["grid_import", "Importación de red"],
  ["grid_export", "Exportación a red"],
  ["battery_charge", "Carga de batería"],
  ["battery_discharge", "Descarga de batería"],
  ["home", "Consumo de la casa (opcional)"],
];
const SOC_SLOTS = [["battery_soc", "Estado de carga batería % (opcional)"]];
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
function pfEnergyFmt(wh) {
  const k = wh / 1000;
  if (Math.abs(k) >= 100) return `${Math.round(k)} kWh`;
  if (Math.abs(k) >= 1) return `${k.toFixed(2)} kWh`;
  return `${Math.round(wh)} Wh`;
}
function pfPolar(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

// Icono vectorial centrado exactamente en (cx, cy).
function pfIcon(cx, cy, type, color) {
  const s = 0.92;
  const t = `translate(${(cx - 12 * s).toFixed(2)},${(cy - 12 * s).toFixed(2)}) scale(${s})`;
  const wrap = (inner, fill) =>
    `<g transform="${t}" fill="${fill || "none"}" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
  if (type === "solar") {
    let rays = "";
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      rays += `<line x1="${(12 + Math.cos(a) * 7).toFixed(1)}" y1="${(12 + Math.sin(a) * 7).toFixed(1)}" x2="${(12 + Math.cos(a) * 10.5).toFixed(1)}" y2="${(12 + Math.sin(a) * 10.5).toFixed(1)}"/>`;
    }
    return wrap(`<circle cx="12" cy="12" r="4.5"/>${rays}`);
  }
  if (type === "grid") return wrap(`<path d="M13 2 L5 13 h5 l-1 9 8-12 h-5 z"/>`, color);
  if (type === "battery") return wrap(`<rect x="4" y="8" width="14" height="9" rx="1.6"/><line x1="20" y1="11" x2="20" y2="14"/>`);
  return wrap(`<path d="M4 12 L12 5 L20 12"/><path d="M6.5 10.5 V20 H17.5 V10.5"/>`); // home
}

class EBillingPowerFlow extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign({ title: "Flujo de energía", entities: {}, colors: {} }, config || {});
    this._built = false;
    this._dur = {};
  }
  set hass(hass) { this._hass = hass; this._update(); }
  getCardSize() { return 8; }
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
    return v * 1000;
  }

  _energyMix() {
    const pv = this._energy("pv_energy");
    const gi = this._energy("grid_import_energy");
    const bd = this._energy("battery_discharge_energy");
    if (pv == null && gi == null && bd == null) return null;
    const P = Math.max(pv || 0, 0), GI = Math.max(gi || 0, 0);
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

  _inOut(feedEnergyKey, homeEnergyKey, feedPowerKey, homePowerKey) {
    const fe = this._energy(feedEnergyKey), he = this._energy(homeEnergyKey);
    if (fe != null || he != null) {
      return { feedin: Math.max(fe || 0, 0), tohome: Math.max(he || 0, 0), energy: true };
    }
    return {
      feedin: Math.max(this._watts(feedPowerKey) || 0, 0),
      tohome: Math.max(this._watts(homePowerKey) || 0, 0),
      energy: false,
    };
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
    const homeSensor = this._watts("home");
    const home = homeSensor != null ? Math.max(homeSensor, 0) : solarToHome + gridToHome + bd;
    return {
      values: {
        solar_home: solarToHome, solar_grid: solarToGrid, solar_battery: solarToBatt,
        grid_home: gridToHome, grid_battery: gridToBatt, battery_home: bd,
      },
      solar: pv, home,
    };
  }

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
    const mix = this._energyMix() || this._accumulate(f.values);
    const E = this._els;
    const io = (v, energy) => (energy ? pfEnergyFmt(v) : pfFmt(v));

    if (E.solar) E.solar.textContent = pfFmt(f.solar);

    const homeTotal = (mix.solar || 0) + (mix.grid || 0) + (mix.battery || 0);
    if (E.home_total) E.home_total.textContent = pfEnergyFmt(homeTotal);
    if (E.home_power) E.home_power.textContent = pfFmt(f.home);

    const g = this._inOut("grid_export_energy", "grid_import_energy", "grid_export", "grid_import");
    if (E.grid_in) E.grid_in.textContent = `← ${io(g.feedin, g.energy)}`;
    if (E.grid_out) E.grid_out.textContent = `→ ${io(g.tohome, g.energy)}`;

    const b = this._inOut("battery_charge_energy", "battery_discharge_energy", "battery_charge", "battery_discharge");
    if (E.bat_out) E.bat_out.textContent = `↓ ${io(b.tohome, b.energy)}`;
    if (E.bat_in) E.bat_in.textContent = `↑ ${io(b.feedin, b.energy)}`;
    const soc = this._watts("battery_soc");
    if (E.sub_battery) E.sub_battery.textContent = soc != null ? `Batería · ${Math.round(soc)}%` : "Batería";

    const THRESH = 5;
    for (const [id] of PF_FLOWS) {
      const grp = E[`ball_${id}`];
      const w = f.values[id] || 0;
      const on = w > THRESH;
      if (grp) grp.style.display = on ? "" : "none";
      if (on) {
        const dur = Math.max(0.6, Math.min(3.4, Math.round((3000 / w) * 5) / 5));
        if (this._dur[id] !== dur) {
          this._dur[id] = dur;
          const anim = E[`anim_${id}`];
          if (anim) { anim.setAttribute("dur", `${dur}s`); try { anim.beginElement(); } catch (_) { /* noop */ } }
        }
      }
    }
    this._renderRing(mix);
  }

  _renderRing(mix) {
    const el = this._els.ring;
    if (!el) return;
    const cx = PF_NODES.home.x, cy = PF_NODES.home.y, r = PF_RING;
    const parts = [
      ["solar", "Solar", mix.solar, this._color("solar")],
      ["grid", "Red", mix.grid, this._color("grid")],
      ["battery", "Batería", mix.battery, this._color("battery")],
    ].filter((p) => p[2] > 0);
    const total = parts.reduce((s, p) => s + p[2], 0);
    let svg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--primary-text-color)" stroke-opacity="0.12" stroke-width="4"/>`;
    if (total > 0) {
      const gap = parts.length > 1 ? 5 : 0;
      let ang = 0;
      for (const [key, name, val, color] of parts) {
        const span = (val / total) * 360;
        const mid = ang + span / 2;
        const a0 = ang + gap / 2, a1 = ang + span - gap / 2;
        if (a1 > a0) {
          const [x0, y0] = pfPolar(cx, cy, r, a0);
          const [x1, y1] = pfPolar(cx, cy, r, a1);
          const large = a1 - a0 > 180 ? 1 : 0;
          const pct = Math.round((val / total) * 100);
          svg += `<path class="pf-seg" style="cursor:pointer" data-key="${key}" data-name="${name}" data-val="${val.toFixed(0)}" data-pct="${pct}" data-mid="${mid.toFixed(1)}" d="M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}" fill="none" stroke="${color}" stroke-width="4.5" stroke-linecap="round"><title>${name}: ${pfEnergyFmt(val)} (${pct}%)</title></path>`;
        }
        ang += span;
      }
    }
    el.innerHTML = svg;
    if (this._tipSrc) {
      const seg = el.querySelector(`.pf-seg[data-key="${this._tipSrc}"]`);
      if (seg) this._setTip(seg.dataset); else this._hideTip();
    }
  }

  _setTip(ds) {
    const tip = this._els.tip;
    if (!tip) return;
    this._tipSrc = ds.key;
    const [px, py] = pfPolar(PF_NODES.home.x, PF_NODES.home.y, PF_RING + 22, parseFloat(ds.mid));
    const text = `${ds.name} · ${pfEnergyFmt(parseFloat(ds.val))} · ${ds.pct}%`;
    const w = text.length * 6.1 + 16, h = 22;
    const x = Math.max(6, Math.min(400 - w - 6, px - w / 2));
    const y = Math.max(6, Math.min(408 - h - 6, py - 11));
    tip.innerHTML =
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="6" fill="var(--primary-text-color)"/>` +
      `<text x="${(x + w / 2).toFixed(1)}" y="${(y + 15).toFixed(1)}" text-anchor="middle" fill="var(--card-background-color)" font-size="11" font-weight="600" font-family="inherit">${this._esc(text)}</text>`;
    tip.style.display = "";
  }
  _hideTip() { this._tipSrc = null; if (this._els.tip) this._els.tip.style.display = "none"; }

  _nodeLabel(n) {
    if (n.labelPos === "top") return `<text class="pf-lbl" x="${n.x}" y="${n.y - n.r - 9}" text-anchor="middle">${n.label}</text>`;
    return `<text class="pf-lbl" x="${n.x}" y="${n.y + n.r + 20}" text-anchor="middle" data-el="${n.label === "Batería" ? "sub_battery" : ""}">${n.label}</text>`;
  }

  _build() {
    this._built = true;
    this._els = {};
    const card = document.createElement("ha-card");

    let lines = "", balls = "";
    for (const [id, from, s, c, e] of PF_FLOWS) {
      const color = this._color(from);
      const d = `M${s[0]},${s[1]} Q${c[0]},${c[1]} ${e[0]},${e[1]}`;
      lines += `<path class="pf-base" d="${d}"/>`;
      balls += `<g class="pf-ball" data-id="${id}" style="display:none">
        <circle r="5.5" fill="${color}" style="filter:drop-shadow(0 0 3px ${color})"/>
        <animateMotion data-id="${id}" dur="1.6s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1" keyTimes="0;1" path="${d}"/>
      </g>`;
    }

    const S = PF_NODES.solar, G = PF_NODES.grid, H = PF_NODES.home, B = PF_NODES.battery;
    const gc = this._color("grid"), bc = this._color("battery"), sc = this._color("solar"), hc = this._color("home");
    const muted = "var(--secondary-text-color)";

    const solarNode = `<g>
      <circle cx="${S.x}" cy="${S.y}" r="${S.r}" fill="var(--card-background-color)" stroke="${sc}" stroke-width="2.5"/>
      ${pfIcon(S.x, S.y - 13, "solar", sc)}
      <text class="pf-val" data-el="solar" x="${S.x}" y="${S.y + 16}" text-anchor="middle">—</text>
    </g>`;

    const homeNode = `<g>
      <circle cx="${H.x}" cy="${H.y}" r="${H.r}" fill="var(--card-background-color)"/>
      <g class="pf-ring"></g>
      ${pfIcon(H.x, H.y - 15, "home", hc)}
      <text class="pf-val" data-el="home_total" x="${H.x}" y="${H.y + 6}" text-anchor="middle">—</text>
      <text class="pf-io" style="fill:${muted}" data-el="home_power" x="${H.x}" y="${H.y + 21}" text-anchor="middle">—</text>
    </g>`;

    const gridNode = `<g>
      <circle cx="${G.x}" cy="${G.y}" r="${G.r}" fill="var(--card-background-color)" stroke="${gc}" stroke-width="2.5"/>
      ${pfIcon(G.x, G.y - 20, "grid", gc)}
      <text class="pf-io" style="fill:${muted}" data-el="grid_in" x="${G.x}" y="${G.y + 3}" text-anchor="middle">—</text>
      <text class="pf-io" style="fill:${gc}" data-el="grid_out" x="${G.x}" y="${G.y + 20}" text-anchor="middle">—</text>
    </g>`;

    const batNode = `<g>
      <circle cx="${B.x}" cy="${B.y}" r="${B.r}" fill="var(--card-background-color)" stroke="${bc}" stroke-width="2.5"/>
      ${pfIcon(B.x, B.y - 20, "battery", bc)}
      <text class="pf-io" style="fill:${bc}" data-el="bat_out" x="${B.x}" y="${B.y + 3}" text-anchor="middle">—</text>
      <text class="pf-io" style="fill:${muted}" data-el="bat_in" x="${B.x}" y="${B.y + 20}" text-anchor="middle">—</text>
    </g>`;

    const labels = [S, G, H, B].map((n) => this._nodeLabel(n)).join("");

    card.innerHTML = `
      <style>${EBillingPowerFlow.styles}</style>
      <div class="pf-wrap">
        ${this._config.title ? `<div class="pf-title">${this._esc(this._config.title)}</div>` : ""}
        <svg viewBox="0 0 400 408" class="pf-svg">
          ${lines}
          ${balls}
          ${solarNode}${gridNode}${batNode}${homeNode}
          ${labels}
          <g class="pf-tip" style="display:none"></g>
        </svg>
      </div>`;
    this.innerHTML = "";
    this.appendChild(card);

    for (const [id] of PF_FLOWS) {
      this._els[`ball_${id}`] = card.querySelector(`.pf-ball[data-id="${id}"]`);
      this._els[`anim_${id}`] = card.querySelector(`animateMotion[data-id="${id}"]`);
    }
    card.querySelectorAll("[data-el]").forEach((el) => { if (el.dataset.el) this._els[el.dataset.el] = el; });
    this._els.ring = card.querySelector(".pf-ring");
    this._els.tip = card.querySelector(".pf-tip");

    card.addEventListener("click", (e) => {
      const seg = e.target.closest(".pf-seg");
      if (!seg) { this._hideTip(); return; }
      if (this._tipSrc === seg.dataset.key) this._hideTip();
      else this._setTip(seg.dataset);
    });
  }

  _esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }
}

EBillingPowerFlow.styles = `
  .pf-wrap { padding: 14px 12px 12px; }
  .pf-title { font-size: 1.1rem; font-weight: 600; color: var(--primary-text-color); padding: 2px 6px 8px; }
  .pf-svg { width: 100%; height: auto; max-width: 460px; display: block; margin: 0 auto; }
  .pf-base { fill: none; stroke: var(--primary-text-color); opacity: 0.14; stroke-width: 2.5; stroke-linecap: round; }
  .pf-val { fill: var(--primary-text-color); font-size: 14px; font-weight: 700; font-family: inherit; }
  .pf-io { font-size: 11px; font-weight: 600; font-family: inherit; }
  .pf-lbl { fill: var(--secondary-text-color); font-size: 12px; font-family: inherit; }
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
    const power = this._sensorsBy("power"), energy = this._sensorsBy("energy"), percent = this._sensorsBy("percent");
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

console.info("%c eBilling-power-flow %c v0.11 ", "background:#f6a609;color:#000;border-radius:3px 0 0 3px;padding:2px 4px", "background:#12b886;color:#fff;border-radius:0 3px 3px 0;padding:2px 4px");

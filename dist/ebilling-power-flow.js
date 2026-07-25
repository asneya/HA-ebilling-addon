/*
 * eBilling Power Flow — tarjeta Lovelace de flujo de energía fotovoltaica
 *
 * Layout en cruz (Solar arriba · Red izq. · Casa der. · Batería abajo) con
 * enrutado ortogonal de esquinas redondeadas, una bola por línea, líneas
 * activas coloreadas, valores por línea, anillo de reparto diario en la casa
 * con tooltip, e iconos vectoriales (la batería refleja su nivel de carga).
 *
 * Instalación:
 *   - HACS: recurso /hacsfiles/HA-ebilling-addon/ebilling-power-flow.js
 *   - Manual: copia a /config/www/ y añade /local/ebilling-power-flow.js
 */

// Todo el módulo va dentro de un IIFE: al cargarse como recurso Lovelace
// (script clásico) las constantes de nivel superior irían al ámbito global y
// podrían colisionar con otras tarjetas.
(() => {
"use strict";

// El color de la casa por defecto es neutro (hereda el color de texto del
// tema), como en las apps de inversores; el resto son propios de cada fuente.
const PF_DEFAULT_COLORS = { solar: "#f5a524", grid: "#6b8afd", battery: "#10b981", home: null };
const PF_NEUTRAL = "var(--primary-text-color)";

/* ---------------------------- geometría ---------------------------- */
// viewBox 400x420. Nodos en los puntos medios de un cuadrado.
const R = 46;                 // radio del nodo
const CX = 200, CY = 212;     // centro del diagrama
const LANE = 18;              // separación de carriles paralelos
const CORNER = 16;            // radio de la esquina redondeada
const EXT = Math.sqrt(R * R - LANE * LANE); // 42.33 → punto de anclaje al círculo

const PF_NODES = {
  solar: { x: CX, y: 76, label: "Solar", labelAbove: true },
  grid: { x: 76, y: CY, label: "Red" },
  home: { x: 324, y: CY, label: "Casa" },
  battery: { x: CX, y: 348, label: "Batería" },
};

const LANE_TOP = CY - LANE, LANE_BOTTOM = CY + LANE;
const LANE_LEFT = CX - LANE, LANE_RIGHT = CX + LANE;
const S = PF_NODES.solar, G = PF_NODES.grid, H = PF_NODES.home, B = PF_NODES.battery;

// id, nodo de origen (da el color), path, [x,y] de la etiqueta de valor
const PF_FLOWS = [
  // rectas por el centro
  ["solar_battery", "solar", `M${CX},${S.y + R} V${B.y - R}`, [CX, 162]],
  ["grid_home", "grid", `M${G.x + R},${CY} H${H.x - R}`, [252, 206]],
  // esquinas: salen en vertical del nodo, giran y entran en horizontal
  ["solar_grid", "solar",
    `M${LANE_LEFT},${S.y + EXT} V${LANE_TOP - CORNER} Q${LANE_LEFT},${LANE_TOP} ${LANE_LEFT - CORNER},${LANE_TOP} H${G.x + EXT}`,
    [142, LANE_TOP - 8]],
  ["solar_home", "solar",
    `M${LANE_RIGHT},${S.y + EXT} V${LANE_TOP - CORNER} Q${LANE_RIGHT},${LANE_TOP} ${LANE_RIGHT + CORNER},${LANE_TOP} H${H.x - EXT}`,
    [258, LANE_TOP - 8]],
  ["grid_battery", "grid",
    `M${G.x + EXT},${LANE_BOTTOM} H${LANE_LEFT - CORNER} Q${LANE_LEFT},${LANE_BOTTOM} ${LANE_LEFT},${LANE_BOTTOM + CORNER} V${B.y - EXT}`,
    [142, LANE_BOTTOM + 15]],
  ["battery_home", "battery",
    `M${LANE_RIGHT},${B.y - EXT} V${LANE_BOTTOM + CORNER} Q${LANE_RIGHT},${LANE_BOTTOM} ${LANE_RIGHT + CORNER},${LANE_BOTTOM} H${H.x - EXT}`,
    [258, LANE_BOTTOM + 15]],
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

/* ---------------------------- utilidades ---------------------------- */

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

// Iconos 24×24 centrados exactamente en (cx, cy).
function pfIcon(cx, cy, type, color, scale = 1) {
  const s = scale;
  const open = `<g transform="translate(${(cx - 12 * s).toFixed(2)},${(cy - 12 * s).toFixed(2)}) scale(${s})" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">`;
  if (type === "solar") {
    // Panel inclinado con retícula.
    return open + `
      <path d="M4.5,16.5 L8.2,7.5 H20 L17,16.5 Z"/>
      <path d="M12.2,7.5 L9.6,16.5 M16.1,7.5 L13.3,16.5"/>
      <path d="M6.6,12 H18.6"/>
      <path d="M11,16.5 V19.5 M8.5,19.5 H13.5"/>
    </g>`;
  }
  if (type === "grid") {
    // Torre de alta tensión.
    return open + `
      <path d="M9.2,4.5 H14.8"/>
      <path d="M12,4.5 L6.6,19.5 M12,4.5 L17.4,19.5"/>
      <path d="M9.9,10.4 H14.1 M8.8,13.8 H15.2 M7.7,17 H16.3"/>
    </g>`;
  }
  if (type === "battery") {
    // Celda vertical; el relleno refleja el estado de carga (data-el).
    return open + `
      <path d="M10.2,3.6 H13.8"/>
      <rect x="7.8" y="5.4" width="8.4" height="14.6" rx="1.8"/>
      <rect data-el="bat_fill" x="9.3" y="18.5" width="5.4" height="0" rx="0.9" fill="${color}" stroke="none"/>
    </g>`;
  }
  // Casa (silueta rellena).
  return `<g transform="translate(${(cx - 12 * s).toFixed(2)},${(cy - 12 * s).toFixed(2)}) scale(${s})">
    <path d="M12,4.2 L21,12.4 h-2.6 V20 H5.6 V12.4 H3 Z" fill="${color}"/>
  </g>`;
}

/* ---------------------------- tarjeta ---------------------------- */

class EBillingPowerFlow extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign({ title: "Flujo de energía", entities: {}, colors: {} }, config || {});
    this._built = false;
    this._dur = {};
    this._lastWrite = 0;
  }
  set hass(hass) { this._hass = hass; this._update(); }
  getCardSize() { return 8; }
  static getStubConfig() { return { title: "Flujo de energía", entities: {}, colors: {} }; }
  static getConfigElement() { return document.createElement("ebilling-power-flow-editor"); }

  _color(key) {
    const c = (this._config.colors || {})[key];
    if (c) return c;
    return PF_DEFAULT_COLORS[key] || PF_NEUTRAL;
  }

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

  // Integración aproximada del consumo por fuente (respaldo si no hay
  // sensores de energía). Se persiste como máximo cada 30 s.
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
    if (now - this._lastWrite > 30000) {
      this._lastWrite = now;
      try { localStorage.setItem("ebilling_pf_daily", JSON.stringify(d)); } catch (_) { /* noop */ }
    }
    this._mem = d;
    return d;
  }

  _configured() {
    const e = this._config.entities || {};
    return Object.keys(e).some((k) => e[k]);
  }

  _update() {
    if (!this._hass || !this._config) return;
    if (!this._built) this._build();
    const E = this._els;
    if (E.hint) E.hint.style.display = this._configured() ? "none" : "";

    const f = this._flows();
    const mix = this._energyMix() || this._accumulate(f.values);
    const io = (v, energy) => (energy ? pfEnergyFmt(v) : pfFmt(v));

    if (E.solar) E.solar.textContent = pfFmt(f.solar);

    const homeTotal = (mix.solar || 0) + (mix.grid || 0) + (mix.battery || 0);
    if (E.home_total) E.home_total.textContent = pfEnergyFmt(homeTotal);
    if (E.home_power) E.home_power.textContent = pfFmt(f.home);

    const g = this._inOut("grid_export_energy", "grid_import_energy", "grid_export", "grid_import");
    if (E.grid_in) E.grid_in.textContent = `← ${io(g.feedin, g.energy)}`;
    if (E.grid_out) E.grid_out.textContent = `→ ${io(g.tohome, g.energy)}`;

    // La descarga sale de la batería (flecha arriba) y la carga entra (abajo).
    const b = this._inOut("battery_charge_energy", "battery_discharge_energy", "battery_charge", "battery_discharge");
    if (E.bat_out) E.bat_out.textContent = `↑ ${io(b.tohome, b.energy)}`;
    if (E.bat_in) E.bat_in.textContent = `↓ ${io(b.feedin, b.energy)}`;

    // Nivel de carga dibujado dentro del icono de la batería.
    const soc = this._watts("battery_soc");
    if (E.sub_battery) E.sub_battery.textContent = soc != null ? `Batería · ${Math.round(soc)}%` : "Batería";
    if (E.bat_fill) {
      const pct = soc != null ? Math.max(0, Math.min(100, soc)) : 0;
      const h = (12.6 * pct) / 100;
      E.bat_fill.setAttribute("height", h.toFixed(2));
      E.bat_fill.setAttribute("y", (18.5 - h).toFixed(2));
    }

    // Líneas: colorear las activas y mover su bola; etiqueta con el valor.
    const THRESH = 5;
    for (const [id] of PF_FLOWS) {
      const w = f.values[id] || 0;
      const on = w > THRESH;
      const live = E[`live_${id}`], ball = E[`ball_${id}`], lbl = E[`label_${id}`];
      if (live) live.style.opacity = on ? "0.5" : "0";
      if (ball) ball.style.display = on ? "" : "none";
      if (lbl) { lbl.style.display = on ? "" : "none"; if (on) lbl.textContent = pfFmt(w); }
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

    if (E.svg) {
      E.svg.setAttribute(
        "aria-label",
        `Solar ${pfFmt(f.solar)}. Casa ${pfFmt(f.home)} ahora, ${pfEnergyFmt(homeTotal)} hoy. ` +
        `Red: ${io(g.feedin, g.energy)} exportada, ${io(g.tohome, g.energy)} importada. ` +
        `Batería: ${io(b.feedin, b.energy)} carga, ${io(b.tohome, b.energy)} descarga.`
      );
    }
  }

  _renderRing(mix) {
    const el = this._els.ring;
    if (!el) return;
    const parts = [
      ["solar", "Solar", mix.solar, this._color("solar")],
      ["grid", "Red", mix.grid, this._color("grid")],
      ["battery", "Batería", mix.battery, this._color("battery")],
    ].filter((p) => p[2] > 0);
    const total = parts.reduce((s, p) => s + p[2], 0);
    let svg = `<circle cx="${H.x}" cy="${H.y}" r="${R}" fill="none" stroke="${PF_NEUTRAL}" stroke-opacity="0.14" stroke-width="5"/>`;
    if (total > 0) {
      const gap = parts.length > 1 ? 5 : 0;
      let ang = 0;
      for (const [key, name, val, color] of parts) {
        const span = (val / total) * 360;
        const mid = ang + span / 2;
        const a0 = ang + gap / 2, a1 = ang + span - gap / 2;
        if (a1 > a0) {
          const [x0, y0] = pfPolar(H.x, H.y, R, a0);
          const [x1, y1] = pfPolar(H.x, H.y, R, a1);
          const large = a1 - a0 > 180 ? 1 : 0;
          const pct = Math.round((val / total) * 100);
          const d = `M${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
          const ds = `data-key="${key}" data-name="${name}" data-val="${val.toFixed(0)}" data-pct="${pct}" data-mid="${mid.toFixed(1)}"`;
          svg += `<path d="${d}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" pointer-events="none"/>`;
          // Camino invisible más grueso: área de pulsación cómoda en móvil.
          svg += `<path class="pf-seg" ${ds} d="${d}" fill="none" stroke="transparent" stroke-width="20" stroke-linecap="butt" tabindex="0" role="button" aria-label="${name}: ${pfEnergyFmt(val)}, ${pct}%"><title>${name}: ${pfEnergyFmt(val)} (${pct}%)</title></path>`;
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
    const [px, py] = pfPolar(H.x, H.y, R + 26, parseFloat(ds.mid));
    const text = `${ds.name} · ${pfEnergyFmt(parseFloat(ds.val))} · ${ds.pct}%`;
    const w = text.length * 6.2 + 18, h = 24;
    const x = Math.max(6, Math.min(400 - w - 6, px - w / 2));
    const y = Math.max(6, Math.min(420 - h - 6, py - 12));
    tip.innerHTML =
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="7" fill="${PF_NEUTRAL}"/>` +
      `<text x="${(x + w / 2).toFixed(1)}" y="${(y + 16).toFixed(1)}" text-anchor="middle" fill="var(--card-background-color)" font-size="11.5" font-weight="600" font-family="inherit">${this._esc(text)}</text>`;
    tip.style.display = "";
  }
  _hideTip() { this._tipSrc = null; if (this._els.tip) this._els.tip.style.display = "none"; }

  _build() {
    this._built = true;
    this._els = {};
    const card = document.createElement("ha-card");
    const sc = this._color("solar"), gc = this._color("grid"), bc = this._color("battery"), hc = this._color("home");
    const muted = "var(--secondary-text-color)";

    let lines = "", balls = "", labels = "";
    for (const [id, from, d, pos] of PF_FLOWS) {
      const color = this._color(from);
      lines += `<path class="pf-base" d="${d}"/>`;
      lines += `<path class="pf-live" data-el="live_${id}" d="${d}" stroke="${color}"/>`;
      balls += `<g data-el="ball_${id}" style="display:none">
        <circle r="5" fill="${color}" style="filter:drop-shadow(0 0 3px ${color})"/>
        <animateMotion data-el="anim_${id}" dur="1.6s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1" keyTimes="0;1" path="${d}"/>
      </g>`;
      labels += `<text class="pf-flowval" data-el="label_${id}" x="${pos[0]}" y="${pos[1]}" text-anchor="middle" style="display:none"></text>`;
    }

    const nodes = `
      <g>
        <circle cx="${S.x}" cy="${S.y}" r="${R}" fill="var(--card-background-color)" stroke="${sc}" stroke-width="2.5"/>
        ${pfIcon(S.x, S.y - 12, "solar", sc, 1.05)}
        <text class="pf-val" data-el="solar" x="${S.x}" y="${S.y + 19}" text-anchor="middle">—</text>
      </g>
      <g>
        <circle cx="${G.x}" cy="${G.y}" r="${R}" fill="var(--card-background-color)" stroke="${gc}" stroke-width="2.5"/>
        ${pfIcon(G.x, G.y - 19, "grid", gc, 0.95)}
        <text class="pf-io" style="fill:${muted}" data-el="grid_in" x="${G.x}" y="${G.y + 6}" text-anchor="middle">—</text>
        <text class="pf-io" style="fill:${gc}" data-el="grid_out" x="${G.x}" y="${G.y + 22}" text-anchor="middle">—</text>
      </g>
      <g>
        <circle cx="${B.x}" cy="${B.y}" r="${R}" fill="var(--card-background-color)" stroke="${bc}" stroke-width="2.5"/>
        ${pfIcon(B.x, B.y - 19, "battery", bc, 0.95)}
        <text class="pf-io" style="fill:var(--error-color, #e5484d)" data-el="bat_out" x="${B.x}" y="${B.y + 6}" text-anchor="middle">—</text>
        <text class="pf-io" style="fill:${bc}" data-el="bat_in" x="${B.x}" y="${B.y + 22}" text-anchor="middle">—</text>
      </g>
      <g>
        <circle cx="${H.x}" cy="${H.y}" r="${R}" fill="var(--card-background-color)"/>
        <g class="pf-ring"></g>
        ${pfIcon(H.x, H.y - 16, "home", hc, 0.95)}
        <text class="pf-val" data-el="home_power" x="${H.x}" y="${H.y + 9}" text-anchor="middle">—</text>
        <text class="pf-io" style="fill:${muted}" data-el="home_total" x="${H.x}" y="${H.y + 24}" text-anchor="middle">—</text>
      </g>`;

    const nodeLabels = [S, G, H, B].map((n) => {
      const y = n.labelAbove ? n.y - R - 11 : n.y + R + 20;
      const attr = n === B ? ` data-el="sub_battery"` : "";
      return `<text class="pf-lbl"${attr} x="${n.x}" y="${y}" text-anchor="middle">${n.label}</text>`;
    }).join("");

    card.innerHTML = `
      <style>${EBillingPowerFlow.styles}</style>
      <div class="pf-wrap">
        ${this._config.title ? `<div class="pf-title">${this._esc(this._config.title)}</div>` : ""}
        <svg data-el="svg" viewBox="0 0 400 420" class="pf-svg" role="img">
          ${lines}
          ${balls}
          ${nodes}
          ${labels}
          ${nodeLabels}
          <g class="pf-tip" style="display:none"></g>
        </svg>
        <div class="pf-hint" data-el="hint" style="display:none">
          Asigna tus sensores de potencia en la configuración de la tarjeta.
        </div>
      </div>`;
    this.innerHTML = "";
    this.appendChild(card);

    card.querySelectorAll("[data-el]").forEach((el) => { if (el.dataset.el) this._els[el.dataset.el] = el; });
    this._els.ring = card.querySelector(".pf-ring");
    this._els.tip = card.querySelector(".pf-tip");

    const toggle = (seg) => {
      if (!seg) { this._hideTip(); return; }
      if (this._tipSrc === seg.dataset.key) this._hideTip();
      else this._setTip(seg.dataset);
    };
    card.addEventListener("click", (e) => toggle(e.target.closest(".pf-seg")));
    card.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const seg = e.target.closest && e.target.closest(".pf-seg");
      if (seg) { e.preventDefault(); toggle(seg); }
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
  .pf-title { font-size: 1.1rem; font-weight: 600; color: var(--primary-text-color); padding: 2px 6px 6px; }
  .pf-svg { width: 100%; height: auto; max-width: 470px; display: block; margin: 0 auto;
            font-variant-numeric: tabular-nums; }
  .pf-base { fill: none; stroke: var(--primary-text-color); opacity: 0.13; stroke-width: 2.5; stroke-linecap: round; }
  .pf-live { fill: none; stroke-width: 2.5; stroke-linecap: round; opacity: 0; transition: opacity .4s ease; }
  .pf-val { fill: var(--primary-text-color); font-size: 15px; font-weight: 700; font-family: inherit; }
  .pf-io { font-size: 11.5px; font-weight: 600; font-family: inherit; }
  .pf-lbl { fill: var(--secondary-text-color); font-size: 12px; font-family: inherit; }
  .pf-flowval {
    fill: var(--secondary-text-color); font-size: 10.5px; font-weight: 600; font-family: inherit;
    paint-order: stroke; stroke: var(--card-background-color); stroke-width: 3.5px; stroke-linejoin: round;
  }
  .pf-seg:focus { outline: none; }
  .pf-seg:focus-visible { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px; }
  .pf-hint { font-size: 12px; color: var(--secondary-text-color); text-align: center; padding: 4px 10px 2px; }
  @media (prefers-reduced-motion: reduce) { animateMotion { display: none; } }
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
      <div class="pfe-color"><input type="color" data-color="${key}" value="${(this._config.colors || {})[key] || PF_DEFAULT_COLORS[key] || "#9aa3b5"}"><span>${label}</span></div>`;

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
        <div class="pfe-note">Opcional. Si los defines, el anillo y los totales usan estos valores del día; si no, se calculan de forma aproximada.</div>
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

// Evita redefinir si el recurso se carga dos veces (caché/HACS + manual).
if (!customElements.get("ebilling-power-flow")) {
  customElements.define("ebilling-power-flow", EBillingPowerFlow);
  customElements.define("ebilling-power-flow-editor", EBillingPowerFlowEditor);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "ebilling-power-flow",
    name: "eBilling — Flujo de energía",
    description: "Diagrama animado del flujo de potencia entre solar, red, batería y casa.",
    preview: true,
  });

  console.info("%c eBilling-power-flow %c v0.14 ", "background:#f5a524;color:#000;border-radius:3px 0 0 3px;padding:2px 4px", "background:#10b981;color:#fff;border-radius:0 3px 3px 0;padding:2px 4px");
}

})();

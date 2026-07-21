/*
 * eBilling Card — tarjeta Lovelace para Home Assistant
 * Comparativa de tarifas del add-on eBilling.
 *
 * Instalación:
 *   1. Copia este archivo a /config/www/ebilling-card.js
 *   2. Ajustes → Paneles → (⋮) Recursos → Añadir recurso:
 *        URL: /local/ebilling-card.js   ·   Tipo: Módulo de JavaScript
 *   3. Añade la tarjeta a tu panel:
 *        type: custom:ebilling-card
 *
 * Configuración (todo opcional; por defecto descubre los sensores solos):
 *   type: custom:ebilling-card
 *   title: Comparativa de tarifas        # encabezado
 *   mode: cycle                          # cycle (acumulado) | projection (fin de ciclo)
 *   entities:                            # forzar tarifas concretas (por sus sensores de coste)
 *     - sensor.ebilling_plan_estable_coste_ciclo
 */

const PALETTE_LIGHT = [
  "#2a78d6", "#eb6834", "#1baf7a", "#eda100",
  "#e87ba4", "#008300", "#4a3aa7", "#e34948",
];
const PALETTE_DARK = [
  "#3987e5", "#d95926", "#199e70", "#c98500",
  "#d55181", "#008300", "#9085e9", "#e66767",
];

const eur = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const eur4 = new Intl.NumberFormat("es-ES", {
  style: "currency", currency: "EUR", minimumFractionDigits: 4, maximumFractionDigits: 4,
});
const num = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });

class EBillingCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    this._mode = this._config.mode === "projection" ? "projection" : "cycle";
    this._built = false;
    this._lastSig = null;
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  getCardSize() {
    return 3 + (this._tariffCount || 2);
  }

  static getStubConfig() {
    return { title: "Comparativa de tarifas" };
  }

  /* -------------------- descubrimiento de datos -------------------- */

  _collect() {
    const states = this._hass.states;
    const explicit = this._config.entities;
    const slugs = [];

    if (Array.isArray(explicit) && explicit.length) {
      for (const id of explicit) {
        const m = /^sensor\.ebilling_(.+)_coste_ciclo$/.exec(id);
        if (m) slugs.push(m[1]);
      }
    } else {
      for (const id of Object.keys(states)) {
        const m = /^sensor\.ebilling_(.+)_coste_ciclo$/.exec(id);
        if (m) slugs.push(m[1]);
      }
    }

    const dark = this._isDark();
    const palette = dark ? PALETTE_DARK : PALETTE_LIGHT;
    const tariffs = [];
    let period = null;

    slugs.forEach((slug, idx) => {
      const cost = states[`sensor.ebilling_${slug}_coste_ciclo`];
      if (!cost) return;
      const a = cost.attributes || {};
      const priceEnt = states[`sensor.ebilling_${slug}_precio`];
      const projEnt = states[`sensor.ebilling_${slug}_proyeccion`];
      const surplusEnt = states[`sensor.ebilling_${slug}_precio_excedente`];
      if (!period && a.ciclo_inicio) period = { start: a.ciclo_inicio, end: a.ciclo_fin };
      tariffs.push({
        slug,
        name: a.tarifa || slug.replace(/_/g, " "),
        company: a.compania || "",
        color: a.color || palette[idx % palette.length],
        cost: Number(cost.state),
        projection: projEnt ? Number(projEnt.state) : null,
        price: priceEnt && priceEnt.state !== "unknown" ? Number(priceEnt.state) : null,
        tramo: priceEnt ? priceEnt.attributes.tramo : null,
        surplus: surplusEnt && surplusEnt.state !== "unknown" ? Number(surplusEnt.state) : null,
        kwh: a.kwh_ciclo != null ? Number(a.kwh_ciclo) : null,
      });
    });

    tariffs.sort((x, y) => this._value(x) - this._value(y));

    const savingSensor = states["sensor.ebilling_ahorro_potencial"];
    const cheapest = tariffs.length ? this._value(tariffs[0]) : 0;
    const dearest = tariffs.length ? this._value(tariffs[tariffs.length - 1]) : 0;
    // El ahorro se calcula sobre el modo mostrado (acumulado o proyección);
    // el sensor global solo se usa como respaldo si no hay tarifas locales.
    let saving = dearest - cheapest;
    if (!tariffs.length && savingSensor && savingSensor.state !== "unknown") {
      saving = Number(savingSensor.state);
    }

    return {
      tariffs,
      period,
      best: tariffs[0] ? tariffs[0].name : "—",
      saving,
    };
  }

  _value(t) {
    return this._mode === "projection" && t.projection != null ? t.projection : t.cost;
  }

  _isDark() {
    if (this._hass && this._hass.themes && typeof this._hass.themes.darkMode === "boolean") {
      return this._hass.themes.darkMode;
    }
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  /* -------------------- render -------------------- */

  _update() {
    if (!this._hass) return;
    const data = this._collect();
    this._tariffCount = data.tariffs.length;

    // Solo re-renderiza cuando cambian los valores relevantes.
    const sig = JSON.stringify([this._mode, this._isDark(), data.tariffs, data.best, data.saving]);
    if (sig === this._lastSig) return;
    this._lastSig = sig;

    if (!this._built) this._build();

    if (!data.tariffs.length) {
      this._hero.innerHTML = "";
      this._rows.innerHTML = `
        <div class="empty">
          <div class="empty-icon">⚡</div>
          <p>No se han encontrado sensores de eBilling.</p>
          <p class="hint">Activa <b>Publicar sensores</b> en el add-on eBilling
          (Ajustes) y espera al primer ciclo de actualización.</p>
        </div>`;
      this._headerSub.textContent = "";
      return;
    }

    const projected = this._mode === "projection";
    const max = Math.max(...data.tariffs.map((t) => this._value(t)), 0.01);
    const cheapest = this._value(data.tariffs[0]);

    this._headerSub.textContent = data.period ? this._periodLabel(data.period) : "";

    // Tiles superiores
    this._hero.innerHTML = `
      <div class="tile">
        <div class="tile-label">Mejor tarifa</div>
        <div class="tile-value">${this._esc(data.best || "—")}</div>
        <div class="tile-sub">${eur.format(cheapest)} ${projected ? "estim. ciclo" : "acumulado"}</div>
      </div>
      <div class="tile accent">
        <div class="tile-label">Ahorro potencial</div>
        <div class="tile-value">${eur.format(data.saving || 0)}</div>
        <div class="tile-sub">frente a la más cara</div>
      </div>`;

    // Filas de tarifas
    this._rows.innerHTML = data.tariffs
      .map((t, i) => {
        const value = this._value(t);
        const extra = value - cheapest;
        const width = Math.max((value / max) * 100, 2);
        const best = i === 0;
        const priceLine = t.price != null
          ? `<span class="chip">${eur4.format(t.price)}/kWh${t.tramo ? " · " + this._esc(t.tramo) : ""}</span>`
          : "";
        const surplusLine = t.surplus != null && t.surplus > 0
          ? `<span class="chip solar">☀ ${eur4.format(t.surplus)}/kWh</span>`
          : "";
        const other = projected ? t.cost : t.projection;
        const otherLabel = projected
          ? (t.cost != null ? `acumulado ${eur.format(t.cost)}` : "")
          : (t.projection != null ? `proyección ${eur.format(t.projection)}` : "");
        const tip = [
          `${t.name}${t.company ? " · " + t.company : ""}`,
          `${projected ? "Proyección" : "Acumulado"}: ${eur.format(value)}`,
          otherLabel,
          t.kwh != null ? `${num.format(t.kwh)} kWh` : "",
          extra > 0 ? `+${eur.format(extra)} vs. mejor` : "más barata",
        ].filter(Boolean).join("\n");

        return `
        <div class="row ${best ? "best" : ""}" title="${this._esc(tip)}">
          <div class="row-head">
            <span class="dot" style="background:${this._esc(t.color)}"></span>
            <div class="row-id">
              <div class="row-name">${this._esc(t.name)}
                ${best ? '<span class="badge best">✓ más barata</span>' : `<span class="badge">+${eur.format(extra)}</span>`}
              </div>
              <div class="row-meta">${this._esc(t.company || "")} ${priceLine} ${surplusLine}</div>
            </div>
            <div class="row-amount">
              <div class="amount">${eur.format(value)}</div>
              <div class="amount-sub">${this._esc(otherLabel)}</div>
            </div>
          </div>
          <div class="track">
            <div class="bar" style="width:${width}%;background:${this._esc(t.color)}"></div>
          </div>
        </div>`;
      })
      .join("");
  }

  _periodLabel(period) {
    const fmt = (iso) => {
      const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-ES", {
        day: "numeric", month: "short", timeZone: "UTC",
      });
    };
    try { return `${fmt(period.start)} — ${fmt(period.end)}`; } catch (_) { return ""; }
  }

  _build() {
    this._built = true;
    const card = document.createElement("ha-card");
    card.innerHTML = `
      <style>${EBillingCard.styles}</style>
      <div class="wrap">
        <div class="header">
          <div>
            <div class="header-title">${this._esc(this._config.title || "Comparativa de tarifas")}</div>
            <div class="header-sub"></div>
          </div>
          <div class="mode-toggle" role="tablist">
            <button data-mode="cycle" class="${this._mode === "cycle" ? "on" : ""}">Acumulado</button>
            <button data-mode="projection" class="${this._mode === "projection" ? "on" : ""}">Fin de ciclo</button>
          </div>
        </div>
        <div class="hero"></div>
        <div class="body"><div class="rows"></div></div>
      </div>`;
    this.innerHTML = "";
    this.appendChild(card);
    this._headerSub = card.querySelector(".header-sub");
    this._hero = card.querySelector(".hero");
    this._body = card.querySelector(".body");
    this._rows = card.querySelector(".rows");

    card.querySelectorAll(".mode-toggle button").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._mode = btn.dataset.mode;
        card.querySelectorAll(".mode-toggle button").forEach((b) =>
          b.classList.toggle("on", b.dataset.mode === this._mode)
        );
        this._lastSig = null;
        this._update();
      });
    });
  }

  _esc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }
}

EBillingCard.styles = `
  .wrap { padding: 16px; }
  .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .header-title { font-size: 1.15rem; font-weight: 600; color: var(--primary-text-color); }
  .header-sub { font-size: 0.8rem; color: var(--secondary-text-color); margin-top: 2px; }
  .mode-toggle { display: inline-flex; background: var(--secondary-background-color); border-radius: 999px; padding: 3px; }
  .mode-toggle button {
    border: 0; background: transparent; color: var(--secondary-text-color);
    font: inherit; font-size: 0.78rem; font-weight: 600; padding: 5px 12px;
    border-radius: 999px; cursor: pointer; white-space: nowrap;
  }
  .mode-toggle button.on { background: var(--card-background-color); color: var(--primary-text-color); box-shadow: 0 1px 3px rgba(0,0,0,.12); }

  .hero { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
  .tile { background: var(--secondary-background-color); border-radius: 12px; padding: 12px 14px; }
  .tile-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--secondary-text-color); }
  .tile-value { font-size: 1.25rem; font-weight: 700; color: var(--primary-text-color); margin-top: 3px; line-height: 1.15; }
  .tile-sub { font-size: 0.75rem; color: var(--secondary-text-color); margin-top: 2px; }
  .tile.accent .tile-value { color: var(--success-color, #0ca678); }

  .rows { display: flex; flex-direction: column; gap: 14px; }
  .row { }
  .row-head { display: flex; align-items: center; gap: 10px; }
  .dot { width: 12px; height: 12px; border-radius: 4px; flex: 0 0 auto; }
  .row-id { flex: 1 1 auto; min-width: 0; }
  .row-name { font-size: 0.95rem; font-weight: 600; color: var(--primary-text-color); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .row-meta { font-size: 0.75rem; color: var(--secondary-text-color); margin-top: 2px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .row-amount { text-align: right; flex: 0 0 auto; }
  .amount { font-size: 1.05rem; font-weight: 700; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
  .amount-sub { font-size: 0.72rem; color: var(--secondary-text-color); }

  .badge { font-size: 0.68rem; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .badge.best { background: color-mix(in srgb, var(--success-color, #0ca678) 18%, transparent); color: var(--success-color, #0ca678); }

  .chip { font-size: 0.72rem; padding: 1px 7px; border-radius: 6px; background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .chip.solar { color: var(--warning-color, #f59f00); }

  .track { height: 8px; border-radius: 5px; margin-top: 8px; background: color-mix(in srgb, var(--primary-text-color) 8%, transparent); overflow: hidden; }
  .bar { height: 100%; border-radius: 5px; min-width: 4px; transition: width .4s ease; }
  .row.best .track { background: color-mix(in srgb, var(--success-color, #0ca678) 12%, transparent); }

  .empty { text-align: center; padding: 24px 10px; color: var(--secondary-text-color); }
  .empty-icon { font-size: 2rem; }
  .empty .hint { font-size: 0.8rem; }
  a { color: var(--primary-color); }

  @media (max-width: 420px) {
    .hero { grid-template-columns: 1fr; }
    .amount { font-size: 1rem; }
  }
`;

customElements.define("ebilling-card", EBillingCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ebilling-card",
  name: "eBilling — Comparativa de tarifas",
  description: "Compara en tiempo real el coste de tus tarifas eléctricas (add-on eBilling).",
  preview: true,
});

console.info("%c eBilling-card %c cargada ", "background:#4a6cf7;color:#fff;border-radius:3px 0 0 3px;padding:2px 4px", "background:#00a443;color:#fff;border-radius:0 3px 3px 0;padding:2px 4px");

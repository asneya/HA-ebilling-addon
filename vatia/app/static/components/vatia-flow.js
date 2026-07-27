/*
 * <vatia-flow> — el «caudal» en tiempo real.
 *
 * Sustituye al diagrama de nodos por un Sankey: el ancho de cada corriente es
 * su potencia, con los orígenes a la izquierda (sol, batería, red) y los
 * destinos a la derecha (casa, batería, red). Es la pieza central del rediseño
 * y la primera escrita como componente web: el estilo va encapsulado, no
 * depende de la página que lo aloje y sirve igual dentro del add-on que en una
 * app independiente.
 *
 * Uso:
 *   const flow = document.createElement('vatia-flow');
 *   flow.data = payload;            // el objeto de /api/live tal cual
 *
 * Los colores salen de los tokens del tema por `var()`, que atraviesa la
 * frontera del shadow DOM: al cambiar de tema se repinta solo, sin JS.
 */
(() => {
  "use strict";

  // Geometría del prototipo (viewBox de 360 de ancho).
  const W = 360, BAND_H = 132, TOP = 20, X0 = 86, X1 = 256, GAP = 10;
  const MIN_W = 20;        // por debajo de 20 W no se dibuja la corriente
  const MIN_TH = 3.5;      // grosor mínimo para que una corriente fina se vea

  // origen → destino, con la clave del flujo que lo alimenta en /api/live
  const STREAMS = [
    { from: "solar", to: "home", key: "solar_home" },
    { from: "solar", to: "batt", key: "solar_battery" },
    { from: "solar", to: "grid", key: "solar_grid" },
    { from: "grid", to: "home", key: "grid_home" },
    { from: "grid", to: "batt", key: "grid_battery" },
    { from: "batt", to: "home", key: "battery_home" },
  ];
  const SRC_ORDER = ["solar", "batt", "grid"];
  const DST_ORDER = ["home", "batt", "grid"];
  // Nombres cortos: al lado del nodo solo cabe una palabra o dos. El detalle
  // del día va en la fila de contadores, que tiene el ancho entero.
  const SRC_NAME = { solar: "Sol", batt: "Batería", grid: "Red" };
  const DST_NAME = { home: "Casa", batt: "Batería", grid: "A la red" };
  // Un mismo nodo se pinta con el color de lo que representa en ese lado: la
  // red que entra es «importada» y la que sale, «exportada».
  const SRC_COLOR = { solar: "--s-solar", batt: "--s-batt", grid: "--s-grid" };
  const DST_COLOR = { home: "--s-home", batt: "--s-batt", grid: "--s-exp" };

  // Contadores del día, con el sentido en el nombre para que no haya que
  // adivinar si «Batería» es lo que ha entrado o lo que ha salido. La casa se
  // enseña siempre; el resto, solo si ha habido algo.
  const METERS = [
    { key: "home", name: "Casa", color: "--s-home", always: true },
    { key: "pv", name: "Sol", color: "--s-solar" },
    { key: "grid_import", name: "De la red", color: "--s-grid" },
    { key: "grid_export", name: "A la red", color: "--s-exp" },
    { key: "battery_discharge", name: "De la batería", color: "--s-batt" },
    { key: "battery_charge", name: "A la batería", color: "--s-batt" },
  ];

  const nf1 = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Por debajo del kilovatio los kW se quedan en «0,0» y parece que no pasa
  // nada, cuando sí pasa: ahí se enseñan vatios.
  const power = (w) => (w < 1000 ? `${nf0.format(w)} W` : `${nf1.format(w / 1000)} kW`);

  const CSS = `
    :host { display: block; }
    svg { width: 100%; display: block; }
    .v { font-size: 16px; font-weight: 600; letter-spacing: -.02em;
         font-variant-numeric: tabular-nums; fill: var(--ink); }
    .n { font-size: 12px; fill: var(--ink-3); }
    .empty { margin: 0; padding: 22px 8px 24px; text-align: center; font-size: 14px;
             line-height: 1.5; color: var(--ink-3); }
    .empty b { color: var(--ink-2); font-weight: 600; }
    /* Fila de contadores del día: hace de leyenda y de resumen a la vez. */
    .meters { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 14px 0 0;
              padding: 12px 0 0; border-top: 1px solid var(--hair);
              font-size: 12px; color: var(--ink-3); }
    .meters li { display: flex; align-items: center; gap: 6px; list-style: none; }
    .meters i { width: 8px; height: 8px; border-radius: 3px; flex: none; }
    .meters b { color: var(--ink-2); font-weight: 600;
                font-variant-numeric: tabular-nums; }
    /* La línea de puntos que recorre cada corriente da el sentido del flujo.
       Se define aquí dentro: las animaciones del documento no cruzan el shadow. */
    @keyframes vf-dash { to { stroke-dashoffset: -28; } }
    .stream { stroke: rgba(255,255,255,.85); stroke-linecap: round;
              stroke-dasharray: 2 26; animation: vf-dash 2.6s linear infinite; }
    @media (prefers-reduced-motion: reduce) { .stream { animation: none; } }
  `;

  class VatiaFlow extends HTMLElement {
    set data(value) { this._data = value; this._render(); }
    get data() { return this._data; }

    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      this._render();
    }

    _render() {
      if (!this.shadowRoot) return;
      const d = this._data;
      if (!d) { this.shadowRoot.innerHTML = `<style>${CSS}</style>`; return; }
      const flows = d.flows || {};
      const meters = (d.energy && d.energy.meters) || {};
      const soc = d.power ? d.power.battery_soc : null;
      this.shadowRoot.innerHTML = `<style>${CSS}</style>
        ${this._caudal(flows)}${this._meters(meters, soc)}`;
    }

    // Los contadores del día. Van fuera del SVG a propósito: con el ancho
    // entero se leen, y al lado de cada nodo no cabían sin recortarse.
    _meters(meters, soc) {
      const items = METERS
        .filter((m) => m.always || (meters[m.key] || 0) > 0.005)
        .map((m) => `<li><i style="background:var(${m.color})"></i>${esc(m.name)}
          <b>${esc(nf2.format(meters[m.key] || 0))} kWh</b></li>`);
      if (soc != null) {
        items.push(`<li><i style="background:var(--s-batt)"></i>Batería
          <b>${esc(nf0.format(soc))} %</b></li>`);
      }
      return `<ul class="meters">${items.join("")}</ul>`;
    }

    _caudal(flows) {
      // Las corrientes se recorren en el orden vertical de los nodos —origen
      // primero, destino después— para que el haz se abra en abanico en vez de
      // cruzarse consigo mismo.
      const active = STREAMS
        .map((s) => ({ ...s, w: Math.max(0, flows[s.key] || 0) }))
        .filter((s) => s.w >= MIN_W)
        .sort((a, b) => SRC_ORDER.indexOf(a.from) - SRC_ORDER.indexOf(b.from) ||
                        DST_ORDER.indexOf(a.to) - DST_ORDER.indexOf(b.to));
      const total = active.reduce((a, s) => a + s.w, 0);
      if (!total) return `<p class="empty">Ahora mismo no circula nada.</p>`;

      // Altura de cada nodo, proporcional a lo que pasa por él, y su posición
      // apilada. Las dos columnas se centran entre sí para que el haz quede
      // equilibrado aunque una tenga menos nodos.
      const srcTot = {}, dstTot = {};
      active.forEach((s) => {
        srcTot[s.from] = (srcTot[s.from] || 0) + s.w;
        dstTot[s.to] = (dstTot[s.to] || 0) + s.w;
      });
      const stack = (order, totals) => {
        const top = {}; let y = TOP;
        order.forEach((k) => {
          if (!totals[k]) return;
          top[k] = y;
          y += (totals[k] / total) * BAND_H + GAP;
        });
        return { top, end: y - GAP };
      };
      const src = stack(SRC_ORDER, srcTot), dst = stack(DST_ORDER, dstTot);
      const tallest = Math.max(src.end, dst.end);
      const shift = (col, order, totals) => {
        const off = (tallest - col.end) / 2;
        order.forEach((k) => { if (totals[k]) col.top[k] += off; });
      };
      shift(src, SRC_ORDER, srcTot);
      shift(dst, DST_ORDER, dstTot);

      const cur = { src: { ...src.top }, dst: { ...dst.top } };
      const defs = [], bands = [], lines = [], bars = [], labels = [];
      const c1 = X0 + 76, c2 = X1 - 76;

      active.forEach((s, i) => {
        const th = Math.max(MIN_TH, (s.w / total) * BAND_H);
        const y0 = cur.src[s.from], y1 = cur.dst[s.to];
        cur.src[s.from] += th; cur.dst[s.to] += th;
        const id = `vf${i}`;
        defs.push(
          `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">
             <stop offset="0" style="stop-color:var(${SRC_COLOR[s.from]})" stop-opacity=".85"/>
             <stop offset="1" style="stop-color:var(${DST_COLOR[s.to]})" stop-opacity=".85"/>
           </linearGradient>`);
        bands.push(
          `<path fill="url(#${id})" d="M${X0} ${y0} C${c1} ${y0},${c2} ${y1},${X1} ${y1}
             L${X1} ${y1 + th} C${c2} ${y1 + th},${c1} ${y0 + th},${X0} ${y0 + th} Z"/>`);
        // Cuanto más potencia lleva la corriente, más rápido corre su línea.
        const speed = (2.6 - Math.min(1.3, s.w / 3000)).toFixed(2);
        lines.push(
          `<path class="stream" fill="none" stroke-width="${Math.min(2, th * 0.22).toFixed(2)}"
             style="animation-duration:${speed}s"
             d="M${X0} ${y0 + th / 2} C${c1} ${y0 + th / 2},${c2} ${y1 + th / 2},${X1} ${y1 + th / 2}"/>`);
      });

      let base = 0;
      const side = (order, totals, col, colorMap, nameMap, isSrc) => {
        order.forEach((k) => {
          if (!totals[k]) return;
          const hgt = (totals[k] / total) * BAND_H;
          const ty = col.top[k] + hgt / 2;
          base = Math.max(base, ty + 16);
          bars.push(`<rect x="${isSrc ? X0 - 9 : X1 + 3}" y="${col.top[k].toFixed(1)}" width="6"
            height="${Math.max(4, hgt).toFixed(1)}" rx="3" style="fill:var(${colorMap[k]})"/>`);
          const tx = isSrc ? 68 : 274;
          const anchor = isSrc ? ' text-anchor="end"' : "";
          labels.push(
            `<text class="v" x="${tx}" y="${(ty - 1).toFixed(1)}"${anchor}>${
              esc(power(totals[k]))}</text>
             <text class="n" x="${tx}" y="${(ty + 14).toFixed(1)}"${anchor}>${
              esc(nameMap[k])}</text>`);
        });
      };
      side(SRC_ORDER, srcTot, src, SRC_COLOR, SRC_NAME, true);
      side(DST_ORDER, dstTot, dst, DST_COLOR, DST_NAME, false);

      const height = Math.max(tallest, base + 6, 150);
      return `<svg viewBox="0 0 ${W} ${height.toFixed(0)}" role="img"
             aria-label="Caudal de energía en tiempo real">
          <defs>${defs.join("")}</defs>
          ${bands.join("")}${lines.join("")}${bars.join("")}${labels.join("")}
        </svg>`;
    }
  }

  if (!customElements.get("vatia-flow")) customElements.define("vatia-flow", VatiaFlow);
})();

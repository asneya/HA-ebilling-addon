/*
 * <vatia-cross> — el flujo clásico: la cruz con los nodos y la bola por el cable.
 *
 * Es **el diagrama que tenía la app** antes del Sankey, recuperado tal cual:
 * Solar arriba, Red a la izquierda, Casa a la derecha y Batería abajo, cables
 * ortogonales con la esquina redondeada, una bola corriendo por cada cable
 * encendido, el valor de cada corriente sobre su cable, el anillo del reparto
 * del día en el nodo de la casa y el icono de la batería con su nivel dentro.
 *
 * Es el lenguaje de las apps de inversor y del panel de Energía de Home
 * Assistant, y por eso está en la galería: dice cosas que el Sankey no dice —el
 * contador del día en cada nodo, la compra y la venta por separado en el nodo de
 * la red— y las dice sin que haya que leer una geometría. Lo que no dice es el
 * caudal: todos los cables tienen el mismo grosor, y una corriente de 200 W se
 * ve igual que una de 5 kW. Para eso está el Sankey.
 *
 * Del original se conserva la geometría entera: radio 46, centro (200, 212),
 * carriles a 18 px, esquinas de 16, y los seis caminos con sus posiciones de
 * etiqueta. Cambian cuatro cosas, y las cuatro por lo mismo —era código de una
 * pantalla y ahora es un componente que dos pantallas comparten:
 *
 *   · Los colores salen de los tokens del tema en vez de los literales del
 *     prototipo (`#f5a524`, `#6b8afd`, `#10b981`), que son casi los del tema
 *     oscuro; en claro se oscurecen para leerse sobre blanco.
 *   · Vale con solo un reparto de corrientes, sin el resto del payload: es lo
 *     que necesita la pantalla del día, que pinta un instante del histórico. Sin
 *     `data`, las potencias de los nodos se deducen de las propias corrientes y
 *     los contadores del día no se enseñan, porque no se saben.
 *   · Los electrodomésticos medidos, como anillo por dentro del nodo de la casa,
 *     junto al del reparto por fuentes que ya traía.
 *   · La bola es SMIL (`animateMotion`), que **no** obedece a
 *     `prefers-reduced-motion` por CSS: con el ajuste puesto no se dibuja.
 *
 * Uso: idéntico a <vatia-flow> y <vatia-orbit>.
 */
(() => {
  "use strict";

  // origen → destino, con la clave del flujo que lo alimenta en /api/live
  const STREAMS = [
    { from: "solar", to: "home", key: "solar_home" },
    { from: "solar", to: "battery", key: "solar_battery" },
    { from: "solar", to: "grid", key: "solar_grid" },
    { from: "grid", to: "home", key: "grid_home" },
    { from: "grid", to: "battery", key: "grid_battery" },
    { from: "battery", to: "home", key: "battery_home" },
  ];

  // La geometría del original, sin tocar.
  const NR = 46, CX = 200, CY = 212, LANE = 18, CORN = 16;
  const EXT = Math.sqrt(NR * NR - LANE * LANE);      // 42,33: anclaje al círculo
  const LT = CY - LANE, LB = CY + LANE, LL = CX - LANE, LR = CX + LANE;
  const N = {
    solar: { x: CX, y: 76 },
    grid: { x: 76, y: CY },
    home: { x: 324, y: CY },
    battery: { x: CX, y: 348 },
  };
  // [clave, nodo que da el color, camino, posición de la etiqueta de valor]
  const PATHS = [
    ["solar_battery", "solar", `M${CX},${N.solar.y + NR} V${N.battery.y - NR}`, [CX, 162]],
    ["grid_home", "grid", `M${N.grid.x + NR},${CY} H${N.home.x - NR}`, [252, 206]],
    ["solar_grid", "solar",
     `M${LL},${N.solar.y + EXT} V${LT - CORN} Q${LL},${LT} ${LL - CORN},${LT} H${N.grid.x + EXT}`,
     [142, LT - 8]],
    ["solar_home", "solar",
     `M${LR},${N.solar.y + EXT} V${LT - CORN} Q${LR},${LT} ${LR + CORN},${LT} H${N.home.x - EXT}`,
     [258, LT - 8]],
    ["grid_battery", "grid",
     `M${N.grid.x + EXT},${LB} H${LL - CORN} Q${LL},${LB} ${LL},${LB + CORN} V${N.battery.y - EXT}`,
     [142, LB + 15]],
    ["battery_home", "battery",
     `M${LR},${N.battery.y - EXT} V${LB + CORN} Q${LR},${LB} ${LR + CORN},${LB} H${N.home.x - EXT}`,
     [258, LB + 15]],
  ];
  const COL = { solar: "--s-solar", grid: "--s-grid", battery: "--s-batt", home: "--s-home" };
  // El anillo del día: de qué fuente vino cada kWh que gastó la casa.
  const RING = { from_solar: "--s-solar", from_grid: "--s-grid", from_battery: "--s-batt" };

  const MIN_W = 20;        // por debajo de 20 W no circula nada
  const MIN_AP_W = 20;

  const nf1 = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Un decimal, la regla de la app. El original ponía dos en los kW y el mismo
  // caudal se leía «2,00 kW» aquí y «2,0 kW» en la fila de contadores.
  const power = (w) => (w < 1000 ? `${nf0.format(w)} W` : `${nf1.format(w / 1000)} kW`);
  const r2 = (v) => Math.round(v * 100) / 100;

  function polar(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  /* Los cuatro glifos del original, dibujados a mano: el sprite del documento no
     cruza la frontera del shadow DOM, así que aquí no se puede usar `<use>`. */
  function icono(cx, cy, tipo, color, s = 1, nivel = 0) {
    const abre = `<g transform="translate(${r2(cx - 12 * s)},${r2(cy - 12 * s)}) scale(${s})"
      fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">`;
    if (tipo === "solar") {
      return `${abre}<path d="M4.5,16.5 L8.2,7.5 H20 L17,16.5 Z"/>
        <path d="M12.2,7.5 L9.6,16.5 M16.1,7.5 L13.3,16.5"/><path d="M6.6,12 H18.6"/>
        <path d="M11,16.5 V19.5 M8.5,19.5 H13.5"/></g>`;
    }
    if (tipo === "grid") {
      return `${abre}<path d="M9.2,4.5 H14.8"/><path d="M12,4.5 L6.6,19.5 M12,4.5 L17.4,19.5"/>
        <path d="M9.9,10.4 H14.1 M8.8,13.8 H15.2 M7.7,17 H16.3"/></g>`;
    }
    if (tipo === "battery") {
      // El relleno crece desde abajo: `nivel` son los píxeles de los 12,6 que
      // mide el hueco. El original lo ponía con setAttribute tras escribir el
      // HTML; aquí entra ya en el propio dibujo.
      return `${abre}<path d="M10.2,3.6 H13.8"/>
        <rect x="7.8" y="5.4" width="8.4" height="14.6" rx="1.8"/>
        <rect x="9.3" y="${r2(18.5 - nivel)}" width="5.4" height="${r2(nivel)}" rx="0.9"
          fill="${color}" stroke="none"/></g>`;
    }
    return `<g transform="translate(${r2(cx - 12 * s)},${r2(cy - 12 * s)}) scale(${s})">
      <path d="M12,4.2 L21,12.4 h-2.6 V20 H5.6 V12.4 H3 Z" fill="${color}"/></g>`;
  }

  const METERS = [
    { key: "home", name: "Casa", color: "--s-home", always: true },
    { key: "pv", name: "Sol", color: "--s-solar" },
    { key: "grid_import", name: "De la red", color: "--s-grid" },
    { key: "grid_export", name: "A la red", color: "--s-exp" },
    { key: "battery_discharge", name: "De la batería", color: "--s-batt" },
    { key: "battery_charge", name: "A la batería", color: "--s-batt" },
  ];

  const CSS = `
    :host { display: block; }
    svg { width: 100%; display: block; overflow: visible; }
    /* Las clases del original, con sus medidas. */
    .pf-base { fill: none; stroke: var(--ink); opacity: .13; stroke-width: 2.5; stroke-linecap: round; }
    .pf-live { fill: none; stroke-width: 2.5; stroke-linecap: round; transition: opacity .45s ease; }
    .pf-val { fill: var(--ink); font-size: 15px; font-weight: 700;
              font-variant-numeric: tabular-nums; }
    .pf-io { font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .pf-lbl { fill: var(--ink-3); font-size: 12.5px; font-weight: 500; }
    /* El valor sobre el cable lleva un halo del color de la tarjeta: si no, cae
       encima de su propio cable y no se lee. */
    .pf-flowval {
      fill: var(--ink-2); font-size: 10.5px; font-weight: 600;
      font-variant-numeric: tabular-nums;
      paint-order: stroke; stroke: var(--solid); stroke-width: 3.5px; stroke-linejoin: round;
    }
    .sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
          overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    .empty { margin: 0; padding: 22px 8px 24px; text-align: center; font-size: 14px;
             line-height: 1.5; color: var(--ink-3); }
    .meters { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 14px 0 0;
              padding: 12px 0 0; border-top: 1px solid var(--hair);
              font-size: 12px; color: var(--ink-3); }
    .meters li { display: flex; align-items: center; gap: 6px; list-style: none; }
    .meters i { width: 8px; height: 8px; flex: none; }
    .meters b { color: var(--ink-2); font-weight: 600;
                font-variant-numeric: tabular-nums; }
  `;

  class VatiaCross extends HTMLElement {
    constructor() {
      super();
      this._meters = true;
    }

    set data(value) { this._data = value; this._flows = null; this._render(); }
    get data() { return this._data; }
    set flows(value) { this._flows = value; this._render(); }
    set meters(value) { this._meters = value !== false; this._render(); }
    set split(value) { this._split = value; this._render(); }

    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      this._render();
    }

    _render() {
      if (!this.shadowRoot) return;
      const d = this._data;
      const flows = this._flows || (d && d.flows) || null;
      if (!flows) { this.shadowRoot.innerHTML = `<style>${CSS}</style>`; return; }
      const meters = (d && d.energy && d.energy.meters) || null;
      const soc = d && d.power ? d.power.battery_soc : null;
      this.shadowRoot.innerHTML = `<style>${CSS}</style>
        ${this._cruz(flows, d, soc)}
        ${this._meters && meters ? this._metersRow(meters, soc) : ""}`;
    }

    _metersRow(meters, soc) {
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

    _cruz(flows, d, soc) {
      const activa = {};
      let total = 0;
      for (const s of STREAMS) {
        const w = Math.max(0, flows[s.key] || 0);
        activa[s.key] = w >= MIN_W ? w : 0;
        total += activa[s.key];
      }
      if (!total) return `<p class="empty">Ahora mismo no circula nada.</p>`;

      // Con el payload entero, las potencias de los nodos son las medidas. Sin
      // él —la pantalla del día— se deducen de las corrientes, que es de donde
      // salieron: es el mismo número por otro camino.
      const p = (d && d.power) || {};
      const suma = (...claves) => claves.reduce((a, k) => a + activa[k], 0);
      const pv = p.pv != null ? p.pv : suma("solar_home", "solar_battery", "solar_grid");
      const casa = p.home != null ? p.home : suma("solar_home", "grid_home", "battery_home");

      // Sin movimiento, sin bola: `animateMotion` es SMIL y el CSS de
      // `prefers-reduced-motion` no lo alcanza.
      const quieto = window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      let cables = "", bolas = "", valores = "";
      for (const [key, from, camino, pos] of PATHS) {
        const w = activa[key];
        const color = `var(${COL[from]})`;
        cables += `<path class="pf-base" d="${camino}"/>
          <path class="pf-live" d="${camino}" stroke="${color}" style="opacity:${w ? 0.5 : 0}"/>`;
        if (!w) continue;
        // Cuanto más caudal, más rápida la bola. Es la única pista de intensidad
        // que da este diagrama, porque todos los cables miden lo mismo.
        const dur = Math.max(0.6, Math.min(3.4, Math.round((3000 / w) * 5) / 5));
        if (!quieto) {
          bolas += `<g><circle r="5" fill="${color}"
            style="filter:drop-shadow(0 0 3px ${color})"/>
            <animateMotion dur="${dur}s" repeatCount="indefinite" calcMode="linear"
              keyPoints="0;1" keyTimes="0;1" path="${camino}"/></g>`;
        }
        valores += `<text class="pf-flowval" x="${pos[0]}" y="${pos[1]}"
          text-anchor="middle">${esc(power(w))}</text>`;
      }

      const conDia = this._meters && d && d.energy;
      const m = (conDia && d.energy.meters) || {};
      const kwh = (key, alt) => `${nf2.format(m[key] != null ? m[key] : (alt || 0))} kWh`;
      const nivel = soc != null ? (12.6 * Math.max(0, Math.min(100, soc))) / 100 : 0;

      return `<svg viewBox="0 0 400 420" role="img"
          aria-label="Flujo de energía en tiempo real">
        ${cables}${bolas}
        <g>
          <circle cx="${N.solar.x}" cy="${N.solar.y}" r="${NR}" fill="none"
            stroke="var(--s-solar)" stroke-width="2.5"/>
          ${icono(N.solar.x, N.solar.y - 14, "solar", "var(--s-solar)", 1.05)}
          <text class="pf-val" x="${N.solar.x}" y="${N.solar.y + 9}"
            text-anchor="middle">${esc(power(pv))}</text>
          ${conDia ? `<text class="pf-io" style="fill:var(--ink-3)" x="${N.solar.x}"
            y="${N.solar.y + 24}" text-anchor="middle">${esc(kwh("pv",
              d.energy.generation && d.energy.generation.total))}</text>` : ""}
        </g>
        <g>
          <circle cx="${N.grid.x}" cy="${N.grid.y}" r="${NR}" fill="none"
            stroke="var(--s-grid)" stroke-width="2.5"/>
          ${icono(N.grid.x, N.grid.y - 20, "grid", "var(--s-grid)", 0.95)}
          ${conDia
            ? `<text class="pf-io" style="fill:var(--s-exp)" x="${N.grid.x}"
                 y="${N.grid.y + 3}" text-anchor="middle">← ${esc(kwh("grid_export"))}</text>
               <text class="pf-io" style="fill:var(--s-grid)" x="${N.grid.x}"
                 y="${N.grid.y + 20}" text-anchor="middle">→ ${esc(kwh("grid_import"))}</text>`
            : `<text class="pf-val" x="${N.grid.x}" y="${N.grid.y + 9}"
                 text-anchor="middle">${esc(power(
                   suma("grid_home", "grid_battery") || activa.solar_grid))}</text>`}
        </g>
        <g>
          <circle cx="${N.battery.x}" cy="${N.battery.y}" r="${NR}" fill="none"
            stroke="var(--s-batt)" stroke-width="2.5"/>
          ${icono(N.battery.x, N.battery.y - 20, "battery", "var(--s-batt)", 0.95, nivel)}
          ${conDia
            ? `<text class="pf-io" style="fill:var(--s-batt-out)" x="${N.battery.x}"
                 y="${N.battery.y + 3}" text-anchor="middle">↑ ${esc(kwh("battery_discharge"))}</text>
               <text class="pf-io" style="fill:var(--s-batt)" x="${N.battery.x}"
                 y="${N.battery.y + 20}" text-anchor="middle">↓ ${esc(kwh("battery_charge"))}</text>`
            : `<text class="pf-val" x="${N.battery.x}" y="${N.battery.y + 9}"
                 text-anchor="middle">${esc(power(
                   activa.battery_home || suma("solar_battery", "grid_battery")))}</text>`}
        </g>
        <g>
          ${this._anillo(conDia ? d.energy.home.rows : null, casa)}
          ${icono(N.home.x, N.home.y - 14, "home", "var(--s-home)", 0.95)}
          <text class="pf-val" x="${N.home.x}" y="${N.home.y + 9}"
            text-anchor="middle">${esc(power(casa))}</text>
          ${conDia ? `<text class="pf-io" style="fill:var(--ink-3)" x="${N.home.x}"
            y="${N.home.y + 24}" text-anchor="middle">${esc(kwh("home",
              d.energy.home.total))}</text>` : ""}
        </g>
        <text class="pf-lbl" x="${N.solar.x}" y="${N.solar.y - NR - 11}"
          text-anchor="middle">Solar</text>
        <text class="pf-lbl" x="${N.grid.x}" y="${N.grid.y + NR + 20}"
          text-anchor="middle">Red</text>
        <text class="pf-lbl" x="${N.home.x}" y="${N.home.y + NR + 20}"
          text-anchor="middle">Casa</text>
        <text class="pf-lbl" x="${N.battery.x}" y="${N.battery.y + NR + 20}"
          text-anchor="middle">${soc != null ? `Batería · ${nf0.format(soc)}%` : "Batería"}</text>
        ${valores}
      </svg>${this._lista(activa, casa, total)}`;
    }

    /* El anillo del nodo de la casa. Por fuera, de qué fuente vino cada kWh del
       día; por dentro, qué parte de lo que gasta **ahora** tiene nombre. Los dos
       son vueltas de círculo, que es lo que este diagrama sabe decir de la casa:
       aquí no hay nodo que partir como en el Sankey. */
    _anillo(rows, casa) {
      const fondo = `<circle cx="${N.home.x}" cy="${N.home.y}" r="${NR}" fill="none"
        stroke="var(--ink)" stroke-opacity=".14" stroke-width="5"/>`;
      const trozos = (lista, radio, ancho) => {
        const suma = lista.reduce((a, x) => a + x.v, 0);
        if (suma <= 0) return "";
        // Un solo tramo da la vuelta entera, y un arco que empieza y acaba en el
        // **mismo punto** no dibuja nada: el original enseñaba un puntito verde
        // justo en el caso más común, la casa tirando de una sola fuente. Ahí va
        // un círculo, que es lo que un tramo de 360° es.
        const enteros = lista.filter((x) => x.v > 0);
        if (enteros.length === 1) {
          const x = enteros[0];
          return `<circle cx="${N.home.x}" cy="${N.home.y}" r="${radio}" fill="none"
            stroke="${x.color}" stroke-width="${ancho}"><title>${esc(x.titulo)}</title></circle>`;
        }
        let ang = 0, out = "";
        const hueco = 5;
        for (const x of lista) {
          const span = (x.v / suma) * 360;
          const a0 = ang + hueco / 2, a1 = ang + span - hueco / 2;
          ang += span;
          if (a1 <= a0) continue;
          const [x0, y0] = polar(N.home.x, N.home.y, radio, a0);
          const [x1, y1] = polar(N.home.x, N.home.y, radio, a1);
          out += `<path d="M${r2(x0)},${r2(y0)} A${radio},${radio} 0
            ${a1 - a0 > 180 ? 1 : 0} 1 ${r2(x1)},${r2(y1)}" fill="none"
            stroke="${x.color}" stroke-width="${ancho}" stroke-linecap="round"
            ><title>${esc(x.titulo)}</title></path>`;
        }
        return out;
      };

      const dia = (rows || [])
        .filter((r) => r.kwh > 0)
        .map((r) => ({ v: r.kwh, color: `var(${RING[r.key] || "--s-home"})`,
                       titulo: `${r.label}: ${nf2.format(r.kwh)} kWh (${r.pct}%)` }));

      const medidos = (this._split || [])
        .map((a) => ({ ...a, w: Math.max(0, a.watts || 0) }))
        .filter((a) => a.w >= MIN_AP_W);
      let dentro = "";
      if (medidos.length && casa >= MIN_AP_W) {
        const suma = medidos.reduce((a, x) => a + x.w, 0);
        const factor = suma > casa ? casa / suma : 1;
        // El hueco que quede es «lo no medido»: no se pinta, para no completar
        // la vuelta con algo que no se sabe de quién es.
        const lista = medidos.map((a) => ({
          v: a.w * factor, color: a.color || "currentColor",
          titulo: `${a.name}: ${power(a.w * factor)}`,
        }));
        const resto = Math.max(0, casa - suma * factor);
        if (resto > 0) lista.push({ v: resto, color: "transparent", titulo: "Sin medir" });
        dentro = trozos(lista, NR - 9, 3.5);
      }
      return fondo + trozos(dia, NR, 5) + dentro;
    }

    _lista(activa, casa, total) {
      const DE = { solar: "Del sol", battery: "De la batería", grid: "De la red" };
      const A = { home: "a la casa", battery: "a la batería", grid: "a la red" };
      const filas = STREAMS.filter((s) => activa[s.key])
        .map((s) => `<li>${DE[s.from]} ${A[s.to]}: ${esc(power(activa[s.key]))}</li>`);
      const medidos = (this._split || [])
        .map((a) => ({ ...a, w: Math.max(0, a.watts || 0) }))
        .filter((a) => a.w >= MIN_AP_W);
      if (medidos.length) {
        filas.push(`<li>La casa por dentro: ${esc(medidos
          .map((a) => `${a.name}, ${power(a.w)}`).join("; "))}</li>`);
      }
      return `<ul class="sr">${filas.join("")}
        <li>En casa ahora mismo: ${esc(power(casa))}</li>
        <li>Caudal total: ${esc(power(total))}</li></ul>`;
    }
  }

  if (!customElements.get("vatia-cross")) {
    customElements.define("vatia-cross", VatiaCross);
  }
})();

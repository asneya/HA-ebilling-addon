/*
 * <vatia-orbit> — el flujo «clásico»: la casa en el centro y las fuentes en órbita.
 *
 * Es la primera versión del diseño «Flujo de energía», la que se descartó al
 * elegir el Sankey. Se recupera porque las dos dicen cosas distintas y no es
 * obvio cuál gana: el Sankey mide caudales —cada cinta es px por kW de verdad y
 * se pueden comparar dos horas— y la órbita mide **el sitio de la casa**: un
 * número grande en el centro, tres fuentes alrededor y de un vistazo se ve de
 * dónde viene la luz. Quien quiera lo primero elige Sankey; quien quiera un
 * cuadro de mandos, esto. Se elige en Ajustes → Galería de flujos.
 *
 * Del diseño se porta la geometría entera y sin retocar: el centro en (180, 182)
 * con radio 50, el sol arriba a (180, 54), la red abajo a la izquierda y la
 * batería abajo a la derecha, los cinco arqueos de las cintas, el anillo de
 * mezcla a r+13 y el arco de carga en el nodo de la batería.
 *
 * Tres cosas cambian, y las tres por la misma razón —el diseño era una maqueta
 * en oscuro y esto es una app con dos temas y datos de verdad:
 *
 *   · Los colores salen de los tokens (`--s-solar`, `--s-grid`…) y no del
 *     literal. En oscuro los tokens *son* los del diseño; en claro se oscurecen
 *     para leerse sobre blanco, que es cosa del tema y no de aquí.
 *   · Falta una cinta: la maqueta nunca dibuja red → batería, porque su física
 *     de juguete no carga de la red. Una instalación de verdad sí, así que tiene
 *     su arqueo, hacia abajo, por fuera de las otras.
 *   · Los electrodomésticos medidos se dibujan como un anillo **dentro** del
 *     núcleo, en el mismo lenguaje que el anillo de mezcla y el arco de carga
 *     que ya trae el diseño. No es el detalle del Sankey —ahí cada aparato es un
 *     nodo con su nombre y su valor— pero al menos se ve cuánto de la casa está
 *     medido y de quién es.
 *
 * Uso: idéntico a <vatia-flow>, para que las pantallas puedan cambiar de uno a
 * otro sin saber cuál tienen delante:
 *   orbit.data = payload;   orbit.flows = {…};   orbit.meters = false;
 *   orbit.split = [{id, name, color, watts}];
 */
(() => {
  "use strict";

  // origen → destino, con la clave del flujo que lo alimenta en /api/live
  const STREAMS = [
    { from: "sol", to: "home", key: "solar_home" },
    { from: "sol", to: "bat", key: "solar_battery" },
    { from: "sol", to: "red", key: "solar_grid" },
    { from: "red", to: "home", key: "grid_home" },
    { from: "red", to: "bat", key: "grid_battery" },
    { from: "bat", to: "home", key: "battery_home" },
  ];

  // La geometría del diseño, tal cual.
  const C = { x: 180, y: 182 }, R = 50;
  const NODES = {
    sol: { x: 180, y: 54, r: 28, name: "Sol" },
    red: { x: 52, y: 274, r: 28, name: "Red" },
    bat: { x: 308, y: 274, r: 28, name: "Batería" },
  };
  /* El arqueo de cada cinta, en píxeles de separación de la recta. Los cinco
     primeros son los del diseño; `red>bat` es el que falta ahí, y va hacia
     abajo (positivo, alejándose del centro) para no cruzar por dentro del
     núcleo, que es justo donde pasa la recta entre los dos nodos de abajo. */
  const BOW = {
    "sol>home": 0, "bat>home": 14, "red>home": -14,
    "sol>bat": 74, "sol>red": -74, "red>bat": 52,
  };
  const COL = {
    sol: "--s-solar", red: "--s-grid", bat: "--s-batt",
    exp: "--s-exp", home: "--s-home",
  };
  // El caudal de referencia para el grosor. El diseño pone el suelo en 1,6 kW:
  // sin él, una casa a 200 W dibujaría cintas gordísimas y parecería un torrente.
  const PICO_MIN = 1600;
  const MIN_W = 20;        // por debajo de 20 W no se dibuja la corriente
  const MIN_AP_W = 20;     // ni el trozo de un electrodoméstico

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
  // La misma regla de la app: vatios por debajo del kilovatio. El diseño lo pone
  // todo en kW con dos decimales, pero «0,20 kW» y «200 W» en la misma pantalla
  // se leen como dos números distintos.
  const power = (w) => (w < 1000 ? `${nf0.format(w)} W` : `${nf1.format(w / 1000)} kW`);
  const r1 = (v) => Math.round(v * 10) / 10;

  /* La cinta entre dos nodos: sale del borde de uno y muere en el borde del
     otro, arqueada `bow` píxeles por su perpendicular. Es la fórmula del diseño. */
  function cinta(a, b, bow) {
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;
    const sx = a.x + ux * a.r, sy = a.y + uy * a.r;
    const ex = b.x - ux * b.r, ey = b.y - uy * b.r;
    const mx = (sx + ex) / 2, my = (sy + ey) / 2;
    return `M${r1(sx)} ${r1(sy)} Q${r1(mx - uy * bow)} ${r1(my + ux * bow)} ${r1(ex)} ${r1(ey)}`;
  }

  /* Un arco de `pathLength: 100`, que es el truco del diseño para repartir un
     círculo en porcentajes sin trigonometría: el trazo discontinuo se mide en
     centésimas de vuelta, así que un tramo de `share` unidades es `share %`. */
  function arco(cx, cy, r, share, offset, color, ancho, hueco = 1.6) {
    const s = Math.max(0, share - hueco);
    return `<circle cx="${cx}" cy="${cy}" r="${r1(r)}" fill="none" stroke="${color}"
      stroke-width="${ancho}" stroke-linecap="butt" pathLength="100"
      stroke-dasharray="${s.toFixed(2)} ${(100 - s).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})"/>`;
  }

  const CSS = `
    :host { display: block; }
    svg { width: 100%; display: block; overflow: visible; }
    /* El valor de cada nodo y su nombre, con las medidas del diseño. */
    .nv { font-size: 15px; font-weight: 600; letter-spacing: -.02em;
          font-variant-numeric: tabular-nums; fill: var(--ink); }
    .nv.off { fill: var(--ink-3); }
    .nn { font-size: 12px; font-weight: 500; fill: var(--ink-3); }
    /* El centro: el número grande de la casa, su unidad y el «AHORA». */
    .cv { font-size: 30px; font-weight: 600; letter-spacing: -.04em;
          font-variant-numeric: tabular-nums; fill: var(--ink); }
    .cu { font-size: 11.5px; font-weight: 500; letter-spacing: .02em; fill: var(--ink-3); }
    .cl { font-size: 10.5px; font-weight: 600; letter-spacing: .1em; fill: var(--ink-3); }
    .sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
          overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    .empty { margin: 0; padding: 22px 8px 24px; text-align: center; font-size: 14px;
             line-height: 1.5; color: var(--ink-3); }
    .empty b { color: var(--ink-2); font-weight: 600; }
    .meters { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 14px 0 0;
              padding: 12px 0 0; border-top: 1px solid var(--hair);
              font-size: 12px; color: var(--ink-3); }
    .meters li { display: flex; align-items: center; gap: 6px; list-style: none; }
    .meters i { width: 8px; height: 8px; flex: none; }
    .meters b { color: var(--ink-2); font-weight: 600;
                font-variant-numeric: tabular-nums; }
    /* Las tres animaciones del diseño. Van aquí dentro porque las del documento
       no cruzan la frontera del shadow DOM. */
    @keyframes vo-drift { to { stroke-dashoffset: -260; } }
    @keyframes vo-halo { 0%, 100% { opacity: .22; } 50% { opacity: .5; } }
    @keyframes vo-pulse { 0%, 100% { opacity: .30; transform: scale(1); }
                          50% { opacity: .62; transform: scale(1.06); } }
    .flujo { stroke: var(--particula); stroke-linecap: round;
             animation: vo-drift 3s linear infinite; }
    .halo { animation: vo-halo 4.8s ease-in-out infinite; }
    .halo.sol { animation-duration: 3.6s; }
    .latido { animation: vo-pulse 4.2s ease-in-out infinite; }
    @media (prefers-reduced-motion: reduce) {
      .flujo, .halo, .latido { animation: none; }
    }
  `;

  class VatiaOrbit extends HTMLElement {
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
        ${this._orbita(flows, soc)}
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

    _orbita(flows, soc) {
      const active = STREAMS
        .map((s) => ({ ...s, w: Math.max(0, flows[s.key] || 0) }))
        .filter((s) => s.w >= MIN_W);
      if (!active.length) return `<p class="empty">Ahora mismo no circula nada.</p>`;

      const casa = active.filter((l) => l.to === "home").reduce((a, l) => a + l.w, 0);
      const pico = Math.max(PICO_MIN, ...active.map((l) => l.w));
      // La batería carga si le entra algo, y eso cambia su nombre en el nodo.
      const cargando = active.some((l) => l.to === "bat");
      const borde = (k) => (k === "home"
        ? { x: C.x, y: C.y, r: R + 8 }
        : { x: NODES[k].x, y: NODES[k].y, r: NODES[k].r + 7 });

      const defs = [], resplandor = [], bandas = [], particulas = [];
      active.forEach((l, i) => {
        const d = cinta(borde(l.from), borde(l.to), BOW[`${l.from}>${l.to}`] || 0);
        const w = Math.max(4, Math.min(30, (l.w / pico) * 26));
        const c1 = `var(${COL[l.from]})`;
        const c2 = `var(${COL[l.to === "red" ? "exp" : l.to]})`;
        const a = borde(l.from), b = borde(l.to);
        defs.push(`<linearGradient id="vo${i}" gradientUnits="userSpaceOnUse"
          x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}">
          <stop offset="0" style="stop-color:${c1}"/>
          <stop offset="1" style="stop-color:${c2}"/></linearGradient>`);
        resplandor.push(`<path d="${d}" fill="none" stroke="${c1}"
          stroke-width="${r1(w + 12)}" stroke-linecap="round" opacity=".13"
          style="filter:blur(7px)"/>`);
        bandas.push(`<path d="${d}" fill="none" stroke="url(#vo${i})"
          stroke-width="${r1(w)}" stroke-linecap="round" opacity=".92"/>`);
        // La partícula corre más deprisa donde más caudal hay: es la única señal
        // de sentido que tiene el diagrama, y de paso ordena las cintas.
        const seg = (3.4 - Math.min(1.9, (l.w / pico) * 1.9)).toFixed(2);
        particulas.push(`<path class="flujo" d="${d}" fill="none"
          stroke-width="${Math.max(1.6, w * 0.17).toFixed(2)}"
          stroke-dasharray="3 ${Math.round(16 + w)}"
          style="animation-duration:${seg}s"/>`);
      });

      // El anillo de mezcla: de quién es cada trozo de lo que gasta la casa.
      let acc = 0;
      const anillo = active.filter((l) => l.to === "home").map((l) => {
        const share = (l.w / (casa || 1)) * 100, off = acc;
        acc += share;
        return arco(C.x, C.y, R + 13, share, off, `var(${COL[l.from]})`, 7);
      });

      const nodos = Object.keys(NODES).map((k) => {
        const n = NODES[k];
        const val = active.filter((l) => l.from === k || l.to === k)
          .reduce((a, l) => a + l.w, 0);
        const vivo = val >= MIN_W;
        const c = `var(${COL[k]})`;
        const abajo = n.y > C.y;
        const nombre = k === "bat" && cargando ? "Batería · carga"
          : k === "sol" && !vivo ? "Sol · dormido" : n.name;
        return `<g>
          ${vivo ? `<circle class="halo ${k}" cx="${n.x}" cy="${n.y}" r="${n.r + 13}"
            fill="${c}" opacity=".16"
            style="filter:blur(9px);transform-origin:${n.x}px ${n.y}px"/>` : ""}
          <circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="var(--node)"
            stroke="${vivo ? c : "var(--hair-2)"}" stroke-width="${vivo ? 1.6 : 1}"/>
          ${k === "bat" && soc != null
            ? arco(n.x, n.y, n.r - 5, Math.max(0, Math.min(100, soc)), 0,
                   `var(--s-batt)`, 3, 0) : ""}
          <text class="nv${vivo ? "" : " off"}" x="${n.x}" y="${n.y + 4}"
            text-anchor="middle">${vivo ? esc(power(val)) : "—"}</text>
          <text class="nn" x="${n.x}" y="${abajo ? n.y + n.r + 19 : n.y - n.r - 11}"
            text-anchor="middle">${esc(nombre)}</text>
        </g>`;
      });

      /* El latido de la casa, **detrás de todo**. El diseño lo pone justo antes
         del círculo del núcleo, o sea encima del anillo de mezcla; sobre un
         fondo casi negro eso es una neblina que no se nota, pero sobre la
         tarjeta blanca del tema claro el rosa al 12 % teñía el anillo y el azul
         de la red se leía morado. Un resplandor va detrás de lo que ilumina. */
      const latido = `
        <circle class="latido" cx="${C.x}" cy="${C.y}" r="${R + 24}"
          fill="var(--s-home)" opacity=".12"
          style="filter:blur(16px);transform-origin:${C.x}px ${C.y}px"/>`;

      const nucleo = `
        <circle cx="${C.x}" cy="${C.y}" r="${R}" fill="var(--solid)"
          stroke="var(--hair-2)" stroke-width="1"/>
        ${this._aparatos(casa)}
        <text class="cv" x="${C.x}" y="${C.y - 4}" text-anchor="middle">${
          esc(casa < 1000 ? nf0.format(casa) : nf1.format(casa / 1000))}</text>
        <text class="cu" x="${C.x}" y="${C.y + 14}" text-anchor="middle">${
          casa < 1000 ? "W en casa" : "kW en casa"}</text>
        <text class="cl" x="${C.x}" y="${C.y + 31}" text-anchor="middle">AHORA</text>`;

      return `<svg viewBox="0 -16 360 356" role="img"
          aria-label="Flujo de energía en tiempo real">
        <defs>${defs.join("")}</defs>
        ${latido}
        <g>${resplandor.join("")}</g>
        ${bandas.join("")}${anillo.join("")}
        ${nucleo}
        ${particulas.join("")}
        ${nodos.join("")}
      </svg>${this._lista(active, casa)}`;
    }

    /* Los electrodomésticos medidos, como anillo por dentro del núcleo. La casa
       aquí es un nodo y no se puede partir en nodos como en el Sankey, así que se
       dice lo que sí se puede decir con una vuelta de círculo: qué parte de lo
       que gasta la casa tiene nombre, y de quién es. El resto se queda sin pintar
       —el hueco es «lo no medido», y así el anillo no miente por completar. */
    _aparatos(casa) {
      const medidos = (this._split || [])
        .map((a) => ({ ...a, w: Math.max(0, a.watts || 0) }))
        .filter((a) => a.w >= MIN_AP_W);
      if (!medidos.length || casa < MIN_AP_W) return "";
      const suma = medidos.reduce((a, x) => a + x.w, 0);
      // Si los enchufes suman más que la casa los sensores no cuadran: se
      // recortan a prorrata antes que dibujar más de una vuelta.
      const factor = suma > casa ? casa / suma : 1;
      let acc = 0;
      return medidos.map((a) => {
        const share = ((a.w * factor) / casa) * 100, off = acc;
        acc += share;
        return arco(C.x, C.y, R - 9, share, off, a.color || "currentColor", 4);
      }).join("");
    }

    /* El diagrama en palabras, con las mismas frases que el Sankey: es el mismo
       reparto y quien lo escucha no tiene por qué notar qué componente hay. */
    _lista(active, casa) {
      const DE = { sol: "Del sol", bat: "De la batería", red: "De la red" };
      const A = { home: "a la casa", bat: "a la batería", red: "a la red" };
      const filas = active.map((s) =>
        `<li>${DE[s.from]} ${A[s.to]}: ${esc(power(s.w))}</li>`);
      const medidos = (this._split || [])
        .map((a) => ({ ...a, w: Math.max(0, a.watts || 0) }))
        .filter((a) => a.w >= MIN_AP_W);
      if (medidos.length) {
        filas.push(`<li>La casa por dentro: ${esc(medidos
          .map((a) => `${a.name}, ${power(a.w)}`).join("; "))}</li>`);
      }
      const total = active.reduce((a, l) => a + l.w, 0);
      return `<ul class="sr">${filas.join("")}
        <li>En casa ahora mismo: ${esc(power(casa))}</li>
        <li>Caudal total: ${esc(power(total))}</li></ul>`;
    }
  }

  if (!customElements.get("vatia-orbit")) {
    customElements.define("vatia-orbit", VatiaOrbit);
  }
})();

/*
 * <vatia-flow> — el «caudal» en tiempo real, según el diseño «Flujo de energía v2».
 *
 * Sankey de dos columnas: a la izquierda lo que entra (sol, batería, red), a la
 * derecha lo que se usa (casa, batería, red). Lo que el diseño pide portar
 * literalmente es la geometría, y lo que la hace funcionar es una decisión que la
 * versión anterior no tomaba: **la escala es px por kW de verdad**, no una
 * normalización al alto de la banda. Antes 200 W y 5 kW se dibujaban con el
 * mismo grosor —el diagrama solo decía proporciones— y ahora a las horas de poco
 * caudal las cintas son finas de verdad, que es la mitad de la información.
 *
 * Se construye en píxeles CSS y no en un viewBox fijo: las medidas del diseño
 * (14 px de nombre, 54 de barra, 40 de paso entre etiquetas) son píxeles, y con
 * un viewBox de 976 escalado al ancho de la tarjeta la letra de 14 acababa
 * dibujada a 10. Así cada número es el que pone el diseño.
 *
 * Dos orientaciones, con el corte que da el propio diseño en 600 px:
 *   ≥ 600 px  columnas a los lados, tal cual la maqueta;
 *   < 600 px  entradas arriba y salidas abajo, cintas giradas 90°, etiquetas
 *             fuera de la zona de cintas. En el móvil el nombre no cabe en una
 *             línea, así que el sufijo baja a la segunda con el valor: las
 *             palabras del diseño se conservan, cambia dónde parte la línea.
 *
 * Uso:
 *   flow.data = payload;              // el objeto de /api/live tal cual
 *   flow.flows = { solar_home: … };   // o un reparto suelto (pantalla del día)
 *   flow.meters = false;              // sin la fila de contadores del día
 *
 * Los colores salen de los tokens del tema por `var()`, que atraviesa la
 * frontera del shadow DOM: al cambiar de tema se repinta solo, sin JS.
 */
(() => {
  "use strict";

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
  // Por debajo de esto un electrodoméstico no merece su propio segmento: se
  // queda dentro del resto de la casa en vez de dibujar una raya.
  const MIN_AP_W = 20;
  // Los sufijos son parte del nombre: sin ellos «Batería» a la izquierda y
  // «Batería» a la derecha son la misma palabra para dos cosas contrarias.
  const SRC_NAME = { solar: "Sol", batt: "Batería · descarga", grid: "Red · compra" };
  const DST_NAME = { home: "Casa", batt: "Batería · carga", grid: "Red · excedente" };
  const SRC_SHORT = { solar: ["Sol", ""], batt: ["Batería", "descarga"], grid: ["Red", "compra"] };
  const DST_SHORT = { home: ["Casa", ""], batt: ["Batería", "carga"], grid: ["Red", "excedente"] };
  // Un mismo nodo se pinta con el color de lo que representa en ese lado: la
  // red que entra es «importada» y la que sale, «exportada».
  const SRC_COLOR = { solar: "--s-solar", batt: "--s-batt", grid: "--s-grid" };
  const DST_COLOR = { home: "--s-home", batt: "--s-batt", grid: "--s-exp" };

  /* El lado derecho, con la casa partida por dentro.
     Cuando hay electrodomésticos medidos, el nodo «Casa» deja de ser uno y pasa
     a ser uno por aparato más el resto. El reparto de cada corriente entre ellos
     es **proporcional**: por el cable no viene marcado qué vatio va a la lavadora
     y cuál a la nevera, así que atribuir el sol al aparato y la red al resto
     sería inventarse un dato. Proporcional es lo único que se puede afirmar.

     Devuelve los mismos mapas que las constantes de arriba —más `tinta`, para los
     colores que vienen de la configuración y no de un token— y `partes`: los
     enlaces ya divididos. */
  function ladoDerecho(active, split) {
    const casa = active.filter((l) => l.to === "home").reduce((a, l) => a + l.w, 0);
    const medidos = (split || [])
      .map((a) => ({ ...a, w: Math.max(0, a.watts || 0) }))
      .filter((a) => a.w >= MIN_AP_W);
    if (!medidos.length || casa < MIN_AP_W) {
      return { orden: DST_ORDER, nombre: DST_NAME, color: DST_COLOR,
               corto: DST_SHORT, tinta: {}, partes: active };
    }
    // La suma de los enchufes no puede pasarse del consumo de la casa: si los
    // sensores no cuadran se recortan a prorrata, que es mejor que un «resto»
    // negativo o que un diagrama que no suma.
    const suma = medidos.reduce((a, x) => a + x.w, 0);
    const factor = suma > casa && suma > 0 ? casa / suma : 1;

    const orden = [], nombre = {}, color = {}, corto = {}, tinta = {};
    medidos.forEach((a, i) => {
      const k = `ap${i}`;
      a.k = k;
      a.w *= factor;
      orden.push(k);
      nombre[k] = a.name;
      corto[k] = [a.name, ""];
      color[k] = null;          // su color es suyo, no un token del tema
      tinta[k] = a.color;
    });
    const resto = Math.max(0, casa - medidos.reduce((a, x) => a + x.w, 0));
    if (resto >= MIN_AP_W) {
      orden.push("home");
      nombre.home = "Resto de la casa";
      corto.home = ["Resto", "de la casa"];
      color.home = DST_COLOR.home;
    }
    orden.push("batt", "grid");
    nombre.batt = DST_NAME.batt; nombre.grid = DST_NAME.grid;
    corto.batt = DST_SHORT.batt; corto.grid = DST_SHORT.grid;
    color.batt = DST_COLOR.batt; color.grid = DST_COLOR.grid;

    // Cada corriente que iba a la casa se reparte entre los destinos de dentro.
    const partes = [];
    for (const l of active) {
      if (l.to !== "home") { partes.push(l); continue; }
      for (const a of medidos) partes.push({ ...l, to: a.k, w: l.w * (a.w / casa) });
      if (resto >= MIN_AP_W) partes.push({ ...l, w: l.w * (resto / casa) });
    }
    return { orden, nombre, color, corto, tinta, partes };
  }

  const MIN_W = 20;        // por debajo de 20 W no se dibuja la corriente
  const CORTE = 600;       // el corte del diseño entre columnas y filas
  // Escala: fija mientras el caudal sea pequeño y normalizada a partir de ahí,
  // para que el diagrama nunca desborde su presupuesto. El diseño lo da como
  // `min(46, 250/total)`, es decir: 46 px/kW hasta 5,43 kW.
  const KW_LLENO = 250 / 46;
  const GAP = 14;          // separación entre segmentos de una misma columna
  const PASO = 40;         // paso mínimo entre centros de etiqueta (antirreapilado)

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
  const r1 = (v) => Math.round(v * 10) / 10;
  /* El color de un nodo: token del tema si lo tiene, y si no el literal que trae
     la configuración del electrodoméstico. Los dos valen en `fill` y en `stroke`. */
  const tono = (mapa, tintas, k) => (mapa[k] ? `var(${mapa[k]})` : (tintas[k] || "currentColor"));

  /* Cuánto mide un texto, de verdad. Hace falta para colocar las etiquetas de la
     versión estrecha: van una al lado de otra y hay que saber si chocan **antes**
     de dibujarlas. Con una estimación por número de caracteres se colaban
     solapes de unos pocos píxeles justo en los nombres largos, que son los que
     importan. Un canvas mide con la misma fuente y sin tocar el DOM. */
  let _ctx = null;
  const FUENTE = `"Geist", ui-sans-serif, system-ui, sans-serif`;
  function medir(texto, px, peso) {
    if (!_ctx) {
      const c = document.createElement("canvas");
      _ctx = c.getContext("2d");
    }
    if (!_ctx) return texto.length * px * 0.56;
    _ctx.font = `${peso} ${px}px ${FUENTE}`;
    return _ctx.measureText(texto).width;
  }

  const CSS = `
    :host { display: block; }
    svg { width: 100%; display: block; overflow: visible; }
    /* Nombre del nodo y su valor, con las medidas del diseño. */
    .n { font-size: 14px; font-weight: 600; letter-spacing: -.01em; fill: var(--ink); }
    .v { font-size: 12.5px; font-weight: 500; font-variant-numeric: tabular-nums; }
    /* El valor dentro de la cinta, cuando la cinta da para leerlo. */
    .dentro { font-size: 12px; font-weight: 600; fill: var(--sobre-cinta);
              font-variant-numeric: tabular-nums; }
    /* «Entra» / «Va a» y el pie con el caudal total. */
    .rot { font-size: 10.5px; font-weight: 600; letter-spacing: .13em;
           text-transform: uppercase; fill: var(--ink-3); }
    .pie { font-size: 12px; fill: var(--ink-3); font-variant-numeric: tabular-nums; }
    .guia { stroke-width: 1; stroke-opacity: .4; }
    /* La alternativa textual del diagrama, que pide el diseño: un Sankey no se
       puede resumir en una etiqueta, así que va la lista de pares con sus
       vatios. Se lee con lector de pantalla y no se ve. */
    .sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
          overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
    .empty { margin: 0; padding: 22px 8px 24px; text-align: center; font-size: 14px;
             line-height: 1.5; color: var(--ink-3); }
    .empty b { color: var(--ink-2); font-weight: 600; }
    /* Fila de contadores del día: hace de leyenda y de resumen a la vez. */
    .meters { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 14px 0 0;
              padding: 12px 0 0; border-top: 1px solid var(--hair);
              font-size: 12px; color: var(--ink-3); }
    .meters li { display: flex; align-items: center; gap: 6px; list-style: none; }
    /* Cuadrado, como las barras del diagrama: la muestra de color de la leyenda
       es una barra en miniatura y tiene que reconocerse como tal. */
    .meters i { width: 8px; height: 8px; flex: none; }
    .meters b { color: var(--ink-2); font-weight: 600;
                font-variant-numeric: tabular-nums; }
    /* Las partículas dan el sentido de la corriente. Se definen aquí dentro: las
       animaciones del documento no cruzan la frontera del shadow DOM. */
    @keyframes vf-dash { to { stroke-dashoffset: -320; } }
    .stream { stroke: var(--particula); stroke-linecap: round;
              stroke-dasharray: 2 26; opacity: .5;
              animation: vf-dash 3.4s linear infinite; }
    @media (prefers-reduced-motion: reduce) { .stream { animation: none; } }
  `;

  class VatiaFlow extends HTMLElement {
    constructor() {
      super();
      this._meters = true;
      this._ancho = 0;
    }

    set data(value) { this._data = value; this._flows = null; this._render(); }
    get data() { return this._data; }

    /* Un reparto suelto, sin el resto del payload: es lo que necesita la
       pantalla del día, que pinta un instante cualquiera del histórico. */
    set flows(value) { this._flows = value; this._render(); }
    set meters(value) { this._meters = value !== false; this._render(); }

    /* La casa por dentro: `[{id, name, color, watts}]`. Solo la usa el diagrama
       detallado; en la tarjeta de la Home la casa es un nodo y basta. */
    set split(value) { this._split = value; this._render(); }

    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      // La orientación depende del ancho, y el ancho de la ventana: hay que
      // repintar al girar el teléfono o al pasar de móvil a tablet.
      if (!this._ro && window.ResizeObserver) {
        this._ro = new ResizeObserver(() => {
          const w = Math.round(this.getBoundingClientRect().width);
          // Solo si cambia de verdad: el observador dispara también al pintar.
          if (w && Math.abs(w - this._ancho) >= 1) this._render();
        });
        this._ro.observe(this);
      }
      this._render();
    }

    disconnectedCallback() {
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
    }

    _render() {
      if (!this.shadowRoot) return;
      const d = this._data;
      const flows = this._flows || (d && d.flows) || null;
      if (!flows) { this.shadowRoot.innerHTML = `<style>${CSS}</style>`; return; }
      const ancho = Math.round(this.getBoundingClientRect().width) || 360;
      this._ancho = ancho;
      const meters = (d && d.energy && d.energy.meters) || null;
      const soc = d && d.power ? d.power.battery_soc : null;
      this.shadowRoot.innerHTML = `<style>${CSS}</style>
        ${this._caudal(flows, ancho)}
        ${this._meters && meters ? this._metersRow(meters, soc) : ""}`;
    }

    // Los contadores del día. Van fuera del SVG a propósito: con el ancho
    // entero se leen, y al lado de cada nodo no cabían sin recortarse.
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

    /* ---- el reparto, común a las dos orientaciones ----
       Cada columna apila sus segmentos con GAP entre ellos y se centra en el eje.
       Después cada cinta toma su hueco dentro del segmento con un cursor: los
       enlaces de un origen en el orden de los destinos y los de un destino en el
       de los orígenes. Es lo que evita que el haz se cruce consigo mismo. */
    _reparto(active, scale, mid, dstOrden) {
      const segmentos = (lado, orden) => {
        const tot = {};
        active.forEach((l) => { tot[l[lado]] = (tot[l[lado]] || 0) + l.w; });
        const list = orden.filter((k) => tot[k] > 0).map((k) => ({ k, w: tot[k] }));
        const alto = list.reduce((a, s) => a + s.w * scale, 0) + GAP * Math.max(0, list.length - 1);
        let b = mid - alto / 2;
        list.forEach((s) => { s.b0 = b; s.b1 = b + s.w * scale; s.cur = s.b0; b = s.b1 + GAP; });
        return list;
      };
      const src = segmentos("from", SRC_ORDER);
      const dst = segmentos("to", dstOrden);
      const buscar = (list, k) => list.find((s) => s.k === k);
      SRC_ORDER.forEach((from) => dstOrden.forEach((to) => {
        const l = active.find((x) => x.from === from && x.to === to);
        if (!l) return;
        const s = buscar(src, from);
        l.sb0 = s.cur; s.cur += l.w * scale; l.sb1 = s.cur;
      }));
      dstOrden.forEach((to) => SRC_ORDER.forEach((from) => {
        const l = active.find((x) => x.from === from && x.to === to);
        if (!l) return;
        const d = buscar(dst, to);
        l.db0 = d.cur; d.cur += l.w * scale; l.db1 = d.cur;
      }));
      return { src, dst };
    }

    /* Antirreapilado del diseño: el bloque de etiqueta ocupa lo suyo, así que en
       segmentos finos las etiquetas se solaparían. Se impone un paso mínimo
       empujando hacia delante; si la última se sale del tope, se desplaza todo y
       se reequilibra hacia atrás.
       `pasos[i]` es la distancia mínima entre el centro i−1 y el i. En las
       columnas es la constante del diseño (40 px, alto del bloque); en las filas
       depende de lo que mide cada nombre, porque con un paso único los nombres
       cortos se separaban de su barra sin necesidad. */
    _centros(list, pasos, piso, tope) {
      const c = list.map((s) => (s.b0 + s.b1) / 2);
      for (let i = 1; i < c.length; i++) if (c[i] - c[i - 1] < pasos[i]) c[i] = c[i - 1] + pasos[i];
      const sobra = c.length ? c[c.length - 1] - tope : 0;
      if (sobra > 0) for (let i = 0; i < c.length; i++) c[i] -= sobra;
      for (let i = c.length - 2; i >= 0; i--) if (c[i + 1] - c[i] < pasos[i + 1]) c[i] = c[i + 1] - pasos[i + 1];
      // Y si tras todo eso la primera se sale por el otro lado, no cabe: se
      // empuja el conjunto y se acepta el solape, que es mejor que salir del
      // lienzo y desaparecer.
      if (c.length && c[0] < piso) {
        const falta = piso - c[0];
        for (let i = 0; i < c.length; i++) c[i] += falta;
      }
      return c;
    }

    _caudal(flows, ancho) {
      const active = STREAMS
        .map((s) => ({ ...s, w: Math.max(0, flows[s.key] || 0) }))
        .filter((s) => s.w >= MIN_W);
      if (!active.length) return `<p class="empty">Ahora mismo no circula nada.</p>`;
      const total = active.reduce((a, s) => a + s.w, 0);
      // El total no cambia al partir la casa: es lo mismo, contado más fino.
      const d = ladoDerecho(active, this._split);
      const svg = ancho >= CORTE
        ? this._horizontal(d.partes, total, ancho, d)
        : this._vertical(d.partes, total, ancho, d);
      return svg + this._lista(active, total, d);
    }

    /* El diagrama en palabras: un par origen→destino por línea, dicho como se
       diría en voz alta y no como una tabla de claves. */
    _lista(active, total, d) {
      const DE = { solar: "Del sol", batt: "De la batería", grid: "De la red" };
      const A = { home: "a la casa", batt: "a la batería", grid: "a la red" };
      const filas = active.map((s) =>
        `<li>${DE[s.from]} ${A[s.to]}: ${esc(power(s.w))}</li>`);
      // Y si la casa está partida por dentro, también por dentro: es información
      // que solo estaba en la geometría, y quien no ve el diagrama la perdería.
      const dentro = (d.orden || []).filter((k) => !["home", "batt", "grid"].includes(k));
      if (dentro.length) {
        const trozos = dentro.map((k) => {
          const w = (d.partes || []).filter((l) => l.to === k).reduce((a, l) => a + l.w, 0);
          return `${d.nombre[k]}, ${power(w)}`;
        });
        const resto = (d.partes || []).filter((l) => l.to === "home")
          .reduce((a, l) => a + l.w, 0);
        if (resto > 0) trozos.push(`resto de la casa, ${power(resto)}`);
        filas.push(`<li>La casa por dentro: ${esc(trozos.join("; "))}</li>`);
      }
      return `<ul class="sr">${filas.join("")}
        <li>Caudal total: ${esc(power(total))}</li></ul>`;
    }

    /* Las cintas y las barras, en coordenadas abstractas (a = a lo largo del
       flujo, b = a lo ancho). Las dos orientaciones comparten esto entero: solo
       cambia cómo se proyecta (a, b) en (x, y). */
    _piezas(active, { A1, A2, AC, proj, dentro, d }) {
      const P = (a, b) => proj(a, b);
      const defs = [], bands = [], dots = [], valores = [];
      active.forEach((l, i) => {
        const id = `vf${i}`;
        const th = l.sb1 - l.sb0;
        /* La cinta nace y muere en el color exacto de su barra, y a opacidad
           llena: así no hay escalón donde se tocan y la cinta parece salir del
           rectángulo en vez de estar pegada a él. La traslucidez se guarda para
           el centro, que es donde las cintas se cruzan y hace falta ver por
           debajo, y el cambio de color se confina al tramo del medio —fuera de
           las dos zonas de contacto— para que cada extremo se lea del color de
           su nodo y no de una mezcla. */
        const cSrc = tono(SRC_COLOR, {}, l.from), cDst = tono(d.color, d.tinta, l.to);
        defs.push(
          `<linearGradient id="${id}" gradientUnits="userSpaceOnUse"
             x1="${P(A1, 0).split(",")[0]}" y1="${P(A1, 0).split(",")[1]}"
             x2="${P(A2, 0).split(",")[0]}" y2="${P(A2, 0).split(",")[1]}">
             <stop offset="0" style="stop-color:${cSrc}" stop-opacity="1"/>
             <stop offset=".07" style="stop-color:${cSrc}" stop-opacity=".88"/>
             <stop offset=".3" style="stop-color:${cSrc}" stop-opacity=".62"/>
             <stop offset=".7" style="stop-color:${cDst}" stop-opacity=".56"/>
             <stop offset=".93" style="stop-color:${cDst}" stop-opacity=".88"/>
             <stop offset="1" style="stop-color:${cDst}" stop-opacity="1"/>
           </linearGradient>`);
        bands.push(
          `<path fill="url(#${id})" d="M${P(A1, l.sb0)} C${P(AC, l.sb0)} ${P(AC, l.db0)} ${P(A2, l.db0)}
             L${P(A2, l.db1)} C${P(AC, l.db1)} ${P(AC, l.sb1)} ${P(A1, l.sb1)} Z"/>`);
        // Una línea central por cinta, si la cinta da para verla.
        if (th > 5) {
          const m0 = (l.sb0 + l.sb1) / 2, m1 = (l.db0 + l.db1) / 2;
          dots.push(
            `<path class="stream" fill="none" stroke-width="${Math.min(3.4, th * 0.26).toFixed(2)}"
               d="M${P(A1, m0)} C${P(AC, m0)} ${P(AC, m1)} ${P(A2, m1)}"/>`);
        }
        // El valor dentro de la cinta, solo si cabe sin tocar los bordes.
        if (dentro && th >= 17) {
          const b = (l.sb0 + l.sb1 + l.db0 + l.db1) / 4;
          valores.push(`<text class="dentro" text-anchor="middle"
            x="${P(AC, b).split(",")[0]}" y="${Number(P(AC, b).split(",")[1]) + 4}">${
            esc(power(l.w))}</text>`);
        }
      });
      return { defs, bands, dots, valores };
    }

    /* Las barras de una columna, entre sus dos bordes del eje del flujo. Alto
       mínimo de 3 px: un segmento muy fino tiene que verse igual.

       Esquinas en ángulo, a propósito. Redondeadas parecían pastillas sueltas
       en vez de los extremos de una cinta: la banda sale recta del borde y el
       redondeo dejaba un hueco claro justo ahí, además de comerse la punta de
       los segmentos finos, que son los que ya cuestan de ver. */
    _barras(list, { a0, a1, proj, colores, tintas = {} }) {
      return list.map((s) => {
        const [x, y] = proj(a0, s.b0).split(",").map(Number);
        const [x2, y2] = proj(a1, s.b1).split(",").map(Number);
        const w = Math.max(Math.abs(x2 - x), 3), h = Math.max(Math.abs(y2 - y), 3);
        return `<rect x="${r1(Math.min(x, x2))}" y="${r1(Math.min(y, y2))}"
          width="${r1(w)}" height="${r1(h)}" style="fill:${tono(colores, tintas, s.k)}"/>`;
      }).join("");
    }

    /* ---- ≥ 600 px: las columnas a los lados, como la maqueta ---- */
    _horizontal(active, total, ancho, d) {
      const ALTO = 352, MID = 176, BW = 54, TOPE = 322, PIE = 340;
      // El hueco para las etiquetas es lo que necesita el nombre más largo a
      // 14 px («Batería · descarga»); el resto es zona de cintas.
      const ETIQ = 150;
      const A1 = ETIQ + BW, A2 = ancho - ETIQ - BW, AC = (A1 + A2) / 2;
      const scale = Math.min(250 / KW_LLENO, 250 / Math.max(1.2, total / 1000)) / 1000;
      const { src, dst } = this._reparto(active, scale, MID, d.orden);
      const proj = (a, b) => `${r1(a)},${r1(b)}`;
      const { defs, bands, dots, valores } = this._piezas(active, { A1, A2, AC, proj, dentro: true, d });

      const labels = [];
      const lado = (list, izq) => {
        const barra = izq ? A1 : A2 + BW;      // borde exterior de la barra
        const tx = izq ? barra - BW - 16 : barra + 16;
        const anchor = izq ? "end" : "start";
        const centros = this._centros(list, list.map(() => PASO), 38, TOPE);
        list.forEach((s, i) => {
          const cy = centros[i], real = (s.b0 + s.b1) / 2;
          // Si la etiqueta se ha tenido que separar de su barra, una guía dice
          // de quién es: sin ella, el nombre parece de la barra de al lado.
          if (Math.abs(cy - real) > 6) {
            const ex = izq ? tx + 6 : tx - 6;
            labels.push(`<line class="guia" x1="${r1(ex)}" y1="${r1(cy - 4)}"
              x2="${r1(izq ? A1 : A2)}" y2="${r1(real)}"
              style="stroke:${izq ? tono(SRC_COLOR, {}, s.k) : tono(d.color, d.tinta, s.k)}"/>`);
          }
          labels.push(`<text class="n" x="${r1(tx)}" y="${r1(cy - 4)}" text-anchor="${anchor}">${
            esc(izq ? SRC_NAME[s.k] : d.nombre[s.k])}</text>
            <text class="v" x="${r1(tx)}" y="${r1(cy + 14)}" text-anchor="${anchor}"
              style="fill:${izq ? tono(SRC_COLOR, {}, s.k) : tono(d.color, d.tinta, s.k)}">${
              esc(power(s.w))}</text>`);
        });
      };
      lado(src, true);
      lado(dst, false);

      return `<svg viewBox="0 0 ${ancho} ${ALTO}" role="img"
             aria-label="Caudal de energía en tiempo real">
          <defs>${defs.join("")}</defs>
          <text class="rot" x="2" y="20" text-anchor="start">Entra</text>
          <text class="rot" x="${ancho - 2}" y="20" text-anchor="end">Va a</text>
          <g>${bands.join("")}</g><g>${dots.join("")}</g>
          <g>${this._barras(src, { a0: A1 - BW, a1: A1, proj, colores: SRC_COLOR })}${
                this._barras(dst, { a0: A2, a1: A2 + BW, proj, colores: d.color, tintas: d.tinta })}</g>
          <g>${labels.join("")}${valores.join("")}</g>
          <text class="pie" x="${r1(AC)}" y="${PIE}" text-anchor="middle">Caudal total ${
            esc(power(total))}</text>
        </svg>`;
    }

    /* ---- < 600 px: entradas arriba, salidas abajo ----
       El diseño deja el móvil a nuestro cargo y dice cómo: las dos columnas
       pasan a filas y las cintas giran 90°. Las etiquetas van fuera de la zona
       de cintas —arriba las de entrada, abajo las de salida— y en dos líneas,
       porque «Batería · descarga» a 14 px no cabe en un tercio de un teléfono. */
    _vertical(active, total, ancho, d) {
      const MARGEN = 4, BW = 34, TRAMO = 132, ETIQ = 38, PIE = 20;
      const A1 = ETIQ + BW;                 // borde inferior de la fila de entrada
      const A2 = A1 + TRAMO;                // borde superior de la fila de salida
      const AC = (A1 + A2) / 2;
      const ALTO = A2 + BW + ETIQ + PIE;
      const MID = ancho / 2;
      // El presupuesto se calcula con **tres** segmentos siempre, aunque ahora
      // haya uno: si dependiera de los que hay, la escala daría un salto al
      // aparecer una corriente y el diagrama parecería cambiar de unidades.
      const budget = Math.max(60, ancho - 2 * MARGEN - 2 * GAP);
      const scale = Math.min(budget / KW_LLENO, budget / Math.max(1.2, total / 1000)) / 1000;
      const { src, dst } = this._reparto(active, scale, MID, d.orden);
      const proj = (a, b) => `${r1(b)},${r1(a)}`;
      // Dentro de una cinta vertical de 34 px de ancho no cabe el valor con
      // holgura: el número va en la etiqueta, que aquí está al lado.
      const { defs, bands, dots } = this._piezas(active, { A1, A2, AC, proj, dentro: false, d });

      const labels = [];
      const fila = (list, arriba) => {
        const y = arriba ? ETIQ - 20 : A2 + BW + 16;
        // Dos líneas por etiqueta: el nombre y, debajo, el sufijo con el valor.
        const textos = list.map((s) => {
          const [nombre, sufijo] = (arriba ? SRC_SHORT : d.corto)[s.k];
          return [nombre, sufijo ? `${sufijo} · ${power(s.w)}` : power(s.w)];
        });
        // Media anchura de cada bloque, medida, más 5 px de aire a cada lado.
        const medios = textos.map(([n, v]) =>
          Math.max(medir(n, 14, 600), medir(v, 12.5, 500)) / 2 + 5);
        const pasos = medios.map((m, i) => (i ? medios[i - 1] + m : 0));
        const centros = this._centros(list, pasos, medios[0], ancho - medios[medios.length - 1]);
        list.forEach((s, i) => {
          const cx = centros[i], real = (s.b0 + s.b1) / 2;
          const [nombre, valor] = textos[i];
          const color = arriba ? tono(SRC_COLOR, {}, s.k) : tono(d.color, d.tinta, s.k);
          if (Math.abs(cx - real) > 6) {
            labels.push(`<line class="guia" x1="${r1(cx)}" y1="${r1(arriba ? y + 4 : y - 12)}"
              x2="${r1(real)}" y2="${r1(arriba ? A1 - BW : A2 + BW)}"
              style="stroke:${color}"/>`);
          }
          labels.push(`<text class="n" x="${r1(cx)}" y="${y}" text-anchor="middle">${
            esc(nombre)}</text>
            <text class="v" x="${r1(cx)}" y="${y + 15}" text-anchor="middle"
              style="fill:${color}">${esc(valor)}</text>`);
        });
      };
      fila(src, true);
      fila(dst, false);

      return `<svg viewBox="0 0 ${ancho} ${ALTO}" role="img"
             aria-label="Caudal de energía en tiempo real">
          <defs>${defs.join("")}</defs>
          <g>${bands.join("")}</g><g>${dots.join("")}</g>
          <g>${this._barras(src, { a0: A1 - BW, a1: A1, proj, colores: SRC_COLOR })}${
                this._barras(dst, { a0: A2, a1: A2 + BW, proj, colores: d.color, tintas: d.tinta })}</g>
          <g>${labels.join("")}</g>
          <text class="pie" x="${r1(MID)}" y="${ALTO - 4}" text-anchor="middle">Caudal total ${
            esc(power(total))}</text>
        </svg>`;
    }
  }

  if (!customElements.get("vatia-flow")) customElements.define("vatia-flow", VatiaFlow);
})();

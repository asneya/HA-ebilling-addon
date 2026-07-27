/*
 * <vatia-chart> — el gráfico de la pantalla de Energía, sobre uPlot.
 *
 * Sustituye al SVG que se regeneraba entero en cada fotograma. Ese enfoque
 * creaba ~1.700 nodos por repintado y el recolector de basura se notaba en el
 * pellizco; con canvas, 288 puntos × 6 series se pintan de una vez.
 *
 * El cambio de fondo es que el zoom ya no ensancha un elemento del DOM para
 * luego desplazarlo: mueve el rango del eje X. Por eso el pellizco puede ir
 * fluido — no se redibuja el documento, se redibuja el lienzo.
 *
 * Uso:
 *   const g = document.createElement('vatia-chart');
 *   g.data = { x: [iso…], series: [{key,label,values,dashed,legend}…] };
 *   g.hidden = new Set(['grid_export']);   // series apagadas en la leyenda
 *   g.addEventListener('pick', (e) => e.detail.index);   // punto fijado
 *   g.addEventListener('range', (e) => e.detail);        // {min,max} del eje
 *
 * Los colores los pone quien lo usa (`colorFor`), porque salen de los tokens
 * del tema y el componente no tiene por qué saber de dónde vienen.
 */
(() => {
  "use strict";

  const ALTO = 268;

  /* Hora local de la casa: se lee el desfase que trae la cadena del servidor y
     se desplaza el instante, igual que en la ventana de energía. Con el reloj
     del navegador, el eje saldría desplazado al mirarlo desde otro país. */
  const offsetOf = (iso) => {
    const m = /([+-])(\d{2}):?(\d{2})$/.exec(String(iso));
    if (!m) return 0;
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  };

  // uPlot formatea en inglés por defecto y salía «6,000» donde toca «6.000».
  const nfY = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });

  class VatiaChart extends HTMLElement {
    constructor() {
      super();
      this._hidden = new Set();
      this._colorFor = () => "#888";
      this._fmtX = (ms) => String(ms);
    }

    /* Quién decide los colores y las etiquetas del eje: la página, que conoce
       los tokens del tema y el rango elegido. */
    set colorFor(fn) { this._colorFor = fn; }
    set formatX(fn) { this._fmtX = fn; }

    set data(value) {
      this._data = value;
      this._build();
    }
    get data() { return this._data; }

    set hidden(set) {
      this._hidden = new Set(set || []);
      // Apagar una serie no rehace el gráfico: uPlot la esconde y reescala.
      if (this._plot) this._syncVisible();
    }

    /* Repinta con los colores de ahora, para cuando cambia el tema. */
    repaint() { this._build(); }

    connectedCallback() {
      if (!this._host) {
        this._host = document.createElement("div");
        this._host.className = "vc-host";
        this.appendChild(this._host);
      }
      this._build();
      if (!this._ro && window.ResizeObserver) {
        // uPlot necesita un tamaño explícito, así que se le da el del hueco.
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(this);
      }
    }

    disconnectedCallback() {
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      if (this._plot) { this._plot.destroy(); this._plot = null; }
    }

    _width() { return Math.max(240, this.clientWidth || 320); }

    _resize() {
      if (this._plot) this._plot.setSize({ width: this._width(), height: ALTO });
    }

    /* Las series visibles, en el orden en que se pintan: «ayer» al fondo para
       que no tape la curva del día. */
    _ordered() {
      const vis = (this._data.series || []).filter((s) => !this._hidden.has(s.key));
      return vis.filter((s) => s.key === "yesterday")
        .concat(vis.filter((s) => s.key !== "yesterday"));
    }

    _syncVisible() {
      const vivas = this._ordered().map((s) => s.key);
      this._orderKeys.forEach((key, i) => {
        this._plot.setSeries(i + 1, { show: vivas.includes(key) }, false);
      });
      this._plot.redraw();
    }

    _build() {
      if (!this.isConnected || !this._host) return;
      const d = this._data;
      if (this._plot) { this._plot.destroy(); this._plot = null; }
      if (!d || !d.x || !d.x.length) { this._host.textContent = ""; return; }

      // uPlot trabaja con números: el eje son segundos de época, y el desfase de
      // la casa se aplica al formatear.
      const off = offsetOf(d.x[0]) * 60;
      const xs = d.x.map((iso) => new Date(iso).getTime() / 1000);
      const orden = this._ordered();
      this._orderKeys = orden.map((s) => s.key);

      const datos = [xs, ...orden.map((s) => s.values.map((v) => (v == null ? null : v)))];

      const series = orden.map((s) => {
        const color = this._colorFor(s.key);
        const tenue = s.key === "yesterday";
        return {
          label: s.label || s.key,
          stroke: color,
          width: s.dashed || tenue ? 1.8 : 2.2,
          // La previsión va punteada y sin relleno; el resto, línea con su área.
          // El relleno se apaga con un color transparente y no con `undefined`:
          // uPlot pone uno por defecto cuando la propiedad no viene, y la
          // previsión salía con área.
          dash: s.dashed ? [2.5, 4.5] : undefined,
          fill: s.dashed ? "rgba(0,0,0,0)" : gradiente(color, tenue ? 0.16 : 0.34),
          // Los huecos no se interpolan: `null` deja el hueco, que es lo que
          // distingue «no hay dato» de «hay un cero».
          spanGaps: false,
          points: { show: false },
          value: (_u, v) => (v == null ? "—" : v),
        };
      });

      const self = this;
      this._plot = new uPlot({
        width: this._width(),
        height: ALTO,
        padding: [12, 10, 0, 0],
        legend: { show: false },      // la leyenda es la de la página, pulsable
        cursor: {
          y: false,
          drag: { x: true, y: false },   // arrastrar para acercar, en escritorio
          points: { size: 8, width: 2 },
          // Al mover el cursor se avisa del punto, que es lo que rellena la
          // leyenda con los valores de ese instante.
          bind: { mouseup: (u, t, f) => (e) => { f(e); self._emitPick(); return null; } },
        },
        scales: { x: { time: true }, y: { range: rangoY } },
        axes: [
          {
            stroke: this._colorFor("--ink-3"),
            grid: { show: false },
            ticks: { show: false },
            font: "11px Geist, sans-serif",
            size: 30,
            values: (_u, vals) => vals.map((v) => self._fmtX((v + off) * 1000)),
          },
          {
            stroke: this._colorFor("--ink-3"),
            grid: { stroke: this._colorFor("--hair"), width: 1 },
            ticks: { show: false },
            font: "11px Geist, sans-serif",
            size: 46,
            values: (_u, vals) => vals.map((v) => nfY.format(v)),
          },
        ],
        series: [{ value: (_u, v) => (v == null ? "" : v) }, ...series],
        hooks: {
          setCursor: [() => self._emitHover()],
          setScale: [(u, key) => {
            if (key !== "x") return;
            const s = u.scales.x;
            self.dispatchEvent(new CustomEvent("range", {
              detail: { min: s.min, max: s.max, full: s.min <= xs[0] && s.max >= xs[xs.length - 1] },
            }));
          }],
        },
      }, datos, this._host);

      this._pinch();
    }

    _emitHover() {
      const i = this._plot.cursor.idx;
      if (i === this._lastHover) return;
      this._lastHover = i;
      this.dispatchEvent(new CustomEvent("hover", { detail: { index: i ?? null } }));
    }

    _emitPick() {
      this.dispatchEvent(new CustomEvent("pick",
        { detail: { index: this._plot.cursor.idx ?? null } }));
    }

    /* Pellizco: mueve el rango del eje en vez de estirar el DOM. Se ancla el
       punto que queda entre los dedos, que es lo que hace que el gesto se sienta
       agarrado a los datos y no a la pantalla. */
    _pinch() {
      const dedos = new Map();
      let inicio = null;
      const over = this._plot.over;

      const xEn = (clientX) => {
        const r = over.getBoundingClientRect();
        return this._plot.posToVal(clientX - r.left, "x");
      };

      over.addEventListener("pointerdown", (ev) => {
        dedos.set(ev.pointerId, ev.clientX);
        if (dedos.size === 2) {
          const [a, b] = [...dedos.values()];
          const s = this._plot.scales.x;
          inicio = { sep: Math.abs(a - b), min: s.min, max: s.max,
                     ancla: xEn((a + b) / 2) };
        }
      }, { passive: true });

      over.addEventListener("pointermove", (ev) => {
        if (!dedos.has(ev.pointerId)) return;
        dedos.set(ev.pointerId, ev.clientX);
        if (dedos.size !== 2 || !inicio) return;
        const [a, b] = [...dedos.values()];
        const sep = Math.abs(a - b);
        if (sep < 20 || inicio.sep < 20) return;
        const factor = inicio.sep / sep;              // separar dedos = acercar
        const izq = inicio.ancla - inicio.min;
        const der = inicio.max - inicio.ancla;
        this._plot.setScale("x", {
          min: inicio.ancla - izq * factor,
          max: inicio.ancla + der * factor,
        });
      }, { passive: true });

      const soltar = (ev) => {
        dedos.delete(ev.pointerId);
        if (dedos.size < 2) inicio = null;
      };
      over.addEventListener("pointerup", soltar, { passive: true });
      over.addEventListener("pointercancel", soltar, { passive: true });
    }

    /* Vuelve al periodo completo. */
    resetZoom() {
      if (this._plot) this._plot.setScale("x", { min: null, max: null });
    }
  }

  /* Relleno degradado bajo la línea. uPlot acepta una función que recibe el
     contexto, así que el degradado se crea con la altura real del área. */
  function gradiente(color, alpha) {
    return (u) => {
      const { ctx } = u;
      const g = ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
      g.addColorStop(0, mezcla(color, alpha));
      g.addColorStop(1, mezcla(color, 0.02));
      return g;
    };
  }

  /* El color con transparencia. Se admite «#rrggbb» y cualquier forma que el
     navegador ya haya resuelto a rgb(). */
  function mezcla(color, alpha) {
    const hex = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
    if (hex) {
      const n = parseInt(hex[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    }
    const rgb = /rgba?\(([^)]+)\)/.exec(String(color));
    if (rgb) {
      const [r, g, b] = rgb[1].split(",").map((v) => parseFloat(v));
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return color;
  }

  /* Eje Y desde cero y con el techo redondeado, para que no salgan cifras
     arbitrarias. uPlot deja elegir el rango entero. */
  function rangoY(_u, _min, max) {
    const tope = Math.max(max, 0.1) * 1.06;
    const pow = Math.pow(10, Math.floor(Math.log10(tope / 4)));
    const paso = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
      .map((m) => m * pow).find((v) => v * 4 >= tope) || pow * 10;
    return [0, paso * 4];
  }

  if (!customElements.get("vatia-chart")) customElements.define("vatia-chart", VatiaChart);
})();

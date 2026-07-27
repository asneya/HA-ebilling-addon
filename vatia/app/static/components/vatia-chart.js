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
    /* «time» (por defecto) usa las cadenas ISO de `x`; «index» las trata como
       etiquetas ya formateadas, para las series que no van sobre el reloj. */
    set xMode(mode) { this._xMode = mode; }
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

      const porIndice = this._xMode === "index";
      // uPlot trabaja con números: en modo tiempo son segundos de época y el
      // desfase de la casa se aplica al formatear; en modo índice, la posición.
      const off = porIndice ? 0 : offsetOf(d.x[0]) * 60;
      const xs = porIndice
        ? d.x.map((_, i) => i)
        : d.x.map((iso) => new Date(iso).getTime() / 1000);
      const orden = this._ordered();
      this._orderKeys = orden.map((s) => s.key);

      const datos = [xs, ...orden.map((s) => s.values.map((v) => (v == null ? null : v)))];

      const ratio = window.devicePixelRatio || 1;
      const series = orden.map((s) => {
        const color = this._colorFor(s.key);
        const tenue = s.key === "yesterday";
        return {
          label: s.label || s.key,
          stroke: color,
          width: s.dashed ? 2 : (tenue ? 1.8 : 2.2),
          // La previsión va punteada y sin relleno; el resto, línea con su área.
          // El relleno se apaga con un color transparente y no con `undefined`:
          // uPlot pone uno por defecto cuando la propiedad no viene, y la
          // previsión salía con área.
          //
          // El patrón de la maqueta es 6/5, en píxeles de CSS. uPlot escala el
          // grosor por la densidad de pantalla pero pasa el guion tal cual al
          // lienzo, así que hay que escalarlo aquí: en una pantalla 2× un 6/5
          // sin escalar sale como un 3/2,5 y la línea parece casi continua.
          dash: s.dashed ? [6 * ratio, 5 * ratio] : undefined,
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
        scales: {
          x: porIndice ? { time: false } : { time: true },
          y: { range: rangoY },
        },
        axes: [
          {
            stroke: this._colorFor("--ink-3"),
            grid: { show: false },
            ticks: { show: false },
            font: "11px Geist, sans-serif",
            size: 30,
            values: (_u, vals) => vals.map((v) => (porIndice
              ? (d.x[Math.round(v)] ?? "")
              : self._fmtX((v + off) * 1000))),
            splits: porIndice
              ? () => xs.filter((i) => xs.length <= 16 || i % Math.ceil(xs.length / 16) === 0)
              : undefined,
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
            // El punto fijado se vuelve a marcar: el zoom no debe perderlo.
            if (self._picked != null) requestAnimationFrame(() => self._markPicked());
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
      this._picked = this._plot.cursor.idx ?? null;
      this.dispatchEvent(new CustomEvent("pick", { detail: { index: this._picked } }));
    }

    /* El punto fijado, que sobrevive al zoom. `null` lo suelta. */
    set picked(i) { this._picked = i; this._markPicked(); }
    get picked() { return this._picked; }

    /* Se vuelve a poner el cursor de uPlot donde está el punto fijado. Sin esto,
       al mover el rango del eje el cursor se recolocaba y la leyenda se quedaba
       sin los valores del punto. */
    _markPicked() {
      if (!this._plot) return;
      const i = this._picked;
      if (i == null) { this._plot.setCursor({ left: -10, top: -10 }); return; }
      const xs = this._plot.data[0];
      if (i < 0 || i >= xs.length) return;
      const s = this._plot.scales.x;
      // Si el punto se queda fuera de lo que se ve, se trae el eje hasta él en
      // vez de perderlo: es el punto que la persona ha elegido.
      if (xs[i] < s.min || xs[i] > s.max) {
        const medio = (s.max - s.min) / 2;
        this._plot.setScale("x", {
          min: Math.max(xs[0], xs[i] - medio),
          max: Math.min(xs[xs.length - 1], xs[i] + medio),
        });
      }
      const left = this._plot.valToPos(xs[i], "x");
      this._plot.setCursor({ left, top: this._plot.bbox.height / 2 / devicePixelRatio });
    }

    /* Gestos.
       Con un dedo: el navegador se queda el desplazamiento vertical de la
       página —`touch-action: pan-y`— y nosotros el horizontal, que sirve para
       recorrer el eje cuando está ampliado. Con dos: pellizco, anclado al punto
       que queda entre los dedos.

       El reparto importa: antes se capturaba todo y no se podía bajar por la
       página con el dedo encima del gráfico. */
    _pinch() {
      const dedos = new Map();
      let inicio = null;      // estado al empezar el pellizco
      let arrastre = null;    // estado al empezar el arrastre de un dedo
      const over = this._plot.over;

      const valorEn = (clientX) => {
        const r = over.getBoundingClientRect();
        return this._plot.posToVal(clientX - r.left, "x");
      };
      const limites = () => {
        const xs = this._plot.data[0];
        return [xs[0], xs[xs.length - 1]];
      };
      const ampliado = () => {
        const s = this._plot.scales.x;
        const [a, b] = limites();
        return s.min > a + 1e-9 || s.max < b - 1e-9;
      };

      over.addEventListener("pointerdown", (ev) => {
        dedos.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        if (dedos.size === 1) {
          const s = this._plot.scales.x;
          arrastre = { x: ev.clientX, y: ev.clientY, min: s.min, max: s.max,
                       porUnidad: (s.max - s.min) / over.clientWidth, movido: false };
        } else if (dedos.size === 2) {
          arrastre = null;
          const [a, b] = [...dedos.values()];
          const s = this._plot.scales.x;
          inicio = { sep: Math.abs(a.x - b.x), min: s.min, max: s.max,
                     ancla: valorEn((a.x + b.x) / 2) };
        }
      }, { passive: true });

      over.addEventListener("pointermove", (ev) => {
        if (!dedos.has(ev.pointerId)) return;
        dedos.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

        if (dedos.size === 2 && inicio) {
          const [a, b] = [...dedos.values()];
          const sep = Math.abs(a.x - b.x);
          if (sep < 20 || inicio.sep < 20) return;
          const factor = inicio.sep / sep;         // separar los dedos = acercar
          const izq = inicio.ancla - inicio.min;
          const der = inicio.max - inicio.ancla;
          const [lo, hi] = limites();
          this._plot.setScale("x", {
            min: Math.max(lo, inicio.ancla - izq * factor),
            max: Math.min(hi, inicio.ancla + der * factor),
          });
          return;
        }

        // Un dedo: solo se recorre el eje si hay zoom y el gesto es claramente
        // horizontal. Si no, se deja pasar y la página se desplaza.
        if (dedos.size !== 1 || !arrastre || !ampliado()) return;
        const dx = ev.clientX - arrastre.x;
        const dy = ev.clientY - arrastre.y;
        if (!arrastre.movido) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          if (Math.abs(dy) > Math.abs(dx)) { arrastre = null; return; }  // es scroll
          arrastre.movido = true;
        }
        const [lo, hi] = limites();
        const ancho = arrastre.max - arrastre.min;
        let min = arrastre.min - dx * arrastre.porUnidad;
        min = Math.max(lo, Math.min(hi - ancho, min));
        this._plot.setScale("x", { min, max: min + ancho });
      }, { passive: true });

      const soltar = (ev) => {
        dedos.delete(ev.pointerId);
        if (dedos.size < 2) inicio = null;
        if (dedos.size === 0) arrastre = null;
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

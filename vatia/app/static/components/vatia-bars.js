/*
 * <vatia-bars> — barras apiladas y agrupadas, sobre uPlot.
 *
 * Los dos gráficos de barras de Facturación: el consumo diario repartido por
 * tramo de la tarifa, y el desglose por horas. Ambos enfrentan lo importado
 * (apilado por tramo) con lo exportado (una barra al lado), que es la
 * comparación que interesa.
 *
 * uPlot es una capa fina y no apila por sí solo, así que el apilado se hace
 * aquí: cada serie se dibuja con la suma de las que van debajo y se pintan de
 * la más alta a la más baja, de modo que cada una tapa a la anterior y quedan a
 * la vista solo los tramos. Es el «hook propio» que el documento de decisiones
 * dice que hay que aceptar como precio de usar uPlot, y son treinta líneas.
 *
 * Uso:
 *   const b = document.createElement('vatia-bars');
 *   b.colorFor = (clave) => '#…';
 *   b.data = {
 *     labels: ['01','02',…],            // eje X, ya formateado
 *     stack:  [{key,label,values}…],    // se apilan en la barra izquierda
 *     side:   [{key,label,values}…],    // barra derecha, sin apilar
 *     unit: 'kWh',
 *     selected: 3,                      // índice resaltado, opcional
 *   };
 *   b.addEventListener('pick', (e) => e.detail.index);
 */
(() => {
  "use strict";

  const nf = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });

  class VatiaBars extends HTMLElement {
    constructor() {
      super();
      this._colorFor = () => "#888";
      this._alto = 240;
    }

    set colorFor(fn) { this._colorFor = fn; }
    set height(px) { this._alto = px; }
    set data(value) { this._data = value; this._build(); }
    get data() { return this._data; }

    repaint() { this._build(); }

    connectedCallback() {
      if (!this._host) {
        this._host = document.createElement("div");
        this.appendChild(this._host);
      }
      this._build();
      if (!this._ro && window.ResizeObserver) {
        this._ro = new ResizeObserver(() => {
          if (this._plot) this._plot.setSize({ width: this._ancho(), height: this._alto });
        });
        this._ro.observe(this);
      }
    }

    disconnectedCallback() {
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      if (this._plot) { this._plot.destroy(); this._plot = null; }
    }

    _ancho() { return Math.max(240, this.clientWidth || 320); }

    /* Los valores de un punto, para poder pedirlos sin esperar a un gesto. */
    readAt(i) { return this._readAt ? this._readAt(i) : null; }

    _build() {
      if (!this.isConnected || !this._host) return;
      if (this._plot) { this._plot.destroy(); this._plot = null; }
      const d = this._data;
      if (!d || !d.labels || !d.labels.length) {
        this._host.innerHTML = `<p class="empty">Sin datos.</p>`;
        return;
      }
      this._host.textContent = "";

      const n = d.labels.length;
      const xs = Array.from({ length: n }, (_, i) => i);
      const pila = d.stack || [];
      const lado = d.side || [];

      // Apilado: cada serie lleva la suma de las que tiene debajo. Se pintan de
      // la más alta a la más baja para que cada una tape a la anterior.
      const acumuladas = pila.map((_, k) =>
        xs.map((i) => pila.slice(0, k + 1)
          .reduce((t, s) => t + Math.max(s.values[i] || 0, 0), 0)));
      const ordenPila = pila.map((s, k) => ({ s, valores: acumuladas[k] })).reverse();

      const conLado = lado.some((s) => s.values.some((v) => v > 0));
      const seriesLado = conLado ? lado : [];

      // Alto real de cada tramo, para el texto del cursor: la serie acumulada
      // diría «valle + llano», que no es lo que se ha consumido en llano.
      const propio = new Map();
      pila.forEach((s) => propio.set(s.key, s.values));
      seriesLado.forEach((s) => propio.set(s.key, s.values));

      const self = this;
      const barra = (align, ancho) => uPlot.paths.bars({
        size: [ancho, 22], align,
        radius: 0.35,
      });

      const series = [
        {},
        ...ordenPila.map(({ s }) => ({
          label: s.label, key: s.key,
          stroke: "transparent",
          fill: self._colorFor(s.key),
          paths: barra(seriesLado.length ? -1 : 0, seriesLado.length ? 0.42 : 0.7),
          points: { show: false },
          value: (_u, _v, _si, i) => valorDe(s.key, i),
        })),
        ...seriesLado.map((s) => ({
          label: s.label, key: s.key,
          stroke: "transparent",
          fill: self._colorFor(s.key),
          paths: barra(1, 0.42),
          points: { show: false },
          value: (_u, _v, _si, i) => valorDe(s.key, i),
        })),
      ];

      function valorDe(key, i) {
        const v = propio.get(key);
        return v && v[i] != null ? `${nf.format(v[i])} ${d.unit || ""}` : "—";
      }

      const datos = [
        xs,
        ...ordenPila.map(({ valores }) => valores),
        ...seriesLado.map((s) => s.values.map((v) => Math.max(v || 0, 0))),
      ];

      this._plot = new uPlot({
        width: this._ancho(),
        height: this._alto,
        padding: [10, 6, 0, 0],
        legend: { show: false },
        cursor: {
          y: false,
          drag: { x: false, y: false },
          points: { show: false },
        },
        scales: {
          // Media unidad de margen a cada lado para que la primera y la última
          // barra no queden cortadas por el borde.
          x: { time: false, range: () => [-0.5, n - 0.5] },
          y: { range: (_u, _min, max) => [0, techo(max)] },
        },
        axes: [
          {
            stroke: this._colorFor("--ink-3"),
            grid: { show: false }, ticks: { show: false },
            font: "11px Geist, sans-serif", size: 28,
            // Las etiquetas ya vienen formateadas; se saltan las que no caben.
            splits: () => xs.filter((i) => n <= 16 || i % Math.ceil(n / 16) === 0),
            values: (_u, vals) => vals.map((i) => d.labels[i] ?? ""),
          },
          {
            stroke: this._colorFor("--ink-3"),
            grid: { stroke: this._colorFor("--hair"), width: 1 },
            ticks: { show: false },
            font: "11px Geist, sans-serif", size: 44,
            values: (_u, vals) => vals.map((v) => nf.format(v)),
          },
        ],
        series,
        hooks: {
          // El aviso del cursor va en el hook y no en un `pointermove` propio:
          // así se lee cuando uPlot ya ha colocado el índice, no antes.
          setCursor: [(u) => {
            const i = u.cursor.idx;
            if (i === self._ultimo) return;
            self._ultimo = i;
            self.dispatchEvent(new CustomEvent("hover",
              { detail: { index: i ?? null, read: self._readAt ? self._readAt(i ?? null) : null } }));
          }],
          // El día elegido se marca con una banda detrás de las barras.
          drawClear: [(u) => {
            const sel = d.selected;
            if (sel == null || sel < 0 || sel >= n) return;
            const { ctx } = u;
            const x0 = u.valToPos(sel - 0.5, "x", true);
            const x1 = u.valToPos(sel + 0.5, "x", true);
            ctx.save();
            ctx.fillStyle = self._colorFor("--seg-track");
            ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height);
            ctx.restore();
          }],
        },
      }, datos, this._host);

      // Tocar una barra elige su punto (el día, en el gráfico diario).
      // Los valores del punto, para la línea de lectura de la página.
      this._readAt = (i) => (i == null ? null : {
        index: i,
        label: d.labels[i],
        rows: [...pila, ...seriesLado]
          .map((x) => ({ key: x.key, label: x.label, value: (propio.get(x.key) || [])[i] || 0 }))
          .filter((r) => r.value > 0),
        unit: d.unit || "",
      });

      this._plot.over.addEventListener("click", () => {
        const i = this._plot.cursor.idx;
        if (i != null) {
          this.dispatchEvent(new CustomEvent("pick",
            { detail: { index: i, read: this._readAt(i) } }));
        }
      });
      this._plot.over.style.touchAction = "pan-y";
      this._recorrer();
    }

    /* Deslizar el dedo recorre las barras.
       uPlot solo escucha el ratón, y arrastrar un dedo no genera `mousemove`:
       sin esto, en el móvil la lectura solo cambiaba al tocar una barra. Se
       coloca el cursor a mano y del resto —índice, banda, aviso— ya se encarga
       el `setCursor` de arriba. Si el gesto arranca vertical se suelta, para no
       quedarse el desplazamiento de la página. */
    _recorrer() {
      const over = this._plot.over;
      let desde = null;
      over.addEventListener("pointerdown", (ev) => {
        desde = { x: ev.clientX, y: ev.clientY, movido: false };
      }, { passive: true });
      over.addEventListener("pointermove", (ev) => {
        if (!desde || !this._plot) return;
        const dx = ev.clientX - desde.x, dy = ev.clientY - desde.y;
        if (!desde.movido) {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
          if (Math.abs(dy) > Math.abs(dx)) { desde = null; return; }
          desde.movido = true;
        }
        const r = over.getBoundingClientRect();
        const x = Math.max(0, Math.min(over.clientWidth, ev.clientX - r.left));
        this._plot.setCursor({ left: x, top: over.clientHeight / 2 });
      }, { passive: true });
      const soltar = () => { desde = null; };
      over.addEventListener("pointerup", soltar, { passive: true });
      over.addEventListener("pointercancel", soltar, { passive: true });
    }
  }

  /* Techo redondeado, para que el eje no enseñe cifras arbitrarias. */
  function techo(max) {
    const tope = Math.max(max, 0.1) * 1.06;
    const pow = Math.pow(10, Math.floor(Math.log10(tope / 4)));
    const paso = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
      .map((m) => m * pow).find((v) => v * 4 >= tope) || pow * 10;
    return paso * 4;
  }

  if (!customElements.get("vatia-bars")) customElements.define("vatia-bars", VatiaBars);
})();

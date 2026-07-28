/*
 * <vatia-skeleton> — el esqueleto de carga del §04.
 *
 * No es una barra de progreso ni un remolino en el centro: imita la **forma**
 * del contenido que va a llegar —una curva gruesa donde irá la serie, cuatro
 * filas de leyenda— para que el salto al dato real no mueva nada de sitio. Ese
 * es todo el punto, y es la razón de que sea un componente y no un `.hidden`
 * más: la forma tiene que parecerse a lo que sustituye.
 *
 * Del documento de diseño, literal:
 *   · pulso de 1,4 s en un **barrido diagonal**, no en la opacidad de cada
 *     bloque (un bloque que late parece roto; un barrido parece que carga);
 *   · tras 8 s aparece «Está tardando más de lo normal» con opción de cancelar;
 *   · §07: los esqueletos se animan **solo mientras se ven**, con
 *     IntersectionObserver y visibilitychange. Nada animado en segundo plano.
 *
 * Uso:
 *   const s = document.createElement('vatia-skeleton');
 *   s.shape = 'chart';                      // «chart» | «rows» | «flow»
 *   s.label = 'Leyendo estadísticas del recorder…';
 *   s.addEventListener('cancel', () => controlador.abort());
 *   // y al acabar, se quita del documento: no hace falta apagar nada.
 */
(() => {
  "use strict";

  const TARDA_MS = 8000;

  const CSS = `
    :host { display: block; position: relative; }
    /* El barrido va sobre todas las piezas a la vez, en una sola capa: es lo que
       hace que se lea como «una cosa cargando» y no como bloques parpadeando. */
    .lienzo { position: relative; overflow: hidden; }
    .barrido {
      position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(100deg,
        transparent 30%, var(--skel-brillo) 50%, transparent 70%);
      transform: translateX(-100%);
      animation: skel-barrido 1.4s linear infinite;
    }
    :host(.quieto) .barrido { animation-play-state: paused; }
    @keyframes skel-barrido {
      to { transform: translateX(100%); }
    }
    @media (prefers-reduced-motion: reduce) {
      .barrido { animation: none; opacity: .5; }
    }

    .pieza { background: var(--skel); border-radius: 5px; }
    .curva { height: 96px; margin: 10px 0 14px; }
    /* La curva no es un rectángulo: se recorta con la silueta de una serie, que
       es la forma que va a ocupar el gráfico. */
    .curva {
      clip-path: polygon(0 92%, 8% 88%, 18% 70%, 28% 44%, 38% 26%, 48% 18%,
        58% 24%, 68% 40%, 78% 62%, 88% 82%, 100% 90%, 100% 100%, 0 100%);
    }
    .filas { display: flex; flex-direction: column; gap: 11px; }
    .fila { display: flex; align-items: center; gap: 8px; }
    .punto { width: 10px; height: 10px; border-radius: 3px; background: var(--skel); }
    .fila .pieza { height: 10px; border-radius: 4px; }
    .fila .n { width: 44px; }
    .fila .v { width: 38px; margin-left: auto; }
    .eje { display: flex; justify-content: space-between; margin-top: 12px; }
    .eje .pieza { height: 9px; width: 22px; border-radius: 4px; }

    .pie { display: flex; align-items: center; gap: 9px; margin-top: 14px;
           font-size: 12.5px; color: var(--ink-3); }
    .aro { width: 15px; height: 15px; border-radius: 999px; flex: none;
           border: 2px solid var(--hair-2); border-top-color: var(--accent);
           animation: skel-giro .9s linear infinite; }
    :host(.quieto) .aro { animation-play-state: paused; }
    @keyframes skel-giro { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .aro { animation: none; } }

    .tarda { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
             margin-top: 12px; font-size: 12.5px; color: var(--ink-2); }
    .tarda button {
      height: 30px; padding: 0 13px; border: 0; border-radius: 999px;
      font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
      color: var(--accent); background: var(--accent-soft);
    }
  `;

  const FORMAS = {
    // El gráfico de Energía: curva, cuatro filas de leyenda y el eje.
    chart: `
      <div class="pieza curva"></div>
      <div class="filas">
        ${"<div class=\"fila\"><span class=\"punto\"></span>"
          + "<span class=\"pieza n\"></span><span class=\"pieza v\"></span></div>"}
        ${"<div class=\"fila\"><span class=\"punto\"></span>"
          + "<span class=\"pieza n\"></span><span class=\"pieza v\"></span></div>"}
        ${"<div class=\"fila\"><span class=\"punto\"></span>"
          + "<span class=\"pieza n\"></span><span class=\"pieza v\"></span></div>"}
        ${"<div class=\"fila\"><span class=\"punto\"></span>"
          + "<span class=\"pieza n\"></span><span class=\"pieza v\"></span></div>"}
      </div>
      <div class="eje">
        <span class="pieza"></span><span class="pieza"></span>
        <span class="pieza"></span><span class="pieza"></span>
      </div>`,
    // Una lista: las tarjetas de tarifa, las filas de una tabla.
    rows: `
      <div class="filas">
        ${Array.from({ length: 4 }, () =>
          "<div class=\"fila\"><span class=\"punto\"></span>"
          + "<span class=\"pieza n\"></span><span class=\"pieza v\"></span></div>").join("")}
      </div>`,
  };

  class VatiaSkeleton extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._forma = "chart";
      this._label = "Cargando…";
    }

    set shape(v) { this._forma = v; this._render(); }
    set label(v) { this._label = v; this._render(); }

    connectedCallback() {
      this._render();
      this._desde = Date.now();
      // «Está tardando más de lo normal» a los 8 s, con salida.
      this._reloj = setTimeout(() => this._tarda(), TARDA_MS);
      // El barrido solo se anima mientras se ve: fuera de pantalla o con la
      // pestaña oculta se para, que es lo que pide el §07.
      this._visible = () => this.classList.toggle("quieto", document.hidden);
      document.addEventListener("visibilitychange", this._visible);
      if (window.IntersectionObserver) {
        this._io = new IntersectionObserver((entradas) => {
          this.classList.toggle("quieto", !entradas[0].isIntersecting || document.hidden);
        });
        this._io.observe(this);
      }
    }

    disconnectedCallback() {
      clearTimeout(this._reloj);
      document.removeEventListener("visibilitychange", this._visible);
      if (this._io) { this._io.disconnect(); this._io = null; }
    }

    _render() {
      if (!this.shadowRoot) return;
      this.shadowRoot.innerHTML = `<style>${CSS}</style>
        <div class="lienzo">
          ${FORMAS[this._forma] || FORMAS.chart}
          <div class="barrido"></div>
        </div>
        <p class="pie"><span class="aro" aria-hidden="true"></span>
          <span>${this._label.replace(/[<&]/g, "")}</span></p>
        <div class="tarda" hidden>
          <span>Está tardando más de lo normal.</span>
          <button type="button">Cancelar</button>
        </div>`;
      this.shadowRoot.querySelector(".tarda button")
        .addEventListener("click", () => this.dispatchEvent(new CustomEvent("cancel")));
      // El aviso puede haber salido ya antes de un repintado.
      if (this._tardando) this._tarda();
    }

    _tarda() {
      this._tardando = true;
      const caja = this.shadowRoot.querySelector(".tarda");
      if (caja) caja.hidden = false;
    }
  }

  if (!customElements.get("vatia-skeleton")) {
    customElements.define("vatia-skeleton", VatiaSkeleton);
  }
})();

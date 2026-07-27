/*
 * <vatia-close> — el cierre del día, al anochecer.
 *
 * Cuando el sol se pone ya no queda nada que decidir: el día está hecho y lo
 * que toca es contarlo. La tarjeta sale sola con la puesta de sol, resume el
 * día en una frase y tres cifras, y se despide hasta mañana.
 *
 * Uso:
 *   const close = document.createElement('vatia-close');
 *   close.data = payload.close;      // el bloque `close` de /api/live
 *   close.addEventListener('dismiss', ...);  // «Ver el día completo»
 *
 * El fondo es el degradado del anochecer del prototipo, igual en los dos
 * temas: el cierre es un momento, no una pantalla, y el momento tiene su luz.
 */
(() => {
  "use strict";

  const nf2 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const hhmm = (iso) => String(iso).slice(11, 16);

  const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
                 "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

  const CSS = `
    :host { display: block; }
    .card { border-radius: 26px; padding: 24px 22px 20px; color: #fff;
            background: linear-gradient(180deg, #141a3c 0%, #3d2a56 34%,
              #8a4359 62%, #c86a48 84%, #e4a05c 100%); }
    .date { font-size: 12px; letter-spacing: .14em; text-transform: uppercase;
            color: rgba(255,255,255,.62); font-weight: 600; }
    h2 { font-family: "Instrument Serif", Georgia, serif; font-weight: 400;
         font-size: 34px; line-height: 1.1; letter-spacing: -.01em;
         margin: 12px 0 0; text-wrap: pretty; }
    .body { font-size: 15px; line-height: 1.6; color: rgba(255,255,255,.82);
            margin: 14px 0 0; text-wrap: pretty; }
    .stats { display: flex; margin: 20px 0 0; padding: 16px 0; text-align: center;
             border-radius: 20px; background: rgba(255,255,255,.13);
             border: 1px solid rgba(255,255,255,.2); }
    .stats > div { flex: 1; }
    .stats > i { width: 1px; background: rgba(255,255,255,.18); }
    .stats b { display: block; font-size: 24px; font-weight: 600;
               letter-spacing: -.025em; line-height: 1.1;
               font-variant-numeric: tabular-nums; }
    .stats span { display: block; font-size: 11px; color: rgba(255,255,255,.72);
                  margin-top: 4px; line-height: 1.35; }
    .note { margin: 14px 0 0; padding: 13px 15px; border-radius: 16px;
            background: rgba(0,0,0,.18); border: 1px solid rgba(255,255,255,.12);
            font-size: 13px; line-height: 1.55; color: rgba(255,255,255,.85); }
    .note b { color: #fff; font-weight: 600; }
    button { display: block; width: 100%; margin: 18px 0 0; height: 46px;
             border: 0; border-radius: 999px; background: rgba(255,255,255,.92);
             font: inherit; font-size: 15px; font-weight: 600; color: #2a1830;
             cursor: pointer; }
  `;

  class VatiaClose extends HTMLElement {
    set data(value) { this._data = value; this._render(); }
    get data() { return this._data; }

    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      this._render();
    }

    _render() {
      if (!this.shadowRoot) return;
      const d = this._data;
      if (!d) { this.shadowRoot.innerHTML = ""; return; }

      const date = new Date(d.date + "T12:00:00");
      const fecha = `${DIAS[date.getDay()]} ${date.getDate()} de ${MESES[date.getMonth()]}`;
      const min = d.minutes_since;
      const hace = min < 60
        ? `hace ${min} ${min === 1 ? "minuto" : "minutos"}`
        : `a las ${hhmm(d.sunset)}`;

      // La frase del día. La escribe el porcentaje de la ventana, que es lo que
      // se podía hacer bien o mal; producir depende del cielo, no de nadie.
      const w = d.in_window;
      let animo = "El sol se puso " + hace + ".";
      if (w && w.pct >= 60) animo = `Un buen día. El sol se puso ${hace}.`;
      else if (w && w.pct < 30) animo = `El sol se puso ${hace}.`;

      let cuerpo = `Tu casa produjo <b>${esc(nf2.format(d.produced))} kWh</b> y consumió ${
        esc(nf2.format(d.consumed))}.`;
      if (w) {
        cuerpo += ` El ${w.pct} % del consumo cayó dentro de la ventana${
          w.pct >= 60 ? "" : " — la noche se llevó el resto"}.`;
      }

      const m = d.tomorrow;
      const nota = m
        ? `<p class="note">Mañana la ventana abre a las <b>${esc(hhmm(m.start))}</b>
             y sobrarán ${esc(nf2.format(m.kwh))} kWh. Lo que pueda esperar, que espere.</p>`
        : `<p class="note">Mañana no se espera excedente: lo que gastes lo dará la
             batería o la red.</p>`;

      this.shadowRoot.innerHTML = `<style>${CSS}</style>
        <div class="card">
          <div class="date">${esc(fecha)}</div>
          <h2>${esc(animo)}</h2>
          <p class="body">${cuerpo}</p>
          <div class="stats">
            ${d.self_pct != null ? `<div><b>${d.self_pct} %</b>
              <span>te has<br>abastecido solo</span></div>` : ""}
            ${d.self_pct != null && w ? "<i></i>" : ""}
            ${w ? `<div><b>${w.pct} %</b>
              <span>del consumo,<br>en la ventana</span></div>` : ""}
            ${(d.self_pct != null || w) ? "<i></i>" : ""}
            <div><b>${esc(nf2.format(d.produced))}</b>
              <span>kWh<br>producidos</span></div>
          </div>
          ${nota}
          <button type="button">Ver el día completo</button>
        </div>`;
      this.shadowRoot.querySelector("button").addEventListener("click", () => {
        this.dispatchEvent(new CustomEvent("dismiss", { bubbles: true }));
      });
    }
  }

  if (!customElements.get("vatia-close")) customElements.define("vatia-close", VatiaClose);
})();

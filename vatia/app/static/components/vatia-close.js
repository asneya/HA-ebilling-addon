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
    /* Lo que se puso hoy. Sobre el cielo del atardecer, así que el material es
       el mismo que la nota: negro traslúcido, no una tarjeta blanca. */
    .aparatos { margin: 14px 0 0; padding: 13px 15px 11px; border-radius: 16px;
                background: rgba(0,0,0,.18); border: 1px solid rgba(255,255,255,.12); }
    .ap-head { font-size: 11px; letter-spacing: .07em; text-transform: uppercase;
               font-weight: 600; color: rgba(255,255,255,.7); margin-bottom: 9px; }
    .aparatos ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
    /* La fila es ahora dos renglones: el de siempre, y debajo la hora que habría
       salido mejor. Metida dentro del nombre partía en cualquier ancho —la barra se
       lleva el flex y al nombre le quedaban tres palabras—, así que va suelta y a
       todo el ancho. */
    .aparatos li { display: grid; gap: 2px; font-size: 13px; }
    .ap-linea { display: flex; align-items: center; gap: 9px; }
    .ap-dot { width: 8px; height: 8px; border-radius: 3px; flex: none; }
    .ap-n { color: #fff; min-width: 0; }
    /* La barra dice de un vistazo cuánto de ese ciclo cayó con sol: es la
       comparación entre aparatos, que en cifras hay que hacer a mano. */
    .ap-bar { flex: 1; min-width: 24px; height: 4px; border-radius: 2px;
              background: rgba(255,255,255,.18); overflow: hidden; }
    .ap-bar i { display: block; height: 100%; background: #7be3b6; }
    /* La hora que habría salido mejor, colgada del nombre y en su propio renglón:
       la fila ya iba llena y meterla en línea la partía en cualquier ancho. */
    /* En ámbar y sangrada hasta debajo del nombre: se lee como una nota de la fila y
       no como otro aparato. El ámbar es el del sol, que es de lo que habla. */
    .ap-mejor { font-size: 11.5px; color: #ffd9a3; padding-left: 17px;
                font-variant-numeric: tabular-nums; }
    .ap-pie { font-size: 11.5px; line-height: 1.5; margin: 11px 0 0;
              color: rgba(255,255,255,.66); text-wrap: pretty; }
    .ap-pie b { color: rgba(255,255,255,.92); }
    .ap-k { flex: none; font-size: 12px; color: rgba(255,255,255,.8);
            font-variant-numeric: tabular-nums; }
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

    // Las tres cifras del día. El ahorro en euros solo existe si hay una
    // tarifa marcada como «la mía» en Facturación; sin ella, su sitio lo ocupa
    // lo producido. Como mucho tres: con cuatro ya no se lee ninguna.
    _stats(d, w) {
      const euro = new Intl.NumberFormat("es-ES",
        { style: "currency", currency: "EUR" });
      const cells = [];
      if (d.self_pct != null) {
        cells.push(`<div><b>${d.self_pct} %</b>
          <span>te has<br>abastecido solo</span></div>`);
      }
      if (d.saved) {
        cells.push(`<div><b>${esc(euro.format(d.saved.eur))}</b>
          <span>te has<br>ahorrado hoy</span></div>`);
      }
      if (w) {
        cells.push(`<div><b>${w.pct} %</b>
          <span>del consumo,<br>en la ventana</span></div>`);
      }
      if (cells.length < 3) {
        cells.push(`<div><b>${esc(nf2.format(d.produced))}</b>
          <span>kWh<br>producidos</span></div>`);
      }
      return `<div class="stats">${cells.slice(0, 3).join("<i></i>")}</div>`;
    }

    /* Qué se puso hoy y cuánto de cada cosa cayó dentro de la ventana.
       El porcentaje de arriba dice si el día se aprovechó; esto dice **qué** lo
       aprovechó, que es lo único que se puede hacer distinto mañana. Cada ciclo
       se reparte por su solape con la ventana, así que una lavadora que empieza
       dentro y acaba fuera no cuenta como todo gratis ni como todo pagado. */
    _aparatos(lista, mejor) {
      if (!lista || !lista.length) return "";
      // La hora que le habría salido mejor, por id, para poder colgarla de la fila
      // que ya habla de ese aparato. Solo las que de verdad ganaban algo: decir «ya
      // era su mejor hueco» en cinco filas sería ruido, y el titular ya lo resume.
      const hueco = new Map();
      for (const f of (mejor?.rows || [])) {
        if (!f.already_best && (f.saving_eur == null || f.saving_eur > 0)) {
          hueco.set(f.id, f);
        }
      }
      const filas = lista.slice(0, 5).map((a) => {
        const pct = a.pct == null ? null : a.pct;
        const barra = pct == null ? ""
          : `<span class="ap-bar"><i style="width:${Math.min(100, pct)}%"></i></span>`;
        const dicho = pct == null ? `${nf2.format(a.kwh)} kWh`
          : `${nf2.format(a.kwh)} kWh · ${pct} % con sol`;
        const veces = a.runs > 1 ? ` (${a.runs} veces)` : "";
        const h = hueco.get(a.id);
        const mejorHora = h
          ? `<span class="ap-mejor">↑ mejor a las ${esc(hhmm(h.best_at))}${
              h.saving_eur ? ` (+${esc(nf2.format(h.saving_eur))} €)` : ""}</span>`
          : "";
        return `<li>
          <span class="ap-linea">
            <span class="ap-dot" style="background:${esc(a.color)}"></span>
            <span class="ap-n">${esc(a.name)}${veces}</span>
            ${barra}
            <span class="ap-k">${esc(dicho)}</span>
          </span>
          ${mejorHora}
        </li>`;
      }).join("");
      return `<div class="aparatos">
        <div class="ap-head">Lo que se puso hoy</div>
        <ul>${filas}</ul>
        ${this._sobreLaMesa(mejor)}
      </div>`;
    }

    /* Lo que había sobre la mesa: el mejor orden posible del día que se acaba, con
       el sol, el consumo y los precios **que de verdad hubo**. Aquí no entra ninguna
       previsión, y por eso se puede decir sin condicionales — es lo que cierra el
       bucle que la aplicación tenía abierto: prometía «gratis a las 13:00» y no
       volvía a mirar si salió gratis.

       Es **una diferencia** y nunca «lo que gastaste»: este modelo no tiene batería
       dentro, y un coste absoluto se contradiría con el desglose de la factura. */
    _sobreLaMesa(mejor) {
      if (!mejor || !mejor.rows || !mejor.rows.length) return "";
      const eur = mejor.saving_eur;
      if (eur == null) {
        const movibles = mejor.rows.filter((f) => !f.already_best);
        if (!movibles.length) return "";
        return `<p class="ap-pie">Marca una tarifa como «la mía» y aquí saldrá lo que
          te habrías ahorrado moviéndolos.</p>`;
      }
      if (eur < 0.05) {
        return `<p class="ap-pie">Aprovechaste el sol prácticamente todo lo que se
          podía: moviendo los ciclos no había ni cinco céntimos que ganar.</p>`;
      }
      return `<p class="ap-pie">Puestos en su mejor hueco te habrías ahorrado
        <b>${esc(nf2.format(eur))} €</b>. Es lo que <b>había</b> sobre la mesa, no lo
        que se hizo mal: la batería no entra en esta cuenta y las tres de la madrugada
        cuentan como una hora cualquiera.</p>`;
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
          ${this._stats(d, w)}
          ${this._aparatos(d.appliances, d.best)}
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

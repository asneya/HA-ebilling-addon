/*
 * <vatia-window> — la ventana de energía gratis.
 *
 * El tramo del día en el que la previsión solar da más de lo que la casa gasta
 * de normal: dentro de la ventana lo que se enchufe lo paga el sol, fuera lo
 * paga la red. Contesta sin que nadie la haga la única pregunta que la app
 * puede contestar mejor que su dueño: ¿ahora o luego?
 *
 * Uso:
 *   const win = document.createElement('vatia-window');
 *   win.data = payload.window;      // el bloque `window` de /api/live
 *
 * `data = null` la deja vacía: sin sensor de previsión no hay ventana, y es
 * mejor no enseñar nada que inventarse una hora.
 */
(() => {
  "use strict";

  const nf1 = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // La hora se lee de la propia cadena ISO, que ya viene en la hora local de la
  // casa. Formatearla con el reloj del navegador daría otra hora al mirarla
  // desde fuera —de viaje, o desde el móvil en otro país—, y la ventana es una
  // hora de la casa, no de quien la mira.
  const hhmm = (iso) => String(iso).slice(11, 16);

  // Desfase horario que trae el servidor, en minutos.
  const offsetOf = (iso) => {
    const m = /([+-])(\d{2}):?(\d{2})$/.exec(String(iso));
    if (!m) return 0;                                    // «...Z»: UTC
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  };
  // «Ahora» en la hora de la casa: se desplaza el instante por el desfase y se
  // leen los campos UTC, que entonces son ya la hora de pared de la casa.
  const nowAt = (iso) =>
    new Date(Date.now() + offsetOf(iso) * 60000).toISOString();
  // «4 h 40 min», «40 min», «4 h». Los minutos se redondean a cinco: la
  // previsión no es tan fina como para prometer «4 h 37 min».
  const dur = (hours) => {
    const total = Math.max(0, Math.round(hours * 12) * 5);
    const h = Math.floor(total / 60), m = total % 60;
    if (h && m) return `${h} h ${m} min`;
    if (h) return `${h} h`;
    return `${m} min`;
  };
  const kw = (w) => (w < 1000 ? `${nf0.format(w)} W` : `${nf1.format(w / 1000)} kW`);

  const CSS = `
    :host { display: block; }
    .pill { display: inline-flex; align-items: center; gap: 8px; height: 30px;
            padding: 0 13px; border-radius: 999px; margin-bottom: 14px;
            font-size: 12px; font-weight: 700; letter-spacing: .03em; }
    .pill i { width: 7px; height: 7px; border-radius: 999px; flex: none; }
    .pill.open { background: var(--pill-good); color: var(--pill-good-ink); }
    .pill.open i { background: var(--pill-good-ink); }
    .pill.pre { background: var(--pill-warn); color: var(--pill-warn-ink); }
    .pill.pre i { background: var(--pill-warn-ink); }
    .pill.post, .pill.none { background: var(--seg-track); color: var(--ink-2); }
    .pill.post i, .pill.none i { background: var(--ink-3); }
    /* El titular es la única voz de la app: en serif y grande, para que se lea
       como una frase y no como un dato. */
    h2 { font-family: "Instrument Serif", Georgia, serif; font-weight: 400;
         font-size: 34px; line-height: 1.05; letter-spacing: -.01em;
         text-wrap: pretty; margin: 0; color: var(--ink); }
    .sub { font-size: 15px; line-height: 1.55; margin: 12px 0 0; color: var(--ink-2); }
    .track-card { margin: 18px 0 0; padding: 15px 16px 13px; border-radius: 20px;
                  background: var(--node); border: 1px solid var(--hair); }
    .track-head { display: flex; justify-content: space-between; align-items: baseline;
                  margin-bottom: 12px; }
    .track-head span:first-child { font-size: 11px; letter-spacing: .07em;
                  text-transform: uppercase; font-weight: 600; color: var(--ink-3); }
    .track-head span:last-child { font-size: 12px; color: var(--ink-3);
                  font-variant-numeric: tabular-nums; }
    .track { position: relative; height: 52px; }
    .rail { position: absolute; left: 0; right: 0; top: 18px; height: 16px;
            border-radius: 8px; overflow: hidden; background: var(--seg-track); }
    .fill { position: absolute; top: 0; bottom: 0;
            background: linear-gradient(90deg, var(--free-from), var(--free-to)); }
    /* La marca de «ahora» va sobre el tramo verde, que es claro en los dos
       temas, así que su tinta es oscura siempre y no sigue al tema. */
    .now { position: absolute; top: 10px; bottom: 14px; width: 2px; border-radius: 2px;
           background: var(--pill-good-ink); }
    .now-label { position: absolute; top: 0; transform: translateX(-50%);
           font-size: 11px; font-weight: 700; color: var(--ink);
           font-variant-numeric: tabular-nums; white-space: nowrap; }
    .axis { position: absolute; bottom: 0; font-size: 11px; color: var(--ink-3);
            font-variant-numeric: tabular-nums; }
    .note { margin: 12px 0 0; padding: 13px 15px; border-radius: 16px;
            background: var(--node); border: 1px solid var(--hair);
            font-size: 13px; line-height: 1.55; color: var(--ink-2); }
    .note b { color: var(--ink); font-weight: 600; }
  `;

  class VatiaWindow extends HTMLElement {
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
      const t = d.today, m = d.tomorrow;
      const say = this._words(d, t, m);
      this.shadowRoot.innerHTML = `<style>${CSS}</style>
        <div class="pill ${d.state}"><i></i>${esc(say.pill)}</div>
        <h2>${esc(say.head)}</h2>
        <p class="sub">${esc(say.sub)}</p>
        ${this._track(d, t)}${say.note}`;
    }

    _words(d, t, m) {
      const abre = m ? `Mañana abre a las ${hhmm(m.start)}` : null;
      if (d.state === "open") {
        return {
          pill: "ENERGÍA GRATIS AHORA",
          head: `Te sobran ${kw(t.surplus_w)} durante ${dur(d.hours_left)}.`,
          sub: `Es el mejor momento del día para gastar. A partir de las ${
            hhmm(t.end)} cada kWh lo pagas.`,
          note: this._note(t, m),
        };
      }
      if (d.state === "pre") {
        const falta = (new Date(t.start) - Date.now()) / 3600000;
        return {
          pill: `ABRE EN ${dur(falta).toUpperCase()}`,
          head: `Tu ventana abre a las ${hhmm(t.start)}.`,
          sub: `Faltan ${dur(falta)}. Te sobrarán ${kw(t.surplus_w)} durante ${
            dur(t.hours)}.`,
          note: this._note(t, m),
        };
      }
      if (d.state === "post") {
        return {
          pill: "VENTANA CERRADA",
          head: `Tu ventana se cerró a las ${hhmm(t.end)}.`,
          sub: `Desde ahora, cada kWh que gastes lo pagas. ${
            abre ? abre + "." : "Mañana no se espera excedente."}`,
          note: "",
        };
      }
      // Un día de nubes: la previsión no llega ni a lo que gasta la casa.
      return {
        pill: "HOY SIN VENTANA",
        head: "Hoy el sol no da para más de lo que gasta la casa.",
        sub: abre
          ? `${abre} y sobrarán ${kw(m.surplus_w)} durante ${dur(m.hours)}.`
          : "Tampoco mañana se espera excedente.",
        note: "",
      };
    }

    // Cómo viene mañana comparado con hoy. Solo se dice cuando hay diferencia:
    // «mañana parecido» no le sirve a nadie.
    _note(t, m) {
      if (!m) {
        return `<p class="note">Mañana <b>no se espera excedente</b>: lo que
          quieras dejar para el sol, mejor hoy.</p>`;
      }
      if (m.kwh < t.kwh * 0.7) {
        return `<p class="note">Mañana entran nubes: la ventana se queda en
          <b>${esc(dur(m.hours))}</b> y ${esc(nf1.format(m.kwh))} kWh, frente a los
          ${esc(nf1.format(t.kwh))} de hoy. Si puedes, no lo dejes para mañana.</p>`;
      }
      if (m.kwh > t.kwh * 1.3) {
        return `<p class="note">Mañana sobra más: <b>${esc(nf1.format(m.kwh))} kWh</b>
          durante ${esc(dur(m.hours))}, desde las ${esc(hhmm(m.start))}.</p>`;
      }
      return "";
    }

    // Línea de tiempo del día de luz, con la ventana pintada encima y la hora
    // actual marcada. El eje son las horas en las que hay sol, no el día
    // entero: la madrugada no aporta nada y comprime lo que sí importa.
    _track(d, t) {
      const light = d.daylight;
      if (!light || !t) return "";
      const from = new Date(light.from).getTime();
      const to = new Date(light.to).getTime();
      if (!(to > from)) return "";
      // Fracción del eje, recortada a [0, 1]: la barra verde se dibuja con los
      // extremos ya recortados, no con el ancho crudo, para que no se salga del
      // riel si la ventana asoma por fuera del día de luz.
      const at = (ms) => Math.max(0, Math.min(1, (ms - from) / (to - from)));
      const pct = (ms) => `${(at(ms) * 100).toFixed(1)}%`;
      const winFrom = at(new Date(t.start).getTime());
      const winTo = at(new Date(t.end).getTime());
      const now = Date.now();
      const inside = now >= from && now <= to;
      const mid = new Date((from + to) / 2);
      return `<div class="track-card">
        <div class="track-head"><span>La ventana de hoy</span>
          <span>${esc(hhmm(t.start))} – ${esc(hhmm(t.end))}</span></div>
        <div class="track">
          <div class="rail"><div class="fill" style="left:${(winFrom * 100).toFixed(1)}%;
            width:${(Math.max(0, winTo - winFrom) * 100).toFixed(1)}%"></div></div>
          ${inside ? `<div class="now" style="left:${pct(now)}"></div>
            <div class="now-label" style="left:${pct(now)}">${
              esc(hhmm(nowAt(light.from)))}</div>` : ""}
          <span class="axis" style="left:0">${esc(hhmm(light.from))}</span>
          <span class="axis" style="left:50%;transform:translateX(-50%)">${
            esc(hhmm(new Date(mid.getTime() + offsetOf(light.from) * 60000).toISOString()))}</span>
          <span class="axis" style="right:0">${esc(hhmm(light.to))}</span>
        </div>
      </div>`;
    }
  }

  if (!customElements.get("vatia-window")) customElements.define("vatia-window", VatiaWindow);
})();

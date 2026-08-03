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
    /* Se permite que el rango baje a su propia línea: «07:36 – 20:24 · 11 h 50
       min netas» al lado de un título no cabe en un móvil estrecho, y partido
       por la mitad el título quedaba pisado por la cifra. */
    .track-head { display: flex; flex-wrap: wrap; column-gap: 10px;
                  justify-content: space-between; align-items: baseline;
                  margin-bottom: 12px; }
    .track-head span:first-child { white-space: nowrap; }
    .track-head span:first-child { font-size: 11px; letter-spacing: .07em;
                  text-transform: uppercase; font-weight: 600; color: var(--ink-3); }
    .track-head span:last-child { font-size: 12px; color: var(--ink-3);
                  font-variant-numeric: tabular-nums; }
    .track { position: relative; height: 132px; }
    /* El lienzo y lo que va encima de él comparten caja, para poder colocar el
       pico en porcentaje sin medir nada. */
    .plot { position: absolute; left: 0; right: 0; top: 0; height: 112px; }
    .plot svg { display: block; width: 100%; height: 100%; }
    /* El sol y la casa: dos curvas, y el excedente es el área de entre las dos.
       Un riel plano decía «de 11:40 a 17:20» y nada más; la forma dice a qué
       hora sobra de verdad, que es lo que se viene a decidir. */
    /* El trazo dice **de dónde sale el número**: continuo lo que ya ha pasado y
       se ha medido, a rayas lo que se espera. Antes la raya significaba «la casa»
       y el continuo «el sol», así que no quedaba manera de distinguir la medida de
       la predicción — y la mitad del dibujo era una predicción de horas que ya
       habían pasado. Ahora la raya significa una sola cosa, y el sol y la casa se
       distinguen por color y grosor, que es lo que hacen las dos leyendas. */
    .sol { fill: none; stroke: var(--s-solar); stroke-width: 1.75;
           stroke-linejoin: round; }
    .sol.prev { stroke-dasharray: 4 3; opacity: .85; }
    .casa { fill: none; stroke: var(--ink-3); stroke-width: 1.4; opacity: .8; }
    .casa.prev { stroke-dasharray: 3 3; }
    .sobra { fill: url(#vw-grad); }
    /* El mejor momento del día, señalado: es la respuesta corta a «¿cuándo?». */
    .pico { position: absolute; width: 7px; height: 7px; border-radius: 999px;
            background: var(--pill-good-ink); border: 1.5px solid var(--node);
            transform: translate(-50%, -50%); }
    .pico-l { position: absolute; font-size: 10.5px; font-weight: 700;
              color: var(--ink); font-variant-numeric: tabular-nums;
              white-space: nowrap; }
    /* La marca de «ahora» va sobre el área verde, que es clara en los dos
       temas, así que su tinta es oscura siempre y no sigue al tema. */
    .now { stroke: var(--pill-good-ink); stroke-width: 2; stroke-linecap: round; }
    .now-label { position: absolute; top: 0; transform: translateX(-50%);
           font-size: 11px; font-weight: 700; color: var(--ink);
           font-variant-numeric: tabular-nums; white-space: nowrap; }
    .axis { position: absolute; bottom: 0; font-size: 11px; color: var(--ink-3);
            font-variant-numeric: tabular-nums; }
    .leyenda { display: flex; gap: 14px; margin: 9px 0 0; font-size: 11.5px;
               color: var(--ink-3); }
    .leyenda span { display: inline-flex; align-items: center; gap: 5px; }
    .leyenda i { width: 12px; height: 2px; border-radius: 2px; flex: none; }
    .leyenda .l-sol { background: var(--s-solar); height: 2px; }
    .leyenda .l-casa { background: var(--ink-3); height: 2px; opacity: .8; }
    /* La muestra del trazo previsto: la misma raya que se dibuja arriba. */
    .leyenda .l-prev { background: none; height: 0;
                       border-top: 2px dashed var(--ink-3); }
    .leyenda .l-sobra { background: var(--free-to); height: 9px; border-radius: 3px; }
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
        ${this._track(d, t)}${say.note}${this._desvio(d)}${this._sesgo(d)}`;
    }

    /* «y el mejor rato es a las 14:30»: la media dice cuánto y el pico dice
       cuándo, y sin el cuándo la tarjeta obliga a adivinar. Solo se añade si el
       pico destaca de verdad sobre la media —un día de meseta no tiene «mejor
       momento»— y si aún no ha pasado, que recomendar una hora que ya fue es
       peor que no decir nada. */
    _cuando(t) {
      if (!t.peak_at || !t.peak_w || !t.surplus_w) return "";
      if (t.peak_w < t.surplus_w * 1.25) return "";
      if (new Date(t.peak_at).getTime() < Date.now()) return "";
      return ` El mejor rato es sobre las ${hhmm(t.peak_at)}, con ${kw(t.peak_w)}.`;
    }

    _words(d, t, m) {
      const abre = m ? `Mañana abre a las ${hhmm(m.start)}` : null;
      if (d.state === "open") {
        // Con el perfil horario la ventana puede tener huecos: si viene uno, lo
        // que hay que decir no es cuándo cierra sino cuándo se corta.
        const corte = (t.gaps || []).find((g) => new Date(g.start) > Date.now());
        // Lo gastable, no el excedente bruto: si la batería se va a llevar la
        // mitad, prometer la mitad que no hay es lo que hacía que la tarjeta
        // no se correspondiera con la realidad al enchufar algo.
        const cuanto = t.spendable_w ?? t.surplus_w;
        return {
          pill: "ENERGÍA GRATIS AHORA",
          head: `Te sobran ${kw(cuanto)} durante ${dur(d.hours_left)}.`,
          sub: (corte
            ? `Es el mejor momento del día para gastar. A las ${hhmm(corte.start)} se corta
               —la casa gasta más de lo que da el sol— y vuelve a las ${hhmm(corte.end)}.`
            : `Es el mejor momento del día para gastar. A partir de las ${
              hhmm(t.end)} cada kWh lo pagas.`) + this._cuando(t),
          note: this._bateria(t) + this._note(t, m),
        };
      }
      if (d.state === "pre") {
        // `reopens_at` solo viene si estamos en un hueco de la ventana: entonces
        // la hora que importa es la de la reapertura, no la del primer corte.
        const cuando = d.reopens_at || t.start;
        const falta = (new Date(cuando) - Date.now()) / 3600000;
        const vuelve = !!d.reopens_at;
        return {
          pill: vuelve ? `VUELVE EN ${dur(falta).toUpperCase()}`
                       : `ABRE EN ${dur(falta).toUpperCase()}`,
          head: vuelve
            ? `Ahora mismo no sobra: vuelve a las ${hhmm(cuando)}.`
            : `Tu ventana abre a las ${hhmm(cuando)}.`,
          sub: (vuelve
            ? `La casa gasta ahora más de lo que da el sol. Después quedan ${
              dur(d.hours_left)} con excedente.`
            : `Faltan ${dur(falta)}. Te sobrarán ${kw(t.spendable_w ?? t.surplus_w)} durante ${
              dur(t.net_hours ?? t.hours)}.`) + this._cuando(t),
          note: this._bateria(t) + this._note(t, m),
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

    /* Lo que el tejado se desvía hoy de lo previsto.

       De una queja: la tarjeta prometía «gratis desde las 10:06» un día en que la
       producción real era bajísima. Ahora la hora que se da ya lleva descontado lo
       que el tejado está dando de verdad — pero eso hay que decirlo, porque si no
       la cifra parece la de la previsión y no cuadra con lo que se ve.

       **Y no se dice por qué**, que es lo que decía antes («hoy el cielo no
       acompaña») y era afirmar lo que no se sabe: la previsión de Solcast ya lleva
       dentro la meteorología, además del azimut, la inclinación y la potencia
       nominal del tejado. Así que un tejado al 60 % de lo previsto no significa
       que haya nubes —ya estaban contadas— sino que algo se desvía de un modelo
       que ya las tenía en cuenta: suciedad, una sombra nueva, un panel o un string
       caído, el inversor recortando, o la propia previsión equivocándose. Vatia
       mide el cuánto; el por qué no lo puede saber, y por eso lo deja abierto en
       vez de elegir el culpable más pintoresco.

       Solo cuando se nota: por encima del 85 % la corrección no cambia ninguna
       decisión y solo sería ruido. Y solo a la baja: si el tejado da más de lo
       prometido, la ventana llega antes y de sobra, y nadie se queja de eso. */
    _desvio(d) {
      const s = d.roof_today;
      if (!s || !s.factor || s.factor > 0.85) return "";
      const pct = Math.round(s.factor * 100);
      // De dónde sale: la hora cerrada, el instante, o los dos. Decirlo importa
      // porque las dos medidas envejecen distinto —la hora tarda en enterarse de
      // un cambio, el instante se cree cualquier bajón puntual— y quien lea la
      // tarjeta tiene derecho a saber con qué se ha decidido.
      const de = [];
      if (s.hour_ratio != null) {
        de.push(`la hora de las ${esc(String(s.hour).padStart(2, "0"))}:00, en la
          que dio el <b>${esc(String(Math.round(s.hour_ratio * 100)))} %</b>`);
      }
      if (s.now_ratio != null) {
        de.push(`lo que está dando ahora mismo, el
          <b>${esc(String(Math.round(s.now_ratio * 100)))} %</b>`);
      }
      return `<p class="note">Hoy tu tejado va al <b>${esc(String(pct))} %</b> de lo
        previsto, así que la hora de arriba ya va rebajada${
          de.length ? ` — medido con ${de.join(" y con ")}` : ""}. Si remonta, esto
        se corrige solo en cuanto el tejado lo note.</p>`;
    }

    /* Que la curva no es la del sensor, dicho en letra pequeña.

       La previsión que se dibuja lleva aplicado lo que este tejado corrige a
       cada hora, aprendido de sus propios días. Un número que no coincide con
       el del sensor de Solcast tiene que explicarse; si no, parece un error. */
    _sesgo(d) {
      const b = d.bias;
      if (!b || !b.horas || !b.peor) return "";
      const f = b.peor.factor;
      const cuanto = Math.abs(Math.round((f - 1) * 100));
      const signo = f < 1 ? "menos" : "más";
      const hora = String(b.peor.hora).padStart(2, "0");
      return `<p class="note">La previsión va corregida con lo que da tu tejado
        de verdad: en ${esc(String(b.horas))} ${b.horas === 1 ? "hora" : "horas"}
        del día se desvía, y donde más es a las <b>${esc(hora)}:00</b>, con un
        <b>${esc(String(cuanto))} % ${esc(signo)}</b> de lo que promete.
        Aprendido de ${esc(String(b.dias))} días tuyos.</p>`;
    }

    /* Lo que se lleva la batería, dicho en voz alta.

       La cuenta se hace igual se diga o no, así que callarla solo conseguiría
       que la cifra de arriba pareciese equivocada: el sol da 4 kWh de más y la
       tarjeta ofrece 1,5. Se dice cuando es un trozo que se nota; por debajo de
       200 Wh no cambia ninguna decisión y solo sería ruido. */
    _bateria(t) {
      const bat = t.battery_kwh || 0;
      if (bat < 0.2) return "";
      return `<p class="note">De lo que da el sol hoy, <b>${esc(nf1.format(bat))} kWh</b>
        van a llenar la batería antes de que sobre nada: lo de arriba es lo que
        queda de verdad para enchufar algo.</p>`;
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
      // Fracción del eje, recortada a [0, 1]: se recortan los extremos y no el
      // ancho crudo, para que nada se salga del dibujo si la ventana asoma por
      // fuera del día de luz.
      const at = (ms) => Math.max(0, Math.min(1, (ms - from) / (to - from)));
      const pct = (ms) => `${(at(ms) * 100).toFixed(1)}%`;
      const now = Date.now();
      const inside = now >= from && now <= to;
      const mid = new Date((from + to) / 2);
      const cabecera = (t.gaps && t.gaps.length)
        ? `${hhmm(t.start)} – ${hhmm(t.end)} · ${dur(t.net_hours ?? t.hours)} netas`
        : `${hhmm(t.start)} – ${hhmm(t.end)}`;
      // La hora de «ahora» se calla si el pico cae encima: las dos etiquetas van
      // arriba y se solaparían, y de las dos la que aporta es la del pico. La
      // raya vertical sigue marcando dónde estamos.
      const pico = t.peak_at ? at(new Date(t.peak_at).getTime()) : null;
      const choca = inside && pico != null && Math.abs(pico - at(now)) < 0.12;
      return `<div class="track-card">
        <div class="track-head"><span>La forma de hoy</span>
          <span>${esc(cabecera)}</span></div>
        <div class="track">
          ${this._forma(t, at, inside ? at(now) : null)}
          ${inside && !choca ? `<div class="now-label" style="left:${pct(now)}">${
              esc(hhmm(nowAt(light.from)))}</div>` : ""}
          <span class="axis" style="left:0">${esc(hhmm(light.from))}</span>
          <span class="axis" style="left:50%;transform:translateX(-50%)">${
            esc(hhmm(new Date(mid.getTime() + offsetOf(light.from) * 60000).toISOString()))}</span>
          <span class="axis" style="right:0">${esc(hhmm(light.to))}</span>
        </div>
        <p class="leyenda">
          <span><i class="l-sobra"></i>Sobra</span>
          <span><i class="l-sol"></i>Sol</span>
          <span><i class="l-casa"></i>Tu casa</span>
          ${t.shape && t.shape.real_until
            ? `<span><i class="l-prev"></i>previsto</span>` : ""}
        </p>
      </div>`;
    }

    /* El día dibujado: la previsión del sol, el consumo típico de la casa y el
       excedente como el área de entre las dos.

       Se dibuja en un viewBox de 0-100 × 0-100 con `preserveAspectRatio="none"`
       para que estire al ancho que haya sin tener que medir el contenedor: el
       componente se pinta también antes de estar en pantalla, y ahí `clientWidth`
       es cero. Los trazos llevarían el mismo estiramiento, así que van con
       `vector-effect` para conservar su grosor.

       El eje vertical no lleva escala escrita a propósito: la tarjeta no es un
       gráfico que se venga a leer con precisión —para eso está la pantalla de
       Energía—, es la forma del día para decidir a qué hora enchufar algo. */
    _forma(t, at, ahora) {
      const s = t.shape;
      if (!s || !s.t || s.t.length < 2) return "";
      const techo = Math.max(...s.sol, ...s.casa, 1);
      const x = (i) => at(new Date(s.t[i]).getTime()) * 100;
      // 4 % de aire arriba, para que la punta no toque el borde.
      const y = (w) => 96 - (Math.max(w, 0) / techo) * 92;
      const linea = (serie) => serie
        .map((w, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(w).toFixed(2)}`).join("");
      /* Lo medido y lo previsto son la misma línea con dos significados, así que
         se dibujan con dos trazos: continuo lo que pasó, discontinuo lo que se
         espera. Los dos tramos comparten el punto de la unión —de ahí el `+1`—
         porque si no quedaría un hueco justo en «ahora».

         `real_until` es null cuando todo es previsión: entonces se dibuja una
         sola línea discontinua, que es lo honesto. */
      const corteReal = s.real_until
        ? s.t.findIndex((iso) => new Date(iso).getTime()
            >= new Date(s.real_until).getTime())
        : -1;
      const tramos = (serie) => {
        if (corteReal < 1) return { fue: "", sera: linea(serie) };
        return {
          fue: linea(serie.slice(0, corteReal + 1)),
          sera: serie.slice(corteReal)
            .map((w, i) => `${i ? "L" : "M"}${x(i + corteReal).toFixed(2)},${
              y(w).toFixed(2)}`).join(""),
        };
      };

      /* El área de excedente. Se recorre el día y se acumula un polígono por
         tramo en el que el sol va por encima de la casa; los cortes de entrada
         y salida se interpolan, que es lo que hace que el área acabe justo
         donde acaba la ventana y no un punto de muestreo después. */
      const areas = [];
      let poly = null;
      const corte = (i) => {
        const d0 = s.sol[i] - s.casa[i], d1 = s.sol[i + 1] - s.casa[i + 1];
        const r = d1 === d0 ? 0 : Math.max(0, Math.min(1, -d0 / (d1 - d0)));
        return {
          x: x(i) + (x(i + 1) - x(i)) * r,
          w: s.casa[i] + (s.casa[i + 1] - s.casa[i]) * r,
        };
      };
      for (let i = 0; i < s.t.length; i++) {
        const sobra = s.sol[i] > s.casa[i];
        if (sobra && !poly) {
          poly = { arriba: [], abajo: [] };
          if (i > 0) {
            const c = corte(i - 1);
            poly.arriba.push([c.x, y(c.w)]);
            poly.abajo.push([c.x, y(c.w)]);
          }
        }
        if (sobra) {
          poly.arriba.push([x(i), y(s.sol[i])]);
          poly.abajo.push([x(i), y(s.casa[i])]);
        } else if (poly) {
          const c = corte(i - 1);
          poly.arriba.push([c.x, y(c.w)]);
          poly.abajo.push([c.x, y(c.w)]);
          areas.push(poly);
          poly = null;
        }
      }
      if (poly) areas.push(poly);
      const relleno = areas
        .filter((p) => p.arriba.length > 1)
        .map((p) => {
          const ida = p.arriba.map(([px, py], i) =>
            `${i ? "L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`).join("");
          const vuelta = [...p.abajo].reverse()
            .map(([px, py]) => `L${px.toFixed(2)},${py.toFixed(2)}`).join("");
          return `<path class="sobra" d="${ida}${vuelta}Z"/>`;
        }).join("");

      /* El pico, con su hora: la respuesta corta a «¿y cuándo?».

         Va en HTML por encima del SVG y no dentro. El lienzo estira sin guardar
         la proporción —así no hay que medir el contenedor— y eso deforma todo
         lo que no sea un trazo: el punto saldría ovalado y la hora, ancha. Los
         trazos se salvan con `vector-effect`; un círculo y un texto, no. */
      let pico = "";
      // Y solo si aún no ha pasado. El pico sale de la curva de **previsión**, así
      // que un pico ya pasado se dibujaría a la altura que se predijo encima de una
      // línea que ahora enseña lo que de verdad ocurrió: dos alturas distintas para
      // el mismo instante. Además de que recomendar una hora que ya fue no sirve —la
      // etiqueta ya se callaba por eso (`_cuando`), pero el punto seguía ahí.
      const pasado = t.peak_at && new Date(t.peak_at).getTime() < Date.now();
      if (t.peak_at && t.peak_w > 0 && !pasado) {
        const cuando = new Date(t.peak_at).getTime();
        const px = at(cuando) * 100;
        const cerca = s.t.reduce((mejor, iso, i) =>
          Math.abs(new Date(iso).getTime() - cuando)
            < Math.abs(new Date(s.t[mejor]).getTime() - cuando) ? i : mejor, 0);
        const py = y(s.sol[cerca]);
        // La etiqueta se pega al borde si el pico cae en un extremo: centrada
        // se saldría del dibujo justo los días en que el pico es al amanecer.
        const empuje = px > 84 ? "translateX(-100%)"
          : px < 16 ? "translateX(0)" : "translateX(-50%)";
        // Y se queda dentro del lienzo pase lo que pase: la altura se pide con
        // un `max()` en vez de decidir arriba o abajo por un umbral en tanto
        // por ciento. El umbral hay que adivinarlo —depende de lo que mida la
        // letra— y en un día despejado la punta cae justo en el filo.
        pico = `<i class="pico" style="left:${px.toFixed(2)}%;top:${py.toFixed(2)}%"></i>
          <span class="pico-l" style="left:${px.toFixed(2)}%;
            top:max(0px, calc(${py.toFixed(2)}% - 20px));
            transform:${empuje}">${esc(hhmm(t.peak_at))}</span>`;
      }

      const sol = tramos(s.sol), casa = tramos(s.casa);
      return `<div class="plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
             aria-label="${esc(s.real_until
               ? "Lo que ha dado el sol y ha gastado la casa hasta ahora, y lo previsto para el resto del día"
               : "Previsión de sol y consumo típico de la casa a lo largo del día")}">
          <defs>
            <linearGradient id="vw-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="var(--free-to)" stop-opacity=".55"/>
              <stop offset="1" stop-color="var(--free-from)" stop-opacity=".22"/>
            </linearGradient>
          </defs>
          ${relleno}
          ${casa.fue ? `<path class="casa" d="${casa.fue}" vector-effect="non-scaling-stroke"/>` : ""}
          ${sol.fue ? `<path class="sol" d="${sol.fue}" vector-effect="non-scaling-stroke"/>` : ""}
          <path class="casa prev" d="${casa.sera}" vector-effect="non-scaling-stroke"/>
          <path class="sol prev" d="${sol.sera}" vector-effect="non-scaling-stroke"/>
          ${ahora != null ? `<line class="now" x1="${(ahora * 100).toFixed(2)}" y1="4"
             x2="${(ahora * 100).toFixed(2)}" y2="96" vector-effect="non-scaling-stroke"/>` : ""}
        </svg>
        ${pico}
      </div>`;
    }
  }

  if (!customElements.get("vatia-window")) customElements.define("vatia-window", VatiaWindow);
})();

/*
 * <vatia-schedule> — la rejilla semanal de 24 × 8.
 *
 * Sustituye a la sintaxis «L-V 10-14,18-22», que había que aprenderse, por
 * celdas que se pintan arrastrando. Cada celda es una hora de un día y lleva el
 * color del periodo al que pertenece; las que no se pintan caen en el periodo
 * por defecto, así que es imposible dejar una hora sin precio.
 *
 * Las ocho filas son los siete días más los festivos, que es lo que entiende el
 * motor de tarifas (el token «F»).
 *
 * Uso:
 *   const rej = document.createElement('vatia-schedule');
 *   rej.periods = [{name, price, schedule}, …];   // lee y escribe
 *   rej.addEventListener('change', () => rej.periods);  // horarios recompuestos
 */
(() => {
  "use strict";

  const DAYS = ["L", "M", "X", "J", "V", "S", "D", "F"];
  const DAY_NAME = ["lunes", "martes", "miércoles", "jueves", "viernes",
                    "sábado", "domingo", "festivos"];
  // Los mismos colores que la app usa para los tramos de la tarifa, más un par
  // de reservas para las tarifas de más de tres periodos.
  const COLORS = ["--punta", "--llano", "--valle", "--s-grid", "--s-exp", "--s-batt-out"];

  // ---- lectura y escritura del formato textual ----------------------------
  // Se reimplementa aquí el mínimo del parser del servidor, porque la rejilla
  // tiene que poder ir y volver sin pasar por la red mientras se pinta.

  const parseDays = (token) => {
    const out = new Set();
    for (const part of token.split(",")) {
      const t = part.trim().toUpperCase();
      if (!t) continue;
      if (t.includes("-")) {
        const [a, b] = t.split("-");
        const ia = DAYS.indexOf(a), ib = DAYS.indexOf(b);
        if (ia < 0 || ib < 0 || ia > ib) continue;
        for (let i = ia; i <= ib; i++) out.add(i);
      } else if (DAYS.includes(t)) out.add(DAYS.indexOf(t));
    }
    return out;
  };

  const parseHours = (token) => {
    const out = new Set();
    for (const part of token.split(",")) {
      const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(part);
      if (!m) continue;
      const a = +m[1], b = +m[2];
      if (!(a >= 0 && a < b && b <= 24)) continue;
      for (let h = a; h < b; h++) out.add(h);
    }
    return out;
  };

  /* Celdas (día, hora) de un horario textual. */
  function cellsOf(schedule) {
    const cells = [];
    for (const rule of String(schedule || "").split("|")) {
      const parts = rule.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const days = parseDays(parts[0]);
      const hours = parseHours(parts.slice(1).join(""));
      for (const d of days) for (const h of hours) cells.push([d, h]);
    }
    return cells;
  }

  /* Tramos contiguos de horas como «10-14,18-22». El final es exclusivo, igual
     que en el formato del servidor. */
  function hoursToText(hours) {
    const sorted = [...hours].sort((a, b) => a - b);
    const out = [];
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
      out.push(`${sorted[i]}-${sorted[j] + 1}`);
      i = j + 1;
    }
    return out.join(",");
  }

  /* Días como «L-V» o «L,X,V»: se comprimen los tramos seguidos. */
  function daysToText(days) {
    const sorted = [...days].sort((a, b) => a - b);
    const out = [];
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
      out.push(j - i >= 1 ? `${DAYS[sorted[i]]}-${DAYS[sorted[j]]}` : DAYS[sorted[i]]);
      i = j + 1;
    }
    return out.join(",");
  }

  /* Horario textual de un periodo a partir de su mapa de celdas. Los días con
     las mismas horas se agrupan en una sola regla, que es lo que hace legible
     la cadena equivalente. */
  function scheduleOf(grid, idx) {
    const porDia = new Map();          // firma de horas → días que la tienen
    for (let d = 0; d < 8; d++) {
      const hours = [];
      for (let h = 0; h < 24; h++) if (grid[d][h] === idx) hours.push(h);
      if (!hours.length) continue;
      const firma = hoursToText(hours);
      if (!porDia.has(firma)) porDia.set(firma, []);
      porDia.get(firma).push(d);
    }
    return [...porDia].map(([horas, dias]) => `${daysToText(dias)} ${horas}`).join(" | ");
  }

  const CSS = `
    :host { display: block; }
    .pintando { font-size: 13px; line-height: 1.5; color: var(--ink-2);
                margin: 0 0 12px; }
    .pintando b { color: var(--ink); font-weight: 600; }
    .chips { display: flex; flex-wrap: wrap; gap: 7px; margin: 0 0 12px; }
    .chip { display: inline-flex; align-items: center; gap: 7px; height: 34px;
            padding: 0 13px; border-radius: 999px; border: 1.5px solid transparent;
            background: var(--node); color: var(--ink-2); font: inherit;
            font-size: 13px; font-weight: 600; cursor: pointer; }
    .chip i { width: 9px; height: 9px; border-radius: 3px; flex: none; }
    .chip[aria-pressed="true"] { border-color: currentColor; color: var(--ink);
            background: var(--solid); }

    .rej { display: grid; grid-template-columns: 20px repeat(24, 1fr);
           gap: 2px; touch-action: none; user-select: none; }
    .rej .hora { grid-column: span 1; font-size: 9px; color: var(--ink-3);
           text-align: center; font-variant-numeric: tabular-nums; }
    .dia { font-size: 11px; font-weight: 600; color: var(--ink-3);
           display: grid; place-items: center; cursor: pointer;
           background: none; border: 0; font-family: inherit; padding: 0; }
    .celda { height: 19px; border-radius: 3px; border: 0; padding: 0;
             cursor: pointer; }

    .atajos { display: flex; flex-wrap: wrap; gap: 7px; margin: 14px 0 0; }
    .atajos button { height: 34px; padding: 0 13px; border-radius: 999px;
            border: 1px solid var(--hair); background: var(--node);
            color: var(--ink-2); font: inherit; font-size: 13px; font-weight: 600;
            cursor: pointer; }
    .equiv { margin: 14px 0 0; padding: 11px 13px; border-radius: 14px;
             background: var(--node); border: 1px solid var(--hair); }
    .equiv-lbl { font-size: 11px; letter-spacing: .07em; text-transform: uppercase;
             font-weight: 600; color: var(--ink-3); }
    .equiv ul { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 3px; }
    .equiv li { font-size: 12.5px; color: var(--ink-2); word-break: break-word; }
    .equiv b { color: var(--ink); font-weight: 600; }
    .nota { font-size: 12.5px; line-height: 1.5; color: var(--ink-3);
            margin: 12px 0 0; }
  `;

  class VatiaSchedule extends HTMLElement {
    set periods(value) {
      this._periods = (value || []).map((p) => ({ ...p }));
      this._load();
      this._render();
    }
    /* Los periodos con su horario recompuesto desde la rejilla. El que hace de
       defecto se devuelve con el horario vacío, que es como el motor sabe que
       recoge todo lo que no cae en ningún otro. */
    get periods() {
      return this._periods.map((p, i) => ({
        ...p,
        schedule: i === this._defaultIdx ? "" : scheduleOf(this._grid, i),
      }));
    }

    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: "open" });
      this._render();
    }

    /* La rejilla a partir de los horarios guardados. El periodo sin horario es
       el de defecto y rellena todo lo que nadie haya reclamado. */
    _load() {
      const n = this._periods.length;
      this._defaultIdx = this._periods.findIndex((p) => !(p.schedule || "").trim());
      if (this._defaultIdx < 0) this._defaultIdx = n - 1;
      this._grid = Array.from({ length: 8 }, () => Array(24).fill(null));
      this._periods.forEach((p, i) => {
        if (i === this._defaultIdx) return;
        for (const [d, h] of cellsOf(p.schedule)) {
          if (this._grid[d][h] === null) this._grid[d][h] = i;
        }
      });
      // Los festivos sin reglas propias se comportan como domingo, igual que en
      // el servidor: se copian para que la fila no engañe.
      if (this._grid[7].every((c) => c === null)) this._grid[7] = [...this._grid[6]];
      for (let d = 0; d < 8; d++) {
        for (let h = 0; h < 24; h++) {
          if (this._grid[d][h] === null) this._grid[d][h] = this._defaultIdx;
        }
      }
      this._brush = this._periods.findIndex((_, i) => i !== this._defaultIdx);
      if (this._brush < 0) this._brush = 0;
    }

    _color(i) { return `var(${COLORS[i % COLORS.length]})`; }

    _paint(d, h) {
      if (this._grid[d][h] === this._brush) return;
      this._grid[d][h] = this._brush;
      const el = this.shadowRoot.querySelector(`[data-c="${d}-${h}"]`);
      if (el) el.style.background = this._color(this._brush);
      this._changed();
    }

    _changed() {
      const eq = this.shadowRoot.querySelector(".equiv ul");
      if (eq) eq.innerHTML = this._equivalencia();
      this.dispatchEvent(new CustomEvent("change", { bubbles: true }));
    }

    /* La cadena que el motor guardaría, visible para quien ya sabe leerla. */
    _equivalencia() {
      return this.periods.map((p, i) => {
        const nombre = esc(p.name || `Tramo ${i + 1}`);
        const valor = i === this._defaultIdx ? "resto de horas"
          : esc(p.schedule || "sin horas");
        return `<li><b>${nombre}</b> · ${valor}</li>`;
      }).join("");
    }

    _render() {
      if (!this.shadowRoot) return;
      if (!this._periods || !this._periods.length) {
        this.shadowRoot.innerHTML = `<style>${CSS}</style>
          <p class="nota">Esta tarifa no tiene tramos horarios.</p>`;
        return;
      }
      const brushName = this._periods[this._brush]?.name || `tramo ${this._brush + 1}`;

      const cabecera = ["<span></span>"];
      for (let h = 0; h < 24; h++) {
        cabecera.push(`<span class="hora">${h % 6 === 0 ? h : ""}</span>`);
      }
      const filas = [];
      for (let d = 0; d < 8; d++) {
        filas.push(`<button class="dia" data-d="${d}"
          title="Pintar ${DAY_NAME[d]} entero">${DAYS[d]}</button>`);
        for (let h = 0; h < 24; h++) {
          filas.push(`<button class="celda" data-c="${d}-${h}"
            style="background:${this._color(this._grid[d][h])}"
            aria-label="${DAY_NAME[d]} ${h}:00"></button>`);
        }
      }

      this.shadowRoot.innerHTML = `<style>${CSS}</style>
        <p class="pintando">Pintando <b>${esc(brushName)}</b>. Arrastra sobre las
          horas; toca la letra de un día para el día entero.</p>
        <div class="chips">${this._periods.map((p, i) => `
          <button class="chip" data-b="${i}" aria-pressed="${i === this._brush}"
            style="color:${this._color(i)}">
            <i style="background:${this._color(i)}"></i>${esc(p.name || `Tramo ${i + 1}`)}
            ${i === this._defaultIdx ? " · resto" : ""}
          </button>`).join("")}</div>
        <div class="rej">${cabecera.join("")}${filas.join("")}</div>
        <div class="atajos">
          <button data-a="lv">Copiar a L–V</button>
          <button data-a="fin">Fin de semana</button>
          <button data-a="fest">Festivos = D</button>
          <button data-a="vaciar">Vaciar</button>
        </div>
        <div class="equiv"><span class="equiv-lbl">Equivalencia</span>
          <ul>${this._equivalencia()}</ul></div>
        <p class="nota">Las horas sin pintar caen en el periodo por defecto, así
          que es imposible dejar un hueco sin precio.</p>`;

      this._wire();
    }

    _wire() {
      const sr = this.shadowRoot;
      sr.querySelectorAll(".chip").forEach((b) =>
        b.addEventListener("click", () => { this._brush = +b.dataset.b; this._render(); }));

      // Pintado por arrastre: se escucha en el contenedor y se mira qué celda
      // hay bajo el dedo, que es lo que permite arrastrar sin soltar.
      const rej = sr.querySelector(".rej");
      let pintando = false;
      const celdaEn = (x, y) => {
        const el = sr.elementFromPoint ? sr.elementFromPoint(x, y)
                                       : document.elementFromPoint(x, y);
        return el && el.dataset && el.dataset.c ? el.dataset.c : null;
      };
      const aplicar = (clave) => {
        if (!clave) return;
        const [d, h] = clave.split("-").map(Number);
        this._paint(d, h);
      };
      rej.addEventListener("pointerdown", (ev) => {
        if (!ev.target.dataset.c) return;
        pintando = true;
        rej.setPointerCapture(ev.pointerId);
        aplicar(ev.target.dataset.c);
        ev.preventDefault();
      });
      rej.addEventListener("pointermove", (ev) => {
        if (pintando) aplicar(celdaEn(ev.clientX, ev.clientY));
      });
      const soltar = () => { pintando = false; };
      rej.addEventListener("pointerup", soltar);
      rej.addEventListener("pointercancel", soltar);

      sr.querySelectorAll(".dia").forEach((b) =>
        b.addEventListener("click", () => {
          const d = +b.dataset.d;
          for (let h = 0; h < 24; h++) this._grid[d][h] = this._brush;
          this._render();
        }));

      sr.querySelectorAll("[data-a]").forEach((b) =>
        b.addEventListener("click", () => { this._atajo(b.dataset.a); }));
    }

    /* Los cuatro atajos del diseño. */
    _atajo(cual) {
      if (cual === "lv") {
        // El lunes manda: es el día que se suele pintar primero.
        for (let d = 1; d <= 4; d++) this._grid[d] = [...this._grid[0]];
      } else if (cual === "fin") {
        for (let h = 0; h < 24; h++) { this._grid[5][h] = this._brush; this._grid[6][h] = this._brush; }
      } else if (cual === "fest") {
        this._grid[7] = [...this._grid[6]];
      } else if (cual === "vaciar") {
        for (let d = 0; d < 8; d++) this._grid[d] = Array(24).fill(this._defaultIdx);
      }
      this._render();
      this._changed();
    }
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  if (!customElements.get("vatia-schedule")) customElements.define("vatia-schedule", VatiaSchedule);
})();

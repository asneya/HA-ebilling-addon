/*
 * Flujo de energía: el día entero, hora a hora.
 *
 * Es el diseño «Flujo de energía v2» completo. El diagrama contesta «de dónde
 * sale y a dónde va cada vatio ahora mismo»; esta pantalla añade la pregunta que
 * viene justo después —«¿y antes?»— con el deslizador de hora y el día
 * reproducido de un tirón.
 *
 * El prototipo del diseño simula el día con fórmulas (campana solar, gaussianas
 * de consumo, integración de la batería). Aquí va con lo medido, que es lo que el
 * propio diseño pide para producción: «solo cambia el origen de pv, house y soc;
 * la lógica de reparto y el diagrama no cambian». Y no cambian: el reparto de
 * cada muestra lo hace el servidor con la misma función que la tarjeta de la Home.
 *
 * Dos cosas que el prototipo no podía tener y la realidad exige:
 *   · una pastilla «Ahora», porque con datos de verdad hay un presente al que
 *     volver, y perderlo tras arrastrar era quedarse sin la lectura principal;
 *   · reproducir da la vuelta al llegar a *ahora* y no a las 24 h: del futuro no
 *     hay medidas, y animar una pantalla vacía no cuenta nada.
 */
import { $, $$ } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/bus.js";
import { nf4 } from "../core/format.js";
import { showView } from "../core/nav.js";
import {
  estado, titular, autoconsumo, coste, costeTexto, notaBateria, tarjetaRed, pot, MIN_W,
} from "../core/flujo.js";

/* El día servido por /api/flowday y dónde está puesta la lectura. */
const st = { dia: null, i: 0, tocando: false, reloj: null, cargando: false };

const PASO_H = 0.14;        // lo que avanza cada tic, como el diseño
const TIC_MS = 45;

/* ------------- carga ------------- */

async function cargar() {
  if (st.cargando) return;
  st.cargando = true;
  $("#f-error").classList.add("hidden");
  $("#f-skel").classList.remove("hidden");
  $("#f-flow").classList.add("hidden");
  try {
    st.dia = await api("flowday");
    // Se abre en el presente: es la lectura que se venía a ver.
    st.i = indiceAhora();
    pintar();
  } catch (err) {
    $("#f-error").textContent = err.message;
    $("#f-error").classList.remove("hidden");
  } finally {
    st.cargando = false;
    $("#f-skel").classList.add("hidden");
    $("#f-flow").classList.remove("hidden");
  }
}

function indiceAhora() {
  const d = st.dia;
  if (!d) return 0;
  return d.now >= 0 ? d.now : Math.max(0, d.x.length - 1);
}

/* Hora decimal ↔ índice de muestra. Las muestras van cada `step_min`. */
function horaDe(i) {
  const iso = st.dia.x[i];
  return Number(iso.slice(11, 13)) + Number(iso.slice(14, 16)) / 60;
}

function indiceDe(hora) {
  const porHora = 60 / (st.dia.step_min || 5);
  return Math.min(st.dia.x.length - 1, Math.max(0, Math.round(hora * porHora)));
}

/* ------------- pintado ------------- */

/* El componente del diagrama, creado una sola vez: vive mientras viva la
   pantalla, y arrastrando la hora se le cambia solo el reparto. */
function diagrama() {
  let node = $("#f-flow").querySelector("vatia-flow");
  if (!node) {
    node = document.createElement("vatia-flow");
    node.meters = false;          // aquí las métricas van en tarjetas
    $("#f-flow").appendChild(node);
  }
  return node;
}

function pintar() {
  const d = st.dia;
  if (!d) return;
  const i = st.i;
  const flows = {};
  for (const k in d.flows) flows[k] = d.flows[k][i];
  const hayDato = Object.values(flows).some((v) => v != null);
  const precio = d.price[i];
  const precioExc = d.surplus_price[i];

  $("#f-clock").textContent = `Ahora · ${d.x[i].slice(11, 16)}`;
  $("#f-hour").value = String(horaDe(i).toFixed(1));
  // Antes de cualquier salida: las pastillas marcan *dónde está la lectura*, y
  // en una hora sin medidas hay que marcarla igual. Con esto al final, arrastrar
  // hasta la noche dejaba encendida la pastilla de la hora anterior.
  chips();

  if (!hayDato) {
    // Una hora sin medidas no es una hora con cero vatios, y decir «no circula
    // nada» sería mentir: si el día aún no ha llegado ahí, se dice eso.
    const futuro = i > indiceAhora();
    $("#f-headline").textContent = futuro
      ? "Esa hora no ha llegado todavía."
      : "No hay medidas de esa hora.";
    $("#f-state").textContent = "Sin datos";
    $("#f-state").dataset.estado = "nada";
    // Se vacía el diagrama sin tirar el componente: recrearlo en cada muestra
    // sin datos le costaría su observador de tamaño y un repintado entero.
    diagrama().flows = null;
    vaciarMetricas();
    dibujarFranja();
    return;
  }

  const est = estado(flows);
  $("#f-state").textContent = est.texto;
  $("#f-state").dataset.estado = est.clave;
  $("#f-headline").textContent = titular(flows, precio);

  // La casa partida por dentro: es aquí y no en la Home donde tiene sitio, que
  // es lo que se pidió — «en el flujo, aunque quizás solo en su versión
  // detallada». En la tarjeta de la Home la casa sigue siendo un nodo.
  diagrama().split = (d.appliances || [])
    .map((a) => ({ id: a.id, name: a.name, color: a.color, watts: a.watts[i] }))
    .filter((a) => a.watts != null);
  diagrama().flows = flows;

  metricas(flows, d.soc ? d.soc[i] : null, precio, precioExc);
  dibujarFranja();
}

function vaciarMetricas() {
  ["#f-self", "#f-soc", "#f-grid", "#f-cost", "#f-price"].forEach((id) => {
    $(id).textContent = "—";
  });
  ["#f-soc-note", "#f-grid-note", "#f-cost-note"].forEach((id) => { $(id).textContent = ""; });
}

function metricas(flows, soc, precio, precioExc) {
  $("#f-self").textContent = `${autoconsumo(flows)}%`;

  $("#f-soc").textContent = soc == null ? "—" : `${Math.round(soc)}%`;
  $("#f-soc-note").textContent = notaBateria(flows, soc);

  const red = tarjetaRed(flows, precio, precioExc);
  $("#f-grid-title").textContent = red.titulo;
  $("#f-grid").textContent = red.w >= MIN_W ? pot(red.w) : "0 W";
  $("#f-grid").dataset.estado = red.clase;
  $("#f-grid-note").textContent = red.nota;

  const eur = coste(flows, precio, precioExc);
  $("#f-price").textContent = precio == null ? "sin tarifa" : `${nf4.format(precio)} €/kWh`;
  $("#f-cost").textContent = costeTexto(eur);
  $("#f-cost").dataset.estado = eur == null ? "nada" : eur <= 0 ? "bien" : eur > 0.4 ? "caro" : "";
  if (eur == null) {
    // Sin tarifa marcada como «la mía» no hay precio, y el coste del instante
    // es justo la cifra que no se puede estimar a ojo.
    $("#f-cost-note").innerHTML =
      "Marca una tarifa como <b>la tuya</b> en Ajustes → Tarifas y aquí saldrá lo que cuesta esta hora.";
  } else if (eur <= 0) {
    $("#f-cost-note").textContent = "A esta hora la casa no te cuesta nada: los excedentes te abonan.";
  } else {
    const compra = Math.max(flows.grid_home || 0, 0) + Math.max(flows.grid_battery || 0, 0);
    $("#f-cost-note").textContent =
      `Solo pagas los ${pot(compra)} que vienen de la red; el resto ya está en casa.`;
  }
}

/* ------------- la franja del día ------------- */

/* Área de producción solar, línea de consumo de la casa y el cabezal de
   lectura. Geometría del diseño (74 px de alto, eje a 6 kW) con dos cambios que
   la maqueta no podía prever:
   · el techo del eje sale del día y no de una constante, que en una casa de
     10 kW recortaba la campana justo por arriba;
   · el ancho es el medido y no 760, porque con un viewBox fijo la franja se
     aplastaba a 42 px en un teléfono y la campana dejaba de leerse. */
function dibujarFranja() {
  const d = st.dia;
  const H = 74;
  const W = Math.round($("#f-daystrip").getBoundingClientRect().width) || 760;
  const pico = Math.max(
    ...d.pv.filter((v) => v != null), ...d.house.filter((v) => v != null), 1000,
  );
  const MAX = pico * 1.08;
  const n = d.x.length;
  const x = (i) => (horaDe(i) / 24) * W;
  const y = (v) => H - 8 - (Math.max(v, 0) / MAX) * (H - 18);

  /* Un subcamino por tramo medido. Los huecos se dejan como huecos: unir por
     encima de un sensor caído dibujaría una recta que nadie ha medido. */
  const tramos = (col) => {
    const out = [];
    let actual = null;
    for (let i = 0; i < n; i++) {
      if (col[i] == null) { actual = null; continue; }
      if (!actual) { actual = []; out.push(actual); }
      actual.push(i);
    }
    return out.filter((t) => t.length > 1);
  };
  const linea = (col) => tramos(col).map((t) =>
    t.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(col[i]).toFixed(1)}`).join("")).join("");
  const area = (col) => tramos(col).map((t) => {
    const cero = y(0).toFixed(1);
    return `M${x(t[0]).toFixed(1)},${cero}` +
      t.map((i) => `L${x(i).toFixed(1)},${y(col[i]).toFixed(1)}`).join("") +
      `L${x(t[t.length - 1]).toFixed(1)},${cero}Z`;
  }).join("");

  const sol = area(d.pv);
  const casa = linea(d.house);
  const i = st.i;
  const pv = d.pv[i];
  const cabeza = pv == null ? "" :
    `<circle cx="${x(i).toFixed(1)}" cy="${y(pv).toFixed(1)}" r="4.5"
       style="fill:var(--s-solar);stroke:var(--solid)" stroke-width="2"/>`;

  $("#f-daystrip").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="f-strip-svg" role="img"
         aria-label="Producción solar y consumo de la casa a lo largo del día">
      <defs>
        <linearGradient id="f-sol" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style="stop-color:var(--s-solar)" stop-opacity=".5"/>
          <stop offset="1" style="stop-color:var(--s-solar)" stop-opacity=".04"/>
        </linearGradient>
      </defs>
      <path d="${sol}" fill="url(#f-sol)"/>
      <path d="${casa}" fill="none" style="stroke:var(--s-home)" stroke-width="1.6" stroke-opacity=".75"/>
      <line x1="${x(i).toFixed(1)}" y1="2" x2="${x(i).toFixed(1)}" y2="${H - 6}"
            style="stroke:var(--ink)" stroke-width="1.5"/>
      ${cabeza}
    </svg>`;
}

/* ------------- controles ------------- */

function chips() {
  const ahora = indiceAhora();
  $$(".f-chip").forEach((b) => {
    const cerca = b.dataset.hour === "now"
      ? st.i === ahora
      : Math.abs(horaDe(st.i) - Number(b.dataset.hour)) < 0.35;
    b.classList.toggle("active", cerca);
  });
}

function irA(i) {
  parar();
  st.i = Math.min(st.dia.x.length - 1, Math.max(0, i));
  pintar();
}

function parar() {
  if (st.reloj) { clearInterval(st.reloj); st.reloj = null; }
  $("#f-play").classList.remove("playing");
  $("#f-play-txt").textContent = "Ver el día entero";
  $("#f-play").querySelector(".f-play-ico").textContent = "▶";
}

function reproducir() {
  if (st.reloj) { parar(); return; }
  const hasta = indiceAhora();
  const porHora = 60 / (st.dia.step_min || 5);
  const salto = Math.max(1, Math.round(PASO_H * porHora));
  // Empieza por el principio del día si ya estamos en el presente: si no,
  // reproducir desde «ahora» daría media vuelta vacía antes de contar nada.
  if (st.i >= hasta) st.i = 0;
  $("#f-play").classList.add("playing");
  $("#f-play-txt").textContent = "Pausar el día";
  $("#f-play").querySelector(".f-play-ico").textContent = "❚❚";
  st.reloj = setInterval(() => {
    st.i = st.i + salto > hasta ? 0 : st.i + salto;
    pintar();
  }, TIC_MS);
}

$("#flow-back").addEventListener("click", () => showView("home"));
$("#f-play").addEventListener("click", reproducir);
$("#f-hour").addEventListener("input", (e) => {
  if (!st.dia) return;
  irA(indiceDe(parseFloat(e.target.value)));
});
$$(".f-chip").forEach((b) => b.addEventListener("click", () => {
  if (!st.dia) return;
  irA(b.dataset.hour === "now" ? indiceAhora() : indiceDe(Number(b.dataset.hour)));
}));

/* Arrastre directo sobre la franja del día, que es lo que se intenta hacer al
   verla: el diseño lo pide para producción y no solo el deslizador. */
function desdeFranja(ev) {
  const svg = $("#f-daystrip").querySelector("svg");
  if (!svg || !st.dia) return;
  const r = svg.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
  irA(indiceDe(frac * 24));
}
$("#f-daystrip").addEventListener("pointerdown", (ev) => {
  st.tocando = true;
  $("#f-daystrip").setPointerCapture?.(ev.pointerId);
  desdeFranja(ev);
});
$("#f-daystrip").addEventListener("pointermove", (ev) => { if (st.tocando) desdeFranja(ev); });
$("#f-daystrip").addEventListener("pointerup", () => { st.tocando = false; });
$("#f-daystrip").addEventListener("pointercancel", () => { st.tocando = false; });

/* ------------- lo que esta pantalla escucha ------------- */

on("vista", ({ name }) => {
  if (name === "flow") { cargar(); return; }
  // Al salir se para el reloj: un intervalo animando una pantalla que no se ve
  // es trabajo tirado, y en el móvil se nota en la batería.
  parar();
});
on("datos", () => { if (st.dia) st.dia = null; });
on("tema", () => { if (st.dia) pintar(); });

/* Al girar el teléfono cambian el ancho de la franja y la orientación del
   diagrama: las dos se calculan con el ancho medido, así que hay que repintar. */
let reloj_ancho = null;
window.addEventListener("resize", () => {
  if (!st.dia || !$("#view-flow").classList.contains("active")) return;
  clearTimeout(reloj_ancho);
  reloj_ancho = setTimeout(pintar, 120);
});

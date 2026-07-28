/*
 * Home: el caudal en tiempo real, la ventana de energía gratis, el cierre del
 * día y el resumen de energía.
 */
import { $, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/bus.js";
import { fmtNum, fmtTemp } from "../core/format.js";
import { SUM_COLORS } from "../core/colors.js";
import { showView } from "../core/nav.js";

/* Lo último que ha contado el servidor. Vive aquí y no en un estado global: no
   lo necesita ninguna otra pantalla. */
let live = null;

/* ------------- meteorología ------------- */

/* El sensor de condición puede traer los estados de HA (`partlycloudy`) o
   texto libre en castellano («Parcialmente nuboso»). Se normaliza a las
   familias que usan el icono y el fondo. */
function weatherFamily(raw) {
  if (!raw) return "clear";
  const s = String(raw).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const has = (...keys) => keys.some((k) => s.includes(k));
  if (has("lightning", "thunder", "tormenta", "electric")) return "lightning";
  if (has("pouring", "chubasc", "diluv", "heavy rain", "lluvia fuerte")) return "pouring";
  if (has("rain", "lluvia", "llov", "drizzle", "llovizna", "shower")) return "rainy";
  if (has("hail", "granizo", "pedrisc")) return "hail";
  if (has("snow", "niev", "nieve")) return "snowy";
  if (has("fog", "niebla", "neblina", "mist", "bruma", "haze", "calima")) return "fog";
  if (has("partlycloudy", "partly", "parcial", "poco nub", "intervalos nub")) return "partlycloudy";
  if (has("cloud", "nub", "cubierto", "overcast")) return "cloudy";
  if (has("wind", "viento")) return "windy";
  return "clear";
}

/* Los ocho glifos del tiempo del sprite mapean uno a uno con las familias de
   `weather.condition`, como manda el diseño. Antes se dibujaban a mano aquí y
   dos familias se perdían por el camino: el viento se enseñaba como nubes
   parciales y el granizo como nieve. Ahora cada una tiene el suyo.

   La única excepción es la luna: el set no trae glifo nocturno, así que el
   despejado de noche conserva el trazo de siempre en vez de enseñar un sol a
   las tres de la mañana. */
const WEATHER_GLYPH = {
  clear: "solar", partlycloudy: "parcial", cloudy: "nubes", fog: "niebla",
  rainy: "lluvia", pouring: "lluvia", lightning: "tormenta",
  snowy: "nieve", hail: "granizo", windy: "viento",
};

function weatherIcon(condition, phase) {
  const family = weatherFamily(condition);
  if (family === "clear" && phase === "night") {
    return `<svg class="i" aria-hidden="true" viewBox="0 0 24 24"><path
      d="M15.6 3.6a8.4 8.4 0 1 0 4.8 12.2A9 9 0 0 1 15.6 3.6Z"/></svg>`;
  }
  return `<svg class="i" aria-hidden="true"><use href="#i-${
    WEATHER_GLYPH[family] || "solar"}"/></svg>`;
}

const PHASE_TEXT = { night: "Noche", dawn: "Amanecer", day: "Día", sunset: "Atardecer" };

/* ------------- carga y pintado ------------- */

export async function loadLive() {
  try {
    live = await api("live");
  } catch (err) {
    // Sin conexión con HA seguimos mostrando la interfaz; solo avisamos.
    live = null;
    $("#flow-empty").textContent = err.message;
    $("#flow-empty").classList.remove("hidden");
    $("#flow").innerHTML = "";
    return;
  }
  renderLive();
}

function renderLive() {
  if (!live) return;

  // Fondo y cabecera
  const bg = $("#bg");
  bg.dataset.phase = live.phase || "day";
  bg.dataset.weather = weatherFamily(live.weather.condition);

  const temp = live.weather.temperature;
  // Con un decimal, como la maqueta («28,6°»): redondeando a entero se pierde
  // medio grado y la cifra tabular de la pastilla deja de tener sentido.
  $("#weather-temp").textContent = temp != null ? `${fmtTemp.format(temp)}°` : "—";
  $("#weather-icon").innerHTML = weatherIcon(live.weather.condition, live.phase);
  $("#weather").title = live.weather.condition
    ? `${live.weather.condition} · ${PHASE_TEXT[live.phase] || ""}`
    : "Asigna los sensores de condición y temperatura en Ajustes";

  const now = new Date(live.generated_at);
  $("#home-sub").textContent =
    `${PHASE_TEXT[live.phase] || ""} · ${now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`;

  // El cierre del día sale con la puesta de sol y sustituye a la ventana. Al
  // descartarlo («Ver el día completo») se recuerda la fecha, para que no
  // vuelva a asomar esa misma noche pero sí a la siguiente.
  const descartado = live.close &&
    localStorage.getItem("vatia-close-seen") === live.close.date;
  const closing = !!live.close && (!descartado || closeState.reopened);
  $("#close").data = closing ? live.close : null;
  $("#close-panel").classList.toggle("hidden", !closing);
  // Si se descartó, queda la fila que lo devuelve.
  $("#reopen-close").classList.toggle("hidden", !(live.close && descartado && !closeState.reopened));

  // Ventana de energía gratis. Sin previsión solar no hay ventana que enseñar,
  // y una tarjeta vacía es peor que ninguna: se esconde la tarjeta entera.
  $("#window").data = closing ? null : live.window || null;
  $("#window-panel").classList.toggle("hidden", closing || !live.window);

  // El pie de la banda del caudal, como la maqueta: lo que está pasando con la
  // red ahora mismo, que es la pregunta que la persona tiene en la cabeza.
  const f = live.flows || {};
  const exportando = (f.solar_grid || 0) > 20;
  const importando = (f.grid_home || 0) + (f.grid_battery || 0) > 20;
  $("#flow-chip").textContent = exportando ? "Exportando a la red"
    : importando ? "Comprando a la red" : "Sin tocar la red";

  // Flujo
  const configured = live.configured;
  $("#flow-empty").classList.toggle("hidden", configured);
  $("#flow").classList.toggle("hidden", !configured);
  if (configured) renderFlow(live);

  // Resumen
  const gen = live.energy.generation, home = live.energy.home;
  const hasEnergy = gen.total > 0 || home.total > 0;
  $("#summary-empty").classList.toggle("hidden", hasEnergy);
  $("#summary").classList.toggle("hidden", !hasEnergy);
  if (hasEnergy) renderSummary(gen, home, live.energy.meters);
}

/* ------------- tabla «Resumen de energía» ------------- */

function summaryColumn(title, block) {
  const rows = block.rows;
  const total = rows.reduce((s, r) => s + r.kwh, 0) || 1;
  const bar = rows
    .filter((r) => r.kwh > 0)
    .map((r) => `<i style="width:${(r.kwh / total) * 100}%;background:${SUM_COLORS[r.key]}"></i>`)
    .join("");
  const list = rows.map((r) => `
    <div class="sum-row">
      <div class="sum-label"><i style="background:${SUM_COLORS[r.key]}"></i>${esc(r.label)}</div>
      <div class="sum-line">
        <b>${fmtNum.format(r.kwh)}</b><span class="u">kWh</span>
        <span class="leader"></span><span class="pct">${r.pct}%</span>
      </div>
    </div>`).join("");
  return `
    <div class="sum-col">
      <div class="sum-title">${title}</div>
      <div class="sum-total"><b>${fmtNum.format(block.total)}</b><span>kWh</span></div>
      <div class="sum-bar">${bar}</div>
      <div class="sum-rows">${list}</div>
    </div>`;
}

function renderSummary(gen, home, meters) {
  $("#summary").innerHTML =
    summaryColumn("Generación", gen) + summaryColumn("Consumo de la casa", home);
  renderSummaryMeters(home, meters);
}

/* Las columnas reparten la energía por origen y destino, y «Desde la red» es
   solo la parte de la importación que ha consumido la casa: si parte de lo
   importado ha ido a cargar la batería, no cuadra con el contador. Las lecturas
   de la red ya están en el nodo de la red del diagrama, justo encima, así que
   aquí solo se explica la diferencia cuando existe. */
function renderSummaryMeters(home, meters) {
  const box = $("#summary-meters");
  const notes = [];
  if ((meters?.grid_to_battery || 0) >= 0.05) {
    notes.push(`${fmtNum.format(meters.grid_to_battery)} kWh de lo importado fue a cargar la batería, así que no lo consumió la casa`);
  }
  if ((meters?.battery_to_grid || 0) >= 0.05) {
    notes.push(`${fmtNum.format(meters.battery_to_grid)} kWh de lo vertido salió de la batería`);
  }
  box.classList.toggle("hidden", !notes.length);
  box.innerHTML = notes.length
    ? `<p class="sum-meters-note">${esc(notes.join(" · "))}</p>`
    : "";
}

/* ------------- caudal en tiempo real ------------- */

/* El diagrama de nodos lo dibuja <vatia-flow>, un Sankey: el ancho de cada
   corriente es su potencia. La composición del consumo la expresa el propio
   haz, así que el anillo que llevaba el nodo de la casa ya no hace falta. */
function renderFlow(data) {
  const host = $("#flow");
  let node = host.querySelector("vatia-flow");
  if (!node) {
    host.textContent = "";
    node = document.createElement("vatia-flow");
    host.appendChild(node);
  }
  node.data = data;
}

/* ------------- el cierre del día ------------- */

/* El cierre se descarta por fecha, así que no vuelve esa noche pero sí la
   siguiente. `reopened` es solo para esta sesión: si lo abres a mano, se queda
   abierto hasta que lo vuelvas a cerrar. */
const closeState = { reopened: false };

$("#close").addEventListener("dismiss", () => {
  const c = $("#close").data;
  if (c) localStorage.setItem("vatia-close-seen", c.date);
  closeState.reopened = false;
  if (live) renderLive();
});

$("#reopen-close").addEventListener("click", () => {
  closeState.reopened = true;
  if (live) renderLive();
  $("#close-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

/* El resumen lleva a la pantalla de Energía. */
function openEnergy() { showView("energy"); }
$("#summary-panel").addEventListener("click", openEnergy);
$("#summary-panel").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEnergy(); }
});

/* ------------- lo que la Home escucha ------------- */

on("vista", ({ name }) => { if (name === "home") loadLive(); });
on("datos", () => loadLive());
// El caudal es un SVG con los colores en atributos: `var()` no llega ahí.
on("tema", () => { if (live) renderFlow(live); });

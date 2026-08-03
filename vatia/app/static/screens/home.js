/*
 * Home: el caudal en tiempo real, la ventana de energía gratis, el cierre del
 * día y el resumen de energía.
 */
import { $, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on, emit } from "../core/bus.js";
import { fmtNum, fmtTemp, fmtEUR } from "../core/format.js";
import { SUM_COLORS } from "../core/colors.js";
import { showView } from "../core/nav.js";
import { estado, titular, montarFlujo } from "../core/flujo.js";
import { aplicarTarjetas } from "../core/tarjetas.js";
import { settings } from "../core/config.js";

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

  // «Cabe en la ventana» **no** desaparece con la ventana. Al anochecer cambia de
  // pregunta —«Lo que te costaría ahora»—, que es el estado `post` del propio
  // diseño, y es justo cuando más sirve: de noche lo que pongas sale de la
  // batería o de la red, y eso es lo que dice su renglón de estimación.
  renderAdvice(live.advice);
  renderPlan(live.plan);
  // Lo que está haciendo cada electrodoméstico va en este payload, y su sección
  // de Ajustes lo enseña: se anuncia para no tener que pedirlo dos veces.
  emit("vivo", live);

  // Los tres estados del flujo v2, con sus palabras: es la pregunta que la
  // persona tiene en la cabeza y se contesta antes de mirar el diagrama.
  const f = live.flows || {};
  const est = estado(f);
  $("#flow-chip").textContent = est.texto;
  $("#flow-chip").dataset.estado = est.clave;
  // Y el titular, que dice en prosa lo mismo que el Sankey dice en geometría.
  $("#flow-headline").textContent = live.configured ? titular(f, null) : "";

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

/* El diagrama lo dibuja el componente que el usuario haya elegido en la galería
   de Ajustes: el Sankey de caudales o la órbita con la casa en el centro. Los
   dos reciben el mismo payload, así que aquí no hay nada que distinguir. */
function renderFlow(data) {
  montarFlujo($("#flow"), settings()).data = data;
}

/* ------------- «Cabe en la ventana» ------------- */

/* «2 h 10 min», «50 min», «2 h». Los minutos se redondean a cinco: el ciclo sale
   de una mediana de muestras de cinco minutos, y dar «2 h 07 min» sería fingir
   una precisión que no existe. */
function dur(horas) {
  const total = Math.max(5, Math.round((horas || 0) * 12) * 5);
  const h = Math.floor(total / 60), m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/* De dónde saldría la energía si se pusiera ahora. Lo que el veredicto no dice:
   «cabe en la ventana» habla de horas de sol, y esto habla de **de qué depósito
   sale** lo que el sol no cubra. En una casa con batería no es lo mismo que
   comprarlo — sale de lo que tenías guardado para la noche—, así que se pone en
   kWh de batería y en euros al precio de importar, que es lo que ese kilovatio
   vale: el que gastes ahora lo tendrás que comprar luego. */
function estimacion(e, kind) {
  if (!e) return "";
  const sol = e.sun_kwh || 0, bat = e.battery_kwh || 0, red = e.grid_kwh || 0;
  if (bat < 0.01 && red < 0.01) {
    return `<small class="ad-est sol">lo pone el sol entero</small>`;
  }
  const trozos = [];
  if (sol >= 0.01) trozos.push(`${fmtNum.format(sol)} de sol`);
  if (!e.split) {
    // Sin capacidad de batería configurada no se puede separar una de otra, y
    // decir «batería» a secas sería afirmar más de lo que se sabe.
    trozos.push(`${fmtNum.format(bat + red)} kWh de batería o red`);
  } else {
    if (bat >= 0.01) {
      const pct = e.battery_pct != null ? ` (${e.battery_pct} % de carga)` : "";
      trozos.push(`${fmtNum.format(bat)} kWh de batería${pct}`);
    }
    if (red >= 0.01) trozos.push(`${fmtNum.format(red)} kWh de red`);
  }
  // Los euros solo cuando el veredicto no es ya una cifra en euros: con la
  // ventana cerrada el veredicto **es** ese mismo importe, y repetirlo en la
  // misma fila no informa de nada, solo la llena.
  const conNumero = kind === "cerrada" || kind === "parcial";
  const eur = (e.battery_eur || 0) + (e.grid_eur || 0);
  const coste = conNumero || (e.battery_eur == null && e.grid_eur == null)
    ? "" : ` ≈ ${fmtEUR.format(eur)} si lo compraras`;
  return `<small class="ad-est">${esc(trozos.join(" · ") + coste)}</small>`;
}

/* La tarjeta del prototipo, con una diferencia de fondo: allí la duración y los
   kWh de cada electrodoméstico se teclean, y aquí se han medido. Del histórico
   del propio enchufe, así que el consejo habla de *tu* lavadora. */
/* ------------- «El plan de hoy» ------------- */

/* La hora de un ISO, y si es de mañana se dice: «a las 03:00» a secas, cuando
   son las once de la noche, se lee como dentro de cuatro minutos. */
function cuando(iso) {
  const t = new Date(iso);
  const hoy = new Date();
  const manana = t.getDate() !== hoy.getDate();
  const hhmm = t.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  return manana ? `mañana a las ${hhmm}` : `a las ${hhmm}`;
}

/* A qué hora sale más barato cada aparato, y si compensa cargar la batería.
   Es la pregunta que viene después de «Cabe en la ventana»: aquella dice qué
   entra ahora, y esta a qué hora conviene de aquí a mañana. */
function renderPlan(plan) {
  const rows = (plan && plan.rows) || [];
  const bat = plan && plan.battery;
  $("#plan-panel").classList.toggle("hidden", !rows.length && !bat);
  if (!rows.length && !bat) return;

  // Solo se cuentan los que de verdad ganan algo esperando: decir «3 aparatos»
  // cuando dos ya están en su mejor hora es inflar el titular.
  const mueven = rows.filter((r) => r.worth_waiting);
  const ahorro = mueven.reduce((a, r) => a + (r.saving_eur || 0), 0);
  // Y cuando no se pide mover nada, hay que decir la verdad. «Ya están en su
  // mejor hora» era falso siempre que el mejor momento fuera más tarde y la
  // diferencia solo no llegara al umbral: contradecía a la tarjeta de la ventana,
  // que en la misma pantalla decía «gratis desde las 10:06».
  const luego = rows.some((r) => r.best.at > r.now.at);
  $("#plan-aside").textContent = !rows.length ? ""
    : mueven.length && ahorro > 0 ? `ahorras ${fmtEUR.format(ahorro)} moviéndolos`
    : mueven.length ? "mejor esperar"
    : luego ? "da casi igual cuándo"
    : "ya están en su mejor hora";

  $("#plan-rows").innerHTML = rows.map((r) => {
    const b = r.best;
    // **El porcentaje tiene que ser del momento del que se habla.** Con
    // `worth_waiting` en falso la fila decía «ahora mismo» y enseñaba el sol de
    // la mejor hora: a las 9:47 ponía «ahora mismo · 100 % con sol» cuando ahora
    // el sol cubría el 60 % y el 100 % era de las 10:17.
    const sub = r.worth_waiting
      ? `${b.sun_pct} % con sol · ${dur(r.hours)}`
      : `ahora mismo · ${r.now.sun_pct} % con sol`;
    // El valor de la derecha es la hora, que es la respuesta; el porqué va
    // debajo.
    const valor = r.worth_waiting ? cuando(b.at) : "ahora";
    const clase = r.worth_waiting ? "v-justo" : "v-gratis";
    // Y el porqué, también cierto. Si esperar cambia el sol pero no el dinero,
    // eso es lo que hay que decir: es el motivo de verdad y se entiende.
    const porque = r.saving_eur >= 0.01 ? `ahorras ${fmtEUR.format(r.saving_eur)}`
      : r.worth_waiting ? `pasa a ${b.sun_pct} % con sol`
      : b.at > r.now.at ? "esperar apenas cambia nada"
      : "es su mejor hora";
    return `
      <div class="ad-row">
        <span class="ad-chip" style="--ap:${esc(r.color)}">
          <svg class="i"><use href="#i-${esc(r.icon)}"/></svg>
        </span>
        <span class="ad-txt"><b>${esc(r.name)}</b><small>${esc(sub)}</small></span>
        <span class="ad-verdict">
          <b class="${clase}">${esc(valor)}</b>
          <small>${esc(porque)}</small>
        </span>
      </div>`;
  }).join("");

  const notas = [];
  // El cielo de hoy, con las mismas palabras que la tarjeta de la ventana y
  // desde el mismo dato: las dos tarjetas prometen horas sacadas de la misma
  // curva, así que si esa curva va rebajada las dos tienen que decirlo. Callarlo
  // aquí sería volver a la incoherencia de partida por la puerta de atrás.
  const cielo = plan && plan.sky;
  if (cielo && cielo.factor && cielo.factor <= 0.85) {
    notas.push(`Hoy el tejado va al <b>${Math.round(cielo.factor * 100)} %</b> de
      lo previsto, así que estas horas ya van con el sol rebajado. Si se despeja,
      mejorarán solas.`);
  }
  if (bat) {
    notas.push(`Compensa <b>cargar ${fmtNum.format(bat.kwh)} kWh</b> de la red
      ${cuando(bat.at)}, a ${fmtEUR.format(bat.valley_eur_kwh)}/kWh: mañana el sol
      no va a llenar la batería y esa misma energía a las horas caras te costaría
      ${fmtEUR.format(bat.peak_eur_kwh)}/kWh. Te ahorras
      <b>${fmtEUR.format(bat.saving_eur)}</b>.`);
  }
  if (rows.length && !rows[0].priced) {
    notas.push(`Sin tu tarifa elegida en Ajustes esto va por lo que no tendrías
      que comprar, no por lo que cuesta. Con la tarifa, en euros.`);
  }
  $("#plan-note").innerHTML = notas.join(" ");
  $("#plan-note").classList.toggle("hidden", !notas.length);
}

function renderAdvice(advice) {
  const rows = (advice && advice.rows) || [];
  $("#advice-panel").classList.toggle("hidden", !rows.length);
  if (!rows.length) return;

  $("#ad-title").textContent = advice.title;
  const cabe = rows.filter((r) => r.verdict.kind === "gratis").length;
  $("#ad-aside").textContent = advice.closed ? "precio de ahora"
    : cabe ? `${cabe} de ${rows.length} entran gratis` : "";

  $("#ad-rows").innerHTML = rows.map((r) => {
    const meta = r.cycle
      ? `${dur(r.cycle.hours)} · ${fmtNum.format(r.cycle.kwh)} kWh`
      : "aprendiendo de su histórico";
    const v = r.verdict;
    // Un veredicto en euros llega como número; los otros dos, como su palabra.
    const valor = typeof v.value === "number" ? fmtEUR.format(v.value) : (v.value || "—");
    return `
      <div class="ad-row">
        <span class="ad-chip" style="--ap:${esc(r.color)}">
          <svg class="i"><use href="#i-${esc(r.icon)}"/></svg>
        </span>
        <span class="ad-txt">
          <b>${esc(r.name)}</b>
          <small>${esc(meta)}</small>
          ${estimacion(r.estimate, v.kind)}
        </span>
        <span class="ad-verdict">
          <b class="v-${esc(v.kind)}">${esc(valor)}</b>
          <small>${esc(v.sub)}</small>
        </span>
      </div>`;
  }).join("");

  // La letra pequeña solo aparece cuando explica algo que se está viendo.
  const aprendiendo = rows.filter((r) => r.verdict.kind === "aprendiendo");
  const sinPrecio = rows.some((r) => r.verdict.kind === "cerrada" && r.verdict.value == null);
  let nota = "";
  if (aprendiendo.length) {
    nota = `De ${aprendiendo.map((r) => r.name).join(", ")} aún no hay dos ciclos en
      el histórico, así que no se dice lo que tarda: en cuanto los haya, aparece
      aquí sin tocar nada.`;
  } else if (sinPrecio) {
    nota = "Para poner el precio hace falta una tarifa marcada como la tuya en Ajustes → Tarifas.";
  }
  $("#ad-note").textContent = nota;
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

/* Y el caudal, al día entero: el diagrama contesta «qué pasa ahora», y la
   pregunta que viene detrás —«¿y antes?»— la contesta la pantalla del flujo. */
function openFlow() { if (live && live.configured) showView("flow"); }
$("#flow-panel").addEventListener("click", openFlow);
$("#flow-panel").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFlow(); }
});

/* ------------- lo que la Home escucha ------------- */

on("vista", ({ name }) => { if (name === "home") loadLive(); });
on("datos", () => loadLive());
// El caudal es un SVG con los colores en atributos: `var()` no llega ahí.
on("tema", () => { if (live) renderFlow(live); });
/* El orden de las tarjetas y el componente del caudal son de quien mira, y
   llegan en la configuración: al recargarla —al entrar, y cada vez que se
   guarda algo en Ajustes— la Home se recoloca. El caudal se vuelve a montar
   porque puede haber cambiado de componente. */
on("config", (cfg) => {
  aplicarTarjetas(cfg && cfg.settings);
  if (live) renderFlow(live);
});

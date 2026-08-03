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
  renderPlan(live.plan);
  renderTiempo(live.weather_hours);
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

/* La hora de un ISO, y si es de mañana se dice: «a las 03:00» a secas, cuando
   son las once de la noche, se lee como dentro de cuatro minutos. */
function cuando(iso) {
  const t = new Date(iso);
  const hoy = new Date();
  const manana = t.getDate() !== hoy.getDate();
  const hhmm = t.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  return manana ? `mañana a las ${hhmm}` : `a las ${hhmm}`;
}

/* La barra del origen: de qué depósito sale la energía de este aparato.

   Es lo que antes decía un renglón de texto —«1,66 de sol · 1,1 kWh de batería
   (11 % de carga)»— y en una barra se lee de un vistazo. Los colores son los del
   resumen de energía, así que «verde es batería» significa lo mismo en las dos
   tarjetas.

   Los trozos por debajo del 4 % no se dibujan: a esa anchura no se ven y solo
   ensucian el borde entre los dos vecinos. La cifra sigue estando en el título. */
function barraOrigen(o) {
  if (!o) return "";
  const partes = [
    ["from_solar", o.sun_kwh || 0, "del sol"],
    ["from_battery", o.battery_kwh || 0, "de la batería"],
    ["from_grid", o.grid_kwh || 0, "de la red"],
  ];
  const total = partes.reduce((a, [, v]) => a + v, 0);
  if (total <= 0) return "";
  const trozos = partes
    .filter(([, v]) => v / total >= 0.04)
    .map(([clave, v, texto]) =>
      `<i style="width:${((v / total) * 100).toFixed(1)}%;background:${
        SUM_COLORS[clave]}" title="${esc(`${fmtNum.format(v)} kWh ${texto}`)}"></i>`)
    .join("");
  return `<span class="ap-barra">${trozos}</span>`;
}

/* Una tarjeta para los aparatos, con tres formas de fila porque son tres
   preguntas distintas:

     · movible  — «¿a qué hora?». Barra del origen si se pone ahora, lo que
       cuesta, y la mejor hora con lo que se gana.
     · fijo     — «¿cuánto me cuesta ahora?». Igual, pero sin proponer hora: el
       aire lo quieres cuando hace calor, no cuando pica el sol.
     · continuo — «¿cuánto lleva hoy y de dónde salió?». Una nevera no tiene hora
       que elegir, y hasta ahora se le calculaba una.

   Antes eran dos tarjetas con dos simulaciones distintas del mismo instante. */
function renderPlan(plan) {
  const rows = (plan && plan.rows) || [];
  const bat = plan && plan.battery;
  $("#plan-panel").classList.toggle("hidden", !rows.length && !bat);
  if (!rows.length && !bat) return;

  // El titular habla solo de los que se pueden mover: es lo único sobre lo que hay
  // una decisión que tomar.
  const movibles = rows.filter((r) => r.kind === "movible");
  const mueven = movibles.filter((r) => r.worth_waiting);
  const ahorro = mueven.reduce((a, r) => a + (r.saving_eur || 0), 0);
  const luego = movibles.some((r) => r.best && r.best.at > r.now.at);
  $("#plan-aside").textContent = !movibles.length ? ""
    : mueven.length && ahorro > 0 ? `ahorras ${fmtEUR.format(ahorro)} moviéndolos`
    : mueven.length ? "mejor esperar"
    : luego ? "da casi igual cuándo"
    : "ya están en su mejor hora";

  $("#plan-rows").innerHTML = rows.map((r) => {
    const v = r.verdict || {};
    // El número de la derecha es lo que cuesta —o «Gratis», que es un coste de
    // cero dicho en palabras—, y sale del mismo reparto que dibuja la barra.
    const importe = typeof v.value === "number" ? fmtEUR.format(v.value) : (v.value || "—");
    let sub, pie;
    if (r.kind === "continuo") {
      const t = r.today || {};
      sub = `${fmtNum.format(t.kwh || 0)} kWh hoy · siempre encendido`;
      pie = v.sub || "";
    } else if (r.kind === "fijo") {
      sub = `${dur(r.hours)} · ahora mismo ${r.now.sun_pct} % con sol`;
      pie = v.sub || "";
    } else {
      // **El porcentaje es del momento del que se habla.** Con `worth_waiting` en
      // falso la fila decía «ahora mismo» y enseñaba el sol de la mejor hora.
      sub = r.worth_waiting
        ? `${dur(r.hours)} · mejor ${cuando(r.best.at)}, ${r.best.sun_pct} % con sol`
        : `${dur(r.hours)} · ahora mismo ${r.now.sun_pct} % con sol`;
      pie = r.saving_eur >= 0.01 ? `ahorras ${fmtEUR.format(r.saving_eur)} esperando`
        : r.worth_waiting ? `esperando pasa a ${r.best.sun_pct} % con sol`
        : r.best && r.best.at > r.now.at ? "esperar apenas cambia nada"
        : "es su mejor hora";
    }
    return `
      <div class="ad-row ap-fila" data-kind="${esc(r.kind)}">
        <span class="ad-chip" style="--ap:${esc(r.color)}">
          <svg class="i"><use href="#i-${esc(r.icon)}"/></svg>
        </span>
        <span class="ad-txt">
          <b>${esc(r.name)}</b>
          <small>${esc(sub)}</small>
          ${barraOrigen(r.kind === "continuo" ? r.today : r.now)}
        </span>
        <span class="ad-verdict">
          <b class="v-${esc(v.kind || "gratis")}">${esc(importe)}</b>
          <small>${esc(pie)}</small>
        </span>
      </div>`;
  }).join("");

  const notas = [];
  // El desvío de hoy, con las mismas palabras que la tarjeta de la ventana y
  // desde el mismo dato: las dos tarjetas prometen horas sacadas de la misma
  // curva, así que si esa curva va rebajada las dos tienen que decirlo. Callarlo
  // aquí sería volver a la incoherencia de partida por la puerta de atrás.
  //
  // Y sin decir por qué se desvía: la previsión ya lleva la meteorología dentro,
  // así que esto no es nubosidad y la causa no se puede saber desde dos sensores.
  const desvio = plan && plan.roof_today;
  if (desvio && desvio.factor && desvio.factor <= 0.85) {
    notas.push(`Hoy tu tejado va al <b>${Math.round(desvio.factor * 100)} %</b> de
      lo previsto, así que estas horas ya van con el sol rebajado. Si remonta,
      mejorarán solas.`);
  }
  if (bat) {
    notas.push(`Compensa <b>cargar ${fmtNum.format(bat.kwh)} kWh</b> de la red
      ${cuando(bat.at)}, a ${fmtEUR.format(bat.valley_eur_kwh)}/kWh: mañana el sol
      no va a llenar la batería y esa misma energía a las horas caras te costaría
      ${fmtEUR.format(bat.peak_eur_kwh)}/kWh. Te ahorras
      <b>${fmtEUR.format(bat.saving_eur)}</b>.`);
  }
  // La reserva de la batería. Venía de la tarjeta que se ha retirado y hay que
  // conservarla: explica por qué una batería «al 21 %» no aparece en ninguna de
  // las barras de arriba, que si no parece un error del programa.
  const pila = plan && plan.battery_state;
  if (pila && pila.at_reserve) {
    notas.push(`La batería está en su reserva (${fmtNum.format(pila.soc)} % de carga,
      mínimo ${fmtNum.format(pila.reserve_pct)} %): el inversor no baja de ahí, así
      que ahora mismo no puede dar nada y lo que el sol no cubra sale de la red.`);
  }
  // Y los aparatos cuya forma de uso ha decidido la aplicación, para que se pueda
  // corregir. Detectar y callarlo es lo que hace que una fila rara parezca un fallo.
  const adivinados = rows.filter((r) => r.kind_auto && r.kind === "continuo");
  if (adivinados.length) {
    notas.push(`${adivinados.map((r) => esc(r.name)).join(", ")} ${
      adivinados.length === 1 ? "está" : "están"} como <b>siempre encendido</b>
      porque así lo dice su histórico: no se ${
      adivinados.length === 1 ? "le" : "les"} propone hora porque no hay ninguna que
      elegir. Se cambia en Ajustes → Electrodomésticos.`);
  }
  if (rows.length && rows.some((r) => r.priced === false)) {
    notas.push(`Sin tu tarifa elegida en Ajustes esto va por lo que no tendrías
      que comprar, no por lo que cuesta. Con la tarifa, en euros.`);
  }
  $("#plan-note").innerHTML = notas.join(" ");
  $("#plan-note").classList.toggle("hidden", !notas.length);
}

/* El tiempo hora a hora de las horas de sol que quedan hoy.

   No es una tarjeta del tiempo cualquiera: en una aplicación de energía lo que
   importa es **qué deja pasar el cielo**, así que cada fila pone la nubosidad al
   lado del sol previsto para esa hora, y el sol sale de la misma curva que la
   ventana y el plan. Así se puede leer del tirón: «a las dos, 70 % de nubes, y
   aun así 2,1 kW».

   La nubosidad de aquí sí es meteorología —viene de la entidad `weather.*`— y no
   hay que confundirla con `roof_today`, que es cuánto se desvía el tejado de una
   previsión que ya tenía esas nubes contadas. Son dos números distintos. */
function renderTiempo(t) {
  const horas = (t && t.hours) || [];
  $("#tiempo-panel").classList.toggle("hidden", !horas.length);
  if (!horas.length) return;

  // El titular: hasta cuándo llega el día y cuánta nube hay de media en lo que
  // queda. Es lo que se quiere saber sin leer las filas.
  const conNubes = horas.filter((h) => h.cloud_pct != null);
  const nubeMedia = conNubes.length
    ? Math.round(conNubes.reduce((a, h) => a + h.cloud_pct, 0) / conNubes.length)
    : null;
  const hasta = new Date(t.until).toLocaleTimeString("es-ES",
    { hour: "2-digit", minute: "2-digit" });
  $("#tiempo-aside").textContent = nubeMedia == null
    ? `hasta las ${hasta}`
    : `${nubeMedia} % de nubes hasta las ${hasta}`;

  const pico = t.peak_w || 0;
  $("#tiempo-rows").innerHTML = horas.map((h) => {
    const hora = new Date(h.at).toLocaleTimeString("es-ES",
      { hour: "2-digit", minute: "2-digit" });
    // La barra en proporción al pico de lo que queda, no al del día entero: a
    // las seis de la tarde todas las barras serían un hilo y no se compararía
    // nada con nada.
    const alto = pico > 0 ? Math.max(2, Math.round(h.sun_w / pico * 100)) : 0;
    const nube = h.cloud_pct == null ? "" :
      `<span class="tp-nube" title="nubosidad prevista">${esc(String(h.cloud_pct))} %</span>`;
    const temp = h.temperature == null ? ""
      : `<span class="tp-temp">${esc(fmtTemp.format(h.temperature))}°</span>`;
    return `
      <div class="tp-row">
        <span class="tp-hora">${esc(hora)}</span>
        <span class="tp-icono" title="${esc(h.condition || "")}">${
          weatherIcon(h.condition, "day")}</span>
        ${temp}
        ${nube}
        <span class="tp-barra"><i style="height:${alto}%"></i></span>
        <span class="tp-sol">${esc(kwSol(h.sun_w))}</span>
      </div>`;
  }).join("");

  // Y de dónde sale el sol de la columna de la derecha, porque no es del sensor:
  // es la curva ya corregida con el tejado y con su desvío de hoy. La misma regla
  // que las otras dos tarjetas — una cifra que no es la del sensor lo dice.
  $("#tiempo-note").innerHTML = `La columna de la derecha es el sol previsto para
    esa hora, con la corrección de tu tejado ya aplicada: es la misma curva de la
    que salen la ventana y el plan.`;
  $("#tiempo-note").classList.remove("hidden");
}

/* Vatios a texto corto para la columna del sol: por debajo del kilovatio se dan
   en vatios enteros, que «0,3 kW» a las siete de la tarde se lee como nada. */
function kwSol(w) {
  if (!w || w < 1) return "—";
  return w < 1000 ? `${Math.round(w)} W` : `${fmtNum.format(w / 1000)} kW`;
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

/*
 * Ajustes: el índice, la fuente de datos, los catorce sensores del balance, la
 * copia de seguridad y el diagnóstico.
 */
import { $, $$, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on, emit } from "../core/bus.js";
import { fmtNum } from "../core/format.js";
import { config, settings, tariffs, reloadConfig } from "../core/config.js";
import { FLOWS, estiloFlujo } from "../core/flujo.js";
import { CATALOGO, ordenTarjetas, ocultas } from "../core/tarjetas.js";
import { showSettingsPage } from "../core/nav.js";
import { guardando } from "../core/guardando.js";
import { asegurar, porTipo, opciones, cargadas } from "../core/entidades.js";

const sensorState = { data: null, picking: null };

/* Los tres modos de un contador de energía, con el nombre que se entiende sin
   saber lo que es un `state_class`. */
const MODOS_CONTADOR = [
  ["auto", "Automático"],
  ["daily", "Del día"],
  ["lifetime", "Total"],
];
const NOTA_CONTADOR = {
  auto: "Se detecta comparando su estado con lo que ha subido hoy.",
  daily: "Se pone a cero cada noche: se lee su valor tal cual.",
  lifetime: "Sube desde que se instaló: se resta el valor de medianoche.",
};

/* ---------------- Sensores, por función ----------------

   El diseño cambia catorce desplegables ciegos por catorce filas que dicen qué
   entidad tienen, cuánto marca ahora y si responde. Una casilla vacía tiñe su
   fila y ofrece los candidatos con el nombre a favor, así que asignar un sensor
   son tres toques y no buscar entre trescientas entradas.

   Los datos vienen de /api/sensors, que ya trae valor en vivo y sugerencias. */

/* El recuento del índice, en segundo plano: si falla no se dice nada, que el
   índice siga enseñando su descripción es mejor que un error por algo que solo
   es un contador. */
async function refreshSensorCount() {
  try {
    sensorState.data = await api("sensors");
    const s = settings();
    if (s) renderSettingsIndex(s);
  } catch (_) { /* sin conexión con HA */ }
}

async function loadSensors() {
  const box = $("#sensors-groups");
  if (!sensorState.data) box.innerHTML = `<div class="panel glass"><p class="empty">Leyendo los sensores…</p></div>`;
  try {
    sensorState.data = await api("sensors");
  } catch (err) {
    box.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    return;
  }
  renderSensors();
}

function renderSensors() {
  const d = sensorState.data;
  if (!d) return;
  $("#sensors-count").textContent = `${d.assigned} de ${d.total}`;

  $("#sensors-groups").innerHTML = d.groups.map((g) => `
    <div class="panel glass sgroup">
      <div class="sgroup-head"><svg class="i"><use href="#i-${esc(g.icon)}"/></svg>
        <b>${esc(g.name)}</b></div>
      ${g.rows.map((r) => sensorRow(r)).join("")}
    </div>`).join("");

  $$("#sensors-groups .srow").forEach((el) =>
    el.addEventListener("click", () => openSensorPicker(el.dataset.slot)));
  $$("#sensors-groups .srow-assign").forEach((el) =>
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openSensorPicker(el.closest(".srow").dataset.slot);
    }));
}

function sensorRow(r) {
  const clases = ["srow"];
  if (!r.entity) clases.push("empty");
  else if (!r.responds) clases.push("down");
  if (r.optional) clases.push("optional");
  // Un sensor que responde perfectamente y mide otra cosa. Se marca aparte de
  // «caído» porque el problema es el contrario: funciona, y por eso engaña.
  if (r.warning) clases.push("mal-elegido");

  // Segunda línea: la entidad y su lectura, que es lo que permite comprobar de
  // un vistazo que la casilla tiene el sensor correcto y no otro parecido.
  let sub;
  if (!r.entity) {
    const n = r.suggestions.length;
    const sug = n ? ` · ${n} sugerencia${n === 1 ? "" : "s"}` : "";
    // El texto de una casilla opcional lo pone el servidor, porque no todas lo
    // son por lo mismo: el consumo de la casa se deduce del balance y el estado
    // de carga no se deduce de nada. Decir «se deduce del balance» en las dos
    // hacía que la del estado de carga pareciese resuelta.
    sub = r.optional ? (r.note || "Opcional") + sug
      : `Sin asignar${sug}`;
  } else {
    const corto = r.entity.replace(/^sensor\./, "").split(",")[0];
    // El tipo de contador va en la fila: leer mal un total como si fuera del día
    // no da error, da una cifra absurda, y así se ve sin entrar.
    const tipo = r.counter && r.counter !== "auto"
      ? ` · ${r.counter === "daily" ? "del día" : "total"}` : "";
    sub = r.responds ? `${corto} · ${fmtNum.format(r.value ?? 0)} ${r.unit}${tipo}`
                     : `${corto} · no disponible${tipo}`;
  }
  return `
    <div class="${clases.join(" ")}" data-slot="${esc(r.slot)}" role="button" tabindex="0">
      <span class="srow-dot"></span>
      <span class="srow-txt"><b>${esc(r.label)}</b><small>${esc(sub)}</small></span>
      ${r.entity ? `<svg class="i nav-chev"><use href="#i-chevron"/></svg>`
                 : `<button type="button" class="srow-assign">Asignar</button>`}
    </div>
    ${r.warning ? `<p class="li-note srow-warn">${negrita(r.warning)}</p>` : ""}`;
}

/* Los avisos del servidor traen **negritas** para señalar la palabra que
   importa. Se convierten aquí, escapando primero: el texto es nuestro, pero
   lleva dentro el `entity_id` que ha elegido el usuario. */
function negrita(texto) {
  return esc(texto).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

/* Hoja de asignación: primero los candidatos y detrás la lista entera, por si
   el nombre del sensor no se parece a nada. */
async function openSensorPicker(slot) {
  const d = sensorState.data;
  const fila = d.groups.flatMap((g) => g.rows).find((r) => r.slot === slot);
  if (!fila) return;
  sensorState.picking = fila;

  $("#pick-title").textContent = fila.label;
  await asegurar();
  const todas = porTipo(fila.kind);

  // Los candidatos primero; debajo, un buscador sobre la lista entera. El §04
  // lo pide así a propósito: con trescientas entidades, un desplegable no se
  // puede recorrer, pero escribir «solar» sí acota.
  const sugerencias = fila.suggestions.length
    ? `<div class="pick-sugg">${fila.suggestions.map((e) => `
        <button type="button" data-pick="${esc(e.entity_id)}">
          <b>${esc(e.name)}</b><code>${esc(e.entity_id)}</code>
          ${e.unit ? `<small>${esc(e.unit)}</small>` : ""}
        </button>`).join("")}</div>`
    : "";

  /* «¿Qué mide este contador?», y por contador.

     Antes era un solo interruptor para los seis, y una instalación normal los
     tiene mezclados: el de la red viene totalizado desde que se instaló y los
     de la batería son del día. Con uno solo, arreglar la mitad estropeaba la
     otra. Va aquí y no en una pantalla aparte porque es la misma decisión que
     elegir la entidad: al ponerla ya sabes lo que mide. */
  const tipoContador = fila.group !== "energy" ? "" : `
    <div class="li col">
      <span class="li-txt"><b>¿Qué mide?</b>
        <small id="pick-kind-note">${esc(NOTA_CONTADOR[fila.counter] || "")}</small></span>
      <div class="segmented glass-soft" id="pick-kind" role="group"
           aria-label="Qué mide este contador">
        ${MODOS_CONTADOR.map(([id, texto]) => `
          <button class="seg${fila.counter === id ? " active" : ""}"
                  data-kind="${id}">${esc(texto)}</button>`).join("")}
      </div>
      ${fila.counter_own ? "" : `<p class="li-note">Ahora sigue al ajuste general.</p>`}
    </div>`;

  $("#pick-body").innerHTML = `
    ${tipoContador}
    ${sugerencias}
    <label class="pick-search">
      <svg class="i" aria-hidden="true"><use href="#i-buscar"/></svg>
      <input type="search" id="pick-q" placeholder="Buscar por nombre, id o unidad"
             autocomplete="off" aria-label="Buscar entidad">
      <span class="pick-count" id="pick-count"></span>
    </label>
    <div class="pick-list" id="pick-list"></div>
    ${fila.entity ? `<div class="banner-act">
      <button type="button" class="btn subtle" data-pick="">Quitar la asignación</button>
    </div>` : ""}
    <p class="li-note">Se puede poner el <b>mismo sensor en las dos casillas</b>
      de un par si es bidireccional: se separa por el signo.</p>`;

  const pintar = (q) => {
    const t = q.trim().toLowerCase();
    const vistos = t
      ? todas.filter((e) => `${e.entity_id} ${e.name} ${e.unit}`.toLowerCase().includes(t))
      : todas;
    $("#pick-count").textContent = t
      ? `${vistos.length} de ${todas.length}`
      : `${todas.length} entidad${todas.length === 1 ? "" : "es"}`;
    $("#pick-list").innerHTML = vistos.length
      ? vistos.slice(0, 60).map((e) => `
          <button type="button" data-pick="${esc(e.entity_id)}"
            ${e.entity_id === fila.entity ? 'aria-current="true"' : ""}>
            <b>${esc(e.name)}</b>
            <small>${esc(e.entity_id)}${e.unit ? ` · ${esc(e.unit)}` : ""}</small>
          </button>`).join("")
      : `<p class="pick-none">Ninguna entidad coincide con «${esc(q)}».</p>`;
    $$("#pick-list [data-pick]").forEach((b) =>
      b.addEventListener("click", () => assignSensor(slot, b.dataset.pick)));
  };
  pintar("");
  $("#pick-q").addEventListener("input", (ev) => pintar(ev.target.value));

  $$("#pick-body .pick-sugg [data-pick], #pick-body .banner-act [data-pick]")
    .forEach((b) => b.addEventListener("click", () => assignSensor(slot, b.dataset.pick)));
  // El tipo de contador se guarda solo y **sin cerrar la hoja**: es habitual
  // cambiarlo y comprobar el valor sin salir.
  $$("#pick-kind .seg").forEach((b) => b.addEventListener("click", async () => {
    const kind = b.dataset.kind;
    $$("#pick-kind .seg").forEach((x) => x.classList.toggle("active", x === b));
    $("#pick-kind-note").textContent = NOTA_CONTADOR[kind] || "";
    try {
      await api("settings", { method: "PUT",
        body: JSON.stringify({ energy_counter_kinds: { [slot]: kind } }) });
      await reloadConfig();
      await loadSensors();
      emit("datos");
    } catch (err) {
      $("#pick-kind-note").textContent = `No se ha podido guardar: ${err.message}`;
    }
  }));
  $("#pick-modal").classList.remove("hidden");
  $("#pick-q").focus();
}

async function assignSensor(slot, entity) {
  const fila = sensorState.picking;
  if (!fila) return;
  const grupo = fila.group === "flow" ? "flow_sensors" : "energy_sensors";
  await api("settings", { method: "PUT",
    body: JSON.stringify({ [grupo]: { [slot]: entity } }) });
  $("#pick-modal").classList.add("hidden");
  // La hoja se cierra al instante; la fila que se está guardando se recarga
  // justo debajo, así que el estado «Guardando» no aporta nada aquí.
  await reloadConfig();
  await loadSensors();
}

/* ---------------- el índice y el formulario ---------------- */

// Resumen de cada categoría en el índice de Ajustes.
function renderSettingsIndex(s) {
  $("#nav-sub-source").textContent = s.source === "homeassistant"
    ? "Home Assistant" : "Demostración · datos de ejemplo";
  const lista = tariffs();
  const n = lista.length;
  // Se nombra la tarifa contratada: es la que decide el ahorro del cierre, y
  // conviene poder comprobar de un vistazo que está bien elegida.
  const mine = lista.find((t) => t.id === s.my_tariff_id);
  $("#nav-sub-tariffs").textContent = (n === 1 ? "1 tarifa" : `${n} tarifas`) +
    (mine ? ` · la tuya es ${mine.name}` : "");
  $("#nav-sub-contract").textContent =
    `${fmtNum.format(s.contracted_power?.p1 ?? 0)} / ${fmtNum.format(s.contracted_power?.p2 ?? 0)} kW · ciclo el día ${s.billing_day ?? 1}`;
  const ifx = s.influx || {};
  const url = (ifx.url || "").trim();
  $("#nav-sub-influx").textContent = !url
    ? "Sin configurar · el histórico sale del recorder"
    : `v${ifx.version ?? 2} · histórico del consumo`;
  $("#nav-sub-publish").textContent = s.export_sensors === false
    ? "Desactivado"
    : `Cada ${s.sensor_update_minutes ?? 5} min`;
  $("#nav-sub-flows").textContent = estiloFlujo(s).name;
  const off = ocultas(s).size;
  $("#nav-sub-home").textContent = off
    ? `${CATALOGO.length - off} de ${CATALOGO.length} tarjetas · orden a tu gusto`
    : "El orden de las tarjetas, a tu gusto";
  const gente = usersState.data?.users;
  $("#nav-sub-users").textContent = gente
    ? `${gente.length} ${gente.length === 1 ? "persona" : "personas"} · ` +
      `${gente.filter((u) => u.role === "admin").length} con permisos`
    : "Quién ha entrado y quién puede configurar";
  aplicarPermisos();
  const version = config()?.version;
  $("#nav-sub-about").textContent = version ? `Versión ${version}` : "Versión del add-on";
  // «13 de 13 asignados»: el índice tiene que decir si está bien sin entrar.
  const sd = sensorState.data;
  $("#nav-sub-sensors").textContent = sd
    ? `${sd.assigned} de ${sd.total} asignados` +
      (sd.down.length ? ` · ${sd.down.length} sin responder` : "")
    : "Potencia y energía del día";
  $("#about-version").textContent = version ? `v${version}` : "—";
}

function fillSettings() {
  const s = settings();
  if (!s) return;
  $("#s-ha-url").value = s.ha_url || "";
  $("#s-ha-token").value = s.ha_token || "";
  $("#s-p1").value = s.contracted_power?.p1 ?? 4.6;
  $("#s-p2").value = s.contracted_power?.p2 ?? 4.6;
  $("#s-billing-day").value = s.billing_day ?? 1;
  $("#s-timezone").value = s.timezone || "Europe/Madrid";
  $("#s-holidays").value = (s.holidays || []).join(", ");
  $("#s-export-sensors").checked = s.export_sensors !== false;
  $("#s-sensor-minutes").value = s.sensor_update_minutes ?? 5;
  $("#s-energy-counters").value = s.energy_counters || "auto";
  $("#s-battery-kwh").value = s.battery_kwh || "";
  $("#s-battery-reserve").value = s.battery_reserve_pct || "";
  renderSettingsIndex(s);
  const ifx = s.influx || {};
  $("#s-ifx-version").value = String(ifx.version ?? 2);
  $("#s-ifx-url").value = ifx.url || "";
  $("#s-ifx-db").value = ifx.database || "";
  $("#s-ifx-measurement").value = ifx.measurement || "kWh";
  $("#s-ifx-org").value = ifx.org || "";
  $("#s-ifx-token").value = ifx.token || "";
  $("#s-ifx-user").value = ifx.username || "";
  $("#s-ifx-pass").value = ifx.password || "";
  // El material traslúcido no es un ajuste nuestro: la guía dice que sigue al
  // del sistema, así que aquí solo se informa de cómo está.
  const reduce = window.matchMedia &&
    window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
  $("#material-state").textContent = reduce ? "Reducido" : "Activo";
  fillEntitySelects();
  updateSourceVisibility();
  ensureGroupedEntities();
}

/* Una sola fuente para toda la app.
   Antes había tres opciones y cada una arrastraba sus propios campos: dos
   sensores de energía «de facturación» aquí y otros dos `entity_id` en InfluxDB,
   que eran **los mismos contadores** que ya se piden en Sensores. Ahora la
   pregunta es una: ¿datos de verdad o de ejemplo? Los sensores, en Sensores. */
function updateSourceVisibility() {
  const source = settings()?.source === "homeassistant" ? "homeassistant" : "demo";
  $$("#source-seg .seg").forEach((b) =>
    b.classList.toggle("active", b.dataset.sourceOpt === source));
  // Fuera del Supervisor no hay token que herede: hay que dar URL y token.
  $("#ha-external").classList.toggle("hidden", source !== "homeassistant" || !!config()?.supervisor);
  const asignados = sensorState.data;
  $("#source-note").innerHTML = source === "demo"
    ? `Datos inventados para probar la app sin tocar nada. El consumo, el flujo
       y la facturación salen de una casa de ejemplo.`
    : `Todo sale de tus sensores de Home Assistant: la Home, Energía, el flujo y
       la facturación${asignados ? ` (${asignados.assigned} de ${asignados.total} asignados)` : ""}.
       Se eligen una sola vez, abajo en <b>Sensores</b>.`;
  const v2 = $("#s-ifx-version").value === "2";
  $$(".ifx-v2").forEach((el) => el.classList.toggle("hidden", !v2));
  $$(".ifx-v1").forEach((el) => el.classList.toggle("hidden", v2));
}

// Carga silenciosa de entidades al abrir Ajustes: evita tener que pulsar
// «Buscar entidades» para ver los desplegables poblados.
async function ensureGroupedEntities() {
  if (cargadas()) return;
  await asegurar();
  fillEntitySelects();
}

/* Los selectores que siguen siendo un desplegable: previsión solar y los dos de
   meteorología. Son de uno en uno y opcionales, así que no piden la pantalla de
   filas con valor en vivo que sí necesitan los catorce del balance. */
function fillEntitySelects() {
  const s = settings();
  if (!s) return;
  $("#s-condition").innerHTML = opciones("any", s.condition_sensor || "");
  $("#s-temp").innerHTML = opciones("temperature", s.temperature_sensor || "");
  $("#s-forecast").innerHTML = opciones("any", s.solar_forecast_sensor || "");
  // Solo entidades `weather.*`: son las únicas con previsión horaria.
  $("#s-weather").innerHTML = opciones(
    "weather", s.weather_entity || "", "— sin tarjeta del tiempo —");
}

/* Lo que manda la barra de «Guardar ajustes».

   Aquí **no van los sensores**. La pantalla de Sensores dejó de ser un
   formulario de catorce desplegables y pasó a ser una lista de filas que se
   guardan una a una al asignarlas, así que ya no hay ningún `[data-flow]` ni
   `[data-energy]` en el documento. Este formulario seguía recorriéndolos: no
   rompía nada —el servidor fusiona por claves y fusionar con vacío no cambia
   nada— pero mandaba `flow_sensors: {}` y `energy_sensors: {}` en cada guardado,
   y el día que alguien hiciera que un PUT reemplace en vez de fusionar, se
   llevaba por delante los catorce sensores de una vez. */
function settingsFromForm() {
  return {
    ha_url: $("#s-ha-url").value.trim(),
    ha_token: $("#s-ha-token").value,
    contracted_power: { p1: parseFloat($("#s-p1").value) || 0, p2: parseFloat($("#s-p2").value) || 0 },
    billing_day: parseInt($("#s-billing-day").value, 10) || 1,
    timezone: $("#s-timezone").value.trim() || "Europe/Madrid",
    holidays: $("#s-holidays").value.split(",").map((x) => x.trim()).filter(Boolean),
    export_sensors: $("#s-export-sensors").checked,
    sensor_update_minutes: parseInt($("#s-sensor-minutes").value, 10) || 5,
    energy_counters: $("#s-energy-counters").value,
    battery_kwh: Number($("#s-battery-kwh").value) || 0,
    condition_sensor: $("#s-condition").value,
    temperature_sensor: $("#s-temp").value,
    solar_forecast_sensor: $("#s-forecast").value,
    weather_entity: $("#s-weather").value,
    influx: {
      version: parseInt($("#s-ifx-version").value, 10) || 2,
      url: $("#s-ifx-url").value.trim(),
      database: $("#s-ifx-db").value.trim(),
      measurement: $("#s-ifx-measurement").value.trim() || "kWh",
      org: $("#s-ifx-org").value.trim(),
      token: $("#s-ifx-token").value,
      username: $("#s-ifx-user").value.trim(),
      password: $("#s-ifx-pass").value,
    },
  };
}

async function saveSettings(silent = false) {
  const status = $("#settings-status");
  const listo = silent ? () => {} : guardando($("#save-settings-btn"));
  try {
    const result = await api("settings", { method: "PUT", body: JSON.stringify(settingsFromForm()) });
    Object.assign(settings(), result.settings);
    if (!silent) {
      status.textContent = "✓ Ajustes guardados";
      setTimeout(() => (status.textContent = ""), 3000);
      emit("datos");
    }
  } catch (err) {
    if (!silent) status.textContent = `Error: ${err.message}`; else throw err;
  } finally {
    listo();
  }
}

/* ---------------- galería de flujos en tiempo real ----------------
   Un icono vectorial por tipo de diagrama, dibujado a mano y no reducido del
   componente de verdad: a 132 px de ancho el Sankey completo es una mancha, y
   lo que hay que reconocer es la **forma** —un haz de cintas entre dos columnas,
   o una casa con satélites—. Los colores son los de las series, así que el icono
   y el diagrama hablan el mismo idioma.

   Se dibujan con los tokens del tema por `var()`: al cambiar de tema se
   repintan solos, sin volver a pasar por aquí. */
const GAL_ART = {
  sankey: `
    <svg class="gal-art" viewBox="0 0 132 84" aria-hidden="true">
      <g fill="none" stroke-linecap="butt">
        <path d="M22 22C52 22 58 30 110 30" stroke="var(--s-solar)" stroke-width="15" opacity=".55"/>
        <path d="M22 45C52 45 58 55 110 55" stroke="var(--s-batt)" stroke-width="8" opacity=".55"/>
        <path d="M22 60C52 60 58 70 110 70" stroke="var(--s-grid)" stroke-width="5" opacity=".55"/>
      </g>
      <g>
        <rect x="16" y="12" width="6" height="20" fill="var(--s-solar)"/>
        <rect x="16" y="39" width="6" height="12" fill="var(--s-batt)"/>
        <rect x="16" y="56" width="6" height="9" fill="var(--s-grid)"/>
        <rect x="110" y="20" width="6" height="21" fill="var(--s-home)"/>
        <rect x="110" y="48" width="6" height="15" fill="var(--s-batt)"/>
        <rect x="110" y="66" width="6" height="9" fill="var(--s-exp)"/>
      </g>
    </svg>`,
  /* La cruz clásica: el nodo arriba, los dos de los lados y la casa a la
     derecha, los cables ortogonales y la bola que los recorre. Lo que hay que
     reconocer aquí es que **todos los cables miden lo mismo**, al contrario que
     en el Sankey. */
  cruz: `
    <svg class="gal-art" viewBox="0 0 132 84" aria-hidden="true">
      <g fill="none" stroke-width="2.4" stroke-linecap="round">
        <path d="M66 24V60" stroke="var(--s-solar)"/>
        <path d="M40 42H92" stroke="var(--s-grid)"/>
        <path d="M56 30V36Q56 38 54 38H40" stroke="var(--s-solar)"/>
        <path d="M76 30V36Q76 38 78 38H92" stroke="var(--s-solar)"/>
      </g>
      <circle cx="66" cy="30" r="3.2" fill="var(--s-solar)"/>
      <circle cx="84" cy="42" r="3.2" fill="var(--s-grid)"/>
      <circle cx="66" cy="14" r="10" fill="var(--solid)" stroke="var(--s-solar)" stroke-width="2"/>
      <circle cx="30" cy="42" r="10" fill="var(--solid)" stroke="var(--s-grid)" stroke-width="2"/>
      <circle cx="102" cy="42" r="10" fill="var(--solid)" stroke="var(--s-home)" stroke-width="2"/>
      <circle cx="66" cy="70" r="10" fill="var(--solid)" stroke="var(--s-batt)" stroke-width="2"/>
      <!-- El anillo del reparto del día, alrededor del nodo de la casa: es lo
           único que este diagrama dice de dentro de la casa. -->
      <circle cx="102" cy="42" r="14" fill="none" stroke="var(--s-solar)" stroke-width="2.6"
              pathLength="100" stroke-dasharray="56 44" transform="rotate(-90 102 42)"/>
      <circle cx="102" cy="42" r="14" fill="none" stroke="var(--s-grid)" stroke-width="2.6"
              pathLength="100" stroke-dasharray="38 62" stroke-dashoffset="-58"
              transform="rotate(-90 102 42)"/>
    </svg>`,
  /* La órbita, con la misma disposición que el componente: casa en el centro,
     sol arriba, red abajo a la izquierda y batería abajo a la derecha. Las
     cintas mueren en el anillo de mezcla y no en el círculo de la casa, igual
     que en el diagrama de verdad. */
  orbita: `
    <svg class="gal-art" viewBox="0 0 132 84" aria-hidden="true">
      <g fill="none" stroke-linecap="butt" opacity=".55">
        <path d="M66 20V29" stroke="var(--s-solar)" stroke-width="9"/>
        <path d="M28.9 65.9 53.1 51.6" stroke="var(--s-grid)" stroke-width="5"/>
        <path d="M103.1 65.9 78.9 51.6" stroke="var(--s-batt)" stroke-width="6"/>
      </g>
      <circle cx="66" cy="44" r="11" fill="var(--solid)" stroke="var(--s-home)" stroke-width="2"/>
      <circle cx="66" cy="44" r="15" fill="none" stroke="var(--s-solar)" stroke-width="3"
              pathLength="100" stroke-dasharray="60 40" transform="rotate(-90 66 44)"/>
      <circle cx="66" cy="44" r="15" fill="none" stroke="var(--s-grid)" stroke-width="3"
              pathLength="100" stroke-dasharray="36 64" stroke-dashoffset="-62"
              transform="rotate(-90 66 44)"/>
      <circle cx="66" cy="12" r="8" fill="var(--solid)" stroke="var(--s-solar)" stroke-width="2"/>
      <circle cx="22" cy="70" r="8" fill="var(--solid)" stroke="var(--s-grid)" stroke-width="2"/>
      <circle cx="110" cy="70" r="8" fill="var(--solid)" stroke="var(--s-batt)" stroke-width="2"/>
    </svg>`,
};

/* ---------------- usuarios y permisos ---------------- */

const usersState = { data: null };

/* ¿Manda quien mira? Lo dice el servidor en `/api/config`; aquí solo se usa
   para esconder lo que no va a poder tocar. **No es la defensa**: el servidor
   rechaza por su cuenta cualquier escritura que no sea de administrador, y
   esconder botones solo evita el chasco de pulsarlos. */
function esAdmin() {
  return !!(config()?.user?.admin);
}

/* Esconde del índice lo que es de administrador. Los rótulos de grupo van
   marcados igual que sus paneles, para que no se quede un título suelto encima
   de nada. */
function aplicarPermisos() {
  const admin = esAdmin();
  $$("#sp-root [data-admin]").forEach((el) => el.classList.toggle("hidden", !admin));
  $("#ajustes-mirador").classList.toggle("hidden", admin);
  // El subtítulo enumeraba justo lo que quien no administra no puede ver.
  $("#ajustes-sub").textContent = admin
    ? "Datos, sensores, facturación e integración"
    : "Tu apariencia y tu pantalla de inicio";
}

const ARRANQUES = {
  primero: "el primero que entre será administrador y el resto, no",
  admin: "todo el que entre será administrador",
  viewer: "nadie será administrador por entrar",
};

/* Cuándo se vio a alguien, en corto: «hoy a las 14:20», «ayer», «hace 3 días».
   La fecha exacta no aporta —lo que se quiere saber es si sigue usándolo— y en
   una fila estrecha ocupa el sitio del nombre. */
function visto(iso) {
  if (!iso) return "todavía no ha entrado";
  const t = new Date(iso), ahora = new Date();
  const dias = Math.floor((ahora - t) / 86400000);
  const hhmm = t.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  if (t.toDateString() === ahora.toDateString()) return `hoy a las ${hhmm}`;
  if (dias <= 1) return "ayer";
  if (dias < 30) return `hace ${dias} días`;
  return t.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
}

async function cargarUsuarios() {
  const caja = $("#users-list");
  $("#users-estado").textContent = "";
  let datos;
  try {
    datos = await api("users");
  } catch (err) {
    caja.innerHTML = `<li><p class="li-note">${esc(err.message)}</p></li>`;
    return;
  }
  $("#users-welcome").textContent =
    `De momento, ${ARRANQUES[datos.welcome] || ARRANQUES.primero}. Se cambia en ` +
    `las opciones del add-on, en Ajustes de Home Assistant → Complementos → ` +
    `Vatia → Configuración.`;
  usersState.data = datos;
  pintarUsuarios();
}

function pintarUsuarios() {
  const datos = usersState.data;
  if (!datos) return;
  const yo = config()?.user || {};
  const admins = datos.users.filter((u) => u.role === "admin").length;
  $("#users-list").innerHTML = datos.users.map((u) => {
    const admin = u.role === "admin";
    // El último administrador no se puede degradar ni borrar: se apaga el
    // control y se dice por qué, en vez de dejar pulsar y dar un error.
    const ultimo = admin && admins === 1;
    const nombre = u.name || "Sin nombre";
    const sub = ultimo
      ? "el único administrador · nombra a otro para poder cambiarlo"
      : `${admin ? "Administrador" : "Solo mira"} · ${visto(u.last_seen)}`;
    return `<li data-user="${esc(u.id)}">
      <div class="card-row">
        <span class="card-ico" style="--ico:${admin ? "#ff375f" : "#8e8e93"}">
          <svg class="i"><use href="#i-${admin ? "ajustes" : "vista-general"}"/></svg></span>
        <span class="card-txt">
          <b>${esc(nombre)}${u.id === yo.id ? " · tú" : ""}</b>
          <small>${esc(sub)}</small></span>
        <input type="checkbox" class="ios-switch" data-user-admin
               ${admin ? "checked" : ""} ${ultimo ? "disabled" : ""}
               aria-label="${esc(nombre)} es administrador">
      </div>
    </li>`;
  }).join("") || `<li><p class="li-note">Todavía no ha entrado nadie más.</p></li>`;
}

async function cambiarRol(id, admin) {
  $("#users-estado").textContent = "Guardando…";
  try {
    await api(`users/${encodeURIComponent(id)}/role`, {
      method: "PUT", body: JSON.stringify({ role: admin ? "admin" : "viewer" }),
    });
    await cargarUsuarios();
    // Si me he degradado a mí mismo, la interfaz tiene que reaccionar: se
    // recarga la configuración y el índice se queda con lo que ya puedo ver.
    await reloadConfig();
    aplicarPermisos();
    $("#users-estado").textContent = "Guardado.";
  } catch (err) {
    $("#users-estado").textContent = err.message;
    pintarUsuarios();          // devuelve el interruptor a donde estaba
  }
}

/* ---------------- las tarjetas de la Home ---------------- */

/* La lista de Ajustes → Pantalla de inicio: una fila por tarjeta, en su orden,
   con las flechas para moverla y el interruptor para verla o no. */
/* Si estas preferencias son solo tuyas o las va a ver toda la casa. Hay que
   decirlo: cambiar el orden creyendo que es tuyo y descolocárselo a los demás
   es exactamente el tipo de sorpresa que no se perdona. */
function quienMira() {
  const u = config()?.user;
  const texto = u && u.identificado
    ? (u.name
      ? `Solo para ti, ${u.name}: cada persona de Home Assistant tiene lo suyo, y
         a los demás no les cambia nada.`
      : `Solo para ti: cada persona de Home Assistant tiene lo suyo, y a los
         demás no les cambia nada.`)
    : `Compartido: has entrado sin pasar por Home Assistant, así que no se sabe
       quién eres y esto lo verá todo el que entre igual. Desde la barra lateral
       de Home Assistant, es tuyo y de nadie más.`;
  return texto.replace(/\s+/g, " ").trim();
}

function pintarTarjetas() {
  $("#home-quien").textContent = quienMira();
  const orden = ordenTarjetas(settings());
  const off = ocultas(settings());
  const total = orden.length;
  $("#home-cards-list").innerHTML = orden.map((id, i) => {
    const t = CATALOGO.find((c) => c.id === id);
    const oculta = off.has(id);
    return `<li data-card-row="${esc(id)}" data-off="${oculta ? 1 : 0}">
      <div class="card-row">
        <span class="card-ico" style="--ico:${esc(t.color)}">
          <svg class="i"><use href="#${esc(t.icon)}"/></svg></span>
        <span class="card-txt"><b>${esc(t.name)}</b><small>${esc(t.claim)}</small></span>
        <span class="card-move">
          <button class="up" data-mover="-1" ${i === 0 ? "disabled" : ""}
                  aria-label="Subir ${esc(t.name)}">
            <svg class="i"><use href="#i-chevron"/></svg></button>
          <button class="down" data-mover="1" ${i === total - 1 ? "disabled" : ""}
                  aria-label="Bajar ${esc(t.name)}">
            <svg class="i"><use href="#i-chevron"/></svg></button>
        </span>
        <input type="checkbox" class="ios-switch" data-card-ver
               ${oculta ? "" : "checked"}
               aria-label="Ver ${esc(t.name)} en la pantalla de inicio">
      </div>
    </li>`;
  }).join("");
}

/* Guarda el orden y lo oculto, y lo aplica sin esperar al servidor: mover una
   tarjeta tiene que sentirse inmediato. Si el guardado falla se vuelve atrás y
   se dice por qué, que es lo que hace la galería de flujos. */
async function guardarTarjetas(orden, off, mensaje) {
  const s = settings();
  const antes = { orden: s.home_order, off: s.home_hidden };
  s.home_order = orden;
  s.home_hidden = [...off];
  pintarTarjetas();
  emit("config", config());
  $("#home-estado").textContent = "Guardando…";
  try {
    await api("settings", {
      method: "PUT",
      body: JSON.stringify({ home_order: orden, home_hidden: [...off] }),
    });
    await reloadConfig();
    pintarTarjetas();
    $("#home-estado").textContent = mensaje;
  } catch (err) {
    s.home_order = antes.orden;
    s.home_hidden = antes.off;
    pintarTarjetas();
    emit("config", config());
    $("#home-estado").textContent = `No se ha podido guardar: ${err.message}`;
  }
}

function moverTarjeta(id, paso) {
  const orden = ordenTarjetas(settings());
  const i = orden.indexOf(id);
  const j = i + paso;
  if (i < 0 || j < 0 || j >= orden.length) return;
  orden.splice(j, 0, ...orden.splice(i, 1));
  const t = CATALOGO.find((c) => c.id === id);
  guardarTarjetas(orden, ocultas(settings()), `Guardado · «${t.name}» en la posición ${j + 1}.`);
}

function verTarjeta(id, ver) {
  const off = ocultas(settings());
  if (ver) off.delete(id); else off.add(id);
  const t = CATALOGO.find((c) => c.id === id);
  guardarTarjetas(ordenTarjetas(settings()), off,
    ver ? `Guardado · «${t.name}» se ve.` : `Guardado · «${t.name}» oculta.`);
}

function pintarGaleria() {
  $("#gal-quien").textContent = quienMira();
  const actual = estiloFlujo(settings()).id;
  $("#flow-gallery").innerHTML = FLOWS.map((f) => `
    <button class="gal-tile" role="radio" data-flow-style="${esc(f.id)}"
            aria-checked="${f.id === actual}">
      ${GAL_ART[f.id] || ""}
      <span class="gal-name">${esc(f.name)}${f.id === actual
        ? `<svg class="i"><use href="#i-correcto"/></svg>` : ""}</span>
      <p class="gal-claim">${esc(f.claim)}</p>
      <p class="gal-mas">${esc(f.detalle)}</p>
    </button>`).join("");
}

async function elegirFlujo(id) {
  const s = settings();
  const antes = s ? s.flow_style : null;
  if (s) s.flow_style = id;
  pintarGaleria();
  $("#gal-estado").textContent = "Guardando…";
  try {
    await api("settings", { method: "PUT", body: JSON.stringify({ flow_style: id }) });
    await reloadConfig();
    pintarGaleria();
    $("#gal-estado").textContent = `Guardado · «${estiloFlujo(settings()).name}» en la Home y en el día.`;
    // Las dos pantallas cambian de componente, así que hay que repintarlas: el
    // nodo viejo se queda en el DOM y sin esto la galería no parecía hacer nada.
    emit("datos");
  } catch (err) {
    if (s) s.flow_style = antes;
    pintarGaleria();
    $("#gal-estado").textContent = `No se ha podido guardar: ${err.message}`;
  }
}

/* ---------------- InfluxDB ----------------
   La sección dice si de verdad se está usando, y no solo si hay una URL puesta:
   la pregunta que uno tiene aquí es «¿está saliendo mi histórico de aquí?», y
   antes no había forma de contestarla. El dato sale de /api/live, que es la
   misma llamada que la Home ya hace cada veinte segundos. */
async function renderInfluxState() {
  const caja = $("#ifx-estado");
  const url = ((settings() || {}).influx || {}).url || "";
  if (!url.trim()) {
    caja.innerHTML = `Ahora mismo <b>no está configurado</b>: el histórico del
      consumo sale de las estadísticas de Home Assistant, con lo que el recorder
      tenga guardado.`;
    return;
  }
  caja.textContent = "Comprobando…";
  try {
    const live = await api("live");
    const perfil = live.window && live.window.profile;
    if (!perfil) {
      caja.innerHTML = `Configurado, pero <b>no se puede comprobar</b>: falta el
        sensor de previsión solar o el de consumo de la casa, así que no se está
        calculando el perfil. Míralo en <b>Sensores</b>.`;
      return;
    }
    caja.innerHTML = perfil.source === "influxdb"
      ? `✓ <b>El histórico sale de InfluxDB</b>: ${perfil.days} días, y el consumo
         típico se calcula ${perfil.hourly ? "hora a hora" : "con una sola cifra"}.`
      : `Configurado, pero el histórico está saliendo de <b>Home Assistant</b>
         (${perfil.days} días): InfluxDB no respondió o no devolvió datos para el
         sensor de consumo de la casa. Comprueba la URL, el bucket y el token.`;
  } catch (err) {
    caja.textContent = `No se pudo comprobar: ${err.message}`;
  }
}

/* ---------------- copia de seguridad ---------------- */

$("#import-config-file").addEventListener("click", () => $("#import-config-input").click());
$("#import-config-input").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  $("#import-config-text").value = await file.text();
  ev.target.value = "";
  $("#import-config-status").textContent = `Fichero cargado (${esc(file.name)}). Pulsa «Importar».`;
});

$("#import-config-btn").addEventListener("click", async () => {
  const status = $("#import-config-status");
  const raw = $("#import-config-text").value.trim();
  if (!raw) { status.textContent = "Pega el JSON o elige un fichero."; return; }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    status.textContent = `No es un JSON válido: ${err.message}`;
    return;
  }
  const listo = guardando($("#import-config-btn"), "Importando…");
  try {
    const r = await api("config/import", { method: "POST", body: JSON.stringify(payload) });
    await reloadConfig();
    fillSettings();
    emit("datos");
    const t = r.imported.tariffs;
    status.textContent = `✓ Importado: ${r.imported.settings} ajustes` +
      (t ? ` y ${t} ${t === 1 ? "tarifa" : "tarifas"}` : " (ninguna tarifa en el fichero)") +
      ". Revisa el token en Fuente de datos.";
    $("#import-config-text").value = "";
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  } finally {
    listo();
  }
});

/* ---------------- diagnóstico ---------------- */

/* Por qué la facturación trae —o no— datos.

   Se pide a mano y no al abrir la pantalla porque son varias consultas a
   InfluxDB —el inventario de la base— y no hay que hacerlas si nadie pregunta.
   Lo primero que se enseña es el veredicto: la conclusión en una frase. Debajo,
   los eslabones, para poder comprobarla en vez de creérsela. */
async function diagnosticoFacturacion() {
  const caja = $("#diag-fact");
  const btn = $("#diag-fact-btn");
  const listo = guardando(btn);
  try {
    const d = await api("diagnostics/billing");
    const ha = d.home_assistant || {};
    const ifx = d.influxdb || {};
    const res = d.resultado || {};
    const bien = res.horas > 0;
    const lista = (xs) => (xs || []).length
      ? (xs || []).map((x) => `<code>${esc(x)}</code>`).join(" ") : "—";

    const filas = [
      ["Fuente", d.source === "homeassistant" ? "Home Assistant" : "Demostración"],
      ["Periodo", `${d.periodo.start.slice(0, 10)} → ${d.periodo.end.slice(0, 10)}`
        + (d.periodo.fijado_a_mano ? " (fijado a mano)" : "")],
      ["Contador", d.sensor_import ? `<code>${esc(d.sensor_import)}</code>` : "sin asignar"],
      ["Estadísticas en HA", ha.error ? `error: ${esc(ha.error)}`
        : ha.intentado ? `${ha.horas} horas · ${fmtNum.format(ha.kwh || 0)} kWh`
        : "no aplica"],
    ];
    if (ifx.configurado) {
      filas.push(
        ["InfluxDB", `v${ifx.version} · base <code>${esc(ifx.base)}</code>`],
        ["Medida configurada", `<code>${esc(ifx.measurement_configurada)}</code>`],
        ["El contador está en", lista(ifx.medidas_del_sensor)],
        ["Medidas de la base", lista(ifx.medidas)],
        ["Respaldo", ifx.error_consulta ? `error: ${esc(ifx.error_consulta)}`
          : ifx.error ? `error: ${esc(ifx.error)}`
          : `${ifx.horas ?? 0} horas · ${fmtNum.format(ifx.kwh || 0)} kWh`],
      );
      if (!ifx.encuentra_el_sensor) {
        filas.push(["entity_id en la base", lista((ifx.entidades || []).slice(0, 12))]);
      }
    } else {
      filas.push(["InfluxDB", "sin configurar"]);
    }
    filas.push(["Resultado", res.error ? `error: ${esc(res.error)}`
      : `${res.horas} horas · ${fmtNum.format(res.kwh || 0)} kWh`]);

    caja.innerHTML = `
      <div class="banner ${bien ? "" : "error"}">${esc(d.veredicto)}</div>
      <div class="list">${filas.map(([k, v]) => `
        <div class="li"><span class="li-label">${esc(k)}</span>
          <span class="li-value">${v}</span></div>`).join("")}</div>
      <div class="li"><button id="diag-fact-btn" class="btn subtle">Volver a comprobar</button></div>`;
    $("#diag-fact-btn").addEventListener("click", diagnosticoFacturacion);
  } catch (err) {
    caja.innerHTML = `<div class="banner error">${esc(err.message)}</div>
      <div class="li"><button id="diag-fact-btn" class="btn subtle">Reintentar</button></div>`;
    $("#diag-fact-btn").addEventListener("click", diagnosticoFacturacion);
  } finally { listo(); }
}

async function loadDiagnostics() {
  const body = $("#diag-body");
  body.innerHTML = `<p class="li-note">Leyendo los sensores…</p>`;
  let d;
  try {
    d = await api("diagnostics");
  } catch (err) {
    body.innerHTML = `<p class="li-note">No se pudo calcular: ${esc(err.message)}</p>`;
    return;
  }
  const fila = (r) => `
    <div class="li diag-row">
      <span class="diag-txt">
        <b>${esc(r.label)}</b>
        <small>${r.sensor ? esc(r.sensor) : "sin sensor"} · ${esc(r.source)}</small>
      </span>
      <span class="diag-kwh ${r.kwh == null ? "muted" : ""}">${
        r.kwh == null ? "--" : `${fmtNum.format(r.kwh)} kWh`
      }</span>
    </div>`;
  const lado = (side, titulo, total) => `
    <div class="diag-side">
      <div class="diag-head"><span>${titulo}</span><b>${fmtNum.format(total)} kWh</b></div>
      ${d.rows.filter((r) => r.side === side).map(fila).join("")}
    </div>`;
  const diff = d.diferencia;
  const veredicto = d.cuadra
    ? `Cuadra: la diferencia (${fmtNum.format(Math.abs(diff))} kWh) entra dentro
       del margen normal entre contadores.`
    : `<b>No cuadra por ${fmtNum.format(Math.abs(diff))} kWh.</b> ${
        diff > 0
          ? "Entra más de lo que sale: o el consumo de la casa se queda corto, o la descarga de la batería y la importación se están contando de más."
          : "Sale más de lo que entra: o el consumo de la casa se pasa, o la generación y la importación se están contando de menos."
      }`;
  body.innerHTML = `
    ${lado("entra", "Entra", d.entra)}
    ${lado("sale", "Sale", d.sale)}
    <p class="li-note diag-verdict ${d.cuadra ? "ok" : "warn"}">${veredicto}</p>
    ${repartoTexto(d.reparto)}
    ${perfilTexto(d.profile)}`;
}

/* A dónde fue lo que entró por la red y lo que salió de la batería.

   No lo mide ningún sensor: no hay contador «red→batería». Se deduce hora a
   hora, y es la parte del resumen que más veces ha estado mal, así que aquí se
   enseña **al lado del contador del que sale**: si las dos columnas de un mismo
   origen no suman su contador, el fallo está en el reparto y no en los
   sensores, y se ve sin tener que deducirlo de la tarjeta de la Home. */
function repartoTexto(r) {
  if (!r) return "";
  const fila = (etiqueta, kwh, clase = "") => `
    <div class="li diag-row">
      <span class="diag-txt ${clase}"><b>${etiqueta}</b></span>
      <span class="diag-kwh ${clase}">${fmtNum.format(kwh)} kWh</span>
    </div>`;
  // Lo que ningún sensor coloca se enseña en su propia fila, con el mismo
  // umbral que las notas de la Home. Un descuadre de 20 Wh es la deriva normal
  // entre contadores y avisar de eso sería ruido.
  const par = (titulo, p, etiquetaOtro) => `
    <div class="diag-side">
      <div class="diag-head"><span>${titulo}</span>
        <b>${fmtNum.format(p.meter)} kWh</b></div>
      ${fila("A la casa", p.home)}
      ${fila(etiquetaOtro, p.other)}
      ${p.unplaced >= 0.05 ? fila("Sin colocar", p.unplaced, "warn") : ""}`
    + (p.unplaced >= 0.05
      ? `<p class="li-note">Esa parte salió del contador y ningún otro sensor la
         recoge: el consumo de la casa dice que no le llegó y tampoco se
         exportó. Es un descuadre entre sensores, no del reparto.</p>`
      : "")
    + `</div>`;
  return `
    <p class="li-note">Y a dónde fue cada cosa. Esto <b>no lo mide ningún
      sensor</b> —no existe un contador «red→batería»—: se deduce hora a hora a
      partir de los seis contadores de arriba.</p>
    ${par("Importada de la red", r.grid, "A cargar la batería")}
    ${par("Descarga de la batería", r.battery, "Vertida a la red")}`;
}

/* De dónde sale el consumo típico con el que se calcula la ventana de energía
   gratis. Se dice aquí porque «¿está usando mi InfluxDB?» es una pregunta de
   diagnóstico, y porque sin esto no había forma de saberlo. */
function perfilTexto(p) {
  if (!p) {
    return `<p class="li-note">Sin <b>consumo típico</b>: falta el sensor de
      consumo de la casa o no hay histórico suficiente, así que no se puede
      calcular la ventana de energía gratis.</p>`;
  }
  const fuente = p.source === "influxdb"
    ? `<b>InfluxDB</b>, ${p.days} días`
    : `las estadísticas de Home Assistant, ${p.days} días`;
  const forma = p.hourly
    ? `hora a hora, de ${fmtNum.format(p.min_w)} a ${fmtNum.format(p.max_w)} W`
    : `una sola cifra para todo el día, ${fmtNum.format(p.flat_w)} W (aún no hay
       histórico para separar las horas)`;
  return `<p class="li-note">El <b>consumo típico</b> de la ventana sale de
    ${fuente}: ${forma}.</p>`;
}

/* ---------------- controles ---------------- */

/* La fuente se guarda sola: es un botón, no un campo de un formulario con barra
   de guardar, y cambiarla afecta a todas las pantallas a la vez. */
$$("#source-seg .seg").forEach((button) =>
  button.addEventListener("click", async () => {
    const source = button.dataset.sourceOpt;
    const s = settings();
    if (s) s.source = source;
    updateSourceVisibility();
    try {
      await api("settings", { method: "PUT", body: JSON.stringify({ source }) });
      await reloadConfig();
      renderSettingsIndex(settings());
      emit("datos");
    } catch (err) {
      $("#source-note").textContent = `No se ha podido guardar: ${err.message}`;
    }
  }));
$("#s-ifx-version").addEventListener("change", updateSourceVisibility);
$("#diag-fact-btn").addEventListener("click", diagnosticoFacturacion);

/* La URL y el token de Home Assistant, en la misma página sin barra de guardar.
   Solo se ven fuera del Supervisor, que es donde hacen falta. */
$$("#s-ha-url, #s-ha-token").forEach((campo) =>
  campo.addEventListener("change", async () => {
    $("#source-note").textContent = "Guardando…";
    try {
      await api("settings", { method: "PUT", body: JSON.stringify({
        ha_url: $("#s-ha-url").value.trim(), ha_token: $("#s-ha-token").value }) });
      await reloadConfig();
      updateSourceVisibility();
      emit("datos");
    } catch (err) {
      $("#source-note").textContent = `No se ha podido guardar: ${err.message}`;
    }
  }));

/* La galería se repinta entera al elegir, así que el oyente va en la rejilla y
   no en cada tile: puesto en el tile, el segundo clic caía en un botón que ya
   no era el mismo elemento. */
$("#flow-gallery").addEventListener("click", (ev) => {
  const tile = ev.target.closest("[data-flow-style]");
  if (tile) elegirFlujo(tile.dataset.flowStyle);
});

/* Y lo mismo con la lista de tarjetas, que también se repinta entera. */
$("#home-cards-list").addEventListener("click", (ev) => {
  const boton = ev.target.closest("[data-mover]");
  if (!boton) return;
  const fila = boton.closest("[data-card-row]");
  moverTarjeta(fila.dataset.cardRow, Number(boton.dataset.mover));
});
$("#home-cards-list").addEventListener("change", (ev) => {
  const sw = ev.target.closest("[data-card-ver]");
  if (!sw) return;
  verTarjeta(sw.closest("[data-card-row]").dataset.cardRow, sw.checked);
});

$("#users-list").addEventListener("change", (ev) => {
  const sw = ev.target.closest("[data-user-admin]");
  if (!sw) return;
  cambiarRol(sw.closest("[data-user]").dataset.user, sw.checked);
});

/* La capacidad de la batería está en la misma página sin barra de guardar, así
   que se guarda al salir del campo, como el desplegable de abajo. */
$("#s-battery-kwh").addEventListener("change", async (ev) => {
  const nota = $("#bat-kwh-state");
  const kwh = Number(ev.target.value) || 0;
  nota.textContent = "Guardando…";
  try {
    await api("settings", { method: "PUT", body: JSON.stringify({ battery_kwh: kwh }) });
    await reloadConfig();
    nota.textContent = kwh > 0
      ? `Guardado · con ${fmtNum.format(kwh)} kWh ya se puede decir cuánta batería se lleva cada ciclo.`
      : "Sin capacidad: la estimación no podrá separar la batería de la red.";
    emit("datos");
  } catch (err) {
    nota.textContent = `No se ha podido guardar: ${err.message}`;
  }
});

/* La reserva, en la misma página y con el mismo trato. Comparte el renglón de
   estado con la capacidad: las dos hablan de lo mismo —cuánta batería se puede
   contar— y dos avisos separados en dos líneas seguidas serían ruido. */
$("#s-battery-reserve").addEventListener("change", async (ev) => {
  const nota = $("#bat-kwh-state");
  const pct = Math.max(0, Math.min(Number(ev.target.value) || 0, 95));
  ev.target.value = pct || "";
  nota.textContent = "Guardando…";
  try {
    await api("settings", {
      method: "PUT", body: JSON.stringify({ battery_reserve_pct: pct }),
    });
    await reloadConfig();
    nota.textContent = pct > 0
      ? `Guardado · por debajo del ${fmtNum.format(pct)} % no se cuenta como disponible.`
      : "Sin reserva declarada: se cuenta la batería entera como utilizable.";
    emit("datos");
  } catch (err) {
    nota.textContent = `No se ha podido guardar: ${err.message}`;
  }
});

/* «Qué miden los contadores» vive en la página de Sensores, que no tiene barra
   de guardar porque todo lo suyo se guarda al tocarlo. Este desplegable, en
   cambio, solo se leía al pulsar «Guardar ajustes»: se elegía la opción, no
   pasaba nada y al volver a entrar seguía la de antes. Ahora se guarda él, como
   las asignaciones de arriba, y los totales se recalculan en el sitio. */
$("#s-energy-counters").addEventListener("change", async (ev) => {
  const listo = guardando(ev.target);
  const nota = $("#counters-state");
  nota.textContent = "Guardando…";
  try {
    await api("settings", { method: "PUT",
      body: JSON.stringify({ energy_counters: ev.target.value }) });
    await reloadConfig();
    await loadSensors();
    nota.textContent = "Guardado.";
    emit("datos");   // los totales del día cambian de cálculo
  } catch (err) {
    nota.textContent = `No se ha podido guardar: ${err.message}`;
  } finally { listo(); }
});
$("#save-settings-btn").addEventListener("click", () => saveSettings(false));
$("#close-pick-modal").addEventListener("click", () => $("#pick-modal").classList.add("hidden"));

/* ---------------- lo que Ajustes escucha ---------------- */

on("vista", ({ name }) => {
  if (name !== "settings") return;
  fillSettings();
  showSettingsPage(null);
  // El recuento de sensores del índice necesita el estado, y el índice tiene
  // que informar sin que haya que entrar en la sección.
  refreshSensorCount();
});
on("pagina-ajustes", ({ page }) => {
  if (page === "diagnostics") loadDiagnostics();
  if (page === "influx") renderInfluxState();
  if (page === "flows") { pintarGaleria(); $("#gal-estado").textContent = ""; }
  if (page === "home") { pintarTarjetas(); $("#home-estado").textContent = ""; }
  if (page === "users") cargarUsuarios();
  // Los sensores se asignan tocando su fila, no rellenando un formulario: la
  // barra de guardar no aplica y cada cambio se guarda solo.
  if (page === "sensors") loadSensors();
});

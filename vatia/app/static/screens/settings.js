/*
 * Ajustes: el índice, la fuente de datos, los catorce sensores del balance, la
 * copia de seguridad y el diagnóstico.
 */
import { $, $$, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on, emit } from "../core/bus.js";
import { fmtNum } from "../core/format.js";
import { config, settings, tariffs, reloadConfig } from "../core/config.js";
import { showSettingsPage } from "../core/nav.js";
import { guardando } from "../core/guardando.js";
import { asegurar, porTipo, opciones, cargadas } from "../core/entidades.js";

const sensorState = { data: null, picking: null };

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
    sub = r.responds ? `${corto} · ${fmtNum.format(r.value ?? 0)} ${r.unit}`
                     : `${corto} · no disponible`;
  }
  return `
    <div class="${clases.join(" ")}" data-slot="${esc(r.slot)}" role="button" tabindex="0">
      <span class="srow-dot"></span>
      <span class="srow-txt"><b>${esc(r.label)}</b><small>${esc(sub)}</small></span>
      ${r.entity ? `<svg class="i nav-chev"><use href="#i-chevron"/></svg>`
                 : `<button type="button" class="srow-assign">Asignar</button>`}
    </div>`;
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

  $("#pick-body").innerHTML = `
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
  const SOURCES = { demo: "Demostración", homeassistant: "Home Assistant", influxdb: "InfluxDB" };
  $("#nav-sub-source").textContent = SOURCES[s.source] || "Sin configurar";
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
    : `v${ifx.version ?? 2} · ${s.source === "influxdb"
        ? "facturación e histórico" : "histórico del consumo"}`;
  $("#nav-sub-publish").textContent = s.export_sensors === false
    ? "Desactivado"
    : `Cada ${s.sensor_update_minutes ?? 5} min`;
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
  $("#s-source").value = s.source || "demo";
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
  renderSettingsIndex(s);
  const ifx = s.influx || {};
  $("#s-ifx-version").value = String(ifx.version ?? 2);
  $("#s-ifx-url").value = ifx.url || "";
  $("#s-ifx-db").value = ifx.database || "";
  $("#s-ifx-measurement").value = ifx.measurement || "kWh";
  $("#s-ifx-entity").value = ifx.entity_id || "";
  $("#s-ifx-entity-export").value = ifx.entity_id_export || "";
  $("#s-ifx-org").value = ifx.org || "";
  $("#s-ifx-token").value = ifx.token || "";
  $("#s-ifx-user").value = ifx.username || "";
  $("#s-ifx-pass").value = ifx.password || "";
  $("#s-ha-entity").innerHTML = s.ha_entity
    ? `<option value="${esc(s.ha_entity)}">${esc(s.ha_entity)}</option>`
    : `<option value="">— pulsa «Buscar sensores» —</option>`;
  $("#s-ha-entity-export").innerHTML = `<option value="">— ninguno —</option>` +
    (s.ha_entity_export ? `<option value="${esc(s.ha_entity_export)}" selected>${esc(s.ha_entity_export)}</option>` : "");
  // El material traslúcido no es un ajuste nuestro: la guía dice que sigue al
  // del sistema, así que aquí solo se informa de cómo está.
  const reduce = window.matchMedia &&
    window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
  $("#material-state").textContent = reduce ? "Reducido" : "Activo";
  fillEntitySelects();
  updateSourceVisibility();
  ensureGroupedEntities();
}

function updateSourceVisibility() {
  const source = $("#s-source").value;
  $("#ha-fields").classList.toggle("hidden", source !== "homeassistant");
  // Los campos de InfluxDB ya no se esconden según la fuente: viven en su propia
  // sección porque también dan el histórico del consumo. Escondiéndolos, quien
  // tenía Home Assistant como fuente no podía configurarlos y el perfil horario
  // de la ventana se quedaba sin el histórico largo, sin manera de saber por qué.
  $("#ifx-hint").classList.toggle("hidden", source !== "influxdb");
  $("#ha-external").classList.toggle("hidden", !!config()?.supervisor);
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
}

async function loadEntities() {
  const btn = $("#load-entities-btn");
  btn.disabled = true; btn.textContent = "Buscando…";
  try {
    await saveSettings(true);
    const entities = await api("entities");
    const s = settings();
    const cur = s?.ha_entity || "";
    const curExp = s?.ha_entity_export || "";
    const opts = (sel) => entities.map((e) =>
      `<option value="${esc(e.entity_id)}" ${e.entity_id === sel ? "selected" : ""}>${esc(e.name)}</option>`).join("");
    $("#s-ha-entity").innerHTML = opts(cur) || `<option value="">Sin sensores de energía</option>`;
    $("#s-ha-entity-export").innerHTML = `<option value="">— ninguno —</option>` + opts(curExp);
  } catch (err) { alert(err.message); } finally {
    btn.disabled = false; btn.textContent = "Buscar sensores";
  }
}

function settingsFromForm() {
  const flow = {}; const energy = {};
  $$("[data-flow]").forEach((el) => { flow[el.dataset.flow] = el.value; });
  $$("[data-energy]").forEach((el) => { energy[el.dataset.energy] = el.value; });
  return {
    source: $("#s-source").value,
    ha_entity: $("#s-ha-entity").value,
    ha_entity_export: $("#s-ha-entity-export").value,
    ha_url: $("#s-ha-url").value.trim(),
    ha_token: $("#s-ha-token").value,
    contracted_power: { p1: parseFloat($("#s-p1").value) || 0, p2: parseFloat($("#s-p2").value) || 0 },
    billing_day: parseInt($("#s-billing-day").value, 10) || 1,
    timezone: $("#s-timezone").value.trim() || "Europe/Madrid",
    holidays: $("#s-holidays").value.split(",").map((x) => x.trim()).filter(Boolean),
    export_sensors: $("#s-export-sensors").checked,
    sensor_update_minutes: parseInt($("#s-sensor-minutes").value, 10) || 5,
    flow_sensors: flow,
    energy_sensors: energy,
    energy_counters: $("#s-energy-counters").value,
    condition_sensor: $("#s-condition").value,
    temperature_sensor: $("#s-temp").value,
    solar_forecast_sensor: $("#s-forecast").value,
    influx: {
      version: parseInt($("#s-ifx-version").value, 10) || 2,
      url: $("#s-ifx-url").value.trim(),
      database: $("#s-ifx-db").value.trim(),
      measurement: $("#s-ifx-measurement").value.trim() || "kWh",
      entity_id: $("#s-ifx-entity").value.trim(),
      entity_id_export: $("#s-ifx-entity-export").value.trim(),
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
    ${perfilTexto(d.profile)}`;
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

$("#s-source").addEventListener("change", updateSourceVisibility);
$("#s-ifx-version").addEventListener("change", updateSourceVisibility);

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
$("#load-entities-btn").addEventListener("click", loadEntities);
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
  // Los sensores se asignan tocando su fila, no rellenando un formulario: la
  // barra de guardar no aplica y cada cambio se guarda solo.
  if (page === "sensors") loadSensors();
});

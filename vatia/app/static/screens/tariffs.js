/*
 * Tarifas: la lista (que sale en Facturación y en Ajustes), el editor en cinco
 * pasos con su rejilla de horarios, y la importación desde CSV.
 */
import { $, $$, esc, abrirHoja, cerrarHoja } from "../core/dom.js";
import { api } from "../core/api.js";
import { on, emit } from "../core/bus.js";
import { fmtNum, nf4, num6 } from "../core/format.js";
import { config, settings, tariffs, reloadConfig } from "../core/config.js";
import { guardando } from "../core/guardando.js";

let editingTariffId = null;

/* Horarios del editor. Con el preajuste 2.0TD venían fijos en el código, así
   que la rejilla no habría podido cambiarlos: ahora se guardan aquí en cuanto
   se toca el horario, y `tariffFromForm` los usa si existen. */
const TD3_SCHEDULES = ["L-V 10-14,18-22", "L-V 8-10,14-18,22-24", ""];
const editorState = { schedules: null, dirty: false };

function describeTariff(t) {
  const e = t.energy || {};
  if (e.type === "pvpc") {
    const m = Number(e.pvpc_margin || 0);
    return `PVPC${m ? ` +${num6(m)}` : ""}`;
  }
  const n = (e.periods || []).length;
  return n === 1 ? "Precio único" : `${n} tramos`;
}

/* Se pinta en Facturación → Tarifas y también en Ajustes → Tarifas. */
function renderTariffsList() {
  const targets = [$("#tariffs-list"), $("#tariffs-list-settings")].filter(Boolean);
  const lista = tariffs();
  if (!lista.length) {
    targets.forEach((el) => { el.innerHTML = `<p class="empty">No hay tarifas. Crea la primera o importa un CSV.</p>`; });
    return;
  }
  const html = lista.map((t) => {
    const e = t.energy || {};
    const chips = e.type === "pvpc"
      ? `<div class="price"><div class="pl">Energía</div><div class="pv">PVPC</div></div>`
      : (e.periods || []).map((p) =>
          `<div class="price"><div class="pl">${esc(p.name)}</div><div class="pv">${num6(p.price)}</div></div>`).join("");
    const surplus = t.surplus && t.surplus.type !== "none"
      ? `<span>☀ ${t.surplus.type === "flat" ? `${num6(t.surplus.price)} €/kWh` : "por tramos"}${t.surplus.virtual_wallet ? " · monedero" : ""}</span>` : "";
    return `
    <div class="bill glass">
      <span class="stripe" style="background:${esc(t.color || "#0a84ff")}"></span>
      <div class="bill-head">
        <div><div class="bill-co">${esc(t.company || "")}</div><div class="bill-name">${esc(t.name)}</div></div>
        <div class="badges">${t.id === (settings()?.my_tariff_id || "")
          ? `<span class="badge mine">La mía</span>` : ""}<span class="badge">${esc(describeTariff(t))}</span></div>
      </div>
      <div class="prices">${chips}</div>
      <div class="chips">
        <span>P1 ${num6(t.power_prices?.p1)}</span><span>P2 ${num6(t.power_prices?.p2)}</span>
        <span>IVA ${t.vat_energy_pct ?? 21}%</span>${surplus}
      </div>
      <div class="bill-actions">
        <button class="btn subtle" data-edit="${esc(t.id)}">Editar</button>
        <button class="btn subtle" data-clone="${esc(t.id)}">Duplicar</button>
        <a class="btn subtle" href="api/tariffs/${esc(t.id)}/export.csv" download>CSV</a>
        <button class="btn subtle danger" data-del="${esc(t.id)}">Eliminar</button>
      </div>
    </div>`;
  }).join("");
  targets.forEach((el) => {
    el.innerHTML = html;
    el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openTariffModal(b.dataset.edit)));
    el.querySelectorAll("[data-clone]").forEach((b) => b.addEventListener("click", () => cloneTariff(b.dataset.clone)));
    el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteTariff(b.dataset.del)));
  });
}

/* ------------- el editor ------------- */

function periodRow(container, period = {}) {
  const row = document.createElement("div");
  row.className = "period-row";
  row.innerHTML = `
    <input class="pr-name" placeholder="Nombre" value="${esc(period.name || "")}">
    <input class="pr-price" type="number" step="0.000001" min="0" placeholder="€/kWh" value="${period.price ?? ""}">
    <input class="pr-schedule" placeholder="L-V 10-14,18-22 (vacío = resto)" value="${esc(period.schedule || "")}">
    <button class="icon-btn pr-del" title="Quitar">✕</button>`;
  row.querySelector(".pr-del").addEventListener("click", () => row.remove());
  container.appendChild(row);
}

function readPeriodRows(container) {
  return Array.from(container.querySelectorAll(".period-row")).map((row, i) => ({
    name: row.querySelector(".pr-name").value.trim() || `P${i + 1}`,
    price: parseFloat(row.querySelector(".pr-price").value) || 0,
    schedule: row.querySelector(".pr-schedule").value.trim(),
  }));
}

function updateEditorVisibility() {
  const etype = $("#t-etype").value;
  $("#t-etype-td3").classList.toggle("hidden", etype !== "td3");
  $("#t-etype-custom").classList.toggle("hidden", etype !== "custom");
  $("#t-etype-pvpc").classList.toggle("hidden", etype !== "pvpc");
  const stype = $("#t-surplus-type").value;
  $("#t-surplus-flat").classList.toggle("hidden", stype !== "flat");
  $("#t-surplus-custom").classList.toggle("hidden", stype !== "schedule");
  $("#t-wallet-wrap").classList.toggle("hidden", stype === "none");
}

function openTariffModal(tariffId = null) {
  editingTariffId = tariffId;
  const t = tariffId ? tariffs().find((x) => x.id === tariffId) : null;
  $("#tariff-modal-title").textContent = t ? `Editar · ${t.name}` : "Nueva tarifa";
  $("#tariff-error").textContent = "";
  $("#t-name").value = t?.name || "";
  $("#t-company").value = t?.company || "";
  $("#t-color").value = t?.color || "#0a84ff";
  const energy = t?.energy || { type: "schedule", preset: "td3", periods: [], pvpc_margin: 0 };
  $("#t-etype").value = energy.type === "pvpc" ? "pvpc" : (energy.preset === "td3" || !t ? "td3" : "custom");
  const byName = {};
  (energy.periods || []).forEach((p) => { byName[p.name.toLowerCase()] = p.price; });
  $("#t-td3-punta").value = byName.punta ?? "";
  $("#t-td3-llano").value = byName.llano ?? "";
  $("#t-td3-valle").value = byName.valle ?? "";
  const box = $("#t-periods"); box.innerHTML = "";
  (energy.type === "schedule" && energy.periods?.length ? energy.periods : [{}]).forEach((p) => periodRow(box, p));
  $("#t-pvpc-margin").value = energy.pvpc_margin ?? 0;
  const surplus = t?.surplus || { type: "none", price: 0, periods: [] };
  $("#t-surplus-type").value = surplus.type || "none";
  $("#t-surplus-price").value = surplus.price ?? "";
  $("#t-virtual-wallet").checked = !!surplus.virtual_wallet;
  const sbox = $("#t-surplus-periods"); sbox.innerHTML = "";
  (surplus.periods?.length ? surplus.periods : [{}]).forEach((p) => periodRow(sbox, p));
  $("#t-power-p1").value = t?.power_prices?.p1 ?? "";
  $("#t-power-p2").value = t?.power_prices?.p2 ?? "";
  $("#t-bono").value = t?.fixed_daily?.[0]?.price ?? 0.019121;
  $("#t-meter").value = t?.meter_rental_daily ?? 0.02663;
  $("#t-services").value = t?.services_monthly?.[0]?.price ?? "";
  $("#t-services-name").value = t?.services_monthly?.[0]?.name ?? "";
  $("#t-elec-tax").value = t?.electricity_tax_pct ?? 0.5;
  $("#t-vat-energy").value = t?.vat_energy_pct ?? 10;
  $("#t-vat-services").value = t?.vat_services_pct ?? 21;
  // El horario arranca del que ya tenga la tarifa; `null` significa «el del
  // preajuste», que es lo que quiere una tarifa nueva.
  editorState.schedules = (energy.periods || []).length
    ? energy.periods.map((x) => x.schedule || "") : null;
  editorState.dirty = false;
  updateEditorVisibility();
  openFirstIncompleteStep();
  abrirHoja($("#tariff-modal"));
}

/* Se abre siempre el primer paso incompleto: en una tarifa nueva es el 1, y al
   editar una que ya funciona no se abre ninguno y la hoja se lee de un vistazo. */
function openFirstIncompleteStep() {
  const res = refreshStepSummaries();
  const orden = ["id", "energy", "surplus", "power", "taxes"];
  const primero = orden.find((k) => res[k] && !res[k].ok);
  orden.forEach((k) => {
    const step = $(`#step-${k}`);
    if (step) step.open = k === primero;
  });
}

/* Los periodos tal y como están ahora en el formulario, que es lo que la rejilla
   necesita para pintarse. */
function editorPeriods() {
  const etype = $("#t-etype").value;
  if (etype === "pvpc") return [];
  if (etype === "td3") {
    const h = editorState.schedules || TD3_SCHEDULES;
    return ["Punta", "Llano", "Valle"].map((name, i) => ({ name, schedule: h[i] ?? "" }));
  }
  const filas = readPeriodRows($("#t-periods"));
  return filas.map((p, i) => ({
    ...p,
    schedule: editorState.schedules ? (editorState.schedules[i] ?? "") : p.schedule,
  }));
}

/* El resumen de cada paso cerrado. Es lo que convierte la hoja en una lista de
   comprobación: se ve qué falta sin abrir nada, y el paso incompleto lo dice en
   su propia línea en vez de esperar al error de guardar. */
function stepSummaries() {
  const val = (sel) => $(sel).value.trim();
  const num = (sel) => { const v = parseFloat($(sel).value); return Number.isFinite(v) ? v : null; };
  const eur = (v) => nf4.format(v) + " €/kWh";
  const etype = $("#t-etype").value;
  const out = {};

  // 1 · Identidad
  const nombre = val("#t-name");
  out.id = nombre
    ? { txt: [val("#t-company") || "sin compañía",
              $("#t-virtual-wallet").checked ? "monedero activo" : null]
             .filter(Boolean).join(" · "), ok: true }
    : { txt: "Falta el nombre", ok: false };

  // 2 · Energía
  if (etype === "pvpc") {
    const m = num("#t-pvpc-margin") || 0;
    out.energy = { txt: `PVPC${m ? ` · margen ${eur(m)}` : " sin margen"}`, ok: true };
  } else if (etype === "td3") {
    const faltan = ["Punta", "Llano", "Valle"]
      .filter((k) => !(num(`#t-td3-${k.toLowerCase()}`) > 0));
    out.energy = faltan.length
      ? { txt: `Falta el precio de ${faltan.join(", ")}`, ok: false }
      : { txt: `Punta ${eur(num("#t-td3-punta"))} · 3 tramos`, ok: true };
  } else {
    const filas = readPeriodRows($("#t-periods")).filter((r) => r.name);
    const sinPrecio = filas.filter((r) => !(r.price > 0));
    out.energy = !filas.length ? { txt: "Sin tramos", ok: false }
      : sinPrecio.length ? { txt: `Falta el precio de ${sinPrecio.map((r) => r.name).join(", ")}`, ok: false }
      : { txt: `${filas.length} tramo${filas.length === 1 ? "" : "s"}`, ok: true };
  }

  // 3 · Excedentes
  const stype = $("#t-surplus-type").value;
  out.surplus = stype === "none" ? { txt: "Sin compensación", ok: true }
    : stype === "flat"
      ? (num("#t-surplus-price") > 0
        ? { txt: `Compensación simplificada · ${eur(num("#t-surplus-price"))}`, ok: true }
        : { txt: "Falta el precio del excedente", ok: false })
      : { txt: "Por tramos", ok: true };

  // 4 · Potencia
  const p1 = num("#t-power-p1"), p2 = num("#t-power-p2");
  const faltaP = [p1 > 0 ? null : "P1", p2 > 0 ? null : "P2"].filter(Boolean);
  out.power = faltaP.length
    ? { txt: `Falta el precio de ${faltaP.join(" y ")}`, ok: false }
    : { txt: `P1 ${nf4.format(p1)} · P2 ${nf4.format(p2)} €/kW·día`, ok: true };

  // 5 · Impuestos y cargos
  const serv = num("#t-services");
  out.taxes = {
    txt: [`IE ${fmtNum.format(num("#t-elec-tax") ?? 0)} %`,
          `IVA ${fmtNum.format(num("#t-vat-energy") ?? 0)} %`,
          num("#t-meter") ? `contador ${fmtNum.format(num("#t-meter") * 30)} €/mes` : null,
          serv ? `servicios ${fmtNum.format(serv)} €/mes` : null]
      .filter(Boolean).join(" · "),
    ok: true,
  };
  return out;
}

function refreshStepSummaries() {
  const res = stepSummaries();
  for (const [key, r] of Object.entries(res)) {
    const el = $(`#sum-${key}`);
    const step = $(`#step-${key}`);
    if (el) el.textContent = r.txt;
    if (step) {
      step.classList.toggle("bad", !r.ok);
      step.classList.toggle("done", r.ok);
    }
  }
  // El resumen del horario, en el paso 2.
  const periodos = editorPeriods();
  const linea = periodos.filter((p) => (p.schedule || "").trim())
    .map((p) => `${p.name} ${p.schedule.replace(/\s*\|\s*/g, " y ")}`).join(" · ");
  const resto = periodos.find((p) => !(p.schedule || "").trim());
  $("#t-grid-sum").textContent = periodos.length
    ? (linea || "Un solo tramo, todas las horas") +
      (resto && linea ? ` · resto ${resto.name}` : "")
    : "Los precios los marca el mercado hora a hora.";
  return res;
}

function openGridSheet() {
  const periods = editorPeriods();
  if (!periods.length) return;
  $("#grid-editor").periods = periods;
  abrirHoja($("#grid-modal"));
}

/* «Hecho» se queda con los horarios que haya pintado la rejilla. */
function closeGridSheet(guardar) {
  if (guardar) {
    editorState.schedules = $("#grid-editor").periods.map((p) => p.schedule);
    refreshStepSummaries();
  }
  cerrarHoja($("#grid-modal"));
}

function tariffFromForm() {
  const num = (sel, def = 0) => { const v = parseFloat($(sel).value); return Number.isFinite(v) ? v : def; };
  const etype = $("#t-etype").value;
  let energy;
  if (etype === "pvpc") energy = { type: "pvpc", preset: null, periods: [], pvpc_margin: num("#t-pvpc-margin") };
  else if (etype === "td3") energy = {
    type: "schedule", preset: "td3", pvpc_margin: 0,
    periods: ["punta", "llano", "valle"].map((k, i) => ({
      name: k[0].toUpperCase() + k.slice(1),
      price: num(`#t-td3-${k}`),
      schedule: (editorState.schedules || TD3_SCHEDULES)[i] ?? "",
    })),
  };
  else energy = { type: "schedule", preset: null, pvpc_margin: 0,
    periods: readPeriodRows($("#t-periods")).map((p, i) => ({
      ...p,
      schedule: editorState.schedules ? (editorState.schedules[i] ?? p.schedule) : p.schedule,
    })) };
  const stype = $("#t-surplus-type").value;
  const services = num("#t-services", 0);
  return {
    name: $("#t-name").value.trim() || "Tarifa sin nombre",
    company: $("#t-company").value.trim(),
    color: $("#t-color").value,
    energy,
    surplus: {
      type: stype, price: num("#t-surplus-price"),
      periods: stype === "schedule" ? readPeriodRows($("#t-surplus-periods")) : [],
      virtual_wallet: stype !== "none" && $("#t-virtual-wallet").checked,
    },
    power_prices: { p1: num("#t-power-p1"), p2: num("#t-power-p2") },
    fixed_daily: num("#t-bono") > 0 ? [{ name: "Financiación bono social", price: num("#t-bono") }] : [],
    meter_rental_daily: num("#t-meter"),
    services_monthly: services > 0
      ? [{ name: $("#t-services-name").value.trim() || "Servicios", price: services }] : [],
    electricity_tax_pct: num("#t-elec-tax", 0.5),
    vat_energy_pct: num("#t-vat-energy", 10),
    vat_services_pct: num("#t-vat-services", 21),
  };
}

/* Guardar, duplicar y borrar acaban igual: se recarga la configuración —que
   repinta la lista— y se avisa de que los datos han cambiado, para que la
   comparativa se rehaga. Ninguna de las tres sabe que Facturación existe. */
async function tarifaCambiada() {
  await reloadConfig();
  emit("datos");
}

async function saveTariff() {
  const tariff = tariffFromForm();
  $("#tariff-error").textContent = "";
  const listo = guardando($("#save-tariff-btn"));
  try {
    if (editingTariffId) await api(`tariffs/${editingTariffId}`, { method: "PUT", body: JSON.stringify(tariff) });
    else await api("tariffs", { method: "POST", body: JSON.stringify(tariff) });
    cerrarHoja($("#tariff-modal"));
    await tarifaCambiada();
  } catch (err) { $("#tariff-error").textContent = err.message; } finally { listo(); }
}

async function cloneTariff(id) {
  const t = tariffs().find((x) => x.id === id);
  if (!t) return;
  const copy = JSON.parse(JSON.stringify(t));
  delete copy.id;
  copy.name = `${copy.name} (copia)`;
  await api("tariffs", { method: "POST", body: JSON.stringify(copy) });
  await tarifaCambiada();
}

async function deleteTariff(id) {
  const t = tariffs().find((x) => x.id === id);
  if (!t || !confirm(`¿Eliminar la tarifa «${t.name}»?`)) return;
  await api(`tariffs/${id}`, { method: "DELETE" });
  await tarifaCambiada();
}

/* ------------- importar CSV ------------- */

function openImportModal() {
  $("#import-textarea").value = "";
  $("#import-error").textContent = "";
  abrirHoja($("#import-modal"));
  setTimeout(() => $("#import-textarea").focus(), 60);
}

async function doImport() {
  const text = $("#import-textarea").value.trim();
  const err = $("#import-error");
  err.textContent = "";
  if (!text) { err.textContent = "Pega el CSV o carga un archivo."; return; }
  const btn = $("#do-import-btn");
  btn.disabled = true;
  const listo = guardando(btn, "Importando…");
  try {
    // No pasa por `api()`: el cuerpo es CSV, no JSON.
    const resp = await fetch("api/tariffs/import", {
      method: "POST", headers: { "Content-Type": "text/csv" }, body: text,
    });
    if (!resp.ok) {
      let detail = `Error ${resp.status}`;
      try { detail = (await resp.json()).detail || detail; } catch (_) { /* noop */ }
      throw new Error(detail);
    }
    const tariff = await resp.json();
    cerrarHoja($("#import-modal"));
    $("#import-status").textContent = `✓ Tarifa «${tariff.name}» importada.`;
    await tarifaCambiada();
  } catch (e) { err.textContent = `✗ ${e.message}`; } finally { listo(); btn.disabled = false; }
}

/* ------------- controles ------------- */

$("#add-tariff-btn").addEventListener("click", () => openTariffModal(null));
$("#add-tariff-btn-2").addEventListener("click", () => openTariffModal(null));
$("#save-tariff-btn").addEventListener("click", saveTariff);
// Un solo paso abierto: al abrir uno se cierran los demás (§05).
$$("#tariff-modal .step").forEach((step) =>
  step.addEventListener("toggle", () => {
    if (!step.open) return;
    $$("#tariff-modal .step").forEach((otro) => { if (otro !== step) otro.open = false; });
  }));
// Los resúmenes se refrescan mientras se escribe, no al guardar.
$("#tariff-modal").addEventListener("input", () => {
  editorState.dirty = true;
  refreshStepSummaries();
});
$("#tariff-modal").addEventListener("change", () => {
  editorState.dirty = true;
  refreshStepSummaries();
});
$("#t-open-grid").addEventListener("click", openGridSheet);
$("#grid-back").addEventListener("click", () => closeGridSheet(false));
$("#grid-done").addEventListener("click", () => closeGridSheet(true));
$("#grid-editor").addEventListener("change", () => { editorState.dirty = true; });
$("#cancel-tariff-btn").addEventListener("click", () => {
  // Cancelar pregunta solo si hay algo que perder.
  if (editorState.dirty &&
      !confirm("Se descartarán los cambios de esta tarifa. ¿Salir?")) return;
  cerrarHoja($("#tariff-modal"));
});
$("#t-etype").addEventListener("change", updateEditorVisibility);
$("#t-surplus-type").addEventListener("change", updateEditorVisibility);
$("#t-add-period").addEventListener("click", () => periodRow($("#t-periods")));
$("#t-add-surplus-period").addEventListener("click", () => periodRow($("#t-surplus-periods")));

$("#import-csv-btn").addEventListener("click", openImportModal);
$("#import-csv-btn-2").addEventListener("click", openImportModal);
$("#close-import-modal").addEventListener("click", () => cerrarHoja($("#import-modal")));
$("#cancel-import-btn").addEventListener("click", () => cerrarHoja($("#import-modal")));
$("#do-import-btn").addEventListener("click", doImport);
$("#import-clear").addEventListener("click", () => { $("#import-textarea").value = ""; $("#import-error").textContent = ""; });
$("#import-load-file").addEventListener("click", () => $("#import-csv-input").click());
$("#import-csv-input").addEventListener("change", async (e) => {
  if (e.target.files.length) {
    try { $("#import-textarea").value = await e.target.files[0].text(); }
    catch (err) { $("#import-error").textContent = err.message; }
  }
  e.target.value = "";
});

/* ------------- lo que las Tarifas escuchan ------------- */

on("subvista", ({ name }) => { if (name === "tariffs") renderTariffsList(); });
on("pagina-ajustes", ({ page }) => { if (page === "tariffs") renderTariffsList(); });
// La lista sale de la configuración: si se recarga, se repinta. Así nadie tiene
// que acordarse de llamar a `renderTariffsList` después de guardar.
on("config", () => { if (config()) renderTariffsList(); });

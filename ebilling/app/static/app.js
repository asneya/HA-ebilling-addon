/* eBilling frontend — vanilla JS, rutas relativas para el Ingress de HA. */
"use strict";

const state = {
  config: null,
  simulation: null,
  cyclesBack: 0,
  projection: false,
  editingTariffId: null,
};

const fmtEUR = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const fmtNum = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, options = {}) {
  const resp = await fetch(`api/${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!resp.ok) {
    let detail = `Error ${resp.status}`;
    try { detail = (await resp.json()).detail || detail; } catch (_) { /* noop */ }
    throw new Error(detail);
  }
  return resp.json();
}

/* ============================= Navegación ============================= */

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => showView(tab.dataset.view));
});

function showView(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "tariffs") renderTariffsList();
  if (name === "settings") fillSettingsForm();
}

/* ============================= Dashboard ============================= */

async function loadSimulation() {
  const banner = $("#error-banner");
  banner.classList.add("hidden");
  try {
    state.simulation = await api(`simulate?cycles_back=${state.cyclesBack}`);
    renderDashboard();
  } catch (err) {
    banner.textContent = err.message;
    banner.classList.remove("hidden");
  }
}

function renderDashboard() {
  const sim = state.simulation;
  if (!sim) return;

  $("#demo-banner").classList.toggle("hidden", sim.source !== "demo");

  // Se formatea solo la parte de fecha del ISO para no desplazar el día
  // cuando la zona horaria del navegador difiere de la del contrato.
  const fmtDay = (iso) => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-ES", {
      day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
    });
  };
  $("#period-label").textContent =
    `${fmtDay(sim.period.start)} → ${fmtDay(sim.period.end)}` +
    (sim.period.is_current ? " · ciclo actual" : "");
  $("#next-cycle").disabled = state.cyclesBack === 0;

  renderStats(sim);
  renderBills(sim);
  renderDailyChart(sim.consumption.daily);
}

function renderStats(sim) {
  const c = sim.consumption;
  const cards = [
    { label: "Consumo total", value: `${fmtNum.format(c.total)} kWh`, sub: `${fmtNum.format(sim.period.elapsed_days)} de ${fmtNum.format(sim.period.cycle_days)} días`, cls: "" },
    { label: "Punta", value: `${fmtNum.format(c.kwh.punta)} kWh`, sub: pct(c.kwh.punta, c.total), cls: "punta" },
    { label: "Llano", value: `${fmtNum.format(c.kwh.llano)} kWh`, sub: pct(c.kwh.llano, c.total), cls: "llano" },
    { label: "Valle", value: `${fmtNum.format(c.kwh.valle)} kWh`, sub: pct(c.kwh.valle, c.total), cls: "valle" },
  ];
  $("#stats-row").innerHTML = cards
    .map((s) => `<div class="card stat ${s.cls}"><div class="label">${s.label}</div><div class="value">${s.value}</div><div class="sub">${s.sub}</div></div>`)
    .join("");
}

function pct(part, total) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}% del total`;
}

function renderBills(sim) {
  const grid = $("#bills-grid");
  const projected = state.projection;
  const bills = [...sim.bills];
  if (projected) bills.sort((a, b) => a.projected_total - b.projected_total);
  const cheapest = bills.length ? (projected ? bills[0].projected_total : bills[0].total) : 0;

  grid.innerHTML = bills
    .map((bill, idx) => {
      const total = projected ? bill.projected_total : bill.total;
      const extra = total - cheapest;
      const badge = idx === 0
        ? `<span class="badge best">✓ Más barata</span>`
        : `<span class="badge extra">+${fmtEUR.format(extra)}</span>`;
      const sub = bill.subtotals;
      const segTotal = sub.power + sub.energy + sub.charges + sub.services || 1;
      const seg = (v, color) => `<i style="width:${(v / segTotal) * 100}%;background:${color}"></i>`;
      return `
      <div class="card bill-card">
        <span class="stripe" style="background:${bill.color || "#4a6cf7"}"></span>
        <div class="bill-head">
          <div>
            <div class="bill-company">${esc(bill.company || "")}</div>
            <div class="bill-name">${esc(bill.name || "Tarifa")}</div>
          </div>
          ${badge}
        </div>
        <div class="bill-total">${fmtEUR.format(total)} <small>${projected ? "proyección ciclo completo" : "acumulado"}</small></div>
        <div class="bill-sub">${projected ? `Acumulado hasta hoy: ${fmtEUR.format(bill.total)}` : `Proyección fin de ciclo: ${fmtEUR.format(bill.projected_total)}`}</div>
        <div class="bill-bars" title="Potencia / Energía / Cargos / Servicios">
          ${seg(sub.power, "#7c3aed")}${seg(sub.energy, "#4a6cf7")}${seg(sub.charges, "#f59f00")}${seg(sub.services, "#94a3b8")}
        </div>
        <div class="bill-breakdown">
          <span>Potencia ${fmtEUR.format(sub.power)}</span>
          <span>Energía ${fmtEUR.format(sub.energy)}</span>
          <span>Cargos ${fmtEUR.format(sub.charges)}</span>
          <span>Impuestos ${fmtEUR.format(sub.taxes)}</span>
        </div>
        <div class="bill-actions">
          <button class="btn ghost" data-bill-detail="${esc(bill.tariff_id)}">Ver factura detallada</button>
        </div>
      </div>`;
    })
    .join("");

  grid.querySelectorAll("[data-bill-detail]").forEach((btn) => {
    btn.addEventListener("click", () => openBillDetail(btn.dataset.billDetail));
  });
}

function openBillDetail(tariffId) {
  const bill = state.simulation.bills.find((b) => b.tariff_id === tariffId);
  if (!bill) return;
  const shown = state.projection ? bill.projected : bill;
  $("#bill-modal-title").textContent =
    `${bill.name} · ${state.projection ? "proyección fin de ciclo" : "acumulado"}`;

  const groups = [
    ["power", "Término de potencia"],
    ["energy", "Término de energía"],
    ["charges", "Cargos e impuesto eléctrico"],
    ["services", "Servicios y otros conceptos"],
    ["vat", "IVA"],
  ];
  let rows = "";
  for (const [key, label] of groups) {
    const lines = shown.lines.filter((l) => l.group === key);
    if (!lines.length) continue;
    rows += `<tr class="group-row"><td colspan="2">${label}</td></tr>`;
    rows += lines
      .map((l) => `<tr><td>${esc(l.concept)}<div class="detail">${esc(l.detail)}</div></td><td>${fmtEUR.format(l.amount)}</td></tr>`)
      .join("");
  }
  rows += `<tr class="total-row"><td>TOTAL FACTURA (${fmtNum.format(shown.days)} días · ${fmtNum.format(shown.kwh_total)} kWh)</td><td>${fmtEUR.format(shown.total)}</td></tr>`;
  $("#bill-modal-body").innerHTML = `<table class="bill-table">${rows}</table>`;
  $("#bill-modal").classList.remove("hidden");
}

function renderDailyChart(daily) {
  const container = $("#daily-chart");
  if (!daily || !daily.length) {
    container.innerHTML = `<p class="hint">Sin datos de consumo en este periodo.</p>`;
    return;
  }
  const colors = { punta: "#ef476f", llano: "#ffd166", valle: "#06d6a0" };
  const barWidth = 26, gap = 8, padL = 42, padB = 26, padT = 12;
  const height = 220;
  const width = padL + daily.length * (barWidth + gap) + 10;
  const max = Math.max(...daily.map((d) => d.punta + d.llano + d.valle), 0.1);
  const scale = (height - padT - padB) / max;

  let svg = "";
  // Rejilla y eje Y
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const val = (max / steps) * i;
    const y = height - padB - val * scale;
    svg += `<line x1="${padL}" y1="${y}" x2="${width}" y2="${y}" stroke="currentColor" opacity="0.12"/>`;
    svg += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.6">${val.toFixed(1)}</text>`;
  }
  daily.forEach((d, i) => {
    const x = padL + i * (barWidth + gap);
    let y = height - padB;
    for (const p of ["valle", "llano", "punta"]) {
      const h = d[p] * scale;
      y -= h;
      svg += `<rect class="bar-seg" x="${x}" y="${y}" width="${barWidth}" height="${Math.max(h, 0)}" rx="2" fill="${colors[p]}"><title>${d.date} · ${p}: ${fmtNum.format(d[p])} kWh</title></rect>`;
    }
    const day = d.date.slice(8);
    if (daily.length <= 31 || i % 2 === 0) {
      svg += `<text x="${x + barWidth / 2}" y="${height - 8}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">${day}</text>`;
    }
  });
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${svg}</svg>`;
}

/* ============================= Tarifas ============================= */

function renderTariffsList() {
  const list = $("#tariffs-list");
  const tariffs = state.config?.tariffs || [];
  if (!tariffs.length) {
    list.innerHTML = `<p class="hint">No hay tarifas. Crea la primera con «Nueva tarifa».</p>`;
    return;
  }
  list.innerHTML = tariffs
    .map((t) => `
      <div class="card bill-card tariff-card">
        <span class="stripe" style="background:${t.color || "#4a6cf7"}"></span>
        <div class="bill-head">
          <div>
            <div class="bill-company">${esc(t.company || "")}</div>
            <div class="bill-name">${esc(t.name || "Tarifa")}</div>
          </div>
        </div>
        <div class="prices">
          <div class="price-chip"><div class="p-label">Punta</div><div class="p-value">${num6(t.energy_prices?.punta)} €/kWh</div></div>
          <div class="price-chip"><div class="p-label">Llano</div><div class="p-value">${num6(t.energy_prices?.llano)} €/kWh</div></div>
          <div class="price-chip"><div class="p-label">Valle</div><div class="p-value">${num6(t.energy_prices?.valle)} €/kWh</div></div>
        </div>
        <div class="bill-breakdown">
          <span>P1 ${num6(t.power_prices?.p1)} €/kW·día</span>
          <span>P2 ${num6(t.power_prices?.p2)} €/kW·día</span>
          <span>IVA ${t.vat_energy_pct ?? 21}%</span>
        </div>
        <div class="bill-actions">
          <button class="btn ghost" data-edit="${esc(t.id)}">Editar</button>
          <button class="btn ghost" data-clone="${esc(t.id)}">Duplicar</button>
          <button class="btn ghost danger" data-del="${esc(t.id)}">Eliminar</button>
        </div>
      </div>`)
    .join("");

  list.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openTariffModal(b.dataset.edit)));
  list.querySelectorAll("[data-clone]").forEach((b) => b.addEventListener("click", () => cloneTariff(b.dataset.clone)));
  list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteTariff(b.dataset.del)));
}

function num6(v) {
  return v === undefined || v === null ? "—" : Number(v).toLocaleString("es-ES", { maximumFractionDigits: 6 });
}

function openTariffModal(tariffId = null) {
  state.editingTariffId = tariffId;
  const t = tariffId ? state.config.tariffs.find((x) => x.id === tariffId) : null;
  $("#tariff-modal-title").textContent = t ? `Editar · ${t.name}` : "Nueva tarifa";
  $("#t-name").value = t?.name || "";
  $("#t-company").value = t?.company || "";
  $("#t-color").value = t?.color || "#4a6cf7";
  $("#t-power-p1").value = t?.power_prices?.p1 ?? "";
  $("#t-power-p2").value = t?.power_prices?.p2 ?? "";
  $("#t-energy-punta").value = t?.energy_prices?.punta ?? "";
  $("#t-energy-llano").value = t?.energy_prices?.llano ?? "";
  $("#t-energy-valle").value = t?.energy_prices?.valle ?? "";
  $("#t-bono").value = t?.fixed_daily?.[0]?.price ?? 0.019121;
  $("#t-meter").value = t?.meter_rental_daily ?? 0.02663;
  $("#t-services").value = t?.services_monthly?.[0]?.price ?? "";
  $("#t-services-name").value = t?.services_monthly?.[0]?.name ?? "";
  $("#t-elec-tax").value = t?.electricity_tax_pct ?? 0.5;
  $("#t-vat-energy").value = t?.vat_energy_pct ?? 10;
  $("#t-vat-services").value = t?.vat_services_pct ?? 21;
  $("#tariff-modal").classList.remove("hidden");
}

function tariffFromForm() {
  const num = (sel, def = 0) => {
    const v = parseFloat($(sel).value);
    return Number.isFinite(v) ? v : def;
  };
  const servicesPrice = num("#t-services", 0);
  return {
    name: $("#t-name").value.trim() || "Tarifa sin nombre",
    company: $("#t-company").value.trim(),
    color: $("#t-color").value,
    power_prices: { p1: num("#t-power-p1"), p2: num("#t-power-p2") },
    energy_prices: {
      punta: num("#t-energy-punta"),
      llano: num("#t-energy-llano"),
      valle: num("#t-energy-valle"),
    },
    fixed_daily: num("#t-bono") > 0
      ? [{ name: "Financiación bono social", price: num("#t-bono") }]
      : [],
    meter_rental_daily: num("#t-meter"),
    services_monthly: servicesPrice > 0
      ? [{ name: $("#t-services-name").value.trim() || "Servicios", price: servicesPrice }]
      : [],
    electricity_tax_pct: num("#t-elec-tax", 0.5),
    vat_energy_pct: num("#t-vat-energy", 10),
    vat_services_pct: num("#t-vat-services", 21),
  };
}

async function saveTariff() {
  const tariff = tariffFromForm();
  try {
    if (state.editingTariffId) {
      await api(`tariffs/${state.editingTariffId}`, { method: "PUT", body: JSON.stringify(tariff) });
    } else {
      await api("tariffs", { method: "POST", body: JSON.stringify(tariff) });
    }
    $("#tariff-modal").classList.add("hidden");
    await reloadConfig();
    renderTariffsList();
    loadSimulation();
  } catch (err) {
    alert(err.message);
  }
}

async function cloneTariff(tariffId) {
  const t = state.config.tariffs.find((x) => x.id === tariffId);
  if (!t) return;
  const copy = JSON.parse(JSON.stringify(t));
  delete copy.id;
  copy.name = `${copy.name} (copia)`;
  await api("tariffs", { method: "POST", body: JSON.stringify(copy) });
  await reloadConfig();
  renderTariffsList();
  loadSimulation();
}

async function deleteTariff(tariffId) {
  const t = state.config.tariffs.find((x) => x.id === tariffId);
  if (!t || !confirm(`¿Eliminar la tarifa «${t.name}»?`)) return;
  await api(`tariffs/${tariffId}`, { method: "DELETE" });
  await reloadConfig();
  renderTariffsList();
  loadSimulation();
}

/* ============================= Ajustes ============================= */

function fillSettingsForm() {
  const s = state.config?.settings;
  if (!s) return;
  $("#s-source").value = s.source || "demo";
  $("#s-ha-url").value = s.ha_url || "";
  $("#s-ha-token").value = s.ha_token || "";
  $("#s-p1").value = s.contracted_power?.p1 ?? 4.6;
  $("#s-p2").value = s.contracted_power?.p2 ?? 4.6;
  $("#s-billing-day").value = s.billing_day ?? 1;
  $("#s-timezone").value = s.timezone || "Europe/Madrid";
  $("#s-holidays").value = (s.holidays || []).join(", ");
  const ifx = s.influx || {};
  $("#s-ifx-version").value = String(ifx.version ?? 2);
  $("#s-ifx-url").value = ifx.url || "";
  $("#s-ifx-db").value = ifx.database || "";
  $("#s-ifx-measurement").value = ifx.measurement || "kWh";
  $("#s-ifx-entity").value = ifx.entity_id || "";
  $("#s-ifx-org").value = ifx.org || "";
  $("#s-ifx-token").value = ifx.token || "";
  $("#s-ifx-user").value = ifx.username || "";
  $("#s-ifx-pass").value = ifx.password || "";

  const entitySelect = $("#s-ha-entity");
  entitySelect.innerHTML = s.ha_entity
    ? `<option value="${esc(s.ha_entity)}">${esc(s.ha_entity)}</option>`
    : `<option value="">— pulsa «Buscar sensores» —</option>`;
  updateSourceVisibility();
}

function updateSourceVisibility() {
  const source = $("#s-source").value;
  $("#ha-fields").classList.toggle("hidden", source !== "homeassistant");
  $("#influx-fields").classList.toggle("hidden", source !== "influxdb");
  $("#ha-external").classList.toggle("hidden", !!state.config?.supervisor);
  const v2 = $("#s-ifx-version").value === "2";
  $$(".ifx-v2").forEach((el) => el.classList.toggle("hidden", !v2));
  $$(".ifx-v1").forEach((el) => el.classList.toggle("hidden", v2));
}

async function loadEntities() {
  const btn = $("#load-entities-btn");
  btn.disabled = true;
  btn.textContent = "Buscando…";
  try {
    // Guarda antes URL/token por si se usa HA externo.
    await saveSettings(true);
    const entities = await api("entities");
    const select = $("#s-ha-entity");
    const current = state.config?.settings?.ha_entity || "";
    select.innerHTML = entities
      .map((e) => `<option value="${esc(e.entity_id)}" ${e.entity_id === current ? "selected" : ""}>${esc(e.name)} (${esc(e.entity_id)})</option>`)
      .join("") || `<option value="">No se encontraron sensores de energía</option>`;
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Buscar sensores";
  }
}

function settingsFromForm() {
  return {
    source: $("#s-source").value,
    ha_entity: $("#s-ha-entity").value,
    ha_url: $("#s-ha-url").value.trim(),
    ha_token: $("#s-ha-token").value,
    contracted_power: {
      p1: parseFloat($("#s-p1").value) || 0,
      p2: parseFloat($("#s-p2").value) || 0,
    },
    billing_day: parseInt($("#s-billing-day").value, 10) || 1,
    timezone: $("#s-timezone").value.trim() || "Europe/Madrid",
    holidays: $("#s-holidays").value.split(",").map((x) => x.trim()).filter(Boolean),
    influx: {
      version: parseInt($("#s-ifx-version").value, 10) || 2,
      url: $("#s-ifx-url").value.trim(),
      database: $("#s-ifx-db").value.trim(),
      measurement: $("#s-ifx-measurement").value.trim() || "kWh",
      entity_id: $("#s-ifx-entity").value.trim(),
      org: $("#s-ifx-org").value.trim(),
      token: $("#s-ifx-token").value,
      username: $("#s-ifx-user").value.trim(),
      password: $("#s-ifx-pass").value,
    },
  };
}

async function saveSettings(silent = false) {
  const status = $("#settings-status");
  try {
    const result = await api("settings", { method: "PUT", body: JSON.stringify(settingsFromForm()) });
    state.config.settings = { ...state.config.settings, ...result.settings };
    if (!silent) {
      status.textContent = "✓ Ajustes guardados";
      setTimeout(() => (status.textContent = ""), 3000);
      loadSimulation();
    }
  } catch (err) {
    if (!silent) status.textContent = `Error: ${err.message}`;
    else throw err;
  }
}

/* ============================= Utilidades ============================= */

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function reloadConfig() {
  state.config = await api("config");
}

/* ============================= Eventos ============================= */

$("#prev-cycle").addEventListener("click", () => { state.cyclesBack += 1; loadSimulation(); });
$("#next-cycle").addEventListener("click", () => {
  if (state.cyclesBack > 0) { state.cyclesBack -= 1; loadSimulation(); }
});
$("#refresh-btn").addEventListener("click", loadSimulation);
$("#projection-toggle").addEventListener("change", (e) => {
  state.projection = e.target.checked;
  renderBills(state.simulation);
});
$("#goto-settings").addEventListener("click", (e) => { e.preventDefault(); showView("settings"); });

$("#add-tariff-btn").addEventListener("click", () => openTariffModal(null));
$("#save-tariff-btn").addEventListener("click", saveTariff);
$("#cancel-tariff-btn").addEventListener("click", () => $("#tariff-modal").classList.add("hidden"));
$("#close-tariff-modal").addEventListener("click", () => $("#tariff-modal").classList.add("hidden"));
$("#close-bill-modal").addEventListener("click", () => $("#bill-modal").classList.add("hidden"));
$$(".modal").forEach((m) => m.addEventListener("click", (e) => {
  if (e.target === m) m.classList.add("hidden");
}));

$("#s-source").addEventListener("change", updateSourceVisibility);
$("#s-ifx-version").addEventListener("change", updateSourceVisibility);
$("#load-entities-btn").addEventListener("click", loadEntities);
$("#save-settings-btn").addEventListener("click", () => saveSettings(false));

/* ============================= Arranque ============================= */

(async function init() {
  try {
    await reloadConfig();
  } catch (err) {
    $("#error-banner").textContent = `No se pudo cargar la configuración: ${err.message}`;
    $("#error-banner").classList.remove("hidden");
    return;
  }
  await loadSimulation();
  // Refresco automático cada 5 minutos («tiempo real»).
  setInterval(loadSimulation, 5 * 60 * 1000);
})();

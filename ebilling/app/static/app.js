/* eBilling frontend — vanilla JS, rutas relativas para el Ingress de HA. */
"use strict";

const state = {
  config: null,
  simulation: null,
  cyclesBack: 0,
  projection: false,
  editingTariffId: null,
  detail: null,
  detailCyclesBack: 0,
  selectedDay: null,
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
  if (name === "detail" && !state.detail) loadDetail();
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

  const banner = $("#error-banner");
  if (sim.errors && sim.errors.length) {
    banner.innerHTML = sim.errors
      .map((e) => `<div><strong>${esc(e.tariff)}</strong>: ${esc(e.error)}</div>`)
      .join("");
    banner.classList.remove("hidden");
  }

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
  if (c.export_total > 0) {
    cards.push({ label: "Excedentes vertidos", value: `${fmtNum.format(c.export_total)} kWh`, sub: "energía compensable", cls: "valle" });
  }
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
  if (!bills.length) {
    grid.innerHTML = `<p class="hint">No hay tarifas válidas que simular.</p>`;
    return;
  }
  const cheapest = projected ? bills[0].projected_total : bills[0].total;

  grid.innerHTML = bills
    .map((bill, idx) => {
      const total = projected ? bill.projected_total : bill.total;
      const extra = total - cheapest;
      const badge = idx === 0
        ? `<span class="badge best">✓ Más barata</span>`
        : `<span class="badge extra">+${fmtEUR.format(extra)}</span>`;
      const typeBadge = bill.energy_type === "pvpc" ? `<span class="badge">PVPC</span>` : "";
      const sub = bill.subtotals;
      const segTotal = sub.power + sub.energy + sub.charges + sub.services || 1;
      const seg = (v, color) => `<i style="width:${(Math.max(v, 0) / segTotal) * 100}%;background:${color}"></i>`;
      const surplusChip = bill.surplus_credit > 0
        ? `<span>Excedentes −${fmtEUR.format(bill.surplus_credit)}</span>`
        : "";
      const warning = bill.warning ? `<div class="hint">⚠ ${esc(bill.warning)}</div>` : "";
      return `
      <div class="card bill-card">
        <span class="stripe" style="background:${bill.color || "#4a6cf7"}"></span>
        <div class="bill-head">
          <div>
            <div class="bill-company">${esc(bill.company || "")}</div>
            <div class="bill-name">${esc(bill.name || "Tarifa")}</div>
          </div>
          <div class="badges">${typeBadge}${badge}</div>
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
          ${surplusChip}
        </div>
        ${warning}
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

/* ============================= Detalle (drill-down) ============================= */

const PCOLOR = { punta: "#ef476f", llano: "#ffd166", valle: "#06d6a0" };
const ECOLOR = "#f59f00";

async function loadDetail() {
  const banner = $("#d-error");
  banner.classList.add("hidden");
  try {
    state.detail = await api(`detail?cycles_back=${state.detailCyclesBack}`);
    renderDetail();
  } catch (err) {
    banner.textContent = err.message;
    banner.classList.remove("hidden");
  }
}

function periodLabelISO(startISO, endISO) {
  const f = (iso) => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-ES", {
      day: "numeric", month: "short", timeZone: "UTC",
    });
  };
  return `${f(startISO)} → ${f(endISO)}`;
}

function dayLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("es-ES", {
    weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
  });
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  $("#d-demo").classList.toggle("hidden", d.source !== "demo");
  $("#d-period").textContent =
    periodLabelISO(d.period.start, d.period.end) + (d.period.is_current ? " · ciclo actual" : "");
  $("#d-next").disabled = state.detailCyclesBack === 0;

  const t = d.totals;
  const tile = (label, value, sub, cls) =>
    `<div class="card stat ${cls}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const cards = [
    tile("Energía importada", `${fmtNum.format(t.import)} kWh`, "compara con tu sensor de importación", ""),
  ];
  if (d.has_export || t.export > 0) {
    cards.push(tile("Energía exportada", `${fmtNum.format(t.export)} kWh`, "compara con tu sensor de exportación", "export"));
  }
  cards.push(
    tile("Punta", `${fmtNum.format(t.punta)} kWh`, pct(t.punta, t.import), "punta"),
    tile("Llano", `${fmtNum.format(t.llano)} kWh`, pct(t.llano, t.import), "llano"),
    tile("Valle", `${fmtNum.format(t.valle)} kWh`, pct(t.valle, t.import), "valle"),
  );
  $("#d-stats").innerHTML = cards.join("");

  renderDailyDetail(d.days);
  if (state.selectedDay && d.days.some((x) => x.date === state.selectedDay)) {
    renderHourly(state.selectedDay);
  } else {
    state.selectedDay = null;
    $("#d-hourly-wrap").classList.add("hidden");
  }
}

function gridAxis(max, padL, padB, padT, width, height) {
  let svg = "";
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const val = (max / steps) * i;
    const y = height - padB - (val / max) * (height - padT - padB);
    svg += `<line x1="${padL}" y1="${y}" x2="${width}" y2="${y}" stroke="currentColor" opacity="0.12"/>`;
    svg += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.6">${val.toFixed(1)}</text>`;
  }
  return svg;
}

function renderDailyDetail(days) {
  const c = $("#d-daily");
  if (!days || !days.length) {
    c.innerHTML = `<p class="hint">Sin datos de consumo en este periodo.</p>`;
    return;
  }
  const groupW = 30, gap = 12, padL = 44, padB = 28, padT = 10, height = 240;
  const width = padL + days.length * (groupW + gap) + 10;
  const max = Math.max(...days.map((d) => Math.max(d.import, d.export)), 0.1);
  const scale = (height - padT - padB) / max;
  const impW = 17, expW = 9;

  let svg = gridAxis(max, padL, padB, padT, width, height);
  days.forEach((d, i) => {
    const x = padL + i * (groupW + gap);
    if (state.selectedDay === d.date) {
      svg += `<rect x="${x - gap / 2}" y="${padT}" width="${groupW + gap}" height="${height - padT - padB}" fill="currentColor" opacity="0.06" rx="4"/>`;
    }
    let y = height - padB;
    for (const p of ["valle", "llano", "punta"]) {
      const h = d[p] * scale;
      y -= h;
      svg += `<rect class="bar-seg" data-day="${d.date}" x="${x}" y="${y}" width="${impW}" height="${Math.max(h, 0)}" rx="2" fill="${PCOLOR[p]}" style="cursor:pointer"><title>${d.date} · ${p}: ${fmtNum.format(d[p])} kWh</title></rect>`;
    }
    const eh = d.export * scale;
    svg += `<rect class="bar-seg" data-day="${d.date}" x="${x + impW + 2}" y="${height - padB - eh}" width="${expW}" height="${Math.max(eh, 0)}" rx="2" fill="${ECOLOR}" style="cursor:pointer"><title>${d.date} · exportada: ${fmtNum.format(d.export)} kWh</title></rect>`;
    if (days.length <= 31 || i % 2 === 0) {
      svg += `<text x="${x + groupW / 2}" y="${height - 8}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">${d.date.slice(8)}</text>`;
    }
  });
  c.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${svg}</svg>`;
  c.querySelectorAll("[data-day]").forEach((el) =>
    el.addEventListener("click", () => selectDay(el.getAttribute("data-day")))
  );
}

function selectDay(date) {
  state.selectedDay = date;
  renderDailyDetail(state.detail.days);
  renderHourly(date);
  $("#d-hourly-wrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderHourly(date) {
  const d = state.detail;
  const map = {};
  d.hours.filter((h) => h.date === date).forEach((h) => (map[h.hour] = h));
  const hours = Array.from({ length: 24 }, (_, hh) =>
    map[hh] || { hour: hh, kwh: 0, export: 0, period: null }
  );

  $("#d-hourly-wrap").classList.remove("hidden");
  $("#d-hourly-title").textContent = `Desglose por horas · ${dayLabel(date)}`;

  const barW = 15, gap = 6, group = 2 * barW + 3, padL = 44, padB = 26, padT = 10, height = 200;
  const width = padL + 24 * (group + gap) + 10;
  const max = Math.max(...hours.map((h) => Math.max(h.kwh, h.export)), 0.1);
  const scale = (height - padT - padB) / max;

  let svg = gridAxis(max, padL, padB, padT, width, height);
  hours.forEach((h, i) => {
    const x = padL + i * (group + gap);
    const ih = h.kwh * scale;
    const fill = h.period ? PCOLOR[h.period] : "#94a3b8";
    svg += `<rect class="bar-seg" x="${x}" y="${height - padB - ih}" width="${barW}" height="${Math.max(ih, 0)}" rx="2" fill="${fill}"><title>${String(h.hour).padStart(2, "0")}:00 · ${h.period || "—"} · ${fmtNum.format(h.kwh)} kWh</title></rect>`;
    const eh = h.export * scale;
    svg += `<rect class="bar-seg" x="${x + barW + 3}" y="${height - padB - eh}" width="${barW}" height="${Math.max(eh, 0)}" rx="2" fill="${ECOLOR}"><title>${String(h.hour).padStart(2, "0")}:00 · exportada ${fmtNum.format(h.export)} kWh</title></rect>`;
    if (i % 2 === 0) {
      svg += `<text x="${x + group / 2}" y="${height - 8}" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.6">${h.hour}</text>`;
    }
  });
  $("#d-hourly").innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${svg}</svg>`;

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "—");
  let rows = `<tr class="group-row"><td>Hora</td><td>Periodo</td><td>Importada</td><td>Exportada</td></tr>`;
  rows += hours
    .map((h) => `<tr><td>${String(h.hour).padStart(2, "0")}:00</td><td>${cap(h.period)}</td><td>${fmtNum.format(h.kwh)} kWh</td><td>${fmtNum.format(h.export)} kWh</td></tr>`)
    .join("");
  $("#d-hourly-table").innerHTML = rows;
}

/* ============================= Tarifas: listado ============================= */

function describeTariff(t) {
  const e = t.energy || {};
  if (e.type === "pvpc") {
    const margin = Number(e.pvpc_margin || 0);
    return `PVPC indexada${margin ? ` + ${num6(margin)} €/kWh` : ""}`;
  }
  const n = (e.periods || []).length;
  return n === 1 ? "Precio único" : `${n} tramos`;
}

function renderTariffsList() {
  const list = $("#tariffs-list");
  const tariffs = state.config?.tariffs || [];
  if (!tariffs.length) {
    list.innerHTML = `<p class="hint">No hay tarifas. Crea la primera con «Nueva tarifa» o importa un CSV.</p>`;
    return;
  }
  list.innerHTML = tariffs
    .map((t) => {
      const e = t.energy || {};
      const chips = e.type === "pvpc"
        ? `<div class="price-chip"><div class="p-label">Energía</div><div class="p-value">PVPC horario</div></div>`
        : (e.periods || [])
            .map((p) => `<div class="price-chip"><div class="p-label">${esc(p.name)}</div><div class="p-value">${num6(p.price)} €/kWh</div></div>`)
            .join("");
      const surplus = t.surplus && t.surplus.type !== "none"
        ? `<span>☀ Excedentes ${t.surplus.type === "flat" ? `${num6(t.surplus.price)} €/kWh` : "por tramos"}</span>`
        : "";
      return `
      <div class="card bill-card tariff-card">
        <span class="stripe" style="background:${t.color || "#4a6cf7"}"></span>
        <div class="bill-head">
          <div>
            <div class="bill-company">${esc(t.company || "")}</div>
            <div class="bill-name">${esc(t.name || "Tarifa")}</div>
          </div>
          <span class="badge">${esc(describeTariff(t))}</span>
        </div>
        <div class="prices">${chips}</div>
        <div class="bill-breakdown">
          <span>P1 ${num6(t.power_prices?.p1)} €/kW·día</span>
          <span>P2 ${num6(t.power_prices?.p2)} €/kW·día</span>
          <span>IVA ${t.vat_energy_pct ?? 21}%</span>
          ${surplus}
        </div>
        <div class="bill-actions">
          <button class="btn ghost" data-edit="${esc(t.id)}">Editar</button>
          <button class="btn ghost" data-clone="${esc(t.id)}">Duplicar</button>
          <a class="btn ghost" href="api/tariffs/${esc(t.id)}/export.csv" download>CSV</a>
          <button class="btn ghost danger" data-del="${esc(t.id)}">Eliminar</button>
        </div>
      </div>`;
    })
    .join("");

  list.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openTariffModal(b.dataset.edit)));
  list.querySelectorAll("[data-clone]").forEach((b) => b.addEventListener("click", () => cloneTariff(b.dataset.clone)));
  list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteTariff(b.dataset.del)));
}

function num6(v) {
  return v === undefined || v === null ? "—" : Number(v).toLocaleString("es-ES", { maximumFractionDigits: 6 });
}

/* ============================= Tarifas: editor ============================= */

function periodRow(container, period = {}) {
  const row = document.createElement("div");
  row.className = "period-row";
  row.innerHTML = `
    <input class="pr-name" placeholder="Nombre" value="${esc(period.name || "")}">
    <input class="pr-price" type="number" step="0.000001" min="0" placeholder="€/kWh" value="${period.price ?? ""}">
    <input class="pr-schedule" placeholder="Horario, p. ej. L-V 10-14,18-22 (vacío = resto)" value="${esc(period.schedule || "")}">
    <button class="icon-btn pr-del" title="Quitar tramo">✕</button>`;
  row.querySelector(".pr-del").addEventListener("click", () => row.remove());
  container.appendChild(row);
}

function readPeriodRows(container) {
  return Array.from(container.querySelectorAll(".period-row")).map((row, idx) => ({
    name: row.querySelector(".pr-name").value.trim() || `P${idx + 1}`,
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
}

function openTariffModal(tariffId = null) {
  state.editingTariffId = tariffId;
  const t = tariffId ? state.config.tariffs.find((x) => x.id === tariffId) : null;
  $("#tariff-modal-title").textContent = t ? `Editar · ${t.name}` : "Nueva tarifa";
  $("#tariff-error").textContent = "";
  $("#t-name").value = t?.name || "";
  $("#t-company").value = t?.company || "";
  $("#t-color").value = t?.color || "#4a6cf7";

  const energy = t?.energy || { type: "schedule", preset: "td3", periods: [], pvpc_margin: 0 };
  let etype = "custom";
  if (energy.type === "pvpc") etype = "pvpc";
  else if (energy.preset === "td3" || !t) etype = "td3";
  $("#t-etype").value = etype;

  const byName = {};
  (energy.periods || []).forEach((p) => { byName[p.name.toLowerCase()] = p.price; });
  $("#t-td3-punta").value = byName.punta ?? "";
  $("#t-td3-llano").value = byName.llano ?? "";
  $("#t-td3-valle").value = byName.valle ?? "";

  const periodsBox = $("#t-periods");
  periodsBox.innerHTML = "";
  (energy.type === "schedule" && energy.periods?.length ? energy.periods : [{}]).forEach(
    (p) => periodRow(periodsBox, p)
  );
  $("#t-pvpc-margin").value = energy.pvpc_margin ?? 0;

  const surplus = t?.surplus || { type: "none", price: 0, periods: [] };
  $("#t-surplus-type").value = surplus.type || "none";
  $("#t-surplus-price").value = surplus.price ?? "";
  const surplusBox = $("#t-surplus-periods");
  surplusBox.innerHTML = "";
  (surplus.periods?.length ? surplus.periods : [{}]).forEach((p) => periodRow(surplusBox, p));

  $("#t-power-p1").value = t?.power_prices?.p1 ?? "";
  $("#t-power-p2").value = t?.power_prices?.p2 ?? "";
  $("#t-bono").value = t?.fixed_daily?.[0]?.price ?? 0.019121;
  $("#t-meter").value = t?.meter_rental_daily ?? 0.02663;
  $("#t-services").value = t?.services_monthly?.[0]?.price ?? "";
  $("#t-services-name").value = t?.services_monthly?.[0]?.name ?? "";
  $("#t-elec-tax").value = t?.electricity_tax_pct ?? 0.5;
  $("#t-vat-energy").value = t?.vat_energy_pct ?? 10;
  $("#t-vat-services").value = t?.vat_services_pct ?? 21;

  updateEditorVisibility();
  $("#tariff-modal").classList.remove("hidden");
}

function tariffFromForm() {
  const num = (sel, def = 0) => {
    const v = parseFloat($(sel).value);
    return Number.isFinite(v) ? v : def;
  };
  const etype = $("#t-etype").value;
  let energy;
  if (etype === "pvpc") {
    energy = { type: "pvpc", preset: null, periods: [], pvpc_margin: num("#t-pvpc-margin") };
  } else if (etype === "td3") {
    energy = {
      type: "schedule",
      preset: "td3",
      periods: [
        { name: "Punta", price: num("#t-td3-punta"), schedule: "L-V 10-14,18-22" },
        { name: "Llano", price: num("#t-td3-llano"), schedule: "L-V 8-10,14-18,22-24" },
        { name: "Valle", price: num("#t-td3-valle"), schedule: "" },
      ],
      pvpc_margin: 0,
    };
  } else {
    energy = { type: "schedule", preset: null, periods: readPeriodRows($("#t-periods")), pvpc_margin: 0 };
  }
  const stype = $("#t-surplus-type").value;
  const surplus = {
    type: stype,
    price: num("#t-surplus-price"),
    periods: stype === "schedule" ? readPeriodRows($("#t-surplus-periods")) : [],
  };
  const servicesPrice = num("#t-services", 0);
  return {
    name: $("#t-name").value.trim() || "Tarifa sin nombre",
    company: $("#t-company").value.trim(),
    color: $("#t-color").value,
    energy,
    surplus,
    power_prices: { p1: num("#t-power-p1"), p2: num("#t-power-p2") },
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
  $("#tariff-error").textContent = "";
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
    $("#tariff-error").textContent = err.message;
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

function openImportModal() {
  $("#import-textarea").value = "";
  $("#import-error").textContent = "";
  $("#import-modal").classList.remove("hidden");
  setTimeout(() => $("#import-textarea").focus(), 50);
}

async function loadFileIntoTextarea(file) {
  $("#import-error").textContent = "";
  try {
    // Lee como texto respetando BOM/UTF-8; el backend tolera latin-1 también.
    $("#import-textarea").value = await file.text();
  } catch (err) {
    $("#import-error").textContent = `No se pudo leer el archivo: ${err.message}`;
  }
}

async function doImport() {
  const text = $("#import-textarea").value.trim();
  const error = $("#import-error");
  error.textContent = "";
  if (!text) {
    error.textContent = "Pega el contenido del CSV o carga un archivo.";
    return;
  }
  const btn = $("#do-import-btn");
  btn.disabled = true;
  try {
    const resp = await fetch("api/tariffs/import", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: text,
    });
    if (!resp.ok) {
      let detail = `Error ${resp.status}`;
      try { detail = (await resp.json()).detail || detail; } catch (_) { /* noop */ }
      throw new Error(detail);
    }
    const tariff = await resp.json();
    $("#import-modal").classList.add("hidden");
    $("#import-status").textContent = `✓ Tarifa «${tariff.name}» importada correctamente.`;
    await reloadConfig();
    renderTariffsList();
    loadSimulation();
  } catch (err) {
    error.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

/* ============================= Ajustes ============================= */

function entityOptions(selected) {
  return selected
    ? `<option value="${esc(selected)}">${esc(selected)}</option>`
    : `<option value="">— pulsa «Buscar sensores» —</option>`;
}

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
  $("#s-export-sensors").checked = s.export_sensors !== false;
  $("#s-sensor-minutes").value = s.sensor_update_minutes ?? 5;
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

  $("#s-ha-entity").innerHTML = entityOptions(s.ha_entity);
  $("#s-ha-entity-export").innerHTML =
    `<option value="">— ninguno —</option>` +
    (s.ha_entity_export ? `<option value="${esc(s.ha_entity_export)}" selected>${esc(s.ha_entity_export)}</option>` : "");
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
    const current = state.config?.settings?.ha_entity || "";
    const currentExport = state.config?.settings?.ha_entity_export || "";
    const opts = (sel) => entities
      .map((e) => `<option value="${esc(e.entity_id)}" ${e.entity_id === sel ? "selected" : ""}>${esc(e.name)} (${esc(e.entity_id)})</option>`)
      .join("");
    $("#s-ha-entity").innerHTML =
      opts(current) || `<option value="">No se encontraron sensores de energía</option>`;
    $("#s-ha-entity-export").innerHTML = `<option value="">— ninguno —</option>` + opts(currentExport);
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
    ha_entity_export: $("#s-ha-entity-export").value,
    ha_url: $("#s-ha-url").value.trim(),
    ha_token: $("#s-ha-token").value,
    contracted_power: {
      p1: parseFloat($("#s-p1").value) || 0,
      p2: parseFloat($("#s-p2").value) || 0,
    },
    billing_day: parseInt($("#s-billing-day").value, 10) || 1,
    timezone: $("#s-timezone").value.trim() || "Europe/Madrid",
    holidays: $("#s-holidays").value.split(",").map((x) => x.trim()).filter(Boolean),
    export_sensors: $("#s-export-sensors").checked,
    sensor_update_minutes: parseInt($("#s-sensor-minutes").value, 10) || 5,
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

$("#d-prev").addEventListener("click", () => { state.detailCyclesBack += 1; state.selectedDay = null; loadDetail(); });
$("#d-next").addEventListener("click", () => {
  if (state.detailCyclesBack > 0) { state.detailCyclesBack -= 1; state.selectedDay = null; loadDetail(); }
});
$("#d-refresh").addEventListener("click", loadDetail);
$("#d-goto-settings").addEventListener("click", (e) => { e.preventDefault(); showView("settings"); });

$("#add-tariff-btn").addEventListener("click", () => openTariffModal(null));
$("#save-tariff-btn").addEventListener("click", saveTariff);
$("#cancel-tariff-btn").addEventListener("click", () => $("#tariff-modal").classList.add("hidden"));
$("#close-tariff-modal").addEventListener("click", () => $("#tariff-modal").classList.add("hidden"));
$("#close-bill-modal").addEventListener("click", () => $("#bill-modal").classList.add("hidden"));
$$(".modal").forEach((m) => m.addEventListener("click", (e) => {
  if (e.target === m) m.classList.add("hidden");
}));

$("#t-etype").addEventListener("change", updateEditorVisibility);
$("#t-surplus-type").addEventListener("change", updateEditorVisibility);
$("#t-add-period").addEventListener("click", () => periodRow($("#t-periods")));
$("#t-add-surplus-period").addEventListener("click", () => periodRow($("#t-surplus-periods")));

$("#import-csv-btn").addEventListener("click", openImportModal);
$("#close-import-modal").addEventListener("click", () => $("#import-modal").classList.add("hidden"));
$("#cancel-import-btn").addEventListener("click", () => $("#import-modal").classList.add("hidden"));
$("#do-import-btn").addEventListener("click", doImport);
$("#import-clear").addEventListener("click", () => {
  $("#import-textarea").value = "";
  $("#import-error").textContent = "";
  $("#import-textarea").focus();
});
$("#import-load-file").addEventListener("click", () => $("#import-csv-input").click());
$("#import-csv-input").addEventListener("change", (e) => {
  if (e.target.files.length) loadFileIntoTextarea(e.target.files[0]);
  e.target.value = "";
});

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

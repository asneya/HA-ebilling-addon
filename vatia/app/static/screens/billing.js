/*
 * Facturación · Simulación: qué te costaría el ciclo con cada tarifa, la
 * factura desglosada y el periodo de trabajo.
 */
import { $, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on, emit } from "../core/bus.js";
import { fallo } from "../core/banner.js";
import { fmtEUR, fmtNum, fmtDay, periodShort } from "../core/format.js";
import { settings, workingPeriod, reloadConfig } from "../core/config.js";
import { ensureBars, renderReadout } from "../core/graficos.js";
import { showView, showSub, currentSub } from "../core/nav.js";

let simulation = null;
let cyclesBack = 0;
let projection = false;
let openBillId = null;

export async function loadSimulation() {
  const banner = $("#error-banner");
  banner.classList.add("hidden");
  // En la primera carga la rejilla de tarifas está vacía y la pantalla entraba
  // en blanco: se pone el esqueleto con la forma que va a tener (§04).
  const abortar = new AbortController();
  const quitar = simulation ? () => {} : esqueletoDeFacturas(abortar);
  try {
    simulation = await api(`simulate?cycles_back=${cyclesBack}`,
      { signal: abortar.signal });
    renderSimulation();
  } catch (err) {
    if (err.name === "AbortError") return;
    banner.textContent = err.message;
    banner.classList.remove("hidden");
  } finally {
    quitar();
  }
}

/* Esqueleto de la lista de tarifas mientras llega la comparativa. */
function esqueletoDeFacturas(abortar) {
  const grid = $("#bills-grid");
  grid.textContent = "";
  const skel = document.createElement("vatia-skeleton");
  skel.shape = "rows";
  skel.label = "Calculando lo que costaría el ciclo con cada tarifa…";
  skel.addEventListener("cancel", () => abortar.abort());
  grid.appendChild(skel);
  return () => { if (skel.parentNode === grid) skel.remove(); };
}

function renderSimulation() {
  const sim = simulation;
  if (!sim) return;
  $("#demo-banner").classList.toggle("hidden", sim.source !== "demo");
  if (sim.errors && sim.errors.length) {
    // Con acción: casi siempre es ESIOS que no responde, y reintentar basta.
    fallo($("#error-banner"), sim.errors
      .map((e) => `<b>${esc(e.tariff)}</b>: ${esc(e.error)}`).join("<br>"),
      loadSimulation, { html: true });
  } else {
    $("#error-banner").classList.add("hidden");
  }
  const custom = !!workingPeriod();
  $("#period-label").textContent = periodShort(sim.period.start, sim.period.end) +
    (custom ? " · fijo" : sim.period.is_current ? " · actual" : "");
  $("#bill-sub").textContent = `${fmtDay(sim.period.start)} → ${fmtDay(sim.period.end)}`;
  $("#prev-cycle").disabled = custom;
  $("#next-cycle").disabled = custom || cyclesBack === 0;

  const c = sim.consumption;
  const tile = (l, v, s) =>
    `<div class="stat glass"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const pct = (part, total) => (total ? `${Math.round((part / total) * 100)}% del total` : "0%");
  let tiles = tile("Consumo total", `${fmtNum.format(c.total)} kWh`,
    `${fmtNum.format(sim.period.elapsed_days)} de ${fmtNum.format(sim.period.cycle_days)} días`);
  tiles += tile("Punta", `${fmtNum.format(c.kwh.punta)} kWh`, pct(c.kwh.punta, c.total))
    .replace('class="stat glass"', 'class="stat glass punta"');
  tiles += tile("Llano", `${fmtNum.format(c.kwh.llano)} kWh`, pct(c.kwh.llano, c.total))
    .replace('class="stat glass"', 'class="stat glass llano"');
  tiles += tile("Valle", `${fmtNum.format(c.kwh.valle)} kWh`, pct(c.kwh.valle, c.total))
    .replace('class="stat glass"', 'class="stat glass valle"');
  if (c.export_total > 0) {
    tiles += tile("Excedentes", `${fmtNum.format(c.export_total)} kWh`, "energía vertida")
      .replace('class="stat glass"', 'class="stat glass export"');
  }
  $("#stats-row").innerHTML = tiles;

  renderBills(sim);
  renderDailyChart(sim.consumption.daily);
}

/* La tarjeta de tarifa del prototipo: barra de color, total grande y el resto
   plegado. Se despliega al tocar, de una en una, y ahí viven el desglose y las
   acciones — entre ellas, marcar la tarifa como «la mía», que es la que da el
   ahorro del día en el cierre. */
function renderBills(sim) {
  const grid = $("#bills-grid");
  const projected = projection;
  const bills = [...sim.bills];
  if (projected) bills.sort((a, b) => a.projected_total - b.projected_total);
  if (!bills.length) { grid.innerHTML = `<p class="empty">No hay tarifas que simular.</p>`; return; }
  const cheapest = projected ? bills[0].projected_total : bills[0].total;
  const myId = settings()?.my_tariff_id || "";

  grid.innerHTML = bills.map((bill, i) => {
    const total = projected ? bill.projected_total : bill.total;
    const extra = total - cheapest;
    const open = bill.tariff_id === openBillId;
    const mine = bill.tariff_id === myId;
    const color = esc(bill.color || "#4d7cba");
    const s = bill.subtotals;
    const shown = projected ? bill.projected : bill;
    const co = [bill.company, bill.energy_type === "pvpc" ? "PVPC" : null,
      `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 })
        .format(shown?.days ?? bill.days ?? 0)} días`].filter(Boolean).join(" · ");
    const sub = i === 0
      ? `${fmtEUR.format(projected ? bill.total : bill.projected_total)} ${projected ? "acumulado" : "proyectado"}`
      : `+${fmtEUR.format(extra)} vs. la mejor`;

    const rows = [
      ["Término de energía", s.energy], ["Término de potencia", s.power],
      ["Cargos y servicios", s.charges + s.services],
      bill.surplus_credit > 0 ? ["Compensación de excedentes", -bill.surplus_credit] : null,
      ["Impuestos", s.taxes],
    ].filter(Boolean).map(([label, v]) =>
      `<div class="tf-row"><span>${label}</span><b class="${v < 0 ? "neg" : ""}">${
        v < 0 ? "−" : ""}${fmtEUR.format(Math.abs(v))}</b></div>`).join("");
    const wallet = shown && shown.wallet_credit > 0
      ? `<div class="tf-row"><span>🔋 Monedero de excedentes</span><b class="neg">+${fmtEUR.format(shown.wallet_credit)}</b></div>` : "";

    return `
    <div class="tf ${open ? "open" : ""}" data-tf="${esc(bill.tariff_id)}" style="--tfc:${color}">
      ${i === 0 ? `<span class="tf-float best">MÁS BARATA</span>` : ""}
      ${mine ? `<span class="tf-float mine">LA MÍA</span>` : ""}
      <div class="tf-head">
        <span class="tf-bar"></span>
        <div class="tf-id">
          <div class="tf-name">${esc(bill.name || "Tarifa")}</div>
          <div class="tf-co">${esc(co)}</div>
        </div>
        <div class="tf-tot">
          <div class="tf-eur">${fmtEUR.format(total)}</div>
          <div class="tf-sub ${i === 0 ? "" : "worse"}">${sub}</div>
        </div>
      </div>
      ${open ? `<div class="tf-more">
        ${rows}${wallet}
        ${bill.warning ? `<div class="tf-warn">⚠ ${esc(bill.warning)}</div>` : ""}
        <div class="tf-actions">
          <button class="tf-btn" data-bill="${esc(bill.tariff_id)}">Ver la factura</button>
          <button class="tf-btn ${mine ? "on" : ""}" data-mine="${esc(bill.tariff_id)}">${
            mine ? "✓ Es la mía" : "Marcarla como mía"}</button>
        </div>
      </div>` : ""}
    </div>`;
  }).join("");

  grid.querySelectorAll(".tf").forEach((card) =>
    card.addEventListener("click", () => {
      const id = card.dataset.tf;
      openBillId = openBillId === id ? null : id;
      renderBills(simulation);
    }));
  grid.querySelectorAll("[data-bill]").forEach((b) =>
    b.addEventListener("click", (ev) => { ev.stopPropagation(); openBillDetail(b.dataset.bill); }));
  grid.querySelectorAll("[data-mine]").forEach((b) =>
    b.addEventListener("click", (ev) => { ev.stopPropagation(); setMyTariff(b.dataset.mine); }));
}

/* Marca (o desmarca, tocando la que ya lo es) la tarifa contratada. La
   comparativa no cambia con esto: solo existe para poder decir cuánto te has
   ahorrado hoy en euros, en el cierre del día. */
async function setMyTariff(tariffId) {
  const current = settings()?.my_tariff_id || "";
  const next = current === tariffId ? "" : tariffId;
  await api("settings", { method: "PUT", body: JSON.stringify({ my_tariff_id: next }) });
  // Recargar la configuración anuncia «config», y con eso la lista de tarifas
  // se repinta sola: aquí no hace falta saber que esa lista existe.
  await reloadConfig();
}

function openBillDetail(tariffId) {
  const bill = simulation.bills.find((b) => b.tariff_id === tariffId);
  if (!bill) return;
  const shown = projection ? bill.projected : bill;
  $("#bill-modal-title").textContent =
    `${bill.name} · ${projection ? "proyección" : "acumulado"}`;
  const groups = [["power", "Término de potencia"], ["energy", "Término de energía"],
    ["charges", "Cargos e impuesto eléctrico"], ["services", "Servicios"], ["vat", "IVA"]];
  let rows = "";
  for (const [key, label] of groups) {
    const lines = shown.lines.filter((l) => l.group === key);
    if (!lines.length) continue;
    rows += `<tr class="group-row"><td colspan="2">${label}</td></tr>`;
    rows += lines.map((l) =>
      `<tr><td>${esc(l.concept)}<div class="detail">${esc(l.detail)}</div></td><td class="${
        l.amount < 0 ? "credit" : ""}">${fmtEUR.format(l.amount)}</td></tr>`).join("");
  }
  rows += `<tr class="total-row"><td>TOTAL (${fmtNum.format(shown.days)} días · ${fmtNum.format(shown.kwh_total)} kWh)</td><td>${fmtEUR.format(shown.total)}</td></tr>`;
  let extra = "";
  if (shown.wallet_credit > 0) {
    extra = `<tr class="group-row"><td colspan="2">Aparte — no afecta al total</td></tr>
      <tr><td>🔋 Monedero / batería virtual<div class="detail">excedentes por encima del tope legal, acumulados como saldo</div></td><td>+${fmtEUR.format(shown.wallet_credit)}</td></tr>`;
  } else if (shown.surplus_lost > 0) {
    extra = `<tr class="group-row"><td colspan="2">Informativo</td></tr>
      <tr><td>Excedente no compensado<div class="detail">valor vertido por encima del tope legal que se pierde</div></td><td>${fmtEUR.format(shown.surplus_lost)}</td></tr>`;
  }
  $("#bill-modal-body").innerHTML = `<table class="table">${rows}${extra}</table>`;
  $("#bill-modal").classList.remove("hidden");
}

function renderDailyChart(daily) {
  const c = $("#daily-chart");
  if (!daily || !daily.length) { c.innerHTML = `<p class="empty">Sin datos.</p>`; return; }
  const bars = ensureBars(c, 220);
  bars.data = {
    labels: daily.map((d) => d.date.slice(8)),
    stack: [
      { key: "valle", label: "Valle", values: daily.map((d) => d.valle) },
      { key: "llano", label: "Llano", values: daily.map((d) => d.llano) },
      { key: "punta", label: "Punta", values: daily.map((d) => d.punta) },
    ],
    side: [],
    unit: "kWh",
  };
  bars.onread = "daily-chart";
  renderReadout("daily-chart", null, "Toca un día para ver su reparto");
}

/* ------------- periodo de trabajo ------------- */

async function applyCustomPeriod() {
  const s = $("#cp-start").value, e = $("#cp-end").value;
  const err = $("#cp-error");
  err.textContent = "";
  if (!s || !e) { err.textContent = "Indica inicio y fin."; return; }
  if (s >= e) { err.textContent = "El inicio debe ser anterior al fin."; return; }
  try {
    await api("settings", { method: "PUT", body: JSON.stringify({ working_period: { start: s, end: e } }) });
    await reloadConfig();
    emit("datos");
  } catch (e2) { err.textContent = e2.message; }
}

async function clearCustomPeriod() {
  try {
    await api("settings", { method: "PUT", body: JSON.stringify({ working_period: null }) });
    await reloadConfig();
    emit("datos");
  } catch (_) { /* noop */ }
}

function prefillCustom() {
  const wp = workingPeriod();
  if (wp) { $("#cp-start").value = wp.start; $("#cp-end").value = wp.end; return; }
  if (simulation?.period) {
    $("#cp-start").value = simulation.period.start.slice(0, 10);
    const [y, m, d] = simulation.period.end.slice(0, 10).split("-").map(Number);
    $("#cp-end").value = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  }
}

/* ------------- controles ------------- */

$("#prev-cycle").addEventListener("click", () => { cyclesBack += 1; loadSimulation(); });
$("#next-cycle").addEventListener("click", () => { if (cyclesBack > 0) { cyclesBack -= 1; loadSimulation(); } });
$("#refresh-btn").addEventListener("click", loadSimulation);
$("#projection-toggle").addEventListener("change", (e) => {
  projection = e.target.checked;
  if (simulation) renderBills(simulation);
});
$("#goto-settings").addEventListener("click", (e) => { e.preventDefault(); showView("settings"); });
$("#close-bill-modal").addEventListener("click", () => $("#bill-modal").classList.add("hidden"));

$("#cp-toggle").addEventListener("click", () => {
  const p = $("#custom-period");
  p.classList.toggle("hidden");
  if (!p.classList.contains("hidden")) prefillCustom();
});
$("#cp-apply").addEventListener("click", applyCustomPeriod);
$("#cp-clear").addEventListener("click", () => { $("#cp-error").textContent = ""; clearCustomPeriod(); });

/* ------------- lo que Facturación escucha ------------- */

on("vista", ({ name }) => {
  if (name !== "billing") return;
  // Facturación entra siempre con una subvista activa (Simulación por
  // defecto), sin tener que pulsar su segmento.
  if (!$(".subview.active")) showSub(currentSub() || "sim");
  if (!simulation) loadSimulation();
});
on("datos", () => loadSimulation());
// La tarifa contratada y el nombre de las tarifas salen de la configuración:
// si cambia, las tarjetas se repintan con lo que ya hay, sin pedir nada.
on("config", () => { if (simulation) renderBills(simulation); });
on("tema", () => { if (simulation) renderSimulation(); });

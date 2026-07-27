/*
 * Facturación · Detalle: el consumo real del ciclo, día a día y hora a hora.
 *
 * Los cuatro gráficos son los mismos componentes que usa Energía: los dos de
 * barras apilan por tramo y los dos acumulados van sobre un eje por índice,
 * porque no corren sobre el reloj sino sobre una lista de días o de horas.
 */
import { $, $$ } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/bus.js";
import { fallo } from "../core/banner.js";
import { fmtNum, periodShort } from "../core/format.js";
import { workingPeriod } from "../core/config.js";
import { ensureBars, cumulativeChart, renderReadout } from "../core/graficos.js";

let detail = null;
let detailCyclesBack = 0;
let selectedDay = null;

export async function loadDetail() {
  const banner = $("#d-error");
  banner.classList.add("hidden");
  try {
    detail = await api(`detail?cycles_back=${detailCyclesBack}`);
    renderDetail();
  } catch (err) {
    fallo(banner, err.message, loadDetail);
  }
}

function renderDetail() {
  const d = detail;
  if (!d) return;
  const custom = !!workingPeriod();
  $("#d-period").textContent = periodShort(d.period.start, d.period.end) +
    (custom ? " · fijo" : d.period.is_current ? " · actual" : "");
  $("#d-prev").disabled = custom;
  $("#d-next").disabled = custom || detailCyclesBack === 0;

  const t = d.totals;
  const tile = (l, v, s, cls = "") =>
    `<div class="stat glass ${cls}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const pct = (p, tot) => (tot ? `${Math.round((p / tot) * 100)}% del total` : "0%");
  let tiles = tile("Importada", `${fmtNum.format(t.import)} kWh`, "compara con tu sensor");
  if (d.has_export || t.export > 0) tiles += tile("Exportada", `${fmtNum.format(t.export)} kWh`, "energía vertida", "export");
  tiles += tile("Punta", `${fmtNum.format(t.punta)} kWh`, pct(t.punta, t.import), "punta");
  tiles += tile("Llano", `${fmtNum.format(t.llano)} kWh`, pct(t.llano, t.import), "llano");
  tiles += tile("Valle", `${fmtNum.format(t.valle)} kWh`, pct(t.valle, t.import), "valle");
  $("#d-stats").innerHTML = tiles;

  // La leyenda de vertido solo si hay vertido: prometer un color que no
  // aparece en ninguna barra hace dudar de si falta un dato o no hay ninguno.
  const hasExport = d.has_export || t.export > 0;
  $$(".leg-export").forEach((el) => el.classList.toggle("hidden", !hasExport));

  renderDailyDetail(d.days);
  renderMonthlyCumulative(d.days);
  if (selectedDay && d.days.some((x) => x.date === selectedDay)) renderHourly(selectedDay);
  else { selectedDay = null; $("#d-hourly-wrap").classList.add("hidden"); }
}

function renderDailyDetail(days) {
  const c = $("#d-daily");
  if (!days || !days.length) { c.innerHTML = `<p class="empty">Sin datos.</p>`; return; }
  const bars = ensureBars(c, 240);
  bars.data = {
    labels: days.map((d) => d.date.slice(8)),
    // El orden es el de apilado, de abajo arriba.
    stack: [
      { key: "valle", label: "Valle", values: days.map((d) => d.valle) },
      { key: "llano", label: "Llano", values: days.map((d) => d.llano) },
      { key: "punta", label: "Punta", values: days.map((d) => d.punta) },
    ],
    side: [{ key: "exp", label: "Exportada", values: days.map((d) => d.export) }],
    unit: "kWh",
    selected: days.findIndex((d) => d.date === selectedDay),
  };
  bars.onread = "d-daily";
  bars.onpick = (i) => selectDay(days[i].date);
  renderReadout("d-daily", null, "Toca un día para ver su reparto");
}

function renderMonthlyCumulative(days) {
  let ci = 0, ce = 0;
  cumulativeChart($("#d-cum-month"), days.map((d) => {
    ci += d.import; ce += d.export;
    return { label: d.date.slice(8), import: ci, export: ce };
  }));
}

function selectDay(date) {
  selectedDay = date;
  renderDailyDetail(detail.days);
  renderHourly(date);
  $("#d-hourly-wrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderHourly(date) {
  const d = detail;
  const map = {};
  d.hours.filter((h) => h.date === date).forEach((h) => (map[h.hour] = h));
  const hours = Array.from({ length: 24 }, (_, hh) => map[hh] || { hour: hh, kwh: 0, export: 0, period: null });
  $("#d-hourly-wrap").classList.remove("hidden");
  const [y, m, dd] = date.split("-").map(Number);
  $("#d-hourly-title").textContent = "Desglose por horas · " +
    new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

  // Cada hora cae en un tramo de la tarifa, así que en vez de apilar tres
  // series se apila una sola por tramo: la hora aporta a la suya y cero a las
  // demás. Así la barra sale del color de su periodo y el cursor sigue diciendo
  // a qué tramo pertenece.
  const TRAMOS = ["punta", "llano", "valle"];
  const bars = ensureBars($("#d-hourly"), 200);
  bars.data = {
    labels: hours.map((h) => String(h.hour)),
    stack: TRAMOS.map((t) => ({
      key: t, label: t[0].toUpperCase() + t.slice(1),
      values: hours.map((h) => (h.period === t ? h.kwh : 0)),
    })).concat([{
      key: "ink-3", label: "Sin periodo",
      values: hours.map((h) => (h.period ? 0 : h.kwh)),
    }]),
    side: [{ key: "exp", label: "Exportada", values: hours.map((h) => h.export) }],
    unit: "kWh",
  };
  bars.onread = "d-hourly";
  renderReadout("d-hourly", null, "Toca una hora para ver sus valores");

  let ci = 0, ce = 0;
  cumulativeChart($("#d-cum-day"), hours.map((h) => {
    ci += h.kwh; ce += h.export;
    return { label: String(h.hour), import: ci, export: ce };
  }));

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "—");
  $("#d-hourly-table").innerHTML =
    `<tr class="group-row"><td>Hora</td><td>Periodo</td><td>Importada</td><td>Exportada</td></tr>` +
    hours.map((h) => `<tr><td>${String(h.hour).padStart(2, "0")}:00</td><td>${cap(h.period)}</td><td>${fmtNum.format(h.kwh)} kWh</td><td>${fmtNum.format(h.export)} kWh</td></tr>`).join("");
}

/* ------------- controles ------------- */

$("#d-prev").addEventListener("click", () => { detailCyclesBack += 1; selectedDay = null; loadDetail(); });
$("#d-next").addEventListener("click", () => {
  if (detailCyclesBack > 0) { detailCyclesBack -= 1; selectedDay = null; loadDetail(); }
});
$("#d-refresh").addEventListener("click", loadDetail);

/* ------------- lo que el Detalle escucha ------------- */

on("subvista", ({ name }) => { if (name === "detail" && !detail) loadDetail(); });
// Solo se recarga si ya se había abierto: pedir el detalle de un ciclo que
// nadie está mirando es una petición cara y para nada.
on("datos", () => { if (detail) loadDetail(); });
on("tema", () => { if (detail) renderDetail(); });

/* El refresco periódico de Facturación necesita saber si el detalle está a la
   vista; es lo único que este módulo enseña fuera. */
export function detailVisible() {
  return !!detail && $("#sub-detail").classList.contains("active");
}

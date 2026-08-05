/*
 * Facturación · Simulación: qué te costaría el ciclo con cada tarifa, la
 * factura desglosada y el periodo de trabajo.
 */
import { $, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on, emit } from "../core/bus.js";
import { fallo } from "../core/banner.js";
import { fmtEUR, fmtNum, fmtDay, periodShort, dur } from "../core/format.js";
import { settings, workingPeriod, reloadConfig } from "../core/config.js";
import { ensureBars, renderReadout } from "../core/graficos.js";
import { showView, showSub, currentSub } from "../core/nav.js";
import { SUM_COLORS } from "../core/colors.js";

let simulation = null;
let breakdown = null;
let openSplitId = null;
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

/* ------------- quién se ha gastado la factura ------------- */

/* Va en su propia petición y no en la comparativa: pide los contadores del ciclo
   por horas y la potencia por horas de cada aparato, y la lista de tarifas —que es
   lo primero que se ve al entrar— no tiene por qué esperar eso. */
async function loadBreakdown() {
  $("#split-rows").innerHTML =
    `<p class="empty">Repartiendo el ciclo hora a hora…</p>`;
  $("#split-note").textContent = "";
  $("#split-sub").textContent = "";
  try {
    breakdown = await api(`breakdown?cycles_back=${cyclesBack}`);
    renderBreakdown();
  } catch (err) {
    breakdown = null;
    // Sin desglose la pantalla sigue sirviendo: la comparativa está arriba. Se
    // dice qué ha fallado en su tarjeta y no en el banner de la pantalla.
    $("#split-rows").innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

/* Una fila: icono, nombre, la barra de origen y lo que cuesta. La barra es la
   misma que en la Home —sol, batería y red con los colores de las series— porque
   es la misma pregunta: de dónde salió esa energía.

   El ancho de la barra son **kWh**, y no euros. Se probaron los euros, que era lo
   que parecía pedir la pantalla, y se leen mal: un horno que gasta 8,8 kWh de sol
   cuesta 0,00 €, y con la barra en euros salía un muñón de tres píxeles al lado de
   un coche de 4,8 kWh. El ojo lee el muñón como «no ha gastado nada», que es lo
   contrario de lo que pasó. Con la barra en energía la fila cuenta la historia
   entera: barra larga y ámbar, cero euros. Eso es justo el consejo de toda la
   aplicación, y el dinero está a la derecha, donde se compara mejor de todos
   modos porque va en columna. */
function filaDelReparto(f, maxKwh) {
  const partes = [
    ["from_solar", f.sun_kwh || 0], ["from_battery", f.battery_kwh || 0],
    ["from_grid", f.grid_kwh || 0],
  ];
  const suma = partes.reduce((a, [, v]) => a + v, 0);
  const trozos = suma <= 0 ? "" : partes
    .filter(([, v]) => v / suma >= 0.002)
    .map(([k, v]) => `<i style="width:${((v / suma) * 100).toFixed(1)}%;background:${
      SUM_COLORS[k]}" title="${esc(`${fmtNum.format(v)} kWh`)}"></i>`).join("");
  const peso = maxKwh > 0 ? f.kwh / maxKwh : 0;
  // Y el porcentaje sí es del dinero, que es la pregunta del título. Con la barra
  // en energía las dos cosas no se confunden: una está en el renglón y la otra al
  // lado del nombre.
  const pct = f.eur != null && breakdown?.detail?.eur
    ? Math.round((f.eur / breakdown.detail.eur) * 100) : null;
  const abierta = f.id === openSplitId && f.detail && f.detail.days;
  return `
    <div class="sp-row${abierta ? " open" : ""}" data-kind="${esc(f.kind)}"
         data-id="${esc(f.id)}"${f.detail && f.detail.days ? ' data-abre="1"' : ""}>
      <span class="ad-chip"${f.color ? ` style="--ap:${esc(f.color)}"` : ""}>
        <svg class="i"><use href="#i-${esc(f.icon)}"/></svg>
      </span>
      <div class="sp-mid">
        <div class="sp-name">${esc(f.name)}${
          pct != null ? `<span class="sp-pct">${pct}%</span>` : ""}</div>
        <span class="sp-barra" style="width:${Math.max(3, peso * 100).toFixed(0)}%">${trozos}</span>
      </div>
      <div class="sp-num">
        <b>${f.eur == null ? "—" : fmtEUR.format(f.eur)}</b>
        <span>${fmtNum.format(f.kwh)} kWh</span>
      </div>
    </div>
    ${abierta ? detalleDeFila(f) : ""}`;
}

/* Lo que la suma del mes esconde. Una fila que dice «7,2 kWh · 1,19 €» no deja hacer
   nada con la información: lo que se puede cambiar es **la hora**, y eso solo se ve
   abriéndola.

   La tira de 24 barras es la pieza que da el consejo sin escribirlo: un lavavajillas
   con todo su bulto en la banda de la noche se ve de un vistazo, y en el total del mes
   no se veía. Y cada barra va partida por origen —lo que no hubo que comprar en ámbar,
   lo comprado en azul— porque el «cuándo» sin el «a qué precio» es media respuesta:
   dos barras iguales a las 13 y a las 22 no cuestan lo mismo. */
function detalleDeFila(f) {
  const d = f.detail;
  const max = Math.max(...d.by_hour, 0.0001);
  // No se pinta con la ventana de hoy, que sería otro día: se pinta con **de dónde
  // salió lo de esa hora**, que es lo que el reparto de ese mes ya sabe.
  const libre = d.free_by_hour || [];
  const barras = d.by_hour.map((v, h) => {
    const alto = Math.max(v > 0 ? 8 : 0, (v / max) * 100);
    const gratis = v > 0 ? Math.min(100, ((libre[h] || 0) / v) * 100) : 0;
    return `<i style="height:${alto.toFixed(0)}%" title="${esc(
      `${h}:00 · ${fmtNum.format(v)} kWh${gratis >= 1
        ? ` · ${Math.round(gratis)} % sin comprar` : ""}`)}"
      ><u style="height:${gratis.toFixed(0)}%"></u></i>`;
  }).join("");
  const peor = d.worst_day;
  // «Ciclos» solo cuando lo son. Con las estadísticas de Home Assistant la resolución
  // es la hora y lo que se cuenta son tramos; con InfluxDB, que guarda meses de datos
  // finos, son ciclos de verdad y entonces se puede decir además lo que suele durar
  // uno. Llamarlos igual en los dos casos sería prometer con unos datos lo que solo
  // sostienen los otros.
  const conCiclos = d.cycles != null;
  const cuantos = conCiclos ? d.cycles : d.runs;
  const tramos = conCiclos
    ? `${cuantos} ${cuantos === 1 ? "ciclo" : "ciclos"}${
        d.median_h ? ` de ${dur(d.median_h)} de media` : ""}`
    : `${cuantos} ${cuantos === 1 ? "tramo" : "tramos"}`;
  return `
    <div class="sp-det">
      <div class="sp-det-l">
        Se usó <b>${d.days} ${d.days === 1 ? "día" : "días"}</b>, en ${tramos}${
          peor ? ` · el más caro fue el <b>${esc(fmtDay(peor.date, false))}</b>${
            peor.eur == null ? "" : ` (${fmtEUR.format(peor.eur)})`}` : ""}.
      </div>
      <div class="sp-horas" role="img" aria-label="Consumo por hora del día">${barras}</div>
      <div class="sp-det-x"><span>0 h</span><span>12 h</span><span>23 h</span></div>
      <div class="sp-det-k"><i class="k-libre"></i>sol o batería
        <i class="k-red"></i>comprado</div>
      <p class="sp-det-n">${conCiclos
        ? `Ciclos contados uno a uno en <b>InfluxDB</b>, con paso de cuarto de hora.`
        : `Un <b>tramo</b> son horas seguidas con consumo, no un ciclo: con las
           estadísticas de Home Assistant la resolución de un mes entero es la hora, así
           que dos lavados en la misma hora son un tramo. Con <b>InfluxDB</b> configurado
           se cuentan los ciclos de verdad.`}</p>
    </div>`;
}

function renderBreakdown() {
  const b = breakdown;
  const caja = $("#split-rows");
  if (!b) return;
  if (!b.appliances) {
    caja.innerHTML = `<p class="empty">Sin electrodomésticos medidos no hay a quién
      repartir la factura. Se añaden en Ajustes → Electrodomésticos, con su sensor
      de potencia.</p>`;
    $("#split-sub").textContent = "";
    return;
  }
  const d = b.detail;
  if (!d || !d.rows.length) {
    caja.innerHTML = `<p class="empty">No hay estadísticas horarias del ciclo con
      las que repartirlo.</p>`;
    return;
  }
  const maxKwh = Math.max(...d.rows.map((f) => f.kwh || 0));
  caja.innerHTML = d.rows.map((f) => filaDelReparto(f, maxKwh)).join("");
  // Se abre una a la vez, como las tarjetas de tarifa de arriba: dos abiertas dejan la
  // pantalla en una lista de tiras que no se comparan entre sí.
  caja.querySelectorAll("[data-abre]").forEach((fila) =>
    fila.addEventListener("click", () => {
      openSplitId = openSplitId === fila.dataset.id ? null : fila.dataset.id;
      renderBreakdown();
    }));

  // El encabezado dice de qué tarifa son los euros, porque un precio por hora es
  // de una tarifa y no de todas.
  $("#split-sub").innerHTML = b.tariff
    ? `Al precio de <b>${esc(b.tariff.name)}</b> hora a hora · término de energía
       ${d.eur == null ? "" : `<b>${fmtEUR.format(d.eur)}</b>`}`
    : `Marca una tarifa como <b>«la mía»</b> arriba y esto se pone en euros. Sin
       ella se enseña la energía y de dónde salió.`;

  const notas = [];
  if (b.pvpc_error) notas.push(`Sin precios PVPC: ${esc(b.pvpc_error)}`);
  if (d.trimmed_kwh > 0) {
    notas.push(`Se han recortado ${fmtNum.format(d.trimmed_kwh)} kWh en las horas en
      que los enchufes sumaban más que el contador de la casa.`);
  }
  const sin = d.rows.find((f) => f.kind === "descuadre");
  if (sin) {
    notas.push(`«Sin asignar» es energía comprada que el reparto no pudo colocar:
      el contador de la casa marca menos de lo que la red le entregó.`);
  }
  notas.push(`Repartido sobre las ${d.hours} horas del ciclo con datos, cada una a
    su precio y cobrando solo lo que salió de la red: lo que puso el sol no cuesta.
    Las filas suman los ${fmtNum.format(d.imported_kwh)} kWh importados.`);
  $("#split-note").innerHTML = notas.join(" ");
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
    const shown = projected ? bill.projected : bill;
    // Los subtotales **de lo que se está enseñando**, no siempre los del acumulado.
    // Con la proyección puesta, el titular era la factura proyectada y las líneas de
    // debajo el acumulado, sin decirlo: cuatro cifras que no suman a la quinta en la
    // misma tarjeta. Y era la explicación más probable de un aviso —«el término de
    // energía no coincide con el importe que aparece en el desglose»—, porque el
    // desglose por electrodoméstico es siempre del periodo transcurrido.
    const s = shown.subtotals || bill.subtotals;
    const co = [bill.company, bill.energy_type === "pvpc" ? "PVPC" : null,
      `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 })
        .format(shown?.days ?? bill.days ?? 0)} días`].filter(Boolean).join(" · ");
    const sub = i === 0
      ? `${fmtEUR.format(projected ? bill.total : bill.projected_total)} ${projected ? "acumulado" : "proyectado"}`
      : `+${fmtEUR.format(extra)} vs. la mejor`;

    // Las cinco líneas son **disjuntas y suman el total**. Antes no: el término de
    // energía venía ya con los excedentes descontados y debajo se restaban otra vez,
    // y el impuesto eléctrico estaba a la vez en «Cargos» y en «Impuestos». Los dos
    // errores tiraban en direcciones contrarias, así que la suma quedaba plausible y
    // ninguno se veía — hasta que alguien comparó esta tarjeta con el detalle, donde
    // los conceptos sí estaban separados.
    //
    // Y el excedente sale de `s`, no de `bill`: con la proyección puesta tiene que ser
    // el proyectado, como las demás líneas.
    const rows = [
      ["Término de energía", s.energy], ["Término de potencia", s.power],
      ["Cargos y servicios", s.charges + s.services],
      s.surplus > 0 ? ["Compensación de excedentes", -s.surplus] : null,
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

$("#prev-cycle").addEventListener("click", () => { cyclesBack += 1; recargar(); });
$("#next-cycle").addEventListener("click", () => { if (cyclesBack > 0) { cyclesBack -= 1; recargar(); } });
$("#refresh-btn").addEventListener("click", recargar);
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
  // El desglose se pide **al entrar** y no en el arranque, que es donde se pide
  // la comparativa: son dos consultas más —los contadores del ciclo por horas y
  // la potencia por horas de cada aparato— y arrancar la aplicación en la Home no
  // tiene por qué pagarlas. Y va por su cuenta y no colgado de `simulation`,
  // porque el arranque ya deja la comparativa cargada: comprobar esa sí dejaba el
  // desglose sin pedir nunca.
  if (!breakdown) loadBreakdown();
});
on("datos", () => recargar());
// La tarifa contratada y el nombre de las tarifas salen de la configuración:
// si cambia, las tarjetas se repintan con lo que ya hay, sin pedir nada.
let miTarifa = null;
on("config", () => {
  if (simulation) renderBills(simulation);
  // El desglose sí hay que volver a pedirlo: sus euros son los precios hora a
  // hora de **esa** tarifa, así que con otra marcada son otros.
  const ahora = settings()?.my_tariff_id || "";
  if (breakdown && ahora !== miTarifa) { miTarifa = ahora; loadBreakdown(); }
});
on("tema", () => {
  if (simulation) renderSimulation();
  if (breakdown) renderBreakdown();
});

/* Las dos peticiones de la pantalla, en el orden en que se miran: primero la
   comparativa, que es lo que se ve al entrar, y el desglose detrás. */
async function recargar() {
  miTarifa = settings()?.my_tariff_id || "";
  await loadSimulation();
  await loadBreakdown();
}

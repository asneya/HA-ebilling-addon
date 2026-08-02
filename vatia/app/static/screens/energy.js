/*
 * Energía: el gráfico de análisis, con sus rangos, sus vistas, su leyenda
 * pulsable y su zoom.
 *
 * El dibujo lo hace <vatia-chart> sobre uPlot; aquí están los controles, el
 * estado de lo que se está mirando y la leyenda.
 */
import { $, $$, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/bus.js";
import { fallo } from "../core/banner.js";
import { fmtNum, fmtValue, xLabel, stampLabel } from "../core/format.js";
import { seriesColor, colorForSeries, isLightColor } from "../core/colors.js";
import { renderReadout } from "../core/graficos.js";
import { recolocar } from "../core/pulsado.js";

const eState = {
  range: "day",
  view: "overview",
  offset: 0,
  data: null,
  hidden: new Set(),
  cursor: null,
  hover: null,    // punto bajo el dedo, sin fijar
  zoomed: false,  // el eje no está al completo
};
const E_ZOOM_MAX = 12;
const SOC_PISTA = "Toca el gráfico para ver la carga de un momento";

async function loadEnergy() {
  const banner = $("#e-error");
  banner.classList.add("hidden");
  // El esqueleto sustituye al gráfico mientras carga —no se pone encima— para
  // que no se vea el gráfico anterior debajo de una capa: sería el dato de otro
  // periodo, y eso es peor que un hueco.
  const primero = !eState.data;
  const abortar = new AbortController();
  mostrarEsqueleto(true, abortar);
  try {
    eState.data = await api(
      `series?view=${eState.view}&range=${eState.range}&offset=${eState.offset}`,
      { signal: abortar.signal },
    );
    // Al entrar en un gráfico todas las series están visibles y sin punto
    // seleccionado: se muestran los totales del periodo.
    eState.hidden.clear();
    eState.cursor = null;
    renderEnergy();
  } catch (err) {
    // Cancelar es una decisión, no un fallo: no se enseña un aviso rojo por
    // haber pulsado «Cancelar». Se deja lo que hubiera, o el hueco si era la
    // primera carga.
    if (err.name === "AbortError") {
      if (primero) $("#e-empty").classList.remove("hidden");
      else renderEnergy();
      return;
    }
    fallo(banner, err.message, loadEnergy);
    $("#e-chart").innerHTML = "";
  } finally {
    mostrarEsqueleto(false);
  }
}

/* El esqueleto de carga. Se crea al mostrarlo y se destruye al ocultarlo: así
   su reloj de los 8 s y su observador de visibilidad se van con él, sin dejar
   nada animándose detrás. */
function mostrarEsqueleto(encendido, abortar) {
  const hueco = $("#e-skel");
  hueco.classList.toggle("hidden", !encendido);
  $(".e-chart-wrap").classList.toggle("hidden", encendido);
  $(".e-zoom-hint").classList.toggle("hidden", encendido);
  if (!encendido) { hueco.textContent = ""; return; }
  $("#e-empty").classList.add("hidden");
  hueco.textContent = "";
  const skel = document.createElement("vatia-skeleton");
  skel.shape = "chart";
  skel.label = "Leyendo estadísticas del recorder…";
  skel.addEventListener("cancel", () => abortar && abortar.abort());
  hueco.appendChild(skel);
}

function renderEnergy() {
  const d = eState.data;
  if (!d) return;
  $("#e-label").textContent = d.label;
  $("#e-next").disabled = !d.can_next;
  $("#e-unit").textContent = d.unit;
  $$(".seg[data-range]").forEach((s) => s.classList.toggle("active", s.dataset.range === eState.range));
  $$(".vt").forEach((v) => v.classList.toggle("active", v.dataset.eview === eState.view));
  // La marca la acaba de poner esta función; la píldora, la de al lado. Al
  // pulsar ya se movieron las dos —eso es lo que da el acuse instantáneo— y
  // esto solo las confirma, o las corrige si la carga acabó en otro sitio.
  recolocar();
  syncPeriodPicker();
  syncZoomControls();

  const hasData = d.x.length && d.series.some((s) => s.values.some((v) => v != null));
  $("#e-empty").classList.toggle("hidden", !!hasData);
  $(".e-chart-wrap").classList.toggle("hidden", !hasData);
  $(".e-zoom-hint").classList.toggle("hidden", !hasData);

  renderStamp();
  renderEnergyLegend();
  if (hasData) renderEnergyChart();
  renderSoc();
  renderEnergyBreakdown();
}

/* El estado de carga, en su propio gráfico debajo del de potencia.
   Solo en la vista de batería, y solo si el sensor tiene datos: sin él la
   tarjeta entera se esconde, que es mejor que un hueco con un eje vacío. */
function renderSoc() {
  const soc = eState.data && eState.data.soc;
  $("#e-soc-panel").classList.toggle("hidden", !soc);
  if (!soc) return;
  $("#e-soc-last").textContent = fmtNum.format(soc.last);
  $("#e-soc-meta").textContent =
    `mínimo ${fmtNum.format(soc.min)} % · máximo ${fmtNum.format(soc.max)} % · media ${fmtNum.format(soc.avg)} %`;
  const box = $("#e-soc");
  box.colorFor = colorForSeries;
  box.formatX = (ms) => xLabel(new Date(ms).toISOString(), eState.range);
  box.height = 150;
  // De 0 a 100 siempre: si el eje se ajustara al recorrido del día, la misma
  // batería parecería vaciarse más un día que otro.
  box.yRange = [0, 100];
  box.data = { x: eState.data.x, series: soc.series };
  renderReadout("e-soc", null, SOC_PISTA);
}

/* El punto que está mandando en la leyenda: el fijado o, si no hay, el que
   tenga el dedo o el ratón encima. */
function puntoMostrado() {
  return eState.cursor != null ? eState.cursor : eState.hover;
}

/* Marca de tiempo y salida a los totales.
   «Totales» sale con cualquier punto a la vista, fijado o no. Antes solo con el
   fijado, y en el móvil eso dejaba sin salida: al levantar el dedo no hay
   `mouseleave` que devuelva el cursor, así que la leyenda se quedaba con los
   valores del instante y no había forma de volver a los totales del periodo. */
function renderStamp() {
  const d = eState.data;
  const idx = puntoMostrado();
  const enPunto = idx != null && d && d.x[idx];
  $("#e-stamp").textContent = enPunto ? stampLabel(d.x[idx], eState.range)
    : (d ? d.label : "—");
  $("#e-clear").classList.toggle("hidden", !enPunto);
}

/* Suelta el punto y vuelve a los totales del periodo. */
function volverATotales() {
  eState.cursor = null;
  eState.hover = null;
  const box = $("#e-chart");
  if (box) box.picked = null;
  renderStamp();
  renderEnergyLegend();
}

function renderEnergyLegend() {
  const d = eState.data;
  const idx = puntoMostrado();
  // El forecast no tiene leyenda (legend === false).
  const shown = d.series.filter((s) => s.legend !== false);
  $("#e-legend").innerHTML = shown.map((s) => {
    const off = eState.hidden.has(s.key);
    // Con punto seleccionado se muestra su valor instantáneo; si no, el total
    // de energía del periodo para esa serie.
    const value = idx != null
      ? fmtValue(s.values[idx], d.unit)
      : fmtValue(s.total, s.total_unit || d.unit);
    return `
      <button class="e-serie ${off ? "off" : ""}" data-serie="${esc(s.key)}"
              aria-pressed="${!off}" title="Mostrar u ocultar ${esc(s.label)}">
        <span class="n">${esc(s.label)}</span>
        <span class="v">
          <span class="check ${isLightColor(seriesColor(s.key)) ? "on-light" : ""}"
                style="background:${esc(seriesColor(s.key))}">${off ? "" : "✓"}</span>
          <span class="num">${value}</span>
        </span>
      </button>`;
  }).join("");
  $$("#e-legend [data-serie]").forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.serie;
    if (eState.hidden.has(key)) eState.hidden.delete(key); else eState.hidden.add(key);
    renderEnergy();
  }));
}

/* --- Selector de periodo con controles nativos --- */

function syncPeriodPicker() {
  const d = eState.data;
  const input = $("#e-date");
  const picker = $("#e-picker");
  const enabled = eState.range !== "total";
  picker.classList.toggle("disabled", !enabled);
  input.disabled = !enabled;
  if (!enabled || !d) return;
  // El valor del control es un día del periodo mostrado; el máximo, hoy.
  input.value = (d.start || "").slice(0, 10);
  input.max = todayISO();
}

function todayISO() {
  const now = new Date();
  const p = (v) => String(v).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// Desplazamiento (en unidades del rango) entre la fecha elegida y hoy.
function offsetForDate(value, range) {
  const [y, m, dd] = value.split("-").map(Number);
  if (!y || !m || !dd) return null;
  const picked = new Date(y, m - 1, dd);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "day") {
    return Math.round((picked - today) / 86400000);
  }
  if (range === "week") {
    const monday = (dt) => {
      const out = new Date(dt);
      out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
      return out;
    };
    return Math.round((monday(picked) - monday(today)) / (7 * 86400000));
  }
  if (range === "month") {
    return (picked.getFullYear() - today.getFullYear()) * 12 + (picked.getMonth() - today.getMonth());
  }
  if (range === "year") return picked.getFullYear() - today.getFullYear();
  return 0;
}

/* --- Zoom del eje X ---
   Ya no estira el DOM: el componente mueve el rango del eje, así que aquí solo
   quedan los botones y el indicador. El factor se deduce del rango visible
   frente al total, que es la definición honesta de «cuánto estoy ampliando». */

function zoomFactor() {
  const p = $("#e-chart");
  const s = p && p._plot && p._plot.scales.x;
  const xs = p && p._plot && p._plot.data[0];
  if (!s || !xs || xs.length < 2) return 1;
  const total = xs[xs.length - 1] - xs[0];
  const visto = s.max - s.min;
  return visto > 0 ? Math.max(1, total / visto) : 1;
}

function syncZoomControls() {
  const z = zoomFactor();
  $("#e-zoom-val").textContent = `${z < 10 ? z.toFixed(1) : Math.round(z)}×`;
  $("#e-zoom-out").disabled = z <= 1.001;
  $("#e-zoom-in").disabled = z >= E_ZOOM_MAX - 0.001;
}

/* Acerca o aleja alrededor del centro de lo que se está viendo. */
function setZoom(mult) {
  const p = $("#e-chart");
  const plot = p && p._plot;
  if (!plot) return;
  const xs = plot.data[0];
  const total = xs[xs.length - 1] - xs[0];
  const s = plot.scales.x;
  const centro = (s.min + s.max) / 2;
  const medio = Math.min(total, (s.max - s.min) / mult) / 2;
  if (total / (medio * 2) > E_ZOOM_MAX) return;
  let min = centro - medio, max = centro + medio;
  // No se sale del periodo: se empuja hacia dentro en vez de dejar hueco.
  if (min < xs[0]) { max += xs[0] - min; min = xs[0]; }
  if (max > xs[xs.length - 1]) { min -= max - xs[xs.length - 1]; max = xs[xs.length - 1]; }
  plot.setScale("x", { min: Math.max(min, xs[0]), max: Math.min(max, xs[xs.length - 1]) });
  syncZoomControls();
}

function resetZoom() {
  const p = $("#e-chart");
  if (p && p.resetZoom) p.resetZoom();
}

/* El gráfico lo dibuja <vatia-chart> sobre uPlot. Aquí solo se le pasan los
   datos, los colores del tema y el formato del eje: el zoom, el cursor y el
   pellizco viven dentro. */
function renderEnergyChart() {
  const box = $("#e-chart");
  box.colorFor = colorForSeries;
  box.formatX = (ms) => xLabel(new Date(ms).toISOString(), eState.range);
  box.hidden = eState.hidden;
  box.data = eState.data;
}

function renderEnergyBreakdown() {
  const bd = eState.data.breakdown;
  const panel = $("#e-breakdown-panel");
  if (!bd || !bd.rows.length) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  $("#e-breakdown-title").textContent =
    eState.view === "solar" ? "Reparto de la generación" : "Origen del consumo";
  $("#e-bd-total").textContent = fmtNum.format(bd.total);
  $("#e-bd-unit").textContent = bd.unit;
  const total = bd.rows.reduce((s, r) => s + r.kwh, 0) || 1;
  $("#e-bd-bar").innerHTML = bd.rows.filter((r) => r.kwh > 0)
    .map((r) => `<i style="width:${(r.kwh / total) * 100}%;background:${esc(seriesColor(r.key))}"></i>`).join("");
  $("#e-bd-rows").innerHTML = bd.rows.map((r) => `
    <div class="e-bd-row">
      <div class="l" style="color:${esc(seriesColor(r.key))}">${esc(r.label)}</div>
      <div class="p">${r.pct}%</div>
      <div class="k">${fmtNum.format(r.kwh)} kWh</div>
    </div>`).join("");
}

/* ------------- controles ------------- */

$$(".seg[data-range]").forEach((b) => b.addEventListener("click", () => {
  eState.range = b.dataset.range;
  eState.offset = 0;
  resetZoom();
  loadEnergy();
}));
$$(".vt").forEach((b) => b.addEventListener("click", () => {
  eState.view = b.dataset.eview;
  resetZoom();
  loadEnergy();
}));
$("#e-prev").addEventListener("click", () => { eState.offset -= 1; loadEnergy(); });
$("#e-next").addEventListener("click", () => { if (eState.offset < 0) { eState.offset += 1; loadEnergy(); } });

// Volver a los totales del periodo tras seleccionar un punto.
$("#e-clear").addEventListener("click", volverATotales);

// Zoom del eje del tiempo.
$("#e-zoom-in").addEventListener("click", () => setZoom(1.6));
$("#e-zoom-out").addEventListener("click", () => setZoom(1 / 1.6));
$("#e-zoom-val").addEventListener("click", () => { resetZoom(); renderEnergy(); });

// Selector de periodo: control nativo de fecha.
$("#e-date").addEventListener("change", (ev) => {
  const offset = offsetForDate(ev.target.value, eState.range);
  if (offset == null || offset > 0) return;
  eState.offset = offset;
  resetZoom();
  loadEnergy();
});
$("#e-picker").addEventListener("click", () => {
  const input = $("#e-date");
  if (input.disabled) return;
  // En escritorio hay que pedir el calendario explícitamente.
  try { input.showPicker(); } catch (_) { input.focus(); }
});

/* Los gestos y el cursor los publica el componente; aquí solo se recogen. */
{
  const box = $("#e-chart");
  // Tocar o deslizar el dedo elige el punto y lo deja elegido.
  box.addEventListener("pick", (ev) => {
    eState.cursor = ev.detail.index;
    renderStamp();
    renderEnergyLegend();
  });
  // Con el ratón por encima, la leyenda sigue al cursor sin fijarlo.
  box.addEventListener("hover", (ev) => {
    if (ev.detail.index == null && eState.cursor != null) return;
    eState.hover = ev.detail.index;
    renderStamp();
    renderEnergyLegend();
  });
  // El rango del eje decide si los controles de zoom están activos.
  box.addEventListener("range", (ev) => {
    eState.zoomed = !ev.detail.full;
    syncZoomControls();
  });

  // El gráfico del estado de carga tiene su propia línea de lectura: es otra
  // magnitud y otro eje, así que no comparte cursor con el de arriba.
  const soc = $("#e-soc");
  const leerSoc = (i) => {
    const d = eState.data && eState.data.soc;
    if (!d || i == null) return null;
    const v = d.series[0].values[i];
    if (v == null) return null;
    return {
      label: stampLabel(eState.data.x[i], eState.range), unit: "%",
      rows: [{ key: "battery_soc", label: "Carga", value: v }],
    };
  };
  const pintarSoc = (ev) => {
    const i = ev.detail.index;
    const d = eState.data && eState.data.soc;
    // Un punto sin lectura —las horas del día que aún no han pasado— lo dice en
    // vez de repetir la pista, que ahí parecería que no ha respondido al dedo.
    const sinDato = !!d && i != null && d.series[0].values[i] == null;
    renderReadout("e-soc", leerSoc(i), sinDato
      ? "Sin lectura de carga a esa hora"
      : SOC_PISTA);
  };
  soc.addEventListener("hover", pintarSoc);
  soc.addEventListener("pick", pintarSoc);
}

/* ------------- lo que Energía escucha ------------- */

on("vista", ({ name }) => { if (name === "energy" && !eState.data) loadEnergy(); });
on("datos", () => { if (eState.data) loadEnergy(); });
on("tema", () => { if (eState.data) renderEnergy(); });

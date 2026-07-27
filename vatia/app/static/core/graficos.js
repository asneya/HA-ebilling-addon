/*
 * Los gráficos que comparten Facturación y su detalle: barras apiladas, líneas
 * acumuladas y la línea de lectura que dice qué hay bajo el dedo.
 *
 * Aquí solo está el pegamento entre la página y los componentes; el dibujo lo
 * hacen <vatia-bars> y <vatia-chart>, que viven en components/ sobre uPlot.
 */
import { $, esc } from "./dom.js";
import { fmtNum } from "./format.js";
import { chartColor, colorForSeries } from "./colors.js";

/* La línea de lectura de un gráfico: lo que hay bajo el dedo, con su color.
   Vacía enseña la pista de que se puede tocar, para que el hueco no parezca un
   fallo. */
export function renderReadout(id, read, pista) {
  const el = $(`#ro-${id}`);
  if (!el) return;
  if (!read || !read.rows.length) {
    el.innerHTML = `<li class="ro-hint">${esc(pista || "Toca el gráfico para ver un punto")}</li>`;
    return;
  }
  el.innerHTML = `<li class="ro-x">${esc(read.label)}</li>` + read.rows.map((r) =>
    `<li><i style="background:${esc(chartColor(r.key))}"></i>${esc(r.label)}
      <b>${esc(fmtNum.format(r.value))} ${esc(read.unit)}</b></li>`).join("");
}

/* Crea el componente una vez y lo reutiliza: rehacerlo en cada dibujado
   destruiría el lienzo y perdería el cursor. */
export function ensureBars(host, alto) {
  let el = host.querySelector("vatia-bars");
  if (!el) {
    host.textContent = "";
    el = document.createElement("vatia-bars");
    el.height = alto;
    el.colorFor = chartColor;
    el.addEventListener("pick", (ev) => {
      if (el.onread) renderReadout(el.onread, ev.detail.read);
      if (el.onpick) el.onpick(ev.detail.index);
    });
    // Al pasar el dedo, la lectura sigue al cursor sin fijar nada.
    el.addEventListener("hover", (ev) => {
      if (el.onread) renderReadout(el.onread, ev.detail.read);
    });
    host.appendChild(el);
  }
  return el;
}

function ensureLines(host, roId) {
  let el = host.querySelector("vatia-chart");
  if (!el) {
    host.textContent = "";
    el = document.createElement("vatia-chart");
    el.xMode = "index";
    el.colorFor = colorForSeries;
    // Los acumulados también dicen qué hay bajo el dedo.
    const leer = (i) => {
      const d = el.data;
      if (!d || i == null) return null;
      return {
        label: d.x[i], unit: "kWh",
        rows: d.series.map((sr) => ({ key: sr.key, label: sr.label, value: sr.values[i] || 0 }))
          .filter((r) => r.value > 0),
      };
    };
    el.addEventListener("hover", (ev) => renderReadout(roId, leer(ev.detail.index)));
    el.addEventListener("pick", (ev) => renderReadout(roId, leer(ev.detail.index)));
    host.appendChild(el);
  }
  return el;
}

/* Acumulado: dos líneas que solo crecen. Se le pasa al mismo componente que la
   pantalla de Energía, con el eje por índice. */
export function cumulativeChart(container, points) {
  if (!points || !points.length) { container.innerHTML = `<p class="empty">Sin datos.</p>`; return; }
  const last = points[points.length - 1];
  const roId = container.id;
  const el = ensureLines(container, roId);
  el.data = {
    x: points.map((p) => p.label),
    series: [
      { key: "grid_import", label: "Importada", values: points.map((p) => p.import) },
      ...(last.export > 0
        ? [{ key: "grid_export", label: "Exportada", values: points.map((p) => p.export) }]
        : []),
    ],
  };
  renderReadout(roId, null, "Toca un punto para ver el acumulado");
}

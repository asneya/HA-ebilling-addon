/*
 * Navegación: las cuatro pestañas, las subvistas de Facturación y los dos
 * niveles de Ajustes.
 *
 * No importa ninguna pantalla, y eso es lo que la hace fiable: antes esta
 * función era una escalera de `if` que llamaba a los cargadores de las cinco,
 * así que añadir una pantalla obligaba a tocar la navegación y un cambio en la
 * navegación podía romper cualquier pantalla. Ahora solo anuncia, y cada
 * pantalla decide qué hacer cuando le toca salir.
 */
import { $, $$ } from "./dom.js";
import { emit } from "./bus.js";

const donde = { view: "home", sub: null, settingsPage: null };

/* Pantallas empujadas: no tienen pestaña propia y se llega a ellas desde una
   tarjeta. Mientras se está dentro sigue encendida la pestaña que las contiene,
   que es de donde se ha venido y a donde se vuelve. */
const PESTANA_DE = { flow: "home" };

export function currentView() { return donde.view; }
export function currentSub() { return donde.sub; }

export function showView(name) {
  donde.view = name;
  document.body.dataset.view = name;
  const pestana = PESTANA_DE[name] || name;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === pestana));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  window.scrollTo({ top: 0, behavior: "smooth" });
  emit("vista", { name });
}

export function showSub(name) {
  donde.sub = name;
  $$(".seg[data-sub]").forEach((s) => s.classList.toggle("active", s.dataset.sub === name));
  $$(".subview").forEach((v) => v.classList.toggle("active", v.id === `sub-${name}`));
  emit("subvista", { name });
}

/* Ajustes por niveles: índice → categoría. */
export function showSettingsPage(page) {
  donde.settingsPage = page || null;
  $$("#view-settings .settings-page").forEach((p) => {
    p.classList.toggle("active", p.id === `sp-${page || "root"}`);
  });
  // El botón de guardar no tiene sentido en el índice, en la lista de tarifas,
  // en apariencia (el tema se aplica y se guarda al pulsarlo) ni en el
  // diagnóstico, que solo lee. Ni en «Fuente de datos» y la galería de flujos,
  // donde cada control se guarda al tocarlo: dejar ahí una barra que no hace
  // nada invita a pulsarla y a dudar de si el cambio se guardó.
  const hideSave = !page ||
    ["tariffs", "about", "diagnostics", "backup", "sensors", "source", "flows",
     "home"].includes(page);
  $("#settings-save-bar").classList.toggle("hidden", hideSave);
  $("#settings-status").textContent = "";
  window.scrollTo(0, 0);
  emit("pagina-ajustes", { page: donde.settingsPage });
}

$$(".tab").forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));
// Solo los segmentos que cambian de subvista (los del rango de Energía también
// son «.seg» y no deben tocar las subvistas de Facturación).
$$(".seg[data-sub]").forEach((seg) => seg.addEventListener("click", () => showSub(seg.dataset.sub)));
$$("[data-settings-page]").forEach((row) =>
  row.addEventListener("click", () => showSettingsPage(row.dataset.settingsPage)));
$$(".settings-back").forEach((b) =>
  b.addEventListener("click", () => showSettingsPage(null)));

/* Las hojas modales se cierran tocando fuera. Vive aquí porque no es de ninguna
   pantalla: las cinco hojas están al final del documento, fuera de las vistas. */
$$(".modal").forEach((m) =>
  m.addEventListener("click", (e) => { if (e.target === m) m.classList.add("hidden"); }));

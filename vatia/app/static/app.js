/*
 * Vatia — punto de entrada.
 *
 * Cada pantalla vive en su fichero y se registra sola al importarse: aquí solo
 * queda el arranque y el refresco periódico. La regla que sostiene el reparto
 * es que las pantallas no se llaman entre sí —se anuncian por `core/bus.js`—,
 * así que se puede leer, tocar o quitar una sin abrir las otras cuatro.
 *
 *   core/     lo que no es de nadie: DOM, red, formato, colores, navegación,
 *             tema, los gráficos que comparten dos pantallas y las cuentas del
 *             flujo, que salen en dos sitios y no pueden contradecirse
 *   screens/  las pantallas, una por fichero
 *
 * Rutas relativas en todo, para funcionar tras el Ingress de Home Assistant.
 */
import { $ } from "./core/dom.js";
import { reloadConfig } from "./core/config.js";
import { currentView } from "./core/nav.js";
import "./core/theme.js";
// Acuse de recibo instantáneo al pulsar una pestaña. Va aquí, suelto: se
// engancha al documento y ninguna pantalla tiene que saber de él.
import "./core/pulsado.js";

import { loadLive } from "./screens/home.js";
import "./screens/flow.js";
import "./screens/energy.js";
import "./screens/appliances.js";
import { loadSimulation } from "./screens/billing.js";
import { detailVisible, loadDetail } from "./screens/detail.js";
import "./screens/tariffs.js";
import "./screens/settings.js";

function hideBoot() {
  const boot = $("#boot");
  if (!boot || boot.classList.contains("done")) return;
  boot.classList.add("done");
  // Se retira del árbol al acabar la transición, para no capturar pulsaciones.
  setTimeout(() => boot.remove(), 600);
}

(async function init() {
  document.body.dataset.view = "home";
  try {
    $("#boot-text").textContent = "Cargando la configuración…";
    // Al cargarla se anuncia «config»: el tema, el fondo y la lista de tarifas
    // se ponen al día solos, sin que el arranque tenga que saber de ellos.
    await reloadConfig();
  } catch (err) {
    $("#boot-text").textContent = `No se pudo cargar la configuración: ${err.message}`;
    $("#flow-empty").textContent = `No se pudo cargar la configuración: ${err.message}`;
    $("#flow-empty").classList.remove("hidden");
    setTimeout(hideBoot, 2500);
    return;
  }
  $("#boot-text").textContent = "Leyendo los sensores…";
  await loadLive();
  hideBoot();
  loadSimulation();

  // Refresco en vivo: la Home cada 20 s, el resto cada minuto.
  setInterval(() => { if (currentView() === "home") loadLive(); }, 20000);
  // Y al volver de segundo plano, en cuanto se vuelve. Un `setInterval` no corre
  // con la aplicación dormida, así que al volver lo que se veía era la lectura de
  // hacía horas —o el hueco de la petición que iOS cortó al dormirla— hasta que
  // tocara el siguiente latido. Lo que uno quiere al volver a una aplicación de
  // tiempo real es lo de ahora, y lo quiere ya.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentView() === "home") loadLive();
  });
  setInterval(() => {
    if (currentView() !== "billing") return;
    loadSimulation();
    if (detailVisible()) loadDetail();
  }, 60000);
})();

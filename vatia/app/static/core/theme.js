/*
 * Tema, fondo y el borde de la cabecera.
 *
 * Tampoco importa ninguna pantalla: cuando el tema cambia se anuncia «tema» y
 * cada una repinta lo suyo. Lo único que hace por todas es olvidar los colores
 * memorizados y repintar los lienzos, que es genérico.
 */
import { $, $$ } from "./dom.js";
import { api } from "./api.js";
import { on, emit } from "./bus.js";
import { config, settings } from "./config.js";
import { forgetTokens } from "./colors.js";
import { guardando } from "./guardando.js";

const THEMES = { auto: "Automático", light: "Claro", dark: "Oscuro" };

function prefersDark() {
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/* El tema vive en Ajustes (servidor) y se refleja en localStorage para que el
   script de la cabecera pueda aplicarlo antes del primer pintado. «auto» se
   resuelve aquí: en el CSS `data-theme` siempre vale «light» o «dark». */
function applyTheme(pref) {
  const choice = THEMES[pref] ? pref : "auto";
  const dark = choice === "dark" || (choice !== "light" && prefersDark());
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  forgetTokens();          // los colores de las series cambian con el tema
  // Los gráficos son lienzos: hay que rehacerlos con los colores nuevos.
  $$("vatia-bars, vatia-chart").forEach((el) => el.repaint && el.repaint());
  try { localStorage.setItem("vatia-theme", choice); } catch (e) { /* modo privado */ }
  $$("#theme-seg .seg").forEach((b) => b.classList.toggle("active", b.dataset.themeOpt === choice));
  // Todo lo demás pintado a mano con colores de token lo repinta su pantalla:
  // el SVG lleva los colores en atributos y esos no los alcanza `var()`.
  emit("tema", { dark });
}

/* El tamaño del texto.
 *
 * Existe porque el ajuste del sistema **no llega** al CSS en iOS: la aplicación
 * de Home Assistant enseña Vatia en un WKWebView y el tamaño dinámico no se
 * propaga salvo que la aplicación anfitriona lo pida, cosa que no hace. En un
 * navegador el ajuste propio del navegador ya funciona —desde que los 185
 * tamaños de la hoja de estilos van en `rem`—; en la app, esto es la única
 * manera.
 *
 * Se aplica multiplicando la raíz, así que **todo** escala a la vez: los `rem`
 * de los tamaños, el interletraje en `em`, y las interlíneas, que son números
 * sin unidad. Es un solo número y no una hoja de estilos alternativa.
 *
 * Se refleja en localStorage por lo mismo que el tema: para poder ponerlo antes
 * del primer pintado y que la página no dé un salto al llegar la configuración.
 */
const ESCALAS = ["1", "1.15", "1.3", "1.6"];

function applyTextScale(valor) {
  // Fuera de la lista se vuelve al tamaño de siempre: un valor que no se
  // entiende no dice si se quería grande o pequeño. El CSS lo acota otra vez.
  const n = ESCALAS.includes(String(valor)) ? String(valor) : "1";
  document.documentElement.style.setProperty("--texto", n);
  try { localStorage.setItem("vatia-texto", n); } catch (e) { /* modo privado */ }
  $$("#text-seg .seg").forEach((b) => b.classList.toggle("active", b.dataset.textOpt === n));
  // Los lienzos miden su texto al dibujarlo, así que hay que rehacerlos: si no,
  // el gráfico se queda con los rótulos del tamaño anterior hasta que se toca.
  $$("vatia-bars, vatia-chart").forEach((el) => el.repaint && el.repaint());
}

/* El fondo dinámico se apaga poniendo `data-bg="flat"` en <body>: el CSS se
   encarga, así que no hay que desmontar nada ni tocar el DOM del cielo. */
function applyBackground(on_) {
  document.body.dataset.bg = on_ ? "sky" : "flat";
  const sw = $("#s-dynamic-bg");
  if (sw) sw.checked = !!on_;
}

async function setBackground(on_) {
  applyBackground(on_);
  // El interruptor guarda él solo, así que es el que necesita el estado del
  // §04: el pulgar se para a medio camino y gira hasta que el servidor contesta.
  const listo = guardando($("#s-dynamic-bg"));
  try {
    await api("settings", { method: "PUT", body: JSON.stringify({ dynamic_background: !!on_ }) });
    const s = settings();
    if (s) s.dynamic_background = !!on_;
  } finally {
    listo();
  }
}

/* El borde de la cabecera solo existe cuando hay contenido por encima. Se
   marca en <body> y el CSS hace el resto. */
function watchScroll() {
  const marcar = () => document.body.classList.toggle("scrolled", window.scrollY > 8);
  addEventListener("scroll", marcar, { passive: true });
  marcar();
}

// Al recargar la configuración, el tema y el fondo se aplican solos: si el
// fondo está apagado tiene que estarlo desde la primera pintada, no a partir de
// que se visite Ajustes.
on("config", (cfg) => {
  applyTheme(cfg?.settings?.theme);
  applyTextScale(cfg?.settings?.text_scale);
  applyBackground(cfg?.settings?.dynamic_background !== false);
});

$$("#theme-seg .seg").forEach((button) =>
  button.addEventListener("click", async () => {
    const pref = button.dataset.themeOpt;
    applyTheme(pref);                       // inmediato, sin esperar al servidor
    const s = settings();
    if (s) s.theme = pref;
    try {
      await api("settings", { method: "PUT", body: JSON.stringify({ theme: pref }) });
    } catch (err) {
      $("#settings-status").textContent = `No se pudo guardar el tema: ${err.message}`;
    }
  }));

$$("#text-seg .seg").forEach((button) =>
  button.addEventListener("click", async () => {
    const valor = button.dataset.textOpt;
    applyTextScale(valor);                  // inmediato, sin esperar al servidor
    const s = settings();
    if (s) s.text_scale = Number(valor);
    try {
      await api("settings", { method: "PUT",
                              body: JSON.stringify({ text_scale: Number(valor) }) });
    } catch (err) {
      $("#settings-status").textContent =
        `No se pudo guardar el tamaño del texto: ${err.message}`;
    }
  }));

$("#s-dynamic-bg").addEventListener("change", (ev) => setBackground(ev.target.checked));

// Con «automático», seguir al sistema cuando cambia sin recargar la página.
if (window.matchMedia) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const follow = () => {
    if ((config()?.settings?.theme || "auto") === "auto") applyTheme("auto");
  };
  if (query.addEventListener) query.addEventListener("change", follow);
  else if (query.addListener) query.addListener(follow);
}

watchScroll();

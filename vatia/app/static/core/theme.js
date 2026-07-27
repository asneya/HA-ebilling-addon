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

/* El fondo dinámico se apaga poniendo `data-bg="flat"` en <body>: el CSS se
   encarga, así que no hay que desmontar nada ni tocar el DOM del cielo. */
function applyBackground(on_) {
  document.body.dataset.bg = on_ ? "sky" : "flat";
  const sw = $("#s-dynamic-bg");
  if (sw) sw.checked = !!on_;
}

async function setBackground(on_) {
  applyBackground(on_);
  await api("settings", { method: "PUT", body: JSON.stringify({ dynamic_background: !!on_ }) });
  const s = settings();
  if (s) s.dynamic_background = !!on_;
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

/*
 * Lo mínimo para hablar con el documento: buscar, escapar y avisar de que hay
 * algo en marcha. No conoce ninguna pantalla, y por eso lo puede usar todo.
 */

export const $ = (s) => document.querySelector(s);
export const $$ = (s) => Array.from(document.querySelectorAll(s));

export function esc(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/* Abrir y cerrar una hoja.
 *
 * Existen porque cerrar era `classList.add("hidden")`, o sea `display: none`, y
 * la hoja **desaparecía de golpe**: entraba subiendo en tres décimas y se
 * esfumaba sin más. Lo que sale por donde no entró se lee como un fallo, no como
 * una decisión, y además deja al ojo sin saber adónde ha ido lo que estaba
 * mirando.
 *
 * La salida no puede ser solo CSS porque hay que esperar a que termine antes de
 * poner `display: none`; de ahí este par. Están aquí y no en cada pantalla para
 * que las seis hojas cierren igual: si la animación cambia, cambia en un sitio.
 */
export function abrirHoja(el) {
  if (!el) return;
  // Si se reabre mientras salía, se cancela la salida: el `fin` de abajo
  // comprueba que la clase siga puesta antes de esconder nada.
  el.classList.remove("saliendo");
  el.classList.remove("hidden");
}

export function cerrarHoja(el) {
  if (!el || el.classList.contains("hidden") || el.classList.contains("saliendo")) return;
  el.classList.add("saliendo");
  const fin = () => {
    // Reabierta a media salida: manda la apertura y aquí no se toca nada.
    if (!el.classList.contains("saliendo")) return;
    el.classList.add("hidden");
    el.classList.remove("saliendo");
  };
  el.addEventListener("animationend", fin, { once: true });
  // Red de seguridad: si la animación no llega a correr —la pestaña estaba en
  // segundo plano, o alguien desactiva las animaciones por su cuenta— la hoja se
  // quedaría abierta y bloqueando la pantalla. Vale más cerrarla tarde que no
  // cerrarla. El plazo es holgado a propósito: no es la duración de nada, es un
  // tope, y si fuera ajustado competiría con la animación de verdad.
  setTimeout(fin, 600);
}

// Indicador de progreso global: una barra fina en la parte superior mientras
// haya alguna petición en vuelo (HIG: dar señal de espera en toda operación).
let pending = 0;

export function setBusy(delta) {
  pending = Math.max(0, pending + delta);
  document.documentElement.classList.toggle("busy", pending > 0);
}

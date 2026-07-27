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

// Indicador de progreso global: una barra fina en la parte superior mientras
// haya alguna petición en vuelo (HIG: dar señal de espera en toda operación).
let pending = 0;

export function setBusy(delta) {
  pending = Math.max(0, pending + delta);
  document.documentElement.classList.toggle("busy", pending > 0);
}

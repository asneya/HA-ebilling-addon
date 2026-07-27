/*
 * La configuración del servidor: ajustes y tarifas.
 *
 * Es lo único que de verdad comparten las cinco pantallas, así que vive aquí y
 * no en un objeto global con el estado de todas. Cada pantalla guarda lo suyo
 * en su propio fichero.
 */
import { api } from "./api.js";
import { emit } from "./bus.js";

let actual = null;

/* La configuración de ahora mismo, o `null` si aún no se ha cargado. Se
   devuelve el objeto tal cual —no una copia— porque `saveSettings` necesita
   poder actualizarlo sin volver a pedirlo al servidor. */
export function config() { return actual; }

export function settings() { return (actual && actual.settings) || null; }

export function tariffs() { return (actual && actual.tariffs) || []; }

/* El periodo de facturación fijado a mano en Ajustes, si lo hay. */
export function workingPeriod() {
  const s = settings();
  return (s && s.working_period) || null;
}

export async function reloadConfig() {
  actual = await api("config");
  emit("config", actual);
  return actual;
}

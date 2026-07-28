/*
 * Las entidades de Home Assistant agrupadas por tipo.
 *
 * Vive en core y no en Ajustes desde que hay dos pantallas que necesitan
 * desplegables de sensores: los catorce del balance y los de cada
 * electrodoméstico. Se piden **una vez** por sesión: son trescientas y no cambian
 * mientras la app está abierta, así que cachearlas aquí ahorra una petición por
 * cada hoja que se abre.
 */
import { esc } from "./dom.js";
import { api } from "./api.js";

let grupos = null;

/* Las carga si no están. Si Home Assistant no contesta no se lanza: los
   desplegables se quedan con el valor guardado, que es mejor que un error por
   algo que solo sirve para elegir más cómodo. */
export async function asegurar() {
  if (grupos) return grupos;
  try {
    grupos = await api("entities/grouped");
  } catch (_) { /* sin conexión: se enseña solo lo guardado */ }
  return grupos;
}

export function porTipo(kind) {
  return (grupos && grupos[kind]) || [];
}

export function cargadas() { return !!grupos; }

/* `<option>`s de un tipo, con el valor guardado conservado aunque no esté en la
   lista: una entidad que ahora no responde no se puede perder por abrir la hoja. */
export function opciones(kind, selected, vacio = "— sin asignar —") {
  const list = porTipo(kind);
  let html = `<option value="">${esc(vacio)}</option>`;
  if (selected && !list.some((e) => e.entity_id === selected)) {
    html += `<option value="${esc(selected)}" selected>${esc(selected)}</option>`;
  }
  html += list.map((e) =>
    `<option value="${esc(e.entity_id)}" ${e.entity_id === selected ? "selected" : ""}>${
      esc(e.name)}${e.unit ? ` (${esc(e.unit)})` : ""}</option>`).join("");
  return html;
}

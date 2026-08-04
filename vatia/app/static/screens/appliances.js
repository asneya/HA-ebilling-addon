/*
 * Electrodomésticos: darlos de alta y ver qué ha aprendido la app de cada uno.
 *
 * Un electrodoméstico aquí no se describe, se **mide**: se dice qué sensor lleva
 * y el resto lo saca la app de su histórico. Por eso el editor no tiene ningún
 * campo de duración ni de consumo, que es lo que el prototipo del diseño sí pedía
 * teclear: un número puesto a ojo en la tarjeta que decide si pones la lavadora
 * ahora o después no vale más que un hueco.
 *
 * La lista dice, por cada uno, qué está haciendo ahora y qué se ha aprendido:
 * «2 h 10 min · 0,9 kWh de mediana, 7 ciclos en 14 días». Mientras no haya dos
 * ciclos dice que está aprendiendo, y eso también es información.
 */
import { $, $$, esc } from "../core/dom.js";
import { api } from "../core/api.js";
import { on } from "../core/bus.js";
import { fmtNum } from "../core/format.js";
import { config, reloadConfig } from "../core/config.js";
import { asegurar, opciones } from "../core/entidades.js";
import { guardando } from "../core/guardando.js";

/* Los mismos glifos que acepta el servidor, con su nombre para el botón. */
const ICONOS = [
  ["lavadora", "Lavadora"], ["lavavajillas", "Lavavajillas"],
  ["horno", "Horno"], ["coche", "Coche"],
  ["aire-acondicionado", "Aire acondicionado"], ["ordenador", "Ordenador"],
  ["movil", "Móvil"], ["nevera", "Nevera"], ["congelador", "Congelador"],
  ["iluminacion", "Iluminación"], ["cortacesped", "Cortacésped"],
  ["microondas", "Microondas"], ["television", "Televisión"],
  ["freidora", "Freidora de aire"], ["ventilador", "Ventilador"],
  ["potencia", "Otro"],
];
/* Seis tonos que **no** son los de las series. En el diagrama detallado los
   electrodomésticos se dibujan donde estaba la casa, al lado del sol (ámbar), la
   batería (verde), la red (azul), el excedente (violeta) y el resto de la casa
   (rosa): si un aparato pudiera llevar uno de esos colores, el nodo diría una
   cosa y el color otra. */
const COLORES = ["#0f7d8a", "#4a4ee0", "#8a5a2b", "#55636f", "#b5179e", "#6b8e23"];

/* Lo que está editándose. `null` cuando la hoja está cerrada. */
let editando = null;
/* Lo último que contó /api/live de cada aparato: lo que hace ahora. */
let vivo = {};

const lista = () => config()?.appliances || [];

/* «2 h 10 min», «50 min». Redondeado a cinco minutos, que es el paso de las
   muestras de las que sale la mediana. */
function dur(horas) {
  const total = Math.max(5, Math.round((horas || 0) * 12) * 5);
  const h = Math.floor(total / 60), m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function render() {
  const aparatos = lista();
  $("#ap-count").textContent = aparatos.length ? `${aparatos.length}` : "ninguno";
  $("#nav-sub-appliances").textContent = aparatos.length
    ? `${aparatos.length} medido${aparatos.length === 1 ? "" : "s"}`
    : "Ninguno · la Home no puede aconsejar";

  if (!aparatos.length) {
    $("#ap-list").innerHTML = `<p class="empty">Ninguno todavía. Con un enchufe
      medido —una lavadora, el horno, el coche— la Home ya puede decirte si te
      cabe gratis en la ventana.</p>`;
    return;
  }

  $("#ap-list").innerHTML = aparatos.map((a) => {
    const v = vivo[a.id] || {};
    const c = v.cycle;
    // Primera línea de estado: lo que hace ahora, que es lo que se comprueba al
    // entrar («¿he asignado el sensor correcto?»).
    const ahora = v.watts == null ? "sin lectura"
      : v.running ? `en marcha · ${fmtNum.format(v.watts)} W`
      : "en reposo";
    const aprendido = c
      ? `${dur(c.hours)} · ${fmtNum.format(c.kwh)} kWh · ${c.cycles} ciclo${
          c.cycles === 1 ? "" : "s"} en ${c.days} días`
      : "aprendiendo su ciclo";
    return `
      <div class="ap-row" data-id="${esc(a.id)}" role="button" tabindex="0">
        <span class="ap-chip" style="--ap:${esc(a.color)}">
          <svg class="i"><use href="#i-${esc(a.icon)}"/></svg>
        </span>
        <span class="ap-txt">
          <b>${esc(a.name)}</b>
          <small>${esc(ahora)} · ${esc(aprendido)}</small>
        </span>
        <svg class="i nav-chev"><use href="#i-chevron"/></svg>
      </div>`;
  }).join("");

  $$("#ap-list .ap-row").forEach((el) => {
    const abrir = () => editar(el.dataset.id);
    el.addEventListener("click", abrir);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrir(); }
    });
  });
}

/* ------------- la hoja ------------- */

async function editar(id) {
  const a = lista().find((x) => x.id === id) || null;
  editando = a ? { ...a } : {
    name: "", icon: "lavadora", color: COLORES[0],
    power_entity: "", energy_entity: "", standby_w: 15, kind: "",
  };
  $("#appliance-modal-title").textContent = a ? a.name : "Nuevo electrodoméstico";
  $("#ap-error").textContent = "";
  $("#ap-name").value = editando.name;
  $("#ap-standby").value = editando.standby_w;
  $("#ap-kind").value = editando.kind || "";
  // Y qué ha detectado la aplicación, cuando se deja en automático: detectar y
  // callarlo es lo que hace que una fila rara parezca un fallo del programa.
  const detectada = (vivo[id] || {}).kind;
  $("#ap-kind-state").textContent = editando.kind || !detectada ? ""
    : `Ahora mismo Vatia lo trata como «${
        detectada === "continuo" ? "siempre encendido" : "puedo elegir la hora"
      }», por lo que dice su histórico.`;
  $("#delete-appliance-btn").classList.toggle("hidden", !a);

  $("#ap-icons").innerHTML = ICONOS.map(([k, nombre]) => `
    <button type="button" class="ap-ico ${k === editando.icon ? "active" : ""}"
            data-icon="${k}" title="${esc(nombre)}" aria-label="${esc(nombre)}">
      <svg class="i"><use href="#i-${k}"/></svg>
    </button>`).join("");
  $$("#ap-icons .ap-ico").forEach((b) => b.addEventListener("click", () => {
    editando.icon = b.dataset.icon;
    $$("#ap-icons .ap-ico").forEach((x) => x.classList.toggle("active", x === b));
  }));

  $("#ap-colors").innerHTML = COLORES.map((c) => `
    <button type="button" class="ap-color ${c === editando.color ? "active" : ""}"
            data-color="${c}" style="--ap:${c}" aria-label="Color ${c}"></button>`).join("");
  $$("#ap-colors .ap-color").forEach((b) => b.addEventListener("click", () => {
    editando.color = b.dataset.color;
    $$("#ap-colors .ap-color").forEach((x) => x.classList.toggle("active", x === b));
  }));

  // Los desplegables se pueblan con lo que haya y se rellenan al llegar la lista:
  // así la hoja abre al instante y no se queda esperando a Home Assistant.
  pintarSelects();
  await asegurar();
  pintarSelects();

  $("#appliance-modal").classList.remove("hidden");
  $("#ap-name").focus();
}

function pintarSelects() {
  $("#ap-power").innerHTML = opciones("power", editando.power_entity, "— sin asignar —");
  $("#ap-energy").innerHTML = opciones("energy", editando.energy_entity, "— ninguno —");
}

function cerrar() {
  editando = null;
  $("#appliance-modal").classList.add("hidden");
}

async function guardar() {
  if (!editando) return;
  const cuerpo = {
    ...editando,
    name: $("#ap-name").value.trim(),
    power_entity: $("#ap-power").value,
    energy_entity: $("#ap-energy").value,
    standby_w: Number($("#ap-standby").value) || 0,
    kind: $("#ap-kind").value,
  };
  if (!cuerpo.name) {
    $("#ap-error").textContent = "Ponle un nombre: es lo que se lee en la Home.";
    $("#ap-name").focus();
    return;
  }
  if (!cuerpo.power_entity) {
    $("#ap-error").textContent =
      "Hace falta el sensor de potencia: sin él no hay ciclo que aprender.";
    return;
  }
  const listo = guardando($("#save-appliance-btn"));
  try {
    await api(cuerpo.id ? `appliances/${cuerpo.id}` : "appliances",
      { method: cuerpo.id ? "PUT" : "POST", body: JSON.stringify(cuerpo) });
    await reloadConfig();
    cerrar();
    render();
  } catch (err) {
    $("#ap-error").textContent = err.message;
  } finally { listo(); }
}

async function borrar() {
  if (!editando || !editando.id) return;
  if (!window.confirm(`¿Quitar ${editando.name}? Sus sensores no se tocan.`)) return;
  const listo = guardando($("#delete-appliance-btn"));
  try {
    await api(`appliances/${editando.id}`, { method: "DELETE" });
    await reloadConfig();
    cerrar();
    render();
  } catch (err) {
    $("#ap-error").textContent = err.message;
  } finally { listo(); }
}

/* ------------- controles ------------- */

$("#add-appliance-btn").addEventListener("click", () => editar(null));
$("#save-appliance-btn").addEventListener("click", guardar);
$("#cancel-appliance-btn").addEventListener("click", cerrar);
$("#delete-appliance-btn").addEventListener("click", borrar);

/* ------------- lo que esta pantalla escucha ------------- */

on("pagina-ajustes", ({ page }) => { if (page === "appliances") render(); });
// El índice de Ajustes dice cuántos hay sin entrar, así que se pinta también al
// abrir Ajustes y cada vez que cambia la configuración.
on("vista", ({ name }) => { if (name === "settings") render(); });
on("config", () => render());

/* Lo que hace cada uno ahora mismo llega en /api/live, que pide la Home. Se
   guarda aquí para que al entrar en la sección la lista ya lo sepa, y se recibe
   por el tablón: si esta pantalla importara la Home habría un ciclo. */
on("vivo", (payload) => {
  vivo = {};
  for (const a of payload?.appliances || []) vivo[a.id] = a;
  if ($("#sp-appliances").classList.contains("active")) render();
});

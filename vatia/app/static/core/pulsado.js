/*
 * El acuse de recibo: al pulsar una pestaña, la selección se mueve **ya**.
 *
 * Antes cada pantalla marcaba el botón elegido al terminar de pintarse, o sea
 * después de la petición al servidor. En una casa con InfluxDB lejos eso son
 * cientos de milisegundos en los que se ha pulsado y no ha pasado nada: no se
 * sabe si el toque ha entrado, y se vuelve a pulsar. El dato tarda lo que
 * tarda, pero *decir que se ha recibido la orden* no tiene por qué tardar nada.
 *
 * Se hace en un único sitio, con delegación en el documento, y no en cada
 * pantalla:
 *
 *   · en la fase de captura, así que se ejecuta **antes** que el manejador de
 *     la pantalla y por tanto antes de que arranque la carga;
 *   · no toca el estado de nadie: solo mueve la marca. Cuando la pantalla
 *     termina de cargar vuelve a ponerla donde toca, y como es la misma, no se
 *     nota. Si la carga acabara eligiendo otra cosa —o fallara—, la pantalla
 *     manda y esto se corrige solo;
 *   · un grupo nuevo se apunta añadiendo una línea a `GRUPOS`, sin tocar la
 *     pantalla que lo use.
 *
 * Además coloca la píldora deslizante de los controles segmentados: la posición
 * va en una variable CSS con el índice del elegido, y del movimiento se encarga
 * una transición. Sin bucles de animación ni medir nada.
 */
import { $$ } from "./dom.js";

/* Contenedor → los botones que se turnan dentro de él. El contenedor delimita
   el grupo: dos controles segmentados en la misma pantalla no se pisan. */
const GRUPOS = [
  [".tabbar", ".tab"],
  [".viewtabs", ".vt"],
  [".segmented", ".seg"],
];

/* Coloca la píldora del control segmentado bajo el botón activo.

   Solo tiene sentido con botones del mismo ancho, que es como está definido
   `.seg` (`flex: 1`). Si algún día hubiera uno más ancho que otro, el sitio de
   arreglarlo es aquí y no en cada pantalla. */
function pildora(caja) {
  if (!caja.classList.contains("segmented")) return;
  const botones = [...caja.querySelectorAll(".seg")];
  const i = botones.findIndex((b) => b.classList.contains("active"));
  caja.style.setProperty("--seg-n", String(botones.length || 1));
  // −1 (nada elegido) esconde la píldora en vez de dejarla en el primero, que
  // sería decir que hay algo elegido cuando no lo hay.
  caja.style.setProperty("--seg-i", String(i));
  caja.classList.toggle("con-pildora", i >= 0);
}

/* Mueve la marca dentro del grupo de `boton`. Sin exportar: solo la usa el
   oyente de aquí abajo, y sacarla fuera invitaría a llamarla desde una
   pantalla, que es justo lo que este módulo existe para no tener que hacer. */
function marcar(boton) {
  for (const [contenedor, hijo] of GRUPOS) {
    if (!boton.matches(hijo)) continue;
    const caja = boton.closest(contenedor);
    if (!caja) continue;
    const hermanos = [...caja.querySelectorAll(hijo)];
    if (!hermanos.includes(boton)) continue;
    hermanos.forEach((b) => b.classList.toggle("active", b === boton));
    pildora(caja);
    return;
  }
}

/* Recoloca las píldoras de todos los controles que ya estén en pantalla. Hace
   falta al arrancar y cada vez que una pantalla repinta su estado por su
   cuenta: la marca la pone ella, pero la píldora la coloca esto. */
export function recolocar() {
  $$(".segmented").forEach(pildora);
}

/* En captura: este oyente corre antes que el de la pantalla, que es lo único que
   garantiza que la marca se mueva antes de que empiece la carga.

   Y **al apretar, no al soltar**. Iba en `click`, que se dispara al levantar el
   dedo: todo este módulo existe para que la marca no espere al servidor, y estaba
   esperando al final del propio toque. En un toque tranquilo eso son 80-150 ms de
   nada, justo el hueco que hace dudar de si el toque ha entrado.

   Hacen falta los dos eventos y no uno:

   · `pointerdown` cubre dedo, ratón y lápiz. Solo el botón principal: con el
     secundario no se elige nada.
   · `keydown` con Enter o Espacio, porque quien navega con teclado no genera
     ningún `pointerdown` y se quedaría sin acuse. Con `click` lo tenía gratis.

   Lo que se pierde es poder arrepentirse arrastrando fuera del botón antes de
   soltar: con `click` eso cancelaba, y ahora la marca ya se ha movido. No se
   compensa, y a propósito. Esto no ejecuta la acción —eso lo sigue haciendo el
   `click` de la pantalla—, solo mueve la marca, y si el toque se cancela la
   pantalla repinta su estado y la devuelve a su sitio, que es el mismo mecanismo
   que ya la corrige cuando la carga acaba eligiendo otra cosa. Vigilar el
   `pointerup` para deshacerla sería código nuevo para un caso que se arregla
   solo. */
const elegible = (ev) => {
  const boton = ev.target.closest?.(".tab, .vt, .seg");
  // Un botón apagado no se elige, y uno que ya está elegido no mueve nada.
  return boton && !boton.disabled ? boton : null;
};

document.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0) return;
  const boton = elegible(ev);
  if (boton) marcar(boton);
}, true);

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const boton = elegible(ev);
  if (boton) marcar(boton);
}, true);

// Y al arrancar, con el estado que venga del servidor.
document.addEventListener("DOMContentLoaded", recolocar);

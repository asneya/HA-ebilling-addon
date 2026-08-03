/*
 * Las tarjetas de la pantalla de inicio: cuáles hay, en qué orden y cuáles se ven.
 *
 * El orden y lo oculto son **de quien mira**, no de la casa. Home Assistant dice
 * quién es a través de Ingress y el servidor devuelve en `settings` las
 * preferencias de esa persona ya mezcladas, así que aquí no hay nada de
 * identidad: se lee `settings.home_order` como se lee cualquier otro ajuste.
 *
 * Vive en `core/` porque lo usan los dos lados —la Home, que se pinta con ello,
 * y Ajustes, que lo edita— y el catálogo tiene que ser el mismo. Con una copia
 * en cada sitio, añadir una tarjeta obligaría a acordarse de los dos.
 *
 * El catálogo es la fuente del orden por defecto: `CATALOGO` está en el orden en
 * que se ven las tarjetas de fábrica.
 */

/* Cada tarjeta con lo que hace falta para presentarla en Ajustes. `id` es lo que
   se guarda y lo que lleva el `data-card` de los elementos de la Home. */
export const CATALOGO = [
  {
    id: "ahora",
    name: "Ahora mismo",
    claim: "El caudal en tiempo real y de dónde sale cada vatio",
    icon: "i-autoconsumo",
    color: "#ff9f0a",
  },
  {
    id: "cierre",
    name: "Cómo ha terminado el día",
    claim: "Aparece al ponerse el sol, con el resumen de la jornada",
    icon: "i-calendario",
    color: "#c86a48",
  },
  {
    id: "ventana",
    name: "Ventana de energía gratis",
    claim: "Cuánto sobra y qué te cabe dentro",
    icon: "i-solar",
    color: "#30d158",
  },
  {
    id: "plan",
    name: "El plan de hoy",
    claim: "A qué hora sale más barato cada electrodoméstico",
    icon: "i-reloj",
    color: "#5e5ce6",
  },
  {
    id: "tiempo",
    name: "El tiempo hora a hora",
    claim: "Las horas de sol que quedan hoy, con las nubes y lo que dejan pasar",
    icon: "i-parcial",
    color: "#64d2ff",
  },
  {
    id: "resumen",
    name: "Resumen de energía",
    claim: "Lo generado y lo consumido hoy, por origen y destino",
    icon: "i-balance",
    color: "#0a84ff",
  },
];

const IDS = CATALOGO.map((t) => t.id);

/* El orden guardado, saneado.

   Dos reglas, y las dos existen para que nadie se quede sin una tarjeta:
   se tiran los ids que ya no existen (una tarjeta retirada en una versión
   posterior) y se añaden al final, en el orden del catálogo, los que falten
   (una tarjeta nueva). Sin lo segundo, quien hubiera ordenado su Home a mano
   no volvería a ver ninguna tarjeta nueva nunca. */
export function ordenTarjetas(settings) {
  const guardado = Array.isArray(settings?.home_order) ? settings.home_order : [];
  const orden = guardado.filter((id, i) => IDS.includes(id) && guardado.indexOf(id) === i);
  IDS.forEach((id) => { if (!orden.includes(id)) orden.push(id); });
  return orden;
}

/* Los ids que quien mira ha decidido no ver. */
export function ocultas(settings) {
  const lista = Array.isArray(settings?.home_hidden) ? settings.home_hidden : [];
  return new Set(lista.filter((id) => IDS.includes(id)));
}

/* Aplica el orden y lo oculto a la Home.

   No mueve nodos: asigna `order` a cada elemento, que es lo que permite que los
   componentes de dentro no se enteren de nada. Los elementos que comparten
   `data-card` —el cierre y su fila de recuperar, la ventana y su consejo—
   reciben el mismo `order` y se quedan juntos en su orden de siempre. */
export function aplicarTarjetas(settings) {
  const orden = ordenTarjetas(settings);
  const off = ocultas(settings);
  document.querySelectorAll("#home-cards [data-card]").forEach((el) => {
    const id = el.dataset.card;
    el.style.order = String(orden.indexOf(id));
    el.classList.toggle("card-off", off.has(id));
  });
  const vacia = document.getElementById("home-empty");
  if (vacia) vacia.classList.toggle("hidden", off.size < IDS.length);
}

/*
 * El tablón de anuncios entre pantallas.
 *
 * Existe para una razón concreta: sin él, la navegación tendría que importar
 * las cinco pantallas para saber a quién avisar, y las pantallas tendrían que
 * importar la navegación para poder cambiar de pantalla. Eso es un ciclo, y con
 * un ciclo cualquier cambio en una pantalla puede romper otra sin tocarla.
 *
 * Con el tablón la dependencia va en un solo sentido: la navegación y el tema
 * *anuncian*, las pantallas *escuchan*. Ninguno de los dos sabe quién hay al
 * otro lado, así que se puede añadir o quitar una pantalla sin tocar nada más.
 *
 * Los cinco anuncios que existen —y no hay más a propósito, porque un tablón
 * con veinte eventos vuelve a ser un ovillo, solo que sin poder seguirlo con el
 * buscador del editor—:
 *
 *   vista          {name}   se ha entrado en una pantalla
 *   subvista       {name}   se ha cambiado de subvista en Facturación
 *   pagina-ajustes {page}   se ha entrado en una sección de Ajustes (null = índice)
 *   config                  la configuración se ha recargado del servidor;
 *                           hay que repintar lo que la muestre (no pide datos)
 *   datos                   algo ha cambiado de verdad y las pantallas tienen
 *                           que volver a pedir sus datos
 *   tema                    se ha aplicado un tema; hay que repintar lo que
 *                           lleve colores resueltos a mano
 */

const oyentes = new Map();

export function on(evento, fn) {
  if (!oyentes.has(evento)) oyentes.set(evento, []);
  oyentes.get(evento).push(fn);
}

export function emit(evento, dato) {
  // Un fallo en un oyente no puede dejar sin avisar a los demás: cada pantalla
  // responde por lo suyo y el error se ve en la consola, no se traga.
  for (const fn of oyentes.get(evento) || []) {
    try { fn(dato); } catch (err) { console.error(`[${evento}]`, err); }
  }
}

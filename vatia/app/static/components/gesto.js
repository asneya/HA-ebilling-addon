/*
 * La holgura del arrastre, en un solo sitio.
 *
 * Los dos gráficos —<vatia-chart> y <vatia-bars>— tienen el mismo dilema al
 * empezar un gesto con un dedo encima del lienzo: ¿lo quiere para recorrer la
 * curva, o está bajando por la página y el gráfico solo estaba en medio? El
 * navegador no lo sabe (`touch-action: pan-y` deja pasar lo vertical, pero
 * alguien tiene que decidir qué es vertical), así que se decide aquí.
 *
 * Estaba escrito dos veces, con la misma cifra copiada. Eso significa que subir
 * la holgura en un gráfico y no en el otro es un cambio que nadie nota hasta que
 * los dos se comportan distinto con el mismo dedo. Ahora es una función.
 *
 * La holgura es de 10 px y no de 6:
 *
 *   · a 6 px la dirección se decide con tan poco recorrido que manda el temblor
 *     de la mano. Un dedo que va a bajar por la pantalla empieza casi siempre con
 *     dos o tres píxeles de lado, y si el reparto de esos primeros píxeles cae en
 *     horizontal, el gráfico se queda el gesto y la página no baja. Eso es un
 *     fallo que el usuario vive como «se ha quedado pillado»;
 *   · a 10 px la proporción entre `dx` y `dy` ya es una dirección de verdad. Es
 *     también la holgura con la que Apple separa un toque de un arrastre.
 *
 * Se carga como script normal —los componentes no son módulos— y antes que ellos.
 */
(function () {
  const HOLGURA_PX = 10;

  /* Qué hacer con un gesto que lleva recorridos (dx, dy) desde donde empezó:
       "esperar" → todavía no se sabe, no se toca nada;
       "soltar"  → es vertical, que se lo quede la página;
       "seguir"  → es horizontal, el gráfico se lo queda. */
  function direccion(dx, dy) {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < HOLGURA_PX && ay < HOLGURA_PX) return "esperar";
    return ay > ax ? "soltar" : "seguir";
  }

  window.VatiaGesto = { HOLGURA_PX, direccion };
})();

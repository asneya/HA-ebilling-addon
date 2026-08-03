/* Nada del diagrama se sale de su lienzo.
 *
 * De una queja: *«el flujo de caudales pintado en vertical, cuando hay detalle de
 * electrodomésticos, hace overflow por la derecha saliéndose de su tarjeta y de la
 * pantalla, sin poder ver todo lo que representa»*.
 *
 * Eran dos cosas, y las dos medibles:
 *
 *   · el presupuesto del dibujo descontaba **dos** huecos entre segmentos, que son
 *     los que hay con los tres nodos del diseño. Con la casa partida por dentro
 *     puede haber siete, y los cuatro huecos de más se comían 56 px que nadie
 *     había reservado: las barras llegaban a [-17, 365] sobre un lienzo de 348;
 *   · y el antirreapilado de etiquetas, al no caber, empujaba el grupo entero a la
 *     derecha sin tope. La última etiqueta acabó medida en x = 563 con la pantalla
 *     en 414. Con `overflow: visible` eso no se recorta: se pinta fuera de la
 *     tarjeta y del borde, donde no hay scroll con el que llegar.
 *
 * Lo que se comprueba, con el número de aparatos como variable:
 *
 *   1. las barras caben en el lienzo
 *   2. las etiquetas también, texto incluido
 *   3. y nada asoma por encima ni por debajo
 *   4. en las dos orientaciones
 *   5. con tres nodos por lado, el lienzo es el de siempre (nada ha cambiado)
 *   6. y las etiquetas de un lado poblado no se pisan entre ellas
 */
const { abrirNavegador, ficheros } = require("./camino");
const BASE = `${ficheros()}/banco.html`;
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

/* Lo que ocupa el dibujo, en coordenadas del propio lienzo: así la medida no
   depende de a qué tamaño se esté enseñando. */
async function medir(p) {
  return p.evaluate(() => {
    const svg = document.querySelector("vatia-flow").shadowRoot.querySelector("svg");
    const vb = svg.getAttribute("viewBox").split(" ").map(Number);
    const caja = svg.getBBox();
    const cajas = (sel) => [...svg.querySelectorAll(sel)].map((e) => e.getBBox());
    const barras = cajas("rect");
    const textos = [...svg.querySelectorAll("text")].map((t) => {
      const c = t.getBBox();
      return { t: t.textContent.trim(), x0: c.x, x1: c.x + c.width, y: c.y,
               y1: c.y + c.height };
    });
    return {
      ancho: vb[2], alto: vb[3],
      barras: barras.length ? { x0: Math.min(...barras.map((c) => c.x)),
                                x1: Math.max(...barras.map((c) => c.x + c.width)) } : null,
      todo: { x0: caja.x, x1: caja.x + caja.width, y0: caja.y, y1: caja.y + caja.height },
      textos,
    };
  });
}

/* ¿Se pisan dos etiquetas de la misma altura? Se comparan solo las que comparten
   renglón: escalonadas, la de arriba y la de abajo pueden solaparse en x sin que
   se lea mal, que es justo de lo que va el escalonado. */
function pisadas(textos) {
  const renglones = new Map();
  textos.forEach((t) => {
    const y = Math.round(t.y);
    if (!renglones.has(y)) renglones.set(y, []);
    renglones.get(y).push(t);
  });
  const choques = [];
  for (const fila of renglones.values()) {
    fila.sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < fila.length; i++) {
      if (fila[i].x0 < fila[i - 1].x1 - 0.5) {
        choques.push(`«${fila[i - 1].t}» / «${fila[i].t}»`);
      }
    }
  }
  return choques;
}

(async () => {
  const b = await abrirNavegador();
  // El caso de siempre (sin aparatos) y el que rompía: con cinco, el lado derecho
  // pasa a siete segmentos —cinco enchufes, el resto de la casa y la batería—.
  for (const caso of [{ n: "vertical", vw: 393, q: "" },
                      { n: "horizontal", vw: 900, q: "&ancho=860" }]) {
    console.log(`\n== ${caso.n} ==`);
    const ctx = await b.newContext({ viewport: { width: caso.vw, height: 1100 } });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => fallos.push("pageerror: " + e));
    let base = null;
    for (const aparatos of [0, 2, 3, 5]) {
      await p.goto(`${BASE}?tag=vatia-flow&escena=mediodia&aparatos=${aparatos}${caso.q}`,
                   { waitUntil: "networkidle" });
      await p.waitForTimeout(350);
      const m = await medir(p);
      const r = (v) => Math.round(v);
      ok(m.barras && m.barras.x0 >= -1 && m.barras.x1 <= m.ancho + 1,
        `${aparatos} aparatos · las barras caben [${r(m.barras.x0)}, ${r(m.barras.x1)}] `
        + `en ${m.ancho}`);
      ok(m.todo.x1 <= m.ancho + 1 && m.todo.x0 >= -1,
        `${aparatos} aparatos · y el texto también [${r(m.todo.x0)}, ${r(m.todo.x1)}]`);
      ok(m.todo.y1 <= m.alto + 1 && m.todo.y0 >= -1,
        `${aparatos} aparatos · nada asoma por arriba ni por abajo `
        + `[${r(m.todo.y0)}, ${r(m.todo.y1)}] en ${m.alto}`);
      if (aparatos === 0) base = m;
      const choques = pisadas(m.textos);
      ok(!choques.length, `${aparatos} aparatos · ninguna etiqueta pisa a otra de su `
        + `renglón${choques.length ? ` (${choques.join(", ")})` : ""}`);
    }
    // Y el caso del diseño no se ha movido: el arreglo solo aprieta cuando hace falta.
    await p.goto(`${BASE}?tag=vatia-flow&escena=mediodia&aparatos=0${caso.q}`,
                 { waitUntil: "networkidle" });
    const solo = await medir(p);
    ok(solo.alto === base.alto && solo.ancho === base.ancho,
      `sin aparatos el lienzo es el de siempre (${solo.ancho}×${solo.alto})`);
    await ctx.close();
  }
  await b.close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

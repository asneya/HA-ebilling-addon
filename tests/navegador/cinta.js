/* La cinta contra su rectángulo: sin escalón donde se tocan.
 *
 *   1. la cinta nace en el color de la barra de origen y a opacidad llena
 *   2. y muere en el de la barra de destino, también llena
 *   3. el centro sigue traslúcido, que es donde las cintas se cruzan
 *   4. el color solo cambia en el tramo del medio, no en los contactos
 *   5. el color de la primera parada es exactamente el relleno de su barra
 *   6. y vale igual en vertical (móvil) que en horizontal
 */
const { abrirNavegador, base, ficheros } = require("./camino");
const BASE = `${ficheros()}/banco.html`;
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

(async () => {
  const b = await abrirNavegador();
  for (const caso of [{ n: "horizontal", vw: 900, q: "&ancho=860" },
                      { n: "vertical", vw: 393, q: "" }]) {
    console.log(`\n== ${caso.n} ==`);
    const ctx = await b.newContext({ viewport: { width: caso.vw, height: 900 } });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => console.log("PAGEERROR", String(e)));
    await p.goto(`${BASE}?tag=vatia-flow&escena=mediodia${caso.q}`, { waitUntil: "networkidle" });
    await p.waitForTimeout(500);

    const d = await p.evaluate(() => {
      const s = document.querySelector("vatia-flow").shadowRoot;
      // El color final que pinta el navegador, con el `var()` ya resuelto.
      const real = (v) => {
        const sonda = document.createElement("span");
        sonda.style.color = v || "";
        document.body.appendChild(sonda);
        const c = getComputedStyle(sonda).color;
        sonda.remove();
        return c;
      };
      const cintas = [...s.querySelectorAll("linearGradient")].map((lg) => ({
        stops: [...lg.querySelectorAll("stop")].map((t) => ({
          off: Number(t.getAttribute("offset")),
          op: Number(t.getAttribute("stop-opacity")),
          col: real(t.style.stopColor || t.getAttribute("stop-color")),
        })),
      }));
      const barras = [...s.querySelectorAll("rect")].map((r) => real(r.style.fill));
      return { cintas, barras };
    });

    const { cintas, barras } = d;
    ok(cintas.length >= 3, `hay cintas que mirar (${cintas.length})`);
    ok(cintas.every((x) => x.stops[0].op === 1), "todas nacen a opacidad llena");
    ok(cintas.every((x) => x.stops[x.stops.length - 1].op === 1), "y mueren igual");
    const minop = Math.min(...cintas.flatMap((x) => x.stops.map((s) => s.op)));
    ok(minop <= 0.65, `el centro sigue traslúcido (mín ${minop})`);
    ok(cintas.every((x) => {
      const i = x.stops.findIndex((s) => s.col !== x.stops[0].col);
      return i > 0 && x.stops[i].off >= 0.25 && x.stops[i - 1].off <= 0.75;
    }), "y el color solo cambia por el medio");
    // La juntura: el primer color de cada cinta tiene que ser el de alguna barra,
    // y el último también. Con opacidad 1 en los dos extremos, eso es el escalón
    // reducido a cero sin tener que medir un píxel.
    const naceEn = cintas.map((x) => x.stops[0].col);
    const mueEn = cintas.map((x) => x.stops[x.stops.length - 1].col);
    ok(naceEn.every((c) => barras.includes(c)),
      `nacen en el relleno exacto de su barra (${[...new Set(naceEn)].join(", ")})`);
    ok(mueEn.every((c) => barras.includes(c)),
      `y mueren en el de la suya (${[...new Set(mueEn)].join(", ")})`);
    await ctx.close();
  }
  await b.close();
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

/* Que la hora que se promete va rebajada, dicho en la tarjeta.
 *
 * De una queja: la tarjeta prometía «gratis desde las 10:06» un día en que
 * estaba nublado y la producción real era bajísima. La hora ya se corrige (ver
 * `tests/python/cielo.py`), pero una cifra corregida en silencio es la misma
 * desconfianza por otro camino: parece la de la previsión y no cuadra con lo que
 * se ve por la ventana. Es la regla que la tarjeta ya cumplía con el sesgo del
 * tejado, y que con el cielo de hoy no cumplía.
 *
 *   1. con el cielo encapotado se dice, y con el porcentaje que es
 *   2. y se explica con qué se ha medido
 *   3. medido solo con la hora cerrada, no se habla del instante
 *   4. medido solo con el instante, no se habla de la hora
 *   5. un cielo que cumple no se menciona: sería ruido
 *   6. sin testigo tampoco
 *   7. la nota del sesgo del tejado sigue estando, que es otra cosa
 *   8. sin errores de consola
 */
const { abrirNavegador, base, ficheros } = require("./camino");
const BASE = `${ficheros()}/bancoventana.html`;
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

const abrir = async (b, q) => {
  const ctx = await b.newContext({ viewport: { width: 414, height: 1100 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/CORS|font|ERR_FAILED|404/.test(t)) fallos.push("console: " + t);
  });
  await p.goto(BASE + q, { waitUntil: "networkidle" });
  await p.waitForTimeout(400);
  const texto = await p.evaluate(() =>
    document.querySelector("vatia-window").shadowRoot.textContent.replace(/\s+/g, " "));
  await ctx.close();
  return texto;
};

(async () => {
  const b = await abrirNavegador();

  console.log("\n1-2 · el cielo encapotado se dice");
  let t = await abrir(b, "?bat=4.2&cielo=15");
  ok(/el tejado va al 15 % de lo previsto/.test(t),
    `con el porcentaje que es («${(t.match(/Hoy el cielo[^.]*\./) || [""])[0]}»)`);
  ok(/la hora de arriba ya va rebajada/.test(t), "y que la hora ya lo lleva puesto");
  ok(/la hora de las 10:00/.test(t) && /está dando ahora mismo/.test(t),
    "explicando con qué se ha medido, que son dos cosas");
  ok(/se corrige solo en cuanto el tejado lo note/.test(t),
    "y que si se despeja mejora solo");

  console.log("\n3-4 · con un solo testigo, no se inventa el otro");
  t = await abrir(b, "?bat=4.2&cielo=30&testigo=hora");
  ok(/la hora de las 10:00/.test(t) && !/ahora mismo/.test(t),
    "con la hora cerrada no se habla del instante");
  t = await abrir(b, "?bat=4.2&cielo=30&testigo=ahora");
  ok(/está dando ahora mismo/.test(t) && !/la hora de las/.test(t),
    "y con el instante no se habla de la hora");

  console.log("\n5-6 · lo que no se menciona");
  t = await abrir(b, "?bat=4.2&cielo=100");
  ok(!/Hoy el cielo/.test(t), "un cielo que cumple no se menciona");
  t = await abrir(b, "?bat=4.2&cielo=90");
  ok(!/Hoy el cielo/.test(t), "ni una desviación del 10 %, que no cambia nada");
  t = await abrir(b, "?bat=4.2");
  ok(!/Hoy el cielo/.test(t), "y sin testigo no se dice nada");

  console.log("\n7 · el sesgo del tejado es otra cosa y sigue ahí");
  t = await abrir(b, "?bat=4.2&cielo=15");
  ok(/La previsión va corregida con lo que da tu tejado/.test(t),
    "las dos notas conviven");
  ok(/Aprendido de 11 días tuyos/.test(t), "y el sesgo sigue diciendo de cuántos días");
  t = await abrir(b, "?bat=4.2&cielo=15&sesgo=0");
  ok(!/Aprendido de/.test(t) && /el tejado va al 15 %/.test(t),
    "sin sesgo aprendido, el cielo de hoy se sigue diciendo");

  await b.close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

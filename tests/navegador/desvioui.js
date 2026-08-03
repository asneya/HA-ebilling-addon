/* Que la hora que se promete va rebajada, dicho en la tarjeta.
 *
 * De una queja: la tarjeta prometía «gratis desde las 10:06» un día en que
 * estaba nublado y la producción real era bajísima. La hora ya se corrige (ver
 * `tests/python/desvio.py`), pero una cifra corregida en silencio es la misma
 * desconfianza por otro camino: parece la de la previsión y no cuadra con lo que
 * se ve por la ventana. Es la regla que la tarjeta ya cumplía con el sesgo del
 * tejado, y que con el desvío de hoy no cumplía.
 *
 *   1. con el tejado por debajo de lo previsto se dice, y con el porcentaje que es
 *   2. y se explica con qué se ha medido
 *   3. medido solo con la hora cerrada, no se habla del instante
 *   4. medido solo con el instante, no se habla de la hora
 *   5. un tejado que cumple no se menciona: sería ruido
 *   6. sin testigo tampoco
 *   7. la nota del sesgo del tejado sigue estando, que es otra cosa
 *   8. el titular dice lo que está en juego, no una potencia media
 *   9. de mañana, no saber nada no es lo mismo que saber que no sobra
 *  10. y se dice desde cuándo sobra algo, que hasta ahí carga la batería
 *  11. sin errores de consola
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

  console.log("\n1-2 · el desvío se dice");
  let t = await abrir(b, "?bat=4.2&desvio=15");
  ok(/tu tejado va al 15 % de lo previsto/.test(t),
    `con el porcentaje que es («${(t.match(/Hoy tu tejado va al[^.]*\./) || [""])[0]}»)`);
  ok(/la hora de arriba ya va rebajada/.test(t), "y que la hora ya lo lleva puesto");
  ok(/la hora de las 10:00/.test(t) && /está dando ahora mismo/.test(t),
    "explicando con qué se ha medido, que son dos cosas");
  ok(/se corrige solo en cuanto el tejado lo note/.test(t),
    "y que si remonta mejora solo");

  console.log("\n3-4 · con un solo testigo, no se inventa el otro");
  t = await abrir(b, "?bat=4.2&desvio=30&testigo=hora");
  ok(/la hora de las 10:00/.test(t) && !/ahora mismo/.test(t),
    "con la hora cerrada no se habla del instante");
  t = await abrir(b, "?bat=4.2&desvio=30&testigo=ahora");
  ok(/está dando ahora mismo/.test(t) && !/la hora de las/.test(t),
    "y con el instante no se habla de la hora");

  console.log("\n5-6 · lo que no se menciona");
  t = await abrir(b, "?bat=4.2&desvio=100");
  ok(!/Hoy tu tejado va al/.test(t), "un tejado que cumple no se menciona");
  t = await abrir(b, "?bat=4.2&desvio=90");
  ok(!/Hoy tu tejado va al/.test(t), "ni una desviación del 10 %, que no cambia nada");
  t = await abrir(b, "?bat=4.2");
  ok(!/Hoy tu tejado va al/.test(t), "y sin testigo no se dice nada");

  console.log("\n7 · el sesgo del tejado es otra cosa y sigue ahí");
  t = await abrir(b, "?bat=4.2&desvio=15");
  ok(/La previsión va corregida con lo que da tu tejado/.test(t),
    "las dos notas conviven");
  ok(/Aprendido de 11 días tuyos/.test(t), "y el sesgo sigue diciendo de cuántos días");
  t = await abrir(b, "?bat=4.2&desvio=15&sesgo=0");
  ok(!/Aprendido de/.test(t) && /tu tejado va al 15 %/.test(t),
    "sin sesgo aprendido, el desvío de hoy se sigue diciendo");

  console.log("\n8 · el titular dice lo que está en juego");
  // De una queja: *«el mensaje de "te sobran X kW hasta las X h" no me parece nada
  // práctico. Además, aburre ver siempre lo mismo»*. Las dos cosas con la misma
  // raíz: nadie tiene un aparato de 2,7 kW, así que la cifra no era una decisión;
  // y la frase no dependía de nada que cambiara salvo el número.
  t = await abrir(b, "?bat=4.2");
  ok(/te sobran [\d,]+ kWh/.test(t),
    `habla de los kWh que quedan («${(t.match(/Hasta las[^.]*\./) || [""])[0]}»)`);
  ok(/Gastarlos te ahorra [\d,]+\s?€/.test(t) && /se van a la red por [\d,]+\s?€/.test(t),
    `y de lo que valen por los dos lados («${(t.match(/Gastarlos[^.]*\./) || [""])[0]}»)`);
  ok(!/Te sobran [\d,]+ kW durante/.test(t),
    "y ya no de una potencia media que no es de ningún aparato");
  ok(!/[Ee]s el mejor momento del día para gastar/.test(t),
    "sin afirmar que este es el mejor momento y decir dos frases después que es otro");
  // La hora de cierre va en el titular: repetirla debajo no añadía nada.
  ok(!/cada kWh lo pagas/.test(t) || /a partir del cierre/.test(t),
    "y la hora no se dice dos veces");
  // Sin tarifa elegida no se inventan euros: se dice en energía.
  t = await abrir(b, "?bat=4.2&euros=0");
  ok(/te sobran [\d,]+ kWh/.test(t) && !/te ahorra/.test(t),
    "sin tarifa, los kWh sí y los euros no");
  ok(/no tendrías que comprar/.test(t),
    "y se dice por qué importan de todos modos");

  console.log("\n9 · de mañana, no saber no es saber que no");
  // De una queja: *«siempre aparece un mensaje de que mañana no habrá excedentes que
  // no tengo idea de a qué se refiere porque todos los días se exporta algo»*. Y era
  // verdad: sin previsión de mañana la tarjeta decía «no se espera excedente», que
  // es afirmar sobre un día del que no había ni un dato. Con un sensor que solo
  // publica hoy, eso salía todos los días.
  t = await abrir(b, "?bat=4.2&manana=0&prevmanana=0");
  ok(/mañana todavía no hay previsión/.test(t),
    `sin dato de mañana se dice que no hay dato («${(t.match(/De mañana[^.]*\./) || [""])[0]}»)`);
  ok(!/no se espera excedente/.test(t), "y no que no vaya a sobrar");
  ok(/separados por comas/.test(t), "con la salida: poner los dos sensores");
  // Y cuando sí hay previsión y de verdad no sobra, se dice lo que siempre.
  t = await abrir(b, "?bat=4.2&manana=0&prevmanana=1");
  ok(/no se espera excedente/.test(t),
    "con previsión y sin excedente, eso sí se afirma");
  ok(!/todavía no hay previsión/.test(t), "y entonces no se habla de sensores");

  console.log("\n10 · desde cuándo sobra algo que gastar");
  // La batería no se lleva su parte a prorrata: después de servir a la casa, el
  // inversor la lleva al 100 % cuanto antes, así que hasta que se llena no sobra
  // nada que enchufar. El total ya lo descontaba; la hora es lo que faltaba.
  t = await abrir(b, "?bat=4.2");
  ok(/No sobra nada que gastar hasta las \d\d:\d\d/.test(t),
    `se dice la hora («${(t.match(/No sobra nada[^.:]*hasta las \d\d:\d\d/) || [""])[0]}»)`);
  ok(/va entero a la batería/.test(t), "y por qué: hasta ahí el sol carga la batería");
  t = await abrir(b, "?bat=0");
  ok(!/No sobra nada que gastar hasta/.test(t),
    "con la batería llena no se hace esperar a nadie");

  await b.close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

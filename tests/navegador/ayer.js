/* «Lo que había sobre la mesa ayer»: el óptimo retrospectivo en la pantalla.
 *
 * El banco de Python (`optimo.py`) comprueba la cuenta con un día hecho a mano.
 * Este comprueba lo que puede romperse aquí:
 *
 *   1. el servidor la sirve con los datos del fake, y salen filas
 *   2. una fila que se podía mover dice **las dos horas** —la que fue y la mejor—
 *      y su ahorro; una que ya estaba bien lo dice y no finge un ahorro
 *   3. el titular es una **diferencia**, y en ninguna parte de la tarjeta se
 *      afirma «lo que gastaste»: el modelo de aquí no tiene batería y el desglose
 *      de arriba sí, así que dos cifras del mismo día se contradirían
 *   4. la fecha se escribe en cristiano, no en ISO
 *   5. no se le propone hora a lo que no se puede mover (una nevera)
 *   6. nada se sale de su tarjeta, y sin errores de consola
 *
 * El punto 3 es el que importa: es lo que impide que esta tarjeta se convierta en
 * una segunda opinión sobre la factura del día.
 */
const { abrirNavegador, base } = require("./camino");
const BASE = base("http://127.0.0.1:8402/");
const YO = "ffbanco00000000000000000000000f";
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

async function abrir(b, retoque) {
  const ctx = await b.newContext({
    viewport: { width: 414, height: 1700 },
    extraHTTPHeaders: { "X-Remote-User-Id": YO, "X-Remote-User-Display-Name": "Banco" },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => { if (m.type() === "error") fallos.push("console: " + m.text()); });
  if (retoque) {
    await p.route("**/api/bestday", async (ruta) => {
      const resp = await ruta.fetch();
      const cuerpo = await resp.json();
      retoque(cuerpo);
      await ruta.fulfill({ response: resp, json: cuerpo });
    });
  }
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.click('.tab[data-view="billing"]');
  await p.waitForFunction(
    () => {
      const c = document.querySelector("#best-rows");
      return c && !/Repasando/.test(c.textContent) && c.textContent.trim().length > 0;
    },
    { timeout: 30000 },
  );
  await p.waitForTimeout(400);
  return { ctx, p };
}

const leer = (p) => p.evaluate(() => {
  const panel = document.querySelector("#best-panel");
  const caja = panel.getBoundingClientRect();
  const filas = [...document.querySelectorAll("#best-rows .bd-row")].map((f) => ({
    id: f.dataset.id,
    movido: f.classList.contains("bd-movido"),
    nombre: f.querySelector(".bd-name")?.textContent.trim(),
    cuando: f.querySelector(".bd-when")?.textContent.replace(/\s+/g, " ").trim(),
    horas: (f.querySelector(".bd-when")?.textContent.match(/\d{1,2}:\d{2}/g) || []),
    valor: f.querySelector(".bd-num b")?.textContent.trim(),
    fuera: f.getBoundingClientRect().right > caja.right + 1,
  }));
  return {
    filas,
    sub: panel.querySelector("#best-sub").textContent.replace(/\s+/g, " ").trim(),
    nota: panel.querySelector("#best-note").textContent.replace(/\s+/g, " ").trim(),
    vacio: document.querySelector("#best-rows .empty")?.textContent.trim() || "",
    scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
});

(async () => {
  const b = await abrirNavegador();

  console.log("\n1-2 · las filas, con datos del fake");
  let { ctx, p } = await abrir(b);
  let v = await leer(p);
  ok(v.filas.length > 0, `salen las filas (${v.filas.length}) · ${v.vacio}`);
  const movidas = v.filas.filter((f) => f.movido);
  const quietas = v.filas.filter((f) => !f.movido);
  ok(movidas.length > 0, `alguna se podía mover (${movidas.map((f) => f.nombre)})`);
  if (movidas.length) {
    ok(movidas[0].horas.length === 2,
      `dice las dos horas, la que fue y la mejor («${movidas[0].cuando}»)`);
    ok(/^\+/.test(movidas[0].valor),
      `y el ahorro con su signo («${movidas[0].valor}»)`);
  }
  if (quietas.length) {
    ok(/ya era su mejor hueco/.test(quietas[0].cuando),
      `y la que ya estaba bien lo dice («${quietas[0].cuando}»)`);
    ok(quietas[0].valor === "—",
      `sin fingir un ahorro («${quietas[0].valor}»)`);
  }

  console.log("\n3 · es una diferencia, no una factura");
  ok(/te habrías ahorrado/.test(v.sub) || /no había ni cinco céntimos/.test(v.sub),
    `el titular es el ahorro que había («${v.sub.slice(0, 64)}…»)`);
  ok(!/(gastaste|te costó|coste del día)/i.test(v.sub + " " + v.nota),
    "y en ninguna parte se afirma lo que se gastó");
  ok(/La batería queda fuera/.test(v.nota),
    "se dice que la batería no está en esta cuenta");
  ok(/no lo que se hizo mal/.test(v.nota),
    "y que es lo que había, no un reproche");

  console.log("\n4 · la fecha, en cristiano");
  ok(!/\d{4}-\d{2}-\d{2}/.test(v.nota), `sin ISO crudo en la nota («${
    (v.nota.match(/el ([^—]+)—/) || [])[1] || "?"}»)`);
  ok(/\d{1,2} de [a-z]{3}/.test(v.nota) || /\d{1,2} [a-z]{3}/.test(v.nota),
    "y con el día y el mes escritos");

  console.log("\n5 · a lo que no se mueve no se le propone hora");
  // La nevera del fake es un continuo: no puede salir en esta tabla.
  const nombres = v.filas.map((f) => f.nombre);
  ok(!nombres.some((n) => /nevera|congelador/i.test(n || "")),
    `ningún continuo entre las filas (${nombres})`);
  // Y el payload lo confirma: hay más aparatos que movibles.
  const cuenta = await p.evaluate(async (raiz) => {
    const d = await (await fetch(raiz + "api/bestday")).json();
    return { aparatos: d.appliances, movibles: d.movable,
             ids: (d.best?.rows || []).map((r) => r.id) };
  }, BASE);
  ok(cuenta.movibles < cuenta.aparatos,
    `el servidor filtra por forma de uso (${cuenta.movibles} movibles de ${cuenta.aparatos})`);

  console.log("\n6 · nada se sale de su tarjeta");
  ok(!v.filas.some((f) => f.fuera), "ninguna fila se sale del panel");
  ok(!v.scrollX, "y la pantalla no gana scroll horizontal");
  await ctx.close();

  console.log("\n7 · un día en el que no había nada que ganar");
  // Se inyecta, porque que el día del fake tenga margen no es algo que este banco
  // pueda dar por hecho: depende de a qué hora corra.
  ({ ctx, p } = await abrir(b, (c) => {
    if (!c.best) return;
    c.best.saving_eur = 0.0;
    for (const r of c.best.rows) {
      r.saving_eur = 0.0;
      r.already_best = true;
      r.best_at = r.ran_at;
    }
  }));
  v = await leer(p);
  ok(/no había ni cinco céntimos/.test(v.sub),
    `se felicita en vez de callar («${v.sub.slice(0, 70)}…»)`);
  ok(v.filas.every((f) => !f.movido), "y ninguna fila se marca como movible");
  await ctx.close();

  await b.close();
  console.log();
  if (fallos.length) {
    console.log(`${fallos.length} fallos`);
    [...new Set(fallos)].forEach((f) => console.log("  " + f));
    process.exit(1);
  }
  console.log("todo en verde");
})();

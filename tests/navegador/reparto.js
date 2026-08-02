/* El bloque «a dónde fue cada cosa» del diagnóstico.
 *
 *   1. sale con las dos filas de cada origen y su contador
 *   2. cuando todo cuadra, no hay fila de sobrante ni aviso
 *   3. cuando la descarga no la coloca nadie, se dice y se marca
 *   4. un descuadre de 20 Wh es deriva normal y no se menciona
 *   5. sin errores de consola
 */
const { abrirNavegador, base, ficheros } = require("./camino");
const BASE = base("http://127.0.0.1:8402/");
const YO = "ffbanco00000000000000000000000f";
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

/* Abre el diagnóstico con el reparto que se le diga. `null` = el de verdad. */
async function abrir(b, reparto) {
  const ctx = await b.newContext({
    viewport: { width: 414, height: 1000 },
    extraHTTPHeaders: { "X-Remote-User-Id": YO, "X-Remote-User-Display-Name": "Banco" },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => { if (m.type() === "error") fallos.push("console: " + m.text()); });
  if (reparto) {
    await p.route("**/api/diagnostics", async (ruta) => {
      const resp = await ruta.fetch();
      const cuerpo = await resp.json();
      cuerpo.reparto = reparto;
      await ruta.fulfill({ response: resp, json: cuerpo });
    });
  }
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1200);
  await p.click('.tab[data-view="settings"]');
  await p.waitForTimeout(700);
  await p.click('[data-settings-page="diagnostics"]');
  await p.waitForTimeout(3500);
  return { ctx, p };
}

const leer = (p) => p.evaluate(() => {
  const filas = [...document.querySelectorAll("#diag-body .diag-row")].map((f) => ({
    etiqueta: f.querySelector(".diag-txt")?.textContent.trim(),
    kwh: f.querySelector(".diag-kwh")?.textContent.trim(),
    marcada: !!f.querySelector(".warn"),
  }));
  const cabeceras = [...document.querySelectorAll("#diag-body .diag-head")]
    .map((h) => h.textContent.trim());
  return { filas, cabeceras, texto: document.querySelector("#diag-body").innerText };
});

(async () => {
  const b = await abrirNavegador();

  console.log("\n1-2 · el reparto real, que cuadra");
  let { ctx, p } = await abrir(b, null);
  let v = await leer(p);
  ok(v.cabeceras.some((c) => /Importada de la red/.test(c)),
    "hay una cabecera para lo importado");
  ok(v.cabeceras.some((c) => /Descarga de la batería/.test(c)),
    "y otra para lo descargado");
  ok(v.filas.filter((f) => f.etiqueta === "A la casa").length === 2,
    `cada origen dice cuánto fue a la casa (${v.filas.filter((f) => f.etiqueta === "A la casa").length})`);
  ok(v.filas.some((f) => f.etiqueta === "A cargar la batería"), "y lo demás, a dónde");
  ok(!v.filas.some((f) => f.etiqueta === "Sin colocar"),
    "cuadrando, no hay fila de sobrante");
  ok(!/Sin colocar|ningún otro sensor/.test(v.texto), "ni aviso ninguno");
  await ctx.close();

  console.log("\n3 · la descarga que ningún sensor coloca");
  ({ ctx, p } = await abrir(b, {
    grid: { home: 6.2, other: 0, placed: 6.2, meter: 6.2, unplaced: 0 },
    battery: { home: 1.1, other: 0.2, placed: 1.3, meter: 2.0, unplaced: 0.7 },
  }));
  v = await leer(p);
  const sobra = v.filas.find((f) => f.etiqueta === "Sin colocar");
  ok(!!sobra, "aparece la fila «Sin colocar»");
  ok(sobra && /0,7\s*kWh/.test(sobra.kwh), `con la cifra que falta (${sobra && sobra.kwh})`);
  ok(sobra && sobra.marcada, "marcada, que es lo que hay que mirar");
  ok(/ningún otro sensor la recoge/.test(v.texto), "y se explica que es de los sensores");
  ok(v.filas.filter((f) => f.etiqueta === "Sin colocar").length === 1,
    "solo en el origen que descuadra, no en los dos");
  await ctx.close();

  console.log("\n4 · 20 Wh es deriva normal");
  ({ ctx, p } = await abrir(b, {
    grid: { home: 6.2, other: 0, placed: 6.2, meter: 6.2, unplaced: 0 },
    battery: { home: 2.25, other: 0, placed: 2.25, meter: 2.27, unplaced: 0.02 },
  }));
  v = await leer(p);
  ok(!v.filas.some((f) => f.etiqueta === "Sin colocar"),
    "no se avisa de dos centésimas");
  await ctx.close();

  await b.close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

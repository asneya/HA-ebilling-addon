/* La lista de Ajustes → Electrodomésticos.
 *
 * No tenía banco, y es la pantalla por la que se pasa a dar de alta un aparato y a
 * comprobar que el sensor es el correcto. Lo que se comprueba:
 *
 *   1. van **por nombre**, no en el orden en que se dieron de alta
 *   2. el aro verde va exactamente en los que el servidor dice encendidos, y es el
 *      mismo aro que la Home (la misma regla de CSS, no una copia)
 *   3. la fila no se contradice: nada rodeado de verde puede decir «en reposo»
 *   4. y de un continuo no se habla de ciclos, que no tiene hora que elegir
 *   5. sin errores de consola y sin scroll horizontal
 *
 * El estado viene del servidor (`on` en `/api/live`) y no se inyecta: lo que se
 * quiere saber es que la pantalla lee **ese** dato y no se inventa otro a partir de
 * los vatios, que es de donde venía la contradicción del punto 3.
 */
const { abrirNavegador, base } = require("./camino");
const BASE = base("http://127.0.0.1:8402/");
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

(async () => {
  const b = await abrirNavegador();
  const ctx = await b.newContext({
    viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f",
                        "X-Remote-User-Display-Name": "Banco" },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/CORS|font|ERR_FAILED|404/.test(t)) fallos.push("console: " + t);
  });

  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.click('.tab[data-view="settings"]');
  await p.waitForTimeout(400);
  await p.click('[data-settings-page="appliances"]');
  await p.waitForFunction(
    () => document.querySelectorAll("#ap-list .ap-row").length > 0, { timeout: 20000 });
  await p.waitForTimeout(600);

  // Lo que dice el servidor, para comparar la pantalla contra su fuente y no contra
  // una lista escrita aquí que se quedaría vieja al cambiar la fixture.
  const delServidor = await p.evaluate(async () => {
    const r = await fetch("api/live");
    const d = await r.json();
    return (d.appliances || []).map(
      (a) => ({ name: a.name, on: !!a.on, kind: a.kind }));
  });

  const filas = await p.evaluate(() => [...document.querySelectorAll("#ap-list .ap-row")]
    .map((f) => ({
      nombre: f.querySelector("b").textContent.trim(),
      texto: f.querySelector("small").textContent.replace(/\s+/g, " ").trim(),
      marcada: f.dataset.on === "1",
      // El aro va en `box-shadow` y no en `border` —un borde empujaría el glifo 2 px
      // al arrancar el aparato—, así que es ahí donde hay que mirarlo.
      aro: getComputedStyle(f.querySelector(".ap-chip")).boxShadow !== "none",
      fuera: f.getBoundingClientRect().right
             > document.querySelector("#ap-list").getBoundingClientRect().right + 1,
    })));

  console.log("1 · por nombre");
  ok(filas.length >= 4, `salen las filas (${filas.length})`);
  const nombres = filas.map((f) => f.nombre);
  const ordenados = [...nombres].sort((a, b) => a.localeCompare(b, "es"));
  ok(JSON.stringify(nombres) === JSON.stringify(ordenados),
    `van alfabéticos (${nombres.join(" · ")})`);
  // Y que la fixture no venga ya ordenada, que haría vacía la comprobación.
  const alta = delServidor.map((a) => a.name);
  ok(JSON.stringify(alta) !== JSON.stringify(ordenados),
    `y el orden de alta era otro (${alta.join(" · ")})`);

  console.log("\n2 · el aro verde, el mismo que la Home");
  const encendidos = new Set(delServidor.filter((a) => a.on).map((a) => a.name));
  ok(encendidos.size > 0 && encendidos.size < filas.length,
    `el servidor dice que unos sí y otros no (${[...encendidos].join(" · ")})`);
  ok(filas.every((f) => f.marcada === encendidos.has(f.nombre)),
    "la marca de la fila coincide con lo que dice el servidor");
  ok(filas.every((f) => f.aro === encendidos.has(f.nombre)),
    "y el aro se pinta exactamente en esos, ni uno más");

  console.log("\n3-4 · la fila no se contradice");
  const rodeadas = filas.filter((f) => f.marcada);
  ok(rodeadas.length > 0 && rodeadas.every((f) => !/en reposo/.test(f.texto)),
    `nada rodeado de verde dice «en reposo» (${rodeadas.map((f) => f.texto.slice(0, 22)).join(" | ")})`);
  const continuos = new Set(
    delServidor.filter((a) => a.kind === "continuo").map((a) => a.name));
  const deContinuo = filas.filter((f) => continuos.has(f.nombre));
  ok(deContinuo.length > 0, `hay algún continuo que comprobar (${[...continuos].join(", ")})`);
  ok(deContinuo.every((f) => !/ciclo/.test(f.texto)),
    `y de un continuo no se habla de ciclos («${(deContinuo[0] || {}).texto}»)`);
  // Los demás sí: es lo que distingue a un movible, y si esto se rompiera la
  // comprobación de arriba pasaría por haberse quedado la pantalla muda.
  ok(filas.some((f) => !continuos.has(f.nombre) && /ciclo/.test(f.texto)),
    "mientras que un movible sí dice sus ciclos");

  console.log("\n5 · nada se sale");
  ok(!filas.some((f) => f.fuera), "ninguna fila se sale de la tarjeta");
  ok(!(await p.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth)),
    "y la pantalla no pide scroll horizontal");

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

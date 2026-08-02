/* Reordenar y ocultar tarjetas de la Home, en el navegador y por usuario.
 *
 *   1. Ajustes → Pantalla de inicio las lista todas, en su orden
 *   2. y dice que lo que se toca ahí es solo tuyo
 *   3. bajar una la mueve de verdad en la Home
 *   4. sin desmontar el componente del caudal (no se reinicializa al reordenar)
 *   5. ocultar una la quita de la Home y la deja en la lista
 *   6. las flechas de los extremos están desactivadas
 *   7. el cierre son dos elementos y se mueven juntos
 *   8. la ventana y su consejo, también
 *   9. otro usuario ve lo suyo, no lo de este
 *  10. ocultarlo todo avisa en vez de dejar la pantalla en blanco
 *  11. cabe a 320 px
 */
const { abrirNavegador, base, ficheros } = require("./camino");
const BASE = base("http://127.0.0.1:8404/");
const ANA = "01ffaa11223344556677889900aabbcc";
const LUIS = "02bb99887766554433221100ffeeddcc";
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

const abrir = async (ctx, ancho) => {
  const p = await ctx.newPage();
  if (ancho) await p.setViewportSize({ width: ancho, height: 900 });
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => { if (m.type() === "error") fallos.push("console: " + m.text()); });
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1200);
  return p;
};

/* El orden en que se ven de verdad las tarjetas: se ordena por el `order` que
   les ha puesto el JS, que es lo que decide el pintado, y se descartan las
   ocultas. Leer el DOM en orden de documento no valdría: no se mueven nodos. */
const enPantalla = (p) => p.evaluate(() => {
  const vistas = [...document.querySelectorAll("#home-cards [data-card]")]
    .filter((el) => !el.classList.contains("card-off"))
    .map((el) => ({ id: el.dataset.card, order: Number(el.style.order) }))
    .sort((a, b) => a.order - b.order);
  const ids = [];
  vistas.forEach((v) => { if (!ids.includes(v.id)) ids.push(v.id); });
  return ids;
});

const irAjustesInicio = async (p) => {
  await p.click('.tab[data-view="settings"]');
  await p.waitForTimeout(700);
  await p.click('[data-settings-page="home"]');
  await p.waitForTimeout(700);
};

const lista = (p) => p.evaluate(() =>
  [...document.querySelectorAll("#home-cards-list [data-card-row]")]
    .map((li) => li.dataset.cardRow));

(async () => {
  const b = await abrirNavegador();

  // Se parte de cero para Ana: el banco se puede repetir.
  const limpio = await b.newContext({ extraHTTPHeaders: { "X-Remote-User-Id": ANA } });
  await limpio.request.put(BASE + "api/settings", {
    data: { home_order: ["ahora", "cierre", "ventana", "plan", "resumen"], home_hidden: [] },
  });
  await limpio.close();

  const ctxAna = await b.newContext({
    viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": ANA, "X-Remote-User-Display-Name": "Ana" },
  });
  const p = await abrir(ctxAna);

  console.log("\n1-2 · la lista de Ajustes");
  await irAjustesInicio(p);
  ok((await lista(p)).join(",") === "ahora,cierre,ventana,plan,resumen",
    `las cinco en su orden (${(await lista(p)).join(" · ")})`);
  const quien = await p.textContent("#home-quien");
  ok(/Solo para ti, Ana/.test(quien), `dice de quién es: «${quien.slice(0, 46)}…»`);

  console.log("\n6 · los extremos no se pueden mover más");
  const extremos = await p.evaluate(() => {
    const filas = [...document.querySelectorAll("#home-cards-list [data-card-row]")];
    const bot = (li, s) => li.querySelector(s).disabled;
    return {
      primeraArriba: bot(filas[0], ".up"), primeraAbajo: bot(filas[0], ".down"),
      ultimaAbajo: bot(filas[filas.length - 1], ".down"),
    };
  });
  ok(extremos.primeraArriba && !extremos.primeraAbajo && extremos.ultimaAbajo,
    "la primera no sube y la última no baja");

  console.log("\n6b · la flecha de subir apunta arriba");
  const flechas = await p.evaluate(() => {
    const caja = (s) => {
      const svg = document.querySelector(`[data-card-row="ventana"] ${s} .i`);
      const r = svg.getBoundingClientRect();
      // El punto de la punta del chevron tras el giro: se compara el centro del
      // trazo con el del recuadro leyendo la matriz aplicada.
      const m = new DOMMatrix(getComputedStyle(svg).transform);
      return { r, ang: Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI) };
    };
    return { up: caja(".up").ang, down: caja(".down").ang };
  });
  ok(flechas.up === -90, `subir gira el chevron hacia arriba (${flechas.up}\u00b0)`);
  ok(flechas.down === 90, `y bajar, hacia abajo (${flechas.down}\u00b0)`);
  ok(!(await p.isVisible("#settings-save-bar")),
    "sin barra de guardar: cada cambio se guarda solo");

  console.log("\n3-4 · bajar una tarjeta");
  const antes = await p.evaluate(() => {
    const n = document.querySelector("#flow vatia-flow");
    if (n) n.__marca = 1;                    // para ver si sobrevive al reorden
    return !!n;
  });
  await p.click('[data-card-row="ahora"] .down');
  await p.waitForTimeout(1400);
  ok((await lista(p)).join(",") === "cierre,ahora,ventana,plan,resumen",
    `la lista se reordena (${(await lista(p)).join(" · ")})`);
  ok(/Guardado/.test(await p.textContent("#home-estado")),
    `y lo dice: «${(await p.textContent("#home-estado")).trim()}»`);
  await p.click('.tab[data-view="home"]');
  await p.waitForTimeout(1200);
  const orden = await enPantalla(p);
  ok(orden.indexOf("ahora") > orden.indexOf("cierre") || !orden.includes("cierre"),
    `la Home la mueve de verdad (${orden.join(" · ")})`);
  const vive = await p.evaluate(() => {
    const n = document.querySelector("#flow vatia-flow");
    return !!n && n.__marca === 1;
  });
  ok(!antes || vive, "el componente del caudal no se ha desmontado al reordenar");

  console.log("\n7-8 · los grupos de dos elementos");
  const grupos = await p.evaluate(() => {
    const de = (id) => [...document.querySelectorAll(`#home-cards [data-card="${id}"]`)]
      .map((el) => Number(el.style.order));
    return { cierre: de("cierre"), ventana: de("ventana") };
  });
  ok(grupos.cierre.length === 2 && grupos.cierre[0] === grupos.cierre[1],
    `el cierre son dos elementos con el mismo orden (${grupos.cierre.join(", ")})`);
  ok(grupos.ventana.length === 2 && grupos.ventana[0] === grupos.ventana[1],
    `la ventana y su consejo, también (${grupos.ventana.join(", ")})`);

  console.log("\n5 · ocultar");
  await irAjustesInicio(p);
  await p.click('[data-card-row="resumen"] [data-card-ver]');
  await p.waitForTimeout(1400);
  ok((await lista(p)).includes("resumen"), "sigue en la lista de Ajustes");
  ok(await p.evaluate(() =>
    document.querySelector('#home-cards-list [data-card-row="resumen"]').dataset.off === "1"),
    "marcada como oculta");
  await p.click('.tab[data-view="home"]');
  await p.waitForTimeout(1000);
  ok(!(await enPantalla(p)).includes("resumen"),
    `y fuera de la Home (${(await enPantalla(p)).join(" · ")})`);

  console.log("\n9 · otro usuario");
  const ctxLuis = await b.newContext({
    viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": LUIS, "X-Remote-User-Display-Name": "Luis" },
  });
  const q = await abrir(ctxLuis);
  const suyo = await enPantalla(q);
  ok(suyo.includes("resumen"), `Luis sigue viendo el resumen (${suyo.join(" · ")})`);
  ok(suyo[0] === "ahora" || !suyo.includes("cierre"),
    "y su orden es el suyo, no el de Ana");
  await irAjustesInicio(q);
  ok(/Solo para ti, Luis/.test(await q.textContent("#home-quien")), "y Ajustes lo dice");
  await ctxLuis.close();

  console.log("\n10 · ocultarlo todo");
  await irAjustesInicio(p);
  for (const id of ["ahora", "cierre", "ventana", "plan"]) {
    await p.click(`[data-card-row="${id}"] [data-card-ver]`);
    await p.waitForTimeout(900);
  }
  await p.click('.tab[data-view="home"]');
  await p.waitForTimeout(900);
  ok((await enPantalla(p)).length === 0, "no queda ninguna tarjeta");
  ok(await p.isVisible("#home-empty"), "pero se avisa en vez de dejarlo en blanco");
  ok(/Ajustes → Pantalla de inicio/.test(await p.textContent("#home-empty")),
    "y se dice por dónde se deshace");

  console.log("\n11 · a 320 px");
  await p.setViewportSize({ width: 320, height: 800 });
  await irAjustesInicio(p);
  const desborde = await p.evaluate(() => {
    const l = document.querySelector("#home-cards-list");
    return Math.max(0, l.scrollWidth - l.clientWidth);
  });
  ok(desborde === 0, `la lista no se va a lo ancho (${desborde} px)`);
  ok(await p.evaluate(() => {
    const b2 = document.querySelector('[data-card-row="ahora"] .down').getBoundingClientRect();
    return b2.right <= window.innerWidth && b2.width >= 30;
  }), "y las flechas caben y son pulsables");

  // Se deja como estaba, que el banco se puede repetir.
  await p.evaluate(() => fetch("api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ home_order: ["ahora", "cierre", "ventana", "plan", "resumen"], home_hidden: [] }),
  }));
  await b.close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

/* Reordenar y ocultar tarjetas de la Home, en el navegador y por usuario.
 *
 *   1. Ajustes → Pantalla de inicio las lista todas, en su orden
 *
 * Cuáles son «todas» se lee del catálogo de la propia aplicación
 * (`core/tarjetas.js`) y no se escribe aquí: lo que este banco comprueba es el
 * mecanismo, y tenerlas a mano hacía que añadir una tarjeta lo pusiera en rojo
 * sin que nada estuviera roto.
 *   2. y dice que lo que se toca ahí es solo tuyo
 *   3. bajar una la mueve de verdad en la Home
 *   4. sin desmontar el componente del caudal (no se reinicializa al reordenar)
 *   5. ocultar una la quita de la Home y la deja en la lista
 *   6. las flechas de los extremos están desactivadas
 *   7. el cierre son dos elementos y se mueven juntos
 *   8. y la ventana, que desde la fusión de las tarjetas es un elemento solo
 *   9. otro usuario ve lo suyo, no lo de este
 *  10. ocultarlo todo avisa en vez de dejar la pantalla en blanco
 *  11. cabe a 320 px
 *  12. y el catálogo llama a cada tarjeta como se llama de verdad en la Home
 *  13. el hueco entre tarjetas es el mismo en cualquier orden
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

/* El catálogo, leído de la propia aplicación.

   Antes estaban las cinco escritas a mano aquí, y añadir una sexta tarjeta ponía
   este banco en rojo sin que nada estuviera roto. Lo que este banco comprueba es
   el **mecanismo** —que se listan todas, que se mueven, que se ocultan—, no cuáles
   son; el catálogo es de `core/tarjetas.js` y de ahí se lee. */
const catalogo = (p) => p.evaluate(() =>
  import("/static/core/tarjetas.js").then((m) => m.CATALOGO.map((c) => c.id)));

(async () => {
  const b = await abrirNavegador();

  const ctxAna = await b.newContext({
    viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": ANA, "X-Remote-User-Display-Name": "Ana" },
  });
  let p = await abrir(ctxAna);
  const TODAS = await catalogo(p);
  const DE_FABRICA = TODAS.join(",");

  // Se parte de cero para Ana: el banco se puede repetir. El orden de partida es
  // el del catálogo, así que una tarjeta nueva no obliga a tocar esto.
  const limpio = await b.newContext({ extraHTTPHeaders: { "X-Remote-User-Id": ANA } });
  await limpio.request.put(BASE + "api/settings", {
    data: { home_order: TODAS, home_hidden: [] },
  });
  await limpio.close();
  await p.close();
  p = await abrir(ctxAna);

  console.log("\n1-2 · la lista de Ajustes");
  await irAjustesInicio(p);
  ok((await lista(p)).join(",") === DE_FABRICA,
    `las ${TODAS.length} en su orden (${(await lista(p)).join(" · ")})`);
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
  // Bajar la primera la pone segunda: se intercambian los dos primeros y el resto
  // se queda como estaba.
  const bajada = [TODAS[1], TODAS[0], ...TODAS.slice(2)].join(",");
  ok((await lista(p)).join(",") === bajada,
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
  // La ventana **era** dos elementos: ella y «Cabe en la ventana», que iba pegado
  // debajo con su mismo `data-card`. Al fusionar las dos tarjetas de aparatos en
  // una, el consejo desapareció y la ventana se quedó sola. Lo que sigue
  // importando es que el grupo se mueva junto, cualquiera que sea su tamaño.
  ok(grupos.ventana.length >= 1
     && new Set(grupos.ventana).size === 1,
    `la ventana se mueve como un grupo (${grupos.ventana.join(", ")})`);

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
  // Todas menos «resumen», que la sección 5 ya ha ocultado. Se recorre el
  // catálogo, así que una tarjeta nueva entra sola en esta comprobación en vez de
  // dejarla a medias sin que nadie se entere.
  for (const id of TODAS.filter((x) => x !== "resumen")) {
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

  console.log("\n12 · el catálogo dice los nombres de verdad");
  // El catálogo solo se lee en Ajustes, así que puede quedarse describiendo una
  // tarjeta que ya no existe sin que nada se rompa: pasó, y durante tres
  // versiones, con «El plan de hoy · a qué hora sale más barato cada
  // electrodoméstico» cuando esa tarjeta ya se llamaba «Tus aparatos» y contaba
  // bastante más. Las que llevan su título escrito en la Home se pueden comparar,
  // y son justo las que cambian.
  await p.setViewportSize({ width: 414, height: 900 });
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1200);
  const nombres = await p.evaluate(async () => {
    const { CATALOGO } = await import("./static/core/tarjetas.js");
    return CATALOGO.map((t) => {
      const el = document.querySelector(`#home-cards [data-card="${t.id}"] .ad-title`);
      return { id: t.id, name: t.name, claim: t.claim, titulo: el?.textContent.trim() || null };
    });
  });
  const conTitulo = nombres.filter((x) => x.titulo);
  ok(conTitulo.length >= 2,
    `hay tarjetas con su título escrito para comparar (${conTitulo.map((x) => x.id).join(", ")})`);
  conTitulo.forEach((x) => {
    ok(x.name === x.titulo,
      `«${x.id}» se llama igual en las dos partes (catálogo «${x.name}» · Home «${x.titulo}»)`);
  });
  ok(nombres.every((x) => x.claim && x.claim.length > 12 && x.name),
    "y ninguna se queda sin nombre ni sin lo que hace");

  console.log("\n13 · el hueco entre tarjetas, en cualquier orden");
  // De una queja, con la tarjeta del cierre puesta arriba: *«parece que le falta el
  // margen inferior con la siguiente tarjeta»*. Y le faltaba: la separación la ponía
  // el `margin-bottom` de `.panel`, y la del cierre es la única que **no** es un
  // `.panel` —lleva su propio fondo de degradado—, así que nunca tuvo hueco debajo.
  // Mientras estaba la última no se notaba.
  //
  // Se mide de verdad, del borde de una al borde de la siguiente y **en el orden en
  // que se ven**: un margen del hijo se cuenta en el orden del documento, y aquí las
  // tarjetas se reordenan con `order`, así que leer el DOM en orden no valdría.
  const huecos = (pag) => pag.evaluate(() => {
    const cont = document.querySelector("#home-cards");
    const vistas = [...cont.children]
      .filter((el) => !el.classList.contains("card-off")
        && el.getBoundingClientRect().height > 4
        && getComputedStyle(el).display !== "none")
      .map((el) => ({ id: el.dataset.card || el.id, r: el.getBoundingClientRect() }))
      .sort((a, b) => a.r.top - b.r.top);
    return vistas.slice(1).map((v, i) => ({
      de: vistas[i].id, a: v.id,
      hueco: Math.round((v.r.top - vistas[i].r.bottom) * 10) / 10,
    }));
  });
  await p.evaluate((todas) => fetch("api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ home_order: todas, home_hidden: [] }),
  }), TODAS);
  // La tarjeta del cierre solo sale tras la puesta de sol, y el banco pasa a
  // cualquier hora: se le **inyecta el cierre en el payload** en vez de quitarle la
  // clase `hidden`. No es lo mismo, y la diferencia importa: sin datos el componente
  // no dibuja nada, la tarjeta mide cero, y como hijo de un contenedor con `gap` un
  // hijo de altura cero se come dos huecos y sale un 28 que no existe en la
  // aplicación —donde una tarjeta vacía siempre va con `hidden`, o sea fuera del
  // flujo—. Medir un estado imposible es medir otra cosa.
  await p.route("**/api/live", async (ruta) => {
    const resp = await ruta.fetch();
    const cuerpo = await resp.json();
    cuerpo.close = cuerpo.close || {
      date: new Date().toISOString().slice(0, 10),
      sunset: new Date().toISOString(), minutes_since: 30,
      produced: 24.3, consumed: 11.2, self_pct: 78,
      in_window: { kwh: 6.4, pct: 57 }, saved: null,
      appliances: [], tomorrow: null,
    };
    await ruta.fulfill({ response: resp, json: cuerpo });
  });
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1800);
  let pares = await huecos(p);
  ok(pares.length >= 2, `hay tarjetas seguidas que medir (${pares.length} pares)`);
  const iguales = (lista) => new Set(lista.map((x) => x.hueco)).size === 1;
  ok(iguales(pares) && pares[0].hueco > 1,
    `todas separadas lo mismo (${[...new Set(pares.map((x) => x.hueco))].join(", ")} px)`);
  // Y con el cierre arriba, que es el caso de la queja: el orden no puede cambiar
  // los huecos.
  await p.evaluate(() => {
    document.querySelectorAll("#home-cards [data-card]").forEach((el) => {
      el.style.order = el.dataset.card === "cierre" ? "-1" : "1";
    });
  });
  await p.waitForTimeout(300);
  pares = await huecos(p);
  const pegadas = pares.filter((x) => x.hueco <= 1);
  ok(!pegadas.length,
    `con el cierre arriba tampoco se pegan${pegadas.length
      ? ` (${pegadas.map((x) => `${x.de}→${x.a}`).join(", ")})` : ""}`);
  ok(iguales(pares),
    `y siguen todas iguales (${[...new Set(pares.map((x) => x.hueco))].join(", ")} px)`);

  // Se deja como estaba, que el banco se puede repetir.
  await p.evaluate((todas) => fetch("api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ home_order: todas, home_hidden: [] }),
  }), TODAS);
  await b.close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

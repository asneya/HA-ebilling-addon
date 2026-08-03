/* Volver a la aplicación después de un rato fuera.
 *
 * De una queja: *«a veces el gráfico de flujo en tiempo real de la home no aparece
 * al volver a la app de segundo plano y se ve un mensaje de Load failed»*.
 *
 * «Load failed» es lo que dice Safari por dentro cuando un `fetch` no llega a
 * hablar, y es lo que pasa en iOS con la petición que estaba en vuelo al dormir la
 * aplicación. Eso no era un error de la casa ni del servidor, y aun así:
 *
 *   · se enseñaba tal cual, con las palabras del navegador;
 *   · y el caudal que estaba pintado se tiraba entero (`innerHTML = ""`) por un
 *     fallo de un segundo, dejando un hueco donde había un dibujo que hacía veinte
 *     segundos era verdad;
 *   · sin reintentar: había que esperar el siguiente latido de veinte segundos.
 *
 * Lo que se comprueba:
 *
 *   1. un refresco que falla **no borra** el caudal que ya se veía
 *   2. se avisa de que el dato no es de ahora
 *   3. y no se le enseña a nadie el «Load failed» del navegador
 *   4. al volver la red, el caudal vuelve a estar al día y sin aviso
 *   5. al volver de segundo plano se pide dato nuevo sin esperar el latido
 *   6. y si falla la primera de todas, ahí sí se explica, en castellano
 */
const { abrirNavegador, base } = require("./camino");
const BASE = base("http://127.0.0.1:8402/");
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

// El dibujo no está en `#flow`: ahí solo vive la etiqueta del componente, y el SVG
// cuelga de su shadow root. Medirlo por fuera daba 25 caracteres siempre.
const estado = (p) => p.evaluate(() => ({
  dibujo: (document.querySelector("#flow")?.firstElementChild
    ?.shadowRoot?.innerHTML || "").length,
  hueco: !document.querySelector("#flow-empty")?.classList.contains("hidden"),
  huecoTxt: document.querySelector("#flow-empty")?.textContent.trim() || "",
  sub: document.querySelector("#home-sub")?.textContent.trim() || "",
  viejo: document.querySelector("#flow-panel")?.classList.contains("viejo") || false,
}));

(async () => {
  const b = await abrirNavegador();

  console.log("\n1-4 · un refresco que falla no borra lo que había");
  let ctx = await b.newContext({ viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f" } });
  let p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1500);
  const bueno = await estado(p);
  ok(bueno.dibujo > 200 && !bueno.hueco,
    `de salida hay caudal pintado (${bueno.dibujo} caracteres de SVG)`);

  // Se corta la red **después** del primer pintado, que es el caso de iOS: la
  // petición no llega a hablar y el navegador lanza un TypeError.
  let cortada = true;
  await p.route("**/api/live", (ruta) => (cortada ? ruta.abort("failed") : ruta.continue()));
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await p.waitForTimeout(1200);
  const roto = await estado(p);
  ok(roto.dibujo > 200, `el caudal sigue ahí (${roto.dibujo} caracteres)`);
  ok(!roto.hueco, "sin hueco ni cartel donde estaba el dibujo");
  ok(roto.viejo, "marcado de dato viejo, que es lo que sí ha cambiado");
  ok(/sin conexi/i.test(roto.sub), `y se dice en la cabecera («${roto.sub}»)`);
  ok(!/load failed/i.test(roto.huecoTxt + roto.sub),
    "nadie ve el «Load failed» del navegador");

  // Y al volver la red se recupera solo, con el reintento corto.
  cortada = false;
  await p.waitForTimeout(3500);
  const vuelto = await estado(p);
  ok(!vuelto.viejo, "al volver la red se quita la marca de viejo");
  ok(!/sin conexi/i.test(vuelto.sub), `y la cabecera vuelve a lo suyo («${vuelto.sub}»)`);
  await ctx.close();

  console.log("\n5 · volver de segundo plano pide dato nuevo");
  ctx = await b.newContext({ viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f" } });
  p = await ctx.newPage();
  let peticiones = 0;
  await p.route("**/api/live", (ruta) => { peticiones += 1; ruta.continue(); });
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1200);
  const antes = peticiones;
  // El latido son veinte segundos: si sin tocar nada llega otra petición en dos,
  // es porque la ha pedido la vuelta y no el reloj.
  await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await p.waitForTimeout(1500);
  ok(peticiones > antes, `pide dato al volver, sin esperar el latido (${antes} → ${peticiones})`);
  await ctx.close();

  console.log("\n6 · si falla la primera de todas, se explica");
  ctx = await b.newContext({ viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f" } });
  p = await ctx.newPage();
  await p.route("**/api/live", (ruta) => ruta.abort("failed"));
  await p.goto(BASE);
  await p.waitForTimeout(4000);
  const primera = await estado(p);
  ok(primera.hueco, "sin nada que conservar, ahí sí sale el hueco");
  ok(/Home Assistant/.test(primera.huecoTxt) && /[Rr]eintentando/.test(primera.huecoTxt),
    `con palabras de persona («${primera.huecoTxt}»)`);
  ok(!/load failed/i.test(primera.huecoTxt), "y tampoco aquí el mensaje del navegador");
  await ctx.close();

  await b.close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

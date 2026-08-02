/* El flujo clásico recuperado: que sea el de antes y que diga lo que decía.
 *
 *   1. la galería tiene tres tiles y el clásico entre ellos
 *   2. la geometría es la del original, nodo a nodo
 *   3. un cable encendido lleva su bola y su valor; uno apagado, ninguna
 *   4. con el payload entero, cada nodo enseña su contador del día
 *   5. con solo un reparto —la pantalla del día— las potencias se deducen y no
 *      se inventan contadores
 *   6. el anillo de la casa: el reparto del día por fuera, los aparatos por dentro
 *   7. el nivel de la batería está dentro de su icono
 *   8. sin movimiento, sin bolas
 */
const { abrirNavegador, base, capturas } = require("./camino");
const S = capturas();
const URL = base("http://127.0.0.1:8306/");


(async () => {
  const b = await abrirNavegador();
  const fallos = [];
  const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

  for (const tema of ["light", "dark"]) {
    const ctx = await b.newContext({ extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f", "X-Remote-User-Display-Name": "Banco" },  viewport: { width: 393, height: 900 },
      deviceScaleFactor: 2, colorScheme: tema });
    const p = await ctx.newPage({ extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f", "X-Remote-User-Display-Name": "Banco" } });
    const errores = [];
    p.on("pageerror", (e) => errores.push(String(e)));
    p.on("console", (m) => { if (m.type() === "error") errores.push(m.text()); });
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForTimeout(1600);
    console.log(`\n== ${tema} ==`);

    // ---- 1. la galería, ahora con tres ----
    await p.click('.tab[data-view="settings"]');
    await p.waitForTimeout(300);
    await p.click('[data-settings-page="flows"]');
    await p.waitForTimeout(400);
    const tiles = await p.$$eval(".gal-tile", (els) => els.map((e) => ({
      id: e.dataset.flowStyle, arte: !!e.querySelector("svg.gal-art"),
      w: Math.round(e.getBoundingClientRect().width),
    })));
    ok(tiles.length === 3, `tres tiles (${tiles.length})`);
    ok(tiles.map((t) => t.id).join() === "sankey,cruz,orbita",
       `en su orden (${tiles.map((t) => t.id).join(", ")})`);
    ok(tiles.every((t) => t.arte), "los tres con su icono vectorial");
    const desborde = await p.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(desborde <= 0, `y la rejilla no se va a lo ancho (${desborde} px)`);
    await p.screenshot({ path: `${S}/c1-galeria-${tema}.png`, fullPage: true });

    // ---- 2. elegirlo y comprobar la geometría del original ----
    await p.click('[data-flow-style="cruz"]');
    await p.waitForTimeout(900);
    await p.click('.tab[data-view="home"]');
    await p.waitForTimeout(1400);

    const g = await p.evaluate(() => {
      const n = document.querySelector("#flow vatia-cross");
      if (!n) return { error: "no hay cruz" };
      const s = n.shadowRoot;
      const svg = s.querySelector("svg");
      // El contorno de cada nodo mide 2,5; el anillo de la casa, 5. Sin
      // distinguirlos, un anillo que da la vuelta entera cuela como un nodo más.
      const circulos = [...s.querySelectorAll("svg > g > circle[r='46'][stroke-width='2.5']")]
        .map((c) => `${c.getAttribute("cx")},${c.getAttribute("cy")}`);
      return {
        viewBox: svg.getAttribute("viewBox"),
        nodos: circulos,
        casaRing: (() => {
          const c = s.querySelector("circle[r='46'][stroke-opacity]");
          return c ? `${c.getAttribute("cx")},${c.getAttribute("cy")}` : null;
        })(),
        // El anillo de la casa es el r=46 sin trazo de color: va aparte.
        etiquetas: [...s.querySelectorAll("text.pf-lbl")].map((t) => t.textContent.trim()),
        cables: s.querySelectorAll("path.pf-base").length,
        vivos: [...s.querySelectorAll("path.pf-live")]
          .filter((x) => x.style.opacity !== "0").length,
        bolas: s.querySelectorAll("animateMotion").length,
        valores: [...s.querySelectorAll("text.pf-flowval")].map((t) => t.textContent.trim()),
        // Contadores del día, uno por nodo.
        dia: [...s.querySelectorAll("text.pf-io")].map((t) => t.textContent.trim()),
        potencias: [...s.querySelectorAll("text.pf-val")].map((t) => t.textContent.trim()),
        // El nivel dentro del icono de la batería.
        nivel: (() => {
          const r = [...s.querySelectorAll("rect")].find((x) => x.getAttribute("rx") === "0.9");
          return r ? Number(r.getAttribute("height")) : null;
        })(),
        soc: n.data?.power?.battery_soc,
        lectura: [...s.querySelectorAll("ul.sr li")].map((l) => l.textContent.trim()),
      };
    });
    if (g.error) { ok(false, g.error); await ctx.close(); continue; }

    ok(g.viewBox === "0 0 400 420", `el viewBox del original (${g.viewBox})`);
    // El sitio, no el orden en el DOM: el grupo de la batería se escribe antes
    // que el de la casa, y eso no lo ve nadie.
    ok([...g.nodos].sort().join(" ") === ["200,76", "76,212", "200,348"].sort().join(" "),
       `sol, red y batería en su sitio (${g.nodos.join(" · ")})`);
    ok(g.casaRing === "324,212",
       `y la casa, cuyo borde **es** el anillo del reparto (${g.casaRing})`);
    ok(g.etiquetas.join() === "Solar,Red,Casa," || /^Solar,Red,Casa,Batería/.test(g.etiquetas.join()),
       `con sus nombres (${g.etiquetas.join(" · ")})`);
    ok(g.cables === 6, `los seis cables, encendidos o no (${g.cables})`);

    // ---- 3. bola y valor solo donde circula algo ----
    ok(g.bolas === g.vivos,
       `una bola por cable encendido y ninguna más (${g.bolas} bolas · ${g.vivos} vivos)`);
    ok(g.valores.length === g.vivos,
       `y un valor por cable encendido (${g.valores.join(", ") || "ninguno"})`);
    ok(g.valores.every((v) => /^\d/.test(v) && /(W|kW)$/.test(v)),
       "con la unidad de la app");
    ok(!g.valores.some((v) => /,\d\d /.test(v)),
       `y un decimal en los kW, no dos (${g.valores.join(", ")})`);

    // ---- 4. el contador del día en cada nodo ----
    ok(g.dia.length >= 5, `los contadores del día en los nodos (${g.dia.length})`);
    ok(g.dia.some((t) => /←/.test(t)) && g.dia.some((t) => /→/.test(t)),
       "la red separa lo vendido de lo comprado");
    ok(g.dia.some((t) => /↑/.test(t)) && g.dia.some((t) => /↓/.test(t)),
       "y la batería lo que entra de lo que sale");

    // ---- 7. el nivel de la batería ----
    if (g.soc != null) {
      const esperado = (12.6 * g.soc) / 100;
      ok(Math.abs(g.nivel - esperado) < 0.05,
         `el icono se llena al ${Math.round(g.soc)} % (${g.nivel} de 12,6 px)`);
      ok(g.etiquetas.some((t) => new RegExp(`${Math.round(g.soc)}%`).test(t)),
         "y el porcentaje va en su nombre");
    }
    await p.screenshot({ path: `${S}/c2-home-cruz-${tema}.png`, fullPage: false });

    // ---- 6. el anillo de la casa, por fuera y por dentro ----
    const anillo = await p.evaluate(() => {
      const n = document.querySelector("#flow vatia-cross");
      // Un tramo que da la vuelta entera es un <circle>, no un <path>: hay que
      // contar los dos, que es la misma cosa dibujada como toca.
      const cuenta = () => ({
        fuera: n.shadowRoot.querySelectorAll(
          'path[stroke-width="5"], circle[stroke-width="5"]:not([stroke-opacity])').length,
        dentro: n.shadowRoot.querySelectorAll(
          'path[stroke-width="3.5"], circle[stroke-width="3.5"]').length,
      });
      const antes = cuenta();
      antes.tramos = (n.data.energy.home.rows || []).filter((r) => r.kwh > 0).length;
      antes.entero = n.shadowRoot.querySelectorAll(
        'circle[stroke-width="5"]:not([stroke-opacity])').length === 1;
      const f = n.data.flows || {};
      const casa = (f.solar_home || 0) + (f.grid_home || 0) + (f.battery_home || 0);
      n.split = [{ id: "h", name: "Horno", color: "#8a5a2b", watts: casa * 0.4 }];
      const con = cuenta();
      const sr = [...n.shadowRoot.querySelectorAll("ul.sr li")].map((l) => l.textContent.trim());
      n.split = [];
      return { antes, con, sr, casa };
    });
    ok(anillo.antes.fuera >= 1,
       `el reparto del día va por fuera (${anillo.antes.fuera} tramos)`);
    // El caso común: la casa tirando de una sola fuente. El original dibujaba
    // ahí un arco degenerado —un punto— en vez de la vuelta entera.
    ok(anillo.antes.entero === (anillo.antes.tramos === 1),
       `con una sola fuente el anillo se cierra (${anillo.antes.tramos} fuente(s), `
       + `círculo=${anillo.antes.entero})`);
    ok(anillo.antes.dentro === 0, "y sin aparatos no hay anillo de dentro");
    // Horno + «sin medir»: dos tramos, uno de ellos transparente.
    ok(anillo.con.dentro === 2,
       `con un aparato aparece por dentro (${anillo.con.dentro} tramos, casa ${Math.round(anillo.casa)} W)`);
    ok(anillo.sr.some((l) => /La casa por dentro.*Horno/.test(l)),
       "y la alternativa de texto lo dice");

    // ---- 5. la pantalla del día: sin contadores inventados ----
    await p.click("#flow-panel");
    await p.waitForTimeout(2200);
    const dia = await p.evaluate(() => {
      const n = document.querySelector("#f-flow vatia-cross");
      if (!n) return null;
      const s = n.shadowRoot;
      return {
        io: s.querySelectorAll("text.pf-io").length,
        val: [...s.querySelectorAll("text.pf-val")].map((t) => t.textContent.trim()),
        meters: s.querySelectorAll("ul.meters").length,
        vacio: !!s.querySelector(".empty"),
      };
    });
    ok(dia !== null, "la pantalla del día usa el mismo componente");
    if (dia && !dia.vacio) {
      ok(dia.io === 0, `sin contadores del día, que ahí no se saben (${dia.io})`);
      ok(dia.val.length === 4,
         `pero los cuatro nodos dicen su potencia (${dia.val.join(" · ")})`);
      ok(dia.meters === 0, "y sin la fila de contadores, que va en tarjetas");
    }
    await p.screenshot({ path: `${S}/c3-dia-cruz-${tema}.png`, fullPage: false });

    ok(errores.length === 0, `sin errores de consola (${errores.slice(0, 3).join(" | ")})`);
    await ctx.close();
  }

  // ---- 8. sin movimiento, sin bolas ----
  const ctx = await b.newContext({ extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f", "X-Remote-User-Display-Name": "Banco" },  viewport: { width: 393, height: 900 },
    reducedMotion: "reduce" });
  const p = await ctx.newPage({ extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f", "X-Remote-User-Display-Name": "Banco" } });
  await p.goto(URL, { waitUntil: "networkidle" });
  await p.waitForTimeout(1800);
  const quieto = await p.evaluate(() => {
    const n = document.querySelector("#flow vatia-cross");
    return n ? {
      bolas: n.shadowRoot.querySelectorAll("animateMotion").length,
      vivos: [...n.shadowRoot.querySelectorAll("path.pf-live")]
        .filter((x) => x.style.opacity !== "0").length,
    } : null;
  });
  console.log("\n== sin movimiento ==");
  ok(quieto && quieto.bolas === 0,
     `con «prefers-reduced-motion» no hay bolas (${quieto ? quieto.bolas : "?"})`);
  ok(quieto && quieto.vivos > 0,
     `pero los cables siguen encendidos (${quieto ? quieto.vivos : "?"})`);
  await ctx.close();

  // Se deja como estaba.
  await (await b.newContext()).newPage({ extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f", "X-Remote-User-Display-Name": "Banco" } }).then(async (q) => {
    await q.goto(URL);
    await q.waitForTimeout(1200);
    await q.evaluate(() => fetch("api/settings", { method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flow_style: "sankey" }) }));
  });

  await b.close();
  console.log("\n" + (fallos.length ? `${fallos.length} fallos` : "todo en verde"));
  process.exit(fallos.length ? 1 : 0);
})();

/* La galería, la fuente de datos unificada y las dos versiones del flujo. */
const { abrirNavegador, base, capturas } = require("./camino");
const S = capturas();
const URL = base("http://127.0.0.1:8300/");


(async () => {
  const b = await abrirNavegador();
  const fallos = [];
  const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

  for (const tema of ["light", "dark"]) {
    const ctx = await b.newContext({ extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f", "X-Remote-User-Display-Name": "Banco" },  viewport: { width: 393, height: 880 },
      deviceScaleFactor: 2, colorScheme: tema });
    const p = await ctx.newPage({ extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f", "X-Remote-User-Display-Name": "Banco" } });
    const errores = [];
    p.on("pageerror", (e) => errores.push(String(e)));
    p.on("console", (m) => { if (m.type() === "error") errores.push(m.text()); });
    await p.goto(URL, { waitUntil: "networkidle" });
    await p.waitForTimeout(1600);

    console.log(`\n== ${tema} ==`);

    // ---- 1. la home con el Sankey, esquinas en ángulo ----
    await p.screenshot({ path: `${S}/g1-home-sankey-${tema}.png`, fullPage: false });
    const rx = await p.evaluate(() => {
      const n = document.querySelector("#flow vatia-flow");
      if (!n) return "sin nodo";
      return [...n.shadowRoot.querySelectorAll("rect")]
        .map((r) => r.getAttribute("rx") || "0").join(",");
    });
    ok(!/[1-9]/.test(rx), `ningún rect del diagrama tiene radio (rx: ${rx || "—"})`);

    // ---- 2. la galería ----
    await p.click('.tab[data-view="settings"]');
    await p.waitForTimeout(300);
    await p.click('[data-settings-page="flows"]');
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${S}/g2-galeria-${tema}.png`, fullPage: true });
    const tiles = await p.$$eval(".gal-tile", (els) => els.map((e) => ({
      id: e.dataset.flowStyle, on: e.getAttribute("aria-checked"),
      w: Math.round(e.getBoundingClientRect().width),
      arte: !!e.querySelector("svg.gal-art"),
      nombre: e.querySelector(".gal-name").textContent.trim(),
    })));
    ok(tiles.length === 3, `tres tiles (${tiles.length})`);
    ok(tiles.every((t) => t.arte), "cada uno con su icono vectorial");
    ok(tiles.filter((t) => t.on === "true").length === 1,
       `y uno solo marcado (${tiles.map((t) => `${t.id}=${t.on}`).join(" ")})`);
    ok(tiles[0].on === "true" && tiles[0].id === "sankey",
       "el marcado es el que está en uso");
    // Que quepan: es la rejilla de dos columnas en un móvil de 393.
    ok(tiles.every((t) => t.w >= 140 && t.w <= 200),
       `dos por fila y sin desbordar (anchos ${tiles.map((t) => t.w).join(", ")})`);
    const desborde = await p.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(desborde <= 0, `la página no se va a lo ancho (${desborde} px)`);
    // Sin barra de guardar: aquí cada toque se guarda solo.
    ok(await p.isHidden("#settings-save-bar"), "sin barra de guardar");

    // ---- 3. elegir la órbita ----
    await p.click('[data-flow-style="orbita"]');
    await p.waitForTimeout(900);
    const estado = (await p.textContent("#gal-estado")).trim();
    ok(/Guardado/.test(estado), `se guarda y se dice: «${estado}»`);
    const marcado = await p.$$eval(".gal-tile", (els) =>
      els.filter((e) => e.getAttribute("aria-checked") === "true")
         .map((e) => e.dataset.flowStyle));
    ok(marcado.join() === "orbita", `ahora la marcada es la órbita (${marcado})`);
    await p.screenshot({ path: `${S}/g3-galeria-orbita-${tema}.png`, fullPage: true });

    // ---- 4. la home, ya con la órbita, sin recargar ----
    await p.click('.tab[data-view="home"]');
    await p.waitForTimeout(1400);
    const cambio = await p.evaluate(() => ({
      orbit: !!document.querySelector("#flow vatia-orbit"),
      flow: !!document.querySelector("#flow vatia-flow"),
      texto: (document.querySelector("#flow vatia-orbit")?.shadowRoot
        ?.querySelector(".cv")?.textContent || "").trim(),
      lectura: [...(document.querySelector("#flow vatia-orbit")?.shadowRoot
        ?.querySelectorAll(".sr li") || [])].map((l) => l.textContent.trim()),
    }));
    ok(cambio.orbit && !cambio.flow,
       "la tarjeta cambia de componente sin recargar la página");
    ok(/\d/.test(cambio.texto), `y el centro dice el consumo de la casa: «${cambio.texto}»`);
    ok(cambio.lectura.some((l) => /Caudal total/.test(l)),
       `con su alternativa en texto (${cambio.lectura.length} líneas)`);
    await p.screenshot({ path: `${S}/g4-home-orbita-${tema}.png`, fullPage: false });

    // ---- 5. la pantalla del día también, y ahí con electrodomésticos ----
    await p.click("#flow-panel");
    await p.waitForTimeout(400);
    if (await p.isVisible("#view-flow")) {
      await p.waitForTimeout(1500);
      const dia = await p.evaluate(() => {
        const n = document.querySelector("#f-flow vatia-orbit");
        if (!n) return null;
        const lee = () => ({
          anillos: n.shadowRoot.querySelectorAll('circle[pathLength="100"]').length,
          dentro: [...n.shadowRoot.querySelectorAll(".sr li")]
            .some((l) => /La casa por dentro/.test(l.textContent)),
        });
        // La línea base, con el reparto **vaciado a mano**: a media tarde ya hay
        // un electrodoméstico en marcha en el payload y a las tres de la mañana
        // no hay ninguno, así que leer «lo que haya» no es una base, es la hora.
        n.split = [];
        const vivo = lee();
        n.split = [{ id: "a", name: "Lavadora", color: "#4a4ee0", watts: 900 }];
        const conAparato = lee();
        n.split = [];
        return { vivo, conAparato };
      });
      ok(dia !== null, "la pantalla del día usa el mismo componente");
      if (dia) {
        ok(dia.vivo.anillos >= 1,
           `con su anillo de mezcla (${dia.vivo.anillos} arcos a la hora de ahora)`);
        // Uno más por el aparato, y otro por el «resto» si la casa gasta más que
        // él. Cuántos exactamente depende de la hora, así que se mide lo que de
        // verdad importa: que el anillo de dentro aparece.
        ok(dia.conAparato.anillos > dia.vivo.anillos,
           `y más arcos con el aparato en marcha (${dia.vivo.anillos} → ${dia.conAparato.anillos})`);
        ok(dia.conAparato.dentro && !dia.vivo.dentro,
           "y la casa por dentro en el texto solo cuando hay algo medido");
      }
      await p.screenshot({ path: `${S}/g5-dia-orbita-${tema}.png`, fullPage: false });
    }

    // ---- 6. volver al Sankey, para dejarlo como estaba ----
    await p.click('.tab[data-view="settings"]');
    await p.waitForTimeout(300);
    await p.click('[data-settings-page="flows"]');
    await p.waitForTimeout(300);
    await p.click('[data-flow-style="sankey"]');
    await p.waitForTimeout(900);

    // ---- 7. la fuente de datos, unificada ----
    await p.click(".settings-page.active .settings-back");
    await p.waitForTimeout(300);
    await p.click('[data-settings-page="source"]');
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${S}/g6-fuente-${tema}.png`, fullPage: true });
    const fuente = await p.evaluate(() => ({
      segs: [...document.querySelectorAll("#source-seg .seg")]
        .map((b) => `${b.dataset.sourceOpt}${b.classList.contains("active") ? "*" : ""}`),
      nota: document.querySelector("#source-note").textContent.replace(/\s+/g, " ").trim(),
      // Lo que ya no está: los dos sensores duplicados de facturación.
      viejos: ["#s-ha-entity", "#s-ha-entity-export", "#load-entities-btn",
               "#s-ifx-entity", "#s-ifx-entity-export"]
        .filter((s) => document.querySelector(s)),
      atajos: [...document.querySelectorAll("#sp-source [data-settings-page]")]
        .map((b) => b.dataset.settingsPage),
    }));
    ok(fuente.segs.join() === "homeassistant*,demo",
       `dos opciones y la de verdad marcada (${fuente.segs.join(", ")})`);
    ok(fuente.viejos.length === 0,
       `ya no hay sensores de facturación aparte (${fuente.viejos.join(", ") || "ninguno"})`);
    ok(fuente.atajos.join() === "sensors,influx",
       `y sí un atajo a donde se eligen de verdad (${fuente.atajos.join(", ")})`);
    ok(/Sensores/.test(fuente.nota), `la nota lo dice: «${fuente.nota}»`);
    ok(await p.isHidden("#settings-save-bar"), "sin barra de guardar tampoco aquí");

    // ---- 8. InfluxDB ya no promete ser una fuente ----
    await p.click(".settings-page.active .settings-back");
    await p.waitForTimeout(250);
    await p.click('[data-settings-page="influx"]');
    await p.waitForTimeout(400);
    const ifx = await p.evaluate(() => ({
      texto: document.querySelector("#sp-influx").textContent.replace(/\s+/g, " "),
      campos: [...document.querySelectorAll("#sp-influx input")].map((i) => i.id),
    }));
    ok(!/Fuente de datos.{0,30}eliges InfluxDB/.test(ifx.texto),
       "no dice ya «elige InfluxDB en Fuente de datos»");
    ok(!ifx.campos.includes("s-ifx-entity"),
       `y no pide entity_id (campos: ${ifx.campos.join(", ")})`);
    await p.screenshot({ path: `${S}/g7-influx-${tema}.png`, fullPage: true });

    // ---- 9. el Sankey sigue partiendo la casa (lo de 0.38.0) ----
    // Con un reparto puesto a mano, porque a la hora en que corre esto puede no
    // haber ningún aparato en marcha. Lo que se comprueba es que el montaje
    // compartido no le ha quitado al Sankey lo que sabía hacer.
    await p.click('.tab[data-view="home"]');
    await p.waitForTimeout(1200);
    const partido = await p.evaluate(() => {
      const n = document.querySelector("#flow vatia-flow");
      if (!n) return null;
      const antes = [...n.shadowRoot.querySelectorAll("text.n")].map((t) => t.textContent);
      // Un horno que se lleve el 40 % de la casa: así hay «Resto» que enseñar.
      // Uno más grande que la casa se recorta a prorrata y se la come entera,
      // que es lo correcto pero no es lo que se está midiendo aquí.
      const f = n.data.flows || {};
      const casaW = (f.solar_home || 0) + (f.grid_home || 0) + (f.battery_home || 0);
      n.split = [{ id: "h", name: "Horno", color: "#8a5a2b", watts: casaW * 0.4 }];
      const t = [...n.shadowRoot.querySelectorAll("text.n")].map((x) => x.textContent);
      const sr = [...n.shadowRoot.querySelectorAll("ul.sr li")].map((x) => x.textContent.trim());
      n.split = [];
      return { antes, nombres: t, sr, casaW,
               casa: n.shadowRoot.querySelector(".empty") === null };
    });
    ok(partido !== null, "la Home usa el Sankey otra vez");
    if (partido && partido.casa) {
      ok(partido.nombres.some((t) => /Horno/.test(t)),
         `el horno tiene su nodo (${partido.nombres.join(" · ")})`);
      ok(partido.nombres.some((t) => /Resto/.test(t)),
         `y lo que no es de nadie es «Resto» (casa ${Math.round(partido.casaW)} W)`);
      ok(partido.sr.some((l) => /La casa por dentro.*Horno/.test(l)),
         `la alternativa textual también lo dice (${partido.sr.length} líneas)`);
      ok(!partido.antes.some((t) => /Resto/.test(t)),
         `y sin reparto la casa es un nodo (${partido.antes.join(" · ")})`);
    }

    ok(errores.length === 0, `sin errores de consola (${errores.slice(0, 3).join(" | ")})`);
    await ctx.close();
  }

  await b.close();
  console.log("\n" + (fallos.length ? `${fallos.length} fallos` : "todo en verde"));
  process.exit(fallos.length ? 1 : 0);
})();

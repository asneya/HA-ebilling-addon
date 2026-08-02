/* La tarjeta de la ventana: la forma del día y el excedente gastable.
 *
 *   1. se dibujan las dos curvas —el sol y la casa— y el área de excedente
 *   2. el hueco de la ventana parte el área en dos, que es donde se ve
 *   3. el pico se marca en su hora, y la etiqueta no se sale de la tarjeta
 *   4. la hora de «ahora» se calla si el pico cae encima
 *   5. el titular dice lo **gastable**, no el excedente bruto
 *   6. y la nota explica lo que se lleva la batería
 *   7. sin batería, ni nota ni descuento
 *   8. la leyenda dice qué es cada cosa
 *   9. cabe a 320 px sin que nada se salga
 *  10. sin errores de consola
 */
const { abrirNavegador, base, ficheros } = require("./camino");
const BASE = `${ficheros()}/bancoventana.html`;
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

const abrir = async (b, q, ancho = 414) => {
  const ctx = await b.newContext({ viewport: { width: ancho, height: 900 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => {
    const t = m.text();
    // Las fuentes se sirven desde el puerto de la app y CORS las bloquea en el
    // banco; dentro de la app van del mismo origen y no pasa.
    if (m.type() === "error" && !/CORS|font|ERR_FAILED|404/.test(t)) fallos.push("console: " + t);
  });
  await p.goto(BASE + q, { waitUntil: "networkidle" });
  await p.waitForTimeout(400);
  return p;
};

(async () => {
  const b = await abrirNavegador();

  console.log("\n1-2 · la forma del día");
  const p = await abrir(b, "?bat=4.2");
  const dibujo = await p.evaluate(() => {
    const s = document.querySelector("vatia-window").shadowRoot;
    return {
      sol: s.querySelectorAll("path.sol").length,
      casa: s.querySelectorAll("path.casa").length,
      areas: s.querySelectorAll("path.sobra").length,
      puntosSol: (s.querySelector("path.sol")?.getAttribute("d") || "").split("L").length,
    };
  });
  ok(dibujo.sol === 1 && dibujo.casa === 1,
    `una curva de sol y una de casa (${dibujo.sol}, ${dibujo.casa})`);
  ok(dibujo.puntosSol > 20, `la del sol con la resolución del día (${dibujo.puntosSol} puntos)`);
  ok(dibujo.areas === 2,
    `el hueco del horno parte el área en dos (${dibujo.areas} tramos rellenos)`);

  console.log("\n3-4 · el pico");
  const pico = await p.evaluate(() => {
    const s = document.querySelector("vatia-window").shadowRoot;
    const dot = s.querySelector(".pico"), lab = s.querySelector(".pico-l");
    const caja = s.host.getBoundingClientRect();
    const r = lab.getBoundingClientRect();
    return {
      hay: !!dot, texto: lab.textContent.trim(),
      dentro: r.left >= caja.left - 1 && r.right <= caja.right + 1,
      arriba: r.top >= s.querySelector(".plot").getBoundingClientRect().top - 1,
      now: !!s.querySelector(".now-label"),
      raya: !!s.querySelector("line.now"),
    };
  });
  const horaPico = await p.evaluate(() =>
    document.querySelector("vatia-window").data.today.peak_at.slice(11, 16));
  ok(pico.hay && pico.texto === horaPico, `el punto y su hora (${pico.texto})`);
  ok(pico.dentro, "la etiqueta no se sale de la tarjeta");
  ok(pico.arriba, "ni se mete en la cabecera cuando la punta está arriba del todo");
  ok(pico.raya, "la raya de «ahora» sigue estando");
  ok(!pico.now, "pero su hora se calla, que caía encima de la del pico");

  console.log("\n4b · con el pico lejos, la hora de «ahora» sí sale");
  const lejos = await abrir(b, "?bat=4.2&pico=5");
  const conNow = await lejos.evaluate(() => {
    const s = document.querySelector("vatia-window").shadowRoot;
    return { now: !!s.querySelector(".now-label"), pico: !!s.querySelector(".pico-l") };
  });
  ok(conNow.now && conNow.pico, "se ven las dos etiquetas, que ya no se pisan");

  console.log("\n5-6 · lo gastable y la batería");
  const conBat = await p.evaluate(() => {
    const s = document.querySelector("vatia-window").shadowRoot;
    return { head: s.querySelector("h2").textContent.trim(),
             notas: [...s.querySelectorAll(".note")]
               .map((n) => n.textContent.replace(/\s+/g, " ").trim()) };
  });
  ok(/2,1 kW/.test(conBat.head), `el titular dice lo gastable: «${conBat.head}»`);
  ok(!/2,4 kW/.test(conBat.head), "y no el bruto, que es lo que prometía de más");
  const nota = conBat.notas.find((n) => /batería/.test(n));
  ok(!!nota && /4,2 kWh/.test(nota), `la nota lo explica: «${(nota || "").slice(0, 58)}…»`);

  console.log("\n7 · sin batería");
  const q = await abrir(b, "?bat=0");
  const sinBat = await q.evaluate(() => {
    const s = document.querySelector("vatia-window").shadowRoot;
    return { head: s.querySelector("h2").textContent.trim(),
             bat: [...s.querySelectorAll(".note")]
               .some((n) => /llenar la batería/.test(n.textContent)) };
  });
  ok(/2,4 kW/.test(sinBat.head), `el titular da el excedente entero (${sinBat.head})`);
  ok(!sinBat.bat, "y no hay nota de batería que no viene a cuento");

  console.log("\n7b · el sesgo del tejado");
  const ses = await p.evaluate(() => [...document.querySelector("vatia-window")
    .shadowRoot.querySelectorAll(".note")]
    .map((n) => n.textContent.replace(/\s+/g, " ").trim())
    .find((n) => /corregida/.test(n)) || "");
  ok(/3 horas/.test(ses) && /09:00/.test(ses) && /42 % menos/.test(ses),
    `dice qué corrige y cuánto: \u00ab${ses.slice(0, 76)}\u2026\u00bb`);
  ok(/11 d\u00edas/.test(ses), "y de cuántos días lo ha sacado");
  const sinSesgo = await abrir(b, "?bat=4.2&sesgo=0");
  ok(!(await sinSesgo.evaluate(() => [...document.querySelector("vatia-window")
    .shadowRoot.querySelectorAll(".note")].some((n) => /corregida/.test(n.textContent)))),
    "y sin nada aprendido no se dice nada");

  console.log("\n8 · la leyenda");
  const ley = await p.evaluate(() => [...document.querySelector("vatia-window")
    .shadowRoot.querySelectorAll(".leyenda span")].map((s) => s.textContent.trim()));
  ok(ley.join(" · ") === "Sobra · Sol previsto · Tu casa",
    `dice qué es cada cosa (${ley.join(" · ")})`);

  console.log("\n9 · a 320 px");
  const estrecho = await abrir(b, "?bat=4.2", 320);
  const desborde = await estrecho.evaluate(() => {
    const s = document.querySelector("vatia-window").shadowRoot;
    const caja = s.host.getBoundingClientRect();
    const fuera = [...s.querySelectorAll(".pico-l, .now-label, .track-head span, .leyenda")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > caja.right + 1 || r.left < caja.left - 1;
      }).map((el) => el.className || el.tagName);
    return { fuera, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  ok(desborde.fuera.length === 0, `nada se sale (${desborde.fuera.join(", ") || "todo dentro"})`);
  ok(desborde.doc <= 0, `y la página no pide scroll horizontal (${desborde.doc} px)`);

  await b.close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

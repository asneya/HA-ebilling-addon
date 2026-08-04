/* La tarjeta de la ventana: la forma del día y el excedente gastable.
 *
 *   1. se dibujan las dos curvas —el sol y la casa— y el área de excedente
 *   2. el hueco de la ventana parte el área en dos, que es donde se ve
 *   3. el pico se marca en su hora, y la etiqueta no se sale de la tarjeta
 *   4. la hora de «ahora» se calla si el pico cae encima
 *   5. el titular dice lo **gastable**, no el excedente bruto
 *   6. y la nota explica lo que se lleva la batería
 *   7. sin batería, ni nota ni descuento
 *  7c. la holgura de la hora se dice **solo cuando cambia algo**: callada si la
 *      hora es fina, con la cifra si puede irse media hora, y diciendo que no
 *      vale si puede irse hora y media
 *   8. la leyenda dice qué es cada cosa
 *   9. cabe a 320 px sin que nada se salga
 *  10. lo medido va con trazo continuo y lo previsto a rayas
 *  11. sin nada medido, una sola línea y sin leyenda de «previsto»
 *  12. sin errores de consola
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
  // La promesa es la misma que cuando esto se escribió —no ofrecer los kWh que la
  // batería se va a llevar— y ahora se dice en energía y no en potencia media: el
  // titular pasó de «te sobran 2,1 kW» a «hasta las X te sobran 5,7 kWh» porque una
  // potencia media no es de ningún aparato y no se puede decidir con ella.
  ok(/5,7 kWh/.test(conBat.head), `el titular dice lo gastable: «${conBat.head}»`);
  ok(!/9,9 kWh/.test(conBat.head), "y no el bruto, que es lo que prometía de más");
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
  ok(/9,9 kWh/.test(sinBat.head), `el titular da el excedente entero (${sinBat.head})`);
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

  console.log("\n7c · la holgura de la hora, y solo cuando cambia algo");
  /* El error del perfil llega ya traducido a minutos (ver `_holgura_de`). Lo que se
     comprueba aquí es **cuándo se dice**: una mañana clara cruza subiendo tres
     kilovatios por hora y la holgura sale de cinco minutos casi todos los días, así
     que decirlo entonces sería una coletilla fija que solo repite «la hora es
     buena» — de eso ya se quejó esta tarjeta una vez. Cuando de verdad no es fina,
     hay que decirlo, porque hasta ahora daba las dos con el mismo aplomo. */
  const sub = (pag) => pag.evaluate(() => document.querySelector("vatia-window")
    .shadowRoot.querySelector(".sub").textContent.replace(/\s+/g, " ").trim());
  const fina = await abrir(b, "?bat=4.2&holgura=5");
  ok(!/puede irse|poco fiable/.test(await sub(fina)),
    "con la hora fina no se dice nada, que sería una coletilla fija");
  const media = await abrir(b, "?bat=4.2&holgura=30");
  const tMedia = await sub(media);
  ok(/puede irse ±30 min/.test(tMedia), `con media hora se dice: «${tMedia.slice(-72)}»`);
  ok(/var(ía|ia) tu consumo/.test(tMedia), "y de dónde viene esa duda");
  const mala = await abrir(b, "?bat=4.2&holgura=90");
  const tMala = await sub(mala);
  ok(/poco fiable/.test(tMala) && /±1 h 30 min/.test(tMala),
    `y con hora y media se dice que la hora no vale: «${tMala.slice(-96)}»`);
  ok(/de lado/.test(tMala), "explicando por qué: el sol cruza el consumo casi de lado");
  // Sin la clave —un payload sin desviación medida— la tarjeta dice lo de siempre.
  ok(!/puede irse|poco fiable/.test(await sub(p)),
    "y sin holgura en el payload, la tarjeta queda como estaba");
  // Nada de etiquetas: `sub` se pinta escapado, así que un `<b>` saldría impreso.
  ok(!/&lt;|<b>/.test(tMala), "sin etiquetas impresas, que ese texto va escapado");

  console.log("\n8 · la leyenda");
  const ley = await p.evaluate(() => [...document.querySelector("vatia-window")
    .shadowRoot.querySelectorAll(".leyenda span")].map((s) => s.textContent.trim()));
  ok(ley.join(" · ") === "Sobra · Sol · Tu casa",
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
  // Y con la frase larga de la holgura, que es la que más texto añade al subtítulo y
  // por tanto el caso que puede desbordar. Comprobarlo solo con el payload corto
  // sería medir la maquetación que no corre riesgo.
  const largo = await abrir(b, "?bat=4.2&holgura=90", 320);
  const conFrase = await largo.evaluate(() => {
    const s = document.querySelector("vatia-window").shadowRoot;
    const caja = s.host.getBoundingClientRect();
    const p = s.querySelector(".sub").getBoundingClientRect();
    return { fuera: p.right > caja.right + 1 || p.left < caja.left - 1,
             doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
             largo: s.querySelector(".sub").textContent.trim().length };
  });
  ok(!conFrase.fuera,
    `el subtítulo con la holgura cabe a 320 px (${conFrase.largo} caracteres)`);
  ok(conFrase.doc <= 0, `y sigue sin pedir scroll (${conFrase.doc} px)`);

  /* De una pregunta: «¿no debería la forma de hoy representar la realidad hasta el
     momento actual y la previsión desde el momento actual?». Sí — y para que se
     entienda al mirarla, el trazo tiene que decir cuál es cuál. */
  console.log("\n10-11 · lo que fue y lo que se espera");
  const trazos = (pg) => pg.evaluate(() => {
    const root = document.querySelector("vatia-window").shadowRoot;
    const de = (sel) => [...root.querySelectorAll(sel)].map((el) => ({
      clase: el.getAttribute("class"),
      raya: getComputedStyle(el).strokeDasharray,
      largo: (el.getAttribute("d") || "").length,
    }));
    return {
      lineas: de("path.sol, path.casa"),
      leyenda: [...root.querySelectorAll(".leyenda span")].map((x) => x.textContent.trim()),
    };
  });
  const conMedida = await trazos(await abrir(b, "?bat=4.2&medido=1"));
  const solidas = conMedida.lineas.filter((l) => !/\bprev\b/.test(l.clase));
  const rayadas = conMedida.lineas.filter((l) => /\bprev\b/.test(l.clase));
  ok(solidas.length === 2 && rayadas.length === 2,
    `hay dos tramos de cada serie (${conMedida.lineas.map((l) => l.clase).join(" | ")})`);
  ok(solidas.every((l) => l.largo > 10) && rayadas.every((l) => l.largo > 10),
    "y los cuatro tienen recorrido, no son trazos vacíos");
  ok(solidas.every((l) => l.raya === "none" || l.raya === ""),
    `lo medido va continuo (${solidas.map((l) => l.raya).join(" · ")})`);
  ok(rayadas.every((l) => /\d/.test(l.raya)),
    `y lo previsto a rayas (${rayadas.map((l) => l.raya).join(" · ")})`);
  ok(conMedida.leyenda.includes("previsto"),
    `con la leyenda que lo explica (${conMedida.leyenda.join(" · ")})`);

  const sinMedida = await trazos(await abrir(b, "?bat=4.2"));
  ok(sinMedida.lineas.length === 2,
    `sin nada medido, una línea por serie (${sinMedida.lineas.length})`);
  ok(sinMedida.lineas.every((l) => /\bprev\b/.test(l.clase)),
    "y las dos son previsión, que es lo único que hay");
  ok(!sinMedida.leyenda.includes("previsto"),
    `sin leyenda de «previsto», que no distingue nada (${sinMedida.leyenda.join(" · ")})`);

  await b.close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

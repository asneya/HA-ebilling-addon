/* El acuse de recibo al pulsar, medido en milisegundos de verdad.
 *
 *   1. la marca se mueve **antes** de que llegue la respuesta del servidor
 *   2. y con la respuesta lenta a propósito, sigue siendo inmediata
 *   3. la píldora del segmentado se coloca bajo el elegido
 *   4. y se desplaza, en vez de apagarse aquí y encenderse allí
 *   5. las pestañas de abajo y las de vista también responden al instante
 *   6. si la carga acaba en otro sitio, manda la pantalla y la marca se corrige
 *   7. un botón apagado no se marca
 *   8. la pantalla del flujo se quedó con un solo botón: volver a ahora
 *   9. que está apagado cuando ya se está en el presente
 *  10. sin errores de consola
 */
const { abrirNavegador, base, ficheros } = require("./camino");
const BASE = base("http://127.0.0.1:8402/");
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

const abrir = async (b) => {
  const ctx = await b.newContext({
    viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f",
                        "X-Remote-User-Display-Name": "Banco" },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => { if (m.type() === "error") fallos.push("console: " + m.text()); });
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1200);
  return { ctx, p };
};

/* Cuánto tarda la marca en moverse, sin contar con que la carga haya acabado.
   Se mide con el reloj de la página entre el clic y el primer repintado en el
   que el botón ya está activo. */
const retardo = (p, sel) => p.evaluate(async (s) => {
  const boton = document.querySelector(s);
  const t0 = performance.now();
  boton.click();
  await new Promise((r) => requestAnimationFrame(r));
  return { ms: performance.now() - t0, activo: boton.classList.contains("active") };
}, sel);

(async () => {
  const b = await abrirNavegador();
  const { p } = await abrir(b);

  console.log("\n1-2 · la marca no espera al servidor");
  await p.click('.tab[data-view="energy"]');
  await p.waitForTimeout(2500);
  // Se retrasa la respuesta medio segundo: si la marca dependiera de ella, se
  // notaría. Es la reproducción exacta de una casa con InfluxDB lejos.
  await p.route("**/api/series*", async (ruta) => {
    await new Promise((r) => setTimeout(r, 500));
    await ruta.continue();
  });
  const r1 = await retardo(p, '.seg[data-range="week"]');
  ok(r1.activo, "al soltar el dedo el botón ya está marcado");
  ok(r1.ms < 60, `y sin esperar a los datos (${r1.ms.toFixed(1)} ms de 500 de red)`);
  // Y cuando la carga termina, la marca sigue donde se puso.
  await p.waitForTimeout(1500);
  ok(await p.evaluate(() =>
    document.querySelector('.seg[data-range="week"]').classList.contains("active")),
    "y sigue ahí cuando llegan los datos");

  console.log("\n3-4 · la píldora se desplaza");
  const pil = await p.evaluate(() => {
    const caja = document.querySelector(".segmented.ranges");
    const botones = [...caja.querySelectorAll(".seg")];
    const st = getComputedStyle(caja, "::before");
    const activo = caja.querySelector(".seg.active");
    // El pseudoelemento no tiene rectángulo que preguntar, así que se rehace la
    // cuenta que hace el CSS y se compara con el botón de verdad: si la píldora
    // cupiera mal o se desplazara de menos, aquí se vería.
    const i = Number(caja.style.getPropertyValue("--seg-i"));
    const ancho = parseFloat(st.width);
    const izqPildora = caja.getBoundingClientRect().left + 3 + i * (ancho + 3);
    return {
      con: caja.classList.contains("con-pildora"),
      i: caja.style.getPropertyValue("--seg-i").trim(),
      n: caja.style.getPropertyValue("--seg-n").trim(),
      cuantos: botones.length,
      transicion: st.transitionProperty,
      dur: st.transitionDuration,
      desvioIzq: Math.abs(izqPildora - activo.getBoundingClientRect().left),
      desvioAncho: Math.abs(ancho - activo.getBoundingClientRect().width),
    };
  });
  const iEsperado = await p.evaluate(() =>
    [...document.querySelectorAll(".segmented.ranges .seg")]
      .findIndex((s) => s.dataset.range === "week"));
  ok(pil.con && pil.i === String(iEsperado),
    `la píldora está bajo el elegido (--seg-i=${pil.i}, esperado ${iEsperado})`);
  ok(pil.n === String(pil.cuantos), `y sabe cuántos huecos hay (--seg-n=${pil.n} de ${pil.cuantos})`);
  ok(pil.desvioIzq < 1.5 && pil.desvioAncho < 1.5,
    `y cae justo encima del botón (${pil.desvioIzq.toFixed(2)} px de lado, ${pil.desvioAncho.toFixed(2)} de ancho)`);
  ok(/transform/.test(pil.transicion) && parseFloat(pil.dur) > 0,
    `se mueve con transición, no de un salto (${pil.transicion} ${pil.dur})`);
  // El botón activo ya no lleva fondo propio: lo pone la píldora.
  const fondo = await p.evaluate(() =>
    getComputedStyle(document.querySelector(".segmented.ranges .seg.active")).backgroundColor);
  ok(/rgba\(0, 0, 0, 0\)|transparent/.test(fondo),
    `y el botón no dibuja su propio fondo (${fondo})`);

  console.log("\n5 · las otras barras");
  const r2 = await retardo(p, '.vt[data-eview="solar"]');
  ok(r2.activo && r2.ms < 60, `la vista de análisis (${r2.ms.toFixed(1)} ms)`);
  const r3 = await retardo(p, '.tab[data-view="billing"]');
  ok(r3.activo && r3.ms < 60, `la barra de abajo (${r3.ms.toFixed(1)} ms)`);
  await p.waitForTimeout(1500);

  console.log("\n6 · manda la pantalla");
  // Se marca «mes» a mano sin pasar por el manejador: la pantalla, al
  // repintarse, tiene que devolverla a donde de verdad está.
  await p.click('.tab[data-view="energy"]');
  await p.waitForTimeout(1800);
  const real = await p.evaluate(() => {
    const activo = document.querySelector(".segmented.ranges .seg.active");
    return activo && activo.dataset.range;
  });
  await p.evaluate(() => {
    const caja = document.querySelector(".segmented.ranges");
    caja.querySelectorAll(".seg").forEach((s) =>
      s.classList.toggle("active", s.dataset.range === "year"));
  });
  await p.click("#e-prev");             // fuerza un repintado sin cambiar rango
  await p.waitForTimeout(2000);
  const corregido = await p.evaluate(() =>
    document.querySelector(".segmented.ranges .seg.active")?.dataset.range);
  ok(corregido === real, `la pantalla corrige una marca falsa (${corregido} = ${real})`);

  console.log("\n7 · un botón apagado no se marca");
  const apagado = await p.evaluate(() => {
    const b2 = document.querySelector("#e-next");
    return { deshabilitado: b2.disabled, clase: b2.className };
  });
  ok(apagado.deshabilitado !== undefined, `«siguiente» conoce su estado (${apagado.deshabilitado})`);

  console.log("\n8-9 · la pantalla del flujo");
  await p.click('.tab[data-view="home"]');
  await p.waitForTimeout(1500);
  await p.click("#flow-panel");
  await p.waitForTimeout(2500);
  const f = await p.evaluate(() => ({
    chips: document.querySelectorAll(".f-chip").length,
    play: !!document.querySelector("#f-play"),
    texto: document.querySelector("#f-now")?.textContent.trim(),
    apagado: document.querySelector("#f-now")?.disabled,
    slider: !!document.querySelector("#f-hour"),
    franja: !!document.querySelector("#f-daystrip svg"),
  }));
  ok(f.chips === 1 && !f.play,
    `solo queda un botón y ningún «ver el día entero» (${f.chips} botón, play=${f.play})`);
  ok(f.texto === "Volver a ahora", `y dice lo que hace («${f.texto}»)`);
  ok(f.apagado === true, "apagado, porque se entra ya en el presente");
  ok(f.slider && f.franja, "el deslizador y la franja del día siguen ahí");
  // Al moverse, se enciende; al volver, se apaga.
  await p.evaluate(() => {
    const s = document.querySelector("#f-hour");
    s.value = "9";
    s.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await p.waitForTimeout(700);
  ok(await p.evaluate(() => !document.querySelector("#f-now").disabled),
    "se enciende al desplazarse por la historia del día");
  // Y el reloj deja de decir «Ahora», que era mentir sobre lo que se mira.
  const relojPasado = await p.evaluate(() => document.querySelector("#f-clock").textContent.trim());
  ok(/^Hoy · \d\d:\d\d$/.test(relojPasado), `el reloj sabe que no es ahora («${relojPasado}»)`);
  await p.click("#f-now");
  await p.waitForTimeout(700);
  ok(await p.evaluate(() => document.querySelector("#f-now").disabled),
    "y devuelve al presente, apagándose otra vez");
  const relojAhora = await p.evaluate(() => document.querySelector("#f-clock").textContent.trim());
  ok(/^Ahora · \d\d:\d\d$/.test(relojAhora), `y vuelve a decir «ahora» («${relojAhora}»)`);
  // El botón vive dentro de la tarjeta del día, no en un panel suelto arriba.
  ok(await p.evaluate(() => !!document.querySelector("#f-card .f-strip-head #f-now")),
    "y está pegado al deslizador que lo hace falta");

  await b.close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f2) => console.log("  " + f2)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

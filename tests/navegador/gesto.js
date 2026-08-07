/* La holgura del arrastre y el arrastre del eje, medidos con eventos de verdad.
 *
 * Dos defectos que la auditoría de gestos encontró en los dos gráficos:
 *
 *   · la decisión de «¿esto es un recorrido del gráfico o alguien bajando por la
 *     página?» estaba escrita dos veces, con la cifra copiada a mano, y se tomaba
 *     con 6 px de recorrido. A esa distancia manda el temblor de la mano: un dedo
 *     que va a bajar empieza con dos o tres píxeles de lado y, si caen en
 *     horizontal, el gráfico se queda el gesto y la página no baja;
 *   · y el arrastre del eje al llegar al borde avanzaba un 4 % **por evento**.
 *     `pointermove` se dispara a la frecuencia de la pantalla, así que el mismo
 *     dedo igual de quieto movía el eje al doble de velocidad en un aparato de
 *     120 Hz que en uno de 60.
 *
 * Lo que se comprueba:
 *
 *   1. la regla vive en un solo sitio y responde lo que dice su contrato
 *   2. el anillo es de 10 px, no de 6
 *   3. un gesto vertical se suelta y la página baja
 *   4. uno horizontal se lo queda el gráfico
 *   5. y los dos gráficos usan la misma regla, no una copia cada uno
 *   6. el eje avanza lo mismo con el doble de eventos en el mismo tiempo
 */
const { abrirNavegador, base } = require("./camino");
const BASE = base("http://127.0.0.1:8402/");
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

const abrir = async (b) => {
  const ctx = await b.newContext({
    viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f" },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1200);
  return { ctx, p };
};

(async () => {
  const nav = await abrirNavegador();
  const { ctx, p } = await abrir(nav);

  console.log("\n1-2 · la regla, en un solo sitio");
  const reglas = await p.evaluate(() => {
    const g = window.VatiaGesto;
    if (!g) return null;
    return {
      holgura: g.HOLGURA_PX,
      // El anillo: justo por dentro no se decide nada; justo por fuera, sí.
      dentro6: g.direccion(6, 2), dentro9: g.direccion(0, 9),
      fuera: g.direccion(11, 2), vertical: g.direccion(2, 11),
      // Empate: se lo queda el gráfico, que es lo que hacía antes (`dy > dx`).
      empate: g.direccion(11, 11),
    };
  });
  ok(reglas !== null, "existe una única regla compartida (`VatiaGesto`)");
  ok(reglas && reglas.holgura === 10, `y el anillo es de 10 px (${reglas && reglas.holgura})`);
  ok(reglas && reglas.dentro6 === "esperar",
    `a 6 px todavía no se decide nada (${reglas && reglas.dentro6})`);
  ok(reglas && reglas.dentro9 === "esperar",
    `a 9 px tampoco (${reglas && reglas.dentro9})`);
  ok(reglas && reglas.fuera === "seguir",
    `pasados los 10, lo horizontal es del gráfico (${reglas && reglas.fuera})`);
  ok(reglas && reglas.vertical === "soltar",
    `y lo vertical, de la página (${reglas && reglas.vertical})`);
  ok(reglas && reglas.empate === "seguir",
    `en empate manda el gráfico, como antes (${reglas && reglas.empate})`);

  console.log("\n3-5 · y los dos gráficos la usan");
  // No se mira el código: se mira que quitando la regla los dos se rompan igual.
  // Si alguno conservara su copia, seguiría respondiendo y esto lo cazaría.
  const usan = await p.evaluate(() => {
    const fuentes = ["vatia-chart", "vatia-bars"].map((t) => {
      const s = [...document.scripts].find((x) => x.src.includes(t));
      return s ? s.src : null;
    });
    return fuentes;
  });
  const codigos = await Promise.all(usan.filter(Boolean).map(async (u) => {
    const r = await p.evaluate((url) => fetch(url).then((x) => x.text()), u);
    return { url: u.split("/").pop(), r };
  }));
  for (const c of codigos) {
    ok(c.r.includes("VatiaGesto.direccion"),
      `${c.url} pregunta a la regla compartida`);
    ok(!/Math\.abs\(dx\) < \d/.test(c.r),
      `${c.url} ya no lleva su propia copia de la holgura`);
  }

  console.log("\n6 · el eje avanza por tiempo y no por evento");
  // Se amplía el eje a mano —no hace falta el pellizco— y se deja el dedo
  // quieto en el borde derecho durante el mismo rato, dos veces: una con un
  // evento cada 32 ms y otra con uno cada 8. Antes, la segunda tanda movía el
  // eje cuatro veces más lejos con el dedo exactamente igual de quieto.
  const medir = async (periodo) => p.evaluate(async (ms) => {
    // Un gráfico propio, no el de la pantalla: así el banco no depende de que
    // esta casa tenga datos, y la pantalla de Energía no reacciona a un
    // recorrido que no ha pedido nadie. 288 puntos son los cinco minutos de un
    // día, que es lo que pinta de verdad.
    let c = document.querySelector("#banco-gesto vatia-chart");
    if (!c) {
      const caja = document.createElement("div");
      caja.id = "banco-gesto";
      caja.style.cssText = "position:fixed;left:0;top:0;width:390px;z-index:9999";
      c = document.createElement("vatia-chart");
      c.colorFor = () => "#0a84ff";
      caja.appendChild(c);
      document.body.appendChild(caja);
      const t0 = Date.UTC(2026, 7, 3) - 2 * 3600e3;
      c.data = {
        x: Array.from({ length: 288 }, (_, i) =>
          new Date(t0 + i * 300e3).toISOString().replace("Z", "+02:00")),
        series: [{ key: "casa", label: "Casa",
                   values: Array.from({ length: 288 }, (_, i) => 400 + i) }],
      };
      await new Promise((k) => requestAnimationFrame(() => requestAnimationFrame(k)));
    }
    if (!c._plot) return null;
    // uPlot no aplica `setScale` en el acto: lo agrupa en el siguiente
    // fotograma. Sin esperarlo, la primera tanda medía desde un eje que todavía
    // no se había movido y la segunda arrancaba con el eje del final, tocando el
    // tope y sin recorrer nada. Los dos resultados eran ruido.
    const marco = () => new Promise((k) =>
      requestAnimationFrame(() => requestAnimationFrame(k)));
    const xs = c._plot.data[0];
    const [lo, hi] = [xs[0], xs[xs.length - 1]];
    const ancho = (hi - lo) / 6;
    c._plot.setScale("x", { min: lo, max: lo + ancho });
    await marco();
    const over = c._plot.over;
    const r = over.getBoundingClientRect();
    // El dedo entra por el centro y se va al borde derecho, dentro del margen
    // del 12 %: pasada la holgura, para que el arrastre esté ya decidido.
    const y = r.top + r.height / 2;
    const ev = (tipo, x) => over.dispatchEvent(new PointerEvent(tipo, {
      pointerId: 1, clientX: x, clientY: y, bubbles: true, isPrimary: true }));
    ev("pointerdown", r.left + r.width / 2);
    ev("pointermove", r.left + r.width / 2 + 40);
    const borde = r.left + r.width * 0.97;
    const antes = c._plot.scales.x.min;
    const t0 = performance.now();
    while (performance.now() - t0 < 480) {
      ev("pointermove", borde);
      await new Promise((k) => setTimeout(k, ms));
    }
    const seg = (performance.now() - t0) / 1000;
    ev("pointerup", borde);
    await marco();
    return { corrido: c._plot.scales.x.min - antes, ventana: ancho, seg };
  }, periodo);

  const lento = await medir(32);
  const rapido = await medir(8);
  if (!lento || !rapido) {
    ok(false, "no se pudo llegar al gráfico de Energía");
  } else {
    const nL = lento.corrido / lento.ventana / lento.seg;
    const nR = rapido.corrido / rapido.ventana / rapido.seg;
    ok(nL > 0.05, `con un evento cada 32 ms el eje corre (${nL.toFixed(2)} ventanas/s)`);
    // El margen es amplio a propósito: lo que se afirma es «no depende del
    // ritmo», no «avanza exactamente 2,4». En CI los `setTimeout` se estiran y
    // el eje topa con el final del periodo, que recorta las dos tandas por igual.
    const razon = nR / nL;
    ok(razon > 0.6 && razon < 1.6,
      `y con cuatro veces más eventos, igual (${nR.toFixed(2)} ventanas/s · razón ${
        razon.toFixed(2)})`);
  }

  await ctx.close();
  await nav.close();
  console.log(fallos.length ? `\n--- fallos ---\n  ${fallos.join("\n  ")}\n\n${
    fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

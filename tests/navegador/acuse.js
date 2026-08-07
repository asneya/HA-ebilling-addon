/* Lo que pasa al apretar y lo que pasa al cerrar, medido en el navegador.
 *
 * Tres huecos que encontró la auditoría contra la guía de diseño, los tres del
 * mismo tipo: cosas que el diseño da por hechas y que no estaban.
 *
 *   · las hojas cerraban con `display: none` y **desaparecían de golpe**. Entraban
 *     subiendo en tres décimas y salían por ningún sitio;
 *   · dieciséis pulsables tenían `cursor: pointer` y al tocarlos no pasaba nada
 *     hasta que respondía la pantalla;
 *   · y diez cifras de 22 a 32 px heredaban la interlínea del cuerpo, 1,5, que es
 *     interlínea de párrafo.
 *
 * Lo que se comprueba:
 *
 *   1. la hoja no se esconde en el acto: se queda mientras sale
 *   2. y sale por donde entró, bajando, no encogiendo ni yéndose de lado
 *   3. la curva de vuelta es la inversa de la de ida, no otra parecida
 *   4. acaba escondida de verdad, sin dejar la pantalla bloqueada
 *   5. reabrir a media salida gana: la hoja se queda
 *   6. los pulsables responden al apretar, y cada uno como le toca
 *   7. las cifras grandes llevan interlínea apretada, no la del cuerpo
 */
const { abrirNavegador, base } = require("./camino");
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

/* Abre una hoja a mano y la cierra por el camino de verdad —el módulo
   compartido—, tomando muestras mientras sale. No se pulsa ningún botón de
   cerrar concreto porque lo que se prueba es el mecanismo, no una pantalla. */
const cerrarYMirar = (p, sel) => p.evaluate(async (s) => {
  const mod = await import("/static/core/dom.js");
  const el = document.querySelector(s);
  mod.abrirHoja(el);
  await new Promise((k) => setTimeout(k, 500));   // que termine de entrar
  const hoja = el.querySelector(".sheet");
  const antes = {
    escondida: el.classList.contains("hidden"),
    y: new DOMMatrix(getComputedStyle(hoja).transform).m42,
  };
  mod.cerrarHoja(el);
  await new Promise((k) => setTimeout(k, 150));   // a mitad de la salida
  const medio = {
    escondida: el.classList.contains("hidden"),
    saliendo: el.classList.contains("saliendo"),
    y: new DOMMatrix(getComputedStyle(hoja).transform).m42,
    escala: new DOMMatrix(getComputedStyle(hoja).transform).m11,
    x: new DOMMatrix(getComputedStyle(hoja).transform).m41,
    opacidadHoja: +getComputedStyle(hoja).opacity,
    curva: getComputedStyle(hoja).animationTimingFunction,
  };
  await new Promise((k) => setTimeout(k, 700));
  const fin = {
    escondida: el.classList.contains("hidden"),
    saliendo: el.classList.contains("saliendo"),
  };
  return { antes, medio, fin };
}, sel);

(async () => {
  const b = await abrirNavegador();
  const { ctx, p } = await abrir(b);

  console.log("\n1-4 · la hoja sale por donde entró");
  const v = await cerrarYMirar(p, "#appliance-modal");
  ok(v.antes.escondida === false && Math.abs(v.antes.y) < 1,
    `abierta y en su sitio antes de cerrar (y=${v.antes.y.toFixed(1)})`);
  ok(v.medio.escondida === false && v.medio.saliendo,
    "a mitad de camino sigue en pantalla, saliendo");
  // Baja: la entrada venía de +28 px, así que la vuelta va hacia +28.
  ok(v.medio.y > 3,
    `y va bajando, que es por donde entró (y=${v.medio.y.toFixed(1)} px)`);
  ok(Math.abs(v.medio.escala - 1) < 0.001 && Math.abs(v.medio.x) < 0.5,
    `sin encogerse ni irse de lado (escala ${v.medio.escala.toFixed(3)}, x ${v.medio.x.toFixed(1)})`);
  ok(v.medio.opacidadHoja < 0.99,
    `y desvaneciéndose, para que el último fotograma no sea un corte (${
      v.medio.opacidadHoja.toFixed(2)})`);
  // La curva de vuelta es la inversa exacta de `cubic-bezier(.2,.9,.3,1)`:
  // (1−x2, 1−y2, 1−x1, 1−y1) = (0, 0, .8, .1). Si alguien la cambia por una
  // «parecida», el camino de ida y el de vuelta dejan de ser el mismo.
  ok(/cubic-bezier\(0,\s*0,\s*0?\.8,\s*0?\.1\)/.test(v.medio.curva),
    `con la curva espejo de la entrada (${v.medio.curva})`);
  ok(v.fin.escondida && !v.fin.saliendo,
    "y al terminar queda escondida de verdad, sin bloquear la pantalla");

  console.log("\n5 · reabrir a media salida");
  const re = await p.evaluate(async () => {
    const mod = await import("/static/core/dom.js");
    const el = document.querySelector("#appliance-modal");
    mod.abrirHoja(el);
    await new Promise((k) => setTimeout(k, 400));
    mod.cerrarHoja(el);
    await new Promise((k) => setTimeout(k, 120));
    mod.abrirHoja(el);                    // se arrepiente a media salida
    await new Promise((k) => setTimeout(k, 800));
    const r = { escondida: el.classList.contains("hidden"),
                saliendo: el.classList.contains("saliendo") };
    el.classList.add("hidden");
    return r;
  });
  ok(!re.escondida && !re.saliendo,
    "quien reabre manda: la hoja se queda, no la esconde el temporizador de la salida");

  console.log("\n6 · el acuse al apretar");
  // Se mira el estilo de `:active` sin tener que apretar de verdad: lo que se
  // afirma es que **existe** una respuesta y de qué clase es, no su valor exacto.
  const acuses = await p.evaluate(() => {
    const reglas = [];
    for (const hoja of document.styleSheets) {
      let ls; try { ls = hoja.cssRules; } catch { continue; }
      // Primero se apunta la regla y **luego** se baja. Al revés no funciona:
      // desde que existe el anidado de CSS, una `CSSStyleRule` normal también
      // tiene `cssRules` —vacío— así que preguntar por él primero se saltaba
      // todas las reglas de estilo y este banco salía en rojo con el CSS puesto.
      const rec = (lista) => {
        for (const r of lista) {
          if (r.selectorText && r.selectorText.includes(":active")) {
            reglas.push([r.selectorText, r.style.cssText]);
          }
          if (r.cssRules && r.cssRules.length) rec(r.cssRules);
        }
      };
      rec(ls);
    }
    // Cada pulsable, y qué clase de respuesta se espera de él.
    const espera = {
      ".tf-btn": "transform", ".srow-assign": "transform", ".ap-ico": "transform",
      ".ap-color": "transform", ".gal-tile": "transform", ".e-zoom-val": "transform",
      ".e-serie": "transform", ".card-move button": "transform",
      ".srow": "background", ".pick-list button": "background",
      ".pick-sugg button": "background", ".step > summary": "background",
      ".sheet-act": "opacity",
    };
    const salida = {};
    for (const [sel, clase] of Object.entries(espera)) {
      const suyas = reglas.filter(([s]) =>
        s.split(",").some((t) => t.trim().startsWith(sel + ":active")));
      salida[sel] = { hay: suyas.length > 0,
                      bien: suyas.some(([, css]) => css.includes(clase)), clase };
    }
    return salida;
  });
  for (const [sel, r] of Object.entries(acuses)) {
    ok(r.hay && r.bien, `${sel} responde al apretar (${r.clase})`);
  }

  console.log("\n7 · interlínea de las cifras grandes");
  // Se mide sobre elementos de verdad de la página, no sobre la hoja de estilos:
  // lo que importa es la caja que ocupa el número, y eso solo se sabe al pintarlo.
  const tipos = await p.evaluate(() => {
    const mirar = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const cs = getComputedStyle(e);
      const tam = parseFloat(cs.fontSize);
      return { tam, alto: parseFloat(cs.lineHeight), razon: parseFloat(cs.lineHeight) / tam };
    };
    return { sumTotal: mirar(".sum-total b"), billTotal: mirar(".bill-total"),
             fMid: mirar(".f-mid"), sumLine: mirar(".sum-line b") };
  });
  let vistos = 0;
  for (const [n, t] of Object.entries(tipos)) {
    if (!t) continue;
    vistos++;
    ok(t.razon < 1.3,
      `${n}: ${t.tam} px con interlínea ${t.razon.toFixed(2)}, no la del cuerpo (1,5)`);
  }
  ok(vistos > 0, `se llegó a medir alguna cifra grande (${vistos})`);

  await ctx.close();
  await b.close();
  console.log(fallos.length ? `\n--- fallos ---\n  ${fallos.join("\n  ")}\n\n${
    fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

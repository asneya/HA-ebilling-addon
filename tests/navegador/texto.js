/* El tamaño del texto: que escale de verdad y que no rompa nada al hacerlo.
 *
 * Los 185 tamaños de la hoja de estilos iban en píxeles, así que subir el
 * tamaño de letra del navegador no movía **nada**. Ahora van en `rem` y la raíz
 * la multiplica una preferencia, `--texto`, con su control en Ajustes.
 *
 * Que escale es la mitad del trabajo; la otra es que la maqueta aguante. Y eso
 * no se razona, se mide: se sube el texto y se recorre la aplicación buscando
 * lo que se sale o lo que ya no cabe en su caja.
 *
 *   1. la raíz sigue a la preferencia, y con ella todo lo demás
 *   2. el interletraje y la interlínea acompañan, por ir en `em` y sin unidad
 *   3. al 130 % y al 160 % nada se sale de la pantalla, en las cuatro vistas
 *   4. ni se queda contenido fuera de una caja de alto fijo
 *   5. las zonas táctiles no encogen
 *   6. el control existe, marca lo elegido y se aplica antes del primer pintado
 *   7. un valor imposible no deja la aplicación inservible
 */
const { abrirNavegador, base } = require("./camino");
const BASE = base("http://127.0.0.1:8402/");
const VISTAS = ["home", "energy", "billing", "settings"];
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

const abrir = async (b, uid) => {
  const ctx = await b.newContext({
    viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": uid },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => { if (m.type() === "error") fallos.push("console: " + m.text()); });
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1400);
  return { ctx, p };
};

const escalar = (p, n) =>
  p.evaluate((v) => document.documentElement.style.setProperty("--texto", v), n);

/* Lo que se sale de la pantalla, y lo que ya no cabe en su caja.
   Son dos fallos distintos: el primero se ve como una barra de scroll o texto
   cortado por el borde; el segundo, como un rótulo pisando lo de al lado, y ese
   no lo delata ningún `scrollHeight` porque el `overflow` por defecto es
   visible. */
const revisar = (p) => p.evaluate(() => {
  const fuera = [], apretados = [];
  const anchoV = document.documentElement.clientWidth;
  const nombre = (el) => el.tagName.toLowerCase() +
    (typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
  for (const el of document.querySelectorAll(".view.active *, .tabbar, .tabbar *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const c = el.getBoundingClientRect();
    if (!c.width || !c.height) continue;
    if (cs.position !== "absolute" && (c.right > anchoV + 1 || c.left < -1)) {
      fuera.push(`${nombre(el)} ${c.left.toFixed(0)}..${c.right.toFixed(0)}/${anchoV}`);
      continue;
    }
    // Caja con alto declarado: ¿lo que hay dentro cabe?
    if (cs.position === "absolute" || !/^\d/.test(cs.height) || !el.children.length) continue;
    const alto = parseFloat(cs.height);
    if (!alto) continue;
    let arriba = Infinity, abajo = -Infinity;
    for (const h of el.children) {
      const cs2 = getComputedStyle(h);
      // Lo que está puesto a mano por encima del borde sobresale a propósito:
      // la insignia flotante de la tarjeta de tarifa vive en `top: -9px`.
      if (cs2.position === "absolute") continue;
      const r = h.getBoundingClientRect();
      if (!r.height) continue;
      arriba = Math.min(arriba, r.top); abajo = Math.max(abajo, r.bottom);
    }
    if (abajo === -Infinity) continue;
    if (arriba - c.top < -1 || c.bottom - abajo < -1) {
      apretados.push(`${nombre(el)} caja ${alto.toFixed(0)} · dentro ${(abajo - arriba).toFixed(0)}`);
    }
  }
  return { fuera, apretados, scroll: document.documentElement.scrollWidth > anchoV + 1 };
});

(async () => {
  const nav = await abrirNavegador();
  const { ctx, p } = await abrir(nav, "fftexto0000000000000000000000ff");

  console.log("\n1-2 · la raíz manda, y todo la sigue");
  const medir = () => p.evaluate(() => {
    const raiz = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const t = document.querySelector(".nav-title, .hero-title, .group-label");
    const cs = t ? getComputedStyle(t) : null;
    return { raiz,
      titulo: cs ? parseFloat(cs.fontSize) : null,
      // El interletraje va en `em` desde la 0.72, así que escala solo. Si
      // alguien lo devolviera a px, esto lo caza.
      espaciado: cs ? parseFloat(cs.letterSpacing) : null,
      interlinea: cs ? parseFloat(cs.lineHeight) : null };
  });
  await escalar(p, 1);
  await p.waitForTimeout(300);
  const uno = await medir();
  await escalar(p, 1.6);
  await p.waitForTimeout(300);
  const seis = await medir();
  ok(Math.abs(uno.raiz - 16) < 0.1, `la raíz de partida es 16 px (${uno.raiz})`);
  ok(Math.abs(seis.raiz - uno.raiz * 1.6) < 0.2,
    `al 160 % la raíz es ${(uno.raiz * 1.6).toFixed(1)} (${seis.raiz})`);
  ok(seis.titulo && Math.abs(seis.titulo - uno.titulo * 1.6) < 0.5,
    `y el rótulo con ella: ${uno.titulo} → ${seis.titulo}`);
  if (uno.espaciado && Math.abs(uno.espaciado) > 0.01) {
    ok(Math.abs(seis.espaciado - uno.espaciado * 1.6) < 0.1,
      `el interletraje acompaña, por ir en em (${uno.espaciado} → ${seis.espaciado})`);
  }
  ok(Math.abs(seis.interlinea - uno.interlinea * 1.6) < 0.5,
    `y la interlínea, por no llevar unidad (${uno.interlinea} → ${seis.interlinea})`);

  console.log("\n3-5 · y la maqueta aguanta");
  for (const esc of [1.3, 1.6]) {
    await escalar(p, esc);
    for (const v of VISTAS) {
      await p.evaluate((n) => document.querySelector(`.tab[data-view="${n}"]`)?.click(), v);
      await p.waitForTimeout(2400);
      const r = await revisar(p);
      ok(!r.fuera.length && !r.scroll,
        `${Math.round(esc * 100)} % · ${v}: nada se sale${
          r.fuera.length ? " → " + r.fuera.slice(0, 3).join(" | ") : ""}`);
      ok(!r.apretados.length,
        `${Math.round(esc * 100)} % · ${v}: nada se queda sin sitio${
          r.apretados.length ? " → " + r.apretados.slice(0, 3).join(" | ") : ""}`);
    }
    // Las zonas táctiles no pueden encoger al crecer el texto.
    const chicas = await p.evaluate(() => {
      const malas = [];
      for (const el of document.querySelectorAll(".tabbar .tab, .view.active button")) {
        const c = el.getBoundingClientRect();
        if (!c.width || !c.height) continue;
        if (c.height < 43.5) malas.push(`${el.className.split(" ")[0]} ${c.height.toFixed(0)}px`);
      }
      return malas;
    });
    ok(!chicas.length,
      `${Math.round(esc * 100)} %: los botones siguen midiendo 44 px${
        chicas.length ? " → " + chicas.slice(0, 4).join(" | ") : ""}`);
  }

  console.log("\n6 · el control");
  await p.evaluate(() => document.querySelector('.tab[data-view="settings"]').click());
  await p.waitForTimeout(2400);
  const ctrl = await p.evaluate(() => ({
    hay: !!document.querySelector("#text-seg"),
    opciones: [...document.querySelectorAll("#text-seg .seg")].map((b) => b.dataset.textOpt),
    // El nombre sigue estando para el lector de pantalla aunque se vea una «A».
    nombres: [...document.querySelectorAll("#text-seg .seg")].map((b) => b.getAttribute("aria-label")),
  }));
  ok(ctrl.hay, "el control está en Apariencia");
  ok(ctrl.opciones.join() === "1,1.15,1.3,1.6", `con sus cuatro tamaños (${ctrl.opciones})`);
  ok(ctrl.nombres.every(Boolean), `y cada uno se llama por su nombre (${ctrl.nombres})`);
  await p.evaluate(() => document.querySelector('#text-seg .seg[data-text-opt="1.3"]').click());
  await p.waitForTimeout(1400);
  ok(await p.evaluate(() =>
    Math.abs(parseFloat(getComputedStyle(document.documentElement).fontSize) - 20.8) < 0.2),
    "elegirlo lo aplica en el acto");
  // Y al recargar tiene que venir ya grande: si se aplicara al llegar la
  // configuración, la página se pintaría pequeña y daría un salto.
  await p.reload();
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  const pronto = await p.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize));
  ok(Math.abs(pronto - 20.8) < 0.2,
    `y al recargar ya está puesto desde el primer pintado (${pronto} px)`);

  console.log("\n7 · un valor imposible no deja la aplicación inservible");
  const topado = await p.evaluate(() => {
    document.documentElement.style.setProperty("--texto", "40");
    const r = parseFloat(getComputedStyle(document.documentElement).fontSize);
    document.documentElement.style.setProperty("--texto", "1.3");
    return r;
  });
  ok(topado <= 16 * 1.6 + 0.2,
    `el CSS lo acota al 160 % pase lo que pase (${topado} px con --texto: 40)`);

  await ctx.close();
  await nav.close();
  console.log(fallos.length ? `\n--- fallos ---\n  ${fallos.join("\n  ")}\n\n${
    fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

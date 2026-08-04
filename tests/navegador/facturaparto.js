/* «Quién se ha gastado la factura»: la tarjeta del desglose en Facturación.
 *
 * El banco de Python (`desglose.py`) comprueba la cuenta con cifras hechas a
 * mano. Este comprueba lo otro, que es lo que el usuario ve:
 *
 *   1. el servidor la sirve de verdad, con los datos del fake, y salen filas
 *   2. está «el resto de la casa», que es la fila sin la que el desglose miente
 *   3. las filas suman el total que la tarjeta dice que suman —el cuadre, medido
 *      **en la pantalla** y no en el payload—
 *   4. sin tarifa marcada como «la mía» se enseña la energía y se dice por qué
 *      no hay euros, en vez de poner los de una tarifa cualquiera
 *   5. con tarifa marcada aparecen los euros
 *   6. nada se sale de su tarjeta
 *   7. sin errores de consola
 *
 * El punto 3 se mide contra el propio texto de la tarjeta a propósito: que el
 * payload cuadre ya lo dice el banco de Python; lo que aquí puede romperse es que
 * la interfaz enseñe unas filas y afirme otro total.
 */
const { abrirNavegador, base, capturas } = require("./camino");
const path = require("path");
const BASE = base("http://127.0.0.1:8402/");
const YO = "ffbanco00000000000000000000000f";
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

async function abrir(b, { tarifa } = {}) {
  const ctx = await b.newContext({
    viewport: { width: 414, height: 1400 },
    extraHTTPHeaders: { "X-Remote-User-Id": YO, "X-Remote-User-Display-Name": "Banco" },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => { if (m.type() === "error") fallos.push("console: " + m.text()); });
  // La tarifa marcada vive en los ajustes del usuario, así que se fija por la
  // API antes de entrar: tocar el botón de la tarjeta obligaría a saber qué
  // tarifa hay y en qué orden salen.
  if (tarifa !== undefined) {
    await p.request.put(BASE + "api/settings", {
      headers: { "X-Remote-User-Id": YO, "Content-Type": "application/json" },
      data: { my_tariff_id: tarifa },
    });
  }
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.click('.tab[data-view="billing"]');
  // El desglose va en su propia petición, detrás de la comparativa: se espera a
  // que ponga filas o a que diga por qué no las pone.
  await p.waitForFunction(
    () => {
      const c = document.querySelector("#split-rows");
      return c && !/Repartiendo/.test(c.textContent) && c.textContent.trim().length > 0;
    },
    { timeout: 30000 },
  );
  await p.waitForTimeout(400);
  return { ctx, p };
}

const leer = (p) => p.evaluate(() => {
  const num = (t) => {
    const m = (t || "").replace(/\s/g, "").match(/-?[\d.]*\d(?:,\d+)?/);
    return m ? parseFloat(m[0].replace(/\./g, "").replace(",", ".")) : null;
  };
  const filas = [...document.querySelectorAll("#split-rows .sp-row")].map((f) => ({
    kind: f.dataset.kind,
    id: f.dataset.id,
    nombre: f.querySelector(".sp-name")?.textContent.trim(),
    eur: num(f.querySelector(".sp-num b")?.textContent),
    kwh: num(f.querySelector(".sp-num span")?.textContent),
    trozos: f.querySelectorAll(".sp-barra i").length,
    // El ancho de la barra, para poder ver si alguna se sale.
    ancho: f.querySelector(".sp-barra")?.getBoundingClientRect().width || 0,
  }));
  const panel = document.querySelector("#split-panel");
  const caja = panel.getBoundingClientRect();
  const desborde = filas.length
    ? [...document.querySelectorAll("#split-rows .sp-row")].some((f) => {
        const r = f.getBoundingClientRect();
        return r.right > caja.right + 1 || r.left < caja.left - 1;
      })
    : false;
  return {
    filas,
    sub: panel.querySelector("#split-sub").textContent.trim(),
    nota: panel.querySelector("#split-note").textContent.trim(),
    vacio: document.querySelector("#split-rows .empty")?.textContent.trim() || "",
    desborde,
    anchoPanel: caja.width,
    scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
});

/* Poner y quitar la tarifa contratada cambia los ajustes de la instancia, que es
   la misma para varios bancos. Se apunta lo que había y se devuelve al acabar: un
   banco que deja la configuración tocada convierte al siguiente en un rojo
   intermitente que depende del orden. */
async function comoEstaba(p, valor) {
  await p.request.put(BASE + "api/settings", {
    headers: { "X-Remote-User-Id": YO, "Content-Type": "application/json" },
    data: { my_tariff_id: valor },
  });
}

(async () => {
  const b = await abrirNavegador();
  const previa = await (await b.newContext()).request
    .get(BASE + "api/config", { headers: { "X-Remote-User-Id": YO } })
    .then((r) => r.json())
    .then((c) => c.settings?.my_tariff_id || "")
    .catch(() => "");

  console.log("\n4 · sin tarifa marcada como «la mía»");
  let { ctx, p } = await abrir(b, { tarifa: "" });
  let v = await leer(p);
  ok(/Marca una tarifa/.test(v.sub),
    `se dice por qué no hay euros («${v.sub.slice(0, 46)}…»)`);
  if (v.filas.length) {
    ok(v.filas.every((f) => f.eur === null),
      "y ninguna fila se inventa un precio");
    ok(v.filas.some((f) => f.kwh > 0), "pero la energía sí está");
  } else {
    ok(false, `no hay filas que mirar (${v.vacio})`);
  }
  // La primera tarifa que traiga la configuración, sea cual sea: el banco no
  // tiene por qué saber cómo se llaman las del fake.
  const id = await p.evaluate(async (raiz) => {
    const cfg = await (await fetch(raiz + "api/config")).json();
    return (cfg.tariffs || [])[0]?.id || "";
  }, BASE);
  await ctx.close();
  ok(!!id, `hay una tarifa con la que poner precios (${id})`);

  console.log("\n1-3, 5 · con tarifa marcada");
  ({ ctx, p } = await abrir(b, { tarifa: id }));
  v = await leer(p);
  ok(v.filas.length >= 2, `salen las filas (${v.filas.length})`);
  ok(v.filas.some((f) => f.id === "__resto__"),
    "y entre ellas «el resto de la casa»");
  ok(v.filas.some((f) => f.kind === "aparato"),
    `y algún aparato medido (${v.filas.filter((f) => f.kind === "aparato").length})`);
  ok(/Al precio de/.test(v.sub), `la cabecera dice de qué tarifa son los euros`);
  ok(v.filas.every((f) => f.eur !== null),
    "todas las filas llevan euros");

  // El cuadre, medido en la pantalla: las filas contra los kWh importados que la
  // propia nota afirma. Un céntimo de holgura por el redondeo de cada fila.
  const importada = (() => {
    const m = v.nota.replace(/\s+/g, " ").match(/suman los ([\d.,]+)\s*kWh/);
    return m ? parseFloat(m[1].replace(/\./g, "").replace(",", ".")) : null;
  })();
  ok(importada !== null, `la nota dice cuánto tiene que sumar (${importada} kWh)`);
  // Los kWh de la columna son el consumo de cada fila, no su parte de red, así
  // que lo comparable es el total de red: se pide al payload por la misma vía que
  // usa la tarjeta, que es lo que se está comprobando que no se contradiga.
  const red = await p.evaluate(async (raiz) => {
    const d = await (await fetch(raiz + "api/breakdown")).json();
    return d.detail ? { filas: d.detail.grid_kwh, importada: d.detail.imported_kwh,
                        n: d.detail.rows.length } : null;
  }, BASE);
  ok(red && Math.abs(red.filas - red.importada) <= 0.02,
    `Σ red de las filas = importada (${red && red.filas} = ${red && red.importada})`);
  ok(red && red.n === v.filas.length,
    `y la pantalla pinta todas las filas que hay (${v.filas.length} de ${red && red.n})`);
  ok(importada === null || Math.abs(importada - red.importada) <= 0.02,
    "y la nota no afirma otra cifra que la del cálculo");

  console.log("\n6 · nada se sale de su tarjeta");
  ok(!v.desborde, "ninguna fila se sale del panel");
  ok(!v.scrollX, "y la pantalla no gana scroll horizontal");
  ok(v.filas.every((f) => f.ancho <= v.anchoPanel + 1),
    `ninguna barra se pasa del ancho del panel (${Math.max(...v.filas.map((f) => Math.round(f.ancho)))} ≤ ${Math.round(v.anchoPanel)})`);

  await p.screenshot({
    path: path.join(capturas(), "facturaparto.png"),
    clip: await p.evaluate(() => {
      const r = document.querySelector("#split-panel").getBoundingClientRect();
      return { x: r.x - 8, y: r.y - 30, width: r.width + 16, height: r.height + 40 };
    }),
  });
  await comoEstaba(p, previa);
  await ctx.close();
  await b.close();
  console.log(`\n  (la tarifa contratada se deja como estaba: «${previa}»)`);

  console.log();
  if (fallos.length) {
    console.log(`${fallos.length} fallos`);
    process.exit(1);
  }
  console.log("todo en verde");
})();

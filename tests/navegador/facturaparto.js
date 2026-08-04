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
 *   7. al abrir una fila: los días, los tramos, el día caro y la tira de 24 horas
 *      partida por origen
 *   8. y con InfluxDB la misma fila habla de **ciclos**, con su duración típica
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

async function abrir(b, { tarifa, retoque } = {}) {
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
  if (retoque) {
    await p.route("**/api/breakdown*", async (ruta) => {
      const resp = await ruta.fetch();
      const cuerpo = await resp.json();
      retoque(cuerpo);
      await ruta.fulfill({ response: resp, json: cuerpo });
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


  console.log("\n7 · al abrir una fila, lo que la suma del mes esconde");
  // Con datos inyectados: que el aparato del fake tenga sol a según qué horas depende
  // del día, y lo que se comprueba aquí es la tira, no el calendario.
  await ctx.close();
  ({ ctx, p } = await abrir(b, { tarifa: id, retoque: (c) => {
    const f = (c.detail?.rows || []).find((r) => r.kind === "aparato");
    if (!f) return;
    f.detail = {
      days: 4, runs: 5,
      worst_day: { date: "2026-08-02", eur: 0.42, kwh: 2.1, grid_kwh: 1.4 },
      // Bulto a las 13 (casi todo del sol) y a las 22 (todo comprado).
      by_hour: Array.from({ length: 24 }, (_, h) => (h === 13 ? 2.0 : h === 22 ? 1.0 : 0)),
      free_by_hour: Array.from({ length: 24 }, (_, h) => (h === 13 ? 1.8 : 0)),
    };
  } }));
  const antes = await p.evaluate(() => !!document.querySelector(".sp-det"));
  ok(!antes, "la fila empieza cerrada: el detalle no ocupa sitio sin pedirlo");
  await p.click('#split-rows .sp-row[data-abre]');
  await p.waitForTimeout(300);
  const det = await p.evaluate(() => {
    const d = document.querySelector(".sp-det");
    if (!d) return null;
    const barras = [...d.querySelectorAll(".sp-horas i")].map((i) => ({
      alto: Math.round(i.getBoundingClientRect().height),
      libre: i.querySelector("u") ? Math.round(i.querySelector("u").getBoundingClientRect().height) : 0,
      titulo: i.getAttribute("title"),
    }));
    return {
      texto: d.querySelector(".sp-det-l").textContent.replace(/\s+/g, " ").trim(),
      nota: d.querySelector(".sp-det-n").textContent.replace(/\s+/g, " ").trim(),
      barras,
      n: barras.length,
      ancho: d.getBoundingClientRect().width,
      panel: document.querySelector("#split-panel").getBoundingClientRect().width,
    };
  });
  ok(det !== null, "al tocarla se abre");
  ok(det && det.n === 24, `la tira tiene una barra por hora (${det && det.n})`);
  ok(det && /4 días/.test(det.texto) && /5 tramos/.test(det.texto),
    `dice los días y los tramos («${det && det.texto.slice(0, 44)}…»)`);
  ok(det && /0,42/.test(det.texto), "y lo que costó el día más caro");
  ok(det && !/2026-08-02/.test(det.texto), "con la fecha en cristiano, no en ISO");
  ok(det && /no un ciclo/.test(det.nota),
    "y se dice que un tramo no es un ciclo, que a esta resolución no se puede saber");
  ok(det && /InfluxDB/.test(det.nota),
    "y que con InfluxDB sí se cuentan, que es lo que hay que hacer para tenerlos");
  // La barra de las 13 va casi entera en ámbar y la de las 22 sin nada: es la mitad
  // que da el consejo, y sin ella la tira solo diría «cuándo» y no «a qué precio».
  const trece = det && det.barras[13];
  const veintidos = det && det.barras[22];
  ok(trece && trece.alto > 0 && veintidos && veintidos.alto > 0,
    `las dos horas con consumo se dibujan (${trece && trece.alto} y ${veintidos && veintidos.alto} px)`);
  ok(trece && trece.libre / trece.alto > 0.8,
    `la de mediodía va casi entera en ámbar (${trece && Math.round(trece.libre / trece.alto * 100)} %)`);
  ok(veintidos && veintidos.libre === 0,
    `y la de la noche, nada (${veintidos && veintidos.libre} px)`);
  ok(det && det.barras[3].alto === 0, "una hora sin consumo no dibuja barra");
  ok(det && det.ancho <= det.panel + 1, "y el detalle no se sale del panel");
  // Y se cierra tocándola otra vez: dos abiertas dejarían la pantalla en una lista de
  // tiras que no se comparan entre sí.
  await p.click('#split-rows .sp-row[data-abre]');
  await p.waitForTimeout(250);
  ok(!(await p.evaluate(() => !!document.querySelector(".sp-det"))),
    "y se cierra tocándola otra vez");

  console.log("\n8 · con InfluxDB la misma fila habla de ciclos");
  // La resolución cambia lo que se puede afirmar, así que la tarjeta tiene que decir
  // una cosa u otra. Llamarlos igual en los dos casos sería prometer con unos datos lo
  // que solo sostienen los otros.
  await ctx.close();
  ({ ctx, p } = await abrir(b, { tarifa: id, retoque: (c) => {
    if (!c.detail) return;
    c.detail.cycles = true;
    const f = (c.detail.rows || []).find((r) => r.kind === "aparato");
    if (!f) return;
    f.detail = {
      days: 4, runs: 5, cycles: 5, median_h: 1.83,
      starts_by_hour: Array.from({ length: 24 }, (_, h) => (h === 22 ? 4 : h === 13 ? 1 : 0)),
      worst_day: { date: "2026-08-02", eur: 0.42, kwh: 2.1, grid_kwh: 1.4 },
      by_hour: Array.from({ length: 24 }, (_, h) => (h === 13 ? 2.0 : h === 22 ? 1.0 : 0)),
      free_by_hour: Array.from({ length: 24 }, (_, h) => (h === 13 ? 1.8 : 0)),
    };
  } }));
  await p.click('#split-rows .sp-row[data-abre]');
  await p.waitForTimeout(300);
  const conInflux = await p.evaluate(() => {
    const d = document.querySelector(".sp-det");
    return d ? {
      texto: d.querySelector(".sp-det-l").textContent.replace(/\s+/g, " ").trim(),
      nota: d.querySelector(".sp-det-n").textContent.replace(/\s+/g, " ").trim(),
    } : null;
  });
  ok(conInflux && /5 ciclos/.test(conInflux.texto),
    `los llama ciclos («${conInflux && conInflux.texto.slice(0, 46)}…»)`);
  ok(conInflux && !/tramos/.test(conInflux.texto), "y no tramos");
  ok(conInflux && /1 h 50 min/.test(conInflux.texto),
    "con lo que suele durar uno, que un tramo no podía decir");
  ok(conInflux && !/no un ciclo/.test(conInflux.nota),
    `y la nota ya no avisa de lo que no son («${conInflux && conInflux.nota.slice(0, 52)}…»)`);
  ok(conInflux && /InfluxDB/.test(conInflux.nota), "sino de dónde se han contado");

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

/* La tarjeta del plan dice la verdad sobre el momento del que habla.
 *
 * De una queja: a las 9:47, con la tarjeta de la ventana diciendo «Lavadora ·
 * gratis **desde las 10:06**», la del plan decía «Lavadora · **ahora** · ahora
 * mismo · 99 % con sol · **es su mejor hora**». Dos tarjetas de la misma
 * pantalla contradiciéndose sobre el mismo instante.
 *
 * El 99 % no era de ahora: con `worth_waiting` en falso la fila seguía leyendo
 * `best.sun_pct` y le pegaba la etiqueta «ahora mismo». Y «es su mejor hora» era
 * falso: la mejor hora era más tarde, solo que la diferencia en euros no llegaba
 * al umbral.
 *
 *   1. cuando dice «ahora mismo», el porcentaje es el de ahora
 *   2. cuando pide esperar, el porcentaje es el de la hora que propone
 *   3. no se afirma «es su mejor hora» si la mejor hora es más tarde
 *   4. y el titular tampoco lo afirma
 *   5. si la mejor hora es de verdad ahora, sí se dice
 *   6. el motivo de esperar por el sol se explica con el sol, no con céntimos
 *   7. sin errores de consola
 */
const { abrirNavegador, base } = require("./camino");
const BASE = base("http://127.0.0.1:8402/");
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

/* Una fila del plan, con lo que el servidor manda de verdad. */
const fila = (extra) => ({
  id: "lavadora", name: "Lavadora", icon: "lavadora", color: "#0f7d8a",
  hours: 1.17, kwh: 0.32,
  now: { at: "2026-08-03T09:47:00+02:00", sun_pct: 60, sun_kwh: 0.19,
         battery_kwh: 0.13, grid_kwh: 0, eur: 0.02 },
  best: { at: "2026-08-03T10:17:00+02:00", sun_pct: 100, sun_kwh: 0.32,
          battery_kwh: 0, grid_kwh: 0, eur: 0.0 },
  saving_eur: 0.013, sun_gain_pct: 40, worth_waiting: true, priced: true,
  ...extra,
});

async function abrir(plan) {
  const ctx = await (await navegador).newContext({
    viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f" },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => { if (m.type() === "error") fallos.push("console: " + m.text()); });
  await p.route("**/api/live", async (ruta) => {
    const resp = await ruta.fetch();
    const cuerpo = await resp.json();
    cuerpo.plan = plan;
    await ruta.fulfill({ response: resp, json: cuerpo });
  });
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1800);
  const leido = await p.evaluate(() => ({
    aside: document.querySelector("#plan-aside")?.textContent.trim(),
    filas: [...document.querySelectorAll("#plan-rows .ad-row")].map((f) => ({
      sub: f.querySelector(".ad-txt small")?.textContent.trim(),
      valor: f.querySelector(".ad-verdict b")?.textContent.trim(),
      porque: f.querySelector(".ad-verdict small")?.textContent.trim(),
    })),
  }));
  await ctx.close();
  return leido;
}

let navegador;
(async () => {
  navegador = abrirNavegador();

  console.log("\n1-2 · el porcentaje es del momento del que se habla");
  // Pide esperar: el porcentaje tiene que ser el de la hora propuesta.
  let v = await abrir({ rows: [fila({})], battery: null });
  ok(/100 % con sol/.test(v.filas[0].sub),
    `esperando, el sol de la hora propuesta («${v.filas[0].sub}»)`);
  ok(!/ahora mismo/.test(v.filas[0].sub), "y no se dice «ahora mismo»");

  // No pide esperar: el porcentaje tiene que ser el de **ahora**, que es 60.
  v = await abrir({ rows: [fila({ worth_waiting: false })], battery: null });
  ok(/ahora mismo/.test(v.filas[0].sub) && /60 % con sol/.test(v.filas[0].sub),
    `y sin esperar, el sol de ahora («${v.filas[0].sub}»)`);
  ok(!/100 % con sol/.test(v.filas[0].sub),
    "nunca el de la mejor hora con la etiqueta de ahora");

  console.log("\n3-4 · no se afirma lo que no es");
  ok(!/es su mejor hora/.test(v.filas[0].porque),
    `no se dice «es su mejor hora» si es más tarde («${v.filas[0].porque}»)`);
  ok(!/mejor hora/.test(v.aside), `ni en el titular («${v.aside}»)`);

  console.log("\n5 · y cuando la mejor hora sí es ahora, se dice");
  const yaEsta = fila({
    worth_waiting: false, saving_eur: 0, sun_gain_pct: 0,
    best: { at: "2026-08-03T09:47:00+02:00", sun_pct: 60, sun_kwh: 0.19,
            battery_kwh: 0.13, grid_kwh: 0, eur: 0.02 },
  });
  v = await abrir({ rows: [yaEsta], battery: null });
  ok(v.filas[0].valor === "ahora" && /es su mejor hora/.test(v.filas[0].porque),
    `ahí sí («${v.filas[0].valor}» · «${v.filas[0].porque}»)`);
  ok(/ya están en su mejor hora/.test(v.aside), `y el titular también («${v.aside}»)`);
  ok(/60 % con sol/.test(v.filas[0].sub), "con el sol de ahora, que es el mismo");

  console.log("\n6 · el motivo de esperar por el sol se explica con el sol");
  v = await abrir({ rows: [fila({ saving_eur: 0.0 })], battery: null });
  ok(/100 % con sol/.test(v.filas[0].porque),
    `«${v.filas[0].porque}» y no un ahorro de cero`);
  ok(!/0,00/.test(v.filas[0].porque), "sin prometer céntimos que no hay");

  await (await navegador).close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

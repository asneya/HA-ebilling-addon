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
 *   7. y si el tejado se desvía de la previsión, se dice aquí también
 *   8. la barra del origen dice de qué depósito sale, con los colores del resumen
 *   9. un aparato de siempre encendido no trae hora, trae lo que lleva hoy
 *  10. sin errores de consola
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
  // La forma de uso y la etiqueta las pone el servidor desde la fusión de las dos
  // tarjetas: el número de la derecha es lo que cuesta, no la hora.
  kind: "movible", kind_auto: true,
  verdict: { kind: "gratis", value: "Gratis", sub: "lo pone el sol" },
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
    nota: document.querySelector("#plan-note")?.textContent.replace(/\s+/g, " ").trim(),
    filas: [...document.querySelectorAll("#plan-rows .ad-row")].map((f) => ({
      kind: f.dataset.kind,
      // Los trozos de la barra del origen: su color y su anchura, que es lo que
      // sustituye al renglón de texto de la tarjeta retirada.
      barra: [...f.querySelectorAll(".ap-barra i")].map((x) => ({
        color: x.style.background, ancho: parseFloat(x.style.width),
        titulo: x.getAttribute("title"),
      })),
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
  ok(/es su mejor hora/.test(v.filas[0].porque),
    `ahí sí lo dice («${v.filas[0].porque}»)`);
  // Y el número de la derecha es lo que cuesta, que desde la fusión es la
  // respuesta: la hora vive en el renglón de debajo del nombre.
  ok(v.filas[0].valor === "Gratis",
    `con lo que cuesta a la derecha («${v.filas[0].valor}»)`);
  ok(/ya están en su mejor hora/.test(v.aside), `y el titular también («${v.aside}»)`);
  ok(/60 % con sol/.test(v.filas[0].sub), "con el sol de ahora, que es el mismo");

  console.log("\n6 · el motivo de esperar por el sol se explica con el sol");
  v = await abrir({ rows: [fila({ saving_eur: 0.0 })], battery: null });
  ok(/100 % con sol/.test(v.filas[0].porque),
    `«${v.filas[0].porque}» y no un ahorro de cero`);
  ok(!/0,00/.test(v.filas[0].porque), "sin prometer céntimos que no hay");

  console.log("\n7 · el desvío de hoy, con las mismas palabras que la ventana");
  // La segunda mitad de la queja: «además está nublado ahora mismo y la
  // producción real es bajísima». Las horas de esta tarjeta salen de la misma
  // curva que la de la ventana, así que si esa curva va rebajada, esta tarjeta
  // tiene que decirlo igual que la otra. Callarlo aquí sería volver a la
  // incoherencia por la puerta de atrás.
  v = await abrir({ rows: [fila({})], battery: null,
                    roof_today: { factor: 0.2, hour: 10, hour_ratio: 0.18, now_ratio: 0.22 } });
  ok(/tu tejado va al 20 % de lo previsto/.test(v.nota),
    `se dice en la nota («${v.nota}»)`);
  ok(/estas horas ya van con el sol rebajado/.test(v.nota),
    "y que las horas de arriba ya lo llevan puesto");
  v = await abrir({ rows: [fila({})], battery: null,
                    roof_today: { factor: 0.95, hour: 10, hour_ratio: 0.95, now_ratio: 0.95 } });
  ok(!/tejado va al/.test(v.nota || ""), "un tejado que cumple no se menciona");
  v = await abrir({ rows: [fila({})], battery: null, roof_today: null });
  ok(!/tejado va al/.test(v.nota || ""), "y sin testigo tampoco");

  console.log("\n8 · la barra del origen");
  // Tres depósitos con partes distintas: la barra tiene que llevar los tres, en
  // proporción, y con su cifra en el título para quien la mire de cerca.
  v = await abrir({ battery: null, rows: [fila({
    now: { at: "2026-08-03T11:00:00+02:00", sun_pct: 50, sun_kwh: 1.0,
           battery_kwh: 0.6, grid_kwh: 0.4, eur: 0.08 },
    worth_waiting: false, saving_eur: 0,
    verdict: { kind: "parcial", value: 0.08, sub: "50 % lo pone el sol" },
  })] });
  const b = v.filas[0].barra;
  ok(b.length === 3, `tres trozos, uno por depósito (${b.length})`);
  ok(Math.abs(b[0].ancho - 50) < 1 && Math.abs(b[1].ancho - 30) < 1
     && Math.abs(b[2].ancho - 20) < 1,
    `en proporción a los kWh (${b.map((x) => x.ancho).join(" / ")} %)`);
  ok(b.every((x) => x.color), `con color cada uno (${b.map((x) => x.color).join(" · ")})`);
  ok(new Set(b.map((x) => x.color)).size === 3, "y los tres distintos");
  ok(/del sol/.test(b[0].titulo) && /de la batería/.test(b[1].titulo)
     && /de la red/.test(b[2].titulo),
    `y su cifra en el título («${b[0].titulo}»)`);
  // Un trozo de migaja no se dibuja: a esa anchura no se ve y ensucia el borde.
  v = await abrir({ battery: null, rows: [fila({
    now: { at: "2026-08-03T11:00:00+02:00", sun_pct: 99, sun_kwh: 2.0,
           battery_kwh: 0.01, grid_kwh: 0, eur: 0 },
    worth_waiting: false, saving_eur: 0,
  })] });
  ok(v.filas[0].barra.length === 1,
    `un trozo por debajo del 4 % no se dibuja (${v.filas[0].barra.length})`);

  console.log("\n9 · un aparato de siempre encendido");
  v = await abrir({ battery: null, rows: [{
    id: "nev", name: "Nevera", icon: "potencia", color: "#08f",
    kind: "continuo", kind_auto: true,
    today: { kwh: 0.67, sun_kwh: 0.31, battery_kwh: 0.3, grid_kwh: 0.06, eur: 0.01 },
    verdict: { kind: "parcial", value: 0.01, sub: "46 % lo pone el sol" },
  }] });
  ok(/0,67 kWh hoy/.test(v.filas[0].sub) && /siempre encendido/.test(v.filas[0].sub),
    `dice lo que lleva hoy, no una hora («${v.filas[0].sub}»)`);
  ok(!/mejor/.test(v.filas[0].sub), "y no propone ninguna hora");
  ok(v.filas[0].barra.length === 3, "con su barra del origen igual que los demás");
  ok(/siempre encendido/.test(v.nota), `y se dice que lo ha decidido la app («${v.nota}»)`);

  await (await navegador).close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

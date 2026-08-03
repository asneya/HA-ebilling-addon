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
 *  10. y uno en marcha dice por dónde va, sin proponerle una hora ya pasada
 *  11. la barra del progreso es la misma del origen, y puede pasarse
 *  12. la forma de uso va en un glifo, y «en marcha» en un punto que late
 *  13. sin errores de consola
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
      marcha: f.dataset.running === "1",
      // Los trozos de la barra del origen: su color y su anchura, que es lo que
      // sustituye al renglón de texto de la tarjeta retirada.
      barra: [...f.querySelectorAll(".ap-barra i")].map((x) => ({
        color: x.style.background, ancho: parseFloat(x.style.width),
        titulo: x.getAttribute("title"),
      })),
      // Y hasta dónde llega el relleno, que en un aparato en marcha es el
      // progreso del ciclo: la barra del origen y la del progreso son la misma.
      relleno: f.querySelector(".ap-barra.ap-progreso > span")?.style.width || null,
      // La insignia de la forma de uso y el punto de «en marcha», que sustituyen
      // a dos renglones de texto.
      insignia: f.querySelector(".ap-insignia use")?.getAttribute("href") || null,
      rotulo: f.querySelector(".ap-insignia title")?.textContent || null,
      late: !!f.querySelector(".ap-late"),
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
  // «Siempre encendido» ya no es un renglón: es la insignia de la fila (§12).
  ok(/0,67 kWh hoy/.test(v.filas[0].sub),
    `dice lo que lleva hoy, no una hora («${v.filas[0].sub}»)`);
  ok(!/mejor/.test(v.filas[0].sub), "y no propone ninguna hora");
  ok(v.filas[0].barra.length === 3, "con su barra del origen igual que los demás");
  ok(/deducido Vatia/.test(v.nota) && /Ajustes → Electrodomésticos/.test(v.nota),
    `y se dice que lo ha decidido la app, y dónde se cambia («${v.nota}»)`);

  console.log("\n10 · un aparato en marcha");
  // La lavadora puesta hace 40 minutos, de un ciclo de 1 h 30 que siempre dura lo
  // mismo. La pregunta «¿a qué hora?» ya está contestada: la fila cuenta otra cosa.
  const enMarcha = (extra) => fila({
    running: { start: "2026-08-03T10:20:00+02:00", elapsed_h: 0.67, kwh: 0.42,
               typical_h: 1.5, pct: 44, over: false,
               ends_at: "2026-08-03T11:50:00+02:00", remaining_h: 0.83,
               range_h: null },
    so_far: { kwh: 0.42, sun_kwh: 0.21, battery_kwh: 0.13, grid_kwh: 0.08,
              eur: 0.02 },
    tail: { hours: 0.83, sun_kwh: 0.5, battery_kwh: 0, grid_kwh: 0, sun_pct: 100 },
    best: null, saving_eur: null, worth_waiting: false,
    verdict: { kind: "parcial", value: 0.02, sub: "50 % lo pone el sol" },
    ...extra,
  });
  v = await abrir({ battery: null, rows: [enMarcha({})] });
  ok(v.filas[0].marcha, "la fila se sabe en marcha");
  // Sin escribir «en marcha»: eso lo dice el punto que late sobre su icono (§12).
  ok(/lleva 40 min/.test(v.filas[0].sub),
    `dice lo que lleva puesto, que es lo medido («${v.filas[0].sub}»)`);
  // La hora sale en la zona del navegador, que aquí es UTC: las 11:50 de Madrid.
  ok(/~termina a las 09:50/.test(v.filas[0].porque),
    `y la hora de fin, que es el número accionable («${v.filas[0].porque}»)`);
  ok(!/mejor/.test(v.filas[0].sub) && !/mejor/.test(v.filas[0].porque),
    "sin proponer una hora óptima de algo que ya está puesto");
  ok(/queda 100 % con sol/.test(v.filas[0].sub),
    "y de dónde va a salir lo que le queda, que es lo que nadie más dice");
  // Con \s, que `Intl` separa el € con espacio duro.
  ok(/^0,02\s€$/.test(v.filas[0].valor),
    `a la derecha, lo que lleva costado y no lo que costaría ponerlo («${v.filas[0].valor}»)`);
  ok(!/mejor hora/.test(v.aside),
    `el titular no cuenta lo que ya está puesto («${v.aside}»)`);

  // Sin fiarse de la duración no se promete una hora: se dice lo que se sabe.
  v = await abrir({ battery: null, rows: [enMarcha({
    running: { start: "2026-08-03T10:20:00+02:00", elapsed_h: 0.67, kwh: 0.42,
               typical_h: 1.5, pct: 44, over: false, ends_at: null,
               remaining_h: null, range_h: [0.9, 2.4] },
    tail: null,
  })] });
  ok(/suele durar 55 min–2 h 25 min/.test(v.filas[0].porque),
    `una lavadora con varios programas dice el recorrido («${v.filas[0].porque}»)`);
  ok(!/termina/.test(v.filas[0].porque), "y no una hora de fin que no se sostiene");
  ok(!/queda \d+ % con sol/.test(v.filas[0].sub),
    "ni de dónde saldrá una cola cuyo final no se sabe");

  console.log("\n11 · la barra del progreso");
  v = await abrir({ battery: null, rows: [enMarcha({})] });
  ok(v.filas[0].relleno === "44%",
    `se rellena hasta donde va el ciclo (${v.filas[0].relleno})`);
  ok(v.filas[0].barra.length === 3,
    "y dentro sigue estando el origen de lo que lleva gastado");
  // Pasarse de lo habitual: la barra llega al borde y **se dice**, que es lo que
  // una barra clavada en el 100 % no puede distinguir.
  v = await abrir({ battery: null, rows: [enMarcha({
    running: { start: "2026-08-03T09:00:00+02:00", elapsed_h: 2.0, kwh: 0.9,
               typical_h: 1.5, pct: 133, over: true, ends_at: null,
               remaining_h: null, range_h: null },
    tail: null,
  })] });
  ok(v.filas[0].relleno === "100%",
    `un programa más largo llena la barra (${v.filas[0].relleno})`);
  ok(/más de lo habitual \(1 h 30 min\)/.test(v.filas[0].porque),
    `y lo dice con palabras («${v.filas[0].porque}»)`);
  // Y sin ciclo aprendido no hay progreso que dibujar: barra normal, sin carril.
  v = await abrir({ battery: null, rows: [enMarcha({
    running: { start: "2026-08-03T10:20:00+02:00", elapsed_h: 0.67, kwh: 0.42,
               typical_h: null, pct: null, over: false, ends_at: null,
               remaining_h: null, range_h: null },
    tail: null,
  })] });
  ok(v.filas[0].relleno === null,
    "sin ciclo aprendido no se dibuja un progreso inventado");
  ok(/aprendiendo su ciclo/.test(v.filas[0].porque),
    `y se dice que aún se está aprendiendo («${v.filas[0].porque}»)`);

  console.log("\n12 · la forma de uso, en un glifo");
  // De una queja: *«tiene mucha información larga y pequeña. Quedaría mejor
  // reemplazar algunos mensajes por iconos»*. «Siempre encendido» y «en marcha» eran
  // etiquetas ocupando el sitio de los datos.
  v = await abrir({ battery: null, rows: [
    fila({ worth_waiting: false, saving_eur: 0 }),
    { ...fila({}), id: "aire", name: "Aire", kind: "fijo", best: null,
      saving_eur: null, worth_waiting: false },
    { id: "nev", name: "Nevera", icon: "potencia", color: "#08f",
      kind: "continuo", kind_auto: true,
      today: { kwh: 0.67, sun_kwh: 0.31, battery_kwh: 0.3, grid_kwh: 0.06, eur: 0.01 },
      verdict: { kind: "parcial", value: 0.01, sub: "46 % lo pone el sol" } },
  ] });
  const [mov, fij, con] = v.filas;
  ok(mov.insignia === "#i-reloj" && /elegir la hora/.test(mov.rotulo),
    `el movible lleva un reloj, que es la pregunta de su fila («${mov.rotulo}»)`);
  ok(fij.insignia === "#i-casa" && /no cuando pica el sol/.test(fij.rotulo),
    `el fijo, la casa: la hora la manda la casa («${fij.rotulo}»)`);
  ok(con.insignia === "#i-potencia" && /Siempre encendido/.test(con.rotulo),
    `y el continuo, el rayo («${con.rotulo}»)`);
  ok(!/siempre encendido/i.test(con.sub),
    `y ya no se escribe en el renglón («${con.sub}»)`);
  ok(v.filas.every((f) => !f.late), "sin nada en marcha, ningún punto");
  ok(!/a las \d\d:\d\d/.test(mov.sub) || /mejor \d\d:\d\d|mejor mañana \d\d:\d\d/.test(mov.sub),
    `y la hora va sin «a las», que se iba a tres líneas («${mov.sub}»)`);

  v = await abrir({ battery: null, rows: [enMarcha({})] });
  ok(v.filas[0].late, "en marcha, el punto que late sobre su icono");
  ok(!/en marcha/i.test(v.filas[0].sub),
    `y tampoco se escribe («${v.filas[0].sub}»)`);
  ok(v.filas[0].insignia === "#i-reloj",
    "sigue siendo un movible: la insignia no cambia por estar puesto");

  await (await navegador).close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

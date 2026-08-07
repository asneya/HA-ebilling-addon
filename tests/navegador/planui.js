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
 *   9c. y la tarjeta explica el reparto del sol entre aparatos
 *  10. y uno en marcha dice por dónde va, sin proponerle una hora ya pasada
 *  11. la barra del progreso es la misma del origen, y puede pasarse
 *  12. la forma de uso va en un glifo, y «en marcha» en un aro verde
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
        // Y el ancho **pintado**, que no es el mismo: un tramo diminuto lo sostiene
        // un mínimo de 2 px del CSS. Sin medir esto no había forma de saber si el
        // tramo que se quiere enseñar se ve o se lo come el redondeo.
        pintado: +x.getBoundingClientRect().width.toFixed(2),
        titulo: x.getAttribute("title"),
      })),
      // El carril y la suma de los tramos, para saber si el mínimo desborda.
      // `getBoundingClientRect` va después de la transformación, así que en una
      // barra de progreso esto es lo que de verdad se ve, no lo que se maquetó.
      carril: (() => {
        const c = f.querySelector(".ap-barra > span");
        return c ? +c.getBoundingClientRect().width.toFixed(2) : null;
      })(),
      anchoBarra: (() => {
        const c = f.querySelector(".ap-barra");
        return c ? +c.getBoundingClientRect().width.toFixed(2) : null;
      })(),
      // Y hasta dónde llega el relleno, que en un aparato en marcha es el
      // progreso del ciclo: la barra del origen y la del progreso son la misma.
      // Va en `--p` y no en la anchura porque se dibuja con `scaleX`: animar la
      // anchura rehace la maqueta en cada fotograma.
      relleno: f.querySelector(".ap-barra.ap-progreso > span")
        ?.style.getPropertyValue("--p").trim() || null,
      // La insignia de la forma de uso y el punto de «en marcha», que sustituyen
      // a dos renglones de texto.
      insignia: f.querySelector(".ap-insignia use")?.getAttribute("href") || null,
      rotulo: f.querySelector(".ap-insignia title")?.textContent || null,
      // El aro verde alrededor del icono: «en marcha» sin escribirlo.
      aro: f.dataset.on === "1",
      anillo: f.querySelector(".ad-chip") ?
        getComputedStyle(f.querySelector(".ad-chip")).boxShadow : null,
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
  // Un trozo diminuto **sí** se dibuja. Antes se descartaba por debajo del 4 %, y
  // con eso la barra podía contradecir a la cifra de al lado: de la pregunta *«me
  // aparece que se alimenta solo de solar pero hay un coste»*. Una nevera al 98,5 %
  // de sol y 1,5 % de red pintaba una barra ámbar entera y a la vez enseñaba euros,
  // así que parecía cobrar por el sol.
  // Las cifras son de un coche cargando: 10 kWh en el día con 0,06 de la red. Ese
  // 0,6 % son 1,07 px sin el mínimo —invisible— y sin embargo **cuesta dinero**, que
  // es lo que hace la contradicción. Con un aparato pequeño el tramo ya se veía
  // solo, así que un banco con esas cifras no habría probado el mínimo: el primer
  // intento de este caso usaba 1,5 % y salía verde con el arreglo quitado.
  v = await abrir({ battery: null, rows: [fila({
    now: { at: "2026-08-03T11:00:00+02:00", sun_pct: 99, sun_kwh: 9.94,
           battery_kwh: 0, grid_kwh: 0.06, eur: 0.01 },
    worth_waiting: false, saving_eur: 0,
    verdict: { kind: "parcial", value: 0.01, sub: "99 % lo puso el sol" },
  })] });
  const dos = v.filas[0].barra;
  ok(dos.length === 2,
    `un tramo del 0,6 % se dibuja igual, para no contradecir a la cifra (${dos.length})`);
  ok(dos[1] && dos[1].pintado >= 2,
    `y el mínimo del CSS lo sostiene a 2 px (${dos[1] && dos[1].pintado} px de ${
      dos[1] && dos[1].ancho} %)`);
  // Y el mínimo no puede desbordar: con `overflow: hidden` lo que se recortaría es
  // justo el tramo pequeño, porque la red va al final. El grande cede los 2 px.
  const suma = dos.reduce((a, x) => a + x.pintado, 0);
  ok(Math.abs(suma - v.filas[0].carril) < 0.6,
    `los tramos suman el carril, sin desbordar (${suma.toFixed(2)} de ${v.filas[0].carril})`);

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

  console.log("\n9b · sus euros son los atribuidos, no una revaloración");
  // De la pregunta: *«¿qué significan los euros que salen junto al congelador?»*. El
  // coste de un continuo sale del `eur` de su atribución —hora a hora, cada hora a
  // su precio, cobrando solo la red— y el servidor ya no lo recalcula. Lo que aquí
  // se comprueba es que la pantalla enseñe **ese** número y no otro.
  v = await abrir({ battery: null, rows: [{
    id: "nev", name: "Nevera", icon: "nevera", color: "#08f",
    kind: "continuo", kind_auto: false,
    today: { kwh: 0.639, sun_kwh: 0.279, battery_kwh: 0.296, grid_kwh: 0.064,
             eur: 0.01 },
    verdict: { kind: "parcial", value: 0.01, sub: "44 % lo puso el sol" },
  }] });
  // `\s` y no un espacio: `Intl` mete un espacio duro antes del €, y comparar la
  // cadena entera se pone rojo por un carácter que no se ve.
  ok(/^0,01\s€$/.test(v.filas[0].valor),
    `enseña el coste atribuido («${v.filas[0].valor}», no los 0,07 € de antes)`);
  ok(/44 %/.test(v.filas[0].porque), `con el sol que lo puso («${v.filas[0].porque}»)`);
  // Y un congelador alimentado del sol y de lo guardado: ni un céntimo.
  v = await abrir({ battery: null, rows: [{
    id: "cong", name: "Congelador", icon: "congelador", color: "#08f",
    kind: "continuo", kind_auto: false,
    today: { kwh: 0.5, sun_kwh: 0.2, battery_kwh: 0.3, grid_kwh: 0.0, eur: 0.0 },
    verdict: { kind: "gratis", value: "Gratis",
               sub: "del sol y de lo que tenías guardado" },
  }] });
  ok(v.filas[0].valor === "Gratis",
    `del sol y de la batería no cuesta nada («${v.filas[0].valor}»)`);
  ok(/guardado/.test(v.filas[0].porque),
    `y se dice por qué el cero es cero («${v.filas[0].porque}»)`);
  ok(v.filas[0].barra.length === 2, "con los dos depósitos de los que salió");

  console.log("\n9c · el sol de una hora es uno, y se dice quién se lo lleva");
  // Del modelo de EMHASS: todas las cargas contra un único balance. El planificador
  // ya reparte, y aquí se comprueba que la tarjeta **explique** el reparto: sin eso
  // la hora recomendada cambia de un día para otro y no hay nada que lo justifique.
  v = await abrir({ battery: null, rows: [
    fila({ id: "coche", name: "Coche", icon: "coche-electrico",
      best: { at: "2026-08-03T13:30:00+02:00", sun_pct: 100, sun_kwh: 2.0,
              battery_kwh: 0, grid_kwh: 0, eur: 0 },
      saving_eur: 0.4, worth_waiting: true, displaced_by: [], alone_at: null }),
    fila({ id: "lavadora", name: "Lavadora",
      best: { at: "2026-08-03T14:30:00+02:00", sun_pct: 80, sun_kwh: 1.6,
              battery_kwh: 0, grid_kwh: 0.4, eur: 0.08 },
      saving_eur: 0.1, worth_waiting: true,
      displaced_by: ["Coche"], alone_at: "2026-08-03T13:30:00+02:00" }),
  ] });
  ok(/El sol de una hora es uno/.test(v.nota),
    `se dice que el sol se reparte («${v.nota.slice(0, 60)}…»)`);
  ok(/Lavadora/.test(v.nota) && /Coche/.test(v.nota),
    "con a quién se le movió la hora y quién tenía el hueco");
  // La hora que habría tenido a solas. **Sin atarla al reloj**: el navegador del
  // banco pinta en UTC, así que las 13:30+02:00 salen como 11:30 y con «mañana»
  // delante. Lo que se comprueba es lo que se afirma: que la nota nombra una hora
  // **distinta** de la recomendada, que es toda la explicación.
  const enNota = (v.nota.match(/(\d{1,2}:\d{2})/g) || []);
  const enFila = (v.filas[1].sub.match(/(\d{1,2}:\d{2})/g) || []);
  ok(enNota.length > 0 && enFila.length > 0 && enNota[0] !== enFila[0],
    `y nombra otra hora que la recomendada (nota ${enNota[0]} vs fila ${enFila[0]})`);
  // Y sin desplazados, no se dice nada: una nota que sale siempre es ruido.
  v = await abrir({ battery: null, rows: [fila({ displaced_by: [], alone_at: null })] });
  ok(!/El sol de una hora es uno/.test(v.nota || ""),
    "y sin nadie desplazado la nota no aparece");

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
    best: null, saving_eur: null, worth_waiting: false, on: true,
    verdict: { kind: "parcial", value: 0.02, sub: "50 % lo pone el sol" },
    ...extra,
  });
  v = await abrir({ battery: null, rows: [enMarcha({})] });
  ok(v.filas[0].marcha, "la fila se sabe en marcha");
  // Sin escribir «en marcha»: eso lo dice el aro verde de su icono (§12).
  ok(/lleva 40 min/.test(v.filas[0].sub),
    `dice lo que lleva puesto, que es lo medido («${v.filas[0].sub}»)`);
  // La hora sale en la zona del navegador, que aquí es UTC: las 11:50 de Madrid.
  ok(/~termina (mañana )?a las 09:50/.test(v.filas[0].porque),
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
  ok(v.filas[0].relleno === "0.440",
    `se rellena hasta donde va el ciclo (${v.filas[0].relleno})`);
  ok(v.filas[0].barra.length === 3,
    "y dentro sigue estando el origen de lo que lleva gastado");
  // El relleno se dibuja escalado, así que hay que mirar lo **pintado**: el carril
  // interior mide la barra entera y es `scaleX` quien lo recorta al 44 %.
  ok(v.filas[0].carril > 0 && Math.abs(v.filas[0].carril / v.filas[0].anchoBarra - 0.44) < 0.02,
    `y en pantalla ocupa ese 44 % (${v.filas[0].carril} px de ${v.filas[0].anchoBarra})`);
  // Pasarse de lo habitual: la barra llega al borde y **se dice**, que es lo que
  // una barra clavada en el 100 % no puede distinguir.
  v = await abrir({ battery: null, rows: [enMarcha({
    running: { start: "2026-08-03T09:00:00+02:00", elapsed_h: 2.0, kwh: 0.9,
               typical_h: 1.5, pct: 133, over: true, ends_at: null,
               remaining_h: null, range_h: null },
    tail: null,
  })] });
  ok(v.filas[0].relleno === "1.000",
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

  // El caso que se le escapaba al §8: un tramo diminuto **dentro** de un relleno
  // corto. El mínimo del CSS son 2 px, pero el relleno se dibuja con `scaleX`, así
  // que 2 px maquetados dentro de un relleno al 10 % son 0,2 px en pantalla. Por
  // eso el mínimo va dividido por `--p`. Sin esa división esta comprobación falla:
  // el tramo existe en el DOM, tiene su color y su título, y no se ve.
  v = await abrir({ battery: null, rows: [enMarcha({
    running: { start: "2026-08-03T11:11:00+02:00", elapsed_h: 0.15, kwh: 0.1,
               typical_h: 1.5, pct: 10, over: false, ends_at: null,
               remaining_h: null, range_h: null },
    so_far: { kwh: 10, sun_kwh: 9.94, battery_kwh: 0, grid_kwh: 0.06, eur: 0.01 },
    tail: null,
  })] });
  ok(v.filas[0].relleno === "0.100", `un ciclo recién empezado (${v.filas[0].relleno})`);
  const chico = v.filas[0].barra;
  ok(chico.length === 2, `los dos tramos siguen dibujándose (${chico.length})`);
  ok(chico[1] && chico[1].pintado >= 2,
    `y el del 0,6 % se ve pese al escalado (${chico[1] && chico[1].pintado} px)`);
  // Y sin desbordar el relleno, que es lo que rompería el otro extremo: pedir
  // 20 px de mínimo dentro de un carril de 30 no puede empujar al vecino fuera.
  const sumaChica = chico.reduce((a, x) => a + x.pintado, 0);
  ok(Math.abs(sumaChica - v.filas[0].carril) < 0.6,
    `los tramos suman el relleno (${sumaChica.toFixed(2)} de ${v.filas[0].carril})`);

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
  ok(v.filas.every((f) => !f.aro), "nada en marcha, ningún aro");
  ok(!/a las \d\d:\d\d/.test(mov.sub) || /mejor \d\d:\d\d|mejor mañana \d\d:\d\d/.test(mov.sub),
    `y la hora va sin «a las», que se iba a tres líneas («${mov.sub}»)`);

  v = await abrir({ battery: null, rows: [enMarcha({})] });
  ok(v.filas[0].aro, "en marcha, el aro alrededor de su icono");
  // Y que el aro se pinta de verdad, no solo que esté el atributo: dos sombras
  // —el anillo y su brillo— y ninguna es «none».
  ok(/rgb/.test(v.filas[0].anillo || "") && v.filas[0].anillo !== "none",
    `y se dibuja (box-shadow «${(v.filas[0].anillo || "").slice(0, 46)}…»)`);
  ok(!/en marcha/i.test(v.filas[0].sub),
    `y tampoco se escribe («${v.filas[0].sub}»)`);
  ok(v.filas[0].insignia === "#i-reloj",
    "sigue siendo un movible: la insignia no cambia por estar puesto");
  // Y los de siempre encendido llevan aro también, como se pidió: una nevera está
  // en marcha, y su compresor entrando y saliendo no es encenderse y apagarse.
  v = await abrir({ battery: null, rows: [{
    id: "nev", name: "Nevera", icon: "congelador", color: "#08f",
    kind: "continuo", kind_auto: true, on: true,
    today: { kwh: 0.67, sun_kwh: 0.31, battery_kwh: 0.3, grid_kwh: 0.06, eur: 0.01 },
    verdict: { kind: "parcial", value: 0.01, sub: "46 % lo pone el sol" },
  }] });
  ok(v.filas[0].aro, "un continuo también va rodeado");
  ok(/rgb/.test(v.filas[0].anillo || ""), "y su aro se dibuja igual");

  await (await navegador).close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

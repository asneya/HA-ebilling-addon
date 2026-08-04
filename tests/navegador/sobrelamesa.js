/* «Lo que había sobre la mesa»: el óptimo del día dentro del cierre.
 *
 * El banco de Python (`optimo.py`) comprueba la cuenta con un día hecho a mano.
 * Este comprueba lo que puede romperse aquí, en la tarjeta del cierre:
 *
 *   1. la hora que habría salido mejor cuelga de la fila del aparato que ya
 *      estaba ahí, y no de una tabla nueva
 *   2. solo se dice de los que costaron de más: «ya era su mejor hueco» en cinco
 *      filas sería ruido, y el pie ya lo resume
 *   3. el pie es una **diferencia**, y en ninguna parte se afirma «lo que
 *      gastaste»: el desglose de la factura reparte la energía entre orígenes
 *      medidos y este coloca rectángulos, así que dos cifras del mismo día se
 *      contradirían
 *   3b. y la coletilla dice la verdad sobre la batería, que desde la 0.65.0 depende
 *      del día: si el reparto la vio, está dentro de la cuenta y el pie lo dice
 *   4. sin tarifa marcada se dice por qué no hay euros, en vez de inventarlos
 *   5. un día que se aprovechó no se calla: se dice que no había nada que ganar,
 *      y sin el bloque la tarjeta sigue exactamente como estaba
 *   6. nada se sale de la tarjeta, y sin errores de consola
 *
 * El cierre **solo existe después de la puesta de sol**, así que el payload se
 * inyecta: esperar a que anochezca haría que el banco pasara o no según la hora,
 * que es lo contrario de lo que se quiere saber.
 */
const { abrirNavegador, base } = require("./camino");
const BASE = base("http://127.0.0.1:8402/");
const YO = "ffbanco00000000000000000000000f";
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

/* El cierre de un día con tres ciclos: dos que se pusieron de noche y uno que
   acertó. Las cifras son las que salen del banco de Python con el fake. */
const base_cierre = () => ({
  date: "2026-08-04", sunset: "2026-08-04T21:12:00+02:00", minutes_since: 24,
  produced: 21.4, consumed: 17.8, self_pct: 71,
  in_window: { pct: 58 }, saved: null,
  appliances: [
    { id: "lavav", name: "Lavavajillas", color: "#0f7d8a", runs: 1, kwh: 2.4, pct: 12 },
    { id: "coche", name: "Coche", color: "#c74bd6", runs: 1, kwh: 1.2, pct: 0 },
    { id: "horno", name: "Horno", color: "#c9822b", runs: 1, kwh: 2.2, pct: 96 },
  ],
  best: {
    // Una casa **sin** batería: los 9,1 kWh que sobraron se vertieron enteros. Es el
    // caso en que el modelo viejo acertaba, y el que deja ver el otro por contraste.
    date: "2026-08-04", extra_eur: 0.58, sun_kwh: 21.4, free_kwh: 9.1,
    stored_kwh: 0, battery: false, battery_eur_kwh: null, movable: 3,
    rows: [
      { id: "lavav", name: "Lavavajillas", kwh: 2.4, hours: 2,
        ran_at: "2026-08-04T22:00:00+02:00", best_at: "2026-08-04T10:00:00+02:00",
        already_best: false, extra_eur: 0.39 },
      { id: "coche", name: "Coche", kwh: 1.2, hours: 1,
        ran_at: "2026-08-04T23:00:00+02:00", best_at: "2026-08-04T11:00:00+02:00",
        already_best: false, extra_eur: 0.19 },
      { id: "horno", name: "Horno", kwh: 2.2, hours: 1,
        ran_at: "2026-08-04T13:00:00+02:00", best_at: "2026-08-04T13:00:00+02:00",
        already_best: true, extra_eur: 0.0 },
    ],
  },
  tomorrow: { start: "2026-08-05T10:20:00+02:00", kwh: 8.4 },
});

async function abrir(b, cierre) {
  const ctx = await b.newContext({
    viewport: { width: 414, height: 1400 },
    extraHTTPHeaders: { "X-Remote-User-Id": YO, "X-Remote-User-Display-Name": "Banco" },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => { if (m.type() === "error") fallos.push("console: " + m.text()); });
  await p.route("**/api/live", async (ruta) => {
    const resp = await ruta.fetch();
    const cuerpo = await resp.json();
    cuerpo.close = cierre;
    await ruta.fulfill({ response: resp, json: cuerpo });
  });
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForFunction(() => {
    const el = document.querySelector("#close");
    return el && el.shadowRoot && el.shadowRoot.querySelector(".aparatos");
  }, { timeout: 20000 });
  await p.waitForTimeout(300);
  return { ctx, p };
}

const leer = (p) => p.evaluate(() => {
  const raiz = document.querySelector("#close").shadowRoot;
  const caja = raiz.querySelector(".aparatos").getBoundingClientRect();
  const filas = [...raiz.querySelectorAll(".aparatos li")].map((li) => ({
    nombre: li.querySelector(".ap-n")?.textContent.trim(),
    mejor: li.querySelector(".ap-mejor")?.textContent.replace(/\s+/g, " ").trim() || null,
    fuera: li.getBoundingClientRect().right > caja.right + 1,
    // Cuánto alto ocupa la nota: si parte en dos renglones, es que no cabe.
    altoMejor: li.querySelector(".ap-mejor")
      ? Math.round(li.querySelector(".ap-mejor").getBoundingClientRect().height) : 0,
  }));
  return {
    filas,
    pie: raiz.querySelector(".ap-pie")?.textContent.replace(/\s+/g, " ").trim() || "",
    todo: raiz.querySelector(".card").textContent.replace(/\s+/g, " "),
    scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
});

(async () => {
  const b = await abrirNavegador();

  console.log("\n1-2 · la hora mejor, colgada de la fila que ya estaba");
  let { ctx, p } = await abrir(b, base_cierre());
  let v = await leer(p);
  ok(v.filas.length === 3, `siguen las tres filas del cierre (${v.filas.length})`);
  const conMejor = v.filas.filter((f) => f.mejor);
  ok(conMejor.length === 2,
    `solo las dos que costaron de más llevan la nota (${conMejor.length})`);
  ok(/Lavavajillas/.test(v.filas[0].nombre) && /10:00/.test(v.filas[0].mejor || ""),
    `con su hora («${v.filas[0].mejor}»)`);
  ok(/0,39/.test(v.filas[0].mejor || ""), "y lo que costó de más no haberla usado");
  // La corrección del signo: una flecha arriba y «de más», nunca un «+0,39 €», que
  // se lee como dinero que entró.
  ok(/↑/.test(v.filas[0].mejor || "") && /de más/.test(v.filas[0].mejor || ""),
    `dicho como sobrecoste y no como ganancia («${v.filas[0].mejor}»)`);
  ok(!/\+\s*0,39/.test(v.filas[0].mejor || ""), "sin signo más delante del importe");
  const horno = v.filas.find((f) => /Horno/.test(f.nombre || ""));
  ok(horno && !horno.mejor,
    `el que ya estaba en su hueco no dice nada («${horno && horno.mejor}»)`);
  // La nota tiene que caber en un renglón: metida dentro del nombre partía en
  // «+0,39 €» y hasta en «€» suelto, que es de donde viene que vaya suelta.
  ok(conMejor.every((f) => f.altoMejor > 0 && f.altoMejor <= 20),
    `y cabe en un renglón (${conMejor.map((f) => f.altoMejor).join(", ")} px)`);

  console.log("\n3 · es una diferencia, no una factura");
  ok(/de más/.test(v.pie), `el pie dice lo que costó de más («${v.pie.slice(0, 58)}…»)`);
  ok(!/ahorrad/.test(v.pie), "y no lo llama ahorro, que este día ya pasó");
  ok(/0,58/.test(v.pie), "con la cifra del día");
  ok(!/(gastaste|te costó|coste del día)/i.test(v.todo),
    "y en ninguna parte de la tarjeta se afirma lo que se gastó");
  ok(/no lo que se hizo mal/.test(v.pie), "se dice que es lo que había, no un reproche");
  ok(!/batería/.test(v.pie),
    "y sin batería en el día no se la menciona, ni para decir que no está");
  await ctx.close();

  console.log("\n3b · con batería, el pie dice que está dentro");
  // El texto de antes prometía lo contrario —«la batería no entra en esta cuenta»— y
  // desde la 0.65.0 sí entra. Una coletilla que se queda vieja es peor que ninguna:
  // dice al usuario que desconfíe de una cifra que ya es buena.
  let c = base_cierre();
  c.best.battery = true;
  c.best.battery_eur_kwh = 0.2814;
  c.best.free_kwh = 1.2;
  c.best.stored_kwh = 7.9;
  ({ ctx, p } = await abrir(b, c));
  v = await leer(p);
  ok(/batería entra en esta cuenta/.test(v.pie),
    `se dice que está dentro («${v.pie.slice(-96)}»)`);
  ok(!/batería no entra/.test(v.pie), "y no queda la promesa vieja");
  ok(/una hora cualquiera/.test(v.pie), "sin perder lo que sí queda fuera");
  await ctx.close();

  console.log("\n3c · y un día con batería que se aprovechó no parece un día malo");
  // El caso que más se va a ver en una casa con batería: el sobrecoste baja de cinco
  // céntimos **porque el sol que sobraba se guardó**. Sin decirlo, «no había nada que
  // ganar» se lee como que el día salió flojo, y fue justo lo contrario.
  c = base_cierre();
  c.best.battery = true;
  c.best.free_kwh = 0;
  c.best.stored_kwh = 9.1;
  c.best.extra_eur = 0.01;
  for (const r of c.best.rows) { r.extra_eur = 0.0; r.already_best = true; }
  ({ ctx, p } = await abrir(b, c));
  v = await leer(p);
  ok(/se guardó en la batería/.test(v.pie),
    `se dice que el sol no se perdió («${v.pie.slice(-72)}»)`);
  await ctx.close();

  console.log("\n4 · sin tarifa marcada, no se inventan euros");
  c = base_cierre();
  c.best.extra_eur = null;
  for (const r of c.best.rows) r.extra_eur = null;
  ({ ctx, p } = await abrir(b, c));
  v = await leer(p);
  ok(/Marca una tarifa/.test(v.pie), `se dice por qué («${v.pie.slice(0, 56)}…»)`);
  ok(!/€/.test(v.filas.filter((f) => f.mejor).map((f) => f.mejor).join(" ")),
    "y las notas dan la hora sin euros");
  ok(v.filas.filter((f) => f.mejor).length === 2, "pero las horas siguen ahí");
  await ctx.close();

  console.log("\n5 · un día que se aprovechó");
  c = base_cierre();
  c.best.extra_eur = 0.0;
  for (const r of c.best.rows) {
    r.extra_eur = 0.0; r.already_best = true; r.best_at = r.ran_at;
  }
  ({ ctx, p } = await abrir(b, c));
  v = await leer(p);
  ok(/ni cinco céntimos menos/.test(v.pie),
    `se felicita en vez de callar («${v.pie.slice(0, 62)}…»)`);
  ok(v.filas.every((f) => !f.mejor), "y ninguna fila propone otra hora");
  await ctx.close();

  console.log("\n5b · y sin el bloque, la tarjeta sigue como estaba");
  c = base_cierre();
  delete c.best;
  ({ ctx, p } = await abrir(b, c));
  v = await leer(p);
  ok(v.filas.length === 3 && v.filas.every((f) => !f.mejor),
    "las filas del cierre no dependen del óptimo");
  ok(v.pie === "", "y no queda un pie vacío");

  console.log("\n6 · nada se sale de la tarjeta");
  ok(!v.filas.some((f) => f.fuera), "ninguna fila se sale");
  ok(!v.scrollX, "y la pantalla no gana scroll horizontal");
  await ctx.close();

  await b.close();
  console.log();
  if (fallos.length) {
    console.log(`${fallos.length} fallos`);
    [...new Set(fallos)].forEach((f) => console.log("  " + f));
    process.exit(1);
  }
  console.log("todo en verde");
})();

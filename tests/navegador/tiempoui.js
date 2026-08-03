/* La tarjeta del tiempo hora a hora en la Home.
 *
 * Cada fila pone la nubosidad **al lado** del sol previsto para esa hora: es lo
 * que convierte «70 % de nubes» en algo sobre lo que decidir, y lo que distingue
 * esta tarjeta de cualquier widget del tiempo.
 *
 *   1. sale con una fila por hora, con la hora, el icono y el sol
 *   2. el titular resume la nube media y hasta cuándo llega el día
 *   3. la barra de sol es proporcional, y la hora del pico la más alta
 *   4. el sol por debajo del kilovatio se da en vatios
 *   5. se dice de dónde sale la columna del sol, que no es del sensor
 *   6. sin nubosidad, esa columna se calla en vez de poner un cero
 *   7. sin entidad del tiempo no hay tarjeta
 *   8. es reordenable como las demás, y ocultable
 *   9. cabe a 320 px sin desbordar
 *  10. sin errores de consola
 */
const { abrirNavegador, base } = require("./camino");
const BASE = base("http://127.0.0.1:8402/");
const YO = "ffbanco00000000000000000000000f";
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

/* Abre la Home con el `weather_hours` que se le diga. `undefined` = el de verdad. */
async function abrir(b, tiempo, ancho = 414) {
  const ctx = await b.newContext({
    viewport: { width: ancho, height: 1200 },
    extraHTTPHeaders: { "X-Remote-User-Id": YO, "X-Remote-User-Display-Name": "Banco" },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => { if (m.type() === "error") fallos.push("console: " + m.text()); });
  if (tiempo !== undefined) {
    await p.route("**/api/live", async (ruta) => {
      const resp = await ruta.fetch();
      const cuerpo = await resp.json();
      cuerpo.weather_hours = tiempo;
      await ruta.fulfill({ response: resp, json: cuerpo });
    });
  }
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1800);
  return { ctx, p };
}

/* Lee la tarjeta, y con ella **las etiquetas que el propio navegador saca** de
   los ISO del payload. Escribir «11:00» a mano aquí sería atarlo al huso del
   contenedor: el CI va en UTC y un ISO con `+02:00` se pinta dos horas antes, así
   que el banco se pondría rojo por dónde corre y no por lo que hace. */
const leer = (p, esperado = null) => p.evaluate((isos) => {
  const panel = document.querySelector("#tiempo-panel");
  const hhmm = (iso) => new Date(iso).toLocaleTimeString("es-ES",
    { hour: "2-digit", minute: "2-digit" });
  return {
    esperado: isos && {
      horas: isos.horas.map(hhmm),
      hasta: hhmm(isos.hasta),
    },
    visible: panel && !panel.classList.contains("hidden"),
    aside: document.querySelector("#tiempo-aside")?.textContent.trim(),
    nota: document.querySelector("#tiempo-note")?.textContent.replace(/\s+/g, " ").trim(),
    filas: [...document.querySelectorAll("#tiempo-rows .tp-row")].map((f) => ({
      hora: f.querySelector(".tp-hora")?.textContent.trim(),
      icono: f.querySelector(".tp-icono use")?.getAttribute("href"),
      temp: f.querySelector(".tp-temp")?.textContent.trim() ?? null,
      nube: f.querySelector(".tp-nube")?.textContent.trim() ?? null,
      alto: f.querySelector(".tp-barra i")?.style.height,
      sol: f.querySelector(".tp-sol")?.textContent.trim(),
    })),
    // Lo ancho de la tarjeta contra lo ancho de su contenido: si una fila se
    // sale, se ve aquí y no hay que mirar una captura.
    desborda: !panel ? false
      : [...panel.querySelectorAll(".tp-row")].some(
        (f) => f.scrollWidth > f.clientWidth + 1),
  };
}, esperado);

/* Lo que el navegador debería escribir, sacado del mismo payload que se inyecta. */
const referencia = (d) => ({ horas: d.hours.map((h) => h.at), hasta: d.until });

/* Un payload de horas hecho a mano, para pedir los casos a propósito. */
const dia = (extra = {}) => ({
  entity: "weather.casa",
  until: "2026-08-03T19:30:00+02:00",
  peak_w: 5000,
  hours: [
    { at: "2026-08-03T11:00:00+02:00", condition: "sunny", temperature: 26.1,
      cloud_pct: 20, sun_w: 3200 },
    { at: "2026-08-03T12:00:00+02:00", condition: "partlycloudy", temperature: 27.2,
      cloud_pct: 45, sun_w: 5000 },
    { at: "2026-08-03T13:00:00+02:00", condition: "cloudy", temperature: 28.0,
      cloud_pct: 85, sun_w: 900 },
    { at: "2026-08-03T14:00:00+02:00", condition: "rainy", temperature: 24.0,
      cloud_pct: 95, sun_w: 320 },
  ],
  ...extra,
});

(async () => {
  const b = await abrirNavegador();

  console.log("\n1-2 · las filas y el titular");
  const payload = dia();
  let { ctx, p } = await abrir(b, payload);
  let v = await leer(p, referencia(payload));
  ok(v.visible, "la tarjeta se ve");
  ok(v.filas.length === 4, `una fila por hora (${v.filas.length})`);
  ok(v.filas.map((f) => f.hora).join(" ") === v.esperado.horas.join(" "),
    `con su hora (${v.filas.map((f) => f.hora).join(" ")})`);
  // El icono de cada hora es el de **su** condición, no el del tiempo de ahora.
  ok(v.filas[0].icono === "#i-solar" && v.filas[2].icono === "#i-nubes"
     && v.filas[3].icono === "#i-lluvia",
    `y su icono (${v.filas.map((f) => f.icono).join(" ")})`);
  ok(v.filas.map((f) => f.temp).join(" ") === "26,1° 27,2° 28,0° 24,0°",
    `con la temperatura de esa hora (${v.filas.map((f) => f.temp).join(" ")})`);
  // La nube media de las cuatro: (20+45+85+95)/4 = 61,25 → 61.
  ok(/61 % de nubes/.test(v.aside) && v.aside.endsWith(v.esperado.hasta),
    `el titular resume el día («${v.aside}»)`);

  console.log("\n3-4 · la barra y las cifras del sol");
  ok(v.filas[1].alto === "100%", `la hora del pico llena la barra (${v.filas[1].alto})`);
  ok(parseInt(v.filas[0].alto, 10) === 64,
    `y las demás en proporción (3.200 de 5.000 → ${v.filas[0].alto})`);
  ok(v.filas[1].sol === "5 kW" && v.filas[0].sol === "3,2 kW",
    `los kilovatios con coma (${v.filas[1].sol} · ${v.filas[0].sol})`);
  ok(v.filas[3].sol === "320 W",
    `y por debajo del kilovatio, en vatios (${v.filas[3].sol})`);
  ok(v.filas[2].nube === "85 %", `la nubosidad de cada hora (${v.filas[2].nube})`);

  console.log("\n5 · de dónde sale la columna del sol");
  ok(/con la corrección de tu tejado ya aplicada/.test(v.nota),
    "se dice que la curva no es la del sensor");
  ok(/la misma curva de la que salen la ventana y el plan/.test(v.nota),
    `y que es la misma que las otras dos tarjetas («${v.nota}»)`);
  await ctx.close();

  console.log("\n6-7 · lo que falta");
  const sinNubes = dia({ hours: dia().hours.map((h) => ({ ...h, cloud_pct: null })) });
  ({ ctx, p } = await abrir(b, sinNubes));
  v = await leer(p, referencia(sinNubes));
  ok(v.filas.every((f) => f.nube === null),
    "sin nubosidad, la columna no se dibuja");
  ok(!/nubes/.test(v.aside) && v.aside.endsWith(v.esperado.hasta),
    `y el titular tampoco la promete («${v.aside}»)`);
  ok(v.filas.every((f) => f.sol), "el sol sigue estando, que es lo que se venía a ver");
  await ctx.close();

  ({ ctx, p } = await abrir(b, null));
  v = await leer(p);
  ok(!v.visible, "sin entidad del tiempo no hay tarjeta");
  await ctx.close();

  console.log("\n8 · reordenable y ocultable, como las demás");
  ({ ctx, p } = await abrir(b, dia()));
  const sitio = await p.evaluate(() => {
    const el = document.querySelector('#home-cards [data-card="tiempo"]');
    return { existe: !!el, order: el && el.style.order };
  });
  ok(sitio.existe, "lleva su `data-card`, que es lo que la hace ordenable");
  ok(sitio.order !== "" && sitio.order !== "-1",
    `y el orden se le ha asignado (order=${sitio.order})`);
  // En el catálogo de Ajustes, que es de donde se reordena.
  await p.click('.tab[data-view="settings"]');
  await p.waitForTimeout(700);
  await p.click('[data-settings-page="home"]');
  await p.waitForTimeout(900);
  const enAjustes = await p.evaluate(() =>
    [...document.querySelectorAll("[data-card-row]")].map((el) => el.dataset.cardRow));
  ok(enAjustes.includes("tiempo"),
    `aparece en la lista de Ajustes (${enAjustes.join(", ")})`);
  await ctx.close();

  console.log("\n9 · a 320 px");
  ({ ctx, p } = await abrir(b, dia(), 320));
  v = await leer(p);
  ok(v.visible && !v.desborda, "ninguna fila se sale");
  ok(v.filas.every((f) => f.sol && f.hora),
    "la hora y el sol siguen estando, que es lo que no puede faltar");
  await ctx.close();

  await b.close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

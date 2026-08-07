/* Los sensores de previsión: poder poner los que hagan falta.
 *
 * De una queja: en la Home salía todos los días «de mañana todavía no hay
 * previsión; si tu integración publica el día siguiente en otro sensor, puedes
 * poner los dos separados por comas en Ajustes → Previsión solar». Lo primero
 * era verdad —Solcast publica hoy y mañana en sensores distintos— y lo segundo
 * era **mentira**: el servidor sabía leer una lista separada por comas, pero en
 * Ajustes había un `<select>` de una sola opción y no había forma de escribirla.
 * El aviso mandaba a un sitio donde no se podía hacer lo que decía.
 *
 * Lo que se comprueba:
 *
 *   1. el ajuste es una lista y enseña lo que hay puesto
 *   2. se puede añadir un segundo sensor, y el desplegable deja de ofrecerlo
 *   3. se puede quitar
 *   4. se guarda, y al recargar sigue estando
 *   5. con los dos puestos, la app **sabe de mañana**, que es el punto de todo
 *   6. y el aviso deja de salir
 *   7. el texto del aviso no manda a hacer nada imposible
 */
const { abrirNavegador, base } = require("./camino");
const BASE = base("http://127.0.0.1:8402/");
const HOY = "sensor.solcast_pv_forecast_today";
const MANANA = "sensor.solcast_pv_forecast_tomorrow";
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

/* El sensor de previsión es ajuste **de la casa**, así que hay que entrar como
   administrador: con un usuario cualquiera el servidor devuelve 403 y el banco
   mediría con la configuración de partida sin enterarse. El primer intento usaba
   un id inventado y salía en rojo con el arreglo puesto. */
const abrir = async (b) => {
  const ctx = await b.newContext({
    viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": "ffbanco00000000000000000000000f" },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1500);
  return { ctx, p };
};

/* Deja el ajuste como se pida, por la API, y devuelve lo que el servidor
   entiende de mañana. `tomorrow_forecast` es lo que la tarjeta usa para decidir
   entre «mañana no sobra» y «de mañana no se sabe». */
const conSensores = (p, lista) => p.evaluate(async (ids) => {
  await fetch("api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ solar_forecast_sensor: ids.join(",") }),
  });
  const r = await fetch("api/live").then((x) => x.json());
  const w = r.window || {};
  return { sabido: w.tomorrow_forecast,
           // `tomorrow` es una ventana entera o `null` si ese día no sobra nada.
           manana: w.tomorrow ? w.tomorrow.kwh : null };
}, lista);

const irAPrevision = async (p) => {
  await p.evaluate(() => document.querySelector('.tab[data-view="settings"]').click());
  await p.waitForTimeout(2200);
  await p.evaluate(() => {
    const b = [...document.querySelectorAll(".nav-row")]
      .find((x) => /previsi[óo]n/i.test(x.textContent));
    if (b) b.click();
  });
  await p.waitForTimeout(1200);
};

const leerLista = (p) => p.evaluate(() => ({
  filas: [...document.querySelectorAll("#s-forecast-list .fc-fila small")]
    .map((e) => e.textContent.trim()),
  ofrece: [...document.querySelectorAll("#s-forecast-add option")]
    .map((o) => o.value).filter(Boolean),
  vacio: !!document.querySelector(".fc-vacio"),
}));

(async () => {
  const nav = await abrirNavegador();
  const { ctx, p } = await abrir(nav);

  console.log("\n1 · el ajuste es una lista");
  await conSensores(p, [HOY]);
  await p.reload();
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1500);
  await irAPrevision(p);
  let v = await leerLista(p);
  ok(v.filas.length === 1 && v.filas[0] === HOY,
    `enseña el sensor que hay puesto (${v.filas.join(", ") || "ninguno"})`);
  ok(!v.ofrece.includes(HOY),
    "y el desplegable de añadir no vuelve a ofrecer el que ya está");
  ok(v.ofrece.includes(MANANA),
    `pero sí ofrece el de mañana, que es el que faltaba (${v.ofrece.length} libres)`);

  console.log("\n2-4 · añadir, quitar y guardar");
  await p.selectOption("#s-forecast-add", MANANA);
  await p.waitForTimeout(500);
  v = await leerLista(p);
  ok(v.filas.length === 2 && v.filas.includes(MANANA),
    `se añade el segundo (${v.filas.join(", ")})`);
  ok(!v.ofrece.includes(MANANA), "y deja de ofrecerse");
  // Quitar el primero y volver a ponerlo, para probar el botón de quitar.
  await p.evaluate(() => document.querySelector("#s-forecast-list [data-quitar]").click());
  await p.waitForTimeout(400);
  v = await leerLista(p);
  ok(v.filas.length === 1, `quitar quita uno solo (${v.filas.join(", ")})`);
  await p.selectOption("#s-forecast-add", HOY);
  await p.waitForTimeout(400);
  // Guardar de verdad y recargar: lo que importa es que sobreviva al fichero.
  await p.evaluate(() => document.querySelector("#save-settings-btn").click());
  await p.waitForTimeout(2500);
  await p.reload();
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1500);
  await irAPrevision(p);
  v = await leerLista(p);
  ok(v.filas.length === 2 && v.filas.includes(HOY) && v.filas.includes(MANANA),
    `y los dos siguen ahí tras recargar (${v.filas.join(", ")})`);

  console.log("\n5-6 · y con los dos, la app sabe de mañana");
  // Este es el punto de todo: con un solo sensor de hoy, de mañana no se sabe
  // nada; con los dos, sí. Si el ajuste no supiera guardar la lista, esto no
  // cambiaría al añadir el segundo.
  const solo = await conSensores(p, [HOY]);
  ok(solo.sabido === false,
    `con solo el de hoy, de mañana no se sabe (tomorrow_forecast=${solo.sabido})`);
  const ambos = await conSensores(p, [HOY, MANANA]);
  ok(ambos.sabido === true,
    `con los dos, sí se sabe (tomorrow_forecast=${ambos.sabido})`);
  ok(typeof ambos.manana === "number",
    `y una ventana de excedente para mañana (${ambos.manana} kWh)`);

  // Y el aviso: con los dos puestos no puede seguir saliendo.
  await p.reload();
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(2500);
  const aviso = await p.evaluate(() => {
    const w = document.querySelector("vatia-window");
    return w ? (w.shadowRoot || w).textContent : "";
  });
  ok(!/todav[íi]a no hay previsi[óo]n/i.test(aviso),
    "el aviso de «de mañana todavía no hay previsión» deja de salir");

  console.log("\n7 · y el texto no manda a hacer nada imposible");
  // El aviso decía «separados por comas», que era justo lo que no se podía
  // hacer. Si alguien lo devuelve a esa redacción, esto lo caza.
  const fuente = await p.evaluate(() =>
    fetch("static/components/vatia-window.js").then((r) => r.text()));
  ok(!/separados por comas/.test(fuente),
    "no se manda a escribir una lista separada por comas, que no hay dónde");
  ok(/Ajustes → Previsión solar/.test(fuente),
    "pero se sigue diciendo adónde ir");

  // Se deja el ajuste como estaba: esto escribe en la configuración de la casa
  // y detrás de este banco corren otros con la misma instancia.
  await conSensores(p, ["sensor.solcast_pv_forecast"]);

  await ctx.close();
  await nav.close();
  console.log(fallos.length ? `\n--- fallos ---\n  ${fallos.join("\n  ")}\n\n${
    fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

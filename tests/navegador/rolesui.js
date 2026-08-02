/* La cara de los permisos: qué ve cada uno en Ajustes.
 *
 *   1. quien administra ve el índice entero, incluida la sección de Usuarios
 *   2. quien no, solo Apariencia y Acerca de
 *   3. y una nota que explica por qué falta lo demás, en vez de un hueco
 *   4. la sección de Usuarios lista a quien ha entrado, con su rol
 *   5. el interruptor nombra administrador y se nota en el acto
 *   6. el último administrador tiene el interruptor bloqueado
 *   7. quien no administra sí puede cambiar su tema, y solo el suyo
 *   8. sin errores de consola
 */
const { abrirNavegador, base, ficheros } = require("./camino");
const BASE = base("http://127.0.0.1:8412/");
const ANA = "aa11111111111111111111111111111a";
const LUIS = "bb22222222222222222222222222222b";
const fallos = [];
const ok = (c, t) => { if (!c) fallos.push(t); console.log((c ? "  ok    " : "  FALLA ") + t); };

const abrir = async (b, quien, nombre) => {
  const ctx = await b.newContext({
    viewport: { width: 414, height: 900 },
    extraHTTPHeaders: { "X-Remote-User-Id": quien, "X-Remote-User-Display-Name": nombre },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => fallos.push("pageerror: " + e));
  p.on("console", (m) => { if (m.type() === "error") fallos.push("console: " + m.text()); });
  await p.goto(BASE);
  await p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await p.waitForTimeout(1200);
  await p.click('.tab[data-view="settings"]');
  await p.waitForTimeout(900);
  return { ctx, p };
};

/* Lo que de verdad se ve del índice, no lo que hay en el DOM. */
const visibles = (p) => p.evaluate(() =>
  [...document.querySelectorAll("#sp-root [data-settings-page]")]
    .filter((el) => el.offsetParent !== null)
    .map((el) => el.dataset.settingsPage));

(async () => {
  const b = await abrirNavegador();

  // Se parte de Ana administradora y Luis sin permisos.
  const set = await b.newContext({ extraHTTPHeaders: { "X-Remote-User-Id": ANA } });
  await set.request.get(BASE + "api/config");
  await set.request.put(BASE + `api/users/${LUIS}/role`, { data: { role: "viewer" } });
  await set.close();

  console.log("\n1 · quien administra");
  const a = await abrir(b, ANA, "Ana");
  const vAna = await visibles(a.p);
  ok(vAna.includes("users"), `ve la sección de Usuarios (${vAna.length} secciones)`);
  ok(vAna.includes("sensors") && vAna.includes("tariffs") && vAna.includes("influx"),
    "y las de la casa: sensores, tarifas, InfluxDB");
  ok(!(await a.p.isVisible("#ajustes-mirador")), "sin la nota de «esto es lo tuyo»");

  console.log("\n2-3 · quien no");
  const l = await abrir(b, LUIS, "Luis");
  const vLuis = await visibles(l.p);
  ok(!vLuis.includes("users"), "no ve la sección de Usuarios");
  ok(!vLuis.some((s) => ["sensors", "tariffs", "influx", "source", "backup", "diagnostics",
    "appliances", "contract", "forecast", "weather", "publish"].includes(s)),
    `ni nada de la casa (${vLuis.join(", ") || "nada"})`);
  ok(vLuis.includes("home") && vLuis.includes("flows") && vLuis.includes("about"),
    `pero sí lo suyo y el acerca de (${vLuis.join(", ")})`);
  ok(await l.p.isVisible("#ajustes-mirador"), "con la nota que explica por qué falta lo demás");
  ok(await l.p.isVisible("#theme-seg"), "y el tema, que es suyo");
  const sub = await l.p.textContent("#ajustes-sub");
  ok(!/sensores|facturación/i.test(sub), `y el subtítulo no promete lo que no hay («${sub}»)`);
  // Un rótulo de grupo sin nada debajo sería peor que esconder los dos.
  const rotulos = await l.p.evaluate(() =>
    [...document.querySelectorAll("#sp-root .group-label")]
      .filter((el) => el.offsetParent !== null).map((el) => el.textContent.trim()));
  ok(!rotulos.some((r) => ["Datos", "Sensores", "Facturación", "Integración", "Usuarios"].includes(r)),
    `sin rótulos huérfanos (${rotulos.join(", ")})`);

  console.log("\n7 · su tema es suyo");
  // Ana se pone el claro primero: si no, el tema de la casa ya viene en oscuro
  // y que Luis lo ponga en oscuro no demuestra nada.
  await a.p.click('[data-theme-opt="light"]');
  await a.p.waitForTimeout(1200);
  await l.p.click('[data-theme-opt="dark"]');
  await l.p.waitForTimeout(1200);
  const temaLuis = await l.p.evaluate(() => document.documentElement.dataset.theme);
  ok(temaLuis === "dark", `Luis se pone el oscuro (${temaLuis})`);
  await a.p.reload();
  await a.p.waitForFunction(() => !document.querySelector("#boot"), { timeout: 25000 });
  await a.p.waitForTimeout(1200);
  const temaAna = await a.p.evaluate(() => document.documentElement.dataset.theme);
  ok(temaAna === "light", `y a Ana le sigue el claro (${temaAna})`);

  console.log("\n4-6 · la sección de Usuarios");
  await a.p.click('.tab[data-view="settings"]');
  await a.p.waitForTimeout(700);
  await a.p.click('[data-settings-page="users"]');
  await a.p.waitForTimeout(1200);
  const filas = await a.p.evaluate(() =>
    [...document.querySelectorAll("#users-list [data-user]")].map((li) => ({
      texto: li.querySelector(".card-txt").textContent.replace(/\s+/g, " ").trim(),
      admin: li.querySelector("[data-user-admin]").checked,
      bloqueado: li.querySelector("[data-user-admin]").disabled,
    })));
  ok(filas.length >= 2, `están los dos (${filas.length})`);
  const fAna = filas.find((f) => /Ana/.test(f.texto));
  const fLuis = filas.find((f) => /Luis/.test(f.texto));
  ok(!!fAna && fAna.admin, `Ana sale como administradora (${fAna?.texto})`);
  ok(!!fLuis && !fLuis.admin, `y Luis como mirón (${fLuis?.texto})`);
  ok(/tú/.test(fAna?.texto || ""), "y se distingue cuál eres tú");
  ok(fAna.bloqueado, "la única administradora tiene el interruptor bloqueado");
  ok(/único administrador/.test(fAna.texto), "y se dice por qué");
  ok(/hoy a las/.test(fLuis.texto), `con cuándo se le vio (${fLuis.texto.slice(-24)})`);
  ok(/opciones del add-on/.test(await a.p.textContent("#users-welcome")),
    "y dónde se cambia el rol de bienvenida");
  ok(!(await a.p.isVisible("#settings-save-bar")),
    "sin barra de guardar: el interruptor se guarda solo");

  console.log("\n5 · nombrar administrador");
  await a.p.click('[data-user="' + LUIS + '"] [data-user-admin]');
  await a.p.waitForTimeout(1500);
  const tras = await a.p.evaluate((id) => {
    const li = document.querySelector(`[data-user="${id}"]`);
    return { admin: li.querySelector("[data-user-admin]").checked,
             texto: li.querySelector(".card-txt").textContent.replace(/\s+/g, " ").trim() };
  }, LUIS);
  ok(tras.admin && /Administrador/.test(tras.texto), `Luis pasa a administrador (${tras.texto})`);
  const desbloqueada = await a.p.evaluate((id) =>
    !document.querySelector(`[data-user="${id}"] [data-user-admin]`).disabled, ANA);
  ok(desbloqueada, "y ahora Ana sí se puede degradar, que ya hay dos");

  // Se deja como estaba.
  await a.p.click('[data-user="' + LUIS + '"] [data-user-admin]');
  await a.p.waitForTimeout(1200);

  await b.close();
  if (fallos.length) { console.log("\n--- fallos ---"); [...new Set(fallos)].forEach((f) => console.log("  " + f)); }
  console.log(fallos.length ? `\n${fallos.length} fallos` : "\ntodo en verde");
  process.exit(fallos.length ? 1 : 0);
})();

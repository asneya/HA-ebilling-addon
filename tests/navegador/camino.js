/* Dónde está el navegador y contra qué instancia va el banco.
 *
 * Playwright resuelve solo el Chromium que se descarga con él, pero solo si la
 * versión del paquete y la del navegador casan. En una máquina donde el
 * navegador viene preinstalado —contenedores de desarrollo— rara vez casan, y
 * el error que da («Executable doesn't exist at …chromium_headless_shell-1228»)
 * no ayuda nada. Así que se busca:
 *
 *   1. lo que diga `VATIA_CHROMIUM`, para poder forzarlo;
 *   2. cualquier Chromium que haya bajo `PLAYWRIGHT_BROWSERS_PATH`, que es el
 *      caso del contenedor de desarrollo;
 *   3. y si no hay ninguno, lo que Playwright decida —que es lo correcto en el
 *      CI, donde el navegador se instala con la versión que toca.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

function ejecutable() {
  if (process.env.VATIA_CHROMIUM) return process.env.VATIA_CHROMIUM;
  const raiz = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!raiz || !fs.existsSync(raiz)) return undefined;
  const candidatos = fs
    .readdirSync(raiz)
    .filter((n) => n.startsWith("chromium-"))
    .map((n) => path.join(raiz, n, "chrome-linux", "chrome"))
    .filter((p) => fs.existsSync(p));
  return candidatos.sort().pop();
}

/* Un Chromium listo, con la misma resolución para todos los bancos. */
async function abrirNavegador(opciones = {}) {
  const exe = ejecutable();
  return chromium.launch({ ...(exe ? { executablePath: exe } : {}), ...opciones });
}

/* La instancia de la app contra la que va el banco. La pone el lanzador; el
   valor por defecto es para lanzar un banco suelto a mano. */
function base(porDefecto = "http://127.0.0.1:8402/") {
  const url = process.argv[2] || process.env.VATIA_BASE || porDefecto;
  return url.endsWith("/") ? url : url + "/";
}

/* El servidor de ficheros de los bancos que cargan un HTML propio. */
function ficheros() {
  return (process.env.VATIA_FICHEROS || "http://127.0.0.1:8320").replace(/\/$/, "");
}

/* Dónde dejar las capturas. Algunos bancos fotografían la pantalla además de
   comprobarla, que es como se revisan los dos temas de un vistazo. Van a un
   directorio ignorado por git: son útiles al mirarlas y no hay por qué
   guardarlas en el repositorio ni subirlas en cada ejecución del CI. */
function capturas() {
  const dir = process.env.VATIA_CAPTURAS
    || path.join(__dirname, "..", ".reg", "capturas");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { abrirNavegador, base, ficheros, capturas, chromium };

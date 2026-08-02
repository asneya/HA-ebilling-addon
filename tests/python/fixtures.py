"""Las fixtures del banco están versionadas y no llevan secretos.

Dos comprobaciones que parecen de perogrullo y que existen porque las dos han
fallado.

**Versionadas.** El `.gitignore` de la raíz ignora `vatia.json` y
`pvpc_cache.json` a propósito: es la configuración del add-on y lleva el token
de Home Assistant en claro, así que no puede colarse en un commit por un
`git add -A` despistado. El efecto secundario es que se tragó **14 de los 22
ficheros de fixture** sin decir nada. En local no se nota —los ficheros están en
disco— y en el CI, con un checkout limpio, la aplicación arrancaba sin
configuración y todo devolvía 502. Cinco ejecuciones en rojo.

Que un fichero exista en `tests/fixtures/` no significa que llegue a nadie más.
Lo que cuenta es si está en el índice de git.

**Sin secretos.** Y como la excepción del `.gitignore` desarma ahí la red de
seguridad, hay que poner otra: si alguien copia su configuración de verdad a una
fixture, esto tiene que gritar antes del commit y no después de publicarlo.

  1. todo lo que hay en `tests/fixtures/` está versionado
  2. y todo lo versionado sigue en disco
  3. las fixtures son JSON válido
  4. los tokens y contraseñas son de adorno
  5. las URLs apuntan a la máquina local, no a una casa de verdad
"""
import json
import re
import subprocess
import sys

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)

FIX = camino.TESTS / "fixtures"
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


def git(*args):
    return subprocess.run(["git", *args], cwd=camino.RAIZ,
                          capture_output=True, text=True).stdout.splitlines()


print("1-2 · versionadas")
en_disco = {p.relative_to(camino.RAIZ).as_posix()
            for p in FIX.rglob("*") if p.is_file()}
en_git = set(git("ls-files", "tests/fixtures"))

sin_versionar = sorted(en_disco - en_git)
ok(not sin_versionar,
   f"todo lo de tests/fixtures está en git ({len(en_git)} de {len(en_disco)})"
   + (f" · faltan: {sin_versionar}" if sin_versionar else ""))

# Y al revés: un fichero versionado que ya no está en disco deja una fixture
# incompleta en cuanto alguien clone.
fantasmas = sorted(en_git - en_disco)
ok(not fantasmas, f"y todo lo de git sigue en disco{' · sobran: ' + str(fantasmas) if fantasmas else ''}")

# El `.gitignore` es la causa conocida, así que se pregunta directamente.
ignorados = [f for f in sorted(en_disco)
             if subprocess.run(["git", "check-ignore", "-q", f], cwd=camino.RAIZ).returncode == 0]
ok(not ignorados, f"y el .gitignore no se traga ninguna{' · ' + str(ignorados) if ignorados else ''}")

print("\n3 · JSON válido")
malos = []
for f in sorted(FIX.rglob("*.json")):
    try:
        json.loads(f.read_text())
    except ValueError as err:
        malos.append(f"{f.name}: {err}")
ok(not malos, f"las {len(list(FIX.rglob('*.json')))} fixtures se leen{' · ' + str(malos) if malos else ''}")

print("\n4-5 · sin secretos")
# Se busca por **forma del valor** y no por nombre de clave. Mirar solo las
# claves que se llamen `token` o `password` deja pasar un secreto guardado en
# cualquier otro sitio, y aquí la red de seguridad del `.gitignore` está
# desarmada a propósito: si algo se cuela, se cuela hasta un repositorio
# público.
#
# La regla de fondo: en una fixture **no hay ningún motivo** para que aparezca
# una cadena larga y aleatoria, ni una máquina que no sea la local. Todo lo que
# tiene que haber son marcadores de una letra y `127.0.0.1`.
SEGURAS = (
    re.compile(r"^sensor\.[a-z0-9_]+$"),          # entidades de mentira
    re.compile(r"^#[0-9a-f]{6}$", re.I),          # colores
    re.compile(r"^\d{4}-\d\d-\d\dT[\d:+.-]+$"),   # marcas de tiempo
    re.compile(r"^[0-9a-f]{32}$"),                # ids de usuario del banco
    re.compile(r"^a0d7b954-[a-z]+$"),             # nombre de un add-on de HA
)
SOSPECHOSAS = (
    (re.compile(r"eyJ[A-Za-z0-9_-]{8,}\."), "parece un JWT"),
    (re.compile(r"^[A-Za-z0-9+/]{40,}={0,2}$"), "parece base64 largo"),
    (re.compile(r"^[0-9a-f]{40,}$", re.I), "parece una clave hexadecimal"),
    (re.compile(r"\b(?:192\.168|10\.\d+|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+"),
     "es una IP de una red doméstica"),
)
HOSTS_OK = ("127.0.0.1", "localhost", "::1")

sospechosos, fuera = [], []
for f in sorted(FIX.rglob("*.json")):
    crudo = f.read_text()
    for valor in re.findall(r'"([^"\\]{6,})"', crudo):
        if any(p.match(valor) for p in SEGURAS):
            continue
        for patron, por_que in SOSPECHOSAS:
            if patron.search(valor):
                sospechosos.append(f"{f.parent.name}/{f.name}: «{valor[:24]}…» {por_que}")
                break
    for host in re.findall(r'"https?://([^"/:]+)', crudo):
        if host not in HOSTS_OK and not host.startswith("a0d7b954-"):
            fuera.append(f"{f.parent.name}/{f.name}: {host}")

ok(not sospechosos,
   "nada con forma de credencial de verdad"
   + ("" if not sospechosos else " · " + "; ".join(dict.fromkeys(sospechosos))))
ok(not fuera,
   "y ninguna URL sale de la máquina local"
   + ("" if not fuera else " · " + "; ".join(dict.fromkeys(fuera))))

# Y que el guardián sirva de algo: se le enseña un token con la pinta que tiene
# uno de verdad y tiene que reconocerlo. Un detector que nunca ha detectado nada
# no ha demostrado que detecte.
TOKEN_FALSO = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
               "eyJpc3MiOiJhYmMxMjMiLCJpYXQiOjE3MDAwMDAwMDB9.xxxxxxxxxxxxxxx")
ok(any(p.search(TOKEN_FALSO) for p, _ in SOSPECHOSAS),
   "y reconoce un token de Home Assistant si se le pone delante")
ok(any(p.search("http://192.168.1.40:8123") for p, _ in SOSPECHOSAS),
   "y la IP de un Home Assistant de una casa de verdad")

print()
if fallos:
    print("--- fallos ---")
    for f in dict.fromkeys(fallos):
        print("  " + f)
print(f"{len(fallos)} fallos" if fallos else "todo en verde")
sys.exit(1 if fallos else 0)

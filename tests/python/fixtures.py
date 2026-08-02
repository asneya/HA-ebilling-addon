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
# Un token de Home Assistant es un JWT largo; una contraseña de verdad rara vez
# tiene una sola letra. Se busca cualquier cosa que no parezca de adorno.
ADORNO = {"", "x", "t", "p", "test", "token", "secret", "abc", "123", "-"}
sospechosos, fuera = [], []
for f in sorted(FIX.rglob("*.json")):
    crudo = f.read_text()
    for clave, valor in re.findall(r'"(\w*(?:token|password|api_key|secret)\w*)"\s*:\s*"([^"]*)"',
                                   crudo, re.I):
        if valor.lower() not in ADORNO and len(valor) > 8:
            sospechosos.append(f"{f.name}:{clave}={valor[:12]}…")
    for url in re.findall(r'"https?://([^"/:]+)', crudo):
        if url not in ("127.0.0.1", "localhost") and not url.startswith("a0d7b954-"):
            fuera.append(f"{f.name}: {url}")

ok(not sospechosos,
   f"ningún token ni contraseña con pinta de real{' · ' + str(sospechosos) if sospechosos else ''}")
ok(not fuera,
   f"y ninguna URL apunta fuera de la máquina{' · ' + str(fuera) if fuera else ''}")

print()
if fallos:
    print("--- fallos ---")
    for f in dict.fromkeys(fallos):
        print("  " + f)
print(f"{len(fallos)} fallos" if fallos else "todo en verde")
sys.exit(1 if fallos else 0)

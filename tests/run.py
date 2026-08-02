#!/usr/bin/env python3
"""Levanta el banco entero y pasa la regresión.

    python3 tests/run.py              # todo
    python3 tests/run.py resumen      # solo los que se llamen así
    python3 tests/run.py --solo-python

Qué hace, por orden:

1. **Copia las fixtures a un directorio de trabajo.** Los bancos escriben en la
   configuración —crean usuarios, cambian roles, guardan sesgos—, así que si
   apuntaran a `tests/fixtures/` ensuciarían el repositorio y la segunda vuelta
   no daría lo mismo que la primera. Copiándolas, cada ejecución empieza igual.
2. Levanta los Home Assistant e InfluxDB de mentira, un servidor de ficheros
   para los bancos que cargan su propia página, y una instancia de la app por
   cada configuración de partida.
3. Pasa los bancos y recoge la última línea de cada uno, que es su veredicto.
   La salida completa queda en `tests/.reg/<banco>.log`: con solo el veredicto,
   un rojo intermitente no hay manera de diagnosticarlo sin volver a provocarlo.
4. Mata todo lo que ha levantado, pase lo que pase.

Los puertos están fijos y escritos aquí. Es lo que esperan los bancos por
defecto, así que uno suelto se puede lanzar a mano mientras se trabaja en él sin
tener que pasarle nada.
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
TESTS = RAIZ / "tests"
APP = RAIZ / "vatia" / "app"
LOGS = TESTS / ".reg"

# Home Assistant e InfluxDB de mentira: puerto → módulo en `falsos/`.
FALSOS = {
    8132: "fakeha14",
    8133: "fakeha15",
    8134: "fakeha-sinstats",
    8186: "fakeinflux",
    8187: "fakeinflux3",
}

# Instancias de la app: puerto → fixture de la que arranca.
INSTANCIAS = {
    8300: "r8300",
    8306: "r8306",
    8321: "captura",
    8363: "sinstats",
    8402: "aparatos",
    8404: "users",
    8408: "sesgo",
    8412: "roles",
}

# El servidor de ficheros de los bancos que cargan una página propia.
PUERTO_FICHEROS = 8320

# (nombre, comando, entorno). El entorno se completa con el directorio de
# trabajo, que no se conoce hasta que se copia la fixture.
PYTHON = [
    ("addon.py", ["addon.py"], {}),
    ("modulos.py", ["modulos.py"], {}),
    ("barra.py", ["barra.py"], {}),
    ("forma.py", ["forma.py"], {}),
    ("sesgo.py", ["sesgo.py"], {}),
    ("plan.py", ["plan.py"], {}),
    ("resumen.py", ["resumen.py"], {"VATIA_BASE": "http://127.0.0.1:8402"}),
    ("importada.py", ["importada.py"], {"VATIA_BASE": "http://127.0.0.1:8402"}),
    ("unificar.py", ["unificar.py"], {}),
    ("ciclos.py", ["ciclos.py"], {}),
    ("facturaifx.py", ["facturaifx.py"], {}),
    ("perfil.py", ["perfil.py"], {}),
    ("diagapi.py", ["diagapi.py", "http://127.0.0.1:8363"], {}),
    ("usuarios.py", ["usuarios.py"],
     {"VATIA_BASE": "http://127.0.0.1:8404", "VATIA_CONFIG": "{trabajo}/users/vatia.json"}),
    ("neg.py", ["neg.py"], {"VATIA_BASE": "http://127.0.0.1:8402"}),
    ("roles.py", ["roles.py"],
     {"VATIA_BASE": "http://127.0.0.1:8412", "VATIA_CONFIG": "{trabajo}/roles/vatia.json"}),
    ("sesgoapi.py", ["sesgoapi.py"],
     {"VATIA_BASE": "http://127.0.0.1:8408", "VATIA_CONFIG": "{trabajo}/sesgo"}),
]

NAVEGADOR = [
    ("forma.js", ["forma.js"], {}),
    ("cinta.js", ["cinta.js"], {}),
    ("tarjetas.js", ["tarjetas.js", "http://127.0.0.1:8404/"], {}),
    ("pulsado.js", ["pulsado.js", "http://127.0.0.1:8402/"], {}),
    ("reparto.js", ["reparto.js", "http://127.0.0.1:8402/"], {}),
    ("rolesui.js", ["rolesui.js", "http://127.0.0.1:8412/"], {}),
    ("gal.js", ["gal.js", "http://127.0.0.1:8300/"], {}),
    ("cruz.js", ["cruz.js", "http://127.0.0.1:8306/"], {}),
]

# Un banco que acaba bien lo dice en su última línea. Cada uno lo dice a su
# manera porque cada uno cuenta una cosa distinta, y forzarlos a todos a la
# misma frase les quitaría lo que tienen de legibles.
VEREDICTOS_BUENOS = ("todo en verde", "ni un negativo", "errores: ninguno")

procesos: list[subprocess.Popen] = []


def responde(puerto: int, espera: float = 0.4) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", puerto), timeout=espera):
            return True
    except OSError:
        return False


def esperar(puertos, limite: float = 45.0) -> list[int]:
    """Espera a que todos escuchen. Devuelve los que no lo hicieron."""
    fin = time.monotonic() + limite
    pendientes = list(puertos)
    while pendientes and time.monotonic() < fin:
        pendientes = [p for p in pendientes if not responde(p)]
        if pendientes:
            time.sleep(0.5)
    return pendientes


def lanzar(cmd, cwd, entorno, log: Path) -> subprocess.Popen:
    log.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        cmd, cwd=cwd, env={**os.environ, **entorno},
        stdout=log.open("w"), stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    procesos.append(proc)
    return proc


def apagar() -> None:
    for proc in procesos:
        if proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except OSError:
                pass
    fin = time.monotonic() + 5
    for proc in procesos:
        try:
            proc.wait(timeout=max(0.1, fin - time.monotonic()))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except OSError:
                pass


def preparar_trabajo() -> Path:
    """Copia las fixtures a un directorio de usar y tirar."""
    trabajo = Path(tempfile.mkdtemp(prefix="vatia-banco-"))
    for origen in sorted((TESTS / "fixtures").iterdir()):
        if origen.is_dir():
            shutil.copytree(origen, trabajo / origen.name)
    return trabajo


def levantar(trabajo: Path) -> bool:
    LOGS.mkdir(parents=True, exist_ok=True)

    for puerto, modulo in FALSOS.items():
        if not responde(puerto):
            lanzar([sys.executable, f"{modulo}.py"], TESTS / "falsos", {},
                   LOGS / f"falso-{puerto}.log")

    if not responde(PUERTO_FICHEROS):
        lanzar([sys.executable, "-m", "http.server", str(PUERTO_FICHEROS),
                "--bind", "127.0.0.1"], TESTS / "navegador", {},
               LOGS / f"ficheros-{PUERTO_FICHEROS}.log")

    for puerto, fixture in INSTANCIAS.items():
        carpeta = trabajo / fixture
        lanzar(
            [sys.executable, "-m", "uvicorn", "main:app", "--app-dir", str(APP),
             "--host", "127.0.0.1", "--port", str(puerto)],
            TESTS,
            {"CONFIG_DIR": str(carpeta), "DATA_DIR": str(carpeta),
             "PYTHONPATH": str(APP)},
            LOGS / f"app-{puerto}.log",
        )

    todos = [*FALSOS, PUERTO_FICHEROS, *INSTANCIAS]
    if caidos := esperar(todos):
        print(f"No levantaron los puertos {caidos}. Mira {LOGS}/", file=sys.stderr)
        return False
    return True


def pasar(nombre, cmd, entorno, carpeta, trabajo, tiempo) -> bool:
    print(f"{nombre:<16} ", end="", flush=True)
    log = LOGS / f"{nombre}.log"
    entorno = {k: v.format(trabajo=trabajo) for k, v in entorno.items()}
    binario = [sys.executable] if nombre.endswith(".py") else ["node"]
    try:
        salida = subprocess.run(
            binario + cmd, cwd=carpeta, env={**os.environ, **entorno},
            capture_output=True, text=True, timeout=tiempo,
        ).stdout
    except subprocess.TimeoutExpired as err:
        salida = (err.stdout or b"").decode() + f"\n(se pasó de {tiempo} s)"
    log.write_text(salida)
    ultima = (salida.strip().splitlines() or ["(sin salida)"])[-1].strip()
    bien = any(ultima.endswith(v) for v in VEREDICTOS_BUENOS)
    print(ultima if bien else f"{ultima}\n{'':<16} → {log}")
    return bien


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("filtro", nargs="*", help="pasar solo los bancos que contengan esto")
    ap.add_argument("--solo-python", action="store_true")
    ap.add_argument("--solo-navegador", action="store_true")
    ap.add_argument("--tiempo", type=int, default=420, help="límite por banco, en segundos")
    args = ap.parse_args()

    tandas = []
    if not args.solo_navegador:
        tandas.append(("python", TESTS / "python", PYTHON))
    if not args.solo_python:
        tandas.append(("navegador", TESTS / "navegador", NAVEGADOR))

    def quiere(nombre: str) -> bool:
        return not args.filtro or any(f in nombre for f in args.filtro)

    trabajo = preparar_trabajo()
    rojos = []
    try:
        if not levantar(trabajo):
            return 2
        for titulo, carpeta, bancos in tandas:
            elegidos = [b for b in bancos if quiere(b[0])]
            if not elegidos:
                continue
            print(f"== {titulo} ==")
            for nombre, cmd, entorno in elegidos:
                if not pasar(nombre, cmd, entorno, carpeta, trabajo, args.tiempo):
                    rojos.append(nombre)
            print()
    finally:
        apagar()
        shutil.rmtree(trabajo, ignore_errors=True)

    if rojos:
        print(f"{len(rojos)} en rojo: {', '.join(rojos)}")
        return 1
    print("REGRESIÓN EN VERDE")
    return 0


if __name__ == "__main__":
    sys.exit(main())

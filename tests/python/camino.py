"""Dónde está todo, calculado y no escrito a mano.

Los bancos nacieron en un directorio temporal con las rutas puestas a pelo. Al
traerlos al repositorio hay que quitarlas: valían en una máquina y en ninguna
otra, y el CI es precisamente otra.

Se importa antes que nada, porque además de decir dónde están las cosas deja
`vatia/app` en el `sys.path` para que los bancos puedan hacer `import series`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# tests/python/camino.py → tests/python → tests → raíz
RAIZ = Path(__file__).resolve().parent.parent.parent
ADDON = RAIZ / "vatia"
APP = ADDON / "app"
CONFIG_YAML = ADDON / "config.yaml"
TESTS = RAIZ / "tests"
FALSOS = TESTS / "falsos"
FIXTURES = TESTS / "fixtures"

if str(APP) not in sys.path:
    sys.path.insert(0, str(APP))


def base(por_defecto: str = "") -> str:
    """URL de la instancia de la app contra la que va el banco.

    La pone el lanzador en `VATIA_BASE`. El valor por defecto es para poder
    lanzar un banco suelto a mano mientras se trabaja en él.
    """
    return (os.environ.get("VATIA_BASE") or por_defecto).rstrip("/")

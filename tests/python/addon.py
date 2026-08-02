"""El `config.yaml` del add-on, comprobado antes de que lo vea el Supervisor.

Este fichero solo falla al instalar, y entonces el add-on no arranca y el error
sale en el log del Supervisor, no aquí. Vale la pena mirarlo desde el banco.

  1. es YAML válido y la versión es una cadena, no un número
  2. las claves son de las que entiende el Supervisor
  3. Ingress está puesto, que es de lo que depende todo
  4. el panel se ve también sin ser administrador
  5. y `panel_admin` es un booleano de verdad, no la cadena «false»
  6. la versión sube respecto a la anterior del changelog
"""
import re
import sys

import yaml

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)

RAIZ = str(camino.ADDON)
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


with open(f"{RAIZ}/config.yaml", encoding="utf-8") as fh:
    crudo = fh.read()
c = yaml.safe_load(crudo)

print("1-2 · el fichero")
ok(isinstance(c, dict), "es un mapa YAML")
ok(isinstance(c.get("version"), str),
   f"la versión es cadena ({c.get('version')!r}) — sin comillas, «0.44» sería 0.44 float")
# Las que valida `supervisor/apps/validate.py`. Una clave mal escrita no da
# error: el Supervisor la ignora y el add-on se comporta como si no estuviera.
CONOCIDAS = {
    "name", "version", "slug", "description", "url", "arch", "init", "startup",
    "boot", "ingress", "ingress_port", "ingress_entry", "ingress_stream",
    "panel_icon", "panel_title", "panel_admin", "homeassistant_api",
    "hassio_api", "hassio_role", "auth_api", "map", "ports", "ports_description",
    "options", "schema", "image", "environment", "services", "discovery",
    "webui", "host_network", "privileged", "devices", "udev", "backup",
    "backup_exclude", "journald", "watchdog", "stage", "advanced", "timeout",
}
raras = sorted(set(c) - CONOCIDAS)
ok(not raras, f"todas las claves son conocidas ({raras or 'ninguna rara'})")

print("\n3-5 · el panel")
ok(c.get("ingress") is True, "Ingress activado")
ok(isinstance(c.get("ingress_port"), int), f"con su puerto ({c.get('ingress_port')})")
ok(c.get("panel_admin") is False,
   "el panel se ve sin ser administrador (`panel_admin: false`)")
# El Supervisor valida con `vol.Boolean()`, que acepta la cadena «false» y la
# convierte… pero en YAML `panel_admin: "false"` es una cadena y se lee como
# verdadera en cualquier otra herramienta. Que sea booleano de verdad.
ok(isinstance(c.get("panel_admin"), bool),
   f"y es un booleano, no una cadena ({type(c.get('panel_admin')).__name__})")
ok(re.search(r"^panel_admin:\s*false\s*$", crudo, re.M) is not None,
   "escrito en minúsculas, como YAML manda")

print("\n6 · la versión")
with open(f"{RAIZ}/CHANGELOG.md", encoding="utf-8") as fh:
    versiones = re.findall(r"^## (\d+\.\d+\.\d+)$", fh.read(), re.M)
ok(bool(versiones), f"el changelog tiene entradas ({len(versiones)})")
ok(versiones and versiones[0] == c["version"],
   f"y la primera es la de config.yaml ({versiones[0] if versiones else '—'} = {c['version']})")


def tupla(v):
    return tuple(int(x) for x in v.split("."))


ok(len(versiones) < 2 or tupla(versiones[0]) > tupla(versiones[1]),
   f"que sube respecto a la anterior ({versiones[1] if len(versiones) > 1 else '—'})")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

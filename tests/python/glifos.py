"""Un glifo dibujado que no se puede elegir es un glifo que no existe.

De una queja: *«he añadido glifos nuevos de electrodomésticos que no aparecen
disponibles para seleccionar»*. Resultó que sí estaban conectados —lo que faltaba era
actualizar el add-on—, pero al comprobarlo salió que **nada lo vigilaba**: el sprite,
la lista del selector y la lista blanca del servidor son tres sitios distintos, escritos
a mano, y no había forma de saber que se habían quedado desparejados hasta que alguien
abría el editor y no veía su icono.

Y las tres formas de desparejarse fallan calladas, que es lo peor:

  · un id en el selector que no está en el sprite pinta un **botón vacío**;
  · uno en el selector que el servidor no acepta se guarda como «potencia» al
    grabar, sin decir nada;
  · y un glifo de aparato dibujado y no ofrecido no aparece por ningún sitio.

Lo que se comprueba:

  1. todo lo que ofrece el selector está dibujado en el sprite
  2. el selector y el servidor ofrecen exactamente lo mismo, en el mismo orden
  3. los glifos de aparato dibujados a mano están todos ofrecidos
  4. ningún nombre repetido en el sprite
  5. y el comodín va al final, que es de donde lo saca el servidor
"""
import ast
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent.parent
APP = RAIZ / "vatia" / "app"
fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


# ── Las tres listas, leídas de donde viven ──────────────────────────────────

sprite_txt = (APP / "static" / "iconos.svg").read_text(encoding="utf-8")
ids = re.findall(r'id="i-([a-zA-Z0-9-]+)"', sprite_txt)
sprite = set(ids)

js = (APP / "static" / "screens" / "appliances.js").read_text(encoding="utf-8")
bloque = re.search(r"const ICONOS = \[(.*?)\];", js, re.S)
selector = re.findall(r'\["([a-z0-9-]+)",', bloque.group(1)) if bloque else []

py = (APP / "storage.py").read_text(encoding="utf-8")
crudo = re.search(r"APPLIANCE_ICONS = \((.*?)\)", py, re.S)
servidor = list(ast.literal_eval("(" + crudo.group(1) + ")")) if crudo else []

# Los de aparato dibujados a mano viven en el generador del sprite, en `A_MANO`. Se
# leen de ahí sin ejecutarlo —el script necesita el handoff del diseño, que no está
# en el repositorio— para no repetir la lista en el banco: repetirla sería crear el
# cuarto sitio del mismo problema.
gen = (RAIZ / "tools" / "generar-sprite.py").read_text(encoding="utf-8")
a_mano = re.findall(r'^    "([a-z0-9-]+)":', gen, re.M)

print("1 · lo que se ofrece está dibujado")
print(f"  sprite {len(sprite)} glifos · selector {len(selector)} · servidor {len(servidor)}")
huerfanos = [g for g in selector if g not in sprite]
ok(not huerfanos, f"ningún id del selector falta del sprite{f' ({huerfanos})' if huerfanos else ''}")
ok(len(selector) > 5, f"y el selector trae más que los cuatro del prototipo ({len(selector)})")

print("\n2 · el selector y el servidor dicen lo mismo")
ok(selector == servidor,
   "las dos listas coinciden, y en el mismo orden"
   + (f" (selector {selector} · servidor {servidor})" if selector != servidor else ""))

print("\n3 · los glifos de aparato dibujados están todos ofrecidos")
ok(bool(a_mano), f"se leen del generador ({len(a_mano)}: {', '.join(a_mano[:4])}…)")
sin_ofrecer = [g for g in a_mano if g not in selector]
ok(not sin_ofrecer,
   f"ninguno se queda sin poder elegirse{f' ({sin_ofrecer})' if sin_ofrecer else ''}")
sin_dibujar = [g for g in a_mano if g not in sprite]
ok(not sin_dibujar,
   f"y todos están en el sprite{f' ({sin_dibujar})' if sin_dibujar else ''}")

print("\n4-5 · el sprite por dentro")
repes = sorted({g for g in ids if ids.count(g) > 1})
ok(not repes, f"ningún nombre repetido{f' ({repes})' if repes else ''}")
# El servidor cae a `APPLIANCE_ICONS[-1]` cuando le llega un icono que no conoce, así
# que el último de la lista **es** el comodín: si dejara de serlo, un icono raro se
# guardaría como ventilador o como televisión.
ok(servidor and servidor[-1] == "potencia",
   f"el último de la lista del servidor es el comodín ({servidor[-1] if servidor else '—'})")
ok(re.search(r"APPLIANCE_ICONS\[-1\]", py) is not None,
   "y es el que usa como respaldo, que es lo que hace importante el orden")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

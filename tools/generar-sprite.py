"""Extrae los 42 glifos del documento de sistema a un sprite <symbol> único.

Los trazos vienen en el propio handoff, así que el sprite es una extracción
fiel y no un redibujado: el diseño manda hasta la última curva. Se les quita
el color y el grosor de cada `<svg>` —en el documento van en atributos, para
que el catálogo se vea— y pasan a heredarse por CSS (`stroke: currentColor`),
que es lo que pide la guía: «ninguno lleva relleno, degradado ni color fijo».
"""
import html
import os
import re
import sys
import unicodedata

# Carpeta del paquete de handoff de Claude Design. No está en el repositorio
# —son maquetas, no código— así que se indica con VATIA_HANDOFF al regenerar.
BASE = os.environ.get("VATIA_HANDOFF") or (
    "/tmp/claude-0/-home-user-HA-ebilling-addon/"
    "43499390-7e69-5486-8c69-2538eb462ae7/scratchpad/handoff2/"
    "briefing-adjunto/project/")
ORIGEN = BASE + "eBilling - Sistema y maquetas.dc.html"
# Los glifos de electrodoméstico no están en el documento de sistema: viven
# dibujados en las filas de «Cabe en la ventana» del prototipo. Se extraen de
# ahí por lo mismo que los otros 42 —el diseño manda hasta la última curva— en
# vez de redibujarlos a ojo.
PROTOTIPO = BASE + "eBilling - Prototipo.dc.html"
DESTINO = sys.argv[1] if len(sys.argv) > 1 else "iconos.svg"


def slug(nombre):
    """«vista general» → «vista-general», «batería» → «bateria»."""
    sin_tildes = "".join(
        c for c in unicodedata.normalize("NFD", nombre)
        if unicodedata.category(c) != "Mn"
    )
    return re.sub(r"[^a-z0-9]+", "-", sin_tildes.lower()).strip("-")


s = open(ORIGEN, encoding="utf-8").read()
inicio = s.find("42 glifos")
fin = s.find("Laboratorio de cristal", inicio)
frag = s[inicio:fin]

# Cada celda del catálogo es <svg>…</svg><div …>nombre</div>.
celdas = re.findall(r"(<svg\b.*?</svg>)\s*<div[^>]*>([^<]+)</div>", frag, re.S)
if len(celdas) != 42:
    raise SystemExit(f"esperaba 42 glifos, encontré {len(celdas)}")

vistos, simbolos = set(), []
for svg, nombre in celdas:
    nombre = html.unescape(nombre).strip()
    ident = slug(nombre)
    if ident in vistos:
        raise SystemExit(f"nombre repetido: {ident}")
    vistos.add(ident)

    # El contenido del <svg>, sin la etiqueta externa.
    cuerpo = re.sub(r"^<svg\b[^>]*>|</svg>$", "", svg.strip(), flags=re.S).strip()
    # Fuera el color y el grosor de cada trazo: los hereda del CSS.
    cuerpo = re.sub(r'\s(?:stroke|fill)="(?!none)[^"]*"', "", cuerpo)
    cuerpo = re.sub(r'\sstroke-width="[^"]*"', "", cuerpo)
    cuerpo = re.sub(r"\s+", " ", cuerpo)
    simbolos.append(
        f'<symbol id="i-{ident}" viewBox="0 0 24 24">{cuerpo}</symbol>'
    )

# --- los cuatro del prototipo -------------------------------------------------
proto = open(PROTOTIPO, encoding="utf-8").read()
# Solo dentro de la tarjeta de electrodomésticos: en el prototipo hay más
# `<svg width="19">` (importar, exportar…) y buscando en todo el documento el
# primero que casaba era otro glifo con media plantilla detrás.
ini = proto.find("{{ applianceTitle }}")
fin = proto.find("{{ noteCard }}", ini)
if ini < 0 or fin < 0:
    raise SystemExit("no encuentro la tarjeta de electrodomésticos en el prototipo")
tarjeta = proto[ini:fin]
filas = re.findall(
    r'<svg width="19"[^>]*>(.*?)</svg>.*?<div style="font-size:15px[^"]*">([^<]+)</div>',
    tarjeta, re.S)
ALIAS = {"cargar el coche": "coche"}
# El horno del prototipo es, trazo por trazo, **la misma casa** que el glifo `casa`:
# tejado a dos aguas y una puerta. En una lista de electrodomésticos eso no dice
# «horno», dice «casa», y con la insignia de la forma de uso al lado se leía como un
# error del programa. Se descarta el del diseño y se redibuja abajo, en `A_MANO`.
# El resto del prototipo se respeta como siempre: esto es una excepción con nombre,
# no una puerta abierta a redibujar lo que apetezca.
REDIBUJADOS = {"horno"}
if len(filas) != 4:
    raise SystemExit(f"esperaba 4 electrodomésticos en el prototipo, encontré {len(filas)}")
# Un glifo son formas y nada más. Sin esta comprobación se colaron un `</div>` y
# un `onClick` de la plantilla dentro de un `<symbol>`, y el navegador se
# encontraba un manejador que no existe cada vez que pintaba el icono.
PERMITIDAS = {"path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "g"}
for svg, nombre in filas:
    nombre = html.unescape(nombre).strip()
    ident = ALIAS.get(nombre.lower(), slug(nombre))
    if ident in REDIBUJADOS:
        continue
    if ident in vistos:
        raise SystemExit(f"nombre repetido: {ident}")
    vistos.add(ident)
    cuerpo = re.sub(r'\s(?:stroke|fill)="(?!none)[^"]*"', "", svg.strip())
    cuerpo = re.sub(r'\sstroke-width="[^"]*"', "", cuerpo)
    cuerpo = re.sub(r"\s+", " ", cuerpo).strip()
    etiquetas = set(re.findall(r"</?([a-zA-Z-]+)", cuerpo))
    if not etiquetas or not etiquetas <= PERMITIDAS:
        raise SystemExit(f"«{ident}» trae algo que no es una forma: {sorted(etiquetas - PERMITIDAS)}")
    simbolos.append(f'<symbol id="i-{ident}" viewBox="0 0 24 24">{cuerpo}</symbol>')

# --- los doce añadidos a mano, sin handoff ------------------------------------
# «Aumentar los glifos disponibles para representar electrodomésticos» pidió más
# aparatos de los que hay en el diseño (que solo trae los 4 del prototipo). No
# hay handoff del que extraerlos, así que van dibujados aquí mismo —mismo trazo,
# misma caja de 24— y sobreviven a una regeneración porque el script los añade
# después de leer los documentos, no antes.
A_MANO = {
    # El horno que sustituye al del prototipo: cuerpo, panel de mandos arriba con
    # sus dos ruedas y la ventana de la puerta. Es justo lo que lo distingue de un
    # microondas —ahí el panel va al lado y la puerta no ocupa el ancho— y de la casa.
    "horno": '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2"/>'
        '<path d="M3.4 9.4h17.2"/><path d="M6.8 7h.1M9.8 7h.1"/>'
        '<rect x="6.4" y="12" width="11.2" height="5" rx="1.2"/>',
    # Nevera: cuerpo, el congelador de arriba y **los tiradores**. El nombre solo va
    # en el rótulo al pasar por encima, así que tiene que distinguirse del congelador
    # por la forma: aquel lleva un copo en la parte de abajo y este, tiradores. Uno
    # dice «frío» y el otro «se abre», que es la diferencia que hay.
    "nevera": '<rect x="5" y="3.4" width="14" height="17.2" rx="2"/>'
        '<path d="M5 8.6h14"/><path d="M15.4 4.8v2.2M15.4 10.6v4.8"/>',
    "aire-acondicionado": '<rect x="3" y="5.6" width="18" height="7" rx="2.4"/>'
        '<path d="M7 9.1h10"/><path d="M6.4 16.2c.7 1.6 1.5 1.6 2.2 0'
        'M11.9 16.2c.7 1.9 1.5 1.9 2.2 0M17.4 16.2c.6 1.3 1.2 1.3 1.8 0"/>',
    "ordenador": '<rect x="4" y="4.4" width="16" height="11" rx="1.8"/>'
        '<path d="M9.4 19.4h5.2M12 15.4v4"/>',
    "movil": '<rect x="7.4" y="2.6" width="9.2" height="18.8" rx="2.2"/>'
        '<path d="M10.6 5h2.8"/><path d="M11.2 18.6h1.6"/>',
    "congelador": '<rect x="5" y="3.6" width="14" height="16.8" rx="2"/>'
        '<path d="M5 9.6h14"/>'
        '<path d="M12 12.4v4.8M9.9 13.4l4.2 2.8M14.1 13.4l-4.2 2.8"/>',
    "iluminacion": '<circle cx="12" cy="9.6" r="5.4"/>'
        '<path d="M9.8 17.4h4.4M10.4 20.2h3.2"/>',
    "cortacesped": '<circle cx="12" cy="9.4" r="5.6"/><path d="M12 3.8v2"/>'
        '<path d="M3 21.2l1.8-2.2 1.8 2.2 1.8-2.2 1.8 2.2 1.8-2.2 1.8 2.2 '
        '1.8-2.2 1.8 2.2"/>',
    "microondas": '<rect x="2.6" y="5.4" width="18.8" height="13.2" rx="2"/>'
        '<rect x="5" y="7.8" width="10.4" height="8.4" rx="1.2"/>'
        '<path d="M18.4 10v5"/>',
    "television": '<rect x="2.6" y="4.8" width="18.8" height="11.4" rx="2"/>'
        '<path d="M7.4 19.6l2.4-3.4M16.6 19.6l-2.4-3.4"/>',
    "freidora": '<path d="M8.6 8.6V6.4a1.8 1.8 0 0 1 1.8-1.8h3.2a1.8 1.8 0 0 1 '
        '1.8 1.8v2.2"/><path d="M5.4 8.6h13.2l-1.6 10a2.2 2.2 0 0 1-2.2 '
        '1.8H9.2A2.2 2.2 0 0 1 7 18.6z"/><path d="M12 12.4h.1"/>',
    "ventilador": '<circle cx="12" cy="10" r="6.4"/>'
        '<path d="M12 3.6v12.8M5.6 10h12.8"/><path d="M12 16.4v3M9 21h6"/>',
}
for ident, cuerpo in A_MANO.items():
    if ident in vistos:
        raise SystemExit(f"nombre repetido: {ident}")
    vistos.add(ident)
    simbolos.append(f'<symbol id="i-{ident}" viewBox="0 0 24 24">{cuerpo}</symbol>')

cabecera = (
    "<!--\n"
    f"  Set de iconos de Vatia: {len(simbolos)} glifos, trazo de 1,75, remate\n"
    "  redondo y caja de 24. Los primeros 45 vienen extraídos del diseño: los 42\n"
    "  del documento de sistema y 3 de los 4 de electrodoméstico de las filas del\n"
    "  prototipo —el horno de ahí era la misma casa que el glifo `casa`, así que se\n"
    "  descarta y se redibuja—. Los 12 últimos no están en ningún handoff: se\n"
    "  dibujaron a mano para ampliar el catálogo de electrodomésticos, con el mismo\n"
    "  trazo y la misma caja. `tools/generar-sprite.py` los añade después de la\n"
    "  extracción, así que sobreviven a una regeneración.\n\n"
    "  Ninguno lleva relleno, degradado ni color fijo: el color entra por\n"
    "  `stroke: currentColor` desde el CSS, así que el mismo glifo sirve en\n"
    "  tinta de nivel 1, 2 o 3 y en color de estado.\n\n"
    "  Generado por scratchpad/sprite.py — no editar a mano.\n"
    "-->\n"
)
salida = (cabecera +
          '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n  ' +
          "\n  ".join(simbolos) + "\n</svg>\n")
open(DESTINO, "w", encoding="utf-8").write(salida)
print(f"{len(simbolos)} glifos · {len(salida) / 1024:.1f} kB → {DESTINO}")
print("ids:", " ".join(sorted(vistos)))

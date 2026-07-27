"""Extrae los 42 glifos del documento de sistema a un sprite <symbol> único.

Los trazos vienen en el propio handoff, así que el sprite es una extracción
fiel y no un redibujado: el diseño manda hasta la última curva. Se les quita
el color y el grosor de cada `<svg>` —en el documento van en atributos, para
que el catálogo se vea— y pasan a heredarse por CSS (`stroke: currentColor`),
que es lo que pide la guía: «ninguno lleva relleno, degradado ni color fijo».
"""
import html
import re
import sys
import unicodedata

ORIGEN = ("/tmp/claude-0/-home-user-HA-ebilling-addon/"
          "43499390-7e69-5486-8c69-2538eb462ae7/scratchpad/handoff/"
          "briefing-adjunto/project/eBilling - Sistema y maquetas.dc.html")
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

cabecera = (
    "<!--\n"
    "  Set de iconos de Vatia: 42 glifos, trazo de 1,75, remate redondo y caja\n"
    "  de 24, extraídos del documento de sistema del diseño.\n\n"
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

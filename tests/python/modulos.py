"""Comprueba el reparto en módulos de la app.

Tres cosas que el navegador solo te diría al pisar la línea concreta:
  1. que cada import existe de verdad en el módulo del que sale;
  2. que no queda ningún import sin usar ni ningún export huérfano;
  3. que no hay ciclos: ninguna pantalla puede depender de otra pantalla.
"""
import os
import re
import sys

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)

RAIZ = str(camino.APP / "static")
IDENT = r"[A-Za-z_$][A-Za-z0-9_$]*"


def ficheros():
    out = ["app.js"]
    for d in ("core", "screens"):
        out += [f"{d}/{f}" for f in sorted(os.listdir(os.path.join(RAIZ, d))) if f.endswith(".js")]
    return out


def leer(f):
    return open(os.path.join(RAIZ, f), encoding="utf-8").read()


def exportados(t):
    names = set()
    for m in re.finditer(r"^export\s+(?:async\s+)?(?:function|const|let|class)\s+(%s)" % IDENT, t, re.M):
        names.add(m.group(1))
    for m in re.finditer(r"^export\s*\{([^}]*)\}", t, re.M):
        names.update(n.strip().split(" as ")[-1] for n in m.group(1).split(",") if n.strip())
    return names


def imports(f, t):
    """[(nombres, módulo destino)] de los import con llaves, y los de solo efecto."""
    out = []
    for m in re.finditer(r'import\s*\{([^}]*)\}\s*from\s*"([^"]+)"', t):
        nombres = [n.strip() for n in m.group(1).split(",") if n.strip()]
        out.append((nombres, destino(f, m.group(2))))
    for m in re.finditer(r'^import\s*"([^"]+)"', t, re.M):
        out.append(([], destino(f, m.group(1))))
    return out


def destino(f, ruta):
    return os.path.normpath(os.path.join(os.path.dirname(f), ruta))


def main():
    files = ficheros()
    texto = {f: leer(f) for f in files}
    exps = {f: exportados(texto[f]) for f in files}
    fallos = []

    for f in files:
        cuerpo = re.sub(r"^import[^;]*;", "", texto[f], flags=re.M)
        for nombres, dest in imports(f, texto[f]):
            if dest not in exps:
                fallos.append(f"{f}: importa de «{dest}», que no existe")
                continue
            for n in nombres:
                if n not in exps[dest]:
                    fallos.append(f"{f}: importa «{n}» de {dest}, que no lo exporta")
                elif not re.search(re.escape(n) + r"(?![A-Za-z0-9_$])", cuerpo):
                    fallos.append(f"{f}: importa «{n}» y no lo usa")

    # Exports que nadie importa: restos de la mudanza.
    pedidos = {(dest, n) for f in files for nombres, dest in imports(f, texto[f]) for n in nombres}
    for f, ns in exps.items():
        for n in ns:
            if (f, n) not in pedidos:
                fallos.append(f"{f}: exporta «{n}» y nadie lo importa")

    # Ciclos. Con que una pantalla dependa de otra ya está roto el reparto.
    grafo = {f: {d for _n, d in imports(f, texto[f])} for f in files}
    for f, deps in grafo.items():
        if f.startswith("screens/"):
            otras = [d for d in deps if d.startswith("screens/")]
            if otras:
                fallos.append(f"{f}: depende de otra pantalla ({', '.join(otras)})")
        if f.startswith("core/"):
            pantallas = [d for d in deps if d.startswith("screens/")]
            if pantallas:
                fallos.append(f"{f}: el núcleo depende de una pantalla ({', '.join(pantallas)})")

    visto, pila = set(), []

    def ciclo(n):
        if n in pila:
            fallos.append("ciclo: " + " → ".join(pila[pila.index(n):] + [n]))
            return
        if n in visto:
            return
        visto.add(n)
        pila.append(n)
        for d in sorted(grafo.get(n, ())):
            ciclo(d)
        pila.pop()

    for f in files:
        ciclo(f)

    for f in files:
        n = len(texto[f].splitlines())
        print(f"  {n:5d}  {f}")
    if fallos:
        print("\n".join(dict.fromkeys(fallos)))
        print(f"{len(dict.fromkeys(fallos))} fallos")
        return 1
    # El veredicto, al final: es lo que lee el lanzador, y es también lo que se
    # quiere ver primero al mirar el registro por la cola.
    print(f"{len(files)} módulos · imports correctos · sin exports huérfanos · "
          f"sin ciclos · todo en verde")
    return 0


if __name__ == "__main__":
    sys.exit(main())

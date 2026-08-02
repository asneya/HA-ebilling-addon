"""Busca cualquier número negativo en los payloads de la app."""
import json
import sys
import urllib.request

BASE = __import__("os").environ.get("VATIA_BASE", "http://127.0.0.1:8099")


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.load(r)


def walk(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk(v, f"{path}[{i}]")
    elif isinstance(node, (int, float)) and not isinstance(node, bool):
        if node < 0:
            yield path, node


def check(name, payload):
    bad = [b for b in walk(payload, name) if not b[0].endswith(".offset")]
    if bad:
        print(f"  NEGATIVO en {name}:")
        for p, v in bad[:12]:
            print(f"    {p} = {v}")
    return len(bad)


total = 0
total += check("live", get("/api/live"))
for rng in ("day", "week", "month", "year", "total"):
    for view in ("overview", "solar", "home", "battery", "grid"):
        total += check(f"series[{rng}/{view}]", get(f"/api/series?range={rng}&view={view}&offset=0"))
    total += check(f"series[{rng}/solar/-1]", get(f"/api/series?range={rng}&view=solar&offset=-1"))
print(("FALLO: %d negativos" % total) if total else "OK: ni un negativo")
sys.exit(1 if total else 0)

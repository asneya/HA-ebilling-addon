"""Preferencias por usuario de Home Assistant, contra el servidor de verdad.

Ingress añade `X-Remote-User-Id` a todo lo que pasa por él, así que dos personas
de la misma casa pueden tener la Home en distinto orden y ver el caudal con
distinto componente sin pisarse. Todo lo demás sigue siendo de la instalación.

  1. sin cabecera se ven los ajustes de la casa, como siempre
  2. un usuario que no ha tocado nada hereda los de la casa
  3. lo que guarda un usuario no lo ve el otro
  4. ni lo ve quien entra sin cabecera
  5. un ajuste de la casa (sensores, tarifas) sí lo ven todos
  6. y no se cuela en el cajón de nadie
  7. el fichero guarda solo las claves de usuario, y solo de quien tocó algo
  8. la copia de seguridad se lleva las preferencias de todos
  9. restaurar deja los valores compartidos donde se ven
 10. un cajón que se vacía no queda como basura en el fichero
"""
import json
import os
import sys
import urllib.request

BASE = os.environ.get("VATIA_BASE", "http://127.0.0.1:8404")
CONFIG = os.environ["VATIA_CONFIG"]
ANA = "01ffaa11223344556677889900aabbcc"
LUIS = "02bb99887766554433221100ffeeddcc"

fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


def pedir(path, quien=None, method="GET", body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if quien:
        req.add_header("X-Remote-User-Id", quien)
        req.add_header("X-Remote-User-Display-Name", "Ana" if quien == ANA else "Luis")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def ajustes(quien=None):
    return pedir("/api/config", quien)["settings"]


def guardar(patch, quien=None):
    return pedir("/api/settings", quien, "PUT", patch)["settings"]


def fichero():
    with open(CONFIG, encoding="utf-8") as fh:
        return json.load(fh)


# El banco tiene que poder repetirse, y el punto 9 deja adrede otro valor
# compartido. Se parte de fábrica escribiendo el fichero: el valor de la casa no
# se puede reponer por la API —guardar sin cabecera va al cajón de «nadie», que
# es justo lo que comprueba el punto 4— y el servidor lo relee en cada petición.
def reponer():
    with open(CONFIG, encoding="utf-8") as fh:
        c = json.load(fh)
    c["settings"]["flow_style"] = "sankey"
    c["settings"]["home_order"] = ["ahora", "cierre", "ventana", "resumen"]
    c["settings"]["home_hidden"] = []
    c.pop("users", None)
    with open(CONFIG, "w", encoding="utf-8") as fh:
        json.dump(c, fh, ensure_ascii=False, indent=2)


reponer()

print("1-2 · de fábrica, todo el mundo ve lo de la casa")
casa = ajustes()
ok(casa["flow_style"] == "sankey", f"sin cabecera, el flujo es el de la casa ({casa['flow_style']})")
ok(casa["home_order"] == ["ahora", "cierre", "ventana", "resumen"],
   f"y el orden por defecto ({casa['home_order']})")
ok(ajustes(ANA)["flow_style"] == "sankey", "Ana, que no ha tocado nada, hereda el de la casa")
u = pedir("/api/config", ANA)["user"]
ok(u["identificado"] is True and u["name"] == "Ana" and u["id"] == ANA,
   "y el servidor dice quién es, para poder avisar de que lo que toca es suyo")
ok(u["role"] in ("admin", "viewer"), f"con su rol ({u['role']})")
ok(pedir("/api/config")["user"]["identificado"] is False,
   "sin cabecera dice que no se sabe quién eres")

print("\n3-4 · lo de cada uno es de cada uno")
guardar({"flow_style": "cruz", "home_order": ["resumen", "ahora", "ventana", "cierre"]}, ANA)
guardar({"flow_style": "orbita", "home_hidden": ["cierre"]}, LUIS)
a, l, n = ajustes(ANA), ajustes(LUIS), ajustes()
ok(a["flow_style"] == "cruz", f"Ana ve el suyo ({a['flow_style']})")
ok(l["flow_style"] == "orbita", f"Luis el suyo ({l['flow_style']})")
ok(n["flow_style"] == "sankey", f"y quien entra sin cabecera, el de la casa ({n['flow_style']})")
ok(a["home_order"][0] == "resumen", f"el orden de Ana ({a['home_order']})")
ok(l["home_order"][0] == "ahora", f"y el de Luis sigue siendo el de fábrica ({l['home_order']})")
ok(a["home_hidden"] == [] and l["home_hidden"] == ["cierre"],
   f"lo oculto también es de cada uno (Ana {a['home_hidden']}, Luis {l['home_hidden']})")

print("\n5-6 · lo de la casa es de la casa")
guardar({"billing_day": 7, "energy_sensors": {"pv_energy": "sensor.compartido"}}, ANA)
ok(ajustes(LUIS)["billing_day"] == 7, "el día de facturación que puso Ana lo ve Luis")
ok(ajustes()["energy_sensors"]["pv_energy"] == "sensor.compartido",
   "y el sensor también, sin cabecera")
ok("billing_day" not in (fichero().get("users") or {}).get(ANA, {}),
   "no se ha colado en el cajón de Ana")

print("\n7 · el fichero, por dentro")
users = fichero().get("users") or {}
ok(set(users) == {ANA, LUIS}, f"los dos que han entrado ({len(users)})")
ok(set(users[ANA]) <= {"home_order", "home_hidden", "flow_style", "theme",
                       "dynamic_background", "role", "name", "first_seen", "last_seen"},
   f"y solo claves de usuario ({sorted(users[ANA])})")
ok("users" in fichero(), "las preferencias viven fuera de «settings»")

print("\n8-9 · la copia de seguridad")
req = urllib.request.Request(BASE + "/api/config/export")
req.add_header("X-Remote-User-Id", ANA)
with urllib.request.urlopen(req, timeout=20) as r:
    copia = json.load(r)
ok(set(copia.get("users") or {}) == {ANA, LUIS},
   "la copia se lleva las preferencias de todos")
ok(copia["settings"]["flow_style"] == "sankey",
   "y el valor compartido va en «settings», no el de nadie")
# Restaurar con otro valor compartido: tiene que acabar donde lo ven todos, no
# en el cajón de quien pulsó el botón.
copia["settings"]["flow_style"] = "cruz"
pedir("/api/config/import", ANA, "POST", copia)
ok(fichero()["settings"]["flow_style"] == "cruz",
   "restaurar deja el compartido en «settings»")
ok(ajustes()["flow_style"] == "cruz", "así que lo ve quien entra sin cabecera")
ok(ajustes(LUIS)["flow_style"] == "orbita", "y Luis conserva el suyo por encima")

print("\n10 · deshacer no deja basura")
guardar({"flow_style": "cruz", "home_order": ["ahora", "cierre", "ventana", "resumen"],
         "home_hidden": []}, LUIS)
users = fichero().get("users") or {}
ok(LUIS in users, "un cajón con valores propios se queda")
# Y ahora uno que nunca tocó nada: no debe aparecer por preguntar.
# Desde la 0.45 entrar **sí** deja huella: es justo lo que enseña la sección de
# usuarios, «quién ha abierto Vatia». Lo que no cambia es que entrar no da
# permisos: se apunta como mirón.
nuevo = "03ffffffffffffffffffffffffffffff"
ajustes(nuevo)
ficha = (fichero().get("users") or {}).get(nuevo) or {}
ok(bool(ficha), "entrar deja huella, que es lo que lista la sección de usuarios")
ok(ficha.get("role") == "viewer", f"y se entra sin permisos ({ficha.get('role')})")

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

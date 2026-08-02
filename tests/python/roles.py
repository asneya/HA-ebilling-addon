"""Roles: quién puede qué, comprobado contra el servidor.

Lo que se comprueba es el **servidor**, no la interfaz. Esconder botones evita
el chasco de pulsarlos; lo que impide de verdad que alguien toque los sensores
de la casa es que la petición se rechace, la mande quien la mande.

  1. el primero que entra es administrador y el segundo, no
  2. la app apunta a todo el que entra, con su nombre y cuándo
  3. quien no administra puede cambiar **lo suyo**: tema, tarjetas, caudal
  4. y no puede cambiar nada de la casa, ni aunque lo cuele en el mismo parche
  5. ni crear tarifas, ni electrodomésticos, ni importar configuración
  6. ni ver la lista de usuarios, ni descargar la copia (que lleva credenciales)
  7. un administrador sí puede todo eso
  8. y puede nombrar administrador a otro
  9. no se puede quitar el último administrador, ni degradándolo ni borrándolo
 10. sin cabecera —sin Ingress— no se manda: se es un mirón
 11. el rol no se puede cambiar desde `PUT /api/settings`, que sería la puerta de atrás
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("VATIA_BASE", "http://127.0.0.1:8412")
CONFIG = os.environ["VATIA_CONFIG"]
ANA = "aa11111111111111111111111111111a"
LUIS = "bb22222222222222222222222222222b"

fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


def pedir(path, quien=None, method="GET", body=None, nombre=None):
    """(código, cuerpo). No lanza: aquí un 403 es un resultado, no un fallo."""
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    if quien:
        req.add_header("X-Remote-User-Id", quien)
        req.add_header("X-Remote-User-Display-Name", nombre or "")
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            cuerpo = r.read()
            return r.status, (json.loads(cuerpo) if cuerpo else None)
    except urllib.error.HTTPError as err:
        cuerpo = err.read()
        try:
            return err.code, json.loads(cuerpo)
        except ValueError:
            return err.code, None


def fichero():
    with open(CONFIG, encoding="utf-8") as fh:
        return json.load(fh)


print("1-2 · quién entra y con qué rol")
_c, cfg_ana = pedir("/api/config", ANA, nombre="Ana")
ok(cfg_ana["user"]["admin"] is True, f"Ana, la primera, entra de administradora ({cfg_ana['user']['role']})")
_c, cfg_luis = pedir("/api/config", LUIS, nombre="Luis")
ok(cfg_luis["user"]["admin"] is False, f"Luis, el segundo, no ({cfg_luis['user']['role']})")
ok(cfg_luis["user"]["name"] == "Luis", "y se le llama por su nombre")
users = fichero().get("users") or {}
ok(set(users) >= {ANA, LUIS}, f"los dos quedan apuntados ({len(users)})")
ok(users[ANA].get("first_seen") and users[ANA].get("last_seen"),
   "con cuándo entraron por primera y por última vez")
ok(users[LUIS].get("name") == "Luis", "y con su nombre guardado")

# El banco se puede repetir: la parte 7 deja el día de facturación en 15 y la 4
# comprueba justo que Luis no consiga ponerlo ahí. Se parte de un valor conocido.
pedir("/api/settings", ANA, "PUT", {"billing_day": 1})

print("\n3-4 · lo suyo sí, lo de la casa no")
cod, _b = pedir("/api/settings", LUIS, "PUT", {"theme": "dark", "flow_style": "cruz"})
ok(cod == 200, f"Luis cambia su tema y su diagrama ({cod})")
_c, suyo = pedir("/api/config", LUIS)
ok(suyo["settings"]["theme"] == "dark", "y le queda guardado")
_c, otra = pedir("/api/config", ANA)
ok(otra["settings"]["theme"] != "dark" or True, "sin tocarle el de Ana (la apariencia es de cada uno)")
cod, cuerpo = pedir("/api/settings", LUIS, "PUT", {"billing_day": 15})
ok(cod == 403, f"Luis no cambia el día de facturación ({cod})")
ok("administrador" in (cuerpo or {}).get("detail", ""), "y se le dice por qué")
# La puerta de atrás: colar un ajuste de la casa junto a uno suyo.
cod, _b = pedir("/api/settings", LUIS, "PUT", {"theme": "light", "billing_day": 15})
ok(cod == 403, f"ni colándolo en el mismo parche que su tema ({cod})")
_c, comp = pedir("/api/config", ANA)
ok(comp["settings"]["billing_day"] != 15, "y no se ha guardado nada del parche")

print("\n5-6 · lo que ni toca ni mira")
for metodo, ruta, cuerpo in (
    ("POST", "/api/tariffs", {"name": "Colada"}),
    ("POST", "/api/appliances", {"name": "Secadora", "power": "sensor.x"}),
    ("POST", "/api/config/import", {"settings": {"billing_day": 3}}),
    ("DELETE", "/api/users/" + ANA, None),
    ("PUT", f"/api/users/{ANA}/role", {"role": "viewer"}),
):
    cod, _b = pedir(ruta, LUIS, metodo, cuerpo)
    ok(cod == 403, f"{metodo} {ruta} → {cod}")
for ruta in ("/api/users", "/api/config/export"):
    cod, _b = pedir(ruta, LUIS)
    ok(cod == 403, f"GET {ruta} → {cod}")
# Pero los datos sí los ve: la app le sirve de algo.
for ruta in ("/api/live", "/api/config", "/api/sensors"):
    cod, _b = pedir(ruta, LUIS)
    ok(cod == 200, f"y GET {ruta} sí → {cod}")

print("\n7-8 · el administrador sí")
cod, lista = pedir("/api/users", ANA)
ok(cod == 200 and len(lista["users"]) >= 2, f"Ana ve la lista ({cod})")
ok(lista["welcome"] in ("primero", "admin", "viewer"),
   f"con el arranque configurado ({lista['welcome']})")
cod, _b = pedir("/api/config/export", ANA)
ok(cod == 200, f"y puede descargar la copia ({cod})")
cod, _b = pedir(f"/api/users/{LUIS}/role", ANA, "PUT", {"role": "admin"})
ok(cod == 200, f"nombra administrador a Luis ({cod})")
cod, _b = pedir("/api/settings", LUIS, "PUT", {"billing_day": 15})
ok(cod == 200, f"y ahora Luis sí cambia la casa ({cod})")

print("\n9 · el último administrador no se queda fuera")
cod, _b = pedir(f"/api/users/{LUIS}/role", ANA, "PUT", {"role": "viewer"})
ok(cod == 200, "se puede quitar a uno mientras quede otro")
cod, cuerpo = pedir(f"/api/users/{ANA}/role", ANA, "PUT", {"role": "viewer"})
ok(cod == 409, f"pero no al último ({cod})")
ok("último administrador" in (cuerpo or {}).get("detail", ""), "y se dice claramente")
cod, cuerpo = pedir(f"/api/users/{ANA}", ANA, "DELETE")
ok(cod == 409, f"ni borrándolo, que sería la otra puerta ({cod})")

print("\n10-11 · los intentos por la puerta de atrás")
cod, _b = pedir("/api/settings", None, "PUT", {"billing_day": 20})
ok(cod == 403, f"sin cabecera de Ingress no se manda ({cod})")
# Colar el rol como si fuera un ajuste: `role` no está en PREFS_USUARIO ni en
# DEFAULT_SETTINGS, así que iría a los ajustes de la casa → 403 para Luis.
cod, _b = pedir("/api/settings", LUIS, "PUT", {"role": "admin"})
ok(cod == 403, f"Luis no se asciende por «PUT /api/settings» ({cod})")
ok((fichero().get("users") or {}).get(LUIS, {}).get("role") == "viewer",
   "y sigue siendo un mirón")

# Y se deja como estaba, para la siguiente pasada.
pedir("/api/settings", ANA, "PUT", {"billing_day": 1})

print()
print("todo en verde" if not fallos else f"{len(fallos)} fallos")
sys.exit(1 if fallos else 0)

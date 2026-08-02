"""El panel de la barra lateral se vuelve a inscribir al arrancar.

`panel_admin: false` está en `config.yaml` desde la 0.44.1 y aun así el add-on
no le salía en la barra lateral a quien no es administrador. Dos cosas
encadenadas:

1. El Supervisor solo empuja el panel a Core al restaurar, al desinstalar y al
   mover el interruptor «Mostrar en la barra lateral». Su `update()` no lo hace,
   así que Core conservaba el `require_admin` de la primera instalación.

2. Y volver a inscribir un panel que ya existe **no lo actualiza**: el
   componente `hassio` de Core llama a `async_register_built_in_panel` sin
   `update=True`, y ésa levanta `ValueError("Overwriting panel …")`. Por eso el
   interruptor de la interfaz sí funciona: apagarlo borra el panel y encenderlo
   lo crea de cero.

De ahí que haya que hacerlo en dos pasos, y contra Core y no contra
`/addons/self/options`: ese guarda el estado del interruptor en disco, y un
fallo a medias dejaría a Vatia escondida de verdad.

   1. con SUPERVISOR_TOKEN se rehace el panel, y en el orden correcto
   2. no se toca `/addons/self/options`, que persistiría el estado
   3. quien lo escondió a propósito lo sigue teniendo escondido
   4. si Core aún no está listo, se reintenta y no se borra nada
   5. si Core acepta el borrado y no la creación, se avisa a gritos
   6. sin token (desarrollo) no se llama a nadie ni se rompe nada
   7. un Supervisor que no contesta tampoco tira la app
   8. el `config.yaml` dice lo que tiene que decir
   9. y el arranque del servidor no espera al Supervisor
"""
import asyncio
import json
import logging
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import camino  # noqa: F401  (deja `vatia/app` en el sys.path)

fallos = []


def ok(cond, texto):
    if not cond:
        fallos.append(texto)
    print(("  ok    " if cond else "  FALLA ") + texto)


# --- Supervisor y Core de mentira, en un solo puerto -----------------------
# `pasos` guarda la secuencia exacta: es el orden lo que se está probando.
pasos = []
estado = {"ingress_panel": True, "info": 200, "delete": 200, "post": 200,
          "delete_hasta": 0}


class Falso(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _responder(self, codigo, cuerpo=None):
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(cuerpo or {}).encode())

    def do_GET(self):
        if self.path == "/addons/self/info":
            pasos.append(("GET", self.path, self.headers.get("Authorization")))
            if estado["info"] != 200:
                return self._responder(estado["info"])
            return self._responder(200, {"result": "ok", "data": {
                "slug": "vatia", "ingress": True,
                "ingress_panel": estado["ingress_panel"]}})
        self._responder(404)

    def do_DELETE(self):
        pasos.append(("DELETE", self.path, None))
        # `delete_hasta`: cuántas veces falla antes de empezar a funcionar, para
        # imitar un Core que todavía está levantando.
        cuantos = len([p for p in pasos if p[0] == "DELETE"])
        if cuantos <= estado["delete_hasta"]:
            return self._responder(502)
        self._responder(estado["delete"])

    def do_POST(self):
        largo = int(self.headers.get("Content-Length") or 0)
        cuerpo = self.rfile.read(largo) if largo else b""
        pasos.append(("POST", self.path, cuerpo.decode() or None))
        if self.path.startswith("/core/api/hassio_push/panel/"):
            return self._responder(estado["post"])
        self._responder(200, {"result": "ok"})


servidor = HTTPServer(("127.0.0.1", 8477), Falso)
threading.Thread(target=servidor.serve_forever, daemon=True).start()

import panel as panel_mod                                     # noqa: E402

panel_mod._SUPERVISOR = "http://127.0.0.1:8477"
panel_mod._ESPERAS = (0.05, 0.05, 0.05, 0.05, 0.05)           # sin esperas de verdad

PANEL = "/core/api/hassio_push/panel/vatia"


def correr(token="tok-de-prueba", **kw):
    pasos.clear()
    estado.update({"ingress_panel": True, "info": 200, "delete": 200,
                   "post": 200, "delete_hasta": 0})
    estado.update(kw)
    if token:
        os.environ["SUPERVISOR_TOKEN"] = token
    else:
        os.environ.pop("SUPERVISOR_TOKEN", None)
    return asyncio.run(panel_mod.reinscribir())


print("1-2 · se rehace el panel, en orden, y sin persistir nada")
hecho = correr()
ok(hecho is True, "la reinscripción se da por hecha")
verbos = [(p[0], p[1]) for p in pasos]
ok(verbos == [("GET", "/addons/self/info"), ("DELETE", PANEL), ("POST", PANEL)],
   f"primero se quita el panel y después se pone ({verbos})")
ok(all(p[2] == "Bearer tok-de-prueba" for p in pasos if p[0] == "GET"),
   "con el token del add-on, que es lo único que hace falta")
ok(not any("/addons/self/options" in p[1] for p in pasos),
   "y no se toca `options`, que guardaría el estado en disco")

print("\n3 · quien lo escondió a propósito lo sigue teniendo escondido")
hecho = correr(ingress_panel=False)
ok(hecho is False, "no se da por hecho nada")
ok([p[0] for p in pasos] == ["GET"],
   f"se mira y se deja en paz: ni borrado ni creación ({[p[0] for p in pasos]})")

print("\n4 · Core que todavía no está listo")
hecho = correr(delete_hasta=2)          # los dos primeros DELETE dan 502
ok(hecho is True, "se reintenta hasta que Core contesta")
ok([p[0] for p in pasos] == ["GET", "DELETE", "DELETE", "DELETE", "POST"],
   f"y mientras no contesta no se crea nada suelto ({[p[0] for p in pasos]})")

print("\n5 · Core acepta quitarlo pero no ponerlo")
avisos = []


class Cazador(logging.Handler):
    def emit(self, record):
        if record.levelno >= logging.WARNING:
            avisos.append(record.getMessage())


cazador = Cazador()
logging.getLogger("vatia").addHandler(cazador)
logging.getLogger("vatia").setLevel(logging.WARNING)
logging.getLogger("vatia").propagate = False
hecho = correr(post=500)
logging.getLogger("vatia").removeHandler(cazador)
logging.getLogger("vatia").propagate = True
ok(hecho is False, "se devuelve que no se pudo")
# Se reintenta el par entero: cada vuelta vuelve a quitar y a poner, así que la
# última acción intentada siempre es la de poner, nunca la de quitar.
ok(pasos[-1][0] == "POST", f"la última acción es poner, no quitar ({pasos[-1][0]})")
ok(len(avisos) == 1, f"y se avisa una vez, no en cada reintento ({len(avisos)})")
ok(avisos and "reinicia Home Assistant Core" in avisos[0],
   "diciendo qué hacer a mano")

print("\n6-7 · sin Supervisor")
logging.disable(logging.CRITICAL)
hecho = correr(token=None)
ok(hecho is False and not pasos, "sin token no se llama a nadie")
antes = panel_mod._SUPERVISOR
panel_mod._SUPERVISOR = "http://127.0.0.1:8478"               # nadie ahí
os.environ["SUPERVISOR_TOKEN"] = "tok-de-prueba"
hecho = asyncio.run(panel_mod.reinscribir())
panel_mod._SUPERVISOR = antes
logging.disable(logging.NOTSET)
ok(hecho is False, "un Supervisor que no contesta tampoco tira la app")

print("\n8 · el config.yaml")
with open(camino.CONFIG_YAML) as f:
    cfg = f.read()
ok("\npanel_admin: false\n" in cfg, "`panel_admin: false`, que es la mitad del asunto")
ok("\ningress: true\n" in cfg, "con ingress, que es la otra mitad")
ok("\nhomeassistant_api: true\n" in cfg,
   "y con acceso al proxy de Core, que es por donde va la reinscripción")

print("\n9 · el arranque no espera al Supervisor")
import inspect                                                # noqa: E402
import main                                                   # noqa: E402
fuente = inspect.getsource(main.lifespan)
ok("create_task(panel.reinscribir())" in fuente, "se lanza como tarea y no con `await`")
ok("await panel.reinscribir()" not in fuente,
   "para que un Core lento no retrase el servidor")

servidor.shutdown()
print()
if fallos:
    print("--- fallos ---")
    for f in dict.fromkeys(fallos):
        print("  " + f)
print(f"{len(fallos)} fallos" if fallos else "todo en verde")
sys.exit(1 if fallos else 0)

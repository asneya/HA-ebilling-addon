/* La única puerta al servidor. Rutas relativas, para funcionar tras el Ingress. */
import { setBusy } from "./dom.js";

export async function api(path, options = {}) {
  setBusy(1);
  try {
    const resp = await fetch(`api/${path}`, {
      headers: { "Content-Type": "application/json" }, ...options,
    });
    if (!resp.ok) {
      let detail = `Error ${resp.status}`;
      try { detail = (await resp.json()).detail || detail; } catch (_) { /* noop */ }
      throw new Error(detail);
    }
    return resp.json();
  } finally {
    setBusy(-1);
  }
}

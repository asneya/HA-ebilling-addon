/* Un aviso de error con su salida: el §04 pide que el banner ofrezca la acción
   —«Reintentar»— en vez de dejar a la persona con el mensaje y nada que hacer. */
import { esc } from "./dom.js";

export function fallo(banner, mensaje, reintentar, opciones) {
  const texto = (opciones && opciones.html) ? mensaje : esc(mensaje);
  banner.innerHTML = `<div>${texto}</div>` + (reintentar
    ? `<div class="banner-act"><button type="button" class="btn subtle">Reintentar</button></div>`
    : "");
  const boton = banner.querySelector("button");
  if (boton) {
    boton.addEventListener("click", () => {
      banner.classList.add("hidden");
      reintentar();
    });
  }
  banner.classList.remove("hidden");
}

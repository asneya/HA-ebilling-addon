/*
 * El estado «Guardando» del §04, para botones e interruptores.
 *
 * Hasta ahora un guardado lento no daba ninguna señal: el botón se quedaba
 * igual y no había forma de saber si el toque había entrado, así que se volvía a
 * pulsar. El catálogo lo pide como un estado del control, no como un aviso
 * aparte, y para el interruptor es literal: «el pulgar se detiene a medio camino
 * y gira hasta la respuesta».
 *
 * Uso:
 *   const listo = guardando(boton);          // o guardando(interruptor)
 *   try { await api(...); } finally { listo(); }
 */
const ESPERA_MS = 140;

/* Marca el control como ocupado y devuelve la función que lo suelta.
   Se espera un pelín antes de marcarlo: un guardado de 40 ms no debe provocar
   un parpadeo, que se lee como un fallo y no como una respuesta. */
export function guardando(control, texto = "Guardando…") {
  if (!control) return () => {};
  const antes = control.textContent;
  let puesto = false;
  const reloj = setTimeout(() => {
    puesto = true;
    control.classList.add("guardando");
    control.setAttribute("aria-busy", "true");
    if (control.tagName === "BUTTON") control.textContent = texto;
    // El control queda inerte mientras espera, pero sin `disabled`: eso le
    // quitaría el foco del teclado a media operación.
    control.style.pointerEvents = "none";
  }, ESPERA_MS);

  return () => {
    clearTimeout(reloj);
    if (!puesto) return;
    control.classList.remove("guardando");
    control.removeAttribute("aria-busy");
    if (control.tagName === "BUTTON") control.textContent = antes;
    control.style.pointerEvents = "";
  };
}

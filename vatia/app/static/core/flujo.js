/*
 * Lo que se puede decir de un reparto de energía: el estado, el titular, el
 * autoconsumo y el coste del instante.
 *
 * Vive fuera del componente y fuera de las pantallas porque lo usan los dos
 * sitios que enseñan el flujo —la tarjeta de la Home y la pantalla del día— y
 * las copias son literales del diseño. Con la cuenta en cada pantalla, la Home
 * y el detalle acabarían diciendo cosas distintas del mismo instante.
 *
 * Las ocho ramas del titular van en el orden del diseño, y el orden importa: las
 * de batería exigen que la red no aporte nada, y la cuarta exige además que el
 * sol esté a cero. Si se relaja —dejar que la cuarta salte con cualquier aporte
 * de batería— el titular contradice al diagrama a las horas en que el sol cubre
 * el 90 % y la batería remata el resto.
 */
import { fmtEUR, nf4 } from "./format.js";

/* Un decimal siempre, la misma regla que usa el propio diagrama para sus
   etiquetas. Tiene que ser la misma: el titular dice «2,0 kW se van a la red» y
   justo debajo la cinta pone su valor, y dos formatos distintos del mismo número
   se leen como dos números. */
const nf1 = new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: 1, maximumFractionDigits: 1,
});

// Por debajo de esto no hay corriente que contar: es ruido del sensor. El
// diseño corta en 10 W; aquí en 20, que es donde ya cortaba el diagrama.
export const MIN_W = 20;

/* Potencia como la escribe esta app: vatios por debajo del kilovatio.
   El diseño lo pone todo en kW con dos decimales; se conserva la convención de
   la app, que es la de la fila de contadores y la de los gráficos, para que el
   mismo caudal no se lea de dos maneras en la misma pantalla. */
export function pot(w) {
  const v = Math.max(w || 0, 0);
  return v < 1000 ? `${Math.round(v)} W` : `${nf1.format(v / 1000)} kW`;
}

/* Las seis corrientes, con el nombre de cada una en /api/live. */
function partes(flows) {
  const g = (k) => Math.max(flows?.[k] || 0, 0);
  return {
    solCasa: g("solar_home"), solBat: g("solar_battery"), solRed: g("solar_grid"),
    batCasa: g("battery_home"), redCasa: g("grid_home"), redBat: g("grid_battery"),
  };
}

/* Los tres estados del diseño, con su copia y su color. */
export function estado(flows) {
  const p = partes(flows);
  if (p.solRed >= MIN_W) return { clave: "export", texto: "Vendiendo a la red" };
  if (p.redCasa >= MIN_W || p.redBat >= MIN_W) return { clave: "import", texto: "Comprando de la red" };
  return { clave: "libre", texto: "Independiente" };
}

/* El titular, palabra por palabra del diseño. `precio` en €/kWh o null. */
export function titular(flows, precio) {
  const p = partes(flows);
  const hay = (v) => v >= MIN_W;
  const exporta = hay(p.solRed);
  if (exporta && hay(p.solBat))
    return `El sol cubre la casa, llena la batería y aún sobra: ${pot(p.solRed)} se van a la red.`;
  if (exporta)
    return `Batería llena y casa cubierta. Todo el excedente, ${pot(p.solRed)}, sale a la red.`;
  if (hay(p.solBat))
    return `Sobra sol y va entero a la batería: ${pot(p.solBat)} guardados para la noche.`;
  if (hay(p.batCasa) && !hay(p.redCasa) && !hay(p.solCasa))
    return `Sin nada de sol, la batería lleva la casa sola con ${pot(p.batCasa)}.`;
  if (hay(p.batCasa) && !hay(p.redCasa))
    return `El sol pone ${pot(p.solCasa)} y la batería remata los ${pot(p.batCasa)} que faltan: cero red.`;
  if (hay(p.redCasa) && hay(p.batCasa))
    return `La batería aporta ${pot(p.batCasa)} y la red completa los ${pot(p.redCasa)} que faltan.`;
  if (hay(p.redCasa) && hay(p.solCasa))
    return `El sol cubre ${pot(p.solCasa)} y la red pone los ${pot(p.redCasa)} restantes.`;
  if (hay(p.redCasa)) {
    // El diseño cierra aquí nombrando el precio. Sin tarifa «la mía» no hay
    // precio que nombrar, y antes que inventárselo se dice el resto.
    return precio == null
      ? `Toda la casa va con red: ${pot(p.redCasa)} comprados.`
      : `Toda la casa va con red: ${pot(p.redCasa)} comprados a ${nf4.format(precio)} €/kWh.`;
  }
  // Cargar la batería desde la red de noche: el prototipo del diseño no puede
  // producirlo —su reparto no tiene ese enlace— pero un inversor real sí.
  if (hay(p.redBat))
    return `La red carga la batería: ${pot(p.redBat)} para tenerlos cuando hagan falta.`;
  return "Ahora mismo no circula nada.";
}

/* Autoconsumo: la parte del consumo de la casa que pones tú. */
export function autoconsumo(flows) {
  const p = partes(flows);
  const casa = p.solCasa + p.batCasa + p.redCasa;
  if (casa < MIN_W) return 100;
  return Math.round(((p.solCasa + p.batCasa) / casa) * 100);
}

/* Coste del instante en €/h: lo que entra por la red menos lo que compensa el
   excedente. `null` si no hay precio, que es distinto de valer cero. */
export function coste(flows, precio, precioExcedente) {
  if (precio == null) return null;
  const p = partes(flows);
  const compra = (p.redCasa + p.redBat) / 1000;
  const vierte = p.solRed / 1000;
  return compra * precio - vierte * (precioExcedente || 0);
}

export function costeTexto(eur) {
  if (eur == null) return "—";
  const signo = eur < 0 ? "−" : "";
  return signo + fmtEUR.format(Math.abs(eur));
}

/* Las dos notas de las tarjetas pequeñas. */
export function notaBateria(flows, soc) {
  const p = partes(flows);
  if (p.solBat >= MIN_W) return `cargando a ${pot(p.solBat)}`;
  if (p.redBat >= MIN_W) return `cargando de la red a ${pot(p.redBat)}`;
  if (p.batCasa >= MIN_W) return `dando ${pot(p.batCasa)} a la casa`;
  if (soc != null && soc >= 99) return "llena, en reposo";
  return "en reposo";
}

export function tarjetaRed(flows, precio, precioExcedente) {
  const p = partes(flows);
  const exporta = p.solRed >= MIN_W;
  const compra = p.redCasa + p.redBat;
  if (exporta) {
    const abona = precioExcedente ? (p.solRed / 1000) * precioExcedente : null;
    return {
      titulo: "A la red", w: p.solRed, clase: "exp",
      nota: abona == null ? "excedente vertido" : `compensa ${fmtEUR.format(abona)}/h`,
    };
  }
  if (compra >= MIN_W) {
    const cuesta = precio == null ? null : (compra / 1000) * precio;
    return {
      titulo: "De la red", w: compra, clase: "imp",
      nota: cuesta == null ? "comprada de la red" : `cuesta ${fmtEUR.format(cuesta)}/h`,
    };
  }
  return { titulo: "De la red", w: 0, clase: "nada", nota: "sin intercambio" };
}

/* ---------------- qué componente dibuja el flujo ----------------
   Dos de la galería de Ajustes, y las dos con la misma interfaz (`data`,
   `flows`, `meters`, `split`), así que las pantallas piden el nodo y no se
   enteran de cuál les ha tocado. El catálogo vive aquí porque lo leen la
   galería, la tarjeta de la Home y la pantalla del día. */
export const FLOWS = [
  {
    id: "sankey",
    tag: "vatia-flow",
    name: "Caudales",
    claim: "Cada cinta mide su potencia",
    detalle: "Sankey de dos columnas. El único que parte la casa en "
      + "electrodomésticos, con su nombre y su valor.",
  },
  {
    id: "orbita",
    tag: "vatia-orbit",
    name: "Órbita",
    claim: "La casa en el centro",
    detalle: "El consumo en grande y un anillo diciendo de quién es. Los "
      + "electrodomésticos, como anillo dentro y sin nombre.",
  },
];

export function estiloFlujo(settings) {
  const id = settings && settings.flow_style;
  return FLOWS.find((f) => f.id === id) || FLOWS[0];
}

/* El nodo del diagrama dentro de `host`, creado si falta y **sustituido** si el
   usuario ha cambiado de estilo. Sustituido y no reconfigurado: son dos
   elementos personalizados distintos, y dejar el viejo puesto era el error que
   hacía que la galería no cambiara nada hasta recargar la página. */
export function montarFlujo(host, settings, { meters = true } = {}) {
  const estilo = estiloFlujo(settings);
  let node = host.querySelector(estilo.tag);
  if (!node) {
    host.textContent = "";
    node = document.createElement(estilo.tag);
    node.meters = meters;
    host.appendChild(node);
  }
  return node;
}

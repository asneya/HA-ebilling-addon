# Diseños de origen

Lo que hay aquí no es código: son las **referencias de diseño** de las que sale
la interfaz, guardadas junto al código para que dentro de un año se pueda
comprobar contra qué se implementó cada cosa.

Los `.dc.html` vienen de [Claude Design](https://claude.ai/design) y usan un
runtime de prototipado propio (`support.js`, etiquetas `<x-dc>`, plantillas con
`{{ }}`). **No se portan**: son maquetas que enseñan aspecto y comportamiento, no
producción. Se guardan sin ese runtime, así que no se abren en un navegador —
para leerlos, se leen.

| Fichero | Qué es |
|---|---|
| `flujo-energia-v2-handoff.md` | La especificación en prosa del flujo de energía v2: geometría del Sankey, reparto de flujos, copias exactas y tokens. Es el documento que manda. |
| `flujo-energia-v2.dc.html` | La maqueta de la que sale esa especificación. |

Implementado en la 0.37.0. Las desviaciones deliberadas respecto a la maqueta
están anotadas en el `CHANGELOG.md` de esa versión y en los comentarios de
`vatia/app/static/components/vatia-flow.js`.

En la **0.46.0** se retiraron dos controles que la maqueta sí trae: los chips de
hora (`Amanecer`, `Mediodía`, `Tarde`, `Noche`) y el botón `Ver el día entero`
que animaba la jornada. Con datos reales el deslizador los deja sin oficio: las
franjas caen en horas arbitrarias y la animación se mira una vez. Del bloque
queda solo el camino de vuelta, `Volver a ahora`, dentro de la tarjeta del día.

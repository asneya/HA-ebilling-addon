# El banco

Regresión de Vatia: 25 bancos, unos de Python y otros de navegador.

```bash
python3 tests/run.py                 # todo
python3 tests/run.py resumen         # solo los que se llamen así
python3 tests/run.py --solo-python   # sin navegador (no hace falta Playwright)
```

El lanzador levanta lo que haga falta —los Home Assistant e InfluxDB de mentira,
un servidor de ficheros y una instancia de la aplicación por cada configuración
de partida—, pasa los bancos, y lo apaga todo al terminar. Cada uno deja su
salida completa en `tests/.reg/<banco>.log`, que es lo que hay que mirar cuando
uno se pone en rojo.

## Antes de la primera vez

```bash
pip install -r vatia/app/requirements.txt -r tests/requirements.txt
cd tests && npm ci && npx playwright install chromium   # solo para los de navegador
```

En un contenedor donde Chromium ya venga instalado, `tests/navegador/camino.js`
lo encuentra bajo `PLAYWRIGHT_BROWSERS_PATH` sin que haya que instalarlo. Y
`VATIA_CHROMIUM` fuerza uno concreto si hiciera falta.

## Cómo está montado

```
tests/
  run.py          el lanzador: levanta, pasa, apaga
  python/         bancos de Python; `camino.py` sabe dónde está el repositorio
  navegador/      bancos de Playwright; `camino.js` resuelve el navegador
  falsos/         Home Assistant e InfluxDB de mentira
  fixtures/       configuración de partida de cada instancia de la aplicación
```

Las fixtures **se copian** a un directorio temporal en cada ejecución. Los
bancos escriben en la configuración —crean usuarios, cambian roles, guardan
sesgos—, así que apuntando al repositorio lo ensuciarían y la segunda vuelta no
daría lo mismo que la primera.

Los puertos están fijos y escritos en `run.py`, que son los que cada banco
espera por defecto: mientras se trabaja en uno se puede lanzar suelto
(`cd tests/python && python3 resumen.py`) con los servidores ya levantados.

## Cómo se escribe un banco

No hay framework, y es a propósito. Un banco es un programa que imprime lo que
comprueba, en castellano, y termina diciendo **`todo en verde`** o cuántos
fallos ha encontrado. Se lee de arriba abajo como se leería la explicación de
por qué algo funciona:

```
1-3 · los dos techos que faltaban
  ok    lo importado se reparte entero · exportación por delante del solar (0.030 = 0.030)
  ok    lo descargado también · atardecer: la batería alimenta la casa (0.200 = 0.200)
  ok    una carga de red de madrugada sigue siendo de red (0.250)
```

Las reglas que se han ido ganando a base de disgustos:

- **La cabecera del fichero cuenta el fallo que motivó el banco**, con números
  reales. Dentro de un año eso es lo único que explica por qué existe.
- **Cada comprobación lleva las cifras en el texto.** «Desde la red no se
  aplasta» no dice nada; `(6,20 de 6,20 kWh)` sí, y en rojo dice dónde mirar.
- **Un banco nuevo se verifica en rojo antes de darlo por bueno**: se rompe el
  arreglo a mano, se comprueba que el banco lo caza, y se deshace. Un banco que
  nunca ha fallado no ha demostrado que sirva para nada.
- **Nada que dependa de la hora del día ni del orden de ejecución.** Dos bancos
  cayeron por esto: uno pasaba por la mañana y fallaba por la tarde, y otro solo
  pasaba la primera vez.
- El veredicto va en la **última línea**: es lo que lee el lanzador.

Para añadirlo a la regresión, una línea en la lista `PYTHON` o `NAVEGADOR` de
`run.py`.

## El CI

`.github/workflows/tests.yml` pasa todo esto en cada push y en cada pull
request. Si algo se pone rojo, los registros de `tests/.reg/` quedan colgados
como artefacto de la ejecución.

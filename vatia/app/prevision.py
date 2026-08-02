"""Lo que tu tejado corrige de la previsión.

Ninguna previsión solar sabe de tu casa. Sabe de irradiancia, de nubes y de la
orientación que se tecleó al configurarla, pero no de la chimenea que da sombra
hasta las diez, ni del árbol del vecino, ni de que los paneles llevan dos años
sin limpiarse. Eso es un sesgo **sistemático**: aparece a la misma hora todos
los días, y por eso se puede aprender.

Lo que se aprende es un factor por hora: la mediana de ``real / previsto`` a esa
hora en los últimos días. Un 0,6 a las nueve significa «a las nueve tu tejado da
el 60 % de lo que promete la previsión». No es un modelo del tiempo —para eso ya
está la previsión, que mira el cielo y hace física— sino la diferencia constante
entre lo que promete y lo que sale.

**De dónde salen los pares.** Home Assistant no guarda las previsiones pasadas:
el `detailedForecast` es un atributo, y los atributos no van a las estadísticas
de largo plazo. Así que no se puede mirar atrás y preguntar «¿qué decía la
previsión anteayer a las dos?». Lo que sí se puede es mirar **lo que queda de
hoy hacia atrás**: la previsión de hoy incluye las horas que ya han pasado, y la
producción real de esas horas está en las estadísticas. De ahí sale un día
entero de pares en cada arranque, y guardándolos se acumula el histórico que HA
no guarda.

Lo que **no** hace, a propósito:

- No corrige el tiempo. Si hoy hay nubes que la previsión no vio, esto no se
  entera: eso lo arregla el factor en vivo, que compara la producción de este
  momento con la prevista para este momento.
- No inventa con dos datos. Hace falta un mínimo de días por hora; por debajo,
  esa hora se queda sin corregir.
- No se desboca. El factor se recorta, porque un día raro con la previsión casi
  a cero da cocientes absurdos.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import date, datetime
from statistics import median
from typing import Any

_LOGGER = logging.getLogger(__name__)

# Días de histórico que se guardan. Con treinta hay de sobra para una mediana
# por hora y el sesgo sigue al sol: en dos meses la sombra de las nueve ya no
# cae a la misma hora, así que una ventana más larga envejecería mal.
DIAS = 30
# Días con dato para creerse una hora. Con menos, la mediana es un día suelto.
MIN_DIAS = 4
# Por debajo de esto la previsión de esa hora no da para un cociente: dividir
# entre casi nada convierte cualquier diferencia en un factor enorme.
MIN_PREVISTO_WH = 150.0
# El recorte. Un tejado puede dar la mitad de lo prometido a una hora de sombra,
# y algo más de lo prometido si la previsión es conservadora; fuera de ahí lo
# que hay es un sensor mal configurado, y eso no se arregla multiplicando.
MIN_FACTOR, MAX_FACTOR = 0.35, 1.6

_lock = threading.Lock()


def _ruta(config_dir: str) -> str:
    return os.path.join(config_dir, "vatia-prevision.json")


def version(config_dir: str) -> tuple[float, int]:
    """Sello del fichero, para saber si hay que releerlo.

    Quien lo use puede cachear el resultado de `aprender` y comprobar esto en
    cada llamada: un `stat` cuesta nada y un `json.load` de treinta días, no
    tanto pero sí lo suficiente como para no hacerlo cada veinte segundos. Con
    un sello en vez de un temporizador la corrección aparece en cuanto hay dato
    nuevo, en lugar de cuando toque.
    """
    try:
        st = os.stat(_ruta(config_dir))
    except OSError:
        return (0.0, 0)
    return (st.st_mtime, st.st_size)


def _leer(config_dir: str) -> dict[str, Any]:
    try:
        with open(_ruta(config_dir), encoding="utf-8") as fh:
            datos = json.load(fh)
    except (OSError, ValueError):
        return {}
    return datos.get("dias") or {} if isinstance(datos, dict) else {}


def _escribir(config_dir: str, dias: dict[str, Any]) -> None:
    destino = _ruta(config_dir)
    tmp = destino + ".tmp"
    try:
        os.makedirs(os.path.dirname(destino), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"dias": dias}, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, destino)   # atómico: nunca se lee a medias
    except OSError:
        _LOGGER.warning("No se pudo guardar el histórico de previsión", exc_info=True)


def registrar(
    config_dir: str,
    dia: date,
    previsto: dict[int, float],
    real: dict[int, float],
) -> None:
    """Guarda los pares (previsto, real) de un día, en Wh por hora.

    Se reescribe el día entero en cada pasada: las horas de hoy se van
    completando según avanza, y la última versión es la buena. Los días viejos
    se caen solos al pasar de ``DIAS``.

    Las horas de noche no se guardan. Nunca van a dar un cociente —la previsión
    ahí es cero— y el fichero vive en la carpeta del add-on, donde se puede
    abrir: catorce ceros por delante de los datos lo hacen ilegible.
    """
    horas = {
        str(h): [round(previsto[h], 1), round(real[h], 1)]
        for h in sorted(set(previsto) & set(real))
        if previsto[h] >= MIN_PREVISTO_WH
    }
    if not horas:
        return
    with _lock:
        dias = _leer(config_dir)
        dias[dia.isoformat()] = horas
        for viejo in sorted(dias)[:-DIAS]:
            del dias[viejo]
        _escribir(config_dir, dias)


class Sesgo:
    """El factor por hora, ya aprendido. ``factor(t)`` vale 1 si no se sabe."""

    def __init__(self, por_hora: dict[int, float], muestras: dict[int, int]):
        self._por_hora = por_hora
        self._muestras = muestras

    def __bool__(self) -> bool:
        return bool(self._por_hora)

    def factor(self, momento: datetime) -> float:
        return self._por_hora.get(momento.hour, 1.0)

    def aplicar(
        self, puntos: list[tuple[datetime, float]]
    ) -> list[tuple[datetime, float]]:
        """La curva de previsión con el sesgo de cada hora ya aplicado."""
        if not self._por_hora:
            return puntos
        return [(t, w * self.factor(t)) for t, w in puntos]

    def payload(self) -> dict[str, Any]:
        """Lo que se enseña de él: qué horas corrige y cuánto."""
        if not self._por_hora:
            return {"horas": 0, "dias": 0, "peor": None, "factores": {}}
        peor = max(self._por_hora.items(), key=lambda par: abs(par[1] - 1.0))
        return {
            "horas": len(self._por_hora),
            "dias": max(self._muestras.values()),
            # La hora que más se desvía, que es la que explica la corrección.
            "peor": {"hora": peor[0], "factor": round(peor[1], 2)},
            "factores": {str(h): round(f, 2) for h, f in sorted(self._por_hora.items())},
        }


def aprender(config_dir: str) -> Sesgo:
    """Lee el histórico y saca la mediana de ``real / previsto`` por hora.

    Mediana y no media: un día con una nube justo encima del panel a las doce no
    puede desplazar la corrección de todos los mediodías. Las horas sin muestras
    suficientes no salen, y entonces ``factor()`` devuelve 1 y esa hora se queda
    tal y como la da la previsión.
    """
    with _lock:
        dias = _leer(config_dir)
    ratios: dict[int, list[float]] = {}
    for horas in dias.values():
        if not isinstance(horas, dict):
            continue
        for clave, par in horas.items():
            try:
                previsto, real = float(par[0]), float(par[1])
                hora = int(clave)
            except (TypeError, ValueError, IndexError):
                continue
            if previsto < MIN_PREVISTO_WH or real < 0:
                continue
            ratios.setdefault(hora, []).append(real / previsto)
    por_hora, muestras = {}, {}
    for hora, valores in ratios.items():
        if len(valores) < MIN_DIAS:
            continue
        factor = max(MIN_FACTOR, min(median(valores), MAX_FACTOR))
        # Una corrección del 5 % no la nota nadie y ensucia la explicación.
        if abs(factor - 1.0) < 0.05:
            continue
        por_hora[hora] = factor
        muestras[hora] = len(valores)
    return Sesgo(por_hora, muestras)


def por_horas(puntos: list[tuple[datetime, float]]) -> dict[int, float]:
    """Wh por hora del día a partir de una curva de potencia (W).

    Integra por trapecios entre puntos consecutivos y reparte cada tramo en la
    hora en la que empieza. La previsión viene cada media hora o cada hora, así
    que ningún tramo cruza dos horas enteras y el reparto es exacto; si alguna
    fuente diera pasos más largos, el error se queda dentro de la hora vecina.
    """
    out: dict[int, float] = {}
    for i in range(len(puntos) - 1):
        (t0, w0), (t1, w1) = puntos[i], puntos[i + 1]
        horas = (t1 - t0).total_seconds() / 3600.0
        if horas <= 0:
            continue
        out[t0.hour] = out.get(t0.hour, 0.0) + (w0 + w1) / 2.0 * horas
    return out

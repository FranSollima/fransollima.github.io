# Prode Mundial 2026

App estática para seguir un prode del Mundial 2026 en tiempo real. Vive en GitHub Pages, no tiene servidor, no tiene build: es un HTML + CSS + JS que consulta la API pública de ESPN directamente desde el browser.

## Cómo funciona

- Los resultados de los partidos los levanta automáticamente de ESPN cada 10 segundos cuando hay un partido en vivo, o cada 5 minutos cuando no hay ninguno.
- Las predicciones de cada jugador están en `predicciones.csv`.
- El puntaje se calcula en el browser: 3 puntos por marcador exacto, 1 punto por resultado correcto (ganador/empate), 0 si erró.
- **Los partidos de eliminatoria se puntúan a los 90 minutos reglamentarios**, sin contar prórroga ni penales.

## Archivos de datos

| Archivo | Qué contiene | Cuándo editarlo |
|---|---|---|
| `predicciones.csv` | Las apuestas de cada jugador para cada partido | Al inicio del torneo (o si hay correcciones) |
| `equipos.csv` | Mapeo nombre en español → abreviatura ESPN | Si aparece un equipo sin mapeo (ver consola del browser) |
| `jugadores.csv` | Mapeo código → nombre para mostrar | Para cambiar cómo se muestra el nombre de alguien |

### Formato de predicciones.csv

```
JUGADOR;PARTIDO;EQUIPO 1;EQUIPO 2;GOLES 1;GOLES 2
FS;ARG-BRA;ARGENTINA;BRASIL;2;1
```

- Separador: `;`
- `JUGADOR`: código corto (ej. `FS`, `DM`)
- `PARTIDO`: identificador libre, solo se usa como referencia
- `EQUIPO 1` / `EQUIPO 2`: nombre en español, tiene que tener mapeo en `equipos.csv`
- `GOLES 1` / `GOLES 2`: predicción de goles para equipo 1 y 2

### Formato de equipos.csv

```
ES;ESPN_ABBR
ARGENTINA;ARG
HOLANDA;NED
```

Si al cargar la app ves una advertencia en la consola del browser del tipo `⚠ Sin mapeo en equipos.csv: "XXXX"`, hay que agregar esa fila.

### Formato de jugadores.csv

```
CODIGO;NOMBRE
FS;Fran
DM;Dani
```

## Ranking

La tabla principal muestra puntos confirmados. Si hay un partido en vivo que afecta los puntos de alguien, aparece el formato `44 (+1)`: el número base son los puntos ya cerrados, el `(+X)` en naranja es provisorio y se ajusta con el resultado final.

En caso de empate en puntos, el desempate es: más marcadores exactos → nombre alfabético.

## Probabilidades en vivo

Cuando hay un partido en curso, cada card de partido muestra una barra con las probabilidades estimadas de victoria local, empate y victoria visitante. Si ESPN tiene odds de casas de apuesta disponibles, los usa; si no, calcula las probabilidades con un modelo Poisson basado en los tiros al arco del partido.

## Deploy

Se publica automáticamente en GitHub Pages con cada push a `main`. No hay build step.

## Actualizar datos

Para corregir o agregar predicciones: editar `predicciones.csv` y hacer push. El browser recarga los CSV frescos en cada refresh.

Si un equipo no mapea, agregar la fila en `equipos.csv` con la abreviatura de 3 letras que usa ESPN (se puede verificar mirando la red en `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard`).

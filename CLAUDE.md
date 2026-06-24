# CLAUDE.md — Prode Mundial 2026

Contexto técnico para Claude Code. Leer antes de hacer cualquier cambio.

## Qué es este proyecto

App estática (HTML/CSS/JS vanilla, sin frameworks, sin build step) deployada en GitHub Pages. El browser llama directamente a la API pública de ESPN para obtener resultados en vivo y los cruza con las predicciones de los jugadores cargadas en CSV.

Restricciones duras:
- Sin dependencias externas (ni siquiera npm)
- Sin servidor — todo corre en el cliente
- `index.html` en la raíz, paths relativos (`./assets/...`)
- Compatible con GitHub Pages (archivos estáticos, nada de SSR)

## Arquitectura

```
index.html          ← estructura HTML, dos paneles: Ranking y Partidos
assets/
  app.js            ← toda la lógica (único archivo JS)
  styles.css        ← CSS mobile-first, sin frameworks
equipos.csv         ← mapeo nombre ES → abreviatura ESPN (ej. HOLANDA → NED)
jugadores.csv       ← mapeo código → nombre para mostrar (ej. FS → Fran)
predicciones.csv    ← 792 filas: 11 jugadores × 72 partidos
```

## API ESPN

```
GET https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?limit=200&dates=20260611-20260719
```

- Sin auth, CORS abierto
- Devuelve todos los partidos del torneo en un solo request
- Campos relevantes por evento:
  - `event.date` — ISO timestamp UTC
  - `competition.status.type.state` — `"pre"` / `"in"` / `"post"`
  - `competition.status.period` — período actual; `> 2` indica prórroga/penales (ET=3/4, penales=5)
  - `competition.status.displayClock` — reloj en vivo (ej. `"67'"`)
  - `competitor.homeAway` — `"home"` o `"away"`
  - `competitor.team.abbreviation` — abreviatura de 3 letras (ej. `"ARG"`)
  - `competitor.score` — goles totales (incluye ET si hubo)
  - `competitor.statistics[].name` / `.displayValue` — estadísticas por equipo (ej. `"shotsOnTarget"`)
  - `competition.odds[0].moneyline.home/draw/away.current.odds` — odds en formato americano (fuente: DraftKings vía ESPN); puede estar ausente

**Importante**: ESPN no expone desglose de goles por período en su API de soccer. Si un partido va a prórroga, el `score` incluye goles de ET. Por eso existe `MARCADOR_CUENTA = "reglamentario"` y el flag `wentToET` para mostrar un aviso `⚠ ET` en la UI.

## Lógica central en app.js

### Constantes clave

```js
const MARCADOR_CUENTA = "reglamentario"; // "reglamentario" | "final"
const POLL_LIVE_MS = 10_000;   // refresco con partido en vivo
const POLL_IDLE_MS = 60_000;   // refresco sin partidos en vivo
```

### Matching equipo predicción ↔ evento ESPN

Se usa `pairKey(a, b)` — concatenación ordenada lexicográficamente — para hacer el lookup independiente del orden home/away:

```js
function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
```

Luego se mapean los goles al orden pred.equipo1/pred.equipo2 con:

```js
const realG1 = ev.homeAbbr === pred.abbr1 ? ev.homeScore : ev.awayScore;
const realG2 = ev.homeAbbr === pred.abbr1 ? ev.awayScore : ev.homeScore;
```

### Puntuación

```js
function calcPuntos(predG1, predG2, realG1, realG2) {
  if (predG1 === realG1 && predG2 === realG2) return 3; // exacto
  if (Math.sign(predG1 - predG2) === Math.sign(realG1 - realG2)) return 1; // resultado
  return 0;
}
```

3 puntos y 1 punto son mutuamente excluyentes (no se acumulan).

### Puntos provisorios vs confirmados

`buildRanking` separa `ptsPost` (partidos terminados) y `ptsLive` (partidos en vivo). El ranking ordena por `ptsPost + ptsLive` pero la UI muestra `"44 (+1)"` para que se vea la diferencia. Al terminar el partido en vivo, el `(+X)` desaparece y el número base sube.

Criterios de desempate en el ranking: total de puntos → cantidad de exactos → nombre alfabético.

### Ordenamiento del panel Partidos

`groupByMatch` pone primero los partidos con `state === "in"`, luego ordena por fecha del evento. Dentro de cada partido, las predicciones se ordenan por: puntos desc → resultado predicho (equipo1 gana / empate / equipo2 gana) → marcador → nombre del jugador.

### Probabilidades en vivo

Durante partidos en vivo, `renderLiveStats` muestra una barra de probabilidades con porcentajes win/draw/lose. La fuente de datos sigue esta prioridad:

1. **Odds de casas de apuesta** (`competition.odds[0].moneyline` vía ESPN/DraftKings): se convierten de formato americano a probabilidad con `americanToProb()` y se normalizan para sumar 100%.
2. **Modelo Poisson** (fallback): usa tiros al arco (`shotsOnTarget`) como proxy de xG. Constantes: `XG_PER_SOT = 0.10` (xG por tiro) y `PRIOR_RATE = 1.1/90` (tasa base por minuto). El modelo mezcla la tasa observada con el prior según cuántos minutos se jugaron (`w = min(minPlayed/30, 1)`). Simula hasta 8 goles adicionales por equipo via Poisson.

Si el partido fue a prórroga (`wentToET === true`), `calcMatchProbs` devuelve `null` y no se muestran probabilidades.

### Polling

Se usa `setTimeout` (no `setInterval`) para poder cambiar el intervalo dinámicamente según si hay partidos en vivo o no. El timer se resetea con cada refresh exitoso o fallido.

## Datos CSV

Separador `;`, encoding UTF-8.

### predicciones.csv

```
JUGADOR;PARTIDO;EQUIPO 1;EQUIPO 2;GOLES 1;GOLES 2
```

- `JUGADOR`: código corto que matchea con `jugadores.csv`
- `EQUIPO 1` / `EQUIPO 2`: nombre en español, tiene que tener entrada en `equipos.csv`
- Si un equipo no tiene mapeo, se loguea `⚠ Sin mapeo en equipos.csv: "..."` en consola y ese partido queda con `estado: "sin_mapeo"`

### equipos.csv

```
ES;ESPN_ABBR
```

- Se carga en `buildEquiposMap()` → `Map<string, string>` (uppercase)
- Tiene entradas duplicadas con y sin acento para tolerancia (ej. `BÉLGICA` y `BELGICA`)
- Abreviaturas a revisar si aparecen partidos nuevos: comparar con lo que devuelve ESPN en `team.abbreviation`

### jugadores.csv

```
CODIGO;NOMBRE
```

- Se carga en `loadJugadores()` → `Map<string, string>`
- Si un código no está en el mapa, la UI muestra el código crudo como fallback

## Flujo de datos

```
init()
  ├─ buildEquiposMap()     → equiposMap (global)
  ├─ loadJugadores()       → jugadoresMap (global)
  └─ loadPredicciones()    → predicciones (global)
        └─ refresh()
              ├─ fetchESPN() → events[]
              ├─ scoreAll(predicciones, events) → scored[]
              ├─ buildRanking(scored) → ranking[]
              ├─ groupByMatch(scored) → groups[]
              ├─ renderRanking(ranking, hasLive, jugadoresMap)
              └─ renderPartidos(groups)
```

## Qué NO cambiar sin entender bien

- El orden en `pairKey` es crítico: si se cambia la lógica de sorting, todos los lookups de partidos se rompen.
- `MARCADOR_CUENTA` es una constante de configuración/documentación. No hay lógica implementada para `"final"` — ESPN no expone los goles de reglamentario separado de ET.
- Los CSVs se cargan via `fetch()` relativo. En local abriendo el HTML directo (sin servidor) falla por CORS. Usar `python3 -m http.server` o Live Server de VSCode.

## Debugging común

| Síntoma | Causa probable |
|---|---|
| Jugador con puntos incorrectos | Browser con ESPN cacheado. Hard reload: Cmd+Shift+R |
| `⚠ Sin mapeo` en consola | Falta fila en `equipos.csv` |
| Partido no aparece en Partidos | No matchea ningún evento ESPN — revisar abreviaturas |
| `(+X)` nunca desaparece | ESPN tardó en marcar el partido como `post` |
| App no carga nada | Error de CORS — no abrir `index.html` directo, usar servidor local |

## Deploy

Push a `main` → GitHub Actions publica automáticamente en GitHub Pages. No hay build. Los archivos CSV se sirven como estáticos y el browser los descarga frescos en cada sesión (sin cache agresivo).

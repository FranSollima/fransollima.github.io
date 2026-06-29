// ─── CONFIG ──────────────────────────────────────────────────────────────────
// MARCADOR_CUENTA: "reglamentario" → puntaje basado en resultado a los 90'.
// Cambiá a "final" para incluir goles de prórroga y penales.
// ADVERTENCIA: ESPN no expone desglose por período en su API de soccer. Si un
// partido llega a prórroga, el campo `score` puede incluir goles de ET.
// Cuando aparezcan partidos de fase eliminatoria, verificar el comportamiento.
const MARCADOR_CUENTA = "reglamentario";

const ESPN_URL =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard" +
  "?limit=200&dates=20260611-20260719";

const ESPN_STANDINGS_URL =
  "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings";

const POLL_LIVE_MS = 10_000;   // 10 s — hay al menos un partido en vivo
const POLL_IDLE_MS = 60_000;   // 1 min — no hay partidos en vivo

// ─── STATE ───────────────────────────────────────────────────────────────────
let pollTimer          = null;
let firstRender        = true;
let equiposMap         = null;
let displayMap         = null;
let jugadoresMap       = null;
let predicciones       = null;
let prediccionesKO     = null;
let groupStandingsData = null; // fetched once at init from ESPN standings endpoint
const probsCache    = new Map(); // ev.id → last valid { pWin, pDraw, pLose, source }
let lastEvents     = [];        // último fetch de ESPN, para usar en stats lazy
let koNumberMap    = new Map(); // eventId → matchNumber (73-104)
let koRoundIdxMap  = new Map(); // "round-of-32-1" → matchNumber
let statsCache     = null;      // resultado de buildStats(), null = no cargado aún
let statsFetching  = false;


// ─── CSV PARSER ──────────────────────────────────────────────────────────────
function parseCSV(text, sep = ";") {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(sep).map(h => h.trim());
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = line.split(sep).map(v => v.trim());
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
    });
}

async function loadText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`No se pudo cargar ${path} (${res.status})`);
  return res.text();
}

// ─── JUGADORES MAP ───────────────────────────────────────────────────────────
async function loadJugadores() {
  const text = await loadText("./jugadores.csv");
  const rows = parseCSV(text);
  const map = new Map();
  for (const row of rows) {
    const codigo = row["CODIGO"]?.trim();
    const nombre = row["NOMBRE"]?.trim();
    if (codigo && nombre) map.set(codigo, nombre);
  }
  return map;
}

// ─── EQUIPOS MAP ─────────────────────────────────────────────────────────────
async function buildEquiposMap() {
  const text = await loadText("./equipos.csv");
  const rows = parseCSV(text);
  const equipos = new Map();
  const display = new Map();
  for (const row of rows) {
    const es    = row["ES"]?.toUpperCase().trim();
    const abbr  = row["ESPN_ABBR"]?.toUpperCase().trim();
    const nombre = row["NOMBRE"]?.trim();
    if (es && abbr) {
      equipos.set(es, abbr);
      if (nombre && !display.has(abbr)) display.set(abbr, nombre);
    }
  }
  return { equipos, display };
}

// ─── PREDICCIONES ────────────────────────────────────────────────────────────
async function loadPredicciones(map) {
  const text = await loadText("./predicciones.csv");
  const rows = parseCSV(text);
  const warned = new Set();

  return rows.map(row => {
    const e1 = row["EQUIPO 1"]?.toUpperCase().trim() ?? "";
    const e2 = row["EQUIPO 2"]?.toUpperCase().trim() ?? "";
    const abbr1 = map.get(e1) ?? null;
    const abbr2 = map.get(e2) ?? null;

    if (!abbr1 && e1 && !warned.has(e1)) {
      console.warn(`⚠ Sin mapeo en equipos.csv: "${row["EQUIPO 1"]}"`);
      warned.add(e1);
    }
    if (!abbr2 && e2 && !warned.has(e2)) {
      console.warn(`⚠ Sin mapeo en equipos.csv: "${row["EQUIPO 2"]}"`);
      warned.add(e2);
    }

    return {
      jugador: row["JUGADOR"]?.trim() ?? "",
      partido: row["PARTIDO"]?.trim() ?? "",
      equipo1: row["EQUIPO 1"]?.trim() ?? "",
      equipo2: row["EQUIPO 2"]?.trim() ?? "",
      abbr1,
      abbr2,
      goles1: parseInt(row["GOLES 1"], 10),
      goles2: parseInt(row["GOLES 2"], 10),
    };
  });
}

// ─── PREDICCIONES KO ─────────────────────────────────────────────────────────
// CSV: JUGADOR;PARTIDO;LLAVE;EQUIPO 1;EQUIPO 2;GOLES 1;GOLES 2;GANADOR
// LLAVE y GANADOR se ignoran.
async function loadPredKO() {
  try {
    const text = await loadText("./predicciones_ko.csv");
    const rows = parseCSV(text);
    return rows.map(row => {
      const matchNum = parseInt(row["PARTIDO"], 10);
      const e1 = row["EQUIPO 1"]?.toUpperCase().trim() ?? "";
      const e2 = row["EQUIPO 2"]?.toUpperCase().trim() ?? "";
      return {
        jugador:  row["JUGADOR"]?.trim() ?? "",
        matchNum,
        equipo1:  row["EQUIPO 1"]?.trim() ?? "",
        equipo2:  row["EQUIPO 2"]?.trim() ?? "",
        abbr1:    equiposMap?.get(e1) ?? null,
        abbr2:    equiposMap?.get(e2) ?? null,
        goles1:   parseInt(row["GOLES 1"], 10),
        goles2:   parseInt(row["GOLES 2"], 10),
      };
    }).filter(r => !isNaN(r.matchNum) && r.jugador);
  } catch {
    return [];
  }
}

// ─── ESPN ─────────────────────────────────────────────────────────────────────
async function fetchESPN() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(ESPN_URL, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) throw new Error(`ESPN devolvió ${res.status}`);
    const data = await res.json();
    return parseESPN(data);
  } finally {
    clearTimeout(timer);
  }
}

function slugToRound(slug) {
  if (slug === "round-of-32")     return "Ronda de 32";
  if (slug === "round-of-16")     return "Octavos de Final";
  if (slug === "quarterfinals")   return "Cuartos de Final";
  if (slug === "semifinals")      return "Semifinales";
  if (slug === "3rd-place-match") return "Tercer Puesto";
  if (slug === "final")           return "Final";
  return null;
}

function parseRound(notes, event) {
  // Try all note sources: comp.notes, ev.notes, and ev.season.slug as fallback
  const headlines = [
    notes?.[0]?.headline,
    event?.notes?.[0]?.headline,
    event?.season?.slug,
  ].filter(Boolean);

  for (const h of headlines) {
    if (/round.?of.?32|r32/i.test(h))   return "Dieciseisavos de final";
    if (/round.?of.?16|r16/i.test(h))   return "Octavos de Final";
    if (/quarter.?final/i.test(h))       return "Cuartos de Final";
    if (/semi.?final/i.test(h))          return "Semifinales";
    if (/third.?place|3rd.?place/i.test(h)) return "Tercer Puesto";
    if (/\bfinal\b/i.test(h))            return "Final";
  }

  // Log unrecognized notes to help debug when knockout matches appear
  if (headlines.length > 0 && !/group/i.test(headlines[0])) {
    console.log("⚽ parseRound — headlines no reconocidos:", headlines);
  }
  return null;
}

function getStat(competitor, name) {
  const s = (competitor?.statistics ?? []).find(s => s.name === name);
  if (s == null) return null;
  const v = parseFloat(s.displayValue ?? s.value ?? 0);
  return isFinite(v) ? v : null;
}

function parseESPN(data) {
  return (data.events ?? []).map(event => {
    const comp = event.competitions?.[0];
    if (!comp) return null;

    const statusType = comp.status?.type ?? {};
    const period = comp.status?.period ?? event.status?.period ?? 0;
    const home = comp.competitors?.find(c => c.homeAway === "home");
    const away = comp.competitors?.find(c => c.homeAway === "away");

    return {
      id:          event.id,
      date:        event.date,
      name:        event.name,
      homeAbbr:    home?.team?.abbreviation?.toUpperCase() ?? null,
      awayAbbr:    away?.team?.abbreviation?.toUpperCase() ?? null,
      homeDisplay: home?.team?.displayName ?? "",
      awayDisplay: away?.team?.displayName ?? "",
      homeScore:   home?.score != null ? parseInt(home.score, 10) : null,
      awayScore:   away?.score != null ? parseInt(away.score, 10) : null,
      state:       statusType.completed ? "post" : (statusType.state ?? "pre"),
      completed:   statusType.completed ?? false,
      statusDesc:  statusType.description ?? "",
      statusName:  statusType.name ?? "",
      period,
      wentToET:    period > 2,
      displayClock:      comp.status?.displayClock ?? event.status?.displayClock ?? "",
      homeShotsOnTarget: getStat(home, "shotsOnTarget"),
      awayShotsOnTarget: getStat(away, "shotsOnTarget"),
      homeShots:         getStat(home, "shots"),
      awayShots:         getStat(away, "shots"),
      homePossession:    getStat(home, "possessionPct"),
      awayPossession:    getStat(away, "possessionPct"),
      odds: (() => {
        const ml = comp.odds?.[0]?.moneyline;
        if (!ml) return null;
        const h = ml.home?.current?.odds;
        const d = ml.draw?.current?.odds;
        const a = ml.away?.current?.odds;
        return h && d && a ? { home: h, draw: d, away: a } : null;
      })(),
      seasonSlug:  event.season?.slug ?? null,
      round: parseRound(comp.notes ?? [], event) ?? slugToRound(event.season?.slug),
    };
  }).filter(Boolean);
}

async function fetchSummary(eventId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${eventId}`,
      { cache: "no-store", signal: ctrl.signal }
    );
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function fetchGroupStandings() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(ESPN_STANDINGS_URL, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return null;
    return parseStandings(await res.json());
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function parseStandings(data) {
  // ESPN puede devolver grupos bajo 'children' o 'groups'
  const groups = data.children ?? data.groups ?? [];
  const result = [];

  for (const grp of groups) {
    const rawName = String(grp.name ?? grp.abbreviation ?? "");
    const m = rawName.match(/Group\s+([A-L])\b/i);
    if (!m) continue;

    const entries = grp.standings?.entries ?? grp.entries ?? [];
    const statVal = (stats, ...names) => {
      for (const n of names) {
        const s = (stats ?? []).find(s =>
          s.name === n ||
          s.abbreviation?.toUpperCase() === n.toUpperCase() ||
          s.shortDisplayName?.toUpperCase() === n.toUpperCase()
        );
        if (s?.value != null) return Number(s.value) || 0;
      }
      return 0;
    };

    const teams = entries.map(e => {
      const abbr = e.team?.abbreviation?.toUpperCase() ?? "";
      if (!abbr) return null;
      const st = e.stats ?? [];
      return {
        abbr,
        display: e.team?.displayName ?? "",
        pj:  statVal(st, "gamesPlayed", "GP"),
        pg:  statVal(st, "wins", "W"),
        pe:  statVal(st, "ties", "draws", "D"),
        pp:  statVal(st, "losses", "L"),
        gf:  statVal(st, "pointsFor", "goalsFor", "GF"),
        ga:  statVal(st, "pointsAgainst", "goalsAgainst", "GA"),
        pts: statVal(st, "points", "pts", "Pts", "PTS"),
        latestEv: null,
      };
    }).filter(Boolean);

    if (teams.length >= 2) result.push({ name: `Grupo ${m[1].toUpperCase()}`, teams });
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── SCORING ──────────────────────────────────────────────────────────────────
function calcPuntos(predG1, predG2, realG1, realG2) {
  if (predG1 === realG1 && predG2 === realG2) return 3;
  if (Math.sign(predG1 - predG2) === Math.sign(realG1 - realG2)) return 1;
  return 0;
}

// Canonical key for a pair of abbreviations — order-independent
function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function scoreAll(preds, events) {
  const byKey = new Map();
  for (const ev of events) {
    if (ev.homeAbbr && ev.awayAbbr) {
      byKey.set(pairKey(ev.homeAbbr, ev.awayAbbr), ev);
    }
  }

  return preds.map(pred => {
    const base = { ...pred, puntos: null, estado: "pre", event: null, realG1: null, realG2: null };

    if (!pred.abbr1 || !pred.abbr2) return { ...base, estado: "sin_mapeo" };

    const ev = byKey.get(pairKey(pred.abbr1, pred.abbr2));
    if (!ev) {
      console.warn(`⚠ Partido no encontrado en ESPN: ${pred.abbr1} vs ${pred.abbr2} (${pred.equipo1} vs ${pred.equipo2})`);
      return { ...base, estado: "no_encontrado" };
    }

    if (ev.state === "pre") return { ...base, event: ev };

    // Map ESPN home/away scores back to pred equipo1/equipo2 ordering
    const realG1 = ev.homeAbbr === pred.abbr1 ? ev.homeScore : ev.awayScore;
    const realG2 = ev.homeAbbr === pred.abbr1 ? ev.awayScore : ev.homeScore;

    if (realG1 === null || realG2 === null) {
      return { ...base, estado: ev.state, event: ev };
    }

    return {
      ...pred,
      event:  ev,
      estado: ev.state,
      realG1,
      realG2,
      puntos: calcPuntos(pred.goles1, pred.goles2, realG1, realG2),
    };
  });
}

// ─── KO SCORING ───────────────────────────────────────────────────────────────
// koEventByNum: Map<matchNum, event> — built in refresh()
function scoreKO(preds, koEventByNum) {
  return preds.map(pred => {
    const base = {
      ...pred, event: null, estado: "pre",
      llave: null, ptsLlave: 0, ptsResult: 0, ptsExacto: 0, puntos: 0,
      corrG1: null, corrG2: null, realG1: null, realG2: null,
    };

    const ev = koEventByNum.get(pred.matchNum);
    if (!ev) return base;
    if (ev.state === "pre") return { ...base, event: ev };
    if (ev.homeScore === null || ev.awayScore === null) {
      return { ...base, event: ev, estado: ev.state };
    }

    const isR32    = pred.matchNum >= 73 && pred.matchNum <= 88;
    const realHome = ev.homeAbbr, realAway = ev.awayAbbr;
    const mHome    = pred.abbr1 === realHome || pred.abbr2 === realHome;
    const mAway    = pred.abbr1 === realAway || pred.abbr2 === realAway;

    let llave = null, ptsLlave = 0;
    if (!isR32) {
      if (!mHome && !mAway) {
        return { ...base, event: ev, estado: ev.state, llave: false };
      }
      llave    = mHome && mAway;
      ptsLlave = llave ? 1 : 0;
    }

    // Align predicted goals to home/away order
    const homeIsAbbr1 = pred.abbr1 === realHome ||
      (pred.abbr2 === realAway && pred.abbr1 !== realAway);
    const corrG1 = homeIsAbbr1 ? pred.goles1 : pred.goles2;
    const corrG2 = homeIsAbbr1 ? pred.goles2 : pred.goles1;

    const realG1    = ev.homeScore, realG2 = ev.awayScore;
    const exact     = corrG1 === realG1 && corrG2 === realG2;
    const result    = Math.sign(corrG1 - corrG2) === Math.sign(realG1 - realG2);
    const ptsResult = result ? 1 : 0;
    const ptsExacto = exact ? 2 : 0;

    return {
      ...pred, event: ev, estado: ev.state,
      llave, ptsLlave, corrG1, corrG2, realG1, realG2,
      ptsResult, ptsExacto,
      puntos: ptsLlave + ptsResult + ptsExacto,
    };
  });
}

function buildRankingKO(koScored) {
  const map = new Map();
  for (const s of koScored) {
    if (!map.has(s.jugador)) {
      map.set(s.jugador, { jugador: s.jugador, llaves: 0, exactos: 0, resultados: 0, puntos: 0 });
    }
    const j = map.get(s.jugador);
    if (s.llave === true)  j.llaves++;
    if (s.ptsExacto > 0)   j.exactos++;
    else if (s.ptsResult > 0) j.resultados++;
    j.puntos += s.puntos ?? 0;
  }
  return [...map.values()].sort((a, b) =>
    b.puntos - a.puntos || b.llaves - a.llaves || b.exactos - a.exactos
  );
}

// ─── LIVE PROBABILITY (Poisson) ──────────────────────────────────────────────
const XG_PER_SOT        = 0.25;        // xG por tiro al arco (~25% conversión en élite)
const XG_PER_SHOT_WIDE  = 0.03;        // xG por tiro desviado/bloqueado
const PRIOR_RATE        = 1.1 / 90;   // tasa base: ~1.1 goles esperados por equipo cada 90'

// xG acumulado combinando SOT y tiros desviados
function calcXg(sot, shots) {
  const sotXg      = (sot   || 0) * XG_PER_SOT;
  const offTarget  = Math.max(0, (shots || 0) - (sot || 0));
  return sotXg + offTarget * XG_PER_SHOT_WIDE;
}

function parseMinute(displayClock, isHalfTime) {
  if (isHalfTime) return 45;
  if (!displayClock) return 0;
  const m = displayClock.match(/^(\d+)/);
  if (!m) return 0;
  const extra = displayClock.match(/\+(\d+)/);
  return parseInt(m[1], 10) + (extra ? parseInt(extra[1], 10) : 0);
}

function poisson(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 0; i < k; i++) p *= lambda / (i + 1);
  return p;
}

function americanToProb(str) {
  const n = parseInt(str, 10);
  return n > 0 ? 100 / (n + 100) : -n / (-n + 100);
}

function calcMatchProbs(ev) {
  if (ev.wentToET) return null;

  // Use live bookmaker odds when available (DraftKings via ESPN)
  if (ev.odds) {
    const raw = {
      home: americanToProb(ev.odds.home),
      draw: americanToProb(ev.odds.draw),
      away: americanToProb(ev.odds.away),
    };
    const total = raw.home + raw.draw + raw.away;
    const r = { pWin: raw.home / total, pDraw: raw.draw / total, pLose: raw.away / total, source: "odds" };
    if (isValidProbs(r)) return r;
    // odds malformados → fall through al modelo Poisson
  }

  // Fallback: Poisson model from shots + possession
  const isHalfTime = ev.statusName === "STATUS_HALFTIME";
  const minPlayed  = parseMinute(ev.displayClock, isHalfTime);
  const minLeft    = isHalfTime ? 45 : Math.max(0, 90 - minPlayed);
  const xgHome = calcXg(ev.homeShotsOnTarget, ev.homeShots);
  const xgAway = calcXg(ev.awayShotsOnTarget, ev.awayShots);
  // Prior pesado por posesión: más posesión → mayor tasa base esperada
  const possHome  = ev.homePossession ?? 50;
  const possAway  = ev.awayPossession ?? 50;
  const priorHome = PRIOR_RATE * (possHome / 50);
  const priorAway = PRIOR_RATE * (possAway / 50);
  const w        = Math.min(minPlayed / 30, 1);
  const rateHome = w * (xgHome / Math.max(minPlayed, 1)) + (1 - w) * priorHome;
  const rateAway = w * (xgAway / Math.max(minPlayed, 1)) + (1 - w) * priorAway;
  const lambdaHome = rateHome * minLeft;
  const lambdaAway = rateAway * minLeft;
  const hs = ev.homeScore ?? 0, as_ = ev.awayScore ?? 0;
  let pWin = 0, pDraw = 0, pLose = 0;
  for (let a = 0; a <= 8; a++) {
    for (let b = 0; b <= 8; b++) {
      const p = poisson(lambdaHome, a) * poisson(lambdaAway, b);
      const fh = hs + a, fa = as_ + b;
      if      (fh > fa) pWin  += p;
      else if (fh === fa) pDraw += p;
      else              pLose += p;
    }
  }
  const r = { pWin, pDraw, pLose, source: "poisson" };
  return isValidProbs(r) ? r : null;
}

function isValidProbs({ pWin, pDraw, pLose }) {
  return isFinite(pWin) && isFinite(pDraw) && isFinite(pLose);
}


function renderLiveStats(ev) {
  const fresh = calcMatchProbs(ev);
  if (fresh) probsCache.set(ev.id, fresh);
  const probs = fresh ?? probsCache.get(ev.id);
  if (!probs) return "";
  const { pWin, pDraw, pLose } = probs;
  const ph = Math.round(pWin  * 100);
  const pd = Math.round(pDraw * 100);
  const pa = Math.round(pLose * 100);
  const home = esc(ev.homeAbbr ?? "Local");
  const away = esc(ev.awayAbbr ?? "Visit.");

  return `<div class="live-stats">
    <div class="prob-3col prob-names">
      <span>${home}</span><span>Empate</span><span>${away}</span>
    </div>
    <div class="prob-3col prob-pcts">
      <span>${ph}%</span><span>${pd}%</span><span>${pa}%</span>
    </div>
    <div class="prob-bar-3">
      <div class="prob-seg prob-win"  style="flex:${pWin.toFixed(4)}"></div>
      <div class="prob-seg prob-draw" style="flex:${pDraw.toFixed(4)}"></div>
      <div class="prob-seg prob-lose" style="flex:${pLose.toFixed(4)}"></div>
    </div>
  </div>`;
}

function buildRanking(scored) {
  const map = new Map();
  for (const s of scored) {
    if (!map.has(s.jugador)) {
      map.set(s.jugador, { jugador: s.jugador, ptsPost: 0, ptsLive: 0, exactos: 0, resultados: 0 });
    }
    const j = map.get(s.jugador);
    if (s.puntos !== null) {
      if (s.estado === "in") j.ptsLive += s.puntos;
      else                   j.ptsPost += s.puntos;
      if (s.puntos === 3)      j.exactos++;
      else if (s.puntos === 1) j.resultados++;
    }
  }
  return [...map.values()].sort((a, b) => {
    const ta = a.ptsPost + a.ptsLive;
    const tb = b.ptsPost + b.ptsLive;
    return tb - ta || b.resultados - a.resultados;
  });
}

// FIFA official match numbers for Round of 32 — keyed by pairKey of ESPN abbreviations
const FIFA_R32 = new Map([
  ["CAN|RSA", 73], ["GER|PAR", 74], ["MAR|NED", 75], ["BRA|JPN", 76],
  ["FRA|SWE", 77], ["CIV|NOR", 78], ["ECU|MEX", 79], ["COD|ENG", 80],
  ["BIH|USA", 81], ["BEL|SEN", 82], ["CRO|POR", 83], ["AUT|ESP", 84],
  ["ALG|SUI", 85], ["ARG|CPV", 86], ["COL|GHA", 87], ["AUS|EGY", 88],
]);

// FIFA official match numbers for R16+ — keyed by UTC date prefix "YYYY-MM-DDTHH:MM"
// Times confirmed: image shows Argentina time (UTC-3), converted to UTC (+3h)
const FIFA_BY_DATE = new Map([
  // Round of 16
  ["2026-07-04T17:00", 90], ["2026-07-04T21:00", 89],
  ["2026-07-05T20:00", 91], ["2026-07-06T00:00", 92],
  ["2026-07-06T19:00", 93], ["2026-07-07T00:00", 94],
  ["2026-07-07T16:00", 95], ["2026-07-07T20:00", 96],
  // Quarterfinals
  ["2026-07-09T20:00", 97], ["2026-07-10T19:00", 98],
  ["2026-07-11T21:00", 99], ["2026-07-12T01:00", 100],
  // Semifinals
  ["2026-07-14T19:00", 101], ["2026-07-15T19:00", 102],
  // Third place & Final
  ["2026-07-18T21:00", 103], ["2026-07-19T19:00", 104],
]);

function buildKoNumbers(events) {
  koNumberMap.clear();
  koRoundIdxMap.clear();

  for (const ev of events) {
    if (ev.seasonSlug === "group-stage") continue;
    // R32: match by team pair
    const pairNum = FIFA_R32.get(pairKey(ev.homeAbbr, ev.awayAbbr));
    // R16+: match by UTC date prefix
    const dateKey = ev.date?.slice(0, 16);
    const num = pairNum ?? FIFA_BY_DATE.get(dateKey);
    if (num) koNumberMap.set(ev.id, num);
  }

  // ESPN's internal R32 index N → FIFA M(N+72), confirmed from bracket data
  for (let n = 1; n <= 16; n++) koRoundIdxMap.set(`round-of-32-${n}`, n + 72);

  // ESPN's internal R16 index N → FIFA match number (ordered by ESPN event ID)
  const r16Map = [90, 89, 91, 92, 93, 94, 96, 95];
  r16Map.forEach((num, i) => koRoundIdxMap.set(`round-of-16-${i + 1}`, num));

  // QF indices 1-4 → M97-M100 (cronológico = FIFA order)
  [97, 98, 99, 100].forEach((num, i) => koRoundIdxMap.set(`quarterfinals-${i + 1}`, num));

  // SF indices 1-2 → M101-M102
  [101, 102].forEach((num, i) => koRoundIdxMap.set(`semifinals-${i + 1}`, num));
}

function resolveKoTeam(displayName, abbr) {
  if (abbr && displayMap?.get(abbr)) return displayMap.get(abbr);
  // "Round of 32 3 Winner" → "Ganador 75"
  const m = displayName.match(/^(Round of 32|Round of 16|Quarterfinal|Semifinal)\s+(\d+)\s+(Winner|Loser)$/i);
  if (m) {
    const slugMap = {
      "round of 32":  "round-of-32",
      "round of 16":  "round-of-16",
      "quarterfinal": "quarterfinals",
      "semifinal":    "semifinals",
    };
    const slug    = slugMap[m[1].toLowerCase()];
    const idx     = parseInt(m[2]);
    const isWin   = m[3].toLowerCase() === "winner";
    const num     = koRoundIdxMap.get(`${slug}-${idx}`);
    if (num) return `${isWin ? "Ganador" : "Perdedor"} ${num}`;
  }
  // Fallback: ESPN english name (Group L Winner, Third Place Group..., etc.)
  return displayName;
}

function groupByMatch(scored, events = []) {
  const groups = new Map();
  for (const s of scored) {
    const key = pairKey(s.abbr1 ?? s.equipo1, s.abbr2 ?? s.equipo2);
    if (!groups.has(key)) {
      groups.set(key, { key, equipo1: s.equipo1, equipo2: s.equipo2, event: s.event, preds: [] });
    }
    groups.get(key).preds.push(s);
  }

  // Add knockout matches (have a round) that have no predictions yet
  for (const ev of events) {
    if (!ev.round) continue;
    if (!groups.has(ev.id)) {
      groups.set(ev.id, { key: ev.id, equipo1: ev.homeDisplay, equipo2: ev.awayDisplay, event: ev, preds: [], koPreds: [] });
    }
  }

  // Attach KO predictions to their match groups by event id
  for (const s of (arguments[2] ?? [])) {
    const evId = s.event?.id;
    if (!evId) continue;
    const g = groups.get(evId);
    if (g) g.koPreds.push(s);
  }
  const todayAR = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  const pastDay = ev => ev?.date
    ? new Date(ev.date).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }) < todayAR ? 1 : 0
    : 0;

  return [...groups.values()].sort((a, b) => {
    const inA = a.event?.state === "in" ? 0 : 1;
    const inB = b.event?.state === "in" ? 0 : 1;
    if (inA !== inB) return inA - inB;
    const pa = pastDay(a.event), pb = pastDay(b.event);
    if (pa !== pb) return pa - pb;
    const da = a.event?.date ?? "9999";
    const db = b.event?.date ?? "9999";
    return da < db ? -1 : da > db ? 1 : 0;
  });
}

// ─── RENDERING ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(new Date(iso).toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
    const dd  = String(d.getDate()).padStart(2, "0");
    const mm  = String(d.getMonth() + 1).padStart(2, "0");
    const hh  = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}, ${hh}:${min}`;
  } catch { return iso; }
}

function badgeHTML(state) {
  if (state !== "in") return "";
  return `<span class="badge in">EN VIVO</span>`;
}

function ptsClass(pts, estado) {
  if (pts === null) return estado === "pre" || estado === "no_encontrado" ? "pts-pending" : "pts-pending";
  if (pts === 3) return "pts-3";
  if (pts === 1) return "pts-1";
  return "pts-0";
}

function renderRanking(ranking, hasLive, jugMap) {
  if (!ranking.length) return '<p class="empty">No hay datos aún.</p>';

  const liveDot = hasLive ? ' <span class="live-dot" title="Hay partidos en vivo"></span>' : "";

  let html = `<h3 class="ranking-section-title">Fase de grupos</h3>
  <table class="ranking-table">
    <thead><tr>
      <th class="col-rank">#</th>
      <th class="col-name">Jugador</th>
      <th class="col-num" title="Marcador exacto = 3 pts">Exactos</th>
      <th class="col-num" title="Resultado correcto = 1 pt">Result.</th>
      <th class="col-total">Total${liveDot}</th>
    </tr></thead><tbody>`;

  let displayRank = 1;
  for (let i = 0; i < ranking.length; i++) {
    const r    = ranking[i];
    const prev = ranking[i - 1];
    const total     = r.ptsPost + r.ptsLive;
    const prevTotal = prev ? prev.ptsPost + prev.ptsLive : null;
    const tied = i > 0 && total === prevTotal && r.resultados === prev.resultados;
    if (i > 0 && !tied) displayRank = i + 1;
    const nombre = jugMap?.get(r.jugador) ?? r.jugador;
    html += `<tr>
      <td class="col-rank">${displayRank}</td>
      <td class="col-name">${esc(nombre)}</td>
      <td class="col-num">${r.exactos}</td>
      <td class="col-num">${r.resultados}</td>
      <td class="col-total">${total}</td>
    </tr>`;
  }
  html += "</tbody></table>";

  if (hasLive) {
    html += `<div class="ranking-live-note">
      <span class="live-dot"></span>
      Los puntos reflejan resultados en vivo y pueden cambiar hasta que termine el partido.
    </div>`;
  }

  return html;
}

function renderRankingKO(ranking, jugMap) {
  if (!ranking.length) return "";
  let html = `<h3 class="ranking-section-title">Eliminatorias</h3>
  <table class="ranking-table ranking-table-ko">
    <thead><tr>
      <th class="col-rank">#</th>
      <th class="col-name">Jugador</th>
      <th class="col-ko-num" title="Llaves predichas correctamente">Llaves</th>
      <th class="col-ko-num" title="Marcador exacto">Exactos</th>
      <th class="col-ko-num" title="Resultado correcto">Result.</th>
      <th class="col-ko-total">Total</th>
    </tr></thead><tbody>`;
  let displayRank = 1;
  for (let i = 0; i < ranking.length; i++) {
    const r = ranking[i];
    if (i > 0 && ranking[i].puntos !== ranking[i - 1].puntos) displayRank = i + 1;
    const nombre = jugMap?.get(r.jugador) ?? r.jugador;
    html += `<tr>
      <td class="col-rank">${displayRank}</td>
      <td class="col-name">${esc(nombre)}</td>
      <td class="col-ko-num">${r.llaves}</td>
      <td class="col-ko-num">${r.exactos}</td>
      <td class="col-ko-num">${r.resultados}</td>
      <td class="col-ko-total">${r.puntos}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  return html;
}

function renderPartidos(groups, openKeys = new Set()) {
  if (!groups.length) return '<p class="empty">No hay predicciones cargadas.</p>';

  const todayAR = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  const isPast = g => g.event?.state === "post"
    && g.event?.date
    && new Date(g.event.date).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }) < todayAR;

  const active = groups.filter(g => !isPast(g));
  const past   = [...groups.filter(isPast)].sort((a, b) => {
    const da = a.event?.date ?? "0", db = b.event?.date ?? "0";
    return da < db ? 1 : da > db ? -1 : 0; // más reciente primero
  });

  const renderCard = g => {
    const ev    = g.event;
    const state = ev?.state ?? "no_encontrado";

    const matchNum = ev ? koNumberMap.get(ev.id) : null;
    const displayHome = matchNum
      ? resolveKoTeam(ev.homeDisplay, ev.homeAbbr)
      : (ev?.homeAbbr && displayMap?.get(ev.homeAbbr)) || ev?.homeDisplay || g.equipo1;
    const displayAway = matchNum
      ? resolveKoTeam(ev.awayDisplay, ev.awayAbbr)
      : (ev?.awayAbbr && displayMap?.get(ev.awayAbbr)) || ev?.awayDisplay || g.equipo2;

    let resultHTML = "";
    if ((state === "post" || state === "in") && ev.homeScore !== null) {
      resultHTML = `<span class="match-result">${ev.homeScore} - ${ev.awayScore}</span>`;
      if (ev.wentToET && MARCADOR_CUENTA === "reglamentario") {
        resultHTML += ` <span class="et-warn" title="Fue a prórroga/penales. El score puede incluir goles de ET — verificar.">⚠ ET</span>`;
      }
    }

    // winner sort key: 0 = equipo1 gana, 1 = empate, 2 = equipo2 gana
    const winnerKey = s => s.goles1 > s.goles2 ? 0 : s.goles1 === s.goles2 ? 1 : 2;

    const sortedPreds = [...g.preds].sort((a, b) => {
      const pa = a.puntos ?? -1, pb = b.puntos ?? -1;
      if (pb !== pa) return pb - pa;
      const wa = winnerKey(a), wb = winnerKey(b);
      if (wa !== wb) return wa - wb;
      if (a.goles1 !== b.goles1) return a.goles1 - b.goles1;
      if (a.goles2 !== b.goles2) return a.goles2 - b.goles2;
      const na = jugadoresMap?.get(a.jugador) ?? a.jugador;
      const nb = jugadoresMap?.get(b.jugador) ?? b.jugador;
      return na.localeCompare(nb, "es");
    });

    const predRows = sortedPreds.map(s => {
      const cls        = ptsClass(s.puntos, s.estado);
      const ptsText    = s.puntos !== null
        ? `${s.puntos} pt${s.puntos !== 1 ? "s" : ""}`
        : (state === "pre" || state === "no_encontrado" ? "—" : "?");
      const liveTag    = s.estado === "in" ? ' <span class="prov-mark" title="En vivo">*</span>' : "";
      const nombre     = jugadoresMap?.get(s.jugador) ?? s.jugador;
      const winnerText = s.goles1 > s.goles2
        ? (s.abbr1 ?? s.equipo1)
        : s.goles1 < s.goles2
          ? (s.abbr2 ?? s.equipo2)
          : "Empate";
      return `<tr class="${cls}">
        <td class="col-name">${esc(nombre)}</td>
        <td class="pred-winner">${esc(winnerText)}</td>
        <td class="pred-score">${s.goles1} - ${s.goles2}</td>
        <td class="pred-pts">${ptsText}${liveTag}</td>
      </tr>`;
    }).join("");

    // KO prediction rows
    const koRows = [...(g.koPreds ?? [])].sort((a, b) => {
      const pa = a.puntos ?? -1, pb = b.puntos ?? -1;
      if (pb !== pa) return pb - pa;
      const wa = winnerKey(a), wb = winnerKey(b);
      if (wa !== wb) return wa - wb;
      if (a.goles1 !== b.goles1) return a.goles1 - b.goles1;
      if (a.goles2 !== b.goles2) return a.goles2 - b.goles2;
      const na = jugadoresMap?.get(a.jugador) ?? a.jugador;
      const nb = jugadoresMap?.get(b.jugador) ?? b.jugador;
      return na.localeCompare(nb, "es");
    }).map(s => {
      const cls     = ptsClass(s.puntos, s.estado);
      const ptsText = s.puntos !== null
        ? `${s.puntos} pt${s.puntos !== 1 ? "s" : ""}`
        : (s.estado === "pre" ? "—" : "?");
      const liveTag  = s.estado === "in" ? ' <span class="prov-mark" title="En vivo">*</span>' : "";
      const nombre   = jugadoresMap?.get(s.jugador) ?? s.jugador;
      const llaveCls  = s.llave === true ? "ko-llave-ok" : s.llave === false ? "ko-llave-no" : "ko-llave-na";
      const llaveIcon = s.llave === true ? "✓" : s.llave === false ? "✗" : "—";
      const winnerName = s.goles1 > s.goles2
        ? (displayMap?.get(s.abbr1) ?? s.equipo1)
        : s.goles1 < s.goles2
          ? (displayMap?.get(s.abbr2) ?? s.equipo2)
          : "Empate";
      return `<tr class="${cls}">
        <td class="col-name">${esc(nombre)}</td>
        <td class="ko-llave-col ${llaveCls}" title="Llave">${llaveIcon}</td>
        <td class="pred-winner">${esc(winnerName)}</td>
        <td class="pred-score">${s.goles1} - ${s.goles2}</td>
        <td class="pred-pts">${ptsText}${liveTag}</td>
      </tr>`;
    }).join("");

    const predSection = g.preds.length > 0 || koRows
      ? `${g.preds.length > 0 ? `<table class="pred-table"><tbody>${predRows}</tbody></table>` : ""}
         ${koRows ? `<table class="pred-table"><tbody>${koRows}</tbody></table>` : ""}`
      : `<p class="empty no-preds">Sin predicciones cargadas</p>`;

    return `<details class="match-card" data-key="${esc(g.key)}" data-state="${esc(state)}"${openKeys.has(g.key) ? " open" : ""}>
      <summary class="match-header">
        <div class="match-teams">${matchNum ? `${matchNum}: ` : ""}${esc(displayHome)} vs. ${esc(displayAway)}</div>
        <div class="match-meta">
          ${badgeHTML(state)}
          ${ev?.round ? `<span class="badge round">${esc(ev.round)}</span>` : ""}
          ${resultHTML}
          ${state === "in" ? `<span class="live-clock">${ev.statusName === "STATUS_HALFTIME" ? "Entretiempo" : esc(ev.displayClock)}</span>` : ""}
          <span class="match-date">${formatDate(ev?.date)}</span>
        </div>
        ${state === "in" ? '<div class="live-scan-bar"></div>' : ""}
      </summary>
      ${state === "in" ? renderLiveStats(ev) : ""}
      ${predSection}
    </details>`;
  };

  const activeHTML = active.map(renderCard).join("");
  const pastOpen = openKeys.has("__past__");
  const pastHTML = past.length
    ? `<details class="past-matches-section" data-key="__past__"${pastOpen ? " open" : ""}>
        <summary class="past-matches-header">Partidos anteriores (${past.length})</summary>
        ${past.map(renderCard).join("")}
      </details>`
    : "";

  return activeHTML + pastHTML;
}

// ─── GROUP STANDINGS ─────────────────────────────────────────────────────────
function buildGroupStandings(events, baseStandings) {
  if (!baseStandings || !baseStandings.length) return [];

  // Deep-copy base standings (completed matches from ESPN standings endpoint)
  const result = baseStandings.map(grp => ({
    name: grp.name,
    teams: grp.teams.map(t => ({ ...t, latestEv: null })),
  }));

  // Index teams for quick lookup
  const teamIndex = new Map(); // abbr → team object in result
  for (const grp of result) {
    for (const t of grp.teams) teamIndex.set(t.abbr, t);
  }

  // Track latest match badge for all played/live events
  for (const ev of events) {
    if (!ev.homeAbbr || !ev.awayAbbr) continue;
    if (ev.state !== "in" && ev.state !== "post") continue;
    const home = teamIndex.get(ev.homeAbbr);
    const away = teamIndex.get(ev.awayAbbr);
    if (!home && !away) continue;

    const updateLatest = t => {
      if (!t) return;
      if (!t.latestEv || ev.state === "in" || ev.date > t.latestEv.date) t.latestEv = ev;
    };
    updateLatest(home);
    updateLatest(away);

    // Overlay live (in-progress) match as provisional on top of completed standings
    if (ev.state === "in") {
      const hs = ev.homeScore ?? 0, as_ = ev.awayScore ?? 0;
      if (home) {
        home.pj++; home.gf += hs; home.ga += as_;
        if (hs > as_)       { home.pg++; home.pts += 3; }
        else if (hs === as_) { home.pe++; home.pts += 1; }
        else                 { home.pp++; }
      }
      if (away) {
        away.pj++; away.gf += as_; away.ga += hs;
        if (as_ > hs)       { away.pg++; away.pts += 3; }
        else if (as_ === hs) { away.pe++; away.pts += 1; }
        else                 { away.pp++; }
      }
    }
  }

  // Re-sort teams within each group
  for (const grp of result) {
    grp.teams.sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      const gdA = a.gf - a.ga, gdB = b.gf - b.ga;
      if (gdB !== gdA) return gdB - gdA;
      if (b.gf !== a.gf) return b.gf - a.gf;
      const na = displayMap?.get(a.abbr) ?? a.display ?? a.abbr;
      const nb = displayMap?.get(b.abbr) ?? b.display ?? b.abbr;
      return na.localeCompare(nb, "es");
    });
  }

  return result;
}

function renderThirdPlaces(standings) {
  const thirds = standings
    .filter(({ teams }) => teams.length >= 3)
    .map(({ name, teams }) => ({ group: name, ...teams[2] }))
    .sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      const gdA = a.gf - a.ga, gdB = b.gf - b.ga;
      if (gdB !== gdA) return gdB - gdA;
      return b.gf - a.gf;
    });

  if (!thirds.length) return "";

  const rows = thirds.map((t, i) => {
    const display = displayMap?.get(t.abbr) ?? t.display ?? t.abbr;
    const gd = t.gf - t.ga;
    const gdStr = gd > 0 ? `+${gd}` : `${gd}`;
    const qualif = i < 8; // top 8 terceros avanzan en un Mundial de 48 equipos
    return `<tr${qualif ? ' class="qualif"' : ""}>
      <td class="col-pos">${i + 1}</td>
      <td class="col-gteam">${esc(display)} <span class="third-group">${esc(t.group)}</span></td>
      <td class="col-gnum">${t.pj}</td>
      <td class="col-gnum">${t.pg}</td>
      <td class="col-gnum">${t.pe}</td>
      <td class="col-gnum">${t.pp}</td>
      <td class="col-gpts">${t.pts}</td>
      <td class="col-goles">${t.gf} - ${t.ga}</td>
    </tr>`;
  }).join("");

  return `<div class="group-block thirds-block">
    <h3 class="group-title">Mejores Terceros</h3>
    <div class="group-table-wrap"><table class="group-table">
      <thead><tr>
        <th class="col-pos">#</th>
        <th class="col-gteam">Equipo</th>
        <th class="col-gnum" title="Partidos jugados">PJ</th>
        <th class="col-gnum" title="Ganados">G</th>
        <th class="col-gnum" title="Empatados">E</th>
        <th class="col-gnum" title="Perdidos">P</th>
        <th class="col-gpts" title="Puntos">Pts</th>
        <th class="col-goles" title="Goles a favor - Goles en contra">GLS</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

// ─── STATS ───────────────────────────────────────────────────────────────────
async function buildStats(events) {
  const completed = events.filter(ev => ev.state === "post");
  const summaries = await Promise.all(completed.map(ev => fetchSummary(ev.id)));

  const goals        = new Map(); // athleteId → { name, count }
  const assists      = new Map();
  const yellows      = new Map(); // teamAbbr  → { name, count }
  const reds         = new Map();

  for (const data of summaries) {
    if (!data) continue;
    for (const kev of data.keyEvents ?? []) {
      const type = kev.type?.type ?? "";

      if (/^goal/.test(type)) {
        const scorer   = kev.participants?.[0]?.athlete;
        const assister = kev.participants?.[1]?.athlete;
        if (scorer) {
          const e = goals.get(scorer.id) ?? { name: scorer.displayName, count: 0 };
          e.count++;
          goals.set(scorer.id, e);
        }
        if (assister) {
          const e = assists.get(assister.id) ?? { name: assister.displayName, count: 0 };
          e.count++;
          assists.set(assister.id, e);
        }
      }

      if (type === "yellow-card") {
        const key = kev.team?.id;
        if (key) {
          const e = yellows.get(key) ?? { name: kev.team.displayName, count: 0 };
          e.count++;
          yellows.set(key, e);
        }
      }

      if (type === "red-card") {
        const key = kev.team?.id;
        if (key) {
          const e = reds.get(key) ?? { name: kev.team.displayName, count: 0 };
          e.count++;
          reds.set(key, e);
        }
      }
    }
  }

  // Team stats from scoreboard (no summaries needed)
  const goalsAgainst = new Map();
  const cleanSheets  = new Map();

  for (const ev of completed) {
    if (ev.homeScore == null || ev.awayScore == null) continue;
    const homeName = displayMap?.get(ev.homeAbbr) ?? ev.homeDisplay ?? ev.homeAbbr;
    const awayName = displayMap?.get(ev.awayAbbr) ?? ev.awayDisplay ?? ev.awayAbbr;

    const h = goalsAgainst.get(ev.homeAbbr) ?? { name: homeName, count: 0 };
    h.count += ev.awayScore;
    goalsAgainst.set(ev.homeAbbr, h);

    const a = goalsAgainst.get(ev.awayAbbr) ?? { name: awayName, count: 0 };
    a.count += ev.homeScore;
    goalsAgainst.set(ev.awayAbbr, a);

    if (ev.awayScore === 0) {
      const cs = cleanSheets.get(ev.homeAbbr) ?? { name: homeName, count: 0 };
      cs.count++;
      cleanSheets.set(ev.homeAbbr, cs);
    }
    if (ev.homeScore === 0) {
      const cs = cleanSheets.get(ev.awayAbbr) ?? { name: awayName, count: 0 };
      cs.count++;
      cleanSheets.set(ev.awayAbbr, cs);
    }
  }

  const top5 = map => [...map.values()].sort((a, b) => b.count - a.count);

  return {
    goals:        top5(goals),
    assists:      top5(assists),
    goalsAgainst: top5(goalsAgainst),
    cleanSheets:  top5(cleanSheets),
    yellows:      top5(yellows),
    reds:         top5(reds),
  };
}

function renderStatCard(title, items, unit) {
  if (!items.length) {
    return `<div class="stat-card">
      <h3 class="stat-title">${esc(title)}</h3>
      <p class="empty">Sin datos aún.</p>
    </div>`;
  }
  const maxCount = items[0].count;
  const rows = items.map((item, i) => `
    <div class="stat-row">
      <span class="stat-rank">${i + 1}</span>
      <span class="stat-name">${esc(item.name)}</span>
      <span class="stat-count">${item.count}</span>
      <div class="stat-bar-wrap">
        <div class="stat-bar" style="width:${Math.round((item.count / maxCount) * 100)}%"></div>
      </div>
    </div>`).join("");
  return `<div class="stat-card">
    <h3 class="stat-title">${esc(title)}</h3>
    <div class="stat-body">${rows}</div>
  </div>`;
}

function renderStats(stats) {
  return `<div class="stats-grid">
    ${renderStatCard("Goleadores", stats.goals, "")}
    ${renderStatCard("Asistencias", stats.assists, "")}
    ${renderStatCard("Goles concedidos", stats.goalsAgainst, "")}
    ${renderStatCard("Vallas invictas", stats.cleanSheets, "")}
    ${renderStatCard("Tarjetas amarillas", stats.yellows, "")}
    ${renderStatCard("Tarjetas rojas", stats.reds, "")}
  </div>`;
}

async function loadStats() {
  if (statsFetching) return;
  statsFetching = true;
  document.getElementById("stats-container").innerHTML =
    '<p class="empty stats-loading">Cargando estadísticas…</p>';
  try {
    statsCache = await buildStats(lastEvents);
    document.getElementById("stats-container").innerHTML = renderStats(statsCache);
  } catch (err) {
    document.getElementById("stats-container").innerHTML =
      `<p class="empty">Error al cargar estadísticas: ${esc(err.message)}</p>`;
    statsFetching = false; // allow retry
  }
}

function renderGroups(standings) {
  if (!standings.length) return '<p class="empty">Datos de grupos no disponibles aún.</p>';

  return standings.map(({ name, teams }) => {
    const rows = teams.map((t, i) => {
      const display = displayMap?.get(t.abbr) ?? t.display ?? t.abbr;
      const gd = t.gf - t.ga;
      const gdStr = gd > 0 ? `+${gd}` : `${gd}`;

      let badge = "";
      if (t.latestEv && t.latestEv.state === "in") {
        const ev = t.latestEv;
        const hs = ev.homeScore ?? 0, as_ = ev.awayScore ?? 0;
        const myScore = ev.homeAbbr === t.abbr ? hs : as_;
        const opScore = ev.homeAbbr === t.abbr ? as_ : hs;
        const rc = myScore > opScore ? "win" : myScore < opScore ? "loss" : "draw";
        badge = `<span class="grp-badge ${rc}">${hs}-${as_}</span>`;
      }

      return `<tr${i < 2 ? ' class="qualif"' : ""}>
        <td class="col-pos">${i + 1}</td>
        <td class="col-gteam">${esc(display)}${badge}</td>
        <td class="col-gnum">${t.pj}</td>
        <td class="col-gnum">${t.pg}</td>
        <td class="col-gnum">${t.pe}</td>
        <td class="col-gnum">${t.pp}</td>
        <td class="col-gpts">${t.pts}</td>
        <td class="col-goles">${t.gf} - ${t.ga}</td>
      </tr>`;
    }).join("");

    return `<div class="group-block">
      <h3 class="group-title">${esc(name)}</h3>
      <div class="group-table-wrap"><table class="group-table">
        <thead><tr>
          <th class="col-pos">#</th>
          <th class="col-gteam">Equipo</th>
          <th class="col-gnum" title="Partidos jugados">PJ</th>
          <th class="col-gnum" title="Ganados">G</th>
          <th class="col-gnum" title="Empatados">E</th>
          <th class="col-gnum" title="Perdidos">P</th>
          <th class="col-gpts" title="Puntos">Pts</th>
          <th class="col-goles" title="Goles a favor - Goles en contra">GLS</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }).join("") + renderThirdPlaces(standings);
}

// ─── REFRESH / POLLING ────────────────────────────────────────────────────────
async function refresh() {
  hideError();
  try {
    const events  = await fetchESPN();
    const scored  = scoreAll(predicciones, events);
    const ranking = buildRanking(scored);
    const hasLive = events.some(ev => ev.state === "in");

    const prevOpen = new Set(
      [...document.querySelectorAll('#partidos-container details[open]')].map(el => el.dataset.key)
    );

    lastEvents = events;
    buildKoNumbers(events);
    if (!statsCache && !statsFetching) loadStats();

    // Build koEventByNum for KO scoring
    const koEventByNum = new Map();
    for (const ev of events) {
      const num = koNumberMap.get(ev.id);
      if (num) koEventByNum.set(num, ev);
    }
    const koScored  = scoreKO(prediccionesKO ?? [], koEventByNum);
    const koRanking = buildRankingKO(koScored);
    const groups    = groupByMatch(scored, events, koScored);

    // Primera carga: auto-abrir partidos en vivo; después preservar estado del usuario
    const openKeys = firstRender
      ? new Set(groups.filter(g => g.event?.state === "in").map(g => g.key))
      : prevOpen;
    firstRender = false;

    const standings = buildGroupStandings(events, groupStandingsData);
    const scrollY = window.scrollY;
    document.getElementById("ranking-container").innerHTML  =
      renderRanking(ranking, hasLive, jugadoresMap) + renderRankingKO(koRanking, jugadoresMap);
    document.getElementById("partidos-container").innerHTML = renderPartidos(groups, openKeys);
    document.getElementById("grupos-container").innerHTML   = renderGroups(standings);
    window.scrollTo(0, scrollY);


    scheduleNext(hasLive);
  } catch (err) {
    console.error(err);
    showError(err.message);
    scheduleNext(false);
  }
}

function scheduleNext(hasLive) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, hasLive ? POLL_LIVE_MS : POLL_IDLE_MS);
}

function showError(msg) {
  const el = document.getElementById("error-banner");
  if (el) { el.textContent = `Error: ${msg}`; el.style.display = "block"; }
}
function hideError() {
  const el = document.getElementById("error-banner");
  if (el) el.style.display = "none";
}

// ─── TABS ─────────────────────────────────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${tabName}"]`)?.classList.add("active");
  document.getElementById(`tab-${tabName}`)?.classList.add("active");
}

function initTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.tab;
      switchTab(name);
      if (name === "stats" && !statsCache && !statsFetching) loadStats();
    });
  });

}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  initTabs();

  try {
    const eq     = await buildEquiposMap();
    equiposMap   = eq.equipos;
    displayMap   = eq.display;
    jugadoresMap   = await loadJugadores();
    predicciones   = await loadPredicciones(equiposMap);
    prediccionesKO = await loadPredKO();
  } catch (err) {
    showError(err.message);
    return;
  }

  // Fetch group standings once (group assignments don't change during the tournament)
  groupStandingsData = await fetchGroupStandings();

  await refresh();
}

document.addEventListener("DOMContentLoaded", init);

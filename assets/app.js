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

const POLL_LIVE_MS = 10_000;   // 10 s — hay al menos un partido en vivo
const POLL_IDLE_MS = 300_000;  // 5 min — no hay partidos en vivo

// ─── STATE ───────────────────────────────────────────────────────────────────
let pollTimer    = null;
let equiposMap   = null;
let jugadoresMap = null;
let predicciones = null;

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
  const map = new Map();
  for (const row of rows) {
    const es   = row["ES"]?.toUpperCase().trim();
    const abbr = row["ESPN_ABBR"]?.toUpperCase().trim();
    if (es && abbr) map.set(es, abbr);
  }
  return map;
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

// ─── ESPN ─────────────────────────────────────────────────────────────────────
async function fetchESPN() {
  const res = await fetch(ESPN_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`ESPN devolvió ${res.status}`);
  const data = await res.json();
  return parseESPN(data);
}

function getStat(competitor, name) {
  const s = (competitor?.statistics ?? []).find(s => s.name === name);
  return s != null ? parseFloat(s.displayValue ?? s.value ?? 0) : null;
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
      state:       statusType.state ?? "pre",
      completed:   statusType.completed ?? false,
      statusDesc:  statusType.description ?? "",
      statusName:  statusType.name ?? "",
      period,
      wentToET:    period > 2,
      displayClock:      comp.status?.displayClock ?? event.status?.displayClock ?? "",
      homeShotsOnTarget: getStat(home, "shotsOnTarget"),
      awayShotsOnTarget: getStat(away, "shotsOnTarget"),
      odds: (() => {
        const ml = comp.odds?.[0]?.moneyline;
        if (!ml) return null;
        const h = ml.home?.current?.odds;
        const d = ml.draw?.current?.odds;
        const a = ml.away?.current?.odds;
        return h && d && a ? { home: h, draw: d, away: a } : null;
      })(),
    };
  }).filter(Boolean);
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

// ─── LIVE PROBABILITY (Poisson) ──────────────────────────────────────────────
const XG_PER_SOT  = 0.10;   // xG por tiro al arco (promedio crudo)
const PRIOR_RATE  = 1.1 / 90; // tasa base: ~1.1 goles esperados por equipo cada 90'

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
    return { pWin: raw.home / total, pDraw: raw.draw / total, pLose: raw.away / total, source: "odds" };
  }

  // Fallback: Poisson model from shots on target
  const isHalfTime = ev.statusName === "STATUS_HALFTIME";
  const minPlayed  = parseMinute(ev.displayClock, isHalfTime);
  const minLeft    = isHalfTime ? 45 : Math.max(0, 90 - minPlayed);
  const xgHome = (ev.homeShotsOnTarget ?? 0) * XG_PER_SOT;
  const xgAway = (ev.awayShotsOnTarget ?? 0) * XG_PER_SOT;
  const w        = Math.min(minPlayed / 30, 1);
  const rateHome = w * (xgHome / Math.max(minPlayed, 1)) + (1 - w) * PRIOR_RATE;
  const rateAway = w * (xgAway / Math.max(minPlayed, 1)) + (1 - w) * PRIOR_RATE;
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
  return { pWin, pDraw, pLose, source: "poisson" };
}

function renderLiveStats(ev) {
  const probs = calcMatchProbs(ev);
  if (!probs) return "";
  const { pWin, pDraw, pLose } = probs;
  const ph = Math.round(pWin  * 100);
  const pd = Math.round(pDraw * 100);
  const pa = Math.round(pLose * 100);
  const xgHome = ((ev.homeShotsOnTarget ?? 0) * XG_PER_SOT).toFixed(1);
  const xgAway = ((ev.awayShotsOnTarget ?? 0) * XG_PER_SOT).toFixed(1);
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
    <div class="prob-3col prob-xg-row">
      <span>${xgHome}</span><span>Est. xG</span><span>${xgAway}</span>
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
    return tb - ta || b.exactos - a.exactos || a.jugador.localeCompare(b.jugador);
  });
}

function groupByMatch(scored) {
  const groups = new Map();
  for (const s of scored) {
    const key = pairKey(s.abbr1 ?? s.equipo1, s.abbr2 ?? s.equipo2);
    if (!groups.has(key)) {
      groups.set(key, { key, equipo1: s.equipo1, equipo2: s.equipo2, event: s.event, preds: [] });
    }
    groups.get(key).preds.push(s);
  }
  return [...groups.values()].sort((a, b) => {
    const inA = a.event?.state === "in" ? 0 : 1;
    const inB = b.event?.state === "in" ? 0 : 1;
    if (inA !== inB) return inA - inB;
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
    return new Date(iso).toLocaleString("es-AR", {
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit",
      timeZone: "America/Argentina/Buenos_Aires",
    });
  } catch { return iso; }
}

function badgeHTML(state) {
  const labels = { pre: "PRÓXIMO", in: "EN VIVO", post: "FINAL" };
  const label = labels[state] ?? state;
  return `<span class="badge ${state}">${label}</span>`;
}

function ptsClass(pts, estado) {
  if (pts === null) return estado === "pre" || estado === "no_encontrado" ? "pts-pending" : "pts-pending";
  if (pts === 3) return "pts-3";
  if (pts === 1) return "pts-1";
  return "pts-0";
}

function renderRanking(ranking, hasLive, jugMap) {
  if (!ranking.length) return '<p class="empty">No hay datos aún.</p>';

  let html = `<table class="ranking-table">
    <thead><tr>
      <th class="col-rank">#</th>
      <th class="col-name">Jugador</th>
      <th class="col-num" title="Marcador exacto = 3 pts">Exactos</th>
      <th class="col-num" title="Resultado correcto = 1 pt">Result.</th>
      <th class="col-total">Total</th>
    </tr></thead><tbody>`;

  let displayRank = 1;
  for (let i = 0; i < ranking.length; i++) {
    const r = ranking[i];
    const total = r.ptsPost + r.ptsLive;
    const prevTotal = i > 0 ? ranking[i - 1].ptsPost + ranking[i - 1].ptsLive : null;
    if (i > 0 && total < prevTotal) displayRank = i + 1;
    const nombre = jugMap?.get(r.jugador) ?? r.jugador;
    const totalHTML = r.ptsLive > 0
      ? `${r.ptsPost} <span class="pts-live">(+${r.ptsLive})</span>`
      : `${r.ptsPost}`;
    html += `<tr>
      <td class="col-rank">${displayRank}</td>
      <td class="col-name">${esc(nombre)}</td>
      <td class="col-num">${r.exactos}</td>
      <td class="col-num">${r.resultados}</td>
      <td class="col-total">${totalHTML}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  if (hasLive) html += '<p class="prov-note">Los puntos entre paréntesis son provisorios (partido en vivo).</p>';
  return html;
}

function renderPartidos(groups) {
  if (!groups.length) return '<p class="empty">No hay predicciones cargadas.</p>';

  return groups.map(g => {
    const ev    = g.event;
    const state = ev?.state ?? "no_encontrado";

    const displayHome = ev?.homeDisplay ?? g.equipo1;
    const displayAway = ev?.awayDisplay ?? g.equipo2;

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

    return `<details class="match-card" data-state="${esc(state)}"${state === "in" ? " open" : ""}>
      <summary class="match-header">
        <div class="match-teams">${esc(displayHome)} vs ${esc(displayAway)}</div>
        <div class="match-meta">
          ${badgeHTML(state)}
          ${resultHTML}
          ${state === "in" ? `<span class="live-clock">${ev.statusName === "STATUS_HALFTIME" ? "Entretiempo" : esc(ev.displayClock)}</span>` : ""}
          <span class="match-date">${formatDate(ev?.date)}</span>
        </div>
        ${state === "in" ? '<div class="live-scan-bar"></div>' : ""}
      </summary>
      ${state === "in" ? renderLiveStats(ev) : ""}
      <table class="pred-table"><tbody>${predRows}</tbody></table>
    </details>`;
  }).join("");
}

// ─── REFRESH / POLLING ────────────────────────────────────────────────────────
async function refresh() {
  hideError();
  try {
    const events  = await fetchESPN();
    const scored  = scoreAll(predicciones, events);
    const ranking = buildRanking(scored);
    const groups  = groupByMatch(scored);
    const hasLive = events.some(ev => ev.state === "in");

    document.getElementById("ranking-container").innerHTML  = renderRanking(ranking, hasLive, jugadoresMap);
    document.getElementById("partidos-container").innerHTML = renderPartidos(groups);

    // Manual refresh button only visible when nothing is live
    document.getElementById("refresh-btn").style.display = hasLive ? "none" : "";

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
function initTabs() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add("active");
    });
  });
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  initTabs();

  document.getElementById("refresh-btn").addEventListener("click", () => {
    clearTimeout(pollTimer);
    refresh();
  });

try {
    equiposMap   = await buildEquiposMap();
    jugadoresMap = await loadJugadores();
    predicciones = await loadPredicciones(equiposMap);
  } catch (err) {
    showError(err.message);
    return;
  }

  await refresh();
}

document.addEventListener("DOMContentLoaded", init);

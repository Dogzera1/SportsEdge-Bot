#!/usr/bin/env node
'use strict';

// scripts/extract-tennis-features.js
//
// Gera CSV walk-forward de features de tênis a partir dos CSVs Sackmann
// (data/tennis_atp, data/tennis_wta). Cada linha = 1 match com features
// calculadas APENAS com informação anterior à data do match (sem look-ahead).
//
// Uso:
//   node scripts/extract-tennis-features.js [--years 2015-2024] [--tour atp,wta]
//                                           [--out data/tennis_features.csv]
//                                           [--min-year-for-output 2018]
//
// Notas:
// - Os primeiros anos são usados só para "aquecer" Elo/rolling stats.
//   Por default só gravamos matches a partir de --min-year-for-output.
// - p1/p2 são atribuídos de forma determinística pela ordem alfabética
//   do nome (não pelo resultado), para evitar target leakage por slot.
// - Target: y = 1 se p1 venceu, 0 caso contrário.

const fs = require('fs');
const path = require('path');

// ── Args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  return argv[i + 1];
}

const YEARS_RANGE = argVal('years', '2015-2024');
const TOURS = argVal('tour', 'atp,wta').split(',').map(s => s.trim()).filter(Boolean);
const OUT_PATH = path.resolve(argVal('out', 'data/tennis_features.csv'));
const MIN_YEAR_OUTPUT = parseInt(argVal('min-year-for-output', '2018'), 10);

const years = (() => {
  if (YEARS_RANGE.includes('-')) {
    const [a, b] = YEARS_RANGE.split('-').map(s => parseInt(s, 10));
    const out = [];
    for (let y = a; y <= b; y++) out.push(y);
    return out;
  }
  return YEARS_RANGE.split(',').map(s => parseInt(s.trim(), 10));
})();

console.log(`[extract] tours=${TOURS.join(',')} years=${years[0]}..${years[years.length - 1]} | output>= ${MIN_YEAR_OUTPUT} | out=${OUT_PATH}`);

// ── CSV parsing ───────────────────────────────────────────────────────────
function parseCsvLine(line) {
  // Sackmann CSVs: sem quotes complexos, split simples basta
  return line.split(',');
}

function loadCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < headers.length - 3) continue; // tolera linhas com colunas faltando no fim
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (cols[j] || '').trim();
    rows.push(row);
  }
  return rows;
}

// ── Load all matches ──────────────────────────────────────────────────────
const allRows = [];
for (const tour of TOURS) {
  const dir = tour === 'wta' ? 'tennis_wta' : 'tennis_atp';
  const prefix = tour === 'wta' ? 'wta_matches_' : 'atp_matches_';
  for (const year of years) {
    const file = path.join('data', dir, `${prefix}${year}.csv`);
    const rows = loadCsv(file);
    for (const r of rows) r._tour = tour;
    allRows.push(...rows);
    if (rows.length) console.log(`  loaded ${file}: ${rows.length}`);
  }
}
console.log(`[extract] total rows loaded: ${allRows.length}`);

// Parse tourney_date (YYYYMMDD) to epoch ms, drop rows without date
function parseDate(s) {
  if (!s || s.length !== 8) return NaN;
  const y = +s.slice(0, 4), m = +s.slice(4, 6), d = +s.slice(6, 8);
  return Date.UTC(y, m - 1, d);
}

const matches = [];
for (const r of allRows) {
  const t = parseDate(r.tourney_date);
  if (!Number.isFinite(t)) continue;
  if (!r.winner_name || !r.loser_name) continue;
  r._t = t;
  matches.push(r);
}
matches.sort((a, b) => a._t - b._t || (+a.match_num || 0) - (+b.match_num || 0));
console.log(`[extract] matches with valid date: ${matches.length}`);

// ── Surface normalization ─────────────────────────────────────────────────
function normSurface(s) {
  const x = String(s || '').toLowerCase();
  if (x.startsWith('hard')) return 'hard';
  if (x.startsWith('clay')) return 'clay';
  if (x.startsWith('grass')) return 'grass';
  if (x.startsWith('carpet')) return 'hard'; // trata carpet como hard indoor
  return 'hard';
}

// ── Elo state ─────────────────────────────────────────────────────────────
const ELO_INIT = 1500;
const K_BASE = 32;
const K_MIN = 10;
const K_SCALE = 40;

function kFactor(games) {
  const r = Math.min(1, games / K_SCALE);
  return K_BASE - (K_BASE - K_MIN) * r;
}
function eloExpected(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

// playerState: name → {
//   elo: { overall, hard, clay, grass },
//   games: { all, hard, clay, grass },
//   recent: [{t, minutes, won, surface, oppName}]  (últimos ~60 dias)
//   serveWin: { n, pct }  (rolling sum of 1st+2nd serve points won / total serve points, últimos ~40 jogos)
// }
const state = new Map();
function getP(name) {
  if (!state.has(name)) {
    state.set(name, {
      elo: { overall: ELO_INIT, hard: ELO_INIT, clay: ELO_INIT, grass: ELO_INIT },
      games: { all: 0, hard: 0, clay: 0, grass: 0 },
      recent: [],
      serveHist: [], // [{svWon, svPts}] últimos N matches
    });
  }
  return state.get(name);
}

// H2H state: map "A|B" (sorted) → { aWinsOverall, bWinsOverall, aWinsSurf:{hard,clay,grass}, bWinsSurf:{...} }
const h2hState = new Map();
function h2hKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
function getH2H(a, b) {
  const k = h2hKey(a, b);
  if (!h2hState.has(k)) {
    h2hState.set(k, {
      keyA: a < b ? a : b,
      all: { a: 0, b: 0 },
      hard: { a: 0, b: 0 }, clay: { a: 0, b: 0 }, grass: { a: 0, b: 0 },
    });
  }
  return h2hState.get(k);
}

// ── Helpers p/ rolling state ─────────────────────────────────────────────
const DAY_MS = 86400000;

function pruneRecent(arr, now) {
  const cutoff = now - 60 * DAY_MS;
  while (arr.length && arr[0].t < cutoff) arr.shift();
}

function estimateMinutesFromScore(score, explicitMinutes) {
  const m = +explicitMinutes;
  if (Number.isFinite(m) && m > 10 && m < 400) return m;
  if (!score) return 90;
  const sets = score.match(/\b\d+-\d+(?:\(\d+\))?\b/g) || [];
  if (!sets.length) return 90;
  let total = 0;
  for (const set of sets) {
    const nums = set.match(/\d+/g) || [];
    const a = +nums[0] || 0, b = +nums[1] || 0;
    const games = a + b;
    if (set.includes('(')) total += 55;
    else if (games >= 13) total += 60;
    else if (games >= 9) total += 45;
    else total += 30;
  }
  return total || 90;
}

function fatigueLastDays(recent, now, days) {
  const cutoff = now - days * DAY_MS;
  let min = 0, count = 0;
  for (const m of recent) {
    if (m.t >= cutoff && m.t < now) { min += m.minutes; count++; }
  }
  return { minutes: min, count };
}

function daysSinceLast(recent, now) {
  if (!recent.length) return 999;
  const last = recent[recent.length - 1];
  return Math.max(0, Math.round((now - last.t) / DAY_MS));
}

function serveWinPct(serveHist) {
  if (!serveHist.length) return null;
  let won = 0, pts = 0;
  for (const s of serveHist) { won += s.svWon; pts += s.svPts; }
  return pts > 0 ? won / pts : null;
}

// ── Feature extraction loop ───────────────────────────────────────────────
const out = [];
const HEADERS = [
  'date', 'tour', 'tourney', 'surface', 'best_of', 'is_slam', 'is_masters',
  'p1', 'p2',
  'elo_diff_overall', 'elo_diff_surface', 'elo_diff_blend',
  'rank_diff', 'rank_points_log_ratio',
  'age_diff', 'height_diff',
  'serve_pct_diff',
  'fatigue_min_7d_diff', 'matches_14d_diff', 'days_since_last_diff',
  'h2h_surface_diff', 'h2h_overall_diff',
  'p1_games_surface', 'p2_games_surface',
  'n_signals',
  'y',
];

let kept = 0, skipped = 0;

for (const r of matches) {
  const now = r._t;
  const surface = normSurface(r.surface);
  const winner = r.winner_name;
  const loser = r.loser_name;
  if (!winner || !loser) { skipped++; continue; }

  // Determinístico: p1 = alfabeticamente menor dos dois nomes
  const [p1, p2] = winner < loser ? [winner, loser] : [loser, winner];
  const p1Won = winner === p1 ? 1 : 0;

  const sp1 = getP(p1);
  const sp2 = getP(p2);

  // ── Features (ANTES de atualizar state) ─────────────────────────────────
  const eloDiffOverall = sp1.elo.overall - sp2.elo.overall;
  const eloDiffSurface = sp1.elo[surface] - sp2.elo[surface];
  // Blend 75% surface / 25% overall, mas cai pra overall quando < 5 jogos na surface
  const p1Blend = (sp1.games[surface] >= 5)
    ? 0.75 * sp1.elo[surface] + 0.25 * sp1.elo.overall
    : sp1.elo.overall;
  const p2Blend = (sp2.games[surface] >= 5)
    ? 0.75 * sp2.elo[surface] + 0.25 * sp2.elo.overall
    : sp2.elo.overall;
  const eloDiffBlend = p1Blend - p2Blend;

  const rank1 = +r[p1 === winner ? 'winner_rank' : 'loser_rank'];
  const rank2 = +r[p2 === winner ? 'winner_rank' : 'loser_rank'];
  const rankDiff = (Number.isFinite(rank1) && Number.isFinite(rank2)) ? (rank1 - rank2) : 0;

  const rp1 = +r[p1 === winner ? 'winner_rank_points' : 'loser_rank_points'];
  const rp2 = +r[p2 === winner ? 'winner_rank_points' : 'loser_rank_points'];
  const rpLogRatio = (Number.isFinite(rp1) && Number.isFinite(rp2) && rp1 > 0 && rp2 > 0)
    ? Math.log(rp1 / rp2) : 0;

  const age1 = +r[p1 === winner ? 'winner_age' : 'loser_age'];
  const age2 = +r[p2 === winner ? 'winner_age' : 'loser_age'];
  const ageDiff = (Number.isFinite(age1) && Number.isFinite(age2)) ? (age1 - age2) : 0;

  const ht1 = +r[p1 === winner ? 'winner_ht' : 'loser_ht'];
  const ht2 = +r[p2 === winner ? 'winner_ht' : 'loser_ht'];
  const heightDiff = (Number.isFinite(ht1) && Number.isFinite(ht2) && ht1 > 0 && ht2 > 0) ? (ht1 - ht2) : 0;

  const sw1 = serveWinPct(sp1.serveHist);
  const sw2 = serveWinPct(sp2.serveHist);
  const servePctDiff = (sw1 != null && sw2 != null) ? (sw1 - sw2) : 0;

  pruneRecent(sp1.recent, now);
  pruneRecent(sp2.recent, now);
  const f1_7 = fatigueLastDays(sp1.recent, now, 7);
  const f2_7 = fatigueLastDays(sp2.recent, now, 7);
  const f1_14 = fatigueLastDays(sp1.recent, now, 14);
  const f2_14 = fatigueLastDays(sp2.recent, now, 14);
  const fatigueMin7Diff = f1_7.minutes - f2_7.minutes;
  const matches14Diff = f1_14.count - f2_14.count;
  const days1 = daysSinceLast(sp1.recent, now);
  const days2 = daysSinceLast(sp2.recent, now);
  const daysSinceDiff = Math.min(days1, 120) - Math.min(days2, 120);

  const h2h = getH2H(p1, p2);
  // keyA é alfabeticamente menor; como p1 é alfabeticamente menor, p1 sempre == keyA
  const h2hSurfaceDiff = h2h[surface].a - h2h[surface].b;
  const h2hOverallDiff = h2h.all.a - h2h.all.b;

  // Conta sinais "fortes" disponíveis (p/ features de confiança da prior)
  let nSignals = 0;
  if (sp1.games.all >= 10 && sp2.games.all >= 10) nSignals++;
  if (sp1.games[surface] >= 5 && sp2.games[surface] >= 5) nSignals++;
  if (Number.isFinite(rank1) && Number.isFinite(rank2)) nSignals++;
  if (sw1 != null && sw2 != null) nSignals++;
  if (sp1.recent.length > 0 && sp2.recent.length > 0) nSignals++;
  if (h2h.all.a + h2h.all.b >= 2) nSignals++;

  const isSlam = r.tourney_level === 'G' ? 1 : 0;
  const isMasters = r.tourney_level === 'M' ? 1 : 0;
  const bestOf = +r.best_of || 3;

  // ── Decide se grava esta linha ────────────────────────────────────────
  const year = new Date(now).getUTCFullYear();
  const shouldOutput = year >= MIN_YEAR_OUTPUT
    && sp1.games.all >= 10 && sp2.games.all >= 10; // aquecimento mínimo

  if (shouldOutput) {
    out.push([
      new Date(now).toISOString().slice(0, 10),
      r._tour, (r.tourney_name || '').replace(/,/g, ' '),
      surface, bestOf, isSlam, isMasters,
      p1.replace(/,/g, ' '), p2.replace(/,/g, ' '),
      eloDiffOverall.toFixed(2), eloDiffSurface.toFixed(2), eloDiffBlend.toFixed(2),
      rankDiff, rpLogRatio.toFixed(4),
      ageDiff.toFixed(2), heightDiff,
      servePctDiff.toFixed(4),
      fatigueMin7Diff, matches14Diff, daysSinceDiff,
      h2hSurfaceDiff, h2hOverallDiff,
      sp1.games[surface], sp2.games[surface],
      nSignals,
      p1Won,
    ]);
    kept++;
  } else {
    skipped++;
  }

  // ── Atualiza state (Elo + rolling) com o RESULTADO deste match ─────────
  const wState = winner === p1 ? sp1 : sp2;
  const lState = winner === p1 ? sp2 : sp1;

  // Elo update (overall + surface)
  const expWOverall = eloExpected(wState.elo.overall, lState.elo.overall);
  const kOverallW = kFactor(wState.games.all);
  const kOverallL = kFactor(lState.games.all);
  wState.elo.overall += kOverallW * (1 - expWOverall);
  lState.elo.overall += kOverallL * (0 - (1 - expWOverall));

  const expWSurf = eloExpected(wState.elo[surface], lState.elo[surface]);
  const kSurfW = kFactor(wState.games[surface]);
  const kSurfL = kFactor(lState.games[surface]);
  wState.elo[surface] += kSurfW * (1 - expWSurf);
  lState.elo[surface] += kSurfL * (0 - (1 - expWSurf));

  wState.games.all++; lState.games.all++;
  wState.games[surface]++; lState.games[surface]++;

  // Recent (fatigue/days)
  const minutes = estimateMinutesFromScore(r.score, r.minutes);
  wState.recent.push({ t: now, minutes, won: 1, surface, opp: loser });
  lState.recent.push({ t: now, minutes, won: 0, surface, opp: winner });

  // Serve % rolling (últimos 40 jogos)
  const wSvPts = +r.w_svpt, wSvWon = (+r.w_1stWon || 0) + (+r.w_2ndWon || 0);
  const lSvPts = +r.l_svpt, lSvWon = (+r.l_1stWon || 0) + (+r.l_2ndWon || 0);
  if (Number.isFinite(wSvPts) && wSvPts > 0) {
    wState.serveHist.push({ svPts: wSvPts, svWon: wSvWon });
    if (wState.serveHist.length > 40) wState.serveHist.shift();
  }
  if (Number.isFinite(lSvPts) && lSvPts > 0) {
    lState.serveHist.push({ svPts: lSvPts, svWon: lSvWon });
    if (lState.serveHist.length > 40) lState.serveHist.shift();
  }

  // H2H update
  if (winner === h2h.keyA) { h2h.all.a++; h2h[surface].a++; }
  else { h2h.all.b++; h2h[surface].b++; }
}

// ── Write CSV ─────────────────────────────────────────────────────────────
const outDir = path.dirname(OUT_PATH);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const header = HEADERS.join(',');
const body = out.map(row => row.join(',')).join('\n');
fs.writeFileSync(OUT_PATH, header + '\n' + body + '\n', 'utf8');

console.log(`[extract] rows written: ${kept} | skipped: ${skipped}`);
console.log(`[extract] out: ${OUT_PATH}`);

// Sanity check: distribution of y e alguns stats
const yMean = out.length ? out.reduce((s, r) => s + (+r[r.length - 1]), 0) / out.length : 0;
console.log(`[extract] y mean (p1 win rate, should be ~0.5 since p1 = alfabeticamente menor): ${yMean.toFixed(4)}`);

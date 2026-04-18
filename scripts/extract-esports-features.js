#!/usr/bin/env node
'use strict';

// scripts/extract-esports-features.js
//
// Extrai features walk-forward de match_results para um esporte esports
// (lol/dota2/valorant/cs2). Diferente do tênis, aqui os "jogadores" são TIMES,
// features derivadas são Elo overall + por liga + forma + H2H + rest.
//
// Uso:
//   node scripts/extract-esports-features.js --game lol [--out data/lol_features.csv]
//                                             [--min-games-warmup 5]
//
// p1 = time alfabeticamente menor (não o vencedor) → y = 1 se p1 venceu.

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const initDatabase = require('../lib/database');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  return argv[i + 1];
}

const GAME = argVal('game', 'lol');
const OUT = path.resolve(argVal('out', `data/${GAME}_features.csv`));
const MIN_WARMUP = parseInt(argVal('min-games-warmup', '5'), 10);
const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

console.log(`[extract-es] game=${GAME} out=${OUT} min_warmup=${MIN_WARMUP}`);

const { db } = initDatabase(DB_PATH);

// Carrega matches ordenados
const rows = db.prepare(`
  SELECT match_id, team1, team2, winner, final_score, league, resolved_at
  FROM match_results
  WHERE game = ?
    AND team1 IS NOT NULL AND team1 != ''
    AND team2 IS NOT NULL AND team2 != ''
    AND winner IS NOT NULL AND winner != ''
    AND resolved_at IS NOT NULL
  ORDER BY resolved_at ASC
`).all(GAME);

console.log(`[extract-es] ${rows.length} rows carregados`);
if (!rows.length) { console.error('[extract-es] sem dados'); process.exit(1); }

// ── Normalização ──
function norm(s) { return String(s || '').toLowerCase().trim(); }

// ── Elo state ──
const ELO_INIT = 1500;
const K_BASE = 32, K_MIN = 12, K_SCALE = 50;
function kFactor(games) { return K_BASE - (K_BASE - K_MIN) * Math.min(1, games / K_SCALE); }
function eloExpected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }

// Team state: name → { elo, eloLeague:{leagueName→elo}, gamesAll, gamesLeague:{...}, recent:[...] }
const teamState = new Map();
function getT(name) {
  const k = norm(name);
  if (!teamState.has(k)) {
    teamState.set(k, {
      displayName: name,
      elo: ELO_INIT,
      eloLeague: new Map(),
      gamesAll: 0,
      gamesLeague: new Map(),
      recent: [], // [{t, won, opp}]
    });
  }
  return teamState.get(k);
}

// H2H
const h2hState = new Map();
function h2hKey(a, b) { a = norm(a); b = norm(b); return a < b ? `${a}|${b}` : `${b}|${a}`; }
function getH2H(a, b) {
  const k = h2hKey(a, b);
  if (!h2hState.has(k)) {
    h2hState.set(k, { keyA: norm(a) < norm(b) ? norm(a) : norm(b), a: 0, b: 0 });
  }
  return h2hState.get(k);
}

// Best of: parse final_score p/ extrair "Bo3" etc
function parseBestOf(fs) {
  const m = String(fs || '').match(/Bo(\d)/i);
  if (!m) return 1;
  return parseInt(m[1], 10) || 1;
}

// League tier (rule-of-thumb)
function leagueTier(league) {
  const l = String(league || '').toLowerCase();
  if (/lck|lpl|lec|lcs|worlds|msi/.test(l)) return 3; // tier 1
  if (/lla|cblol|vcs|pcs|ljl/.test(l)) return 2;
  if (/masters|academy|emea|lpl2|pro league|one|major|dpc|ti|riyadh|epl|esl pro/i.test(l)) return 2;
  return 1;
}

const DAY_MS = 86400000;

// ── Feature extraction ──
const out = [];
const HEADERS = [
  'date', 'league', 'league_tier',
  't1', 't2', 'best_of',
  'elo_diff_overall', 'elo_diff_league',
  'games_t1', 'games_t2',
  'winrate_diff_10', 'winrate_diff_20',
  'h2h_diff', 'h2h_total',
  'days_since_last_t1', 'days_since_last_t2', 'days_since_diff',
  'matches_last14_diff',
  'n_signals',
  'y',
];

let kept = 0, skipped = 0;

for (const r of rows) {
  const t = new Date(r.resolved_at).getTime();
  if (!Number.isFinite(t)) { skipped++; continue; }
  const league = r.league || '';
  const bestOf = parseBestOf(r.final_score);
  const tier = leagueTier(league);

  // p1 = alfa menor
  const a = norm(r.team1), b = norm(r.team2);
  const [p1Raw, p2Raw] = a < b ? [r.team1, r.team2] : [r.team2, r.team1];
  const p1Won = norm(r.winner) === norm(p1Raw) ? 1 : 0;

  const s1 = getT(p1Raw);
  const s2 = getT(p2Raw);

  // Features (ANTES de atualizar state)
  const eloDiffOverall = s1.elo - s2.elo;
  const eloL1 = s1.eloLeague.get(league) || s1.elo;
  const eloL2 = s2.eloLeague.get(league) || s2.elo;
  const eloDiffLeague = eloL1 - eloL2;

  const wr10_1 = winRateLast(s1.recent, 10);
  const wr10_2 = winRateLast(s2.recent, 10);
  const wrDiff10 = (wr10_1.n >= 5 && wr10_2.n >= 5) ? (wr10_1.pct - wr10_2.pct) : 0;
  const wr20_1 = winRateLast(s1.recent, 20);
  const wr20_2 = winRateLast(s2.recent, 20);
  const wrDiff20 = (wr20_1.n >= 10 && wr20_2.n >= 10) ? (wr20_1.pct - wr20_2.pct) : 0;

  const h2h = getH2H(p1Raw, p2Raw);
  const p1IsKeyA = norm(p1Raw) === h2h.keyA;
  const h2hDiff = p1IsKeyA ? (h2h.a - h2h.b) : (h2h.b - h2h.a);
  const h2hTotal = h2h.a + h2h.b;

  const last1 = s1.recent.length ? s1.recent[s1.recent.length - 1].t : null;
  const last2 = s2.recent.length ? s2.recent[s2.recent.length - 1].t : null;
  const daysSince1 = last1 ? Math.min(120, Math.round((t - last1) / DAY_MS)) : 120;
  const daysSince2 = last2 ? Math.min(120, Math.round((t - last2) / DAY_MS)) : 120;
  const daysSinceDiff = daysSince1 - daysSince2;

  const mCut = t - 14 * DAY_MS;
  const m14_1 = s1.recent.filter(x => x.t >= mCut).length;
  const m14_2 = s2.recent.filter(x => x.t >= mCut).length;
  const matchesLast14Diff = m14_1 - m14_2;

  // Sinais
  let nSignals = 0;
  if (s1.gamesAll >= MIN_WARMUP && s2.gamesAll >= MIN_WARMUP) nSignals++;
  if ((s1.gamesLeague.get(league) || 0) >= 3 && (s2.gamesLeague.get(league) || 0) >= 3) nSignals++;
  if (wr10_1.n >= 5 && wr10_2.n >= 5) nSignals++;
  if (h2hTotal >= 2) nSignals++;
  if (last1 && last2) nSignals++;

  const shouldOutput = s1.gamesAll >= MIN_WARMUP && s2.gamesAll >= MIN_WARMUP;
  if (shouldOutput) {
    out.push([
      new Date(t).toISOString().slice(0, 10),
      (league || '').replace(/,/g, ' '),
      tier,
      (p1Raw || '').replace(/,/g, ' '),
      (p2Raw || '').replace(/,/g, ' '),
      bestOf,
      eloDiffOverall.toFixed(2),
      eloDiffLeague.toFixed(2),
      s1.gamesAll, s2.gamesAll,
      wrDiff10.toFixed(4), wrDiff20.toFixed(4),
      h2hDiff, h2hTotal,
      daysSince1, daysSince2, daysSinceDiff,
      matchesLast14Diff,
      nSignals,
      p1Won,
    ]);
    kept++;
  } else {
    skipped++;
  }

  // Update state
  const wState = norm(r.winner) === norm(p1Raw) ? s1 : s2;
  const lState = wState === s1 ? s2 : s1;

  const expW = eloExpected(wState.elo, lState.elo);
  const kW = kFactor(wState.gamesAll), kL = kFactor(lState.gamesAll);
  wState.elo += kW * (1 - expW);
  lState.elo += kL * (0 - (1 - expW));

  const wEloL = wState.eloLeague.get(league) || ELO_INIT;
  const lEloL = lState.eloLeague.get(league) || ELO_INIT;
  const expWL = eloExpected(wEloL, lEloL);
  const kWL = kFactor(wState.gamesLeague.get(league) || 0);
  const kLL = kFactor(lState.gamesLeague.get(league) || 0);
  wState.eloLeague.set(league, wEloL + kWL * (1 - expWL));
  lState.eloLeague.set(league, lEloL + kLL * (0 - (1 - expWL)));

  wState.gamesAll++; lState.gamesAll++;
  wState.gamesLeague.set(league, (wState.gamesLeague.get(league) || 0) + 1);
  lState.gamesLeague.set(league, (lState.gamesLeague.get(league) || 0) + 1);

  wState.recent.push({ t, won: 1, opp: lState.displayName });
  lState.recent.push({ t, won: 0, opp: wState.displayName });
  if (wState.recent.length > 40) wState.recent.splice(0, wState.recent.length - 40);
  if (lState.recent.length > 40) lState.recent.splice(0, lState.recent.length - 40);

  if (norm(r.winner) === h2h.keyA) h2h.a++; else h2h.b++;
}

function winRateLast(recent, n) {
  const slice = recent.slice(-n);
  if (!slice.length) return { pct: 0.5, n: 0 };
  const wins = slice.filter(x => x.won).length;
  return { pct: wins / slice.length, n: slice.length };
}

// Write
const outDir = path.dirname(OUT);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(OUT, HEADERS.join(',') + '\n' + out.map(r => r.join(',')).join('\n') + '\n', 'utf8');

console.log(`[extract-es] written: ${kept} (skipped=${skipped}) → ${OUT}`);
const yMean = out.length ? out.reduce((s, r) => s + (+r[r.length - 1]), 0) / out.length : 0;
console.log(`[extract-es] y mean (p1 win rate, ~0.5 esperado): ${yMean.toFixed(4)}`);

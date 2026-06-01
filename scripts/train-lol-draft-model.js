#!/usr/bin/env node
// Trains the draft model from oracleselixir_players and writes JSON artifacts to lib/.
// Usage: node scripts/train-lol-draft-model.js [--db sportsedge.db]
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { buildWrTable, buildMatchupMatrix, buildSynergyMatrix, fitLogistic, sigmoid } = require('../lib/lol-draft-train');
const { normalizeChampion } = require('../lib/lol-champions');

const args = process.argv.slice(2);
const dbPath = (args.includes('--db') ? args[args.indexOf('--db') + 1] : (process.env.DB_PATH || 'sportsedge.db'));
// SHRINK_K=100 + L2=0.02 chosen by grid-search walk-forward: weaker shrinkage overfit the
// per-patch meta (OOS Brier worse than a coinflip); this config beats the 0.5 baseline. The
// draft edge over the blue-side base rate is small (~0.0024 Brier) — a modest lean, not a
// confident probability. Champion WR (wrDiff) carries ~no OOS signal; lane+synergy carry the rest.
const SHRINK_K = 100, PRIOR = 0.5;

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(`SELECT gameid, side, position, champion, result, patch, date
  FROM oracleselixir_players WHERE champion IS NOT NULL AND position IS NOT NULL`).all();
console.log(`[train] loaded ${rows.length} player-rows from oracleselixir_players`);
if (rows.length < 1000) { console.error('[train] ABORT: <1000 rows — run /admin sync-oracleselixir first'); process.exit(1); }

function gameFeatures(players, wr, matchups, synergy) {
  const blue = players.filter(p => String(p.side).toLowerCase() === 'blue');
  const red = players.filter(p => String(p.side).toLowerCase() === 'red');
  if (!blue.length || !red.length) return null;
  const shr = (c) => { const k = `${normalizeChampion(c.champion)}|${String(c.position).toLowerCase()}`; const e = wr[k]; return e ? (e.wins + SHRINK_K * PRIOR) / (e.n + SHRINK_K) : PRIOR; };
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0.5;
  const wrDiff = avg(blue.map(shr)) - avg(red.map(shr));
  let laneSum = 0;
  for (const b of blue) {
    const role = String(b.position).toLowerCase();
    const opp = red.find(p => String(p.position).toLowerCase() === role);
    if (!opp) continue;
    const cell = matchups?.[role]?.[normalizeChampion(b.champion)]?.[normalizeChampion(opp.champion)];
    const w = cell ? (cell.wins + SHRINK_K * PRIOR) / (cell.n + SHRINK_K) : PRIOR;
    laneSum += (w - 0.5);
  }
  const synSide = (side) => { const cs = side.map(p => normalizeChampion(p.champion)).filter(Boolean); let s = 0; for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) { const cell = synergy[[cs[i], cs[j]].sort().join('|')]; if (cell) s += ((cell.wins + SHRINK_K * PRIOR) / (cell.n + SHRINK_K) - 0.5); } return s; };
  const synergyDiff = synSide(blue) - synSide(red);
  return { x: [wrDiff, laneSum, synergyDiff, 0], y: blue[0].result ? 1 : 0 };
}

function groupGames(rs) { const g = new Map(); for (const r of rs) { if (!g.has(r.gameid)) g.set(r.gameid, []); g.get(r.gameid).push(r); } return g; }

const patches = [...new Set(rows.map(r => r.patch).filter(Boolean))].sort();
const cut = patches[Math.floor(patches.length * 0.8)] || patches[patches.length - 1];
const trainRows = rows.filter(r => r.patch < cut), testRows = rows.filter(r => r.patch >= cut);

function trainOn(rs) {
  const wr = buildWrTable(rs), matchups = buildMatchupMatrix(rs), synergy = buildSynergyMatrix(rs);
  const samples = [...groupGames(rs).values()].map(p => gameFeatures(p, wr, matchups, synergy)).filter(Boolean);
  const weights = fitLogistic(samples, { epochs: 500, lr: 0.2, l2: 0.02 });
  return { wr, matchups, synergy, weights };
}
function evalOn(model, rs) {
  let brier = 0, ll = 0, base = 0, k = 0;
  for (const players of groupGames(rs).values()) {
    const f = gameFeatures(players, model.wr, model.matchups, model.synergy); if (!f) continue;
    const w = model.weights; const p = sigmoid(w[0] + f.x.reduce((a, xi, i) => a + xi * w[i + 1], 0));
    brier += (p - f.y) ** 2; ll += -(f.y * Math.log(p + 1e-9) + (1 - f.y) * Math.log(1 - p + 1e-9));
    base += (0.5 - f.y) ** 2; k++;
  }
  return { n: k, brier: brier / k, logloss: ll / k, brierBaseline: base / k };
}

const wf = trainOn(trainRows);
const ev = evalOn(wf, testRows);
console.log(`[train] walk-forward (train<${cut}, test>=${cut}): n=${ev.n} Brier=${ev.brier.toFixed(4)} (baseline 0.5-pred=${ev.brierBaseline.toFixed(4)}) logloss=${ev.logloss.toFixed(4)}`);
if (ev.brier >= ev.brierBaseline) console.warn('[train] WARNING: model does NOT beat the 0.5 baseline OOS — review before relying on it.');

const full = trainOn(rows);
const champs = [...new Set(rows.map(r => normalizeChampion(r.champion)).filter(Boolean))].sort();
const meta = { priorWr: PRIOR, shrinkK: SHRINK_K, weights: full.weights, trainedAt: new Date().toISOString(), rows: rows.length, patches: patches.length, walkForward: ev, champCount: champs.length };
const out = (f, o) => fs.writeFileSync(path.join(__dirname, '..', 'lib', f), JSON.stringify(o));
out('lol-draft-wr.json', full.wr);
out('lol-draft-matchups.json', full.matchups);
out('lol-draft-synergy.json', full.synergy);
out('lol-draft-meta.json', meta);
console.log(`[train] wrote artifacts: ${Object.keys(full.wr).length} wr keys, ${champs.length} champions. weights=${JSON.stringify(full.weights.map(w => +w.toFixed(3)))}`);
db.close();

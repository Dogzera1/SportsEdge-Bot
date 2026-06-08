'use strict';
// Point-in-time Elo replay for the CS match predictor (display-only).
// Predicts P(team1 wins); getP() BEFORE rate() (no leakage). Mirrors backtest-dota-match.js.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createEloSystem } = require('../lib/elo-rating');
const { _applyIsotonicBlocks } = require('../lib/brier-holdout-eval');
const M = require('../lib/lol-match-metrics');

const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });
const ELO_CONFIG = { kBase: 32, kMin: 10, kScale: 40, halfLifeDays: 0, confidenceScale: 20, confidenceFloor: 5 };
const clamp01 = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));

const games = db.prepare(`
  SELECT team1, team2, winner, final_score, resolved_at
  FROM match_results
  WHERE game='cs2' AND winner IS NOT NULL AND winner!=''
    AND team1 IS NOT NULL AND team2 IS NOT NULL
  ORDER BY resolved_at ASC
`).all();

const elo = createEloSystem(ELO_CONFIG);
const samples = [];
for (const g of games) {
  const pred = elo.getP(g.team1, g.team2);
  const y = (String(g.winner).toLowerCase() === String(g.team1).toLowerCase()) ? 1 : 0;
  if (pred.foundA && pred.foundB && pred.confidence > 0) samples.push({ p: pred.pA, y, date: g.resolved_at });
  const winner = y ? g.team1 : g.team2, loser = y ? g.team2 : g.team1;
  const sc = String(g.final_score || '').match(/(\d+)\s*[-:]\s*(\d+)/);
  const margin = sc ? Math.max(1, Math.abs(parseInt(sc[1]) - parseInt(sc[2]))) : 1;
  elo.rate(winner, loser, margin, g.resolved_at);
}
db.close();

samples.sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
const cut = Math.floor(samples.length * 0.7);
const train = samples.slice(0, cut), test = samples.slice(cut);
const pStar = train.reduce((s, x) => s + x.y, 0) / Math.max(1, train.length);

function fitIsotonicPav(smp, nBins = 12) {
  if (!smp.length) return [];
  const bins = Array.from({ length: nBins }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  for (const { p, y } of smp) { let i = Math.floor(clamp01(p) * nBins); i = Math.max(0, Math.min(nBins - 1, i)); bins[i].sumP += p; bins[i].sumY += y; bins[i].n++; }
  let arr = bins.filter(b => b.n >= 3).map(b => ({ pMin: b.sumP / b.n, pMax: b.sumP / b.n, yMean: b.sumY / b.n, n: b.n }));
  if (arr.length < 2) return [];
  let i = 0;
  while (i < arr.length - 1) {
    if (arr[i].yMean > arr[i + 1].yMean) { const a = arr[i], b = arr[i + 1], n = a.n + b.n; arr.splice(i, 2, { pMin: Math.min(a.pMin, b.pMin), pMax: Math.max(a.pMax, b.pMax), yMean: (a.yMean * a.n + b.yMean * b.n) / n, n }); if (i > 0) i--; } else i++;
  }
  arr.sort((a, b) => a.pMin - b.pMin);
  for (let k = 0; k < arr.length; k++) { arr[k].pMin = (k === 0) ? 0 : (arr[k - 1].pMax + arr[k].pMin) / 2; arr[k].pMax = (k === arr.length - 1) ? 1 : arr[k].pMax; }
  for (let k = 0; k < arr.length - 1; k++) { const mid = (arr[k].pMax + arr[k + 1].pMin) / 2; arr[k].pMax = mid; arr[k + 1].pMin = mid; }
  return arr.map(b => ({ pMin: +b.pMin.toFixed(6), pMax: +b.pMax.toFixed(6), yMean: +b.yMean.toFixed(6), n: b.n }));
}
let blocks = fitIsotonicPav(train);
const testRaw = test.map(s => ({ p: s.p, y: s.y }));
const testCal = test.map(s => ({ p: _applyIsotonicBlocks(blocks, s.p), y: s.y }));
const brierRaw = M.brier(testRaw);
const brierCal = blocks.length ? M.brier(testCal) : Infinity;
const keptOOS = blocks.length > 0 && brierCal < brierRaw;
if (!keptOOS) blocks = [];
const baselineBrier = M.brier(test.map(s => ({ p: pStar, y: s.y })));

console.log(`[cs] n=${samples.length} (train=${train.length} test=${test.length}) baseRate(team1)=${pStar.toFixed(4)}`);
console.log(`[cs] Elo raw:   Brier=${brierRaw.toFixed(4)} ECE=${M.ece(testRaw).toFixed(4)}`);
console.log(`[cs] baseline:  Brier=${baselineBrier.toFixed(4)}`);
console.log(`[cs] Elo beats base-rate OOS? ${brierRaw < baselineBrier ? 'YES' : 'NO'}  | calib kept? ${keptOOS}`);

fs.writeFileSync(path.join(__dirname, '..', 'lib', 'cs-match-meta.json'), JSON.stringify({
  game: 'cs2', level: 'match', predicts: 'P(team1 wins)', eloConfig: ELO_CONFIG, trainedAt: new Date().toISOString(),
  n: samples.length, walkForward: { trainN: train.length, testN: test.length }, baseRate: +pStar.toFixed(6),
  oos: { baselineBrier: +baselineBrier.toFixed(6), eloRawBrier: +brierRaw.toFixed(6), eloRawEce: +M.ece(testRaw).toFixed(6), beatsBaseline: brierRaw < baselineBrier },
}, null, 2));
fs.writeFileSync(path.join(__dirname, '..', 'lib', 'cs-match-calib.json'), JSON.stringify({ method: 'isotonic_pav', blocks, keptOOS }, null, 2));
console.log('[cs] wrote lib/cs-match-meta.json + lib/cs-match-calib.json');

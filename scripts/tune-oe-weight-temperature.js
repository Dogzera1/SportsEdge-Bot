#!/usr/bin/env node
'use strict';

/**
 * tune-oe-weight-temperature.js
 *
 * Explora trade-off entre acurácia e calibração (ECE) do OE sub-model.
 * Testa:
 *   (1) Sweep de W_OE ∈ {0.00, 0.05, 0.08, 0.10, 0.12, 0.15}
 *   (2) Temperature scaling: p' = sigmoid(logit(p) / T), T ∈ {1.0, 1.2, 1.5, 2.0}
 *   (3) Matriz combinada.
 *
 * Split chronológico 80/20 (mesmo do backtest-lol-model.js). Pra cada config,
 * reporta Brier / LogLoss / Acc / ECE. Identifica config que minimiza ECE
 * mantendo accuracy ≥ 67%.
 */

const path = require('path');
const Database = require('better-sqlite3');
const { createEloSystem, eloExpected } = require('../lib/elo-rating');
const { computeRegionalStrengths, classifyLeagueRegion } = require('../lib/lol-regional-strength');
const { shrinkForBestOf } = require('../lib/lol-series-model');
const { classifyLeague } = require('../lib/lol-model');

const DB_PATH = path.resolve(__dirname, '..', 'sportsedge.db');
const TRAIN_FRACTION = 0.80;
const W_OE_VALUES = [0.00, 0.05, 0.08, 0.10, 0.12, 0.15];
const T_VALUES = [1.0, 1.2, 1.5, 2.0];
const MIN_ACC = 0.67;

function parseFinal(fs) {
  if (!fs) return null;
  const m = String(fs).match(/Bo(\d)\s+(\d+)-(\d+)/i);
  if (!m) return null;
  return { bestOf: parseInt(m[1], 10), s1: parseInt(m[2], 10), s2: parseInt(m[3], 10) };
}
function normTeam(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); }
function brier(p, y) { return (p - y) ** 2; }
function logloss(p, y) {
  const eps = 1e-12;
  const pc = Math.max(eps, Math.min(1 - eps, p));
  return -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
}
function computeECE(preds, outcomes, nBuckets = 10) {
  const buckets = Array.from({ length: nBuckets }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  for (let i = 0; i < preds.length; i++) {
    const p = preds[i], y = outcomes[i];
    const idx = Math.min(nBuckets - 1, Math.floor(p * nBuckets));
    buckets[idx].sumP += p; buckets[idx].sumY += y; buckets[idx].n++;
  }
  let ece = 0; const total = preds.length;
  for (const b of buckets) {
    if (!b.n) continue;
    ece += (b.n / total) * Math.abs(b.sumP / b.n - b.sumY / b.n);
  }
  return ece;
}
function applyTemperature(p, T) {
  if (T === 1.0) return p;
  const eps = 1e-9;
  const pc = Math.max(eps, Math.min(1 - eps, p));
  const logit = Math.log(pc / (1 - pc));
  return 1 / (1 + Math.exp(-logit / T));
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const all = db.prepare(`
    SELECT team1, team2, winner, final_score, league, resolved_at
    FROM match_results
    WHERE game='lol' AND winner IS NOT NULL AND winner != ''
      AND final_score LIKE 'Bo%'
      AND resolved_at >= datetime('now','-2 years')
    ORDER BY resolved_at ASC
  `).all();
  const series = [];
  for (const r of all) {
    const sc = parseFinal(r.final_score);
    if (sc) series.push({ ...r, ...sc });
  }
  const splitIdx = Math.floor(series.length * TRAIN_FRACTION);
  const train = series.slice(0, splitIdx);
  const test = series.slice(splitIdx);
  const splitDate = train[train.length - 1].resolved_at;
  console.log(`Train: ${train.length} | Test: ${test.length} | Split: ${splitDate}`);

  // Elo on train
  const elo = createEloSystem({
    initialRating: 1500, kBase: 32, kMin: 10, kScale: 40,
    halfLifeDays: 60, homeAdvantage: 0,
    marginFactor: 0.5, confidenceScale: 20, confidenceFloor: 5,
  });
  for (const m of train) {
    const tier = classifyLeague(m.league);
    const winner1 = normTeam(m.winner) === normTeam(m.team1);
    elo.rate(winner1 ? m.team1 : m.team2, winner1 ? m.team2 : m.team1,
      Math.abs(m.s1 - m.s2), m.resolved_at, tier);
  }

  // Regional offsets train-only
  const { offsets: regOffsets, teamRegion } = computeRegionalStrengths(db, { maxDateIso: splitDate });
  function regionalOffsetFor(team, league) {
    const lr = classifyLeagueRegion(league);
    if (lr && regOffsets[lr] !== undefined) return regOffsets[lr];
    const tr = teamRegion.get(normTeam(team));
    if (tr && regOffsets[tr] !== undefined) return regOffsets[tr];
    return 0;
  }

  // Preload OE data
  const oeRows = db.prepare(`
    SELECT teamname, date, result, golddiffat15, xpdiffat15,
           firstdragon, firstbaron, firsttower
    FROM oracleselixir_games WHERE date IS NOT NULL
  `).all();
  const oeByTeam = new Map();
  for (const r of oeRows) {
    const nt = normTeam(r.teamname);
    if (!oeByTeam.has(nt)) oeByTeam.set(nt, []);
    oeByTeam.get(nt).push(r);
  }
  for (const arr of oeByTeam.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));

  function oeStatsFor(team, matchDateIso, sinceDays = 60, minGames = 5) {
    const arr = oeByTeam.get(normTeam(team));
    if (!arr) return null;
    const cutoff = new Date(matchDateIso);
    const since = new Date(cutoff.getTime() - sinceDays * 86400_000);
    const rows = arr.filter(r => {
      const d = new Date(r.date);
      return d < cutoff && d >= since;
    });
    if (rows.length < minGames) return null;
    let wins = 0, gd = 0, gdN = 0, fd = 0, fb = 0, ft = 0;
    for (const r of rows) {
      wins += r.result || 0;
      if (Number.isFinite(r.golddiffat15)) { gd += r.golddiffat15; gdN++; }
      if (r.firstdragon === 1) fd++;
      if (r.firstbaron === 1) fb++;
      if (r.firsttower === 1) ft++;
    }
    const n = rows.length;
    return {
      games: n, winRate: wins / n,
      avgGdAt15: gdN ? gd / gdN : null,
      firstDragonRate: fd / n, firstBaronRate: fb / n, firstTowerRate: ft / n,
    };
  }
  function oePA(team1, team2, dateIso) {
    const s1 = oeStatsFor(team1, dateIso);
    const s2 = oeStatsFor(team2, dateIso);
    if (!s1 || !s2) return null;
    const gd15Diff = (s1.avgGdAt15 || 0) - (s2.avgGdAt15 || 0);
    const obj1 = (s1.firstDragonRate + s1.firstBaronRate + s1.firstTowerRate) / 3;
    const obj2 = (s2.firstDragonRate + s2.firstBaronRate + s2.firstTowerRate) / 3;
    const objDiff = obj1 - obj2;
    const wrDiff = s1.winRate - s2.winRate;
    const logit = Math.tanh(gd15Diff / 1500) * 1.2 + Math.tanh(objDiff / 0.3) * 0.8 + wrDiff * 3.0;
    return { pA: 1 / (1 + Math.exp(-logit)), conf: Math.min(1.0, Math.min(s1.games, s2.games) / 15) };
  }

  // Pre-compute base P (regional + shrinkage) e OE para cada test match
  const basePreds = []; // {pBase, pOE, confOE, y1}
  for (const m of test) {
    const tier = classifyLeague(m.league);
    const r = elo.getP(m.team1, m.team2, tier);
    if (!r.foundA || !r.foundB || r.confidence < 0.3) continue;
    const y1 = normTeam(m.winner) === normTeam(m.team1) ? 1 : 0;
    const offA = regionalOffsetFor(m.team1, m.league);
    const offB = regionalOffsetFor(m.team2, m.league);
    const pReg = (offA !== 0 || offB !== 0)
      ? eloExpected(r.ratingA + offA, r.ratingB + offB) : r.pA;
    const pBase = shrinkForBestOf(pReg, m.bestOf);
    const oe = oePA(m.team1, m.team2, m.resolved_at);
    basePreds.push({ pBase, oe, y1 });
  }

  // Matriz de resultados
  console.log(`\nBase preds: ${basePreds.length}`);
  console.log('W_OE \\ T    ' + T_VALUES.map(t => `T=${t.toFixed(1).padStart(4)}`).join('  '));
  console.log('---------------------------------------------------------------------------');

  const matrix = [];
  for (const wOE of W_OE_VALUES) {
    const row = [`${wOE.toFixed(2)}`.padStart(10)];
    const rowScores = [];
    for (const T of T_VALUES) {
      let briers = 0, lls = 0, correct = 0;
      const preds = [], outs = [];
      for (const bp of basePreds) {
        let p;
        if (bp.oe) {
          const w = wOE * bp.oe.conf;
          p = (bp.pBase + bp.oe.pA * w) / (1 + w);
        } else p = bp.pBase;
        p = applyTemperature(p, T);
        briers += brier(p, bp.y1);
        lls += logloss(p, bp.y1);
        if ((p >= 0.5 ? 1 : 0) === bp.y1) correct++;
        preds.push(p); outs.push(bp.y1);
      }
      const n = basePreds.length;
      const acc = correct / n;
      const ece = computeECE(preds, outs);
      const s = { wOE, T, brier: briers / n, ll: lls / n, acc, ece };
      rowScores.push(s);
      matrix.push(s);
      row.push(`A${(acc*100).toFixed(1)}/E${(ece*100).toFixed(1)}`.padStart(10));
    }
    console.log(row.join(' '));
  }

  // Identifica melhor: menor ECE com acc ≥ MIN_ACC
  const eligible = matrix.filter(s => s.acc >= MIN_ACC);
  console.log(`\nConfigs com acc ≥ ${MIN_ACC*100}%: ${eligible.length}/${matrix.length}`);
  if (eligible.length) {
    eligible.sort((a, b) => a.ece - b.ece);
    console.log('\nTop 5 por ECE (acc ≥ cutoff):');
    for (const s of eligible.slice(0, 5)) {
      console.log(`  W=${s.wOE.toFixed(2)} T=${s.T.toFixed(1)} | Brier=${s.brier.toFixed(4)} LL=${s.ll.toFixed(4)} Acc=${(s.acc*100).toFixed(1)}% ECE=${s.ece.toFixed(4)}`);
    }
  }

  // Top 5 por log-loss (equilibra acc+calibração)
  console.log('\nTop 5 por LogLoss (independente de cutoff):');
  matrix.sort((a, b) => a.ll - b.ll);
  for (const s of matrix.slice(0, 5)) {
    console.log(`  W=${s.wOE.toFixed(2)} T=${s.T.toFixed(1)} | Brier=${s.brier.toFixed(4)} LL=${s.ll.toFixed(4)} Acc=${(s.acc*100).toFixed(1)}% ECE=${s.ece.toFixed(4)}`);
  }
}

main().catch(e => { console.error('ERR:', e); process.exit(1); });

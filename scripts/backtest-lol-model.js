#!/usr/bin/env node
'use strict';

/**
 * backtest-lol-model.js
 *
 * Isola impacto de cada melhoria recente do modelo LoL:
 *   (A) baseline        = Elo puro (tier1/tier2, sem regional, sem shrinkage)
 *   (B) +regional       = A + offsets inter-regionais (LCK/LPL/LCS/etc)
 *   (C) +regional+shrk  = B + BO1 shrinkage (factor 0.85 pra BO1)
 *
 * Split chronológico 80/20. Regional offsets computados SÓ com train data
 * pra evitar leakage. Métricas: Brier, log-loss, accuracy, ECE (10 buckets).
 */

const path = require('path');
const Database = require('better-sqlite3');
const { createEloSystem, eloExpected } = require('../lib/elo-rating');
const { computeRegionalStrengths, classifyLeagueRegion } = require('../lib/lol-regional-strength');
const { shrinkForBestOf } = require('../lib/lol-series-model');
const { classifyLeague } = require('../lib/lol-model');

const DB_PATH = path.resolve(__dirname, '..', 'sportsedge.db');
const TRAIN_FRACTION = 0.80;

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
  // Expected Calibration Error com 10 buckets uniformes em [0,1]
  const buckets = Array.from({ length: nBuckets }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  for (let i = 0; i < preds.length; i++) {
    const p = preds[i], y = outcomes[i];
    let idx = Math.min(nBuckets - 1, Math.floor(p * nBuckets));
    buckets[idx].sumP += p;
    buckets[idx].sumY += y;
    buckets[idx].n++;
  }
  let ece = 0, total = preds.length;
  for (const b of buckets) {
    if (b.n === 0) continue;
    const avgP = b.sumP / b.n, avgY = b.sumY / b.n;
    ece += (b.n / total) * Math.abs(avgP - avgY);
  }
  return ece;
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
    if (!sc) continue;
    series.push({ ...r, ...sc });
  }
  const splitIdx = Math.floor(series.length * TRAIN_FRACTION);
  const train = series.slice(0, splitIdx);
  const test = series.slice(splitIdx);
  const splitDate = train[train.length - 1].resolved_at;

  console.log(`Total: ${series.length} | Train: ${train.length} | Test: ${test.length}`);
  console.log(`Split date: ${splitDate}`);

  // ── Bootstrap Elo em train ──
  const elo = createEloSystem({
    initialRating: 1500, kBase: 32, kMin: 10, kScale: 40,
    halfLifeDays: 60, homeAdvantage: 0,
    marginFactor: 0.5, confidenceScale: 20, confidenceFloor: 5,
  });
  for (const m of train) {
    const tier = classifyLeague(m.league);
    const winner1 = normTeam(m.winner) === normTeam(m.team1);
    const wName = winner1 ? m.team1 : m.team2;
    const lName = winner1 ? m.team2 : m.team1;
    const margin = Math.abs(m.s1 - m.s2);
    elo.rate(wName, lName, margin, m.resolved_at, tier);
  }

  // ── Compute regional strengths no train apenas ──
  const { offsets: regOffsets, teamRegion } = computeRegionalStrengths(db, { maxDateIso: splitDate });
  console.log('\nRegional offsets (train only):');
  Object.entries(regOffsets).sort((a,b) => b[1] - a[1]).forEach(([k,v]) => {
    console.log(`  ${k.padEnd(6)}${v >= 0 ? '+' : ''}${v.toFixed(1)}`);
  });

  function regionalOffsetFor(team, league) {
    const lr = classifyLeagueRegion(league);
    if (lr && regOffsets[lr] !== undefined) return regOffsets[lr];
    const tr = teamRegion.get(normTeam(team));
    if (tr && regOffsets[tr] !== undefined) return regOffsets[tr];
    return 0;
  }

  // ── Scoring loops ──
  const variants = ['A_baseline', 'B_regional', 'C_regional_shrink'];
  const scores = {};
  for (const v of variants) scores[v] = { brier: 0, logloss: 0, correct: 0, n: 0, preds: [], outcomes: [] };

  let usedCount = 0;
  for (const m of test) {
    const tier = classifyLeague(m.league);
    const r = elo.getP(m.team1, m.team2, tier);
    if (!r.foundA || !r.foundB || r.confidence < 0.3) continue;
    usedCount++;

    const y1 = normTeam(m.winner) === normTeam(m.team1) ? 1 : 0;

    // (A) baseline
    const pA_base = r.pA;
    // (B) regional
    const offA = regionalOffsetFor(m.team1, m.league);
    const offB = regionalOffsetFor(m.team2, m.league);
    const pA_reg = (offA !== 0 || offB !== 0)
      ? eloExpected(r.ratingA + offA, r.ratingB + offB)
      : pA_base;
    // (C) regional + shrinkage (só BO1 difere)
    const pA_shrk = shrinkForBestOf(pA_reg, m.bestOf);

    for (const [k, p] of [['A_baseline', pA_base], ['B_regional', pA_reg], ['C_regional_shrink', pA_shrk]]) {
      const s = scores[k];
      s.brier += brier(p, y1);
      s.logloss += logloss(p, y1);
      if ((p >= 0.5 ? 1 : 0) === y1) s.correct++;
      s.n++;
      s.preds.push(p);
      s.outcomes.push(y1);
    }
  }

  console.log(`\nScored ${usedCount} test matches`);
  console.log('\nVariant              | Brier    | LogLoss  | Acc     | ECE');
  console.log('---------------------|----------|----------|---------|---------');
  for (const v of variants) {
    const s = scores[v];
    const brierAvg = s.brier / s.n;
    const llAvg = s.logloss / s.n;
    const acc = s.correct / s.n;
    const ece = computeECE(s.preds, s.outcomes);
    console.log(`${v.padEnd(21)}|  ${brierAvg.toFixed(4)}  |  ${llAvg.toFixed(4)}  |  ${(acc*100).toFixed(1)}%  |  ${ece.toFixed(4)}`);
  }

  // Δ vs baseline
  console.log('\nDeltas vs A_baseline:');
  const base = scores.A_baseline;
  const baseBrier = base.brier / base.n, baseLL = base.logloss / base.n;
  for (const v of ['B_regional', 'C_regional_shrink']) {
    const s = scores[v];
    const dB = (s.brier / s.n) - baseBrier;
    const dLL = (s.logloss / s.n) - baseLL;
    const dAcc = (s.correct - base.correct) / base.n * 100;
    console.log(`  ${v}: ΔBrier=${dB >= 0 ? '+' : ''}${dB.toFixed(4)} | ΔLogLoss=${dLL >= 0 ? '+' : ''}${dLL.toFixed(4)} | ΔAcc=${dAcc >= 0 ? '+' : ''}${dAcc.toFixed(2)}pp`);
  }

  // Subset: inter-regional test matches apenas (onde B_regional tem efeito)
  console.log('\n── Subset: inter-regional matches only ──');
  const regionalIdx = [];
  for (let i = 0; i < test.length; i++) {
    const m = test[i];
    const lr1 = classifyLeagueRegion(m.league);
    const isInter = /worlds|msi|first stand|red bull|mid[- ]?season/i.test(m.league);
    if (isInter) regionalIdx.push(i);
  }
  console.log(`Inter-regional test matches: ${regionalIdx.length}`);
  if (regionalIdx.length >= 20) {
    const subScores = {};
    for (const v of variants) subScores[v] = { brier: 0, logloss: 0, correct: 0, n: 0 };
    let j = 0, iScored = 0;
    for (const m of test) {
      const isInter = /worlds|msi|first stand|red bull|mid[- ]?season/i.test(m.league);
      if (!isInter) continue;
      const r = elo.getP(m.team1, m.team2, classifyLeague(m.league));
      if (!r.foundA || !r.foundB || r.confidence < 0.3) continue;
      const y1 = normTeam(m.winner) === normTeam(m.team1) ? 1 : 0;
      const offA = regionalOffsetFor(m.team1, m.league);
      const offB = regionalOffsetFor(m.team2, m.league);
      const pA_base = r.pA;
      const pA_reg = eloExpected(r.ratingA + offA, r.ratingB + offB);
      const pA_shrk = shrinkForBestOf(pA_reg, m.bestOf);
      for (const [k, p] of [['A_baseline', pA_base], ['B_regional', pA_reg], ['C_regional_shrink', pA_shrk]]) {
        const s = subScores[k];
        s.brier += brier(p, y1);
        s.logloss += logloss(p, y1);
        if ((p >= 0.5 ? 1 : 0) === y1) s.correct++;
        s.n++;
      }
      iScored++;
    }
    console.log(`Inter-regional scored: ${iScored}`);
    console.log('Variant              | Brier    | LogLoss  | Acc');
    for (const v of variants) {
      const s = subScores[v];
      if (s.n === 0) continue;
      console.log(`${v.padEnd(21)}|  ${(s.brier/s.n).toFixed(4)}  |  ${(s.logloss/s.n).toFixed(4)}  |  ${(s.correct/s.n*100).toFixed(1)}%`);
    }
  }
}

main().catch(e => { console.error('ERR:', e); process.exit(1); });

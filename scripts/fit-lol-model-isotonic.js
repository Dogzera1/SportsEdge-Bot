#!/usr/bin/env node
'use strict';

/**
 * fit-lol-model-isotonic.js
 *
 * Fit de calibração isotônica (PAV) sobre as probabilidades finais do
 * getLolProbability. Split 3-way chronológico:
 *   train  (70%) → bootstrap Elo + regional offsets
 *   calib  (15%) → gera (pred, y) pairs e ajusta PAV
 *   test   (15%) → avalia metrics com e sem isotônica aplicada
 *
 * Output: lib/lol-model-isotonic.json — blocks compatíveis com applyIsotonic()
 * de lib/esports-model-trained.js.
 *
 * Métrica objetivo: reduzir ECE mantendo Brier/LL. Reporta delta.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createEloSystem, eloExpected } = require('../lib/elo-rating');
const { computeRegionalStrengths, classifyLeagueRegion } = require('../lib/lol-regional-strength');
const { shrinkForBestOf } = require('../lib/lol-series-model');
const { classifyLeague } = require('../lib/lol-model');

const DB_PATH = path.resolve(__dirname, '..', 'sportsedge.db');
const OUT_PATH = path.resolve(__dirname, '..', 'lib', 'lol-model-isotonic.json');
const BIN_WIDTH = 0.05;
const MIN_BIN = 5; // mínimo de obs por bin pra considerar

const W_OE = 0.15;

// ── Utils ─────────────────────────────────────────────────────────────────
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
function computeECE(preds, outcomes, n = 10) {
  const buckets = Array.from({ length: n }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  for (let i = 0; i < preds.length; i++) {
    const p = preds[i], y = outcomes[i];
    const idx = Math.min(n - 1, Math.floor(p * n));
    buckets[idx].sumP += p; buckets[idx].sumY += y; buckets[idx].n++;
  }
  let e = 0, total = preds.length;
  for (const b of buckets) {
    if (!b.n) continue;
    e += (b.n / total) * Math.abs(b.sumP / b.n - b.sumY / b.n);
  }
  return e;
}

// ── PAV (Pool Adjacent Violators) → gera blocks ───────────────────────────
function fitPAV(pairs) {
  // pairs: [{ p, y }]. Ordena por p.
  pairs.sort((a, b) => a.p - b.p);
  // 1. Agrupa em bins uniformes
  const bins = new Map();
  for (const { p, y } of pairs) {
    const idx = Math.floor(Math.min(0.9999, p) / BIN_WIDTH);
    if (!bins.has(idx)) bins.set(idx, { pMin: 1, pMax: 0, sumY: 0, sumP: 0, n: 0 });
    const b = bins.get(idx);
    b.pMin = Math.min(b.pMin, p);
    b.pMax = Math.max(b.pMax, p);
    b.sumY += y; b.sumP += p; b.n++;
  }
  // 2. Filtra bins pequenos
  let arr = [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, b]) => ({
      idx,
      pMin: b.pMin, pMax: b.pMax,
      yMean: b.sumY / b.n, pMean: b.sumP / b.n, n: b.n,
    }))
    .filter(b => b.n >= MIN_BIN);

  // 3. PAV: merge bins violadores
  let i = 0;
  while (i < arr.length - 1) {
    if (arr[i].yMean > arr[i + 1].yMean) {
      const a = arr[i], bb = arr[i + 1];
      const merged = {
        idx: a.idx,
        pMin: Math.min(a.pMin, bb.pMin),
        pMax: Math.max(a.pMax, bb.pMax),
        pMean: (a.pMean * a.n + bb.pMean * bb.n) / (a.n + bb.n),
        yMean: (a.yMean * a.n + bb.yMean * bb.n) / (a.n + bb.n),
        n: a.n + bb.n,
      };
      arr.splice(i, 2, merged);
      if (i > 0) i--;
    } else i++;
  }
  return arr.map(b => ({
    pMin: +b.pMin.toFixed(4),
    pMax: +b.pMax.toFixed(4),
    yMean: +b.yMean.toFixed(4),
    n: b.n,
  }));
}

function applyIsotonic(blocks, p) {
  if (!blocks || !blocks.length) return p;
  if (p <= blocks[0].pMax) return blocks[0].yMean;
  const last = blocks[blocks.length - 1];
  if (p >= last.pMin) return last.yMean;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (p >= b.pMin && p <= b.pMax) return b.yMean;
    if (i + 1 < blocks.length) {
      const n = blocks[i + 1];
      if (p > b.pMax && p < n.pMin) {
        const t = (p - b.pMax) / (n.pMin - b.pMax);
        return b.yMean + t * (n.yMean - b.yMean);
      }
    }
  }
  return p;
}

// ── OE helpers ────────────────────────────────────────────────────────────
function preloadOE(db) {
  const rows = db.prepare(`
    SELECT teamname, date, result, golddiffat15, xpdiffat15,
           firstdragon, firstbaron, firsttower
    FROM oracleselixir_games WHERE date IS NOT NULL
  `).all();
  const byTeam = new Map();
  for (const r of rows) {
    const nt = normTeam(r.teamname);
    if (!byTeam.has(nt)) byTeam.set(nt, []);
    byTeam.get(nt).push(r);
  }
  for (const arr of byTeam.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));
  return byTeam;
}
function oeStatsFor(byTeam, team, dateIso, sinceDays = 60, minGames = 5) {
  const arr = byTeam.get(normTeam(team));
  if (!arr) return null;
  const cutoff = new Date(dateIso);
  const since = new Date(cutoff.getTime() - sinceDays * 86400_000);
  const rows = arr.filter(r => { const d = new Date(r.date); return d < cutoff && d >= since; });
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
function oePA(byTeam, t1, t2, dateIso) {
  const s1 = oeStatsFor(byTeam, t1, dateIso);
  const s2 = oeStatsFor(byTeam, t2, dateIso);
  if (!s1 || !s2) return null;
  const gd15Diff = (s1.avgGdAt15 || 0) - (s2.avgGdAt15 || 0);
  const obj1 = (s1.firstDragonRate + s1.firstBaronRate + s1.firstTowerRate) / 3;
  const obj2 = (s2.firstDragonRate + s2.firstBaronRate + s2.firstTowerRate) / 3;
  const logit = Math.tanh(gd15Diff / 1500) * 1.2 + Math.tanh((obj1 - obj2) / 0.3) * 0.8 + (s1.winRate - s2.winRate) * 3.0;
  return { pA: 1 / (1 + Math.exp(-logit)), conf: Math.min(1.0, Math.min(s1.games, s2.games) / 15) };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT team1, team2, winner, final_score, league, resolved_at
    FROM match_results
    WHERE game='lol' AND winner IS NOT NULL AND winner != ''
      AND final_score LIKE 'Bo%'
      AND resolved_at >= datetime('now','-2 years')
    ORDER BY resolved_at ASC
  `).all();
  const series = rows.map(r => ({ ...r, ...parseFinal(r.final_score) })).filter(r => r.bestOf);

  const nTrain = Math.floor(series.length * 0.70);
  const nCalib = Math.floor(series.length * 0.15);
  const train = series.slice(0, nTrain);
  const calib = series.slice(nTrain, nTrain + nCalib);
  const test = series.slice(nTrain + nCalib);
  const splitTrainEnd = train[train.length - 1].resolved_at;
  console.log(`Train: ${train.length} | Calib: ${calib.length} | Test: ${test.length}`);
  console.log(`Train cutoff: ${splitTrainEnd}`);

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
  const { offsets: regOffsets, teamRegion } = computeRegionalStrengths(db, { maxDateIso: splitTrainEnd });
  function regOffFor(team, league) {
    const lr = classifyLeagueRegion(league);
    if (lr && regOffsets[lr] !== undefined) return regOffsets[lr];
    const tr = teamRegion.get(normTeam(team));
    if (tr && regOffsets[tr] !== undefined) return regOffsets[tr];
    return 0;
  }
  const oeByTeam = preloadOE(db);

  function predict(m) {
    const tier = classifyLeague(m.league);
    const r = elo.getP(m.team1, m.team2, tier);
    if (!r.foundA || !r.foundB || r.confidence < 0.3) return null;
    const offA = regOffFor(m.team1, m.league);
    const offB = regOffFor(m.team2, m.league);
    const pReg = (offA !== 0 || offB !== 0)
      ? eloExpected(r.ratingA + offA, r.ratingB + offB) : r.pA;
    let p = shrinkForBestOf(pReg, m.bestOf);
    const oe = oePA(oeByTeam, m.team1, m.team2, m.resolved_at);
    if (oe) {
      const w = W_OE * oe.conf;
      p = (p + oe.pA * w) / (1 + w);
    }
    return p;
  }

  // ── 1. Fit PAV on calib ──
  const calibPairs = [];
  for (const m of calib) {
    const p = predict(m);
    if (p == null) continue;
    const y = normTeam(m.winner) === normTeam(m.team1) ? 1 : 0;
    calibPairs.push({ p, y });
  }
  console.log(`\nCalib pairs: ${calibPairs.length}`);
  const blocks = fitPAV(calibPairs);
  console.log(`PAV blocks: ${blocks.length}`);
  for (const b of blocks) {
    console.log(`  [${b.pMin.toFixed(3)}, ${b.pMax.toFixed(3)}] → y=${b.yMean.toFixed(3)} (n=${b.n})`);
  }

  // ── 2. Evaluate on test ──
  let sR = { brier: 0, ll: 0, correct: 0, n: 0, preds: [], outs: [] };
  let sC = { brier: 0, ll: 0, correct: 0, n: 0, preds: [], outs: [] };
  for (const m of test) {
    const p = predict(m);
    if (p == null) continue;
    const y = normTeam(m.winner) === normTeam(m.team1) ? 1 : 0;
    const pCal = applyIsotonic(blocks, p);
    sR.brier += brier(p, y); sR.ll += logloss(p, y);
    if ((p >= 0.5 ? 1 : 0) === y) sR.correct++;
    sR.n++; sR.preds.push(p); sR.outs.push(y);
    sC.brier += brier(pCal, y); sC.ll += logloss(pCal, y);
    if ((pCal >= 0.5 ? 1 : 0) === y) sC.correct++;
    sC.n++; sC.preds.push(pCal); sC.outs.push(y);
  }

  console.log('\n── Test metrics ──');
  console.log('              Brier     LogLoss   Acc      ECE');
  console.log(`raw       ${(sR.brier/sR.n).toFixed(4)}   ${(sR.ll/sR.n).toFixed(4)}   ${(sR.correct/sR.n*100).toFixed(1)}%   ${computeECE(sR.preds, sR.outs).toFixed(4)}`);
  console.log(`calib     ${(sC.brier/sC.n).toFixed(4)}   ${(sC.ll/sC.n).toFixed(4)}   ${(sC.correct/sC.n*100).toFixed(1)}%   ${computeECE(sC.preds, sC.outs).toFixed(4)}`);

  // ── 3. Save ──
  const out = {
    version: 1,
    fittedAt: new Date().toISOString(),
    method: 'isotonic_pav',
    nCalibSamples: calibPairs.length,
    w_oe: W_OE,
    blocks,
    trainingNote: 'Fit sobre período calib (últimos 15% antes do test). Aplicar pós-blend dos sub-models mas antes do clamp final.',
  };
  try { require('../lib/model-backup').backupBeforeWrite(OUT_PATH); } catch (_) {}
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\nSaved: ${OUT_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });

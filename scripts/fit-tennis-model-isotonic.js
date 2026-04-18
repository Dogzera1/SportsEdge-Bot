#!/usr/bin/env node
'use strict';

/**
 * fit-tennis-model-isotonic.js
 *
 * Fit isotônico (PAV) sobre predictions surface-Elo walk-forward em holdout.
 * Mesmo approach do fit-lol-model-isotonic.js.
 *
 * Split 70/15/15:
 *   train (70%) — bootstrap Elo
 *   calib (15%) — fit PAV
 *   test  (15%) — avalia raw vs calibrated
 *
 * Output: lib/tennis-model-isotonic.json (blocks compatíveis com applyIsotonic)
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { tournamentTier, tennisProhibitedTournament, detectSurface } = require('../lib/tennis-model');

const DB_PATH = path.resolve(__dirname, '..', 'sportsedge.db');
const OUT_PATH = path.resolve(__dirname, '..', 'lib', 'tennis-model-isotonic.json');
const BIN_WIDTH = 0.05;
const MIN_BIN = 5;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
}
function eloExpected(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }
function surfaceKey(league) {
  const s = detectSurface(league);
  if (s === 'grama') return 'grass';
  if (s === 'saibro') return 'clay';
  return 'hard';
}
function brier(p, y) { return (p - y) ** 2; }
function logloss(p, y) {
  const eps = 1e-12;
  const pc = Math.max(eps, Math.min(1 - eps, p));
  return -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
}
function computeECE(preds, outcomes, n = 10) {
  const buckets = Array.from({ length: n }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  for (let i = 0; i < preds.length; i++) {
    const idx = Math.min(n - 1, Math.floor(preds[i] * n));
    buckets[idx].sumP += preds[i]; buckets[idx].sumY += outcomes[i]; buckets[idx].n++;
  }
  let e = 0;
  for (const b of buckets) {
    if (!b.n) continue;
    e += (b.n / preds.length) * Math.abs(b.sumP / b.n - b.sumY / b.n);
  }
  return e;
}

function fitPAV(pairs) {
  pairs.sort((a, b) => a.p - b.p);
  const bins = new Map();
  for (const { p, y } of pairs) {
    const idx = Math.floor(Math.min(0.9999, p) / BIN_WIDTH);
    if (!bins.has(idx)) bins.set(idx, { pMin: 1, pMax: 0, sumY: 0, sumP: 0, n: 0 });
    const b = bins.get(idx);
    b.pMin = Math.min(b.pMin, p);
    b.pMax = Math.max(b.pMax, p);
    b.sumY += y; b.sumP += p; b.n++;
  }
  let arr = [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, b]) => ({
      idx, pMin: b.pMin, pMax: b.pMax,
      yMean: b.sumY / b.n, pMean: b.sumP / b.n, n: b.n,
    }))
    .filter(b => b.n >= MIN_BIN);

  let i = 0;
  while (i < arr.length - 1) {
    if (arr[i].yMean > arr[i + 1].yMean) {
      const a = arr[i], bb = arr[i + 1];
      arr.splice(i, 2, {
        idx: a.idx,
        pMin: Math.min(a.pMin, bb.pMin),
        pMax: Math.max(a.pMax, bb.pMax),
        pMean: (a.pMean * a.n + bb.pMean * bb.n) / (a.n + bb.n),
        yMean: (a.yMean * a.n + bb.yMean * bb.n) / (a.n + bb.n),
        n: a.n + bb.n,
      });
      if (i > 0) i--;
    } else i++;
  }
  return arr.map(b => ({
    pMin: +b.pMin.toFixed(4), pMax: +b.pMax.toFixed(4),
    yMean: +b.yMean.toFixed(4), n: b.n,
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

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT team1, team2, winner, final_score, league, resolved_at
    FROM match_results
    WHERE game='tennis' AND winner IS NOT NULL AND winner != ''
      AND team1 IS NOT NULL AND team2 IS NOT NULL
      AND resolved_at IS NOT NULL
    ORDER BY resolved_at ASC
  `).all();
  // Fix do data bug: 98% das rows históricas têm team1=winner. Shuffle determinístico
  // por match_id pra desenviesar (50% chance de flip team1/team2). Preserva winner.
  function _hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return h; }
  const shuffled = rows.map(r => {
    const seed = _hash((r.team1 || '') + '|' + (r.team2 || '') + '|' + (r.resolved_at || ''));
    if (seed % 2 === 1) {
      return { ...r, team1: r.team2, team2: r.team1 };
    }
    return r;
  });
  // Exclui ITF low-tier
  const filtered = shuffled.filter(r => !tennisProhibitedTournament(r.league).prohibited);
  const nTrain = Math.floor(filtered.length * 0.70);
  const nCalib = Math.floor(filtered.length * 0.15);
  const train = filtered.slice(0, nTrain);
  const calib = filtered.slice(nTrain, nTrain + nCalib);
  const test = filtered.slice(nTrain + nCalib);
  console.log(`Train: ${train.length} | Calib: ${calib.length} | Test: ${test.length}`);

  // State Elo (iterativo em train + calib + test — walk-forward)
  const state = new Map();
  function getP(name) {
    const k = norm(name);
    if (!state.has(k)) {
      state.set(k, { overall: 1500, hard: 1500, clay: 1500, grass: 1500, games: { overall: 0, hard: 0, clay: 0, grass: 0 } });
    }
    return state.get(k);
  }
  function predict(r) {
    const surf = surfaceKey(r.league);
    const p1 = getP(r.team1), p2 = getP(r.team2);
    if (p1.games.overall < 10 || p2.games.overall < 10) return null;
    const hasSurf = p1.games[surf] >= 3 && p2.games[surf] >= 3;
    const r1 = hasSurf ? 0.6 * p1[surf] + 0.4 * p1.overall : p1.overall;
    const r2 = hasSurf ? 0.6 * p2[surf] + 0.4 * p2.overall : p2.overall;
    return { pA: eloExpected(r1, r2), y: norm(r.winner) === norm(r.team1) ? 1 : 0, surf };
  }
  function update(r) {
    const surf = surfaceKey(r.league);
    const p1 = getP(r.team1), p2 = getP(r.team2);
    const y = norm(r.winner) === norm(r.team1) ? 1 : 0;
    const hasSurf = p1.games[surf] >= 3 && p2.games[surf] >= 3;
    const r1 = hasSurf ? 0.6 * p1[surf] + 0.4 * p1.overall : p1.overall;
    const r2 = hasSurf ? 0.6 * p2[surf] + 0.4 * p2.overall : p2.overall;
    const k = 32 * (1 + 0.5 * Math.max(0, 1 - p1.games.overall / 40));
    const expW = eloExpected(r1, r2);
    const delta = k * (y - expW);
    p1.overall += delta; p2.overall -= delta;
    p1[surf] += delta; p2[surf] -= delta;
    p1.games.overall++; p2.games.overall++;
    p1.games[surf]++; p2.games[surf]++;
  }

  // 1. Percorre train só pra construir Elo (não usa predições)
  for (const r of train) update(r);

  // 2. Em calib, colhe predictions → fit PAV
  const calibPairs = [];
  for (const r of calib) {
    const pr = predict(r);
    if (pr) calibPairs.push({ p: pr.pA, y: pr.y });
    update(r);
  }
  console.log(`Calib pairs: ${calibPairs.length}`);
  const blocks = fitPAV(calibPairs);
  console.log(`PAV blocks: ${blocks.length}`);
  for (const b of blocks) console.log(`  [${b.pMin.toFixed(3)}, ${b.pMax.toFixed(3)}] → y=${b.yMean.toFixed(3)} (n=${b.n})`);

  // 3. Em test, avalia raw vs calibrated
  let sR = { bri: 0, ll: 0, cor: 0, preds: [], outs: [] };
  let sC = { bri: 0, ll: 0, cor: 0, preds: [], outs: [] };
  for (const r of test) {
    const pr = predict(r);
    if (!pr) { update(r); continue; }
    const pCal = applyIsotonic(blocks, pr.pA);
    sR.bri += brier(pr.pA, pr.y); sR.ll += logloss(pr.pA, pr.y);
    if ((pr.pA >= 0.5 ? 1 : 0) === pr.y) sR.cor++;
    sR.preds.push(pr.pA); sR.outs.push(pr.y);
    sC.bri += brier(pCal, pr.y); sC.ll += logloss(pCal, pr.y);
    if ((pCal >= 0.5 ? 1 : 0) === pr.y) sC.cor++;
    sC.preds.push(pCal); sC.outs.push(pr.y);
    update(r);
  }
  const n = sR.preds.length;
  console.log(`\n── Test metrics (n=${n}) ──`);
  console.log('          Brier    LogLoss  Acc     ECE');
  console.log(`raw    ${(sR.bri/n).toFixed(4)}   ${(sR.ll/n).toFixed(4)}   ${(sR.cor/n*100).toFixed(1)}%   ${computeECE(sR.preds, sR.outs).toFixed(4)}`);
  console.log(`calib  ${(sC.bri/n).toFixed(4)}   ${(sC.ll/n).toFixed(4)}   ${(sC.cor/n*100).toFixed(1)}%   ${computeECE(sC.preds, sC.outs).toFixed(4)}`);

  fs.writeFileSync(OUT_PATH, JSON.stringify({
    version: 1,
    fittedAt: new Date().toISOString(),
    method: 'isotonic_pav',
    nCalibSamples: calibPairs.length,
    blocks,
    trainingNote: 'Fit sobre surface-Elo walk-forward; aplicar após tennis-model blended output.',
  }, null, 2));
  console.log(`\nSaved: ${OUT_PATH}`);
}

main();

#!/usr/bin/env node
'use strict';

/**
 * fit-esports-isotonic.js
 *
 * Fit PAV isotônico pós-hoc por jogo (lol/dota2/cs2/valorant).
 * Split 70/15/15 chronológico. Output: lib/{game}-isotonic.json.
 *
 * Uso:
 *   node scripts/fit-esports-isotonic.js --game=dota2
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}
const GAME = argVal('game', 'lol');
const DB_PATH = path.resolve(__dirname, '..', 'sportsedge.db');
const OUT_PATH = path.resolve(__dirname, '..', 'lib', `${GAME}-isotonic.json`);
const BIN_WIDTH = 0.05;
const MIN_BIN = 5;

function norm(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); }
function eloExpected(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }
function brier(p, y) { return (p - y) ** 2; }
function logloss(p, y) {
  const eps = 1e-12;
  const pc = Math.max(eps, Math.min(1 - eps, p));
  return -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
}
function computeECE(preds, outs, n = 10) {
  const bk = Array.from({ length: n }, () => ({ sp: 0, sy: 0, n: 0 }));
  for (let i = 0; i < preds.length; i++) {
    const idx = Math.min(n - 1, Math.floor(preds[i] * n));
    bk[idx].sp += preds[i]; bk[idx].sy += outs[i]; bk[idx].n++;
  }
  let e = 0;
  for (const b of bk) if (b.n) e += (b.n / preds.length) * Math.abs(b.sp / b.n - b.sy / b.n);
  return e;
}

function fitPAV(pairs) {
  pairs.sort((a, b) => a.p - b.p);
  const bins = new Map();
  for (const { p, y } of pairs) {
    const idx = Math.floor(Math.min(0.9999, p) / BIN_WIDTH);
    if (!bins.has(idx)) bins.set(idx, { pMin: 1, pMax: 0, sumY: 0, sumP: 0, n: 0 });
    const b = bins.get(idx);
    b.pMin = Math.min(b.pMin, p); b.pMax = Math.max(b.pMax, p);
    b.sumY += y; b.sumP += p; b.n++;
  }
  let arr = [...bins.entries()].sort((a, b) => a[0] - b[0])
    .map(([idx, b]) => ({
      pMin: b.pMin, pMax: b.pMax,
      yMean: b.sumY / b.n, n: b.n,
    }))
    .filter(b => b.n >= MIN_BIN);

  let i = 0;
  while (i < arr.length - 1) {
    if (arr[i].yMean > arr[i + 1].yMean) {
      const a = arr[i], bb = arr[i + 1];
      arr.splice(i, 2, {
        pMin: Math.min(a.pMin, bb.pMin),
        pMax: Math.max(a.pMax, bb.pMax),
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
    WHERE game=? AND winner IS NOT NULL AND winner != ''
      AND team1 IS NOT NULL AND team2 IS NOT NULL
      AND resolved_at IS NOT NULL
    ORDER BY resolved_at ASC
  `).all(GAME);
  const nTrain = Math.floor(rows.length * 0.70);
  const nCalib = Math.floor(rows.length * 0.15);
  const train = rows.slice(0, nTrain);
  const calib = rows.slice(nTrain, nTrain + nCalib);
  const test = rows.slice(nTrain + nCalib);
  console.log(`[fit-iso] game=${GAME} | Train=${train.length} Calib=${calib.length} Test=${test.length}`);

  const state = new Map();
  function getP(name) {
    const k = norm(name);
    if (!state.has(k)) state.set(k, { overall: 1500, games: 0 });
    return state.get(k);
  }
  function predict(r) {
    const p1 = getP(r.team1), p2 = getP(r.team2);
    if (p1.games < 5 || p2.games < 5) return null;
    return { pA: eloExpected(p1.overall, p2.overall), y: norm(r.winner) === norm(r.team1) ? 1 : 0 };
  }
  function update(r) {
    const p1 = getP(r.team1), p2 = getP(r.team2);
    const y = norm(r.winner) === norm(r.team1) ? 1 : 0;
    const pA = eloExpected(p1.overall, p2.overall);
    const k = 32 * (1 + 0.3 * Math.max(0, 1 - p1.games / 50));
    const delta = k * (y - pA);
    p1.overall += delta; p2.overall -= delta;
    p1.games++; p2.games++;
  }

  for (const r of train) update(r);

  const calibPairs = [];
  for (const r of calib) {
    const pr = predict(r);
    if (pr) calibPairs.push({ p: pr.pA, y: pr.y });
    update(r);
  }
  console.log(`Calib pairs: ${calibPairs.length}`);
  const blocks = fitPAV(calibPairs);
  console.log(`PAV blocks: ${blocks.length}`);

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
    version: 1, game: GAME,
    fittedAt: new Date().toISOString(),
    method: 'isotonic_pav',
    nCalibSamples: calibPairs.length,
    blocks,
    trainingNote: 'Walk-forward surface-agnostic Elo; aplicar pós-trained model output.',
  }, null, 2));
  console.log(`\nSaved: ${OUT_PATH}`);
}

main();

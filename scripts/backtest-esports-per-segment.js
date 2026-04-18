#!/usr/bin/env node
'use strict';

/**
 * backtest-esports-per-segment.js
 *
 * Walk-forward Elo per-game → segmenta por (tier × bestOf). Reporta métricas
 * por célula. Uso:
 *   node scripts/backtest-esports-per-segment.js --game=dota2
 *
 * Games suportados: lol, dota2, cs2, valorant.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { leagueTier, parseBestOf } = require('../lib/esports-runtime-features');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}
const GAME = argVal('game', 'lol');
const DB_PATH = path.resolve(__dirname, '..', 'sportsedge.db');
const OUT_PATH = path.resolve(__dirname, '..', 'data', `${GAME}-backtest-per-segment.json`);
const MIN_WARMUP = 5;

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

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT team1, team2, winner, final_score, league, resolved_at
    FROM match_results
    WHERE game = ?
      AND winner IS NOT NULL AND winner != ''
      AND team1 IS NOT NULL AND team1 != ''
      AND team2 IS NOT NULL AND team2 != ''
      AND resolved_at IS NOT NULL
    ORDER BY resolved_at ASC
  `).all(GAME);
  console.log(`[backtest-es] game=${GAME} | ${rows.length} matches`);

  // State Elo
  const state = new Map();
  function getP(name) {
    const k = norm(name);
    if (!state.has(k)) state.set(k, { overall: 1500, games: 0 });
    return state.get(k);
  }

  // segKey = `tier{1|2|3}|Bo{1|3|5}`
  const segments = new Map();
  const segKey = (tier, bo) => `tier${tier}|Bo${bo}`;
  let predicted = 0;

  for (const r of rows) {
    const tier = leagueTier(r.league);
    const bo = parseBestOf(r.final_score, null);
    const p1 = getP(r.team1);
    const p2 = getP(r.team2);
    const pA = eloExpected(p1.overall, p2.overall);
    const y = norm(r.winner) === norm(r.team1) ? 1 : 0;

    if (p1.games >= MIN_WARMUP && p2.games >= MIN_WARMUP) {
      predicted++;
      const key = segKey(tier, bo);
      if (!segments.has(key)) segments.set(key, { preds: [], outs: [], n: 0 });
      const seg = segments.get(key);
      seg.preds.push(pA); seg.outs.push(y); seg.n++;
    }

    // Update Elo
    const k = 32 * (1 + 0.3 * Math.max(0, 1 - p1.games / 50));
    const delta = k * (y - pA);
    p1.overall += delta; p2.overall -= delta;
    p1.games++; p2.games++;
  }
  console.log(`[backtest-es] predicted=${predicted}`);

  const results = [];
  for (const [key, seg] of segments) {
    if (seg.n < 30) continue;
    let bri = 0, ll = 0, cor = 0;
    for (let i = 0; i < seg.n; i++) {
      bri += brier(seg.preds[i], seg.outs[i]);
      ll += logloss(seg.preds[i], seg.outs[i]);
      if ((seg.preds[i] >= 0.5 ? 1 : 0) === seg.outs[i]) cor++;
    }
    const [tierPart, boPart] = key.split('|');
    results.push({
      tier: tierPart, bestOf: boPart,
      n: seg.n,
      brier: +(bri / seg.n).toFixed(4),
      logloss: +(ll / seg.n).toFixed(4),
      acc: +(cor / seg.n).toFixed(4),
      ece: +computeECE(seg.preds, seg.outs).toFixed(4),
    });
  }
  results.sort((a, b) => b.n - a.n);

  // Overall
  let oBri = 0, oLl = 0, oCor = 0, oN = 0;
  const oP = [], oO = [];
  for (const seg of segments.values()) {
    for (let i = 0; i < seg.n; i++) {
      oBri += brier(seg.preds[i], seg.outs[i]);
      oLl += logloss(seg.preds[i], seg.outs[i]);
      if ((seg.preds[i] >= 0.5 ? 1 : 0) === seg.outs[i]) oCor++;
      oN++; oP.push(seg.preds[i]); oO.push(seg.outs[i]);
    }
  }
  const overall = {
    n: oN,
    brier: +(oBri / oN).toFixed(4),
    logloss: +(oLl / oN).toFixed(4),
    acc: +(oCor / oN).toFixed(4),
    ece: +computeECE(oP, oO).toFixed(4),
  };

  console.log(`\n── OVERALL (${GAME}) ──`);
  console.log(`n=${overall.n} | Brier=${overall.brier} | LogLoss=${overall.logloss} | Acc=${(overall.acc*100).toFixed(1)}% | ECE=${overall.ece}`);

  console.log('\n── POR SEGMENTO (n ≥ 30) ──');
  console.log('Tier    Bo    | n      Brier    LL       Acc     ECE   | Δ Brier');
  for (const s of results) {
    const delta = s.brier - overall.brier;
    const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(4);
    const flag = Math.abs(delta) >= 0.015 ? (delta < 0 ? ' ✓ strong' : ' ✗ weak') : '';
    console.log(`${s.tier.padEnd(7)} ${s.bestOf.padEnd(5)} | ${String(s.n).padStart(6)} | ${s.brier.toFixed(4)} | ${s.logloss.toFixed(4)} | ${(s.acc*100).toFixed(1).padStart(5)}% | ${s.ece.toFixed(4)} | ${deltaStr.padStart(7)}${flag}`);
  }

  const outDir = path.dirname(OUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ game: GAME, overall, segments: results, meta: { ranAt: new Date().toISOString() } }, null, 2));
  console.log(`\nSaved: ${OUT_PATH}`);
}

main();

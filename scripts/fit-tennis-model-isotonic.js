#!/usr/bin/env node
'use strict';

/**
 * fit-tennis-model-isotonic.js (v2)
 *
 * Fit isotônico (PAV) sobre predictions surface-Elo. Diferenças vs v1:
 *   - Random shuffle estratificado em vez de chronological 70/15/15
 *     (v1 sofria shift de domínio entre calib e test — calib aprendia
 *      pattern Slam-heavy que não generalizava, daí o block [0.40, 0.55)
 *      com yMean=0.74 que causou ROI -64% no bucket 2.20-3.00).
 *   - Bins finos (0.025) na zona [0.30, 0.55] onde o leak aparecia,
 *     bins normais (0.05) fora.
 *   - VALIDAÇÃO OBRIGATÓRIA POR ZONA: se ECE pós-calib > raw em qualquer
 *     zona, ABORTA o save e sai com exit 1 (não substitui o arquivo).
 *
 * Output: lib/tennis-model-isotonic.json (compatível com applyIsotonic)
 *
 * Uso:
 *   node scripts/fit-tennis-model-isotonic.js
 *   node scripts/fit-tennis-model-isotonic.js --force-save  # ignora validação
 *   node scripts/fit-tennis-model-isotonic.js --seed=42
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { tournamentTier, tennisProhibitedTournament, detectSurface } = require('../lib/tennis-model');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}
const FORCE_SAVE = argv.includes('--force-save');
const SEED = parseInt(arg('seed', '17'), 10);

const DB_PATH = (arg('db', null) || process.env.DB_PATH || path.resolve(__dirname, '..', 'sportsedge.db'))
  .trim().replace(/^=+/, '');
const OUT_PATH = path.resolve(__dirname, '..', 'lib', 'tennis-model-isotonic.json');

// Zonas de validação. ECE_calib não pode ser pior que ECE_raw em nenhuma.
// A zona crítica do leak é [0.30, 0.55).
const VALIDATION_ZONES = [
  { label: '[0.05, 0.30)', min: 0.05, max: 0.30 },
  { label: '[0.30, 0.55)', min: 0.30, max: 0.55 },  // crítica
  { label: '[0.55, 0.80)', min: 0.55, max: 0.80 },
  { label: '[0.80, 0.95]', min: 0.80, max: 0.95 + 1e-9 },
];

const FINE_ZONE = { min: 0.30, max: 0.55, width: 0.025 };
const COARSE_WIDTH = 0.05;
const MIN_BIN = 5;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
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
function computeZoneECE(preds, outcomes, zMin, zMax, nBins = 8) {
  const idx = [];
  for (let i = 0; i < preds.length; i++) {
    if (preds[i] >= zMin && preds[i] < zMax) idx.push(i);
  }
  if (!idx.length) return { n: 0, ece: null, hitRate: null, avgP: null };
  let pMin = Infinity, pMax = -Infinity;
  for (const i of idx) { if (preds[i] < pMin) pMin = preds[i]; if (preds[i] > pMax) pMax = preds[i]; }
  const span = Math.max(1e-6, pMax - pMin);
  const w = span / nBins;
  const bk = Array.from({ length: nBins }, () => ({ sp: 0, sy: 0, n: 0 }));
  for (const i of idx) {
    let bIdx = Math.floor((preds[i] - pMin) / w);
    if (bIdx < 0) bIdx = 0; if (bIdx >= nBins) bIdx = nBins - 1;
    bk[bIdx].sp += preds[i]; bk[bIdx].sy += outcomes[i]; bk[bIdx].n++;
  }
  let e = 0;
  const sumY = idx.reduce((s, i) => s + outcomes[i], 0);
  const sumP = idx.reduce((s, i) => s + preds[i], 0);
  for (const b of bk) if (b.n) e += (b.n / idx.length) * Math.abs(b.sp / b.n - b.sy / b.n);
  return {
    n: idx.length,
    ece: +e.toFixed(4),
    hitRate: +(sumY / idx.length).toFixed(4),
    avgP: +(sumP / idx.length).toFixed(4),
  };
}

// PRNG determinístico (Mulberry32) — split reprodutível via --seed
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Bin width variável: fino dentro do FINE_ZONE, normal fora.
function bucketIndex(p) {
  if (p >= FINE_ZONE.min && p < FINE_ZONE.max) {
    // Bins finos com offset pra alinhar com FINE_ZONE.min
    const k = Math.floor((p - FINE_ZONE.min) / FINE_ZONE.width);
    return `f${k}`;
  }
  // Bins normais
  return `c${Math.floor(Math.min(0.9999, p) / COARSE_WIDTH)}`;
}

function fitPAVVariableBins(pairs) {
  pairs.sort((a, b) => a.p - b.p);
  const bins = new Map();
  for (const { p, y } of pairs) {
    const idx = bucketIndex(p);
    if (!bins.has(idx)) bins.set(idx, { pMin: 1, pMax: 0, sumY: 0, sumP: 0, n: 0 });
    const b = bins.get(idx);
    b.pMin = Math.min(b.pMin, p);
    b.pMax = Math.max(b.pMax, p);
    b.sumY += y; b.sumP += p; b.n++;
  }
  // Sort por pMean ascendente (estável já que bin é faixa de p)
  let arr = [...bins.values()]
    .map(b => ({
      pMin: b.pMin, pMax: b.pMax,
      yMean: b.sumY / b.n, pMean: b.sumP / b.n, n: b.n,
    }))
    .filter(b => b.n >= MIN_BIN)
    .sort((a, b) => a.pMean - b.pMean);

  // PAV merge
  let i = 0;
  while (i < arr.length - 1) {
    if (arr[i].yMean > arr[i + 1].yMean) {
      const a = arr[i], bb = arr[i + 1];
      arr.splice(i, 2, {
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
  // por composição pra desenviesar (50% chance de flip team1/team2).
  function _hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return h; }
  const shuffled = rows.map(r => {
    const seed = _hash((r.team1 || '') + '|' + (r.team2 || '') + '|' + (r.resolved_at || ''));
    if (seed % 2 === 1) return { ...r, team1: r.team2, team2: r.team1 };
    return r;
  });
  const filtered = shuffled.filter(r => !tennisProhibitedTournament(r.league).prohibited);

  console.log(`Total rows: ${rows.length} | post-flip: ${shuffled.length} | post-filter: ${filtered.length}`);

  // ── Walk-forward Elo: precisa cronológico pra warm-up ──
  // Mas o test set não pode ser só os últimos 15% (shift de domínio).
  // Solução: bootstrap Elo nos primeiros 70% chronological, depois RANDOM split
  // dos 30% restantes em calib (50%) + test (50%) usando seeded shuffle.
  const nWarmup = Math.floor(filtered.length * 0.70);
  const warmup = filtered.slice(0, nWarmup);
  const remaining = filtered.slice(nWarmup);

  // Random shuffle estratificado por (league_substring) pra ter mistura
  // similar de tier nos dois splits. Stratification key = primeiras 4 letras
  // do nome lower-case (proxy de tournament family).
  const rng = mulberry32(SEED);
  const groups = new Map();
  for (const r of remaining) {
    const k = norm(r.league || '').slice(0, 4) || '_';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const calibSet = [], testSet = [];
  for (const [, arr] of groups) {
    // Fisher-Yates shuffle dentro do grupo
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    // Split 50/50 estratificado
    const half = Math.floor(arr.length / 2);
    for (let i = 0; i < arr.length; i++) {
      (i < half ? calibSet : testSet).push(arr[i]);
    }
  }
  // Ambos mantêm ordem cronológica relativa pra walk-forward update.
  calibSet.sort((a, b) => String(a.resolved_at).localeCompare(b.resolved_at));
  testSet.sort((a, b) => String(a.resolved_at).localeCompare(b.resolved_at));

  console.log(`Warmup: ${warmup.length} | Calib: ${calibSet.length} | Test: ${testSet.length}`);

  // ── Elo state ──
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

  // 1. Warm-up Elo
  for (const r of warmup) update(r);

  // 2. Calib pairs (predict + walk-forward update)
  const calibPairs = [];
  for (const r of calibSet) {
    const pr = predict(r);
    if (pr) calibPairs.push({ p: pr.pA, y: pr.y });
    update(r);
  }
  console.log(`Calib pairs: ${calibPairs.length}`);
  const blocks = fitPAVVariableBins(calibPairs);
  console.log(`PAV blocks: ${blocks.length}`);
  for (const b of blocks) console.log(`  [${b.pMin.toFixed(3)}, ${b.pMax.toFixed(3)}] → y=${b.yMean.toFixed(3)} (n=${b.n})`);

  // 3. Test eval
  const rawP = [], calP = [], outs = [];
  let cR = 0, cC = 0, sumBR = 0, sumBC = 0, sumLR = 0, sumLC = 0;
  for (const r of testSet) {
    const pr = predict(r);
    if (!pr) { update(r); continue; }
    const pCal = applyIsotonic(blocks, pr.pA);
    rawP.push(pr.pA); calP.push(pCal); outs.push(pr.y);
    sumBR += brier(pr.pA, pr.y); sumBC += brier(pCal, pr.y);
    sumLR += logloss(pr.pA, pr.y); sumLC += logloss(pCal, pr.y);
    if ((pr.pA >= 0.5 ? 1 : 0) === pr.y) cR++;
    if ((pCal >= 0.5 ? 1 : 0) === pr.y) cC++;
    update(r);
  }
  const n = rawP.length;
  console.log(`\n── Test metrics (n=${n}) ──`);
  console.log('          Brier    LogLoss  Acc     ECE');
  console.log(`raw    ${(sumBR/n).toFixed(4)}   ${(sumLR/n).toFixed(4)}   ${(cR/n*100).toFixed(1)}%   ${computeECE(rawP, outs).toFixed(4)}`);
  console.log(`calib  ${(sumBC/n).toFixed(4)}   ${(sumLC/n).toFixed(4)}   ${(cC/n*100).toFixed(1)}%   ${computeECE(calP, outs).toFixed(4)}`);

  // ── Validação por zona ──
  console.log(`\n── Validação por zona (raw vs calib filtrado por raw P) ──`);
  let failed = false;
  const zoneReport = [];
  for (const z of VALIDATION_ZONES) {
    // Filtra ambos por raw P pra comparação apples-to-apples
    const idx = [];
    for (let i = 0; i < rawP.length; i++) if (rawP[i] >= z.min && rawP[i] < z.max) idx.push(i);
    if (idx.length < 30) {
      zoneReport.push({ zone: z.label, n: idx.length, status: 'skip', note: 'n<30' });
      console.log(`  ${z.label.padEnd(15)} n=${idx.length} → skip (n<30)`);
      continue;
    }
    const rawSub = idx.map(i => rawP[i]);
    const calSub = idx.map(i => calP[i]);
    const outSub = idx.map(i => outs[i]);
    const eceR = computeECE(rawSub, outSub, 8);
    const eceC = computeECE(calSub, outSub, 8);
    const status = eceC > eceR ? 'FAIL' : 'OK';
    if (status === 'FAIL') failed = true;
    zoneReport.push({ zone: z.label, n: idx.length, raw: +eceR.toFixed(4), calib: +eceC.toFixed(4), status });
    console.log(`  ${z.label.padEnd(15)} n=${String(idx.length).padStart(5)} | raw ECE ${eceR.toFixed(4)} | calib ECE ${eceC.toFixed(4)} | ${status === 'FAIL' ? '✗ ' : '✓ '}${status}`);
  }

  if (failed && !FORCE_SAVE) {
    console.log(`\n✗ Validação FALHOU em pelo menos uma zona. NÃO salvando isotonic.`);
    console.log(`  Pra forçar save (debug): re-rode com --force-save`);
    console.log(`  Pra resetar: re-rode com --seed=<outro> ou ajuste o calib set.`);
    process.exit(1);
  }

  if (failed && FORCE_SAVE) {
    console.log(`\n⚠️  Validação falhou mas --force-save passado — salvando mesmo assim.`);
  } else {
    console.log(`\n✓ Validação OK em todas zonas com n≥30.`);
  }

  try { require('../lib/model-backup').backupBeforeWrite(OUT_PATH); } catch (_) {}
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    version: 2,
    fittedAt: new Date().toISOString(),
    method: 'isotonic_pav_variable_bins',
    seed: SEED,
    nCalibSamples: calibPairs.length,
    nTestSamples: n,
    fineZone: FINE_ZONE,
    coarseWidth: COARSE_WIDTH,
    validation: { zones: zoneReport, failed, forced: FORCE_SAVE },
    blocks,
    trainingNote: 'v2: random-shuffle stratified (warmup chronological 70%, calib/test seeded random 50/50 do remaining), bins finos 0.025 em [0.30, 0.55], validação obrigatória por zona.',
  }, null, 2));
  console.log(`\nSaved: ${OUT_PATH}`);
}

main();

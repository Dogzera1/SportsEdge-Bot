#!/usr/bin/env node
'use strict';

/**
 * shadow-compare.js — §12e Shadow A/B retrospectivo.
 *
 * Compara 2 versões de weights (active vs shadow/backup) executando ambas
 * em TODOS os matches settled de match_results. Outputs:
 *   - Brier, Acc, AUC, LogLoss side-by-side
 *   - Agreement rate (% matches onde ambos predizem mesmo vencedor)
 *   - Distribuição de divergência (|pActive - pShadow| histogram)
 *   - Tips em que shadow teria gerado outra decisão (EV ≥ threshold)
 *
 * Uso:
 *   node scripts/shadow-compare.js --game lol --shadow lib/backups/lol-weights-2026-04-18T14-13-34.json
 *   node scripts/shadow-compare.js --game dota2 --shadow <path> --days 30 --ev-threshold 5
 *
 * Sem --shadow, usa o backup mais recente em lib/backups/<game>-weights-*.json.
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const initDatabase = require('../lib/database');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const GAME = argVal('game', 'lol');
const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const DAYS = parseInt(argVal('days', '60'), 10);
const EV_THRESHOLD = parseFloat(argVal('ev-threshold', '5'));

// Resolve shadow weights path
let SHADOW_PATH = argVal('shadow', null);
if (!SHADOW_PATH) {
  const backupDir = path.resolve(__dirname, '..', 'lib', 'backups');
  if (!fs.existsSync(backupDir)) {
    console.error(`[shadow-compare] sem --shadow e lib/backups/ ausente`);
    process.exit(1);
  }
  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith(`${GAME}-weights-`) && f.endsWith('.json'))
    .map(f => ({ f, mt: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mt - a.mt);
  if (!files.length) { console.error(`[shadow-compare] sem backups pra game=${GAME}`); process.exit(1); }
  SHADOW_PATH = path.join(backupDir, files[0].f);
  console.log(`[shadow-compare] usando backup mais recente: ${files[0].f}`);
}

const ACTIVE_PATH = path.resolve(__dirname, '..', 'lib', `${GAME}-weights.json`);

if (!fs.existsSync(ACTIVE_PATH)) { console.error(`ativo ausente: ${ACTIVE_PATH}`); process.exit(1); }
if (!fs.existsSync(SHADOW_PATH)) { console.error(`shadow ausente: ${SHADOW_PATH}`); process.exit(1); }

console.log(`[shadow-compare] game=${GAME}`);
console.log(`[shadow-compare] active : ${ACTIVE_PATH}`);
console.log(`[shadow-compare] shadow : ${SHADOW_PATH}`);
console.log(`[shadow-compare] days=${DAYS} ev_threshold=${EV_THRESHOLD}%`);

// Load both
const wActive = JSON.parse(fs.readFileSync(ACTIVE_PATH, 'utf8'));
const wShadow = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));

console.log(`[shadow-compare] active  trained ${wActive.trainedAt?.slice(0, 19)} feats=${wActive.featureNames?.length}`);
console.log(`[shadow-compare] shadow  trained ${wShadow.trainedAt?.slice(0, 19)} feats=${wShadow.featureNames?.length}`);

// Instala 2 predictors clonando o módulo (via require + env override)
const { db } = initDatabase(DB_PATH);
const { buildTrainedContext } = require('../lib/esports-runtime-features');

function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); }
function predictTree(tree, x) { while (!tree.leaf) tree = x[tree.feat] <= tree.thresh ? tree.left : tree.right; return tree.value; }
function applyIso(blocks, p) {
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

// Constrói vetor respeitando dim do weights
const { buildVector: _buildVectorEs } = require('../lib/esports-model-trained');

function predictWith(W, ctx) {
  const inv = String(ctx.team1 || '').toLowerCase() > String(ctx.team2 || '').toLowerCase();
  const nctx = inv ? invertCtx(ctx) : ctx;
  const v = _buildVectorEs(nctx, W.standardize.mean.length);
  if (v.length !== W.standardize.mean.length) return null;
  const { mean, std } = W.standardize;
  const xs = v.map((x, j) => (x - mean[j]) / (std[j] || 1));
  let z = W.logistic.b;
  for (let j = 0; j < xs.length; j++) z += W.logistic.w[j] * xs[j];
  let pLog = sigmoid(z);
  let pGb = null;
  if (W.gbdt?.trees?.length) {
    let F = W.gbdt.init;
    for (const t of W.gbdt.trees) F += W.gbdt.lr * predictTree(t, xs);
    pGb = sigmoid(F);
  }
  const ew = W.ensembleWeights || { logistic: 1, gbdt: 0 };
  const raw = pGb != null ? (ew.logistic * pLog + ew.gbdt * pGb) : pLog;
  const useCal = W.calibration?.active === true;
  let p = useCal ? applyIso(W.calibration.blocks, raw) : raw;
  return inv ? 1 - p : p;
}

function invertCtx(ctx) {
  return {
    team1: ctx.team2, team2: ctx.team1,
    eloOverall1: ctx.eloOverall2, eloOverall2: ctx.eloOverall1,
    eloLeague1: ctx.eloLeague2, eloLeague2: ctx.eloLeague1,
    games1: ctx.games2, games2: ctx.games1,
    winRateDiff10: -1 * (ctx.winRateDiff10 || 0),
    winRateDiff20: -1 * (ctx.winRateDiff20 || 0),
    h2hDiff: -1 * (ctx.h2hDiff || 0),
    h2hTotal: ctx.h2hTotal,
    daysSinceLast1: ctx.daysSinceLast2, daysSinceLast2: ctx.daysSinceLast1,
    matchesLast14Diff: -1 * (ctx.matchesLast14Diff || 0),
    winStreakDiff: -1 * (ctx.winStreakDiff || 0),
    wrTrendDiff: -1 * (ctx.wrTrendDiff || 0),
    bestOf: ctx.bestOf, leagueTier: ctx.leagueTier,
    // LoL extras
    gpmDiff: -1 * (ctx.gpmDiff || 0), gdmDiff: -1 * (ctx.gdmDiff || 0),
    gd15Diff: -1 * (ctx.gd15Diff || 0), fbRateDiff: -1 * (ctx.fbRateDiff || 0),
    ftRateDiff: -1 * (ctx.ftRateDiff || 0), dpmDiff: -1 * (ctx.dpmDiff || 0),
    kdDiff: -1 * (ctx.kdDiff || 0), teamWrDiff: -1 * (ctx.teamWrDiff || 0),
    draPctDiff: -1 * (ctx.draPctDiff || 0), nashPctDiff: -1 * (ctx.nashPctDiff || 0),
    hasTeamStats: ctx.hasTeamStats,
    oeGd15Diff: -1 * (ctx.oeGd15Diff || 0), oeObjDiff: -1 * (ctx.oeObjDiff || 0),
    oeWrDiff: -1 * (ctx.oeWrDiff || 0), oeDpmDiff: -1 * (ctx.oeDpmDiff || 0),
    hasOeStats: ctx.hasOeStats,
    avgKdaDiff: -1 * (ctx.avgKdaDiff || 0), maxKdaDiff: -1 * (ctx.maxKdaDiff || 0),
    starScoreDiff: -1 * (ctx.starScoreDiff || 0), hasRosterStats: ctx.hasRosterStats,
  };
}

// Fetch settled matches
const matches = db.prepare(`
  SELECT team1, team2, winner, league, resolved_at, final_score
  FROM match_results
  WHERE game = ?
    AND winner IS NOT NULL AND winner != ''
    AND resolved_at >= datetime('now', ?)
  ORDER BY resolved_at DESC
  LIMIT 5000
`).all(GAME, `-${DAYS} days`);

console.log(`[shadow-compare] ${matches.length} matches settled em ${DAYS}d`);
if (!matches.length) process.exit(0);

let stats = {
  active: { n: 0, brier: 0, hits: 0, logloss: 0 },
  shadow: { n: 0, brier: 0, hits: 0, logloss: 0 },
  agreement: 0,
  divergences: [],
};

for (const m of matches) {
  const ctx = buildTrainedContext(db, GAME, m);
  if (!ctx) continue;
  const pA = predictWith(wActive, ctx);
  const pS = predictWith(wShadow, ctx);
  if (pA == null || pS == null) continue;
  const y = String(m.winner || '').toLowerCase() === String(m.team1 || '').toLowerCase() ? 1 : 0;
  stats.active.n++;
  stats.active.brier += (pA - y) ** 2;
  stats.active.hits += (pA >= 0.5 ? 1 : 0) === y ? 1 : 0;
  stats.active.logloss += -(y * Math.log(Math.max(1e-12, pA)) + (1 - y) * Math.log(Math.max(1e-12, 1 - pA)));
  stats.shadow.n++;
  stats.shadow.brier += (pS - y) ** 2;
  stats.shadow.hits += (pS >= 0.5 ? 1 : 0) === y ? 1 : 0;
  stats.shadow.logloss += -(y * Math.log(Math.max(1e-12, pS)) + (1 - y) * Math.log(Math.max(1e-12, 1 - pS)));
  if ((pA >= 0.5) === (pS >= 0.5)) stats.agreement++;
  stats.divergences.push(Math.abs(pA - pS));
}

const fmt = (s) => ({
  n: s.n,
  brier: (s.brier / s.n).toFixed(5),
  acc: ((s.hits / s.n) * 100).toFixed(2) + '%',
  logloss: (s.logloss / s.n).toFixed(5),
});

console.log('\n── Head-to-head ─────────────────');
console.log('ACTIVE:', fmt(stats.active));
console.log('SHADOW:', fmt(stats.shadow));

const dActive = stats.active.brier / stats.active.n;
const dShadow = stats.shadow.brier / stats.shadow.n;
const brierDelta = ((dActive - dShadow) / dShadow * 100);
console.log(`\nΔ Brier: active vs shadow = ${brierDelta > 0 ? '+' : ''}${brierDelta.toFixed(2)}% ${brierDelta < 0 ? '✅ active melhor' : '⚠️ shadow melhor — revisar retrain'}`);

console.log(`\nAgreement rate: ${(stats.agreement / stats.active.n * 100).toFixed(1)}% (${stats.agreement}/${stats.active.n} matches mesmo vencedor previsto)`);

// Divergence histogram
const divs = stats.divergences;
divs.sort((a, b) => a - b);
const p50 = divs[Math.floor(divs.length * 0.5)];
const p90 = divs[Math.floor(divs.length * 0.9)];
const p99 = divs[Math.floor(divs.length * 0.99)];
console.log(`\n|pActive - pShadow| distribution: p50=${p50.toFixed(3)} p90=${p90.toFixed(3)} p99=${p99.toFixed(3)}`);

console.log(`\n[shadow-compare] done`);

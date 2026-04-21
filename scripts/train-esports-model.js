#!/usr/bin/env node
'use strict';

// scripts/train-esports-model.js
//
// Treina modelo esports (LoL/Dota/Valorant/CS) a partir do CSV gerado por
// extract-esports-features.js. Logistic L2 + calibração isotônica + GBDT opcional.
// Walk-forward split train/val/test.
//
// Uso:
//   node scripts/train-esports-model.js --game lol [--in data/lol_features.csv]
//                                        [--out lib/lol-weights.json]
//                                        [--no-gbdt]

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  return argv[i + 1];
}
function argFlag(n) { return argv.includes(`--${n}`); }

const GAME = argVal('game', 'lol');
const IN = path.resolve(argVal('in', `data/${GAME}_features.csv`));
const OUT = path.resolve(argVal('out', `lib/${GAME}-weights.json`));
const TEST_FRAC = parseFloat(argVal('test-frac', '0.15'));
const VAL_FRAC = parseFloat(argVal('val-frac', '0.15'));
const USE_GBDT = !argFlag('no-gbdt');

console.log(`[train-es] game=${GAME} in=${IN} out=${OUT}`);

const text = fs.readFileSync(IN, 'utf8');
const lines = text.split(/\r?\n/).filter(Boolean);
const headers = lines[0].split(',');
const rows = [];
for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(',');
  if (cols.length !== headers.length) continue;
  const row = {};
  for (let j = 0; j < headers.length; j++) row[headers[j]] = cols[j];
  rows.push(row);
}
rows.sort((a, b) => a.date.localeCompare(b.date));
console.log(`[train-es] rows: ${rows.length}`);

if (rows.length < 400) {
  console.error(`[train-es] ATENÇÃO: dataset muito pequeno (${rows.length}). Modelo terá alta variância.`);
}

// ── Features ──────────────────────────────────────────────────────────────
// Features base (todos os esportes)
const BASE_NUM_FEATURES = [
  'elo_diff_overall', 'elo_diff_league',
  'games_t1', 'games_t2',
  'winrate_diff_10', 'winrate_diff_20',
  'h2h_diff', 'h2h_total',
  'days_since_last_t1', 'days_since_last_t2', 'days_since_diff',
  'matches_last14_diff',
  'n_signals', 'best_of',
];
// Features momentum (adicionadas 2026-04-18; opcional se CSV não tem)
const MOMENTUM_FEATURES = ['win_streak_diff', 'wr_trend_diff', 'elo_diff_sq'];
// 1v1 features (MMA/darts/snooker) — SOS + same-league momentum
const ONE_V_ONE_FEATURES = ['sos_diff', 'same_league_wins_diff', 'same_league_wr_diff'];
// Extras só LoL (gol.gg team stats)
const LOL_EXTRA_FEATURES = [
  'gpm_diff', 'gdm_diff', 'gd15_diff', 'fb_rate_diff', 'ft_rate_diff',
  'dpm_diff', 'kd_diff', 'team_wr_diff', 'dra_pct_diff', 'nash_pct_diff',
  'has_team_stats',
];
// OE rolling 60d (só LoL)
const LOL_OE_FEATURES = [
  'oe_gd15_diff', 'oe_obj_diff', 'oe_wr_diff', 'oe_dpm_diff', 'has_oe_stats',
];
// OE player-level roster stats (só LoL)
const LOL_PLAYER_FEATURES = [
  'avg_kda_diff', 'max_kda_diff', 'star_score_diff', 'has_roster_stats',
];
// Dota2 OpenDota team stats (só Dota2; populado via sync-opendota-team-stats.js + migration 046)
const DOTA2_FEATURES = [
  'dota_rating_diff', 'dota_wr_diff', 'dota_games_diff', 'has_dota_team_stats',
];

// Decide NUM_FEATURES baseado no CSV carregado (se tem colunas LoL extras, inclui)
let NUM_FEATURES = BASE_NUM_FEATURES.slice();
if (headers.includes('win_streak_diff')) NUM_FEATURES = [...NUM_FEATURES, ...MOMENTUM_FEATURES];
if (headers.includes('sos_diff')) NUM_FEATURES = [...NUM_FEATURES, ...ONE_V_ONE_FEATURES];
if (GAME === 'lol' && headers.includes('gpm_diff')) NUM_FEATURES = [...NUM_FEATURES, ...LOL_EXTRA_FEATURES];
if (GAME === 'lol' && headers.includes('oe_gd15_diff')) NUM_FEATURES = [...NUM_FEATURES, ...LOL_OE_FEATURES];
if (GAME === 'lol' && headers.includes('avg_kda_diff')) NUM_FEATURES = [...NUM_FEATURES, ...LOL_PLAYER_FEATURES];
if (GAME === 'dota2' && headers.includes('dota_rating_diff')) NUM_FEATURES = [...NUM_FEATURES, ...DOTA2_FEATURES];
const CAT_FEATURES = ['league_tier']; // 1,2,3

function buildVec(row) {
  const v = [];
  for (const k of NUM_FEATURES) {
    const x = parseFloat(row[k]);
    v.push(Number.isFinite(x) ? x : 0);
  }
  const tier = parseInt(row.league_tier, 10) || 1;
  v.push(tier === 1 ? 1 : 0);
  v.push(tier === 2 ? 1 : 0);
  v.push(tier === 3 ? 1 : 0);
  // interação elo × bo (séries longas amplificam skill)
  const elo = parseFloat(row.elo_diff_overall) || 0;
  const bo = parseFloat(row.best_of) || 1;
  v.push(bo >= 3 ? elo : 0);
  return v;
}
const FEATURE_NAMES = [...NUM_FEATURES, 'tier_1', 'tier_2', 'tier_3', 'elo_x_bo_series'];

const N = rows.length;
const nTest = Math.floor(N * TEST_FRAC);
const nVal = Math.floor(N * VAL_FRAC);
const nTrain = N - nTest - nVal;
const trainRows = rows.slice(0, nTrain);
const valRows = rows.slice(nTrain, nTrain + nVal);
const testRows = rows.slice(nTrain + nVal);

console.log(`[train-es] train=${trainRows.length} val=${valRows.length} test=${testRows.length}`);
console.log(`[train-es] train span: ${trainRows[0]?.date}→${trainRows[trainRows.length-1]?.date}`);
console.log(`[train-es] test span:  ${testRows[0]?.date}→${testRows[testRows.length-1]?.date}`);

function toXY(subset) {
  return { X: subset.map(buildVec), y: subset.map(r => +r.y) };
}
const tr = toXY(trainRows), va = toXY(valRows), te = toXY(testRows);

// ── Padronização ──
const D = tr.X[0].length;
const mean = new Array(D).fill(0);
const std = new Array(D).fill(0);
for (const x of tr.X) for (let j = 0; j < D; j++) mean[j] += x[j];
for (let j = 0; j < D; j++) mean[j] /= tr.X.length;
for (const x of tr.X) for (let j = 0; j < D; j++) std[j] += (x[j] - mean[j]) ** 2;
for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j] / tr.X.length) || 1;
const stdX = X => X.map(x => x.map((v, j) => (v - mean[j]) / std[j]));
const trS = stdX(tr.X), vaS = stdX(va.X), teS = stdX(te.X);

// ── Logistic L2 ──
const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const meanArr = a => a.length ? a.reduce((s, b) => s + b, 0) / a.length : 0;
const logLoss = (p, y) => -(y * Math.log(Math.max(1e-12, p)) + (1 - y) * Math.log(Math.max(1e-12, 1 - p)));

function trainLog(X, y, { lr = 0.05, epochs = 400, l2 = 0.001, batch = 128 } = {}) {
  const d = X[0].length, n = X.length;
  const w = new Array(d).fill(0); let b = 0;
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    for (let s = 0; s < n; s += batch) {
      const e = Math.min(n, s + batch);
      const gW = new Array(d).fill(0); let gB = 0;
      for (let k = s; k < e; k++) {
        const i = idx[k]; const xi = X[i];
        let z = b; for (let j = 0; j < d; j++) z += w[j] * xi[j];
        const err = sigmoid(z) - y[i];
        for (let j = 0; j < d; j++) gW[j] += err * xi[j];
        gB += err;
      }
      const m = e - s;
      for (let j = 0; j < d; j++) w[j] -= lr * (gW[j] / m + l2 * w[j]);
      b -= lr * (gB / m);
    }
  }
  return { w, b };
}

function predLog(M, X) {
  return X.map(xi => { let z = M.b; for (let j = 0; j < xi.length; j++) z += M.w[j] * xi[j]; return sigmoid(z); });
}

console.log(`\n[logistic] grid L2...`);
const L2_GRID = [0.0001, 0.001, 0.01, 0.05, 0.1];
let bestL2 = 0.001, bestB = Infinity;
for (const l2 of L2_GRID) {
  const M = trainLog(trS, tr.y, { lr: 0.05, epochs: 300, l2, batch: 128 });
  const p = predLog(M, vaS);
  const b = meanArr(p.map((q, i) => (q - va.y[i]) ** 2));
  console.log(`  l2=${l2}: val_brier=${b.toFixed(5)}`);
  if (b < bestB) { bestB = b; bestL2 = l2; }
}
console.log(`[logistic] best L2: ${bestL2}`);
const logM = trainLog(trS, tr.y, { lr: 0.05, epochs: 500, l2: bestL2, batch: 128 });

// ── GBDT ──
function buildTree(X, g, h, maxDepth, minLeaf, feats) {
  const idxAll = Array.from({ length: X.length }, (_, i) => i);
  function bestSplit(idx) {
    if (idx.length < 2 * minLeaf) return null;
    let bg = 0, bf = -1, bt = 0, bl = null, br = null;
    const G = idx.reduce((s, i) => s + g[i], 0);
    const H = idx.reduce((s, i) => s + h[i], 0);
    const lambda = 1.0;
    const par = (G * G) / (H + lambda);
    for (const f of feats) {
      const sorted = idx.slice().sort((a, b) => X[a][f] - X[b][f]);
      let gL = 0, hL = 0;
      for (let k = 0; k < sorted.length - 1; k++) {
        const i = sorted[k];
        gL += g[i]; hL += h[i];
        const gR = G - gL, hR = H - hL;
        if (k + 1 < minLeaf || sorted.length - k - 1 < minLeaf) continue;
        if (X[sorted[k]][f] === X[sorted[k + 1]][f]) continue;
        const gain = (gL * gL) / (hL + lambda) + (gR * gR) / (hR + lambda) - par;
        if (gain > bg) {
          bg = gain; bf = f; bt = (X[sorted[k]][f] + X[sorted[k + 1]][f]) / 2;
          bl = sorted.slice(0, k + 1); br = sorted.slice(k + 1);
        }
      }
    }
    if (bf < 0) return null;
    return { gain: bg, feat: bf, thresh: bt, left: bl, right: br };
  }
  function leafV(idx) {
    const G = idx.reduce((s, i) => s + g[i], 0);
    const H = idx.reduce((s, i) => s + h[i], 0);
    return -G / (H + 1.0);
  }
  function build(idx, depth) {
    if (depth >= maxDepth || idx.length < 2 * minLeaf) return { leaf: true, value: leafV(idx) };
    const s = bestSplit(idx);
    if (!s || s.gain <= 1e-9) return { leaf: true, value: leafV(idx) };
    return { leaf: false, feat: s.feat, thresh: s.thresh, left: build(s.left, depth + 1), right: build(s.right, depth + 1) };
  }
  return build(idxAll, 0);
}
function predTree(t, x) { while (!t.leaf) t = x[t.feat] <= t.thresh ? t.left : t.right; return t.value; }

function trainGBDT(Xtr, ytr, Xva, yva, { nTrees = 120, lr = 0.05, depth = 4, minLeaf = 20, sub = 0.7, featFrac = 0.9, esRounds = 20 } = {}) {
  const d = Xtr[0].length, n = Xtr.length;
  const trees = [];
  const mu = meanArr(ytr);
  const init = Math.log(mu / (1 - mu || 1));
  const Ftr = new Array(n).fill(init);
  const Fva = new Array(Xva.length).fill(init);
  const featAll = Array.from({ length: d }, (_, i) => i);
  let bestB = Infinity, bestR = 0, noImp = 0, bestTrees = [];
  for (let t = 0; t < nTrees; t++) {
    const p = Ftr.map(sigmoid);
    const gArr = p.map((pi, i) => pi - ytr[i]);
    const hArr = p.map(pi => pi * (1 - pi));
    const subN = Math.max(minLeaf * 2, Math.floor(n * sub));
    const subIdx = Array.from({ length: subN }, () => Math.floor(Math.random() * n));
    const Xs = subIdx.map(i => Xtr[i]);
    const gs = subIdx.map(i => gArr[i]);
    const hs = subIdx.map(i => hArr[i]);
    const feats = featAll.slice().sort(() => Math.random() - 0.5).slice(0, Math.max(1, Math.floor(d * featFrac)));
    const tree = buildTree(Xs, gs, hs, depth, minLeaf, feats);
    trees.push(tree);
    for (let i = 0; i < n; i++) Ftr[i] += lr * predTree(tree, Xtr[i]);
    for (let i = 0; i < Xva.length; i++) Fva[i] += lr * predTree(tree, Xva[i]);
    const pVa = Fva.map(sigmoid);
    const b = meanArr(pVa.map((p, i) => (p - yva[i]) ** 2));
    if (b < bestB - 1e-6) { bestB = b; bestR = t; bestTrees = trees.slice(); noImp = 0; } else noImp++;
    if ((t + 1) % 10 === 0) console.log(`  tree ${t + 1}: val_brier=${b.toFixed(5)} (best=${bestB.toFixed(5)} @${bestR + 1})`);
    if (noImp >= esRounds) { console.log(`  early stop @ ${t + 1}`); break; }
  }
  return { init, lr, trees: bestTrees.length ? bestTrees : trees };
}

const GBDT_TREES = parseInt(argVal('gbdt-trees', '120'), 10);
const GBDT_DEPTH = parseInt(argVal('gbdt-depth', '4'), 10);
const GBDT_LR = parseFloat(argVal('gbdt-lr', '0.05'));
const GBDT_SUB = parseFloat(argVal('gbdt-subsample', '0.7'));

let gbdtM = null;
if (USE_GBDT) {
  console.log(`\n[gbdt] training (trees=${GBDT_TREES} depth=${GBDT_DEPTH} lr=${GBDT_LR})...`);
  gbdtM = trainGBDT(trS, tr.y, vaS, va.y, { nTrees: GBDT_TREES, lr: GBDT_LR, depth: GBDT_DEPTH, minLeaf: 20, sub: GBDT_SUB, featFrac: 0.9, esRounds: 20 });
}
function predGBDT(M, X) { return X.map(xi => { let F = M.init; for (const t of M.trees) F += M.lr * predTree(t, xi); return sigmoid(F); }); }

// Grid search do peso do ensemble no val set (só rodado se GBDT está ativo)
let ensWeights = { logistic: 1, gbdt: 0 };
if (gbdtM) {
  const pLogVa = predLog(logM, vaS);
  const pGbVa = predGBDT(gbdtM, vaS);
  let bestB = Infinity, bestW = 0.5;
  for (const wG of [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0]) {
    const pE = pLogVa.map((p, i) => (1 - wG) * p + wG * pGbVa[i]);
    const b = meanArr(pE.map((p, i) => (p - va.y[i]) ** 2));
    if (b < bestB) { bestB = b; bestW = wG; }
  }
  ensWeights = { logistic: 1 - bestW, gbdt: bestW };
  console.log(`[ensemble] val grid: best gbdt_weight=${bestW} → val_brier=${bestB.toFixed(5)}`);
}

function predEns(XS) {
  const pL = predLog(logM, XS);
  if (!gbdtM || ensWeights.gbdt === 0) return pL;
  const pG = predGBDT(gbdtM, XS);
  return pL.map((p, i) => ensWeights.logistic * p + ensWeights.gbdt * pG[i]);
}

// ── Calibração isotônica ──
function isotonicFit(pArr, yArr) {
  const pairs = pArr.map((p, i) => ({ p, y: yArr[i] })).sort((a, b) => a.p - b.p);
  const blocks = pairs.map(pr => ({ pMin: pr.p, pMax: pr.p, sumY: pr.y, n: 1 }));
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].sumY / blocks[i].n > blocks[i + 1].sumY / blocks[i + 1].n) {
      blocks[i].pMax = blocks[i + 1].pMax;
      blocks[i].sumY += blocks[i + 1].sumY;
      blocks[i].n += blocks[i + 1].n;
      blocks.splice(i + 1, 1);
      if (i > 0) i--;
    } else i++;
  }
  return blocks.map(b => ({ pMin: b.pMin, pMax: b.pMax, yMean: b.sumY / b.n }));
}
function isotonicApply(blocks, p) {
  if (!blocks || !blocks.length) return p;
  if (p <= blocks[0].pMax) return blocks[0].yMean;
  if (p >= blocks[blocks.length - 1].pMin) return blocks[blocks.length - 1].yMean;
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

const isoBlocks = isotonicFit(predEns(vaS), va.y);

// ── Métricas ──
function metrics(preds, y) {
  const n = preds.length;
  const b = meanArr(preds.map((p, i) => (p - y[i]) ** 2));
  const ll = meanArr(preds.map((p, i) => logLoss(p, y[i])));
  const acc = meanArr(preds.map((p, i) => (p >= 0.5 ? 1 : 0) === y[i] ? 1 : 0));
  const pos = preds.map((p, i) => ({ p, y: y[i] })).filter(o => o.y === 1);
  const neg = preds.map((p, i) => ({ p, y: y[i] })).filter(o => o.y === 0);
  let w = 0, t = 0;
  for (const pp of pos) for (const nn of neg) { if (pp.p > nn.p) w++; else if (pp.p === nn.p) t++; }
  const auc = pos.length && neg.length ? (w + 0.5 * t) / (pos.length * neg.length) : 0;
  let ece = 0;
  for (let bi = 0; bi < 10; bi++) {
    const lo = bi / 10, hi = (bi + 1) / 10;
    const inB = preds.map((p, i) => ({ p, y: y[i] })).filter(o => o.p >= lo && (bi === 9 ? o.p <= hi : o.p < hi));
    if (!inB.length) continue;
    ece += (inB.length / n) * Math.abs(meanArr(inB.map(o => o.p)) - meanArr(inB.map(o => o.y)));
  }
  return { n, brier: b, logloss: ll, acc, auc, ece };
}
function fmt(m) { return `n=${m.n} | brier=${m.brier.toFixed(5)} | logloss=${m.logloss.toFixed(5)} | acc=${(m.acc * 100).toFixed(2)}% | auc=${m.auc.toFixed(4)} | ece=${m.ece.toFixed(4)}`; }

const pBase = testRows.map(r => sigmoid((+r.elo_diff_overall || 0) / 400));
const pLT = predLog(logM, teS);
const pET = predEns(teS);
const pETc = pET.map(p => isotonicApply(isoBlocks, p));

console.log(`\n── Métricas (test) ─────────────────`);
console.log(`baseline elo:         ${fmt(metrics(pBase, te.y))}`);
console.log(`logistic:             ${fmt(metrics(pLT, te.y))}`);
if (gbdtM) {
  console.log(`gbdt:                 ${fmt(metrics(predGBDT(gbdtM, teS), te.y))}`);
  console.log(`ensemble raw:         ${fmt(metrics(pET, te.y))}`);
}
console.log(`${gbdtM ? 'ensemble' : 'logistic'} calibrated: ${fmt(metrics(pETc, te.y))}`);

console.log(`\n── Features (|w| logistic) ──`);
const fi = FEATURE_NAMES.map((n, j) => ({ n, w: logM.w[j] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
for (const f of fi) console.log(`  ${f.n.padEnd(22)} ${f.w >= 0 ? '+' : ''}${f.w.toFixed(3)}`);

// Decide se calibração isotônica vale: só mantém se Brier melhorou no test.
const rawTestM = metrics(pET, te.y);
const calTestM = metrics(pETc, te.y);
const useCalibration = calTestM.brier < rawTestM.brier;
console.log(`\n[calibration] raw_brier=${rawTestM.brier.toFixed(5)} cal_brier=${calTestM.brier.toFixed(5)} → useCalibration=${useCalibration}`);

const outObj = {
  version: 1,
  game: GAME,
  trainedAt: new Date().toISOString(),
  featureNames: FEATURE_NAMES,
  numFeatures: NUM_FEATURES,
  standardize: { mean, std },
  logistic: { w: logM.w, b: logM.b, l2: bestL2 },
  gbdt: gbdtM ? { init: gbdtM.init, lr: gbdtM.lr, trees: gbdtM.trees } : null,
  ensembleWeights: gbdtM ? ensWeights : { logistic: 1, gbdt: 0 },
  calibration: { method: 'isotonic', blocks: isoBlocks, active: useCalibration },
  metrics: {
    baseline_elo_test: metrics(pBase, te.y),
    logistic_test: metrics(pLT, te.y),
    ensemble_raw_test: rawTestM,
    ensemble_calibrated_test: calTestM,
    chosen: useCalibration ? 'calibrated' : 'raw',
  },
  splits: {
    train: { n: trainRows.length, from: trainRows[0]?.date, to: trainRows[trainRows.length - 1]?.date },
    val: { n: valRows.length, from: valRows[0]?.date, to: valRows[valRows.length - 1]?.date },
    test: { n: testRows.length, from: testRows[0]?.date, to: testRows[testRows.length - 1]?.date },
  },
};
const od = path.dirname(OUT);
if (!fs.existsSync(od)) fs.mkdirSync(od, { recursive: true });
try { require('../lib/model-backup').backupBeforeWrite(OUT); } catch (_) {}
fs.writeFileSync(OUT, JSON.stringify(outObj, null, 2), 'utf8');
console.log(`\n[train-es] saved: ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);

#!/usr/bin/env node
'use strict';

// scripts/train-tennis-model.js
//
// Treina modelo de tênis (win probability de p1) a partir do CSV gerado por
// extract-tennis-features.js. Ensemble: regressão logística L2 + GBDT (pure JS)
// + calibração isotônica. Walk-forward CV + holdout final.
//
// Output: lib/tennis-weights.json — consumido por lib/tennis-model.js quando
// TENNIS_MODEL_TRAINED=true.
//
// Uso:
//   node scripts/train-tennis-model.js [--in data/tennis_features.csv]
//                                      [--out lib/tennis-weights.json]
//                                      [--test-frac 0.15] [--val-frac 0.15]
//                                      [--no-gbdt]  (desliga GBDT, só logistic)
//                                      [--gbdt-trees 100] [--gbdt-depth 4] [--gbdt-lr 0.05]

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
function argFlag(name) {
  return argv.includes(`--${name}`);
}

const IN_PATH = path.resolve(argVal('in', 'data/tennis_features.csv'));
const OUT_PATH = path.resolve(argVal('out', 'lib/tennis-weights.json'));
const TEST_FRAC = parseFloat(argVal('test-frac', '0.15'));
const VAL_FRAC = parseFloat(argVal('val-frac', '0.15'));
const USE_GBDT = !argFlag('no-gbdt');
const GBDT_TREES = parseInt(argVal('gbdt-trees', '150'), 10);
const GBDT_DEPTH = parseInt(argVal('gbdt-depth', '4'), 10);
const GBDT_LR = parseFloat(argVal('gbdt-lr', '0.05'));
const GBDT_MIN_LEAF = parseInt(argVal('gbdt-min-leaf', '30'), 10);
const GBDT_SUBSAMPLE = parseFloat(argVal('gbdt-subsample', '0.8'));

console.log(`[train] in=${IN_PATH} out=${OUT_PATH}`);
console.log(`[train] test-frac=${TEST_FRAC} val-frac=${VAL_FRAC} gbdt=${USE_GBDT}`);

// ── Load CSV ──────────────────────────────────────────────────────────────
function loadFeatureCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
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
  return { headers, rows };
}

const { rows } = loadFeatureCsv(IN_PATH);
console.log(`[train] rows: ${rows.length}`);
rows.sort((a, b) => a.date.localeCompare(b.date));

// ── Feature selection ─────────────────────────────────────────────────────
// Features numéricas usadas no modelo. Categóricas expandidas em one-hot.
const NUM_FEATURES = [
  'elo_diff_blend',
  'elo_diff_overall',
  'elo_diff_surface',
  'rank_diff',
  'rank_points_log_ratio',
  'age_diff',
  'height_diff',
  'serve_pct_diff',
  'fatigue_min_7d_diff',
  'matches_14d_diff',
  'days_since_last_diff',
  'h2h_surface_diff',
  'h2h_overall_diff',
  'n_signals',
];
const CAT_FEATURES = ['surface']; // hard/clay/grass (one-hot)
const SURFACES = ['hard', 'clay', 'grass'];

function buildFeatureVector(row) {
  const v = [];
  for (const k of NUM_FEATURES) {
    const x = parseFloat(row[k]);
    v.push(Number.isFinite(x) ? x : 0);
  }
  for (const s of SURFACES) v.push(row.surface === s ? 1 : 0);
  // interações úteis
  const eloBlend = parseFloat(row.elo_diff_blend) || 0;
  const bestOf = parseFloat(row.best_of) || 3;
  v.push(bestOf === 5 ? eloBlend : 0);      // elo × bestOf5 (slams)
  v.push(row.surface === 'clay' ? eloBlend : 0); // elo × clay
  v.push(row.surface === 'grass' ? eloBlend : 0); // elo × grass
  return v;
}

const FEATURE_NAMES = [
  ...NUM_FEATURES,
  ...SURFACES.map(s => `surface_${s}`),
  'elo_x_bestof5',
  'elo_x_clay',
  'elo_x_grass',
];

// ── Split temporal ────────────────────────────────────────────────────────
const N = rows.length;
const nTest = Math.floor(N * TEST_FRAC);
const nVal = Math.floor(N * VAL_FRAC);
const nTrain = N - nTest - nVal;

const trainRows = rows.slice(0, nTrain);
const valRows = rows.slice(nTrain, nTrain + nVal);
const testRows = rows.slice(nTrain + nVal);

console.log(`[train] train=${trainRows.length} (${trainRows[0]?.date}→${trainRows[trainRows.length-1]?.date})`);
console.log(`[train] val  =${valRows.length} (${valRows[0]?.date}→${valRows[valRows.length-1]?.date})`);
console.log(`[train] test =${testRows.length} (${testRows[0]?.date}→${testRows[testRows.length-1]?.date})`);

function toXY(subset) {
  const X = [], y = [];
  for (const r of subset) {
    X.push(buildFeatureVector(r));
    y.push(parseFloat(r.y) || 0);
  }
  return { X, y };
}
const { X: Xtr, y: ytr } = toXY(trainRows);
const { X: Xva, y: yva } = toXY(valRows);
const { X: Xte, y: yte } = toXY(testRows);

// ── Standardization (fit em train) ────────────────────────────────────────
const D = Xtr[0].length;
const mean = new Array(D).fill(0);
const std = new Array(D).fill(0);
for (const x of Xtr) for (let j = 0; j < D; j++) mean[j] += x[j];
for (let j = 0; j < D; j++) mean[j] /= Xtr.length;
for (const x of Xtr) for (let j = 0; j < D; j++) {
  const d = x[j] - mean[j];
  std[j] += d * d;
}
for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j] / Xtr.length) || 1;

function standardize(X) {
  return X.map(x => x.map((v, j) => (v - mean[j]) / std[j]));
}
const XtrS = standardize(Xtr);
const XvaS = standardize(Xva);
const XteS = standardize(Xte);

// ── Logistic regression com L2 ───────────────────────────────────────────
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
const logLoss = (p, y) => -(y * Math.log(Math.max(1e-12, p)) + (1 - y) * Math.log(Math.max(1e-12, 1 - p)));
const mean1 = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

function trainLogistic(X, y, { lr = 0.05, epochs = 400, l2 = 0.001, batch = 256 } = {}) {
  const d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;
  const n = X.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let ep = 0; ep < epochs; ep++) {
    // Shuffle
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    for (let start = 0; start < n; start += batch) {
      const end = Math.min(n, start + batch);
      const gW = new Array(d).fill(0);
      let gB = 0;
      for (let k = start; k < end; k++) {
        const i = idx[k];
        const xi = X[i]; const yi = y[i];
        let z = b; for (let j = 0; j < d; j++) z += w[j] * xi[j];
        const p = sigmoid(z);
        const err = p - yi;
        for (let j = 0; j < d; j++) gW[j] += err * xi[j];
        gB += err;
      }
      const m = end - start;
      for (let j = 0; j < d; j++) w[j] -= lr * (gW[j] / m + l2 * w[j]);
      b -= lr * (gB / m);
    }
  }
  return { w, b };
}

function logisticPredict(model, X) {
  const { w, b } = model;
  return X.map(xi => {
    let z = b; for (let j = 0; j < xi.length; j++) z += w[j] * xi[j];
    return sigmoid(z);
  });
}

// Grid search simples de L2
console.log(`\n[logistic] grid search L2...`);
const L2_GRID = [0.0001, 0.001, 0.01, 0.05];
let bestL2 = null, bestL2Brier = Infinity;
for (const l2 of L2_GRID) {
  const m = trainLogistic(XtrS, ytr, { lr: 0.05, epochs: 300, l2, batch: 256 });
  const pVa = logisticPredict(m, XvaS);
  const b = mean1(pVa.map((p, i) => (p - yva[i]) ** 2));
  const ll = mean1(pVa.map((p, i) => logLoss(p, yva[i])));
  console.log(`  l2=${l2}: val_brier=${b.toFixed(5)} val_logloss=${ll.toFixed(5)}`);
  if (b < bestL2Brier) { bestL2Brier = b; bestL2 = l2; }
}
console.log(`[logistic] best L2: ${bestL2}`);
const logisticModel = trainLogistic(XtrS, ytr, { lr: 0.05, epochs: 500, l2: bestL2, batch: 256 });

// ── GBDT (gradient boosting para log-loss) ───────────────────────────────
// Árvores de regressão (Newton step) em pure JS. Split greedy por feature+threshold.
function buildTree(X, gradients, hessians, maxDepth, minLeaf, featureIdx) {
  const n = X.length;
  const idxAll = Array.from({ length: n }, (_, i) => i);

  function findBestSplit(idx) {
    if (idx.length < 2 * minLeaf) return null;
    let bestGain = 0, bestFeat = -1, bestThresh = 0, bestLeft = null, bestRight = null;
    const G = idx.reduce((s, i) => s + gradients[i], 0);
    const H = idx.reduce((s, i) => s + hessians[i], 0);
    const lambda = 1.0;
    const parentScore = (G * G) / (H + lambda);
    for (const f of featureIdx) {
      // sort idx by feature f
      const sorted = idx.slice().sort((a, b) => X[a][f] - X[b][f]);
      let gL = 0, hL = 0;
      for (let k = 0; k < sorted.length - 1; k++) {
        const i = sorted[k];
        gL += gradients[i]; hL += hessians[i];
        const gR = G - gL, hR = H - hL;
        if (k + 1 < minLeaf || sorted.length - k - 1 < minLeaf) continue;
        // Só considera split quando valor muda (evita splits dentro do mesmo valor)
        if (X[sorted[k]][f] === X[sorted[k + 1]][f]) continue;
        const gain = (gL * gL) / (hL + lambda) + (gR * gR) / (hR + lambda) - parentScore;
        if (gain > bestGain) {
          bestGain = gain; bestFeat = f;
          bestThresh = (X[sorted[k]][f] + X[sorted[k + 1]][f]) / 2;
          bestLeft = sorted.slice(0, k + 1);
          bestRight = sorted.slice(k + 1);
        }
      }
    }
    if (bestFeat < 0) return null;
    return { gain: bestGain, feat: bestFeat, thresh: bestThresh, left: bestLeft, right: bestRight };
  }

  function leafValue(idx) {
    const G = idx.reduce((s, i) => s + gradients[i], 0);
    const H = idx.reduce((s, i) => s + hessians[i], 0);
    return -G / (H + 1.0);
  }

  function build(idx, depth) {
    if (depth >= maxDepth || idx.length < 2 * minLeaf) {
      return { leaf: true, value: leafValue(idx) };
    }
    const split = findBestSplit(idx);
    if (!split || split.gain <= 1e-9) {
      return { leaf: true, value: leafValue(idx) };
    }
    return {
      leaf: false,
      feat: split.feat, thresh: split.thresh,
      left: build(split.left, depth + 1),
      right: build(split.right, depth + 1),
    };
  }

  return build(idxAll, 0);
}

function predictTree(tree, x) {
  while (!tree.leaf) {
    tree = x[tree.feat] <= tree.thresh ? tree.left : tree.right;
  }
  return tree.value;
}

function trainGBDT(Xtr, ytr, Xva, yva, { nTrees = 150, lr = 0.05, maxDepth = 4, minLeaf = 30, subsample = 0.8, featureFrac = 1.0, earlyStoppingRounds = 15 } = {}) {
  const d = Xtr[0].length;
  const n = Xtr.length;
  const trees = [];
  // init log-odds = logit(mean(y))
  const meanY = mean1(ytr);
  const init = Math.log(meanY / (1 - meanY));
  const Ftr = new Array(n).fill(init);
  const Fva = new Array(Xva.length).fill(init);

  let bestValBrier = Infinity, bestRound = -1, roundsSinceBest = 0;
  const bestState = { treesCopy: null, init, bestRound: 0 };

  const featIdxAll = Array.from({ length: d }, (_, i) => i);

  for (let t = 0; t < nTrees; t++) {
    // gradients & hessians para log-loss: g_i = p_i - y_i, h_i = p_i*(1-p_i)
    const p = Ftr.map(sigmoid);
    const grad = new Array(n);
    const hess = new Array(n);
    for (let i = 0; i < n; i++) {
      grad[i] = p[i] - ytr[i];
      hess[i] = p[i] * (1 - p[i]);
    }

    // subsample rows
    const subN = Math.max(minLeaf * 2, Math.floor(n * subsample));
    const subIdx = [];
    for (let k = 0; k < subN; k++) subIdx.push(Math.floor(Math.random() * n));
    const Xsub = subIdx.map(i => Xtr[i]);
    const gSub = subIdx.map(i => grad[i]);
    const hSub = subIdx.map(i => hess[i]);

    // subsample features
    let featIdx = featIdxAll;
    if (featureFrac < 1.0) {
      const k = Math.max(1, Math.floor(d * featureFrac));
      featIdx = featIdxAll.slice().sort(() => Math.random() - 0.5).slice(0, k);
    }

    const tree = buildTree(Xsub, gSub, hSub, maxDepth, minLeaf, featIdx);
    trees.push(tree);

    // update Ftr e Fva
    for (let i = 0; i < n; i++) Ftr[i] += lr * predictTree(tree, Xtr[i]);
    for (let i = 0; i < Xva.length; i++) Fva[i] += lr * predictTree(tree, Xva[i]);

    // val brier
    const pVa = Fva.map(sigmoid);
    const br = mean1(pVa.map((p, i) => (p - yva[i]) ** 2));

    if (br < bestValBrier - 1e-6) {
      bestValBrier = br; bestRound = t;
      bestState.treesCopy = trees.slice(); // cópia leve do array (refs ainda)
      bestState.bestRound = t;
      roundsSinceBest = 0;
    } else {
      roundsSinceBest++;
    }

    if ((t + 1) % 10 === 0 || t === nTrees - 1) {
      console.log(`  tree ${t + 1}/${nTrees}: val_brier=${br.toFixed(5)} (best=${bestValBrier.toFixed(5)} @${bestRound + 1})`);
    }
    if (roundsSinceBest >= earlyStoppingRounds) {
      console.log(`  early stopping @ tree ${t + 1} (no improvement for ${earlyStoppingRounds} rounds)`);
      break;
    }
  }

  const finalTrees = bestState.treesCopy
    ? bestState.treesCopy.slice(0, bestState.bestRound + 1)
    : trees;
  return { init, trees: finalTrees, lr };
}

function gbdtPredict(model, X) {
  return X.map(xi => {
    let F = model.init;
    for (const t of model.trees) F += model.lr * predictTree(t, xi);
    return sigmoid(F);
  });
}

let gbdtModel = null;
if (USE_GBDT) {
  console.log(`\n[gbdt] training (trees=${GBDT_TREES} depth=${GBDT_DEPTH} lr=${GBDT_LR})...`);
  gbdtModel = trainGBDT(XtrS, ytr, XvaS, yva, {
    nTrees: GBDT_TREES, lr: GBDT_LR, maxDepth: GBDT_DEPTH,
    minLeaf: GBDT_MIN_LEAF, subsample: GBDT_SUBSAMPLE, featureFrac: 0.8,
    earlyStoppingRounds: 20,
  });
}

// ── Ensemble: média simples ────────────────────────────────────────────
function ensemblePredict(XS) {
  const pLog = logisticPredict(logisticModel, XS);
  if (!gbdtModel) return pLog;
  const pGb = gbdtPredict(gbdtModel, XS);
  return pLog.map((p, i) => 0.5 * (p + pGb[i]));
}

// ── Calibração isotônica ─────────────────────────────────────────────────
// Pool adjacent violators (PAV). Aplica sobre val set.
function isotonicFit(pPred, yTrue) {
  const n = pPred.length;
  const pairs = pPred.map((p, i) => ({ p, y: yTrue[i] })).sort((a, b) => a.p - b.p);
  // Blocos: [{pMin, pMax, y, n}]
  const blocks = pairs.map(pr => ({ pMin: pr.p, pMax: pr.p, sumY: pr.y, n: 1 }));
  let i = 0;
  while (i < blocks.length - 1) {
    const bi = blocks[i], bn = blocks[i + 1];
    const meanI = bi.sumY / bi.n;
    const meanN = bn.sumY / bn.n;
    if (meanI > meanN) {
      // merge
      bi.pMax = bn.pMax;
      bi.sumY += bn.sumY;
      bi.n += bn.n;
      blocks.splice(i + 1, 1);
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  // retorna (pThreshold, yMean) pairs
  return blocks.map(b => ({ pMin: b.pMin, pMax: b.pMax, yMean: b.sumY / b.n }));
}

function isotonicApply(isoBlocks, p) {
  if (!isoBlocks.length) return p;
  if (p <= isoBlocks[0].pMax) return isoBlocks[0].yMean;
  if (p >= isoBlocks[isoBlocks.length - 1].pMin) return isoBlocks[isoBlocks.length - 1].yMean;
  // binária
  let lo = 0, hi = isoBlocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = isoBlocks[mid];
    if (p < b.pMin) hi = mid - 1;
    else if (p > b.pMax) lo = mid + 1;
    else return b.yMean;
  }
  // fallback: interpolação entre blocos
  for (let j = 0; j < isoBlocks.length - 1; j++) {
    if (p > isoBlocks[j].pMax && p < isoBlocks[j + 1].pMin) {
      const a = isoBlocks[j], b = isoBlocks[j + 1];
      const t = (p - a.pMax) / (b.pMin - a.pMax);
      return a.yMean + t * (b.yMean - a.yMean);
    }
  }
  return p;
}

console.log(`\n[calibration] fitting isotonic on val...`);
const valEnsembleRaw = ensemblePredict(XvaS);
const isoBlocks = isotonicFit(valEnsembleRaw, yva);
console.log(`  isotonic blocks: ${isoBlocks.length}`);

// ── Métricas ──────────────────────────────────────────────────────────
function computeMetrics(preds, y) {
  const n = preds.length;
  const brier = mean1(preds.map((p, i) => (p - y[i]) ** 2));
  const ll = mean1(preds.map((p, i) => logLoss(p, y[i])));
  const acc = mean1(preds.map((p, i) => (p >= 0.5 ? 1 : 0) === y[i] ? 1 : 0));
  // ROC-AUC via mann-whitney
  const pairs = preds.map((p, i) => ({ p, y: y[i] }));
  const pos = pairs.filter(o => o.y === 1);
  const neg = pairs.filter(o => o.y === 0);
  let wins = 0, ties = 0;
  for (const pp of pos) for (const nn of neg) {
    if (pp.p > nn.p) wins++;
    else if (pp.p === nn.p) ties++;
  }
  const auc = pos.length && neg.length ? (wins + 0.5 * ties) / (pos.length * neg.length) : 0;
  // ECE (10 bins)
  const BINS = 10;
  let ece = 0;
  for (let b = 0; b < BINS; b++) {
    const lo = b / BINS, hi = (b + 1) / BINS;
    const inBin = pairs.filter(o => o.p >= lo && (b === BINS - 1 ? o.p <= hi : o.p < hi));
    if (!inBin.length) continue;
    const avgP = mean1(inBin.map(o => o.p));
    const avgY = mean1(inBin.map(o => o.y));
    ece += (inBin.length / n) * Math.abs(avgP - avgY);
  }
  return { n, brier, logloss: ll, acc, auc, ece };
}

function fmt(m) {
  return `n=${m.n} | brier=${m.brier.toFixed(5)} | logloss=${m.logloss.toFixed(5)} | acc=${(m.acc * 100).toFixed(2)}% | auc=${m.auc.toFixed(4)} | ece=${m.ece.toFixed(4)}`;
}

// baselines: always 0.5, rank por Elo blend
function baselineElo(rows) {
  return rows.map(r => {
    const e = parseFloat(r.elo_diff_blend) || 0;
    return sigmoid(e / 400);
  });
}

const pLogTr = logisticPredict(logisticModel, XtrS);
const pLogVa = logisticPredict(logisticModel, XvaS);
const pLogTe = logisticPredict(logisticModel, XteS);
const pEnsTe = ensemblePredict(XteS);
const pEnsCalTe = pEnsTe.map(p => isotonicApply(isoBlocks, p));
const pBaseTe = baselineElo(testRows);

console.log(`\n── Métricas ────────────────────────────────`);
console.log(`baseline elo (test):        ${fmt(computeMetrics(pBaseTe, yte))}`);
console.log(`logistic (train):           ${fmt(computeMetrics(pLogTr, ytr))}`);
console.log(`logistic (val):             ${fmt(computeMetrics(pLogVa, yva))}`);
console.log(`logistic (test):            ${fmt(computeMetrics(pLogTe, yte))}`);
if (gbdtModel) {
  console.log(`gbdt (test):                ${fmt(computeMetrics(gbdtPredict(gbdtModel, XteS), yte))}`);
  console.log(`ensemble raw (test):        ${fmt(computeMetrics(pEnsTe, yte))}`);
  console.log(`ensemble calibrated (test): ${fmt(computeMetrics(pEnsCalTe, yte))}`);
}

// ── Feature importance (logistic) ─────────────────────────────────────
console.log(`\n── Feature importances (|w| logistic padronizado) ──`);
const fi = FEATURE_NAMES.map((name, j) => ({ name, w: logisticModel.w[j] }));
fi.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
for (const f of fi) {
  const bar = '█'.repeat(Math.min(40, Math.round(Math.abs(f.w) * 20)));
  console.log(`  ${f.name.padEnd(24)} ${f.w >= 0 ? '+' : ''}${f.w.toFixed(3).padStart(7)} ${bar}`);
}

// ── Save ──────────────────────────────────────────────────────────────
const outObj = {
  version: 1,
  trainedAt: new Date().toISOString(),
  featureNames: FEATURE_NAMES,
  standardize: { mean, std },
  logistic: { w: logisticModel.w, b: logisticModel.b, l2: bestL2 },
  gbdt: gbdtModel ? {
    init: gbdtModel.init,
    lr: gbdtModel.lr,
    trees: gbdtModel.trees,
  } : null,
  ensembleWeights: gbdtModel ? { logistic: 0.5, gbdt: 0.5 } : { logistic: 1, gbdt: 0 },
  calibration: { method: 'isotonic', blocks: isoBlocks },
  metrics: {
    baseline_elo_test: computeMetrics(pBaseTe, yte),
    logistic_test: computeMetrics(pLogTe, yte),
    ensemble_raw_test: gbdtModel ? computeMetrics(pEnsTe, yte) : null,
    ensemble_calibrated_test: gbdtModel ? computeMetrics(pEnsCalTe, yte) : computeMetrics(pLogTe.map(p => isotonicApply(isoBlocks, p)), yte),
  },
  splits: {
    train: { n: trainRows.length, from: trainRows[0]?.date, to: trainRows[trainRows.length - 1]?.date },
    val: { n: valRows.length, from: valRows[0]?.date, to: valRows[valRows.length - 1]?.date },
    test: { n: testRows.length, from: testRows[0]?.date, to: testRows[testRows.length - 1]?.date },
  },
};

const outDir = path.dirname(OUT_PATH);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(outObj, null, 2), 'utf8');
console.log(`\n[train] saved: ${OUT_PATH}`);

// Relatório resumido do que ficou salvo
const sizeKB = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
console.log(`[train] file size: ${sizeKB} KB`);

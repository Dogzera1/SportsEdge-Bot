// lib/tennis-model-trained.js
//
// Loader + predictor do modelo treinado de tênis (lib/tennis-weights.json).
// Feature vector montado a partir de estado em runtime (Elo, fatigue, H2H,
// ranking) — features ausentes viram 0 (o modelo foi treinado com todas,
// mas é robusto a missingness após padronização porque 0 == média depois
// da padronização para features centradas).
//
// Uso:
//   const { predictTrainedTennis, hasTrainedModel } = require('./tennis-model-trained');
//   const p = predictTrainedTennis({ elo1, elo2, surface, ... });
//   p === { p1, p2, used:true, featuresUsed, confidence, raw } | null

const fs = require('fs');
const path = require('path');
const { log } = require('./utils');

const WEIGHTS_PATH = process.env.TENNIS_WEIGHTS_PATH
  || path.join(__dirname, 'tennis-weights.json');

let _cached = null;
let _loadedPath = null;
let _loadFailed = false;

function tryLoad() {
  if (_cached || _loadFailed) return _cached;
  try {
    if (!fs.existsSync(WEIGHTS_PATH)) {
      log('INFO', 'TENNIS-TRAINED', `weights file not found: ${WEIGHTS_PATH} — trained model disabled`);
      _loadFailed = true;
      return null;
    }
    const raw = fs.readFileSync(WEIGHTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.logistic || !parsed.standardize || !parsed.featureNames) {
      log('WARN', 'TENNIS-TRAINED', `weights file missing required fields`);
      _loadFailed = true;
      return null;
    }
    _cached = parsed;
    _loadedPath = WEIGHTS_PATH;
    const m = parsed.metrics?.ensemble_calibrated_test || parsed.metrics?.logistic_test;
    log('INFO', 'TENNIS-TRAINED',
      `loaded weights v${parsed.version} trained ${parsed.trainedAt} | test brier=${m?.brier?.toFixed(5)} acc=${(m?.acc * 100)?.toFixed(2)}% auc=${m?.auc?.toFixed(4)}`);
    return _cached;
  } catch (e) {
    log('WARN', 'TENNIS-TRAINED', `failed to load weights: ${e.message}`);
    _loadFailed = true;
    return null;
  }
}

function hasTrainedModel() {
  return !!tryLoad();
}

// ── Feature vector builder ────────────────────────────────────────────────
// Surface mapping: runtime usa 'saibro'/'grama'/'dura', treino usou 'clay'/'grass'/'hard'.
function canonSurface(s) {
  const x = String(s || '').toLowerCase();
  if (x === 'saibro' || x === 'clay') return 'clay';
  if (x === 'grama' || x === 'grass') return 'grass';
  return 'hard';
}

/**
 * Monta o vetor de features na MESMA ordem de FEATURE_NAMES do treino.
 * Inputs vêm de estado de runtime (Elo do DB, fatigue/H2H do DB, ranking do enrich).
 * Features ausentes viram 0 (após padronização será ≈ média do treino).
 *
 * @param {object} ctx
 * @param {number} ctx.eloOverall1, eloOverall2
 * @param {number} ctx.eloSurface1, eloSurface2
 * @param {number} ctx.gamesSurface1, gamesSurface2  (p/ decidir blend)
 * @param {string} ctx.surface                       ('dura'/'saibro'/'grama' ou 'hard'/'clay'/'grass')
 * @param {number} [ctx.rank1], [ctx.rank2]          (rank atual)
 * @param {number} [ctx.rankPoints1], [ctx.rankPoints2]
 * @param {number} [ctx.age1], [ctx.age2]
 * @param {number} [ctx.height1], [ctx.height2]
 * @param {number} [ctx.servePct1], [ctx.servePct2]  (SPW 0-1)
 * @param {number} [ctx.fatigueMin7d_1], [ctx.fatigueMin7d_2]
 * @param {number} [ctx.matches14d_1], [ctx.matches14d_2]
 * @param {number} [ctx.daysSinceLast1], [ctx.daysSinceLast2]
 * @param {number} [ctx.h2hSurface1], [ctx.h2hSurface2]  (p/ vencidos em surface)
 * @param {number} [ctx.h2hAll1], [ctx.h2hAll2]          (p/ vencidos geral)
 * @param {number} [ctx.bestOf]                      (3 ou 5)
 * @returns { vector, featuresUsed: {...} }
 */
function buildRuntimeFeatureVector(ctx) {
  const surface = canonSurface(ctx.surface);
  const bestOf = Number.isFinite(+ctx.bestOf) ? +ctx.bestOf : 3;

  // Blend Elo (igual ao treino)
  const p1BlendOk = (ctx.gamesSurface1 || 0) >= 5;
  const p2BlendOk = (ctx.gamesSurface2 || 0) >= 5;
  const p1Blend = p1BlendOk
    ? 0.75 * (ctx.eloSurface1 || 1500) + 0.25 * (ctx.eloOverall1 || 1500)
    : (ctx.eloOverall1 || 1500);
  const p2Blend = p2BlendOk
    ? 0.75 * (ctx.eloSurface2 || 1500) + 0.25 * (ctx.eloOverall2 || 1500)
    : (ctx.eloOverall2 || 1500);

  const eloBlend = p1Blend - p2Blend;
  const eloOverall = (ctx.eloOverall1 || 1500) - (ctx.eloOverall2 || 1500);
  const eloSurf = (ctx.eloSurface1 || 1500) - (ctx.eloSurface2 || 1500);

  const rankDiff = (Number.isFinite(+ctx.rank1) && Number.isFinite(+ctx.rank2))
    ? (+ctx.rank1 - +ctx.rank2) : 0;
  const rpLogRatio = (Number.isFinite(+ctx.rankPoints1) && Number.isFinite(+ctx.rankPoints2)
      && +ctx.rankPoints1 > 0 && +ctx.rankPoints2 > 0)
    ? Math.log(+ctx.rankPoints1 / +ctx.rankPoints2) : 0;
  const ageDiff = (Number.isFinite(+ctx.age1) && Number.isFinite(+ctx.age2))
    ? (+ctx.age1 - +ctx.age2) : 0;
  const heightDiff = (Number.isFinite(+ctx.height1) && Number.isFinite(+ctx.height2)
      && +ctx.height1 > 0 && +ctx.height2 > 0)
    ? (+ctx.height1 - +ctx.height2) : 0;
  const servePctDiff = (Number.isFinite(+ctx.servePct1) && Number.isFinite(+ctx.servePct2))
    ? (+ctx.servePct1 - +ctx.servePct2) : 0;
  const fatigueMin7Diff = (+ctx.fatigueMin7d_1 || 0) - (+ctx.fatigueMin7d_2 || 0);
  const matches14Diff = (+ctx.matches14d_1 || 0) - (+ctx.matches14d_2 || 0);
  const d1 = Math.min(Number.isFinite(+ctx.daysSinceLast1) ? +ctx.daysSinceLast1 : 120, 120);
  const d2 = Math.min(Number.isFinite(+ctx.daysSinceLast2) ? +ctx.daysSinceLast2 : 120, 120);
  const daysSinceDiff = d1 - d2;
  const h2hSurfaceDiff = (+ctx.h2hSurface1 || 0) - (+ctx.h2hSurface2 || 0);
  const h2hOverallDiff = (+ctx.h2hAll1 || 0) - (+ctx.h2hAll2 || 0);

  // Conta sinais com dados reais (usado p/ confidence)
  let nSignals = 0;
  if ((ctx.eloOverall1 || 0) > 1500.1 || (ctx.eloOverall1 || 0) < 1499.9) nSignals++;
  if (p1BlendOk && p2BlendOk) nSignals++;
  if (rankDiff !== 0) nSignals++;
  if (servePctDiff !== 0) nSignals++;
  if (fatigueMin7Diff !== 0 || matches14Diff !== 0) nSignals++;
  if (h2hOverallDiff !== 0 || h2hSurfaceDiff !== 0) nSignals++;

  // Momentum (novo 2026-04-18; ctx opcional — default 0 = neutro após padronização).
  // Caller pode pré-computar winStreakDiff/wrLast10Diff via query recent matches.
  const winStreakDiff = Number.isFinite(+ctx.winStreakDiff) ? +ctx.winStreakDiff : 0;
  const wrLast10Diff = Number.isFinite(+ctx.wrLast10Diff) ? +ctx.wrLast10Diff : 0;
  const eloDiffSq = Math.sign(eloBlend) * (eloBlend * eloBlend) / 1000;

  // Ordem PRECISA bater com FEATURE_NAMES do treino. Dim expected:
  //   20 = base + surface + interactions              (pré-momentum, weights antigas)
  //   23 = base + momentum + surface + interactions  (2026-04-18+)
  const base = [
    eloBlend,            // elo_diff_blend
    eloOverall,          // elo_diff_overall
    eloSurf,             // elo_diff_surface
    rankDiff,            // rank_diff
    rpLogRatio,          // rank_points_log_ratio
    ageDiff,             // age_diff
    heightDiff,          // height_diff
    servePctDiff,        // serve_pct_diff
    fatigueMin7Diff,     // fatigue_min_7d_diff
    matches14Diff,       // matches_14d_diff
    daysSinceDiff,       // days_since_last_diff
    h2hSurfaceDiff,      // h2h_surface_diff
    h2hOverallDiff,      // h2h_overall_diff
    nSignals,            // n_signals
  ];
  const momentum = [winStreakDiff, wrLast10Diff, eloDiffSq];
  const tail = [
    surface === 'hard' ? 1 : 0,
    surface === 'clay' ? 1 : 0,
    surface === 'grass' ? 1 : 0,
    bestOf === 5 ? eloBlend : 0,
    surface === 'clay' ? eloBlend : 0,
    surface === 'grass' ? eloBlend : 0,
  ];
  return { vector: [...base, ...momentum, ...tail], vectorLegacy: [...base, ...tail], nSignals, eloBlend, surface };
}

// ── Predict ──────────────────────────────────────────────────────────────
function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); }

function predictTree(tree, x) {
  while (!tree.leaf) tree = x[tree.feat] <= tree.thresh ? tree.left : tree.right;
  return tree.value;
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

/**
 * Prediz P1 com o modelo treinado. Retorna null se pesos não disponíveis.
 * @returns {{ p1, p2, raw, calibrated, method, confidence, nSignals } | null}
 */
function predictTrainedTennis(ctx) {
  const W = tryLoad();
  if (!W) return null;

  const { vector: v23, vectorLegacy: v20, nSignals, eloBlend, surface } = buildRuntimeFeatureVector(ctx);
  const { mean, std } = W.standardize;
  // Escolhe vetor compatível: weights nova (23 dims c/ momentum) ou antiga (20).
  const v = mean.length === v20.length ? v20 : v23;
  if (v.length !== mean.length) {
    log('WARN', 'TENNIS-TRAINED', `feature dim mismatch: v=${v.length} weights=${mean.length}`);
    return null;
  }
  const xs = v.map((x, j) => (x - mean[j]) / (std[j] || 1));

  // Logistic
  let z = W.logistic.b;
  for (let j = 0; j < xs.length; j++) z += W.logistic.w[j] * xs[j];
  let pLog = sigmoid(z);

  // GBDT (se presente)
  let pGbdt = null;
  if (W.gbdt && Array.isArray(W.gbdt.trees) && W.gbdt.trees.length) {
    let F = W.gbdt.init;
    for (const t of W.gbdt.trees) F += W.gbdt.lr * predictTree(t, xs);
    pGbdt = sigmoid(F);
  }

  const ew = W.ensembleWeights || { logistic: 1, gbdt: 0 };
  const raw = pGbdt != null
    ? (ew.logistic * pLog + ew.gbdt * pGbdt)
    : pLog;

  // Kill switch p/ isotonic interna do weights file. Esports model gateia via
  // W.calibration.active flag — tennis-weights v1 não tem flag, então isotonic
  // sempre rodava. PAV de 1206 amostras tem 82 blocks com pequenos
  // saltos não-monotônicos; opt-out via env quando suspeitar de degradação.
  const internalIsoDisabled = /^(1|true|yes)$/i.test(String(process.env.TENNIS_INTERNAL_ISOTONIC_DISABLED || ''));
  const calibrated = internalIsoDisabled ? raw : applyIsotonic(W.calibration?.blocks, raw);

  // Confidence: cresce com sinais disponíveis, cap em 0.85
  const confidence = Math.min(0.85, 0.30 + 0.10 * nSignals);

  return {
    p1: +calibrated.toFixed(4),
    p2: +(1 - calibrated).toFixed(4),
    raw: +raw.toFixed(4),
    calibrated: +calibrated.toFixed(4),
    method: `trained(${pGbdt != null ? 'logistic+gbdt' : 'logistic'}${internalIsoDisabled ? '' : '+isotonic'})`,
    confidence: +confidence.toFixed(2),
    nSignals,
    eloBlend,
    surface,
  };
}

/**
 * Query recent matches de um jogador em match_results (tennis) pra computar
 * win_streak + wr_last10. Retorna { streak, wrLast10 } ou null se sem dados.
 * Usado por callers que querem momentum no ctx pra predictTrainedTennis.
 */
function getTennisRecentMomentum(db, playerName, beforeDate = null) {
  if (!db || !playerName) return null;
  try {
    const cutoff = beforeDate ? new Date(beforeDate).toISOString() : new Date().toISOString();
    const rows = db.prepare(`
      SELECT winner, team1, team2, resolved_at
      FROM match_results
      WHERE game='tennis' AND resolved_at < ?
        AND (lower(team1)=lower(?) OR lower(team2)=lower(?))
      ORDER BY resolved_at DESC
      LIMIT 15
    `).all(cutoff, playerName, playerName);
    if (!rows.length) return null;
    // Constrói `wonArr` em ordem cronológica (oldest → newest)
    const wonArr = rows.reverse().map(r =>
      String(r.winner || '').toLowerCase() === String(playerName).toLowerCase() ? 1 : 0
    );
    // Streak a partir do final
    const last = wonArr[wonArr.length - 1];
    let streak = 0;
    for (let i = wonArr.length - 1; i >= 0; i--) {
      if (wonArr[i] === last) streak++; else break;
    }
    streak = last ? streak : -streak;
    // WR last 10 (se temos pelo menos 10)
    const wrLast10 = wonArr.length >= 10
      ? wonArr.slice(-10).reduce((a, b) => a + b, 0) / 10
      : null;
    return { streak, wrLast10 };
  } catch (_) { return null; }
}

module.exports = {
  predictTrainedTennis,
  hasTrainedModel,
  buildRuntimeFeatureVector, // exposto p/ testes
  getTennisRecentMomentum,   // helper pra caller computar ctx.winStreakDiff/wrLast10Diff
};

// lib/esports-model-trained.js
//
// Loader + predictor do modelo treinado para esports (lol/dota2/valorant/cs2).
// Carrega lib/<game>-weights.json se existir e se o modelo bateu baseline Elo
// no test. Caso contrário, retorna null (fallback para heurística).
//
// Uso:
//   const { predictTrainedEsports, hasTrainedModel } = require('./esports-model-trained');
//   const p = predictTrainedEsports('lol', { eloOverall1, eloOverall2, ... });

const fs = require('fs');
const path = require('path');
const { log } = require('./utils');

// External post-hoc isotonic (fit via scripts/fit-esports-isotonic.js per game).
// Carrega lib/{game}-isotonic.json se existir. Aplicado APÓS a isotônica interna
// dos weights (dupla calibração — ajuda quando a interna é sub-ótima pelo modelo
// treinado e externa calibra sobre distribuição real do jogo via Elo walk-forward).
// Só aplicado quando ENV permite e confidence < 0.70 (trained muito confiante =
// confia no que ele diz).
const _extIsotonicCache = new Map(); // game → blocks | null
function _loadExtIsotonic(game) {
  const g = String(game || '').toLowerCase();
  if (_extIsotonicCache.has(g)) return _extIsotonicCache.get(g);
  try {
    const p = path.join(__dirname, `${g}-isotonic.json`);
    if (!fs.existsSync(p)) { _extIsotonicCache.set(g, null); return null; }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const blocks = Array.isArray(j.blocks) && j.blocks.length ? j.blocks : null;
    _extIsotonicCache.set(g, blocks);
    if (blocks) log('INFO', 'ES-TRAINED', `${g}: external isotonic loaded (${blocks.length} blocks)`);
    return blocks;
  } catch (_) { _extIsotonicCache.set(g, null); return null; }
}

const MODE_ENV = game => `${game.toUpperCase()}_TRAINED_MODE`;

const _cache = new Map(); // game → { weights | null, loadedAt }
const _failed = new Set();

function _weightsPath(game) {
  return process.env[`${game.toUpperCase()}_WEIGHTS_PATH`]
    || path.join(__dirname, `${game}-weights.json`);
}

function tryLoad(game) {
  const g = String(game || '').toLowerCase();
  if (_cache.has(g)) return _cache.get(g).weights;
  if (_failed.has(g)) return null;
  const p = _weightsPath(g);
  try {
    if (!fs.existsSync(p)) {
      log('INFO', 'ES-TRAINED', `${g}: weights file not found (${p}) — trained disabled`);
      _failed.add(g);
      return null;
    }
    const W = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!W.logistic || !W.standardize || !W.featureNames) {
      log('WARN', 'ES-TRAINED', `${g}: weights incomplete`);
      _failed.add(g);
      return null;
    }
    // Gate: requer lift mínimo MIN_LIFT_PCT (default 5%) sobre baseline Elo no test.
    // Antes era >=base (qualquer lift passava). Em test n<300 a variance ~1.5-2%
    // → lifts <5% (Darts -2.3%, Snooker -3.4%, Dota2 -4%, Valorant -3.7%) são
    // ruído. Override via <GAME>_TRAINED_MIN_LIFT (decimal, e.g. 0.02 = 2%).
    const baseBrier = W.metrics?.baseline_elo_test?.brier;
    const chosenMetric = W.metrics?.chosen === 'calibrated'
      ? W.metrics?.ensemble_calibrated_test
      : (W.metrics?.ensemble_raw_test || W.metrics?.logistic_test);
    const chosenBrier = chosenMetric?.brier;
    const minLiftPct = parseFloat(
      process.env[`${g.toUpperCase()}_TRAINED_MIN_LIFT`]
      ?? process.env.TRAINED_MIN_LIFT
      ?? '0.05'
    );
    const requiredBrier = baseBrier != null ? baseBrier * (1 - minLiftPct) : null;
    if (baseBrier != null && chosenBrier != null && chosenBrier >= requiredBrier) {
      const liftPct = ((baseBrier - chosenBrier) / baseBrier * 100).toFixed(1);
      log('WARN', 'ES-TRAINED',
        `${g}: lift ${liftPct}% < ${(minLiftPct*100).toFixed(0)}% threshold (brier=${chosenBrier?.toFixed(5)} vs base=${baseBrier?.toFixed(5)}) — trained disabled`);
      _cache.set(g, { weights: null, loadedAt: Date.now() });
      _failed.add(g);
      return null;
    }
    _cache.set(g, { weights: W, loadedAt: Date.now() });
    log('INFO', 'ES-TRAINED',
      `${g}: loaded v${W.version} ${W.trainedAt} | test brier=${chosenBrier?.toFixed(5)} acc=${(chosenMetric?.acc * 100)?.toFixed(2)}% auc=${chosenMetric?.auc?.toFixed(4)} | baseline=${baseBrier?.toFixed(5)}`);
    return W;
  } catch (e) {
    log('WARN', 'ES-TRAINED', `${g}: load error ${e.message}`);
    _failed.add(g);
    return null;
  }
}

function hasTrainedModel(game) {
  return !!tryLoad(game);
}

// Modos:
//   'off'    — não usa trained
//   'shadow' — log mas usa heurística pra decisão
//   'active' — usa trained pra decisão
//
// Default 'active' só pra games com lift forte (LoL/CS2). Marginais
// (Valorant -3.7%, Dota2 -4%, MMA -6%, Darts -2.3%, Snooker -3.4%) ficam
// 'shadow' por default — observação sem afetar decisão. Override via env
// <GAME>_TRAINED_MODE.
const _STRONG_TRAINED = new Set(['lol', 'cs2']);
function modeFor(game) {
  const envMode = process.env[MODE_ENV(game)];
  if (envMode) return String(envMode).toLowerCase();
  return _STRONG_TRAINED.has(String(game || '').toLowerCase()) ? 'active' : 'shadow';
}

// ── Feature vector builder ────────────────────────────────────────────────
// Ordem DEVE bater com FEATURE_NAMES em scripts/train-esports-model.js:
//   NUM_FEATURES = [elo_diff_overall, elo_diff_league, games_t1, games_t2,
//                   winrate_diff_10, winrate_diff_20, h2h_diff, h2h_total,
//                   days_since_last_t1, days_since_last_t2, days_since_diff,
//                   matches_last14_diff, n_signals, best_of]
//   + tier_1, tier_2, tier_3, elo_x_bo_series
//
// p1 = team1 do match já alfabeticamente menor? NÃO — no treino p1 foi alfa menor.
// No runtime precisamos manter consistência: se o chamador passar team1/team2 ordem
// qualquer, invertemos se preciso e depois mapeamos P de volta.
function buildVector(ctx, expectedDim) {
  const bestOf = Number.isFinite(+ctx.bestOf) ? +ctx.bestOf : 1;
  const tier = Number.isFinite(+ctx.leagueTier) ? +ctx.leagueTier : 1;
  const elo = (ctx.eloOverall1 || 1500) - (ctx.eloOverall2 || 1500);
  const eloL = (ctx.eloLeague1 || ctx.eloOverall1 || 1500) - (ctx.eloLeague2 || ctx.eloOverall2 || 1500);
  const wr10 = Number.isFinite(+ctx.winRateDiff10) ? +ctx.winRateDiff10 : 0;
  const wr20 = Number.isFinite(+ctx.winRateDiff20) ? +ctx.winRateDiff20 : 0;
  const h2hDiff = Number.isFinite(+ctx.h2hDiff) ? +ctx.h2hDiff : 0;
  const h2hTotal = Number.isFinite(+ctx.h2hTotal) ? +ctx.h2hTotal : 0;
  const ds1 = Math.min(120, Number.isFinite(+ctx.daysSinceLast1) ? +ctx.daysSinceLast1 : 120);
  const ds2 = Math.min(120, Number.isFinite(+ctx.daysSinceLast2) ? +ctx.daysSinceLast2 : 120);
  const m14 = Number.isFinite(+ctx.matchesLast14Diff) ? +ctx.matchesLast14Diff : 0;

  let nSig = 0;
  if ((ctx.games1 || 0) >= 5 && (ctx.games2 || 0) >= 5) nSig++;
  if (wr10 !== 0) nSig++;
  if (h2hTotal >= 2) nSig++;
  if (eloL !== 0) nSig++;
  if (m14 !== 0) nSig++;

  const base = [
    elo, eloL,
    (ctx.games1 || 0), (ctx.games2 || 0),
    wr10, wr20,
    h2hDiff, h2hTotal,
    ds1, ds2, ds1 - ds2,
    m14,
    nSig, bestOf,
  ]; // 14 base

  // Momentum (3) — train-esports-model MOMENTUM_FEATURES (2026-04-18+)
  const winStreakDiff = Number.isFinite(+ctx.winStreakDiff) ? +ctx.winStreakDiff : 0;
  const wrTrendDiff = Number.isFinite(+ctx.wrTrendDiff) ? +ctx.wrTrendDiff : 0;
  const eloDiffSq = Math.sign(elo) * (elo * elo) / 1000;
  const momentum = [winStreakDiff, wrTrendDiff, eloDiffSq];

  // 1v1 features (3) — ONE_V_ONE_FEATURES. SOS + same-league wins/WR (MMA/darts/snooker).
  // Default 0 quando runtime não supply — neutro após padronização.
  const sosDiff = Number.isFinite(+ctx.sosDiff) ? +ctx.sosDiff : 0;
  const sameLeagueWinsDiff = Number.isFinite(+ctx.sameLeagueWinsDiff) ? +ctx.sameLeagueWinsDiff : 0;
  const sameLeagueWrDiff = Number.isFinite(+ctx.sameLeagueWrDiff) ? +ctx.sameLeagueWrDiff : 0;
  const oneVone = [sosDiff, sameLeagueWinsDiff, sameLeagueWrDiff];

  // LoL team_stats extras (11). 0 quando ausente — após padronização vira ~média.
  const lolExtras = [
    +ctx.gpmDiff || 0,
    +ctx.gdmDiff || 0,
    +ctx.gd15Diff || 0,
    +ctx.fbRateDiff || 0,
    +ctx.ftRateDiff || 0,
    +ctx.dpmDiff || 0,
    +ctx.kdDiff || 0,
    +ctx.teamWrDiff || 0,
    +ctx.draPctDiff || 0,
    +ctx.nashPctDiff || 0,
    ctx.hasTeamStats ? 1 : 0,
  ];

  // Oracle's Elixir rolling 60d extras (5).
  const oeExtras = [
    +ctx.oeGd15Diff || 0,
    +ctx.oeObjDiff || 0,
    +ctx.oeWrDiff || 0,
    +ctx.oeDpmDiff || 0,
    ctx.hasOeStats ? 1 : 0,
  ];

  // OE player-level roster extras (4).
  const playerExtras = [
    +ctx.avgKdaDiff || 0,
    +ctx.maxKdaDiff || 0,
    +ctx.starScoreDiff || 0,
    ctx.hasRosterStats ? 1 : 0,
  ];

  const cat = [
    tier === 1 ? 1 : 0,
    tier === 2 ? 1 : 0,
    tier === 3 ? 1 : 0,
    bestOf >= 3 ? elo : 0,
  ];

  // Compatibilidade com weights de várias gerações:
  //   18 = base + cat
  //   21 = base + momentum + cat                              (Dota2/CS2/Valorant 2026-04+)
  //   24 = base + momentum + 1v1 + cat                        (MMA/darts/snooker 2026-04-18+)
  //   29 = base + lolExtras + cat                             (LoL pré-OE)
  //   32 = base + momentum + lolExtras + cat                  (LoL + momentum, pré-OE)
  //   34 = base + lolExtras + oeExtras + cat                  (LoL com OE team)
  //   37 = base + momentum + lolExtras + oeExtras + cat
  //   38 = base + lolExtras + oeExtras + playerExtras + cat   (LoL com player roster)
  //   41 = base + momentum + lolExtras + oeExtras + playerExtras + cat   (LoL momentum + player, 2026-04-18+)
  if (expectedDim === base.length + cat.length) return [...base, ...cat];
  if (expectedDim === base.length + momentum.length + cat.length)
    return [...base, ...momentum, ...cat];
  if (expectedDim === base.length + momentum.length + oneVone.length + cat.length)
    return [...base, ...momentum, ...oneVone, ...cat];
  if (expectedDim === base.length + lolExtras.length + cat.length)
    return [...base, ...lolExtras, ...cat];
  if (expectedDim === base.length + momentum.length + lolExtras.length + cat.length)
    return [...base, ...momentum, ...lolExtras, ...cat];
  if (expectedDim === base.length + lolExtras.length + oeExtras.length + cat.length)
    return [...base, ...lolExtras, ...oeExtras, ...cat];
  if (expectedDim === base.length + momentum.length + lolExtras.length + oeExtras.length + cat.length)
    return [...base, ...momentum, ...lolExtras, ...oeExtras, ...cat];
  if (expectedDim === base.length + lolExtras.length + oeExtras.length + playerExtras.length + cat.length)
    return [...base, ...lolExtras, ...oeExtras, ...playerExtras, ...cat];
  if (expectedDim === base.length + momentum.length + lolExtras.length + oeExtras.length + playerExtras.length + cat.length)
    return [...base, ...momentum, ...lolExtras, ...oeExtras, ...playerExtras, ...cat];
  return [...base, ...momentum, ...oneVone, ...lolExtras, ...oeExtras, ...playerExtras, ...cat];
}

const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

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
 * Prediz P1 (primeiro time passado em ctx, NÃO necessariamente alfa menor).
 * O modelo treinou com p1=alfa_menor, então inverte se necessário e devolve
 * a P mapeada de volta pra ordem do chamador.
 *
 * @param {string} game - 'lol'|'dota2'|'valorant'|'cs2'
 * @param {object} ctx  - { team1, team2, eloOverall1/2, eloLeague1/2, games1/2,
 *                          winRateDiff10/20, h2hDiff, h2hTotal, daysSinceLast1/2,
 *                          matchesLast14Diff, bestOf, leagueTier }
 * @returns {{ p1, p2, raw, calibrated, method, confidence, nSignals } | null}
 */
function predictTrainedEsports(game, ctx) {
  const mode = modeFor(game);
  if (mode === 'off') return null;
  const W = tryLoad(game);
  if (!W) return null;

  // p1 alinhado à ordem do treino (alfa menor)
  const n1 = String(ctx.team1 || '').toLowerCase();
  const n2 = String(ctx.team2 || '').toLowerCase();
  const inv = n1 > n2;
  const normCtx = inv
    ? {
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
        // Momentum flips: diff quantities inverted; elo_diff_sq recomputed from inverted elo in buildVector
        winStreakDiff: -1 * (ctx.winStreakDiff || 0),
        wrTrendDiff: -1 * (ctx.wrTrendDiff || 0),
        bestOf: ctx.bestOf, leagueTier: ctx.leagueTier,
        // flip diff-based gol.gg stats
        gpmDiff: -1 * (ctx.gpmDiff || 0),
        gdmDiff: -1 * (ctx.gdmDiff || 0),
        gd15Diff: -1 * (ctx.gd15Diff || 0),
        fbRateDiff: -1 * (ctx.fbRateDiff || 0),
        ftRateDiff: -1 * (ctx.ftRateDiff || 0),
        dpmDiff: -1 * (ctx.dpmDiff || 0),
        kdDiff: -1 * (ctx.kdDiff || 0),
        teamWrDiff: -1 * (ctx.teamWrDiff || 0),
        draPctDiff: -1 * (ctx.draPctDiff || 0),
        nashPctDiff: -1 * (ctx.nashPctDiff || 0),
        hasTeamStats: ctx.hasTeamStats,
        // flip OE diffs
        oeGd15Diff: -1 * (ctx.oeGd15Diff || 0),
        oeObjDiff: -1 * (ctx.oeObjDiff || 0),
        oeWrDiff: -1 * (ctx.oeWrDiff || 0),
        oeDpmDiff: -1 * (ctx.oeDpmDiff || 0),
        hasOeStats: ctx.hasOeStats,
        // flip player roster diffs
        avgKdaDiff: -1 * (ctx.avgKdaDiff || 0),
        maxKdaDiff: -1 * (ctx.maxKdaDiff || 0),
        starScoreDiff: -1 * (ctx.starScoreDiff || 0),
        hasRosterStats: ctx.hasRosterStats,
      }
    : ctx;

  const { mean, std } = W.standardize;
  const v = buildVector(normCtx, mean.length);
  if (v.length !== mean.length) {
    log('WARN', 'ES-TRAINED', `${game}: feature dim mismatch v=${v.length} weights=${mean.length}`);
    return null;
  }
  const xs = v.map((x, j) => (x - mean[j]) / (std[j] || 1));

  let z = W.logistic.b;
  for (let j = 0; j < xs.length; j++) z += W.logistic.w[j] * xs[j];
  let pLog = sigmoid(z);

  let pGb = null;
  if (W.gbdt && Array.isArray(W.gbdt.trees) && W.gbdt.trees.length) {
    let F = W.gbdt.init;
    for (const t of W.gbdt.trees) F += W.gbdt.lr * predictTree(t, xs);
    pGb = sigmoid(F);
  }
  const ew = W.ensembleWeights || { logistic: 1, gbdt: 0 };
  const raw = pGb != null ? (ew.logistic * pLog + ew.gbdt * pGb) : pLog;

  const useCal = W.calibration?.active === true;
  let calibrated = useCal ? applyIsotonic(W.calibration.blocks, raw) : raw;

  // External post-hoc isotonic (ver _loadExtIsotonic). Opt-out via ENV.
  const extDisabled = process.env.EXT_ISOTONIC_DISABLED === 'true' ||
                      process.env[`${game.toUpperCase()}_EXT_ISOTONIC_DISABLED`] === 'true';
  if (!extDisabled) {
    const extBlocks = _loadExtIsotonic(game);
    if (extBlocks) {
      calibrated = applyIsotonic(extBlocks, calibrated);
    }
  }

  // 2026-05-01: CLV calibration layer (lit: arxiv 2410.21484). Aplicado pós
  // isotonic — puxa em direção a closing line. No-op se calib file ausente.
  // Opt-out: CLV_CALIB_DISABLED=true. Override per-sport: CLV_BLEND_WEIGHT_CS2=0.40 etc.
  // Sport key bate com lib/{sport}-clv-calibration.json. cs/cs2 unificados em 'cs2'.
  try {
    const { applyClvCalib } = require('./clv-calibration');
    const clvSport = game === 'cs' ? 'cs2' : game;
    calibrated = applyClvCalib(clvSport, calibrated);
  } catch (_) { /* opcional */ }

  // Re-mapeia p/ ordem original do chamador
  const pFirst = inv ? (1 - calibrated) : calibrated;

  // Confidence baseada em n_signals e gap baseline
  // Procura n_signals via featureNames pra resilência se ordem mudar; fallback
  // posição 12 (legacy).
  const nSigIdx = (W.featureNames || []).indexOf('n_signals');
  const nSig = nSigIdx >= 0 ? v[nSigIdx] : v[12];
  const conf = Math.min(0.80, 0.35 + 0.09 * nSig);

  // Mode 'shadow': loga mas retorna null pra caller não blendar.
  // Permite observação sem afetar decisão (Valorant/Dota2/MMA/Darts/Snk default).
  if (mode === 'shadow') {
    log('INFO', 'ES-TRAINED-SHADOW',
      `${game} ${ctx.team1} vs ${ctx.team2}: shadow_p1=${pFirst.toFixed(4)} (raw=${(inv ? 1 - raw : raw).toFixed(4)}) conf=${conf.toFixed(2)} nSig=${nSig}`);
    return null;
  }

  return {
    p1: +pFirst.toFixed(4),
    p2: +(1 - pFirst).toFixed(4),
    raw: +(inv ? 1 - raw : raw).toFixed(4),
    calibrated: +pFirst.toFixed(4),
    method: `trained(${pGb != null ? 'log+gbdt' : 'log'}${useCal ? '+iso' : ''})`,
    confidence: +conf.toFixed(2),
    nSignals: nSig,
    inverted: inv,
  };
}

module.exports = {
  predictTrainedEsports,
  hasTrainedModel,
  modeFor,
  buildVector,   // exposto p/ testes
};

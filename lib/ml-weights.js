'use strict';
// Dynamic weight manager for ML pre-filter factors
// Recalculates weights weekly based on per-factor accuracy

const DEFAULT_WEIGHTS = { forma: 0.25, h2h: 0.30, comp: 0.35, streak: 0.05, kd10: 0.10 };
const MIN_SAMPLE = 10; // minimum tips per factor to trust dynamic weight
const WEIGHT_FLOOR = 0.10;
const WEIGHT_CAP   = 0.55;

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

function getDynamicWeights(stmts) {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL_MS) return _cache;

  try {
    const rows = stmts.getAllFactorWeights.all();
    if (!rows.length) { _cache = { ...DEFAULT_WEIGHTS }; _cacheTs = now; return _cache; }

    const weights = {};
    for (const r of rows) {
      if (r.total >= MIN_SAMPLE) {
        weights[r.factor] = r.weight;
      } else {
        weights[r.factor] = DEFAULT_WEIGHTS[r.factor] ?? 0.30;
      }
    }
    // Fill missing factors with defaults
    for (const [k, v] of Object.entries(DEFAULT_WEIGHTS)) {
      if (!(k in weights)) weights[k] = v;
    }
    _cache = weights;
    _cacheTs = now;
    return weights;
  } catch (_) {
    return { ...DEFAULT_WEIGHTS };
  }
}

// Called weekly (or on demand) — recalculates weights from accuracy data
function recalcWeights(stmts, log) {
  try {
    const rows = stmts.getFactorAccuracyLast45d.all();
    if (!rows.length) { log && log('INFO', 'ML-WEIGHTS', 'Sem dados suficientes para recalcular pesos'); return; }

    const accuracies = {};
    for (const r of rows) {
      if (r.total >= MIN_SAMPLE) {
        accuracies[r.factor] = r.wins / r.total;
      }
    }

    if (!Object.keys(accuracies).length) return;

    // Softmax-style normalization: weight ∝ accuracy
    const baseline = 0.50; // random baseline
    const factors = Object.keys(accuracies);
    const rawWeights = {};
    let total = 0;
    for (const f of factors) {
      const edge = Math.max(0, accuracies[f] - baseline);
      rawWeights[f] = edge;
      total += edge;
    }

    // If all factors have 0 edge over baseline, keep defaults
    if (total === 0) {
      log && log('INFO', 'ML-WEIGHTS', 'Nenhum fator com edge > baseline — mantendo pesos padrão');
      return;
    }

    // Normalize and apply floor/cap
    const TARGET_SUM = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0); // ~0.90
    const newWeights = {};
    for (const f of factors) {
      const raw = (rawWeights[f] / total) * TARGET_SUM;
      newWeights[f] = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CAP, raw));
    }

    // Persist
    for (const [factor, weight] of Object.entries(newWeights)) {
      const acc = rows.find(r => r.factor === factor);
      stmts.upsertFactorWeight.run(factor, weight, acc?.wins ?? 0, acc?.total ?? 0);
    }

    _cache = null; // invalidate cache
    log && log('INFO', 'ML-WEIGHTS', `Pesos recalculados: ${JSON.stringify(newWeights)}`);
  } catch (e) {
    log && log('ERROR', 'ML-WEIGHTS', `Erro ao recalcular pesos: ${e.message}`);
  }
}

// Settle factor logs — call after tip settlement
function settleFactorLogs(stmts, log) {
  try {
    const unsettled = stmts.getUnsettledFactorLogs.all();
    for (const row of unsettled) {
      const winner = row.result === 'win' ? row.tip_participant : (row.participant1 === row.tip_participant ? 'team2' : 'team1');
      const dir = row.predicted_dir; // 't1' or 't2'
      const actual = (row.result === 'win') ? dir : (dir === 't1' ? 't2' : 't1');
      stmts.updateFactorLogWinner.run(actual, row.tip_id, row.factor);
    }
    if (unsettled.length) log && log('INFO', 'ML-WEIGHTS', `${unsettled.length} factor logs settled`);
  } catch (e) {
    log && log('ERROR', 'ML-WEIGHTS', `Erro ao settlear factor logs: ${e.message}`);
  }
}

module.exports = { getDynamicWeights, recalcWeights, settleFactorLogs, DEFAULT_WEIGHTS };

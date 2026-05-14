'use strict';

/**
 * valorant-rounds-model.js — Wave 2A pricing round-level Valorant per-map.
 *
 * Delegate a `cs-rounds-model.js` — Valorant MR12 (first-to-13 + OT) tem
 * format idêntico ao CS2:
 *   - 24 rounds avg sem OT
 *   - σ_diff ~3.5 rounds empirical
 *   - σ_total ~3.0 rounds
 *
 * Diferenças que podem ser tunadas via env override (default = CS defaults):
 *   - VAL_ROUNDS_K (default 16, tuning constant)
 *   - VAL_ROUNDS_SIGMA_FULL (default 3.5)
 *   - VAL_ROUNDS_SIGMA_TOTAL (default 3.0)
 *
 * Shadow-only default (idem Wave 1 CS rounds). Pra promover real, requer:
 *   - Sample 30d shadow n>=30
 *   - ROI shadow >= 3%
 *   - VALORANT_ROUNDS_ENABLED=true Railway env
 *
 * Cross-sport (P5): replica padrão arquitetural CS Wave 1 commit 197fef4.
 */
const { scanCsRoundsMarkets, roundDiffParams, roundTotalParams } = require('./cs-rounds-model');

function _envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

/**
 * Scanner Valorant rounds — wrapper que injeta envs Valorant-specific.
 *
 * @param {object} args — mesmo shape de scanCsRoundsMarkets
 * @returns {Array} tips
 */
function scanValorantRoundsMarkets(args = {}) {
  // Merge defaults Valorant (idem CS por ora — pode divergir futuro)
  const tips = scanCsRoundsMarkets({
    ...args,
    minEv: args.minEv ?? _envFloat('VAL_ROUNDS_MIN_EV', 4),
    maxEv: args.maxEv ?? _envFloat('VAL_ROUNDS_MAX_EV', 30),
    minPmodel: args.minPmodel ?? _envFloat('VAL_ROUNDS_MIN_PMODEL', 0.50),
    minOdd: args.minOdd ?? _envFloat('VAL_ROUNDS_MIN_ODD', 1.50),
    maxOdd: args.maxOdd ?? _envFloat('VAL_ROUNDS_MAX_ODD', 3.50),
    maxPerMatch: args.maxPerMatch ?? parseInt(process.env.VAL_ROUNDS_MAX_PER_MATCH || '3', 10),
  });
  // Anota source pra distinguir downstream (sport key Valorant em tips DB)
  for (const t of tips) {
    t._source = 'valorant_rounds_model';
  }
  return tips;
}

module.exports = {
  scanValorantRoundsMarkets,
  roundDiffParams,
  roundTotalParams,
};

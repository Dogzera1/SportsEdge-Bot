'use strict';

/**
 * lib/constants.js — constantes compartilhadas entre server.js / bot.js / libs.
 *
 * Antes: vários Set/Array inline com mesma lista (ML_MARKETS) duplicados em
 * 3+ lugares. Risco: adicionar novo market type em um e esquecer outro =
 * tip routed wrong.
 */

// Markets que entram em settlement direto via name match (winner detection).
// Outros markets (handicap/totals/btts/aces/...) são roteados pra
// market_tips_shadow + propagator.
const ML_MARKETS_LIST = ['ML', '1X2_H', '1X2_A', '1X2_D', 'OVER_2.5', 'UNDER_2.5'];
const ML_MARKETS = new Set(ML_MARKETS_LIST);

function isMlMarket(marketType) {
  return ML_MARKETS.has(String(marketType || 'ML').toUpperCase());
}

module.exports = {
  ML_MARKETS,        // Set para .has() lookup
  ML_MARKETS_LIST,   // Array para SQL IN(?,?,...) ou listagem
  isMlMarket,
};

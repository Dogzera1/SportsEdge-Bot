/**
 * Tests for lib/constants — ML_MARKETS dedup.
 */

const { ML_MARKETS, ML_MARKETS_LIST, isMlMarket } = require('../lib/constants');

module.exports = function runTests(t) {
  t.test('ML_MARKETS é Set', () => {
    t.assert(ML_MARKETS instanceof Set, 'deve ser Set');
  });

  t.test('ML_MARKETS_LIST é Array com mesmos elementos', () => {
    t.assert(Array.isArray(ML_MARKETS_LIST), 'deve ser Array');
    t.assert(ML_MARKETS_LIST.length === ML_MARKETS.size, 'tamanhos batem');
    for (const m of ML_MARKETS_LIST) t.assert(ML_MARKETS.has(m), `${m} não no Set`);
  });

  t.test('isMlMarket aceita ML / 1X2_H / 1X2_A / 1X2_D / OVER_2.5 / UNDER_2.5', () => {
    t.assert(isMlMarket('ML'));
    t.assert(isMlMarket('ml'), 'case-insensitive');
    t.assert(isMlMarket('1X2_H'));
    t.assert(isMlMarket('OVER_2.5'));
    t.assert(isMlMarket('UNDER_2.5'));
    t.assert(isMlMarket('1X2_D'));
  });

  t.test('isMlMarket rejeita non-ML', () => {
    t.assert(!isMlMarket('HANDICAP'));
    t.assert(!isMlMarket('TOTAL'));
    t.assert(!isMlMarket('TOTALACES'));
    t.assert(!isMlMarket('MAP1_WINNER'));
    t.assert(!isMlMarket('BTTS_YES'));
  });

  t.test('isMlMarket sem arg trata como ML', () => {
    t.assert(isMlMarket(null));
    t.assert(isMlMarket(undefined));
    t.assert(isMlMarket(''));
  });
};

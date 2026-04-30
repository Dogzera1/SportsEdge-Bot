/**
 * Tests for lib/football-data-features — getMarketDivergence + parsing.
 *
 * Não testa getShotXgForm/getClosingOddsBenchmark direto (precisariam DB
 * com football_data_csv populado). Foca em getMarketDivergence (puro).
 */

const { getMarketDivergence, getLeagueBaseline } = require('../lib/football-data-features');

module.exports = function runTests(t) {
  t.test('getMarketDivergence: input null retorna null', () => {
    t.assert(getMarketDivergence(null, null) === null);
    t.assert(getMarketDivergence({}, null) === null);
    t.assert(getMarketDivergence(null, {}) === null);
  });

  t.test('getMarketDivergence: model = market → divergence 0', () => {
    const r = getMarketDivergence(
      { pH: 0.5, pD: 0.3, pA: 0.2 },
      { pH: 0.5, pD: 0.3, pA: 0.2 }
    );
    t.assert(r != null);
    t.assert(r.divergence_h === 0);
    t.assert(r.divergence_d === 0);
    t.assert(r.divergence_a === 0);
    t.assert(r.max_divergence === 0);
    t.assert(r.suspect === false);
  });

  t.test('getMarketDivergence: divergência grande → suspect', () => {
    const r = getMarketDivergence(
      { pH: 0.70, pD: 0.20, pA: 0.10 },
      { pH: 0.45, pD: 0.30, pA: 0.25 }
    );
    t.assert(r.divergence_h === 0.25, `h=${r.divergence_h}`);
    t.assert(r.divergence_a === -0.15, `a=${r.divergence_a}`);
    t.assert(r.max_divergence === 0.25);
    t.assert(r.suspect === true, 'deve marcar suspect');
  });

  t.test('getMarketDivergence: <10pp não é suspect', () => {
    const r = getMarketDivergence(
      { pH: 0.50, pD: 0.30, pA: 0.20 },
      { pH: 0.45, pD: 0.32, pA: 0.23 }
    );
    t.assert(r.max_divergence < 0.10);
    t.assert(r.suspect === false, 'sub-threshold não deve suspect');
  });

  t.test('getMarketDivergence: campos missing tratados como 0', () => {
    const r = getMarketDivergence({ pH: 0.5 }, { pH: 0.6 });
    t.assert(r != null, 'não retorna null com pD/pA missing');
    t.assert(Math.abs(r.divergence_h + 0.10) < 1e-9, `h=${r.divergence_h}`);
  });

  t.test('getLeagueBaseline: invalid league retorna null', () => {
    t.assert(getLeagueBaseline(null, null) === null);
    t.assert(getLeagueBaseline(null, '') === null);
    // db null não causa throw
    t.assert(getLeagueBaseline(null, 'Premier League') === null);
  });
};

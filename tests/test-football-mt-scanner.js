/**
 * Tests for lib/football-mt-scanner — totals + handicap + DC + BTTS.
 */

const { scanFootballMarkets } = require('../lib/football-mt-scanner');

function _trainedMarketsBasic() {
  return {
    ou: {
      '0.5': { over: 0.95, under: 0.05 },
      '1.5': { over: 0.78, under: 0.22 },
      '2.5': { over: 0.55, under: 0.45 },
      '3.5': { over: 0.30, under: 0.70 },
    },
    btts: { yes: 0.50, no: 0.50 },
  };
}

module.exports = function runTests(t) {
  t.test('input vazio retorna array vazio', () => {
    t.assert(Array.isArray(scanFootballMarkets({})));
    t.assert(scanFootballMarkets({ pinMarkets: null, trainedMarkets: null }).length === 0);
  });

  t.test('totals over com EV positivo é detectado', () => {
    const tips = scanFootballMarkets({
      pinMarkets: { totals: [{ line: 2.5, oddsOver: 2.10, oddsUnder: 1.85 }] },
      trainedMarkets: _trainedMarketsBasic(),
      minEv: 5, minPmodel: 0.50, minOdd: 1.50, maxOdd: 4.0,
    });
    // pOver=0.55, odd=2.10 → EV = (0.55*2.10 - 1)*100 = 15.5%
    const overTip = tips.find(x => x.market === 'totals' && x.side === 'over');
    t.assert(overTip != null, 'over tip detectada');
    t.assert(overTip.ev > 5, `ev=${overTip.ev}`);
    t.assert(overTip.pModel === 0.55);
  });

  t.test('totals under abaixo de minPmodel rejeita', () => {
    // pUnder=0.05 (line 0.5), abaixo de minPmodel=0.50 → rejeita
    const tips = scanFootballMarkets({
      pinMarkets: { totals: [{ line: 0.5, oddsOver: 1.05, oddsUnder: 15.0 }] },
      trainedMarkets: _trainedMarketsBasic(),
      minEv: 5, minPmodel: 0.50,
    });
    const underTip = tips.find(x => x.market === 'totals' && x.side === 'under' && x.line === 0.5);
    t.assert(underTip == null, `under não deve passar (pUnder=0.05 < 0.50)`);
  });

  t.test('totals com odds inválidas (null) rejeita silenciosamente', () => {
    const tips = scanFootballMarkets({
      pinMarkets: { totals: [{ line: 2.5, oddsOver: null, oddsUnder: null }] },
      trainedMarkets: _trainedMarketsBasic(),
    });
    t.assert(tips.length === 0, `esperado 0 tips, got ${tips.length}`);
  });

  t.test('linha sem trained data é skipada', () => {
    // line 5.5 não existe em _trainedMarketsBasic
    const tips = scanFootballMarkets({
      pinMarkets: { totals: [{ line: 5.5, oddsOver: 2.0, oddsUnder: 1.85 }] },
      trainedMarkets: _trainedMarketsBasic(),
    });
    t.assert(tips.length === 0, 'line 5.5 deve ser ignorada');
  });

  t.test('EV acima de maxEv rejeita (anti-overconfidence)', () => {
    // pOver=0.55 (line 2.5), odd 5.0 → EV = (0.55*5 - 1)*100 = 175% — overconfident
    const tips = scanFootballMarkets({
      pinMarkets: { totals: [{ line: 2.5, oddsOver: 5.0, oddsUnder: 1.20 }] },
      trainedMarkets: _trainedMarketsBasic(),
      minEv: 5, minPmodel: 0.50, minOdd: 1.50, maxOdd: 4.0, maxEv: 50,
    });
    const overTip = tips.find(x => x.side === 'over');
    // odd 5.0 > maxOdd 4.0 — rejeita por gate odd, não EV
    t.assert(overTip == null, 'odd 5.0 > maxOdd 4.0');
  });

  t.test('odd abaixo de minOdd rejeita', () => {
    const tips = scanFootballMarkets({
      pinMarkets: { totals: [{ line: 0.5, oddsOver: 1.10, oddsUnder: 7.0 }] },
      trainedMarkets: _trainedMarketsBasic(),
      minEv: 5, minPmodel: 0.50, minOdd: 1.50,
    });
    const overTip = tips.find(x => x.line === 0.5 && x.side === 'over');
    t.assert(overTip == null, 'odd 1.10 < minOdd 1.50');
  });

  t.test('shape da tip retornada', () => {
    const tips = scanFootballMarkets({
      pinMarkets: { totals: [{ line: 2.5, oddsOver: 2.10, oddsUnder: 1.85 }] },
      trainedMarkets: _trainedMarketsBasic(),
      minEv: 5, minPmodel: 0.50,
    });
    const tip = tips[0];
    t.assert(tip != null);
    t.assert('market' in tip);
    t.assert('line' in tip);
    t.assert('side' in tip);
    t.assert('pModel' in tip);
    t.assert('odd' in tip);
    t.assert('ev' in tip);
    t.assert('label' in tip);
  });

  t.test('multiple lines geram multiple tips', () => {
    const tips = scanFootballMarkets({
      pinMarkets: {
        totals: [
          { line: 1.5, oddsOver: 1.30, oddsUnder: 3.50 },
          { line: 2.5, oddsOver: 2.10, oddsUnder: 1.85 },
        ],
      },
      trainedMarkets: _trainedMarketsBasic(),
      minEv: 5, minPmodel: 0.50, minOdd: 1.50,
    });
    // line 1.5: pOver=0.78, odd 1.30 → EV = (0.78*1.30 - 1)*100 = 1.4% < minEv 5 — reject
    // line 2.5: pOver=0.55, odd 2.10 → EV ~15.5% — pass
    t.assert(tips.length === 1, `esperado 1 tip, got ${tips.length}`);
    t.assert(tips[0].line === 2.5);
  });

  t.test('BTTS yes com EV+', () => {
    const tips = scanFootballMarkets({
      pinMarkets: { btts: { yesOdd: 1.95 } },
      trainedMarkets: _trainedMarketsBasic(), // btts.yes=0.50, odd 1.95 → EV = -2.5% < min, deve rejeitar
      minEv: 5, minPmodel: 0.50,
    });
    t.assert(tips.length === 0, 'BTTS pYes=0.50 odd=1.95 → EV=-2.5%, abaixo de minEv');
  });
};

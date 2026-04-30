/**
 * Tests for lib/elo-rating — eloExpected math + system basics.
 */

const { eloExpected, createEloSystem, findByName } = require('../lib/elo-rating');

module.exports = function runTests(t) {
  t.test('eloExpected: ratings iguais → 0.5', () => {
    t.assert(Math.abs(eloExpected(1500, 1500) - 0.5) < 1e-9);
  });

  t.test('eloExpected: A com +400 → ~0.91', () => {
    const p = eloExpected(1900, 1500);
    t.assert(p > 0.90 && p < 0.92, `p=${p}`);
  });

  t.test('eloExpected: A com -400 → ~0.09', () => {
    const p = eloExpected(1500, 1900);
    t.assert(p > 0.08 && p < 0.10, `p=${p}`);
  });

  t.test('eloExpected: A com -400 + B com +400 = 1', () => {
    const p1 = eloExpected(1500, 1900);
    const p2 = eloExpected(1900, 1500);
    t.assert(Math.abs(p1 + p2 - 1) < 1e-9, `p1+p2=${p1+p2}`);
  });

  t.test('eloExpected: monotônico (rA aumenta → P aumenta)', () => {
    const a = eloExpected(1400, 1500);
    const b = eloExpected(1500, 1500);
    const c = eloExpected(1600, 1500);
    t.assert(a < b && b < c, `${a} < ${b} < ${c}`);
  });

  t.test('createEloSystem: defaults aplicados', () => {
    const sys = createEloSystem();
    t.assert(sys != null, 'sistema criado');
    t.assert(typeof sys.rate === 'function', 'tem .rate()');
    t.assert(typeof sys.getRating === 'function', 'tem .getRating()');
    t.assert(typeof sys.getP === 'function', 'tem .getP()');
  });

  t.test('createEloSystem: getRating retorna null para player desconhecido', () => {
    const sys = createEloSystem({ initialRating: 1500 });
    const r = sys.getRating('NeverPlayed');
    t.assert(r === null, `esperado null pra unknown player, got ${JSON.stringify(r)}`);
  });

  t.test('createEloSystem: getP de novos players → 0.5/0.5', () => {
    const sys = createEloSystem({ initialRating: 1500 });
    const r = sys.getP('A', 'B');
    t.assert(Math.abs(r.pA - 0.5) < 1e-9, `pA=${r.pA}`);
    t.assert(Math.abs(r.pB - 0.5) < 1e-9, `pB=${r.pB}`);
  });

  t.test('createEloSystem: rate altera rating em direção ao expected', () => {
    const sys = createEloSystem({ initialRating: 1500, kBase: 32, halfLifeDays: 0 });
    sys.rate('A', 'B'); // A vence
    const a = sys.getRating('A');
    const b = sys.getRating('B');
    t.assert(a.rating > 1500, `A rating=${a.rating} (deve subir)`);
    t.assert(b.rating < 1500, `B rating=${b.rating} (deve cair)`);
    // Soma conservada (zero-sum) — pode ter rounding
    t.assert(Math.abs(a.rating + b.rating - 3000) <= 1, 'soma conservada (±1 rounding)');
  });

  t.test('getP retorna probabilidades complementares', () => {
    const sys = createEloSystem({ initialRating: 1500 });
    sys.rate('A', 'B'); // A vence — A sobe, B desce
    const r = sys.getP('A', 'B');
    t.assert(r.pA > 0.5, `pA=${r.pA} deve > 0.5 após A vencer`);
    t.assert(Math.abs(r.pA + r.pB - 1) < 1e-9, `pA+pB=${r.pA+r.pB}`);
  });

  t.test('findByName: case + accent insensitive', () => {
    const map = new Map();
    map.set('cristian garin', 1500);
    t.assert(findByName(map, 'Cristian Garin') === 1500, 'case');
    t.assert(findByName(map, 'CRISTIAN garin') === 1500, 'upper');
    t.assert(findByName(map, 'inexistente') == null, 'miss');
  });
};

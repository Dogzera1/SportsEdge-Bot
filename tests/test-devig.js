/**
 * Tests for lib/devig — vig removal multiplicativo + power.
 */

const { devigMultiplicative, devigMultiplicativeN, devigPower } = require('../lib/devig');

module.exports = function runTests(t) {
  t.test('multiplicative 2-way: probs somam 1', () => {
    const r = devigMultiplicative('1.80', '2.10');
    t.assert(r != null, 'retornou null');
    const sum = r.p1 + r.p2;
    t.assert(Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
  });

  t.test('multiplicative 2-way: overround positivo (vig real)', () => {
    const r = devigMultiplicative('1.95', '1.95');
    t.assert(r.overround > 1, `overround=${r.overround}`);
    t.assert(Math.abs(r.p1 - 0.5) < 1e-9 && Math.abs(r.p2 - 0.5) < 1e-9, 'simétrico');
  });

  t.test('multiplicative com odd inválido retorna null', () => {
    t.assert(devigMultiplicative('1.0', '2.0') === null, 'odd <=1 deve retornar null');
    t.assert(devigMultiplicative('abc', '2.0') === null, 'odd não-numérico deve retornar null');
    t.assert(devigMultiplicative(null, 2.0) === null, 'null deve retornar null');
  });

  t.test('multiplicativeN 3-way: probs somam 1', () => {
    const r = devigMultiplicativeN(['2.40', '3.20', '3.10']);
    t.assert(r != null, 'retornou null');
    const sum = r.probs.reduce((a, b) => a + b, 0);
    t.assert(Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
    t.assert(r.probs.length === 3, 'probs length');
  });

  t.test('power 2-way: probs somam 1 e k>1 quando overround>1', () => {
    const r = devigPower('1.80', '2.10');
    t.assert(r != null, 'retornou null');
    const sum = r.p1 + r.p2;
    t.assert(Math.abs(sum - 1) < 1e-6, `sum=${sum}`);
    t.assert(r.k > 1, `k=${r.k} (overround>1 deve precisar k>1)`);
  });

  t.test('power 3-way: probs somam 1', () => {
    const r = devigPower(['2.40', '3.20', '3.10']);
    t.assert(r != null);
    const sum = r.probs.reduce((a, b) => a + b, 0);
    t.assert(Math.abs(sum - 1) < 1e-6, `sum=${sum}`);
  });

  t.test('power vs multiplicative: ambos somam 1, podem divergir levemente', () => {
    // Os dois métodos retornam probs válidas mas podem dar valores levemente
    // diferentes no fav (depende se a curva de vig é uniforme ou exponencial).
    // Importante é que ambos somam 1 e estão em [0,1].
    const m = devigMultiplicative('1.20', '5.50');
    const p = devigPower('1.20', '5.50');
    t.assert(Math.abs(m.p1 + m.p2 - 1) < 1e-9, 'multiplicative soma 1');
    t.assert(Math.abs(p.p1 + p.p2 - 1) < 1e-6, 'power soma 1');
    t.assert(p.p1 > 0 && p.p1 < 1, `p_fav=${p.p1} válido`);
  });

  t.test('power com overround=1 retorna k=1', () => {
    // Odds que somam exatamente 1: 1/0.5 + 1/0.5 → 2 → não. Tente 2.0 + 2.0
    // dá 0.5+0.5=1. Sem vig.
    const r = devigPower('2.00', '2.00');
    t.assert(Math.abs(r.k - 1) < 1e-6, `k=${r.k}`);
    t.assert(Math.abs(r.p1 - 0.5) < 1e-9, 'p1=0.5');
  });
};

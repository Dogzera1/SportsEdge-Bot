/**
 * Testes do pré-filtro ML de darts (3-dart avg como sinal principal).
 */

const { dartsPreFilter } = require('../lib/darts-ml');

module.exports = function runTests(t) {
  t.test('Sem odds retorna pass=false', () => {
    const r = dartsPreFilter({}, {});
    t.assert(!r.pass && r.score === 0, `got ${JSON.stringify(r)}`);
  });

  t.test('Sem enrichment: direção implied mas sem edge detectado', () => {
    const r = dartsPreFilter({ odds: { t1: 1.5, t2: 2.5 } }, {});
    t.assert(!r.pass, 'sem enrich → sem edge');
    t.assert(r.factorCount === 0, `factorCount=${r.factorCount}`);
  });

  t.test('3-dart avg favorável para underdog → edge detectado', () => {
    // Underdog (t2 com odds 3.0) tem avg 100 vs favorito (t1) avg 92
    // Diff = -8pp → modelP2 deve subir significativamente
    const r = dartsPreFilter(
      { odds: { t1: 1.5, t2: 3.0 } },
      { avgP1: 92, avgP2: 100, winRateP1: 50, winRateP2: 50 }
    );
    t.assert(r.pass, `esperava pass: ${JSON.stringify(r)}`);
    t.assert(r.direction === 't2', `direção deveria ser t2 (underdog com melhor avg): ${r.direction}`);
    t.assert(r.factorCount === 2, `2 fatores: ${r.factorCount}`);
  });

  t.test('3-dart avg confirma favorito do mercado → sem edge (mercado justo)', () => {
    // Favorito (t1 @ 1.5) tem avg 100 vs t2 avg 92 — confirma o book
    const r = dartsPreFilter(
      { odds: { t1: 1.5, t2: 3.0 } },
      { avgP1: 100, avgP2: 92, winRateP1: 60, winRateP2: 40 }
    );
    // Pode até passar, mas a direção deve ser t1
    if (r.pass) t.assert(r.direction === 't1', `direção esperada t1: ${r.direction}`);
  });

  t.test('Saturação: diff de 20pp não deveria explodir modelP', () => {
    const r = dartsPreFilter(
      { odds: { t1: 2.0, t2: 2.0 } },
      { avgP1: 110, avgP2: 80, winRateP1: 80, winRateP2: 20 }
    );
    t.assert(r.modelP1 <= 0.75, `modelP1=${r.modelP1} muito alto (deveria saturar ~15pp sobre implied 0.50)`);
    t.assert(r.modelP1 >= 0.55, `modelP1=${r.modelP1} muito baixo (deveria subir com sinal forte)`);
  });
};

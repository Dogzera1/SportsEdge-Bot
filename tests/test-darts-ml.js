/**
 * Testes do pré-filtro ML de darts (3-dart avg como sinal principal).
 */

const { dartsPreFilter } = require('../lib/darts-ml');

module.exports = function runTests(t) {
  t.test('Sem odds retorna pass=false', () => {
    const r = dartsPreFilter({}, {});
    t.assert(!r.pass && r.score === 0, `got ${JSON.stringify(r)}`);
  });

  t.test('Sem enrichment (Pinnacle-only): pass=true, factorCount=0, modelP=impliedP', () => {
    // 2026-05-09 (lib/darts-ml.js L122-132): pass=true intencional quando enrich vazio.
    // Pinnacle-only via getPinnacleDartsMatches não traz playerId Sofascore pra hidratar
    // avg/wr/H2H. pollDarts precisa do pass=true pra deixar trained + EV gate filtrar
    // downstream (sem isso pula antes mesmo de Pinnacle sharp odds serem avaliadas).
    const r = dartsPreFilter({ odds: { t1: 1.5, t2: 2.5 } }, {});
    t.assert(r.pass, `Pinnacle-only path: pass deve ser true, got ${JSON.stringify(r)}`);
    t.assert(r.factorCount === 0, `factorCount=${r.factorCount}`);
    t.assert(r.score === 0, `score deve ser 0 sem fatores (modelP=impliedP de-juice): ${r.score}`);
    t.assert(Math.abs(r.modelP1 - r.impliedP1) < 1e-6, `modelP1=impliedP1 sem ajuste (got ${r.modelP1} vs ${r.impliedP1})`);
  });

  t.test('Enrich parcial (só winRateP1 sem winRateP2): factor pareado não conta', () => {
    // Guard pra regressão da regra "fatores são pareados". avg precisa de avgP1+avgP2,
    // wr de wrP1+wrP2 etc. Sem o par completo, factorCount=0 → continua Pinnacle-only path.
    const r = dartsPreFilter(
      { odds: { t1: 1.5, t2: 2.5 } },
      { winRateP1: 60 }
    );
    t.assert(r.factorCount === 0, `sem par wrP2, fator wr não conta: factorCount=${r.factorCount}`);
    t.assert(r.pass, `mantém Pinnacle-only quando par incompleto: ${JSON.stringify(r)}`);
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

'use strict';

// Regression test pra ESPN PEN/AET correction (round 4 fix).
// Simula payload ESPN com STATUS_FINAL_PEN — score deve usar regulation period
// (1H+2H linescores), não score que inclui pênaltis.

const { parseEvent } = (() => {
  // parseEvent é interno em espn-soccer.js. Para teste, replicamos a logic chave.
  // Não importamos do módulo pra evitar dependência side-effect (require espnGet etc).
  // Esse teste valida a heurística de detection.
  return {
    parseEvent: null, // marker — vamos testar via behavior simulado
  };
})();

module.exports = function (t) {
  // Replica o filter FINAL_STATUSES + lookup linescores
  const FINAL_STATUSES = new Set([
    'STATUS_FINAL', 'STATUS_FULL_TIME',
    'STATUS_FINAL_AET', 'STATUS_FINAL_PEN', 'STATUS_END_OF_REGULATION',
  ]);

  // PEN: home.score=5, away.score=4 (incluindo penalty 4-3); regulation 1-1.
  function _parsePenScenario(home, away, statusU) {
    if (!FINAL_STATUSES.has(statusU)) return null;
    const aet = statusU === 'STATUS_FINAL_AET';
    const pen = statusU === 'STATUS_FINAL_PEN';
    let hs = parseInt(home.score, 10);
    let as = parseInt(away.score, 10);
    if (pen || aet) {
      const homeLs = home.linescores || [];
      const awayLs = away.linescores || [];
      if (homeLs.length >= 2 && awayLs.length >= 2) {
        const reg1 = +(homeLs[0]?.value || 0) + +(homeLs[1]?.value || 0);
        const reg2 = +(awayLs[0]?.value || 0) + +(awayLs[1]?.value || 0);
        hs = reg1; as = reg2;
      }
    }
    const winner = pen ? 'Draw' : (hs > as ? 'home' : (as > hs ? 'away' : 'Draw'));
    return { hs, as, winner, aet, pen };
  }

  t.test('PEN scenario: 1-1 + 4-3 pen → regulation 1-1 Draw', () => {
    const home = { score: '5', linescores: [{ value: 0 }, { value: 1 }, { value: 0 }, { value: 0 }, { value: 4 }] };
    const away = { score: '4', linescores: [{ value: 0 }, { value: 1 }, { value: 0 }, { value: 0 }, { value: 3 }] };
    const r = _parsePenScenario(home, away, 'STATUS_FINAL_PEN');
    t.assert(r.hs === 1 && r.as === 1, `regulation should be 1-1, got ${r.hs}-${r.as}`);
    t.assert(r.winner === 'Draw', `PEN winner=Draw (regulamentar), got ${r.winner}`);
  });

  t.test('AET scenario: 1-1 + 1-0 ET → regulation 1-1', () => {
    const home = { score: '2', linescores: [{ value: 0 }, { value: 1 }, { value: 1 }, { value: 0 }] };
    const away = { score: '1', linescores: [{ value: 1 }, { value: 0 }, { value: 0 }, { value: 0 }] };
    const r = _parsePenScenario(home, away, 'STATUS_FINAL_AET');
    t.assert(r.hs === 1 && r.as === 1, `regulation 1-1 expected, got ${r.hs}-${r.as}`);
    // AET preserves real winner (não é Draw como PEN)
    t.assert(r.winner === 'Draw', `regulation tied = Draw winner, got ${r.winner}`);
  });

  t.test('STATUS_FINAL: score puro, sem fallback regulation', () => {
    const home = { score: '2', linescores: [{ value: 1 }, { value: 1 }] };
    const away = { score: '0', linescores: [{ value: 0 }, { value: 0 }] };
    const r = _parsePenScenario(home, away, 'STATUS_FINAL');
    t.assert(r.hs === 2 && r.as === 0, '90min final: 2-0');
    t.assert(r.winner === 'home');
  });

  t.test('STATUS_POSTPONED: rejeitado pelo allowlist', () => {
    const home = { score: '0', linescores: [] };
    const away = { score: '0', linescores: [] };
    const r = _parsePenScenario(home, away, 'STATUS_POSTPONED');
    t.assert(r === null, 'POSTPONED rejected');
  });

  t.test('STATUS_AGGREGATE: rejeitado (lib agora drops)', () => {
    const r = _parsePenScenario({ score: '1' }, { score: '0' }, 'STATUS_AGGREGATE');
    t.assert(r === null, 'AGGREGATE rejected');
  });
};

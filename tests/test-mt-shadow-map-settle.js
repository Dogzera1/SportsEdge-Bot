/**
 * Property test settleMapWinnerFromSweep — pega MAP-settle bug class.
 *
 * Bug class (memory project_map_settle_bug_2026_05_13): 26 tips ML voided em
 * 2026-05-13 porque server.js settlava ML map-specific (`match_id` sufixado
 * `_MAP{N}`) pelo series winner mesmo em séries non-sweep (Bo3 2-1 / Bo5 3-1).
 * Fix B+C (commit 075df26) introduziu guard via `settleMapWinnerFromSweep`.
 *
 * Este test trava o contrato dessa função; quem mexer na semântica quebra aqui
 * antes de chegar em prod.
 *
 * Invariantes:
 *   1. Non-sweep (Bo3 2-1 / Bo5 3-1 / Bo5 3-2 / Bo7 4-x onde x>0) → result=null
 *   2. Sweep + mapN > winnerMaps → result='void' (map_not_played)
 *   3. Sweep + mapN ≤ winnerMaps + pickIsSeriesWinner=true → result='win'
 *   4. Sweep + mapN ≤ winnerMaps + pickIsSeriesWinner=false → result='loss'
 *   5. mapN inválido (<1, NaN, non-numeric) → result=null
 *   6. Score impossível ("Bo3 40-27" kills dump OpenDota) → result=null
 *   7. Shape: sempre retorna `{ result, reason }`; null result tem reason string
 */

const fc = require('fast-check');
const { settleMapWinnerFromSweep } = require('../lib/market-tips-shadow');

// Sweep válido: Bo1/3/5/7, winner leva todos os mapas.
// Ex: "Bo3 2-0", "Bo5 3-0", "Bo7 4-0" + ordem invertida ("Bo3 0-2" etc).
const sweepScore = fc.constantFrom(1, 3, 5, 7).chain(bestOf => {
  const winnerMaps = Math.ceil(bestOf / 2);
  return fc.boolean().map(winnerFirst => ({
    bestOf,
    winnerMaps,
    score: winnerFirst ? `Bo${bestOf} ${winnerMaps}-0` : `Bo${bestOf} 0-${winnerMaps}`
  }));
});

// Non-sweep válido: Bo3 2-1, Bo5 3-1, Bo5 3-2, Bo7 4-1/4-2/4-3.
const nonSweepScore = fc.constantFrom(3, 5, 7).chain(bestOf => {
  const winnerMaps = Math.ceil(bestOf / 2);
  return fc.integer({ min: 1, max: winnerMaps - 1 }).chain(loserMaps =>
    fc.boolean().map(winnerFirst => ({
      bestOf,
      winnerMaps,
      loserMaps,
      score: winnerFirst
        ? `Bo${bestOf} ${winnerMaps}-${loserMaps}`
        : `Bo${bestOf} ${loserMaps}-${winnerMaps}`
    }))
  );
});

// Sweep + mapN dentro do range jogado (≤ winnerMaps).
const sweepWithValidMapN = sweepScore.chain(s =>
  fc.integer({ min: 1, max: s.winnerMaps }).map(mapN => ({ ...s, mapN }))
);

// Sweep + mapN ALÉM do que foi jogado.
const sweepWithOversizedMapN = sweepScore.chain(s =>
  fc.integer({ min: 1, max: 3 }).map(off => ({ ...s, mapN: s.winnerMaps + off }))
);

module.exports = function runTests(t) {
  // ─── INVARIANTE 1: non-sweep nunca settla via series winner ─────────────
  t.test('non-sweep MAP returns result=null (the bug class)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        nonSweepScore,
        fc.boolean(),
        (mapN, info, pick) => {
          const r = settleMapWinnerFromSweep(mapN, info.score, pick);
          if (r.result !== null) {
            throw new Error(
              `non-sweep "${info.score}" mapN=${mapN} pick=${pick} → expected null, got ${JSON.stringify(r)}`
            );
          }
          if (typeof r.reason !== 'string' || r.reason.length === 0) {
            throw new Error(`null result missing reason: ${JSON.stringify(r)}`);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  // ─── INVARIANTE 2: sweep + mapN > winnerMaps → void ─────────────────────
  t.test('sweep with mapN beyond winnerMaps returns void', () => {
    fc.assert(
      fc.property(sweepWithOversizedMapN, fc.boolean(), (info, pick) => {
        const r = settleMapWinnerFromSweep(info.mapN, info.score, pick);
        if (r.result !== 'void') {
          throw new Error(
            `sweep "${info.score}" mapN=${info.mapN}>winnerMaps=${info.winnerMaps} → expected void, got ${JSON.stringify(r)}`
          );
        }
      }),
      { numRuns: 200 }
    );
  });

  // ─── INVARIANTE 3: sweep + valid mapN + pick=winner → win ───────────────
  t.test('sweep with valid mapN + pickIsSeriesWinner=true returns win', () => {
    fc.assert(
      fc.property(sweepWithValidMapN, info => {
        const r = settleMapWinnerFromSweep(info.mapN, info.score, true);
        if (r.result !== 'win') {
          throw new Error(
            `sweep "${info.score}" mapN=${info.mapN} pick=true → expected win, got ${JSON.stringify(r)}`
          );
        }
      }),
      { numRuns: 200 }
    );
  });

  // ─── INVARIANTE 4: sweep + valid mapN + pick=loser → loss ───────────────
  t.test('sweep with valid mapN + pickIsSeriesWinner=false returns loss', () => {
    fc.assert(
      fc.property(sweepWithValidMapN, info => {
        const r = settleMapWinnerFromSweep(info.mapN, info.score, false);
        if (r.result !== 'loss') {
          throw new Error(
            `sweep "${info.score}" mapN=${info.mapN} pick=false → expected loss, got ${JSON.stringify(r)}`
          );
        }
      }),
      { numRuns: 200 }
    );
  });

  // ─── INVARIANTE 5: mapN inválido → null ─────────────────────────────────
  t.test('invalid mapN returns null', () => {
    const badMapN = fc.oneof(
      fc.integer({ max: 0 }),
      fc.constant(NaN),
      fc.constant(null),
      fc.constant(undefined),
      fc.constant('abc'),
      fc.constant({}),
      fc.constant([])
    );
    fc.assert(
      fc.property(badMapN, sweepScore, fc.boolean(), (mapN, info, pick) => {
        const r = settleMapWinnerFromSweep(mapN, info.score, pick);
        if (r.result !== null) {
          throw new Error(
            `bad mapN=${JSON.stringify(mapN)} "${info.score}" → expected null, got ${JSON.stringify(r)}`
          );
        }
      }),
      { numRuns: 100 }
    );
  });

  // ─── INVARIANTE 6: score impossível → null ──────────────────────────────
  t.test('unparseable / malformed score returns null', () => {
    const badScore = fc.oneof(
      fc.constant(''),
      fc.constant(null),
      fc.constant(undefined),
      fc.constant('garbage'),
      fc.constant('Bo3'),
      fc.constant('---'),
      fc.constant('xx-yy'),
      fc.constant(' ')
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), badScore, fc.boolean(), (mapN, score, pick) => {
        const r = settleMapWinnerFromSweep(mapN, score, pick);
        if (r.result !== null) {
          throw new Error(
            `bad score=${JSON.stringify(score)} mapN=${mapN} → expected null, got ${JSON.stringify(r)}`
          );
        }
      }),
      { numRuns: 80 }
    );
  });

  // ─── INVARIANTE 6b: OpenDota kills dump regression ──────────────────────
  t.test('OpenDota kills pattern (Bo3 40-27) returns null', () => {
    // Source bug: OpenDota populava final_score com RADIANT_SCORE-DIRE_SCORE
    // (kills) em vez de maps. Row tipo "Bo3 40-27" deve ser rejeitado pelo
    // validador _parseEsportsMapScore (max=ceil(N/2)).
    const kills = ['Bo3 40-27', 'Bo3 35-22', 'Bo5 60-45', 'Bo3 25-12', 'Bo5 80-50', 'Bo1 12-8'];
    for (const score of kills) {
      const r = settleMapWinnerFromSweep(1, score, true);
      if (r.result !== null) {
        throw new Error(`kills pattern "${score}" → expected null, got ${JSON.stringify(r)}`);
      }
    }
  });

  // ─── INVARIANTE 7: shape contract { result, reason } ────────────────────
  t.test('always returns { result, reason } shape (never throws)', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), fc.anything(), (a, b, c) => {
        let r;
        try {
          r = settleMapWinnerFromSweep(a, b, c);
        } catch (e) {
          throw new Error(`unexpected throw on (${JSON.stringify(a)}, ${JSON.stringify(b)}, ${JSON.stringify(c)}): ${e.message}`);
        }
        if (!r || typeof r !== 'object') {
          throw new Error(`expected object, got ${typeof r}`);
        }
        if (!('result' in r) || !('reason' in r)) {
          throw new Error(`missing result/reason: ${JSON.stringify(r)}`);
        }
        if (r.result !== null && r.result !== 'win' && r.result !== 'loss' && r.result !== 'void') {
          throw new Error(`invalid result value: ${JSON.stringify(r.result)}`);
        }
        if (r.result === null && typeof r.reason !== 'string') {
          throw new Error(`null result needs string reason: ${JSON.stringify(r)}`);
        }
      }),
      { numRuns: 300 }
    );
  });

  // ─── Anchors regressivos: casos exatos do bug ───────────────────────────
  t.test('anchor: Bo3 2-1 mapN=1 returns null (exact bug class)', () => {
    const r = settleMapWinnerFromSweep(1, 'Bo3 2-1', true);
    t.assert(r.result === null, `Bo3 2-1 MAP1: expected null, got ${JSON.stringify(r)}`);
    t.assert(/non_sweep/.test(r.reason || ''), `expected non_sweep reason, got "${r.reason}"`);
  });

  t.test('anchor: Bo5 3-1 mapN=1 returns null (memory bug regression)', () => {
    // Memory project_map_settle_bug_2026_05_13: "Tips ML com match_id sufixado
    // _MAP{N} settled errado pelo series winner em non-sweep (Bo5 3-1)"
    const r = settleMapWinnerFromSweep(1, 'Bo5 3-1', true);
    t.assert(r.result === null, `Bo5 3-1 MAP1 must be null (not win-from-series), got ${JSON.stringify(r)}`);
  });

  t.test('anchor: Bo3 2-0 mapN=1 pick=winner returns win', () => {
    const r = settleMapWinnerFromSweep(1, 'Bo3 2-0', true);
    t.assert(r.result === 'win', `expected win, got ${JSON.stringify(r)}`);
    t.assert(/sweep/.test(r.reason || ''), `expected sweep reason, got "${r.reason}"`);
  });

  t.test('anchor: Bo3 2-0 mapN=3 returns void (map_not_played)', () => {
    const r = settleMapWinnerFromSweep(3, 'Bo3 2-0', true);
    t.assert(r.result === 'void', `expected void, got ${JSON.stringify(r)}`);
    t.assert(/map_not_played/.test(r.reason || ''), `expected map_not_played, got "${r.reason}"`);
  });

  t.test('anchor: Bo5 3-0 mapN=2 pick=loser returns loss', () => {
    const r = settleMapWinnerFromSweep(2, 'Bo5 3-0', false);
    t.assert(r.result === 'loss', `expected loss, got ${JSON.stringify(r)}`);
  });
};

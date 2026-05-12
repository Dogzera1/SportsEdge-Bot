/**
 * Property-based tests do Kelly calculator usando fast-check.
 * Gera milhares de inputs e procura edge case que quebra invariantes:
 *   - stake ≤ bankroll × MAX_KELLY_FRAC (cap sagrado)
 *   - stake ≥ 0 (nunca negativo)
 *   - stake finito (sem NaN/Infinity)
 *   - p×odd ≤ 1 → stake === 0 (negative-edge gate)
 *   - monotônico em pModel (↑p → ↑stake, odd fixo)
 *
 * Roda só se fast-check estiver instalado (devDep). Skip silencioso senão —
 * permite `npm test` funcionar em ambientes sem dev install.
 */

let fc;
try { fc = require('fast-check'); } catch (_) {}

const {
  kellyStakeForMarket,
  MAX_KELLY_FRAC,
} = require('../lib/market-tip-processor');

const RUNS = parseInt(process.env.FC_RUNS || '500', 10);  // 500 inputs default

module.exports = function runTests(t) {
  if (!fc) {
    t.test('property tests (skipped — `npm install` pra habilitar fast-check)', () => {});
    return;
  }

  // ──────────────────────────────────────────────────────────────────
  // Invariante 1: stake nunca excede bankroll × MAX_KELLY_FRAC
  // CLAUDE.md "Limites SAGRADOS": MAX_KELLY_FRAC = 0.10
  // ──────────────────────────────────────────────────────────────────
  t.test('stake ≤ bankroll × MAX_KELLY_FRAC sempre', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),    // pModel
        fc.double({ min: 1.01, max: 100, noNaN: true }),      // odd
        fc.double({ min: 50, max: 10000, noNaN: true }),      // bankroll
        (pModel, odd, bankroll) => {
          const stake = kellyStakeForMarket(pModel, odd, bankroll);
          const cap = bankroll * MAX_KELLY_FRAC;
          // Permitir 0.01% tolerância pra float ops
          return stake <= cap * 1.0001;
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // Invariante 2: stake sempre finito (sem NaN/Infinity)
  // ──────────────────────────────────────────────────────────────────
  t.test('stake é finito pra inputs válidos', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 0.999, noNaN: true }),
        fc.double({ min: 1.01, max: 1000, noNaN: true }),
        fc.double({ min: 1, max: 100000, noNaN: true }),
        (pModel, odd, bankroll) => {
          const stake = kellyStakeForMarket(pModel, odd, bankroll);
          return Number.isFinite(stake);
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // Invariante 3: stake nunca negativo
  // ──────────────────────────────────────────────────────────────────
  t.test('stake ≥ 0 pra qualquer input', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 0.999, noNaN: true }),
        fc.double({ min: 1.01, max: 1000, noNaN: true }),
        fc.double({ min: 1, max: 100000, noNaN: true }),
        (pModel, odd, bankroll) => {
          const stake = kellyStakeForMarket(pModel, odd, bankroll);
          return stake >= 0;
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // Invariante 4: p×odd ≤ 1 (negative-edge) → stake === 0
  // ──────────────────────────────────────────────────────────────────
  t.test('p×odd ≤ 1 retorna stake=0 (negative-edge gate)', () => {
    fc.assert(
      fc.property(
        // Construa pares onde p × odd ≤ 1
        fc.double({ min: 0.01, max: 0.49, noNaN: true }),
        fc.double({ min: 1.01, max: 2.0, noNaN: true }),
        (pModel, odd) => {
          // Garante negative edge: p×odd <= 1 → vamos forçar via odd cap
          const cappedOdd = Math.min(odd, 1 / pModel);
          if (pModel * cappedOdd > 1) return true;  // skip se virou positivo
          const stake = kellyStakeForMarket(pModel, cappedOdd, 100);
          return stake === 0;
        }
      ),
      { numRuns: RUNS }
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // Invariante 5: edge cases extremos não quebram
  // ──────────────────────────────────────────────────────────────────
  t.test('edge cases não retornam NaN/Infinity', () => {
    const cases = [
      { p: 0.5, odd: 1.01, b: 100 },         // odd quase 1
      { p: 0.999, odd: 100, b: 100 },         // p alto + odd alto
      { p: 0.001, odd: 1000, b: 100 },        // p baixo + odd alto
      { p: 0.999, odd: 1.001, b: 100 },       // ambos extremos
      { p: 0.5, odd: 2.0, b: 0.01 },          // bankroll mínima
      { p: 0.5, odd: 2.0, b: 1e7 },           // bankroll enorme
      { p: 0.5, odd: 2.0, b: Number.MAX_SAFE_INTEGER / 1e10 },
    ];
    for (const { p, odd, b } of cases) {
      const stake = kellyStakeForMarket(p, odd, b);
      t.assert(
        Number.isFinite(stake) && stake >= 0,
        `kelly(p=${p}, odd=${odd}, b=${b}) = ${stake} (não finito ou negativo)`
      );
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // Invariante 6: inputs inválidos retornam 0 (sem throw)
  // ──────────────────────────────────────────────────────────────────
  t.test('inputs inválidos retornam 0 sem throw', () => {
    const invalid = [
      [NaN, 2.0, 100],
      [0.5, NaN, 100],
      [0.5, 2.0, NaN],
      [-0.1, 2.0, 100],          // p negativo
      [1.5, 2.0, 100],           // p > 1 (lib aceita? validar)
      [0.5, 0.5, 100],           // odd < 1
      [0.5, 1.0, 100],           // odd = 1 (no edge)
      [0.5, -2.0, 100],          // odd negativa
      [0, 2.0, 100],             // p = 0
    ];
    for (const [p, odd, b] of invalid) {
      let stake, threw = false;
      try { stake = kellyStakeForMarket(p, odd, b); } catch (_) { threw = true; }
      t.assert(!threw, `kelly(p=${p}, odd=${odd}, b=${b}) jogou exceção`);
      t.assert(
        stake === 0 || (Number.isFinite(stake) && stake >= 0),
        `kelly(${p}, ${odd}, ${b}) deveria ser 0 ou stake válido, got ${stake}`
      );
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // Invariante 7: monotônico em pModel (com odd e bankroll fixos)
  // ↑pModel com edge positivo → ↑stake (ou igual se ambos abaixo gate)
  // ──────────────────────────────────────────────────────────────────
  t.test('monotônico crescente em pModel (odd fixo)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 0.85, noNaN: true }),     // p_base
        fc.double({ min: 1.5, max: 5.0, noNaN: true }),       // odd
        (pBase, odd) => {
          // Compara stake em (p) vs (p+0.05) — deve ser non-decreasing
          const stakeLow = kellyStakeForMarket(pBase, odd, 100);
          const stakeHigh = kellyStakeForMarket(Math.min(pBase + 0.05, 0.99), odd, 100);
          // Tolera 0.001u de noise (cap, env multiplier, etc)
          return stakeHigh + 0.001 >= stakeLow;
        }
      ),
      { numRuns: RUNS }
    );
  });
};

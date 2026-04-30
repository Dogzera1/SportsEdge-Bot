/**
 * Tests for tip_context_json shape — não testa o servidor real, mas valida
 * que a serialização que /record-tip faz é bem formada e cap em 4KB.
 *
 * Replica a lógica de server.js _tipContextJson construction pra garantir
 * shape consistente (mudanças futuras não devem quebrar callers).
 */

function _buildTipContext(t) {
  // Mirror exato de server.js:13994 (commit f7b7fcd)
  const ctx = {};
  if (t.factors) ctx.factors = t.factors;
  if (t.mlScore != null) ctx.ml_score = t.mlScore;
  if (t.factorCount != null) ctx.factor_count = t.factorCount;
  if (t.trainedConf != null) ctx.trained_conf = t.trainedConf;
  if (t.divergencePp != null) ctx.divergence_pp = t.divergencePp;
  if (t.lineShopOdds && typeof t.lineShopOdds === 'object') {
    const ls = t.lineShopOdds;
    ctx.line_shop = {
      best_book: ls.bestBook, best_odd: ls.bestOdd,
      pinnacle_odd: ls.pinnacleOdd, delta_pct: ls.deltaPct,
    };
  }
  if (t.pickSide) ctx.pick_side = t.pickSide;
  if (t.kellyFrac != null) ctx.kelly_frac = t.kellyFrac;
  if (t.stakeAdjust != null) ctx.stake_adjust = t.stakeAdjust;
  if (t.preMatchBonus != null) ctx.pre_match_bonus = t.preMatchBonus;
  if (Object.keys(ctx).length > 0) {
    return JSON.stringify(ctx).slice(0, 4000);
  }
  return null;
}

module.exports = function runTests(t) {
  t.test('payload vazio retorna null', () => {
    t.assert(_buildTipContext({}) === null);
  });

  t.test('factors preservado', () => {
    const r = _buildTipContext({ factors: [{ label: 'Elo', value: '1500/1450' }] });
    const parsed = JSON.parse(r);
    t.assert(parsed.factors.length === 1);
    t.assert(parsed.factors[0].label === 'Elo');
  });

  t.test('mlScore numérico', () => {
    const r = _buildTipContext({ mlScore: 8.42 });
    const parsed = JSON.parse(r);
    t.assert(parsed.ml_score === 8.42);
  });

  t.test('mlScore=0 não é dropado (truthy check correto)', () => {
    // Bug comum: usar truthy check em vez de != null. mlScore=0 é válido.
    const r = _buildTipContext({ mlScore: 0 });
    t.assert(r != null, 'ml_score=0 deve ser preservado');
    const parsed = JSON.parse(r);
    t.assert(parsed.ml_score === 0);
  });

  t.test('lineShopOdds reduzido pra resumo (não array completo)', () => {
    const r = _buildTipContext({
      lineShopOdds: {
        bestBook: 'pinnacle', bestOdd: 1.95, pinnacleOdd: 1.95, deltaPct: 0,
        // Campos a mais que NÃO devem ser preservados (raw é grande)
        rawList: Array.from({ length: 100 }, (_, i) => ({ book: `b${i}`, odd: 2.0 })),
      },
    });
    const parsed = JSON.parse(r);
    t.assert(parsed.line_shop != null, 'line_shop preservado');
    t.assert(!parsed.line_shop.rawList, 'rawList NÃO deve estar no snapshot');
    t.assert(parsed.line_shop.best_book === 'pinnacle');
  });

  t.test('cap 4KB hard', () => {
    // Payload grande propositalmente
    const r = _buildTipContext({
      factors: Array.from({ length: 1000 }, (_, i) => ({
        label: `LongLabel${i}`,
        value: `LongValueWithLotsOfData${i}_x`.repeat(20),
      })),
    });
    t.assert(r.length <= 4000, `len=${r.length}`);
  });

  t.test('campos null/undefined ignorados', () => {
    const r = _buildTipContext({
      factors: null,
      mlScore: undefined,
      kellyFrac: 0.10, // este sim
    });
    const parsed = JSON.parse(r);
    t.assert(!('factors' in parsed));
    t.assert(!('ml_score' in parsed));
    t.assert(parsed.kelly_frac === 0.10);
  });

  t.test('shape estável (chaves snake_case)', () => {
    const r = _buildTipContext({
      mlScore: 1, factorCount: 2, divergencePp: 3,
      preMatchBonus: 4, kellyFrac: 5, stakeAdjust: 6,
    });
    const parsed = JSON.parse(r);
    // Todas chaves devem ser snake_case
    for (const key of Object.keys(parsed)) {
      t.assert(/^[a-z_]+$/.test(key), `chave não-snake_case: ${key}`);
    }
  });
};

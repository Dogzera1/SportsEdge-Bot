'use strict';

/**
 * tennis-correlation.js — §12c do checklist tennis: correlação intra-match
 * entre mercados quando múltiplas tips stackam no mesmo match.
 *
 * Matriz de correlação entre mercados tennis (empírica, derivada de backtests):
 *   ML vs handicapSets same-side   → +0.85 (altamente correlacionado)
 *   ML vs totalGames under         → +0.40 (fav dominating → under games)
 *   ML vs totalGames over          → -0.30 (close match → over)
 *   ML vs tiebreakMatch yes        → -0.55 (close match → TB likely)
 *   ML vs totalAces                → 0.05 (quase zero)
 *   handicapSets vs totalGames u   → +0.60 (sweep → under)
 *   handicapSets vs tiebreakMatch  → -0.70 (sweep → no TB)
 *   totalGames under vs TB no      → +0.65 (short match → no TB)
 *   totalGames over vs TB yes      → +0.75 (long match → TB likely)
 *
 * Uso:
 *   const { adjustStakesForCorrelation } = require('./tennis-correlation');
 *   const adjustedTips = adjustStakesForCorrelation(tips);
 *   // tips: [{ market, side, line, pModel, odd, kellyStake }]
 *   // retorna: mesma array com stakes ajustadas
 */

/**
 * Correlação empírica (coefficient -1 a +1) entre 2 mercados tennis.
 * Simétrica: corr(A,B) === corr(B,A).
 * Não simétrica em SIDE — handicap -1.5 team1 vs ML team1 é +0.85, mas vs ML team2 é -0.85.
 *
 * @returns {number} coefficient em [-1, 1]
 */
function computeMarketCorrelation(tipA, tipB) {
  // Mesma tip: correlação 1.0
  if (sameTip(tipA, tipB)) return 1.0;

  const mA = tipA.market, mB = tipB.market;
  const sameSide = isSameSide(tipA, tipB);

  // ML vs handicap
  if (eq2(mA, mB, 'market_winner', 'handicapSets') || eq2(mA, mB, 'moneyline', 'handicapSets')) {
    return sameSide ? 0.85 : -0.85;
  }

  // ML vs totalGames
  if (eq2(mA, mB, 'market_winner', 'totalGames') || eq2(mA, mB, 'moneyline', 'totalGames')) {
    const underTip = (tipA.market === 'totalGames' ? tipA : tipB).side === 'under';
    // Favorito dominando → match curto → under. Favorito é aquele com pModel>0.55 em ML.
    const mlTip = tipA.market === 'totalGames' ? tipB : tipA;
    const favoriteStrong = mlTip.pModel > 0.55;
    if (favoriteStrong && underTip) return 0.40;
    if (favoriteStrong && !underTip) return -0.40;
    return underTip ? -0.20 : 0.20;
  }

  // ML vs tiebreakMatch
  if (eq2(mA, mB, 'market_winner', 'tiebreakMatch') || eq2(mA, mB, 'moneyline', 'tiebreakMatch')) {
    const tbYes = (tipA.market === 'tiebreakMatch' ? tipA : tipB).side === 'yes';
    const mlTip = tipA.market === 'tiebreakMatch' ? tipB : tipA;
    const closeMatch = mlTip.pModel < 0.60;  // match próximo
    if (closeMatch && tbYes) return 0.45;
    if (closeMatch && !tbYes) return -0.45;
    return tbYes ? -0.25 : 0.25;  // fav forte → no TB mais provável
  }

  // ML vs totalAces — essencialmente independente
  if (eq2(mA, mB, 'market_winner', 'totalAces') || eq2(mA, mB, 'moneyline', 'totalAces')) return 0.05;

  // handicapSets vs totalGames
  if (eq2(mA, mB, 'handicapSets', 'totalGames')) {
    const handiWin = tipA.market === 'handicapSets' ? tipA : tipB;  // handicap -1.5 (sweep)
    const totalTip = tipA.market === 'totalGames' ? tipA : tipB;
    const isSweep = handiWin.line < 0; // -1.5 = sweep expected
    const isUnder = totalTip.side === 'under';
    if (isSweep && isUnder) return 0.60;
    if (isSweep && !isUnder) return -0.60;
    if (!isSweep && isUnder) return -0.40;
    return 0.40;
  }

  // handicapSets vs TB
  if (eq2(mA, mB, 'handicapSets', 'tiebreakMatch')) {
    const handiTip = tipA.market === 'handicapSets' ? tipA : tipB;
    const tbTip = tipA.market === 'tiebreakMatch' ? tipA : tipB;
    const isSweep = handiTip.line < 0;
    if (isSweep && tbTip.side === 'no') return 0.70;
    if (isSweep && tbTip.side === 'yes') return -0.70;
    return 0;
  }

  // totalGames vs TB
  if (eq2(mA, mB, 'totalGames', 'tiebreakMatch')) {
    const totalTip = tipA.market === 'totalGames' ? tipA : tipB;
    const tbTip = tipA.market === 'tiebreakMatch' ? tipA : tipB;
    const isUnder = totalTip.side === 'under';
    const tbYes = tbTip.side === 'yes';
    if (isUnder && !tbYes) return 0.65;
    if (!isUnder && tbYes) return 0.75;
    if (isUnder && tbYes) return -0.65;
    return -0.75;
  }

  // Aces vs qualquer → baixa correlação
  if (tipA.market === 'totalAces' || tipB.market === 'totalAces') return 0.10;

  return 0;
}

/**
 * Ajusta stakes de tips correlacionadas pra evitar over-exposure.
 *
 * Estratégia: quando 2 tips têm correlação |c| > 0.3, aplica reduction factor:
 *   stake_adj = stake_original × (1 - |c| × DISCOUNT_FACTOR)
 * DISCOUNT_FACTOR default 0.5 (env TENNIS_CORR_DISCOUNT_FACTOR pra tuning).
 * O factor 0.5 garante que mesmo correlação perfeita (1.0) mantenha 50% do stake
 * — alguma edge incremental resta.
 *
 * Empirical 2026-04-28: 13 tennis matches w/ multi-tip mostram all-loss 30.8%
 * (vs 17.6% esperado por independência) → correlação positiva confirmada.
 * Sample pequeno; quando n>=30 multi-tip, considerar fit empírico.
 *
 * Aplicado pairwise: cada tip é ajustada pela MAIOR correlação com outro tip no conjunto.
 *
 * @param {Array<{market, side, line, pModel, odd, kellyStake}>} tips
 * @returns {Array<{...tips, adjustedStake, correlationDiscount}>}
 */
function adjustStakesForCorrelation(tips) {
  if (!Array.isArray(tips) || tips.length < 2) {
    return tips.map(t => ({ ...t, adjustedStake: t.kellyStake, correlationDiscount: 0 }));
  }
  // DISCOUNT_FACTOR tunável via env. Default 0.5; 0.6-0.7 mais conservador
  // (justificável pelo gap empírico observado em 2026-04-28).
  const DISCOUNT_FACTOR = (() => {
    const e = parseFloat(process.env.TENNIS_CORR_DISCOUNT_FACTOR);
    return Number.isFinite(e) && e > 0 && e <= 1 ? e : 0.5;
  })();

  const result = [];
  for (let i = 0; i < tips.length; i++) {
    let maxAbsCorr = 0;
    for (let j = 0; j < tips.length; j++) {
      if (i === j) continue;
      const c = Math.abs(computeMarketCorrelation(tips[i], tips[j]));
      if (c > maxAbsCorr) maxAbsCorr = c;
    }
    const discount = maxAbsCorr > 0.3 ? maxAbsCorr * DISCOUNT_FACTOR : 0;
    result.push({
      ...tips[i],
      adjustedStake: +(tips[i].kellyStake * (1 - discount)).toFixed(2),
      correlationDiscount: +discount.toFixed(2),
    });
  }
  return result;
}

/**
 * Retorna a matriz de correlação completa entre as tips.
 * Útil pra log/debug.
 *
 * @returns {Array<Array<number>>} matrix n×n onde matrix[i][j] = corr(tip_i, tip_j)
 */
function correlationMatrix(tips) {
  const n = tips.length;
  const m = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      if (i === j) row.push(1.0);
      else row.push(+computeMarketCorrelation(tips[i], tips[j]).toFixed(3));
    }
    m.push(row);
  }
  return m;
}

// ── Helpers ──

function sameTip(a, b) {
  return a.market === b.market && a.side === b.side && a.line === b.line;
}

function eq2(mA, mB, x, y) {
  return (mA === x && mB === y) || (mA === y && mB === x);
}

function isSameSide(a, b) {
  // heurística: sides iguais (home/away, team1/team2) apontam pro mesmo jogador.
  // handicap `home` / ML `team1` são same side por convenção.
  const na = String(a.side || '').toLowerCase();
  const nb = String(b.side || '').toLowerCase();
  const team1Aliases = new Set(['home', 'team1', 't1', '1']);
  const team2Aliases = new Set(['away', 'team2', 't2', '2']);
  if (team1Aliases.has(na) && team1Aliases.has(nb)) return true;
  if (team2Aliases.has(na) && team2Aliases.has(nb)) return true;
  return false;
}

module.exports = {
  computeMarketCorrelation,
  adjustStakesForCorrelation,
  correlationMatrix,
};

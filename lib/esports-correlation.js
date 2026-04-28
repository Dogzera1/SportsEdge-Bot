'use strict';

/**
 * esports-correlation.js — correlação intra-match entre mercados MT esports
 * (LoL/CS2/Dota2/Valorant). Análogo ao tennis-correlation.js.
 *
 * Coeficientes empíricos (best estimates pré-backtest dedicado; refinar quando
 * houver n≥100 settled por par mercado-side):
 *
 *   ML same-side  vs handicap (-1.5)    → +0.65 (sweep requer fav forte)
 *   ML same-side  vs handicap (+1.5)    → -0.10 (cobertura insuficiente; low corr)
 *   ML same-side  vs total maps under   → +0.40 quando fav forte (sweep curto)
 *   ML same-side  vs total maps over    → -0.30 (close match = série longa)
 *   handicap (-1.5) vs total under      → +0.55 (sweep ⇒ under maps)
 *   total_kills_mapN entre mapas        → +0.20 (draft consistency)
 *   total_kills vs ML                   → 0.05 (kills do mapa N independente do outcome série)
 *   total_kills vs handicap maps        → 0.05
 *   total_kills vs total maps           → 0.05
 *
 * Uso:
 *   const { adjustStakesForCorrelation } = require('./esports-correlation');
 *   const adj = adjustStakesForCorrelation(tips); // [{market, side, line, pModel, odd, kellyStake}]
 *   // adj[i] tem .adjustedStake e .correlationDiscount
 *
 * Stake adjustment: discount = max|c| × 0.5 quando |c|>0.3 (mesmo regime do tennis).
 * Garante 50% mínimo mesmo em correlação perfeita — alguma edge incremental resta.
 */

const TEAM1_ALIASES = new Set(['home', 'team1', 't1', '1']);
const TEAM2_ALIASES = new Set(['away', 'team2', 't2', '2']);

function _isTeam1(side) { return TEAM1_ALIASES.has(String(side || '').toLowerCase()); }
function _isTeam2(side) { return TEAM2_ALIASES.has(String(side || '').toLowerCase()); }

function _isSameSide(a, b) {
  const sa = String(a.side || '').toLowerCase();
  const sb = String(b.side || '').toLowerCase();
  if (_isTeam1(sa) && _isTeam1(sb)) return true;
  if (_isTeam2(sa) && _isTeam2(sb)) return true;
  return false;
}

function _eq2(mA, mB, x, y) {
  return (mA === x && mB === y) || (mA === y && mB === x);
}

function _normMarket(m) {
  const s = String(m || '').toLowerCase();
  // Aliases comuns: ml/moneyline/market_winner; total/totals/totalMaps; handicap/handicapMaps
  if (s === 'ml' || s === 'market_winner' || s === 'moneyline') return 'ml';
  if (s === 'total' || s === 'totals' || s === 'totalmaps') return 'total';
  if (s === 'handicap' || s === 'handicapmaps') return 'handicap';
  // Kills per-mapa: total_kills_map1, total_kills_map2... preserva sufixo
  if (/^total_kills_map\d+$/.test(s)) return s;
  return s;
}

function _kmIdx(market) {
  const m = _normMarket(market);
  const x = m.match(/^total_kills_map(\d+)$/);
  return x ? parseInt(x[1], 10) : null;
}

function sameTip(a, b) {
  return _normMarket(a.market) === _normMarket(b.market)
    && a.side === b.side
    && a.line === b.line;
}

/**
 * Coeficiente de correlação empírico entre 2 tips esports.
 * Range: [-1, 1].
 */
function computeMarketCorrelation(tipA, tipB) {
  if (sameTip(tipA, tipB)) return 1.0;

  const mA = _normMarket(tipA.market);
  const mB = _normMarket(tipB.market);
  const sameSide = _isSameSide(tipA, tipB);

  // ── ML vs handicap ──
  if (_eq2(mA, mB, 'ml', 'handicap')) {
    const handi = mA === 'handicap' ? tipA : tipB;
    const isSweepHand = Number(handi.line) < 0; // -1.5 = sweep
    if (sameSide && isSweepHand) return 0.65;       // ML team1 + handicap -1.5 team1
    if (sameSide && !isSweepHand) return 0.10;      // ML team1 + handicap +1.5 team1 (cobertura, low corr)
    if (!sameSide && isSweepHand) return -0.65;     // ML team1 + handicap -1.5 team2
    return -0.10;                                   // opostos +1.5
  }

  // ── ML vs total maps ──
  if (_eq2(mA, mB, 'ml', 'total')) {
    const total = mA === 'total' ? tipA : tipB;
    const ml = mA === 'ml' ? tipA : tipB;
    const isUnder = String(total.side || '').toLowerCase() === 'under';
    const favStrong = Number(ml.pModel || 0) > 0.60;
    if (favStrong && isUnder) return 0.40;     // fav forte + under = sweep curto
    if (favStrong && !isUnder) return -0.30;   // fav forte + over = inconsistente
    if (!favStrong && isUnder) return -0.20;
    return 0.20;                                // close match + over (série longa)
  }

  // ── handicap vs total ──
  if (_eq2(mA, mB, 'handicap', 'total')) {
    const handi = mA === 'handicap' ? tipA : tipB;
    const total = mA === 'total' ? tipA : tipB;
    const isSweepHand = Number(handi.line) < 0;
    const isUnder = String(total.side || '').toLowerCase() === 'under';
    if (isSweepHand && isUnder) return 0.55;
    if (isSweepHand && !isUnder) return -0.55;
    if (!isSweepHand && isUnder) return -0.30;
    return 0.30;
  }

  // ── total_kills_mapN vs total_kills_mapM (mesma série) ──
  const kA = _kmIdx(mA);
  const kB = _kmIdx(mB);
  if (kA != null && kB != null) {
    return kA === kB ? 1.0 : 0.20;
  }

  // ── total_kills_mapN vs ML/handicap/total → essencialmente independente ──
  if (kA != null || kB != null) return 0.05;

  return 0;
}

/**
 * Ajusta stakes pairwise. Cada tip é descontada pela maior |corr| com outro tip.
 * Discount = max|c| × 0.5 quando |c|>0.3.
 */
function adjustStakesForCorrelation(tips) {
  if (!Array.isArray(tips) || tips.length < 2) {
    return tips.map(t => ({ ...t, adjustedStake: t.kellyStake, correlationDiscount: 0 }));
  }
  const result = [];
  for (let i = 0; i < tips.length; i++) {
    let maxAbsCorr = 0;
    for (let j = 0; j < tips.length; j++) {
      if (i === j) continue;
      const c = Math.abs(computeMarketCorrelation(tips[i], tips[j]));
      if (c > maxAbsCorr) maxAbsCorr = c;
    }
    const discount = maxAbsCorr > 0.3 ? maxAbsCorr * 0.5 : 0;
    result.push({
      ...tips[i],
      adjustedStake: +(Number(tips[i].kellyStake || 0) * (1 - discount)).toFixed(2),
      correlationDiscount: +discount.toFixed(2),
    });
  }
  return result;
}

function correlationMatrix(tips) {
  const n = tips.length;
  const m = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      row.push(i === j ? 1.0 : +computeMarketCorrelation(tips[i], tips[j]).toFixed(3));
    }
    m.push(row);
  }
  return m;
}

module.exports = {
  computeMarketCorrelation,
  adjustStakesForCorrelation,
  correlationMatrix,
};

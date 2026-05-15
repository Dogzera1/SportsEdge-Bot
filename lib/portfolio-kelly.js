'use strict';

/**
 * portfolio-kelly.js — correlation-aware stake reduction CROSS-CYCLE.
 *
 * Problema: esports-correlation + tennis-correlation já fazem adjustStakesForCorrelation
 * em batch IN-CYCLE (mesma scanMarkets run). Mas tips abertas de cycles
 * anteriores em outras matches/sports não se comunicam — várias tips abertas
 * simultâneas (mesma série Bo3, ou matches do mesmo dia LoL/CS/Dota) somam
 * Kelly individual > Kelly portfolio safe.
 *
 * Caso real: 5 tips abertas LoL diferentes leagues simultaneamente. Cada
 * 1u (Kelly individual = ¼). Total exposure 5u. Se model está overfitted
 * no mesmo regime (eg patch novo), todas perdem juntas — DD intra-day 5x
 * pior que Kelly individual previu.
 *
 * Solução: consulta tips abertas mesmo sport, calcula correlation média da
 * nova tip vs abertas, aplica discount proporcional. Cap total exposure
 * per sport via env.
 *
 * Uso:
 *   const { applyPortfolioDiscount } = require('./portfolio-kelly');
 *   const adj = applyPortfolioDiscount(db, {
 *     sport: 'lol',
 *     match: { team1, team2 },
 *     newTip: { market: 'ML', side: 'team1', line: null, pModel, kellyStake: 1.5 },
 *   });
 *   // adj = { adjustedStake, discount, reason, openCount, totalExposure }
 *
 * Opt-out: PORTFOLIO_KELLY_DISABLED=true.
 */

// Cap total exposure por sport (em units stake). Sum aberta + nova ≤ cap.
const _DEFAULT_SPORT_CAP_UNITS = 10; // ~10% bankroll se 1u=1%
const _DEFAULT_DISCOUNT_FACTOR = 0.5; // mesmo factor do esports-correlation

function _normSide(side) {
  return String(side || '').toLowerCase();
}

function _normMarket(m) {
  const x = String(m || '').toUpperCase();
  if (x === 'HANDICAP_GAMES' || x === 'HANDICAPGAMES') return 'handicapGames';
  if (x === 'TOTAL_GAMES' || x === 'TOTALGAMES') return 'totalGames';
  if (x === 'HANDICAP') return 'handicap';
  if (x === 'TOTAL') return 'total';
  if (x === 'ML' || x === 'MONEYLINE') return 'ML';
  return String(m || '');
}

function _sameMatch(openTip, newMatch) {
  const t1 = String(newMatch.team1 || '').toLowerCase();
  const t2 = String(newMatch.team2 || '').toLowerCase();
  const p1 = String(openTip.participant1 || '').toLowerCase();
  const p2 = String(openTip.participant2 || '').toLowerCase();
  return (p1 === t1 && p2 === t2) || (p1 === t2 && p2 === t1);
}

function _getCorrelationLib(sport) {
  const s = String(sport || '').toLowerCase();
  if (['lol', 'cs', 'cs2', 'dota2', 'valorant'].includes(s)) {
    try { return require('./esports-correlation'); } catch (_) { return null; }
  }
  if (s === 'tennis') {
    try { return require('./tennis-correlation'); } catch (_) { return null; }
  }
  return null;
}

function _estimateCorr(corrLib, openTip, newTip, sameMatch) {
  if (!sameMatch) return 0; // tips em matches diferentes: corr ≈ 0 (sport-agnostic baseline)
  if (!corrLib?.computeMarketCorrelation) return 0.3; // fallback conservador
  try {
    const a = {
      market: _normMarket(openTip.market_type || openTip.market || 'ML'),
      side: _normSide(openTip.side || 'team1'),
      line: openTip.line != null ? Number(openTip.line) : null,
      pModel: Number(openTip.model_p_pick) || 0,
    };
    const b = {
      market: _normMarket(newTip.market || 'ML'),
      side: _normSide(newTip.side || 'team1'),
      line: newTip.line != null ? Number(newTip.line) : null,
      pModel: Number(newTip.pModel) || 0,
    };
    const c = corrLib.computeMarketCorrelation(a, b);
    return Number.isFinite(c) ? Math.abs(c) : 0;
  } catch (_) { return 0; }
}

function applyPortfolioDiscount(db, opts = {}) {
  const { sport, match, newTip } = opts;
  const out = {
    adjustedStake: Number(newTip?.kellyStake) || 0,
    discount: 0,
    reason: 'no_op',
    openCount: 0,
    totalExposure: 0,
  };
  if (!db || !sport || !newTip) { out.reason = 'invalid_args'; return out; }
  if (/^(1|true|yes)$/i.test(String(process.env.PORTFOLIO_KELLY_DISABLED || ''))) {
    out.reason = 'disabled';
    return out;
  }
  const baseStake = Number(newTip.kellyStake) || 0;
  if (baseStake <= 0) { out.reason = 'zero_stake'; return out; }

  let openTips = [];
  try {
    openTips = db.prepare(`
      SELECT id, sport, participant1, participant2, market_type, tip_participant, odds, stake, model_p_pick, sent_at
      FROM tips
      WHERE sport = ?
        AND result IS NULL
        AND (archived IS NULL OR archived = 0)
        AND (is_shadow IS NULL OR is_shadow = 0)
        AND sent_at >= datetime('now', '-6 hours')
      ORDER BY sent_at DESC LIMIT 50
    `).all(sport);
  } catch (e) { out.reason = `db_err:${e.message}`; return out; }

  if (!openTips.length) { out.reason = 'no_open_tips'; return out; }
  out.openCount = openTips.length;

  // Total exposure em units (parse stake como '1.5u' → 1.5).
  // 2026-05-15 audit P2: regex agora anchored ao prefixo + 'u' suffix.
  // Antes /(\d+(?:\.\d+)?)/ pegava PRIMEIRO número da string — se stake fosse
  // armazenado errado como 'R$ 35.00' (DM display format), pegava 35 (10×
  // escala real). Format canônico é '1.5u' no DB; o anchor é defesa contra
  // corrupção upstream. Stake fora do format → skip (não infla exposure).
  let totalUnits = 0;
  for (const t of openTips) {
    const s = String(t.stake || '').trim();
    const mU = s.match(/^(\d+(?:\.\d+)?)\s*u\b/i);
    if (mU) {
      const units = parseFloat(mU[1]);
      if (Number.isFinite(units) && units >= 0) totalUnits += units;
    }
    // Else: silent skip — stake fora do format esperado não infla exposure.
  }
  out.totalExposure = +totalUnits.toFixed(2);

  // Cap total exposure por sport
  const capUnits = parseFloat(process.env[`PORTFOLIO_KELLY_CAP_${sport.toUpperCase()}_UNITS`])
    || parseFloat(process.env.PORTFOLIO_KELLY_CAP_UNITS)
    || _DEFAULT_SPORT_CAP_UNITS;

  if ((totalUnits + baseStake) > capUnits) {
    // Reduz nova stake pra caber no cap; mínimo 0.1u (mantém presença).
    const remaining = Math.max(0.1, capUnits - totalUnits);
    if (remaining < baseStake) {
      out.adjustedStake = +remaining.toFixed(2);
      out.discount = +((1 - remaining / baseStake) * 100).toFixed(1);
      out.reason = `sport_cap_${capUnits}u_total_${totalUnits.toFixed(1)}u`;
      return out;
    }
  }

  // Correlation discount com tips abertas (mesmo match prioritário)
  const corrLib = _getCorrelationLib(sport);
  if (!corrLib && !match) { out.reason = 'no_corr_lib'; return out; }

  let maxCorr = 0;
  let corrSource = null;
  for (const ot of openTips) {
    const isSameMatch = match ? _sameMatch(ot, match) : false;
    const c = _estimateCorr(corrLib, ot, newTip, isSameMatch);
    if (c > maxCorr) {
      maxCorr = c;
      corrSource = { tip_id: ot.id, market: ot.market_type, same_match: isSameMatch, corr: +c.toFixed(2) };
    }
  }

  // Aplicar discount só se maxCorr > 0.3 (low corr negligenciável)
  const corrThreshold = parseFloat(process.env.PORTFOLIO_KELLY_CORR_THRESHOLD || '0.3');
  if (maxCorr <= corrThreshold) {
    out.reason = `low_corr_${maxCorr.toFixed(2)}`;
    return out;
  }

  // discount = maxCorr × DISCOUNT_FACTOR (cap em 0.5 = max -50%)
  const factor = parseFloat(process.env.PORTFOLIO_KELLY_DISCOUNT_FACTOR) || _DEFAULT_DISCOUNT_FACTOR;
  const discountPct = Math.min(0.5, maxCorr * factor);
  out.adjustedStake = +(baseStake * (1 - discountPct)).toFixed(2);
  out.discount = +(discountPct * 100).toFixed(1);
  out.reason = `corr_discount_${corrSource?.market || '?'}_corr=${maxCorr.toFixed(2)}_sameMatch=${corrSource?.same_match}`;
  out._source = corrSource;
  return out;
}

module.exports = { applyPortfolioDiscount };

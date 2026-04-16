/**
 * stake-adjuster.js — Multiplicador dinâmico de stake baseado em performance histórica.
 *
 * Três fatores independentes (multiplicados entre si):
 *   1. League ROI       — performance por campeonato (exige ≥20 tips settled)
 *   2. Recent streak    — últimos 15 settled por esporte (damping em drawdown)
 *   3. Daily stop-loss  — pausa o esporte se perda diária > 15% banca
 *
 * Retorna {multiplier:number, reasons:string[]}.
 * multiplier=0 → bloqueia a tip completamente.
 */

'use strict';

function _num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** ROI por liga: (wins*(avgOdd-1) - losses) / total_stake */
function getLeagueStats(db, sport, league) {
  if (!sport || !league) return null;
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(COALESCE(stake_reais, 0)), 2) AS total_staked,
      ROUND(SUM(COALESCE(profit_reais, 0)), 2) AS total_profit
    FROM tips
    WHERE sport = ? AND event_name = ? AND result IN ('win', 'loss')
  `).get(sport, league);
  if (!row || !row.total) return null;
  const roi = row.total_staked > 0 ? (row.total_profit / row.total_staked) * 100 : 0;
  return {
    total: row.total,
    wins: row.wins || 0,
    losses: row.losses || 0,
    totalStaked: row.total_staked,
    totalProfit: row.total_profit,
    roi: +roi.toFixed(2),
  };
}

/** Win/loss nos últimos N tips settled do esporte. */
function getRecentStreak(db, sport, lookback = 15) {
  const rows = db.prepare(`
    SELECT result FROM tips
    WHERE sport = ? AND result IN ('win', 'loss')
    ORDER BY settled_at DESC, id DESC
    LIMIT ?
  `).all(sport, lookback);
  if (!rows.length) return { total: 0, wins: 0, losses: 0 };
  let wins = 0, losses = 0;
  for (const r of rows) {
    if (r.result === 'win') wins++;
    else if (r.result === 'loss') losses++;
  }
  return { total: rows.length, wins, losses };
}

/** P&L do dia atual (UTC). Positivo = lucro. */
function getDailyPnL(db, sport) {
  const row = db.prepare(`
    SELECT
      ROUND(SUM(COALESCE(profit_reais, 0)), 2) AS profit,
      ROUND(SUM(COALESCE(stake_reais, 0)), 2) AS staked,
      COUNT(*) AS n
    FROM tips
    WHERE sport = ? AND result IN ('win', 'loss')
      AND DATE(settled_at) = DATE('now')
  `).get(sport);
  return {
    profit: row?.profit || 0,
    staked: row?.staked || 0,
    settledToday: row?.n || 0,
  };
}

/**
 * Calcula multiplicador final (produto dos 3 fatores).
 * @param {object} opts
 *   opts.currentBanca — banca atual do esporte (reais) p/ daily stop-loss
 */
function computeStakeMultiplier(db, sport, league, opts = {}) {
  const reasons = [];
  let mult = 1.0;

  // Fator 1: League ROI
  const lg = getLeagueStats(db, sport, league);
  if (lg && lg.total >= 20) {
    const roi = lg.roi;
    let lgMult = 1.0;
    if (roi >= 15) lgMult = 1.20;
    else if (roi >= 5) lgMult = 1.10;
    else if (roi >= -5) lgMult = 1.00;
    else if (roi >= -15) lgMult = 0.75;
    else if (roi >= -25) lgMult = 0.50;
    else lgMult = 0.0;
    if (lgMult !== 1.0) {
      reasons.push(`league_roi=${roi}% (${lg.total} tips) → ${lgMult}x`);
    }
    mult *= lgMult;
    if (lgMult === 0) return { multiplier: 0, reasons, blocked: 'league_roi_too_low' };
  } else if (lg) {
    reasons.push(`league_sample=${lg.total}/20 (insuficiente)`);
  }

  // Fator 2: Streak
  const st = getRecentStreak(db, sport, 15);
  if (st.total >= 10) {
    let streakMult = 1.0;
    if (st.losses >= 10) streakMult = 0.50;
    else if (st.losses >= 8) streakMult = 0.75;
    else if (st.wins >= 10) streakMult = 1.10;
    if (streakMult !== 1.0) {
      reasons.push(`streak=${st.wins}W-${st.losses}L → ${streakMult}x`);
    }
    mult *= streakMult;
  }

  // Fator 3: Daily stop-loss
  const currentBanca = _num(opts.currentBanca);
  if (currentBanca && currentBanca > 0) {
    const daily = getDailyPnL(db, sport);
    const lossPct = daily.profit < 0 ? (Math.abs(daily.profit) / currentBanca) : 0;
    if (lossPct >= 0.15) {
      reasons.push(`daily_loss=${(lossPct*100).toFixed(1)}% banca → STOP`);
      return { multiplier: 0, reasons, blocked: 'daily_stop_loss' };
    } else if (lossPct >= 0.10) {
      reasons.push(`daily_loss=${(lossPct*100).toFixed(1)}% banca → 0.75x`);
      mult *= 0.75;
    }
  }

  // Cap [0, 1.5]
  mult = Math.max(0, Math.min(1.5, mult));
  return { multiplier: +mult.toFixed(2), reasons, blocked: null };
}

module.exports = {
  getLeagueStats,
  getRecentStreak,
  getDailyPnL,
  computeStakeMultiplier,
};

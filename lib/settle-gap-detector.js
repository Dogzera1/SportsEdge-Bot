/**
 * Settle gap detector — encontra market_tips_shadow.result NOT NULL +
 * tips.result NULL (crash mid-flow entre shadow commit e propagator).
 *
 * Audit P0 architectural 2026-05-15 (data flow agent):
 * Shadow + propagator NÃO-transacional (better-sqlite3 limitation
 * "cannot start a transaction within a transaction"). Crash entre
 * shadow.commit + propagator.commit deixa shadow.result NOT NULL
 * mas tips.result NULL → cleanup #3 voida em 14d sem restaurar bankroll.
 *
 * Solution: cron daily detecta gaps + re-fire propagator (idempotent
 * via audit guard em lib/mt-result-propagator.js).
 *
 * Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md (C)
 */

/**
 * SQL fragment pra norm coluna SQLite (espelha _normTeam em mt-result-propagator).
 */
const _NORM_SQL_COL = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(lower(${col}), ' ', ''), '-', ''), '.', ''), '''', '')`;

/**
 * Encontra gaps: shadow settled + tip pending matching (sport, market, normalized pair).
 *
 * Match criteria:
 *   - same sport
 *   - same UPPER(market_type)
 *   - tips.is_shadow=0, NOT archived, result IS NULL
 *   - ABS(sent_at - shadow.created_at) < 14 days
 *   - normalized pair match (forward OR reverse)
 *
 * @param {Database} db better-sqlite3
 * @param {object} opts { windowDays = 30 }
 * @returns {Array<{shadow_id, tip_id, sport, market, team1, team2, result, profit_pct, line, odd}>}
 */
function findSettleGaps(db, opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) && opts.windowDays > 0 ? opts.windowDays : 30;
  const normT1 = _NORM_SQL_COL('t.participant1');
  const normT2 = _NORM_SQL_COL('t.participant2');
  const normM1 = _NORM_SQL_COL('mts.team1');
  const normM2 = _NORM_SQL_COL('mts.team2');

  const sql = `
    SELECT mts.id AS shadow_id, t.id AS tip_id, mts.sport, mts.market, mts.side,
           mts.team1, mts.team2, mts.result, mts.profit_pct, mts.line, mts.odd
    FROM market_tips_shadow mts
    INNER JOIN tips t
      ON t.sport = mts.sport
      AND UPPER(t.market_type) = UPPER(mts.market)
      AND COALESCE(t.is_shadow, 0) = 0
      AND (t.archived IS NULL OR t.archived = 0)
      AND t.result IS NULL
      AND ABS(julianday(COALESCE(t.sent_at, t.settled_at)) - julianday(mts.created_at)) < 14
      AND (
        (${normT1} = ${normM1} AND ${normT2} = ${normM2})
        OR
        (${normT1} = ${normM2} AND ${normT2} = ${normM1})
      )
    WHERE mts.result IS NOT NULL
      AND mts.created_at >= datetime('now', '-' || ? || ' days')
    LIMIT 50
  `;

  return db.prepare(sql).all(windowDays);
}

module.exports = { findSettleGaps };

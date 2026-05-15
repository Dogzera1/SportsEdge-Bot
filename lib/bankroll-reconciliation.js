/**
 * Bankroll reconciliation — detecta drift entre stored current_banca e
 * sum(profit_reais) das tips reais (is_shadow=0, archived=0).
 *
 * Audit P0 architectural 2026-05-15 (data flow + state agents):
 * 2026-05-12 R$6.58 mirror drift lol↔dota2 unresolved root cause —
 * detection cron pega drifts subsequentes em <24h.
 *
 * Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md (E)
 */

/**
 * Computa drift per sport. Retorna array de drifts > threshold.
 *
 * Convenção drift_amount: stored_delta − expected_delta
 *   - drift_amount > 0: stored excede expected (bankroll inflado vs tips)
 *   - drift_amount < 0: stored aquém expected (bankroll desatualizado vs tips)
 *
 * @param {Database} db better-sqlite3 instance
 * @param {object} opts { threshold = 0.10 }
 * @returns {{ drifts: Array<{sport, expected_delta, stored_delta, drift_amount}>, scanned_at, threshold }}
 */
function reconcileBankrollDrift(db, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0 ? opts.threshold : 0.10;
  const scanned_at = new Date().toISOString();

  const banks = db.prepare(`
    SELECT sport, initial_banca, current_banca
    FROM bankroll
  `).all();

  const drifts = [];
  const expectedStmt = db.prepare(`
    SELECT COALESCE(SUM(profit_reais), 0) AS expected_delta
    FROM tips
    WHERE sport = ?
      AND COALESCE(is_shadow, 0) = 0
      AND (archived IS NULL OR archived = 0)
      AND result IN ('win', 'loss')
      AND profit_reais IS NOT NULL
  `);
  for (const b of banks) {
    const expected = expectedStmt.get(b.sport);
    const expected_delta = +(expected.expected_delta || 0).toFixed(2);
    const stored_delta = +(Number(b.current_banca) - Number(b.initial_banca)).toFixed(2);
    const drift_amount = +(stored_delta - expected_delta).toFixed(2);
    if (Math.abs(drift_amount) > threshold) {
      drifts.push({
        sport: b.sport,
        expected_delta,
        stored_delta,
        drift_amount,
      });
    }
  }

  return { drifts, scanned_at, threshold };
}

/**
 * Persiste drifts em bankroll_drift_log (migration 110) pra trending.
 *
 * @returns {number} count de drifts gravados
 */
function logDrifts(db, drifts, threshold) {
  if (!drifts || drifts.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO bankroll_drift_log (sport, expected_delta, stored_delta, drift_amount, threshold)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const d of drifts) stmt.run(d.sport, d.expected_delta, d.stored_delta, d.drift_amount, threshold);
  });
  tx();
  return drifts.length;
}

module.exports = { reconcileBankrollDrift, logDrifts };

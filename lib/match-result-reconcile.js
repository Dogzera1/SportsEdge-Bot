/**
 * match-result-reconcile.js — detect mismatches dual-source em match_results.
 *
 * Mig 109 cria tabela `match_result_sources` (multi-row por match_id+game+source).
 * Sources atuais wired (FASE 1 tennis):
 *   - 'sackmann' (server.js:587, JeffSackmann CSV import)
 *   - 'espn' / 'sofascore' (callers tennis settle path)
 *
 * Reconcile detecta:
 *   - 2+ sources pro mesmo (match_id, game)
 *   - winner DIVERGENT entre sources
 *   - últimos N dias (default 7d janela rolling)
 *
 * P2-compliant: só DM admin (research/observability). Settle path NÃO bloqueia.
 * FASE 2 futura: settle só após confirmation. Por ora, alert + investigar manual.
 */

/**
 * Detecta mismatches winner cross-source últimos N dias.
 *
 * @param {Database} db better-sqlite3
 * @param {Object} opts { days?: number, game?: string, minSources?: number }
 * @returns {{ ts, days, n_mismatches, mismatches: Array }}
 */
function findMismatches(db, opts = {}) {
  const days = Math.max(1, Math.min(60, parseInt(opts.days || '7', 10) || 7));
  const game = opts.game ? String(opts.game).toLowerCase().trim() : null;
  const minSources = Math.max(2, parseInt(opts.minSources || '2', 10) || 2);

  const gameCond = game ? `AND game = ?` : '';
  const gameArgs = game ? [game] : [];

  // Step 1: encontrar (match_id, game) que têm 2+ sources com winner diferente.
  const rows = db.prepare(`
    SELECT match_id, game,
           COUNT(DISTINCT source) AS n_sources,
           COUNT(DISTINCT winner) AS n_winners,
           GROUP_CONCAT(DISTINCT source) AS sources_csv,
           GROUP_CONCAT(DISTINCT winner) AS winners_csv,
           MAX(recorded_at) AS last_recorded
      FROM match_result_sources
     WHERE recorded_at >= datetime('now', '-' || ? || ' days')
       ${gameCond}
     GROUP BY match_id, game
    HAVING n_sources >= ? AND n_winners >= 2
     ORDER BY last_recorded DESC
     LIMIT 500
  `).all(days, ...gameArgs, minSources);

  // Step 2: pra cada mismatch, fetch detail breakdown
  const detailStmt = db.prepare(`
    SELECT source, winner, final_score, recorded_at
      FROM match_result_sources
     WHERE match_id = ? AND game = ?
     ORDER BY recorded_at DESC
  `);
  const mismatches = rows.map(r => ({
    match_id: r.match_id,
    game: r.game,
    n_sources: r.n_sources,
    n_winners: r.n_winners,
    sources_csv: r.sources_csv,
    winners_csv: r.winners_csv,
    last_recorded: r.last_recorded,
    detail: detailStmt.all(r.match_id, r.game),
  }));

  return {
    ts: new Date().toISOString(),
    days, minSources,
    n_mismatches: mismatches.length,
    mismatches,
  };
}

module.exports = { findMismatches };

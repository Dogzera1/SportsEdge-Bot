// 2026-05-28 (audit P0 banco): retention unificado pras log tables sem cleanup.
// Memory: lib/database.js cleanOldOdds(14d) + cleanOldSynced(60d) já cobrem 2.
// analyzed_dedup (bot.js:1001), error_log (bot.js:1500), cross_significance_snapshots
// (bot.js:29226) também têm DELETE próprio. Esta lib cobre as 6 restantes —
// risco OOM Railway 512MB cap latente em log tables que crescem sem teto.
//
// Default 90d, env override DB_RETENTION_<TABLE>_DAYS=N. Disable total via
// DB_RETENTION_DISABLED=true. Inclui PRAGMA wal_checkpoint(TRUNCATE) ao fim.

const DEFAULT_DAYS = 90;

// Tabela → coluna de timestamp (varia entre logs).
const TABLES = [
  { name: 'tip_factor_log',        col: 'created_at' },
  { name: 'bankroll_drift_log',    col: 'created_at' },
  { name: 'mt_auto_promote_log',   col: 'created_at' },
  { name: 'ml_auto_promote_log',   col: 'created_at' },
  { name: 'analytics_alerts',      col: 'created_at' },
  { name: 'paper_trades',          col: 'created_at' },
];

function _tableExists(db, name) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return !!row;
  } catch (_) { return false; }
}

function _columnExists(db, table, col) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => r.name === col);
  } catch (_) { return false; }
}

function _envDays(table) {
  const key = `DB_RETENTION_${table.toUpperCase()}_DAYS`;
  const v = parseInt(process.env[key] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DAYS;
}

function runDbRetentionCycle(db, log) {
  if (/^(1|true|yes)$/i.test(String(process.env.DB_RETENTION_DISABLED || ''))) {
    return { ok: true, skipped: 'disabled' };
  }
  const results = [];
  let totalDeleted = 0;
  for (const { name, col } of TABLES) {
    if (!_tableExists(db, name)) { results.push({ table: name, skipped: 'no_table' }); continue; }
    if (!_columnExists(db, name, col)) { results.push({ table: name, skipped: `no_col_${col}` }); continue; }
    const days = _envDays(name);
    try {
      const r = db.prepare(
        `DELETE FROM ${name} WHERE ${col} < datetime('now', '-' || ? || ' days')`
      ).run(days);
      const changes = r.changes || 0;
      totalDeleted += changes;
      results.push({ table: name, days, deleted: changes });
    } catch (e) {
      results.push({ table: name, error: e.message });
    }
  }
  // Checkpoint WAL after bulk deletes to reclaim disk.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
  if (typeof log === 'function' && totalDeleted > 0) {
    try { log('INFO', 'DB-RETENTION', `deleted=${totalDeleted} across ${results.filter(r => r.deleted).length} tables`); } catch (_) {}
  }
  return { ok: true, total_deleted: totalDeleted, results };
}

module.exports = { runDbRetentionCycle, TABLES, DEFAULT_DAYS };

'use strict';

/**
 * frozen-holdout.js — reserva últimos N dias do treino dos auto-tune systems
 * pra preservar amostra walk-forward não-vista.
 *
 * Auto-tune systems (kelly_auto_tune, mt_auto_promote, gates_autotune,
 * ev_calibration, learned_corrections, readiness_learner, odds_bucket_guard,
 * mt_bucket_guard, mt_leak_guard) treinam em janela rolling 30-90d. Sem
 * holdout, decisão de "promote MT" / "tune kelly_mult" é tomada em dados que
 * vão ser re-avaliados pelos mesmos sistemas — overfitting estrutural.
 *
 * FROZEN_HOLDOUT_DAYS=N (default 0 = OFF) reserva últimos N dias. Quando
 * setado, queries dos auto-tune adicionam `AND settled_at < datetime('now', '-N days')`
 * — auto-tune treina em [-(days+holdout), -holdout]; resto fica intocado pra
 * eval manual posterior.
 *
 * Uso recomendado: 60-90d. Validar mensalmente via /admin/holdout-eval (TBD).
 *
 * Override scoped via FROZEN_HOLDOUT_<SYSTEM>_DAYS (ex: FROZEN_HOLDOUT_KELLY_DAYS=120
 * mantém kelly mais conservador que mt_auto_promote).
 */

function _parseDays(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Days a reservar (inteiro >=0). 0 = holdout OFF (legacy behavior).
 *
 * @param {string} system - nome do sistema (ex: 'kelly', 'mt_auto_promote', 'gates_autotune')
 *                         Override per-system via FROZEN_HOLDOUT_<SYSTEM_UPPER>_DAYS.
 * @returns {number} N dias a excluir do treino (do mais recente).
 */
function getHoldoutDays(system = '') {
  const sysKey = String(system || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (sysKey) {
    const sysVal = process.env[`FROZEN_HOLDOUT_${sysKey}_DAYS`];
    if (sysVal != null && sysVal !== '') return _parseDays(sysVal);
  }
  return _parseDays(process.env.FROZEN_HOLDOUT_DAYS);
}

/**
 * Retorna clause SQL pra adicionar em WHERE de query de treino.
 * Coluna padrão: settled_at. Override via param.
 *
 * @param {string} system - nome do sistema
 * @param {string} column - coluna timestamp pra filtrar (default 'settled_at')
 * @returns {string} clause SQL (vazia se holdout=0). Não inclui AND/WHERE — caller adiciona.
 *
 * Exemplo:
 *   const holdoutClause = getHoldoutSql('kelly');
 *   db.prepare(`SELECT ... FROM tips WHERE sport=? AND result IN('win','loss')
 *              AND settled_at >= datetime('now', '-30 days') ${holdoutClause}`)
 */
function getHoldoutSql(system = '', column = 'settled_at') {
  const days = getHoldoutDays(system);
  if (!days) return '';
  // Validate column name to prevent SQL injection (caller is internal, but defensive).
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) return '';
  return `AND ${column} < datetime('now', '-${days} days')`;
}

/**
 * Retorna cutoff ISO pra usar em filters JS (não SQL).
 *
 * @param {string} system
 * @returns {string|null} ISO timestamp ou null se holdout=0.
 */
function getHoldoutCutoffIso(system = '') {
  const days = getHoldoutDays(system);
  if (!days) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Status agregado pra /admin/holdout-status endpoint.
 */
function getStatus() {
  const systems = ['kelly', 'mt_auto_promote', 'gates_autotune', 'ev_calibration',
                   'learned_corrections', 'readiness_learner', 'odds_bucket_guard',
                   'mt_bucket_guard', 'mt_leak_guard', 'league_guard'];
  const out = {
    default_days: _parseDays(process.env.FROZEN_HOLDOUT_DAYS),
    per_system: {},
    cutoff_iso: getHoldoutCutoffIso(),
  };
  for (const s of systems) {
    out.per_system[s] = {
      days: getHoldoutDays(s),
      cutoff_iso: getHoldoutCutoffIso(s),
    };
  }
  return out;
}

module.exports = { getHoldoutDays, getHoldoutSql, getHoldoutCutoffIso, getStatus };

'use strict';

/**
 * overfeaturing-monitor.js — detecta features dormentes / redundantes.
 *
 * 2026-05-11 (P3 CLAUDE.md): audit periódico pra evitar acumular features
 * que nunca disparam OU duplicam intent de outras existentes. Sintomas:
 *   - Disable source com count=0 em 30d → trigger nunca aciona
 *   - Cron com low count vs expected → não roda OR roda mas no-op
 *   - Multipliers retornando 1.0 em majoria → no-op
 *
 * Findings = candidatos pra revisão humana, NÃO auto-action.
 * P2-compliant: research-only (DM admin, sem auto-delete).
 */

const { log } = require('./utils');

/**
 * Detecta disable sources que nunca dispararam em N dias.
 * Source com count=0 em janela = feature dormente.
 */
function _detectDormantDisableSources(db, days = 30) {
  try {
    const rows = db.prepare(`
      SELECT source, COUNT(*) AS n
      FROM market_tips_runtime_state
      WHERE disabled = 1
        AND updated_at >= datetime('now', ?)
      GROUP BY source
    `).all(`-${days} days`);
    const activeSources = new Set(rows.map(r => r.source));
    const knownSources = [
      'auto_clv_leak',
      'auto_roi_leak',
      'auto_early_roi_leak',
      'auto_loss_streak',
      'auto_validation',
      'auto_bucket',
      'manual',
    ];
    const dormant = knownSources.filter(s => !activeSources.has(s));
    return {
      active: rows,
      dormant,
      window_days: days,
    };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Detecta crons com count baixo vs expected (rodando menos do que devia).
 * Snapshot do cronStatus — comparar lastTs vs expected_interval.
 */
function _detectLowCountCrons(cronStatus) {
  try {
    const findings = [];
    const crons = cronStatus?.crons || {};
    for (const [name, c] of Object.entries(crons)) {
      const expected = c.expected_interval_ms;
      if (!expected) continue;
      // Expectativa 24h = 1/dia; cron com count=1 OK pra 1d uptime.
      // Pra count=0 em cron expectado de 1h+ é suspeito.
      const expectedRunsIn24h = (24 * 3600 * 1000) / expected;
      if (expectedRunsIn24h >= 6 && (c.count || 0) < expectedRunsIn24h / 4) {
        findings.push({
          cron: name,
          count: c.count || 0,
          expected_runs_24h: Math.floor(expectedRunsIn24h),
          last_result: c.lastResult,
          last_error: c.lastError,
        });
      }
    }
    return findings;
  } catch (e) {
    return [{ error: e.message }];
  }
}

/**
 * Detecta envs opt-in que NUNCA foram setadas em prod.
 * Usa heurística: env mencionada no código mas process.env retorna undefined.
 * NOTA: só faz sentido se envs.list disponível (Railway API ou dump local).
 * Por ora retorna apenas envs conhecidas opt-in + status.
 */
function _detectDeadOptInEnvs() {
  // Lista hand-curada de envs opt-in adicionadas recentemente que vale verificar.
  // Pode crescer conforme features novas são adicionadas.
  const optInEnvs = [
    'TENNIS_HOURS_BLOCKED',
    'LOL_HOURS_ALLOWED',
    'LOL_HOURS_BLOCKED',
    'CS_HOURS_BLOCKED',
    'FOOTBALL_HOURS_BLOCKED',
    'MT_LEAK_EARLY_AUTO',
    'MT_LEAK_STREAK_AUTO',
    'KELLY_TIER_MULT_DISABLED',
    'RISK_METRICS_MONITOR_AUTO',
    'TIME_OF_DAY_AUTO',
    'CLV_AUTO_KELLY',
    'LEAGUE_TRUST_DISABLED',
    'KELLY_AUTO_TUNE',
  ];
  const status = {};
  for (const e of optInEnvs) {
    const v = process.env[e];
    if (v == null || v === '') status[e] = 'unset';
    else status[e] = v;
  }
  const unset = Object.entries(status).filter(([, v]) => v === 'unset').map(([k]) => k);
  return { status, unset };
}

/**
 * Audit principal — combina detectors + retorna findings consolidados.
 */
function runOverfeaturingAudit(db, opts = {}) {
  const days = opts.days || 30;
  const cronStatus = opts.cronStatus || null;
  const findings = {
    dormant_disable_sources: _detectDormantDisableSources(db, days),
    low_count_crons: cronStatus ? _detectLowCountCrons(cronStatus) : null,
    dead_opt_in_envs: _detectDeadOptInEnvs(),
    timestamp: new Date().toISOString(),
    window_days: days,
  };
  // Score severidade: count de findings concretos
  const issues = [];
  if (findings.dormant_disable_sources.dormant?.length >= 2) {
    issues.push(`${findings.dormant_disable_sources.dormant.length} disable sources dormentes em ${days}d`);
  }
  if (findings.low_count_crons?.length >= 3) {
    issues.push(`${findings.low_count_crons.length} crons rodando abaixo do esperado`);
  }
  if (findings.dead_opt_in_envs.unset.length >= 8) {
    issues.push(`${findings.dead_opt_in_envs.unset.length} envs opt-in nunca setadas`);
  }
  findings.summary = {
    n_issues: issues.length,
    issues,
    health: issues.length === 0 ? '✅ ok' : issues.length <= 2 ? '🟡 monitor' : '🔴 review',
  };
  return findings;
}

module.exports = {
  runOverfeaturingAudit,
  _detectDormantDisableSources,
  _detectLowCountCrons,
  _detectDeadOptInEnvs,
};

'use strict';

/**
 * ai-shadow-audit-cron.js — monitoring detector pra tips AI shadow/real.
 *
 * Contexto: AI shadow tips (via _runAiShadow bot.js:10196) são settled em
 * match_results mas NÃO alimentam nenhum learner ML existente. Audit 2026-05-22
 * (memory project_ai_audit_2026_05_22) descobriu tennis AI shadow ROI -24.6%
 * com avgEV 49% (hallucinated, Ben Shelton EV=468% caso extremo). Refit prompt
 * aplicado (commits b17b710, eac9a7d) + P validation (890dc7a) + EV cap real
 * only (1a45897) — mas sem feedback automático de regressão.
 *
 * Este detector roda 24h, compara métricas AI tips per sport contra thresholds,
 * e DM admin se sair do range esperado.
 *
 * P2 compliance: NÃO automatiza ação. Apenas DM informativo. Decisão (refit
 * prompt, ajustar gates, desligar <SPORT>_AI_SHADOW) fica com humano.
 *
 * Alerta quando:
 *   ROI < AI_AUDIT_ROI_FLOOR (default -15%) AND n >= AI_AUDIT_MIN_N (default 20)
 *   OR
 *   avgEV > AI_AUDIT_EV_CEILING (default 30%) AND n >= AI_AUDIT_MIN_N
 *
 * Source: tips table filtrada via tip_reason LIKE pattern AI signature.
 * Cobre real + shadow universes (ambos alimentam o monitoring — não é decisão).
 *
 * Envs:
 *   AI_SHADOW_AUDIT_AUTO=true       (default true) — master switch
 *   AI_AUDIT_WINDOW_DAYS=30         — janela analise
 *   AI_AUDIT_ROI_FLOOR=-15          — abaixo disso = alerta
 *   AI_AUDIT_EV_CEILING=30          — acima disso = alerta (hallucination signal)
 *   AI_AUDIT_MIN_N=20               — amostra mínima settled
 *   AI_AUDIT_COOLDOWN_HOURS=24      — dedup DM
 */

const { log } = require('./utils');

const DEFAULTS = {
  windowDays: 30,
  roiFloor: -15,
  evCeiling: 30,
  minN: 20,
  cooldownHours: 24,
};

const SPORTS = ['lol', 'cs', 'cs2', 'dota2', 'valorant', 'tennis', 'football', 'mma'];

function _envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

function _envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

/**
 * Stats AI tips per sport. Filtro via tip_reason LIKE — _runAiShadow grava
 * "AI shadow POC (<SPORT>_AI_SHADOW)" ou "AI ML <displayName> real (DeepSeek)".
 * Stake em texto ("1u") → parse via REPLACE/CAST REAL.
 *
 * @returns {{n_settled, win, loss, void, pending, stake_u, profit_u, roi_pct, avg_ev}|null}
 */
function _aiStatsForSport(db, sport, windowDays) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS n_total,
      SUM(CASE WHEN result IN ('win','loss') THEN 1 ELSE 0 END) AS n_settled,
      SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS n_win,
      SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS n_loss,
      SUM(CASE WHEN result = 'void' THEN 1 ELSE 0 END) AS n_void,
      SUM(CASE WHEN result IS NULL THEN 1 ELSE 0 END) AS n_pending,
      SUM(CASE WHEN result IN ('win','loss') THEN
        CAST(REPLACE(REPLACE(LOWER(stake), 'u', ''), ' ', '') AS REAL) ELSE 0 END) AS staked_u,
      SUM(CASE WHEN result = 'win' THEN
        CAST(REPLACE(REPLACE(LOWER(stake), 'u', ''), ' ', '') AS REAL) * (odds - 1) ELSE 0 END) AS profit_gross_u,
      SUM(CASE WHEN result = 'loss' THEN
        CAST(REPLACE(REPLACE(LOWER(stake), 'u', ''), ' ', '') AS REAL) ELSE 0 END) AS loss_stake_u,
      AVG(CASE WHEN ev IS NOT NULL THEN CAST(ev AS REAL) ELSE NULL END) AS avg_ev
    FROM tips
    WHERE sport = ?
      AND COALESCE(archived, 0) = 0
      AND (
        tip_reason LIKE 'AI shadow POC%'
        OR tip_reason LIKE 'AI ML %'
        OR tip_reason LIKE '%DeepSeek%'
      )
      AND sent_at >= datetime('now', '-' || ? || ' days')
  `).get(sport, windowDays);

  if (!row || !Number(row.n_total)) return null;
  const nSettled = Number(row.n_settled) || 0;
  const staked = Number(row.staked_u) || 0;
  const profit = (Number(row.profit_gross_u) || 0) - (Number(row.loss_stake_u) || 0);
  return {
    n_total: Number(row.n_total) || 0,
    n_settled: nSettled,
    n_win: Number(row.n_win) || 0,
    n_loss: Number(row.n_loss) || 0,
    n_void: Number(row.n_void) || 0,
    n_pending: Number(row.n_pending) || 0,
    stake_u: staked,
    profit_u: profit,
    roi_pct: staked > 0 ? (profit / staked) * 100 : null,
    hit_rate_pct: (Number(row.n_win) + Number(row.n_loss)) > 0
      ? (Number(row.n_win) / (Number(row.n_win) + Number(row.n_loss))) * 100
      : null,
    avg_ev: Number(row.avg_ev) || null,
  };
}

/**
 * Roda audit AI shadow per sport. Retorna alertas + breakdown completo.
 *
 * @param {Object} db better-sqlite3 instance
 * @param {Object} opts
 * @returns {{alerts: Array, breakdown: Array, cfg: Object}}
 */
function runAiShadowAudit(db, opts = {}) {
  const cfg = {
    windowDays: opts.windowDays || _envInt('AI_AUDIT_WINDOW_DAYS', DEFAULTS.windowDays),
    roiFloor: opts.roiFloor != null ? opts.roiFloor : _envFloat('AI_AUDIT_ROI_FLOOR', DEFAULTS.roiFloor),
    evCeiling: opts.evCeiling || _envFloat('AI_AUDIT_EV_CEILING', DEFAULTS.evCeiling),
    minN: opts.minN || _envInt('AI_AUDIT_MIN_N', DEFAULTS.minN),
  };

  const alerts = [];
  const breakdown = [];
  const now = new Date().toISOString();

  for (const sport of SPORTS) {
    const stats = _aiStatsForSport(db, sport, cfg.windowDays);
    if (!stats || !stats.n_total) continue;

    const row = { sport, ...stats };
    breakdown.push(row);

    if (stats.n_settled < cfg.minN) {
      row.skip_reason = 'insufficient_sample';
      continue;
    }

    const reasons = [];
    if (stats.roi_pct != null && stats.roi_pct < cfg.roiFloor) {
      reasons.push(`ROI ${stats.roi_pct.toFixed(1)}% < floor ${cfg.roiFloor}%`);
    }
    if (stats.avg_ev != null && stats.avg_ev > cfg.evCeiling) {
      reasons.push(`avgEV ${stats.avg_ev.toFixed(1)}% > ceiling ${cfg.evCeiling}%`);
    }
    if (reasons.length) {
      row.alert = true;
      row.alert_reasons = reasons;
      alerts.push({
        sport,
        n_settled: stats.n_settled,
        roi_pct: stats.roi_pct != null ? +stats.roi_pct.toFixed(2) : null,
        hit_rate_pct: stats.hit_rate_pct != null ? +stats.hit_rate_pct.toFixed(1) : null,
        avg_ev: stats.avg_ev != null ? +stats.avg_ev.toFixed(1) : null,
        reasons,
        ts: now,
      });
    }
  }

  return { alerts, breakdown, cfg };
}

module.exports = { runAiShadowAudit, DEFAULTS };

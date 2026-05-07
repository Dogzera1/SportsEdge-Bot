'use strict';

/**
 * shadow-vs-real-drift.js — early-warning detector pra degradação do modelo base.
 *
 * Cenário-alvo: shadow ROI degrada (modelo puro sangrando) enquanto real ROI
 * continua estável (gates filtram piores tips, mascarando degradação). Esse é
 * exatamente o sinal silencioso onde gates "se viram" temporariamente até real
 * também alcançar o problema. Detector dá DM admin antes disso acontecer.
 *
 * P2 compliance: NÃO automatiza ação. Apenas DM informativo. Decisão (revert
 * promote, refit calib, model rollback) fica com humano após análise causal.
 *
 * Métrica:
 *   delta_shadow = ROI_shadow_recent (Nd) - ROI_shadow_baseline (N..2N d)
 *   delta_real   = ROI_real_recent (Nd) - ROI_real_baseline (N..2N d)
 *   gap = delta_shadow - delta_real
 *
 * Alerta quando:
 *   |gap| ≥ alertThresholdPp (default 5pp), AND
 *   delta_shadow ≤ -3pp (shadow piorou, não é noise positivo), AND
 *   amostras suficientes (n_shadow ≥ 30, n_real ≥ 20 em ambas janelas)
 *
 * Cobre 2 fontes de shadow:
 *   - tips is_shadow=1 (ML shadow — sports shadow-only ou ML disabled)
 *   - market_tips_shadow (MT — todos sports)
 * Métrica é unificada per sport (somando os dois universos).
 *
 * Cron 24h. Dedup DM 24h por sport.
 *
 * Envs:
 *   SHADOW_VS_REAL_DRIFT_AUTO=true        (default true) — master switch
 *   SHADOW_VS_REAL_DRIFT_WINDOW_DAYS=14   — janela "recente"
 *   SHADOW_VS_REAL_DRIFT_GAP_PP=5         — gap threshold em pp pra alertar
 *   SHADOW_VS_REAL_DRIFT_SHADOW_DROP_PP=3 — delta_shadow precisa cair ≥ isso
 *   SHADOW_VS_REAL_DRIFT_MIN_N_SHADOW=30  — amostra mínima shadow per janela
 *   SHADOW_VS_REAL_DRIFT_MIN_N_REAL=20    — amostra mínima real per janela
 *   SHADOW_VS_REAL_DRIFT_COOLDOWN_HOURS=24 — dedup DM
 */

const { log } = require('./utils');

const DEFAULTS = {
  windowDays: 14,
  gapThresholdPp: 5,
  shadowDropThresholdPp: 3,
  minNShadow: 30,
  minNReal: 20,
  cooldownHours: 24,
};

const SPORTS = [
  'lol', 'cs', 'cs2', 'dota2', 'valorant',
  'tennis', 'football', 'mma',
  'darts', 'snooker', 'tabletennis', 'basket',
];

function _envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

function _envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

/**
 * ROI shadow per sport entre [start, end] dias (start > end, ambos negativos relativos a now).
 * Soma 2 universos: tips is_shadow=1 + market_tips_shadow.
 *
 * @returns {{n, profit, staked, roi}|null}
 */
function _shadowRoi(db, sport, startDays, endDays) {
  // tips is_shadow=1 — stake é texto ("1u"). Converte via REAL parsing.
  const tipsRow = db.prepare(`
    SELECT
      COUNT(*) AS n,
      SUM(CASE WHEN result='win' THEN
        CAST(REPLACE(REPLACE(LOWER(stake), 'u', ''), ' ', '') AS REAL) * (odds - 1)
        ELSE 0 END) AS profit,
      SUM(CASE WHEN result IN ('win','loss') THEN
        CAST(REPLACE(REPLACE(LOWER(stake), 'u', ''), ' ', '') AS REAL)
        ELSE 0 END) AS staked,
      SUM(CASE WHEN result='loss' THEN
        CAST(REPLACE(REPLACE(LOWER(stake), 'u', ''), ' ', '') AS REAL)
        ELSE 0 END) AS lossStake
    FROM tips
    WHERE sport = ?
      AND is_shadow = 1
      AND result IN ('win','loss')
      AND COALESCE(archived, 0) = 0
      AND sent_at >= datetime('now', '-' || ? || ' days')
      AND sent_at <  datetime('now', '-' || ? || ' days')
  `).get(sport, startDays, endDays);

  const tipsN = Number(tipsRow?.n) || 0;
  const tipsProfit = (Number(tipsRow?.profit) || 0) - (Number(tipsRow?.lossStake) || 0);
  const tipsStaked = Number(tipsRow?.staked) || 0;

  // market_tips_shadow — profit_units/stake_units já em unidades.
  const mtsRow = db.prepare(`
    SELECT
      COUNT(*) AS n,
      SUM(COALESCE(profit_units, 0)) AS profit,
      SUM(CASE WHEN result IN ('win','loss') THEN COALESCE(stake_units, 1) ELSE 0 END) AS staked
    FROM market_tips_shadow
    WHERE sport = ?
      AND result IN ('win','loss')
      AND created_at >= datetime('now', '-' || ? || ' days')
      AND created_at <  datetime('now', '-' || ? || ' days')
  `).get(sport, startDays, endDays);

  const mtsN = Number(mtsRow?.n) || 0;
  const mtsProfit = Number(mtsRow?.profit) || 0;
  const mtsStaked = Number(mtsRow?.staked) || 0;

  const n = tipsN + mtsN;
  const profit = tipsProfit + mtsProfit;
  const staked = tipsStaked + mtsStaked;
  const roi = staked > 0 ? (profit / staked) * 100 : null;
  return { n, profit, staked, roi };
}

/**
 * ROI real per sport entre [start, end] dias.
 * Lê tips is_shadow=0 (real ML+MT promoted). Stake em reais → profit/staked é R$.
 * ROI percentual é unitless ((profit/staked)*100), comparável com shadow units ROI.
 */
function _realRoi(db, sport, startDays, endDays) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS n,
      SUM(COALESCE(profit_reais, 0)) AS profit,
      SUM(CASE WHEN result IN ('win','loss') THEN COALESCE(stake_reais, 0) ELSE 0 END) AS staked
    FROM tips
    WHERE sport = ?
      AND COALESCE(is_shadow, 0) = 0
      AND COALESCE(archived, 0) = 0
      AND result IN ('win','loss')
      AND sent_at >= datetime('now', '-' || ? || ' days')
      AND sent_at <  datetime('now', '-' || ? || ' days')
  `).get(sport, startDays, endDays);
  const n = Number(row?.n) || 0;
  const profit = Number(row?.profit) || 0;
  const staked = Number(row?.staked) || 0;
  const roi = staked > 0 ? (profit / staked) * 100 : null;
  return { n, profit, staked, roi };
}

/**
 * Roda o detector. Retorna lista de alertas + breakdown per sport (mesmo
 * sem alerta) pra debug.
 *
 * @returns {{alerts: Array, breakdown: Array}}
 */
function runShadowVsRealDriftCheck(db, opts = {}) {
  const cfg = {
    windowDays: opts.windowDays || _envInt('SHADOW_VS_REAL_DRIFT_WINDOW_DAYS', DEFAULTS.windowDays),
    gapThresholdPp: opts.gapThresholdPp || _envFloat('SHADOW_VS_REAL_DRIFT_GAP_PP', DEFAULTS.gapThresholdPp),
    shadowDropThresholdPp: opts.shadowDropThresholdPp || _envFloat('SHADOW_VS_REAL_DRIFT_SHADOW_DROP_PP', DEFAULTS.shadowDropThresholdPp),
    minNShadow: opts.minNShadow || _envInt('SHADOW_VS_REAL_DRIFT_MIN_N_SHADOW', DEFAULTS.minNShadow),
    minNReal: opts.minNReal || _envInt('SHADOW_VS_REAL_DRIFT_MIN_N_REAL', DEFAULTS.minNReal),
  };

  const alerts = [];
  const breakdown = [];
  const now = new Date().toISOString();

  for (const sport of SPORTS) {
    // Janelas: recent = [windowDays, 0d), baseline = [2*windowDays, windowDays)
    const window = cfg.windowDays;
    const shadowRecent = _shadowRoi(db, sport, window, 0);
    const shadowBase = _shadowRoi(db, sport, window * 2, window);
    const realRecent = _realRoi(db, sport, window, 0);
    const realBase = _realRoi(db, sport, window * 2, window);

    const sportRow = {
      sport,
      shadow_recent: shadowRecent.roi != null ? +shadowRecent.roi.toFixed(2) : null,
      shadow_baseline: shadowBase.roi != null ? +shadowBase.roi.toFixed(2) : null,
      real_recent: realRecent.roi != null ? +realRecent.roi.toFixed(2) : null,
      real_baseline: realBase.roi != null ? +realBase.roi.toFixed(2) : null,
      n_shadow_recent: shadowRecent.n,
      n_shadow_baseline: shadowBase.n,
      n_real_recent: realRecent.n,
      n_real_baseline: realBase.n,
      delta_shadow: null,
      delta_real: null,
      gap_pp: null,
      alert: false,
    };

    // Gate de amostra: precisa volume nas 4 janelas
    if (shadowRecent.n < cfg.minNShadow || shadowBase.n < cfg.minNShadow
        || realRecent.n < cfg.minNReal || realBase.n < cfg.minNReal) {
      sportRow.skip_reason = 'insufficient_sample';
      breakdown.push(sportRow);
      continue;
    }

    if (shadowRecent.roi == null || shadowBase.roi == null
        || realRecent.roi == null || realBase.roi == null) {
      sportRow.skip_reason = 'null_roi';
      breakdown.push(sportRow);
      continue;
    }

    const deltaShadow = shadowRecent.roi - shadowBase.roi;
    const deltaReal = realRecent.roi - realBase.roi;
    const gap = deltaShadow - deltaReal;
    sportRow.delta_shadow = +deltaShadow.toFixed(2);
    sportRow.delta_real = +deltaReal.toFixed(2);
    sportRow.gap_pp = +gap.toFixed(2);

    // Alerta quando shadow caiu mais do que real, com magnitude relevante.
    // gap negativo + shadow drop substancial = early warning de model decay.
    const shadowDropped = deltaShadow <= -cfg.shadowDropThresholdPp;
    const gapNegative = gap <= -cfg.gapThresholdPp;
    if (shadowDropped && gapNegative) {
      sportRow.alert = true;
      alerts.push({
        sport,
        delta_shadow: sportRow.delta_shadow,
        delta_real: sportRow.delta_real,
        gap_pp: sportRow.gap_pp,
        n_shadow: shadowRecent.n,
        n_real: realRecent.n,
        roi_shadow_recent: sportRow.shadow_recent,
        roi_real_recent: sportRow.real_recent,
        ts: now,
      });
    }
    breakdown.push(sportRow);
  }

  return { alerts, breakdown, cfg };
}

module.exports = { runShadowVsRealDriftCheck, DEFAULTS };

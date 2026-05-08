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
 * 2026-05-08: market filter opcional (P1 granularidade — ML drift ≠ MT drift).
 *   - market='ML': só tips ML shadow universe (tips.is_shadow=1, market_type IN ML markets)
 *   - market='MT': só market_tips_shadow + tips ML shadow excluídas
 *   - market=null (default): comportamento legado (soma ambos)
 *
 * @returns {{n, profit, staked, roi}|null}
 */
function _shadowRoi(db, sport, startDays, endDays, market = null) {
  // tips is_shadow=1 — stake é texto ("1u"). Converte via REAL parsing.
  // ML markets espelha lib/constants ML_MARKETS_LIST.
  const ML_MARKETS_SQL = "('ML', '1X2_H', '1X2_A', '1X2_D', 'OVER_2.5', 'UNDER_2.5')";
  const filterTipsML = market === 'MT' ? `AND UPPER(COALESCE(market_type, 'ML')) NOT IN ${ML_MARKETS_SQL}`
                      : market === 'ML' ? `AND UPPER(COALESCE(market_type, 'ML')) IN ${ML_MARKETS_SQL}`
                      : '';
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
      ${filterTipsML}
  `).get(sport, startDays, endDays);

  const tipsN = Number(tipsRow?.n) || 0;
  const tipsProfit = (Number(tipsRow?.profit) || 0) - (Number(tipsRow?.lossStake) || 0);
  const tipsStaked = Number(tipsRow?.staked) || 0;

  // market_tips_shadow — profit_units/stake_units já em unidades.
  // Quando market='ML', skipamos market_tips_shadow inteira (são todas non-ML).
  let mtsN = 0, mtsProfit = 0, mtsStaked = 0;
  if (market !== 'ML') {
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
    mtsN = Number(mtsRow?.n) || 0;
    mtsProfit = Number(mtsRow?.profit) || 0;
    mtsStaked = Number(mtsRow?.staked) || 0;
  }

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
 *
 * 2026-05-08: market filter opcional (ver _shadowRoi).
 */
function _realRoi(db, sport, startDays, endDays, market = null) {
  const ML_MARKETS_SQL = "('ML', '1X2_H', '1X2_A', '1X2_D', 'OVER_2.5', 'UNDER_2.5')";
  const filterMl = market === 'MT' ? `AND UPPER(COALESCE(market_type, 'ML')) NOT IN ${ML_MARKETS_SQL}`
                  : market === 'ML' ? `AND UPPER(COALESCE(market_type, 'ML')) IN ${ML_MARKETS_SQL}`
                  : '';
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
      ${filterMl}
  `).get(sport, startDays, endDays);
  const n = Number(row?.n) || 0;
  const profit = Number(row?.profit) || 0;
  const staked = Number(row?.staked) || 0;
  const roi = staked > 0 ? (profit / staked) * 100 : null;
  return { n, profit, staked, roi };
}

/**
 * Computa a row de drift pra um par (sport, market). market=null = legacy
 * (sport-wide soma ML+MT). Compartilhado entre groupBy=sport e groupBy=sport_market.
 */
function _buildRow(db, sport, market, cfg, now) {
  const window = cfg.windowDays;
  const shadowRecent = _shadowRoi(db, sport, window, 0, market);
  const shadowBase = _shadowRoi(db, sport, window * 2, window, market);
  const realRecent = _realRoi(db, sport, window, 0, market);
  const realBase = _realRoi(db, sport, window * 2, window, market);

  const row = {
    sport,
    ...(market ? { market } : {}),
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

  if (shadowRecent.n < cfg.minNShadow || shadowBase.n < cfg.minNShadow
      || realRecent.n < cfg.minNReal || realBase.n < cfg.minNReal) {
    row.skip_reason = 'insufficient_sample';
    return { row, alerted: false };
  }
  if (shadowRecent.roi == null || shadowBase.roi == null
      || realRecent.roi == null || realBase.roi == null) {
    row.skip_reason = 'null_roi';
    return { row, alerted: false };
  }

  const deltaShadow = shadowRecent.roi - shadowBase.roi;
  const deltaReal = realRecent.roi - realBase.roi;
  const gap = deltaShadow - deltaReal;
  row.delta_shadow = +deltaShadow.toFixed(2);
  row.delta_real = +deltaReal.toFixed(2);
  row.gap_pp = +gap.toFixed(2);

  const shadowDropped = deltaShadow <= -cfg.shadowDropThresholdPp;
  const gapNegative = gap <= -cfg.gapThresholdPp;
  if (shadowDropped && gapNegative) {
    row.alert = true;
    return {
      row,
      alerted: true,
      alertEntry: {
        sport,
        ...(market ? { market } : {}),
        delta_shadow: row.delta_shadow,
        delta_real: row.delta_real,
        gap_pp: row.gap_pp,
        n_shadow: shadowRecent.n,
        n_real: realRecent.n,
        roi_shadow_recent: row.shadow_recent,
        roi_real_recent: row.real_recent,
        ts: now,
      },
    };
  }
  return { row, alerted: false };
}

/**
 * Roda o detector. Retorna lista de alertas + breakdown per (sport[, market]).
 *
 * 2026-05-08: opção groupBy='sport_market' splita ML vs MT (P1 granularidade —
 * model drift difere entre universos: ML calib pode degradar enquanto MT
 * permanece estável, ou vice-versa).
 *
 * @param {Object} opts
 * @param {string} [opts.groupBy='sport']  'sport' (default, legado) | 'sport_market'
 * @returns {{alerts: Array, breakdown: Array, cfg: Object, groupBy: string}}
 */
function runShadowVsRealDriftCheck(db, opts = {}) {
  const cfg = {
    windowDays: opts.windowDays || _envInt('SHADOW_VS_REAL_DRIFT_WINDOW_DAYS', DEFAULTS.windowDays),
    gapThresholdPp: opts.gapThresholdPp || _envFloat('SHADOW_VS_REAL_DRIFT_GAP_PP', DEFAULTS.gapThresholdPp),
    shadowDropThresholdPp: opts.shadowDropThresholdPp || _envFloat('SHADOW_VS_REAL_DRIFT_SHADOW_DROP_PP', DEFAULTS.shadowDropThresholdPp),
    minNShadow: opts.minNShadow || _envInt('SHADOW_VS_REAL_DRIFT_MIN_N_SHADOW', DEFAULTS.minNShadow),
    minNReal: opts.minNReal || _envInt('SHADOW_VS_REAL_DRIFT_MIN_N_REAL', DEFAULTS.minNReal),
  };
  const groupBy = opts.groupBy === 'sport_market' ? 'sport_market' : 'sport';

  const alerts = [];
  const breakdown = [];
  const now = new Date().toISOString();
  const markets = groupBy === 'sport_market' ? ['ML', 'MT'] : [null];

  for (const sport of SPORTS) {
    for (const market of markets) {
      const r = _buildRow(db, sport, market, cfg, now);
      breakdown.push(r.row);
      if (r.alerted) alerts.push(r.alertEntry);
    }
  }

  return { alerts, breakdown, cfg, groupBy };
}

module.exports = { runShadowVsRealDriftCheck, DEFAULTS };

'use strict';

/**
 * lib/analytics-metrics.js — métricas avançadas (DAX-equivalent) sobre tips.
 *
 * Cada função retorna { ok, metric, sport, days, rows[], summary{} }. Usa
 * lib/analytics (DuckDB) sob o capô.
 *
 * Métricas:
 *   - rollingSharpe       Sharpe ratio diário per sport (avg/std × sqrt(N))
 *   - kellyEfficiency     stake real / kelly teórico (sub/sobre-betting)
 *   - leagueVariance      ROI variance por liga (n≥3) — flag concentração risco
 *   - cohortSurvival      tips emitidas dia X, ROI cumulativo +1d/+7d/+30d
 *   - clvDrift            avg open→clv shift per sport (sharp money signal)
 */

const { query } = require('./analytics');

const _DEFAULT_DAYS = 30;

/**
 * Rolling Sharpe ratio per sport: profit/stake aggregated daily, then
 *   sharpe = mean(daily_roi) / stddev(daily_roi) × sqrt(N_days)
 * Sports com <5 dias úteis settled retornam sharpe=null.
 *
 * Interpretação:
 *   Sharpe > 1.0  → consistent edge (target)
 *   0 < Sharpe ≤ 1 → marginal alpha
 *   Sharpe < 0    → losing system
 */
async function rollingSharpe(opts = {}) {
  const days = Math.max(7, Math.min(180, opts.days || _DEFAULT_DAYS));
  const sport = opts.sport || null;
  const sportFilter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  const sql = `
    WITH daily AS (
      SELECT sport,
             CAST(settled_at AS DATE) AS day,
             SUM(COALESCE(profit_reais, 0)) AS profit,
             SUM(COALESCE(stake_reais, 0)) AS stake,
             COUNT(*) AS n
        FROM sd.tips
       WHERE result IN ('win','loss')
         AND COALESCE(is_shadow, 0) = 0
         AND COALESCE(archived, 0) = 0
         AND CAST(settled_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
         ${sportFilter}
       GROUP BY sport, CAST(settled_at AS DATE)
       HAVING SUM(COALESCE(stake_reais, 0)) > 0
    )
    SELECT sport,
           COUNT(*) AS n_days,
           SUM(n) AS n_tips,
           ROUND(AVG(profit / stake) * 100, 2) AS avg_daily_roi_pct,
           ROUND(STDDEV(profit / stake) * 100, 2) AS std_daily_roi_pct,
           ROUND(SUM(profit), 2) AS total_profit,
           ROUND(SUM(stake), 2) AS total_stake,
           CASE WHEN COUNT(*) >= 5 AND STDDEV(profit / stake) > 0
                THEN ROUND(AVG(profit / stake) / STDDEV(profit / stake) * SQRT(COUNT(*)), 3)
                ELSE NULL END AS sharpe_ratio
      FROM daily
     GROUP BY sport
     ORDER BY sharpe_ratio DESC NULLS LAST`;
  const rows = await query(sql);
  return {
    ok: true, metric: 'rollingSharpe', days, sport,
    note: 'Sharpe = mean(daily_roi) / std(daily_roi) × sqrt(N_days). >1 ideal, <0 leak.',
    rows,
  };
}

/**
 * Kelly efficiency: stake usado vs Kelly teórico do modelo.
 *   kelly_theoretical = (b * p - q) / b   (b=odds-1, p=model_p_pick, q=1-p)
 *   kelly_actual      = stake_reais / banca
 *   efficiency        = actual / theoretical
 * <1 = under-betting (deixa EV na mesa), >1 = over-leveraged (variance bomb).
 *
 * Usa banca BRL=R$100 baseline (alocação por sport pós-rebalance 2026-04-24).
 */
async function kellyEfficiency(opts = {}) {
  const days = Math.max(7, Math.min(180, opts.days || _DEFAULT_DAYS));
  const sport = opts.sport || null;
  const sportFilter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  const banca = parseFloat(opts.banca || 100);
  const sql = `
    WITH base AS (
      SELECT sport, market_type,
             odds, model_p_pick AS p,
             stake_reais,
             CASE WHEN odds > 1 AND model_p_pick > 0 AND model_p_pick < 1
                  THEN (model_p_pick * (odds - 1) - (1 - model_p_pick)) / (odds - 1)
                  ELSE NULL END AS kelly_theoretical
        FROM sd.tips
       WHERE result IN ('win','loss')
         AND model_p_pick IS NOT NULL
         AND odds IS NOT NULL
         AND stake_reais IS NOT NULL
         AND COALESCE(is_shadow, 0) = 0
         AND COALESCE(archived, 0) = 0
         AND CAST(sent_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
         ${sportFilter}
    )
    SELECT sport, market_type,
           COUNT(*) AS n,
           ROUND(AVG(kelly_theoretical) * 100, 2) AS avg_kelly_theoretical_pct,
           ROUND(AVG(stake_reais / ${banca}) * 100, 2) AS avg_actual_pct,
           ROUND(AVG((stake_reais / ${banca}) / NULLIF(kelly_theoretical, 0)), 2) AS avg_efficiency,
           SUM(CASE WHEN kelly_theoretical IS NOT NULL AND kelly_theoretical < 0 THEN 1 ELSE 0 END) AS n_neg_kelly
      FROM base
     WHERE kelly_theoretical IS NOT NULL AND kelly_theoretical > 0
     GROUP BY sport, market_type
     HAVING n >= 3
     ORDER BY n DESC`;
  const rows = await query(sql);
  return {
    ok: true, metric: 'kellyEfficiency', days, sport, banca,
    note: 'Efficiency = (stake/banca) / kelly_theoretical. <1 under-bet (EV perdido), >1 over-leveraged.',
    rows,
  };
}

/**
 * League variance: per (sport, league) ROI + std dev profit. Liga com std
 * elevado vs ROI marginal = ruído (concentração de risco). Pra n≥3 settled.
 */
async function leagueVariance(opts = {}) {
  const days = Math.max(7, Math.min(180, opts.days || _DEFAULT_DAYS));
  const minN = parseInt(opts.minN || 3, 10);
  const sport = opts.sport || null;
  const sportFilter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  const sql = `
    SELECT sport,
           event_name AS league,
           COUNT(*) AS n,
           SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
           ROUND(SUM(profit_reais), 2) AS profit,
           ROUND(SUM(stake_reais), 2) AS stake,
           CASE WHEN SUM(stake_reais) > 0
                THEN ROUND(SUM(profit_reais) / SUM(stake_reais) * 100, 2)
                ELSE NULL END AS roi_pct,
           ROUND(STDDEV(profit_reais / NULLIF(stake_reais, 0)) * 100, 2) AS std_per_tip_pct,
           ROUND(AVG(odds), 2) AS avg_odd,
           ROUND(AVG(ev), 2) AS avg_ev
      FROM sd.tips
     WHERE result IN ('win','loss')
       AND COALESCE(is_shadow, 0) = 0
       AND COALESCE(archived, 0) = 0
       AND CAST(sent_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
       ${sportFilter}
     GROUP BY sport, event_name
     HAVING COUNT(*) >= ${minN}
     ORDER BY profit ASC`;
  const rows = await query(sql);
  return {
    ok: true, metric: 'leagueVariance', days, sport, minN,
    note: 'std_per_tip > |roi|×2 indica ruído > sinal. Considere blocklist.',
    rows,
  };
}

/**
 * Cohort survival: tips emitidas em dia X, % settled e ROI cumulativo aos
 *   1d, 7d, 30d post-emission. Curva de "decay" — tips MT esports settle
 *   rápido (24-72h), tennis ATP 1d, football até 5d.
 */
async function cohortSurvival(opts = {}) {
  const days = Math.max(7, Math.min(90, opts.days || _DEFAULT_DAYS));
  const sport = opts.sport || null;
  const sportFilter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  const sql = `
    WITH cohort AS (
      SELECT id, sport,
             CAST(sent_at AS DATE) AS emit_day,
             sent_at, settled_at, result,
             COALESCE(profit_reais, 0) AS profit,
             COALESCE(stake_reais, 0) AS stake,
             CASE WHEN settled_at IS NOT NULL
                  THEN EXTRACT(epoch FROM (CAST(settled_at AS TIMESTAMP) - CAST(sent_at AS TIMESTAMP))) / 86400.0
                  ELSE NULL END AS settle_days
        FROM sd.tips
       WHERE COALESCE(is_shadow, 0) = 0
         AND COALESCE(archived, 0) = 0
         AND CAST(sent_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
         ${sportFilter}
    )
    SELECT sport,
           COUNT(*) AS n_total,
           SUM(CASE WHEN result IN ('win','loss','void') THEN 1 ELSE 0 END) AS n_settled,
           SUM(CASE WHEN result IN ('win','loss','void') AND settle_days <= 1 THEN 1 ELSE 0 END) AS settled_1d,
           SUM(CASE WHEN result IN ('win','loss','void') AND settle_days <= 7 THEN 1 ELSE 0 END) AS settled_7d,
           ROUND(AVG(CASE WHEN result IN ('win','loss') THEN settle_days ELSE NULL END), 2) AS avg_settle_days,
           ROUND(SUM(CASE WHEN result IN ('win','loss') AND settle_days <= 1 THEN profit ELSE 0 END), 2) AS profit_1d,
           ROUND(SUM(CASE WHEN result IN ('win','loss') AND settle_days <= 7 THEN profit ELSE 0 END), 2) AS profit_7d,
           ROUND(SUM(CASE WHEN result IN ('win','loss') THEN profit ELSE 0 END), 2) AS profit_total,
           SUM(CASE WHEN result IS NULL THEN 1 ELSE 0 END) AS n_pending
      FROM cohort
     GROUP BY sport
     ORDER BY n_total DESC`;
  const rows = await query(sql);
  return {
    ok: true, metric: 'cohortSurvival', days, sport,
    note: 'avg_settle_days alto + n_pending alto = settle path lento ou tips órfãs.',
    rows,
  };
}

/**
 * CLV drift: pra cada sport, avg shift entre open_odds (taken) e clv_odds
 *   (closing). drift% = (open/clv - 1) × 100. Positivo = pegamos linha melhor
 *   que close (alpha real). Negativo = mercado moveu contra nós (modelo errado
 *   ou stale).
 *
 * Cobertura: % tips com CLV captado vs total. Audit revelou 21% tennis real;
 *   mig 080 + capturePromotedMtTipsClv (2026-05-04) deve subir pra 80%+.
 */
async function clvDrift(opts = {}) {
  const days = Math.max(7, Math.min(180, opts.days || _DEFAULT_DAYS));
  const sport = opts.sport || null;
  const sportFilter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  const sql = `
    SELECT sport,
           COUNT(*) AS n_total,
           SUM(CASE WHEN clv_odds IS NOT NULL THEN 1 ELSE 0 END) AS n_with_clv,
           ROUND(SUM(CASE WHEN clv_odds IS NOT NULL THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS clv_capture_rate_pct,
           ROUND(AVG(CASE WHEN clv_odds IS NOT NULL AND clv_odds > 1 AND open_odds IS NOT NULL AND open_odds > 1
                    THEN (open_odds / clv_odds - 1) * 100 ELSE NULL END), 2) AS avg_clv_pct,
           SUM(CASE WHEN clv_odds IS NOT NULL AND clv_odds > 1 AND open_odds IS NOT NULL AND open_odds > 1
                    AND (open_odds / clv_odds - 1) > 0.005 THEN 1 ELSE 0 END) AS n_positive_clv,
           SUM(CASE WHEN clv_odds IS NOT NULL AND clv_odds > 1 AND open_odds IS NOT NULL AND open_odds > 1
                    AND (open_odds / clv_odds - 1) < -0.005 THEN 1 ELSE 0 END) AS n_negative_clv,
           ROUND(AVG(open_odds), 2) AS avg_open,
           ROUND(AVG(clv_odds), 2) AS avg_close
      FROM sd.tips
     WHERE COALESCE(is_shadow, 0) = 0
       AND COALESCE(archived, 0) = 0
       AND CAST(sent_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
       ${sportFilter}
     GROUP BY sport
     HAVING COUNT(*) >= 5
     ORDER BY n_with_clv DESC`;
  const rows = await query(sql);
  return {
    ok: true, metric: 'clvDrift', days, sport,
    note: 'avg_clv > 1% + capture_rate > 70% = skill confirmado. <0% persistente = modelo errado ou execução lenta.',
    rows,
  };
}

const _METRICS = {
  sharpe: rollingSharpe,
  kelly: kellyEfficiency,
  variance: leagueVariance,
  cohort: cohortSurvival,
  clv: clvDrift,
};

/**
 * Dispatch genérico: getMetric('sharpe', { days: 30, sport: 'tennis' }).
 */
async function getMetric(name, opts = {}) {
  const fn = _METRICS[String(name || '').toLowerCase()];
  if (!fn) throw new Error(`unknown metric: ${name} (available: ${Object.keys(_METRICS).join(', ')})`);
  return fn(opts);
}

module.exports = {
  rollingSharpe,
  kellyEfficiency,
  leagueVariance,
  cohortSurvival,
  clvDrift,
  getMetric,
  _METRICS_LIST: Object.keys(_METRICS),
};

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

/**
 * Brier score per sport: mean((p_model - outcome)^2). 0 = perfeito, 0.25 = baseline
 *   coin flip. Lower = melhor calibração. Comparar com Brier baseline (avg result
 *   rate) pra detectar se modelo agrega valor.
 */
async function brierScore(opts = {}) {
  const days = Math.max(7, Math.min(180, opts.days || _DEFAULT_DAYS));
  const sport = opts.sport || null;
  const sportFilter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  const sql = `
    WITH base AS (
      SELECT sport, market_type,
             model_p_pick AS p,
             CASE WHEN result = 'win' THEN 1 ELSE 0 END AS outcome,
             stake_reais
        FROM sd.tips
       WHERE result IN ('win','loss')
         AND model_p_pick IS NOT NULL AND model_p_pick > 0 AND model_p_pick < 1
         AND COALESCE(is_shadow, 0) = 0
         AND COALESCE(archived, 0) = 0
         AND CAST(sent_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
         ${sportFilter}
    )
    SELECT sport,
           COUNT(*) AS n,
           ROUND(AVG((p - outcome) * (p - outcome)), 4) AS brier,
           ROUND(AVG(p), 3) AS avg_p_model,
           ROUND(AVG(outcome), 3) AS hit_rate,
           ROUND(AVG(outcome) * (1 - AVG(outcome)), 4) AS brier_baseline,
           ROUND((AVG(outcome) * (1 - AVG(outcome))) - AVG((p - outcome) * (p - outcome)), 4) AS brier_skill
      FROM base
     GROUP BY sport
     HAVING n >= 5
     ORDER BY brier_skill DESC NULLS LAST`;
  const rows = await query(sql);
  return {
    ok: true, metric: 'brier', days, sport,
    note: 'brier_skill > 0 = modelo melhor que coin-flip baseline. <0 = pior que random.',
    rows,
  };
}

/**
 * EV bucket performance: tips grouped por (sport, EV bucket). Confirma audit
 *   2026-05-01 (bucket >12% sangrando). Baseline pro EV calibration loop.
 */
async function evBucketPivot(opts = {}) {
  const days = Math.max(7, Math.min(180, opts.days || _DEFAULT_DAYS));
  const sport = opts.sport || null;
  const sportFilter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  const sql = `
    SELECT sport,
           CASE WHEN ev < 3 THEN '0-3'
                WHEN ev < 5 THEN '3-5'
                WHEN ev < 8 THEN '5-8'
                WHEN ev < 12 THEN '8-12'
                ELSE '>12' END AS ev_bucket,
           COUNT(*) AS n,
           SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
           ROUND(SUM(profit_reais), 2) AS profit,
           ROUND(SUM(stake_reais), 2) AS stake,
           CASE WHEN SUM(stake_reais) > 0
                THEN ROUND(SUM(profit_reais) / SUM(stake_reais) * 100, 1)
                ELSE NULL END AS roi_pct,
           ROUND(AVG(odds), 2) AS avg_odd
      FROM sd.tips
     WHERE result IN ('win','loss')
       AND ev IS NOT NULL
       AND COALESCE(is_shadow, 0) = 0
       AND COALESCE(archived, 0) = 0
       AND CAST(sent_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
       ${sportFilter}
     GROUP BY sport, ev_bucket
     HAVING n >= 2
     ORDER BY sport, ev_bucket`;
  const rows = await query(sql);
  return {
    ok: true, metric: 'evBucket', days, sport,
    note: 'Audit 2026-05-01: bucket >12% leak persistente em LoL/CS/Tennis. EV cap reduzido.',
    rows,
  };
}

/**
 * Time-of-day heatmap: hora UTC × sport ROI. Detecta janelas tóxicas (asia
 *   noturna, etc). Wired via env TIME_OF_DAY_AUTO=true (gate em record-tip).
 */
async function timeOfDayHeatmap(opts = {}) {
  const days = Math.max(7, Math.min(180, opts.days || _DEFAULT_DAYS));
  const sport = opts.sport || null;
  const sportFilter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  const sql = `
    SELECT sport,
           CAST(strftime(CAST(settled_at AS TIMESTAMP), '%H') AS INTEGER) AS hour_utc,
           COUNT(*) AS n,
           SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
           ROUND(SUM(profit_reais), 2) AS profit,
           ROUND(SUM(stake_reais), 2) AS stake,
           CASE WHEN SUM(stake_reais) > 0
                THEN ROUND(SUM(profit_reais) / SUM(stake_reais) * 100, 1)
                ELSE NULL END AS roi_pct
      FROM sd.tips
     WHERE result IN ('win','loss')
       AND COALESCE(is_shadow, 0) = 0
       AND COALESCE(archived, 0) = 0
       AND CAST(settled_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
       ${sportFilter}
     GROUP BY sport, hour_utc
     HAVING n >= 2
     ORDER BY sport, hour_utc`;
  const rows = await query(sql);
  return {
    ok: true, metric: 'timeOfDay', days, sport,
    note: 'Bucket horário com ROI <-25% n≥8 = candidato block via TIME_OF_DAY_AUTO env.',
    rows,
  };
}

/**
 * Drawdown analysis: equity curve diário per sport + max DD + recovery time.
 *   Window function calcula running_max e drawdown vs peak.
 */
async function drawdownAnalysis(opts = {}) {
  const days = Math.max(14, Math.min(180, opts.days || _DEFAULT_DAYS));
  const sport = opts.sport || null;
  const sportFilter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  const sql = `
    WITH daily AS (
      SELECT sport,
             CAST(settled_at AS DATE) AS day,
             SUM(COALESCE(profit_reais, 0)) AS profit
        FROM sd.tips
       WHERE result IN ('win','loss')
         AND COALESCE(is_shadow, 0) = 0
         AND COALESCE(archived, 0) = 0
         AND CAST(settled_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
         ${sportFilter}
       GROUP BY sport, CAST(settled_at AS DATE)
    ),
    cum AS (
      SELECT sport, day, profit,
             SUM(profit) OVER (PARTITION BY sport ORDER BY day) AS cum_profit
        FROM daily
    ),
    dd AS (
      SELECT sport, day, cum_profit,
             MAX(cum_profit) OVER (PARTITION BY sport ORDER BY day) AS peak,
             cum_profit - MAX(cum_profit) OVER (PARTITION BY sport ORDER BY day) AS drawdown,
             ROW_NUMBER() OVER (PARTITION BY sport ORDER BY day DESC) AS rn_desc
        FROM cum
    ),
    summary AS (
      SELECT sport,
             COUNT(*) AS n_days,
             MIN(drawdown) AS min_drawdown,
             MAX(cum_profit) AS peak_profit
        FROM dd
       GROUP BY sport
    ),
    latest AS (
      SELECT sport, cum_profit AS current_profit
        FROM dd WHERE rn_desc = 1
    )
    SELECT s.sport,
           s.n_days,
           ROUND(s.min_drawdown, 2) AS max_drawdown,
           ROUND(s.peak_profit, 2) AS peak_profit,
           ROUND(l.current_profit, 2) AS current_profit,
           ROUND(s.min_drawdown / NULLIF(s.peak_profit, 0) * 100, 1) AS max_dd_pct
      FROM summary s
      LEFT JOIN latest l USING (sport)
     ORDER BY max_drawdown ASC`;
  const rows = await query(sql);
  return {
    ok: true, metric: 'drawdown', days, sport,
    note: 'max_dd_pct < -20% = sport em distress (DRAWDOWN_HARD_LIMIT bloqueia >25%).',
    rows,
  };
}

/**
 * Calibration bins: tips agrupadas em 10 bins por model_p_pick (0-10%, 10-20%
 *   ... 90-100%). Pra cada bin compute hit rate real. Modelo bem calibrado
 *   tem hit_rate ≈ avg_p_model em cada bin (linha y=x). Desvio = miscalibration.
 *
 * Útil pra:
 *   - Detectar overconfidence (bin 80-90% com hit 60% = modelo super-confident)
 *   - Validar isotonic regression funcionando
 *   - Sinalizar necessidade de refit
 */
async function calibrationBins(opts = {}) {
  const days = Math.max(7, Math.min(180, opts.days || _DEFAULT_DAYS));
  const sport = opts.sport || null;
  const sportFilter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  const sql = `
    WITH base AS (
      SELECT sport,
             FLOOR(model_p_pick * 10) AS bin,
             model_p_pick AS p,
             CASE WHEN result = 'win' THEN 1 ELSE 0 END AS hit
        FROM sd.tips
       WHERE result IN ('win','loss')
         AND model_p_pick IS NOT NULL AND model_p_pick > 0 AND model_p_pick < 1
         AND COALESCE(is_shadow, 0) = 0
         AND COALESCE(archived, 0) = 0
         AND CAST(sent_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
         ${sportFilter}
    )
    SELECT sport,
           CAST(bin AS INTEGER) AS bin_idx,
           CONCAT(CAST(bin * 10 AS INTEGER), '-', CAST((bin + 1) * 10 AS INTEGER), '%') AS bin_label,
           COUNT(*) AS n,
           ROUND(AVG(p) * 100, 1) AS avg_predicted_pct,
           ROUND(AVG(hit) * 100, 1) AS actual_hit_pct,
           ROUND((AVG(hit) - AVG(p)) * 100, 1) AS calib_gap_pp
      FROM base
     GROUP BY sport, bin
     HAVING n >= 3
     ORDER BY sport, bin_idx`;
  const rows = await query(sql);
  return {
    ok: true, metric: 'calibration', days, sport,
    note: 'calib_gap_pp ~0 = bem calibrado. >+5pp = under-confident; <-5pp = over-confident.',
    rows,
  };
}

/**
 * Market × Sport ROI matrix: pivot (sport, market_type) com ROI/n/profit.
 *   Detecta interações: ML lol leak vs HG tennis ganha (já mapeado em audit
 *   2026-05-04 mas visualizar matriz facilita decisão de gates futuros).
 */
async function marketSportPivot(opts = {}) {
  const days = Math.max(7, Math.min(180, opts.days || _DEFAULT_DAYS));
  const sql = `
    SELECT sport,
           UPPER(COALESCE(market_type, 'ML')) AS market_type,
           COUNT(*) AS n,
           SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
           ROUND(SUM(profit_reais), 2) AS profit,
           ROUND(SUM(stake_reais), 2) AS stake,
           CASE WHEN SUM(stake_reais) > 0
                THEN ROUND(SUM(profit_reais) / SUM(stake_reais) * 100, 1)
                ELSE NULL END AS roi_pct,
           ROUND(AVG(odds), 2) AS avg_odd,
           ROUND(AVG(ev), 2) AS avg_ev
      FROM sd.tips
     WHERE result IN ('win','loss')
       AND COALESCE(is_shadow, 0) = 0
       AND COALESCE(archived, 0) = 0
       AND CAST(sent_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
     GROUP BY sport, UPPER(COALESCE(market_type, 'ML'))
     HAVING n >= 2
     ORDER BY profit ASC`;
  const rows = await query(sql);
  return {
    ok: true, metric: 'marketSport', days,
    note: 'Cells vermelhas = leak (alvo block). Verdes = scale up. Compare com /admin/blocklist-stats.',
    rows,
  };
}

/**
 * Streak analysis: longest win/loss/void streaks per sport + current streak.
 *   Useful pra detectar tilt windows (5+ losses streak = stop-loss trigger).
 *   Window function tracks transitions via LAG.
 */
async function streakAnalysis(opts = {}) {
  const days = Math.max(7, Math.min(180, opts.days || _DEFAULT_DAYS));
  const sport = opts.sport || null;
  const sportFilter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  // Strategy: para cada sport, ordena por sent_at, identifica grupos de
  // resultados consecutivos via running sum de "result mudou" (gaps-and-islands).
  const sql = `
    WITH ordered AS (
      SELECT sport, sent_at, result,
             LAG(result) OVER (PARTITION BY sport ORDER BY sent_at) AS prev_result
        FROM sd.tips
       WHERE result IN ('win','loss','void')
         AND COALESCE(is_shadow, 0) = 0
         AND COALESCE(archived, 0) = 0
         AND CAST(sent_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
         ${sportFilter}
    ),
    grp AS (
      SELECT sport, sent_at, result,
             SUM(CASE WHEN result = prev_result OR prev_result IS NULL THEN 0 ELSE 1 END)
                 OVER (PARTITION BY sport ORDER BY sent_at ROWS UNBOUNDED PRECEDING) AS group_id
        FROM ordered
    ),
    streaks AS (
      SELECT sport, result, group_id, COUNT(*) AS streak_len,
             MIN(sent_at) AS streak_start, MAX(sent_at) AS streak_end
        FROM grp
       GROUP BY sport, result, group_id
    ),
    last_streak AS (
      SELECT sport, result AS current_result, streak_len AS current_streak
        FROM streaks s
       WHERE streak_end = (SELECT MAX(streak_end) FROM streaks s2 WHERE s2.sport = s.sport)
    )
    SELECT s.sport,
           COUNT(*) AS n_streaks,
           MAX(CASE WHEN s.result = 'win' THEN s.streak_len ELSE 0 END) AS longest_win,
           MAX(CASE WHEN s.result = 'loss' THEN s.streak_len ELSE 0 END) AS longest_loss,
           MAX(CASE WHEN s.result = 'void' THEN s.streak_len ELSE 0 END) AS longest_void,
           ANY_VALUE(l.current_result) AS current_result,
           ANY_VALUE(l.current_streak) AS current_streak
      FROM streaks s
      LEFT JOIN last_streak l ON s.sport = l.sport
     GROUP BY s.sport
     ORDER BY longest_loss DESC`;
  const rows = await query(sql);
  return {
    ok: true, metric: 'streak', days, sport,
    note: 'longest_loss ≥5 = tilt risk window. current_result=loss + streak ≥3 = pause real path.',
    rows,
  };
}

const _METRICS = {
  sharpe: rollingSharpe,
  kelly: kellyEfficiency,
  variance: leagueVariance,
  cohort: cohortSurvival,
  clv: clvDrift,
  brier: brierScore,
  evbucket: evBucketPivot,
  timeofday: timeOfDayHeatmap,
  drawdown: drawdownAnalysis,
  calibration: calibrationBins,
  marketsport: marketSportPivot,
  streak: streakAnalysis,
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
  brierScore,
  evBucketPivot,
  timeOfDayHeatmap,
  drawdownAnalysis,
  calibrationBins,
  marketSportPivot,
  streakAnalysis,
  getMetric,
  _METRICS_LIST: Object.keys(_METRICS),
};

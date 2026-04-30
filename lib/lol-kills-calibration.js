'use strict';

/**
 * lib/lol-kills-calibration.js — métrica rolling de calibração do modelo de
 * kills (total_kills_map<N>) usando market_tips_shadow settled.
 *
 * Brier per-tip: (p_model - outcome)^2  onde outcome = 1 (win) | 0 (loss).
 * push/void excluídos.
 * ECE (Expected Calibration Error): bin p_model em buckets de 0.1, calcula
 *   |mean(p_model) - mean(outcome)| ponderado por tamanho do bucket.
 * MAE: |mean(p_model) - hit_rate|.
 */

const { log } = require('./utils');

function _outcomeBinary(result) {
  if (result === 'win') return 1;
  if (result === 'loss') return 0;
  return null;
}

/**
 * Computa métricas de calibração agregadas.
 * @param {object} db
 * @param {object} opts { days=14, sport='lol', minN=10, leagueLike }
 * @returns {{ overall, byLeague, byBucket }}
 */
function computeKillsCalibration(db, opts = {}) {
  const days = Math.max(3, Math.min(180, opts.days || 14));
  const sport = opts.sport || 'lol';
  const minN = opts.minN ?? 10;
  const leagueClause = opts.leagueLike ? `AND league LIKE ?` : '';
  const args = [sport, `-${days} days`];
  if (opts.leagueLike) args.push(`%${opts.leagueLike}%`);

  const rows = db.prepare(`
    SELECT id, league, market, line, side, p_model, ev_pct, odd, result, profit_units,
           created_at, settled_at
    FROM market_tips_shadow
    WHERE sport = ?
      AND market LIKE 'total_kills_%'
      AND result IN ('win','loss')
      AND created_at >= datetime('now', ?)
      ${leagueClause}
    ORDER BY created_at DESC
    LIMIT 5000
  `).all(...args);

  if (!rows.length) return { ok: true, n: 0, overall: null, byLeague: [], byBucket: [] };

  // Overall
  let sse = 0, sumP = 0, sumOutcome = 0, n = 0;
  let profit = 0, stake = 0;
  const buckets = new Map(); // p_bucket → { n, sumP, sumOutcome }
  const byLeague = new Map();

  for (const r of rows) {
    const o = _outcomeBinary(r.result);
    if (o == null || !Number.isFinite(r.p_model)) continue;
    const p = Math.max(0, Math.min(1, r.p_model));
    sse += Math.pow(p - o, 2);
    sumP += p;
    sumOutcome += o;
    n++;
    profit += Number(r.profit_units || 0);
    stake += 1; // 1u baseline (stake_units é Kelly-ajustado, usar uniform pra hit rate)

    // Bucket de p_model em steps de 0.1
    const bucket = Math.min(9, Math.floor(p * 10));
    const b = buckets.get(bucket) || { n: 0, sumP: 0, sumOutcome: 0 };
    b.n++; b.sumP += p; b.sumOutcome += o;
    buckets.set(bucket, b);

    // By league
    const lg = r.league || 'Unknown';
    const lgRow = byLeague.get(lg) || { league: lg, n: 0, sse: 0, sumP: 0, sumOutcome: 0, profit: 0 };
    lgRow.n++;
    lgRow.sse += Math.pow(p - o, 2);
    lgRow.sumP += p;
    lgRow.sumOutcome += o;
    lgRow.profit += Number(r.profit_units || 0);
    byLeague.set(lg, lgRow);
  }

  if (n === 0) return { ok: true, n: 0, overall: null, byLeague: [], byBucket: [] };

  const meanP = sumP / n;
  const hitRate = sumOutcome / n;
  const brier = sse / n;
  const mae = Math.abs(meanP - hitRate);

  // ECE — soma ponderada de |p_bucket_mean - outcome_bucket_mean| pelo peso n_bucket/n_total
  let ece = 0;
  const byBucket = [];
  for (const [bk, b] of buckets) {
    const bMeanP = b.sumP / b.n;
    const bMeanO = b.sumOutcome / b.n;
    const weight = b.n / n;
    ece += weight * Math.abs(bMeanP - bMeanO);
    byBucket.push({
      bucket: `${(bk / 10).toFixed(1)}-${((bk + 1) / 10).toFixed(1)}`,
      n: b.n,
      mean_p: +bMeanP.toFixed(4),
      hit_rate: +bMeanO.toFixed(4),
      gap: +(bMeanP - bMeanO).toFixed(4),
    });
  }
  byBucket.sort((a, b) => parseFloat(a.bucket) - parseFloat(b.bucket));

  // By league array
  const byLeagueArr = [...byLeague.values()]
    .filter(l => l.n >= Math.min(5, minN))
    .map(l => ({
      league: l.league, n: l.n,
      brier: +(l.sse / l.n).toFixed(4),
      mean_p: +(l.sumP / l.n).toFixed(4),
      hit_rate: +(l.sumOutcome / l.n).toFixed(4),
      mae: +Math.abs(l.sumP / l.n - l.sumOutcome / l.n).toFixed(4),
      roi_pct: +((l.profit / l.n) * 100).toFixed(2),
    }))
    .sort((a, b) => b.n - a.n);

  return {
    ok: true,
    days,
    sport,
    n,
    overall: {
      n, brier: +brier.toFixed(4), ece: +ece.toFixed(4),
      mean_p: +meanP.toFixed(4), hit_rate: +hitRate.toFixed(4),
      mae: +mae.toFixed(4),
      roi_pct: +((profit / stake) * 100).toFixed(2),
    },
    byBucket,
    byLeague: byLeagueArr,
  };
}

/**
 * Decide auto-disable do kills scanner se calib piorou significativamente.
 * Thresholds default: brier > 0.30 OU |mae| > 0.10 com n >= 30 → disable.
 * Persiste decisão em gates_runtime_state.
 */
function evaluateKillsAutoDisable(db, calibResult, opts = {}) {
  const brierMax = opts.brierMax ?? 0.30;
  const maeMax = opts.maeMax ?? 0.10;
  const minN = opts.minN ?? 30;

  if (!calibResult || !calibResult.overall) {
    return { action: 'no_data', reason: 'sample insuficiente' };
  }
  const { brier, mae, n } = calibResult.overall;
  if (n < minN) return { action: 'wait', reason: `n=${n} < ${minN}`, current: { brier, mae, n } };

  const degraded = brier > brierMax || mae > maeMax;
  const status = {
    action: degraded ? 'disable_recommended' : 'healthy',
    brier, mae, n,
    threshold: { brier: brierMax, mae: maeMax },
  };

  // Persist em gates_runtime_state
  try {
    db.prepare(`
      INSERT INTO gates_runtime_state (key, value, updated_at)
      VALUES ('lol_kills_calib', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify({ ...calibResult.overall, evaluated_at: new Date().toISOString(), action: status.action }));
  } catch (e) {
    log('DEBUG', 'KILLS-CALIB', `persist gates_runtime_state err: ${e.message}`);
  }

  return status;
}

module.exports = { computeKillsCalibration, evaluateKillsAutoDisable };

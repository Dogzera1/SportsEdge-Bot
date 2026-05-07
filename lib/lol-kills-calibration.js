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
 * @param {object} opts { days=14, sport='lol', minN=10, leagueLike, realOnly }
 * @returns {{ overall, byLeague, byBucket }}
 *
 * 2026-05-07 (princípio shadow=causa): cron runKillsCalibrationCheck (bot.js:5696)
 * dispara DM "disable_recommended" quando degrada calib. Antes agregava
 * market_tips_shadow direto — mistura research-only + dispatched → pode
 * recomendar disable de model com base em decisões hipotéticas. Pattern fix
 * espelha runMarketTipsLeakGuard / runMarketTipsRoiGuardSided: REAL_ONLY
 * default true, JOIN tips is_shadow=0 + market_type + janela 14d + team norm.
 * Opt-out: opts.realOnly=false ou env KILLS_CALIB_REAL_ONLY=false.
 */
function computeKillsCalibration(db, opts = {}) {
  const days = Math.max(3, Math.min(180, opts.days || 14));
  const sport = opts.sport || 'lol';
  const minN = opts.minN ?? 10;
  const realOnly = opts.realOnly != null
    ? !!opts.realOnly
    : !/^(0|false|no)$/i.test(String(process.env.KILLS_CALIB_REAL_ONLY ?? 'true'));
  const leagueClause = opts.leagueLike ? `AND mts.league LIKE ?` : '';
  const args = [sport, `-${days} days`];
  if (opts.leagueLike) args.push(`%${opts.leagueLike}%`);

  // _NORM espelha _normTeam em mt-result-propagator.js:37 (lower + remove
  // space/dash/dot/apostrofe). JOIN com tips real exige same normalização.
  const _NORM = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(lower(${col}),' ',''),'-',''),'.',''),'''','')`;
  const realJoin = realOnly ? `
    INNER JOIN tips t ON
      t.sport = mts.sport
      AND UPPER(t.market_type) = UPPER(mts.market)
      AND COALESCE(t.is_shadow, 0) = 0
      AND (t.archived IS NULL OR t.archived = 0)
      AND t.result IN ('win','loss','void','push')
      AND ABS(julianday(COALESCE(t.sent_at, t.settled_at)) - julianday(mts.created_at)) < 14
      AND (
        (${_NORM('t.participant1')} = ${_NORM('mts.team1')} AND ${_NORM('t.participant2')} = ${_NORM('mts.team2')})
        OR
        (${_NORM('t.participant1')} = ${_NORM('mts.team2')} AND ${_NORM('t.participant2')} = ${_NORM('mts.team1')})
      )
  ` : '';
  const rows = db.prepare(`
    SELECT mts.id AS id, mts.league AS league, mts.market AS market,
           mts.line AS line, mts.side AS side, mts.p_model AS p_model,
           mts.ev_pct AS ev_pct, mts.odd AS odd, mts.result AS result,
           mts.profit_units AS profit_units,
           mts.created_at AS created_at, mts.settled_at AS settled_at
    FROM market_tips_shadow mts
    ${realJoin}
    WHERE mts.sport = ?
      AND mts.market LIKE 'total_kills_%'
      AND mts.result IN ('win','loss')
      AND mts.created_at >= datetime('now', ?)
      ${leagueClause}
    ORDER BY mts.created_at DESC
    LIMIT 5000
  `).all(...args);

  if (!rows.length) return { ok: true, n: 0, overall: null, byLeague: [], byBucket: [] };

  // Overall
  let sse = 0, sumP = 0, sumOutcome = 0, n = 0;
  let profit = 0, stake = 0;
  const buckets = new Map(); // p_bucket → { n, sumP, sumOutcome }
  const byLeague = new Map();

  // 2026-05-07 (audit P2): profit_units stored é Kelly-ajustado (= actual_stake ×
  // (odds-1) win / -actual_stake loss). Antes acumulava ele em `profit` mas
  // dividia por `stake` que crescia 1 por row (uniform) — resultado misto que
  // não era ROI nem mean Kelly profit. Fix: recompute profit a 1u flat usando
  // r.odd, mantendo stake uniforme. Agora roi_pct = sum(profitFlat) / n × 100
  // = mean(uniform 1u ROI), métrica consistente pra calib (sem viés Kelly).
  const _flatProfit = (result, odd) => {
    if (result === 'win') return (Number(odd) || 0) - 1;
    if (result === 'loss') return -1;
    return 0; // push/void
  };
  for (const r of rows) {
    const o = _outcomeBinary(r.result);
    if (o == null || !Number.isFinite(r.p_model)) continue;
    const p = Math.max(0, Math.min(1, r.p_model));
    sse += Math.pow(p - o, 2);
    sumP += p;
    sumOutcome += o;
    n++;
    const flatP = _flatProfit(r.result, r.odd);
    profit += flatP;
    stake += 1; // 1u baseline (alinhado com profitFlat)

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
    lgRow.profit += flatP; // mesmo critério uniform 1u
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

/**
 * Frente 2 helper — agrega per-league cobertura por source. Mostra quais ligas
 * dependem só de gol.gg (OE não tem) → flag "fragile" pra monitor.
 */
function getLeagueCoverage(db, opts = {}) {
  const days = opts.days || 30;
  // Distinct leagues em market_tips_shadow LoL kills
  const tipLeagues = db.prepare(`
    SELECT league, COUNT(*) AS n
    FROM market_tips_shadow
    WHERE sport = 'lol' AND market LIKE 'total_kills_%'
      AND created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY league
    ORDER BY n DESC
  `).all(days);

  // OE coverage: ligas com >=1 game em window
  const oeLeagues = db.prepare(`
    SELECT league, COUNT(DISTINCT gameid) AS n
    FROM oracleselixir_games
    WHERE date >= date('now', '-' || ? || ' days')
    GROUP BY league
  `).all(days);
  const oeSet = new Set(oeLeagues.map(r => String(r.league || '').toLowerCase()));

  // gol.gg coverage: match_id LIKE 'golgg_%' em match_results
  const ggLeagues = db.prepare(`
    SELECT league, COUNT(*) AS n
    FROM match_results
    WHERE game = 'lol' AND match_id LIKE 'golgg_%'
      AND resolved_at >= date('now', '-' || ? || ' days')
    GROUP BY league
  `).all(days);
  const ggSet = new Set(ggLeagues.map(r => String(r.league || '').toLowerCase()));

  return tipLeagues.map(t => {
    const lg = String(t.league || '').toLowerCase();
    const oe = oeSet.has(lg);
    const gg = ggSet.has(lg);
    return {
      league: t.league,
      tips_n: t.n,
      oe_coverage: oe,
      golgg_coverage: gg,
      fragile: !oe && gg, // depende só de gol.gg
      uncovered: !oe && !gg, // nem uma fonte → settlement vai falhar
    };
  });
}

module.exports = { computeKillsCalibration, evaluateKillsAutoDisable, getLeagueCoverage };

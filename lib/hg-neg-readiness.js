/**
 * HG- (handicapGames negative line) readiness monitor — 2026-05-09.
 *
 * User: HG- tennis tem ROI +52.8% n=24 mas sample insuficiente pra agir.
 * Cron 24h alerta admin quando n_settled atinge threshold (default 50)
 * com IC95 estreito o suficiente pra justificar mudança de stake/calib.
 *
 * P2-compliant: só ALERTA admin (não auto-action). Decisão (refit calib,
 * ajustar Kelly hierarchy) fica humana.
 *
 * Source: tabela tips, is_shadow=0, market_type='HANDICAP_GAMES',
 * match_id LIKE %::lnN% OR tip_participant termina com '-X.X'.
 */

'use strict';

/**
 * Calcula Wilson 95% confidence interval lower bound do ROI.
 * Aproximação: usa hit rate como proxy. ROI IC requer profit distribution
 * que tem variance maior que binomial — mas Wilson hit_lower é proxy
 * conservador útil pra readiness check.
 *
 * @param {number} wins
 * @param {number} n
 * @returns {{lower: number, upper: number}} hit rate IC95 (0..1)
 */
function wilsonHitIc95(wins, n) {
  if (n <= 0) return { lower: 0, upper: 1 };
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    lower: Math.max(0, (center - margin) / denom),
    upper: Math.min(1, (center + margin) / denom),
  };
}

/**
 * Roda check de readiness HG- tennis.
 *
 * @param {object} db better-sqlite3 instance
 * @param {object} [opts]
 * @param {number} [opts.days=60] janela
 * @param {number} [opts.minN=50] threshold sample mínimo
 * @param {number} [opts.minRoi=10] ROI mínimo (%) pra triggerar
 * @param {number} [opts.minIcLowerHit=0.50] hit IC95 lower bound mínimo
 *   (0.50 = pelo menos breakeven em hit). Conservador pra evitar false-armed.
 * @param {boolean} [opts.includeArchived=false] inclui tips arquivadas
 *   (pré PNL_DAILY_CUTOFF_DATE reset). Default OFF preserva semantica
 *   "viva". Use true pra visibilidade histórica pós-reset.
 * @returns {{
 *   armed: boolean,
 *   reasons: string[],
 *   stats: { n, wins, losses, roi, hit, hit_ic95_lower, hit_ic95_upper, clv, clv_n, profit, staked },
 *   cfg: object,
 * }}
 */
function runHgNegReadiness(db, opts = {}) {
  const cfg = {
    days: opts.days ?? 60,
    minN: opts.minN ?? 50,
    minRoi: opts.minRoi ?? 10,
    minIcLowerHit: opts.minIcLowerHit ?? 0.50,
    includeArchived: !!opts.includeArchived,
  };

  // Query tips reais tennis HG-. Match via match_id pattern OR
  // tip_participant fallback (legacy tips pre-pattern lnP/N).
  const archivedCond = cfg.includeArchived ? '' : 'AND (archived IS NULL OR archived = 0)';
  const rows = db.prepare(`
    SELECT
      result,
      COALESCE(stake_reais, 0) AS stake,
      COALESCE(profit_reais, 0) AS profit,
      clv_odds, odds, ev,
      match_id, tip_participant
    FROM tips
    WHERE COALESCE(is_shadow, 0) = 0
      ${archivedCond}
      AND sport = 'tennis'
      AND UPPER(COALESCE(market_type, '')) = 'HANDICAP_GAMES'
      AND result IN ('win', 'loss')
      AND sent_at >= datetime('now', '-' || ? || ' days')
  `).all(cfg.days);

  // Filtrar apenas HG- (negative line)
  const reNeg = /::lnN/i;
  const reTpNeg = /\s-\d+(?:\.\d+)?\s*$/;
  const negs = rows.filter(r => {
    const mid = String(r.match_id || '');
    if (reNeg.test(mid)) return true;
    if (/::lnP/i.test(mid)) return false;
    // Legacy: parseia tip_participant
    return reTpNeg.test(String(r.tip_participant || ''));
  });

  const n = negs.length;
  const wins = negs.filter(r => r.result === 'win').length;
  const losses = n - wins;
  const staked = negs.reduce((a, r) => a + Number(r.stake || 0), 0);
  const profit = negs.reduce((a, r) => a + Number(r.profit || 0), 0);
  const roi = staked > 0 ? (profit / staked) * 100 : null;
  const hit = n > 0 ? wins / n : null;
  const ic = wilsonHitIc95(wins, n);

  const clvSamples = negs.filter(r => r.clv_odds > 1 && r.odds > 1)
    .map(r => (r.odds / r.clv_odds - 1) * 100);
  const clv = clvSamples.length
    ? clvSamples.reduce((a, b) => a + b, 0) / clvSamples.length
    : null;

  const stats = {
    n, wins, losses,
    roi: roi != null ? +roi.toFixed(2) : null,
    hit: hit != null ? +(hit * 100).toFixed(1) : null,
    hit_ic95_lower: +(ic.lower * 100).toFixed(1),
    hit_ic95_upper: +(ic.upper * 100).toFixed(1),
    clv: clv != null ? +clv.toFixed(2) : null,
    clv_n: clvSamples.length,
    profit: +profit.toFixed(2),
    staked: +staked.toFixed(2),
  };

  // Threshold check
  const reasons = [];
  if (n < cfg.minN) reasons.push(`n=${n} < ${cfg.minN}`);
  if (roi == null || roi < cfg.minRoi) reasons.push(`ROI=${roi}% < ${cfg.minRoi}%`);
  if (ic.lower < cfg.minIcLowerHit) reasons.push(`hit IC95 lower=${stats.hit_ic95_lower}% < ${(cfg.minIcLowerHit * 100).toFixed(0)}%`);

  const armed = reasons.length === 0;

  return { armed, reasons, stats, cfg };
}

module.exports = { runHgNegReadiness, wilsonHitIc95 };

'use strict';

// Builder do digest PnL diário (hoje + 7d + 30d + total).
// BRT-aware (DATE(settled_at, '-3 hours')) — alinha com dia BRT, não UTC.
// Usado pelo cron runPnlDaily (bot.js) e pelo endpoint admin manual.

function buildPnlDailyMessage(db, opts = {}) {
  const skipToday = !!opts.skipToday;
  const brtNow = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const today = brtNow.toISOString().slice(0, 10);
  const lines = [];
  const stats = { today_n: 0, today_profit: 0, today_stake: 0, past7d_days: 0, sum30d_n: 0, sumAll_n: 0 };

  if (skipToday) {
    lines.push(`📊 *Resumo PnL* — ${today}`, '');
  } else {
    lines.push(`🌙 *Lucro de Hoje* — ${today}`, '');

    const mlRows = db.prepare(`
      SELECT sport, result,
             COALESCE(profit_reais, 0) AS profit_reais,
             CAST(REPLACE(REPLACE(stake, 'u', ''), 'U', '') AS REAL) AS stake_units
        FROM tips
       WHERE COALESCE(is_shadow, 0) = 0
         AND COALESCE(archived, 0) = 0
         AND result IN ('win', 'loss', 'void')
         AND DATE(settled_at, '-3 hours') = ?
    `).all(today);

    const mtRows = db.prepare(`
      SELECT sport, result,
             COALESCE(profit_units, 0) AS profit_units,
             COALESCE(stake_units, 0) AS stake_units
        FROM market_tips_shadow
       WHERE result IN ('win', 'loss', 'void')
         AND admin_dm_sent_at IS NOT NULL
         AND DATE(settled_at, '-3 hours') = ?
    `).all(today);

    const bySport = {};
    let totW = 0, totL = 0, totV = 0, totProfit = 0, totStake = 0;
    for (const r of mlRows) {
      const s = r.sport || '?';
      bySport[s] = bySport[s] || { mlN: 0, mlP: 0, mtN: 0, mtP: 0, w: 0, l: 0, v: 0 };
      bySport[s].mlN++;
      bySport[s].mlP += r.profit_reais || 0;
      totProfit += r.profit_reais || 0;
      totStake += r.stake_units || 0;
      if (r.result === 'win') { bySport[s].w++; totW++; }
      else if (r.result === 'loss') { bySport[s].l++; totL++; }
      else if (r.result === 'void') { bySport[s].v++; totV++; }
    }
    for (const r of mtRows) {
      const s = r.sport || '?';
      bySport[s] = bySport[s] || { mlN: 0, mlP: 0, mtN: 0, mtP: 0, w: 0, l: 0, v: 0 };
      bySport[s].mtN++;
      bySport[s].mtP += r.profit_units || 0;
      totProfit += r.profit_units || 0;
      totStake += r.stake_units || 0;
      if (r.result === 'win') { bySport[s].w++; totW++; }
      else if (r.result === 'loss') { bySport[s].l++; totL++; }
      else if (r.result === 'void') { bySport[s].v++; totV++; }
    }
    const totSettled = totW + totL + totV;
    const roi = totStake > 0 ? (totProfit / totStake * 100) : 0;
    stats.today_n = totSettled;
    stats.today_profit = totProfit;
    stats.today_stake = totStake;
    if (totSettled > 0) {
      lines.push(`📊 ${totSettled} liquidadas (${totW}W ${totL}L ${totV}V)`);
      lines.push(`💰 *${totProfit >= 0 ? '+' : ''}${totProfit.toFixed(2)}u* (${totProfit >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI · ${totStake.toFixed(1)}u stake)`);
    } else {
      lines.push('_Nenhuma tip liquidada hoje._');
    }

    const sportsSorted = Object.entries(bySport).sort((a, b) => (b[1].mlP + b[1].mtP) - (a[1].mlP + a[1].mtP));
    if (sportsSorted.length > 0) {
      lines.push('', '*Por sport:*');
      for (const [s, d] of sportsSorted) {
        const c = d.mlN + d.mtN;
        const p = d.mlP + d.mtP;
        if (c === 0) continue;
        const parts = [];
        if (d.mlN > 0) parts.push(`ML ${d.mlN}`);
        if (d.mtN > 0) parts.push(`MT ${d.mtN}`);
        const emoji = p > 0 ? '🟢' : p < 0 ? '🔴' : '⚪';
        lines.push(`${emoji} ${s}: ${parts.join(' + ')} (${d.w}W${d.l}L${d.v}V) → ${p >= 0 ? '+' : ''}${p.toFixed(2)}u`);
      }
    }
  }

  // ── Últimos 7 dias (excluindo hoje), BRT-aware ──
  const past7Rows = db.prepare(`
    WITH unified AS (
      SELECT DATE(settled_at, '-3 hours') AS d,
             COALESCE(profit_reais, 0) AS p,
             CAST(REPLACE(REPLACE(stake, 'u', ''), 'U', '') AS REAL) AS s
        FROM tips
       WHERE COALESCE(is_shadow, 0) = 0
         AND COALESCE(archived, 0) = 0
         AND result IN ('win', 'loss', 'void')
         AND DATE(settled_at, '-3 hours') >= DATE(?, '-7 days')
         AND DATE(settled_at, '-3 hours') < ?
      UNION ALL
      SELECT DATE(settled_at, '-3 hours') AS d,
             COALESCE(profit_units, 0) AS p,
             COALESCE(stake_units, 0) AS s
        FROM market_tips_shadow
       WHERE result IN ('win', 'loss', 'void')
         AND admin_dm_sent_at IS NOT NULL
         AND DATE(settled_at, '-3 hours') >= DATE(?, '-7 days')
         AND DATE(settled_at, '-3 hours') < ?
    )
    SELECT d, ROUND(SUM(p), 2) AS profit,
           ROUND(SUM(s), 2) AS stake, COUNT(*) AS n
      FROM unified
     GROUP BY d
     ORDER BY d DESC
  `).all(today, today, today, today);

  stats.past7d_days = past7Rows.length;

  if (past7Rows.length > 0) {
    lines.push('', '*Últimos 7 dias:*');
    for (const r of past7Rows) {
      const parts = (r.d || '').split('-');
      const ddmm = parts.length === 3 ? `${parts[2]}/${parts[1]}` : (r.d || '');
      const p = r.profit || 0;
      const e = p > 0 ? '🟢' : p < 0 ? '🔴' : '⚪';
      const roiDay = r.stake > 0 ? ` · ${p >= 0 ? '+' : ''}${(p / r.stake * 100).toFixed(1)}%` : '';
      lines.push(`${ddmm} ${e} ${p >= 0 ? '+' : ''}${p.toFixed(2)}u (${r.n} tip${r.n === 1 ? '' : 's'}${roiDay})`);
    }
    const sum7 = past7Rows.reduce((a, r) => ({
      p: a.p + (r.profit || 0), s: a.s + (r.stake || 0), n: a.n + (r.n || 0),
    }), { p: 0, s: 0, n: 0 });
    const e7 = sum7.p > 0 ? '🟢' : sum7.p < 0 ? '🔴' : '⚪';
    const r7 = sum7.s > 0 ? ` · ROI ${sum7.p >= 0 ? '+' : ''}${(sum7.p / sum7.s * 100).toFixed(1)}%` : '';
    lines.push(`└ ${e7} *7d: ${sum7.n} tips · ${sum7.p >= 0 ? '+' : ''}${sum7.p.toFixed(2)}u${r7}*`);
  }

  // ── Resumo do sistema: 30d + Total (BRT-aware) ──
  const aggregateQuery = (whereExtra, params) => db.prepare(`
    WITH unified AS (
      SELECT COALESCE(profit_reais, 0) AS p,
             CAST(REPLACE(REPLACE(stake, 'u', ''), 'U', '') AS REAL) AS s,
             result, settled_at
        FROM tips
       WHERE COALESCE(is_shadow, 0) = 0
         AND COALESCE(archived, 0) = 0
         AND result IN ('win', 'loss', 'void')
         ${whereExtra}
      UNION ALL
      SELECT COALESCE(profit_units, 0) AS p,
             COALESCE(stake_units, 0) AS s,
             result, settled_at
        FROM market_tips_shadow
       WHERE result IN ('win', 'loss', 'void')
         AND admin_dm_sent_at IS NOT NULL
         ${whereExtra}
    )
    SELECT ROUND(SUM(p), 2) AS profit,
           ROUND(SUM(s), 2) AS stake,
           COUNT(*) AS n,
           SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS w,
           SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS l,
           MIN(DATE(settled_at, '-3 hours')) AS first_dt
      FROM unified
  `).get(...(params || []));

  const sum30 = aggregateQuery(`AND DATE(settled_at, '-3 hours') >= DATE(?, '-29 days')`, [today, today]);
  const sumAll = aggregateQuery('', []);

  stats.sum30d_n = sum30?.n || 0;
  stats.sumAll_n = sumAll?.n || 0;

  const summaryLines = [];
  const fmtSum = (label, row, sinceTag) => {
    if (!row || !row.n) return null;
    const p = row.profit || 0;
    const s = row.stake || 0;
    const e = p > 0 ? '🟢' : p < 0 ? '🔴' : '⚪';
    const roiPct = s > 0 ? ` · ROI ${p >= 0 ? '+' : ''}${(p / s * 100).toFixed(1)}%` : '';
    const settled = (row.w || 0) + (row.l || 0);
    const hit = settled > 0 ? ` · hit ${(row.w / settled * 100).toFixed(0)}%` : '';
    return `${e} ${label}: ${row.n} tips · ${p >= 0 ? '+' : ''}${p.toFixed(2)}u${roiPct}${hit}${sinceTag || ''}`;
  };
  const l30 = fmtSum('30d', sum30);
  if (l30) summaryLines.push(l30);
  const lAll = fmtSum('Total', sumAll, sumAll?.first_dt ? ` _(desde ${sumAll.first_dt})_` : '');
  if (lAll) summaryLines.push(lAll);

  if (summaryLines.length > 0) {
    lines.push('', '*Resumo do sistema:*');
    for (const ln of summaryLines) lines.push(ln);
  }

  return { msg: lines.join('\n'), stats, today };
}

module.exports = { buildPnlDailyMessage };

'use strict';

/**
 * lib/analytics-watchdog.js — análise automática das 12 métricas DAX.
 *
 * Roda cada N horas (cron em bot.js). Aplica regras de threshold pra cada
 * métrica e gera alerts. Throttle 24h por (rule_id, sport) via tabela
 * analytics_alerts (mig 081).
 *
 * Rules são audit-driven (thresholds vêm de findings 2026-05-04). Tunable
 * via env WATCHDOG_<RULE>_THRESHOLD se precisar ajustar.
 *
 * Severity:
 *   P0: ação imediata sugerida (ex: drawdown > 25% bloqueia automaticamente)
 *   P1: investigar nas próximas 24h (ex: calibration drift > 8pp)
 *   P2: heads-up sem urgência (ex: streak loss 5 = tilt window mas não block)
 *
 * Output: { alerts: [{rule, sport, severity, value, threshold, message, ctx}],
 *           summary: { total: N, by_severity: {...}, by_sport: {...} } }
 */

const { getMetric } = require('./analytics-metrics');

function _envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

/**
 * Rules — cada uma:
 *   id: identificador (persistência)
 *   metric: qual métrica de analytics-metrics rodar
 *   severity: P0/P1/P2
 *   test(rows, opts): retorna lista de matches (objetos {sport, value, threshold, ctx})
 *   message(match): string Telegram-friendly
 *   action: hint do que fazer
 */
const RULES = [
  {
    id: 'sharpe_negative',
    metric: 'sharpe',
    severity: 'P0',
    label: 'Sharpe negativo',
    test: (rows) => {
      const min = _envFloat('WATCHDOG_SHARPE_MIN', 0);
      return rows.filter(r => r.sharpe_ratio !== null && r.sharpe_ratio < min && (r.n_tips || 0) >= 10)
        .map(r => ({ sport: r.sport, value: r.sharpe_ratio, threshold: min, ctx: { n: r.n_tips, profit: r.total_profit } }));
    },
    message: (m) => `<b>Sharpe negativo</b> em ${m.sport}: ${m.value.toFixed(2)} (n=${m.ctx.n}, profit ${m.ctx.profit})`,
    action: 'Considere shadow ou tighten gates do sport.',
  },
  {
    id: 'drawdown_distress',
    metric: 'drawdown',
    severity: 'P0',
    label: 'Drawdown distress',
    test: (rows) => {
      const max = _envFloat('WATCHDOG_DD_MAX_PCT', -25);
      return rows.filter(r => r.max_dd_pct !== null && r.max_dd_pct <= max)
        .map(r => ({ sport: r.sport, value: r.max_dd_pct, threshold: max, ctx: { peak: r.peak_profit, current: r.current_profit } }));
    },
    message: (m) => `<b>Drawdown ${m.value.toFixed(1)}%</b> em ${m.sport} (peak R$${m.ctx.peak} → atual R$${m.ctx.current})`,
    action: 'Bankroll Guardian deve estar bloqueando real path. Confirme via /admin/sport-detail.',
  },
  {
    id: 'calibration_drift',
    metric: 'calibration',
    severity: 'P1',
    label: 'Calibration drift',
    test: (rows) => {
      const maxAbs = _envFloat('WATCHDOG_CALIB_MAX_GAP_PP', 8);
      // Agrega por sport — média dos abs(gap) ponderada por n
      const bySport = new Map();
      for (const r of rows) {
        const cur = bySport.get(r.sport) || { totalN: 0, totalGap: 0, bins: 0 };
        cur.totalN += r.n;
        cur.totalGap += Math.abs(r.calib_gap_pp || 0) * r.n;
        cur.bins += 1;
        bySport.set(r.sport, cur);
      }
      const out = [];
      for (const [sport, v] of bySport) {
        if (v.bins < 3 || v.totalN < 20) continue;
        const wgap = v.totalGap / v.totalN;
        if (wgap > maxAbs) out.push({ sport, value: wgap, threshold: maxAbs, ctx: { bins: v.bins, n: v.totalN } });
      }
      return out;
    },
    message: (m) => `<b>Calibration drift ${m.value.toFixed(1)}pp</b> em ${m.sport} (n=${m.ctx.n}, ${m.ctx.bins} bins)`,
    action: 'Refit isotonic ou retreinar modelo (scripts/refresh-all-isotonics.js).',
  },
  {
    id: 'tilt_window',
    metric: 'streak',
    severity: 'P1',
    label: 'Tilt window',
    test: (rows) => {
      const minLossStreak = parseInt(process.env.WATCHDOG_TILT_LOSS_MIN || '4', 10);
      return rows.filter(r => r.current_result === 'loss' && (r.current_streak || 0) >= minLossStreak)
        .map(r => ({ sport: r.sport, value: r.current_streak, threshold: minLossStreak, ctx: { longest: r.longest_loss } }));
    },
    message: (m) => `<b>Tilt window</b> ${m.sport}: ${m.value} losses consecutivas (longest histórico ${m.ctx.longest})`,
    action: 'Pause real path 12h ou reduzir kelly para BAIXA até próxima win.',
  },
  {
    id: 'clv_negative',
    metric: 'clv',
    severity: 'P1',
    label: 'CLV persistente negativo',
    test: (rows) => {
      const cutoff = _envFloat('WATCHDOG_CLV_MIN_PCT', -1);
      return rows.filter(r => r.avg_clv_pct !== null && r.avg_clv_pct < cutoff && (r.n_with_clv || 0) >= 30)
        .map(r => ({ sport: r.sport, value: r.avg_clv_pct, threshold: cutoff, ctx: { n: r.n_with_clv, capture: r.clv_capture_rate_pct } }));
    },
    message: (m) => `<b>CLV ${m.value.toFixed(2)}%</b> em ${m.sport} (n=${m.ctx.n}, capture ${m.ctx.capture}%)`,
    action: 'AUTO_SHADOW_NEGATIVE_CLV deve estar flippando shadow auto. Verifique se ativo.',
  },
  {
    id: 'brier_worse_than_baseline',
    metric: 'brier',
    severity: 'P1',
    label: 'Brier skill negativo',
    test: (rows) => {
      return rows.filter(r => r.brier_skill !== null && r.brier_skill < 0 && r.n >= 20)
        .map(r => ({ sport: r.sport, value: r.brier_skill, threshold: 0, ctx: { n: r.n, brier: r.brier, baseline: r.brier_baseline } }));
    },
    message: (m) => `<b>Brier skill ${m.value.toFixed(4)}</b> em ${m.sport} pior que coin-flip (n=${m.ctx.n})`,
    action: 'Modelo pior que random — review imediata. Considere shadow.',
  },
  {
    id: 'ev_bucket_leak',
    metric: 'evbucket',
    severity: 'P1',
    label: 'EV bucket leak',
    test: (rows) => {
      const minRoi = _envFloat('WATCHDOG_EV_LEAK_ROI', -15);
      const minN = parseInt(process.env.WATCHDOG_EV_LEAK_MIN_N || '10', 10);
      return rows.filter(r => r.ev_bucket === '>12' && r.roi_pct !== null && r.roi_pct < minRoi && r.n >= minN)
        .map(r => ({ sport: r.sport, value: r.roi_pct, threshold: minRoi, ctx: { bucket: r.ev_bucket, n: r.n } }));
    },
    message: (m) => `<b>EV bucket ${m.ctx.bucket}</b> ${m.sport}: ROI ${m.value.toFixed(1)}% n=${m.ctx.n}`,
    action: 'Tighten TIP_EV_MAX_PER_SPORT pra esse sport (audit 2026-05-01 já reduziu para vários).',
  },
  {
    id: 'time_of_day_toxic',
    metric: 'timeofday',
    severity: 'P2',
    label: 'Janela horária tóxica',
    test: (rows) => {
      const minRoi = _envFloat('WATCHDOG_TOD_ROI_MIN', -30);
      const minN = parseInt(process.env.WATCHDOG_TOD_MIN_N || '10', 10);
      return rows.filter(r => r.roi_pct !== null && r.roi_pct < minRoi && r.n >= minN)
        .map(r => ({ sport: r.sport, value: r.roi_pct, threshold: minRoi, ctx: { hour: r.hour_utc, n: r.n } }));
    },
    message: (m) => `Hora UTC ${String(m.ctx.hour).padStart(2,'0')}h ${m.sport}: ROI ${m.value.toFixed(1)}% n=${m.ctx.n}`,
    action: 'TIME_OF_DAY_AUTO=true (já default) deve bloquear automaticamente.',
  },
  {
    id: 'market_matrix_leak',
    metric: 'marketsport',
    severity: 'P1',
    label: 'Market×sport leak',
    test: (rows) => {
      const minRoi = _envFloat('WATCHDOG_MATRIX_ROI_MIN', -25);
      const minN = parseInt(process.env.WATCHDOG_MATRIX_MIN_N || '15', 10);
      return rows.filter(r => r.roi_pct !== null && r.roi_pct < minRoi && r.n >= minN)
        .map(r => ({ sport: r.sport, value: r.roi_pct, threshold: minRoi, ctx: { market: r.market_type, n: r.n, profit: r.profit } }));
    },
    message: (m) => `<b>${m.sport}/${m.ctx.market}</b>: ROI ${m.value.toFixed(1)}% n=${m.ctx.n} profit R$${m.ctx.profit}`,
    action: 'Adicionar a MT_PERMANENT_DISABLE_LIST ou flip ML_DISABLED.',
  },
  {
    id: 'kelly_over_leveraged',
    metric: 'kelly',
    severity: 'P2',
    label: 'Kelly over-leveraged',
    test: (rows) => {
      return rows.filter(r => r.avg_efficiency !== null && r.avg_efficiency > 1.5 && r.n >= 10)
        .map(r => ({ sport: r.sport, value: r.avg_efficiency, threshold: 1.5, ctx: { market: r.market_type, n: r.n } }));
    },
    message: (m) => `${m.sport}/${m.ctx.market}: Kelly eff ${m.value}× (over-leveraged)`,
    action: 'Reduzir KELLY_<SPORT>_<CONF> ou stake_mult per-market.',
  },
];

/**
 * Roda watchdog: avalia todas rules + filtra por throttle (não realertar
 * mesma (rule, sport) dentro de cooldown_h horas).
 */
async function runWatchdog(db, opts = {}) {
  const days = opts.days || 30;
  const cooldownH = parseFloat(process.env.WATCHDOG_COOLDOWN_HOURS || '24');
  const cooldownMs = cooldownH * 60 * 60 * 1000;
  const out = { ts: new Date().toISOString(), days, alerts: [], suppressed: 0, summary: { total: 0, by_severity: {}, by_sport: {} } };

  // Cache métricas pra reusar entre rules
  const metricCache = new Map();
  const fetchMetric = async (name) => {
    if (metricCache.has(name)) return metricCache.get(name);
    const r = await getMetric(name, { days });
    metricCache.set(name, r);
    return r;
  };

  for (const rule of RULES) {
    let metric;
    try { metric = await fetchMetric(rule.metric); }
    catch (e) { out.alerts.push({ rule_id: rule.id, error: e.message }); continue; }
    const matches = rule.test(metric.rows || [], opts);
    for (const match of matches) {
      // Throttle check
      const last = db.prepare(`
        SELECT fired_at FROM analytics_alerts
         WHERE rule_id = ? AND sport = ? AND status = 'open'
         ORDER BY fired_at DESC LIMIT 1
      `).get(rule.id, match.sport);
      if (last) {
        const ageMs = Date.now() - new Date(last.fired_at).getTime();
        if (ageMs < cooldownMs) { out.suppressed++; continue; }
      }
      const alert = {
        rule_id: rule.id, label: rule.label, severity: rule.severity,
        sport: match.sport, value: match.value, threshold: match.threshold,
        message: rule.message(match), action: rule.action, ctx: match.ctx,
      };
      out.alerts.push(alert);
      out.summary.total++;
      out.summary.by_severity[rule.severity] = (out.summary.by_severity[rule.severity] || 0) + 1;
      out.summary.by_sport[match.sport] = (out.summary.by_sport[match.sport] || 0) + 1;
      // Persist
      try {
        db.prepare(`
          INSERT INTO analytics_alerts (rule_id, sport, severity, status, metric_value, threshold_value, message, context_json)
          VALUES (?, ?, ?, 'open', ?, ?, ?, ?)
        `).run(rule.id, match.sport, rule.severity, match.value, match.threshold, alert.message, JSON.stringify(match.ctx || {}));
      } catch (_) {}
    }
  }
  return out;
}

/**
 * Daily digest: snapshot completo das 12 métricas, top movers (good/bad),
 * resumo banca + alerts ativos. Rodado 1x/dia.
 */
async function runDigest(db, opts = {}) {
  const days = opts.days || 7; // Janela curta = mais sensível a regime change
  const out = { ts: new Date().toISOString(), days, sections: {} };

  const metricsToInclude = ['sharpe','brier','clv','drawdown','streak','marketsport'];
  for (const name of metricsToInclude) {
    try {
      const r = await getMetric(name, { days });
      out.sections[name] = { rows: r.rows || [], note: r.note };
    } catch (e) { out.sections[name] = { error: e.message }; }
  }
  // Active alerts
  try {
    const alerts = db.prepare(`
      SELECT rule_id, sport, severity, COUNT(*) AS n, MAX(fired_at) AS last_fired
        FROM analytics_alerts
       WHERE status = 'open' AND fired_at >= datetime('now', '-7 days')
       GROUP BY rule_id, sport, severity
       ORDER BY severity, last_fired DESC
    `).all();
    out.active_alerts = alerts;
  } catch (_) { out.active_alerts = []; }
  return out;
}

/**
 * Formata alerts pra mensagem Telegram (HTML mode).
 * Agrupa por severity, mostra action.
 */
function formatTelegramAlerts(watchOut) {
  const a = watchOut.alerts || [];
  if (!a.length) return null;
  const bySev = { P0: [], P1: [], P2: [] };
  for (const al of a) {
    if (al.error) continue;
    (bySev[al.severity] || bySev.P2).push(al);
  }
  const sevIcon = { P0: '🔴', P1: '🟠', P2: '🟡' };
  let msg = `<b>📊 Analytics Watchdog</b>\n${watchOut.ts}\n${a.length} alerts (${watchOut.suppressed} suprimidos)\n`;
  for (const sev of ['P0','P1','P2']) {
    if (!bySev[sev].length) continue;
    msg += `\n${sevIcon[sev]} <b>${sev}</b>\n`;
    for (const al of bySev[sev].slice(0, 8)) {
      msg += `• ${al.message}\n   <i>${al.action}</i>\n`;
    }
    if (bySev[sev].length > 8) msg += `   <i>...+${bySev[sev].length - 8} mais</i>\n`;
  }
  return msg;
}

/**
 * Formata digest diário em mensagem Telegram.
 */
function formatTelegramDigest(digestOut) {
  const s = digestOut.sections || {};
  let msg = `<b>📈 Daily Analytics Digest</b>\n${digestOut.ts.slice(0, 10)} · janela ${digestOut.days}d\n`;
  // Sharpe top/bottom
  const sharpe = s.sharpe?.rows || [];
  if (sharpe.length) {
    const top = sharpe.filter(r => r.sharpe_ratio !== null).slice(0, 3);
    const bot = sharpe.filter(r => r.sharpe_ratio !== null).slice(-2);
    msg += `\n<b>Sharpe ratio</b>\n`;
    for (const r of top) msg += `  ⬆ ${r.sport}: ${r.sharpe_ratio.toFixed(2)} (n=${r.n_tips})\n`;
    for (const r of bot) if (!top.includes(r)) msg += `  ⬇ ${r.sport}: ${r.sharpe_ratio.toFixed(2)}\n`;
  }
  // CLV
  const clv = s.clv?.rows || [];
  if (clv.length) {
    msg += `\n<b>CLV %</b>\n`;
    for (const r of clv.slice(0, 4)) {
      msg += `  ${r.avg_clv_pct >= 0 ? '✅' : '⚠️'} ${r.sport}: ${r.avg_clv_pct?.toFixed(2)}% (capture ${r.clv_capture_rate_pct}%)\n`;
    }
  }
  // Streak
  const streak = s.streak?.rows || [];
  if (streak.length) {
    const tilts = streak.filter(r => r.current_result === 'loss' && r.current_streak >= 3);
    if (tilts.length) {
      msg += `\n<b>Tilt windows</b>\n`;
      for (const r of tilts) msg += `  🔻 ${r.sport}: ${r.current_streak} losses\n`;
    }
  }
  // Active alerts
  const alerts = digestOut.active_alerts || [];
  if (alerts.length) {
    msg += `\n<b>Alerts ativos (7d)</b>\n`;
    for (const a of alerts.slice(0, 6)) {
      msg += `  ${a.severity} ${a.rule_id}/${a.sport || '*'} (${a.n}×)\n`;
    }
  } else {
    msg += `\n✅ <b>Sem alerts ativos</b>\n`;
  }
  return msg;
}

/**
 * PnL Daily Report: aggrega profit_reais per dia (últimos 7d) + per mês
 *   (atual + anterior). Converte BRL→units via baseline.unit_value (default 1).
 *
 * Output:
 *   { daily7d: [{date, units, n, wins, losses}, ...],
 *     monthly: [{month, units, n, hit_rate}, ...],
 *     totals: { mtd_units, ytd_units, pending_units, banca_current_units } }
 */
async function runPnlReport(db, opts = {}) {
  const { query } = require('./analytics');
  const days = 7;

  // Unit value via settings.baseline (mig 044 sincronizou)
  let unitValue = 1;
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'baseline_unit_value'`).get();
    if (row?.value) unitValue = parseFloat(row.value) || 1;
    else {
      const baseline = db.prepare(`SELECT value FROM settings WHERE key = 'baseline'`).get();
      if (baseline?.value) {
        try {
          const j = JSON.parse(baseline.value);
          if (j?.unit_value) unitValue = parseFloat(j.unit_value) || 1;
        } catch (_) {}
      }
    }
  } catch (_) {}

  const sportFilter = opts.sport ? `AND sport = '${opts.sport.replace(/'/g, "''")}'` : '';

  // Daily 7d (settled tips, exclui shadow + archived)
  const daily = await query(`
    SELECT CAST(settled_at AS DATE) AS date,
           ROUND(SUM(profit_reais) / ${unitValue}, 2) AS units,
           ROUND(SUM(stake_reais) / ${unitValue}, 2) AS stake_units,
           COUNT(*) AS n,
           SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
           SUM(CASE WHEN result = 'void' THEN 1 ELSE 0 END) AS voids
      FROM sd.tips
     WHERE result IN ('win','loss','void')
       AND COALESCE(is_shadow, 0) = 0
       AND COALESCE(archived, 0) = 0
       AND CAST(settled_at AS TIMESTAMP) >= (now() - INTERVAL '${days}' DAY)
       AND profit_reais IS NOT NULL
       ${sportFilter}
     GROUP BY CAST(settled_at AS DATE)
     ORDER BY date ASC
  `);

  // Monthly: atual + anteriores 5 (até 6 meses)
  const monthly = await query(`
    SELECT strftime(CAST(settled_at AS TIMESTAMP), '%Y-%m') AS month,
           ROUND(SUM(profit_reais) / ${unitValue}, 2) AS units,
           ROUND(SUM(stake_reais) / ${unitValue}, 2) AS stake_units,
           COUNT(*) AS n,
           SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
           ROUND(SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) * 100.0
                 / NULLIF(SUM(CASE WHEN result IN ('win','loss') THEN 1 ELSE 0 END), 0), 1) AS hit_rate
      FROM sd.tips
     WHERE result IN ('win','loss','void')
       AND COALESCE(is_shadow, 0) = 0
       AND COALESCE(archived, 0) = 0
       AND CAST(settled_at AS TIMESTAMP) >= (now() - INTERVAL '180' DAY)
       AND profit_reais IS NOT NULL
       ${sportFilter}
     GROUP BY strftime(CAST(settled_at AS TIMESTAMP), '%Y-%m')
     ORDER BY month DESC
     LIMIT 6
  `);

  // Per-sport monthly (current month only, top 5)
  const ymCur = new Date().toISOString().slice(0, 7);
  const bySport = await query(`
    SELECT sport,
           ROUND(SUM(profit_reais) / ${unitValue}, 2) AS units,
           COUNT(*) AS n,
           SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins
      FROM sd.tips
     WHERE result IN ('win','loss')
       AND COALESCE(is_shadow, 0) = 0
       AND COALESCE(archived, 0) = 0
       AND strftime(CAST(settled_at AS TIMESTAMP), '%Y-%m') = '${ymCur}'
       ${sportFilter}
     GROUP BY sport
     ORDER BY units DESC
     LIMIT 8
  `);

  // Pending exposure (units abertos)
  const pending = await query(`
    SELECT ROUND(SUM(stake_reais) / ${unitValue}, 2) AS pending_units,
           COUNT(*) AS n
      FROM sd.tips
     WHERE result IS NULL
       AND COALESCE(is_shadow, 0) = 0
       AND COALESCE(archived, 0) = 0
       ${sportFilter}
  `);

  // Totais
  const mtdUnits = monthly.find(m => m.month === ymCur)?.units || 0;
  const ytdUnits = monthly.filter(m => m.month.startsWith(new Date().getFullYear().toString())).reduce((s, m) => s + (m.units || 0), 0);

  return {
    ts: new Date().toISOString(),
    unit_value: unitValue,
    daily7d: daily,
    monthly,
    by_sport_current_month: bySport,
    totals: {
      mtd_units: +mtdUnits.toFixed(2),
      ytd_units: +ytdUnits.toFixed(2),
      pending_units: pending[0]?.pending_units || 0,
      pending_n: pending[0]?.n || 0,
    },
  };
}

/**
 * Formata PnL report em mensagem Telegram (HTML mode).
 * Layout pedido pelo user: DD/MM = ±X.Xu por dia da semana + monthly.
 */
function formatTelegramPnl(report) {
  if (!report) return null;
  const fmtU = (v) => {
    if (v == null) return '—';
    const sign = v >= 0 ? '+' : '';
    return `${sign}${v.toFixed(2)}u`;
  };
  const fmtDate = (iso) => {
    if (!iso) return '?';
    const d = new Date(iso);
    return `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth() + 1).padStart(2,'0')}`;
  };
  const fmtMonth = (ym) => {
    const months = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
    const [y, m] = String(ym).split('-');
    return `${months[parseInt(m, 10) - 1]}/${y.slice(2)}`;
  };

  let msg = `<b>💰 PnL Daily Report</b>\n${report.ts.slice(0, 10)} UTC\n`;

  // Daily 7d
  if (report.daily7d?.length) {
    msg += `\n<b>Últimos 7 dias</b>\n<pre>`;
    // Preenche dias faltantes (0u) pra dar visão completa
    const map = new Map(report.daily7d.map(d => [d.date, d]));
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const row = map.get(iso);
      const lbl = fmtDate(iso);
      if (row) {
        const icon = row.units > 0 ? '🟢' : row.units < 0 ? '🔴' : '⚪';
        msg += `${icon} ${lbl} = ${fmtU(row.units)} (${row.n} tips, ${row.wins}W/${row.losses}L)\n`;
      } else {
        msg += `⚪ ${lbl} = 0.00u (sem settled)\n`;
      }
    }
    const sum = report.daily7d.reduce((s, d) => s + (d.units || 0), 0);
    msg += `\n7d total: ${fmtU(sum)}\n`;
    msg += `</pre>`;
  } else {
    msg += `\nSem tips settled últimos 7d.\n`;
  }

  // Monthly
  if (report.monthly?.length) {
    msg += `\n<b>Mensal</b>\n<pre>`;
    for (const m of report.monthly.slice(0, 4)) {
      const icon = m.units > 0 ? '🟢' : m.units < 0 ? '🔴' : '⚪';
      const hit = m.hit_rate != null ? ` hit ${m.hit_rate}%` : '';
      msg += `${icon} ${fmtMonth(m.month)}: ${fmtU(m.units)} · ${m.n} tips${hit}\n`;
    }
    msg += `</pre>`;
  }

  // Per sport (mês atual)
  if (report.by_sport_current_month?.length) {
    msg += `\n<b>Por sport (${fmtMonth(new Date().toISOString().slice(0,7))})</b>\n<pre>`;
    for (const s of report.by_sport_current_month) {
      const icon = s.units > 0 ? '🟢' : s.units < 0 ? '🔴' : '⚪';
      msg += `${icon} ${s.sport.padEnd(10)} ${fmtU(s.units)} (${s.wins}/${s.n})\n`;
    }
    msg += `</pre>`;
  }

  // Totals
  const t = report.totals || {};
  msg += `\n<b>Totals</b>\n`;
  msg += `MTD: ${fmtU(t.mtd_units)} · YTD: ${fmtU(t.ytd_units)}\n`;
  if (t.pending_units > 0) msg += `Pending: ${fmtU(t.pending_units)} (${t.pending_n} tips)\n`;
  if (report.unit_value !== 1) msg += `\n<i>1u = R$${report.unit_value}</i>`;
  return msg;
}

module.exports = {
  runWatchdog,
  runDigest,
  runPnlReport,
  formatTelegramAlerts,
  formatTelegramDigest,
  formatTelegramPnl,
  RULES,
};

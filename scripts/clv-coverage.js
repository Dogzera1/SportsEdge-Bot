#!/usr/bin/env node
/**
 * clv-coverage.js — audita cobertura de CLV em market_tips_shadow
 * + regular tips. CLV é capturado só quando scanner re-detecta mesma tip
 * com odd diferente. Tips que aparecem UMA vez não têm close_odd.
 *
 * Uso: node scripts/clv-coverage.js [--days=30]
 */
require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');

const DB_PATH = (process.env.DB_PATH || 'sportsedge.db').trim().replace(/^=+/, '');
const argv = process.argv.slice(2);
const argVal = (n, d) => {
  const i = argv.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
};
const DAYS = parseInt(argVal('days', '30'), 10);

const { db } = initDatabase(DB_PATH);

function pct(a, b) {
  return b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '—';
}

function printTable(title, rows) {
  console.log(`\n## ${title}`);
  if (!rows.length) { console.log('  (sem dados)'); return; }
  const cols = Object.keys(rows[0]);
  console.log('  ' + cols.map(c => c.padEnd(20)).join(' ').slice(0, 120));
  console.log('  ' + cols.map(() => '─'.repeat(20)).join(' ').slice(0, 120));
  for (const r of rows) {
    console.log('  ' + cols.map(c => String(r[c] ?? '—').padEnd(20)).join(' ').slice(0, 120));
  }
}

console.log(`clv-coverage: janela ${DAYS}d\n`);

// MARKET TIPS SHADOW
try {
  const q1 = db.prepare(`
    SELECT sport,
           COUNT(*) AS total,
           SUM(CASE WHEN clv_pct IS NOT NULL THEN 1 ELSE 0 END) AS with_clv,
           SUM(CASE WHEN result IN ('win','loss') THEN 1 ELSE 0 END) AS settled,
           SUM(CASE WHEN result IN ('win','loss') AND clv_pct IS NOT NULL THEN 1 ELSE 0 END) AS settled_with_clv,
           AVG(clv_pct) AS avg_clv
    FROM market_tips_shadow
    WHERE created_at >= datetime('now', '-${DAYS} days')
    GROUP BY sport
    ORDER BY total DESC
  `).all();

  const rows1 = q1.map(r => ({
    sport: r.sport,
    total: r.total,
    with_clv: `${r.with_clv} (${pct(r.with_clv, r.total)})`,
    settled: r.settled,
    settled_with_clv: `${r.settled_with_clv} (${pct(r.settled_with_clv, r.settled)})`,
    avg_clv: r.avg_clv != null ? (r.avg_clv >= 0 ? '+' : '') + r.avg_clv.toFixed(2) + '%' : '—',
  }));
  printTable(`MARKET TIPS SHADOW — por sport`, rows1);
} catch (e) { console.log('market_tips_shadow query err: ' + e.message); }

// MARKET TIPS SHADOW — breakdown por (sport, market, side)
try {
  const q2 = db.prepare(`
    SELECT sport || '/' || market || '/' || side AS key,
           COUNT(*) AS total,
           SUM(CASE WHEN clv_pct IS NOT NULL THEN 1 ELSE 0 END) AS with_clv,
           AVG(clv_pct) AS avg_clv
    FROM market_tips_shadow
    WHERE created_at >= datetime('now', '-${DAYS} days')
    GROUP BY sport, market, side
    HAVING total >= 10
    ORDER BY total DESC
    LIMIT 20
  `).all();

  const rows2 = q2.map(r => ({
    'sport/market/side': r.key.slice(0, 28),
    total: r.total,
    with_clv: `${r.with_clv} (${pct(r.with_clv, r.total)})`,
    avg_clv: r.avg_clv != null ? (r.avg_clv >= 0 ? '+' : '') + r.avg_clv.toFixed(2) + '%' : '—',
  }));
  printTable(`MARKET TIPS SHADOW — por (sport, market, side)`, rows2);
} catch (e) { console.log('breakdown query err: ' + e.message); }

// REGULAR TIPS
try {
  const q3 = db.prepare(`
    SELECT sport,
           COUNT(*) AS total,
           SUM(CASE WHEN clv_odds IS NOT NULL AND clv_odds > 0 THEN 1 ELSE 0 END) AS with_clv,
           SUM(CASE WHEN result IN ('win','loss') THEN 1 ELSE 0 END) AS settled,
           SUM(CASE WHEN result IN ('win','loss') AND clv_odds IS NOT NULL AND clv_odds > 0 THEN 1 ELSE 0 END) AS settled_with_clv
    FROM tips
    WHERE sent_at >= datetime('now', '-${DAYS} days')
      AND (archived IS NULL OR archived = 0)
      AND COALESCE(is_shadow, 0) = 0
    GROUP BY sport
    ORDER BY total DESC
  `).all();

  const rows3 = q3.map(r => ({
    sport: r.sport,
    total: r.total,
    with_clv: `${r.with_clv} (${pct(r.with_clv, r.total)})`,
    settled: r.settled,
    settled_with_clv: `${r.settled_with_clv} (${pct(r.settled_with_clv, r.settled)})`,
  }));
  printTable(`REGULAR TIPS (ML) — por sport`, rows3);
} catch (e) { console.log('regular tips query err: ' + e.message); }

// Tips sem CLV: por que?
console.log('\n## Tips sem CLV — hipóteses:');
console.log('  - tip emitida UMA vez (scanner não re-detectou com odd diferente)');
console.log('  - odd ficou estável (movimentou <0.005)');
console.log('  - match já começou antes do scanner re-rodar');
console.log('\n  Soluções:');
console.log('  - runCloseCaptureCron: cron T-5min antes do start capturando odd final via Pinnacle');
console.log('  - stamp close_odd=current_odd quando is_live flipa de 0→1 no poll');

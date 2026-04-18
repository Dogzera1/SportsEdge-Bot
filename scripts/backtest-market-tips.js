#!/usr/bin/env node
'use strict';

/**
 * backtest-market-tips.js
 *
 * Agrega market_tips_shadow por (sport, market) e reporta:
 *   - n detected, settled, hitRate%, avgEv%, totalProfit units, ROI%
 *
 * Uso:
 *   node scripts/backtest-market-tips.js              # 30d todos sports
 *   node scripts/backtest-market-tips.js --sport=lol
 *   node scripts/backtest-market-tips.js --days=90
 *   node scripts/backtest-market-tips.js --json
 */

const path = require('path');
const Database = require('better-sqlite3');
const { getShadowStats, settleShadowTips } = require('../lib/market-tips-shadow');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}
const SPORT = arg('sport', null);
const DAYS = parseInt(arg('days', '30'), 10);
const asJson = argv.includes('--json');
const doSettle = argv.includes('--settle');

const DB_PATH = path.resolve(__dirname, '..', 'sportsedge.db');
const db = new Database(DB_PATH);

if (doSettle) {
  const r = settleShadowTips(db);
  console.log(`Settlement: ${r.settled} settled, ${r.skipped} skipped`);
}

const stats = getShadowStats(db, { sport: SPORT, days: DAYS });

if (asJson) {
  console.log(JSON.stringify({ days: DAYS, sport: SPORT, rows: stats }, null, 2));
} else {
  console.log(`\n── Market tips shadow backtest (${DAYS}d${SPORT ? ', sport=' + SPORT : ''}) ──\n`);
  if (!stats.length) {
    console.log('  (nenhum market tip logado nesta janela)');
    process.exit(0);
  }
  const hdr = 'Sport     | Market         | n     | Settled | Hit%   | AvgEv%  | ROI%   | Profit (u) | CLVn  | AvgCLV% | CLV+%';
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const r of stats) {
    const hitStr = r.hitRate != null ? r.hitRate.toFixed(1) + '%' : '?';
    const roiStr = r.roiPct != null ? (r.roiPct >= 0 ? '+' : '') + r.roiPct.toFixed(2) + '%' : '?';
    const clvStr = r.avgClv != null ? (r.avgClv >= 0 ? '+' : '') + r.avgClv.toFixed(2) + '%' : '?';
    const clvPosStr = r.clvPositivePct != null ? r.clvPositivePct.toFixed(1) + '%' : '?';
    console.log(
      `${r.sport.padEnd(9)} | ${r.market.padEnd(14)} | ${String(r.n).padStart(5)} | ${String(r.settled).padStart(7)} | ${hitStr.padStart(6)} | ${(r.avgEv >= 0 ? '+' : '') + r.avgEv.toFixed(2).padStart(6)}% | ${roiStr.padStart(7)} | ${r.totalProfit.toFixed(2).padStart(8)} | ${String(r.clvN).padStart(5)} | ${clvStr.padStart(7)} | ${clvPosStr.padStart(5)}`
    );
  }
  // Summary por market
  console.log('\n── Summary por market (across sports) ──');
  const byMarket = new Map();
  for (const r of stats) {
    if (!byMarket.has(r.market)) byMarket.set(r.market, { n: 0, settled: 0, profit: 0, stake: 0, evSum: 0 });
    const m = byMarket.get(r.market);
    m.n += r.n; m.settled += r.settled; m.profit += r.totalProfit;
    if (r.roiPct != null && r.settled > 0) m.stake += (r.totalProfit / (r.roiPct / 100));
    m.evSum += r.avgEv * r.n;
  }
  for (const [market, m] of byMarket) {
    const roi = m.stake > 0 ? (m.profit / m.stake * 100).toFixed(2) : '?';
    console.log(`  ${market.padEnd(14)} n=${m.n} settled=${m.settled} profit=${m.profit.toFixed(1)}u roi≈${roi}% avgEv=${(m.evSum/m.n).toFixed(2)}%`);
  }
}

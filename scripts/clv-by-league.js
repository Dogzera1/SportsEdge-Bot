#!/usr/bin/env node
'use strict';

/**
 * clv-by-league.js
 *
 * Agrega tips settled por (sport, event_name) e reporta:
 *   - n (quantidade)
 *   - hitRate (% win)
 *   - avgEv (EV% reportado na tip)
 *   - avgClvPct ((odd - clv_odds) / clv_odds × 100 — positivo = beat close)
 *   - ROI pct (profit_reais / stake_reais)
 *
 * Uso:
 *   node scripts/clv-by-league.js                  # todos sports, 30d
 *   node scripts/clv-by-league.js --sport=esports
 *   node scripts/clv-by-league.js --days=60
 *   node scripts/clv-by-league.js --json
 */

const path = require('path');
const Database = require('better-sqlite3');

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
const MIN_N = parseInt(arg('min', '5'), 10);

const DB_PATH = path.resolve(__dirname, '..', 'sportsedge.db');
const db = new Database(DB_PATH, { readonly: true });

const filter = SPORT ? ` AND sport = '${SPORT.replace(/'/g, "''")}'` : '';
const rows = db.prepare(`
  SELECT sport, event_name, odds, clv_odds, ev, result, profit_reais,
         stake_reais, COALESCE(stake_reais, 1) AS eff_stake
  FROM tips
  WHERE result IN ('win', 'loss')
    AND odds IS NOT NULL
    AND sent_at >= datetime('now', '-${DAYS} days')
    ${filter}
`).all();

// Agrupa por (sport, event_name cleaned)
const agg = new Map();
function key(s, e) { return `${s}|${(e || '?').trim()}`; }

for (const r of rows) {
  const k = key(r.sport, r.event_name);
  if (!agg.has(k)) agg.set(k, {
    sport: r.sport, league: (r.event_name || '?').trim(),
    n: 0, wins: 0,
    evSum: 0, clvPctSum: 0, roiSum: 0, stakeSum: 0, profitSum: 0,
    clvN: 0,
  });
  const a = agg.get(k);
  a.n++;
  if (r.result === 'win') a.wins++;
  if (Number.isFinite(r.ev)) a.evSum += r.ev;
  if (Number.isFinite(r.clv_odds) && r.clv_odds > 1 && Number.isFinite(r.odds) && r.odds > 1) {
    // CLV pct: (odd_tip - clv_odds) / clv_odds × 100
    //   > 0 = beat close (value captured), < 0 = close moved against you
    a.clvPctSum += ((r.odds - r.clv_odds) / r.clv_odds) * 100;
    a.clvN++;
  }
  a.stakeSum += r.eff_stake || 1;
  if (Number.isFinite(r.profit_reais)) a.profitSum += r.profit_reais;
}

const results = [];
for (const a of agg.values()) {
  if (a.n < MIN_N) continue;
  results.push({
    sport: a.sport,
    league: a.league,
    n: a.n,
    hitRate: +(a.wins / a.n * 100).toFixed(1),
    avgEv: +(a.evSum / a.n).toFixed(2),
    avgClvPct: a.clvN ? +(a.clvPctSum / a.clvN).toFixed(2) : null,
    roi: a.stakeSum > 0 ? +(a.profitSum / a.stakeSum * 100).toFixed(2) : null,
    profit: +a.profitSum.toFixed(2),
  });
}
results.sort((a, b) => (b.n) - (a.n));

if (asJson) {
  console.log(JSON.stringify({ days: DAYS, sport: SPORT, minN: MIN_N, rows: results }, null, 2));
} else {
  console.log(`\n── CLV per-league (last ${DAYS}d${SPORT ? ', sport=' + SPORT : ''}, min n=${MIN_N}) ──\n`);
  const hdr = 'Sport     | League                                | n    | Hit%   | AvgEv%  | CLV%    | ROI%   | Profit';
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const r of results) {
    const clvStr = r.avgClvPct != null ? (r.avgClvPct >= 0 ? '+' : '') + r.avgClvPct.toFixed(2) : '?';
    const roiStr = r.roi != null ? (r.roi >= 0 ? '+' : '') + r.roi.toFixed(2) : '?';
    const flag = r.avgClvPct != null && r.n >= 10 && r.avgClvPct < -2
      ? '  ✗ CLV neg'
      : r.avgClvPct > 2 ? '  ✓ CLV pos'
      : '';
    console.log(
      `${r.sport.padEnd(9)} | ${r.league.slice(0,38).padEnd(38)} | ${String(r.n).padStart(4)} | ${r.hitRate.toFixed(1).padStart(5)}% | ${(r.avgEv >= 0 ? '+' : '') + r.avgEv.toFixed(2).padStart(6)}% | ${clvStr.padStart(7)}% | ${roiStr.padStart(6)}% | ${r.profit.toFixed(2).padStart(7)}${flag}`
    );
  }
  // Summary
  const posClv = results.filter(r => r.avgClvPct != null && r.n >= 10 && r.avgClvPct > 1);
  const negClv = results.filter(r => r.avgClvPct != null && r.n >= 10 && r.avgClvPct < -1);
  console.log('\n── Alertas ──');
  if (posClv.length) {
    console.log(`  ✓ CLV positivo persistente (n≥10): ${posClv.map(r => r.league + ' (+' + r.avgClvPct + '%)').join(', ')}`);
  }
  if (negClv.length) {
    console.log(`  ✗ CLV NEGATIVO persistente (n≥10, leak): ${negClv.map(r => r.league + ' (' + r.avgClvPct + '%)').join(', ')}`);
    console.log('    → Considerar stricter edge threshold ou skip em ligas negativas.');
  }
}

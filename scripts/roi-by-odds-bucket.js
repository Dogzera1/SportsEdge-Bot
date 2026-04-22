#!/usr/bin/env node
'use strict';

/**
 * roi-by-odds-bucket.js
 *
 * Agrega tips settled por faixa de odd e reporta:
 *   - n (quantidade)
 *   - hitRate (% win)
 *   - avgEv (EV% reportado na tip)
 *   - avgClvPct ((odd_tip - clv_odds) / clv_odds × 100)
 *   - ROI pct (profit_reais / stake_reais)
 *
 * Buckets default (conservadores, pra garantir n≥30 no médio prazo):
 *   [1.01, 1.40)   deep_fav
 *   [1.40, 1.70)   fav
 *   [1.70, 2.20)   slight_fav
 *   [2.20, 3.00)   underdog_leve
 *   [3.00, ∞)      longshot
 *
 * Uso:
 *   node scripts/roi-by-odds-bucket.js                        # todos sports, 30d, breakdown por sport
 *   node scripts/roi-by-odds-bucket.js --sport=lol
 *   node scripts/roi-by-odds-bucket.js --days=90
 *   node scripts/roi-by-odds-bucket.js --global-only          # sem breakdown per-sport
 *   node scripts/roi-by-odds-bucket.js --json
 *   node scripts/roi-by-odds-bucket.js --min=10               # min n p/ aparecer na tabela
 */

try { require('dotenv').config({ override: true }); } catch (_) {}
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
const MIN_N = parseInt(arg('min', '5'), 10);
const asJson = argv.includes('--json');
const globalOnly = argv.includes('--global-only');
const includeArchived = argv.includes('--include-archived');

const BUCKETS = [
  { label: '1.01-1.40', min: 1.01, max: 1.40, tag: 'deep_fav' },
  { label: '1.40-1.70', min: 1.40, max: 1.70, tag: 'fav' },
  { label: '1.70-2.20', min: 1.70, max: 2.20, tag: 'slight_fav' },
  { label: '2.20-3.00', min: 2.20, max: 3.00, tag: 'underdog_leve' },
  { label: '3.00+',     min: 3.00, max: Infinity, tag: 'longshot' },
];

function bucketOf(odd) {
  for (const b of BUCKETS) {
    if (odd >= b.min && odd < b.max) return b;
  }
  return null;
}

const DB_PATH = (arg('db', null) || process.env.DB_PATH || path.resolve(__dirname, '..', 'sportsedge.db'))
  .trim().replace(/^=+/, '');
const db = new Database(DB_PATH, { readonly: true });

const sportFilter = SPORT ? ` AND sport = '${SPORT.replace(/'/g, "''")}'` : '';
const rows = db.prepare(`
  SELECT sport, odds, clv_odds, ev, result, profit_reais,
         COALESCE(stake_reais, 1) AS eff_stake
  FROM tips
  WHERE result IN ('win', 'loss')
    AND odds IS NOT NULL
    AND odds > 1
    ${includeArchived ? '' : "AND (archived IS NULL OR archived = 0)"}
    AND sent_at >= datetime('now', '-${DAYS} days')
    ${sportFilter}
`).all();

function emptyAgg() {
  return { n: 0, wins: 0, evSum: 0, clvPctSum: 0, clvN: 0, stakeSum: 0, profitSum: 0 };
}

// aggBySport[sport][bucketTag] = agg; aggBySport['__ALL__'][bucketTag] = global
const aggBySport = new Map();
function ensure(s, tag) {
  if (!aggBySport.has(s)) aggBySport.set(s, new Map());
  const m = aggBySport.get(s);
  if (!m.has(tag)) m.set(tag, emptyAgg());
  return m.get(tag);
}

for (const r of rows) {
  const odd = Number(r.odds);
  const b = bucketOf(odd);
  if (!b) continue;
  for (const s of [r.sport, '__ALL__']) {
    const a = ensure(s, b.tag);
    a.n++;
    if (r.result === 'win') a.wins++;
    if (Number.isFinite(r.ev)) a.evSum += r.ev;
    if (Number.isFinite(r.clv_odds) && r.clv_odds > 1) {
      a.clvPctSum += ((odd - r.clv_odds) / r.clv_odds) * 100;
      a.clvN++;
    }
    a.stakeSum += r.eff_stake || 1;
    if (Number.isFinite(r.profit_reais)) a.profitSum += r.profit_reais;
  }
}

function summarize(a) {
  return {
    n: a.n,
    hitRate: a.n ? +(a.wins / a.n * 100).toFixed(1) : null,
    avgEv: a.n ? +(a.evSum / a.n).toFixed(2) : null,
    avgClvPct: a.clvN ? +(a.clvPctSum / a.clvN).toFixed(2) : null,
    roi: a.stakeSum > 0 ? +(a.profitSum / a.stakeSum * 100).toFixed(2) : null,
    profit: +a.profitSum.toFixed(2),
  };
}

function buildTable(sportKey) {
  const m = aggBySport.get(sportKey);
  if (!m) return [];
  return BUCKETS.map(b => {
    const a = m.get(b.tag) || emptyAgg();
    return { bucket: b.label, tag: b.tag, ...summarize(a) };
  });
}

function fmtPct(v, n = 2, signed = true) {
  if (v === null || !Number.isFinite(v)) return '?';
  const s = v.toFixed(n);
  return (signed && v >= 0 ? '+' : '') + s + '%';
}

function printTable(title, rows) {
  console.log(`\n── ${title} ──\n`);
  const hdr = 'Bucket      | n     | Hit%    | AvgEv%   | CLV%     | ROI%     | Profit   | Flag';
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const r of rows) {
    if (r.n < MIN_N) continue;
    const hit = r.hitRate != null ? r.hitRate.toFixed(1) + '%' : '?';
    const ev = fmtPct(r.avgEv);
    const clv = fmtPct(r.avgClvPct);
    const roi = fmtPct(r.roi);
    // leak flag: ROI < -5% com n≥30 OU CLV < -2% com n≥30
    let flag = '';
    if (r.n >= 30 && r.roi !== null && r.roi < -5) flag = '✗ ROI leak';
    else if (r.n >= 30 && r.avgClvPct !== null && r.avgClvPct < -2) flag = '✗ CLV leak';
    else if (r.n >= 30 && r.roi !== null && r.roi > 5) flag = '✓ edge';
    console.log(
      `${r.bucket.padEnd(11)} | ${String(r.n).padStart(5)} | ${hit.padStart(7)} | ${ev.padStart(8)} | ${clv.padStart(8)} | ${roi.padStart(8)} | ${r.profit.toFixed(2).padStart(8)} | ${flag}`
    );
  }
}

if (asJson) {
  const out = {
    days: DAYS,
    sport: SPORT,
    minN: MIN_N,
    global: buildTable('__ALL__'),
    bySport: {},
  };
  for (const [s, _] of aggBySport) {
    if (s === '__ALL__') continue;
    out.bySport[s] = buildTable(s);
  }
  console.log(JSON.stringify(out, null, 2));
} else {
  const globalRows = buildTable('__ALL__');
  printTable(
    `ROI por faixa de odd (${DAYS}d${SPORT ? ', sport=' + SPORT : ', todos sports'}, min n=${MIN_N})`,
    globalRows
  );

  // Alertas globais
  const leaks = globalRows.filter(r => r.n >= 30 && r.roi !== null && r.roi < -5);
  const edges = globalRows.filter(r => r.n >= 30 && r.roi !== null && r.roi > 5);
  console.log('\n── Alertas globais ──');
  if (leaks.length) {
    console.log('  ✗ Buckets com ROI leak (n≥30, ROI<-5%):');
    for (const l of leaks) {
      console.log(`     ${l.bucket}: n=${l.n}, ROI=${fmtPct(l.roi)}, CLV=${fmtPct(l.avgClvPct)}`);
    }
    console.log('    → Candidatos pra apertar gate de odds ou exigir EV maior nessa faixa.');
  }
  if (edges.length) {
    console.log('  ✓ Buckets rentáveis (n≥30, ROI>+5%):');
    for (const e of edges) {
      console.log(`     ${e.bucket}: n=${e.n}, ROI=${fmtPct(e.roi)}`);
    }
  }
  if (!leaks.length && !edges.length) {
    console.log('  (nenhum bucket com n≥30 cruzou thresholds — sample pequeno ou performance neutra)');
  }

  if (!globalOnly && !SPORT) {
    console.log('\n── Breakdown per-sport ──');
    const sports = [...aggBySport.keys()].filter(s => s !== '__ALL__').sort();
    for (const s of sports) {
      const sRows = buildTable(s);
      const total = sRows.reduce((acc, r) => acc + r.n, 0);
      if (total < MIN_N) continue;
      printTable(`sport=${s}`, sRows);
    }
  }
}

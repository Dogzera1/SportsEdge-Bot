#!/usr/bin/env node
'use strict';

/**
 * audit-leaks.js
 *
 * Audita 3 dimensões que ainda não tinham relatório dedicado:
 *   1. Confidence calibration (ALTA/MÉDIA/BAIXA hit% por sport)
 *      → ALTA deve > MÉDIA > BAIXA. Se não, conf assignment quebrado.
 *   2. Live vs pre-match ROI
 *      → Live espera-se pior que pre (delay de odds). Mas se diferença
 *        for >20pp, gate live precisa apertar.
 *   3. Stake sizing vs ROI
 *      → Tips com stake alto (Kelly forte) deveriam ter ROI ≥ stake baixo.
 *        Se ROI cai com stake, Kelly tá miscalibrado pro EV reportado.
 *
 * Uso:
 *   node scripts/audit-leaks.js                       # 60d, todos sports
 *   node scripts/audit-leaks.js --since=2026-04-22    # só novo regime
 *   node scripts/audit-leaks.js --sport=tennis
 *   node scripts/audit-leaks.js --json
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
const DAYS = parseInt(arg('days', '60'), 10);
const SINCE = arg('since', null);
const asJson = argv.includes('--json');

const REGIME_CHANGE_DATE = '2026-04-22';

const DB_PATH = (arg('db', null) || process.env.DB_PATH || path.resolve(__dirname, '..', 'sportsedge.db'))
  .trim().replace(/^=+/, '');
const db = new Database(DB_PATH, { readonly: true });

const useSince = SINCE && /^\d{4}-\d{2}-\d{2}$/.test(SINCE);
const timeFilter = useSince
  ? `AND sent_at >= '${SINCE} 00:00:00'`
  : `AND sent_at >= datetime('now', '-${DAYS} days')`;
const sportFilter = SPORT ? `AND sport = '${SPORT.replace(/'/g, "''")}'` : '';

const baseWhere = `
  WHERE result IN ('win', 'loss')
    AND odds IS NOT NULL AND odds > 1
    AND (archived IS NULL OR archived = 0)
    AND COALESCE(is_shadow, 0) = 0
    ${timeFilter}
    ${sportFilter}
`;

const tips = db.prepare(`
  SELECT sport, odds, ev, stake, confidence, is_live, result,
         COALESCE(stake_reais, 0) AS staked,
         COALESCE(profit_reais, 0) AS profit
  FROM tips
  ${baseWhere}
`).all();

if (!tips.length) {
  console.log(`Sem tips settled. Tente --days maior ou remover --sport.`);
  process.exit(0);
}

function normConf(c) {
  const s = String(c || '').toUpperCase();
  if (s === 'ALTA' || s === 'HIGH') return 'ALTA';
  if (s === 'BAIXA' || s === 'LOW') return 'BAIXA';
  if (s === 'MEDIA' || s === 'MÉDIA' || s === 'MED') return 'MEDIA';
  return 'OTHER';
}

function parseStake(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/u/i, '').trim());
  return Number.isFinite(n) ? n : null;
}

function stakeBucket(s) {
  if (s == null) return 'unknown';
  if (s < 1) return '<1u';
  if (s < 1.5) return '1u';
  if (s < 2.5) return '2u';
  if (s < 3.5) return '3u';
  return '4u+';
}

function summarize(arr) {
  if (!arr.length) return null;
  const wins = arr.filter(t => t.result === 'win').length;
  const staked = arr.reduce((s, t) => s + Number(t.staked || 0), 0);
  const profit = arr.reduce((s, t) => s + Number(t.profit || 0), 0);
  const evSum = arr.reduce((s, t) => s + (Number(t.ev) || 0), 0);
  return {
    n: arr.length,
    hitRate: +(wins / arr.length * 100).toFixed(1),
    avgEv: +(evSum / arr.length).toFixed(2),
    roi: staked > 0 ? +(profit / staked * 100).toFixed(2) : null,
    profit: +profit.toFixed(2),
  };
}

// Agrupa por (sport, dim, value). dim ∈ {confidence, isLive, stakeBucket}
function groupBy(keyFn) {
  const m = new Map();
  for (const t of tips) {
    const k = keyFn(t);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  const out = [];
  for (const [k, arr] of m) out.push({ key: k, ...summarize(arr) });
  return out;
}

const sports = [...new Set(tips.map(t => t.sport))].sort();

// ── 1. Confidence calibration ──
const dim1 = []; // {sport, conf, n, hit, ev, roi, profit}
for (const s of sports) {
  for (const conf of ['ALTA', 'MEDIA', 'BAIXA']) {
    const arr = tips.filter(t => t.sport === s && normConf(t.confidence) === conf);
    if (!arr.length) continue;
    dim1.push({ sport: s, conf, ...summarize(arr) });
  }
}

// Detecta inversões: ALTA hit% < MEDIA, MEDIA hit% < BAIXA
const confInversions = [];
for (const s of sports) {
  const alta = dim1.find(r => r.sport === s && r.conf === 'ALTA');
  const media = dim1.find(r => r.sport === s && r.conf === 'MEDIA');
  const baixa = dim1.find(r => r.sport === s && r.conf === 'BAIXA');
  // Só flagga se ambos têm n ≥ 15 (evitar ruído de sample pequeno)
  if (alta && media && alta.n >= 15 && media.n >= 15 && alta.hitRate < media.hitRate - 3) {
    confInversions.push(`${s}: ALTA hit ${alta.hitRate}% < MEDIA ${media.hitRate}% (Δ ${(alta.hitRate - media.hitRate).toFixed(1)}pp)`);
  }
  if (media && baixa && media.n >= 15 && baixa.n >= 15 && media.hitRate < baixa.hitRate - 3) {
    confInversions.push(`${s}: MEDIA hit ${media.hitRate}% < BAIXA ${baixa.hitRate}% (Δ ${(media.hitRate - baixa.hitRate).toFixed(1)}pp)`);
  }
}

// ── 2. Live vs pre-match ──
const dim2 = [];
for (const s of sports) {
  for (const isLive of [0, 1]) {
    const arr = tips.filter(t => t.sport === s && (t.is_live ? 1 : 0) === isLive);
    if (!arr.length) continue;
    dim2.push({ sport: s, mode: isLive ? 'LIVE' : 'PRE', ...summarize(arr) });
  }
}

const liveLeaks = [];
for (const s of sports) {
  const pre = dim2.find(r => r.sport === s && r.mode === 'PRE');
  const live = dim2.find(r => r.sport === s && r.mode === 'LIVE');
  if (pre && live && pre.n >= 15 && live.n >= 15) {
    const roiDiff = (pre.roi ?? 0) - (live.roi ?? 0);
    if (roiDiff > 20) {
      liveLeaks.push(`${s}: PRE ROI ${pre.roi}% vs LIVE ROI ${live.roi}% (Δ ${roiDiff.toFixed(1)}pp)`);
    }
  }
}

// ── 3. Stake sizing ──
const dim3 = []; // {sport, bucket, n, hit, roi, profit}
const STAKE_ORDER = ['<1u', '1u', '2u', '3u', '4u+', 'unknown'];
for (const s of sports) {
  for (const bucket of STAKE_ORDER) {
    const arr = tips.filter(t => t.sport === s && stakeBucket(parseStake(t.stake)) === bucket);
    if (!arr.length) continue;
    dim3.push({ sport: s, bucket, ...summarize(arr) });
  }
}

// Detecta: stake maior tem ROI menor (Kelly miscalibrado)
const stakeInversions = [];
for (const s of sports) {
  const buckets = ['1u', '2u', '3u', '4u+']
    .map(b => dim3.find(r => r.sport === s && r.bucket === b))
    .filter(b => b && b.n >= 10 && b.roi != null);
  if (buckets.length >= 2) {
    // Procura inversão: maior stake → menor ROI
    for (let i = 0; i < buckets.length - 1; i++) {
      for (let j = i + 1; j < buckets.length; j++) {
        const a = buckets[i], c = buckets[j];
        if (c.roi < a.roi - 15) {
          stakeInversions.push(`${s}: stake ${c.bucket} ROI ${c.roi}% < ${a.bucket} ROI ${a.roi}% (Δ ${(c.roi - a.roi).toFixed(1)}pp)`);
          break; // só reporta o pior
        }
      }
    }
  }
}

const periodLabel = useSince ? `desde ${SINCE}` + (SINCE === REGIME_CHANGE_DATE ? ' [novo regime]' : '') : `${DAYS}d`;

if (asJson) {
  console.log(JSON.stringify({
    period: periodLabel, totalTips: tips.length,
    confidence: { rows: dim1, inversions: confInversions },
    liveVsPre: { rows: dim2, leaks: liveLeaks },
    stakeSizing: { rows: dim3, inversions: stakeInversions },
  }, null, 2));
  process.exit(0);
}

console.log(`\n══════ AUDIT-LEAKS (${periodLabel}, n=${tips.length}) ══════`);

// 1
console.log(`\n── 1. Confidence calibration (esperado: ALTA hit% > MEDIA > BAIXA) ──`);
console.log('  Sport     | Conf    | n     | Hit%   | AvgEv%  | ROI%    | Profit');
console.log('  ' + '-'.repeat(70));
for (const r of dim1) {
  const roi = r.roi != null ? (r.roi >= 0 ? '+' : '') + r.roi.toFixed(2) + '%' : '?';
  console.log(`  ${r.sport.padEnd(9)} | ${r.conf.padEnd(7)} | ${String(r.n).padStart(5)} | ${r.hitRate.toFixed(1).padStart(5)}% | ${(r.avgEv >= 0 ? '+' : '') + r.avgEv.toFixed(2).padStart(6)}% | ${roi.padStart(7)} | ${r.profit.toFixed(2).padStart(7)}`);
}
if (confInversions.length) {
  console.log('\n  ✗ Inversões (n≥15, hit% caiu ≥3pp):');
  for (const i of confInversions) console.log(`     ${i}`);
} else {
  console.log('\n  ✓ Nenhuma inversão crítica detectada');
}

// 2
console.log(`\n── 2. Live vs Pre-match ROI ──`);
console.log('  Sport     | Mode | n     | Hit%   | AvgEv%  | ROI%    | Profit');
console.log('  ' + '-'.repeat(68));
for (const r of dim2) {
  const roi = r.roi != null ? (r.roi >= 0 ? '+' : '') + r.roi.toFixed(2) + '%' : '?';
  console.log(`  ${r.sport.padEnd(9)} | ${r.mode.padEnd(4)} | ${String(r.n).padStart(5)} | ${r.hitRate.toFixed(1).padStart(5)}% | ${(r.avgEv >= 0 ? '+' : '') + r.avgEv.toFixed(2).padStart(6)}% | ${roi.padStart(7)} | ${r.profit.toFixed(2).padStart(7)}`);
}
if (liveLeaks.length) {
  console.log('\n  ✗ Live ROI muito pior que Pre (Δ>20pp):');
  for (const l of liveLeaks) console.log(`     ${l}`);
} else {
  console.log('\n  ✓ Nenhum gap LIVE vs PRE crítico (>20pp)');
}

// 3
console.log(`\n── 3. Stake sizing vs ROI (esperado: ROI estável ou crescente com stake) ──`);
console.log('  Sport     | Stake   | n     | Hit%   | AvgEv%  | ROI%    | Profit');
console.log('  ' + '-'.repeat(70));
for (const r of dim3) {
  const roi = r.roi != null ? (r.roi >= 0 ? '+' : '') + r.roi.toFixed(2) + '%' : '?';
  console.log(`  ${r.sport.padEnd(9)} | ${r.bucket.padEnd(7)} | ${String(r.n).padStart(5)} | ${r.hitRate.toFixed(1).padStart(5)}% | ${(r.avgEv >= 0 ? '+' : '') + r.avgEv.toFixed(2).padStart(6)}% | ${roi.padStart(7)} | ${r.profit.toFixed(2).padStart(7)}`);
}
if (stakeInversions.length) {
  console.log('\n  ✗ Stake maior com ROI menor (Δ>15pp, n≥10) — Kelly miscalibrado:');
  for (const i of stakeInversions) console.log(`     ${i}`);
} else {
  console.log('\n  ✓ Stake sizing consistente');
}

console.log('\n');

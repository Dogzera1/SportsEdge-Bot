#!/usr/bin/env node
'use strict';

/**
 * ai-impact-report.js — mede ROI/hit-rate/CLV das tips agrupadas por
 * "path de IA" (normal, override, hybrid) pra decidir se a IA é necessária.
 *
 * - IA normal: IA aprovou a pick do modelo (sem sufixo no model_label).
 * - IA override: IA disse SEM_EDGE mas modelo teve sinal forte → tip foi com
 *   CONF=BAIXA stake=1u. model_label contém "+override".
 * - IA hybrid: caso especial (path deterministic paralelo). model_label contém "+hybrid".
 *
 * Output: tabela per-sport + conclusão se vale manter IA.
 *
 * Uso:
 *   node scripts/ai-impact-report.js              (default 60d)
 *   node scripts/ai-impact-report.js --days 90
 *   node scripts/ai-impact-report.js --sport cs   (só 1 esporte)
 *   node scripts/ai-impact-report.js --db /path/prod.db
 */

require('dotenv').config({ override: true });
const path = require('path');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const DAYS = parseInt(argVal('days', '60'), 10);
const SPORT_FILTER = argVal('sport', null);
const DB_PATH = (argVal('db', null) || process.env.DB_PATH || path.join(__dirname, '..', 'sportsedge.db'))
  .trim().replace(/^=+/, '');

const initDatabase = require('../lib/database');
const { db } = initDatabase(DB_PATH);

console.log(`[ai-impact] db=${DB_PATH}`);
console.log(`[ai-impact] window=${DAYS}d${SPORT_FILTER ? ` sport=${SPORT_FILTER}` : ''}\n`);

// Classifica path pelo model_label. Retorna 'normal' | 'override' | 'hybrid' | 'no_ai'.
function pathOf(label, reason) {
  const l = String(label || '');
  const r = String(reason || '');
  if (/\+override/i.test(l)) return 'override';
  if (/\+hybrid/i.test(l)) return 'hybrid';
  if (/fallback em backoff IA|fallback sem IA|sem IA|determin/i.test(r)) return 'no_ai';
  return 'normal';
}

const rows = db.prepare(`
  SELECT sport, odds, ev, stake, result, model_label, tip_reason,
         stake_reais, profit_reais, clv_odds, open_odds, is_shadow, confidence
  FROM tips
  WHERE sent_at >= datetime('now', ?)
    AND result IN ('win', 'loss', 'void')
    ${SPORT_FILTER ? "AND sport = ?" : ''}
`).all(
  `-${DAYS} days`,
  ...(SPORT_FILTER ? [SPORT_FILTER] : [])
);

if (!rows.length) {
  console.log('Sem tips settled no período. Aborta.');
  process.exit(0);
}

// Aggregate por sport × path
const buckets = new Map(); // `${sport}|${path}` → acc

function accFor(key) {
  if (!buckets.has(key)) {
    buckets.set(key, {
      n: 0, wins: 0, losses: 0, voids: 0,
      totalStake: 0, totalProfit: 0,
      evSum: 0, clvSum: 0, clvN: 0,
      conf: { ALTA: 0, MÉDIA: 0, BAIXA: 0 },
    });
  }
  return buckets.get(key);
}

for (const r of rows) {
  if (r.is_shadow) continue; // só tips reais
  const p = pathOf(r.model_label, r.tip_reason);
  const key = `${r.sport}|${p}`;
  const acc = accFor(key);
  acc.n++;
  if (r.result === 'win') acc.wins++;
  else if (r.result === 'loss') acc.losses++;
  else if (r.result === 'void') acc.voids++;
  // Tudo em units (stake já é número via `CAST`). profit = stake × (odd-1) em win, -stake em loss.
  const _stake = parseFloat(String(r.stake || '').replace(/u/i, '')) || 0;
  const _odd = parseFloat(r.odds) || 0;
  acc.totalStake += _stake;
  acc.totalProfit += r.result === 'win' ? _stake * (_odd - 1)
                   : r.result === 'loss' ? -_stake
                   : 0;
  acc.evSum += +r.ev || 0;
  if (r.clv_odds && r.open_odds) {
    const clvPct = ((+r.clv_odds / +r.open_odds) - 1) * 100;
    if (Number.isFinite(clvPct)) { acc.clvSum += clvPct; acc.clvN++; }
  }
  if (r.confidence && acc.conf[r.confidence] !== undefined) acc.conf[r.confidence]++;
}

// Sort: sport asc, then path fixed order
const PATH_ORDER = ['normal', 'override', 'hybrid', 'no_ai'];
const sports = new Set([...buckets.keys()].map(k => k.split('|')[0]));

const fmt = (n, d = 1) => Number.isFinite(+n) ? (+n).toFixed(d) : 'n/a';

console.log('────────────────────────────────────────────────────────────────────────────');
console.log('Sport     Path       n    W/L/V     Hit%    avgEV%    ROI%     CLV%    Conf');
console.log('────────────────────────────────────────────────────────────────────────────');

const overall = new Map(); // path → {n, stake, profit, wins, nonVoid}

for (const sport of [...sports].sort()) {
  for (const p of PATH_ORDER) {
    const acc = buckets.get(`${sport}|${p}`);
    if (!acc) continue;
    const nonVoid = acc.wins + acc.losses;
    const hit = nonVoid > 0 ? (acc.wins / nonVoid * 100) : 0;
    const avgEV = acc.n > 0 ? (acc.evSum / acc.n) : 0;
    const roi = acc.totalStake > 0 ? (acc.totalProfit / acc.totalStake * 100) : 0;
    const clv = acc.clvN > 0 ? (acc.clvSum / acc.clvN) : null;
    const confTop = Object.entries(acc.conf).sort((a, b) => b[1] - a[1])[0];
    const confStr = confTop && confTop[1] > 0 ? `${confTop[0].slice(0, 3)}/${confTop[1]}` : '-';

    console.log(
      `${sport.padEnd(9)} ${p.padEnd(10)} ${String(acc.n).padStart(4)}  ${acc.wins}/${acc.losses}/${acc.voids}${' '.repeat(Math.max(0, 8 - `${acc.wins}/${acc.losses}/${acc.voids}`.length))} ${fmt(hit).padStart(5)}   ${fmt(avgEV).padStart(5)}    ${fmt(roi).padStart(6)}  ${clv != null ? fmt(clv).padStart(6) : '   n/a'}  ${confStr}`
    );

    const o = overall.get(p) || { n: 0, stake: 0, profit: 0, wins: 0, nonVoid: 0, clvSum: 0, clvN: 0 };
    o.n += acc.n; o.stake += acc.totalStake; o.profit += acc.totalProfit;
    o.wins += acc.wins; o.nonVoid += nonVoid;
    o.clvSum += acc.clvSum; o.clvN += acc.clvN;
    overall.set(p, o);
  }
}

console.log('────────────────────────────────────────────────────────────────────────────');
console.log('\n── OVERALL (agregado cross-sport) ─────────────────────────────────────────');

for (const p of PATH_ORDER) {
  const o = overall.get(p);
  if (!o || !o.n) continue;
  const hit = o.nonVoid > 0 ? (o.wins / o.nonVoid * 100) : 0;
  const roi = o.stake > 0 ? (o.profit / o.stake * 100) : 0;
  const clv = o.clvN > 0 ? (o.clvSum / o.clvN) : null;
  console.log(`${p.padEnd(10)} n=${String(o.n).padStart(4)}  Hit%=${fmt(hit).padStart(5)}  ROI%=${fmt(roi).padStart(6)}  CLV%=${clv != null ? fmt(clv).padStart(6) : ' n/a'}`);
}

console.log('\n── Interpretação ──────────────────────────────────────────────────────────');
const normal = overall.get('normal');
const override = overall.get('override');
if (normal && override && normal.n >= 30 && override.n >= 15) {
  const roiN = normal.stake > 0 ? (normal.profit / normal.stake * 100) : 0;
  const roiO = override.stake > 0 ? (override.profit / override.stake * 100) : 0;
  const delta = roiN - roiO;
  console.log(`ROI normal (IA aprovou) = ${fmt(roiN)}%`);
  console.log(`ROI override (IA disse SEM_EDGE, modelo vetou) = ${fmt(roiO)}%`);
  console.log(`Δ ROI (normal − override) = ${delta >= 0 ? '+' : ''}${fmt(delta)}pp`);
  if (Math.abs(delta) < 1) {
    console.log(`→ IA NÃO está agregando valor mensurável. Considere desligar em esports maduros.`);
  } else if (delta > 3) {
    console.log(`→ IA está filtrando tips ruins: quando ela aprova, ROI é melhor. Manter como gate.`);
  } else if (delta < -3) {
    console.log(`→ IA está rejeitando tips lucrativas (override>normal). Modelo está melhor sem IA.`);
  } else {
    console.log(`→ Efeito pequeno da IA (|Δ| < 3pp). Sub-amostra pode ruidar. Olhar per-sport.`);
  }
} else {
  console.log(`Amostras insuficientes (normal=${normal?.n ?? 0}, override=${override?.n ?? 0}) pra conclusão robusta. Precisa de n≥30 normal + n≥15 override.`);
}

console.log('\n[ai-impact] done');

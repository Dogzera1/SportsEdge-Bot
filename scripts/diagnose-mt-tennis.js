#!/usr/bin/env node
/**
 * diagnose-mt-tennis.js — audita as tips "vencedoras" de tennis MT shadow pra
 * distinguir edge real de sorte/bug.
 *
 * Contexto: dashboard mostrou handicapSets/home 97.4% hit ROI +55% mas CLV -2.8%.
 * High hit + neg CLV = sorte/bug, não edge. Este script cava por linha, faixa
 * de pModel, liga e fase do torneio pra identificar onde o 'ganho' veio.
 *
 * Uso:
 *   node scripts/diagnose-mt-tennis.js
 *   node scripts/diagnose-mt-tennis.js --days=60 --market=handicapSets --side=home
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
const MARKET = argVal('market', null);
const SIDE = argVal('side', null);
const SPORT = argVal('sport', 'tennis');

const { db } = initDatabase(DB_PATH);

function bucket(x, edges, labels) {
  for (let i = 0; i < edges.length; i++) if (x < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

function groupBy(rows, keyFn) {
  const out = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    const st = out.get(k) || { n: 0, wins: 0, staked: 0, profit: 0, clvSum: 0, clvN: 0, pSum: 0 };
    st.n++;
    if (r.result === 'win') st.wins++;
    st.staked += Number(r.stake_units || 1);
    st.profit += Number(r.profit_units || 0);
    if (r.clv_pct != null && Number.isFinite(r.clv_pct)) { st.clvSum += r.clv_pct; st.clvN++; }
    st.pSum += Number(r.p_model || 0);
    out.set(k, st);
  }
  return [...out.entries()].map(([k, s]) => ({
    key: k,
    n: s.n,
    winRate: +(s.wins / s.n * 100).toFixed(1),
    roi: s.staked > 0 ? +(s.profit / s.staked * 100).toFixed(1) : null,
    profit: +s.profit.toFixed(2),
    avgClv: s.clvN ? +(s.clvSum / s.clvN).toFixed(2) : null,
    clvN: s.clvN,
    avgPModel: +(s.pSum / s.n).toFixed(3),
  })).sort((a, b) => b.n - a.n);
}

function printTable(title, rows, maxRows = 15) {
  if (!rows.length) return;
  console.log(`\n## ${title}`);
  console.log(`${'key'.padEnd(30)} ${'n'.padStart(4)} ${'win%'.padStart(6)} ${'roi'.padStart(7)} ${'P&L'.padStart(7)} ${'CLV'.padStart(7)} ${'pMod'.padStart(6)}`);
  for (const r of rows.slice(0, maxRows)) {
    const key = String(r.key).slice(0, 29).padEnd(30);
    const clv = r.avgClv == null ? '—' : (r.avgClv >= 0 ? '+' : '') + r.avgClv.toFixed(1) + '%';
    const roi = r.roi == null ? '—' : (r.roi >= 0 ? '+' : '') + r.roi + '%';
    console.log(`${key} ${String(r.n).padStart(4)} ${(r.winRate + '%').padStart(6)} ${roi.padStart(7)} ${((r.profit >= 0 ? '+' : '') + r.profit.toFixed(1) + 'u').padStart(7)} ${clv.padStart(7)}(${String(r.clvN).padStart(2)}) ${String(r.avgPModel).padStart(6)}`);
  }
}

(() => {
  const conds = [`created_at >= datetime('now', '-${DAYS} days')`, `sport = ?`, `result IN ('win','loss')`];
  const params = [SPORT];
  if (MARKET) { conds.push('market = ?'); params.push(MARKET); }
  if (SIDE) { conds.push('side = ?'); params.push(SIDE); }

  const rows = db.prepare(`
    SELECT team1, team2, league, market, line, side, odd, p_model, p_implied,
           ev_pct, clv_pct, stake_units, profit_units, result, is_live,
           close_odd, created_at, best_of
    FROM market_tips_shadow
    WHERE ${conds.join(' AND ')}
    ORDER BY created_at DESC
  `).all(...params);

  console.log(`diagnose-mt-tennis: ${rows.length} tips settled últimos ${DAYS}d (sport=${SPORT}${MARKET ? ` market=${MARKET}` : ''}${SIDE ? ` side=${SIDE}` : ''})`);
  if (!rows.length) { console.log('sem dados'); process.exit(0); }

  // 1. Breakdown by (market, side) — confirma o que o dashboard mostra
  printTable('by (market, side)', groupBy(rows, r => `${r.market}/${r.side}`));

  // 2. Breakdown por linha (handicapSets +1.5 vs -1.5 etc; totalGames 21.5 vs 22.5 etc)
  printTable('by (market, side, line)', groupBy(rows, r => `${r.market}/${r.side} line=${r.line}`));

  // 3. Breakdown por pModel bucket — modelo confiando demais?
  const pBuckets = [0.55, 0.65, 0.75, 0.85, 0.95];
  const pLabels = ['<55%', '55-65%', '65-75%', '75-85%', '85-95%', '>=95%'];
  printTable('by pModel bucket', groupBy(rows, r => bucket(r.p_model, pBuckets, pLabels)));

  // 4. Breakdown por odd bucket
  const oBuckets = [1.40, 1.60, 1.80, 2.00, 2.50];
  const oLabels = ['<1.40', '1.40-1.60', '1.60-1.80', '1.80-2.00', '2.00-2.50', '>=2.50'];
  printTable('by odd bucket', groupBy(rows, r => bucket(r.odd, oBuckets, oLabels)));

  // 5. Breakdown by league (top 10)
  printTable('by league (top sample)', groupBy(rows, r => (r.league || 'unknown').slice(0, 28)));

  // 6. Breakdown is_live pre-match vs live
  printTable('by is_live', groupBy(rows, r => r.is_live ? 'LIVE' : 'PRE'));

  // 7. Sanity red flags
  console.log('\n## RED FLAGS');
  const highHit = rows.filter(r => r.result === 'win').length / rows.length;
  const avgClv = rows.filter(r => r.clv_pct != null).reduce((s, r) => s + r.clv_pct, 0) / Math.max(1, rows.filter(r => r.clv_pct != null).length);
  const implied = rows.reduce((s, r) => s + (1 / (r.odd || 2)), 0) / rows.length;
  console.log(`  hit rate overall: ${(highHit * 100).toFixed(1)}% vs implícita média ${(implied * 100).toFixed(1)}%`);
  console.log(`  CLV médio: ${avgClv.toFixed(2)}% (negativo = mercado move contra = não é edge real)`);
  if (avgClv < 0 && highHit > 0.65) {
    console.log(`  🚩 High hit (${(highHit * 100).toFixed(1)}%) + CLV negativo → sorte/bug, não edge. ROI vai corrigir negativo no longo prazo.`);
  }

  // 8. Preço vs modelo — overestimation check
  const bigGap = rows.filter(r => r.p_model && r.p_implied && (r.p_model - r.p_implied) > 0.15);
  console.log(`\n  tips com pModel - pImplied > 15pp: ${bigGap.length}/${rows.length} (${(bigGap.length/rows.length*100).toFixed(1)}%)`);
  if (bigGap.length > 0) {
    const hitBigGap = bigGap.filter(r => r.result === 'win').length / bigGap.length;
    console.log(`    hit rate dessas: ${(hitBigGap * 100).toFixed(1)}% (se modelo está certo, deveria ser próximo do pModel médio)`);
    const avgP = bigGap.reduce((s, r) => s + r.p_model, 0) / bigGap.length;
    console.log(`    pModel médio dessas: ${(avgP * 100).toFixed(1)}% (diff = ${((hitBigGap - avgP) * 100).toFixed(1)}pp)`);
  }
})();

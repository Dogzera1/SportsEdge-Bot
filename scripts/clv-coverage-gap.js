#!/usr/bin/env node
// Diagnóstico de gap de coverage CLV — quantifica por que 68% das tips settled
// não têm clv_odds capturado.
//
// Causas testadas:
//   C1: match muito rápido — tip settled < 15min após sent (cron não passou)
//   C2: tip pre-match emitida > 3h antes do start (janela checkCLV fechada)
//   C3: tip pre-match emitida < 3h antes mas cron não capturou (name match fail?)
//   C4: tip live (is_live=1) sem CLV — indica problema no path live
//
// Uso:
//   DB_PATH=/data/sportsedge_snapshot_2026-04-24.db node scripts/clv-coverage-gap.js --days 30

const Database = require('better-sqlite3');

const DB_PATH = (process.env.DB_PATH || 'sportsedge.db').trim().replace(/^=+/, '');
const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg >= 0 ? parseInt(process.argv[daysArg + 1], 10) : 30;

const db = new Database(DB_PATH, { readonly: true });
const pct = (a, b) => b === 0 ? '-' : ((a / b) * 100).toFixed(1) + '%';

console.log(`# CLV Coverage Gap Diagnosis`);
console.log(`DB: ${DB_PATH}`);
console.log(`Janela: últimos ${DAYS} dias\n`);

// ── Coverage geral por sport ──
const coverage = db.prepare(`
  SELECT
    sport,
    COUNT(*) n,
    SUM(CASE WHEN clv_odds IS NOT NULL THEN 1 ELSE 0 END) n_with_clv,
    SUM(CASE WHEN is_live = 1 THEN 1 ELSE 0 END) n_live,
    SUM(CASE WHEN is_live = 1 AND clv_odds IS NOT NULL THEN 1 ELSE 0 END) n_live_clv,
    SUM(CASE WHEN (is_live IS NULL OR is_live = 0) AND clv_odds IS NOT NULL THEN 1 ELSE 0 END) n_pre_clv
  FROM tips
  WHERE sent_at >= datetime('now', ?)
    AND UPPER(result) IN ('WIN','LOSS')
  GROUP BY sport
  ORDER BY n DESC
`).all(`-${DAYS} days`);

console.log(`## Coverage CLV por sport`);
console.log(`| sport | n | c/CLV | cov % | live | live c/CLV | pre c/CLV |`);
console.log(`|---|---:|---:|---:|---:|---:|---:|`);
for (const r of coverage) {
  const nPre = r.n - r.n_live;
  console.log(`| ${r.sport} | ${r.n} | ${r.n_with_clv} | ${pct(r.n_with_clv, r.n)} | ${r.n_live} | ${pct(r.n_live_clv, r.n_live)} | ${pct(r.n_pre_clv, nPre)} |`);
}
console.log();

// ── Gap breakdown: settlement speed ──
const speedGap = db.prepare(`
  SELECT
    sport,
    COUNT(*) n_no_clv,
    SUM(CASE WHEN (julianday(settled_at) - julianday(sent_at)) * 1440 < 15 THEN 1 ELSE 0 END) c1_fast,
    SUM(CASE WHEN (julianday(settled_at) - julianday(sent_at)) * 1440 BETWEEN 15 AND 60 THEN 1 ELSE 0 END) med,
    SUM(CASE WHEN (julianday(settled_at) - julianday(sent_at)) * 1440 > 60 THEN 1 ELSE 0 END) slow,
    ROUND(AVG((julianday(settled_at) - julianday(sent_at)) * 1440), 1) avg_min_to_settle
  FROM tips
  WHERE sent_at >= datetime('now', ?)
    AND UPPER(result) IN ('WIN','LOSS')
    AND clv_odds IS NULL
    AND settled_at IS NOT NULL
  GROUP BY sport
  ORDER BY n_no_clv DESC
`).all(`-${DAYS} days`);

console.log(`## C1: Tips sem CLV — velocidade de settlement`);
console.log(`"fast" = settled < 15min após sent (cron pode nem ter passado ainda)`);
console.log(`| sport | sem CLV | fast <15min | 15-60min | > 60min | avg min |`);
console.log(`|---|---:|---:|---:|---:|---:|`);
for (const r of speedGap) {
  console.log(`| ${r.sport} | ${r.n_no_clv} | ${r.c1_fast} | ${r.med} | ${r.slow} | ${r.avg_min_to_settle} |`);
}
console.log();

// ── Live vs Pre-match gap ──
const liveGap = db.prepare(`
  SELECT
    sport,
    is_live,
    COUNT(*) n_no_clv,
    ROUND(AVG((julianday(settled_at) - julianday(sent_at)) * 1440), 1) avg_min_to_settle
  FROM tips
  WHERE sent_at >= datetime('now', ?)
    AND UPPER(result) IN ('WIN','LOSS')
    AND clv_odds IS NULL
  GROUP BY sport, is_live
  ORDER BY sport, is_live
`).all(`-${DAYS} days`);

console.log(`## C4: Gap por live vs pre-match`);
console.log(`| sport | mode | sem CLV | avg min settle |`);
console.log(`|---|---|---:|---:|`);
for (const r of liveGap) {
  const mode = r.is_live === 1 ? 'LIVE' : 'pre';
  console.log(`| ${r.sport} | ${mode} | ${r.n_no_clv} | ${r.avg_min_to_settle || '-'} |`);
}
console.log();

// ── Categorias mutuamente exclusivas (summary) ──
const categories = db.prepare(`
  SELECT
    sport,
    COUNT(*) n,
    SUM(CASE WHEN clv_odds IS NOT NULL THEN 1 ELSE 0 END) ok,
    SUM(CASE WHEN clv_odds IS NULL AND (julianday(settled_at) - julianday(sent_at)) * 1440 < 15 THEN 1 ELSE 0 END) gap_fast,
    SUM(CASE WHEN clv_odds IS NULL AND is_live = 1 AND (julianday(settled_at) - julianday(sent_at)) * 1440 >= 15 THEN 1 ELSE 0 END) gap_live,
    SUM(CASE WHEN clv_odds IS NULL AND (is_live IS NULL OR is_live = 0) AND (julianday(settled_at) - julianday(sent_at)) * 1440 >= 15 THEN 1 ELSE 0 END) gap_pre
  FROM tips
  WHERE sent_at >= datetime('now', ?)
    AND UPPER(result) IN ('WIN','LOSS')
  GROUP BY sport
  HAVING n >= 5
  ORDER BY n DESC
`).all(`-${DAYS} days`);

console.log(`## Categorias mutuamente exclusivas (n≥5 por sport)`);
console.log(`- ok: tem CLV capturado`);
console.log(`- gap_fast: sem CLV, settled <15min após sent (cron passou tarde)`);
console.log(`- gap_live: sem CLV, live, settled ≥15min (name match fail ou feed drop)`);
console.log(`- gap_pre: sem CLV, pre-match, settled ≥15min (tip >3h antes OU name match fail)`);
console.log();
console.log(`| sport | n | ok | gap_fast | gap_live | gap_pre |`);
console.log(`|---|---:|---:|---:|---:|---:|`);
for (const r of categories) {
  console.log(`| ${r.sport} | ${r.n} | ${r.ok} | ${r.gap_fast} | ${r.gap_live} | ${r.gap_pre} |`);
}
console.log();

// ── Flags ──
console.log(`## Flags`);
for (const r of categories) {
  const fastPct = (r.gap_fast / r.n) * 100;
  const livePct = (r.gap_live / r.n) * 100;
  const prePct = (r.gap_pre / r.n) * 100;
  if (fastPct > 30) console.log(`- ${r.sport}: ${fastPct.toFixed(0)}% gap_fast — cron lento ou matches muito rápidos`);
  if (livePct > 30) console.log(`- ${r.sport}: ${livePct.toFixed(0)}% gap_live — feed name match quebrando em live`);
  if (prePct > 30) console.log(`- ${r.sport}: ${prePct.toFixed(0)}% gap_pre — emissão muito antes do start OU name match feed pré-match`);
}

db.close();

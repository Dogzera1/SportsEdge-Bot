#!/usr/bin/env node
// CLV leak diagnosis — identifica onde o CLV negativo está vindo.
//
// Hipóteses testadas:
//   H1: detecção tardia — delta grande entre odds_fetched_at e sent_at indica
//       que gastamos tempo entre ver a odd e emitir a tip
//   H2: open→close drift — se open_odds >> clv_odds (close), linha se moveu
//       contra nós após emitir (sinal de sharp consensus tardio)
//   H3: live pior que pre-match (ou vice-versa)
//   H4: leak concentrado em hora do dia (polling gap)
//   H5: leak concentrado em sport/liga específica
//
// Uso:
//   DB_PATH=/data/sportsedge_snapshot_2026-04-24.db node scripts/clv-leak-diagnosis.js
//   DB_PATH=sportsedge.db node scripts/clv-leak-diagnosis.js --days 30

const Database = require('better-sqlite3');

const DB_PATH = (process.env.DB_PATH || 'sportsedge.db').trim().replace(/^=+/, '');
const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg >= 0 ? parseInt(process.argv[daysArg + 1], 10) : 30;

const db = new Database(DB_PATH, { readonly: true });

const fmt = (n, d = 2) => (n == null || Number.isNaN(n)) ? 'null' : Number(n).toFixed(d);
const pct = (n) => fmt(n) + '%';

function clvPct(open, close, isPickWin) {
  // CLV% = ganho relativo na odd entre abertura e fechamento, assumindo lado pick.
  // Positivo = fechamos melhor que abrimos (line moveu a favor).
  if (!open || !close) return null;
  return ((open - close) / close) * 100;
}

console.log(`# CLV Leak Diagnosis`);
console.log(`DB: ${DB_PATH}`);
console.log(`Janela: últimos ${DAYS} dias`);
console.log(`Gerado: ${new Date().toISOString()}`);
console.log();

// ── Overview ──
const totals = db.prepare(`
  SELECT
    COUNT(*) n,
    SUM(CASE WHEN clv_odds IS NOT NULL AND open_odds IS NOT NULL THEN 1 ELSE 0 END) n_clv,
    SUM(CASE WHEN odds_fetched_at IS NOT NULL AND sent_at IS NOT NULL THEN 1 ELSE 0 END) n_delay
  FROM tips
  WHERE sent_at >= datetime('now', ?)
    AND UPPER(result) IN ('WIN','LOSS')
`).get(`-${DAYS} days`);

console.log(`## Overview`);
console.log(`- Tips settled: ${totals.n}`);
console.log(`- Com open+clv odds (pra CLV%): ${totals.n_clv}`);
console.log(`- Com odds_fetched_at+sent_at (pra delay): ${totals.n_delay}`);
console.log();

if (totals.n === 0) {
  console.log('Sem tips settled na janela. Sem diagnóstico possível.');
  process.exit(0);
}

// ── Delay detecção → envio ──
const delaySql = `
  SELECT
    sport,
    COUNT(*) n,
    ROUND(AVG((julianday(sent_at) - julianday(odds_fetched_at)) * 86400), 1) avg_delay_s,
    ROUND(MIN((julianday(sent_at) - julianday(odds_fetched_at)) * 86400), 1) min_delay_s,
    ROUND(MAX((julianday(sent_at) - julianday(odds_fetched_at)) * 86400), 1) max_delay_s
  FROM tips
  WHERE sent_at >= datetime('now', ?)
    AND odds_fetched_at IS NOT NULL
  GROUP BY sport
  ORDER BY avg_delay_s DESC
`;
const delays = db.prepare(delaySql).all(`-${DAYS} days`);
console.log(`## H1: Delay odds_fetched → sent (segundos)`);
console.log(`Se > 30s em média, sharp já moveu a linha. < 5s é ideal.`);
console.log();
console.log(`| sport | n | avg s | min s | max s |`);
console.log(`|---|---:|---:|---:|---:|`);
for (const r of delays) {
  console.log(`| ${r.sport} | ${r.n} | ${fmt(r.avg_delay_s, 1)} | ${fmt(r.min_delay_s, 1)} | ${fmt(r.max_delay_s, 1)} |`);
}
console.log();

// ── CLV por sport ──
const clvBySport = db.prepare(`
  SELECT
    sport,
    COUNT(*) n,
    ROUND(AVG((open_odds - clv_odds) / clv_odds * 100), 2) avg_clv_pct,
    SUM(CASE WHEN clv_odds < open_odds THEN 1 ELSE 0 END) n_pos,
    SUM(CASE WHEN clv_odds > open_odds THEN 1 ELSE 0 END) n_neg,
    ROUND(AVG(open_odds), 3) avg_open,
    ROUND(AVG(clv_odds), 3) avg_close
  FROM tips
  WHERE sent_at >= datetime('now', ?)
    AND UPPER(result) IN ('WIN','LOSS')
    AND open_odds IS NOT NULL AND clv_odds IS NOT NULL
  GROUP BY sport
  ORDER BY avg_clv_pct ASC
`).all(`-${DAYS} days`);

console.log(`## H2: CLV por sport (open → close)`);
console.log(`CLV% > 0 = fechamos odd melhor que abrimos (edge capturado antes do sharp)`);
console.log(`CLV% < 0 = linha moveu contra nós (sharp entrou depois e reprecificou)`);
console.log();
console.log(`| sport | n | avg CLV% | n pos | n neg | avg open | avg close |`);
console.log(`|---|---:|---:|---:|---:|---:|---:|`);
for (const r of clvBySport) {
  console.log(`| ${r.sport} | ${r.n} | ${pct(r.avg_clv_pct)} | ${r.n_pos} | ${r.n_neg} | ${fmt(r.avg_open, 3)} | ${fmt(r.avg_close, 3)} |`);
}
console.log();

// ── Live vs Pre-match ──
const clvLive = db.prepare(`
  SELECT
    sport,
    is_live,
    COUNT(*) n,
    ROUND(AVG((open_odds - clv_odds) / clv_odds * 100), 2) avg_clv_pct,
    ROUND(AVG((julianday(sent_at) - julianday(odds_fetched_at)) * 86400), 1) avg_delay_s
  FROM tips
  WHERE sent_at >= datetime('now', ?)
    AND UPPER(result) IN ('WIN','LOSS')
    AND open_odds IS NOT NULL AND clv_odds IS NOT NULL
  GROUP BY sport, is_live
  ORDER BY sport, is_live
`).all(`-${DAYS} days`);

console.log(`## H3: Live vs Pre-match`);
console.log(`Detectar se leak concentra em um dos modos.`);
console.log();
console.log(`| sport | mode | n | avg CLV% | avg delay s |`);
console.log(`|---|---|---:|---:|---:|`);
for (const r of clvLive) {
  const mode = r.is_live === 1 ? 'LIVE' : 'pre';
  console.log(`| ${r.sport} | ${mode} | ${r.n} | ${pct(r.avg_clv_pct)} | ${fmt(r.avg_delay_s, 1)} |`);
}
console.log();

// ── Por hora do dia (UTC) ──
const byHour = db.prepare(`
  SELECT
    CAST(strftime('%H', sent_at) AS INTEGER) hour_utc,
    COUNT(*) n,
    ROUND(AVG((open_odds - clv_odds) / clv_odds * 100), 2) avg_clv_pct,
    ROUND(AVG((julianday(sent_at) - julianday(odds_fetched_at)) * 86400), 1) avg_delay_s
  FROM tips
  WHERE sent_at >= datetime('now', ?)
    AND UPPER(result) IN ('WIN','LOSS')
    AND open_odds IS NOT NULL AND clv_odds IS NOT NULL
  GROUP BY hour_utc
  HAVING n >= 3
  ORDER BY avg_clv_pct ASC
`).all(`-${DAYS} days`);

console.log(`## H4: Por hora do dia (UTC — subtrair 3 para BRT)`);
console.log(`Horas com CLV pior indicam gaps de polling ou janela de sharp movement.`);
console.log();
console.log(`| hora UTC | n | avg CLV% | avg delay s |`);
console.log(`|---:|---:|---:|---:|`);
for (const r of byHour.slice(0, 15)) {
  console.log(`| ${String(r.hour_utc).padStart(2, '0')}h | ${r.n} | ${pct(r.avg_clv_pct)} | ${fmt(r.avg_delay_s, 1)} |`);
}
console.log();

// ── Por liga (event_name) ──
const byLeague = db.prepare(`
  SELECT
    sport,
    COALESCE(NULLIF(TRIM(event_name), ''), '(sem liga)') league,
    COUNT(*) n,
    ROUND(AVG((open_odds - clv_odds) / clv_odds * 100), 2) avg_clv_pct,
    ROUND(SUM(profit_reais), 2) profit
  FROM tips
  WHERE sent_at >= datetime('now', ?)
    AND UPPER(result) IN ('WIN','LOSS')
    AND open_odds IS NOT NULL AND clv_odds IS NOT NULL
  GROUP BY sport, league
  HAVING n >= 3
  ORDER BY avg_clv_pct ASC
  LIMIT 25
`).all(`-${DAYS} days`);

console.log(`## H5: Top 25 piores CLV por liga (n≥3)`);
console.log();
console.log(`| sport | liga | n | avg CLV% | profit R$ |`);
console.log(`|---|---|---:|---:|---:|`);
for (const r of byLeague) {
  const leagueShort = r.league.length > 50 ? r.league.slice(0, 47) + '...' : r.league;
  console.log(`| ${r.sport} | ${leagueShort} | ${r.n} | ${pct(r.avg_clv_pct)} | ${fmt(r.profit)} |`);
}
console.log();

// ── Bucket de odds ──
const byOddBucket = db.prepare(`
  SELECT
    sport,
    CASE
      WHEN open_odds < 1.5 THEN '<1.50'
      WHEN open_odds < 1.8 THEN '1.50-1.80'
      WHEN open_odds < 2.2 THEN '1.80-2.20'
      WHEN open_odds < 3.0 THEN '2.20-3.00'
      ELSE '3.00+'
    END bucket,
    COUNT(*) n,
    ROUND(AVG((open_odds - clv_odds) / clv_odds * 100), 2) avg_clv_pct,
    ROUND(SUM(profit_reais), 2) profit
  FROM tips
  WHERE sent_at >= datetime('now', ?)
    AND UPPER(result) IN ('WIN','LOSS')
    AND open_odds IS NOT NULL AND clv_odds IS NOT NULL
  GROUP BY sport, bucket
  HAVING n >= 3
  ORDER BY sport, bucket
`).all(`-${DAYS} days`);

console.log(`## CLV por bucket de odd (open_odds)`);
console.log();
console.log(`| sport | bucket | n | avg CLV% | profit R$ |`);
console.log(`|---|---|---:|---:|---:|`);
for (const r of byOddBucket) {
  console.log(`| ${r.sport} | ${r.bucket} | ${r.n} | ${pct(r.avg_clv_pct)} | ${fmt(r.profit)} |`);
}
console.log();

// ── Conclusões automáticas ──
console.log(`## Flags automáticos`);
const flags = [];
for (const r of clvBySport) {
  if (r.avg_clv_pct < -2 && r.n >= 10) flags.push(`- ${r.sport}: CLV ${pct(r.avg_clv_pct)} em ${r.n} tips — leak estrutural`);
}
for (const r of delays) {
  if (r.avg_delay_s > 60 && r.n >= 10) flags.push(`- ${r.sport}: delay médio ${fmt(r.avg_delay_s, 1)}s detecção→envio — potencial cause do leak`);
}
for (const r of byLeague.slice(0, 5)) {
  if (r.avg_clv_pct < -5 && r.n >= 5) flags.push(`- ${r.sport} / ${r.league}: CLV ${pct(r.avg_clv_pct)} em ${r.n} tips — liga candidata a block`);
}
if (flags.length === 0) {
  console.log(`Sem flags automáticas (nenhum leak ≥2% com n≥10).`);
} else {
  console.log(flags.join('\n'));
}
console.log();

db.close();

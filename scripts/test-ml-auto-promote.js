#!/usr/bin/env node
'use strict';

/**
 * test-ml-auto-promote.js — smoke test do ciclo lib/ml-auto-promote.js.
 *
 * Usa DB in-memory + tips sintéticas pra exercitar todas as branches:
 *   - PROMOTE sport com ROI sólido + IC > 0
 *   - REJECT_CI sport com ROI ok mas IC borderline
 *   - REVERT sport real com ROI negativo
 *   - LEAGUE_BLOCK liga real com ROI -30%
 *   - AUDIT granular tier × bucket
 *
 * Run: `node scripts/test-ml-auto-promote.js`
 */

const Database = require('better-sqlite3');

const db = new Database(':memory:');
db.pragma('journal_mode = WAL');

// Schema mínimo: tips + settings + as 2 tabelas da mig 099 (replicadas aqui
// pra evitar dependência de applyMigrations completo que requer schema esports).
db.exec(`
  CREATE TABLE IF NOT EXISTS tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sport TEXT,
    stake TEXT,
    odds REAL,
    result TEXT,
    event_name TEXT,
    market_type TEXT DEFAULT 'ML',
    is_shadow INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0,
    clv_pct REAL,
    sent_at TEXT DEFAULT (datetime('now')),
    settled_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS ml_auto_promote_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    sport TEXT NOT NULL,
    tier TEXT,
    bucket TEXT,
    league TEXT,
    action TEXT NOT NULL,
    reason TEXT,
    n INTEGER,
    roi_pct REAL,
    clv_pct REAL
  );
  CREATE TABLE IF NOT EXISTS ml_league_blocklist (
    sport TEXT NOT NULL,
    league_norm TEXT NOT NULL,
    league_raw TEXT,
    since TEXT DEFAULT (datetime('now')),
    source TEXT,
    reason TEXT,
    n INTEGER,
    roi_pct REAL,
    PRIMARY KEY (sport, league_norm)
  );
`);
console.log('[test] in-memory schema ready');

// ─── Synthetic tips ───
// Sport LOL = ainda em shadow (env LOL_SHADOW=true). 30d shadow: 160 tips,
// odd 1.8, hit 60% → ROI ≈ +8%. IC95% deve ser >0.
// Sport CS = NÃO em shadow. 14d real: 40 tips, odd 1.8 hit 35% → ROI ≈ -17% → revert.
// Sport TENNIS = shadow OK, mas com 1 liga RUIM (real -30%, n=15) → league_block.
const ins = db.prepare(`
  INSERT INTO tips (sport, stake, odds, result, event_name, is_shadow, sent_at, clv_pct, market_type, archived)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ML', 0)
`);

function addTips({ sport, n, odd, hitPct, league, isShadow, daysAgo, clv }) {
  const wins = Math.round(n * hitPct);
  for (let i = 0; i < n; i++) {
    const result = i < wins ? 'win' : 'loss';
    const ts = `datetime('now', '-${daysAgo} days', '-${i * 60} seconds')`;
    db.prepare(`INSERT INTO tips (sport, stake, odds, result, event_name, is_shadow, sent_at, clv_pct, market_type, archived) VALUES (?, ?, ?, ?, ?, ?, ${ts}, ?, 'ML', 0)`)
      .run(sport, '1u', odd, result, league, isShadow ? 1 : 0, clv);
  }
}

// LOL shadow: deve promover (ROI +8% n=160)
addTips({ sport: 'lol', n: 160, odd: 1.8, hitPct: 0.60, league: 'LCK 2026 Spring', isShadow: 1, daysAgo: 5, clv: 1.5 });

// CS real (não shadow): deve reverter (14d ROI -17%)
addTips({ sport: 'cs', n: 40, odd: 1.8, hitPct: 0.35, league: 'BLAST Premier 2026', isShadow: 0, daysAgo: 3, clv: -2.0 });

// TENNIS shadow OK overall + liga RUIM real → league_block
addTips({ sport: 'tennis', n: 150, odd: 1.9, hitPct: 0.55, league: 'ATP 250 Pune', isShadow: 1, daysAgo: 10, clv: 0.8 });
// + 15 real tips na MESMA liga problemática (Pune) com ROI -30%
addTips({ sport: 'tennis', n: 15, odd: 1.8, hitPct: 0.30, league: 'ATP 250 Pune', isShadow: 0, daysAgo: 7, clv: -3.0 });

// FOOTBALL shadow borderline ROI +2% mas IC inclui 0 (alta variance) → reject_ci
// Como construir variance alta: misturar odds altas + mix de wins/losses.
// 80 tips odd 3.0 hit 35% → ROI = (0.35*2 - 0.65) = 0.05 = +5%. SE pra odd 3
// é bem maior. Vamos ver.
addTips({ sport: 'football', n: 200, odd: 3.0, hitPct: 0.35, league: 'Premier League', isShadow: 1, daysAgo: 8, clv: 0.5 });

// Set initial shadow envs pra que _isCurrentlyShadow retorne true onde
// deveria. lol/tennis/football começam em shadow. cs NÃO está em shadow.
process.env.LOL_SHADOW = 'true';
process.env.TENNIS_SHADOW = 'true';
process.env.FOOTBALL_SHADOW = 'true';
delete process.env.CS_SHADOW;

const totalsTips = db.prepare(`
  SELECT sport, is_shadow,
    COUNT(*) AS n,
    SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS w,
    SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS l
  FROM tips GROUP BY sport, is_shadow ORDER BY sport
`).all();
console.log('\n[test] synthetic dataset:');
for (const r of totalsTips) console.log(`  ${r.sport} shadow=${r.is_shadow}: n=${r.n} w=${r.w} l=${r.l}`);

(async () => {
  console.log('\n[test] running runMlAutoPromoteCycle...');
  const { runMlAutoPromoteCycle } = require('../lib/ml-auto-promote');
  const t0 = Date.now();
  const out = await runMlAutoPromoteCycle(db);
  console.log(`[test] cycle done em ${Date.now() - t0}ms`);
  console.log('[test] totals:', out.totals);

  for (const k of ['promoted', 'reverted', 'league_blocked', 'league_unblocked', 'rejected_by_ci']) {
    if (out.decisions?.[k]?.length) {
      console.log(`\n[test] ${k.toUpperCase()}:`);
      for (const d of out.decisions[k]) console.log('  ', JSON.stringify(d));
    }
  }

  if (out.decisions?.audit_granularity?.length) {
    console.log(`\n[test] AUDIT_GRANULARITY (${out.decisions.audit_granularity.length} rows):`);
    const sorted = [...out.decisions.audit_granularity].sort((a, b) => Math.abs(b.roi) - Math.abs(a.roi));
    for (const a of sorted) {
      console.log(`  ${a.source.padEnd(7)} ${a.sport.padEnd(10)} ${a.tier.padEnd(6)} ${a.bucket.padEnd(10)} n=${String(a.n).padStart(4)} ROI=${a.roi >= 0 ? '+' : ''}${a.roi}%${a.clv != null ? ' CLV=' + a.clv + '%' : ''}`);
    }
  }

  // Verifica side-effects
  console.log('\n[test] settings table:');
  for (const r of db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'ml_shadow_%'`).all()) {
    console.log(`  ${r.key} = ${r.value}`);
  }

  console.log('\n[test] envs após cycle:');
  for (const sp of ['lol', 'cs', 'tennis', 'football']) {
    console.log(`  ${sp.toUpperCase()}_SHADOW = ${process.env[`${sp.toUpperCase()}_SHADOW`] || '(unset)'}`);
  }

  console.log('\n[test] ml_league_blocklist:');
  for (const r of db.prepare(`SELECT * FROM ml_league_blocklist`).all()) {
    console.log(`  ${r.sport} ${r.league_raw} | ${r.reason} | source=${r.source}`);
  }

  const logCount = db.prepare(`SELECT action, COUNT(*) AS n FROM ml_auto_promote_log GROUP BY action`).all();
  console.log('\n[test] ml_auto_promote_log breakdown:');
  for (const r of logCount) console.log(`  ${r.action}: ${r.n}`);
})().catch(e => {
  console.error(`[test] FATAL: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}).finally(() => {
  try { db.close(); } catch (_) {}
});

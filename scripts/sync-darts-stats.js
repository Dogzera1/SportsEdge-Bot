#!/usr/bin/env node
'use strict';

/**
 * sync-darts-stats.js — fetch event stats (avg 3-dart, 180s, checkouts) pra eventos
 * darts existentes em match_results. Popula tabela `darts_event_stats`.
 *
 * Trade-off: 200ms/req × N events = throughput. Default: últimos 180d (mais relevante).
 *
 * Uso:
 *   node scripts/sync-darts-stats.js --days 180 --rate-ms 200
 */

require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const DAYS = parseInt(argVal('days', '180'), 10);
const RATE_MS = parseInt(argVal('rate-ms', '200'), 10);
const PROXY_BASE = argVal('proxy',
  process.env.SOFASCORE_PROXY_BASE
  || 'https://victorious-expression-production-af8a.up.railway.app/api/v1/sofascore');
const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const { db } = initDatabase(DB_PATH);

// Cria tabela de stats
db.exec(`
  CREATE TABLE IF NOT EXISTS darts_event_stats (
    event_id TEXT PRIMARY KEY,
    match_id TEXT,
    team1 TEXT,
    team2 TEXT,
    avg3dart_t1 REAL,
    avg3dart_t2 REAL,
    thrown_180_t1 INTEGER,
    thrown_180_t2 INTEGER,
    thrown_over_140_t1 INTEGER,
    thrown_over_140_t2 INTEGER,
    thrown_over_100_t1 INTEGER,
    thrown_over_100_t2 INTEGER,
    checkout_t1 REAL,
    checkout_t2 REAL,
    resolved_at TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_darts_stats_resolved ON darts_event_stats(resolved_at DESC);
`);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (sportsedge-bot)' } }, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => resolve({ status: r.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

async function fetchEventStats(eventId) {
  const url = `${PROXY_BASE}/event/${eventId}/statistics/`;
  const r = await httpsGet(url).catch(() => null);
  if (!r || r.status !== 200) return null;
  try {
    const j = JSON.parse(r.body);
    const out = {};
    for (const period of j.statistics || []) {
      if (period.period !== 'ALL') continue;
      for (const g of period.groups || []) {
        for (const it of g.statisticsItems || []) {
          out[it.key] = { home: it.homeValue, away: it.awayValue };
        }
      }
    }
    return out;
  } catch (_) { return null; }
}

async function main() {
  // Pega match_ids darts dos últimos N days com format 'sofa_darts_{id}'
  const rows = db.prepare(`
    SELECT match_id, team1, team2, resolved_at
    FROM match_results
    WHERE game = 'darts'
      AND resolved_at >= datetime('now', ?)
      AND match_id LIKE 'sofa_darts_%'
    ORDER BY resolved_at DESC
  `).all(`-${DAYS} days`);

  console.log(`[sync-darts-stats] ${rows.length} events pra sync (${DAYS}d)`);

  const upsert = db.prepare(`
    INSERT INTO darts_event_stats (event_id, match_id, team1, team2,
      avg3dart_t1, avg3dart_t2, thrown_180_t1, thrown_180_t2,
      thrown_over_140_t1, thrown_over_140_t2,
      thrown_over_100_t1, thrown_over_100_t2,
      checkout_t1, checkout_t2, resolved_at)
    VALUES (@event_id, @match_id, @team1, @team2,
      @avg3dart_t1, @avg3dart_t2, @thrown_180_t1, @thrown_180_t2,
      @thrown_over_140_t1, @thrown_over_140_t2,
      @thrown_over_100_t1, @thrown_over_100_t2,
      @checkout_t1, @checkout_t2, @resolved_at)
    ON CONFLICT(event_id) DO UPDATE SET
      avg3dart_t1=excluded.avg3dart_t1, avg3dart_t2=excluded.avg3dart_t2,
      thrown_180_t1=excluded.thrown_180_t1, thrown_180_t2=excluded.thrown_180_t2,
      thrown_over_140_t1=excluded.thrown_over_140_t1, thrown_over_140_t2=excluded.thrown_over_140_t2,
      thrown_over_100_t1=excluded.thrown_over_100_t1, thrown_over_100_t2=excluded.thrown_over_100_t2,
      checkout_t1=excluded.checkout_t1, checkout_t2=excluded.checkout_t2,
      updated_at=datetime('now')
  `);

  let ok = 0, skipped = 0;
  const startMs = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const eventId = r.match_id.replace('sofa_darts_', '');
    const stats = await fetchEventStats(eventId);
    if (!stats || !stats.Average3Darts) { skipped++; await sleep(RATE_MS); continue; }
    upsert.run({
      event_id: eventId,
      match_id: r.match_id,
      team1: r.team1, team2: r.team2,
      avg3dart_t1: stats.Average3Darts?.home ?? null,
      avg3dart_t2: stats.Average3Darts?.away ?? null,
      thrown_180_t1: stats.Thrown180?.home ?? null,
      thrown_180_t2: stats.Thrown180?.away ?? null,
      thrown_over_140_t1: stats.ThrownOver140?.home ?? null,
      thrown_over_140_t2: stats.ThrownOver140?.away ?? null,
      thrown_over_100_t1: stats.ThrownOver100?.home ?? null,
      thrown_over_100_t2: stats.ThrownOver100?.away ?? null,
      checkout_t1: stats.Checkout?.home ?? stats.CheckoutPercentage?.home ?? null,
      checkout_t2: stats.Checkout?.away ?? stats.CheckoutPercentage?.away ?? null,
      resolved_at: r.resolved_at,
    });
    ok++;
    if (i % 50 === 0 || i === rows.length - 1) {
      const elapsed = Math.round((Date.now() - startMs) / 1000);
      console.log(`[sync-darts-stats] ${i+1}/${rows.length} ok=${ok} skip=${skipped} (${elapsed}s elapsed)`);
    }
    await sleep(RATE_MS);
  }

  const total = db.prepare("SELECT COUNT(*) n FROM darts_event_stats").get();
  console.log(`\n[sync-darts-stats] done. ok=${ok} skipped=${skipped} | table total=${total.n}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

#!/usr/bin/env node
'use strict';

/**
 * settle-mt-shadow-esports.js
 *
 * Roda settleShadowTips() e reporta especificamente cs/lol/dota2:
 *   - Quantas foram liquidadas neste run
 *   - Quantas continuam pendentes E POR QUÊ (sem match_result / janela <2h /
 *     market sem handler / etc)
 *
 * Uso:
 *   node scripts/settle-mt-shadow-esports.js
 *   node scripts/settle-mt-shadow-esports.js --json
 */

require('dotenv').config({ override: true });
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const DB_PATH = (process.env.DB_PATH || path.resolve(__dirname, '..', 'sportsedge.db'))
  .trim().replace(/^=+/, '');

const db = new Database(DB_PATH);
const SPORTS = ['cs2', 'lol', 'dota2'];

function counts() {
  const out = {};
  for (const sp of SPORTS) {
    const r = db.prepare(`
      SELECT
        SUM(CASE WHEN result IS NULL THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN result = 'void' THEN 1 ELSE 0 END) AS voids,
        COUNT(*) AS total
      FROM market_tips_shadow WHERE sport = ?
    `).get(sp);
    out[sp] = {
      total: r.total || 0,
      pending: r.pending || 0,
      wins: r.wins || 0,
      losses: r.losses || 0,
      voids: r.voids || 0,
    };
  }
  return out;
}

function diagnosePending(sport) {
  const rows = db.prepare(`
    SELECT id, team1, team2, league, market, line, side, created_at
    FROM market_tips_shadow
    WHERE sport = ? AND result IS NULL
    ORDER BY created_at ASC
  `).all(sport);

  const reasons = { too_recent: 0, no_match_result: 0, market_no_handler: 0, ok_should_settle: 0 };
  const samples = { too_recent: [], no_match_result: [], market_no_handler: [] };
  const HANDLED = new Set(['matchWinner', 'handicapMaps', 'totalMaps']);
  const game = sport;

  const nowMs = Date.now();
  for (const t of rows) {
    const ageH = (nowMs - new Date(t.created_at + 'Z').getTime()) / 3600000;
    if (ageH < 2) {
      reasons.too_recent++;
      if (samples.too_recent.length < 3) samples.too_recent.push(`${t.team1} vs ${t.team2} | ${t.market} | ${ageH.toFixed(1)}h`);
      continue;
    }
    if (!HANDLED.has(t.market)) {
      reasons.market_no_handler++;
      if (samples.market_no_handler.length < 3) samples.market_no_handler.push(`${t.team1} vs ${t.team2} | ${t.market}/${t.line ?? ''} (${ageH.toFixed(0)}h)`);
      continue;
    }
    // Tem match_result?
    const n1 = String(t.team1 || '').toLowerCase().trim();
    const n2 = String(t.team2 || '').toLowerCase().trim();
    const mr = db.prepare(`
      SELECT COUNT(*) AS n FROM match_results
      WHERE game = ?
        AND ((lower(team1) = ? AND lower(team2) = ?) OR (lower(team1) = ? AND lower(team2) = ?))
        AND winner IS NOT NULL AND winner != ''
        AND resolved_at >= datetime(?, '-24 hours')
        AND resolved_at <= datetime(?, '+7 days')
    `).get(game, n1, n2, n2, n1, t.created_at, t.created_at);
    if ((mr.n || 0) === 0) {
      reasons.no_match_result++;
      if (samples.no_match_result.length < 5) samples.no_match_result.push(`${t.team1} vs ${t.team2} | ${t.league} | ${t.market} (${ageH.toFixed(0)}h)`);
    } else {
      reasons.ok_should_settle++;
    }
  }
  return { reasons, samples };
}

const before = counts();

const { settleShadowTips } = require('../lib/market-tips-shadow');
const r = settleShadowTips(db);

const after = counts();

const result = { ranAt: new Date().toISOString(), settleResult: r, sports: {} };
for (const sp of SPORTS) {
  result.sports[sp] = {
    before: before[sp],
    after: after[sp],
    delta: {
      settled: (after[sp].wins + after[sp].losses + after[sp].voids) - (before[sp].wins + before[sp].losses + before[sp].voids),
      stillPending: after[sp].pending,
    },
    diagnosis: after[sp].pending > 0 ? diagnosePending(sp) : null,
  };
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log(`\n══════ SETTLE MT-SHADOW (cs/lol/dota2) — ${result.ranAt} ══════`);
console.log(`\nResultado settleShadowTips: ${JSON.stringify(r)}\n`);

for (const sp of SPORTS) {
  const a = result.sports[sp];
  console.log(`── ${sp.toUpperCase()} ──`);
  console.log(`  Total: ${a.before.total} → ${a.after.total} | Pendentes: ${a.before.pending} → ${a.after.pending}`);
  console.log(`  Resolved: ${a.after.wins} W / ${a.after.losses} L / ${a.after.voids} V`);
  console.log(`  Settled neste run: ${a.delta.settled}`);

  if (a.delta.stillPending > 0 && a.diagnosis) {
    const d = a.diagnosis;
    console.log(`\n  ${a.delta.stillPending} ainda pendentes — diagnóstico:`);
    if (d.reasons.too_recent) console.log(`    • ${d.reasons.too_recent} criadas <2h atrás (cron espera 2h pra dar settle):`);
    for (const s of d.samples.too_recent) console.log(`        ${s}`);
    if (d.reasons.market_no_handler) console.log(`    • ${d.reasons.market_no_handler} markets sem handler (totalAces/correctScore/etc — viram void após 14d):`);
    for (const s of d.samples.market_no_handler) console.log(`        ${s}`);
    if (d.reasons.no_match_result) console.log(`    • ${d.reasons.no_match_result} sem match_result correspondente (sync esports não puxou):`);
    for (const s of d.samples.no_match_result) console.log(`        ${s}`);
    if (d.reasons.ok_should_settle) console.log(`    • ${d.reasons.ok_should_settle} ALERT: deveriam ter sido liquidadas mas não foram — investigar manualmente`);
  }
  console.log('');
}

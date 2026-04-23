#!/usr/bin/env node
'use strict';

/**
 * settle-mt-shadow-esports.js (v2)
 *
 * Roda settleShadowTips() e diagnostica especificamente cs/lol/dota2.
 * Categorias REAIS de pending:
 *   - too_recent (<2h)
 *   - market_no_handler (totalKills/duration/totalAces/etc — vira void 14d)
 *   - no_match_result (sync esports não puxou)
 *   - match_score_unparseable (achou match mas final_score não bate Bo3 X-Y)
 *   - team_name_mismatch (tem match_result mas com nomes diferentes)
 *
 * Uso:
 *   node scripts/settle-mt-shadow-esports.js
 *   node scripts/settle-mt-shadow-esports.js --json
 *   node scripts/settle-mt-shadow-esports.js --sport=lol     # só 1 sport
 */

require('dotenv').config({ override: true });
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}
const asJson = argv.includes('--json');
const ONE_SPORT = arg('sport', null);

const DB_PATH = (process.env.DB_PATH || path.resolve(__dirname, '..', 'sportsedge.db'))
  .trim().replace(/^=+/, '');

const db = new Database(DB_PATH);
const SPORTS = ONE_SPORT ? [ONE_SPORT] : ['cs2', 'lol', 'dota2'];

// Markets que market-tips-shadow.js settleShadowTips JÁ trata (com handler).
// Pra esports: handicap, total. Pra outros: vide settleShadowTips.
const HANDLED_ESPORTS = new Set(['matchWinner', 'handicap', 'total']);
// Markets sem handler em esports — viram void após 14d via cleanup auto.
const UNHANDLED_AUTO_VOID = new Set(['totalAces', 'correctScore', 'totalKills', 'duration', 'firstBlood', 'mapWinner']);

function counts(sport) {
  const r = db.prepare(`
    SELECT
      SUM(CASE WHEN result IS NULL THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN result = 'void' THEN 1 ELSE 0 END) AS voids,
      COUNT(*) AS total
    FROM market_tips_shadow WHERE sport = ?
  `).get(sport);
  return {
    total: r.total || 0, pending: r.pending || 0,
    wins: r.wins || 0, losses: r.losses || 0, voids: r.voids || 0,
  };
}

function parseScore(s) {
  // Mesma lógica de _parseEsportsMapScore — Bo<N> A-B com validação
  const str = String(s || '');
  const boMatch = str.match(/\bBo(\d+)/i);
  const bestOf = boMatch ? parseInt(boMatch[1], 10) : null;
  const sm = str.match(/(\d+)\s*[-x]\s*(\d+)/);
  if (!sm) return null;
  const a = parseInt(sm[1], 10), b = parseInt(sm[2], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (bestOf) {
    const maxMaps = Math.ceil(bestOf / 2);
    if (Math.max(a, b) > maxMaps || a + b > bestOf) return null;
  } else {
    if (Math.max(a, b) > 5 || a + b > 7) return null;
  }
  return { a, b, bestOf };
}

function diagnosePending(sport) {
  const rows = db.prepare(`
    SELECT id, team1, team2, league, market, line, side, created_at
    FROM market_tips_shadow
    WHERE sport = ? AND result IS NULL
    ORDER BY created_at ASC
  `).all(sport);

  const reasons = {
    too_recent: 0,
    market_no_handler: 0,
    no_match_result: 0,
    match_score_unparseable: 0,
    ok_should_settle: 0,
  };
  const samples = { too_recent: [], market_no_handler: [], no_match_result: [], match_score_unparseable: [], ok_should_settle: [] };
  const nowMs = Date.now();

  for (const t of rows) {
    const ageH = (nowMs - new Date(t.created_at + 'Z').getTime()) / 3600000;
    if (ageH < 2) {
      reasons.too_recent++;
      if (samples.too_recent.length < 3) samples.too_recent.push(`${t.team1} vs ${t.team2} | ${t.market}/${t.line ?? ''} | ${ageH.toFixed(1)}h`);
      continue;
    }
    if (UNHANDLED_AUTO_VOID.has(t.market)) {
      reasons.market_no_handler++;
      if (samples.market_no_handler.length < 3) samples.market_no_handler.push(`${t.team1} vs ${t.team2} | ${t.market}/${t.line ?? ''} (${Math.floor(ageH)}h, void em ${Math.max(0, 14 - Math.floor(ageH/24))}d)`);
      continue;
    }
    if (!HANDLED_ESPORTS.has(t.market)) {
      // Market desconhecido — não tratado nem auto-voided. Bug em potential.
      reasons.market_no_handler++;
      if (samples.market_no_handler.length < 5) samples.market_no_handler.push(`${t.team1} vs ${t.team2} | UNKNOWN MARKET=${t.market}`);
      continue;
    }

    // Tem match_result?
    const n1 = String(t.team1 || '').toLowerCase().trim();
    const n2 = String(t.team2 || '').toLowerCase().trim();
    const game = sport;
    const candidates = db.prepare(`
      SELECT winner, final_score, resolved_at, league
      FROM match_results
      WHERE game = ?
        AND ((lower(team1) = ? AND lower(team2) = ?) OR (lower(team1) = ? AND lower(team2) = ?))
        AND winner IS NOT NULL AND winner != ''
        AND resolved_at >= datetime(?, '-24 hours')
        AND resolved_at <= datetime(?, '+7 days')
      ORDER BY ABS(julianday(resolved_at) - julianday(?)) ASC
      LIMIT 5
    `).all(game, n1, n2, n2, n1, t.created_at, t.created_at, t.created_at);

    if (!candidates.length) {
      reasons.no_match_result++;
      if (samples.no_match_result.length < 5) samples.no_match_result.push(`${t.team1} vs ${t.team2} | ${t.league || '?'} | ${t.market}/${t.line ?? ''} (${Math.floor(ageH)}h)`);
      continue;
    }

    // Achou candidate(s). Final_score parseável?
    const parseable = candidates.find(c => parseScore(c.final_score));
    if (!parseable) {
      reasons.match_score_unparseable++;
      if (samples.match_score_unparseable.length < 5) {
        const sample = candidates[0];
        samples.match_score_unparseable.push(`${t.team1} vs ${t.team2} | match found | final_score="${sample.final_score}" (${candidates.length} candidates)`);
      }
      continue;
    }

    // Tudo OK — deveria ter sido liquidada. Bug.
    reasons.ok_should_settle++;
    if (samples.ok_should_settle.length < 5) {
      samples.ok_should_settle.push(`${t.team1} vs ${t.team2} | ${t.market}/${t.line ?? ''} | match_score="${parseable.final_score}"`);
    }
  }
  return { reasons, samples };
}

const before = {};
const after = {};
const diag = {};

for (const sp of SPORTS) before[sp] = counts(sp);

const { settleShadowTips } = require('../lib/market-tips-shadow');
const r = settleShadowTips(db);

for (const sp of SPORTS) {
  after[sp] = counts(sp);
  if (after[sp].pending > 0) diag[sp] = diagnosePending(sp);
}

if (asJson) {
  const result = { ranAt: new Date().toISOString(), settleResult: r, sports: {} };
  for (const sp of SPORTS) {
    result.sports[sp] = { before: before[sp], after: after[sp], diagnosis: diag[sp] || null };
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log(`\n══════ SETTLE MT-SHADOW (${SPORTS.join('/')}) ══════`);
console.log(`Resultado settleShadowTips: ${JSON.stringify(r)}`);
console.log(`(skipped no settle = match não encontrado OU score não parseável OU já liquidado)\n`);

for (const sp of SPORTS) {
  const a = after[sp], b = before[sp];
  console.log(`── ${sp.toUpperCase()} ──`);
  console.log(`  Total: ${b.total} → ${a.total} | Pendentes: ${b.pending} → ${a.pending}`);
  console.log(`  Resolved: ${a.wins} W / ${a.losses} L / ${a.voids} V`);
  console.log(`  Settled neste run: ${(a.wins+a.losses+a.voids) - (b.wins+b.losses+b.voids)}`);

  if (a.pending > 0 && diag[sp]) {
    const d = diag[sp];
    console.log(`\n  ${a.pending} pending — quebra por motivo:`);
    if (d.reasons.too_recent) {
      console.log(`    • ${d.reasons.too_recent} muito recentes (<2h, cron espera):`);
      for (const s of d.samples.too_recent) console.log(`        ${s}`);
    }
    if (d.reasons.market_no_handler) {
      console.log(`    • ${d.reasons.market_no_handler} sem handler ou auto-void scheduled:`);
      for (const s of d.samples.market_no_handler) console.log(`        ${s}`);
    }
    if (d.reasons.no_match_result) {
      console.log(`    • ${d.reasons.no_match_result} 🔴 SEM match_result correspondente (sync esports não puxou):`);
      for (const s of d.samples.no_match_result) console.log(`        ${s}`);
    }
    if (d.reasons.match_score_unparseable) {
      console.log(`    • ${d.reasons.match_score_unparseable} 🟠 match achado mas final_score não parseável:`);
      for (const s of d.samples.match_score_unparseable) console.log(`        ${s}`);
    }
    if (d.reasons.ok_should_settle) {
      console.log(`    • ${d.reasons.ok_should_settle} 🚨 BUG: match achado, score parseável, mas não liquidado:`);
      for (const s of d.samples.ok_should_settle) console.log(`        ${s}`);
    }
  }
  console.log('');
}

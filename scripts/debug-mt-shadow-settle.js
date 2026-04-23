#!/usr/bin/env node
'use strict';

/**
 * debug-mt-shadow-settle.js
 *
 * Simula settleShadowTips passo a passo pras tips com `ok_should_settle` flag
 * (match achado, score parseável, mas não liquidando). Mostra cada step
 * e onde o flow para.
 *
 * Uso:
 *   node scripts/debug-mt-shadow-settle.js
 *   node scripts/debug-mt-shadow-settle.js --sport=lol
 *   node scripts/debug-mt-shadow-settle.js --id=12345        # debug 1 tip específica
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
const SPORT = arg('sport', null);
const ONE_ID = arg('id', null);
const TEAM_FILTER = arg('team', null); // grep team1 OR team2 LIKE

const DB_PATH = (process.env.DB_PATH || path.resolve(__dirname, '..', 'sportsedge.db'))
  .trim().replace(/^=+/, '');
const db = new Database(DB_PATH, { readonly: true });

function _norm(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); }
function _normLeague(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(atp|wta|itf|challenger|masters|1000|500|250|grand slam|main draw|qualifying|qualif|open|cup|trophy|international)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function _leagueOverlap(a, b) {
  if (!a || !b) return false;
  const tA = a.split(' ').filter(w => w.length >= 4);
  const tB = new Set(b.split(' ').filter(w => w.length >= 4));
  return tA.some(w => tB.has(w));
}
function _parseEsportsMapScore(finalScore) {
  const s = String(finalScore || '');
  if (!s) return null;
  const boMatch = s.match(/\bBo(\d+)/i);
  const bestOf = boMatch ? parseInt(boMatch[1], 10) : null;
  const scoreMatch = s.match(/(\d+)\s*[-x]\s*(\d+)/);
  if (!scoreMatch) return null;
  const a = parseInt(scoreMatch[1], 10);
  const b = parseInt(scoreMatch[2], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (bestOf != null && bestOf > 0) {
    const maxPerSide = (bestOf % 2 === 0) ? bestOf : Math.ceil(bestOf / 2);
    const total = a + b;
    if (Math.max(a, b) > maxPerSide || total > bestOf || total < 1) return null;
  } else {
    if (a > 3 || b > 3) return null;
  }
  return { winnerMaps: Math.max(a, b), loserMaps: Math.min(a, b), bestOf };
}

function debugOne(t) {
  const sport = t.sport;
  const HANDLED = new Set(['matchWinner', 'handicap', 'total']);
  const game = sport;
  console.log(`\n══════ id=${t.id} ${sport} ${t.market}/${t.line ?? ''} side=${t.side ?? ''} ══════`);
  console.log(`  ${t.team1} vs ${t.team2} | ${t.league || '?'} | created=${t.created_at}`);

  // Step 1: market handler check
  if (!HANDLED.has(t.market)) {
    console.log(`  ✗ STEP1: market '${t.market}' NÃO está em HANDLED ${[...HANDLED].join('/')} → skip silently`);
    return;
  }
  console.log(`  ✓ STEP1: market handled`);

  // Step 2: query candidates
  const n1 = _norm(t.team1), n2 = _norm(t.team2);
  const windowBefore = '-24 hours', windowAfter = '+7 days';
  let candidates = db.prepare(`
    SELECT winner, final_score, resolved_at, match_id, team1, team2, league
    FROM match_results
    WHERE game = ?
      AND ((lower(team1) = ? AND lower(team2) = ?) OR (lower(team1) = ? AND lower(team2) = ?))
      AND resolved_at >= datetime(?, ?)
      AND resolved_at <= datetime(?, ?)
      AND winner IS NOT NULL AND winner != ''
    ORDER BY ABS(julianday(resolved_at) - julianday(?)) ASC
    LIMIT 10
  `).all(game, n1, n2, n2, n1, t.created_at, windowBefore, t.created_at, windowAfter, t.created_at);
  console.log(`  STEP2: exact match → ${candidates.length} candidates`);

  if (!candidates.length) {
    const l1 = `%${n1}%`, l2 = `%${n2}%`;
    candidates = db.prepare(`
      SELECT winner, final_score, resolved_at, match_id, team1, team2, league
      FROM match_results
      WHERE game = ?
        AND ((lower(team1) LIKE ? AND lower(team2) LIKE ?) OR (lower(team1) LIKE ? AND lower(team2) LIKE ?))
        AND resolved_at >= datetime(?, ?)
        AND resolved_at <= datetime(?, ?)
        AND winner IS NOT NULL AND winner != ''
      ORDER BY ABS(julianday(resolved_at) - julianday(?)) ASC
      LIMIT 10
    `).all(game, l1, l2, l2, l1, t.created_at, windowBefore, t.created_at, windowAfter, t.created_at);
    console.log(`  STEP2b: fuzzy LIKE → ${candidates.length} candidates`);
  }

  if (!candidates.length) {
    console.log(`  ✗ STEP2: NO candidates → skipped`);
    return;
  }

  for (const [i, c] of candidates.entries()) {
    console.log(`     [${i}] team1='${c.team1}' team2='${c.team2}' winner='${c.winner}' score='${c.final_score || ''}' league='${c.league || '?'}'`);
  }

  // Step 3: league tiebreak
  const tipLeagueN = _normLeague(t.league || '');
  let filtered = candidates;
  if (tipLeagueN && candidates.length > 1) {
    const leagueMatches = candidates.filter(c => _leagueOverlap(tipLeagueN, _normLeague(c.league || '')));
    if (leagueMatches.length) {
      filtered = leagueMatches;
      console.log(`  STEP3: league overlap '${tipLeagueN}' → filtered ${candidates.length} → ${filtered.length}`);
    } else {
      console.log(`  STEP3: nenhuma candidate com league overlap '${tipLeagueN}' → mantém todas`);
    }
  }

  // Step 4: pick parseable
  let mr = filtered[0];
  const needsMapScore = (t.market === 'handicap' || t.market === 'total');
  if (needsMapScore) {
    const parseable = filtered.find(c => _parseEsportsMapScore(c.final_score) != null);
    if (parseable) {
      mr = parseable;
      console.log(`  STEP4: picked parseable → score='${mr.final_score}' winner='${mr.winner}'`);
    } else {
      console.log(`  ✗ STEP4: NENHUMA candidate com score parseável (todas falham _parseEsportsMapScore) → skip`);
      for (const c of filtered) console.log(`        '${c.final_score}' → parsed=${JSON.stringify(_parseEsportsMapScore(c.final_score))}`);
      return;
    }
  }

  // Step 5: winnerIs1
  const nw = _norm(mr.winner);
  const winnerIs1 = nw === n1 || (nw && n1 && (nw.includes(n1) || n1.includes(nw)));
  console.log(`  STEP5: winnerIs1=${winnerIs1} (winner_norm='${nw}' vs team1_norm='${n1}')`);

  // Step 6: parse + result
  if (t.market === 'handicap') {
    const parsedMaps = _parseEsportsMapScore(mr.final_score);
    if (!parsedMaps) {
      console.log(`  ✗ STEP6: _parseEsportsMapScore re-call retornou null (BUG! step4 disse parseable)`);
      return;
    }
    const team1Sets = winnerIs1 ? parsedMaps.winnerMaps : parsedMaps.loserMaps;
    const team2Sets = winnerIs1 ? parsedMaps.loserMaps : parsedMaps.winnerMaps;
    const team1Diff = team1Sets - team2Sets;
    const sideIsT1 = t.side === 'team1' || t.side === 'home';
    const covers = sideIsT1 ? (team1Diff + t.line > 0) : (-team1Diff + t.line > 0);
    const result = covers ? 'win' : 'loss';
    console.log(`  ✓ STEP6 handicap: ${parsedMaps.winnerMaps}-${parsedMaps.loserMaps} | team1Sets=${team1Sets} team2Sets=${team2Sets} diff=${team1Diff}`);
    console.log(`         sideIsT1=${sideIsT1} (side=${t.side}) | line=${t.line} | covers=${covers} → result=${result}`);
    console.log(`  ✓ DEVERIA settle como '${result}' MAS NÃO ESTÁ. Por quê?`);

    // Hipótese: timing. Tip pode ter sido criada DEPOIS do match resolvido.
    const tipMs = new Date(t.created_at + 'Z').getTime();
    const matchMs = new Date(mr.resolved_at + 'Z').getTime();
    const diffH = (tipMs - matchMs) / 3600000;
    console.log(`         Timing: tip criada ${diffH > 0 ? '+' : ''}${diffH.toFixed(1)}h após match resolvido`);
    if (diffH > 0) {
      console.log(`         🚨 TIP CRIADA DEPOIS DO MATCH! Cron checa created_at <= -2h, então deve passar...`);
    }
  } else if (t.market === 'total') {
    const parsedMaps = _parseEsportsMapScore(mr.final_score);
    const totalMaps = parsedMaps.winnerMaps + parsedMaps.loserMaps;
    const over = totalMaps > t.line;
    const result = (t.side === 'over') === over ? 'win' : 'loss';
    console.log(`  ✓ STEP6 total: ${totalMaps} ${over ? '>' : '≤'} ${t.line} | side='${t.side}' → result=${result}`);
  }
}

// Pega tips ok_should_settle (match achado + parseable + handled market + ≥2h + pending)
const HANDLED = ['matchWinner', 'handicap', 'total'];
const sportFilter = SPORT ? `AND sport = '${SPORT.replace(/'/g, "''")}'` : '';
const idFilter = ONE_ID ? `AND id = ${parseInt(ONE_ID, 10)}` : '';
const teamFilter = TEAM_FILTER
  ? `AND (lower(team1) LIKE lower('%${TEAM_FILTER.replace(/'/g, "''")}%') OR lower(team2) LIKE lower('%${TEAM_FILTER.replace(/'/g, "''")}%'))`
  : '';
const sql = `
  SELECT id, sport, team1, team2, league, market, line, side, created_at
  FROM market_tips_shadow
  WHERE result IS NULL
    AND market IN (${HANDLED.map(m => `'${m}'`).join(',')})
    AND created_at <= datetime('now', '-2 hours')
    ${sportFilter}
    ${idFilter}
    ${teamFilter}
  ORDER BY created_at DESC
  LIMIT 30
`;
const rows = db.prepare(sql).all();
console.log(`Encontrei ${rows.length} tips pending com market handled e ≥2h. Debugando até 10:`);

let count = 0;
for (const t of rows) {
  if (count++ >= 10) break;
  debugOne(t);
}

#!/usr/bin/env node
'use strict';

/**
 * sync-sofascore-history.js — ingest histórico Sofascore proxy para sports
 * sem match_results atual (darts, snooker, table-tennis).
 *
 * Fluxo:
 *   1. Itera N dias atrás (default 180d)
 *   2. Pra cada dia, fetch /schedule/{sport}/{date}/
 *   3. Filtra events status=finished, extrai winner via winnerCode (1=home, 2=away)
 *   4. Upsert em match_results
 *
 * Slugs: darts | snooker | table-tennis
 *
 * Uso:
 *   node scripts/sync-sofascore-history.js --sport table-tennis --days-back 90
 *   node scripts/sync-sofascore-history.js --sport darts --days-back 365
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

const SPORT = argVal('sport', 'table-tennis');
const DAYS_BACK = parseInt(argVal('days-back', '180'), 10);
const RATE_MS = parseInt(argVal('rate-ms', '300'), 10);
const PROXY_BASE = argVal('proxy',
  process.env.SOFASCORE_PROXY_BASE
  || 'https://victorious-expression-production-af8a.up.railway.app/api/v1/sofascore');
const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

// Map sport slug → game column em match_results (shorter, consistente)
const SPORT_TO_GAME = {
  'darts': 'darts',
  'snooker': 'snooker',
  'table-tennis': 'tabletennis',
};
const GAME = SPORT_TO_GAME[SPORT] || SPORT;

console.log(`[sync-sofa] sport=${SPORT} game=${GAME} days-back=${DAYS_BACK} rate=${RATE_MS}ms`);
console.log(`[sync-sofa] proxy=${PROXY_BASE}`);

const { db } = initDatabase(DB_PATH);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url, timeoutMs = 20000) {
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

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchDay(dateStr) {
  const url = `${PROXY_BASE}/schedule/${SPORT}/${dateStr}/`;
  const r = await httpsGet(url);
  if (r.status !== 200) return [];
  try {
    const j = JSON.parse(r.body);
    return Array.isArray(j.events) ? j.events : [];
  } catch (_) { return []; }
}

function extractMatch(ev) {
  // Só processa finished (senão pula)
  if (ev?.status?.type !== 'finished') return null;
  const home = ev?.homeTeam?.name;
  const away = ev?.awayTeam?.name;
  if (!home || !away) return null;

  // winnerCode: 1=home, 2=away, 3=draw
  const wc = ev?.winnerCode;
  let winner = null;
  if (wc === 1) winner = home;
  else if (wc === 2) winner = away;
  else return null; // draw/null → skip

  // Score final se disponível
  const h = ev?.homeScore?.current ?? ev?.homeScore?.display;
  const a = ev?.awayScore?.current ?? ev?.awayScore?.display;
  const scoreStr = (h != null && a != null) ? `${h}-${a}` : '';

  const league = ev?.tournament?.uniqueTournament?.name
             || ev?.tournament?.name
             || `${SPORT}`;
  const startTs = ev?.startTimestamp ? new Date(ev.startTimestamp * 1000) : null;
  const resolvedAt = startTs ? startTs.toISOString().slice(0, 19).replace('T', ' ') : null;
  if (!resolvedAt) return null;

  return {
    match_id: `sofa_${GAME}_${ev.id}`,
    game: GAME,
    team1: home,
    team2: away,
    winner,
    final_score: scoreStr,
    league,
    resolved_at: resolvedAt,
  };
}

async function main() {
  const upsert = db.prepare(`
    INSERT INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
    VALUES (@match_id, @game, @team1, @team2, @winner, @final_score, @league, @resolved_at)
    ON CONFLICT(match_id, game) DO UPDATE SET
      team1=excluded.team1, team2=excluded.team2, winner=excluded.winner,
      final_score=excluded.final_score, league=excluded.league, resolved_at=excluded.resolved_at
  `);
  const tx = db.transaction((rows) => { for (const r of rows) upsert.run(r); });

  const startMs = Date.now();
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  let totalIngested = 0;
  let totalDays = 0;
  let errDays = 0;

  for (let i = 1; i <= DAYS_BACK; i++) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = fmtDate(d);
    try {
      const events = await fetchDay(dateStr);
      const matches = events.map(extractMatch).filter(Boolean);
      if (matches.length) {
        tx(matches);
        totalIngested += matches.length;
      }
      totalDays++;
      if (i % 10 === 0 || i === DAYS_BACK) {
        console.log(`[sync-sofa] ${i}/${DAYS_BACK} (${dateStr}) ingest=${matches.length} total=${totalIngested}`);
      }
    } catch (e) {
      errDays++;
      if (errDays < 5) console.warn(`[sync-sofa] day ${dateStr} err: ${e.message}`);
    }
    await sleep(RATE_MS);
  }

  const dbCount = db.prepare("SELECT COUNT(*) n FROM match_results WHERE game=?").get(GAME);
  const elapsed = Math.round((Date.now() - startMs) / 1000);
  console.log(`\n[sync-sofa] done in ${elapsed}s. Days: ${totalDays}/${DAYS_BACK} (err ${errDays})`);
  console.log(`[sync-sofa] Ingested: ${totalIngested}`);
  console.log(`[sync-sofa] match_results.${GAME} total: ${dbCount.n}`);
}

main().catch(e => { console.error('[sync-sofa] FATAL:', e); process.exit(1); });

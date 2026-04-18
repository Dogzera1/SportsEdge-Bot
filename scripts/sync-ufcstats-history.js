#!/usr/bin/env node
'use strict';

/**
 * sync-ufcstats-history.js — ingest histórico UFCStats → match_results.
 *
 * Fluxo:
 *   1. Lista todos eventos completos (http://ufcstats.com/statistics/events/completed?page=all)
 *   2. Pra cada evento, fetch event-details → extrai fights (winner/loser/method/round)
 *   3. Upsert em match_results com game='mma'
 *
 * Rate-limit: 500ms entre requests (UFCStats é pequeno site; não abusar).
 *
 * Uso:
 *   node scripts/sync-ufcstats-history.js          # full sync
 *   node scripts/sync-ufcstats-history.js --max 50 # só 50 eventos mais recentes (teste)
 *   node scripts/sync-ufcstats-history.js --since 2020
 */

require('dotenv').config({ override: true });
const path = require('path');
const http = require('http');
const initDatabase = require('../lib/database');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const MAX_EVENTS = parseInt(argVal('max', '0'), 10) || 0;  // 0 = all
const SINCE_YEAR = parseInt(argVal('since', '0'), 10) || 0;
const RATE_MS = parseInt(argVal('rate-ms', '500'), 10);
const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const { db } = initDatabase(DB_PATH);

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; sportsedge-bot)' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: HEADERS }, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => resolve({ status: r.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')); });
  });
}

async function fetchEventsList() {
  const url = 'http://ufcstats.com/statistics/events/completed?page=all';
  const r = await httpGet(url);
  if (r.status !== 200) throw new Error('events list HTTP ' + r.status);
  const events = [];
  const seen = new Set();
  const re = /event-details\/([a-f0-9]+)["'][^>]*>([^<]+)</g;
  let m;
  while ((m = re.exec(r.body)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    events.push({ id, name: m[2].trim() });
  }
  return events;
}

function parseDate(s) {
  // "April 18, 2026"
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function parseMethodRound(rowHtml) {
  // Method e round vem em TDs no final. Exemplo:
  // <td><p>KO/TKO</p><p>Punches</p></td> ... <td><p>2</p></td> <td><p>4:32</p></td>
  const ps = [...rowHtml.matchAll(/<p class="b-fight-details__table-text[^"]*"[^>]*>\s*([^<]+?)\s*<\/p>/g)]
    .map(m => m[1].trim());
  return ps;
}

async function fetchEventFights(eventId, eventName) {
  const url = `http://ufcstats.com/event-details/${eventId}`;
  const r = await httpGet(url);
  if (r.status !== 200) return [];

  // Extrai data do evento
  const dateM = r.body.match(/Date:[\s\S]{0,40}?<\/i>\s*([^<]+)/);
  const eventDate = dateM ? parseDate(dateM[1].trim()) : null;

  const tbodyMatch = r.body.match(/<tbody[^>]*class="b-fight-details__table-body"[^>]*>([\s\S]{0,200000}?)<\/tbody>/);
  if (!tbodyMatch) return [];
  const body = tbodyMatch[1];

  const rows = [...body.matchAll(/<tr[^>]*data-link="http:\/\/ufcstats\.com\/fight-details\/([a-f0-9]+)"[^>]*>([\s\S]{0,10000}?)<\/tr>/g)];
  const fights = [];
  for (const rm of rows) {
    const fightId = rm[1];
    const row = rm[2];

    // Fighters (ordem: 1º = winner, 2º = loser)
    const fighters = [...row.matchAll(/href="http:\/\/ufcstats\.com\/fighter-details\/[a-f0-9]+"\s*>\s*([^<]+?)\s*</g)]
      .map(m => m[1].trim());
    if (fighters.length < 2) continue;
    const fighter1 = fighters[0];
    const fighter2 = fighters[1];

    // Winner: TD tem flag green/red. Se primeira flag for green → fighter1 venceu.
    // Se for red → fighter2. Se 'draw' ou 'nc' → skip (no clear winner).
    const flagText = row.match(/b-flag__text">([^<]+?)</);
    const flag = flagText ? flagText[1].trim().toLowerCase() : null;

    let winner = null;
    if (flag === 'win') winner = fighter1; // Green = first listed won
    else if (flag === 'loss') winner = fighter2; // (improvável mas por segurança)
    else continue; // draw, nc, next

    // Method (KO/Submission/Decision) + Round
    const ps = parseMethodRound(row);
    // Estrutura típica: [f1Str, f2Str, f1TD, f2TD, f1Sub, f2Sub, weightClass, methodType, methodDetail, round, time]
    const method = ps.length >= 10 ? ps[ps.length - 4] : null;
    const round = ps.length >= 10 ? parseInt(ps[ps.length - 2], 10) || null : null;

    fights.push({
      match_id: `ufcstats_${fightId}`,
      game: 'mma',
      team1: fighter1, team2: fighter2,
      winner,
      final_score: `${method || ''} R${round || '?'}`.trim(),
      league: eventName,
      resolved_at: eventDate || new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
  }
  return fights;
}

async function main() {
  console.log(`[sync-ufcstats] fetching events list...`);
  let events = await fetchEventsList();
  console.log(`[sync-ufcstats] ${events.length} events disponíveis`);

  if (SINCE_YEAR) {
    // No way to filter without date — filter by name regex of year
    events = events.filter(e => !/\b(19\d{2}|200[0-9]|201[0-9]|202[0-9])\b/.test(e.name) || _eventYearFromName(e.name) >= SINCE_YEAR);
  }
  if (MAX_EVENTS > 0) events = events.slice(0, MAX_EVENTS);
  console.log(`[sync-ufcstats] processando ${events.length} eventos (rate ${RATE_MS}ms/req)`);

  // Upsert statement — PK é (match_id, game)
  const upsert = db.prepare(`
    INSERT INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
    VALUES (@match_id, @game, @team1, @team2, @winner, @final_score, @league, @resolved_at)
    ON CONFLICT(match_id, game) DO UPDATE SET
      team1=excluded.team1, team2=excluded.team2, winner=excluded.winner,
      final_score=excluded.final_score, league=excluded.league, resolved_at=excluded.resolved_at
  `);

  let totalFights = 0;
  let totalEventsOk = 0;
  let errCount = 0;
  const tx = db.transaction((rows) => { for (const r of rows) upsert.run(r); });

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    try {
      const fights = await fetchEventFights(ev.id, ev.name);
      if (fights.length) {
        tx(fights);
        totalFights += fights.length;
        totalEventsOk++;
      }
      if (i % 20 === 0 || i === events.length - 1) {
        console.log(`[sync-ufcstats] ${i+1}/${events.length} (${ev.name.slice(0,40)}) → +${fights.length} fights | total ${totalFights}`);
      }
    } catch (e) {
      errCount++;
      if (errCount < 5) console.warn(`[sync-ufcstats] err event ${ev.name}: ${e.message}`);
    }
    await sleep(RATE_MS);
  }

  // Sanity
  const mmaCount = db.prepare("SELECT COUNT(*) n FROM match_results WHERE game='mma'").get();
  console.log(`\n[sync-ufcstats] done. Events OK: ${totalEventsOk}/${events.length} | Errors: ${errCount}`);
  console.log(`[sync-ufcstats] Fights inserted: ${totalFights}`);
  console.log(`[sync-ufcstats] match_results.mma total: ${mmaCount.n}`);
}

function _eventYearFromName(n) {
  const m = String(n).match(/\b(19\d{2}|20\d{2})\b/);
  return m ? parseInt(m[1], 10) : 0;
}

main().catch(e => { console.error('[sync-ufcstats] FATAL:', e); process.exit(1); });

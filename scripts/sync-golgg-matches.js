#!/usr/bin/env node
'use strict';

// scripts/sync-golgg-matches.js
//
// Sincroniza histórico de matches LoL do gol.gg para match_results.
// Auto-descobre tournaments via endpoint AJAX `/tournament/ajax.trlist.php`
// (retorna lista oficial por season S12-S16). Sem API key.
//
// Uso:
//   node scripts/sync-golgg-matches.js                       # default: S13-S16
//   node scripts/sync-golgg-matches.js --seasons S14,S15
//   node scripts/sync-golgg-matches.js --min-games 10        # ignora tournaments minúsculos
//   node scripts/sync-golgg-matches.js --dry-run             # só printa

require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  return argv[i + 1];
}
function argFlag(n) { return argv.includes(`--${n}`); }

const SEASONS = (argVal('seasons', 'S13,S14,S15,S16') || '').split(',').map(s => s.trim()).filter(Boolean);
const MIN_GAMES = parseInt(argVal('min-games', '5'), 10);
const DRY = argFlag('dry-run');
const DELAY_MS = parseInt(argVal('delay', '400'), 10);

// Filter: só regiões tier-1/tier-2 e internacionais (evita ITF-equivalente que polui o modelo)
const REGION_INCLUDE = /^(KR|CN|EU|NA|LMS|VN|TW|BR|LA|TR|JP|OCE|WR|CIS|SEA|MENA)$/i;

const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': HTTP_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'User-Agent': HTTP_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://gol.gg/tournament/list/',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function fetchTournamentsForSeason(season) {
  const r = await post('https://gol.gg/tournament/ajax.trlist.php', `season=${season}`);
  if (r.status !== 200) return [];
  try {
    const arr = JSON.parse(r.body);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn(`[sync-golgg] parse tournaments ${season}: ${e.message}`);
    return [];
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parser: extrai rows de tournament-matchlist.
// Cada <tr> tem:
//   <td class='text-left'><a href='../game/stats/<gameId>/page-summary/' title='<T1> vs <T2> summary'><T1> vs <T2></a></td>
//   <td class='text-right text_victory|text_defeat'><T1_fullname></td>
//   <td class='text-center'>X - Y</td>
//   <td class='text_victory|text_defeat'><T2_fullname></td>
//   <td class='text-center'>WEEK<N></td>
//   <td class='text-center'><patch></td>
//   <td class='text-center'>YYYY-MM-DD</td>
function parseMatches(html, tournamentName) {
  const rowRe = /<tr>\s*<td class='text-left'><a href='[^']+game\/stats\/(\d+)\/[^']*' title='([^']+)'>[^<]*<\/a><\/td>\s*<td class='text-right (text_victory|text_defeat)'>([^<]+)<\/td>\s*<td class='text-center'>(\d+)\s*-\s*(\d+)<\/td>\s*<td class='(text_victory|text_defeat)'>([^<]+)<\/td>[\s\S]*?<td class='text-center'>(\d{4}-\d{2}-\d{2})<\/td>\s*<\/tr>/g;
  const out = [];
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const [, gameId, title, t1Class, t1Full, s1, s2, t2Class, t2Full, date] = m;
    const team1 = t1Full.trim();
    const team2 = t2Full.trim();
    const score1 = parseInt(s1, 10);
    const score2 = parseInt(s2, 10);
    const p1Win = t1Class === 'text_victory';
    const winner = p1Win ? team1 : team2;
    const bo = (score1 + score2) >= 5 ? 5 : (score1 + score2) >= 3 ? 3 : 1;
    out.push({
      match_id: `golgg_${gameId}`,
      team1, team2, winner,
      final_score: `Bo${bo} ${score1}-${score2}`,
      league: tournamentName,
      resolved_at: `${date} 23:00:00`,
    });
  }
  return out;
}

async function main() {
  const { db } = initDatabase(DB_PATH);
  const before = db.prepare(`SELECT COUNT(*) as n FROM match_results WHERE game='lol'`).get().n;
  console.log(`[sync-golgg] match_results.lol ANTES: ${before}`);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
    VALUES (?, 'lol', ?, ?, ?, ?, ?, ?)
  `);

  // Primeiro hit na root pra "acordar" sessão
  await get('https://gol.gg/').catch(() => null);
  await sleep(200);

  // Descobre tournaments por season
  const allTourneys = [];
  for (const s of SEASONS) {
    const list = await fetchTournamentsForSeason(s);
    console.log(`[sync-golgg] ${s}: ${list.length} tournaments retornados pelo AJAX`);
    for (const t of list) {
      const nbgames = parseInt(t.nbgames || 0, 10);
      if (nbgames < MIN_GAMES) continue;
      if (!REGION_INCLUDE.test(t.region || '')) continue;
      allTourneys.push({ name: t.trname, region: t.region, nbgames });
    }
    await sleep(300);
  }
  console.log(`[sync-golgg] ${allTourneys.length} tournaments qualificados (regiões filtradas + min-games=${MIN_GAMES})`);

  let okTourneys = 0, failedTourneys = 0, totalMatches = 0, insertedMatches = 0;

  for (const t of allTourneys) {
    const slug = encodeURIComponent(t.name);
    const url = `https://gol.gg/tournament/tournament-matchlist/${slug}/`;
    try {
      const r = await get(url);
      if (r.status !== 200) { failedTourneys++; console.log(`  ${t.name}: HTTP ${r.status} (skip)`); await sleep(DELAY_MS); continue; }
      const matches = parseMatches(r.body, t.name);
      if (matches.length === 0) { failedTourneys++; console.log(`  ${t.name}: 0 matches`); await sleep(DELAY_MS); continue; }

      okTourneys++;
      totalMatches += matches.length;
      let newlyInserted = 0;
      if (!DRY) {
        const tx = db.transaction((rows) => {
          for (const m of rows) {
            const res = insertStmt.run(m.match_id, m.team1, m.team2, m.winner, m.final_score, m.league, m.resolved_at);
            if (res.changes > 0) newlyInserted++;
          }
        });
        tx(matches);
      }
      insertedMatches += newlyInserted;
      console.log(`  ${t.name} [${t.region}]: ${matches.length} parsed (+${newlyInserted} novos)`);
    } catch (e) {
      failedTourneys++;
      console.log(`  ${t.name}: ERR ${e.message}`);
    }
    await sleep(DELAY_MS);
  }

  const after = db.prepare(`SELECT COUNT(*) as n FROM match_results WHERE game='lol'`).get().n;
  console.log(`\n[sync-golgg] DEPOIS: ${after} (delta +${after - before})`);
  console.log(`[sync-golgg] tournaments OK=${okTourneys} fail=${failedTourneys} | matches parsed=${totalMatches} new=${insertedMatches}`);
}

main().catch(e => { console.error('[sync-golgg] fatal:', e.message); process.exit(1); });

#!/usr/bin/env node
'use strict';

// scripts/sync-hltv-results.js
//
// Sincroniza histórico de matches CS2 via scraping de hltv.org/results.
// Página lista results por offset (50 por página, ordenado -data).
// Sem API; parse HTML via regex.
//
// Uso:
//   node scripts/sync-hltv-results.js                # default: 3000 matches
//   node scripts/sync-hltv-results.js --max 8000 --delay 2000

require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const argv = process.argv.slice(2);
function argVal(n, d) {
  const i = argv.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const MAX = parseInt(argVal('max', '3000'), 10);
const DELAY_MS = parseInt(argVal('delay', '2000'), 10);

const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': HTTP_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.hltv.org/',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parser: HLTV results page.
// Bloco por match:
//   <div class="result-con" ...>
//     <a href="/matches/<id>/<slug>">...
//       <div class="team1">...<div class="team">TEAM1</div><div class="team-won|team-lost">score1</div>...
//       <div class="team2">...<div class="team">TEAM2</div><div class="team-won|team-lost">score2</div>...
//       <span class="event-name">EVENT</span>
//       <span class="date-cell"><span class="standard-headline">data</span></span>  (fallback)
// Simplificação via regex porque HLTV muda classe frequentemente.
function parseResults(html, dateStr) {
  const results = [];
  // Cada bloco de resultado tem <a href="/matches/NNNNNN/...">
  const matchRe = /<a href="\/matches\/(\d+)\/[^"]+"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = matchRe.exec(html)) !== null) {
    const matchId = m[1];
    const inner = m[2];
    // Só queremos result-con (partidas concluídas, tem score)
    if (!/team-won|team-lost|score-won|score-lost/.test(inner) && !/result-score/.test(inner)) continue;
    // Team names
    const t1m = inner.match(/class="team1[^"]*"[\s\S]*?<div class="team">([^<]+)<\/div>/);
    const t2m = inner.match(/class="team2[^"]*"[\s\S]*?<div class="team">([^<]+)<\/div>/);
    if (!t1m || !t2m) continue;
    const t1 = t1m[1].trim(), t2 = t2m[1].trim();
    if (!t1 || !t2) continue;
    // Scores
    const scoreMatch = inner.match(/<div class="result-score">\s*<span[^>]*>(\d+)<\/span>\s*<span[^>]*>-<\/span>\s*<span[^>]*>(\d+)<\/span>/)
      || inner.match(/<span class="score-won[^"]*">(\d+)<\/span>\s*<span[^>]*>-<\/span>\s*<span class="score-lost[^"]*">(\d+)<\/span>/)
      || inner.match(/<span[^>]*>(\d+)<\/span>\s*<span[^>]*>[-:]<\/span>\s*<span[^>]*>(\d+)<\/span>/);
    if (!scoreMatch) continue;
    const s1 = parseInt(scoreMatch[1], 10), s2 = parseInt(scoreMatch[2], 10);
    if (s1 === s2) continue;
    // Winner: maior score
    const winner = s1 > s2 ? t1 : t2;
    // Event name (league)
    const evMatch = inner.match(/class="event-name"[^>]*>([^<]+)<\/span>/)
      || inner.match(/data-event[^=]*="([^"]+)"/);
    const event = evMatch ? evMatch[1].trim() : '';
    // Bo inferido: 2 jogos → Bo3 (até 2 wins), 3 → Bo5, 1 → Bo1
    const bo = Math.max(s1, s2) >= 3 ? 5 : Math.max(s1, s2) >= 2 ? 3 : 1;
    results.push({
      match_id: `hltv_${matchId}`,
      team1: t1, team2: t2, winner,
      final_score: `Bo${bo} ${s1}-${s2}`,
      league: event,
      resolved_at: dateStr, // fallback: usa data da page
    });
  }
  return results;
}

// HLTV agrupa results por data em /results?offset=N. Extrai data headers no HTML.
// Cada div.results-sublist tem <span class="standard-headline">Results for October 15th 2024</span>
function parseResultsPage(html) {
  const out = [];
  // Split por sublist
  const subRe = /<div class="results-sublist"[\s\S]*?(?=<div class="results-sublist"|$)/g;
  let seen = 0;
  let m;
  while ((m = subRe.exec(html)) !== null) {
    const sub = m[0];
    const headerMatch = sub.match(/<span class="standard-headline">Results for ([^<]+)<\/span>/)
      || sub.match(/<span class="standard-headline">([^<]+)<\/span>/);
    let dateStr = '2024-01-01 23:00:00';
    if (headerMatch) {
      try {
        const d = new Date(headerMatch[1]);
        if (!isNaN(d.getTime())) dateStr = d.toISOString().replace('T', ' ').slice(0, 19);
      } catch (_) {}
    }
    const chunk = parseResults(sub, dateStr);
    out.push(...chunk);
    seen++;
    if (seen > 50) break;
  }
  // Fallback: parse do HTML todo caso o split não funcione
  if (!out.length) {
    const fallbackDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
    out.push(...parseResults(html, fallbackDate));
  }
  return out;
}

async function main() {
  const { db } = initDatabase(DB_PATH);
  const before = db.prepare(`SELECT COUNT(*) as n FROM match_results WHERE game='cs2'`).get().n;
  console.log(`[hltv] match_results.cs2 ANTES: ${before}`);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
    VALUES (?, 'cs2', ?, ?, ?, ?, ?, ?)
  `);

  let offset = 0, totalFetched = 0, totalInserted = 0;
  const PAGE_SIZE = 100; // HLTV retorna 100 por page
  let consecutiveEmpty = 0;

  while (totalFetched < MAX && consecutiveEmpty < 3) {
    const url = `https://www.hltv.org/results?offset=${offset}`;
    try {
      const r = await get(url);
      if (r.status === 403 || r.status === 429) {
        console.log(`  blocked (${r.status}), backoff 60s...`);
        await sleep(60000);
        continue;
      }
      if (r.status !== 200) { console.log(`  HTTP ${r.status}, stop`); break; }
      const results = parseResultsPage(r.body);
      if (!results.length) { consecutiveEmpty++; console.log(`  offset=${offset}: 0 parsed`); offset += PAGE_SIZE; await sleep(DELAY_MS); continue; }
      consecutiveEmpty = 0;
      let pageInserted = 0;
      const tx = db.transaction((rows) => {
        for (const x of rows) {
          const res = insertStmt.run(x.match_id, x.team1, x.team2, x.winner, x.final_score, x.league, x.resolved_at);
          if (res.changes > 0) pageInserted++;
        }
      });
      tx(results);
      totalFetched += results.length;
      totalInserted += pageInserted;
      console.log(`  offset=${offset}: ${results.length} parsed, +${pageInserted} inserted | total=${totalInserted}/${totalFetched}`);
    } catch (e) {
      console.log(`  offset=${offset}: ERR ${e.message}`);
    }
    offset += PAGE_SIZE;
    await sleep(DELAY_MS);
  }

  const after = db.prepare(`SELECT COUNT(*) as n FROM match_results WHERE game='cs2'`).get().n;
  console.log(`\n[hltv] DEPOIS: ${after} (delta +${after - before})`);
  console.log(`[hltv] fetched=${totalFetched} inserted=${totalInserted}`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

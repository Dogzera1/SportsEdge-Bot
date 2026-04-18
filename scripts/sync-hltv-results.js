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
const START_OFFSET = parseInt(argVal('start-offset', '0'), 10);

const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Usa o proxy HLTV existente (HLTV_PROXY_BASE) — mesmo padrão do lib/hltv.js.
// Sem proxy, cai pra direto (vai dar 403 na maioria dos casos).
const HLTV_PROXY_BASE = (process.env.HLTV_PROXY_BASE || '').trim().replace(/\/+$/, '');
const HLTV_DIRECT = /^(1|true|yes)$/i.test(String(process.env.HLTV_DIRECT || ''));

function buildHltvUrl(path) {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (HLTV_PROXY_BASE) {
    let b = HLTV_PROXY_BASE;
    if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
    return `${b}${p}`;
  }
  return `https://www.hltv.org${p}`;
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': HTTP_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.hltv.org/',
        'ngrok-skip-browser-warning': 'true',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parser: HLTV /results page.
// Estrutura (2026):
//   <div class="result-con><a href="/matches/<id>/<slug>" class="a-reset">
//     <div class="result"><table><tr>
//       <td class="team-cell"><div class="line-align team1">
//         <div class="team [team-won]">TEAM1</div><img.../></div></td>
//       <td class="result-score">
//         <span class="score-won|score-lost">N</span> - <span class="...">N</span></td>
//       <td class="team-cell"><div class="line-align team2">
//         <img.../><div class="team [team-won]">TEAM2</div></div></td>
//       <td class="event">...<span class="event-name">EVENT</span></td>
function parseResults(html, dateStr) {
  const results = [];
  // Splitta por result-con
  const blocks = html.split(/<div class="result-con/).slice(1);
  for (const raw of blocks) {
    const block = raw.slice(0, 4000); // limita scope
    // Match id
    const idMatch = block.match(/^[^>]*><a href="\/matches\/(\d+)\//);
    if (!idMatch) continue;
    const matchId = idMatch[1];
    // Team 1 (dentro do primeiro team-cell)
    const t1Match = block.match(/<div class="line-align team1">[\s\S]*?<div class="team( team-won)?\s*">([^<]+)<\/div>/);
    if (!t1Match) continue;
    const t1 = t1Match[2].trim();
    const t1Won = !!t1Match[1];
    // Team 2 (segundo team-cell)
    const t2Match = block.match(/<div class="line-align team2">[\s\S]*?<div class="team( team-won)?\s*">([^<]+)<\/div>/);
    if (!t2Match) continue;
    const t2 = t2Match[2].trim();
    const t2Won = !!t2Match[1];
    // Scores
    const scoreMatch = block.match(/<td class="result-score">\s*<span class="(score-won|score-lost)">(\d+)<\/span>\s*-\s*<span class="(score-won|score-lost)">(\d+)<\/span>/);
    if (!scoreMatch) continue;
    const s1 = parseInt(scoreMatch[2], 10);
    const s2 = parseInt(scoreMatch[4], 10);
    if (!Number.isFinite(s1) || !Number.isFinite(s2) || s1 === s2) continue;
    // Winner: via team-won class (mais robusto que comparar score)
    let winner = null;
    if (t1Won) winner = t1;
    else if (t2Won) winner = t2;
    else winner = s1 > s2 ? t1 : t2;
    // Event
    const evMatch = block.match(/<span class="event-name">([^<]+)<\/span>/);
    const event = evMatch ? evMatch[1].trim() : '';
    // Bo inferido
    const maxS = Math.max(s1, s2);
    const bo = maxS >= 3 ? 5 : maxS >= 2 ? 3 : 1;
    results.push({
      match_id: `hltv_${matchId}`,
      team1: t1, team2: t2, winner,
      final_score: `Bo${bo} ${s1}-${s2}`,
      league: event,
      resolved_at: dateStr,
    });
  }
  return results;
}

// Escaneia o HTML inteiro pegando cada <div class="result-con>, e mantém um
// "currentDate" running baseado no <span class="standard-headline"> mais próximo
// acima. HLTV insere headers tipo "Results for April 10th 2025" entre grupos de dias.
function parseResultsPage(html) {
  const out = [];
  // Encontra todas as ocorrências de result-con e de standard-headline na ordem do doc
  const markers = [];
  const reResultCon = /<div class="result-con/g;
  const reHeadline = /<span class="standard-headline">([^<]+)<\/span>/g;
  let m;
  while ((m = reResultCon.exec(html)) !== null) markers.push({ type: 'match', idx: m.index });
  while ((m = reHeadline.exec(html)) !== null) markers.push({ type: 'date', idx: m.index, text: m[1].trim() });
  markers.sort((a, b) => a.idx - b.idx);

  let currentDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const mk of markers) {
    if (mk.type === 'date') {
      // "Results for April 10th 2025" ou "April 10th 2025"
      const clean = mk.text.replace(/^Results for\s+/i, '').replace(/(\d+)(st|nd|rd|th)/, '$1');
      const d = new Date(clean);
      if (!isNaN(d.getTime())) currentDate = d.toISOString().replace('T', ' ').slice(0, 19);
      continue;
    }
    // match — parse só este bloco
    const chunk = html.slice(mk.idx, mk.idx + 4000);
    const parsed = parseResults('<div class="result-con' + chunk.slice('<div class="result-con'.length), currentDate);
    if (parsed.length) out.push(parsed[0]); // só o primeiro (este bloco)
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

  let offset = START_OFFSET, totalFetched = 0, totalInserted = 0;
  const PAGE_SIZE = 100; // HLTV retorna 100 por page
  let consecutiveEmpty = 0;

  if (!HLTV_PROXY_BASE && !HLTV_DIRECT) {
    console.error(`[hltv] HLTV_PROXY_BASE não configurado — Cloudflare bloqueia acesso direto. Abortando.`);
    process.exit(1);
  }
  console.log(`[hltv] usando ${HLTV_PROXY_BASE ? 'proxy=' + HLTV_PROXY_BASE : 'direct (HLTV_DIRECT=true)'}`);

  while (totalFetched < MAX && consecutiveEmpty < 3) {
    const url = buildHltvUrl(`/results?offset=${offset}`);
    try {
      const r = await get(url);
      if (r.status === 403 || r.status === 429) {
        // Railway proxy cf-clearance session pode estar stale; espera 5min pra renovar
        console.log(`  blocked (${r.status}), backoff 5min (proxy CF session)...`);
        await sleep(5 * 60 * 1000);
        continue;
      }
      if (r.status !== 200) { console.log(`  HTTP ${r.status}, stop`); break; }
      // Detecta CF challenge
      if (/just a moment|cf-browser-verification|cloudflare/i.test(r.body) && r.body.length < 5000) {
        console.log(`  CF challenge (body<5kb), backoff 30s...`);
        await sleep(30000);
        continue;
      }
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

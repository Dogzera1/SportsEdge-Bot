#!/usr/bin/env node
'use strict';

// v2: usa /admin/mt-shadow-audit pra ter match_results join (final_score, winner).
// Foca em ATP Madrid R3 Madrid R2 + Mauthausen pra comparar pattern.

const https = require('https');
const fs = require('fs');

const BASE = (process.env.BASE || '').replace(/\/+$/, '');
const KEY = process.env.KEY || '';
if (!BASE || !KEY) { console.error('defina BASE e KEY'); process.exit(1); }

function get(url) {
  return new Promise(r => {
    const u = new URL(url);
    const opt = { method: 'GET', hostname: u.hostname, path: u.pathname + u.search,
                  headers: { 'x-admin-key': KEY } };
    https.request(opt, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { r({ status: res.statusCode, body: JSON.parse(d) }); }
                            catch { r({ status: res.statusCode, body: d.slice(0, 500) }); } });
    }).on('error', e => r({ status: 0, error: e.message })).end();
  });
}

function parseScoreGames(score) {
  // "6-4 7-5" → 22 ; "6-1 6-7 6-3" → 29 ; "Bo3 ..." for esports — return null for tennis-only
  if (!score || /^Bo\d/.test(score)) return null;
  // Strip tiebreak "(2)" annotations
  const clean = score.replace(/\([^)]*\)/g, '');
  const parts = clean.split(/\s+/).filter(Boolean);
  let total = 0, validSets = 0;
  for (const p of parts) {
    const m = p.match(/^(\d{1,2})-(\d{1,2})$/);
    if (m) {
      total += parseInt(m[1], 10) + parseInt(m[2], 10);
      validSets++;
    }
  }
  return validSets > 0 ? total : null;
}

async function main() {
  // Pull all settled MT shadow rows with match_results join (mt-shadow-audit returns mismatches+ok)
  // Better: use the leagues endpoints we have. Combine multiple sources.

  // Approach: query market_tips_by_league and also pull match_results via /sport-performance?
  // Simplest: use the audit-7d.json we already have, join with audit-leaks-7d.json, extract.
  // BUT we need final_score → mt-shadow-audit body has mr_score.

  console.log('Fetching mt-shadow-audit (this can be big)...');
  const audit = await get(`${BASE}/admin/mt-shadow-audit?days=14&apply=0&key=${KEY}`);
  const auditBody = audit.body || {};
  console.log(`Examined ${auditBody.examined}, ok ${auditBody.ok_count}, mismatches ${auditBody.mismatches_count}`);
  // mismatches has rows with mr_score. But that's only 11 rows. We need ALL settled, not just mismatches.

  // Use market-tips-recent + cross-ref via match_results separately.
  console.log('\nFetching MT Madrid R3 + R2 + Mauthausen...');
  const leagues = ['ATP Madrid - R3', 'ATP Madrid - R2', 'ATP Madrid - R16', 'ATP Challenger Mauthausen - R1'];
  const allTips = [];
  for (const lg of leagues) {
    const r = await get(`${BASE}/market-tips-recent?sport=tennis&league=${encodeURIComponent(lg)}&days=14&limit=500&includeVoid=1&dedup=0&key=${KEY}`);
    const tips = r.body?.tips || r.body?.rows || [];
    console.log(`  ${lg}: ${tips.length} tips`);
    for (const t of tips) allTips.push({ league: lg, ...t });
  }

  // Now per tip, search for match in match_results via admin endpoint or specific hit.
  // /admin/mt-tips-suspect lists with mr_score. Or: aggregate dedup first, then sample.

  // === DEDUP by (match, market, line, side) ===
  const dedup = new Map();
  for (const t of allTips) {
    const k = `${t.league}|${t.team1||t.participant1}|${t.team2||t.participant2}|${(t.market||t.market_type||'').toLowerCase()}|${t.line}|${(t.side||'').toLowerCase()}`;
    const prev = dedup.get(k);
    if (!prev || (t.created_at || t.sent_at || '') > (prev.created_at || prev.sent_at || '')) {
      dedup.set(k, t);
    }
  }
  console.log(`\nApós dedup: ${dedup.size} tips únicas (de ${allTips.length} raw)`);

  // === Compute true ROI per league after dedup ===
  const byLeague = new Map();
  for (const t of dedup.values()) {
    let g = byLeague.get(t.league);
    if (!g) { g = { n: 0, wins: 0, losses: 0, voids: 0, profit: 0, staked: 0 }; byLeague.set(t.league, g); }
    g.n++;
    const result = (t.result||'').toLowerCase();
    const stake = parseFloat(t.stake_units || 1) || 1;
    const odd = parseFloat(t.odd || t.odds || 0);
    if (result === 'win') { g.wins++; g.profit += stake * (odd - 1); g.staked += stake; }
    else if (result === 'loss') { g.losses++; g.profit -= stake; g.staked += stake; }
    else if (result === 'void') { g.voids++; }
  }
  console.log('\n=== Por liga (POST dedup) ===');
  console.log('  liga                                n  W  L  V  staked profit  ROI%');
  for (const [lg, g] of byLeague.entries()) {
    const roi = g.staked > 0 ? +(g.profit / g.staked * 100).toFixed(1) : 0;
    console.log(`  ${lg.slice(0,38).padEnd(38)} ${g.n.toString().padStart(2)} ${g.wins.toString().padStart(2)} ${g.losses.toString().padStart(2)} ${g.voids.toString().padStart(2)} ${g.staked.toFixed(1).padStart(6)} ${(g.profit>=0?'+':'')+g.profit.toFixed(2).padStart(6)} ${roi.toString().padStart(6)}`);
  }

  // === Per-match concentration ===
  const byMatch = new Map();
  for (const t of allTips) {
    const k = `${t.league} | ${t.team1||t.participant1} vs ${t.team2||t.participant2}`;
    let g = byMatch.get(k);
    if (!g) { g = { n: 0, wins: 0, losses: 0, voids: 0, profit: 0, staked: 0, markets: new Set() }; byMatch.set(k, g); }
    g.n++;
    g.markets.add(`${t.market||t.market_type}/${t.side}/${t.line}`);
    const result = (t.result||'').toLowerCase();
    const stake = parseFloat(t.stake_units || 1) || 1;
    const odd = parseFloat(t.odd || t.odds || 0);
    if (result === 'win') { g.wins++; g.profit += stake * (odd - 1); g.staked += stake; }
    else if (result === 'loss') { g.losses++; g.profit -= stake; g.staked += stake; }
    else if (result === 'void') { g.voids++; }
  }
  console.log('\n=== Concentração por match (n>=4 raw) ===');
  console.log('  match                                                          n unique W  L  V  profit');
  const sortedM = [...byMatch.entries()].filter(([k,g])=>g.n>=4).sort((a,b)=>a[1].profit - b[1].profit);
  for (const [k, g] of sortedM) {
    console.log(`  ${k.slice(0,60).padEnd(60)}  ${g.n.toString().padStart(2)}  ${g.markets.size.toString().padStart(4)} ${g.wins.toString().padStart(2)} ${g.losses.toString().padStart(2)} ${g.voids.toString().padStart(2)}  ${(g.profit>=0?'+':'')+g.profit.toFixed(2)}`);
  }

  // === DUPLICATAS exatas (mesmo match + mesmo market + mesma line + mesmo side) ===
  const dupKey = new Map();
  for (const t of allTips) {
    const k = `${t.team1||t.participant1}|${t.team2||t.participant2}|${(t.market||t.market_type||'').toLowerCase()}|${t.line}|${(t.side||'').toLowerCase()}`;
    if (!dupKey.has(k)) dupKey.set(k, []);
    dupKey.get(k).push(t);
  }
  const exactDupes = [...dupKey.entries()].filter(([k,v])=>v.length>1).sort((a,b)=>b[1].length - a[1].length);
  console.log(`\n=== Duplicatas exatas (mesmo team+market+line+side) ===`);
  console.log(`Total grupos com >=2 tips: ${exactDupes.length}`);
  for (const [k, arr] of exactDupes.slice(0, 10)) {
    const w = arr.filter(t => (t.result||'')==='win').length;
    const l = arr.filter(t => (t.result||'')==='loss').length;
    console.log(`  ${arr.length}× | ${k} | W=${w} L=${l}`);
  }

  fs.writeFileSync('audit-atp-madrid-rcv2.json', JSON.stringify({
    raw: allTips.length, dedup: dedup.size,
    byLeague: [...byLeague.entries()],
    byMatch: [...byMatch.entries()],
    exactDupes: exactDupes.map(([k,v]) => ({key:k, count:v.length, results:v.map(t=>t.result)})),
  }, null, 2));
  console.log(`\nGravado audit-atp-madrid-rcv2.json`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

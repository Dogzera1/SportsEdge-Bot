#!/usr/bin/env node
'use strict';

// scripts/root-cause-tennis-clv.js
// Investiga CLV tennis -26% — quebra por liga, mercado, is_live, timing dispatch→close.

const https = require('https');
const fs = require('fs');

const BASE = (process.env.BASE || '').replace(/\/+$/, '');
const KEY = process.env.KEY || '';
if (!BASE || !KEY) { console.error('defina BASE e KEY'); process.exit(1); }

function get(path) {
  return new Promise(r => {
    const u = new URL(BASE + path);
    https.request({ method: 'GET', hostname: u.hostname, path: u.pathname + u.search,
                    headers: { 'x-admin-key': KEY } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { r({ status: res.statusCode, body: JSON.parse(d) }); }
                            catch { r({ status: res.statusCode, body: d.slice(0, 300) }); } });
    }).on('error', e => r({ status: 0, error: e.message })).end();
  });
}

function clvPct(open, close) {
  // CLV = (open - close) / close * 100 (positivo = pegamos odd melhor que close)
  // Anteriormente: (open_odds / clv_odds - 1) * 100 — equivalente.
  if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 1 || close <= 1) return null;
  return (open / close - 1) * 100;
}

async function main() {
  console.log('Pulling tennis MT tips com odd timestamps...');
  // Reusa endpoint /market-tips-recent que tem clv_pct
  const r = await get(`/market-tips-recent?sport=tennis&days=14&limit=500&includeVoid=1&dedup=0&key=${KEY}`);
  let tips = r.body?.tips || r.body?.rows || [];
  console.log(`Total raw tennis MT tips 14d: ${tips.length}`);

  // Dedup by (team1, team2, market, line, side) keeping latest
  const dedup = new Map();
  for (const t of tips) {
    const k = `${t.team1}|${t.team2}|${t.market}|${t.line}|${t.side}`;
    const prev = dedup.get(k);
    if (!prev || (t.created_at || '') > (prev.created_at || '')) dedup.set(k, t);
  }
  tips = [...dedup.values()];
  console.log(`After dedup: ${tips.length}`);

  // Pull ML real tennis com clv_odds + open_odds
  const ml = await get(`/tips-history?sport=tennis&days=14&limit=500&include_markets=1&key=${KEY}`);
  const mlTips = (Array.isArray(ml.body) ? ml.body : (ml.body?.tips || [])).filter(t => t.sport === 'tennis');
  console.log(`Real tips (ML+MT promoted): ${mlTips.length}`);

  // === ANALYSIS ===
  console.log('\n=== MT shadow CLV breakdown ===');

  // Shadow has: open_odd (initial), odd (current/last seen), close_odd (final), clv_pct
  // Compute CLV from open vs close where available
  let withClv = 0, sumClv = 0, posCount = 0;
  const byLeague = new Map();
  const byMarket = new Map();
  const byLive = new Map();
  for (const t of tips) {
    let clv = Number(t.clv_pct);
    if (!Number.isFinite(clv)) {
      const open = Number(t.odd) || Number(t.open_odd);
      const close = Number(t.close_odd);
      clv = clvPct(open, close);
    }
    if (!Number.isFinite(clv)) continue;
    withClv++;
    sumClv += clv;
    if (clv > 0) posCount++;

    const lg = t.league || '?';
    let g = byLeague.get(lg);
    if (!g) { g = { n: 0, sum: 0, pos: 0 }; byLeague.set(lg, g); }
    g.n++; g.sum += clv; if (clv > 0) g.pos++;

    const mk = t.market || '?';
    let m = byMarket.get(mk);
    if (!m) { m = { n: 0, sum: 0, pos: 0 }; byMarket.set(mk, m); }
    m.n++; m.sum += clv; if (clv > 0) m.pos++;

    const isLive = t.is_live ? 'LIVE' : 'PRE';
    let l = byLive.get(isLive);
    if (!l) { l = { n: 0, sum: 0, pos: 0 }; byLive.set(isLive, l); }
    l.n++; l.sum += clv; if (clv > 0) l.pos++;
  }
  console.log(`Total com CLV: ${withClv} | avg CLV: ${(sumClv/withClv).toFixed(2)}% | positive rate: ${(posCount/withClv*100).toFixed(0)}%`);

  console.log('\n--- Por liga (top n) ---');
  for (const [lg, g] of [...byLeague.entries()].sort((a,b)=>b[1].n-a[1].n).slice(0, 25)) {
    const avg = +(g.sum / g.n).toFixed(1);
    const pos = +(g.pos / g.n * 100).toFixed(0);
    console.log(`  ${lg.slice(0,42).padEnd(42)} n=${String(g.n).padStart(3)} avgCLV=${String(avg).padStart(7)}% pos%=${String(pos).padStart(3)}%`);
  }

  console.log('\n--- Por mercado ---');
  for (const [mk, g] of [...byMarket.entries()].sort((a,b)=>b[1].n-a[1].n)) {
    const avg = +(g.sum / g.n).toFixed(1);
    const pos = +(g.pos / g.n * 100).toFixed(0);
    console.log(`  ${mk.padEnd(20)} n=${String(g.n).padStart(3)} avgCLV=${String(avg).padStart(7)}% pos%=${String(pos).padStart(3)}%`);
  }

  console.log('\n--- Live vs Pre-match ---');
  for (const [k, g] of byLive.entries()) {
    const avg = +(g.sum / g.n).toFixed(1);
    const pos = +(g.pos / g.n * 100).toFixed(0);
    console.log(`  ${k.padEnd(8)} n=${String(g.n).padStart(3)} avgCLV=${avg}% pos%=${pos}%`);
  }

  console.log('\n=== ML real tips CLV (tennis) ===');
  let realClvN = 0, realClvSum = 0;
  const realByLeague = new Map();
  for (const t of mlTips) {
    const open = Number(t.open_odds);
    const close = Number(t.clv_odds);
    const clv = clvPct(open, close);
    if (!Number.isFinite(clv)) continue;
    realClvN++; realClvSum += clv;
    const lg = t.event_name || '?';
    let g = realByLeague.get(lg);
    if (!g) { g = { n: 0, sum: 0, pos: 0 }; realByLeague.set(lg, g); }
    g.n++; g.sum += clv; if (clv > 0) g.pos++;
  }
  console.log(`Real n=${realClvN} avgCLV=${realClvN ? (realClvSum/realClvN).toFixed(2) : '-'}%`);
  for (const [lg, g] of [...realByLeague.entries()].sort((a,b)=>b[1].n-a[1].n)) {
    const avg = +(g.sum / g.n).toFixed(1);
    const pos = +(g.pos / g.n * 100).toFixed(0);
    console.log(`  ${lg.slice(0,42).padEnd(42)} n=${String(g.n).padStart(3)} avgCLV=${String(avg).padStart(7)}% pos%=${String(pos).padStart(3)}%`);
  }

  // === Worst CLV individual examples ===
  console.log('\n=== Top 10 PIORES CLV (shadow) ===');
  const withClvList = tips.filter(t => Number.isFinite(Number(t.clv_pct)) || Number.isFinite(clvPct(Number(t.odd||t.open_odd), Number(t.close_odd))))
    .map(t => ({
      ...t,
      _clv: Number.isFinite(Number(t.clv_pct)) ? Number(t.clv_pct) : clvPct(Number(t.odd||t.open_odd), Number(t.close_odd)),
    }));
  for (const t of withClvList.sort((a,b)=>a._clv - b._clv).slice(0, 10)) {
    console.log(`  CLV=${t._clv.toFixed(1)}% | ${t.league?.slice(0,28)} | ${t.team1} vs ${t.team2} | ${t.market}/${t.side} ln=${t.line} | open=${t.odd||t.open_odd} close=${t.close_odd} | ${t.is_live?'LIVE':'PRE'}`);
  }

  fs.writeFileSync('audit-tennis-clv.json', JSON.stringify({
    counts: { raw: r.body?.tips?.length || 0, dedup: tips.length, withClv },
    avg_clv: withClv ? sumClv/withClv : null,
    pos_rate: withClv ? posCount/withClv : null,
    by_league: [...byLeague.entries()].map(([k,v]) => ({ league: k, ...v, avg: v.n?v.sum/v.n:null })),
    by_market: [...byMarket.entries()].map(([k,v]) => ({ market: k, ...v, avg: v.n?v.sum/v.n:null })),
    by_live: [...byLive.entries()].map(([k,v]) => ({ live: k, ...v, avg: v.n?v.sum/v.n:null })),
    real_avg_clv: realClvN ? realClvSum/realClvN : null,
    worst: withClvList.sort((a,b)=>a._clv-b._clv).slice(0, 25),
  }, null, 2));
  console.log('\nGravado audit-tennis-clv.json');
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

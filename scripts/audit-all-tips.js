#!/usr/bin/env node
'use strict';

// scripts/audit-all-tips.js
// Junta TUDO: ML real + ML shadow + MT shadow rows individuais (últimos 7d).
// Saída: audit-all-tips-7d.json + relatório agregado no stdout.

const https = require('https');
const fs = require('fs');

const BASE = (process.env.BASE || '').replace(/\/+$/, '');
const KEY = process.env.KEY || '';
const DAYS = parseInt(process.env.DAYS || '7', 10);
if (!BASE || !KEY) { console.error('defina BASE e KEY'); process.exit(1); }

const SPORTS = ['lol','dota2','cs','cs2','valorant','tennis','football','mma','snooker','darts','tabletennis'];

function get(url) {
  return new Promise(r => {
    const t = setTimeout(() => r({ status: 0, body: null, error: 'timeout' }), 30000);
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(t);
        try { r({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { r({ status: res.statusCode, body: d.slice(0, 500) }); }
      });
    }).on('error', e => { clearTimeout(t); r({ status: 0, error: e.message }); });
  });
}

const u = (p, q = {}) => {
  q.key = KEY;
  return BASE + p + '?' + Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
};

async function main() {
  const all = []; // {source, sport, ...row}

  // 1. ML real per sport via /tips-history (default ML only — esse já filtra)
  for (const s of SPORTS) {
    const r = await get(u('/tips-history', { days: DAYS, sport: s, limit: 500 }));
    const rows = Array.isArray(r.body) ? r.body : (r.body?.tips || []);
    for (const t of rows) all.push({ source: 'ml_real', sport: s, ...t });
    process.stdout.write(`\r[1/3] ml_real ${s}: ${rows.length}        `);
  }
  process.stdout.write('\n');

  // 2. ML shadow per sport via /shadow-tips
  for (const s of SPORTS) {
    const r = await get(u('/shadow-tips', { sport: s, limit: 500 }));
    const rows = r.body?.tips || [];
    // /shadow-tips não filtra por dias — corta client-side
    const cutoff = new Date(Date.now() - DAYS * 86400_000);
    const recent = rows.filter(t => {
      const ts = Date.parse(String(t.sent_at || '').replace(' ', 'T'));
      return Number.isFinite(ts) && ts >= cutoff.getTime();
    });
    for (const t of recent) all.push({ source: 'ml_shadow', sport: s, ...t });
    process.stdout.write(`\r[2/3] ml_shadow ${s}: ${recent.length}/${rows.length}    `);
  }
  process.stdout.write('\n');

  // 3. MT shadow per sport via /market-tips-recent (paginate até esgotar)
  for (const s of SPORTS) {
    let offset = 0;
    let total = 0;
    while (true) {
      const r = await get(u('/market-tips-recent', { sport: s, days: DAYS, limit: 500, offset, includeVoid: 1, dedup: 0 }));
      const rows = r.body?.tips || r.body?.rows || (Array.isArray(r.body) ? r.body : []);
      if (!rows.length) break;
      for (const t of rows) all.push({ source: 'mt_shadow', sport: s, ...t });
      total += rows.length;
      if (rows.length < 500) break;
      offset += rows.length;
    }
    process.stdout.write(`\r[3/3] mt_shadow ${s}: ${total}            `);
  }
  process.stdout.write('\n');

  console.log(`\nTOTAL collected: ${all.length} rows`);

  // === AGGREGATIONS ===
  // Helpers
  const agg = (arr, keyFn) => {
    const m = new Map();
    for (const t of arr) {
      const k = keyFn(t);
      if (!k) continue;
      let g = m.get(k);
      if (!g) { g = { key: k, n: 0, settled: 0, wins: 0, losses: 0, voids: 0, pending: 0, profit: 0, staked: 0, clvSum: 0, clvN: 0, evSum: 0, evN: 0 }; m.set(k, g); }
      g.n++;
      const result = (t.result || '').toLowerCase();
      if (result === 'win') { g.wins++; g.settled++; }
      else if (result === 'loss') { g.losses++; g.settled++; }
      else if (result === 'void') { g.voids++; }
      else g.pending++;
      const profit = Number(t.profit_reais ?? t.profit_units ?? t.profit ?? 0);
      const staked = Number(t.stake_reais ?? t.stake_units ?? t.staked ?? 0) ||
                     parseFloat(String(t.stake || '0').replace('u','')) || 0;
      g.profit += profit;
      g.staked += staked;
      const ev = Number(t.ev || 0);
      if (ev) { g.evSum += ev; g.evN++; }
      // CLV
      const cl = Number(t.clv_pct);
      if (Number.isFinite(cl) && cl !== 0) { g.clvSum += cl; g.clvN++; }
      else if (t.open_odds && t.clv_odds) {
        const c = (Number(t.open_odds) / Number(t.clv_odds) - 1) * 100;
        if (Number.isFinite(c)) { g.clvSum += c; g.clvN++; }
      }
    }
    return [...m.values()].map(g => ({
      key: g.key, n: g.n, settled: g.settled, wins: g.wins, losses: g.losses, voids: g.voids, pending: g.pending,
      hit: g.settled ? +(g.wins / g.settled * 100).toFixed(1) : null,
      profit: +g.profit.toFixed(2),
      staked: +g.staked.toFixed(2),
      roi: g.staked ? +(g.profit / g.staked * 100).toFixed(1) : null,
      avgEv: g.evN ? +(g.evSum / g.evN).toFixed(1) : null,
      avgClv: g.clvN ? +(g.clvSum / g.clvN).toFixed(1) : null,
      clvN: g.clvN,
    })).sort((a, b) => b.n - a.n);
  };

  const tier = (sport, league) => {
    const L = String(league || '').toLowerCase();
    if (sport === 'tennis') {
      if (/(slam|wimbledon|french open|us open|australian open|roland)/.test(L)) return 'Slam';
      if (/(masters|atp 1000|atp1000)/.test(L)) return 'Masters';
      if (/(wta|atp).*(madrid|miami|indian wells|rome|cincinnati|paris|monte|shanghai|toronto|canadian)/.test(L)) return 'WTA/ATP500+1000';
      if (/(atp\s*\d|wta\s*\d|atp250|wta250|atp500|wta500)/.test(L)) return 'ATP/WTA Tour';
      if (/challenger/.test(L)) return 'Challenger';
      if (/(125k|125 k|wta\s*125)/.test(L)) return 'WTA 125';
      if (/itf/.test(L)) return 'ITF';
      return 'Other';
    }
    if (sport === 'lol') {
      if (/lck$|lpl$|lec$|lcs$|lta\b/.test(L)) return 'Tier1';
      if (/lck challengers|lcl|lpl academy|prm|ncs|tcl|lec|cblol|lla|pcs/.test(L)) return 'Tier2';
      if (/road of legends|esports world cup|ewc/.test(L)) return 'Special';
      return 'Tier3+';
    }
    if (sport === 'cs2' || sport === 'cs') {
      if (/major|elite|epl|esl pro|blast|iem/.test(L)) return 'Tier1';
      if (/esl challenger|ccts?|cct|european pro|rush b|champion of champions/.test(L)) return 'Tier2';
      return 'Tier3';
    }
    if (sport === 'football') {
      if (/premier league|la liga|serie a italy|bundesliga|ligue 1$/.test(L)) return 'Tier1';
      if (/championship|serie b|brasileirao serie a|league 1\b|ligue 2/.test(L)) return 'Tier2';
      return 'Tier3';
    }
    return 'Other';
  };

  // Group by source
  const bySource = agg(all, t => t.source);
  // Real vs shadow combined per sport
  const bySourceSport = agg(all, t => `${t.source}|${t.sport}`);
  // Tennis tier
  const tennisRows = all.filter(t => t.sport === 'tennis');
  const lolRows = all.filter(t => t.sport === 'lol');
  const csRows = all.filter(t => t.sport === 'cs' || t.sport === 'cs2');
  const fbRows = all.filter(t => t.sport === 'football');

  const fmt = (rows, header) => {
    console.log('\n=== ' + header + ' ===');
    console.log('  KEY                                    n   set  hit%   ROI%  EV%   CLV%(n)  profit');
    for (const r of rows) {
      if (r.n < 1) continue;
      console.log(
        '  ' + String(r.key).slice(0, 38).padEnd(38) +
        ' ' + String(r.n).padStart(3) +
        ' ' + String(r.settled).padStart(4) +
        ' ' + (r.hit ?? '-').toString().padStart(5) +
        ' ' + (r.roi ?? '-').toString().padStart(6) +
        ' ' + (r.avgEv ?? '-').toString().padStart(5) +
        ' ' + (r.avgClv ?? '-').toString().padStart(5) + '(' + String(r.clvN).padStart(3) + ')' +
        ' ' + (r.profit >= 0 ? '+' : '') + r.profit.toFixed(2).padStart(7)
      );
    }
  };

  fmt(bySource, 'BY SOURCE');
  fmt(bySourceSport.filter(r => r.n >= 3), 'BY SOURCE × SPORT (n≥3)');
  fmt(agg(tennisRows, t => `${t.source}|${tier('tennis', t.event_name || t.league)}`), 'TENNIS by source × tier');
  fmt(agg(tennisRows, t => `${t.source}|${(t.market_type || t.market || 'ML')}|${(t.side || 'na')}`).filter(r => r.n >= 3), 'TENNIS by source × market × side (n≥3)');
  fmt(agg(tennisRows, t => `${tier('tennis', t.event_name || t.league)}|${(t.market_type || t.market || 'ML')}`).filter(r => r.n >= 3), 'TENNIS by tier × market (n≥3)');
  fmt(agg(lolRows, t => `${t.source}|${tier('lol', t.event_name || t.league)}|${(t.market_type || t.market || 'ML')}`).filter(r => r.n >= 2), 'LOL by source × tier × market (n≥2)');
  fmt(agg(csRows, t => `${t.source}|${tier('cs2', t.event_name || t.league)}|${(t.market_type || t.market || 'ML')}`).filter(r => r.n >= 2), 'CS by source × tier × market (n≥2)');
  fmt(agg(fbRows, t => `${t.source}|${tier('football', t.event_name || t.league)}|${(t.market_type || t.market || 'ML')}`).filter(r => r.n >= 2), 'FOOTBALL by source × tier × market (n≥2)');

  // Top leaks (ROI ≤ -10% AND n ≥ 5)
  const leakKey = t => `${t.sport}|${t.event_name || t.league || '?'}|${(t.market_type || t.market || 'ML')}|${(t.side || 'na')}|${t.source}`;
  const leaks = agg(all, leakKey).filter(r => r.n >= 5 && (r.roi ?? 0) <= -10).sort((a, b) => a.profit - b.profit);
  fmt(leaks.slice(0, 20), '🔴 TOP LEAKS (n≥5, ROI≤-10%)');

  const winners = agg(all, leakKey).filter(r => r.n >= 5 && (r.roi ?? 0) >= 10).sort((a, b) => b.profit - a.profit);
  fmt(winners.slice(0, 20), '🟢 TOP WINNERS (n≥5, ROI≥10%)');

  // Save raw + aggregations
  fs.writeFileSync('audit-all-tips-7d.json', JSON.stringify({
    fetched_at: new Date().toISOString(),
    days: DAYS,
    total_rows: all.length,
    by_source_summary: bySource,
    by_source_sport: bySourceSport,
    leaks: leaks,
    winners: winners,
    tips: all,
  }, null, 2));
  console.log(`\nGravado audit-all-tips-7d.json (${all.length} rows raw)`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

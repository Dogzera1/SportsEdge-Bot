#!/usr/bin/env node
'use strict';

// scripts/audit-leaks-deep.js
//
// Auditoria profunda 7d agrupando por sport × liga × mercado × tier.
// Foca em IDENTIFICAR leaks reais (n suficiente, ROI/CLV negativos, padrões).

const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE = (process.env.BASE || '').replace(/\/+$/, '');
const KEY = process.env.KEY || '';
if (!BASE || !KEY) { console.error('defina BASE e KEY'); process.exit(1); }

const SPORTS = ['lol','dota2','cs2','valorant','tennis','football','mma','snooker','darts','tabletennis'];
const DAYS = parseInt(process.env.DAYS || '7', 10);

function get(u) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve({ status: 0, error: 'timeout' }), 30000);
    https.get(u, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(t);
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d.slice(0, 300) }); }
      });
    }).on('error', e => { clearTimeout(t); resolve({ status: 0, error: e.message }); });
  });
}

const u = (p, q = {}) => {
  q.key = KEY;
  return BASE + p + '?' + Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
};

async function main() {
  const out = { fetched_at: new Date().toISOString(), days: DAYS, results: {} };
  const tasks = [];
  const add = (n, url) => tasks.push({ n, url });

  // ML real grouping
  add('tips_by_sport', u('/tips-by-sport', { days: DAYS }));
  add('tips_by_market', u('/tips-by-market', { days: DAYS }));
  add('league_bleed_scan', u('/league-bleed-scan', { days: DAYS }));
  add('league_blocks', u('/league-blocks'));
  add('mt_shadow_audit', u('/admin/mt-shadow-audit', { days: DAYS }));
  add('mt_promote_status', u('/admin/mt-promote-status'));
  add('mt_settle_audit', u('/admin/mt-settle-audit', { days: DAYS }));
  add('market_tips_breakdown', u('/market-tips-breakdown', { days: DAYS }));
  add('market_tips_by_sport', u('/market-tips-by-sport', { days: DAYS }));

  for (const s of SPORTS) {
    add(`tips_by_league_${s}`,         u('/tips-by-league', { days: DAYS, sport: s }));
    add(`clv_by_league_${s}`,          u('/clv-by-league', { days: DAYS, sport: s }));
    add(`market_tips_by_league_${s}`,  u('/market-tips-by-league', { days: DAYS, sport: s }));
    add(`roi_by_ev_${s}`,              u('/roi-by-ev-bucket', { days: DAYS, sport: s }));
  }

  let done = 0;
  await Promise.all(tasks.map(async ({ n, url }) => {
    const r = await get(url);
    out.results[n] = { status: r.status, body: r.body, ...(r.error ? { error: r.error } : {}) };
    done++;
    process.stdout.write(`\r[deep] ${done}/${tasks.length}`);
  }));
  process.stdout.write('\n');

  const ok = Object.values(out.results).filter(r => r.status >= 200 && r.status < 400).length;
  console.log(`[deep] ok=${ok} fail=${tasks.length - ok}`);
  for (const [k, v] of Object.entries(out.results)) {
    if (!(v.status >= 200 && v.status < 400)) console.log(`  - ${k}: ${v.status}`);
  }

  fs.writeFileSync(path.join(process.cwd(), 'audit-leaks-7d.json'), JSON.stringify(out, null, 2));
  console.log(`[deep] gravado em audit-leaks-7d.json`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

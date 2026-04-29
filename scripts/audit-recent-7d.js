#!/usr/bin/env node
'use strict';

// scripts/audit-recent-7d.js
//
// Hits prod endpoints e gera audit-7d.json com snapshot completo dos últimos 7d.
//
// Uso (cmd Windows):
//   set BASE=https://sua-app.up.railway.app
//   set KEY=seu_admin_key
//   node scripts/audit-recent-7d.js
//
// Uso (PowerShell):
//   $env:BASE="https://..."; $env:KEY="..."; node scripts/audit-recent-7d.js

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = (process.env.BASE || '').replace(/\/+$/, '');
const KEY = process.env.KEY || '';
if (!BASE || !KEY) {
  console.error('ERRO: defina BASE e KEY como variáveis de ambiente.');
  console.error('  cmd:        set BASE=https://...  &&  set KEY=...');
  console.error('  PowerShell: $env:BASE="..."; $env:KEY="..."');
  process.exit(1);
}

const SPORTS = ['lol','dota2','cs2','valorant','tennis','football','mma','snooker','darts','tabletennis'];

function get(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const t = setTimeout(() => resolve({ status: 0, error: 'timeout', url }), 30000);
    lib.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        clearTimeout(t);
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { parsed = data.slice(0, 500); }
        resolve({ status: res.statusCode, body: parsed, url });
      });
    }).on('error', e => { clearTimeout(t); resolve({ status: 0, error: e.message, url }); });
  });
}

const sep = (k, v) => `${k}=${encodeURIComponent(v)}`;
function url(path, params = {}) {
  params.key = KEY;
  const qs = Object.entries(params).map(([k, v]) => sep(k, v)).join('&');
  return `${BASE}${path}?${qs}`;
}

async function main() {
  console.log(`[audit] base=${BASE.replace(/^https?:\/\//, '')} window=7d`);
  const out = { fetched_at: new Date().toISOString(), base: BASE, days: 7, results: {} };

  const tasks = [];
  const add = (name, u) => tasks.push({ name, u });

  add('overall_summary',          url('/overall-summary', { days: 7 }));
  add('bankroll_audit',           url('/bankroll-audit'));
  add('ml_shadow_by_sport',       url('/ml-shadow-by-sport', { days: 7 }));
  add('clv_capture_trace',        url('/admin/clv-capture-trace', { days: 7 }));
  add('loops_state',              url('/loops-state'));
  add('ai_impact',                url('/ai-impact', { days: 7 }));
  add('league_blocklist',         url('/league-blocklist'));
  add('mt_settled_suspects',      url('/mt-settled-suspects', { days: 7 }));
  add('shadow_summary',           url('/shadow-summary', { days: 7 }));
  add('models_summary',           url('/models'));
  add('odds_bucket_roi',          url('/roi-by-odds-bucket', { days: 7 }));

  for (const s of SPORTS) {
    add(`tips_${s}`,              url('/tips-history', { days: 7, sport: s, limit: 500 }));
    add(`void_${s}`,              url('/void-audit', { days: 7, sport: s }));
    add(`mt_summary_${s}`,        url('/market-tips-summary', { days: 7, sport: s }));
  }

  let done = 0;
  const total = tasks.length;
  await Promise.all(tasks.map(async ({ name, u }) => {
    const r = await get(u);
    out.results[name] = { status: r.status, ok: r.status >= 200 && r.status < 400, ...(r.error ? { error: r.error } : {}), body: r.body };
    done++;
    process.stdout.write(`\r[audit] ${done}/${total}`);
  }));
  process.stdout.write('\n');

  const okCount = Object.values(out.results).filter(r => r.ok).length;
  const failCount = total - okCount;
  console.log(`[audit] ok=${okCount} fail=${failCount}`);
  if (failCount > 0) {
    console.log('[audit] endpoints com falha:');
    for (const [k, v] of Object.entries(out.results)) {
      if (!v.ok) console.log(`  - ${k}: status=${v.status}${v.error ? ' err=' + v.error : ''}`);
    }
  }

  const outPath = path.join(process.cwd(), 'audit-7d.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`[audit] gravado em ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

#!/usr/bin/env node
'use strict';

// scripts/root-cause-atp-madrid-r3.js
// Investigate the ATP Madrid R3 totalGames over leak (-63% n=13).
// Pull tips + match scores from prod via HTTP.

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

async function main() {
  // 1) Pull MT shadow ATP Madrid R3 (all markets)
  const mt = await get(`${BASE}/market-tips-recent?sport=tennis&league=${encodeURIComponent('ATP Madrid - R3')}&days=14&limit=200&includeVoid=1&dedup=0&key=${KEY}`);
  const mtTips = mt.body?.tips || mt.body?.rows || [];
  console.log(`MT shadow tips ATP Madrid R3: ${mtTips.length}`);

  // 2) Pull ML real tips for same league
  const ml = await get(`${BASE}/tips-history?sport=tennis&days=14&limit=500&key=${KEY}`);
  const mlAll = Array.isArray(ml.body) ? ml.body : (ml.body?.tips || []);
  const mlTips = mlAll.filter(t => (t.event_name || '').includes('ATP Madrid - R3'));
  console.log(`ML real tips ATP Madrid R3: ${mlTips.length}`);

  // 3) Combine + analyze
  const allRows = [
    ...mlTips.map(t => ({ src: 'ml_real', ...t })),
    ...mtTips.map(t => ({ src: 'mt_shadow', ...t })),
  ];

  console.log('\n=== Per-tip detail ===');
  console.log('  ID  src  market   side line   teams                                   pModel  odd  EV%  result  score');
  for (const t of allRows.sort((a,b) => (a.sent_at||a.created_at||'').localeCompare(b.sent_at||b.created_at||''))) {
    const m = (t.market_type || t.market || '?').slice(0,14);
    let sdRaw = t.side;
    if (!sdRaw) {
      const sm = String(t.tip_participant||'').match(/(OVER|UNDER|HOME|AWAY)/i);
      if (sm) sdRaw = sm[1];
    }
    const sd = String(sdRaw||'').toLowerCase();
    let lnDisp = t.line;
    if (lnDisp == null) {
      const lm = String(t.tip_participant||'').match(/[+-]?\d+\.?\d*/);
      lnDisp = lm ? lm[0] : '?';
    }
    const ln = lnDisp;
    const teams = ((t.participant1 || t.team1 || '?') + ' vs ' + (t.participant2 || t.team2 || '?')).slice(0,38);
    const pm = t.model_p_pick ?? t.pModel ?? t.p_model ?? '-';
    const od = t.odds ?? t.odd ?? '-';
    const ev = t.ev ?? '-';
    const res = (t.result || 'pend').slice(0,5);
    const fs = (t.final_score || t.match_final_score || '?').slice(0,18);
    console.log(`  ${String(t.id).padEnd(4)} ${t.src.slice(0,9).padEnd(9)} ${m.padEnd(15)} ${sd.padEnd(5)} ${String(ln).padEnd(5)} ${teams.padEnd(38)} ${String(pm).slice(0,6).padEnd(6)} ${String(od).slice(0,5).padEnd(5)} ${String(ev).slice(0,5).padEnd(5)} ${res.padEnd(6)} ${fs}`);
  }

  // 4) totalGames-specific analysis
  const tgOver = allRows.filter(t => {
    const m = (t.market_type || t.market || '').toLowerCase();
    const s = (t.side || '').toLowerCase();
    const tp = String(t.tip_participant||'').toUpperCase();
    return (m === 'totalgames' || m === 'total_games' || m === 'totalGames' || m === 'TOTAL_GAMES') &&
           (s === 'over' || tp.includes('OVER'));
  });
  console.log(`\n=== totalGames OVER detail (${tgOver.length} tips) ===`);
  let totalLines = 0, totalActual = 0, n = 0;
  const ouDetail = [];
  for (const t of tgOver) {
    let lnRaw = t.line;
    if (lnRaw == null) {
      const m = String(t.tip_participant||'').match(/[+-]?\d+\.?\d*/);
      lnRaw = m ? m[0] : 'NaN';
    }
    const ln = parseFloat(lnRaw);
    const fs = String(t.final_score || t.match_final_score || '');
    // Parse "6-4 7-5" → total games
    let actualGames = null;
    const m = fs.match(/(\d)-(\d)/g);
    if (m) {
      actualGames = m.reduce((s, x) => {
        const [a, b] = x.split('-').map(Number);
        return s + a + b;
      }, 0);
    }
    if (Number.isFinite(ln) && actualGames != null) {
      totalLines += ln;
      totalActual += actualGames;
      n++;
      ouDetail.push({ id: t.id, line: ln, actual: actualGames, diff: actualGames - ln, result: t.result, ev: t.ev, odd: t.odds||t.odd, fs });
    }
  }
  console.log(`  Avg line: ${(totalLines/n).toFixed(2)} | Avg actual games: ${(totalActual/n).toFixed(2)} | Mean diff (actual - line): ${((totalActual-totalLines)/n).toFixed(2)}`);
  console.log(`  Tips coberta over: ${ouDetail.filter(x => x.actual > x.line).length}/${n} (esperado >50% pra hit positivo)`);
  console.log('\n  Per-tip:');
  console.log('  ID    line  actual  diff   result  EV   score');
  for (const d of ouDetail.sort((a,b) => a.diff - b.diff)) {
    console.log(`  ${String(d.id).padEnd(5)} ${d.line.toString().padStart(5)} ${String(d.actual).padStart(6)}  ${(d.diff>=0?'+':'')+d.diff.toFixed(1).padStart(5)}  ${(d.result||'pend').padEnd(6)} ${String(d.ev).padStart(5)}  ${d.fs}`);
  }

  // 5) handicapGames home (the second leak)
  const hgHome = allRows.filter(t => {
    const m = (t.market_type || t.market || '').toLowerCase();
    const s = (t.side || '').toLowerCase();
    return (m === 'handicapgames' || m === 'handicap_games') && (s === 'home' || s === 'team1');
  });
  console.log(`\n=== handicapGames HOME detail (${hgHome.length} tips) ===`);
  console.log('  ID    line  pModel  EV   result  score');
  for (const t of hgHome) {
    const ln = t.line ?? '?';
    const pm = t.model_p_pick ?? '?';
    console.log(`  ${String(t.id).padEnd(5)} ${String(ln).padEnd(5)} ${String(pm).slice(0,6).padEnd(6)} ${String(t.ev||'-').padEnd(5)} ${(t.result||'pend').padEnd(6)} ${(t.final_score||t.match_final_score||'?')}`);
  }

  fs.writeFileSync('audit-atp-madrid-r3.json', JSON.stringify({ allRows, ouDetail }, null, 2));
  console.log(`\nGravado audit-atp-madrid-r3.json (${allRows.length} rows)`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

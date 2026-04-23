#!/usr/bin/env node
/**
 * settle-tennis-now.js — força liquidação de tips Tennis sem esperar o
 * ciclo de settleCompletedTips (10min) nem refresh do Sackmann CSV.
 *
 * Fluxo:
 *   1. Pre-sync match_results via ESPN scoreboard (live+recente)
 *   2. Pre-sync via ESPN range N dias (completa janela -7d default)
 *   3. Pre-sync via Sofascore N dias (cobre Challenger/WTA125/ITF fora do ESPN)
 *   4. Lê unsettled tips sport=tennis
 *   5. Pra cada tip, consulta /tennis-db-result (usa match_results já atualizado)
 *   6. Se resolved, POST /settle — dashboard passa a mostrar como liquidada
 *
 * Uso:
 *   node scripts/settle-tennis-now.js
 *   node scripts/settle-tennis-now.js --days=180 --espn-range=14 --sofa=7
 *   node scripts/settle-tennis-now.js --no-mt        # pula market tips shadow
 *
 * Bônus: também dispara /admin/settle-market-tips-shadow (cross-sport, idempotente).
 * Settla market tips de Tennis + LoL + Dota + CS + Football de uma vez, porque
 * settleShadowTips() não filtra por sport. Use --no-mt pra pular.
 *
 * Env:
 *   SERVER      (default 127.0.0.1)
 *   SERVER_PORT (default 3000)
 *   ADMIN_KEY   (necessário pra sync-tennis-espn-range + sync-tennis-sofascore + settle-market-tips-shadow)
 */
require('dotenv').config({ override: true });
const http = require('http');

const SERVER = process.env.SERVER || '127.0.0.1';
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '3000', 10) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function parseArgs() {
  const out = { days: 120, espnRange: 7, sofa: 3, dry: false, mt: true };
  for (const a of process.argv.slice(2)) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'days') out.days = parseInt(v, 10) || out.days;
    else if (k === 'espn-range') out.espnRange = parseInt(v, 10) || out.espnRange;
    else if (k === 'sofa') out.sofa = parseInt(v, 10) || out.sofa;
    else if (k === 'dry') out.dry = true;
    else if (k === 'no-mt') out.mt = false;
  }
  return out;
}

function req(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'settle-tennis-now' };
    const payload = body ? JSON.stringify(body) : null;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request({ hostname: SERVER, port: PORT, path, method, headers, timeout: 60000 }, (res) => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        try {
          const parsed = d ? JSON.parse(d) : {};
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body: { _raw: d, _parseErr: e.message } });
        }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error(`timeout ${method} ${path}`)));
    if (payload) r.write(payload);
    r.end();
  });
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`[${name}] ok (${Date.now() - t0}ms):`, typeof r === 'object' ? JSON.stringify(r).slice(0, 200) : r);
    return r;
  } catch (e) {
    console.log(`[${name}] fail (${Date.now() - t0}ms): ${e.message}`);
    return null;
  }
}

(async () => {
  const args = parseArgs();
  console.log(`settle-tennis-now: server=${SERVER}:${PORT} days=${args.days} espn-range=${args.espnRange} sofa=${args.sofa}${args.dry ? ' [DRY]' : ''}`);

  // 1-3. Pre-sync match_results (ESPN live + ESPN range + Sofascore)
  await step('sync-espn-live', () => req('GET', '/sync-tennis-espn-results?force=1').then(r => r.body));
  if (ADMIN_KEY) {
    await step('sync-espn-range', () => req('GET', `/sync-tennis-espn-range?days=${args.espnRange}&key=${encodeURIComponent(ADMIN_KEY)}`).then(r => r.body));
    await step('sync-sofascore', () => req('GET', `/sync-tennis-sofascore?days=${args.sofa}&key=${encodeURIComponent(ADMIN_KEY)}`).then(r => r.body));
  } else {
    console.log('[sync-espn-range] skipped — ADMIN_KEY não setada no .env');
    console.log('[sync-sofascore] skipped — ADMIN_KEY não setada no .env');
  }

  // 4. Lista unsettled
  const unsettledRes = await req('GET', `/unsettled-tips?sport=tennis&days=${args.days}`);
  const tips = Array.isArray(unsettledRes.body) ? unsettledRes.body : [];
  console.log(`\n[unsettled] ${tips.length} tip(s) tennis pending (janela ${args.days}d)`);
  if (!tips.length) {
    console.log('Nada pra liquidar. Saindo.');
    return;
  }

  // 5-6. Settle loop
  let settled = 0, pending = 0, failed = 0;
  for (const tip of tips) {
    if (!tip.match_id || !tip.participant1 || !tip.participant2) { pending++; continue; }
    const q = `p1=${encodeURIComponent(tip.participant1)}&p2=${encodeURIComponent(tip.participant2)}&sentAt=${encodeURIComponent(tip.sent_at || '')}&league=${encodeURIComponent(tip.event_name || '')}`;
    const lookup = await req('GET', `/tennis-db-result?${q}`).catch(() => ({ body: null }));
    const lb = lookup.body || {};
    if (!lb.resolved || !lb.winner) { pending++; continue; }

    if (args.dry) {
      console.log(`  [DRY] ${tip.participant1} vs ${tip.participant2} → ${lb.winner} (match_id=${tip.match_id} score=${lb.final_score || '?'})`);
      settled++;
      continue;
    }
    const settleRes = await req('POST', `/settle?sport=tennis`, { matchId: tip.match_id, winner: lb.winner });
    if (settleRes.status === 200 && !settleRes.body?.error) {
      console.log(`  [OK] ${tip.participant1} vs ${tip.participant2} → ${lb.winner} (${lb.final_score || '?'})`);
      settled++;
    } else {
      console.log(`  [FAIL] ${tip.participant1} vs ${tip.participant2}: ${settleRes.body?.error || settleRes.status}`);
      failed++;
    }
  }

  console.log(`\n[resumo-tips-regulares] settled=${settled} pending=${pending} failed=${failed} total=${tips.length}`);

  // 7. Market tips shadow — settla cross-sport (Tennis+LoL+Dota+CS+Football).
  // Endpoint é idempotente (mesma lógica do cron 30min). Requer ADMIN_KEY.
  if (args.mt && !args.dry) {
    if (!ADMIN_KEY) {
      console.log('\n[mt-shadow] skipped — ADMIN_KEY não setada');
    } else {
      const r = await req('GET', `/admin/settle-market-tips-shadow?key=${encodeURIComponent(ADMIN_KEY)}`);
      if (r.status === 200 && r.body?.ok) {
        console.log(`\n[mt-shadow] settled=${r.body.settled || 0} skipped=${r.body.skipped || 0} (cross-sport)`);
      } else {
        console.log(`\n[mt-shadow] fail: ${r.body?.error || r.status}`);
      }
    }
  } else if (args.mt && args.dry) {
    console.log('\n[mt-shadow] skipped — dry run');
  }

  process.exit(0);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});

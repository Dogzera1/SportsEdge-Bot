#!/usr/bin/env node
'use strict';

// Validação 24h post ATTACKs 2+3+5 (2026-05-27)
// Run: node scripts/validate-attacks-24h.js
// Mede se calib edits produziram efeito mensurável em shadow + real.

const https = require('https');
const KEY = process.env.ADMIN_KEY || '14725836';
const HOST = process.env.HOST || 'sportsedge-bot-production.up.railway.app';

const BASELINE_27MAY_PRE_ATTACKS = {
  tennis_real_7d_roi: -22.3,
  tennis_shadow_28d_roi: -4.25,
  tennis_tier_quali_HG_shadow_28d_roi: -8.3,
  tennis_tier_quali_HG_shadow_28d_n: 609,
  lol_total_under_shadow_28d_roi: 6.55,
  lol_total_under_pCalib_under_bin3: 0.6202,
};

function req(path) {
  return new Promise((res) => {
    const u = path + (path.includes('?') ? '&' : '?') + 'key=' + KEY;
    https.request({
      host: HOST, port: 443, path: u, method: 'GET',
      headers: { 'x-admin-key': KEY }, timeout: 30000, rejectUnauthorized: false,
    }, (resp) => {
      let b = '';
      resp.on('data', d => b += d);
      resp.on('end', () => { let j=null; try { j=JSON.parse(b);} catch(_){} res({ status: resp.statusCode, data: j }); });
    }).on('error', () => res({ status: 'ERR' })).on('timeout', () => res({ status: 'TIMEOUT' })).end();
  });
}

(async () => {
  console.log(`Validation run @ ${new Date().toISOString()}`);
  console.log(`Host: ${HOST}\n`);

  // 1. Real tennis ROI 7d
  const tenReal = await req('/shadow-readiness?source=real&sport=tennis&days=7');
  const ten7 = tenReal.data?.performance;
  console.log('=== Tennis REAL 7d (only sport in real) ===');
  if (ten7) {
    // 2026-05-28: API retorna profit_reais (BRL). Label R$ pra evitar confusion
    // com "u" quando banca cruza tier (uv ≠ R$1.00). ROI% é units-agnostic.
    console.log(`  n=${tenReal.data?.volume?.settled} ROI=${ten7.roi_pct}% profit=R$${ten7.profit_reais}`);
    console.log(`  Baseline 2026-05-27: ${BASELINE_27MAY_PRE_ATTACKS.tennis_real_7d_roi}%`);
    const delta = ten7.roi_pct - BASELINE_27MAY_PRE_ATTACKS.tennis_real_7d_roi;
    console.log(`  Delta: ${delta > 0 ? '+' : ''}${delta.toFixed(1)}pp ${delta > 5 ? '✅ IMPROVEMENT' : delta > 0 ? '↗ marginal' : '↘ no improvement yet'}`);
  }

  // 2. Tennis tier_quali_or_early HG shadow — ATTACK 3 target
  const tenShadow = await req('/admin/mt-shadow-by-league?sport=tennis&days=14&minN=5');
  const tqe = (tenShadow.data?.by_tier || []).find(t => t.tier === 'tier_quali_or_early' && t.market === 'handicapGames');
  console.log('\n=== Tennis tier_quali_or_early HG SHADOW 14d (ATTACK 3 target) ===');
  if (tqe) {
    // MT shadow endpoint retorna total_profit em units (profit_units)
    console.log(`  n=${tqe.n_settled} ROI=${tqe.roi_pct}% profit=${tqe.total_profit}u hit=${tqe.hit_rate}%`);
    console.log(`  Baseline d28 pre: -8.3% n=609 profit=-59.87u`);
    console.log(`  Expected post-ATTACK-3: tip emit drop in this tier (flat-cap pCalib=0.369 reduces EV)`);
    if (tqe.n_settled < 100) console.log(`  ✅ emit count dropped (n=${tqe.n_settled} 14d vs 609/28d ~305 expected pre-fix)`);
  } else {
    console.log(`  no data — possibly tip count dropped to zero (best case)`);
  }

  // 3. Tennis HG overall — sanity check no regression in other tiers
  const tenHG = (tenShadow.data?.by_tier || []).filter(t => t.market === 'handicapGames');
  console.log('\n=== Tennis HG SHADOW per tier (regression check) ===');
  for (const t of tenHG) {
    console.log(`  ${t.tier}: n=${t.n_settled} ROI=${t.roi_pct}% profit=${t.total_profit}u`);
  }

  // 4. LoL TOTAL UNDER shadow — ATTACK 2 + ATTACK 5 target
  const lolShadow = await req('/admin/mt-shadow-by-ev?sport=lol&days=14&minN=3');
  console.log('\n=== LoL TOTAL UNDER SHADOW 14d by EV (ATTACK 2+5 target) ===');
  const lolU = (lolShadow.data?.buckets || []).filter(b => b.market === 'total' && b.side === 'under');
  for (const b of lolU) {
    console.log(`  EV ${b.ev_bucket}: n=${b.n_total} hit=${b.hit_rate}% ROI=${b.roi_pct}% calib_gap=${b.calibration_gap_pp}pp avg_p=${b.avg_pmodel}`);
  }

  // 5. Tennis real by_market 7d
  const tenRealMkt = await req('/shadow-readiness?source=real&sport=tennis&groupBy=sport_market&days=7');
  console.log('\n=== Tennis REAL 7d by market ===');
  const tenMkts = tenRealMkt.data?.groups || [];
  for (const g of tenMkts) {
    // profit_units (units) prioritário; profit_reais (BRL) marca label R$ pra disambiguar
    const profitLabel = (g.profit_units != null)
      ? `${g.profit_units}u`
      : `R$${g.profit_reais}`;
    console.log(`  ${g.market_type}: n=${g.n_settled || g.n} ROI=${g.roi_pct}% profit=${profitLabel}`);
  }

  // 6. Bot health
  const p2 = await req('/admin/p2-status');
  console.log('\n=== Bot state ===');
  console.log(`  commit: ${p2.data?.version?.commit_short}`);
  console.log(`  p2 compliance: ${p2.data?.compliance_summary?.slice(0,60)}`);

  // 7. Goal check
  console.log('\n=== /goal [tornar bot com tips edge] CHECK ===');
  if (ten7?.roi_pct >= 5) {
    console.log(`  ✅ tennis 7d ROI >= +5% — EDGE detected (n=${tenReal.data?.volume?.settled})`);
    console.log(`  Continue monitoring for 14d sustain.`);
  } else if (ten7?.roi_pct >= 0) {
    console.log(`  ↗ tennis 7d ROI breakeven+ (${ten7.roi_pct}%) — recovering, edge not confirmed`);
  } else {
    console.log(`  ↘ tennis 7d ROI ${ten7?.roi_pct}% — still negative, attacks needs more time OR more attacks`);
  }
})();

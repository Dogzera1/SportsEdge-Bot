#!/usr/bin/env node
/**
 * probe-pinnacle-tennis.js — inspeciona markets raw de um matchup tennis
 * pra identificar como Pinnacle distingue games handicap vs sets handicap.
 *
 * Uso: node scripts/probe-pinnacle-tennis.js [matchupId]
 * Se sem arg, pega 1 tennis matchup live/upcoming.
 */
require('dotenv').config({ override: true });
const pinnacle = require('../lib/pinnacle');

const argv = process.argv.slice(2);
const MATCHUP_ID = argv[0] || null;

(async () => {
  let matchupId = MATCHUP_ID;
  let matchupInfo = null;

  if (!matchupId) {
    console.log('Buscando matchups tennis...');
    const matchups = await pinnacle.listSportMatchups(33);
    const first = matchups.filter(m => {
      const name = String(m?.league?.name || '').toLowerCase();
      if (!name.includes('atp') && !name.includes('wta') && !name.includes('challenger')) return false;
      const p1 = String(m?.participants?.[0]?.name || '');
      if (p1.includes('/')) return false; // doubles
      return true;
    })[0];
    if (!first) { console.log('Nenhum matchup tennis found'); process.exit(1); }
    matchupId = first.id;
    matchupInfo = first;
    console.log(`Pick: ${first.league?.name} — ${first.participants?.[0]?.name} vs ${first.participants?.[1]?.name} (ID: ${matchupId})`);
  }

  console.log(`\nFetching markets for matchup ${matchupId}...`);
  const markets = await pinnacle.getMatchupMarkets(matchupId);
  if (!Array.isArray(markets)) { console.log('No markets'); process.exit(1); }
  console.log(`Total markets returned: ${markets.length}\n`);

  // Group by (type, period)
  const groups = {};
  for (const m of markets) {
    const key = `${m.type}|period=${m.period}`;
    (groups[key] = groups[key] || []).push(m);
  }

  console.log('## Market types × periods:');
  for (const [k, list] of Object.entries(groups)) {
    console.log(`  ${k}: ${list.length} market(s)`);
  }

  // Filter: só spreads/handicaps period=0 (onde suspeitamos do bug)
  console.log('\n## Handicaps period=0 (detalhado):');
  const spreads = markets.filter(m => (m.type === 'spread' || m.type === 'handicap') && m.period === 0);
  for (const s of spreads) {
    console.log(`\n  type=${s.type} period=${s.period} status=${s.status}`);
    console.log(`  key: ${s.key || s.id || '?'}`);
    // Imprime todos os campos não triviais
    for (const [field, val] of Object.entries(s)) {
      if (['type', 'period', 'status', 'prices'].includes(field)) continue;
      const v = typeof val === 'object' ? JSON.stringify(val).slice(0, 100) : String(val).slice(0, 80);
      console.log(`    ${field}: ${v}`);
    }
    if (Array.isArray(s.prices)) {
      for (const p of s.prices) {
        console.log(`    price: desig=${p.designation} points=${p.points} price=${p.price}`);
      }
    }
  }

  console.log('\n## Totals period=0 (detalhado):');
  const totals = markets.filter(m => m.type === 'total' && m.period === 0);
  for (const t of totals.slice(0, 5)) {
    console.log(`\n  type=${t.type} period=${t.period} status=${t.status}`);
    for (const [field, val] of Object.entries(t)) {
      if (['type', 'period', 'status', 'prices'].includes(field)) continue;
      const v = typeof val === 'object' ? JSON.stringify(val).slice(0, 100) : String(val).slice(0, 80);
      console.log(`    ${field}: ${v}`);
    }
    if (Array.isArray(t.prices)) {
      for (const p of t.prices) {
        console.log(`    price: desig=${p.designation} points=${p.points} price=${p.price}`);
      }
    }
  }
  if (totals.length > 5) console.log(`\n  ... (+${totals.length - 5} outros totals period=0)`);

  // Moneyline
  console.log('\n## Moneyline period=0:');
  const ml = markets.find(m => m.type === 'moneyline' && m.period === 0);
  if (ml) {
    const home = ml.prices?.find(p => p.designation === 'home');
    const away = ml.prices?.find(p => p.designation === 'away');
    console.log(`  home: ${pinnacle.americanToDecimal(home?.price)} (american ${home?.price})`);
    console.log(`  away: ${pinnacle.americanToDecimal(away?.price)} (american ${away?.price})`);
  }

  console.log('\n## Procurando markets "sets"/"sets_handicap"/"special" em qualquer period:');
  const maybeSets = markets.filter(m => {
    const str = JSON.stringify(m).toLowerCase();
    return str.includes('sets') || str.includes('match handicap') || m.special;
  });
  for (const m of maybeSets.slice(0, 10)) {
    console.log(`  type=${m.type} period=${m.period} special=${JSON.stringify(m.special || null).slice(0, 80)} cat=${m.category || '?'}`);
  }
  if (!maybeSets.length) console.log('  (nenhum encontrado)');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });

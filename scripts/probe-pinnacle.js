#!/usr/bin/env node
/**
 * probe-pinnacle.js — inspeciona raw markets por esporte pra identificar
 * se Pinnacle cria virtual matchups que precisam de filtragem específica.
 *
 * Uso:
 *   node scripts/probe-pinnacle.js tennis    (sportId=33)
 *   node scripts/probe-pinnacle.js cs        (sportId=12 filter counter-strike)
 *   node scripts/probe-pinnacle.js lol       (sportId=12 filter league of legends)
 *   node scripts/probe-pinnacle.js dota      (sportId=12 filter dota 2)
 *   node scripts/probe-pinnacle.js valorant  (sportId=12 filter valorant)
 *   node scripts/probe-pinnacle.js mma       (sportId=22)
 *   node scripts/probe-pinnacle.js football  (sportId=29)
 */
require('dotenv').config({ override: true });
const pinnacle = require('../lib/pinnacle');

const SPORT_CONFIG = {
  tennis:  { sportId: 33, leagueMatch: /atp|wta|challenger/i, skipDoubles: true },
  cs:      { sportId: 12, leagueMatch: /counter-?strike|cs2|cs:go/i },
  lol:     { sportId: 12, leagueMatch: /league of legends|lol/i },
  dota:    { sportId: 12, leagueMatch: /dota/i },
  valorant:{ sportId: 12, leagueMatch: /valorant/i },
  mma:     { sportId: 22, leagueMatch: /ufc|mma/i },
  football:{ sportId: 29, leagueMatch: /./ },
};

const sport = (process.argv[2] || 'tennis').toLowerCase();
const cfg = SPORT_CONFIG[sport];
if (!cfg) { console.log(`Sport inválido. Use: ${Object.keys(SPORT_CONFIG).join(', ')}`); process.exit(1); }

(async () => {
  console.log(`Buscando matchups ${sport} (sportId=${cfg.sportId})...`);
  const matchups = await pinnacle.listSportMatchups(cfg.sportId);
  const candidates = matchups.filter(m => {
    const name = String(m?.league?.name || '').toLowerCase();
    if (!cfg.leagueMatch.test(name)) return false;
    const p1 = String(m?.participants?.[0]?.name || '');
    const p2 = String(m?.participants?.[1]?.name || '');
    if (cfg.skipDoubles && (p1.includes(' / ') || p2.includes(' / '))) return false;
    return true;
  });
  if (!candidates.length) { console.log(`Nenhum matchup ${sport} encontrado`); process.exit(0); }

  // Pega o PRIMEIRO (sem filtrar "(Sets)"/"(Games)") pra ver estrutura raw
  const first = candidates[0];
  console.log(`\nPick: ${first.league?.name} — ${first.participants?.[0]?.name} vs ${first.participants?.[1]?.name} (ID: ${first.id})`);

  const markets = await pinnacle.getMatchupMarkets(first.id);
  if (!Array.isArray(markets)) { console.log('No markets'); process.exit(1); }
  console.log(`Total markets retornados: ${markets.length}\n`);

  // Agrupa por matchupId interno — detecta virtualização
  const byMatchId = new Map();
  for (const m of markets) {
    const k = String(m.matchupId || first.id);
    if (!byMatchId.has(k)) byMatchId.set(k, []);
    byMatchId.get(k).push(m);
  }

  console.log(`## Virtual matchups detectados: ${byMatchId.size}`);
  if (byMatchId.size === 1) {
    console.log(`  ✅ Sem virtualização. MatchupId único: ${[...byMatchId.keys()][0]}`);
  } else {
    console.log(`  ⚠️ Múltiplos matchupIds — virtualização presente!`);
    for (const [mid, list] of byMatchId.entries()) {
      const spreads = list.filter(m => m.type === 'spread' && m.period === 0);
      const totals = list.filter(m => m.type === 'total' && m.period === 0);
      const spreadLines = [...new Set(spreads.map(m => m.prices?.find(p => p.designation === 'home')?.points))].filter(x => Number.isFinite(x));
      const totalLines = [...new Set(totals.map(m => m.prices?.find(p => p.designation === 'over')?.points))].filter(x => Number.isFinite(x));
      console.log(`  matchupId=${mid}: ${spreads.length} spreads period=0 lines=[${spreadLines.slice(0,10).join(',')}], ${totals.length} totals period=0 lines=[${totalLines.slice(0,10).join(',')}]`);
    }
  }

  // Tipo × period summary
  console.log('\n## Tipos de market × periods:');
  const typePeriodGroups = {};
  for (const m of markets) {
    const key = `${m.type}|period=${m.period}`;
    typePeriodGroups[key] = (typePeriodGroups[key] || 0) + 1;
  }
  for (const [k, c] of Object.entries(typePeriodGroups)) {
    console.log(`  ${k}: ${c}`);
  }

  // Heurística atual (lib/pinnacle.js): qual grupo o getMatchupHandicaps escolheria?
  console.log('\n## Heurística atual — escolheria virtual com mais lines distintas:');
  if (byMatchId.size > 1) {
    let bestMid = null, bestLines = 0;
    for (const [mid, list] of byMatchId.entries()) {
      const spreads = list.filter(m => m.type === 'spread' && m.period === 0);
      const uniq = new Set(spreads.map(m => m.prices?.find(p => p.designation === 'home')?.points).filter(Number.isFinite));
      if (uniq.size > bestLines) { bestLines = uniq.size; bestMid = mid; }
    }
    console.log(`  → chooser: matchupId=${bestMid} (${bestLines} lines)`);
    if (bestLines <= 2) console.log(`  🚩 AVISO: escolha com poucas lines pode estar errada. Revisar heurística.`);
  } else {
    console.log(`  → N/A (sem virtualização)`);
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });

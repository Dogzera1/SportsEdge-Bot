#!/usr/bin/env node
'use strict';
// scripts/dota-draft-probe.js — prova end-to-end dos libs de draft Dota (sem UI).
// Uso: node scripts/dota-draft-probe.js --blue "Anti-Mage,Pudge" --red "Juggernaut,Lion" --players "Nisha,Malr1ne"
require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');
const { resolveProPlayer, getPlayerHeroStats } = require('../lib/dota-player-heroes');
const { getMatchupEdge } = require('../lib/dota-hero-matchups');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : ''; };
const list = (s) => (s || '').split(',').map(x => x.trim()).filter(Boolean);

async function main() {
  const { db } = initDatabase(DB_PATH);
  const blue = list(arg('--blue')), red = list(arg('--red')), players = list(arg('--players'));

  console.log('=== matchup edge (blue vs red) ===');
  const edge = getMatchupEdge(db, blue, red);
  console.log(`blueAdvantagePp=${edge.blueAdvantagePp} sampled=${edge.sampled}`);
  for (const p of edge.pairs.slice(0, 6)) console.log(`  ${p.blue} vs ${p.red}: ${p.advPp >= 0 ? '+' : ''}${p.advPp}pp (n=${p.games})`);

  console.log('\n=== player×hero WR (on-demand) ===');
  for (const nick of players) {
    const pro = resolveProPlayer(db, nick);
    if (!pro) { console.log(`  ${nick}: (não encontrado em dota_pro_players)`); continue; }
    const hs = await getPlayerHeroStats(db, pro.account_id);
    const top = hs.slice(0, 3).map(h => `hero ${h.hero_id} ${(h.wr * 100).toFixed(0)}% (n=${h.games})`).join(', ');
    console.log(`  ${nick} -> ${pro.name} [${pro.team_name || '?'}] acct=${pro.account_id}: ${top || '(sem dados)'}`);
  }
  db.close();
}
main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

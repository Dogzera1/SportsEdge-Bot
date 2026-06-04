#!/usr/bin/env node
'use strict';
// scripts/sync-opendota-hero-matchups.js
// Pra cada herói em dota_hero_stats, puxa /heroes/{id}/matchups (counters) e grava em dota_hero_matchups.
// Uso: node scripts/sync-opendota-hero-matchups.js [--limit N] [--delay 1100]
require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const API_KEY = process.env.OPENDOTA_API_KEY || '';
const argv = process.argv.slice(2);
const LIMIT = (() => { const i = argv.indexOf('--limit'); return i >= 0 ? parseInt(argv[i + 1], 10) : Infinity; })();
const DELAY = (() => { const i = argv.indexOf('--delay'); return i >= 0 ? parseInt(argv[i + 1], 10) : 1100; })();

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SportsEdge/1.0' }, timeout: 30000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const { db } = initDatabase(DB_PATH);
  const heroes = db.prepare('SELECT hero_id FROM dota_hero_stats ORDER BY hero_id').all().map(r => r.hero_id).slice(0, LIMIT);
  console.log(`[opendota-matchups] ${heroes.length} heroes, delay ${DELAY}ms`);
  const upsert = db.prepare(`INSERT INTO dota_hero_matchups (hero_id, vs_hero_id, games, wins, wr, updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(hero_id,vs_hero_id) DO UPDATE SET games=excluded.games, wins=excluded.wins, wr=excluded.wr, updated_at=datetime('now')`);
  let ok = 0, fail = 0, pairs = 0;
  for (const hid of heroes) {
    try {
      const rows = await getJson(`https://api.opendota.com/api/heroes/${hid}/matchups${API_KEY ? '?api_key=' + API_KEY : ''}`);
      if (Array.isArray(rows)) {
        const tx = db.transaction(() => {
          for (const r of rows) {
            const games = r.games_played || 0, wins = r.wins || 0;
            if (!r.hero_id || !games) continue;
            upsert.run(hid, r.hero_id, games, wins, wins / games);
            pairs++;
          }
        });
        tx();
        ok++;
      } else fail++;
    } catch (e) { fail++; }
    await sleep(DELAY);
  }
  console.log(`[opendota-matchups] heroes ok=${ok} fail=${fail}; pairs upserted=${pairs}; total ${db.prepare('SELECT COUNT(*) c FROM dota_hero_matchups').get().c}`);
}
main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

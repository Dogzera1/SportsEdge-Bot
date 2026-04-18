#!/usr/bin/env node
'use strict';

// scripts/sync-opendota-heroes.js
//
// Puxa heroStats + heroes do OpenDota e grava em dota_hero_stats.
// Equivalente ao champion_stats do LoL pra Dota2.
//
// Campos: hero_id, localized_name (nome), primary_attr, roles,
//   pub_pick, pub_win, pro_pick, pro_win, pro_ban (últimos ~6 meses)

require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const API_KEY = process.env.OPENDOTA_API_KEY || '';

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SportsEdge/1.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const { db } = initDatabase(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS dota_hero_stats (
      hero_id INTEGER PRIMARY KEY,
      localized_name TEXT,
      primary_attr TEXT,
      roles TEXT,
      pub_pick INTEGER, pub_win INTEGER,
      pub_winrate REAL,
      pro_pick INTEGER, pro_win INTEGER, pro_ban INTEGER,
      pro_winrate REAL,
      pro_pickban_rate REAL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dota_hero_name ON dota_hero_stats(localized_name);
  `);

  const url = `https://api.opendota.com/api/heroStats${API_KEY ? '?api_key=' + API_KEY : ''}`;
  console.log(`[opendota-heroes] fetching ${url}`);
  const rows = await getJson(url);
  if (!Array.isArray(rows)) { console.error('not an array'); process.exit(1); }
  console.log(`[opendota-heroes] ${rows.length} heroes`);

  const upsert = db.prepare(`
    INSERT INTO dota_hero_stats (hero_id, localized_name, primary_attr, roles,
      pub_pick, pub_win, pub_winrate, pro_pick, pro_win, pro_ban, pro_winrate, pro_pickban_rate, updated_at)
    VALUES (@hero_id, @localized_name, @primary_attr, @roles, @pub_pick, @pub_win, @pub_winrate,
      @pro_pick, @pro_win, @pro_ban, @pro_winrate, @pro_pickban_rate, datetime('now'))
    ON CONFLICT(hero_id) DO UPDATE SET
      localized_name=excluded.localized_name, primary_attr=excluded.primary_attr, roles=excluded.roles,
      pub_pick=excluded.pub_pick, pub_win=excluded.pub_win, pub_winrate=excluded.pub_winrate,
      pro_pick=excluded.pro_pick, pro_win=excluded.pro_win, pro_ban=excluded.pro_ban,
      pro_winrate=excluded.pro_winrate, pro_pickban_rate=excluded.pro_pickban_rate,
      updated_at=datetime('now')
  `);

  // Consolida pub picks/wins de todos os tiers (1-8)
  let total = 0;
  const tx = db.transaction(() => {
    for (const h of rows) {
      let pubPick = 0, pubWin = 0;
      for (let tier = 1; tier <= 8; tier++) {
        pubPick += (h[`${tier}_pick`] || 0);
        pubWin += (h[`${tier}_win`] || 0);
      }
      const pubWr = pubPick ? pubWin / pubPick : null;
      const proPick = h.pro_pick || 0, proWin = h.pro_win || 0, proBan = h.pro_ban || 0;
      const proWr = proPick ? proWin / proPick : null;
      // pickban rate: assume últimos ~7 dias ~1000 pro matches como proxy
      const proPbRate = proPick + proBan > 0 ? (proPick + proBan) / 1000 : null;

      upsert.run({
        hero_id: h.id,
        localized_name: h.localized_name,
        primary_attr: h.primary_attr,
        roles: Array.isArray(h.roles) ? h.roles.join(',') : '',
        pub_pick: pubPick, pub_win: pubWin, pub_winrate: pubWr,
        pro_pick: proPick, pro_win: proWin, pro_ban: proBan,
        pro_winrate: proWr, pro_pickban_rate: proPbRate,
      });
      total++;
    }
  });
  tx();

  console.log(`[opendota-heroes] upserted: ${total}`);
  console.log(`[opendota-heroes] dota_hero_stats total: ${db.prepare('SELECT COUNT(*) as n FROM dota_hero_stats').get().n}`);
  // Top heroes por pro winrate
  const top = db.prepare(`SELECT localized_name, pro_pick, pro_winrate FROM dota_hero_stats WHERE pro_pick >= 20 ORDER BY pro_winrate DESC LIMIT 5`).all();
  console.log(`[opendota-heroes] top 5 pro WR (>=20 picks):`);
  for (const t of top) console.log(`  ${t.localized_name}: ${(t.pro_winrate * 100).toFixed(1)}% (n=${t.pro_pick})`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

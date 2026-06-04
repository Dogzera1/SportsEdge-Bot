#!/usr/bin/env node
'use strict';
// scripts/sync-opendota-pro-players.js
// Puxa /proPlayers do OpenDota e grava o mapa nick->account_id em dota_pro_players.
require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');
const { normalizeProNick } = require('../lib/dota-player-heroes');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const API_KEY = process.env.OPENDOTA_API_KEY || '';

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SportsEdge/1.0' }, timeout: 30000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  const { db } = initDatabase(DB_PATH);
  const url = `https://api.opendota.com/api/proPlayers${API_KEY ? '?api_key=' + API_KEY : ''}`;
  console.log(`[opendota-pros] fetching ${url}`);
  const rows = await getJson(url);
  if (!Array.isArray(rows)) { console.error('not an array'); process.exit(1); }
  console.log(`[opendota-pros] ${rows.length} pro players`);

  const upsert = db.prepare(`INSERT INTO dota_pro_players (account_id, name, name_norm, team_name, updated_at)
    VALUES (@account_id, @name, @name_norm, @team_name, datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET name=excluded.name, name_norm=excluded.name_norm, team_name=excluded.team_name, updated_at=datetime('now')`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const p of rows) {
      if (!p.account_id) continue;
      const name = p.name || p.personaname || '';
      upsert.run({ account_id: p.account_id, name, name_norm: normalizeProNick(name), team_name: p.team_name || null });
      n++;
    }
  });
  tx();
  console.log(`[opendota-pros] upserted ${n}; total ${db.prepare('SELECT COUNT(*) c FROM dota_pro_players').get().c}`);
}
main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

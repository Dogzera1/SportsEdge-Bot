'use strict';

// Sincroniza estatísticas agregadas por role a partir do CSV do repo:
// https://github.com/PandaTobi/League-of-Legends-ESports-Data
//
// Fonte (raw):
// https://raw.githubusercontent.com/PandaTobi/League-of-Legends-ESports-Data/master/Role%20Impact/league_pro_play_data.csv
//
// Uso:
//   node scripts/sync-golgg-role-impact.js
//   set DB_PATH=C:\caminho\sportsedge.db && node scripts/sync-golgg-role-impact.js

const https = require('https');
const initDatabase = require('../lib/database');

const CSV_URL = 'https://raw.githubusercontent.com/PandaTobi/League-of-Legends-ESports-Data/master/Role%20Impact/league_pro_play_data.csv';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SportsEdgeBot/1.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

function percentToFloat(p) {
  const s = String(p || '').trim();
  if (!s) return null;
  const n = parseFloat(s.replace('%', ''));
  return Number.isFinite(n) ? (n / 100) : null;
}

function num(v) {
  const n = parseFloat(String(v || '').trim());
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const { status, body } = await fetchText(CSV_URL);
  if (status !== 200) throw new Error(`HTTP ${status}`);

  // CSV linhas: player,ROLE,games,winrate,kda,kills,deaths,assists,csm,gpm,dmg
  // Há linhas vazias (",,,,,") entre registros.
  const rows = body.split('\n').map(l => l.trim()).filter(Boolean);

  const roleGames = {};
  const agg = {
    winrate: {},
    gpm: {},
    dmg: {},
    kda: {},
  };

  function add(role, games, stat, bucket) {
    if (!bucket[role]) bucket[role] = 0;
    bucket[role] += games * stat;
  }

  for (const line of rows) {
    const parts = line.split(',');
    if (parts.length < 11) continue;
    const role = String(parts[1] || '').trim().toUpperCase();
    const games = num(parts[2]);
    const winr = percentToFloat(parts[3]);
    const kda = num(parts[4]);
    const gpm = num(parts[9]);
    const dmg = num(parts[10]);
    if (!role || !games || !gpm) continue;

    roleGames[role] = (roleGames[role] || 0) + games;
    if (winr != null) add(role, games, winr, agg.winrate);
    if (gpm != null) add(role, games, gpm, agg.gpm);
    if (dmg != null) add(role, games, dmg, agg.dmg);
    if (kda != null) add(role, games, kda, agg.kda);
  }

  const dbPath = process.env.DB_PATH || 'sportsedge.db';
  const { db } = initDatabase(dbPath);

  const upsert = db.prepare(`
    INSERT INTO golgg_role_impact (role, sample_games, winrate, gpm, dmg_pct, kda, source, updated_at)
    VALUES (@role, @sample_games, @winrate, @gpm, @dmg_pct, @kda, 'gol.gg', datetime('now'))
    ON CONFLICT(role) DO UPDATE SET
      sample_games=excluded.sample_games,
      winrate=excluded.winrate,
      gpm=excluded.gpm,
      dmg_pct=excluded.dmg_pct,
      kda=excluded.kda,
      source=excluded.source,
      updated_at=excluded.updated_at
  `);

  let written = 0;
  for (const [role, games] of Object.entries(roleGames)) {
    const g = games || 0;
    if (g <= 0) continue;
    const row = {
      role,
      sample_games: g,
      winrate: agg.winrate[role] != null ? (agg.winrate[role] / g) : null,
      gpm: agg.gpm[role] != null ? (agg.gpm[role] / g) : null,
      dmg_pct: agg.dmg[role] != null ? (agg.dmg[role] / g) : null,
      kda: agg.kda[role] != null ? (agg.kda[role] / g) : null,
    };
    upsert.run(row);
    written++;
  }

  console.log(`OK roles=${written}`);
}

main().catch(e => {
  console.error('ERR', e.message);
  process.exit(1);
});


#!/usr/bin/env node
'use strict';

// scripts/sync-golgg-team-stats.js
//
// Sincroniza aggregate stats por time do gol.gg (teams/list/season-SXX/split-YYY/)
// para a tabela team_stats no sqlite. Features a adicionar ao modelo LoL:
// GPM, GDM, FB%, FT%, GD@15, DRA%, NASH%, DPM, K:D, etc.
//
// Uso:
//   node scripts/sync-golgg-team-stats.js                                  # default S13-S16 ALL+Spring+Summer
//   node scripts/sync-golgg-team-stats.js --seasons S14,S15 --splits ALL

require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const argv = process.argv.slice(2);
function argVal(n, d) {
  const i = argv.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const SEASONS = (argVal('seasons', 'S13,S14,S15,S16')).split(',').map(s => s.trim()).filter(Boolean);
const SPLITS = (argVal('splits', 'ALL,Spring,Summer,Winter')).split(',').map(s => s.trim()).filter(Boolean);
const DELAY_MS = parseInt(argVal('delay', '400'), 10);

const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': HTTP_UA, 'Accept': 'text/html' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parsePct(s) {
  const n = parseFloat(String(s || '').replace('%', '').replace(',', '.').trim());
  return Number.isFinite(n) ? n / 100 : null;
}
function parseNum(s) {
  const n = parseFloat(String(s || '').replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}
function parseDurationSec(s) {
  const m = String(s || '').match(/(\d+):(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Schema do team_stats (32 cols no gol.gg, ordem fixa):
// [0]Name [1]Season [2]Region [3]Games [4]Win_rate [5]K:D [6]GPM [7]GDM
// [8]Game_duration [9]FP% [10]Blue% [11]Kills/game [12]Deaths/game
// [13]Towers_killed [14]Towers_lost [15]FB% [16]FT% [17]DRAPG [18]DRA%
// [19]VGPG [20]HER% [21]DRA@15 [22]TD@15 [23]GD@15 [24]PPG [25]NASHPG
// [26]NASH% [27]CSM [28]DPM [29]WPM [30]VWPM [31]WCPM

function parseTeamRow(cells) {
  return {
    team: cells[0],
    season: cells[1],
    region: cells[2],
    games: parseNum(cells[3]),
    winrate: parsePct(cells[4]),
    kd_ratio: parseNum(cells[5]),
    gpm: parseNum(cells[6]),
    gdm: parseNum(cells[7]),
    game_duration_sec: parseDurationSec(cells[8]),
    fp_pct: parsePct(cells[9]),
    blue_pct: parsePct(cells[10]),
    kills_pg: parseNum(cells[11]),
    deaths_pg: parseNum(cells[12]),
    towers_killed_pg: parseNum(cells[13]),
    towers_lost_pg: parseNum(cells[14]),
    fb_pct: parsePct(cells[15]),
    ft_pct: parsePct(cells[16]),
    dra_per_game: parseNum(cells[17]),
    dra_pct: parsePct(cells[18]),
    vg_per_game: parseNum(cells[19]),
    her_pct: parsePct(cells[20]),
    dra_at_15: parseNum(cells[21]),
    td_at_15: parseNum(cells[22]),
    gd_at_15: parseNum(cells[23]),
    ppg: parseNum(cells[24]),
    nash_per_game: parseNum(cells[25]),
    nash_pct: parsePct(cells[26]),
    csm: parseNum(cells[27]),
    dpm: parseNum(cells[28]),
    wpm: parseNum(cells[29]),
    vwpm: parseNum(cells[30]),
    wcpm: parseNum(cells[31]),
  };
}

async function fetchTeamsForSeasonSplit(season, split) {
  const url = `https://gol.gg/teams/list/season-${season}/split-${split}/tournament-ALL/`;
  const r = await get(url);
  if (r.status !== 200) return [];
  const allTbls = [...r.body.matchAll(/<table[\s\S]*?<\/table>/g)];
  if (!allTbls.length) return [];
  // A última table (playerslist) é a de stats
  const tbl = allTbls[allTbls.length - 1][0];
  const rows = [...tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = [...rows[i][1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map(c => c[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length < 30) continue;
    const row = parseTeamRow(cells);
    if (!row.team || !row.games) continue;
    out.push(row);
  }
  return out;
}

async function main() {
  const { db } = initDatabase(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS team_stats (
      team TEXT NOT NULL,
      season TEXT NOT NULL,
      split TEXT NOT NULL DEFAULT 'ALL',
      region TEXT,
      games INTEGER,
      winrate REAL, kd_ratio REAL, gpm REAL, gdm REAL,
      game_duration_sec INTEGER,
      fp_pct REAL, blue_pct REAL,
      kills_pg REAL, deaths_pg REAL,
      towers_killed_pg REAL, towers_lost_pg REAL,
      fb_pct REAL, ft_pct REAL,
      dra_per_game REAL, dra_pct REAL,
      vg_per_game REAL, her_pct REAL,
      dra_at_15 REAL, td_at_15 REAL, gd_at_15 REAL,
      ppg REAL, nash_per_game REAL, nash_pct REAL,
      csm REAL, dpm REAL, wpm REAL, vwpm REAL, wcpm REAL,
      updated_at TEXT,
      PRIMARY KEY (team, season, split)
    );
    CREATE INDEX IF NOT EXISTS idx_team_stats_team ON team_stats(team);
  `);

  const upsert = db.prepare(`
    INSERT INTO team_stats (team, season, split, region, games, winrate, kd_ratio, gpm, gdm,
      game_duration_sec, fp_pct, blue_pct, kills_pg, deaths_pg, towers_killed_pg, towers_lost_pg,
      fb_pct, ft_pct, dra_per_game, dra_pct, vg_per_game, her_pct, dra_at_15, td_at_15, gd_at_15,
      ppg, nash_per_game, nash_pct, csm, dpm, wpm, vwpm, wcpm, updated_at)
    VALUES (@team,@season,@split,@region,@games,@winrate,@kd_ratio,@gpm,@gdm,
      @game_duration_sec,@fp_pct,@blue_pct,@kills_pg,@deaths_pg,@towers_killed_pg,@towers_lost_pg,
      @fb_pct,@ft_pct,@dra_per_game,@dra_pct,@vg_per_game,@her_pct,@dra_at_15,@td_at_15,@gd_at_15,
      @ppg,@nash_per_game,@nash_pct,@csm,@dpm,@wpm,@vwpm,@wcpm,datetime('now'))
    ON CONFLICT(team, season, split) DO UPDATE SET
      region=excluded.region, games=excluded.games, winrate=excluded.winrate, kd_ratio=excluded.kd_ratio,
      gpm=excluded.gpm, gdm=excluded.gdm, game_duration_sec=excluded.game_duration_sec,
      fp_pct=excluded.fp_pct, blue_pct=excluded.blue_pct, kills_pg=excluded.kills_pg,
      deaths_pg=excluded.deaths_pg, towers_killed_pg=excluded.towers_killed_pg, towers_lost_pg=excluded.towers_lost_pg,
      fb_pct=excluded.fb_pct, ft_pct=excluded.ft_pct, dra_per_game=excluded.dra_per_game, dra_pct=excluded.dra_pct,
      vg_per_game=excluded.vg_per_game, her_pct=excluded.her_pct, dra_at_15=excluded.dra_at_15,
      td_at_15=excluded.td_at_15, gd_at_15=excluded.gd_at_15, ppg=excluded.ppg,
      nash_per_game=excluded.nash_per_game, nash_pct=excluded.nash_pct, csm=excluded.csm, dpm=excluded.dpm,
      wpm=excluded.wpm, vwpm=excluded.vwpm, wcpm=excluded.wcpm, updated_at=datetime('now')
  `);

  let totalUpserts = 0, okPages = 0, emptyPages = 0;

  await get('https://gol.gg/').catch(() => null);
  await sleep(200);

  for (const season of SEASONS) {
    for (const split of SPLITS) {
      try {
        const teams = await fetchTeamsForSeasonSplit(season, split);
        if (!teams.length) { emptyPages++; console.log(`  ${season}/${split}: 0 teams`); await sleep(DELAY_MS); continue; }
        // injeta split (parser não traz)
        for (const r of teams) { r.split = split; r.region = r.region || null; }
        const tx = db.transaction((rows) => { for (const r of rows) upsert.run(r); });
        tx(teams);
        totalUpserts += teams.length;
        okPages++;
        console.log(`  ${season}/${split}: +${teams.length} teams upserted`);
      } catch (e) {
        console.log(`  ${season}/${split}: ERR ${e.message}`);
      }
      await sleep(DELAY_MS);
    }
  }

  const count = db.prepare(`SELECT COUNT(*) as n FROM team_stats`).get().n;
  console.log(`\n[sync-golgg-team-stats] ok=${okPages} empty=${emptyPages} upserts=${totalUpserts} | total rows em team_stats: ${count}`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

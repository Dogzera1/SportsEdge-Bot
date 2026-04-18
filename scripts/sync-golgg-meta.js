#!/usr/bin/env node
'use strict';

// scripts/sync-golgg-meta.js
//
// Sincroniza do gol.gg:
//   - champion_stats  (champion aggregates por season/split): meta WR, PR%, BP%, GD@15
//   - player_stats    (player aggregates por season/split): WR, KDA, GD@15, DPM
//
// Uso:
//   node scripts/sync-golgg-meta.js [--seasons S13,S14,S15,S16] [--splits ALL,Spring,Summer,Winter]
//
// Tabelas:
//   champion_stats(champion, season, split, picks, bans, prioscore, wins, losses,
//                  winrate, kda, avg_bt, avg_rp, bp_pct, gt, csm, dpm, gpm,
//                  csd15, gd15, xpd15, updated_at)  PK (champion, season, split)
//   player_stats  (player, season, split, country, games, winrate, kda, avg_kills,
//                  avg_deaths, avg_assists, csm, gpm, kp_pct, dmg_pct, gold_pct,
//                  vs_pct, dpm, vspm, wpm, wcpm, vwpm, gd15, csd15, xpd15, fb_pct,
//                  fb_victim_pct, penta, solo_kills, updated_at)  PK (player, season, split)

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

const SEASONS = argVal('seasons', 'S13,S14,S15,S16').split(',').map(s => s.trim()).filter(Boolean);
const SPLITS = argVal('splits', 'ALL,Spring,Summer,Winter').split(',').map(s => s.trim()).filter(Boolean);
const DELAY_MS = parseInt(argVal('delay', '400'), 10);

const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': HTTP_UA, 'Accept': 'text/html' } }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res({ status: r.statusCode, body: d }));
    }).on('error', rej);
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parsePct(s) { const n = parseFloat(String(s || '').replace('%', '').replace(',', '.').trim()); return Number.isFinite(n) ? n / 100 : null; }
function parseNum(s) { const n = parseFloat(String(s || '').replace(',', '.').trim()); return Number.isFinite(n) ? n : null; }

async function fetchTableRows(url) {
  const r = await get(url);
  if (r.status !== 200) return [];
  const tbls = [...r.body.matchAll(/<table[\s\S]*?<\/table>/g)];
  if (!tbls.length) return [];
  const tbl = tbls[tbls.length - 1][0];
  const rows = [...tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = [...rows[i][1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map(c => c[1].replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').trim());
    if (cells.length < 5) continue;
    out.push(cells);
  }
  return out;
}

async function syncChampions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS champion_stats (
      champion TEXT NOT NULL, season TEXT NOT NULL, split TEXT NOT NULL DEFAULT 'ALL',
      picks INTEGER, bans INTEGER, prio_score REAL,
      wins INTEGER, losses INTEGER, winrate REAL, kda REAL,
      avg_bt REAL, avg_rp REAL, bp_pct REAL, gt REAL,
      csm REAL, dpm REAL, gpm REAL,
      csd15 REAL, gd15 REAL, xpd15 REAL,
      updated_at TEXT,
      PRIMARY KEY (champion, season, split)
    );
    CREATE INDEX IF NOT EXISTS idx_champion_stats_champ ON champion_stats(champion);
  `);
  const upsert = db.prepare(`
    INSERT INTO champion_stats (champion,season,split,picks,bans,prio_score,wins,losses,winrate,kda,
      avg_bt,avg_rp,bp_pct,gt,csm,dpm,gpm,csd15,gd15,xpd15,updated_at)
    VALUES (@champion,@season,@split,@picks,@bans,@prio_score,@wins,@losses,@winrate,@kda,
      @avg_bt,@avg_rp,@bp_pct,@gt,@csm,@dpm,@gpm,@csd15,@gd15,@xpd15,datetime('now'))
    ON CONFLICT(champion,season,split) DO UPDATE SET
      picks=excluded.picks, bans=excluded.bans, prio_score=excluded.prio_score,
      wins=excluded.wins, losses=excluded.losses, winrate=excluded.winrate, kda=excluded.kda,
      avg_bt=excluded.avg_bt, avg_rp=excluded.avg_rp, bp_pct=excluded.bp_pct, gt=excluded.gt,
      csm=excluded.csm, dpm=excluded.dpm, gpm=excluded.gpm,
      csd15=excluded.csd15, gd15=excluded.gd15, xpd15=excluded.xpd15, updated_at=datetime('now')
  `);
  let total = 0;
  for (const s of SEASONS) {
    for (const sp of SPLITS) {
      const url = `https://gol.gg/champion/list/season-${s}/split-${sp}/tournament-ALL/`;
      try {
        const rows = await fetchTableRows(url);
        if (!rows.length) { console.log(`  champions ${s}/${sp}: 0`); await sleep(DELAY_MS); continue; }
        // Header: Champion Picks Bans PrioScore Wins Losses Winrate KDA AvgBT AvgRP BP% GT CSM DPM GPM CSD@15 GD@15 XPD@15
        const tx = db.transaction((arr) => {
          for (const cells of arr) {
            if (cells.length < 18) continue;
            upsert.run({
              champion: cells[0], season: s, split: sp,
              picks: parseInt(cells[1], 10) || 0,
              bans: parseInt(cells[2], 10) || 0,
              prio_score: parsePct(cells[3]),
              wins: parseInt(cells[4], 10) || 0,
              losses: parseInt(cells[5], 10) || 0,
              winrate: parsePct(cells[6]),
              kda: parseNum(cells[7]),
              avg_bt: parseNum(cells[8]), avg_rp: parseNum(cells[9]),
              bp_pct: parsePct(cells[10]), gt: parseNum(cells[11]),
              csm: parseNum(cells[12]), dpm: parseNum(cells[13]), gpm: parseNum(cells[14]),
              csd15: parseNum(cells[15]), gd15: parseNum(cells[16]), xpd15: parseNum(cells[17]),
            });
          }
        });
        tx(rows);
        total += rows.length;
        console.log(`  champions ${s}/${sp}: +${rows.length}`);
      } catch (e) { console.log(`  champions ${s}/${sp}: ERR ${e.message}`); }
      await sleep(DELAY_MS);
    }
  }
  return total;
}

async function syncPlayers(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS player_stats (
      player TEXT NOT NULL, season TEXT NOT NULL, split TEXT NOT NULL DEFAULT 'ALL',
      country TEXT, games INTEGER, winrate REAL, kda REAL,
      avg_kills REAL, avg_deaths REAL, avg_assists REAL,
      csm REAL, gpm REAL, kp_pct REAL, dmg_pct REAL, gold_pct REAL, vs_pct REAL,
      dpm REAL, vspm REAL, wpm REAL, wcpm REAL, vwpm REAL,
      gd15 REAL, csd15 REAL, xpd15 REAL, fb_pct REAL, fb_victim_pct REAL,
      penta INTEGER, solo_kills INTEGER,
      updated_at TEXT,
      PRIMARY KEY (player, season, split)
    );
    CREATE INDEX IF NOT EXISTS idx_player_stats_player ON player_stats(player);
  `);
  const upsert = db.prepare(`
    INSERT INTO player_stats (player,season,split,country,games,winrate,kda,avg_kills,avg_deaths,avg_assists,
      csm,gpm,kp_pct,dmg_pct,gold_pct,vs_pct,dpm,vspm,wpm,wcpm,vwpm,gd15,csd15,xpd15,fb_pct,fb_victim_pct,
      penta,solo_kills,updated_at)
    VALUES (@player,@season,@split,@country,@games,@winrate,@kda,@avg_kills,@avg_deaths,@avg_assists,
      @csm,@gpm,@kp_pct,@dmg_pct,@gold_pct,@vs_pct,@dpm,@vspm,@wpm,@wcpm,@vwpm,@gd15,@csd15,@xpd15,
      @fb_pct,@fb_victim_pct,@penta,@solo_kills,datetime('now'))
    ON CONFLICT(player,season,split) DO UPDATE SET
      country=excluded.country, games=excluded.games, winrate=excluded.winrate, kda=excluded.kda,
      avg_kills=excluded.avg_kills, avg_deaths=excluded.avg_deaths, avg_assists=excluded.avg_assists,
      csm=excluded.csm, gpm=excluded.gpm, kp_pct=excluded.kp_pct, dmg_pct=excluded.dmg_pct,
      gold_pct=excluded.gold_pct, vs_pct=excluded.vs_pct, dpm=excluded.dpm, vspm=excluded.vspm,
      wpm=excluded.wpm, wcpm=excluded.wcpm, vwpm=excluded.vwpm,
      gd15=excluded.gd15, csd15=excluded.csd15, xpd15=excluded.xpd15,
      fb_pct=excluded.fb_pct, fb_victim_pct=excluded.fb_victim_pct,
      penta=excluded.penta, solo_kills=excluded.solo_kills, updated_at=datetime('now')
  `);
  let total = 0;
  for (const s of SEASONS) {
    for (const sp of SPLITS) {
      const url = `https://gol.gg/players/list/season-${s}/split-${sp}/tournament-ALL/`;
      try {
        const rows = await fetchTableRows(url);
        if (!rows.length) { console.log(`  players ${s}/${sp}: 0`); await sleep(DELAY_MS); continue; }
        // Header: Player Country Games Win rate KDA AvgKills AvgDeaths AvgAssists CSM GPM KP% DMG% Gold% VS% DPM VSPM AvgWPM AvgWCPM AvgVWPM GD@15 CSD@15 XPD@15 FB% FBVictim Penta SoloKills
        const tx = db.transaction((arr) => {
          for (const cells of arr) {
            if (cells.length < 26) continue;
            upsert.run({
              player: cells[0], season: s, split: sp,
              country: cells[1], games: parseInt(cells[2], 10) || 0,
              winrate: parsePct(cells[3]), kda: parseNum(cells[4]),
              avg_kills: parseNum(cells[5]), avg_deaths: parseNum(cells[6]), avg_assists: parseNum(cells[7]),
              csm: parseNum(cells[8]), gpm: parseNum(cells[9]),
              kp_pct: parsePct(cells[10]), dmg_pct: parsePct(cells[11]),
              gold_pct: parsePct(cells[12]), vs_pct: parsePct(cells[13]),
              dpm: parseNum(cells[14]), vspm: parseNum(cells[15]),
              wpm: parseNum(cells[16]), wcpm: parseNum(cells[17]), vwpm: parseNum(cells[18]),
              gd15: parseNum(cells[19]), csd15: parseNum(cells[20]), xpd15: parseNum(cells[21]),
              fb_pct: parsePct(cells[22]), fb_victim_pct: parsePct(cells[23]),
              penta: parseInt(cells[24], 10) || 0, solo_kills: parseInt(cells[25], 10) || 0,
            });
          }
        });
        tx(rows);
        total += rows.length;
        console.log(`  players ${s}/${sp}: +${rows.length}`);
      } catch (e) { console.log(`  players ${s}/${sp}: ERR ${e.message}`); }
      await sleep(DELAY_MS);
    }
  }
  return total;
}

// ── Bridge: popula pro_champ_stats a partir de champion_stats ────────────
// Existing bot.js usa pro_champ_stats(champion,role) via endpoint /champ-winrates.
// Pegamos a season/split MAIS RECENTE por champion como fonte (representa meta atual).
function normChampionName(s) {
  return String(s || '').replace(/['\s\.]/g, '').replace(/&/g, '');
}

function bridgeChampStats(db) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS pro_champ_stats (
      champion TEXT NOT NULL, role TEXT NOT NULL,
      wins INTEGER DEFAULT 0, total INTEGER DEFAULT 0, patch TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (champion, role)
    );`);
    const latestPerChamp = db.prepare(`
      SELECT champion, wins, losses, season, split
      FROM champion_stats
      WHERE (champion, season || '.' || split) IN (
        SELECT champion, MAX(season || '.' || split) FROM champion_stats GROUP BY champion
      )
    `).all();
    const upsert = db.prepare(`
      INSERT INTO pro_champ_stats (champion, role, wins, total, patch, updated_at)
      VALUES (?, 'ALL', ?, ?, ?, datetime('now'))
      ON CONFLICT(champion, role) DO UPDATE SET
        wins=excluded.wins, total=excluded.total, patch=excluded.patch, updated_at=datetime('now')
    `);
    let n = 0, nNorm = 0;
    const tx = db.transaction(() => {
      for (const r of latestPerChamp) {
        const total = (r.wins || 0) + (r.losses || 0);
        if (total < 5) continue; // ignora sample pequeno
        const patch = `${r.season}/${r.split}`;
        upsert.run(r.champion, r.wins || 0, total, patch);
        n++;
        const norm = normChampionName(r.champion);
        if (norm !== r.champion) {
          try { upsert.run(norm, r.wins || 0, total, patch); nNorm++; } catch (_) {}
        }
      }
    });
    tx();
    console.log(`[meta] bridged pro_champ_stats: ${n} + ${nNorm} normalized variants (role='ALL')`);
  } catch (e) { console.warn(`[meta] bridge champ err: ${e.message}`); }
}

async function main() {
  const { db } = initDatabase(DB_PATH);
  await get('https://gol.gg/').catch(() => null);
  await sleep(200);

  console.log(`[meta] syncing champions...`);
  const ch = await syncChampions(db);
  console.log(`[meta] champion rows upserted: ${ch}`);

  console.log(`[meta] syncing players...`);
  const pl = await syncPlayers(db);
  console.log(`[meta] player rows upserted: ${pl}`);

  console.log(`[meta] bridging to legacy tables...`);
  bridgeChampStats(db);

  const chTot = db.prepare(`SELECT COUNT(*) as n FROM champion_stats`).get().n;
  const plTot = db.prepare(`SELECT COUNT(*) as n FROM player_stats`).get().n;
  const proChTot = db.prepare(`SELECT COUNT(*) as n FROM pro_champ_stats`).get().n;
  console.log(`\n[meta] champion_stats: ${chTot} | player_stats: ${plTot} | pro_champ_stats bridge: ${proChTot}`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

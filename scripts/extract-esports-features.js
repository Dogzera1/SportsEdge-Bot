#!/usr/bin/env node
'use strict';

// scripts/extract-esports-features.js
//
// Extrai features walk-forward de match_results para um esporte esports
// (lol/dota2/valorant/cs2). Diferente do tênis, aqui os "jogadores" são TIMES,
// features derivadas são Elo overall + por liga + forma + H2H + rest.
//
// Uso:
//   node scripts/extract-esports-features.js --game lol [--out data/lol_features.csv]
//                                             [--min-games-warmup 5]
//
// p1 = time alfabeticamente menor (não o vencedor) → y = 1 se p1 venceu.

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const initDatabase = require('../lib/database');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  return argv[i + 1];
}

const GAME = argVal('game', 'lol');
const OUT = path.resolve(argVal('out', `data/${GAME}_features.csv`));
const MIN_WARMUP = parseInt(argVal('min-games-warmup', '5'), 10);
const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

console.log(`[extract-es] game=${GAME} out=${OUT} min_warmup=${MIN_WARMUP}`);

const { db } = initDatabase(DB_PATH);

// ── Team stats loader (só LoL — gol.gg) ─────────────────────────────────
// Estrutura: team_stats → { <normTeam>: { season→split→row } }
const teamStatsMap = new Map();
if (GAME === 'lol') {
  try {
    const rows = db.prepare(`SELECT * FROM team_stats`).all();
    for (const r of rows) {
      const k = String(r.team || '').toLowerCase().trim();
      if (!teamStatsMap.has(k)) teamStatsMap.set(k, {});
      const byT = teamStatsMap.get(k);
      if (!byT[r.season]) byT[r.season] = {};
      byT[r.season][r.split] = r;
    }
    console.log(`[extract-es] team_stats loaded: ${rows.length} rows covering ${teamStatsMap.size} teams`);
  } catch (e) { console.warn(`[extract-es] team_stats load err: ${e.message}`); }
}

// ── Oracle's Elixir rolling loader (só LoL) ─────────────────────────────
// Preload game-level rows por team pra lookup rolling sem SQL no loop.
const oeByTeam = new Map(); // normTeam → [{ t, result, side, gd15, dpm, fd, fb, ft }]
if (GAME === 'lol') {
  try {
    const rows = db.prepare(`
      SELECT teamname, date, result, side, golddiffat15, dpm,
             firstdragon, firstbaron, firsttower
      FROM oracleselixir_games WHERE date IS NOT NULL
    `).all();
    for (const r of rows) {
      const k = String(r.teamname || '').toLowerCase().trim();
      if (!k) continue;
      if (!oeByTeam.has(k)) oeByTeam.set(k, []);
      oeByTeam.get(k).push({
        t: new Date(r.date).getTime(),
        result: r.result || 0,
        side: r.side,
        gd15: r.golddiffat15,
        dpm: r.dpm,
        fd: r.firstdragon || 0, fb: r.firstbaron || 0, ft: r.firsttower || 0,
      });
    }
    for (const arr of oeByTeam.values()) arr.sort((a, b) => a.t - b.t);
    console.log(`[extract-es] OE loaded: ${rows.length} rows covering ${oeByTeam.size} teams`);
  } catch (e) { console.warn(`[extract-es] OE load err: ${e.message}`); }
}

function oeStatsAt(team, tMs, sinceDays = 60, minGames = 5) {
  const arr = oeByTeam.get(String(team || '').toLowerCase().trim());
  if (!arr) return null;
  const sinceT = tMs - sinceDays * 86400000;
  // Binary search / linear — pequeno array por time (~50-100 rows max)
  const filtered = arr.filter(r => r.t < tMs && r.t >= sinceT);
  if (filtered.length < minGames) return null;
  let wins = 0, gd = 0, gdN = 0, dpm = 0, dpmN = 0, fd = 0, fb = 0, ft = 0;
  for (const r of filtered) {
    wins += r.result || 0;
    if (Number.isFinite(r.gd15)) { gd += r.gd15; gdN++; }
    if (Number.isFinite(r.dpm)) { dpm += r.dpm; dpmN++; }
    fd += r.fd; fb += r.fb; ft += r.ft;
  }
  const n = filtered.length;
  return {
    games: n,
    wr: wins / n,
    gd15: gdN ? gd / gdN : null,
    dpm: dpmN ? dpm / dpmN : null,
    obj: (fd + fb + ft) / (3 * n),
  };
}

// ── OE player-level rolling loader (LoL only) ────────────────────────────
// Pre-load all rows per team (via teamname normalized). Pra cada match, agrega
// os 5 jogadores mais freq do time pré-match e computa team-level roster stats.
const oePlayersByTeam = new Map(); // normTeam → [{ t, playername, position, kills, deaths, assists }]
if (GAME === 'lol') {
  try {
    const rows = db.prepare(`
      SELECT teamname, date, playername, position, kills, deaths, assists
      FROM oracleselixir_players WHERE date IS NOT NULL AND teamname IS NOT NULL
        AND lower(teamname) NOT LIKE '%academy%'
        AND lower(teamname) NOT LIKE '%challengers%'
        AND lower(teamname) NOT LIKE '%rookies%'
        AND lower(teamname) NOT LIKE '%youth%'
    `).all();
    for (const r of rows) {
      const k = String(r.teamname || '').toLowerCase().trim();
      if (!k) continue;
      if (!oePlayersByTeam.has(k)) oePlayersByTeam.set(k, []);
      oePlayersByTeam.get(k).push({
        t: new Date(r.date).getTime(),
        playername: r.playername,
        position: r.position,
        kills: r.kills || 0,
        deaths: r.deaths || 0,
        assists: r.assists || 0,
      });
    }
    for (const arr of oePlayersByTeam.values()) arr.sort((a, b) => a.t - b.t);
    console.log(`[extract-es] OE players loaded: ${rows.length} rows covering ${oePlayersByTeam.size} teams`);
  } catch (e) { console.warn(`[extract-es] OE players load err: ${e.message}`); }
}

// Roster stats at time tMs: pega 5 players top-freq do time pre-match, agrega KDA.
function rosterStatsAt(team, tMs, sinceDays = 60, minGamesPerPlayer = 10) {
  const arr = oePlayersByTeam.get(String(team || '').toLowerCase().trim());
  if (!arr) return null;
  const sinceT = tMs - sinceDays * 86400000;
  // Filter pre-match + sinceDays
  const filtered = arr.filter(r => r.t < tMs && r.t >= sinceT);
  if (filtered.length < 15) return null; // min 3 players × 5 games = 15 rows mínimo

  // Count games per (player, position), select 1 per position
  const byPos = new Map(); // pos → {playername → count}
  for (const r of filtered) {
    if (!byPos.has(r.position)) byPos.set(r.position, new Map());
    const m = byPos.get(r.position);
    m.set(r.playername, (m.get(r.playername) || 0) + 1);
  }
  const rosterPlayers = new Set();
  for (const [pos, m] of byPos) {
    // top player por posição
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted[0] && sorted[0][1] >= minGamesPerPlayer) rosterPlayers.add(sorted[0][0]);
  }
  if (rosterPlayers.size < 3) return null;

  // Agrega KDA por player
  const byPlayer = new Map(); // name → { k, d, a, g }
  for (const r of filtered) {
    if (!rosterPlayers.has(r.playername)) continue;
    if (!byPlayer.has(r.playername)) byPlayer.set(r.playername, { k: 0, d: 0, a: 0, g: 0 });
    const p = byPlayer.get(r.playername);
    p.k += r.kills; p.d += r.deaths; p.a += r.assists; p.g++;
  }
  const kdas = [];
  for (const p of byPlayer.values()) {
    const kda = p.d > 0 ? (p.k + p.a) / p.d : (p.k + p.a);
    kdas.push(kda);
  }
  if (kdas.length < 3) return null;

  const avgKda = kdas.reduce((a, b) => a + b, 0) / kdas.length;
  const maxKda = Math.max(...kdas);
  const starCount = kdas.filter(k => k > 5).length;
  const strongCount = kdas.filter(k => k > 4).length;
  const starScore = starCount >= 2 ? 2 : starCount === 1 ? 1 : strongCount >= 2 ? 0.5 : 0;

  return { nPlayers: kdas.length, avgKda, maxKda, starScore };
}

// Mapa data → season/split (gol.gg usa SN = Year-2010+1 aprox; simplificação)
// ── Dota2 OpenDota team stats loader ────────────────────────────────────
// Usa dota_team_stats (migration 046+048) populado por scripts/sync-opendota-team-stats.js.
// v1: rating/wr/games | v2 --deep: rolling 30d {recent_wr, avg_kill_margin,
// avg_duration_sec, win_streak_current, days_since_last}
// Lookup case-insensitive por name OR tag. Current stats (leve look-ahead bias aceitável).
const dotaTeamByName = new Map();
const dotaTeamByTag = new Map();
if (GAME === 'dota2') {
  try {
    // Try v2 columns; fall back silently if migration 048 não rodou
    let rows;
    try {
      rows = db.prepare(`
        SELECT name, tag, rating, wins, losses, wr,
               recent_n, recent_wr, avg_kill_margin, avg_duration_sec,
               win_streak_current, days_since_last
        FROM dota_team_stats
        WHERE name IS NOT NULL AND (rating IS NOT NULL OR (wins + losses) >= 5)
      `).all();
    } catch (_) {
      rows = db.prepare(`
        SELECT name, tag, rating, wins, losses, wr
        FROM dota_team_stats
        WHERE name IS NOT NULL AND (rating IS NOT NULL OR (wins + losses) >= 5)
      `).all();
    }
    for (const r of rows) {
      const entry = {
        rating: Number(r.rating) || null,
        wr: Number(r.wr) || null,
        games: Number(r.wins || 0) + Number(r.losses || 0),
        recentN: Number(r.recent_n) || 0,
        recentWr: Number.isFinite(r.recent_wr) ? r.recent_wr : null,
        killMargin: Number.isFinite(r.avg_kill_margin) ? r.avg_kill_margin : null,
        durationSec: Number.isFinite(r.avg_duration_sec) ? r.avg_duration_sec : null,
        streak: Number(r.win_streak_current) || 0,
        daysSinceLast: Number.isFinite(r.days_since_last) ? r.days_since_last : null,
      };
      if (r.name) dotaTeamByName.set(String(r.name).toLowerCase().trim(), entry);
      if (r.tag) dotaTeamByTag.set(String(r.tag).toLowerCase().trim(), entry);
    }
    const withDeep = rows.filter(r => r.recent_n > 0).length;
    console.log(`[extract-es] dota_team_stats loaded: ${rows.length} teams (${withDeep} with rolling 30d)`);
  } catch (e) { console.warn(`[extract-es] dota_team_stats load err: ${e.message}`); }
}

function dotaTeamLookup(name) {
  if (!name) return null;
  const k = String(name).toLowerCase().trim();
  return dotaTeamByName.get(k) || dotaTeamByTag.get(k) || null;
}

function seasonSplit(dateIso) {
  const [y, m] = dateIso.split('-').map(Number);
  const season = `S${y - 2010 - 2}`; // 2023→S13, 2024→S14, 2025→S15, 2026→S16
  let split = 'ALL';
  if (y >= 2025 && m <= 2) split = 'Winter';
  else if (m >= 1 && m <= 5) split = 'Spring';
  else if (m >= 6 && m <= 8) split = 'Summer';
  else split = 'ALL';
  return { season, split };
}

function getTeamStats(name, season, split) {
  const k = String(name || '').toLowerCase().trim();
  const entry = teamStatsMap.get(k);
  if (!entry) return null;
  // tenta split específico, depois ALL
  if (entry[season]?.[split]) return entry[season][split];
  if (entry[season]?.ALL) return entry[season].ALL;
  // fallback: última season disponível
  const seasons = Object.keys(entry).sort().reverse();
  for (const s of seasons) {
    if (entry[s].ALL) return entry[s].ALL;
    const firstSplit = Object.values(entry[s])[0];
    if (firstSplit) return firstSplit;
  }
  return null;
}

// Carrega matches ordenados
const rows = db.prepare(`
  SELECT match_id, team1, team2, winner, final_score, league, resolved_at
  FROM match_results
  WHERE game = ?
    AND team1 IS NOT NULL AND team1 != ''
    AND team2 IS NOT NULL AND team2 != ''
    AND winner IS NOT NULL AND winner != ''
    AND resolved_at IS NOT NULL
  ORDER BY resolved_at ASC
`).all(GAME);

console.log(`[extract-es] ${rows.length} rows carregados`);
if (!rows.length) { console.error('[extract-es] sem dados'); process.exit(1); }

// ── Normalização ──
function norm(s) { return String(s || '').toLowerCase().trim(); }

// ── Elo state ──
const ELO_INIT = 1500;
const K_BASE = 32, K_MIN = 12, K_SCALE = 50;
function kFactor(games) { return K_BASE - (K_BASE - K_MIN) * Math.min(1, games / K_SCALE); }
function eloExpected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }

// Team state: name → { elo, eloLeague:{leagueName→elo}, gamesAll, gamesLeague:{...}, recent:[...] }
const teamState = new Map();
function getT(name) {
  const k = norm(name);
  if (!teamState.has(k)) {
    teamState.set(k, {
      displayName: name,
      elo: ELO_INIT,
      eloLeague: new Map(),
      gamesAll: 0,
      gamesLeague: new Map(),
      recent: [], // [{t, won, opp}]
    });
  }
  return teamState.get(k);
}

// H2H
const h2hState = new Map();
function h2hKey(a, b) { a = norm(a); b = norm(b); return a < b ? `${a}|${b}` : `${b}|${a}`; }
function getH2H(a, b) {
  const k = h2hKey(a, b);
  if (!h2hState.has(k)) {
    h2hState.set(k, { keyA: norm(a) < norm(b) ? norm(a) : norm(b), a: 0, b: 0 });
  }
  return h2hState.get(k);
}

// Best of: parse final_score p/ extrair "Bo3" etc
function parseBestOf(fs) {
  const m = String(fs || '').match(/Bo(\d)/i);
  if (!m) return 1;
  return parseInt(m[1], 10) || 1;
}

// League tier (rule-of-thumb)
function leagueTier(league) {
  const l = String(league || '').toLowerCase();
  if (/lck|lpl|lec|lcs|worlds|msi/.test(l)) return 3; // tier 1
  if (/lla|cblol|vcs|pcs|ljl/.test(l)) return 2;
  if (/masters|academy|emea|lpl2|pro league|one|major|dpc|ti|riyadh|epl|esl pro/i.test(l)) return 2;
  return 1;
}

const DAY_MS = 86400000;

// ── Feature extraction ──
const out = [];
const HEADERS = [
  'date', 'league', 'league_tier',
  't1', 't2', 'best_of',
  'elo_diff_overall', 'elo_diff_league',
  'games_t1', 'games_t2',
  'winrate_diff_10', 'winrate_diff_20',
  'h2h_diff', 'h2h_total',
  'days_since_last_t1', 'days_since_last_t2', 'days_since_diff',
  'matches_last14_diff',
  'n_signals',
  // Momentum features (cheap, orthogonal; capturam hot/cold streaks + tendência)
  'win_streak_diff',   // +N = t1 em W-streak, -N = L-streak; diff entre times
  'wr_trend_diff',     // (wr10-wr20) diff; positivo = t1 melhorando vs t2
  'elo_diff_sq',       // sign(elo_diff) * elo_diff^2 / 1000; captura non-linearidade
  // gol.gg team stats diffs (só populado se GAME='lol' e ambos times têm stats)
  'gpm_diff', 'gdm_diff', 'gd15_diff', 'fb_rate_diff', 'ft_rate_diff',
  'dpm_diff', 'kd_diff', 'team_wr_diff', 'dra_pct_diff', 'nash_pct_diff',
  'has_team_stats',
  // Oracle's Elixir rolling 60d (só LoL; 0 se algum time sem min 5 games pre-match)
  'oe_gd15_diff', 'oe_obj_diff', 'oe_wr_diff', 'oe_dpm_diff', 'has_oe_stats',
  // OE player-level roster stats (só LoL; 0 se algum time sem roster válido)
  'avg_kda_diff', 'max_kda_diff', 'star_score_diff', 'has_roster_stats',
  // Dota2 OpenDota team stats (só Dota2; 0 se algum time sem match)
  // v1 (rating/wr/games — sempre presente com sync básico)
  'dota_rating_diff', 'dota_wr_diff', 'dota_games_diff', 'has_dota_team_stats',
  // v2 rolling 30d (só populado com sync --deep; orthogonal ao Elo)
  'dota_recent_wr_diff', 'dota_kill_margin_diff', 'dota_duration_diff',
  'dota_streak_diff', 'dota_days_idle_diff', 'has_dota_rolling_stats',
  'y',
];

let kept = 0, skipped = 0;

for (const r of rows) {
  const t = new Date(r.resolved_at).getTime();
  if (!Number.isFinite(t)) { skipped++; continue; }
  const league = r.league || '';
  const bestOf = parseBestOf(r.final_score);
  const tier = leagueTier(league);

  // p1 = alfa menor
  const a = norm(r.team1), b = norm(r.team2);
  const [p1Raw, p2Raw] = a < b ? [r.team1, r.team2] : [r.team2, r.team1];
  const p1Won = norm(r.winner) === norm(p1Raw) ? 1 : 0;

  const s1 = getT(p1Raw);
  const s2 = getT(p2Raw);

  // Features (ANTES de atualizar state)
  const eloDiffOverall = s1.elo - s2.elo;
  const eloL1 = s1.eloLeague.get(league) || s1.elo;
  const eloL2 = s2.eloLeague.get(league) || s2.elo;
  const eloDiffLeague = eloL1 - eloL2;

  const wr10_1 = winRateLast(s1.recent, 10);
  const wr10_2 = winRateLast(s2.recent, 10);
  const wrDiff10 = (wr10_1.n >= 5 && wr10_2.n >= 5) ? (wr10_1.pct - wr10_2.pct) : 0;
  const wr20_1 = winRateLast(s1.recent, 20);
  const wr20_2 = winRateLast(s2.recent, 20);
  const wrDiff20 = (wr20_1.n >= 10 && wr20_2.n >= 10) ? (wr20_1.pct - wr20_2.pct) : 0;

  const h2h = getH2H(p1Raw, p2Raw);
  const p1IsKeyA = norm(p1Raw) === h2h.keyA;
  const h2hDiff = p1IsKeyA ? (h2h.a - h2h.b) : (h2h.b - h2h.a);
  const h2hTotal = h2h.a + h2h.b;

  const last1 = s1.recent.length ? s1.recent[s1.recent.length - 1].t : null;
  const last2 = s2.recent.length ? s2.recent[s2.recent.length - 1].t : null;
  const daysSince1 = last1 ? Math.min(120, Math.round((t - last1) / DAY_MS)) : 120;
  const daysSince2 = last2 ? Math.min(120, Math.round((t - last2) / DAY_MS)) : 120;
  const daysSinceDiff = daysSince1 - daysSince2;

  const mCut = t - 14 * DAY_MS;
  const m14_1 = s1.recent.filter(x => x.t >= mCut).length;
  const m14_2 = s2.recent.filter(x => x.t >= mCut).length;
  const matchesLast14Diff = m14_1 - m14_2;

  // Win streak: conta consecutivos W (positivo) ou L (negativo) no fim da lista.
  function currentStreak(recent) {
    if (!recent || !recent.length) return 0;
    const last = recent[recent.length - 1].won;
    let n = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].won === last) n++; else break;
    }
    return last ? n : -n;
  }
  const streak1 = currentStreak(s1.recent);
  const streak2 = currentStreak(s2.recent);
  const winStreakDiff = streak1 - streak2;

  // Trend: wr10 - wr20 diff entre times (positivo = t1 aquecendo vs t2)
  const trend1 = (wr10_1.n >= 5 && wr20_1.n >= 10) ? (wr10_1.pct - wr20_1.pct) : 0;
  const trend2 = (wr10_2.n >= 5 && wr20_2.n >= 10) ? (wr10_2.pct - wr20_2.pct) : 0;
  const wrTrendDiff = trend1 - trend2;

  // Elo squared (preserva sinal). Non-linearidade: mismatches grandes
  // tem efeito maior que proporcional (escalonado /1000 pra ficar comparável).
  const eloDiffSq = Math.sign(eloDiffOverall) * (eloDiffOverall * eloDiffOverall) / 1000;

  // Sinais
  let nSignals = 0;
  if (s1.gamesAll >= MIN_WARMUP && s2.gamesAll >= MIN_WARMUP) nSignals++;
  if ((s1.gamesLeague.get(league) || 0) >= 3 && (s2.gamesLeague.get(league) || 0) >= 3) nSignals++;
  if (wr10_1.n >= 5 && wr10_2.n >= 5) nSignals++;
  if (h2hTotal >= 2) nSignals++;
  if (last1 && last2) nSignals++;

  const shouldOutput = s1.gamesAll >= MIN_WARMUP && s2.gamesAll >= MIN_WARMUP;
  if (shouldOutput) {
    // gol.gg team stats diffs (só LoL; 0 se algum time sem stats)
    let gpmDiff = 0, gdmDiff = 0, gd15Diff = 0, fbDiff = 0, ftDiff = 0;
    let dpmDiff = 0, kdDiff = 0, teamWrDiff = 0, draPctDiff = 0, nashPctDiff = 0;
    let hasTeamStats = 0;
    if (GAME === 'lol' && teamStatsMap.size > 0) {
      const iso = new Date(t).toISOString().slice(0, 10);
      const { season, split } = seasonSplit(iso);
      const ts1 = getTeamStats(p1Raw, season, split);
      const ts2 = getTeamStats(p2Raw, season, split);
      if (ts1 && ts2) {
        hasTeamStats = 1;
        gpmDiff = (ts1.gpm || 0) - (ts2.gpm || 0);
        gdmDiff = (ts1.gdm || 0) - (ts2.gdm || 0);
        gd15Diff = (ts1.gd_at_15 || 0) - (ts2.gd_at_15 || 0);
        fbDiff = (ts1.fb_pct || 0) - (ts2.fb_pct || 0);
        ftDiff = (ts1.ft_pct || 0) - (ts2.ft_pct || 0);
        dpmDiff = (ts1.dpm || 0) - (ts2.dpm || 0);
        kdDiff = (ts1.kd_ratio || 0) - (ts2.kd_ratio || 0);
        teamWrDiff = (ts1.winrate || 0) - (ts2.winrate || 0);
        draPctDiff = (ts1.dra_pct || 0) - (ts2.dra_pct || 0);
        nashPctDiff = (ts1.nash_pct || 0) - (ts2.nash_pct || 0);
      }
    }
    // Oracle's Elixir rolling (só LoL)
    let oeGd15Diff = 0, oeObjDiff = 0, oeWrDiff = 0, oeDpmDiff = 0, hasOeStats = 0;
    if (GAME === 'lol' && oeByTeam.size > 0) {
      const oe1 = oeStatsAt(p1Raw, t);
      const oe2 = oeStatsAt(p2Raw, t);
      if (oe1 && oe2) {
        hasOeStats = 1;
        oeGd15Diff = (oe1.gd15 || 0) - (oe2.gd15 || 0);
        oeObjDiff = oe1.obj - oe2.obj;
        oeWrDiff = oe1.wr - oe2.wr;
        oeDpmDiff = (oe1.dpm || 0) - (oe2.dpm || 0);
      }
    }
    // OE roster (player-level) stats
    let avgKdaDiff = 0, maxKdaDiff = 0, starScoreDiff = 0, hasRosterStats = 0;
    if (GAME === 'lol' && oePlayersByTeam.size > 0) {
      const r1 = rosterStatsAt(p1Raw, t);
      const r2 = rosterStatsAt(p2Raw, t);
      if (r1 && r2) {
        hasRosterStats = 1;
        avgKdaDiff = r1.avgKda - r2.avgKda;
        maxKdaDiff = r1.maxKda - r2.maxKda;
        starScoreDiff = r1.starScore - r2.starScore;
      }
    }
    // Dota2 OpenDota team stats
    let dotaRatingDiff = 0, dotaWrDiff = 0, dotaGamesDiff = 0, hasDotaTeamStats = 0;
    // v2 rolling 30d features
    let dotaRecentWrDiff = 0, dotaKillMarginDiff = 0, dotaDurationDiff = 0;
    let dotaStreakDiff = 0, dotaDaysIdleDiff = 0, hasDotaRollingStats = 0;
    if (GAME === 'dota2' && dotaTeamByName.size > 0) {
      const d1 = dotaTeamLookup(p1Raw);
      const d2 = dotaTeamLookup(p2Raw);
      if (d1 && d2 && d1.rating != null && d2.rating != null && d1.games >= 5 && d2.games >= 5) {
        hasDotaTeamStats = 1;
        dotaRatingDiff = d1.rating - d2.rating;
        dotaWrDiff = (d1.wr || 0) - (d2.wr || 0);
        dotaGamesDiff = Math.log1p(d1.games) - Math.log1p(d2.games);
      }
      // Rolling 30d: exige ambos com recent_n >= 5
      if (d1 && d2 && d1.recentN >= 5 && d2.recentN >= 5) {
        hasDotaRollingStats = 1;
        dotaRecentWrDiff = (d1.recentWr ?? 0) - (d2.recentWr ?? 0);
        dotaKillMarginDiff = (d1.killMargin ?? 0) - (d2.killMargin ?? 0);
        // Duration em minutos (ou 0 se null)
        const dur1 = (d1.durationSec ?? 0) / 60;
        const dur2 = (d2.durationSec ?? 0) / 60;
        dotaDurationDiff = dur1 - dur2;
        dotaStreakDiff = (d1.streak ?? 0) - (d2.streak ?? 0);
        dotaDaysIdleDiff = (d1.daysSinceLast ?? 0) - (d2.daysSinceLast ?? 0);
      }
    }
    out.push([
      new Date(t).toISOString().slice(0, 10),
      (league || '').replace(/,/g, ' '),
      tier,
      (p1Raw || '').replace(/,/g, ' '),
      (p2Raw || '').replace(/,/g, ' '),
      bestOf,
      eloDiffOverall.toFixed(2),
      eloDiffLeague.toFixed(2),
      s1.gamesAll, s2.gamesAll,
      wrDiff10.toFixed(4), wrDiff20.toFixed(4),
      h2hDiff, h2hTotal,
      daysSince1, daysSince2, daysSinceDiff,
      matchesLast14Diff,
      nSignals,
      winStreakDiff, wrTrendDiff.toFixed(4), eloDiffSq.toFixed(2),
      gpmDiff.toFixed(2), gdmDiff.toFixed(2), gd15Diff.toFixed(2),
      fbDiff.toFixed(4), ftDiff.toFixed(4),
      dpmDiff.toFixed(2), kdDiff.toFixed(3), teamWrDiff.toFixed(4),
      draPctDiff.toFixed(4), nashPctDiff.toFixed(4), hasTeamStats,
      oeGd15Diff.toFixed(2), oeObjDiff.toFixed(4), oeWrDiff.toFixed(4), oeDpmDiff.toFixed(2), hasOeStats,
      avgKdaDiff.toFixed(3), maxKdaDiff.toFixed(3), starScoreDiff.toFixed(2), hasRosterStats,
      dotaRatingDiff.toFixed(1), dotaWrDiff.toFixed(4), dotaGamesDiff.toFixed(3), hasDotaTeamStats,
      dotaRecentWrDiff.toFixed(4), dotaKillMarginDiff.toFixed(2), dotaDurationDiff.toFixed(2),
      dotaStreakDiff, dotaDaysIdleDiff, hasDotaRollingStats,
      p1Won,
    ]);
    kept++;
  } else {
    skipped++;
  }

  // Update state
  const wState = norm(r.winner) === norm(p1Raw) ? s1 : s2;
  const lState = wState === s1 ? s2 : s1;

  const expW = eloExpected(wState.elo, lState.elo);
  const kW = kFactor(wState.gamesAll), kL = kFactor(lState.gamesAll);
  wState.elo += kW * (1 - expW);
  lState.elo += kL * (0 - (1 - expW));

  const wEloL = wState.eloLeague.get(league) || ELO_INIT;
  const lEloL = lState.eloLeague.get(league) || ELO_INIT;
  const expWL = eloExpected(wEloL, lEloL);
  const kWL = kFactor(wState.gamesLeague.get(league) || 0);
  const kLL = kFactor(lState.gamesLeague.get(league) || 0);
  wState.eloLeague.set(league, wEloL + kWL * (1 - expWL));
  lState.eloLeague.set(league, lEloL + kLL * (0 - (1 - expWL)));

  wState.gamesAll++; lState.gamesAll++;
  wState.gamesLeague.set(league, (wState.gamesLeague.get(league) || 0) + 1);
  lState.gamesLeague.set(league, (lState.gamesLeague.get(league) || 0) + 1);

  wState.recent.push({ t, won: 1, opp: lState.displayName });
  lState.recent.push({ t, won: 0, opp: wState.displayName });
  if (wState.recent.length > 40) wState.recent.splice(0, wState.recent.length - 40);
  if (lState.recent.length > 40) lState.recent.splice(0, lState.recent.length - 40);

  if (norm(r.winner) === h2h.keyA) h2h.a++; else h2h.b++;
}

function winRateLast(recent, n) {
  const slice = recent.slice(-n);
  if (!slice.length) return { pct: 0.5, n: 0 };
  const wins = slice.filter(x => x.won).length;
  return { pct: wins / slice.length, n: slice.length };
}

// Write
const outDir = path.dirname(OUT);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(OUT, HEADERS.join(',') + '\n' + out.map(r => r.join(',')).join('\n') + '\n', 'utf8');

console.log(`[extract-es] written: ${kept} (skipped=${skipped}) → ${OUT}`);
const yMean = out.length ? out.reduce((s, r) => s + (+r[r.length - 1]), 0) / out.length : 0;
console.log(`[extract-es] y mean (p1 win rate, ~0.5 esperado): ${yMean.toFixed(4)}`);

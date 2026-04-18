#!/usr/bin/env node
'use strict';

/**
 * extract-1v1-features.js — walk-forward extraction genérico pra sports 1v1.
 *
 * Suporta: mma, darts, snooker, tabletennis, tennis (teórico; tennis tem script próprio).
 * Features cross-player: Elo overall + league, recent winrate, h2h, streak, days-since, momentum.
 *
 * Uso:
 *   node scripts/extract-1v1-features.js --game snooker
 *   node scripts/extract-1v1-features.js --game darts --out data/darts_features.csv
 *
 * Output: data/{game}_features.csv consumido por train-esports-model.js --game {game}.
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const initDatabase = require('../lib/database');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const GAME = argVal('game', 'mma');
const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const OUT = path.resolve(argVal('out', `data/${GAME}_features.csv`));
const MIN_WARMUP = parseInt(argVal('min-games-warmup', '3'), 10);

const { db } = initDatabase(DB_PATH);

const ELO_INIT = 1500;
const K_BASE = 32, K_MIN = 12, K_SCALE = 20; // MMA: menos fights per fighter → K_SCALE menor
function kFactor(games) { return K_BASE - (K_BASE - K_MIN) * Math.min(1, games / K_SCALE); }
function eloExpected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
function norm(s) { return String(s || '').toLowerCase().trim(); }

// Parse weight class do league/event name (best-effort).
// Ex: "UFC 327: Prochazka vs. Ulberg" → fight title, não dá. Mas muitos events têm
// no event name tipo "UFC Fight Night: Lightweight Bout". Mais confiável: final_score
// que temos como "KO/TKO R2" ou similar — não tem weight class. Fallback: null.
function parseWeightClass(league, finalScore) {
  const text = `${league || ''} ${finalScore || ''}`.toLowerCase();
  if (/\bflyweight\b/.test(text)) return 'flyweight';
  if (/\bbantamweight\b/.test(text)) return 'bantamweight';
  if (/\bfeatherweight\b/.test(text)) return 'featherweight';
  if (/\blightweight\b/.test(text)) return 'lightweight';
  if (/\bwelterweight\b/.test(text)) return 'welterweight';
  if (/\bmiddleweight\b/.test(text)) return 'middleweight';
  if (/\blight heavyweight\b/.test(text)) return 'light heavyweight';
  if (/\bheavyweight\b/.test(text)) return 'heavyweight';
  return null;
}

// Parse método de finalização do final_score (ex: "KO/TKO R2", "Submission R1", "Decision R3").
function parseMethod(finalScore) {
  const t = String(finalScore || '').toLowerCase();
  if (/ko|tko/.test(t)) return 'ko';
  if (/sub/.test(t)) return 'sub';
  if (/dec|decision/.test(t)) return 'dec';
  return null;
}

const rows = db.prepare(`
  SELECT match_id, team1, team2, winner, final_score, league, resolved_at
  FROM match_results
  WHERE game = ?
    AND team1 IS NOT NULL AND team2 IS NOT NULL
    AND winner IS NOT NULL AND winner != ''
    AND resolved_at IS NOT NULL
  ORDER BY resolved_at ASC
`).all(GAME);

console.log(`[extract-1v1] game=${GAME} ${rows.length} matches carregados`);
if (!rows.length) { console.error('no data'); process.exit(1); }

const fighterState = new Map();
function getF(name) {
  const k = norm(name);
  if (!fighterState.has(k)) {
    fighterState.set(k, {
      displayName: name,
      elo: ELO_INIT,
      eloWeight: new Map(),
      fights: 0,
      fightsWeight: new Map(),
      recent: [], // {t, won, method, opp, oppElo, league}
      methodCount: { ko: 0, sub: 0, dec: 0 },
    });
  }
  return fighterState.get(k);
}

// SOS — avg Elo dos últimos N oponentes (proxy de strength of schedule).
// Player que venceu top-10 tem SOS alto; player que venceu tier-C tem SOS baixo.
function sosLast(recent, n) {
  const slice = recent.slice(-n);
  if (!slice.length) return null;
  const elos = slice.map(x => x.oppElo).filter(e => Number.isFinite(e));
  if (!elos.length) return null;
  return elos.reduce((a, b) => a + b, 0) / elos.length;
}

// Momentum na mesma liga/tournament — wins em matches recentes dessa liga.
// Captura "player está hot neste torneio específico".
function sameLeagueWins(recent, league, windowDays, now) {
  const cutoff = now - windowDays * 86400000;
  let wins = 0, losses = 0;
  for (const r of recent) {
    if (r.t < cutoff) continue;
    if (norm(r.league) !== norm(league)) continue;
    if (r.won) wins++; else losses++;
  }
  return { wins, losses, total: wins + losses };
}

const h2hState = new Map();
function h2hKey(a, b) { a = norm(a); b = norm(b); return a < b ? `${a}|${b}` : `${b}|${a}`; }
function getH2H(a, b) {
  const k = h2hKey(a, b);
  if (!h2hState.has(k)) h2hState.set(k, { keyA: norm(a) < norm(b) ? norm(a) : norm(b), a: 0, b: 0 });
  return h2hState.get(k);
}

function currentStreak(recent) {
  if (!recent.length) return 0;
  const last = recent[recent.length - 1].won;
  let n = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].won === last) n++; else break;
  }
  return last ? n : -n;
}

function winRateLast(recent, n) {
  const slice = recent.slice(-n);
  if (!slice.length) return null;
  const wins = slice.filter(x => x.won).length;
  return wins / slice.length;
}

const DAY_MS = 86400000;
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
  'win_streak_diff', 'wr_trend_diff', 'elo_diff_sq',
  'sos_diff', 'same_league_wins_diff', 'same_league_wr_diff',  // novas 1v1 features
  // MMA-specific — populated 0 pra non-MMA sports que reusam train-esports-model
  'gpm_diff', 'gdm_diff', 'gd15_diff', 'fb_rate_diff', 'ft_rate_diff',
  'dpm_diff', 'kd_diff', 'team_wr_diff', 'dra_pct_diff', 'nash_pct_diff', 'has_team_stats',
  'oe_gd15_diff', 'oe_obj_diff', 'oe_wr_diff', 'oe_dpm_diff', 'has_oe_stats',
  'avg_kda_diff', 'max_kda_diff', 'star_score_diff', 'has_roster_stats',
  'y',
];

let kept = 0, skipped = 0;

for (const r of rows) {
  const t = new Date(r.resolved_at).getTime();
  if (!Number.isFinite(t)) { skipped++; continue; }
  const league = r.league || '';
  const weightClass = parseWeightClass(league, r.final_score);
  const tier = 1; // MMA é geralmente 1 tier (UFC); podemos diferenciar Fight Night vs Numbered depois

  const a = norm(r.team1), b = norm(r.team2);
  const [p1Raw, p2Raw] = a < b ? [r.team1, r.team2] : [r.team2, r.team1];
  const p1Won = norm(r.winner) === norm(p1Raw) ? 1 : 0;

  const s1 = getF(p1Raw);
  const s2 = getF(p2Raw);

  const eloDiffOverall = s1.elo - s2.elo;
  const eloW1 = weightClass ? (s1.eloWeight.get(weightClass) || s1.elo) : s1.elo;
  const eloW2 = weightClass ? (s2.eloWeight.get(weightClass) || s2.elo) : s2.elo;
  const eloDiffLeague = eloW1 - eloW2;

  const wr10_1 = winRateLast(s1.recent, 5);
  const wr10_2 = winRateLast(s2.recent, 5);
  const wrDiff10 = (s1.recent.length >= 3 && s2.recent.length >= 3 && wr10_1 != null && wr10_2 != null) ? (wr10_1 - wr10_2) : 0;
  const wr20_1 = winRateLast(s1.recent, 10);
  const wr20_2 = winRateLast(s2.recent, 10);
  const wrDiff20 = (s1.recent.length >= 5 && s2.recent.length >= 5 && wr20_1 != null && wr20_2 != null) ? (wr20_1 - wr20_2) : 0;

  const h2h = getH2H(p1Raw, p2Raw);
  const p1IsKeyA = norm(p1Raw) === h2h.keyA;
  const h2hDiff = p1IsKeyA ? (h2h.a - h2h.b) : (h2h.b - h2h.a);
  const h2hTotal = h2h.a + h2h.b;

  const last1 = s1.recent.length ? s1.recent[s1.recent.length - 1].t : null;
  const last2 = s2.recent.length ? s2.recent[s2.recent.length - 1].t : null;
  const daysSince1 = last1 ? Math.min(365, Math.round((t - last1) / DAY_MS)) : 365;
  const daysSince2 = last2 ? Math.min(365, Math.round((t - last2) / DAY_MS)) : 365;
  const daysSinceDiff = daysSince1 - daysSince2;

  const mCut = t - 180 * DAY_MS; // MMA: 180d window (vs esports 14d) — fighters fight ~3-4x/year
  const m14_1 = s1.recent.filter(x => x.t >= mCut).length;
  const m14_2 = s2.recent.filter(x => x.t >= mCut).length;

  // Momentum
  const streak1 = currentStreak(s1.recent);
  const streak2 = currentStreak(s2.recent);
  const trend1 = (wr10_1 != null && wr20_1 != null) ? (wr10_1 - wr20_1) : 0;
  const trend2 = (wr10_2 != null && wr20_2 != null) ? (wr10_2 - wr20_2) : 0;
  const eloDiffSq = Math.sign(eloDiffOverall) * (eloDiffOverall * eloDiffOverall) / 1000;

  // SOS — avg opponent Elo dos últimos 5 matches
  const sos1 = sosLast(s1.recent, 5);
  const sos2 = sosLast(s2.recent, 5);
  const sosDiff = (sos1 != null && sos2 != null) ? (sos1 - sos2) : 0;

  // Same-league momentum — wins na mesma tournament/league nos últimos 365d
  const slw1 = sameLeagueWins(s1.recent, league, 365, t);
  const slw2 = sameLeagueWins(s2.recent, league, 365, t);
  const sameLeagueWinsDiff = slw1.wins - slw2.wins;
  const slwWr1 = slw1.total >= 2 ? slw1.wins / slw1.total : null;
  const slwWr2 = slw2.total >= 2 ? slw2.wins / slw2.total : null;
  const sameLeagueWrDiff = (slwWr1 != null && slwWr2 != null) ? (slwWr1 - slwWr2) : 0;

  let nSignals = 0;
  if (s1.fights >= MIN_WARMUP && s2.fights >= MIN_WARMUP) nSignals++;
  if (weightClass && (s1.fightsWeight.get(weightClass) || 0) >= 2 && (s2.fightsWeight.get(weightClass) || 0) >= 2) nSignals++;
  if (s1.recent.length >= 3 && s2.recent.length >= 3) nSignals++;
  if (h2hTotal >= 1) nSignals++;
  if (last1 && last2) nSignals++;

  const shouldOutput = s1.fights >= MIN_WARMUP && s2.fights >= MIN_WARMUP;
  if (shouldOutput) {
    out.push([
      new Date(t).toISOString().slice(0, 10),
      (league || '').replace(/,/g, ' '),
      tier,
      (p1Raw || '').replace(/,/g, ' '),
      (p2Raw || '').replace(/,/g, ' '),
      1, // MMA é fight único (bestOf=1)
      eloDiffOverall.toFixed(2),
      eloDiffLeague.toFixed(2),
      s1.fights, s2.fights,
      wrDiff10.toFixed(4), wrDiff20.toFixed(4),
      h2hDiff, h2hTotal,
      daysSince1, daysSince2, daysSinceDiff,
      m14_1 - m14_2,
      nSignals,
      streak1 - streak2, (trend1 - trend2).toFixed(4), eloDiffSq.toFixed(2),
      sosDiff.toFixed(2), sameLeagueWinsDiff, sameLeagueWrDiff.toFixed(4),
      // LoL-specific: todos 0 (MMA reusa esse header pra compatibilidade com train-esports-model)
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // gpm..has_team_stats
      0, 0, 0, 0, 0,  // oe_* + has_oe_stats
      0, 0, 0, 0,  // avg_kda..has_roster_stats
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
  const kW = kFactor(wState.fights), kL = kFactor(lState.fights);
  wState.elo += kW * (1 - expW);
  lState.elo += kL * (0 - (1 - expW));

  if (weightClass) {
    const wEloW = wState.eloWeight.get(weightClass) || ELO_INIT;
    const lEloW = lState.eloWeight.get(weightClass) || ELO_INIT;
    const expWW = eloExpected(wEloW, lEloW);
    const kWW = kFactor(wState.fightsWeight.get(weightClass) || 0);
    const kLW = kFactor(lState.fightsWeight.get(weightClass) || 0);
    wState.eloWeight.set(weightClass, wEloW + kWW * (1 - expWW));
    lState.eloWeight.set(weightClass, lEloW + kLW * (0 - (1 - expWW)));
    wState.fightsWeight.set(weightClass, (wState.fightsWeight.get(weightClass) || 0) + 1);
    lState.fightsWeight.set(weightClass, (lState.fightsWeight.get(weightClass) || 0) + 1);
  }

  wState.fights++; lState.fights++;
  const method = parseMethod(r.final_score);
  if (method) wState.methodCount[method]++;
  // Captura Elo do oponente ANTES do update pra SOS. Aqui já atualizamos elo acima,
  // então precisamos passar o elo pre-update. Re-deriva via fighter vencedor/perdedor:
  const oppEloForW = lState.elo; // lState acabou de ser atualizado pro novo Elo, que reflete pós-match
  const oppEloForL = wState.elo;
  wState.recent.push({ t, won: 1, method, opp: lState.displayName, oppElo: oppEloForW, league });
  lState.recent.push({ t, won: 0, method, opp: wState.displayName, oppElo: oppEloForL, league });
  if (wState.recent.length > 30) wState.recent.splice(0, wState.recent.length - 30);
  if (lState.recent.length > 30) lState.recent.splice(0, lState.recent.length - 30);

  if (norm(r.winner) === h2h.keyA) h2h.a++; else h2h.b++;
}

const outDir = path.dirname(OUT);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(OUT, HEADERS.join(',') + '\n' + out.map(r => r.join(',')).join('\n') + '\n', 'utf8');

console.log(`[extract-1v1] written: ${kept} (skipped=${skipped}) → ${OUT}`);
const yMean = out.length ? out.reduce((s, r) => s + (+r[r.length - 1]), 0) / out.length : 0;
console.log(`[extract-1v1] y mean (p1 win rate, ~0.5 esperado): ${yMean.toFixed(4)}`);

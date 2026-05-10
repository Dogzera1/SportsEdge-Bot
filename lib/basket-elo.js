'use strict';

/**
 * basket-elo.js — Elo simples para NBA (fase 1 do sport basket).
 *
 * Conventions:
 * - Initial rating 1500 (sem prior bayesiano, NBA tem rosters mutáveis temporada-a-temporada)
 * - K = 20 (regular season), 30 (playoffs detectado via league flag, futuro)
 * - Home advantage = +85 Elo points (~3.3% win prob shift, valor empírico FiveThirtyEight)
 * - Decay: 25% pra mean (1500) entre temporadas — implementado em ensureSeasonReset.
 *
 * Public API:
 *   getElo(db, name) → { rating, games, isCold }
 *   predictWin(db, home, away) → { pHome, pAway, ratingDiff }
 *   updateMatch(db, home, away, winner, ts) → void (persists)
 *   ensureSeasonReset(db, opts) → { applied, season, n, sampleBefore, sampleAfter }
 *   listAll(db, opts)
 */

const _norm = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]/g, '');

const INITIAL = 1500;
const K_REG = 20;
const HOME_ADV = 85;
const SEASON_DECAY = 0.25; // 25% pra mean entre temporadas
const SEASON_SETTING_KEY = 'basket_elo_last_season_reset';

function _getRow(db, name) {
  const n = _norm(name);
  if (!n) return null;
  return db.prepare('SELECT * FROM basket_elo WHERE team_norm = ?').get(n);
}

function getElo(db, name) {
  const row = _getRow(db, name);
  if (!row) return { rating: INITIAL, games: 0, isCold: true };
  return { rating: Number(row.rating) || INITIAL, games: Number(row.games) || 0, isCold: (Number(row.games) || 0) < 5 };
}

function _expected(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

/**
 * Calcula probabilidades pré-jogo dado home/away. Inclui home advantage.
 * Cold start (games <5): retorna { pHome:0.55, pAway:0.45, isCold:true } como fallback
 * (50% + home edge default; impede tip cega em times sem histórico).
 */
function predictWin(db, home, away) {
  const h = getElo(db, home);
  const a = getElo(db, away);
  const isCold = h.isCold || a.isCold;
  if (isCold) {
    return { pHome: 0.55, pAway: 0.45, ratingDiff: 0, isCold: true, hRating: h.rating, aRating: a.rating, hGames: h.games, aGames: a.games };
  }
  const adjHome = h.rating + HOME_ADV;
  const pHome = _expected(adjHome, a.rating);
  return { pHome, pAway: 1 - pHome, ratingDiff: adjHome - a.rating, isCold: false, hRating: h.rating, aRating: a.rating, hGames: h.games, aGames: a.games };
}

/**
 * Aplica resultado: ajusta ratings via Elo update.
 * winner = 'home' | 'away' | nome exato do time vencedor (parsed via norm match).
 * ts = ISO string (sent_at ou resolved_at).
 */
function updateMatch(db, home, away, winner, ts = null) {
  if (!home || !away || !winner) return;
  const hN = _norm(home), aN = _norm(away);
  if (!hN || !aN) return;
  let homeWon;
  if (winner === 'home') homeWon = true;
  else if (winner === 'away') homeWon = false;
  else {
    const wN = _norm(winner);
    if (wN === hN || wN.includes(hN) || hN.includes(wN)) homeWon = true;
    else if (wN === aN || wN.includes(aN) || aN.includes(wN)) homeWon = false;
    else return; // winner não casa nem com home nem away — skip
  }
  const h = getElo(db, home);
  const a = getElo(db, away);
  const adjHome = h.rating + HOME_ADV;
  const expHome = _expected(adjHome, a.rating);
  const k = K_REG; // expandir pra K_PO=30 quando league flag indicar playoffs
  const sHome = homeWon ? 1 : 0;
  const newH = h.rating + k * (sHome - expHome);
  const newA = a.rating + k * ((1 - sHome) - (1 - expHome));
  const tsIso = ts || new Date().toISOString().replace('T', ' ').slice(0, 19);
  const ups = db.prepare(`
    INSERT INTO basket_elo (team_norm, team_raw, rating, games, last_match_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(team_norm) DO UPDATE SET
      team_raw = excluded.team_raw,
      rating = excluded.rating,
      games = excluded.games,
      last_match_at = excluded.last_match_at,
      updated_at = datetime('now')
  `);
  ups.run(hN, home, newH, h.games + 1, tsIso);
  ups.run(aN, away, newA, a.games + 1, tsIso);
}

/**
 * Pull all ratings (admin debug / dashboard).
 */
function listAll(db, { limit = 50 } = {}) {
  return db.prepare('SELECT team_raw, rating, games, last_match_at FROM basket_elo ORDER BY rating DESC LIMIT ?').all(limit);
}

/**
 * NBA season label de uma data. Out-Jun = season "YYYY-YY+1". Jul-Set é
 * offseason (retorna a season que acabou em Jun).
 *   2026-05-10 → "2025-26"
 *   2026-09-15 → "2025-26" (offseason ainda nominalmente)
 *   2026-10-25 → "2026-27"
 */
function _seasonOf(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1; // 1-12
  if (m >= 10) return `${y}-${String(y + 1).slice(-2)}`;
  return `${y - 1}-${String(y).slice(-2)}`;
}

/**
 * Aplica decay 25% pra INITIAL (1500) em todos times. Idempotente per season
 * via settings table (settings tem `key` PRIMARY KEY).
 *
 * Sintoma motivador 2026-05-10: LAL=1330 vs OKC=2008 (gap 678) — K=20 sem
 * decay acumula drift inter-temporada. NBA típico gap top-bottom 100-300;
 * 678 é structurally errado e contamina blend (mesmo com w=0.35).
 *
 * @param {object} opts
 *   - season: label da temporada (default = current via _seasonOf)
 *   - force: true → ignora dedup per-season (re-aplica decay)
 *   - dryRun: true → não escreve, retorna sample do efeito
 *   - resetGames: true → também zera games counter (default false)
 * @returns { applied, season, alreadyApplied, n, sampleBefore, sampleAfter }
 */
function ensureSeasonReset(db, opts = {}) {
  const season = String(opts.season || _seasonOf(new Date()));
  const force = !!opts.force;
  const dryRun = !!opts.dryRun;
  const resetGames = !!opts.resetGames;

  // Check dedup via settings table
  let lastReset = null;
  try {
    lastReset = db.prepare('SELECT value FROM settings WHERE key = ?').get(SEASON_SETTING_KEY)?.value || null;
  } catch (_) {}

  const alreadyApplied = lastReset === season;
  if (alreadyApplied && !force) {
    return { applied: false, season, alreadyApplied: true, lastReset, n: 0 };
  }

  // Sample pre-decay (top 3 + bottom 3 by rating)
  const all = db.prepare('SELECT team_norm, team_raw, rating, games FROM basket_elo').all();
  const n = all.length;
  if (!n) {
    return { applied: false, season, n: 0, reason: 'no_teams' };
  }
  const sortedByRating = [...all].sort((a, b) => Number(b.rating) - Number(a.rating));
  const sampleBefore = {
    top: sortedByRating.slice(0, 3).map(t => ({ team: t.team_raw, rating: Number(t.rating).toFixed(0), games: t.games })),
    bottom: sortedByRating.slice(-3).reverse().map(t => ({ team: t.team_raw, rating: Number(t.rating).toFixed(0), games: t.games })),
    gap: Math.round(Number(sortedByRating[0].rating) - Number(sortedByRating[n - 1].rating)),
  };

  // Compute new ratings: r_new = INITIAL + (r_old - INITIAL) * (1 - SEASON_DECAY)
  // = INITIAL * SEASON_DECAY + r_old * (1 - SEASON_DECAY)
  // Pra SEASON_DECAY=0.25: r_new = 375 + r_old * 0.75
  const decayedRows = all.map(t => ({
    team_norm: t.team_norm,
    team_raw: t.team_raw,
    rating: INITIAL + (Number(t.rating) - INITIAL) * (1 - SEASON_DECAY),
    games: resetGames ? 0 : Number(t.games) || 0,
  }));
  const sortedAfter = [...decayedRows].sort((a, b) => b.rating - a.rating);
  const sampleAfter = {
    top: sortedAfter.slice(0, 3).map(t => ({ team: t.team_raw, rating: t.rating.toFixed(0), games: t.games })),
    bottom: sortedAfter.slice(-3).reverse().map(t => ({ team: t.team_raw, rating: t.rating.toFixed(0), games: t.games })),
    gap: Math.round(sortedAfter[0].rating - sortedAfter[n - 1].rating),
  };

  if (dryRun) {
    return { applied: false, dryRun: true, season, n, sampleBefore, sampleAfter, decayPct: SEASON_DECAY };
  }

  // Apply update in transaction
  const upd = db.prepare('UPDATE basket_elo SET rating = ?, games = ?, updated_at = datetime(\'now\') WHERE team_norm = ?');
  const tx = db.transaction((rows) => {
    for (const r of rows) upd.run(r.rating, r.games, r.team_norm);
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(SEASON_SETTING_KEY, season);
  });
  tx(decayedRows);

  return { applied: true, season, n, sampleBefore, sampleAfter, decayPct: SEASON_DECAY };
}

module.exports = { getElo, predictWin, updateMatch, listAll, ensureSeasonReset, _seasonOf, _norm, INITIAL, HOME_ADV, SEASON_DECAY };

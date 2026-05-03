'use strict';

/**
 * basket-elo.js — Elo simples para NBA (fase 1 do sport basket).
 *
 * Conventions:
 * - Initial rating 1500 (sem prior bayesiano, NBA tem rosters mutáveis temporada-a-temporada)
 * - K = 20 (regular season), 30 (playoffs detectado via league flag, futuro)
 * - Home advantage = +85 Elo points (~3.3% win prob shift, valor empírico FiveThirtyEight)
 * - Decay: 25% pra mean (1500) entre temporadas — wired no _maybeSeasonReset.
 *
 * Public API:
 *   getElo(db, name) → { rating, games, isCold }
 *   predictWin(db, home, away) → { pHome, pAway, ratingDiff }
 *   updateMatch(db, home, away, winner, ts) → void (persists)
 *   ensureSeasonReset(db, currentSeason) → opt-in
 */

const _norm = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]/g, '');

const INITIAL = 1500;
const K_REG = 20;
const HOME_ADV = 85;

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

module.exports = { getElo, predictWin, updateMatch, listAll, _norm, INITIAL, HOME_ADV };

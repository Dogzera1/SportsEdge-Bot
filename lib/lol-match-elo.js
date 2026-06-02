'use strict';
/**
 * lol-match-elo.js — shared Elo builder for the Match Lab predictor.
 * Used by BOTH scripts/backtest-lol-match.js and lib/lol-match-predict.js so the
 * Elo seen at fit-time matches the Elo seen at serve-time. Display-only.
 */
const { createEloSystem } = require('./elo-rating');
const { classifyLeague } = require('./lol-model');

// Aggregate oracleselixir_players (one row per player) into one row per game.
// Returns [{ gameid, blueTeam, redTeam, blueWon, date, league }] sorted by date ASC.
function aggregateOeGames(db, opts = {}) {
  const minDate = opts.minDate ? String(opts.minDate) : null;
  const rows = db.prepare(`
    SELECT gameid, side, teamname, date, league, result
    FROM oracleselixir_players
    ${minDate ? 'WHERE date >= ?' : ''}
    ORDER BY date ASC, gameid ASC
  `).all(...(minDate ? [minDate] : []));
  const oe = new Map();
  for (const r of rows) {
    let g = oe.get(r.gameid);
    if (!g) { g = { gameid: r.gameid, date: r.date, league: r.league, blueTeam: null, redTeam: null, blueWon: null }; oe.set(r.gameid, g); }
    const side = String(r.side || '').toLowerCase();
    if (side === 'blue') { g.blueTeam = r.teamname; if (g.blueWon === null) g.blueWon = r.result ? 1 : 0; }
    else if (side === 'red') { g.redTeam = r.teamname; }
  }
  const games = [...oe.values()].filter(g => g.blueWon != null && g.blueTeam && g.redTeam);
  games.sort((a, b) => String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0);
  return games;
}

// Rate every OE game into `elo` in chronological order (margin=1; games are single maps).
function _rateOeGames(db, elo, opts = {}) {
  for (const g of aggregateOeGames(db, opts)) {
    const tier = classifyLeague(g.league);
    const winner = g.blueWon ? g.blueTeam : g.redTeam;
    const loser  = g.blueWon ? g.redTeam : g.blueTeam;
    elo.rate(winner, loser, 1, g.date, tier);
  }
}

// Build a bootstrapped Elo from the chosen source.
//   series — match_results (legacy baseline)
//   games  — Oracle's Elixir games only
//   hybrid — match_results before the OE window (seed) + OE games (granular)
function buildMatchElo(db, { config, source }) {
  const elo = createEloSystem(config);
  const ctxFn = (row) => classifyLeague(row.league);
  if (source === 'series') {
    elo.bootstrap(db, 'lol', ctxFn, { maxAgeDays: 100000 });
  } else if (source === 'games') {
    _rateOeGames(db, elo);
  } else if (source === 'hybrid') {
    const cutoff = db.prepare(`SELECT MIN(date) d FROM oracleselixir_players`).get()?.d || null;
    elo.bootstrap(db, 'lol', ctxFn, { maxAgeDays: 100000, maxDate: cutoff });
    _rateOeGames(db, elo);
  } else {
    throw new Error(`unknown source: ${source}`);
  }
  return elo;
}

module.exports = { aggregateOeGames, buildMatchElo };

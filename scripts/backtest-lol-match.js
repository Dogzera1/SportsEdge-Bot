'use strict';

// scripts/backtest-lol-match.js
// Task 4 — Point-in-time Elo replay baseline for LoL match predictor.
//
// NO DATA LEAKAGE: getP() is called BEFORE rate() for every match.
// Matches with no prior history for either team (confidence=0) are skipped.

const path = require('path');
const Database = require('better-sqlite3');
const { createEloSystem } = require('../lib/elo-rating');
const { classifyLeague } = require('../lib/lol-model');
const M = require('../lib/lol-match-metrics');

const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });

// All resolved LoL matches in strict chronological order (no leakage).
const games = db.prepare(`
  SELECT team1, team2, winner, final_score, league, resolved_at
  FROM match_results
  WHERE game='lol' AND winner IS NOT NULL AND winner!=''
    AND team1 IS NOT NULL AND team2 IS NOT NULL
  ORDER BY resolved_at ASC
`).all();

// halfLifeDays MUST be 0 for replay-mode backtest.
// The engine anchors time-decay to new Date() (today), so historical matches
// fed via rate() would get near-zero weight (a 2023 match at halfLife=60d
// gets weight 0.5^(1000/60) ≈ 0), preventing ratings from diverging.
// Time-decay belongs only in live-mode (where "now" is always current).
const elo = createEloSystem({
  kBase: 32,
  kMin: 10,
  kScale: 40,
  halfLifeDays: 0,
  confidenceScale: 20,
  confidenceFloor: 5,
});

const samples = []; // { p: P(team1 wins), y: 1 if team1 won }

for (const g of games) {
  const tier = classifyLeague(g.league);

  // PREDICT first (uses only past data already processed)
  const pred = elo.getP(g.team1, g.team2, tier);
  const y = (String(g.winner).toLowerCase() === String(g.team1).toLowerCase()) ? 1 : 0;

  if (pred.foundA && pred.foundB && pred.confidence > 0) {
    samples.push({ p: pred.pA, y, date: g.resolved_at, league: g.league });
  }

  // UPDATE after prediction (no leakage)
  const winner = y ? g.team1 : g.team2;
  const loser  = y ? g.team2 : g.team1;
  const sc = String(g.final_score || '').match(/(\d+)\s*[-:]\s*(\d+)/);
  const margin = sc ? Math.max(1, Math.abs(parseInt(sc[1]) - parseInt(sc[2]))) : 1;
  elo.rate(winner, loser, margin, g.resolved_at, tier);
}

db.close();

const base = M.blueSideBaseline(samples);
console.log(`[backtest] n=${samples.length}`);
console.log(`[backtest] Elo-only:  Brier=${M.brier(samples).toFixed(4)}  logloss=${M.logloss(samples).toFixed(4)}  ECE=${M.ece(samples).toFixed(4)}`);
console.log(`[backtest] baseline:  Brier=${base.brier.toFixed(4)} (pStar=${base.pStar.toFixed(3)})`);
console.log(`[backtest] Elo beats baseline OOS? ${M.brier(samples) < base.brier ? 'YES' : 'NO'}`);

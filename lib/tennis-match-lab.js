'use strict';
/**
 * tennis-match-lab.js — Display-only Tennis match analyzer for the /edge "Tennis Lab".
 * REUSES the production tennis model read-only (getTennisProbability ML ensemble for the
 * headline + the Markov engine for the markets). Does NOT build a parallel model (P3 —
 * tennis already has one). Money-path airtight: only read-only/pure functions; never
 * scanTennisMarkets / stake / Kelly / tips. fairOdd = 1/p, edge = p*odd-1 computed inline.
 */
const { getTennisProbability, detectSurface, tournamentTier } = require('./tennis-model');
const { priceTennisMatch, extractServeProbs, solvePointProbs, handicapGamesProb,
        estimateTennisAces, estimateTennisDoubleFaults } = require('./tennis-markov-model');
const { applyMarkovCalib } = require('./tennis-markov-calib');
const { getPlayerServeProfile, getPlayerRankInfo } = require('./tennis-player-stats');

// SPW médio ATP/WTA por superfície (ref. Sackmann) — ancora solvePointProbs no fallback.
const SPW_AVG = { hard: 0.637, clay: 0.611, grass: 0.662, indoor: 0.648 };

// getPlayerServeProfile retorna firstInPct/firstWonPct/secondWonPct em FRAÇÃO (0-1);
// serveSubModel/extractServeProbs querem ...Pct em PERCENT (0-100) + .games. Adapta.
function _serveStatsFromProfile(prof) {
  if (!prof || prof.firstInPct == null || prof.firstWonPct == null || prof.secondWonPct == null) return null;
  const spw = prof.firstInPct * prof.firstWonPct + (1 - prof.firstInPct) * prof.secondWonPct; // 0-1
  return {
    firstServePct: prof.firstInPct * 100,
    firstServePointsPct: prof.firstWonPct * 100,
    secondServePointsPct: prof.secondWonPct * 100,
    games: prof.matches,   // serveSubModel exige >= 2 (getPlayerServeProfile já garante >= 5)
    spw,                   // consumido pelo trained model (enrich.serveStats.spw)
  };
}

// P(total > line) a partir do pdf {games:prob}.
function _pOverFromPdf(pdf, line) {
  let s = 0;
  for (const [k, v] of Object.entries(pdf || {})) if (Number(k) > line) s += v;
  return s;
}

module.exports = { _serveStatsFromProfile, _pOverFromPdf };

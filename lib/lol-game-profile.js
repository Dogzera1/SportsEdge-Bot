'use strict';
/**
 * lol-game-profile.js — Display-only "match reading" layer for the Match Lab panel.
 *
 * DISPLAY-ONLY: MUST NOT be called from any stake/EV/Kelly/betting path. It only
 * enriches the /edge analyzer with phase profile, fair odds/edge, win condition,
 * comp style and a data-quality badge.
 *
 * Honesty contract (spec §2):
 *   - early phase = MEASURED (golddiff/xpdiff @15 real)
 *   - mid/late    = ESTIMATED (scaling via game length) — labeled, lower confidence
 *   - comp style  = QUALITATIVE (Riot class tags heuristic) — not validated vs outcome
 */
const { normalizeChampion, normalizeRole } = require('./lol-champions');

// ── Artifact load (lazy, once) ──
let _art = null;
function _loadArtifacts() {
  if (_art) return _art;
  _art = { timing: require('./lol-champion-timing.json'), tags: require('./lol-champion-tags.json') };
  return _art;
}

// ── Odds (display-only; NOT a stake/EV/Kelly path) ──
function fairOdds(probTeam1) {
  const p = Math.max(1e-6, Math.min(1 - 1e-6, probTeam1));
  return { team1: +(1 / p).toFixed(2), team2: +(1 / (1 - p)).toFixed(2) };
}

function computeEdge(probTeam1, bookOdds) {
  if (typeof bookOdds !== 'number' || !(bookOdds > 1)) return null;
  return +((probTeam1 * bookOdds) - 1).toFixed(3);
}

module.exports = { fairOdds, computeEdge, _loadArtifacts };

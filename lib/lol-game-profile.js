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

// ── Phase profile ──
function _normC(p) { return normalizeChampion(p.champion); }
function _normR(p) { return normalizeRole(p.role); }

function _meanGold(picks, timing) {
  let sum = 0, cnt = 0;
  for (const p of (picks || [])) { const c = timing.byChampRole[_normC(p) + '|' + _normR(p)]; if (c && c.n > 0) { sum += c.golddiff15; cnt++; } }
  return cnt ? sum / cnt : 0;
}
function _meanXp(picks, timing) {
  let sum = 0, cnt = 0;
  for (const p of (picks || [])) { const c = timing.byChampRole[_normC(p) + '|' + _normR(p)]; if (c && c.n > 0) { sum += c.xpdiff15; cnt++; } }
  return cnt ? sum / cnt : 0;
}
function _meanScaling(picks, timing) {
  let sum = 0, cnt = 0;
  for (const p of (picks || [])) { const s = timing.scaling[_normC(p)]; if (s) { sum += s.index; cnt++; } }
  return cnt ? sum / cnt : 0;
}
function _phaseFromScore(score, banda = 0.1) {
  const winner = score > banda ? 'blue' : score < -banda ? 'red' : 'even';
  const bars = Math.round(Math.min(1, Math.abs(score)) * 5);
  return { winner, bars };
}

function phaseEdges(draft, timing) {
  const goldDiff = _meanGold(draft.blue, timing) - _meanGold(draft.red, timing);
  const xpDiff = _meanXp(draft.blue, timing) - _meanXp(draft.red, timing);
  const scaleDiff = _meanScaling(draft.blue, timing) - _meanScaling(draft.red, timing);

  const earlyScore = Math.tanh(goldDiff / 500);   // ~500 gold saturates
  const lateScore = Math.tanh(scaleDiff / 0.10);  // ~0.10 wr diff saturates
  const midScore = (earlyScore + lateScore) / 2;

  return {
    early: { ..._phaseFromScore(earlyScore), edge: +earlyScore.toFixed(3), measured: true,
             anchor: { golddiff15: Math.round(goldDiff), xpdiff15: Math.round(xpDiff) }, confidence: 0.8 },
    mid:   { ..._phaseFromScore(midScore), edge: +midScore.toFixed(3), measured: false, label: 'transição', confidence: 0.4 },
    late:  { ..._phaseFromScore(lateScore), edge: +lateScore.toFixed(3), measured: false, label: 'estimativa', confidence: 0.45 },
  };
}

module.exports = { fairOdds, computeEdge, phaseEdges, _loadArtifacts };

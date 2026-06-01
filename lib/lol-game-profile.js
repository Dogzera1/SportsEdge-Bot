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

// ── Expected time & win condition ──
function expectedTime(allPicks, timing) {
  let sum = 0, n = 0;
  for (const p of (allPicks || [])) { const s = timing.expectedLen[_normC(p)]; if (s) { sum += s; n++; } }
  const seconds = n ? Math.round(sum / n) : 0;
  const min = seconds / 60;
  const bucket = !seconds ? 'desconhecido' : (min < 29 ? 'curto' : (min <= 34 ? 'médio' : 'longo'));
  return { seconds, bucket };
}

function winCondition(phases) {
  const e = phases.early.winner, l = phases.late.winner;
  const side = (w) => (w === 'blue' ? 'Azul' : 'Vermelho');
  if (e !== 'even' && e === l) return `${side(e)} favorecido em todas as fases.`;
  if (e !== 'even' && l !== 'even' && e !== l) return `${side(e)} leva a rota; precisa converter antes do ${side(l)} escalar pro late.`;
  if (e !== 'even' && l === 'even') return `${side(e)} leva a vantagem na rota; o jogo tende a equilibrar depois.`;
  if (e === 'even' && l !== 'even') return `Rota equilibrada; ${side(l)} tende a crescer no late.`;
  return 'Partida equilibrada; decisão tende a vir de execução, não de draft.';
}

// ── Comp style (QUALITATIVE — Riot class tags heuristic, not outcome-validated) ──
function compStyle(picks, tags) {
  const counts = { Assassin: 0, Fighter: 0, Tank: 0, Mage: 0, Marksman: 0, Support: 0 };
  let known = 0, attackSum = 0, attackN = 0;
  for (const p of (picks || [])) {
    const tag = tags[_normC(p)];
    if (!tag) continue;
    known++;
    for (const cls of (tag.tags || [])) if (cls in counts) counts[cls]++;
    if (tag.info && typeof tag.info.attack === 'number') { attackSum += tag.info.attack; attackN++; }
  }
  const frontline = counts.Tank + counts.Fighter;
  const avgAttack = attackN ? attackSum / attackN : 0;
  let style = 'balanceado';
  if (counts.Assassin >= 2) style = 'pick';
  else if (frontline >= 2 && counts.Mage >= 1) style = 'teamfight';
  else if (counts.Mage >= 2 && counts.Marksman >= 1) style = 'poke/siege';
  else if (counts.Fighter >= 2 && avgAttack >= 7) style = 'split';
  const denom = (picks && picks.length) ? picks.length : 5;
  const confidence = +Math.max(0.2, Math.min(0.6, (known / denom) * 0.6)).toFixed(2);
  return { style, confidence };
}

// ── Quality badge ──
function qualityBlock({ knownChamps = 0, totalChamps = 10, laneMatchups = [], eloConfidence = 0 }) {
  const avgLaneN = (laneMatchups && laneMatchups.length)
    ? Math.round(laneMatchups.reduce((s, l) => s + (l.n || 0), 0) / laneMatchups.length) : 0;
  const warnings = [];
  if (knownChamps < totalChamps) warnings.push(`${totalChamps - knownChamps} campeões sem dado`);
  if (laneMatchups && laneMatchups.length && avgLaneN < 20) warnings.push('amostra de rota baixa');
  const frac = totalChamps ? knownChamps / totalChamps : 0;
  let tier = 'baixa';
  if (frac >= 0.9 && avgLaneN >= 30 && eloConfidence >= 0.6) tier = 'alta';
  else if (frac >= 0.7) tier = 'média';
  return { knownChamps, totalChamps, avgLaneN, eloConfidence: +(eloConfidence || 0).toFixed(2), tier, warnings };
}

// ── Top-level: assemble the display-only game profile ──
function computeGameProfile(input, artifacts) {
  const art = artifacts || _loadArtifacts();
  const { draft, probTeam1, bookOdds = null, eloConfidence = 0, laneMatchups = [], knownChamps = 0, totalChamps = 10 } = input;

  let phases = null, expTime = null, winCond = null, comp = null;
  if (draft && Array.isArray(draft.blue) && draft.blue.length > 0) {
    phases = phaseEdges(draft, art.timing);
    const allPicks = [...draft.blue, ...(draft.red || [])];
    expTime = expectedTime(allPicks, art.timing);
    winCond = winCondition(phases);
    comp = { blue: compStyle(draft.blue, art.tags), red: compStyle(draft.red || [], art.tags) };
  }
  return {
    phases,
    expectedTime: expTime,
    winCondition: winCond,
    compStyle: comp,
    fairOdds: fairOdds(probTeam1),
    edge: computeEdge(probTeam1, bookOdds),
    quality: qualityBlock({ knownChamps, totalChamps, laneMatchups, eloConfidence }),
  };
}

module.exports = { fairOdds, computeEdge, phaseEdges, expectedTime, winCondition, compStyle, qualityBlock, computeGameProfile, _loadArtifacts };

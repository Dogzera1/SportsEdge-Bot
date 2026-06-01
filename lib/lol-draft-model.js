// lib/lol-draft-model.js — runtime draft win-prob engine (hybrid: logistic number + component breakdown).
const fs = require('fs');
const path = require('path');
const { normalizeChampion, normalizeRole } = require('./lol-champions');
const { sigmoid } = require('./lol-draft-train');

let _cache = null;
function _loadArtifacts() {
  if (_cache) return _cache;
  const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
  _cache = {
    meta: read('lol-draft-meta.json'),
    wr: read('lol-draft-wr.json'),
    matchups: read('lol-draft-matchups.json'),
    synergy: read('lol-draft-synergy.json'),
  };
  return _cache;
}
function invalidateCache() { _cache = null; }

function shrinkWr(wins, n, prior, k) {
  return (wins + k * prior) / (n + k);
}

function _wr(art, champ, role) {
  const cell = art.wr[`${champ}|${role}`];
  if (!cell) return { wr: art.meta.priorWr, n: 0 };
  return { wr: shrinkWr(cell.wins, cell.n, art.meta.priorWr, art.meta.shrinkK), n: cell.n };
}

function _laneDelta(art, blueChamp, redChamp, role) {
  const cell = art.matchups?.[role]?.[blueChamp]?.[redChamp];
  const n = cell ? cell.n : 0;
  const wr = cell ? shrinkWr(cell.wins, cell.n, art.meta.priorWr, art.meta.shrinkK) : art.meta.priorWr;
  return { deltaPp: (wr - 0.5) * 100, n };
}

function _synergy(art, champs) {
  let sum = 0, used = 0;
  for (let i = 0; i < champs.length; i++) for (let j = i + 1; j < champs.length; j++) {
    const cell = art.synergy[[champs[i], champs[j]].sort().join('|')];
    if (!cell) continue;
    sum += (shrinkWr(cell.wins, cell.n, art.meta.priorWr, art.meta.shrinkK) - 0.5);
    used++;
  }
  return { score: sum, pairs: used };
}

function computeDraftWinProb(draft, opts = {}, artifacts = null) {
  const art = artifacts || _loadArtifacts();
  const norm = (arr) => (arr || []).map(p => ({ c: normalizeChampion(p.champion), role: normalizeRole(p.role), raw: p.champion }));
  const blue = norm(draft.blue), red = norm(draft.red);

  let knownN = 0, totalN = 0;
  const blueWr = blue.map(p => { const w = _wr(art, p.c, p.role); totalN++; if (w.n > 0) knownN++; return w.wr; });
  const redWr = red.map(p => { const w = _wr(art, p.c, p.role); totalN++; if (w.n > 0) knownN++; return w.wr; });
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0.5;
  const wrDiff = avg(blueWr) - avg(redWr);

  const laneMatchups = [];
  let laneSum = 0;
  for (const b of blue) {
    const opp = red.find(r => r.role === b.role && b.role);
    if (!opp) continue;
    const d = _laneDelta(art, b.c, opp.c, b.role);
    laneSum += d.deltaPp / 100;
    laneMatchups.push({ role: b.role, blue: b.raw, red: opp.raw, deltaPp: +d.deltaPp.toFixed(1), n: d.n });
  }

  const sB = _synergy(art, blue.map(p => p.c).filter(Boolean));
  const sR = _synergy(art, red.map(p => p.c).filter(Boolean));
  const synergyDiff = sB.score - sR.score;
  const masteryDiff = 0; // wired in Phase 2 (needs player names + pro_player_champ_stats); 0 keeps weight inert

  const w = art.meta.weights; // [bias, wrDiff, lane, synergy, mastery]
  const z = w[0] + w[1] * wrDiff + w[2] * laneSum + w[3] * synergyDiff + w[4] * masteryDiff;
  const prob = Math.max(0, Math.min(1, sigmoid(z)));

  const confidence = Math.max(0.05, Math.min(1, (knownN / Math.max(1, totalN)) * (laneMatchups.filter(l => l.n >= 10).length / 5)));

  return {
    prob: +prob.toFixed(4),
    confidence: +confidence.toFixed(2),
    breakdown: {
      wrDiffPp: +(wrDiff * 100).toFixed(1),
      laneMatchups: laneMatchups.sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp)),
      synergyBluePairs: sB.pairs, synergyRedPairs: sR.pairs, synergyDiff: +synergyDiff.toFixed(3),
      knownChamps: knownN, totalChamps: totalN,
    },
  };
}

module.exports = { computeDraftWinProb, shrinkWr, invalidateCache };

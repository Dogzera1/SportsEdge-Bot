'use strict';
/**
 * dota-match-predict.js — Display-only Dota match predictor.
 * prob = Elo (calibrated). Draft is a SEPARATE read (WR), not in the number.
 * DISPLAY-ONLY: must not feed stake/EV/Kelly.
 */
const { createEloSystem } = require('./elo-rating');
const { getDraftMatchupFactor } = require('./dota-hero-features');
const { _applyIsotonicBlocks } = require('./brier-holdout-eval');
const META = require('./dota-match-meta.json');
const CALIB = require('./dota-match-calib.json');

let _elo = null, _eloTs = 0;
const ELO_TTL = 3600_000;
function _dotaElo(db) {
  if (_elo && Date.now() - _eloTs < ELO_TTL) return _elo;
  _elo = createEloSystem(META.eloConfig);
  _elo.bootstrap(db, 'dota2', () => undefined, { maxAgeDays: 100000 });
  _eloTs = Date.now();
  return _elo;
}

function predictMatch(db, { team1, team2, side = 'blue', draft = null } = {}) {
  const blueTeam = (side === 'blue') ? team1 : team2;
  const redTeam  = (side === 'blue') ? team2 : team1;

  let pEloBlue = null, eloConf = 0, ratingBlue = null, ratingRed = null;
  if (blueTeam && redTeam) {
    const e = _dotaElo(db).getP(blueTeam, redTeam);
    if (e.foundA && e.foundB && e.confidence > 0) { pEloBlue = e.pA; eloConf = e.confidence; ratingBlue = e.ratingA; ratingRed = e.ratingB; }
  }

  let probBlue = (pEloBlue == null) ? 0.5 : pEloBlue;
  if (pEloBlue != null && CALIB.blocks && CALIB.blocks.length > 0) probBlue = _applyIsotonicBlocks(CALIB.blocks, probBlue);
  probBlue = Math.max(0, Math.min(1, probBlue));
  const probTeam1 = (side === 'blue') ? probBlue : (1 - probBlue);

  // Draft READ (separate from the prob).
  let draftRead = null;
  if (draft && Array.isArray(draft.blue) && draft.blue.length > 0) {
    const f = getDraftMatchupFactor(db, draft.blue, draft.red || []);
    if (f) draftRead = { blueWR: f.blueWR, redWR: f.redWR, factor: f.factor };
  }

  let confidence, label;
  if (pEloBlue !== null) { confidence = eloConf; label = eloConf > 0.6 ? 'forte' : 'lean'; }
  else { confidence = 0.2; label = 'lean fraco'; }

  return {
    prob: +probTeam1.toFixed(4), probBlue: +probBlue.toFixed(4),
    components: {
      elo: pEloBlue !== null ? { pBlue: +pEloBlue.toFixed(4), confidence: +eloConf.toFixed(2), ratingBlue, ratingRed } : null,
      draft: draftRead,
    },
    confidence: +confidence.toFixed(2), label,
  };
}
module.exports = { predictMatch };

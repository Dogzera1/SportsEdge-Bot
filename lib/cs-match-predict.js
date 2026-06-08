'use strict';
/**
 * cs-match-predict.js — Display-only CS match predictor.
 * prob = Elo cs2 (calibrated). DISPLAY-ONLY: must not feed EV/Kelly/money-path.
 * Mirrors dota-match-predict.js; no draft (CS has no comp data in v1).
 */
const { createEloSystem } = require('./elo-rating');
const { _applyIsotonicBlocks } = require('./brier-holdout-eval');
const META = require('./cs-match-meta.json');
const CALIB = require('./cs-match-calib.json');

let _elo = null, _eloTs = 0;
const ELO_TTL = 3600_000;
function _csElo(db) {
  if (_elo && Date.now() - _eloTs < ELO_TTL) return _elo;
  _elo = createEloSystem(META.eloConfig);
  _elo.bootstrap(db, 'cs2', () => undefined, { maxAgeDays: 100000 });
  _eloTs = Date.now();
  return _elo;
}

function predictMatch(db, { team1, team2 } = {}) {
  let pElo = null, eloConf = 0, ratingT1 = null, ratingT2 = null, gamesT1 = 0, gamesT2 = 0;
  if (team1 && team2) {
    const e = _csElo(db).getP(team1, team2);
    if (e.foundA && e.foundB && e.confidence > 0) {
      pElo = e.pA;
      eloConf = e.confidence;
      ratingT1 = e.ratingA;
      ratingT2 = e.ratingB;
      gamesT1 = e.gamesA;
      gamesT2 = e.gamesB;
    }
  }
  let probTeam1 = (pElo == null) ? 0.5 : pElo;
  if (pElo != null && CALIB.blocks && CALIB.blocks.length > 0) {
    probTeam1 = _applyIsotonicBlocks(CALIB.blocks, probTeam1);
  }
  probTeam1 = Math.max(0, Math.min(1, probTeam1));

  let confidence, label;
  if (pElo !== null) {
    confidence = eloConf;
    label = eloConf > 0.6 ? 'forte' : 'lean';
  } else {
    confidence = 0.2;
    label = 'lean fraco';
  }

  return {
    prob: +probTeam1.toFixed(4),
    probTeam1: +probTeam1.toFixed(4),
    components: {
      elo: pElo !== null ? {
        pTeam1: +pElo.toFixed(4),
        confidence: +eloConf.toFixed(2),
        ratingTeam1: ratingT1,
        ratingTeam2: ratingT2,
        gamesTeam1: gamesT1,
        gamesTeam2: gamesT2,
      } : null,
    },
    confidence: +confidence.toFixed(2),
    label,
  };
}
module.exports = { predictMatch };

'use strict';
/**
 * lol-match-predict.js — Display-only LoL match predictor.
 *
 * Consumes the validated artifacts from Tasks 6-7:
 *   lib/lol-match-meta.json  — blend weights + eloConfig
 *   lib/lol-match-calib.json — isotonic PAV calibration blocks
 *
 * DISPLAY-ONLY: this module MUST NOT be called from any stake/EV/Kelly/betting
 * path. It exists solely for the /edge analyzer UI.
 *
 * Predicts P(team1 wins) given team names, which side team1 is on, and an
 * optional draft. Blend: P(blue side wins) via logistic(bias + w_elo*logit(pElo)
 * + w_draft*logit(pDraft)) → isotonic calibration → orient to team1.
 *
 * The Elo system uses meta.eloConfig (halfLifeDays=0, all-history) to exactly
 * reproduce the backtest's final Elo state — NOT the production _getElo which
 * uses halfLifeDays=60. Using the wrong Elo would break the fitted weights.
 */

const path = require('path');
const { createEloSystem } = require('./elo-rating');
const { classifyLeague } = require('./lol-model');
const { computeDraftWinProb } = require('./lol-draft-model');
const { _applyIsotonicBlocks } = require('./brier-holdout-eval');

// ── Artifact load (once at module load) ──

const META  = require('./lol-match-meta.json');
const CALIB = require('./lol-match-calib.json');

// ── Module-level Elo cache (1h TTL) ──
// Uses META.eloConfig (halfLifeDays=0) — all-history Elo matching the backtest.
// Distinct from lol-model._getElo (halfLifeDays=60, recent-weighted).

let _elo = null;
let _eloTs = 0;
const ELO_TTL = 3600_000; // 1 hour

function _matchLabElo(db) {
  if (_elo && Date.now() - _eloTs < ELO_TTL) return _elo;
  _elo = createEloSystem(META.eloConfig);
  _elo.bootstrap(db, 'lol', (row) => classifyLeague(row.league), { maxAgeDays: 100000 });
  _eloTs = Date.now();
  return _elo;
}

// ── Math helpers ──

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function logit(p) {
  const clamped = Math.max(1e-6, Math.min(1 - 1e-6, p));
  return Math.log(clamped / (1 - clamped));
}

// ── Core predictor ──

/**
 * Predict P(team1 wins) for a LoL match.
 *
 * @param {object} db         - better-sqlite3 DB instance
 * @param {object} opts
 * @param {string|null} opts.team1  - Team 1 name (or null)
 * @param {string|null} opts.team2  - Team 2 name (or null)
 * @param {string}      opts.side   - Which side team1 is on: 'blue'|'red' (default 'blue')
 * @param {object|null} opts.draft  - { blue:[{champion,role}], red:[{champion,role}] } or null
 * @param {string}      opts.league - Optional league name for Elo tier context
 *
 * @returns {{
 *   prob: number,         P(team1 wins), 4dp
 *   probBlue: number,     P(blue side wins), 4dp
 *   components: { elo: {pBlue,confidence}|null, draft: {pBlue}|null },
 *   confidence: number,   0-1, 2dp
 *   label: string,        'forte'|'lean'|'lean fraco'
 * }}
 */
function predictMatch(db, { team1, team2, side = 'blue', draft = null, league = null } = {}) {
  // 1. Orient: determine which team is on blue side
  const blueTeam = (side === 'blue') ? team1 : team2;
  const redTeam  = (side === 'blue') ? team2 : team1;

  // 2. Elo term — only when both teams are present
  let pEloBlue = null;
  let eloConf  = 0;

  if (blueTeam && redTeam) {
    const eloSys = _matchLabElo(db);
    const tier   = league ? classifyLeague(league) : undefined;
    const e      = eloSys.getP(blueTeam, redTeam, tier);
    if (e.foundA && e.foundB && e.confidence > 0) {
      pEloBlue = e.pA; // P(blueTeam wins)
      eloConf  = e.confidence;
    }
  }

  // 3. Draft term — only when draft.blue has at least one pick
  let pDraftBlue = null;
  if (draft && Array.isArray(draft.blue) && draft.blue.length > 0) {
    const d    = computeDraftWinProb(draft);
    pDraftBlue = d.prob; // P(blue side wins)
  }

  // 4. Blend
  let probBlue;

  if (pEloBlue === null && pDraftBlue === null) {
    // No information at all
    probBlue = 0.5;
  } else if (pEloBlue === null && pDraftBlue !== null) {
    // Draft-only: no blend/calib — weak lean
    probBlue = pDraftBlue;
  } else {
    // Full blend (Elo present; draft may or may not be present)
    const w = META.weights; // [bias, w_elo, w_draft]
    const xElo   = (pEloBlue   !== null) ? logit(pEloBlue)   : 0;
    const xDraft = (pDraftBlue !== null) ? logit(pDraftBlue) : 0;
    const z = w[0] + w[1] * xElo + w[2] * xDraft;
    probBlue = sigmoid(z);

    // Apply isotonic calibration
    if (CALIB.keptOOS && CALIB.blocks && CALIB.blocks.length > 0) {
      probBlue = _applyIsotonicBlocks(CALIB.blocks, probBlue);
    }
  }

  // Clamp to [0,1] for safety
  probBlue = Math.max(0, Math.min(1, probBlue));

  // 5. Orient to team1
  const probTeam1 = (side === 'blue') ? probBlue : (1 - probBlue);

  // 6. Confidence and label
  let confidence;
  let label;

  if (pEloBlue !== null) {
    confidence = eloConf;
    label      = eloConf > 0.6 ? 'forte' : 'lean';
  } else {
    confidence = 0.2;
    label      = 'lean fraco';
  }

  return {
    prob:      +probTeam1.toFixed(4),
    probBlue:  +probBlue.toFixed(4),
    components: {
      elo:   pEloBlue   !== null ? { pBlue: +pEloBlue.toFixed(4),   confidence: +eloConf.toFixed(2) } : null,
      draft: pDraftBlue !== null ? { pBlue: +pDraftBlue.toFixed(4) }                                  : null,
      // form intentionally NOT included — dropped from blend (hurt OOS)
    },
    confidence: +confidence.toFixed(2),
    label,
  };
}

module.exports = { predictMatch };

'use strict';

/**
 * lol-model.js — LoL-specific probability model.
 *
 * Combines 3 sub-models for superior probability estimation:
 *   A) Team Elo (40%) — from match_results via universal Elo engine
 *   B) Draft/Composition Score (35%) — from pro_champ_stats + pro_player_champ_stats
 *   C) Recent Form Momentum (25%) — weighted recent results with streaks
 *
 * ADDITIVE: used alongside the existing esportsPreFilter, not replacing it.
 *
 * Usage:
 *   const { getLolProbability } = require('./lol-model');
 *   const result = getLolProbability(db, match, odds, enrich, compScore);
 *   // result = { modelP1, modelP2, confidence, method, factors: [...] }
 */

const { createEloSystem, eloExpected } = require('./elo-rating');
const { log, norm } = require('./utils');
const { seriesProbFromMap, mapProbFromSeries, shrinkForBestOf } = require('./lol-series-model');
const { getTeamRegionalOffset, invalidateRegionalCache } = require('./lol-regional-strength');
const { devigMultiplicative } = require('./devig');
const { matchStage, stageConfidenceMultiplier } = require('./esports-runtime-features');

function _parseBestOf(format, finalScore) {
  for (const s of [format, finalScore]) {
    if (!s) continue;
    const m = String(s).match(/Bo(\d)/i);
    if (m) return parseInt(m[1], 10) || 1;
  }
  return 1;
}

const TAG = 'LOL-MODEL';

// ── Sub-model weights ──
const W_ELO  = 0.40;
const W_COMP = 0.35;
const W_FORM = 0.25;

// ── Elo singleton (lazy-initialized, cached 1h) ──
let _eloSystem = null;
let _eloBootstrapTs = 0;
const ELO_CACHE_TTL = 60 * 60 * 1000; // 1h

// Major leagues get higher K-factor (more predictive signal)
const MAJOR_LEAGUES = ['lck', 'lpl', 'lec', 'lcs', 'worlds', 'msi', 'wcs'];

/**
 * Classify a league string into a tier context for Elo.
 * @param {string} league
 * @returns {string} 'tier1' or 'tier2'
 */
function classifyLeague(league) {
  if (!league) return 'tier2';
  const l = String(league).toLowerCase();
  for (const major of MAJOR_LEAGUES) {
    if (l.includes(major)) return 'tier1';
  }
  return 'tier2';
}

/**
 * Get or bootstrap the LoL Elo system.
 * @param {object} db - better-sqlite3 database instance (raw db, not {db, stmts})
 */
function _getElo(db) {
  const now = Date.now();
  if (_eloSystem && (now - _eloBootstrapTs) < ELO_CACHE_TTL) {
    return _eloSystem;
  }

  _eloSystem = createEloSystem({
    initialRating: 1500,
    kBase: 32,
    kMin: 10,
    kScale: 40,
    halfLifeDays: 60,       // esports changes fast
    homeAdvantage: 0,       // no home advantage in LoL
    marginFactor: 0.5,      // Bo3 score matters: 2-0 vs 2-1
    confidenceScale: 20,
    confidenceFloor: 5,
  });

  _eloSystem.bootstrap(db, 'lol', (row) => classifyLeague(row.league), { maxAgeDays: 365 });
  _eloBootstrapTs = now;

  return _eloSystem;
}

/** Force Elo cache invalidation (call after settlement). */
function invalidateLolEloCache() {
  _eloSystem = null;
  _eloBootstrapTs = 0;
  invalidateRegionalCache();
}

// ── Sub-model A: Team Elo ──

/**
 * Get Elo-based win probability for two LoL teams.
 * @param {object} db
 * @param {string} team1
 * @param {string} team2
 * @param {string} [league]
 * @returns {{ pA: number, pB: number, confidence: number, ratingA: number, ratingB: number }}
 */
function _eloSubModel(db, team1, team2, league) {
  const elo = _getElo(db);
  const tier = classifyLeague(league);

  // Try context-specific (tier) first, then fall back to overall
  const result = elo.getP(team1, team2, tier);

  // Inter-regional adjustment: LCK 1900 ≠ LCS 1900. Aplica offset em Elo points
  // derivado de histórico de Worlds/MSI/First Stand. Só afeta quando regiões
  // diferem (a maioria dos matches é doméstico — offsetA=offsetB → cancela).
  let pA = result.pA, pB = result.pB;
  let regAdj = 0;
  try {
    const offA = getTeamRegionalOffset(db, team1, league);
    const offB = getTeamRegionalOffset(db, team2, league);
    regAdj = offA - offB;
    if (regAdj !== 0) {
      pA = eloExpected(result.ratingA + offA, result.ratingB + offB);
      pB = 1 - pA;
    }
  } catch (e) {
    log('WARN', TAG, `regional offset error: ${e.message}`);
  }

  return {
    pA, pB,
    confidence: result.confidence,
    ratingA: result.ratingA,
    ratingB: result.ratingB,
    gamesA: result.gamesA,
    gamesB: result.gamesB,
    foundA: result.foundA,
    foundB: result.foundB,
    regionalAdj: regAdj,
  };
}

// ── Sub-model B: Draft / Composition Score ──

/**
 * Evaluate draft strength using pro_champ_stats and pro_player_champ_stats.
 *
 * @param {object} db - raw better-sqlite3 db
 * @param {number|null} compScore - pre-computed compScore from collectGameContext (pp diff)
 * @param {object} [enrich] - enrichment data (may contain draft info)
 * @returns {{ pA: number, pB: number, confidence: number }}
 */
function _compSubModel(db, compScore, enrich) {
  // If compScore is available (calculated from live draft data), use it directly
  if (compScore !== null && !isNaN(compScore) && compScore !== 0) {
    // compScore is in percentage points: positive = t1 favored
    // Convert to probability adjustment using logistic function
    // A compScore of +5pp maps to ~55% for t1, -5pp maps to ~45%
    const logit = compScore * 0.04; // scale factor: 5pp -> 0.2 logit
    const pA = 1 / (1 + Math.exp(-logit));
    const pB = 1 - pA;

    // Confidence based on magnitude: larger compScore = more confident draft edge
    const confidence = Math.min(1.0, Math.abs(compScore) / 15);

    return { pA, pB, confidence };
  }

  // No compScore available: try to compute from DB using champion stats freshness
  // This is the fallback when draft data isn't available (pre-game, no live data)
  // We check if pro_champ_stats has recent data (updated in last 30 days)
  let freshChampData = false;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM pro_champ_stats
      WHERE updated_at >= datetime('now', '-30 days') AND total >= 10
    `).get();
    freshChampData = row && row.cnt >= 20; // at least 20 champions with fresh stats
  } catch (_) {}

  if (!freshChampData) {
    return { pA: 0.5, pB: 0.5, confidence: 0 };
  }

  // Without live draft, we can't compute comp advantage
  // Return neutral with low confidence
  return { pA: 0.5, pB: 0.5, confidence: 0 };
}

// ── Sub-model C: Recent Form Momentum ──

/**
 * Calculate form-based probability from recent match results.
 * Uses exponential decay weighting, streak bonuses, and opponent-quality adjustment.
 *
 * @param {object} db - raw better-sqlite3 db
 * @param {string} team1
 * @param {string} team2
 * @param {object} [enrich] - enrichment data with form1, form2
 * @returns {{ pA: number, pB: number, confidence: number, streak1: number, streak2: number }}
 */
function _formSubModel(db, team1, team2, enrich) {
  // Get recent matches from DB (last 60 days, up to 10 matches)
  let rows1, rows2;
  try {
    rows1 = db.prepare(`
      SELECT team1, team2, winner, final_score, league, resolved_at
      FROM match_results
      WHERE (lower(team1) = lower(?) OR lower(team2) = lower(?))
        AND game = 'lol'
        AND winner IS NOT NULL AND winner != ''
        AND resolved_at >= datetime('now', '-60 days')
      ORDER BY resolved_at DESC
      LIMIT 10
    `).all(team1, team1);
  } catch (_) { rows1 = []; }

  try {
    rows2 = db.prepare(`
      SELECT team1, team2, winner, final_score, league, resolved_at
      FROM match_results
      WHERE (lower(team1) = lower(?) OR lower(team2) = lower(?))
        AND game = 'lol'
        AND winner IS NOT NULL AND winner != ''
        AND resolved_at >= datetime('now', '-60 days')
      ORDER BY resolved_at DESC
      LIMIT 10
    `).all(team2, team2);
  } catch (_) { rows2 = []; }

  // Also consider enrichment data as fallback
  const hasDbForm1 = rows1.length >= 3;
  const hasDbForm2 = rows2.length >= 3;

  // If neither side has enough DB data, use enrichment entirely
  if (!hasDbForm1 && !hasDbForm2) {
    return _formFromEnrich(enrich);
  }

  // If only one side lacks DB data, try fuzzy match before falling back to enrich
  if (!hasDbForm1 && rows1.length < 3) {
    try {
      const fuzzy = `%${team1}%`;
      const fuzzyRows = db.prepare(`
        SELECT team1, team2, winner, final_score, league, resolved_at
        FROM match_results
        WHERE (lower(team1) LIKE lower(?) OR lower(team2) LIKE lower(?))
          AND game = 'lol' AND winner IS NOT NULL AND winner != ''
          AND resolved_at >= datetime('now', '-60 days')
        ORDER BY resolved_at DESC LIMIT 10
      `).all(fuzzy, fuzzy);
      if (fuzzyRows.length >= 3) rows1 = fuzzyRows;
    } catch (_) {}
  }
  if (!hasDbForm2 && rows2.length < 3) {
    try {
      const fuzzy = `%${team2}%`;
      const fuzzyRows = db.prepare(`
        SELECT team1, team2, winner, final_score, league, resolved_at
        FROM match_results
        WHERE (lower(team1) LIKE lower(?) OR lower(team2) LIKE lower(?))
          AND game = 'lol' AND winner IS NOT NULL AND winner != ''
          AND resolved_at >= datetime('now', '-60 days')
        ORDER BY resolved_at DESC LIMIT 10
      `).all(fuzzy, fuzzy);
      if (fuzzyRows.length >= 3) rows2 = fuzzyRows;
    } catch (_) {}
  }

  // If still insufficient for one side after fuzzy, fall back to enrich
  if (rows1.length < 3 && rows2.length < 3) {
    return _formFromEnrich(enrich);
  }

  const score1 = _calcFormScore(rows1, team1, db);
  const score2 = _calcFormScore(rows2, team2, db);

  // Calculate streaks
  const streak1 = _calcStreakFromRows(rows1, team1);
  const streak2 = _calcStreakFromRows(rows2, team2);

  // Convert form scores to probability
  // formScore range is roughly [-1, +1], use logistic transform
  const diff = score1 - score2;
  const logit = diff * 1.5; // scaling factor
  const pA = 1 / (1 + Math.exp(-logit));
  const pB = 1 - pA;

  // Confidence based on sample size (use max of actual rows to not penalize one-sided data)
  const avgGames = (rows1.length + rows2.length) / 2;
  const confidence = Math.min(1.0, avgGames / 8);

  return { pA, pB, confidence, streak1, streak2 };
}

/**
 * Calculate a form score from recent match rows.
 * Incorporates: exponential recency decay, streak bonus, opponent-quality adjustment.
 *
 * @param {Array} rows - match_results rows, most recent first
 * @param {string} team - the team whose perspective we evaluate
 * @param {object} db - for opponent Elo lookups
 * @returns {number} score in roughly [-1, +1]
 */
function _calcFormScore(rows, team, db) {
  if (!rows.length) return 0;

  const teamNorm = norm(team);
  let weightedSum = 0;
  let totalWeight = 0;
  let streak = 0;
  let streakActive = true;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const won = norm(r.winner) === teamNorm ||
                (norm(r.team1) === teamNorm && norm(r.winner) === norm(r.team1)) ||
                (norm(r.team2) === teamNorm && norm(r.winner) === norm(r.team2));

    // Exponential recency decay: weight = 0.85^i (most recent = 1.0)
    const recencyWeight = Math.pow(0.85, i);

    // Opponent quality adjustment using Elo if available
    let oppQualityMult = 1.0;
    if (db && _eloSystem) {
      const opponent = norm(r.team1) === teamNorm ? r.team2 : r.team1;
      const oppRating = _eloSystem.getRating(opponent);
      if (oppRating && oppRating.rating) {
        // Above-average opponent (>1500): beating them counts more
        // Below-average opponent (<1500): beating them counts less
        const ratingDiff = (oppRating.rating - 1500) / 400; // normalized
        oppQualityMult = 1.0 + ratingDiff * 0.3; // +30% for rating 1900, -30% for rating 1100
        oppQualityMult = Math.max(0.5, Math.min(1.5, oppQualityMult));
      }
    }

    const result = won ? 1.0 : -1.0;

    // Margin bonus: check final_score for dominant wins
    let marginBonus = 0;
    if (r.final_score) {
      const m = String(r.final_score).match(/(\d+)\s*[-:]\s*(\d+)/);
      if (m) {
        const s1 = parseInt(m[1], 10);
        const s2 = parseInt(m[2], 10);
        const isT1 = norm(r.team1) === teamNorm;
        const myScore = isT1 ? s1 : s2;
        const theirScore = isT1 ? s2 : s1;
        if (won && myScore > theirScore) {
          marginBonus = (myScore - theirScore) * 0.1; // 2-0 = +0.2, 3-0 = +0.3
        }
      }
    }

    const matchValue = (result + marginBonus) * oppQualityMult;
    weightedSum += matchValue * recencyWeight;
    totalWeight += recencyWeight;

    // Track streak
    if (streakActive) {
      if (i === 0) {
        streak = won ? 1 : -1;
      } else if ((won && streak > 0) || (!won && streak < 0)) {
        streak += won ? 1 : -1;
      } else {
        streakActive = false;
      }
    }
  }

  let formScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // Streak bonus: 3+ wins = +0.15, 4+ = +0.25, 5+ = +0.35
  // Negative streaks penalize similarly
  if (Math.abs(streak) >= 3) {
    const streakBonus = Math.min(0.35, (Math.abs(streak) - 2) * 0.10);
    formScore += streak > 0 ? streakBonus : -streakBonus;
  }

  // Clamp to [-1.5, +1.5]
  return Math.max(-1.5, Math.min(1.5, formScore));
}

/**
 * Calculate streak from rows.
 */
function _calcStreakFromRows(rows, team) {
  if (!rows.length) return 0;
  const teamNorm = norm(team);
  let streak = 0;
  for (const r of rows) {
    const won = norm(r.winner) === teamNorm ||
                (norm(r.team1) === teamNorm && norm(r.winner) === norm(r.team1)) ||
                (norm(r.team2) === teamNorm && norm(r.winner) === norm(r.team2));
    if (streak === 0) {
      streak = won ? 1 : -1;
    } else if ((won && streak > 0) || (!won && streak < 0)) {
      streak += won ? 1 : -1;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Fallback: derive form probability from enrich data (when DB has insufficient rows).
 */
function _formFromEnrich(enrich) {
  if (!enrich) return { pA: 0.5, pB: 0.5, confidence: 0, streak1: 0, streak2: 0 };

  const f1 = enrich.form1;
  const f2 = enrich.form2;
  const gf1 = enrich.grid?.form1;
  const gf2 = enrich.grid?.form2;

  // Use DB form or GRID form, whichever has more data
  const form1 = (f1 && (f1.wins + f1.losses) >= 3) ? f1 : ((gf1 && (gf1.wins + gf1.losses) >= 3) ? gf1 : null);
  const form2 = (f2 && (f2.wins + f2.losses) >= 3) ? f2 : ((gf2 && (gf2.wins + gf2.losses) >= 3) ? gf2 : null);

  if (!form1 && !form2) {
    return { pA: 0.5, pB: 0.5, confidence: 0, streak1: 0, streak2: 0 };
  }

  const wr1 = form1 ? (form1.winRate || 0) : 50;
  const wr2 = form2 ? (form2.winRate || 0) : 50;

  // Parse streaks
  const parseStreak = (s) => {
    if (typeof s === 'number') return s;
    if (!s || s === '—') return 0;
    const m = String(s).match(/^(\d+)([WLD])$/);
    if (!m) return 0;
    const count = parseInt(m[1], 10);
    return m[2] === 'W' ? count : (m[2] === 'L' ? -count : 0);
  };

  const streak1 = form1 ? parseStreak(form1.streak) : 0;
  const streak2 = form2 ? parseStreak(form2.streak) : 0;

  // Convert WR difference to probability
  const wrDiff = (wr1 - wr2) / 100; // normalized to [-1, +1]
  const logit = wrDiff * 1.2;
  const pA = 1 / (1 + Math.exp(-logit));
  const pB = 1 - pA;

  const totalGames = ((form1?.wins || 0) + (form1?.losses || 0) + (form2?.wins || 0) + (form2?.losses || 0));
  const confidence = Math.min(0.6, totalGames / 20); // cap at 0.6 for enrich-only

  return { pA, pB, confidence, streak1, streak2 };
}

// ── Main entry point ──

/**
 * Generate LoL-specific probability estimate by combining 3 sub-models.
 *
 * @param {object} db - raw better-sqlite3 database instance
 * @param {object} match - { team1, team2, league, game, format, status }
 * @param {object} odds - { t1: '1.50', t2: '2.80' }
 * @param {object} enrich - enrichment data (form1, form2, h2h, grid, etc.)
 * @param {number|null} compScore - composition score from collectGameContext (pp diff)
 * @returns {{ modelP1: number, modelP2: number, confidence: number, method: string, factors: Array }}
 */
function getLolProbability(db, match, odds, enrich, compScore) {
  const team1 = match.team1 || match.participant1_name;
  const team2 = match.team2 || match.participant2_name;
  const league = match.league || '';

  const factors = [];
  let totalWeight = 0;
  let blendedP1 = 0;

  // ── Implied probability (prior) ──
  let impliedP1 = 0.5;
  let impliedP2 = 0.5;
  const dj = odds?.t1 ? devigMultiplicative(odds.t1, odds.t2 || '2.00') : null;
  if (dj) { impliedP1 = dj.p1; impliedP2 = dj.p2; }

  // ── Sub-model A: Team Elo (weight 0.40) ──
  try {
    const elo = _eloSubModel(db, team1, team2, league);

    if (elo.foundA && elo.foundB && elo.confidence > 0) {
      const effectiveWeight = W_ELO * elo.confidence;
      blendedP1 += elo.pA * effectiveWeight;
      totalWeight += effectiveWeight;
      factors.push({
        name: 'elo',
        pA: elo.pA,
        pB: elo.pB,
        weight: effectiveWeight,
        confidence: elo.confidence,
        detail: `${team1} ${elo.ratingA} vs ${team2} ${elo.ratingB} (${elo.gamesA}/${elo.gamesB} games)`,
      });
    }
  } catch (e) {
    log('WARN', TAG, `Elo sub-model error: ${e.message}`);
  }

  // ── Sub-model B: Draft/Composition (weight 0.35) ──
  try {
    const comp = _compSubModel(db, compScore, enrich);

    if (comp.confidence > 0) {
      const effectiveWeight = W_COMP * comp.confidence;
      blendedP1 += comp.pA * effectiveWeight;
      totalWeight += effectiveWeight;
      factors.push({
        name: 'comp',
        pA: comp.pA,
        pB: comp.pB,
        weight: effectiveWeight,
        confidence: comp.confidence,
        detail: compScore !== null ? `compScore=${compScore.toFixed(1)}pp` : 'no draft data',
      });
    }
  } catch (e) {
    log('WARN', TAG, `Comp sub-model error: ${e.message}`);
  }

  // ── Sub-model C: Recent Form Momentum (weight 0.25) ──
  try {
    const form = _formSubModel(db, team1, team2, enrich);

    if (form.confidence > 0) {
      const effectiveWeight = W_FORM * form.confidence;
      blendedP1 += form.pA * effectiveWeight;
      totalWeight += effectiveWeight;
      factors.push({
        name: 'form',
        pA: form.pA,
        pB: form.pB,
        weight: effectiveWeight,
        confidence: form.confidence,
        detail: `streak: ${team1}=${form.streak1 || 0}, ${team2}=${form.streak2 || 0}`,
      });
    }
  } catch (e) {
    log('WARN', TAG, `Form sub-model error: ${e.message}`);
  }

  // ── Blend sub-models ──
  let modelP1, modelP2;
  let method;

  if (totalWeight > 0) {
    // Normalize blended probability
    const rawModelP1 = blendedP1 / totalWeight;

    // Blend model probability with implied (market) probability
    // More confident model = more weight on model, less on market
    // totalWeight ranges from ~0 (no data) to ~1.0 (all sub-models at full confidence)
    const modelWeight = Math.min(0.80, totalWeight); // cap: never trust model > 80% vs market
    modelP1 = rawModelP1 * modelWeight + impliedP1 * (1 - modelWeight);
    modelP2 = 1 - modelP1;
    method = factors.map(f => f.name).join('+');
  } else {
    // No sub-model data: fall back to implied probability
    modelP1 = impliedP1;
    modelP2 = impliedP2;
    method = 'implied';
  }

  // Sanity clamp: never go below 5% or above 95%
  modelP1 = Math.max(0.05, Math.min(0.95, modelP1));
  modelP2 = 1 - modelP1;

  // Overall confidence: average of sub-model confidences weighted by their weights
  let confidence = totalWeight > 0
    ? Math.min(1.0, factors.reduce((sum, f) => sum + f.confidence * f.weight, 0) / totalWeight)
    : 0;

  // Stage boost: high-stakes (international/playoffs) reduce variance —
  // full effort, prep intensiva, menos sandbagging/rotação de sub.
  const stage = matchStage(league);
  if (stage !== 'regular' && confidence > 0) {
    confidence = Math.min(1.0, confidence * stageConfidenceMultiplier(stage));
  }

  // modelP1 é série-level (Elo treinado em resultados de série). Pra mercados
  // de mapa individual, inverte pro nível de mapa sob independência. Momentum
  // é aplicado só se o consumidor pedir simulação explícita.
  const bestOf = _parseBestOf(match.format, match.final_score);
  // Shrinkage: BO1 tem variância alta; puxa P de volta pra 0.5 antes de expor.
  // BO3 mild, BO5 no-op — ver lol-series-model.shrinkForBestOf.
  if (bestOf <= 1 && modelP1 !== impliedP1) {
    modelP1 = shrinkForBestOf(modelP1, bestOf);
    modelP2 = 1 - modelP1;
  }
  let mapP1 = modelP1;
  let mapP2 = modelP2;
  if (bestOf >= 3) {
    mapP1 = mapProbFromSeries(modelP1, bestOf);
    mapP2 = 1 - mapP1;
  }

  return {
    modelP1: Math.round(modelP1 * 10000) / 10000,
    modelP2: Math.round(modelP2 * 10000) / 10000,
    mapP1: Math.round(mapP1 * 10000) / 10000,
    mapP2: Math.round(mapP2 * 10000) / 10000,
    bestOf,
    stage,
    confidence: Math.round(confidence * 100) / 100,
    method,
    factors,
    impliedP1,
    impliedP2,
  };
}

module.exports = {
  getLolProbability,
  invalidateLolEloCache,
  classifyLeague,
  // Series utilities (re-export)
  seriesProbFromMap,
  mapProbFromSeries,
  shrinkForBestOf,
  // Exposed for testing
  _eloSubModel,
  _compSubModel,
  _formSubModel,
};

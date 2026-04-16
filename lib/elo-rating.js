'use strict';

/**
 * elo-rating.js — Universal Elo Engine with professional-bettor features.
 *
 * Features:
 *   1. Time-decay: recent matches weighted more (configurable half-life)
 *   2. Context variants: surface/map/league can have separate ratings
 *   3. Margin-of-victory adjustment: winning 3-0 vs 3-2 affects K differently
 *   4. Sample confidence: returns confidence 0-1 based on games played
 *   5. Bootstrap from DB: can initialize from match_results table
 *
 * Usage:
 *   const { createEloSystem, eloExpected } = require('./elo-rating');
 *   const elo = createEloSystem({ kBase: 32, halfLifeDays: 60 });
 *   elo.bootstrap(db, 'lol', row => row.league.includes('LCK') ? 'tier1' : 'tier2');
 *   const { pA, pB, confidence } = elo.getP('T1', 'Gen.G', 'tier1');
 */

const { log } = require('./utils');

const TAG = 'ELO';

// ── Core Elo math ──

/**
 * Standard Elo expected score: P(A wins) given ratings rA, rB.
 */
function eloExpected(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

// ── Normalization ──

function _norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
}

// ── Factory ──

/**
 * Create a configurable Elo system.
 *
 * @param {object} config
 * @param {number} [config.initialRating=1500]
 * @param {number} [config.kBase=32]         - Base K-factor for new players
 * @param {number} [config.kMin=10]          - Minimum K-factor after many games
 * @param {number} [config.kScale=40]        - Games until K reaches kMin
 * @param {number} [config.halfLifeDays=0]   - Time decay half-life in days (0 = disabled)
 * @param {number} [config.homeAdvantage=0]  - Elo points added to home/T1 side
 * @param {number} [config.marginFactor=0]   - 0 = ignore margin, 1 = full margin adjustment
 * @param {number} [config.confidenceScale=20] - Games needed for full confidence
 * @param {number} [config.confidenceFloor=5]  - Games below which confidence = 0
 */
function createEloSystem(config = {}) {
  const C = {
    initialRating:   config.initialRating   ?? 1500,
    kBase:           config.kBase           ?? 32,
    kMin:            config.kMin            ?? 10,
    kScale:          config.kScale          ?? 40,
    halfLifeDays:    config.halfLifeDays    ?? 0,
    homeAdvantage:   config.homeAdvantage   ?? 0,
    marginFactor:    config.marginFactor    ?? 0,
    confidenceScale: config.confidenceScale ?? 20,
    confidenceFloor: config.confidenceFloor ?? 5,
  };

  // ── Internal state ──
  // ratings: Map<normalizedName, Map<context, { rating, games, lastDate }>>
  // The special context key '_all' holds the overall (context-free) rating.
  const ratings = new Map();

  // ── Helpers ──

  function _getEntry(name, context) {
    const nk = _norm(name);
    if (!ratings.has(nk)) {
      ratings.set(nk, { name, contexts: new Map() });
    }
    const player = ratings.get(nk);
    // Store canonical name (last seen spelling)
    player.name = name;
    const ctx = context || '_all';
    if (!player.contexts.has(ctx)) {
      player.contexts.set(ctx, { rating: C.initialRating, games: 0, lastDate: null });
    }
    return player.contexts.get(ctx);
  }

  function _kFactor(games) {
    const ratio = Math.min(1, games / C.kScale);
    return C.kBase - (C.kBase - C.kMin) * ratio;
  }

  /**
   * Time-decay multiplier: how much a result at `matchDate` should count
   * relative to a result today. Returns 1.0 for recent matches, decaying
   * towards 0 for old matches.
   */
  function _timeDecay(matchDate, referenceDate) {
    if (!C.halfLifeDays || C.halfLifeDays <= 0 || !matchDate) return 1.0;
    const ref = referenceDate ? new Date(referenceDate) : new Date();
    const match = new Date(matchDate);
    const daysDiff = Math.max(0, (ref.getTime() - match.getTime()) / (1000 * 60 * 60 * 24));
    // Exponential decay: weight = 0.5^(days/halfLife)
    return Math.pow(0.5, daysDiff / C.halfLifeDays);
  }

  /**
   * Margin-of-victory K multiplier.
   * margin > 0 means dominant win. E.g. in Bo3: 2-0 = margin 2, 2-1 = margin 1.
   * The adjustment scales K up for dominant wins and down for close wins.
   */
  function _marginMultiplier(margin) {
    if (C.marginFactor <= 0 || !margin || margin <= 0) return 1.0;
    // Log-based scaling: ln(margin+1) / ln(2) gives ~1.0 for margin=1, ~1.58 for margin=2, ~2.0 for margin=3
    const raw = Math.log(margin + 1) / Math.log(2);
    // Blend with marginFactor: at marginFactor=0 this is 1.0, at marginFactor=1 it's the full raw
    return 1.0 + (raw - 1.0) * C.marginFactor;
  }

  // ── Public API ──

  /**
   * Record a match result and update Elo ratings.
   *
   * @param {string} winner  - Winner name
   * @param {string} loser   - Loser name
   * @param {number} [margin=1] - Victory margin (e.g., score difference, 2 for 2-0)
   * @param {string|Date} [date] - Match date (for time decay)
   * @param {string} [context]   - Context key (e.g., 'tier1', 'hard', 'dust2')
   */
  function rate(winner, loser, margin, date, context) {
    margin = margin || 1;

    // Update both the specific context and the global '_all' context
    const contexts = context ? [context, '_all'] : ['_all'];

    for (const ctx of contexts) {
      const wEntry = _getEntry(winner, ctx);
      const lEntry = _getEntry(loser, ctx);

      // Calculate effective ratings (home advantage on winner side for T1)
      const wRating = wEntry.rating;
      const lRating = lEntry.rating;

      const expW = eloExpected(wRating, lRating);

      // K-factor: base K adjusted by games played
      const kW = _kFactor(wEntry.games);
      const kL = _kFactor(lEntry.games);

      // Margin multiplier
      const mMult = _marginMultiplier(margin);

      // Time decay: recent results count more
      const decay = _timeDecay(date, null);

      // Final K = base K * margin multiplier * time decay
      const effKW = kW * mMult * decay;
      const effKL = kL * mMult * decay;

      wEntry.rating += effKW * (1 - expW);
      lEntry.rating += effKL * (0 - (1 - expW));
      wEntry.games++;
      lEntry.games++;
      if (date) {
        wEntry.lastDate = date;
        lEntry.lastDate = date;
      }
    }
  }

  /**
   * Get win probability for playerA vs playerB.
   *
   * @param {string} playerA
   * @param {string} playerB
   * @param {string} [context] - If given, blends context-specific + overall rating
   * @returns {{ pA: number, pB: number, confidence: number, ratingA: number, ratingB: number, gamesA: number, gamesB: number, foundA: boolean, foundB: boolean }}
   */
  function getP(playerA, playerB, context) {
    const nA = _norm(playerA);
    const nB = _norm(playerB);

    const pDataA = ratings.get(nA);
    const pDataB = ratings.get(nB);

    const foundA = !!pDataA;
    const foundB = !!pDataB;

    // Get overall ratings
    const allA = pDataA?.contexts.get('_all');
    const allB = pDataB?.contexts.get('_all');

    let ratingA = allA?.rating ?? C.initialRating;
    let ratingB = allB?.rating ?? C.initialRating;
    let gamesA = allA?.games ?? 0;
    let gamesB = allB?.games ?? 0;

    // If context is specified, blend context-specific + overall
    if (context && context !== '_all') {
      const ctxA = pDataA?.contexts.get(context);
      const ctxB = pDataB?.contexts.get(context);

      if (ctxA && ctxA.games >= 3) {
        // Blend: weight context proportionally to games played in that context
        const ctxWeight = Math.min(0.75, ctxA.games / C.confidenceScale * 0.75);
        ratingA = ctxA.rating * ctxWeight + ratingA * (1 - ctxWeight);
        gamesA = Math.max(gamesA, ctxA.games);
      }
      if (ctxB && ctxB.games >= 3) {
        const ctxWeight = Math.min(0.75, ctxB.games / C.confidenceScale * 0.75);
        ratingB = ctxB.rating * ctxWeight + ratingB * (1 - ctxWeight);
        gamesB = Math.max(gamesB, ctxB.games);
      }
    }

    // Apply home advantage to playerA
    const effA = ratingA + C.homeAdvantage;

    const pA = eloExpected(effA, ratingB);
    const pB = 1 - pA;

    // Confidence: based on minimum games between the two players
    const minGames = Math.min(gamesA, gamesB);
    let confidence = 0;
    if (minGames >= C.confidenceFloor) {
      confidence = Math.min(1.0, (minGames - C.confidenceFloor) / (C.confidenceScale - C.confidenceFloor));
    }

    return {
      pA, pB, confidence,
      ratingA: Math.round(ratingA),
      ratingB: Math.round(ratingB),
      gamesA, gamesB,
      foundA, foundB,
    };
  }

  /**
   * Get the raw rating object for a player (for inspection/debugging).
   */
  function getRating(name, context) {
    const nk = _norm(name);
    const pData = ratings.get(nk);
    if (!pData) return null;
    const ctx = context || '_all';
    const entry = pData.contexts.get(ctx);
    if (!entry) return null;
    return { name: pData.name, rating: Math.round(entry.rating), games: entry.games, lastDate: entry.lastDate };
  }

  /**
   * Get all ratings (for debugging/dashboard).
   * @param {string} [context='_all']
   * @returns {Array<{name, rating, games, lastDate}>}
   */
  function getAllRatings(context) {
    const ctx = context || '_all';
    const result = [];
    for (const [, pData] of ratings) {
      const entry = pData.contexts.get(ctx);
      if (entry && entry.games > 0) {
        result.push({ name: pData.name, rating: Math.round(entry.rating), games: entry.games, lastDate: entry.lastDate });
      }
    }
    return result.sort((a, b) => b.rating - a.rating);
  }

  /**
   * Bootstrap Elo ratings from the match_results table.
   *
   * @param {object} db - better-sqlite3 database instance
   * @param {string} game - Game filter (e.g., 'lol', 'cs', 'dota')
   * @param {function} [contextFn] - Optional: row => context string (e.g., row => classifyLeague(row.league))
   * @param {object} [opts]
   * @param {number} [opts.maxAgeDays=365] - Only include matches from the last N days
   */
  function bootstrap(db, game, contextFn, opts) {
    const maxAgeDays = (opts && opts.maxAgeDays) || 365;

    let rows;
    try {
      rows = db.prepare(`
        SELECT team1, team2, winner, final_score, league, resolved_at
        FROM match_results
        WHERE game = ? AND winner IS NOT NULL AND winner != ''
          AND team1 IS NOT NULL AND team1 != ''
          AND team2 IS NOT NULL AND team2 != ''
          AND resolved_at >= datetime('now', '-' || ? || ' days')
        ORDER BY resolved_at ASC
      `).all(game, String(maxAgeDays));
    } catch (e) {
      log('ERROR', TAG, `bootstrap query failed: ${e.message}`);
      return 0;
    }

    let count = 0;
    for (const row of rows) {
      const winnerNorm = _norm(row.winner);
      const t1Norm = _norm(row.team1);

      const winnerName = (t1Norm === winnerNorm || row.team1 === row.winner) ? row.team1 : row.team2;
      const loserName = winnerName === row.team1 ? row.team2 : row.team1;

      // Calculate margin from final_score if available
      let margin = 1;
      if (row.final_score) {
        const parsed = _parseScore(row.final_score);
        if (parsed) {
          const winnerIsT1 = winnerName === row.team1;
          const wScore = winnerIsT1 ? parsed.s1 : parsed.s2;
          const lScore = winnerIsT1 ? parsed.s2 : parsed.s1;
          margin = Math.max(1, wScore - lScore);
        }
      }

      // Determine context
      const context = contextFn ? contextFn(row) : null;

      rate(winnerName, loserName, margin, row.resolved_at, context);
      count++;
    }

    log('INFO', TAG, `Bootstrapped ${count} ${game} matches into Elo (${ratings.size} entities)`);
    return count;
  }

  /**
   * Clear all ratings (useful for re-bootstrapping).
   */
  function reset() {
    ratings.clear();
  }

  /**
   * Number of entities tracked.
   */
  function size() {
    return ratings.size;
  }

  return {
    rate,
    getP,
    getRating,
    getAllRatings,
    bootstrap,
    reset,
    size,
  };
}

// ── Score parsing helper ──

/**
 * Parse a final_score string like "2-1", "2-0", "3-1", "16-14" etc.
 * Returns { s1, s2 } or null if unparseable.
 */
function _parseScore(score) {
  if (!score) return null;
  const m = String(score).match(/(\d+)\s*[-:]\s*(\d+)/);
  if (!m) return null;
  return { s1: parseInt(m[1], 10), s2: parseInt(m[2], 10) };
}

// ── Fuzzy name finder (shared utility) ──

/**
 * Find a name in a Map using fuzzy matching.
 * @param {Map} map - Map where keys are names
 * @param {string} name - Name to search for
 * @returns {*} The map value, or null
 */
function findByName(map, name) {
  if (!name) return null;
  const norm = _norm(name);
  if (map.has(name)) return map.get(name);
  for (const [k, v] of map) {
    if (_norm(k) === norm) return v;
  }
  for (const [k, v] of map) {
    const nk = _norm(k);
    if (nk.length >= 3 && (nk.includes(norm) || norm.includes(nk))) return v;
  }
  const last = norm.split(' ').pop();
  if (last && last.length >= 4) {
    for (const [k, v] of map) {
      if (_norm(k).split(' ').pop() === last) return v;
    }
  }
  return null;
}

module.exports = { createEloSystem, eloExpected, findByName };

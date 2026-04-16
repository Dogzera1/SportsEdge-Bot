/**
 * football-model.js — Poisson + Elo + Form ensemble model for football 1X2 probabilities
 *
 * Professional football betting approach:
 * 1. Poisson regression (Dixon-Coles inspired) from historical goals  (weight 0.50)
 * 2. Elo-based prediction with home advantage                         (weight 0.30)
 * 3. Recent form signal with exponential decay                        (weight 0.20)
 *
 * Falls back gracefully when data is missing — uses implied odds as anchor.
 */

const { log } = require('./utils');

// ── Constants ────────────────────────────────────────────────────────────────

const HOME_FACTOR = parseFloat(process.env.FOOTBALL_POISSON_HOME || '1.25');
const MAX_GOALS   = 6;  // enumerate scorelines 0-0 .. 6-6 (49 combos)

// League-specific empirical draw rates (proportion of matches ending draw)
const DRAW_RATE_BY_LEAGUE = {
  'serie_a':          0.27,
  'serie_b':          0.26,
  'premier_league':   0.25,
  'la_liga':          0.26,
  'bundesliga':       0.25,
  'ligue_1':          0.25,
  'eredivisie':       0.26,
  'primeira_liga':    0.26,
  'championship':     0.26,
  'mls':              0.23,
};
const DRAW_RATE_DEFAULT = 0.26;

// ── Math helpers ─────────────────────────────────────────────────────────────

function factorial(n) {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/**
 * Poisson probability mass function: P(X = k) given mean lambda
 */
function poissonPmf(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

/**
 * Calculate expected goals for home and away teams.
 *
 * @param {number} homeAttack    - home team attack strength (ratio vs league avg)
 * @param {number} homeDefense   - home team defense strength (ratio vs league avg)
 * @param {number} awayAttack    - away team attack strength
 * @param {number} awayDefense   - away team defense strength
 * @param {number} leagueAvg     - league average goals per team per game
 * @param {number} homeFactor    - home boost multiplier (default 1.25)
 * @returns {{ lambdaHome: number, lambdaAway: number }}
 */
function calcExpectedGoals(homeAttack, homeDefense, awayAttack, awayDefense, leagueAvg, homeFactor = HOME_FACTOR) {
  // Home xG = home_attack * away_defense * league_avg * home_factor
  // Away xG = away_attack * home_defense * league_avg
  const lambdaHome = Math.max(0.15, Math.min(5.0, homeAttack * awayDefense * leagueAvg * homeFactor));
  const lambdaAway = Math.max(0.15, Math.min(5.0, awayAttack * homeDefense * leagueAvg));
  return { lambdaHome, lambdaAway };
}

/**
 * Sum all scoreline probabilities 0-0 through maxGoals-maxGoals into 1X2 probabilities.
 *
 * @param {number} lambdaHome - expected goals for home
 * @param {number} lambdaAway - expected goals for away
 * @param {number} maxGoals   - max goals per side to enumerate (default 6)
 * @returns {{ pH: number, pD: number, pA: number, over25: number }}
 */
function scoreline1x2(lambdaHome, lambdaAway, maxGoals = MAX_GOALS) {
  let pH = 0, pD = 0, pA = 0, pUnder25 = 0;

  // Pre-compute PMF arrays to avoid redundant calls
  const pmfH = [];
  const pmfA = [];
  for (let i = 0; i <= maxGoals; i++) {
    pmfH[i] = poissonPmf(lambdaHome, i);
    pmfA[i] = poissonPmf(lambdaAway, i);
  }

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = pmfH[i] * pmfA[j];
      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;
      if (i + j <= 2) pUnder25 += p;
    }
  }

  // Normalize (scorelines beyond maxGoals are negligible but ensure sum = 1)
  const total = pH + pD + pA;
  if (total > 0 && total !== 1) {
    pH /= total;
    pD /= total;
    pA /= total;
  }

  return { pH, pD, pA, over25: 1 - pUnder25 };
}

/**
 * Query team attack/defense strength from match_results table.
 *
 * @param {object} db     - better-sqlite3 database instance
 * @param {string} team   - team name
 * @param {number} limit  - max recent games to consider (default 20)
 * @returns {{ attack: number, defense: number, games: number, goalsFor: number, goalsAgainst: number, homeGoalsFor: number, homeGoalsAgainst: number, awayGoalsFor: number, awayGoalsAgainst: number, homeGames: number, awayGames: number } | null}
 */
function getTeamStrength(db, team, limit = 20) {
  try {
    const rows = db.prepare(`
      SELECT team1, team2, final_score, league
      FROM match_results
      WHERE (lower(team1) = lower(?) OR lower(team2) = lower(?))
        AND game = 'football'
        AND final_score IS NOT NULL
        AND final_score LIKE '%-%'
      ORDER BY resolved_at DESC
      LIMIT ?
    `).all(team, team, limit);

    if (!rows || rows.length < 3) return null;

    let goalsFor = 0, goalsAgainst = 0, games = 0;
    let homeGoalsFor = 0, homeGoalsAgainst = 0, homeGames = 0;
    let awayGoalsFor = 0, awayGoalsAgainst = 0, awayGames = 0;

    for (const row of rows) {
      const parts = row.final_score.split('-').map(s => parseInt(s.trim(), 10));
      if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) continue;

      const [g1, g2] = parts;
      const isHome = row.team1.toLowerCase() === team.toLowerCase();

      if (isHome) {
        goalsFor += g1;
        goalsAgainst += g2;
        homeGoalsFor += g1;
        homeGoalsAgainst += g2;
        homeGames++;
      } else {
        goalsFor += g2;
        goalsAgainst += g1;
        awayGoalsFor += g2;
        awayGoalsAgainst += g1;
        awayGames++;
      }
      games++;
    }

    if (games < 3) return null;

    return {
      attack: goalsFor / games,
      defense: goalsAgainst / games,
      games,
      goalsFor: goalsFor / games,
      goalsAgainst: goalsAgainst / games,
      homeGoalsFor: homeGames > 0 ? homeGoalsFor / homeGames : null,
      homeGoalsAgainst: homeGames > 0 ? homeGoalsAgainst / homeGames : null,
      awayGoalsFor: awayGames > 0 ? awayGoalsFor / awayGames : null,
      awayGoalsAgainst: awayGames > 0 ? awayGoalsAgainst / awayGames : null,
      homeGames,
      awayGames,
    };
  } catch (err) {
    log('WARN', 'FB-MODEL', `getTeamStrength error for "${team}": ${err.message}`);
    return null;
  }
}

/**
 * Get league average goals per team per game from match_results.
 *
 * @param {object} db      - better-sqlite3 database instance
 * @param {string} [league] - optional league filter
 * @returns {number} average goals per team per game (default 1.30 if no data)
 */
function getLeagueAvgGoals(db, league) {
  try {
    let query, params;
    if (league) {
      query = `
        SELECT final_score FROM match_results
        WHERE game = 'football' AND final_score IS NOT NULL AND final_score LIKE '%-%'
          AND lower(league) = lower(?)
        ORDER BY resolved_at DESC LIMIT 200
      `;
      params = [league];
    } else {
      query = `
        SELECT final_score FROM match_results
        WHERE game = 'football' AND final_score IS NOT NULL AND final_score LIKE '%-%'
        ORDER BY resolved_at DESC LIMIT 500
      `;
      params = [];
    }

    const rows = db.prepare(query).all(...params);
    if (!rows || rows.length < 10) return 1.30; // sensible default: ~2.6 total goals/game

    let totalGoals = 0, games = 0;
    for (const row of rows) {
      const parts = row.final_score.split('-').map(s => parseInt(s.trim(), 10));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        totalGoals += parts[0] + parts[1];
        games++;
      }
    }

    if (games < 10) return 1.30;
    // Return per-team average (total goals / 2 sides / games)
    return totalGoals / (2 * games);
  } catch (err) {
    log('WARN', 'FB-MODEL', `getLeagueAvgGoals error: ${err.message}`);
    return 1.30;
  }
}

// ── Component A: Poisson Regression (weight 0.50) ────────────────────────────

/**
 * @param {object} db
 * @param {object} match   - { team1, team2, league }
 * @param {object} enrich  - { form1, form2 } with goalsFor/goalsAgainst
 * @returns {{ pH: number, pD: number, pA: number, lambdaH: number, lambdaA: number, over25: number, dataQuality: number } | null}
 */
function poissonComponent(db, match, enrich) {
  const homeStr = getTeamStrength(db, match.team1, 20);
  const awayStr = getTeamStrength(db, match.team2, 20);

  // Also use enrichment goalsFor/goalsAgainst as fallback/supplement
  const homeGF = homeStr?.attack ?? enrich?.form1?.goalsFor ?? null;
  const homeGA = homeStr?.defense ?? enrich?.form1?.goalsAgainst ?? null;
  const awayGF = awayStr?.attack ?? enrich?.form2?.goalsFor ?? null;
  const awayGA = awayStr?.defense ?? enrich?.form2?.goalsAgainst ?? null;

  if (homeGF === null || homeGA === null || awayGF === null || awayGA === null) {
    return null;
  }

  const leagueAvg = getLeagueAvgGoals(db, match.league);

  // Attack strength = team's goals scored per game / league avg
  // Defense strength = team's goals conceded per game / league avg
  // (defense > 1 means worse defense = concedes more than average)
  const homeAttack  = leagueAvg > 0 ? homeGF / leagueAvg : 1.0;
  const homeDefense = leagueAvg > 0 ? homeGA / leagueAvg : 1.0;
  const awayAttack  = leagueAvg > 0 ? awayGF / leagueAvg : 1.0;
  const awayDefense = leagueAvg > 0 ? awayGA / leagueAvg : 1.0;

  const { lambdaHome, lambdaAway } = calcExpectedGoals(
    homeAttack, homeDefense, awayAttack, awayDefense, leagueAvg, HOME_FACTOR
  );

  const result = scoreline1x2(lambdaHome, lambdaAway, MAX_GOALS);

  // Data quality: how many games inform the strengths
  const hGames = homeStr?.games ?? enrich?.form1?.games ?? 0;
  const aGames = awayStr?.games ?? enrich?.form2?.games ?? 0;
  const minGames = Math.min(hGames, aGames);
  const dataQuality = minGames >= 10 ? 1.0 : minGames >= 5 ? 0.8 : minGames >= 3 ? 0.6 : 0.4;

  return {
    pH: result.pH,
    pD: result.pD,
    pA: result.pA,
    lambdaH: lambdaHome,
    lambdaA: lambdaAway,
    over25: result.over25,
    dataQuality,
    leagueAvg,
    homeAttack, homeDefense, awayAttack, awayDefense,
  };
}

// ── Component B: Elo Prediction (weight 0.30) ───────────────────────────────

/**
 * @param {object} db
 * @param {object} match - { team1, team2, league }
 * @returns {{ pH: number, pD: number, pA: number, homeElo: number, awayElo: number, eloGames: number } | null}
 */
function eloComponent(db, match) {
  try {
    const homeRow = db.prepare('SELECT rating, games FROM football_elo WHERE lower(team)=lower(?)').get(match.team1);
    const awayRow = db.prepare('SELECT rating, games FROM football_elo WHERE lower(team)=lower(?)').get(match.team2);

    const homeElo = homeRow?.rating ? parseFloat(homeRow.rating) : null;
    const awayElo = awayRow?.rating ? parseFloat(awayRow.rating) : null;
    const homeGames = homeRow?.games ? parseInt(homeRow.games, 10) : 0;
    const awayGames = awayRow?.games ? parseInt(awayRow.games, 10) : 0;

    if (homeElo === null || awayElo === null) return null;
    if (homeGames < 3 && awayGames < 3) return null;

    // Home advantage in Elo points (~50-65 points, standard in football Elo)
    const homeAdvElo = parseFloat(process.env.FOOTBALL_ELO_HOME_ADV || '50') || 50;

    // Expected score (logistic)
    const eH = 1 / (1 + Math.pow(10, (awayElo - (homeElo + homeAdvElo)) / 400));

    // Convert expected score to 1X2 probabilities
    // Draw rate from league or default
    const leagueKey = (match.league || '').toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    let drawRate = DRAW_RATE_DEFAULT;
    for (const [k, v] of Object.entries(DRAW_RATE_BY_LEAGUE)) {
      if (leagueKey.includes(k)) { drawRate = v; break; }
    }

    // Distribute: eH ~ P(home wins) + 0.5 * P(draw)
    // So P(home win) = eH - 0.5 * drawRate, P(away win) = (1 - eH) - 0.5 * drawRate
    let pH = eH - 0.5 * drawRate;
    let pA = (1 - eH) - 0.5 * drawRate;
    let pD = drawRate;

    // Clamp and normalize
    pH = Math.max(0.05, pH);
    pA = Math.max(0.05, pA);
    pD = Math.max(0.08, Math.min(0.45, pD));

    const total = pH + pD + pA;
    pH /= total;
    pD /= total;
    pA /= total;

    return {
      pH, pD, pA,
      homeElo, awayElo,
      eloGames: Math.min(homeGames, awayGames),
    };
  } catch (err) {
    log('WARN', 'FB-MODEL', `eloComponent error: ${err.message}`);
    return null;
  }
}

// ── Component C: Form Signal (weight 0.20) ──────────────────────────────────

/**
 * Calculate form-based 1X2 probabilities from recent results.
 * Uses exponential decay weighting (most recent = 1.0, oldest of 5 = 0.5).
 *
 * @param {object} enrich - { form1, form2 } where each has { form, goalsFor, goalsAgainst, homeForm, awayForm }
 * @param {object} odds   - { h, d, a } for xPoints calculation
 * @returns {{ pH: number, pD: number, pA: number, homePPG: number, awayPPG: number } | null}
 */
function formComponent(enrich, odds) {
  const form1 = enrich?.form1;
  const form2 = enrich?.form2;

  if (!form1?.form?.length && !form2?.form?.length) return null;

  // Exponential decay weights: game 0 (most recent) = 1.0, game 4 = 0.5
  // decay = 0.5^(i/4) so weight halves over 5 games
  const decayWeight = (i) => Math.pow(0.5, i / 4);

  // Weighted PPG (points per game: W=3, D=1, L=0)
  const weightedPPG = (formArr) => {
    if (!Array.isArray(formArr) || !formArr.length) return null;
    const slice = formArr.slice(0, 5);
    let wSum = 0, ptsSum = 0;
    for (let i = 0; i < slice.length; i++) {
      const w = decayWeight(i);
      const pts = slice[i] === 'W' ? 3 : slice[i] === 'D' ? 1 : 0;
      ptsSum += pts * w;
      wSum += w;
    }
    return wSum > 0 ? ptsSum / wSum : null;
  };

  // Weighted goal difference per game
  const weightedGDPerGame = (formArr) => {
    if (!Array.isArray(formArr) || !formArr.length) return 0;
    const slice = formArr.slice(0, 5);
    let wSum = 0, gdSum = 0;
    for (let i = 0; i < slice.length; i++) {
      const w = decayWeight(i);
      // W ~ +1.2 GD avg, D ~ 0, L ~ -1.2 GD avg (approximation when no exact scores)
      const gd = slice[i] === 'W' ? 1.2 : slice[i] === 'D' ? 0 : -1.2;
      gdSum += gd * w;
      wSum += w;
    }
    return wSum > 0 ? gdSum / wSum : 0;
  };

  // Use venue-specific form when available, else overall form
  const homeFormArr = form1?.homeForm?.length ? form1.homeForm : form1?.form;
  const awayFormArr = form2?.awayForm?.length ? form2.awayForm : form2?.form;

  const homePPG = weightedPPG(homeFormArr);
  const awayPPG = weightedPPG(awayFormArr);

  // If we have no form at all, bail
  if (homePPG === null && awayPPG === null) return null;

  const homeGD = weightedGDPerGame(homeFormArr);
  const awayGD = weightedGDPerGame(awayFormArr);

  // xPoints: compare implied probability of result vs actual result
  // If a team consistently beats odds-implied expectations, they're undervalued
  let homeXPtsEdge = 0, awayXPtsEdge = 0;
  if (odds?.h && odds?.d && odds?.a) {
    const oH = parseFloat(odds.h), oD = parseFloat(odds.d), oA = parseFloat(odds.a);
    if (oH > 1 && oD > 1 && oA > 1) {
      const overround = 1/oH + 1/oD + 1/oA;
      const impliedH = (1/oH) / overround;
      // A team winning at home when implied < 0.40 adds positive xPts edge
      if (homePPG !== null) {
        const actualWinRate = homePPG / 3; // rough: PPG/3 ~ win rate
        homeXPtsEdge = actualWinRate - impliedH;
      }
      const impliedA = (1/oA) / overround;
      if (awayPPG !== null) {
        const actualWinRate = awayPPG / 3;
        awayXPtsEdge = actualWinRate - impliedA;
      }
    }
  }

  // Convert form signals to probability adjustments
  // PPG range 0-3, normalize to 0-1 for comparison
  const hStrength = (homePPG ?? 1.5) / 3.0; // 0..1
  const aStrength = (awayPPG ?? 1.5) / 3.0;

  // Raw probability from form (simple logistic-style)
  // home advantage implicit in PPG if using homeForm
  let rawH = hStrength;
  let rawA = aStrength;

  // Adjust for GD trend (teams on scoring runs are stronger)
  rawH += homeGD * 0.05;
  rawA += awayGD * 0.05;

  // Adjust for xPoints edge (overperforming teams get a boost)
  rawH += homeXPtsEdge * 0.10;
  rawA += awayXPtsEdge * 0.10;

  // Clamp
  rawH = Math.max(0.10, Math.min(0.80, rawH));
  rawA = Math.max(0.10, Math.min(0.80, rawA));

  // Draw: when teams are close in strength, draw is more likely
  const strengthDiff = Math.abs(rawH - rawA);
  const drawBase = 0.26;
  const drawBoost = Math.max(0, 0.10 - strengthDiff * 0.15); // closer teams → more draw
  let pD = drawBase + drawBoost;

  let pH = rawH * (1 - pD);
  let pA = rawA * (1 - pD);

  // Normalize
  const total = pH + pD + pA;
  pH /= total;
  pD /= total;
  pA /= total;

  return {
    pH, pD, pA,
    homePPG: homePPG ?? null,
    awayPPG: awayPPG ?? null,
  };
}

// ── Ensemble ─────────────────────────────────────────────────────────────────

/**
 * Get implied odds probabilities (de-juiced) as a baseline.
 */
function impliedFromOdds(odds) {
  const oH = parseFloat(odds?.h), oD = parseFloat(odds?.d), oA = parseFloat(odds?.a);
  if (!oH || !oD || !oA || oH <= 1 || oD <= 1 || oA <= 1) return null;

  const rawH = 1/oH, rawD = 1/oD, rawA = 1/oA;
  const overround = rawH + rawD + rawA;
  return {
    pH: rawH / overround,
    pD: rawD / overround,
    pA: rawA / overround,
    margin: (overround - 1) * 100,
  };
}

/**
 * Main entry point: ensemble football probability model.
 *
 * @param {object} db       - better-sqlite3 database instance (raw db, not stmts)
 * @param {object} match    - { team1, team2, league, id }
 * @param {object} odds     - { h, d, a } decimal European odds
 * @param {object} enrich   - { form1, form2, h2h, standings }
 *   form1/form2: { form: ['W','D','L',...], goalsFor, goalsAgainst, games, homeForm, awayForm }
 * @returns {{ pH: number, pD: number, pA: number, confidence: number, method: string, factors: string[],
 *             lambdaH?: number, lambdaA?: number, over25?: number, eloHome?: number, eloAway?: number }}
 */
function getFootballProbability(db, match, odds, enrich) {
  const factors = [];
  const implied = impliedFromOdds(odds);

  if (!implied) {
    log('WARN', 'FB-MODEL', `No valid odds for ${match.team1} vs ${match.team2}`);
    return {
      pH: 0.40, pD: 0.25, pA: 0.35,
      confidence: 0.2,
      method: 'fallback_uniform',
      factors: ['no_valid_odds'],
    };
  }

  // Weights for each component (will be re-distributed if a component is missing)
  const baseWeights = { poisson: 0.50, elo: 0.30, form: 0.20 };

  // ── Run components ──
  const poisson = poissonComponent(db, match, enrich);
  const elo = eloComponent(db, match);
  const form = formComponent(enrich, odds);

  // Track which components are available
  const components = {};
  let totalWeight = 0;

  if (poisson) {
    components.poisson = { pH: poisson.pH, pD: poisson.pD, pA: poisson.pA, w: baseWeights.poisson };
    totalWeight += baseWeights.poisson;
    factors.push(`poisson(lH=${poisson.lambdaH.toFixed(2)},lA=${poisson.lambdaA.toFixed(2)},q=${poisson.dataQuality.toFixed(1)})`);
  }

  if (elo) {
    components.elo = { pH: elo.pH, pD: elo.pD, pA: elo.pA, w: baseWeights.elo };
    totalWeight += baseWeights.elo;
    factors.push(`elo(${elo.homeElo.toFixed(0)}v${elo.awayElo.toFixed(0)},g=${elo.eloGames})`);
  }

  if (form) {
    components.form = { pH: form.pH, pD: form.pD, pA: form.pA, w: baseWeights.form };
    totalWeight += baseWeights.form;
    factors.push(`form(hPPG=${form.homePPG?.toFixed(2) ?? '?'},aPPG=${form.awayPPG?.toFixed(2) ?? '?'})`);
  }

  // ── Ensemble or fallback ──
  let pH, pD, pA, method;

  if (totalWeight === 0) {
    // No model data at all — return implied with small home advantage nudge
    pH = implied.pH + 0.02;
    pA = implied.pA - 0.02;
    pD = implied.pD;
    method = 'implied_only';
    factors.push('no_model_data');
  } else {
    // Weighted average, re-normalizing weights to sum to 1
    pH = 0; pD = 0; pA = 0;
    for (const comp of Object.values(components)) {
      const normalizedW = comp.w / totalWeight;
      pH += comp.pH * normalizedW;
      pD += comp.pD * normalizedW;
      pA += comp.pA * normalizedW;
    }
    method = Object.keys(components).join('+');

    // Shrinkage toward implied: blend 70% model / 30% implied when we have all 3 components,
    // more implied reliance when fewer components are available
    const modelConfidence = totalWeight >= 0.90 ? 0.70 : totalWeight >= 0.50 ? 0.55 : 0.40;
    pH = pH * modelConfidence + implied.pH * (1 - modelConfidence);
    pD = pD * modelConfidence + implied.pD * (1 - modelConfidence);
    pA = pA * modelConfidence + implied.pA * (1 - modelConfidence);
    factors.push(`shrinkage(model=${(modelConfidence * 100).toFixed(0)}%,implied=${((1-modelConfidence)*100).toFixed(0)}%)`);
  }

  // ── Normalize to exactly 1.0 ──
  const total = pH + pD + pA;
  pH /= total;
  pD /= total;
  pA /= total;

  // ── Confidence score (0..1) ──
  let confidence = 0.5; // base

  // Data quality boost
  if (poisson) {
    const bothEnoughGames = (poisson.dataQuality >= 0.8);
    confidence += bothEnoughGames ? 0.15 : poisson.dataQuality * 0.10;

    // Poisson stability: lambdas in weird range reduce confidence
    if (poisson.lambdaH < 0.3 || poisson.lambdaH > 4.0) confidence -= 0.10;
    if (poisson.lambdaA < 0.3 || poisson.lambdaA > 4.0) confidence -= 0.10;
  } else {
    confidence -= 0.10; // no poisson data
  }

  // Elo reliability
  if (elo) {
    if (elo.eloGames >= 10) confidence += 0.10;
    else if (elo.eloGames >= 5) confidence += 0.05;
    else confidence -= 0.05; // too few Elo games
  } else {
    confidence -= 0.05;
  }

  // Form data available
  if (form) {
    confidence += 0.05;
  }

  // Components agreement: if all components agree on the favorite, boost confidence
  const componentList = Object.values(components);
  if (componentList.length >= 2) {
    const allAgreeHome = componentList.every(c => c.pH > c.pA);
    const allAgreeAway = componentList.every(c => c.pA > c.pH);
    if (allAgreeHome || allAgreeAway) confidence += 0.10;
    else confidence -= 0.05; // disagreement reduces confidence
  }

  // Clamp confidence
  confidence = Math.max(0.15, Math.min(0.95, confidence));

  // ── Build result ──
  const result = {
    pH: parseFloat(pH.toFixed(4)),
    pD: parseFloat(pD.toFixed(4)),
    pA: parseFloat(pA.toFixed(4)),
    confidence: parseFloat(confidence.toFixed(3)),
    method,
    factors,
  };

  // Attach optional data
  if (poisson) {
    result.lambdaH = parseFloat(poisson.lambdaH.toFixed(3));
    result.lambdaA = parseFloat(poisson.lambdaA.toFixed(3));
    result.over25 = parseFloat(poisson.over25.toFixed(4));
    result.leagueAvg = parseFloat(poisson.leagueAvg.toFixed(3));
  }
  if (elo) {
    result.eloHome = parseFloat(elo.homeElo.toFixed(1));
    result.eloAway = parseFloat(elo.awayElo.toFixed(1));
  }

  log('DEBUG', 'FB-MODEL', `${match.team1} vs ${match.team2}: pH=${(result.pH*100).toFixed(1)}% pD=${(result.pD*100).toFixed(1)}% pA=${(result.pA*100).toFixed(1)}% conf=${result.confidence} [${method}]`);

  return result;
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getFootballProbability,
  // Expose internals for testing and direct use
  poissonPmf,
  calcExpectedGoals,
  scoreline1x2,
  getTeamStrength,
  getLeagueAvgGoals,
  poissonComponent,
  eloComponent,
  formComponent,
  impliedFromOdds,
  HOME_FACTOR,
  MAX_GOALS,
  DRAW_RATE_BY_LEAGUE,
};

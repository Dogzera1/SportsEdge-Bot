/**
 * tennis-model.js — Enhanced Tennis Model (multi-factor ensemble)
 *
 * Professional tennis betting approach combining:
 *   A) Surface-specific Elo (reuses tennis-ml.js)        weight: 0.40
 *   B) Serve/Return efficiency (dominance ratio)          weight: 0.25
 *   C) Fatigue/Schedule index                             weight: 0.15
 *   D) H2H surface-weighted with recency                 weight: 0.20
 *
 * Entry point:
 *   getTennisProbability(db, match, odds, enrich, surface)
 *   Returns { modelP1, modelP2, confidence, method, factors: [...] }
 */

const fs = require('fs');
const path = require('path');
const { log } = require('./utils');
const { getTennisElo, extractSurface } = require('./tennis-ml');
const { predictTrainedTennis, hasTrainedModel } = require('./tennis-model-trained');

// Isotonic post-hoc calibration (fit via scripts/fit-tennis-model-isotonic.js)
let _isotonicBlocks = null;
try {
  const p = path.join(__dirname, 'tennis-model-isotonic.json');
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(j.blocks) && j.blocks.length) _isotonicBlocks = j.blocks;
  }
} catch (_) {}

function _applyIsotonic(p) {
  const blocks = _isotonicBlocks;
  if (!blocks) return p;
  if (p <= blocks[0].pMax) return blocks[0].yMean;
  const last = blocks[blocks.length - 1];
  if (p >= last.pMin) return last.yMean;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (p >= b.pMin && p <= b.pMax) return b.yMean;
    if (i + 1 < blocks.length) {
      const n = blocks[i + 1];
      if (p > b.pMax && p < n.pMin) {
        const t = (p - b.pMax) / (n.pMin - b.pMax);
        return b.yMean + t * (n.yMean - b.yMean);
      }
    }
  }
  return p;
}

// Modos do modelo treinado:
//   'off'    — não usa treinado (default)
//   'shadow' — log P treinada ao lado da heurística; decisão ainda usa heurística
//   'active' — usa P treinada como probabilidade final (blend com implied pela confidence)
const TRAINED_MODE = String(process.env.TENNIS_TRAINED_MODE || 'active').toLowerCase();

// ── Weights ──
const W_ELO     = 0.40;
const W_SERVE   = 0.25;
const W_FATIGUE = 0.15;
const W_H2H     = 0.20;

// ── Helpers ──

function _norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Surface Detection ──

const CLAY_KEYWORDS = [
  'roland garros', 'french open', 'rome', 'monte carlo', 'monte-carlo',
  'barcelona', '(clay)', 'madrid', 'buenos aires', 'rio open', 'hamburg',
  'lyon', 'bastad', 'umag', 'kitzbuhel', 'gstaad', 'bucharest', 'marrakech',
  'cordoba', 'santiago', 'estoril', 'geneva',
];
const GRASS_KEYWORDS = [
  'wimbledon', "queen's", 'queens', 'halle', '(grass)', 'eastbourne',
  'stuttgart', 'mallorca', 's-hertogenbosch', 'newport',
];
const INDOOR_HARD_KEYWORDS = [
  'paris masters', 'atp finals', 'nitto', 'bercy', 'vienna', 'basel',
  'st. petersburg', 'sofia', 'stockholm', 'metz', 'moscow', 'antwerp',
];

/**
 * Detect surface from league/tournament string.
 * Returns 'saibro' | 'grama' | 'dura'
 */
function detectSurface(league) {
  // First try the standard (Hard)/(Clay)/(Grass) tag from tennis-ml
  const tagged = extractSurface(league);
  if (league && /\((Clay|Grass|Hard|Carpet)\)/i.test(league)) return tagged;

  const low = String(league || '').toLowerCase();
  for (const kw of CLAY_KEYWORDS)  if (low.includes(kw)) return 'saibro';
  for (const kw of GRASS_KEYWORDS) if (low.includes(kw)) return 'grama';
  // Indoor hard doesn't change the surface label
  return 'dura';
}

// ── Tournament tier ──

function tournamentTier(league) {
  const low = String(league || '').toLowerCase();
  if (/grand slam|\[g\]|roland garros|wimbledon|us open|aus(tralian)? open/i.test(low)) return 'grandslam';
  if (/masters|1000|\[m\]|indian wells|miami|madrid|rome|italian|canadian|cincinnati|shanghai|paris masters|monte.carlo/i.test(low)) return 'masters';
  if (/500|\[5\]/i.test(low)) return '500';
  if (/250|\[2\]/i.test(low)) return '250';
  if (/challenger|\bch\d+\b/i.test(low)) return 'challenger';
  if (/itf|futures|\b[wm]\d{2,3}\b|\$\d+k/i.test(low)) return 'itf';
  return 'other';
}

/**
 * Extrai prize money do nome do torneio ITF/Challenger.
 * Nomes comuns:
 *   "ITF W15 Monastir"  → 15
 *   "M25 Cairo"         → 25
 *   "W75 Florianopolis" → 75
 *   "Challenger 80 ..."  → 80 (Challenger tem prize pool inflation, W/M é o k$)
 *   "$25K Tunisia"      → 25
 * @returns {number|null} prize pool em thousands (15, 25, 40, 50, 75, 100...) ou null
 */
function extractItfPrizePool(league) {
  const s = String(league || '');
  // W15 / M25 / W100 etc
  const wm = s.match(/\b[WM](\d{2,3})\b/);
  if (wm) return parseInt(wm[1], 10);
  // $25K / $15k
  const dollar = s.match(/\$(\d+)\s*[Kk]/);
  if (dollar) return parseInt(dollar[1], 10);
  // "Challenger 50", "ATP Challenger 75"
  const ch = s.match(/challenger\s+(\d{2,3})/i);
  if (ch) return parseInt(ch[1], 10);
  // "CH50", "CH125"
  const chShort = s.match(/\bch(\d{2,3})\b/i);
  if (chShort) return parseInt(chShort[1], 10);
  return null;
}

/**
 * Decide se torneio é prohibited (risco alto de match-fixing em ITF low-tier).
 * Default: exclui ITF com prize pool ≤ $25k. Pode ser override via env.
 * @returns {{ prohibited: boolean, reason: string|null, tier: string, prize: number|null }}
 */
function tennisProhibitedTournament(league) {
  const tier = tournamentTier(league);
  const prize = extractItfPrizePool(league);
  const maxProhibited = parseInt(process.env.TENNIS_ITF_EXCLUDE_PRIZE_MAX || '25', 10);
  if (tier === 'itf') {
    if (prize == null) {
      // ITF sem prize parseável — default restritivo
      return { prohibited: true, reason: 'ITF sem prize parseável — exclui por segurança', tier, prize: null };
    }
    if (prize <= maxProhibited) {
      return { prohibited: true, reason: `ITF $${prize}K ≤ threshold $${maxProhibited}K (fix risk)`, tier, prize };
    }
  }
  return { prohibited: false, reason: null, tier, prize };
}

// ── A) Surface Elo Sub-model ──

function eloSubModel(db, player1, player2, surface, impliedP1, impliedP2) {
  try {
    const elo = getTennisElo(db, player1, player2, surface, impliedP1, impliedP2);
    if (!elo) return null;
    return {
      p1: elo.modelP1,
      p2: elo.modelP2,
      found1: elo.found1,
      found2: elo.found2,
      elo1: elo.elo1,
      elo2: elo.elo2,
      eloMatches1: elo.eloMatches1,
      eloMatches2: elo.eloMatches2,
      surfMatches1: elo.surfMatches1,
      surfMatches2: elo.surfMatches2,
      confidence: (elo.found1 && elo.found2) ? 1.0 : elo.found1 || elo.found2 ? 0.4 : 0,
    };
  } catch (e) {
    log('WARN', 'TENNIS-MODEL', `Elo sub-model error: ${e.message}`);
    return null;
  }
}

// ── B) Serve/Return Efficiency Sub-model ──

/**
 * Compute dominance ratio from serve stats.
 * SPW = Service Points Won % (0-1)
 * RPW = Return Points Won % (0-1)
 * If we have SPW for player A and RPW for player B:
 *   dominance_A = SPW_A / (1 - RPW_B)   (how well A serves relative to B's return)
 *   dominance_B = SPW_B / (1 - RPW_A)
 *   P(A) = dominance_A / (dominance_A + dominance_B)
 */
function serveSubModel(serveStats1, serveStats2) {
  if (!serveStats1 || !serveStats2) return null;
  if ((serveStats1.games || 0) < 2 || (serveStats2.games || 0) < 2) return null;

  // We need first serve points % as SPW proxy. Combine 1st and 2nd serve.
  // Approximate total SPW: weighted by first serve %
  // SPW ~ (1stServePct/100 * 1stServePointsPct/100) + ((1 - 1stServePct/100) * 2ndServePointsPct/100)
  function computeSPW(stats) {
    const fsPct = stats.firstServePct;
    const fspPct = stats.firstServePointsPct;
    const sspPct = stats.secondServePointsPct;
    if (fsPct == null || fspPct == null || sspPct == null) return null;
    return (fsPct / 100) * (fspPct / 100) + (1 - fsPct / 100) * (sspPct / 100);
  }

  // RPW: opponent's SPW inverted, but we approximate from break points converted
  // Better proxy: RPW ~ 1 - opponent_SPW (if we had it)
  // Since we have both players' stats, RPW_A = 1 - SPW_B is a rough but useful proxy
  // Actually, use breakPointsConvertedPct as a signal for return quality

  const spw1 = computeSPW(serveStats1);
  const spw2 = computeSPW(serveStats2);

  if (spw1 == null || spw2 == null) return null;

  // RPW approximated: a player's return points won ~ 1 - opponent's SPW
  // But we want RPW in a general sense, not match-specific
  // Use breakPointsConvertedPct as a boost/penalty
  const bpConv1 = serveStats1.breakPointsConvertedPct != null ? serveStats1.breakPointsConvertedPct / 100 : 0.35;
  const bpConv2 = serveStats2.breakPointsConvertedPct != null ? serveStats2.breakPointsConvertedPct / 100 : 0.35;

  // Blend: RPW ~ (1 - spw_opponent) * 0.7 + bpConv * 0.3
  const rpw1 = (1 - spw2) * 0.7 + bpConv1 * 0.3;
  const rpw2 = (1 - spw1) * 0.7 + bpConv2 * 0.3;

  // Dominance ratio
  const denom1 = 1 - rpw2;  // how hard is it for P2 to return against P1
  const denom2 = 1 - rpw1;

  if (denom1 <= 0.01 || denom2 <= 0.01) return null; // degenerate

  const dom1 = spw1 / denom1;
  const dom2 = spw2 / denom2;

  const total = dom1 + dom2;
  if (total <= 0) return null;

  const p1 = clamp(dom1 / total, 0.15, 0.85);
  const p2 = 1 - p1;

  return {
    p1, p2,
    spw1: +(spw1 * 100).toFixed(1),
    spw2: +(spw2 * 100).toFixed(1),
    rpw1: +(rpw1 * 100).toFixed(1),
    rpw2: +(rpw2 * 100).toFixed(1),
    dom1: +dom1.toFixed(3),
    dom2: +dom2.toFixed(3),
    confidence: 1.0,
  };
}

// ── C) Fatigue/Schedule Sub-model ──

/**
 * Compute fatigue index for a player from their recent match history in match_results.
 * Returns a value from 0 (no fatigue / optimal rest) to 1 (heavy fatigue).
 *
 * Signals:
 * - Days since last match: 0-1 = heavy (0.8), 2 = moderate (0.5), 3-7 = optimal (0.1), 8-14 = slight rust (0.3), 14+ = rust (0.5)
 * - Matches in last 7 days: 3+ = accumulated fatigue
 * - Tournament round (later rounds = more accumulated fatigue)
 */
function computeFatigueIndex(db, playerName, matchTimeMs, league) {
  try {
    const rows = db.prepare(`
      SELECT resolved_at, final_score, league
      FROM match_results
      WHERE (lower(team1) = lower(?) OR lower(team2) = lower(?))
        AND game = 'tennis'
        AND resolved_at IS NOT NULL
      ORDER BY resolved_at DESC
      LIMIT 10
    `).all(playerName, playerName);

    if (!rows.length) return { fatigue: 0.3, matchesLast7: 0, daysSinceLast: null, detail: 'no_history' };

    const now = matchTimeMs || Date.now();

    // Days since last match
    let daysSinceLast = null;
    let matchesLast7 = 0;
    let matchesLast14 = 0;
    let fiveSetMatchesLast7 = 0;

    for (const r of rows) {
      const t = new Date(r.resolved_at).getTime();
      if (isNaN(t)) continue;
      const daysDiff = (now - t) / (1000 * 60 * 60 * 24);
      if (daysSinceLast === null) daysSinceLast = daysDiff;
      if (daysDiff <= 7) {
        matchesLast7++;
        // Check for 5-setters (score like "3-2" or "2-3")
        const score = String(r.final_score || '');
        const sets = score.split('-').map(Number);
        if (sets.length === 2 && (sets[0] + sets[1]) >= 5) fiveSetMatchesLast7++;
      }
      if (daysDiff <= 14) matchesLast14++;
    }

    // Base fatigue from days since last match
    let baseFatigue;
    if (daysSinceLast === null) {
      baseFatigue = 0.3; // unknown
    } else if (daysSinceLast <= 1) {
      baseFatigue = 0.8; // back-to-back = heavy
    } else if (daysSinceLast <= 2) {
      baseFatigue = 0.5; // moderate
    } else if (daysSinceLast <= 7) {
      baseFatigue = 0.1; // optimal rest
    } else if (daysSinceLast <= 14) {
      baseFatigue = 0.25; // slight rust
    } else {
      baseFatigue = 0.4; // rust from inactivity
    }

    // Accumulated fatigue: many matches in short period
    const accumulationBonus = matchesLast7 >= 4 ? 0.25 : matchesLast7 >= 3 ? 0.15 : 0;

    // 5-setter tax
    const fiveSetTax = fiveSetMatchesLast7 * 0.1;

    // Tournament round fatigue (later rounds = deeper into tournament)
    const tier = tournamentTier(league);
    const roundFatigue = tier === 'grandslam' ? 0.05 : 0; // GS rounds are longer/harder

    const fatigue = clamp(baseFatigue + accumulationBonus + fiveSetTax + roundFatigue, 0, 1);

    return { fatigue, matchesLast7, daysSinceLast, fiveSetMatchesLast7, detail: 'computed' };
  } catch (e) {
    log('WARN', 'TENNIS-MODEL', `Fatigue computation error for ${playerName}: ${e.message}`);
    return { fatigue: 0.3, matchesLast7: 0, daysSinceLast: null, detail: 'error' };
  }
}

/**
 * Fatigue sub-model: converts fatigue differential into probability adjustment.
 * Max adjustment: +/- 3% (0.03 in probability).
 * Positive = player 1 has fatigue advantage (less fatigued).
 */
function fatigueSubModel(db, player1, player2, matchTimeMs, league) {
  const f1 = computeFatigueIndex(db, player1, matchTimeMs, league);
  const f2 = computeFatigueIndex(db, player2, matchTimeMs, league);

  if (f1.detail === 'no_history' && f2.detail === 'no_history') return null;

  // Fatigue diff: positive means P2 is more fatigued (advantage P1)
  const diff = f2.fatigue - f1.fatigue;

  // Map to probability adjustment: max +/- 0.03
  const MAX_ADJ = 0.03;
  const adj = clamp(diff * MAX_ADJ / 0.5, -MAX_ADJ, MAX_ADJ);

  // Convert to sub-model probability: 0.5 + adjustment
  const p1 = clamp(0.5 + adj, 0.35, 0.65);
  const p2 = 1 - p1;

  const confidence = (f1.detail === 'computed' && f2.detail === 'computed') ? 1.0
    : (f1.detail === 'computed' || f2.detail === 'computed') ? 0.5
    : 0;

  return {
    p1, p2,
    fatigue1: +f1.fatigue.toFixed(2),
    fatigue2: +f2.fatigue.toFixed(2),
    days1: f1.daysSinceLast != null ? +f1.daysSinceLast.toFixed(1) : null,
    days2: f2.daysSinceLast != null ? +f2.daysSinceLast.toFixed(1) : null,
    matchesLast7_1: f1.matchesLast7,
    matchesLast7_2: f2.matchesLast7,
    confidence,
  };
}

// ── D) H2H Surface-Weighted Sub-model ──

/**
 * Parse H2H matches from match_results with surface filtering and recency weighting.
 *
 * Professional adjustments:
 * - Filter by SAME surface (clay H2H irrelevant on hard)
 * - Recency: last 2 years full weight, 2-4 years half weight, older = ignore
 * - Need >= 3 surface-specific H2H for signal
 * - Fallback to overall H2H with 0.7x weight if insufficient surface H2H
 */
function h2hSubModel(db, player1, player2, surface) {
  try {
    // Fetch all H2H matches (last 5 years)
    const rows = db.prepare(`
      SELECT team1, team2, winner, league, resolved_at
      FROM match_results
      WHERE game = 'tennis'
        AND winner IS NOT NULL AND winner != ''
        AND (
          (lower(team1) = lower(?) AND lower(team2) = lower(?))
          OR (lower(team1) = lower(?) AND lower(team2) = lower(?))
        )
        AND resolved_at >= datetime('now', '-5 years')
      ORDER BY resolved_at DESC
    `).all(player1, player2, player2, player1);

    if (!rows.length) return null;

    const now = Date.now();
    const n1 = _norm(player1);

    let surfaceWins1 = 0, surfaceWins2 = 0, surfaceWeightedWins1 = 0, surfaceWeightedWins2 = 0;
    let allWins1 = 0, allWins2 = 0, allWeightedWins1 = 0, allWeightedWins2 = 0;

    for (const r of rows) {
      const matchSurface = extractSurface(r.league);
      const resolvedMs = new Date(r.resolved_at).getTime();
      const yearsAgo = (now - resolvedMs) / (1000 * 60 * 60 * 24 * 365.25);

      // Recency weight
      let recencyW;
      if (yearsAgo <= 2) recencyW = 1.0;
      else if (yearsAgo <= 4) recencyW = 0.5;
      else recencyW = 0; // ignore > 4 years

      if (recencyW <= 0) continue;

      const winnerNorm = _norm(r.winner);
      const t1Norm = _norm(r.team1);
      const p1Won = (winnerNorm === n1) || (t1Norm === n1 && r.winner === r.team1) || (t1Norm !== n1 && r.winner !== r.team1 && winnerNorm !== _norm(r.team1) && winnerNorm !== _norm(r.team2));

      // Simplified: check if winner matches player1 name
      const isP1Winner = _norm(r.winner) === n1
        || (_norm(r.team1) === n1 && _norm(r.winner) === _norm(r.team1))
        || (_norm(r.team2) !== n1 && _norm(r.winner) !== _norm(r.team2));

      // Be more careful: only count if we can positively identify who won
      let p1w = false;
      if (_norm(r.winner) === n1) {
        p1w = true;
      } else if (_norm(r.team1) === n1 && _norm(r.winner) === _norm(r.team1)) {
        p1w = true;
      } else if (_norm(r.team2) === n1 && _norm(r.winner) === _norm(r.team2)) {
        p1w = true;
      } else if (_norm(r.team1) !== n1 && _norm(r.team2) !== n1) {
        // Can't identify player in this row, skip
        continue;
      } else {
        // player1 is in the match but didn't win
        p1w = false;
      }

      // All surface
      if (p1w) { allWins1++; allWeightedWins1 += recencyW; }
      else { allWins2++; allWeightedWins2 += recencyW; }

      // Same surface
      if (matchSurface === surface) {
        if (p1w) { surfaceWins1++; surfaceWeightedWins1 += recencyW; }
        else { surfaceWins2++; surfaceWeightedWins2 += recencyW; }
      }
    }

    const surfaceTotal = surfaceWins1 + surfaceWins2;
    const allTotal = allWins1 + allWins2;

    if (allTotal === 0) return null;

    let p1, p2, usedSurface;

    if (surfaceTotal >= 3) {
      // Enough surface-specific H2H
      const totalW = surfaceWeightedWins1 + surfaceWeightedWins2;
      if (totalW <= 0) return null;
      p1 = surfaceWeightedWins1 / totalW;
      p2 = 1 - p1;
      usedSurface = true;
    } else {
      // Fall back to overall H2H with reduced weight (applied via confidence)
      const totalW = allWeightedWins1 + allWeightedWins2;
      if (totalW <= 0) return null;
      p1 = allWeightedWins1 / totalW;
      p2 = 1 - p1;
      usedSurface = false;
    }

    // Regularize toward 0.5 with small samples
    const sampleSize = usedSurface ? surfaceTotal : allTotal;
    const regStrength = Math.min(1.0, sampleSize / 8); // full confidence at 8+ H2H
    p1 = 0.5 + (p1 - 0.5) * regStrength;
    p2 = 1 - p1;

    // Clamp to reasonable bounds
    p1 = clamp(p1, 0.15, 0.85);
    p2 = 1 - p1;

    const confidence = usedSurface ? 1.0 : 0.7;

    return {
      p1, p2,
      surfaceWins1, surfaceWins2, surfaceTotal,
      allWins1, allWins2, allTotal,
      usedSurface,
      confidence,
    };
  } catch (e) {
    log('WARN', 'TENNIS-MODEL', `H2H sub-model error: ${e.message}`);
    return null;
  }
}

// ── Also use enrich.h2h from Sofascore if DB H2H is empty ──

function h2hFromEnrich(enrich) {
  const h = enrich?.h2h;
  if (!h || h.totalMatches < 1) return null;

  const total = h.t1Wins + h.t2Wins;
  if (total < 1) return null;

  // Regularize toward 0.5
  const regStrength = Math.min(1.0, total / 8);
  let p1 = 0.5 + ((h.t1Wins / total) - 0.5) * regStrength;
  p1 = clamp(p1, 0.15, 0.85);
  const p2 = 1 - p1;

  return {
    p1, p2,
    surfaceWins1: 0, surfaceWins2: 0, surfaceTotal: 0,
    allWins1: h.t1Wins, allWins2: h.t2Wins, allTotal: total,
    usedSurface: false,
    confidence: total >= 3 ? 0.7 : 0.4,
  };
}

// ── Confidence Calculator ──

function computeConfidence(eloResult, formData, rankData, h2hResult) {
  let confidence = 0.50;

  // +0.15 if Elo available for both
  if (eloResult && eloResult.found1 && eloResult.found2) {
    confidence += 0.15;
  }

  // +0.10 if form data for both (>= 3 recent matches each)
  const f1 = formData?.form1;
  const f2 = formData?.form2;
  const hasForm1 = f1 && (f1.wins + f1.losses) >= 3;
  const hasForm2 = f2 && (f2.wins + f2.losses) >= 3;
  if (hasForm1 && hasForm2) confidence += 0.10;

  // +0.10 if ranking data available
  if (rankData?.ranking1 && rankData?.ranking2) confidence += 0.10;

  // +0.15 if H2H data on surface (>= 3 matches)
  if (h2hResult && h2hResult.usedSurface && h2hResult.surfaceTotal >= 3) {
    confidence += 0.15;
  } else if (h2hResult && h2hResult.allTotal >= 3) {
    confidence += 0.08; // partial credit for overall H2H
  }

  return clamp(confidence, 0, 1.0);
}

// ── Main Entry Point ──

/**
 * Enhanced tennis probability model.
 *
 * @param {object} db - better-sqlite3 database
 * @param {object} match - { team1, team2, league, status, time, id }
 * @param {object} odds - { t1, t2, bookmaker }
 * @param {object} enrich - { form1, form2, h2h, ranking1, ranking2, serveStats1, serveStats2 }
 * @param {string} [surfaceOverride] - 'dura' | 'saibro' | 'grama' (auto-detected if not passed)
 * @returns {{ modelP1: number, modelP2: number, confidence: number, method: string, factors: object[] }}
 */
function getTennisProbability(db, match, odds, enrich, surfaceOverride) {
  const player1 = match.team1;
  const player2 = match.team2;
  const league = match.league || '';
  const surface = surfaceOverride || detectSurface(league);

  // Implied probabilities from odds (de-juiced)
  const o1 = parseFloat(odds?.t1) || 2.0;
  const o2 = parseFloat(odds?.t2) || 2.0;
  const r1 = 1 / o1, r2 = 1 / o2;
  const totalVig = r1 + r2;
  const impliedP1 = r1 / totalVig;
  const impliedP2 = r2 / totalVig;

  const factors = [];
  const subModels = []; // { weight, p1, p2, label }

  // ── A) Surface Elo ──
  const eloResult = eloSubModel(db, player1, player2, surface, impliedP1, impliedP2);
  if (eloResult && eloResult.confidence > 0) {
    const effectiveWeight = (eloResult.found1 && eloResult.found2) ? W_ELO : W_ELO * 0.4;
    subModels.push({
      weight: effectiveWeight,
      p1: eloResult.p1,
      p2: eloResult.p2,
      label: 'elo',
    });
    factors.push({
      name: 'Surface Elo',
      p1: +(eloResult.p1 * 100).toFixed(1),
      p2: +(eloResult.p2 * 100).toFixed(1),
      weight: +effectiveWeight.toFixed(2),
      detail: `${player1}: ${eloResult.elo1} (${eloResult.eloMatches1} games, ${eloResult.surfMatches1} on surface) | ${player2}: ${eloResult.elo2} (${eloResult.eloMatches2} games, ${eloResult.surfMatches2} on surface)`,
      found1: eloResult.found1,
      found2: eloResult.found2,
    });
  }

  // ── B) Serve/Return Efficiency ──
  const serveResult = serveSubModel(enrich?.serveStats1, enrich?.serveStats2);
  if (serveResult) {
    subModels.push({
      weight: W_SERVE,
      p1: serveResult.p1,
      p2: serveResult.p2,
      label: 'serve',
    });
    factors.push({
      name: 'Serve/Return',
      p1: +(serveResult.p1 * 100).toFixed(1),
      p2: +(serveResult.p2 * 100).toFixed(1),
      weight: W_SERVE,
      detail: `SPW: ${serveResult.spw1}% vs ${serveResult.spw2}% | RPW: ${serveResult.rpw1}% vs ${serveResult.rpw2}% | Dom: ${serveResult.dom1} vs ${serveResult.dom2}`,
    });
  }

  // ── C) Fatigue ──
  const matchTimeMs = match.time ? new Date(match.time).getTime() : Date.now();
  const fatigueResult = fatigueSubModel(db, player1, player2, matchTimeMs, league);
  if (fatigueResult && fatigueResult.confidence > 0) {
    const effectiveWeight = W_FATIGUE * fatigueResult.confidence;
    subModels.push({
      weight: effectiveWeight,
      p1: fatigueResult.p1,
      p2: fatigueResult.p2,
      label: 'fatigue',
    });
    factors.push({
      name: 'Fatigue',
      p1: +(fatigueResult.p1 * 100).toFixed(1),
      p2: +(fatigueResult.p2 * 100).toFixed(1),
      weight: +effectiveWeight.toFixed(2),
      detail: `${player1}: fatigue=${fatigueResult.fatigue1}, days_since=${fatigueResult.days1 ?? '?'}, last7=${fatigueResult.matchesLast7_1} | ${player2}: fatigue=${fatigueResult.fatigue2}, days_since=${fatigueResult.days2 ?? '?'}, last7=${fatigueResult.matchesLast7_2}`,
    });
  }

  // ── D) H2H Surface-Weighted ──
  let h2hResult = h2hSubModel(db, player1, player2, surface);
  if (!h2hResult || h2hResult.allTotal < 1) {
    // Fallback to enrich H2H (Sofascore/DB API)
    h2hResult = h2hFromEnrich(enrich);
  }
  if (h2hResult) {
    const effectiveWeight = W_H2H * h2hResult.confidence;
    subModels.push({
      weight: effectiveWeight,
      p1: h2hResult.p1,
      p2: h2hResult.p2,
      label: 'h2h',
    });
    const surfLabel = h2hResult.usedSurface
      ? `Surface H2H: ${h2hResult.surfaceWins1}-${h2hResult.surfaceWins2} (${surface})`
      : `Overall H2H: ${h2hResult.allWins1}-${h2hResult.allWins2}`;
    factors.push({
      name: 'H2H',
      p1: +(h2hResult.p1 * 100).toFixed(1),
      p2: +(h2hResult.p2 * 100).toFixed(1),
      weight: +effectiveWeight.toFixed(2),
      detail: surfLabel,
      usedSurface: h2hResult.usedSurface,
    });
  }

  // ── Ensemble blend ──
  let ensembleP1, ensembleP2;

  if (subModels.length === 0) {
    // No sub-models available — fall back to implied
    ensembleP1 = impliedP1;
    ensembleP2 = impliedP2;
  } else {
    // Weighted average, then normalize
    const totalWeight = subModels.reduce((s, m) => s + m.weight, 0);
    if (totalWeight <= 0) {
      ensembleP1 = impliedP1;
      ensembleP2 = impliedP2;
    } else {
      ensembleP1 = subModels.reduce((s, m) => s + (m.weight / totalWeight) * m.p1, 0);
      ensembleP2 = subModels.reduce((s, m) => s + (m.weight / totalWeight) * m.p2, 0);
    }
  }

  // Normalize
  const total = ensembleP1 + ensembleP2;
  if (total > 0 && total !== 1) {
    ensembleP1 /= total;
    ensembleP2 /= total;
  }

  // ── Confidence ──
  let confidence = computeConfidence(
    eloResult,
    { form1: enrich?.form1, form2: enrich?.form2 },
    { ranking1: enrich?.ranking1, ranking2: enrich?.ranking2 },
    h2hResult
  );

  // Sharp market cap: tennis ATP/WTA principal (Pinnacle/Betfair) são muito precisos.
  // Limita peso do ensemble em 70% pra evitar edges fantasma em underdog.
  const SHARP_CAP = parseFloat(process.env.TENNIS_SHARP_CAP || '0.70');
  confidence = Math.min(confidence, SHARP_CAP);

  // Divergence penalty: se ensemble diverge do implied em > 15pp, reduz confidence
  // proporcionalmente — grande divergência quase sempre é sinal fraco (small sample,
  // ranking/surface desalinhado), não forte.
  const divergence = Math.abs(ensembleP1 - impliedP1);
  if (divergence > 0.15) {
    const penalty = Math.min(0.5, (divergence - 0.15) * 2); // até -50%
    confidence *= (1 - penalty);
  }

  // ── Final blend: model confidence * ensemble + (1-confidence) * implied ──
  const modelP1 = confidence * ensembleP1 + (1 - confidence) * impliedP1;
  const modelP2 = confidence * ensembleP2 + (1 - confidence) * impliedP2;

  // Normalize final
  const finalTotal = modelP1 + modelP2;
  let finalP1 = finalTotal > 0 ? modelP1 / finalTotal : 0.5;
  let finalP2 = 1 - finalP1;

  // Build method string
  const methodParts = subModels.map(m => m.label);
  let method = methodParts.length
    ? `ensemble(${methodParts.join('+')})`
    : 'implied_only';

  // ── Modelo treinado (shadow/active) ───────────────────────────────────
  // Monta features em runtime a partir do eloResult + enrich + DB state.
  let trainedPred = null;
  if (TRAINED_MODE !== 'off' && hasTrainedModel() && eloResult) {
    try {
      // fatigue/h2h já foram computados; extraimos contadores
      const matches14d_1 = fatigueResult ? (fatigueResult.matchesLast7_1 || 0) : 0;
      const matches14d_2 = fatigueResult ? (fatigueResult.matchesLast7_2 || 0) : 0;
      const days1 = fatigueResult ? (fatigueResult.days1 ?? null) : null;
      const days2 = fatigueResult ? (fatigueResult.days2 ?? null) : null;
      // fatigueMin aproximado via matchesLast7 × 90min (placeholder; ideal puxar do DB)
      const fatMin1 = matches14d_1 * 90;
      const fatMin2 = matches14d_2 * 90;

      const h2hSurf1 = h2hResult?.surfaceWins1 || 0;
      const h2hSurf2 = h2hResult?.surfaceWins2 || 0;
      const h2hAll1 = h2hResult?.allWins1 || 0;
      const h2hAll2 = h2hResult?.allWins2 || 0;

      trainedPred = predictTrainedTennis({
        eloOverall1: eloResult.eloOverall1 || eloResult.elo1,
        eloOverall2: eloResult.eloOverall2 || eloResult.elo2,
        eloSurface1: eloResult.eloSurface1 || eloResult.elo1,
        eloSurface2: eloResult.eloSurface2 || eloResult.elo2,
        gamesSurface1: eloResult.surfMatches1,
        gamesSurface2: eloResult.surfMatches2,
        surface,
        rank1: enrich?.ranking1?.rank,
        rank2: enrich?.ranking2?.rank,
        rankPoints1: enrich?.ranking1?.points,
        rankPoints2: enrich?.ranking2?.points,
        age1: enrich?.ranking1?.age,
        age2: enrich?.ranking2?.age,
        height1: enrich?.ranking1?.height,
        height2: enrich?.ranking2?.height,
        servePct1: enrich?.serveStats1?.spw,
        servePct2: enrich?.serveStats2?.spw,
        fatigueMin7d_1: fatMin1,
        fatigueMin7d_2: fatMin2,
        matches14d_1, matches14d_2,
        daysSinceLast1: days1,
        daysSinceLast2: days2,
        h2hSurface1: h2hSurf1,
        h2hSurface2: h2hSurf2,
        h2hAll1, h2hAll2,
        bestOf: /grand slam|\[g\]|wimbledon|us open|roland|australian/i.test(league) ? 5 : 3,
      });
    } catch (e) {
      log('WARN', 'TENNIS-MODEL', `trained predict error: ${e.message}`);
    }
  }

  if (trainedPred) {
    const divT = Math.abs(trainedPred.p1 - impliedP1);
    log('INFO', 'TENNIS-TRAINED',
      `${player1} vs ${player2} | surf=${surface} | trainedP1=${(trainedPred.p1*100).toFixed(1)}% (raw=${(trainedPred.raw*100).toFixed(1)}%) | heuristicP1=${(finalP1*100).toFixed(1)}% | impliedP1=${(impliedP1*100).toFixed(1)}% | div=${(divT*100).toFixed(1)}pp | conf=${trainedPred.confidence}`);

    if (TRAINED_MODE === 'active') {
      const confT = trainedPred.confidence;
      // Blend trained com implied (prior do mercado) usando confidence do próprio trained
      const blendedT1 = confT * trainedPred.p1 + (1 - confT) * impliedP1;
      const blendedT2 = 1 - blendedT1;
      finalP1 = +blendedT1.toFixed(4);
      finalP2 = +blendedT2.toFixed(4);
      method = trainedPred.method;
    }
  }

  // Post-hoc isotonic calibration — reduz ECE de ~0.17 pra ~0.04 e Brier -14%.
  // Só aplica quando blocks carregados e confidence mínima. Aplicado por último
  // (after blend com trained).
  if (_isotonicBlocks && confidence > 0.20) {
    const preCal = finalP1;
    finalP1 = _applyIsotonic(finalP1);
    finalP2 = 1 - finalP1;
    if (Math.abs(finalP1 - preCal) > 0.02) {
      log('DEBUG', 'TENNIS-MODEL', `  └ isotonic: ${(preCal*100).toFixed(1)}% → ${(finalP1*100).toFixed(1)}%`);
    }
  }

  log('DEBUG', 'TENNIS-MODEL', `${player1} vs ${player2} | surface=${surface} | method=${method} | P1=${(finalP1*100).toFixed(1)}% | conf=${confidence.toFixed(2)} | factors=${subModels.length} | ensembleP1=${(ensembleP1*100).toFixed(1)}% impliedP1=${(impliedP1*100).toFixed(1)}% divergence=${(divergence*100).toFixed(1)}pp`);
  if (divergence > 0.10 && subModels.length) {
    const breakdown = subModels.map(m => `${m.label}:${(m.p1*100).toFixed(0)}%(w${m.weight.toFixed(2)})`).join(' | ');
    log('DEBUG', 'TENNIS-MODEL', `  └ sub-models: ${breakdown}`);
  }

  return {
    modelP1: +finalP1.toFixed(4),
    modelP2: +finalP2.toFixed(4),
    confidence: +confidence.toFixed(2),
    method,
    surface,
    tier: tournamentTier(league),
    factors,
    // Expose sub-model details for logging
    _elo: eloResult || null,
    _serve: serveResult || null,
    _fatigue: fatigueResult || null,
    _h2h: h2hResult || null,
    _trained: trainedPred || null,
    _trainedMode: TRAINED_MODE,
    _implied: { p1: +impliedP1.toFixed(4), p2: +impliedP2.toFixed(4) },
  };
}

module.exports = {
  getTennisProbability,
  detectSurface,
  tournamentTier,
  extractItfPrizePool,
  tennisProhibitedTournament,
  // Expose sub-models for unit testing
  eloSubModel,
  serveSubModel,
  fatigueSubModel,
  h2hSubModel,
};

'use strict';

/**
 * tennis-player-stats.js — estatísticas históricas por jogador (ace/DF/serve)
 * baseadas em tennis_match_stats (Sackmann).
 *
 * API:
 *   getPlayerServeProfile(db, playerName, { sinceDays, surface, minMatches })
 *     → { firstInPct, firstWonPct, secondWonPct, acePerMatchAvg, acePerSvptPct,
 *         dfPerMatchAvg, dfPerSvptPct, matches }
 *
 *   getPlayerAceRate(db, playerName, { sinceDays, surface, minMatches })
 *     → { acePerMatchAvg, acePerSvptPct, matches } | null
 *
 *   getPlayerDfRate(db, playerName, opts) → { dfPerMatchAvg, dfPerSvptPct, matches } | null
 */

function _normName(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

const _cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30min

/**
 * Busca stats agregadas pro jogador. Retorna aggregates per match considerando
 * AMBAS as linhas onde ele é p1 OU p2.
 */
function getPlayerServeProfile(db, playerName, opts = {}) {
  const name = _normName(playerName);
  if (!name) return null;
  const sinceDays = opts.sinceDays ?? 730; // 2y default — Sackmann updates annually
  const surface = opts.surface ? String(opts.surface).toLowerCase() : null;
  const minMatches = opts.minMatches ?? 5;

  const cacheKey = `${name}|${sinceDays}|${surface || '_'}|${minMatches}`;
  const hit = _cache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL) return hit.data;

  const surfaceFilter = surface ? `AND surface = '${surface.replace(/'/g, "''")}'` : '';

  try {
    // Player pode ser p1 ou p2. Agrega stats correspondentes.
    const rows = db.prepare(`
      SELECT
        CASE WHEN lower(player1) = ? THEN p1_ace ELSE p2_ace END AS ace,
        CASE WHEN lower(player1) = ? THEN p1_df ELSE p2_df END AS df,
        CASE WHEN lower(player1) = ? THEN p1_svpt ELSE p2_svpt END AS svpt,
        CASE WHEN lower(player1) = ? THEN p1_1st_in ELSE p2_1st_in END AS first_in,
        CASE WHEN lower(player1) = ? THEN p1_1st_won ELSE p2_1st_won END AS first_won,
        CASE WHEN lower(player1) = ? THEN p1_2nd_won ELSE p2_2nd_won END AS second_won,
        CASE WHEN lower(player1) = ? THEN p1_sv_gms ELSE p2_sv_gms END AS sv_gms
      FROM tennis_match_stats
      WHERE (lower(player1) = ? OR lower(player2) = ?)
        AND date >= datetime('now', '-${sinceDays} days')
        AND svpt IS NOT NULL AND svpt > 0
        ${surfaceFilter}
    `).all(name, name, name, name, name, name, name, name, name);

    if (rows.length < minMatches) {
      _cache.set(cacheKey, { ts: Date.now(), data: null });
      return null;
    }

    let totalAce = 0, totalDf = 0, totalSvpt = 0, totalFirstIn = 0, totalFirstWon = 0, totalSecondWon = 0, totalSvGms = 0;
    let matchesWithSvpt = 0;
    for (const r of rows) {
      if (!Number.isFinite(r.svpt) || r.svpt <= 0) continue;
      totalAce += r.ace || 0;
      totalDf += r.df || 0;
      totalSvpt += r.svpt;
      totalFirstIn += r.first_in || 0;
      totalFirstWon += r.first_won || 0;
      totalSecondWon += r.second_won || 0;
      totalSvGms += r.sv_gms || 0;
      matchesWithSvpt++;
    }
    if (matchesWithSvpt < minMatches) {
      _cache.set(cacheKey, { ts: Date.now(), data: null });
      return null;
    }

    const firstInPct = totalSvpt > 0 ? +(totalFirstIn / totalSvpt).toFixed(4) : null;
    const firstWonPct = totalFirstIn > 0 ? +(totalFirstWon / totalFirstIn).toFixed(4) : null;
    const secondServes = totalSvpt - totalFirstIn;
    const secondWonPct = secondServes > 0 ? +(totalSecondWon / secondServes).toFixed(4) : null;
    const acePerMatchAvg = +(totalAce / matchesWithSvpt).toFixed(2);
    const acePerSvptPct = +(totalAce / totalSvpt * 100).toFixed(2);
    const dfPerMatchAvg = +(totalDf / matchesWithSvpt).toFixed(2);
    const dfPerSvptPct = +(totalDf / totalSvpt * 100).toFixed(2);

    const data = {
      firstInPct, firstWonPct, secondWonPct,
      acePerMatchAvg, acePerSvptPct,
      dfPerMatchAvg, dfPerSvptPct,
      matches: matchesWithSvpt,
      totalSvpt, totalSvGms,
      surface: surface || null,
    };
    _cache.set(cacheKey, { ts: Date.now(), data });
    return data;
  } catch (e) {
    _cache.set(cacheKey, { ts: Date.now(), data: null });
    return null;
  }
}

function getPlayerAceRate(db, playerName, opts = {}) {
  const p = getPlayerServeProfile(db, playerName, opts);
  if (!p) return null;
  return { acePerMatchAvg: p.acePerMatchAvg, acePerSvptPct: p.acePerSvptPct, matches: p.matches };
}

function getPlayerDfRate(db, playerName, opts = {}) {
  const p = getPlayerServeProfile(db, playerName, opts);
  if (!p) return null;
  return { dfPerMatchAvg: p.dfPerMatchAvg, dfPerSvptPct: p.dfPerSvptPct, matches: p.matches };
}

function invalidateCache() { _cache.clear(); }

module.exports = {
  getPlayerServeProfile,
  getPlayerAceRate,
  getPlayerDfRate,
  invalidateCache,
};

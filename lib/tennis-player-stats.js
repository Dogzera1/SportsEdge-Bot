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
  // 2026-04-28: clamp + bind pra SQL safety. Antes `${sinceDays} days`
  // template direto + surface com escape parcial — defesa em profundidade.
  const _clampDays = (v, def, max = 3650) => {
    const n = parseInt(v, 10);
    return (Number.isFinite(n) && n > 0 && n <= max) ? n : def;
  };
  const sinceDays = _clampDays(opts.sinceDays, 730); // 2y default
  const surface = opts.surface ? String(opts.surface).toLowerCase().slice(0, 32) : null;
  const minMatches = opts.minMatches ?? 5;

  const cacheKey = `${name}|${sinceDays}|${surface || '_'}|${minMatches}`;
  const hit = _cache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL) return hit.data;

  // Surface aceita só [a-z]+ — defesa contra injection se vazar caller exposto.
  const surfaceClean = surface && /^[a-z]+$/.test(surface) ? surface : null;
  const surfaceFilter = surfaceClean ? `AND surface = ?` : '';
  const surfaceArgs = surfaceClean ? [surfaceClean] : [];

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
        AND date >= datetime('now', ?)
        AND svpt IS NOT NULL AND svpt > 0
        ${surfaceFilter}
    `).all(name, name, name, name, name, name, name, name, name, `-${sinceDays} days`, ...surfaceArgs);

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

/**
 * Clutch stats: BP save % em situações de pressão no saque.
 * Diferencia tops (~70%) de mid-tier (~55%). Sinal moderado pra tiebreaks+decisive games.
 *
 * @returns {{ bpSavePct, totalFaced, totalSaved, matches } | null}
 */
/**
 * Return stats: BP conversion % (como retornador, com que freq converte BPs).
 * Complementa BP save (como sacador). Sinal independente.
 *
 * Ex: Sinner é elite em saque E retorno; Isner elite em saque mas fraco retornando.
 *
 * @returns {{ bpConversionPct, totalConverted, totalOpportunities, matches } | null}
 */
function getPlayerReturnStats(db, playerName, opts = {}) {
  const name = _normName(playerName);
  if (!name) return null;
  const _clampDays = (v, def) => { const n = parseInt(v, 10); return (Number.isFinite(n) && n > 0 && n <= 3650) ? n : def; };
  const sinceDays = _clampDays(opts.sinceDays, 730);
  const surface = opts.surface ? String(opts.surface).toLowerCase().slice(0, 32) : null;
  const minMatches = opts.minMatches ?? 10;
  const surfaceClean = surface && /^[a-z]+$/.test(surface) ? surface : null;
  const surfaceFilter = surfaceClean ? `AND surface = ?` : '';
  const surfaceArgs = surfaceClean ? [surfaceClean] : [];

  try {
    // Pra player = p1 em row: oponent stats são p2_bp_*. Conversão = (opp_faced - opp_saved) / opp_faced.
    const rows = db.prepare(`
      SELECT
        CASE WHEN lower(player1) = ? THEN p2_bp_faced ELSE p1_bp_faced END AS opp_faced,
        CASE WHEN lower(player1) = ? THEN p2_bp_saved ELSE p1_bp_saved END AS opp_saved
      FROM tennis_match_stats
      WHERE (lower(player1) = ? OR lower(player2) = ?)
        AND date >= datetime('now', ?)
        ${surfaceFilter}
    `).all(name, name, name, name, `-${sinceDays} days`, ...surfaceArgs);
    if (rows.length < minMatches) return null;
    let totalFaced = 0, totalSaved = 0, matches = 0;
    for (const r of rows) {
      if (!Number.isFinite(r.opp_faced) || r.opp_faced <= 0) continue;
      totalFaced += r.opp_faced;
      totalSaved += r.opp_saved || 0;
      matches++;
    }
    if (matches < minMatches || totalFaced < 20) return null;
    const totalConverted = totalFaced - totalSaved;
    return {
      bpConversionPct: +(totalConverted / totalFaced * 100).toFixed(2),
      totalConverted, totalOpportunities: totalFaced, matches,
    };
  } catch (_) { return null; }
}

function getPlayerClutchStats(db, playerName, opts = {}) {
  const name = _normName(playerName);
  if (!name) return null;
  const _clampDays = (v, def) => { const n = parseInt(v, 10); return (Number.isFinite(n) && n > 0 && n <= 3650) ? n : def; };
  const sinceDays = _clampDays(opts.sinceDays, 730);
  const surface = opts.surface ? String(opts.surface).toLowerCase().slice(0, 32) : null;
  const minMatches = opts.minMatches ?? 10;
  const surfaceClean = surface && /^[a-z]+$/.test(surface) ? surface : null;
  const surfaceFilter = surfaceClean ? `AND surface = ?` : '';
  const surfaceArgs = surfaceClean ? [surfaceClean] : [];

  try {
    const rows = db.prepare(`
      SELECT
        CASE WHEN lower(player1) = ? THEN p1_bp_saved ELSE p2_bp_saved END AS saved,
        CASE WHEN lower(player1) = ? THEN p1_bp_faced ELSE p2_bp_faced END AS faced
      FROM tennis_match_stats
      WHERE (lower(player1) = ? OR lower(player2) = ?)
        AND date >= datetime('now', ?)
        ${surfaceFilter}
    `).all(name, name, name, name, `-${sinceDays} days`, ...surfaceArgs);
    if (rows.length < minMatches) return null;
    let totalSaved = 0, totalFaced = 0, matches = 0;
    for (const r of rows) {
      if (!Number.isFinite(r.faced) || r.faced <= 0) continue;
      totalSaved += r.saved || 0;
      totalFaced += r.faced;
      matches++;
    }
    if (matches < minMatches || totalFaced < 20) return null;
    return {
      bpSavePct: +(totalSaved / totalFaced * 100).toFixed(2),
      totalSaved, totalFaced, matches,
    };
  } catch (_) { return null; }
}

function getPlayerDfRate(db, playerName, opts = {}) {
  const p = getPlayerServeProfile(db, playerName, opts);
  if (!p) return null;
  return { dfPerMatchAvg: p.dfPerMatchAvg, dfPerSvptPct: p.dfPerSvptPct, matches: p.matches };
}

/**
 * Rank info: retorna rank mais recente do jogador no DB (proxy pra current rank)
 * + melhor rank histórico + trajetória (last 5 matches ranks).
 *
 * @returns {{ latestRank, bestRank, recentRanks: Array<{date, rank}>, matches } | null}
 */
function getPlayerRankInfo(db, playerName, opts = {}) {
  const name = _normName(playerName);
  if (!name) return null;
  const _clampDays = (v, def) => { const n = parseInt(v, 10); return (Number.isFinite(n) && n > 0 && n <= 3650) ? n : def; };
  const sinceDays = _clampDays(opts.sinceDays, 730);

  try {
    const rows = db.prepare(`
      SELECT
        date,
        CASE WHEN lower(player1) = ? THEN p1_rank ELSE p2_rank END AS rank
      FROM tennis_match_stats
      WHERE (lower(player1) = ? OR lower(player2) = ?)
        AND date >= datetime('now', ?)
      ORDER BY date DESC
      LIMIT 30
    `).all(name, name, name, `-${sinceDays} days`);
    const valid = rows.filter(r => Number.isFinite(r.rank) && r.rank > 0);
    if (!valid.length) return null;
    const latestRank = valid[0].rank;
    const bestRank = Math.min(...valid.map(r => r.rank));
    const recentRanks = valid.slice(0, 5).map(r => ({ date: r.date.slice(0, 10), rank: r.rank }));
    return { latestRank, bestRank, recentRanks, matches: valid.length };
  } catch (_) { return null; }
}

/**
 * Return Points Won % (RPW) por superfície. Complementa SPW pra opponent
 * adjustment Klaassen-Magnus: P1's expected SPW vs P2 = league_avg + (P1_SPW
 * - league_avg_SPW) - (P2_RPW - league_avg_RPW). Sem RPW, modelo só captura
 * skill geral do sacador, não força específica do retornador.
 *
 * Implementação: pra cada match do jogador, soma pontos de SAQUE do oponente
 * (svpt) e pontos perdidos pelo oponente quando saca (= ganhos pelo jogador
 * no return). RPW = total_won_returning / total_opp_svpt.
 *
 * @returns {{ rpwPct, totalReturnPoints, totalReturnWon, matches } | null}
 */
function getPlayerReturnPointsWon(db, playerName, opts = {}) {
  const name = _normName(playerName);
  if (!name) return null;
  const _clampDays = (v, def) => { const n = parseInt(v, 10); return (Number.isFinite(n) && n > 0 && n <= 3650) ? n : def; };
  const sinceDays = _clampDays(opts.sinceDays, 730);
  const surface = opts.surface ? String(opts.surface).toLowerCase().slice(0, 32) : null;
  const minMatches = opts.minMatches ?? 5;
  const surfaceClean = surface && /^[a-z]+$/.test(surface) ? surface : null;
  const surfaceFilter = surfaceClean ? `AND surface = ?` : '';
  const surfaceArgs = surfaceClean ? [surfaceClean] : [];

  const cacheKey = `rpw|${name}|${sinceDays}|${surfaceClean || '_'}|${minMatches}`;
  const hit = _cache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL) return hit.data;

  try {
    // Player retorna quando oponente saca. Aggrega oponent serving stats.
    const rows = db.prepare(`
      SELECT
        CASE WHEN lower(player1) = ? THEN p2_svpt ELSE p1_svpt END AS opp_svpt,
        CASE WHEN lower(player1) = ? THEN (p2_1st_won + p2_2nd_won) ELSE (p1_1st_won + p1_2nd_won) END AS opp_won
      FROM tennis_match_stats
      WHERE (lower(player1) = ? OR lower(player2) = ?)
        AND date >= datetime('now', ?)
      ${surfaceFilter}
    `).all(name, name, name, name, `-${sinceDays} days`, ...surfaceArgs);
    if (rows.length < minMatches) {
      _cache.set(cacheKey, { ts: Date.now(), data: null });
      return null;
    }
    let totalSvpt = 0, totalWon = 0, matches = 0;
    for (const r of rows) {
      if (!Number.isFinite(r.opp_svpt) || r.opp_svpt <= 0) continue;
      totalSvpt += r.opp_svpt;
      // Player ganhou no return = points oponente saca - points oponente venceu
      totalWon += r.opp_svpt - (r.opp_won || 0);
      matches++;
    }
    if (matches < minMatches || totalSvpt < 50) {
      _cache.set(cacheKey, { ts: Date.now(), data: null });
      return null;
    }
    const data = {
      rpwPct: +(totalWon / totalSvpt).toFixed(4),
      totalReturnPoints: totalSvpt,
      totalReturnWon: totalWon,
      matches,
      surface: surfaceClean || null,
    };
    _cache.set(cacheKey, { ts: Date.now(), data });
    return data;
  } catch (_) {
    _cache.set(cacheKey, { ts: Date.now(), data: null });
    return null;
  }
}

/**
 * Klaassen-Magnus opponent-adjusted serve probability.
 * Ajusta p1Serve baseado na força de retorno de P2 (e vice-versa).
 *
 *   p1Serve_vs_p2 = avg_SPW + (p1_SPW - avg_SPW) - (p2_RPW - avg_RPW)
 *
 * Onde avg_SPW + avg_RPW = 1 por construção (todo ponto vai pra alguém).
 *
 * @param {number} p1Spw — P(P1 win point on serve), e.g. 0.65
 * @param {number} p2Spw — P(P2 win point on serve)
 * @param {number} p1Rpw — P(P1 win point on return), e.g. 0.39
 * @param {number} p2Rpw — P(P2 win point on return)
 * @param {number} avgSpw — surface average SPW (default per surface)
 * @returns {{ p1Adj, p2Adj }}
 */
function adjustServeProbsKM(p1Spw, p2Spw, p1Rpw, p2Rpw, avgSpw = 0.62) {
  const avgRpw = 1 - avgSpw;
  const p1ServeDelta = p1Spw - avgSpw;
  const p2ReturnDelta = p2Rpw - avgRpw;
  const p2ServeDelta = p2Spw - avgSpw;
  const p1ReturnDelta = p1Rpw - avgRpw;
  const p1Adj = avgSpw + p1ServeDelta - p2ReturnDelta;
  const p2Adj = avgSpw + p2ServeDelta - p1ReturnDelta;
  // Clamp em range realista [0.40, 0.85] pra evitar artifacts numéricos.
  return {
    p1Adj: Math.max(0.40, Math.min(0.85, p1Adj)),
    p2Adj: Math.max(0.40, Math.min(0.85, p2Adj)),
  };
}

function invalidateCache() { _cache.clear(); }

module.exports = {
  getPlayerServeProfile,
  getPlayerAceRate,
  getPlayerDfRate,
  getPlayerClutchStats,
  getPlayerReturnStats,
  getPlayerReturnPointsWon,
  getPlayerRankInfo,
  adjustServeProbsKM,
  invalidateCache,
};

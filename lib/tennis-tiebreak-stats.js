'use strict';

/**
 * tennis-tiebreak-stats.js — rolling tiebreak win rate per player.
 *
 * Parseia `final_score` de match_results pra extrair TBs jogados (sets 7-6/6-7)
 * e computa W/L rolling últimos 12m. TB WR é altamente preditivo em mercados de
 * set/TB — jogadores tipo Federer (historicamente), Isner têm edge real em TB.
 *
 * Assume convenção: em final_score, o primeiro número de cada set é team1.
 *
 * Output por jogador:
 *   { games, wr, recentGames, recentWr, sampleQuality }
 */

const DAY_MS = 86400000;

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
}

/**
 * Dado final_score string, retorna pra cada TB set:
 *   { team1WonTb: boolean }
 * Retorna array vazio se sem TB.
 */
function extractTiebreakSets(finalScore) {
  const s = String(finalScore || '');
  const tbs = [];
  // Match sets like "7-6(3)" or "6-7(5)" or simple "7-6" / "6-7"
  const setRegex = /\b(\d+)-(\d+)(?:\s*\(\d+\))?/g;
  let m;
  while ((m = setRegex.exec(s)) !== null) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    // TB sets são exatamente 7-6 ou 6-7 (extensão de 6-6 até 7)
    if (a === 7 && b === 6) tbs.push({ team1WonTb: true });
    else if (a === 6 && b === 7) tbs.push({ team1WonTb: false });
  }
  return tbs;
}

// Cache por jogador
const _cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h

/**
 * @returns {{ games, wr, recentGames, recentWr, sampleQuality } | null}
 */
function getPlayerTiebreakStats(db, playerName, opts = {}) {
  const n = normName(playerName);
  if (!n) return null;
  const lookbackDays = opts.lookbackDays ?? 365;
  const recentDays = opts.recentDays ?? 90;
  const minGames = opts.minGames ?? 5;

  const cacheKey = `${n}|${lookbackDays}`;
  const hit = _cache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL) return hit.data;

  let rows;
  try {
    rows = db.prepare(`
      SELECT team1, team2, winner, final_score, resolved_at
      FROM match_results
      WHERE game = 'tennis'
        AND resolved_at >= datetime('now', '-${lookbackDays} days')
        AND final_score IS NOT NULL AND final_score != ''
        AND (lower(team1) = ? OR lower(team2) = ? OR lower(team1) LIKE ? OR lower(team2) LIKE ?)
      ORDER BY resolved_at DESC
    `).all(n, n, `%${n}%`, `%${n}%`);
  } catch (_) { return null; }

  if (!rows.length) {
    _cache.set(cacheKey, { ts: Date.now(), data: null });
    return null;
  }

  const now = Date.now();
  let total = 0, wins = 0;
  let recentTotal = 0, recentWins = 0;

  for (const r of rows) {
    const sets = extractTiebreakSets(r.final_score);
    if (!sets.length) continue;
    const isPlayerT1 = normName(r.team1) === n || normName(r.team1).includes(n) || n.includes(normName(r.team1));
    const ts = new Date(r.resolved_at).getTime();
    const ageDays = (now - ts) / DAY_MS;
    for (const set of sets) {
      total++;
      const playerWon = isPlayerT1 ? set.team1WonTb : !set.team1WonTb;
      if (playerWon) wins++;
      if (ageDays <= recentDays) {
        recentTotal++;
        if (playerWon) recentWins++;
      }
    }
  }

  if (total < minGames) {
    const out = { games: total, wr: 0.5, recentGames: recentTotal, recentWr: 0.5, sampleQuality: 'low' };
    _cache.set(cacheKey, { ts: Date.now(), data: out });
    return out;
  }

  const wr = wins / total;
  const recentWr = recentTotal > 0 ? recentWins / recentTotal : wr;
  const sampleQuality = total >= 20 ? 'high' : total >= 10 ? 'med' : 'low';

  const out = {
    games: total,
    wr: +wr.toFixed(3),
    recentGames: recentTotal,
    recentWr: +recentWr.toFixed(3),
    sampleQuality,
  };
  _cache.set(cacheKey, { ts: Date.now(), data: out });
  return out;
}

/**
 * Dado as TB stats dos 2 jogadores, retorna fator multiplicativo pra ajustar
 * o pB de TB nos markov sims. Fator > 1 beneficia team1.
 *
 * Cap ±15%: jogador com TB WR 65% (15pp acima de 50%) vs média → 1.15×.
 */
function getTiebreakAdjustment(stats1, stats2) {
  if (!stats1 || !stats2 || stats1.sampleQuality === 'low' && stats2.sampleQuality === 'low') {
    return { factor: 1, reason: 'insufficient data' };
  }
  // Blend: 60% rolling 12m, 40% recent 90d quando há amostra recente
  const getBlended = (s) => {
    if (s.recentGames >= 5) return 0.6 * s.wr + 0.4 * s.recentWr;
    return s.wr;
  };
  const b1 = getBlended(stats1);
  const b2 = getBlended(stats2);
  // Normaliza: se ambos TB WR > 0.5, é a diferença que importa.
  // factor = 1 + (b1 - b2) × 0.3 (cap ±15%)
  const delta = (b1 - b2) * 0.3;
  const factor = Math.max(0.85, Math.min(1.15, 1 + delta));
  return {
    factor: +factor.toFixed(3),
    b1: +b1.toFixed(3), b2: +b2.toFixed(3),
    reason: `TB WR: ${(b1*100).toFixed(0)}% vs ${(b2*100).toFixed(0)}% → factor ×${factor.toFixed(2)}`,
  };
}

function invalidateCache() { _cache.clear(); }

module.exports = {
  getPlayerTiebreakStats,
  getTiebreakAdjustment,
  extractTiebreakSets,
  invalidateCache,
};

'use strict';

/**
 * tennis-injury-risk.js — detector light de risco de lesão a partir de sinais
 * já presentes em match_results. Sem dependência externa (Twitter/RSS).
 *
 * Sinais:
 *   1. Retirement rate últimos 365d — %matches perdidos via RET/W/O.
 *      Threshold crítico: >8% = histórico de problemas físicos.
 *   2. Recent retirements últimos 30d — peso maior (sinal fresco).
 *   3. Perdas por bagel (6-0) recentes — sinal de fadiga/indisposição.
 *
 * Uso:
 *   const r = getPlayerInjuryRisk(db, 'Casper Ruud');
 *   // r = { risk: 0.35, level: 'medium', reasons: [...], retRate: 0.12, lastRetDays: 22 }
 *
 * Saída:
 *   - risk: 0..1 score agregado
 *   - level: 'low' (<0.20) | 'medium' (0.20-0.45) | 'high' (≥0.45)
 *   - reasons: array de razões textuais pro log
 */

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
}

function _isRetScore(fs) {
  const s = String(fs || '').toLowerCase();
  return /\bret\b|\bw\/o\b|retired|walkover/.test(s);
}

// Cache curto — chamado 1x por pollTennis cycle por jogador
const _cache = new Map(); // norm(name) → { ts, data }
const TTL_MS = 15 * 60 * 1000;

function getPlayerInjuryRisk(db, playerName, opts = {}) {
  const n = normName(playerName);
  if (!n) return null;
  const hit = _cache.get(n);
  if (hit && (Date.now() - hit.ts) < TTL_MS) return hit.data;

  const lookbackDays = opts.lookbackDays ?? 365;
  const recentDays = opts.recentDays ?? 30;
  const minGames = opts.minGames ?? 10;

  let rows;
  try {
    rows = db.prepare(`
      SELECT team1, team2, winner, final_score, resolved_at
      FROM match_results
      WHERE game = 'tennis'
        AND resolved_at >= datetime('now', '-${lookbackDays} days')
        AND (lower(team1) = ? OR lower(team2) = ? OR lower(team1) LIKE ? OR lower(team2) LIKE ?)
      ORDER BY resolved_at DESC
    `).all(n, n, `%${n}%`, `%${n}%`);
  } catch (_) { return null; }

  if (!rows.length) {
    _cache.set(n, { ts: Date.now(), data: null });
    return null;
  }

  // Filtra por match confirmado (winner set)
  const settled = rows.filter(r => r.winner);
  if (settled.length < minGames) {
    const out = { risk: 0, level: 'low', reasons: [`amostra pequena (${settled.length} jogos)`], games: settled.length };
    _cache.set(n, { ts: Date.now(), data: out });
    return out;
  }

  const now = Date.now();
  let totalLosses = 0, retLosses = 0, recentRetLosses = 0;
  let bagelLosses = 0, recentBagelLosses = 0;
  let lastRetTs = null;

  for (const r of settled) {
    const isPlayerT1 = normName(r.team1) === n || normName(r.team1).includes(n) || n.includes(normName(r.team1));
    const won = normName(r.winner) === (isPlayerT1 ? normName(r.team1) : normName(r.team2));
    if (won) continue;
    totalLosses++;
    const ts = new Date(r.resolved_at).getTime();
    const ageDays = (now - ts) / 86400000;

    if (_isRetScore(r.final_score)) {
      retLosses++;
      if (ageDays <= recentDays) recentRetLosses++;
      if (!lastRetTs || ts > lastRetTs) lastRetTs = ts;
    }
    // Bagel detection: player perdeu set 6-0 ou 0-6 (jogador foi bageled)
    const fs = String(r.final_score || '');
    const sets = fs.match(/\b(\d+)-(\d+)\b/g) || [];
    for (const set of sets) {
      const [a, b] = set.split('-').map(Number);
      // se jogador é T1: perdeu set quando a < b; se T2: perdeu quando a > b
      const playerSetScore = isPlayerT1 ? a : b;
      const oppSetScore = isPlayerT1 ? b : a;
      if (playerSetScore === 0 && oppSetScore === 6) {
        bagelLosses++;
        if (ageDays <= recentDays) recentBagelLosses++;
        break;
      }
    }
  }

  const retRate = totalLosses > 0 ? retLosses / settled.length : 0;
  const recentRetRate = recentRetLosses / Math.max(1, settled.filter(r => (now - new Date(r.resolved_at).getTime()) / 86400000 <= recentDays).length);
  const bagelRate = totalLosses > 0 ? bagelLosses / settled.length : 0;
  const lastRetDays = lastRetTs ? Math.round((now - lastRetTs) / 86400000) : null;

  // Score agregado (0..1):
  //   retRate: 0-10% → 0-0.3; 10-20% → 0.3-0.5; >20% → 0.5+
  //   recentRetRate: >5% → +0.15
  //   recentRetLosses: 1 → +0.15; 2+ → +0.30
  //   recentBagelLosses: 1 → +0.10; 2+ → +0.20
  let risk = 0;
  if (retRate >= 0.20) risk += 0.50;
  else if (retRate >= 0.10) risk += 0.30;
  else if (retRate >= 0.05) risk += 0.15;

  if (recentRetLosses >= 2) risk += 0.30;
  else if (recentRetLosses === 1) risk += 0.20;

  if (recentBagelLosses >= 2) risk += 0.15;
  else if (recentBagelLosses === 1) risk += 0.08;

  risk = Math.min(1, risk);
  const level = risk >= 0.45 ? 'high' : risk >= 0.20 ? 'medium' : 'low';

  const reasons = [];
  if (retRate >= 0.05) reasons.push(`retRate=${(retRate * 100).toFixed(1)}% (${retLosses}/${settled.length} jogos)`);
  if (recentRetLosses > 0) reasons.push(`${recentRetLosses} RET últimos ${recentDays}d`);
  if (recentBagelLosses > 0) reasons.push(`${recentBagelLosses} bagels (6-0 perdido) últimos ${recentDays}d`);
  if (lastRetDays != null && lastRetDays <= recentDays) reasons.push(`última retirada há ${lastRetDays}d`);

  const out = {
    risk: +risk.toFixed(3),
    level,
    reasons,
    retRate: +retRate.toFixed(3),
    retLosses,
    recentRetLosses,
    bagelLosses,
    recentBagelLosses,
    lastRetDays,
    games: settled.length,
  };
  _cache.set(n, { ts: Date.now(), data: out });
  return out;
}

function invalidateCache(playerName) {
  if (playerName) _cache.delete(normName(playerName));
  else _cache.clear();
}

module.exports = { getPlayerInjuryRisk, invalidateCache, _isRetScore };

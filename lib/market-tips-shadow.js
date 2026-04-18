'use strict';

/**
 * market-tips-shadow.js — logging estruturado de market tips detectadas (sem DM).
 *
 * Uso:
 *   const { logShadowTip, settleShadowTips, getShadowStats } = require('./market-tips-shadow');
 *
 *   logShadowTip(db, { sport, match, bestOf, tip, stake });
 *   settleShadowTips(db);  // cron: cruza com match_results
 *   getShadowStats(db, { sport, days }); // agregação pra report
 *
 * Dedup: mesmo (match_key, market, line, side) não é re-logado em <12h.
 * Settlement: pra match_winner/handicap, cruza winner de match_results.
 *   Totais/TB/Aces precisam de metadata adicional (final_score parsing).
 */

const { log } = require('./utils');

function _norm(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); }

function _matchKey(match) {
  const a = _norm(match.team1), b = _norm(match.team2);
  const t = match.time || match.start_time || '';
  return `${a}|${b}|${(t || '').slice(0, 10)}`;
}

/**
 * @param {object} db
 * @param {object} args
 * @param {string} args.sport — 'lol' | 'dota2' | 'cs2' | 'valorant' | 'tennis'
 * @param {object} args.match — { team1, team2, league, time?, ... }
 * @param {number} args.bestOf
 * @param {object} args.tip   — { market, line, side, pModel, pImplied, odd, ev, label }
 * @param {number} [args.stakeUnits] — opcional
 * @param {object} [args.meta] — qualquer extra JSON-serializable
 */
function logShadowTip(db, args) {
  try {
    const { sport, match, bestOf, tip, stakeUnits = null, meta = null } = args;
    if (!db || !match || !tip) return false;
    const matchKey = _matchKey(match);

    // Dedup: mesmo (match_key, market, line, side) em <12h
    const existing = db.prepare(`
      SELECT id FROM market_tips_shadow
      WHERE match_key = ? AND market = ? AND line IS ? AND side IS ?
        AND created_at >= datetime('now', '-12 hours')
      LIMIT 1
    `).get(matchKey, tip.market, tip.line ?? null, tip.side ?? null);
    if (existing) return false;

    db.prepare(`
      INSERT INTO market_tips_shadow
        (sport, match_key, team1, team2, league, best_of,
         market, line, side, label, p_model, p_implied, odd, ev_pct, stake_units,
         meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sport,
      matchKey,
      match.team1 || null,
      match.team2 || null,
      match.league || null,
      bestOf || null,
      tip.market,
      tip.line ?? null,
      tip.side ?? null,
      tip.label || null,
      tip.pModel ?? null,
      tip.pImplied ?? null,
      tip.odd,
      tip.ev,
      stakeUnits,
      meta ? JSON.stringify(meta) : null,
    );
    return true;
  } catch (e) {
    log('DEBUG', 'MT-SHADOW', `log err: ${e.message}`);
    return false;
  }
}

/**
 * Settle shadow tips pendentes. Cruza com match_results por (team1, team2, data).
 * Só trata market_winner/handicap de sets/maps (requer só winner). Totals, aces, TB ficam
 * como unsettled (requer parsing adicional do final_score).
 *
 * @returns {{ settled: number, skipped: number }}
 */
function settleShadowTips(db) {
  let settled = 0, skipped = 0;
  const pending = db.prepare(`
    SELECT id, sport, team1, team2, market, line, side, odd, stake_units, created_at
    FROM market_tips_shadow
    WHERE result IS NULL
      AND created_at >= datetime('now', '-30 days')
      AND created_at <= datetime('now', '-2 hours')
    ORDER BY created_at ASC
    LIMIT 200
  `).all();

  for (const t of pending) {
    try {
      // Busca match_results por (team1, team2) na janela de ±48h do created_at
      const gameMap = { lol: 'lol', dota2: 'dota2', cs2: 'cs2', valorant: 'valorant', tennis: 'tennis' };
      const game = gameMap[t.sport];
      if (!game) { skipped++; continue; }
      const n1 = _norm(t.team1), n2 = _norm(t.team2);
      const mr = db.prepare(`
        SELECT winner, final_score, resolved_at
        FROM match_results
        WHERE game = ?
          AND ((lower(team1) = ? AND lower(team2) = ?) OR (lower(team1) = ? AND lower(team2) = ?))
          AND resolved_at >= datetime(?, '-12 hours')
          AND resolved_at <= datetime(?, '+48 hours')
          AND winner IS NOT NULL AND winner != ''
        ORDER BY resolved_at ASC
        LIMIT 1
      `).get(game, n1, n2, n2, n1, t.created_at, t.created_at);
      if (!mr) { skipped++; continue; }

      // Evaluate result por market type
      let result = null;
      if (t.market === 'handicap' || t.market === 'handicapSets') {
        // Line em Pinnacle é HOME (team1) handicap. Side: 'home' = team1 cobre, 'away' = team2 cobre.
        // Precisamos da diferença de mapas: final_score tipo "Bo3 2-1"
        const m = String(mr.final_score || '').match(/(\d+)\s*[-x]\s*(\d+)/);
        if (!m) { skipped++; continue; }
        const s1 = parseInt(m[1], 10), s2 = parseInt(m[2], 10);
        // Determina qual team ganhou: alinha com nossa ordem (team1/team2)
        const winnerIs1 = _norm(mr.winner) === n1;
        const diff = winnerIs1 ? (s1 - s2) : (s2 - s1); // team1 - team2 PERSPECTIVE
        // Pra tip side 'home' → team1 cobre se (team1_maps - team2_maps + line > 0)
        //                    → i.e., team1_diff + line > 0
        // mas diff pode vir invertido. Recalcula:
        const team1Maps = winnerIs1 ? s1 : s2;
        const team2Maps = winnerIs1 ? s2 : s1;
        const team1Diff = team1Maps - team2Maps;
        const covers = t.side === 'home' ? (team1Diff + t.line > 0) : (-team1Diff - t.line > 0);
        result = covers ? 'win' : 'loss';
      } else if (t.market === 'total' || t.market === 'totalGames') {
        const m = String(mr.final_score || '').match(/(\d+)\s*[-x]\s*(\d+)/);
        if (!m) { skipped++; continue; }
        const totalMaps = parseInt(m[1], 10) + parseInt(m[2], 10);
        const over = totalMaps > t.line;
        result = (t.side === 'over') === over ? 'win' : 'loss';
      } else {
        // TB / aces / props — settlement requer mais info. Marca como 'unsettled' permanente.
        skipped++;
        continue;
      }

      const profit = result === 'win'
        ? ((t.stake_units || 1) * (t.odd - 1))
        : -(t.stake_units || 1);

      db.prepare(`
        UPDATE market_tips_shadow SET result = ?, settled_at = datetime('now'), profit_units = ?
        WHERE id = ?
      `).run(result, profit, t.id);
      settled++;
    } catch (e) {
      log('DEBUG', 'MT-SHADOW', `settle err id=${t.id}: ${e.message}`);
      skipped++;
    }
  }
  return { settled, skipped };
}

/**
 * Stats agregados pra report. Agrupa por (sport, market).
 */
function getShadowStats(db, opts = {}) {
  const days = opts.days ?? 30;
  const sport = opts.sport || null;
  const filter = sport ? `AND sport = '${sport.replace(/'/g, "''")}'` : '';
  const rows = db.prepare(`
    SELECT sport, market,
      COUNT(*) AS n,
      SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result IN ('win','loss') THEN 1 ELSE 0 END) AS settled,
      AVG(ev_pct) AS avg_ev,
      SUM(COALESCE(profit_units, 0)) AS total_profit,
      SUM(CASE WHEN result IN ('win','loss') THEN COALESCE(stake_units, 1) ELSE 0 END) AS total_stake
    FROM market_tips_shadow
    WHERE created_at >= datetime('now', '-${days} days')
      ${filter}
    GROUP BY sport, market
    ORDER BY n DESC
  `).all();
  return rows.map(r => ({
    sport: r.sport,
    market: r.market,
    n: r.n,
    settled: r.settled,
    hitRate: r.settled > 0 ? +(r.wins / r.settled * 100).toFixed(1) : null,
    avgEv: +(r.avg_ev || 0).toFixed(2),
    totalProfit: +r.total_profit.toFixed(2),
    roiPct: r.total_stake > 0 ? +(r.total_profit / r.total_stake * 100).toFixed(2) : null,
  }));
}

module.exports = { logShadowTip, settleShadowTips, getShadowStats };

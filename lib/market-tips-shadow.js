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
function _normStrict(s) { return String(s || '').toLowerCase().replace(/[\s-]/g, ''); }
// Normaliza league: remove tier keywords + pontuação pra comparar "ATP Madrid" vs "Mutua Madrid Open"
function _normLeague(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(atp|wta|itf|challenger|masters|1000|500|250|grand slam|main draw|qualifying|qualif|open|cup|trophy|international)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// League overlap: true se ≥1 token significativo (≥4 chars) é comum entre os dois.
// "madrid" ↔ "madrid open" ✅; "madrid" ↔ "rome" ❌; "" ↔ x → false (força tiebreak normal).
function _leagueOverlap(a, b) {
  if (!a || !b) return false;
  const tA = a.split(' ').filter(w => w.length >= 4);
  const tB = new Set(b.split(' ').filter(w => w.length >= 4));
  return tA.some(w => tB.has(w));
}

function _matchKey(match) {
  const a = _norm(match.team1), b = _norm(match.team2);
  const t = match.time || match.start_time || '';
  return `${a}|${b}|${(t || '').slice(0, 10)}`;
}

/**
 * Parse esports final_score (formato "Bo3 2-1") com validação anti-kills.
 *
 * Sources como OpenDota populam final_score com RADIANT_SCORE-DIRE_SCORE (kills)
 * em vez de maps, causando rows tipo "Bo3 40-27". Essa função rejeita scores
 * que violam maxMaps = ceil(bestOf/2) por side, total ≤ bestOf.
 *
 * @returns {{ winnerMaps, loserMaps, bestOf } | null}
 */
function _parseEsportsMapScore(finalScore) {
  const s = String(finalScore || '');
  if (!s) return null;
  const boMatch = s.match(/\bBo(\d+)/i);
  const bestOf = boMatch ? parseInt(boMatch[1], 10) : null;
  const scoreMatch = s.match(/(\d+)\s*[-x]\s*(\d+)/);
  if (!scoreMatch) return null;
  const a = parseInt(scoreMatch[1], 10);
  const b = parseInt(scoreMatch[2], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  // Validação: se bestOf conhecido, scores devem caber no range de maps.
  // Bo-odd (Bo1/Bo3/Bo5): first-to-ceil(N/2), max=ceil(N/2).
  // Bo-even (Bo2): all games played, max=N (ex: Bo2 2-0 é válido).
  if (bestOf != null && bestOf > 0) {
    const maxPerSide = (bestOf % 2 === 0) ? bestOf : Math.ceil(bestOf / 2);
    const total = a + b;
    if (Math.max(a, b) > maxPerSide || total > bestOf || total < 1) return null;
  } else {
    // Sem Bo prefix, aceita apenas se ambos ≤ 3 (cobre Bo1-Bo5)
    if (a > 3 || b > 3) return null;
  }

  // Winner determinado por quem tem mais — bate com match_results.winner por convenção.
  const winnerMaps = Math.max(a, b);
  const loserMaps = Math.min(a, b);
  return { winnerMaps, loserMaps, bestOf };
}

/**
 * Parse score string completo de tennis. Ex: "6-4 7-6(5) 4-6 6-3 RET"
 * Retorna estrutura com sets + totais.
 *
 * @param {string} finalScore
 * @param {boolean} winnerIsT1 — se team1 venceu a partida (pra orientar sets per team)
 * @returns {{ sets: [{t1, t2, tb}], totalGames: number, setCount: number,
 *             hasTiebreak: boolean, t1Sets: number, t2Sets: number } | null}
 */
function parseTennisScore(finalScore, winnerIsT1) {
  const s = String(finalScore || '');
  if (!s) return null;
  // Regex pra cada set: "6-4", "7-6(5)", "0-6" etc. Aceita espaço OU começo de string.
  const setRegex = /\b(\d+)-(\d+)(?:\s*\((\d+)\))?/g;
  const sets = [];
  let m;
  while ((m = setRegex.exec(s)) !== null) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    // Filter: scoreline válido só tem números até 7. Scores tipo "27-25" não existem em tênis moderno.
    if (a > 20 || b > 20) continue;
    // Exclui o caso de "Bo3 2-1" onde 2-1 é série, não set
    if (a <= 3 && b <= 3 && sets.length === 0 && /^\s*bo\d/i.test(s)) continue;
    sets.push({ t1: a, t2: b, tb: m[3] != null });
  }
  if (!sets.length) return null;

  const totalGames = sets.reduce((sum, st) => sum + st.t1 + st.t2, 0);
  const hasTiebreak = sets.some(st => st.tb);

  // Conta sets: cada set tem winner (quem chegou a 6+ primeiro, ou 7-6 via TB).
  // Aqui orientação é T1 = primeiro número do score (convenção).
  let t1Sets = 0, t2Sets = 0;
  for (const st of sets) {
    if (st.t1 > st.t2) t1Sets++;
    else if (st.t2 > st.t1) t2Sets++;
  }

  return {
    sets, totalGames, setCount: sets.length, hasTiebreak,
    t1Sets, t2Sets,
  };
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

    // Dedup por (sport, team1_norm, team2_norm, market, side) — IGNORA line E
    // match_key (que pode mudar entre cycles se match.time for atualizado).
    // Linhas correlacionadas (Over 19.5, 20.5, 21.5) mantém só a com maior p_model.
    // Janela 24h pra cobrir cycles durante torneio.
    const t1n = _normStrict(match.team1), t2n = _normStrict(match.team2);
    const existing = db.prepare(`
      SELECT id, odd, line, p_model, ev_pct FROM market_tips_shadow
      WHERE sport = ?
        AND REPLACE(REPLACE(lower(team1),' ',''),'-','') = ?
        AND REPLACE(REPLACE(lower(team2),' ',''),'-','') = ?
        AND market = ? AND side IS ?
        AND created_at >= datetime('now', '-24 hours')
        AND result IS NULL
      ORDER BY p_model DESC
      LIMIT 1
    `).get(sport, t1n, t2n, tip.market, tip.side ?? null);
    if (existing) {
      // Se nova tip tem p_model MAIOR (linha mais conservadora surgiu), update a
      // existing com nova line/odd/p_model/ev — substitui a "linha oficial" da tip.
      if ((tip.pModel || 0) > (existing.p_model || 0)) {
        db.prepare(`
          UPDATE market_tips_shadow
          SET line = ?, odd = ?, p_model = ?, p_implied = ?, ev_pct = ?, label = ?,
              close_captured_at = datetime('now')
          WHERE id = ?
        `).run(
          tip.line ?? null,
          tip.odd ?? null,
          tip.pModel ?? null,
          tip.pImplied ?? null,
          tip.ev ?? null,
          tip.label ?? null,
          existing.id
        );
        log('INFO', 'MT-UPGRADE', `${args.sport}/${tip.market}|${tip.side} ${match.team1} vs ${match.team2}: line ${existing.line} (p=${existing.p_model?.toFixed(3)}) → line ${tip.line} (p=${tip.pModel?.toFixed(3)})`);
      } else if (tip.odd && existing.odd && existing.odd > 0 && Math.abs(tip.odd - existing.odd) > 0.005 && tip.line === existing.line) {
        // Mesma line, odd diferente — update close_odd pra CLV tracking
        const openOdd = existing.odd;
        const closeOdd = tip.odd;
        const clvPct = (openOdd / closeOdd - 1) * 100;
        db.prepare(`
          UPDATE market_tips_shadow
          SET close_odd = ?, clv_pct = ?, close_captured_at = datetime('now')
          WHERE id = ?
        `).run(closeOdd, +clvPct.toFixed(2), existing.id);
        const sign = clvPct >= 0 ? '+' : '';
        log('INFO', 'MT-CLV', `${args.sport}/${tip.market} ${match.team1} vs ${match.team2}: open=${openOdd} → close=${closeOdd} CLV=${sign}${clvPct.toFixed(1)}%`);
      }
      return false;
    }

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
    log('WARN', 'MT-SHADOW', `log err (${args?.sport}/${args?.tip?.market}): ${e.message}`);
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

  // Cleanup: markets sem settlement handler (totalAces, correctScore) ficam
  // NULL pra sempre e contaminam queries de readiness/stats. Após 14d → void.
  try {
    const voided = db.prepare(`
      UPDATE market_tips_shadow
      SET result = 'void', settled_at = datetime('now'), profit_units = 0
      WHERE result IS NULL
        AND market IN ('totalAces', 'correctScore')
        AND created_at <= datetime('now', '-14 days')
    `).run();
    if (voided.changes > 0) {
      log('INFO', 'MT-SHADOW', `voided ${voided.changes} ghost rows (totalAces/correctScore >14d)`);
    }
  } catch (_) {}

  const pending = db.prepare(`
    SELECT id, sport, team1, team2, league, market, line, side, odd, stake_units, created_at
    FROM market_tips_shadow
    WHERE result IS NULL
      AND created_at >= datetime('now', '-30 days')
      AND created_at <= datetime('now', '-2 hours')
    ORDER BY created_at ASC
    LIMIT 200
  `).all();

  for (const t of pending) {
    try {
      // Busca match_results por (team1, team2) na janela do created_at.
      // Tennis usa janela ampla (±10 dias) porque Sackmann armazena tourney_date
      // (início da semana do torneio), não match date — matches Sex/Sáb ficam 3-5
      // dias após tourney_date. Esports usam ±48h.
      const gameMap = { lol: 'lol', dota2: 'dota2', cs2: 'cs2', valorant: 'valorant', tennis: 'tennis', football: 'football' };
      const game = gameMap[t.sport];
      if (!game) { skipped++; continue; }
      const n1 = _norm(t.team1), n2 = _norm(t.team2);
      const windowBefore = t.sport === 'tennis' ? '-10 days'
                         : t.sport === 'football' ? '-48 hours'
                         : '-12 hours';
      const windowAfter = t.sport === 'tennis' ? '+10 days'
                        : t.sport === 'football' ? '+72 hours'
                        : '+48 hours';
      // Retorna múltiplas candidates pra pegar a row com score parseável.
      // Rationale: temos rows OpenDota (kills-based) + PandaScore (map-based) pro
      // mesmo match; preferimos a que tem final_score válido pra handicap/total.
      let candidates = db.prepare(`
        SELECT winner, final_score, resolved_at, match_id, league
        FROM match_results
        WHERE game = ?
          AND ((lower(team1) = ? AND lower(team2) = ?) OR (lower(team1) = ? AND lower(team2) = ?))
          AND resolved_at >= datetime(?, ?)
          AND resolved_at <= datetime(?, ?)
          AND winner IS NOT NULL AND winner != ''
        ORDER BY ABS(julianday(resolved_at) - julianday(?)) ASC
        LIMIT 10
      `).all(game, n1, n2, n2, n1, t.created_at, windowBefore, t.created_at, windowAfter, t.created_at);

      // Fallback fuzzy LIKE pra football: nomes Pinnacle ("Córdoba") ≠ Sofascore
      // ("CF Córdoba"). Sem este fallback settle silenciosamente falha em 100%.
      if (!candidates.length && t.sport === 'football') {
        const l1 = `%${n1}%`, l2 = `%${n2}%`;
        candidates = db.prepare(`
          SELECT winner, final_score, resolved_at, match_id, league
          FROM match_results
          WHERE game = ?
            AND ((lower(team1) LIKE ? AND lower(team2) LIKE ?) OR (lower(team1) LIKE ? AND lower(team2) LIKE ?))
            AND resolved_at >= datetime(?, ?)
            AND resolved_at <= datetime(?, ?)
            AND winner IS NOT NULL AND winner != ''
          ORDER BY ABS(julianday(resolved_at) - julianday(?)) ASC
          LIMIT 10
        `).all(game, l1, l2, l2, l1, t.created_at, windowBefore, t.created_at, windowAfter, t.created_at);
      }
      if (!candidates.length) { skipped++; continue; }

      // Tiebreak por league: mesmos 2 jogadores podem se enfrentar em torneios
      // consecutivos (Djokovic/Alcaraz Madrid→Rome). Quando múltiplos candidates,
      // prefere o que tem league overlap com a tip — evita settlement no torneio errado.
      const tipLeagueN = _normLeague(t.league || '');
      let filtered = candidates;
      if (tipLeagueN && candidates.length > 1) {
        const leagueMatches = candidates.filter(c => _leagueOverlap(tipLeagueN, _normLeague(c.league || '')));
        if (leagueMatches.length) filtered = leagueMatches;
      }

      // Pra markets que dependem de score parseável, prefere row com score válido.
      // Esports handicap/total: needs _parseEsportsMapScore != null.
      // Tennis handicapSets/totalGames/tiebreakMatch: needs parseTennisScore != null.
      const needsMapScore = (t.market === 'handicap' || t.market === 'handicapSets' || t.market === 'total')
        && t.sport !== 'tennis';
      const needsTennisScore = t.sport === 'tennis' &&
        (t.market === 'handicapSets' || t.market === 'totalGames' || t.market === 'tiebreakMatch' || t.market === 'handicap');
      let mr = filtered[0];
      if (needsMapScore) {
        const parseable = filtered.find(c => _parseEsportsMapScore(c.final_score) != null);
        if (parseable) mr = parseable;
      } else if (needsTennisScore) {
        const parseable = filtered.find(c => parseTennisScore(c.final_score) != null);
        if (parseable) mr = parseable;
      }

      // Evaluate result por market type
      let result = null;
      const winnerIs1 = _norm(mr.winner) === n1;

      if (t.market === 'handicap' || t.market === 'handicapSets') {
        // Handicap de SETS (esports maps OR tennis sets).
        // Esports: final_score "Bo3 2-1". Tennis: série de sets "6-4 7-6(5) ..."
        let team1Sets, team2Sets;
        if (t.sport === 'tennis') {
          const parsed = parseTennisScore(mr.final_score);
          if (!parsed) { skipped++; continue; }
          team1Sets = parsed.t1Sets;
          team2Sets = parsed.t2Sets;
          // Se team1 do DB match_results é na verdade o T2 original, inverte
          if (!winnerIs1) { [team1Sets, team2Sets] = [team2Sets, team1Sets]; }
        } else {
          const parsedMaps = _parseEsportsMapScore(mr.final_score);
          if (!parsedMaps) { skipped++; continue; }
          team1Sets = winnerIs1 ? parsedMaps.winnerMaps : parsedMaps.loserMaps;
          team2Sets = winnerIs1 ? parsedMaps.loserMaps : parsedMaps.winnerMaps;
        }
        const team1Diff = team1Sets - team2Sets;
        // Scanner pós-swap emite side='team1'|'team2' com t.line já orientada pro lado do side.
        // Legacy 'home' === team1. Para 'team2'/'away', line salva é -lineT1 (ponto de vista team2).
        const sideIsT1 = t.side === 'team1' || t.side === 'home';
        const covers = sideIsT1 ? (team1Diff + t.line > 0) : (-team1Diff + t.line > 0);
        result = covers ? 'win' : 'loss';
      } else if (t.market === 'total') {
        // Total de MAPS em esports (Bo3 "2-1" → total 3)
        const parsedMaps = _parseEsportsMapScore(mr.final_score);
        if (!parsedMaps) { skipped++; continue; }
        const totalMaps = parsedMaps.winnerMaps + parsedMaps.loserMaps;
        const over = totalMaps > t.line;
        result = (t.side === 'over') === over ? 'win' : 'loss';
      } else if (t.market === 'totalGames') {
        // Tennis total de GAMES (soma todos os sets)
        const parsed = parseTennisScore(mr.final_score);
        if (!parsed) { skipped++; continue; }
        const over = parsed.totalGames > t.line;
        result = (t.side === 'over') === over ? 'win' : 'loss';
      } else if (t.market === 'tiebreakMatch') {
        // Tennis: TB yes/no baseado em se algum set foi 7-6
        const parsed = parseTennisScore(mr.final_score);
        if (!parsed) { skipped++; continue; }
        const wasTB = parsed.hasTiebreak;
        result = (t.side === 'yes') === wasTB ? 'win' : 'loss';
      } else if (t.market === 'draw' && t.sport === 'football') {
        // Football 1X2_D (empate). winner === 'Draw' quando não houve vencedor.
        const isDraw = /^draw$/i.test(String(mr.winner || '').trim());
        result = isDraw ? 'win' : 'loss';
      } else if (t.market === 'totals' && t.sport === 'football') {
        // Football OVER_2.5 / UNDER_2.5. final_score "H-A" (ex: "2-1").
        const m = String(mr.final_score || '').match(/^\s*(\d+)\s*[-–]\s*(\d+)/);
        if (!m) { skipped++; continue; }
        const totalGoals = parseInt(m[1], 10) + parseInt(m[2], 10);
        const line = Number(t.line) || 2.5;
        const over = totalGoals > line;
        result = (t.side === 'over') === over ? 'win' : 'loss';
      } else {
        // correctScore / totalAces / props — settlement requer dados extras (aces/score
        // parseado) não ingeridos. Cleanup acima marca result='void' após 14d.
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
      SUM(CASE WHEN result IN ('win','loss') THEN COALESCE(stake_units, 1) ELSE 0 END) AS total_stake,
      SUM(CASE WHEN clv_pct IS NOT NULL THEN 1 ELSE 0 END) AS clv_n,
      AVG(clv_pct) AS avg_clv,
      SUM(CASE WHEN clv_pct > 0 THEN 1 ELSE 0 END) AS clv_positive
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
    clvN: r.clv_n || 0,
    avgClv: r.clv_n > 0 ? +(r.avg_clv || 0).toFixed(2) : null,
    clvPositivePct: r.clv_n > 0 ? +((r.clv_positive / r.clv_n) * 100).toFixed(1) : null,
  }));
}

/**
 * Check se há tip shadow registrada com admin DM enviado nas últimas `hoursAgo` horas
 * pra esta combinação de (match_key, market, line, side). Backstop persistente
 * pro dedup in-memory que se perde em restart.
 *
 * @returns {boolean}
 */
function wasAdminDmSentRecently(db, { match, market, line, side, hoursAgo = 24 }) {
  try {
    if (!db || !match) return false;
    const matchKey = _matchKey(match);
    const row = db.prepare(`
      SELECT id FROM market_tips_shadow
      WHERE match_key = ? AND market = ? AND line IS ? AND side IS ?
        AND admin_dm_sent_at IS NOT NULL
        AND admin_dm_sent_at >= datetime('now', ?)
      LIMIT 1
    `).get(matchKey, market, line ?? null, side ?? null, `-${hoursAgo} hours`);
    return !!row;
  } catch (e) {
    log('DEBUG', 'MT-SHADOW', `dmCheck err: ${e.message}`);
    return false;
  }
}

/**
 * Marca que admin DM foi enviado pra este tip. Atualiza a row mais recente
 * (última 12h) com timestamp atual.
 */
function markAdminDmSent(db, { match, market, line, side }) {
  try {
    if (!db || !match) return false;
    const matchKey = _matchKey(match);
    const res = db.prepare(`
      UPDATE market_tips_shadow
      SET admin_dm_sent_at = datetime('now')
      WHERE id = (
        SELECT id FROM market_tips_shadow
        WHERE match_key = ? AND market = ? AND line IS ? AND side IS ?
          AND created_at >= datetime('now', '-12 hours')
        ORDER BY created_at DESC
        LIMIT 1
      )
    `).run(matchKey, market, line ?? null, side ?? null);
    return res.changes > 0;
  } catch (e) {
    log('DEBUG', 'MT-SHADOW', `markDm err: ${e.message}`);
    return false;
  }
}

module.exports = { logShadowTip, settleShadowTips, getShadowStats, parseTennisScore, wasAdminDmSentRecently, markAdminDmSent };

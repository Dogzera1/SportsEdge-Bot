'use strict';

/**
 * baseline-shadow.js — sistema de validação contrafactual.
 *
 * Hipótese a testar: "Sem nenhum modelo próprio, só line-shopping com Pinnacle
 * dejuiced como fair, qual o ROI walk-forward em 90d?"
 *
 * Se ROI baseline >= ROI do stack atual → stack atual (52k LOC, 6 calib layers,
 * 23 gates, 33 crons) não está pagando seu overhead em evidência. Nesse caso,
 * a maior parte da complexidade é overfitting/noise-chasing.
 *
 * Como funciona:
 *   1. Pra cada match com Pinnacle + ≥1 outro book:
 *      - Calcula P_dejuiced via Pinnacle (devig power method)
 *      - Identifica best non-Pinnacle book pra cada side
 *      - Calcula EV = P_dej × best_odd - 1
 *      - Se EV >= threshold (default 5%) → loga como baseline tip
 *   2. Settlement piggyback: quando match_results popula, settle baseline tips
 *   3. Comparação retroativa: agrega ROI/CLV/Brier; compara com stack via
 *      /admin/baseline-shadow-stats
 *
 * Sem gates próprios, sem modelo, sem IA, sem calib. Pure line shop.
 *
 * Wire: chamar `logBaselineShadowIfQualifies(db, ctx)` em qualquer ponto
 * onde já temos match + oddsObj (ex: runAutoAnalysis após fetchOdds). Idempotente
 * via dedup (sport, match_id, side).
 *
 * Settlement: rodar `settleBaselineShadow(db)` no mesmo cron de settleCompletedTips
 * (cross-reference match_results table).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MIN_EV = parseFloat(process.env.BASELINE_SHADOW_MIN_EV || '5'); // %
const DEFAULT_MIN_ODD = parseFloat(process.env.BASELINE_SHADOW_MIN_ODD || '1.30');
const DEFAULT_MAX_ODD = parseFloat(process.env.BASELINE_SHADOW_MAX_ODD || '5.00');
const DISABLED = /^(1|true|yes)$/i.test(String(process.env.BASELINE_SHADOW_DISABLED || ''));

let _devig = null;
function _getDevig() {
  if (!_devig) _devig = require('./devig');
  return _devig;
}

/**
 * Encontra Pinnacle nas odds e books alternativos pra calcular EV line-shop.
 *
 * @param {object} oddsObj - estrutura padrão { team1Odd, team2Odd, _allOdds: [{bookmaker, team1Odd, team2Odd}] }
 * @returns {{ pinnacleP1, pinnacleP2, bestT1: {book,odd}, bestT2: {book,odd} } | null}
 */
function _extractPinnacleAndBest(oddsObj) {
  if (!oddsObj || typeof oddsObj !== 'object') return null;
  const allOdds = Array.isArray(oddsObj._allOdds) ? oddsObj._allOdds : [];
  if (allOdds.length < 2) return null;

  const pin = allOdds.find(b => /pinnacle/i.test(String(b.bookmaker || b.book || '')));
  if (!pin) return null;

  const pinO1 = parseFloat(pin.team1Odd || pin.t1 || pin.odd1);
  const pinO2 = parseFloat(pin.team2Odd || pin.t2 || pin.odd2);
  if (!(pinO1 > 1) || !(pinO2 > 1)) return null;

  const dev = _getDevig().devigPower
    ? _getDevig().devigPower(pinO1, pinO2)
    : _getDevig().devigMultiplicative(pinO1, pinO2);
  if (!dev) return null;

  const others = allOdds.filter(b => !/pinnacle/i.test(String(b.bookmaker || b.book || '')));
  let bestT1 = null, bestT2 = null;
  for (const b of others) {
    const o1 = parseFloat(b.team1Odd || b.t1 || b.odd1);
    const o2 = parseFloat(b.team2Odd || b.t2 || b.odd2);
    const bookName = String(b.bookmaker || b.book || 'unknown');
    if (o1 > 1 && (!bestT1 || o1 > bestT1.odd)) bestT1 = { book: bookName, odd: o1 };
    if (o2 > 1 && (!bestT2 || o2 > bestT2.odd)) bestT2 = { book: bookName, odd: o2 };
  }

  return { pinnacleP1: dev.p1, pinnacleP2: dev.p2, pinnacleO1: pinO1, pinnacleO2: pinO2, bestT1, bestT2 };
}

/**
 * Loga baseline shadow tip se qualifies. Idempotente via dedup (sport, match_id, side).
 *
 * @param {object} db - better-sqlite3 instance
 * @param {object} ctx - { sport, matchId, team1, team2, league, oddsObj, regimeTag? }
 * @returns {{ logged: number, skipped: string[] }}
 */
function logBaselineShadowIfQualifies(db, ctx) {
  if (DISABLED) return { logged: 0, skipped: ['disabled'] };
  if (!db || !ctx?.sport || !ctx?.matchId || !ctx?.oddsObj) {
    return { logged: 0, skipped: ['invalid_input'] };
  }

  const ext = _extractPinnacleAndBest(ctx.oddsObj);
  if (!ext) return { logged: 0, skipped: ['no_pinnacle_or_alt_book'] };

  const sides = [
    { side: 'team1', P: ext.pinnacleP1, pinOdd: ext.pinnacleO1, best: ext.bestT1 },
    { side: 'team2', P: ext.pinnacleP2, pinOdd: ext.pinnacleO2, best: ext.bestT2 },
  ];

  const logged = [];
  const skipped = [];

  for (const s of sides) {
    if (!s.best || !(s.best.odd >= DEFAULT_MIN_ODD) || !(s.best.odd <= DEFAULT_MAX_ODD)) {
      skipped.push(`${s.side}:no_book_or_odd_range`);
      continue;
    }
    const evPct = (s.P * s.best.odd - 1) * 100;
    if (evPct < DEFAULT_MIN_EV) {
      skipped.push(`${s.side}:ev_${evPct.toFixed(1)}<${DEFAULT_MIN_EV}`);
      continue;
    }

    // Dedup: mesma (sport, match_id, side) já logada nas últimas 24h pula.
    const existing = db.prepare(`
      SELECT 1 FROM baseline_shadow_tips
      WHERE sport = ? AND match_id = ? AND side = ?
        AND created_at >= datetime('now', '-24 hours')
      LIMIT 1
    `).get(ctx.sport, String(ctx.matchId), s.side);
    if (existing) { skipped.push(`${s.side}:dedup_24h`); continue; }

    try {
      db.prepare(`
        INSERT INTO baseline_shadow_tips
          (sport, match_id, team1, team2, league, side,
           pinnacle_odd, pinnacle_p_dejuiced,
           best_book, best_odd, ev_pct,
           created_at, regime_tag)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      `).run(
        ctx.sport, String(ctx.matchId), ctx.team1 || null, ctx.team2 || null, ctx.league || null,
        s.side,
        s.pinOdd, s.P,
        s.best.book, s.best.odd, +evPct.toFixed(2),
        ctx.regimeTag || null
      );
      logged.push(s.side);
    } catch (e) {
      skipped.push(`${s.side}:insert_err_${e.message.slice(0, 40)}`);
    }
  }

  return { logged: logged.length, sides: logged, skipped };
}

/**
 * Settle baseline shadow tips via match_results table (mesmo fluxo do
 * settleCompletedTips). Roda em batch — chamar em cron 30min.
 *
 * @returns {{ settled: number, errors: number }}
 */
function settleBaselineShadow(db) {
  if (DISABLED) return { settled: 0, errors: 0, skipped: 'disabled' };
  let settled = 0, errors = 0;

  // 2026-05-06: match_results schema real é (game, match_id, team1, team2, winner, final_score, ...).
  // Não tem team1_score/team2_score nem column 'sport' — usa 'game'. winner é
  // string (nome do time vencedor) — compara via fuzzy match com bst.team1/team2.
  // 'draw' / 'void' detectados via winner string ou final_score=null.
  const pending = db.prepare(`
    SELECT bst.id, bst.sport, bst.match_id, bst.side, bst.best_odd,
           bst.team1 AS bst_t1, bst.team2 AS bst_t2,
           mr.winner, mr.team1 AS mr_t1, mr.team2 AS mr_t2, mr.final_score
    FROM baseline_shadow_tips bst
    INNER JOIN match_results mr ON mr.game = bst.sport AND mr.match_id = bst.match_id
    WHERE bst.settled_at IS NULL
      AND mr.winner IS NOT NULL
    LIMIT 500
  `).all();

  const upd = db.prepare(`
    UPDATE baseline_shadow_tips
    SET result = ?, profit_units = ?, settled_at = datetime('now')
    WHERE id = ?
  `);

  // Fuzzy match: lower-case substring bidirecional. Suficiente pra esports/tennis
  // onde nomes em match_results e baseline tip vêm do mesmo provider (Pinnacle).
  const _norm = (s) => String(s || '').toLowerCase().trim();
  const _matches = (a, b) => {
    const na = _norm(a), nb = _norm(b);
    if (!na || !nb) return false;
    return na === nb || na.includes(nb) || nb.includes(na);
  };

  for (const row of pending) {
    try {
      const winner = String(row.winner || '').toLowerCase().trim();
      // Detect draw/void
      if (winner === 'draw' || winner === 'void' || winner === 'tie' || winner === '') {
        upd.run(winner === 'draw' || winner === 'tie' ? 'push' : 'void', 0, row.id);
        settled++;
        continue;
      }
      // Determine which side won via fuzzy match (winner name vs team1/team2)
      const sideTeam = row.side === 'team1' ? (row.bst_t1 || row.mr_t1) : (row.bst_t2 || row.mr_t2);
      const otherTeam = row.side === 'team1' ? (row.bst_t2 || row.mr_t2) : (row.bst_t1 || row.mr_t1);
      let result, profit;
      if (_matches(winner, sideTeam)) {
        result = 'win';
        profit = +(row.best_odd - 1).toFixed(4);
      } else if (_matches(winner, otherTeam)) {
        result = 'loss';
        profit = -1;
      } else {
        // Winner não bate nenhum side conhecido — provável match falso ou nome variante.
        // Skip (fica pending) pra reprocessar com mais contexto depois.
        continue;
      }
      upd.run(result, profit, row.id);
      settled++;
    } catch (e) {
      errors++;
    }
  }

  return { settled, errors };
}

/**
 * Stats agregados pra comparação com stack atual.
 *
 * @returns {{ overall: {...}, perSport: [{...}] }}
 */
function getStats(db, opts = {}) {
  const days = parseInt(opts.days || '90', 10) || 90;
  const overall = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN result IN ('win','loss','push') THEN 1 ELSE 0 END) AS settled,
      SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result IN ('win','loss') THEN 1 ELSE 0 END) AS resolved,
      SUM(COALESCE(profit_units, 0)) AS profit_u,
      AVG(ev_pct) AS avg_ev,
      AVG(clv_pct) AS avg_clv,
      SUM(CASE WHEN clv_pct IS NOT NULL THEN 1 ELSE 0 END) AS clv_n
    FROM baseline_shadow_tips
    WHERE created_at >= datetime('now', '-' || ? || ' days')
  `).get(days);

  const perSport = db.prepare(`
    SELECT sport,
      COUNT(*) AS total,
      SUM(CASE WHEN result IN ('win','loss') THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
      SUM(COALESCE(profit_units, 0)) AS profit_u,
      AVG(ev_pct) AS avg_ev,
      AVG(clv_pct) AS avg_clv
    FROM baseline_shadow_tips
    WHERE created_at >= datetime('now', '-' || ? || ' days')
    GROUP BY sport
    ORDER BY sport
  `).all(days);

  const fmt = (r) => ({
    n: r.total || 0,
    resolved: r.resolved || 0,
    wins: r.wins || 0,
    hit_pct: r.resolved ? +(r.wins / r.resolved * 100).toFixed(1) : null,
    profit_u: +(r.profit_u || 0).toFixed(2),
    roi_pct: r.resolved ? +((r.profit_u || 0) / r.resolved * 100).toFixed(1) : null,
    avg_ev: r.avg_ev != null ? +r.avg_ev.toFixed(2) : null,
    avg_clv: r.avg_clv != null ? +r.avg_clv.toFixed(2) : null,
    clv_n: r.clv_n || 0,
  });

  return {
    days,
    overall: fmt(overall),
    perSport: perSport.map(r => ({ sport: r.sport, ...fmt(r) })),
    threshold_min_ev: DEFAULT_MIN_EV,
    odd_range: [DEFAULT_MIN_ODD, DEFAULT_MAX_ODD],
    disabled: DISABLED,
  };
}

module.exports = {
  logBaselineShadowIfQualifies,
  settleBaselineShadow,
  getStats,
  _extractPinnacleAndBest, // exported for tests
};

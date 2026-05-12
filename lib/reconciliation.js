'use strict';
/**
 * Reconciliação noturna — detecta divergências silenciosas que não aparecem
 * em audit de código mas custam dinheiro com o tempo.
 *
 * Cobertura phase 1:
 *   1. Bankroll drift — SUM(tips.profit_reais) per sport ≠ (current_banca - initial_banca)
 *   2. Result divergence — tip stored result ≠ match_results atual (fonte atualizou pós-settle)
 *
 * Phase 2 (futuro): reconcile tips vs Telegram DM (precisa capturar tg_message_id no envio).
 *
 * P2 clean: lê tips real (is_shadow=0, archived=0) — research universe não polui reconcile.
 */

// Tolerância R$0.10 — diff abaixo é noise (arredondamento de tipStakeReais/tipProfitReais).
const BANKROLL_EPSILON_BRL = 0.10;

/**
 * Compara bankroll.current_banca per sport com soma de profit_reais das tips
 * settled real. Retorna array de drifts > epsilon.
 */
function reconcileBankroll(db) {
  const rows = db.prepare(`
    SELECT
      b.sport,
      b.initial_banca,
      b.current_banca,
      ROUND(b.current_banca - b.initial_banca, 2) AS bankroll_delta_brl,
      ROUND(COALESCE(SUM(CASE
        WHEN COALESCE(t.is_shadow, 0) = 0
         AND COALESCE(t.archived, 0) = 0
         AND t.result IN ('win', 'loss', 'void', 'push')
        THEN COALESCE(t.profit_reais, 0)
        ELSE 0
      END), 0), 2) AS settled_profit_sum_brl,
      COUNT(CASE
        WHEN COALESCE(t.is_shadow, 0) = 0
         AND COALESCE(t.archived, 0) = 0
         AND t.result IN ('win', 'loss', 'void', 'push')
        THEN 1
      END) AS settled_n
    FROM bankroll b
    LEFT JOIN tips t ON t.sport = b.sport
    GROUP BY b.sport
    ORDER BY b.sport
  `).all();

  const drifts = [];
  for (const r of rows) {
    const expected = r.settled_profit_sum_brl;
    const actual = r.bankroll_delta_brl;
    const diff = Math.abs(expected - actual);
    if (diff > BANKROLL_EPSILON_BRL) {
      drifts.push({
        sport: r.sport,
        initial_banca: r.initial_banca,
        current_banca: r.current_banca,
        bankroll_delta_brl: actual,
        settled_profit_sum_brl: expected,
        diff_brl: Math.round((actual - expected) * 100) / 100,
        settled_n: r.settled_n,
      });
    }
  }
  return { rows, drifts };
}

/**
 * Compara tips settled (real ML) vs match_results atual. Detecta:
 *   - Sackmann/ESPN atualizou score após settle (RET vs final)
 *   - Bot settled errado pela fonte que estava errada no momento
 *
 * Limita a tips dos últimos `days` (default 14). MT tips skipped — cobertas
 * por /admin/mt-shadow-audit que tem math específica per market.
 */
function reconcileResultDivergence(db, { days = 14, sport = null } = {}) {
  // ML only — MT é audited separadamente
  const conds = [
    `t.result IN ('win', 'loss')`,
    `COALESCE(t.is_shadow, 0) = 0`,
    `COALESCE(t.archived, 0) = 0`,
    `(t.market_type IS NULL OR t.market_type = 'ML')`,
    `t.settled_at >= datetime('now', '-' || ? || ' days')`,
  ];
  const params = [days];
  if (sport) { conds.push('t.sport = ?'); params.push(sport); }

  // JOIN match_results por match_id direto quando possível, fallback nome
  const rows = db.prepare(`
    SELECT
      t.id, t.sport, t.match_id, t.participant1, t.participant2,
      t.tip_participant, t.result AS stored_result, t.settled_at,
      mr.winner AS mr_winner, mr.final_score AS mr_score, mr.resolved_at AS mr_resolved
    FROM tips t
    LEFT JOIN match_results mr ON mr.match_id = t.match_id
    WHERE ${conds.join(' AND ')}
    ORDER BY t.settled_at DESC
    LIMIT 500
  `).all(...params);

  const _normName = s => String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

  const divergences = [];
  for (const r of rows) {
    if (!r.mr_winner) continue;  // sem match_result atual, skip
    const tipPick = _normName(r.tip_participant);
    const winner = _normName(r.mr_winner);
    if (!tipPick || !winner) continue;
    const tipWon = winner === tipPick
      || winner.includes(tipPick) || tipPick.includes(winner);
    const expectedResult = tipWon ? 'win' : 'loss';
    // Walkover detection — score com RET/W.O./etc deveria virar void, não loss
    const scoreStr = String(r.mr_score || '').toLowerCase();
    const isWalkover = /\b(ret|retir|w\.?o\.?|walkover|cancell|withdrew|dq\b|forfeit)\b/.test(scoreStr);
    const adjExpected = isWalkover ? 'void' : expectedResult;
    if (adjExpected !== r.stored_result) {
      divergences.push({
        tip_id: r.id, sport: r.sport, match_id: r.match_id,
        participants: `${r.participant1} vs ${r.participant2}`,
        tip_pick: r.tip_participant,
        stored_result: r.stored_result,
        expected_result: adjExpected,
        mr_winner: r.mr_winner,
        mr_score: r.mr_score,
        settled_at: r.settled_at,
        mr_resolved_at: r.mr_resolved,
        is_walkover: isWalkover || undefined,
      });
    }
  }
  return { examined: rows.length, divergences };
}

/**
 * Roda phase 1 completo. Retorna { bankroll, results } com summary + arrays.
 * Caller decide se DM admin + apply remediation.
 */
function runReconciliation(db, opts = {}) {
  const bankroll = reconcileBankroll(db);
  const results = reconcileResultDivergence(db, opts);
  return {
    ts: new Date().toISOString(),
    bankroll: {
      sports_checked: bankroll.rows.length,
      drifts_count: bankroll.drifts.length,
      drifts: bankroll.drifts,
      all_rows: bankroll.rows,
    },
    results: {
      examined: results.examined,
      divergences_count: results.divergences.length,
      divergences: results.divergences,
    },
  };
}

/**
 * Render DM admin (resumo curto). Vazio = tudo OK, não envia DM.
 */
function renderReconciliationDM(report) {
  const lines = [];
  if (report.bankroll.drifts_count > 0) {
    lines.push(`🚨 *Bankroll drift* (${report.bankroll.drifts_count} sport(s)):`);
    for (const d of report.bankroll.drifts.slice(0, 10)) {
      lines.push(`  ${d.sport}: delta R$${d.bankroll_delta_brl} vs profit R$${d.settled_profit_sum_brl} (diff R$${d.diff_brl}, n=${d.settled_n})`);
    }
  }
  if (report.results.divergences_count > 0) {
    lines.push(`\n⚠️ *Result divergence* (${report.results.divergences_count} tip(s), examined ${report.results.examined}):`);
    for (const d of report.results.divergences.slice(0, 10)) {
      lines.push(`  tip#${d.tip_id} ${d.sport}: stored=${d.stored_result} expected=${d.expected_result} | ${d.participants} → ${d.mr_winner} ${d.mr_score ? '(' + d.mr_score + ')' : ''}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  reconcileBankroll,
  reconcileResultDivergence,
  runReconciliation,
  renderReconciliationDM,
  BANKROLL_EPSILON_BRL,
};

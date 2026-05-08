/**
 * lib/ml-rejected-audit.js — registra tips ML rejeitadas por gates pré-DM.
 *
 * Criado 2026-05-08 após audit de logs prod mostrar 5+ picks ML rejeitados
 * por Gate EV sanity em 19min sem registro algum (research-gold sumindo).
 *
 * P2-aligned: pure research universe, nunca trigga ações automáticas. Apenas
 * gravação opt-in pra audit de calibração (são esses ceilings 50%/80% bem
 * calibrados? quantos % seriam wins se passassem?).
 *
 * Ativação: ML_REJECTED_AUDIT=true (default false — opt-in, evita inflar DB
 * em prod até validar utilidade).
 *
 * Uso:
 *   const { recordMlGateRejection } = require('./lib/ml-rejected-audit');
 *   recordMlGateRejection(db, {
 *     sport: 'tennis',
 *     match,                       // { id, team1, team2, league, status }
 *     tipParticipant: 'Mia Ristic',
 *     pickSide: 't2',
 *     odd: 4.47,
 *     evPct: 49.9,
 *     modelPPick: 0.335,
 *     conf: 'MÉDIA',
 *     isLive: true,
 *     rejectedByGate: 'ev_sanity',
 *     gateMeta: { ceiling: 50, ev: 76 },
 *   });
 */

let _stmt = null;

function _isEnabled() {
  const v = String(process.env.ML_REJECTED_AUDIT || 'true').toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function recordMlGateRejection(db, args) {
  if (!_isEnabled()) return false;
  if (!db || !args || !args.rejectedByGate) return false;
  try {
    const sport = String(args.sport || '').toLowerCase();
    if (!sport) return false;
    const match = args.match || {};
    const matchId = args.matchId || (match.id != null ? String(match.id) : null);
    const team1 = args.team1 || match.team1 || null;
    const team2 = args.team2 || match.team2 || null;
    const league = args.league || match.league || match.tournament || null;
    const isLiveExplicit = typeof args.isLive === 'boolean'
      ? args.isLive
      : (match.status === 'live');

    const tipParticipant = args.tipParticipant || null;
    const pickSide = args.pickSide || null;
    const odd = Number.isFinite(args.odd) ? +args.odd : null;
    const evPct = Number.isFinite(args.evPct) ? +args.evPct : null;
    const modelPPick = Number.isFinite(args.modelPPick) ? +args.modelPPick : null;
    const conf = args.conf || null;
    const rejectedByGate = String(args.rejectedByGate);
    const gateMeta = args.gateMeta != null
      ? (typeof args.gateMeta === 'string' ? args.gateMeta : JSON.stringify(args.gateMeta))
      : null;

    if (!_stmt) {
      _stmt = db.prepare(`
        INSERT INTO ml_gate_rejected_audit
          (sport, match_id, league, team1, team2, tip_participant, pick_side,
           odd, ev_pct, model_p_pick, conf, is_live, rejected_by_gate, gate_meta,
           rejected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    }
    _stmt.run(
      sport, matchId, league, team1, team2, tipParticipant, pickSide,
      odd, evPct, modelPPick, conf, isLiveExplicit ? 1 : 0,
      rejectedByGate, gateMeta, new Date().toISOString()
    );
    return true;
  } catch (e) {
    // Audit é best-effort: nunca quebra o flow do gate. Cron retention 60d
    // recomendado pra evitar bloat (tabela tende a crescer rápido com gates
    // EV sanity disparando frequentemente em prod).
    try {
      const { log } = require('./utils');
      log('DEBUG', 'ML-AUDIT', `recordMlGateRejection falhou: ${e.message}`);
    } catch (_) {}
    return false;
  }
}

/**
 * Resumo agregado por sport×gate em janela de N dias. Read-only — usa pra
 * dashboard / endpoint /admin/ml-gate-rejected-audit.
 */
function summarize(db, { days = 7, sport = null } = {}) {
  if (!db) return [];
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const params = [cutoff];
  let where = `rejected_at >= ?`;
  if (sport) { where += ` AND sport = ?`; params.push(String(sport).toLowerCase()); }
  return db.prepare(`
    SELECT sport, rejected_by_gate AS gate, is_live,
           COUNT(*) AS n,
           ROUND(AVG(odd), 2) AS avg_odd,
           ROUND(AVG(ev_pct), 2) AS avg_ev,
           ROUND(AVG(model_p_pick), 3) AS avg_model_p,
           MIN(rejected_at) AS first_at,
           MAX(rejected_at) AS last_at
    FROM ml_gate_rejected_audit
    WHERE ${where}
    GROUP BY sport, rejected_by_gate, is_live
    ORDER BY n DESC
  `).all(...params);
}

module.exports = { recordMlGateRejection, summarize };

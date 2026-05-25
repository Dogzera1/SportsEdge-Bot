// Pre-DM drift instrumentation pra tennis MT (handicapGames + totalGames).
//
// FASE 0 do plano "tennis HG line shop" (audit 2026-05-25):
//   - Captura drift entre odd emitida (cache Pinnacle no scan time) vs odd
//     real do Pinnacle no momento do DM dispatch (cache bypass).
//   - SOMENTE LOG. Não bloqueia/altera DM dispatch.
//   - Opt-in via env TENNIS_PREDM_INSTRUMENT=true (default OFF).
//
// Background: audit 30d real n=86 mostrou HG live drift mean -13%, 50%
// das tips com drift < -20%. Drift positivo (n=20) concentrado em WTA
// (ROI -11.9%) vs ATP +31.6%. Esta instrumentação coleta baseline antes
// de Fase 1 (decisão ship/swap/abort).
//
// Schema (mig 127):
//   tips.tip_pre_dm_drift_pct  REAL    — (freshOdd - emitOdd) / emitOdd * 100
//   tips.tip_pre_dm_check_at   TEXT    — ISO timestamp da check
//   tips.tip_pre_dm_decision   TEXT    — 'skip_instrument' (Fase 0)

const { getMatchupHandicaps, getMatchupTotals } = require('./pinnacle');
const { log } = require('./utils');

// Extrai matchupId Pinnacle do match_id interno `tennis_pin_<id>::mt::...`
function extractPinnacleMatchupId(matchId) {
  if (typeof matchId !== 'string') return null;
  const m = matchId.match(/^tennis_pin_(\d+)/);
  return m ? Number(m[1]) : null;
}

// Acha line correspondente em lista de handicaps Pinnacle.
// Tip pode ter line negada (side='away' → t.line = -h.line).
function findHandicapLine(handicaps, tipLine, tipSide) {
  if (!Array.isArray(handicaps) || !Number.isFinite(tipLine)) return null;
  // Lines no Pinnacle são SEMPRE do POV home (h.line = +/-N). Tip 'home' usa h.line direto;
  // tip 'away' usa -h.line. Side determina qual odd extrair.
  const searchLine = tipSide === 'away' ? -tipLine : tipLine;
  const hit = handicaps.find(h => Math.abs(h.line - searchLine) < 0.01);
  if (!hit) return null;
  const oddFresh = tipSide === 'away' ? hit.oddsAway : hit.oddsHome;
  return Number.isFinite(oddFresh) ? oddFresh : null;
}

function findTotalLine(totals, tipLine, tipSide) {
  if (!Array.isArray(totals) || !Number.isFinite(tipLine)) return null;
  const hit = totals.find(t => Math.abs(t.line - tipLine) < 0.01);
  if (!hit) return null;
  const oddFresh = tipSide === 'over' ? hit.oddsOver : hit.oddsUnder;
  return Number.isFinite(oddFresh) ? oddFresh : null;
}

/**
 * Instrumentação Fase 0 — fire-and-forget. Não bloqueia DM dispatch.
 *
 * @param {Object} args
 * @param {Database} args.db — better-sqlite3 instance
 * @param {number} args.tipId — id da tip recém-inserida
 * @param {string} args.matchId — tips.match_id (formato `tennis_pin_<id>::mt::...`)
 * @param {string} args.market — 'handicapGames' | 'totalGames'
 * @param {number} args.line — t.line (signed para HG, positive para TG)
 * @param {string} args.side — 'home'|'away' (HG) | 'over'|'under' (TG)
 * @param {number} args.emitOdd — t.odd no momento do scan
 * @param {boolean} [args.isLive] — para period selection
 * @returns {Promise<{ok:boolean, driftPct?:number, freshOdd?:number, reason?:string}>}
 */
async function instrumentTipDrift({ db, tipId, matchId, market, line, side, emitOdd, isLive }) {
  try {
    if (!db || !Number.isFinite(tipId) || !Number.isFinite(emitOdd) || emitOdd <= 0) {
      return { ok: false, reason: 'invalid_args' };
    }
    const mkt = String(market || '').toLowerCase();
    if (mkt !== 'handicapgames' && mkt !== 'totalgames') {
      return { ok: false, reason: 'market_not_supported' };
    }

    const matchupId = extractPinnacleMatchupId(matchId);
    if (!matchupId) return { ok: false, reason: 'no_matchupId' };

    // Tennis period 0 = match-level. Live tennis MT usa period 0 (match-level games handicap/total).
    const period = 0;

    let freshOdd = null;
    if (mkt === 'handicapgames') {
      // ttlMs:0 força cache bypass (lib/pinnacle.js + lib/utils.cachedHttpGet:672).
      const handicaps = await getMatchupHandicaps(matchupId, period, { ttlMs: 0, groupByVirtual: true });
      // groupByVirtual:true retorna { sets, games } — usa games (já validado em scanner).
      const games = handicaps && handicaps.games ? handicaps.games : [];
      freshOdd = findHandicapLine(games, line, side);
    } else {
      const totals = await getMatchupTotals(matchupId, period, { ttlMs: 0 });
      freshOdd = findTotalLine(totals, line, side);
    }

    if (!Number.isFinite(freshOdd)) {
      // Linha pode ter sumido (Pinnacle removeu OR line moved enough that not listed).
      // Marca check com decision 'no_fresh_line' (futuro Fase 1 = abort).
      db.prepare(`UPDATE tips
                  SET tip_pre_dm_check_at = datetime('now'),
                      tip_pre_dm_decision = 'no_fresh_line'
                  WHERE id = ?`).run(tipId);
      return { ok: true, reason: 'no_fresh_line' };
    }

    const driftPct = ((freshOdd - emitOdd) / emitOdd) * 100;

    db.prepare(`UPDATE tips
                SET tip_pre_dm_drift_pct = ?,
                    tip_pre_dm_check_at = datetime('now'),
                    tip_pre_dm_decision = 'skip_instrument'
                WHERE id = ?`).run(driftPct, tipId);

    if (Math.abs(driftPct) >= 10) {
      log('INFO', 'TENNIS-PREDM-DRIFT',
        `tip#${tipId} ${mkt}/${side} line=${line}: emit=${emitOdd} fresh=${freshOdd.toFixed(2)} drift=${driftPct >= 0 ? '+' : ''}${driftPct.toFixed(1)}% (live=${isLive ? 1 : 0})`);
    }

    return { ok: true, driftPct, freshOdd };
  } catch (e) {
    // Best-effort — falha não bloqueia dispatch nem polui logs em volume.
    try { log('DEBUG', 'TENNIS-PREDM-DRIFT', `tip#${tipId} instrumentation failed: ${e.message}`); } catch (_) {}
    return { ok: false, reason: 'exception', error: e.message };
  }
}

module.exports = {
  instrumentTipDrift,
  // Exports internos para testing/admin debug
  _extractPinnacleMatchupId: extractPinnacleMatchupId,
  _findHandicapLine: findHandicapLine,
  _findTotalLine: findTotalLine,
};

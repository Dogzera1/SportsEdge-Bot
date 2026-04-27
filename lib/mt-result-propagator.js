'use strict';

/**
 * mt-result-propagator.js — quando shadow row liquida (settleShadowTips), propaga
 * o resultado pra row equivalente em `tips` (caso o sport tenha sido promovido
 * via recordMarketTipAsRegular). Sem isso, tips reais ficavam pending pra sempre
 * porque o settleCompletedTips legacy só sabe lidar com market_type='ML'.
 *
 * Lookup primário: match_id sintético `${match.id}::mt::${market}::${side}`.
 * Fallback: (sport, normalized teams pair, market_type matching) com result IS NULL
 * — cobre rows criadas antes do match_id sintético existir.
 */
const { log } = require('./utils');

const MARKET_TYPE_MAP = {
  handicap: 'HANDICAP',
  handicapSets: 'HANDICAP_SETS',
  handicapGames: 'HANDICAP_GAMES',
  total: 'TOTAL',
  totals: 'TOTAL',
  totalGames: 'TOTAL_GAMES',
  tiebreakMatch: 'TIEBREAK',
  totalAces: 'TOTAL_ACES',
  draw: 'DRAW',
};

function _normTeam(s) {
  return String(s || '').toLowerCase().replace(/[\s\-.']/g, '');
}

/**
 * @param {object} db - sqlite db
 * @param {object} shadowRow - row from market_tips_shadow (id, sport, team1, team2, market, line, side, odd, stake_units)
 * @param {'win'|'loss'} result
 * @param {number} profitUnits
 */
function propagateMtResultToTips(db, shadowRow, result, profitUnits) {
  if (!shadowRow || !result) return null;
  const market_type = MARKET_TYPE_MAP[shadowRow.market] || String(shadowRow.market || '').toUpperCase();
  if (!market_type) return null;

  // BUG FIX 2026-04-27 #4: lookup ANTES era só por suffix LIKE '%::mt::market::side'
  // — pegava QUALQUER tip pendente com esse market+side, INDEPENDENTE do par
  // de teams. Resultado: shadow de "Bencic vs Baptiste" handicapGames/away
  // settled → propagator pegou tip pendente de "Atmane vs Zverev"
  // handicapGames/away (mesmo sufixo) e marcou WIN sem o match real ter
  // acontecido. Bug crítico de cross-tip contamination.
  //
  // Fix: SEMPRE filtra por pair (participant1/participant2 vs shadowRow.team1/team2)
  // ALÉM de match_type+market_type+sport. Sem isso, o LIKE é frouxo demais.
  const t1n = _normTeam(shadowRow.team1);
  const t2n = _normTeam(shadowRow.team2);
  if (!t1n || !t2n) {
    log('DEBUG', 'MT-PROP', `shadow missing team names — skip propagation`);
    return null;
  }
  // Lookup pattern: prefere com line encoded (`::ln<tag>`), fallback sem.
  // Bot pós-2026-04-28 grava line no match_id; tips legacy usam só market::side.
  // A line-suffix variant é mais segura — exato match em vez de odd heurística.
  const sidePattern = `%::mt::${shadowRow.market}::${shadowRow.side ?? 'na'}%`;
  // Encode line do shadow no formato match_id pra match exato (preferido)
  let shadowLineSuffix = '';
  if (Number.isFinite(shadowRow.line)) {
    const ln = Number(shadowRow.line);
    const tag = ln < 0 ? `N${Math.abs(ln)}` : ln > 0 ? `P${ln}` : '0';
    shadowLineSuffix = `::ln${tag}`;
  }
  const sideLinePattern = shadowLineSuffix
    ? `%::mt::${shadowRow.market}::${shadowRow.side ?? 'na'}${shadowLineSuffix}`
    : null;

  // INVARIANTE TEMPORAL: shadow.created_at deve estar dentro de ±14d de tip.sent_at.
  // Bug evitado: shadow row de match X liquidando tip de match Y do mesmo par
  // jogada semanas depois.
  const TIME_WINDOW_DAYS = 14;
  const shadowCreatedMs = shadowRow.created_at ? new Date(shadowRow.created_at).getTime() : NaN;
  const isTimeMatch = (tipSentAt) => {
    if (!Number.isFinite(shadowCreatedMs)) return true; // sem timestamp shadow, não bloqueia
    const tipMs = new Date(tipSentAt || '').getTime();
    if (!Number.isFinite(tipMs)) return true;
    return Math.abs(tipMs - shadowCreatedMs) <= TIME_WINDOW_DAYS * 86400000;
  };

  // BUG FIX 2026-04-27 #2: line-mismatch via odd heurística. Mantém como segunda
  // camada quando line-suffix não está presente (tips legacy).
  const ODD_TOL_PCT = 0.07;
  const isOddMatch = (tipOdd) => {
    const a = Number(tipOdd) || 0;
    const b = Number(shadowRow.odd) || 0;
    if (a <= 1 || b <= 1) return true;
    return Math.abs(a - b) / a <= ODD_TOL_PCT;
  };
  let tipRow = null;
  let matchPath = '';
  // Lookup #1 (preferido): line-suffix exato — mais robusto que odd heurística
  if (sideLinePattern) {
    try {
      const candidates = db.prepare(`
        SELECT id, stake, odds, sport, sent_at
        FROM tips
        WHERE sport = ? AND market_type = ?
          AND match_id LIKE ?
          AND result IS NULL AND (archived IS NULL OR archived = 0)
          AND sent_at >= datetime('now', '-30 days')
          AND (
            (REPLACE(REPLACE(REPLACE(REPLACE(lower(participant1),' ',''),'-',''),'.',''),'''','') = ?
             AND REPLACE(REPLACE(REPLACE(REPLACE(lower(participant2),' ',''),'-',''),'.',''),'''','') = ?)
            OR
            (REPLACE(REPLACE(REPLACE(REPLACE(lower(participant1),' ',''),'-',''),'.',''),'''','') = ?
             AND REPLACE(REPLACE(REPLACE(REPLACE(lower(participant2),' ',''),'-',''),'.',''),'''','') = ?)
          )
        ORDER BY sent_at DESC LIMIT 5
      `).all(shadowRow.sport, market_type, sideLinePattern, t1n, t2n, t2n, t1n);
      tipRow = candidates.find(c => isTimeMatch(c.sent_at)) || null;
      if (tipRow) matchPath = 'line_suffix';
    } catch (e) {
      log('DEBUG', 'MT-PROP', `lookup line-suffix err: ${e.message}`);
    }
  }
  // Lookup #2: pattern legacy + odd-match (tips antes do line-suffix)
  if (!tipRow) {
    try {
      const candidates = db.prepare(`
        SELECT id, stake, odds, sport, sent_at
        FROM tips
        WHERE sport = ? AND market_type = ?
          AND match_id LIKE ?
          AND result IS NULL AND (archived IS NULL OR archived = 0)
          AND sent_at >= datetime('now', '-30 days')
          AND (
            (REPLACE(REPLACE(REPLACE(REPLACE(lower(participant1),' ',''),'-',''),'.',''),'''','') = ?
             AND REPLACE(REPLACE(REPLACE(REPLACE(lower(participant2),' ',''),'-',''),'.',''),'''','') = ?)
            OR
            (REPLACE(REPLACE(REPLACE(REPLACE(lower(participant1),' ',''),'-',''),'.',''),'''','') = ?
             AND REPLACE(REPLACE(REPLACE(REPLACE(lower(participant2),' ',''),'-',''),'.',''),'''','') = ?)
          )
        ORDER BY sent_at DESC LIMIT 5
      `).all(shadowRow.sport, market_type, sidePattern, t1n, t2n, t2n, t1n);
      // Aplica TRÊS filtros: time + odd. Ambos têm que passar.
      tipRow = candidates.find(c => isTimeMatch(c.sent_at) && isOddMatch(c.odds)) || null;
      if (tipRow) matchPath = 'pattern_odd_time';
      if (candidates.length > 0 && !tipRow) {
        log('WARN', 'MT-PROP',
          `${candidates.length} tip candidate(s) pra ${shadowRow.sport}/${market_type} ${shadowRow.team1} vs ${shadowRow.team2} ` +
          `rejeitados (time+odd validation). shadow.odd=${shadowRow.odd} shadow.line=${shadowRow.line} shadow.created=${shadowRow.created_at}. ` +
          `Tip ids: ${candidates.map(c => `${c.id}@${c.odds} sent=${(c.sent_at||'').slice(0,16)}`).join(',')}`);
      }
    } catch (e) {
      log('DEBUG', 'MT-PROP', `lookup pattern err: ${e.message}`);
    }
  }

  // Fallback: tip MT pode ter sido criada com match_id sem sufixo ::mt::
  // (pre-aaab32d). Procura por pair match sem o LIKE de sufixo. Mesma defesa
  // por odd-match — nunca propaga pra tip com line diferente.
  if (!tipRow) {
    try {
      const candidates = db.prepare(`
        SELECT id, stake, odds, sport, sent_at FROM tips
        WHERE sport = ?
          AND market_type = ?
          AND result IS NULL
          AND (archived IS NULL OR archived = 0)
          AND sent_at >= datetime('now', '-30 days')
          AND (
            (REPLACE(REPLACE(REPLACE(REPLACE(lower(participant1),' ',''),'-',''),'.',''),'''','') = ?
             AND REPLACE(REPLACE(REPLACE(REPLACE(lower(participant2),' ',''),'-',''),'.',''),'''','') = ?)
            OR
            (REPLACE(REPLACE(REPLACE(REPLACE(lower(participant1),' ',''),'-',''),'.',''),'''','') = ?
             AND REPLACE(REPLACE(REPLACE(REPLACE(lower(participant2),' ',''),'-',''),'.',''),'''','') = ?)
          )
        ORDER BY sent_at DESC LIMIT 5
      `).all(shadowRow.sport, market_type, t1n, t2n, t2n, t1n);
      tipRow = candidates.find(c => isTimeMatch(c.sent_at) && isOddMatch(c.odds)) || null;
      if (tipRow) matchPath = 'pair_only_odd_time';
    } catch (e) {
      log('DEBUG', 'MT-PROP', `lookup pair-only err: ${e.message}`);
    }
  }

  if (!tipRow) return null;

  // UPDATE result + stake_reais/profit_reais (R$) + reflexo em bankroll.current_banca.
  // BUG FIX 2026-04-27: propagator antes só fazia UPDATE result/settled_at, deixando
  // profit_reais=NULL → /tips-history summary mostrava P&L 0, current_banca não
  // refletia tips MT. Agora replica lógica de settleCompletedTips (server.js:3680).
  try {
    const stakeU = parseFloat(String(tipRow.stake || '').replace(/u/i, '')) || 1;
    const odds = Number(tipRow.odds) || 1;
    let stakeR = 0, profitR = 0;
    try {
      const { getSportUnitValue } = require('./sport-unit');
      const bk = db.prepare(`SELECT current_banca, initial_banca FROM bankroll WHERE sport = ?`).get(tipRow.sport);
      const uv = getSportUnitValue(bk?.current_banca || 0, bk?.initial_banca || 100);
      stakeR = parseFloat((stakeU * uv).toFixed(2));
      profitR = result === 'win'
        ? parseFloat((stakeR * (odds - 1)).toFixed(2))
        : parseFloat((-stakeR).toFixed(2));
    } catch (eU) {
      // Fallback: usa unit value 1.0 se sport-unit falhar
      stakeR = stakeU;
      profitR = result === 'win' ? stakeU * (odds - 1) : -stakeU;
    }

    db.transaction(() => {
      db.prepare(`
        UPDATE tips
        SET result = ?, settled_at = datetime('now'),
            stake_reais = ?, profit_reais = ?, is_live = 0
        WHERE id = ? AND result IS NULL
      `).run(result, stakeR, profitR, tipRow.id);
      // Atualiza bankroll do sport (mesmo padrão de server.js:3684)
      const bk = db.prepare(`SELECT current_banca FROM bankroll WHERE sport = ?`).get(tipRow.sport);
      if (bk) {
        const nova = parseFloat((bk.current_banca + profitR).toFixed(2));
        db.prepare(`UPDATE bankroll SET current_banca = ?, updated_at = datetime('now') WHERE sport = ?`).run(nova, tipRow.sport);
      }
    })();

    log('INFO', 'MT-PROP',
      `tip id=${tipRow.id} ${shadowRow.sport}/${market_type}/${shadowRow.side} line=${shadowRow.line} ` +
      `shadow_id=${shadowRow.id} match_path=${matchPath} → ${result} ` +
      `R$${profitR >= 0 ? '+' : ''}${profitR.toFixed(2)} (stake R$${stakeR.toFixed(2)} odd=${odds} shadow_odd=${shadowRow.odd})`);
    return tipRow.id;
  } catch (e) {
    log('WARN', 'MT-PROP', `update err id=${tipRow.id}: ${e.message}`);
    return null;
  }
}

module.exports = propagateMtResultToTips;
module.exports.propagateMtResultToTips = propagateMtResultToTips;
module.exports.MARKET_TYPE_MAP = MARKET_TYPE_MAP;

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
  const sidePattern = `%::mt::${shadowRow.market}::${shadowRow.side ?? 'na'}`;
  let tipRow = null;
  try {
    // Lookup primário: match_id sintético + pair match. Garante que só liquida
    // a tip do MESMO match (mesmo Pinnacle event ID via match_id base + sufixo).
    tipRow = db.prepare(`
      SELECT id, stake, odds, sport
      FROM tips
      WHERE sport = ?
        AND market_type = ?
        AND match_id LIKE ?
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
      ORDER BY sent_at DESC LIMIT 1
    `).get(shadowRow.sport, market_type, sidePattern, t1n, t2n, t2n, t1n);
  } catch (e) {
    log('DEBUG', 'MT-PROP', `lookup synthetic+pair err: ${e.message}`);
  }

  // Fallback: tip MT pode ter sido criada com match_id sem sufixo ::mt::
  // (pre-aaab32d). Procura por pair match sem o LIKE de sufixo.
  if (!tipRow) {
    try {
      tipRow = db.prepare(`
        SELECT id, stake, odds, sport FROM tips
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
        ORDER BY sent_at DESC LIMIT 1
      `).get(shadowRow.sport, market_type, t1n, t2n, t2n, t1n);
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

    log('INFO', 'MT-PROP', `tip id=${tipRow.id} ${shadowRow.sport}/${market_type}/${shadowRow.side} → ${result} R$${profitR >= 0 ? '+' : ''}${profitR.toFixed(2)} (stake R$${stakeR.toFixed(2)})`);
    return tipRow.id;
  } catch (e) {
    log('WARN', 'MT-PROP', `update err id=${tipRow.id}: ${e.message}`);
    return null;
  }
}

module.exports = propagateMtResultToTips;
module.exports.propagateMtResultToTips = propagateMtResultToTips;
module.exports.MARKET_TYPE_MAP = MARKET_TYPE_MAP;

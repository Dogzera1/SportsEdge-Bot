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

  // Busca match_id sintético direto: ${anything}::mt::${market}::${side}
  // O LIKE pattern é determinístico — id real do match tem prefixo variável (pin_X, ps_Y, etc).
  const sidePattern = `%::mt::${shadowRow.market}::${shadowRow.side ?? 'na'}`;
  let tipRow = null;
  try {
    tipRow = db.prepare(`
      SELECT id, stake, odds, sport
      FROM tips
      WHERE sport = ?
        AND market_type = ?
        AND match_id LIKE ?
        AND result IS NULL
        AND (archived IS NULL OR archived = 0)
        AND sent_at >= datetime('now', '-30 days')
      ORDER BY sent_at DESC LIMIT 1
    `).get(shadowRow.sport, market_type, sidePattern);
  } catch (e) {
    log('DEBUG', 'MT-PROP', `lookup synthetic err: ${e.message}`);
  }

  // Fallback: lookup por (sport, market_type, team pair normalizada, result NULL)
  if (!tipRow) {
    const t1n = _normTeam(shadowRow.team1);
    const t2n = _normTeam(shadowRow.team2);
    if (t1n && t2n) {
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
        log('DEBUG', 'MT-PROP', `lookup pair err: ${e.message}`);
      }
    }
  }

  if (!tipRow) return null;

  // UPDATE result + odds_settle. Reaproveita stake da própria tip (pode ter sido
  // ajustado pelo risk guard na hora do insert) — não usa stake do shadow.
  try {
    const stakeU = parseFloat(String(tipRow.stake || '').replace(/u/i, '')) || 1;
    const settleProfit = result === 'win' ? stakeU * (Number(tipRow.odds) - 1) : -stakeU;
    db.prepare(`
      UPDATE tips
      SET result = ?, settled_at = datetime('now')
      WHERE id = ? AND result IS NULL
    `).run(result, tipRow.id);
    log('INFO', 'MT-PROP', `tip id=${tipRow.id} ${shadowRow.sport}/${market_type}/${shadowRow.side} → ${result} (${settleProfit >= 0 ? '+' : ''}${settleProfit.toFixed(2)}u)`);
    return tipRow.id;
  } catch (e) {
    log('WARN', 'MT-PROP', `update err id=${tipRow.id}: ${e.message}`);
    return null;
  }
}

module.exports = propagateMtResultToTips;
module.exports.propagateMtResultToTips = propagateMtResultToTips;
module.exports.MARKET_TYPE_MAP = MARKET_TYPE_MAP;

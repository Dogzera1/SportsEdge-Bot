'use strict';

/**
 * market-tip-processor.js — processa tips detectadas pelos market scanners
 * (handicap, totals, aces etc) e formata pra DM admin.
 *
 * MVP: admin-only DM (não subscribers). Validação 1-2 semanas antes de escalar.
 *
 * Responsabilidades:
 *   - shouldSendMarketTip(tip, ctx): gate (EV mín, correlação com ML tip, dedup).
 *   - selectBestMarketTip(tips, mlDirection): escolhe 1 market tip complementar.
 *   - buildMarketTipDM(match, tip, stake, league): formata mensagem Telegram.
 *
 * Correlação — evita tip redundante com ML:
 *   ML team1 + Handicap -1.5 team1: CORRELATED (ambos exigem team1 forte) → penaliza
 *   ML team1 + Over 2.5 maps: INDEPENDENT (match longo ≠ team1 forte) → ok
 *   ML team1 + Under 2.5 maps: ANTI-CORRELATED (sweep mais provável se team1 MUITO forte) → ok
 *
 * Dedup: caller é responsável por tracking (match, market, line, side) chave.
 */

const DEFAULT_MIN_EV = 8;           // threshold EV pct — markets exigem mais que ML (baseline 4)
const DEFAULT_MIN_PMODEL = 0.55;    // só pick lado com ≥55% prob (evita extreme longshots)
const MAX_KELLY_FRAC = 0.10;        // Kelly 10% — conservador pra markets novos

/**
 * Filtra um tip candidato. Retorna motivo se rejeitado.
 */
function shouldSendMarketTip(tip, ctx = {}) {
  const { minEv = DEFAULT_MIN_EV, minPmodel = DEFAULT_MIN_PMODEL, mlDirection = null, mlPick = null } = ctx;

  if (!tip || !Number.isFinite(tip.ev) || tip.ev < minEv) {
    return { ok: false, reason: `EV ${tip?.ev?.toFixed(1) || '?'}% < ${minEv}%` };
  }
  if (!Number.isFinite(tip.pModel) || tip.pModel < minPmodel) {
    return { ok: false, reason: `pModel ${(tip?.pModel * 100)?.toFixed(1) || '?'}% < ${minPmodel * 100}%` };
  }

  // Correlação check: evita handicap do MESMO lado que ML pick
  // (redundante — se team1 já picked em ML, handicap -1.5 team1 adiciona ruído)
  if (tip.market === 'handicap' && mlDirection && mlPick) {
    // Scanner emite side='team1'|'team2' (pós-swap já reorientado).
    // Legacy fallback: 'home'→team1, 'away'→team2.
    const tipTeam = tip.side === 'team1' || tip.side === 'home' ? 'team1' : 'team2';
    if (tip.line < 0 && tipTeam === mlDirection) {
      return { ok: false, reason: `correlated com ML pick ${mlDirection} (handicap ${tip.line})` };
    }
  }
  return { ok: true, reason: null };
}

/**
 * De uma lista de tips sorted por EV desc, retorna o melhor que passa nos gates.
 */
function selectBestMarketTip(tips, ctx = {}) {
  if (!Array.isArray(tips) || !tips.length) return null;
  for (const t of tips) {
    const gate = shouldSendMarketTip(t, ctx);
    if (gate.ok) return { tip: t, reason: null };
  }
  return { tip: null, reason: 'no tip passed gates' };
}

/**
 * Kelly reduzido pra markets novos. 0.10 Kelly fracionário sobre a banca.
 * Retorna units (assumindo 100u banca).
 */
function kellyStakeForMarket(pModel, odd, totalBankrollUnits = 100, kellyFrac = MAX_KELLY_FRAC) {
  if (!Number.isFinite(pModel) || !Number.isFinite(odd) || pModel <= 0 || odd <= 1) return 0;
  // Kelly full = (p×(odd-1) - (1-p)) / (odd-1) = (p×odd - 1) / (odd - 1)
  const b = odd - 1;
  const q = 1 - pModel;
  const fullKelly = (pModel * b - q) / b;
  if (fullKelly <= 0) return 0;
  const fractional = fullKelly * kellyFrac;
  const units = fractional * totalBankrollUnits;
  return Math.round(units * 10) / 10; // 1 decimal
}

/**
 * Formata mensagem Telegram pra market tip.
 */
function buildMarketTipDM({ match, tip, stake, league, sport }) {
  const emoji = { handicap: '🎯', total: '📊', totalGames: '📊', handicapSets: '🎯',
    tiebreakMatch: '⚡', totalAces: '🔥', totalSets: '📏' }[tip.market] || '💹';
  const sportLabel = { lol: 'LoL', dota2: 'Dota 2', cs2: 'CS2', tennis: 'Tennis' }[sport] || sport;

  const pImpliedStr = tip.pImplied ? `${(tip.pImplied * 100).toFixed(1)}%` : '?';
  const pModelStr = `${(tip.pModel * 100).toFixed(1)}%`;

  return `${emoji} *MARKET TIP* — ${sportLabel}\n\n` +
    `⚔️ *${match.team1}* vs *${match.team2}*\n` +
    `📋 ${league || match.league || '-'}\n\n` +
    `*${tip.label}* @ *${tip.odd.toFixed(2)}*\n\n` +
    `📈 EV: *+${tip.ev.toFixed(1)}%*\n` +
    `🎲 P modelo: ${pModelStr} (implícita: ${pImpliedStr})\n` +
    `💰 Stake: *${stake}u* (Kelly 0.10 fracionário)\n\n` +
    `_Market scanner (admin-only MVP). Validação 1-2 semanas antes de liberar pra subscribers._`;
}

module.exports = {
  shouldSendMarketTip,
  selectBestMarketTip,
  kellyStakeForMarket,
  buildMarketTipDM,
  DEFAULT_MIN_EV,
  DEFAULT_MIN_PMODEL,
  MAX_KELLY_FRAC,
};

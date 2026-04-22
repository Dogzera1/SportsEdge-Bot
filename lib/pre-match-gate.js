'use strict';

/**
 * pre-match-gate.js
 *
 * Bonus de EV exigido pra tips PRE-MATCH (não-live).
 *
 * Background: audit-leaks (2026-04-22) mostrou que LIVE tem ROI consistentemente
 * MELHOR que PRE em vários sports (cs +72pp, valorant +56pp, esports +47pp,
 * darts +40pp). PRE-match scanner pega odds estáticas com 30-60min antes;
 * mercado se move antes do start e EV vira fantasma. LIVE valida com scoreboard
 * real-time, filtrando garbage.
 *
 * Solução: exigir EV maior pra PRE-match. Não toca em LIVE.
 *
 * Env vars:
 *   PRE_MATCH_EV_BONUS=2                       # cross-sport (default 0)
 *   <SPORT>_PRE_MATCH_EV_BONUS=5               # per-sport override (substitui global)
 *
 * <SPORT> normalizado: LOL, DOTA2, CS, VALORANT, TENNIS, MMA, FOOTBALL, DARTS,
 *                       SNOOKER, TT, TABLETENNIS.
 *
 * API:
 *   const { preMatchEvBonus } = require('./lib/pre-match-gate');
 *   const bonus = preMatchEvBonus('cs', isLive);   // 0 se live, ou bonus configurado
 *   const required = baseRequired + bonus;
 */

function normSport(sport) {
  const s = String(sport || '').toLowerCase().trim();
  if (s === 'cs' || s === 'cs2' || s === 'counterstrike') return 'CS';
  if (s === 'lol' || s === 'esports' || s === 'leagueoflegends') return 'LOL';
  if (s === 'dota' || s === 'dota2') return 'DOTA2';
  if (s === 'val' || s === 'valorant') return 'VALORANT';
  if (s === 'tennis') return 'TENNIS';
  if (s === 'mma') return 'MMA';
  if (s === 'football' || s === 'soccer') return 'FOOTBALL';
  if (s === 'darts') return 'DARTS';
  if (s === 'snooker') return 'SNOOKER';
  if (s === 'tt' || s === 'tabletennis') return 'TT';
  return s.toUpperCase();
}

function preMatchEvBonus(sport, isLive) {
  if (isLive) return 0;
  const S = normSport(sport);
  // Per-sport override tem prioridade
  const perSport = process.env[`${S}_PRE_MATCH_EV_BONUS`];
  if (perSport != null && perSport !== '') {
    const v = parseFloat(perSport);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  const global = process.env.PRE_MATCH_EV_BONUS;
  if (global != null && global !== '') {
    const v = parseFloat(global);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return 0;
}

module.exports = { preMatchEvBonus, normSport };

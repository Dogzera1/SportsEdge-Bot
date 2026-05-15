'use strict';

/**
 * dota-team-aliases.js — Dota2 team name alias expansion.
 *
 * Audit 2026-05-15 (tip emission cross-sport): bot.js Pinnacle-anchored
 * Dota matches falham em /opendota-live lookup quando Pinnacle usa nome
 * abreviado e OpenDota canonical é completo.
 *
 * Caso observado prod 2026-05-15: "PlayTime vs BB Team" (pin_1630783559)
 * com odds Pinnacle 2.2/1.625 + live, mas opendota-live retornou
 * hasLiveStats=false porque "bbteam" not includes "betboomteam" (canonical).
 *
 * Match em PandaScore (ps_1487805) "PlayTime vs BetBoom Team" tem live
 * stats funcionando — mesmo match, source diferente, naming diferente.
 *
 * Solution: expandAlias(name) traduz formas abreviadas pra canonical antes
 * de normName/comparação. Pattern espelha lib/football-poisson-trained
 * _TEAM_ALIASES (já estabelecido pra football).
 */

// Map: variante (lowercase, trimmed) → canonical (OpenDota team_name format)
// Mantenha entries minúsculas, sem espaços extras. Bidirectional via expand:
// abreviado → completo (one direction enough — OpenDota é sempre canonical).
const _ALIASES = {
  // BetBoom variants (Pinnacle uses "BB", OpenDota "BetBoom Team")
  'bb': 'betboom team',
  'bb team': 'betboom team',
  'bbteam': 'betboom team',
  'betboom': 'betboom team',

  // Natus Vincere variants
  'navi': 'natus vincere',
  'na`vi': 'natus vincere',
  "na'vi": 'natus vincere',

  // Team Spirit variants
  'spirit': 'team spirit',
  'tspirit': 'team spirit',

  // Team Liquid variants (canonical may be "Team Liquid" or "Liquid")
  'liquid': 'team liquid',

  // Team Falcons variants
  'falcons': 'team falcons',

  // 9Pandas variants
  '9p': '9pandas',
  '9 pandas': '9pandas',

  // PSG.LGD variants
  'lgd': 'psg.lgd',
  'psg lgd': 'psg.lgd',

  // Tundra Esports
  'tundra esports': 'tundra',

  // Nigma Galaxy variants
  'nigma': 'nigma galaxy',

  // Invictus Gaming
  'ig': 'invictus gaming',

  // Xtreme Gaming
  'xtreme': 'xtreme gaming',
  'xg': 'xtreme gaming',
};

/**
 * Expand short-form Dota team name to canonical (OpenDota format).
 * Case-insensitive. Returns lowercased canonical OR lowercased input if unknown.
 *
 * @param {string} name
 * @returns {string} lowercased canonical (suitable pra normName subsequente)
 */
function expandAlias(name) {
  const k = String(name || '').toLowerCase().trim();
  if (!k) return k;
  return _ALIASES[k] || k;
}

/**
 * @internal pra tests apenas
 */
function _getAliases() { return _ALIASES; }

module.exports = { expandAlias, _getAliases };

'use strict';

/**
 * valorant-team-aliases.js — Valorant team name alias expansion.
 *
 * Audit 2026-05-15 cross-sport tip emission: Pinnacle/PandaScore retornam
 * team names com abbreviations enquanto VLR.gg canonical é completo.
 *
 * Case observado prod 2026-05-15: /live-snapshot retornou MESMO match em
 * duas entradas:
 *   - "Vitality vs FUT" (Pinnacle source)
 *   - "FUT Esports vs Team Vitality" (PandaScore canonical)
 * Cross-source dedup falha pelo naming divergente. Bot pode emit 2 tips
 * pra same physical match.
 *
 * Espelha lib/dota-team-aliases.js (fix bf8dad8 commit anterior sessão).
 */

// Map: variante (lowercase, trimmed) → canonical (VLR/PandaScore long form).
// Default canonical = "Team X" form quando ambíguo.
const _ALIASES = {
  // Tier 1 EMEA/Americas franchised teams
  'vitality': 'team vitality',
  'vit': 'team vitality',
  'fut': 'fut esports',
  'fnatic': 'fnatic',          // canonical
  'fnc': 'fnatic',
  'faze': 'faze clan',
  'faze clan': 'faze clan',
  'th': 'team heretics',
  'heretics': 'team heretics',
  'gen.g': 'gen.g esports',
  'geng': 'gen.g esports',
  'kc': 'karmine corp',
  'karmine': 'karmine corp',
  'liquid': 'team liquid',
  'tl': 'team liquid',
  'navi': 'natus vincere',
  'na`vi': 'natus vincere',

  // Americas
  '100t': '100 thieves',
  '100 thieves': '100 thieves',
  'c9': 'cloud9',
  'cloud9': 'cloud9',
  'sen': 'sentinels',
  'sentinels': 'sentinels',
  'nrg': 'nrg esports',
  'g2': 'g2 esports',
  'evil geniuses': 'evil geniuses',
  'eg': 'evil geniuses',
  'mibr': 'mibr',                // canonical
  'leviatan': 'leviatán',
  'leviatán': 'leviatán',
  'kru': 'kru esports',
  'krü esports': 'kru esports',

  // Pacific
  't1': 't1',                    // canonical, no alias
  'drx': 'drx',
  'paper rex': 'paper rex',
  'prx': 'paper rex',
  'rrq': 'rex regum qeon',
  'zeta': 'zeta division',
  'zeta division': 'zeta division',

  // China
  'edg': 'edward gaming',
  'edward gaming': 'edward gaming',
  'tyloo': 'tyloo',
  'jdg': 'jdg esports',

  // Game Changers / Tier-2 frequents
  'shopify rebellion': 'shopify rebellion gc',
  'guild': 'guild esports',
  'm80': 'm80',
};

/**
 * @param {string} name
 * @returns {string} lowercased canonical OR lowercased input if unknown
 */
function expandAlias(name) {
  const k = String(name || '').toLowerCase().trim();
  if (!k) return k;
  return _ALIASES[k] || k;
}

function _getAliases() { return _ALIASES; }

module.exports = { expandAlias, _getAliases };

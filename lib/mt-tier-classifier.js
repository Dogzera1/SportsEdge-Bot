'use strict';

/**
 * lib/mt-tier-classifier.js — classify (sport, league) into tier buckets
 * pra MT stake adjustments + audit/reporting.
 *
 * Source dos patterns:
 *   - Audit 2026-05-04 (mt-shadow-by-league): tier patterns per sport
 *   - Memory project_tennis_segment_round (round/segment classification)
 *   - Tennis-tier.js (existing)
 *
 * Use:
 *   const tier = classifyTier('tennis', 'ATP Madrid - R3');
 *   const mult = getTierStakeMult('tennis', tier);
 */

const TIER_PATTERNS = {
  tennis: [
    { tier: 'tier1_slam', regex: /grand slam|wimbledon|roland|us open|australian open/i },
    { tier: 'tier1_masters', regex: /masters 1000|atp 1000|wta 1000|miami|indian wells|monte.?carlo|madrid|rome|cincinnati|paris|toronto|shanghai|beijing/i },
    { tier: 'tier2_500', regex: /atp 500|wta 500/i },
    { tier: 'tier3_250', regex: /atp 250|wta 250/i },
    { tier: 'tier4_challenger', regex: /challenger|cha\b/i },
    { tier: 'tier5_itf', regex: /itf/i },
  ],
  lol: [
    { tier: 'tier0_intl', regex: /worlds|msi|first stand/i },
    { tier: 'tier1_major', regex: /^lec\b|^lcs\b|^lck\b|^lpl\b|^lcp\b|^lta/i },
    { tier: 'tier2_regional', regex: /cblol|ljl|lcl|lec champ|lcs challengers|lck cl|lck c|lpl academy/i },
    { tier: 'tier3_minor', regex: /circuito|nlc|nacl|las|north|prime|hitpoint/i },
  ],
  dota2: [
    { tier: 'tier0_intl', regex: /the international|ti[0-9]/i },
    { tier: 'tier1_dpc', regex: /dpc|major/i },
    { tier: 'tier2_qual', regex: /qualifier|tour/i },
  ],
  cs2: [
    { tier: 'tier0_major', regex: /major|iem.+(katowice|cologne)/i },
    { tier: 'tier1_premier', regex: /iem|esl pro|blast/i },
    { tier: 'tier2_secondary', regex: /cct|ec[srt]l|cct south|gamerlegion|esl challenger/i },
  ],
  football: [
    { tier: 'tier0_intl', regex: /champions league|world cup|euro/i },
    // La Liga peeled off antes do tier1_top5 — audit 2026-05-04 mostrou totals
    // -18% ROI n=20 hit 20%. Penalty stake aplicada via TIER_DEFAULT_MULT.
    { tier: 'tier1_la_liga', regex: /laliga|la liga/i },
    { tier: 'tier1_top5', regex: /premier|serie a$|bundesliga|ligue 1/i },
    { tier: 'tier1_brazil_a', regex: /brasileirao serie a$|brasileirão serie a/i },
    // Brasileirão B peeled off antes do tier2_second — audit 2026-05-04 mostrou
    // +42% ROI n=13 sharp money. Boost via TIER_DEFAULT_MULT.
    { tier: 'tier1_brazil_b', regex: /brasileirao serie b|brasileirão serie b/i },
    { tier: 'tier2_second', regex: /serie b|championship|2\. bundesliga/i },
    { tier: 'tier3_cup', regex: /copa|cup|libertadores|sudamericana/i },
  ],
  basket: [
    { tier: 'tier1_nba', regex: /^nba$/i },
    { tier: 'tier2_top', regex: /euroleague|wnba/i },
  ],
};

const TIER_FALLBACK = {
  tennis: 'tier_unknown',
  lol: 'tier_unknown',
  dota2: 'tier_other',
  cs2: 'tier3_other',
  football: 'tier4_lower',
  basket: 'tier3_other',
};

function classifyTier(sport, league) {
  const lg = String(league || '').trim();
  if (!lg) return 'tier_unknown';
  const patterns = TIER_PATTERNS[sport];
  if (!patterns) return 'tier_unknown';
  for (const p of patterns) {
    if (p.regex.test(lg)) return p.tier;
  }
  return TIER_FALLBACK[sport] || 'tier_unknown';
}

/**
 * Stake multiplier por (sport, tier) baseado em ROI realizado audit.
 *
 * Defaults derivados do audit 2026-05-04 (60d window):
 *   - Tiers com ROI consistente positivo: boost 1.1-1.3
 *   - Tiers neutros: 1.0
 *   - Tiers com leak/variance: 0.5-0.8
 *
 * Override via env: <SPORT>_<TIER>_STAKE_MULT
 *   Ex: CS2_TIER2_SECONDARY_STAKE_MULT=1.3
 *       TENNIS_TIER4_CHALLENGER_STAKE_MULT=0.5
 */
const TIER_DEFAULT_MULT = {
  // CS2: tier2 secondary +63% ROI no audit (CCT/ESL Challenger SA com CLV+14%)
  'cs2|tier2_secondary': 1.3,
  // LoL: tier2 regional +26% ROI no audit (LCK CL especialmente)
  'lol|tier2_regional': 1.2,
  // Tennis: challenger +qualifier sangra (-25-80% leaks frequentes)
  'tennis|tier4_challenger': 0.6,
  // Football: tier1 top5 + brazil_a sharp; tier4_lower sangra
  'football|tier4_lower': 0.7,
  // Football: La Liga totals -18% ROI n=20 (audit 2026-05-04) — penalty stake
  'football|tier1_la_liga': 0.7,
  // Football: Brasileirão B +42% ROI n=13 (audit 2026-05-04) — boost stake
  'football|tier1_brazil_b': 1.15,
};

function getTierStakeMult(sport, tier) {
  if (!sport || !tier) return 1.0;
  const envKey = `${sport.toUpperCase()}_${tier.toUpperCase()}_STAKE_MULT`;
  const envVal = parseFloat(process.env[envKey]);
  if (Number.isFinite(envVal) && envVal > 0 && envVal <= 2.0) return envVal;
  const defaultMult = TIER_DEFAULT_MULT[`${sport}|${tier}`];
  return Number.isFinite(defaultMult) ? defaultMult : 1.0;
}

/**
 * EV cap por sport (MT path) — defaults baseados em calibration gap audit:
 *   - EV >30% mostrou gap +40-115pp (modelo broken)
 *   - Cap nesta faixa rejeita tips marginais.
 *
 * Override: <SPORT>_MT_EV_MAX (number) ou <SPORT>_MT_EV_MAX_DISABLED=true
 */
const EV_MAX_DEFAULTS = {
  tennis: 25,
  lol: 20,
  cs2: 20,
  football: 20,
  dota2: 20,
  valorant: 20,
  basket: 25,
  mma: 30,
};

function getEvMaxCap(sport) {
  if (!sport) return Infinity;
  const upKey = String(sport).toUpperCase();
  if (/^(1|true|yes)$/i.test(String(process.env[`${upKey}_MT_EV_MAX_DISABLED`] || ''))) return Infinity;
  const env = parseFloat(process.env[`${upKey}_MT_EV_MAX`]);
  if (Number.isFinite(env) && env > 0) return env;
  return EV_MAX_DEFAULTS[String(sport).toLowerCase()] ?? 30;
}

module.exports = {
  classifyTier,
  getTierStakeMult,
  getEvMaxCap,
  TIER_PATTERNS,
  TIER_DEFAULT_MULT,
  EV_MAX_DEFAULTS,
};

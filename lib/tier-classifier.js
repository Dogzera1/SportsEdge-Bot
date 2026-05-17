'use strict';

/**
 * tier-classifier.js — fonte canônica única pra classificação tier string
 * (P3 anti-overfeaturing). Antes existiam 3 cópias inline com regex divergentes:
 *   - scripts/fit-tennis-markov-calibration.js _classifyTier
 *   - server.js:20602 inline _classifyTier (shadow-tier-divergence endpoint)
 *   - bot.js:18190 _tnTier (tennis-only)
 *
 * Audit granularidade 2026-05-17 (memory project_session_2026_05_17): 4 cópias
 * paralelas. Refactor pra reduzir surface area + garantir consistência cross-
 * caller (caller emite mesma key string que fit script grava no JSON).
 *
 * Retornos por sport:
 *   tennis: atp_main / wta_main / atp_challenger / wta_challenger / wta125k / itf
 *   esports (lol/cs/cs2/dota2/valorant): tier1 / tier2 / other  (via getLeagueTier)
 *   football: top5_uefa / br_continental / other
 *   outros (basket/mma/darts/snooker/tabletennis): null  (cascade fallback default)
 *
 * Mantém:
 *   - lib/league-tier.js (numeric 1/2/3) — leak guard, bucket_block, Kelly tier mult
 *   - bot.js:4188 _classifyStuckTier (settle log only, purpose distinto)
 *
 * Uso:
 *   const { classifyTierString } = require('./lib/tier-classifier');
 *   const tier = classifyTierString('tennis', tip.league);
 */

let _getLeagueTier;
try { _getLeagueTier = require('./league-tier').getLeagueTier; } catch (_) {}

function classifyTierString(sport, league) {
  const lg = String(league || '').trim();
  if (!lg) return null;
  const sp = String(sport || '').toLowerCase();

  if (sp === 'tennis') {
    if (/ATP Challenger/i.test(lg)) return 'atp_challenger';
    if (/WTA Challenger/i.test(lg)) return 'wta_challenger';
    if (/WTA 125K/i.test(lg)) return 'wta125k';
    if (/^ITF\s|ITF Futures|ITF (Men|Women)/i.test(lg)) return 'itf';
    if (/^ATP\s/i.test(lg)) return 'atp_main';
    if (/^WTA\s/i.test(lg)) return 'wta_main';
    return null;
  }

  if (sp === 'lol' || sp === 'cs' || sp === 'cs2' || sp === 'dota2' || sp === 'valorant') {
    if (!_getLeagueTier) return null;
    try {
      const t = _getLeagueTier(sp, lg);
      return t === 1 ? 'tier1' : t === 2 ? 'tier2' : 'other';
    } catch (_) { return null; }
  }

  if (sp === 'football') {
    if (/Premier League|La Liga|Bundesliga|Serie A\b|Ligue 1|Champions League|Europa League/i.test(lg)) return 'top5_uefa';
    if (/Brasileir|Copa do Brasil|Libertadores|Sudamericana/i.test(lg)) return 'br_continental';
    return 'other';
  }

  return null;
}

module.exports = { classifyTierString };

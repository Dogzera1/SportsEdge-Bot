'use strict';

/**
 * dota-fraud-blacklist.js — ligas Dota2 com histórico de match-fixing,
 * baixa integridade competitiva ou estrutura suscetível a fraude.
 *
 * Política: tip NÃO enviada quando league bate com regex. Modelo pode estar
 * certo, mas edge é dominado por upside de fraude — risk/reward invertido.
 *
 * Baseado em investigações ESIC (Esports Integrity Commission) + comunidade:
 *   - LATAM Div 2 (D2CL, BTS Pro Series Americas tier 2, DreamLeague Closed Qual LATAM)
 *   - SEA Div 2 (histórico pesado 2021-2023)
 *   - Tier-2/3 regionais pequenos asiáticos com prize pool <$5k
 *   - Show matches / exhibitions
 *   - Qualifiers open inferiores a main event (sample ruim, não fraude necessariamente)
 *
 * Mantido como denylist (whitelist via implicit — tier-1/2 reconhecido roda normal).
 * Atualize manualmente quando ESIC publicar investigations novas.
 */

const FRAUD_PATTERNS = [
  // LATAM tier 2 — histórico ESIC 2023
  /\bd2cl\b/i,                                    // Dota 2 Champions League (tier 2 LATAM)
  /\bbts\s*pro\s*series.*?(americas|latam|south)/i,
  /\bdreamleague.*?(closed|open)\s*qual.*?(latam|americas)/i,
  /\blatam\s*pro\s*series/i,
  /\b(dpc|division)\s*(latam|americas|sa).*?(div|tier)?\s*(ii|2|3)\b/i,
  /\blatam.*?(div|division|tier)\s*(ii|2|3)\b/i,

  // SEA tier 2 — histórico pesado
  /\bsea\s*division\s*(ii|2)\b/i,
  /\bsea.*?(tier\s*[23]|div.*?[23])/i,
  /\bepulze.*?(sea|asia)/i,                       // Epulze Pro League SEA (histórico)
  /\bgec\b/i,                                     // Global Esports Championship (flagged 2022)

  // Showmatches / exhibitions — sem rigor competitivo
  /\bshow\s*match/i,
  /\bexhibition/i,
  /\ball\s*stars?\b/i,

  // Generic low-integrity signals
  /\bamateur/i,
  /\bopen\s*qual.*?(round\s*1|preliminary)/i,     // open qual primeiro round = fraude-friendly
];

/**
 * Testa se liga está na blacklist. Retorna motivo ou null.
 */
function isFraudRiskLeague(league) {
  const s = String(league || '').trim();
  if (!s) return null;
  for (const re of FRAUD_PATTERNS) {
    if (re.test(s)) return re.source.replace(/\\\\/g, '\\');
  }
  return null;
}

module.exports = { isFraudRiskLeague, FRAUD_PATTERNS };

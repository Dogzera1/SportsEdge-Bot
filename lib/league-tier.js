'use strict';

/**
 * league-tier.js — Resolver de tier centralizado por (sport, league).
 *
 * Tier semantics: 1 = top, 2 = mid, 3 = obscuro/early-stage.
 * Usado por leak guards (MT CLV/ROI), bucket gates e outros agregadores
 * que precisam detectar leak em sample agregado por tier mesmo quando
 * sample por liga individual é insuficiente.
 *
 * Estende esports leagueTier (lib/esports-runtime-features.js) para
 * tennis/football/basket/mma com regex baseado em backtest histórico.
 */

// Esports: reutiliza heurística existente, normalizando para 1=top.
function _esportsTier(league) {
  const l = String(league || '').toLowerCase();
  // Top: ligas regulares globais + Worlds/Majors + IEM/Blast Premier
  if (/lck|lpl|lec|lcs|worlds|msi|first stand|the international|\bti\d*\b|major championship|valorant champions|vct masters|iem (katowice|cologne|rio|sydney|dallas|chengdu|melbourne)|blast premier|blast (world final|spring final|fall final)|esl one (cologne|stockholm)|riyadh masters|pgl major/.test(l)) return 1;
  // Mid: regional secundário, ligas tier-2 conhecidas, masters/qualifiers grandes
  if (/lla|cblol|vcs|pcs|ljl|masters|academy|emea|prime league|pro league|\bone\b|major|dpc|epl|esl pro|swiss|game changers|challengers/.test(l)) return 2;
  return 3;
}

function _tennisTier(league) {
  const l = String(league || '').toLowerCase();
  // Tier 1: Grand Slams + WTA 1000 + ATP Masters 1000
  if (/grand slam|wimbledon|us open|french open|roland garros|australian open|atp finals|wta finals|masters 1000|atp 1000|wta 1000|indian wells|miami open|monte.?carlo|madrid open|italian open|rome open|cincinnati|shanghai|paris (master|rolex)|canadian open|toronto/.test(l)) return 1;
  // Tier 2: ATP/WTA 500 + 250 main tour
  if (/atp 500|atp 250|wta 500|wta 250|atp\b|wta\b/.test(l) && !/challenger|itf|college/.test(l)) return 2;
  // Tier 3: Challenger + ITF + amador
  return 3;
}

function _footballTier(league) {
  const l = String(league || '').toLowerCase();
  // Tier 1: top-5 europeu + Champions/Europa League + Brasileirão A
  if (/premier league|la liga|serie a$|bundesliga|ligue 1|champions league|europa league|conference league|brasileir.{1,4} a\b|copa libertadores|copa do mundo|euro \d{4}|copa am[eé]rica/.test(l)) return 1;
  // Tier 2: segundas divisões + ligas grandes secundárias + Sul-Americana + Brasileirão B
  if (/championship|la liga 2|serie b$|bundesliga 2|ligue 2|brasileir.{1,4} b\b|copa sudamericana|primeira liga|eredivisie|jupiler|super lig|saudi pro|mls/.test(l)) return 2;
  return 3;
}

function _basketTier(league) {
  const l = String(league || '').toLowerCase();
  // Tier 1: NBA + EuroLeague + WNBA
  if (/\bnba\b|euroleague|wnba/.test(l)) return 1;
  // Tier 2: ACB, EuroCup, NBL, NBB
  if (/euro ?cup|acb|nbb|liga endesa|nbl|cba|chinese basketball/.test(l)) return 2;
  return 3;
}

function _mmaTier(league) {
  const l = String(league || '').toLowerCase();
  if (/\bufc\b|pfl championship|bellator/.test(l)) return 1;
  if (/lfa|cage warriors|one championship|rizin|pfl/.test(l)) return 2;
  return 3;
}

/**
 * Retorna tier numérico (1=top, 2=mid, 3=obscuro) para (sport, league).
 * Sport string normaliza (lol/dota2/cs/cs2/valorant viram esports tier).
 */
function getLeagueTier(sport, league) {
  if (!league) return 3;
  const sp = String(sport || '').toLowerCase();
  if (sp === 'lol' || sp === 'esports' || sp === 'dota2' || sp === 'cs' || sp === 'cs2' || sp === 'valorant') {
    return _esportsTier(league);
  }
  if (sp === 'tennis') return _tennisTier(league);
  if (sp === 'football') return _footballTier(league);
  if (sp === 'basket' || sp === 'basketball') return _basketTier(league);
  if (sp === 'mma') return _mmaTier(league);
  // Default conservador: tier 3 quando sport desconhecido
  return 3;
}

/**
 * Retorna chave string 'tier1'|'tier2'|'tier3' para uso em keys/labels.
 */
function getLeagueTierKey(sport, league) {
  return `tier${getLeagueTier(sport, league)}`;
}

module.exports = { getLeagueTier, getLeagueTierKey };

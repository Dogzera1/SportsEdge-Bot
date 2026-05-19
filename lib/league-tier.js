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
  // 2026-05-11: adicionado "champions tour" (formato VCT Americas/EMEA/Pacific
  // dos feeds: "Valorant - Champions Tour: Americas") + "vct (americas|emea|
  // pacific|china)" — antes caía em tier 3 mascarando ROI tier-1 em audit.
  // 2026-05-15 (Sprint 2 unification): sync com lib/esports-runtime-features
  // — adicionado \biem\b (catch IEM cities futuros), \bewc\b + esports world
  //  cup, blast (world|fall|spring) sem "final". NÃO adicionado "esl pro
  //  league" (canonical test mantém ESL Pro como tier2 — discrepancy
  //  intencional vs runtime-feat que tratava como tier1 erroneamente).
  if (/lck|lpl|lec|lcs|worlds|msi|first stand|the international|\bti\d*\b|major championship|valorant champions|vct masters|vct (americas|emea|pacific|china)|champions tour|\biem\b|iem (katowice|cologne|rio|sydney|dallas|chengdu|melbourne)|blast premier|blast (world final|spring final|fall final)|blast (world|fall|spring)|esl one (cologne|stockholm)|riyadh masters|pgl major|\bewc\b|esports world cup/.test(l)) return 1;
  // Mid: regional secundário, ligas tier-2 conhecidas, masters/qualifiers grandes
  // 2026-05-08: regex challengers? cobre singular (ESL Challenger League Europe) e plural
  // 2026-05-15 (Sprint 2 unification): adicionado \bcct\b + challenger series
  //  (audit 2026-05-11 documentou leak UNDER 2.5 CCT ROI -100% n=5).
  if (/lla|cblol|vcs|pcs|ljl|masters|academy|emea|prime league|pro league|\bone\b|major|dpc|epl|esl pro|swiss|game changers|challengers?|\bcct\b|challenger series/.test(l)) return 2;
  return 3;
}

function _tennisTier(league) {
  const l = String(league || '').toLowerCase();
  // Tier 1: Grand Slams + WTA 1000 + ATP Masters 1000
  // 2026-05-11: adicionado "atp rome|atp madrid|atp cincinnati|atp toronto|
  // atp canada|wta rome|wta madrid|wta cincinnati" — strings reais nos
  // feeds (ex: "ATP Rome handicapGames") não tinham "Open" nem "Masters"
  // mas são Masters 1000. Memory: ATP Rome ROI +11.4% n=128 (sweet spot
  // tier1 real). Antes caía em tier2 perdendo Kelly mult 1.30→1.00.
  if (/grand slam|wimbledon|us open|french open|roland garros|australian open|atp finals|wta finals|masters 1000|atp 1000|wta 1000|indian wells|miami open|monte.?carlo|madrid open|italian open|rome open|cincinnati|shanghai|paris (master|rolex)|canadian open|toronto|atp (rome|madrid|toronto|canada|montreal)\b|wta (rome|madrid|toronto|canada|montreal|cincinnati)\b/.test(l)) return 1;
  // Tier 2: ATP/WTA 500 + 250 main tour
  if (/atp 500|atp 250|wta 500|wta 250|atp\b|wta\b/.test(l) && !/challenger|itf|college/.test(l)) return 2;
  // Tier 3: Challenger + ITF + amador
  return 3;
}

function _footballTier(league) {
  const l = String(league || '').toLowerCase();
  // 2026-05-08: tier 2 checked PRIMEIRO pra evitar precedência incorreta —
  // "Bundesliga 2" matchava `bundesliga` em tier 1 antes do tier 2 ser avaliado.
  // Mesma issue pra "Serie B" / "La Liga 2" / "Ligue 2" que continham
  // substring de tier 1. Re-ordenando, segundas divisões classificadas correto.
  // 2026-05-18: false-positive fix tier 1 — "Russian Premier League" /
  // "Indian Premier League" / "Scottish Premier League" matchavam /premier
  // league/ → tier 1 errado. "Austrian Bundesliga" matchava /bundesliga/ →
  // tier 1. Country-prefix check ANTES dos tier 1/2 regex evita escalation
  // espúria em Kelly mult + leak guard.
  if (/^(russian|indian|scottish|welsh|finnish|norwegian|swedish|danish|austrian|albanian|hungarian|czech|polish|romanian|ukrainian|israeli|cypriot|maltese)\b/i.test(l)) return 3;
  // Tier 2: segundas divisões + ligas grandes secundárias + Sul-Americana + Brasileirão B
  // 2026-05-19 audit P0-4: brasileir.{1,4} b/a era frágil ('Brasileirão Série B' tem
  // 8 chars entre 'brasileir' e ' b'). Padrão clean: variações 'brasileirão/brasileirao/
  // brasileira' + opcional ' série/serie' (com ou sem acento) + final ' a/b' word boundary.
  if (/championship|la liga 2|serie b\b|bundesliga 2|ligue 2|brasileir(?:ã?o|a)\b(?:\s+s[eé]rie)?\s+b\b|copa sudamericana|primeira liga|eredivisie|jupiler|super lig|saudi pro|mls/.test(l)) return 2;
  // Tier 1: top-5 europeu + Champions/Europa League + Brasileirão A
  if (/premier league|la liga|serie a$|bundesliga|ligue 1|champions league|europa league|conference league|brasileir(?:ã?o|a)\b(?:\s+s[eé]rie)?\s+a\b|copa libertadores|copa do mundo|euro \d{4}|copa am[eé]rica/.test(l)) return 1;
  return 3;
}

function _basketTier(league) {
  const l = String(league || '').toLowerCase();
  // 2026-05-18: false-positive fix. /\bnba\b/ matchava "NBA G League",
  // "NBA Summer League", "NBA 2K League" → tier 1 errado (essas são feeder/
  // developmental leagues, deveriam tier 2 ou menor). Exclude PRIMEIRO.
  if (/nba (g[\s-]?league|summer league|2k league|d-league|development league)/i.test(l)) return 2;
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

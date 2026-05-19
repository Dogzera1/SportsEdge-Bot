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

// 2026-05-18: WTA 125K cities (calendário 2026) — Pinnacle/Sofa emitem só city
// sem prefixo. Necessário pra routing tier-aware Markov calib (lib/tennis-markov-
// calib.json markets.handicapGames.tiers.wta125k). Atualizar anualmente se WTA
// trocar calendário. Override via env TENNIS_WTA125K_EXTRA (CSV) se necessário.
const _WTA_125K_BASE = [
  'Trnava', 'Saint Malo', 'Saint-Malo', 'Parma', 'Charleston Open 2', 'Karlsruhe',
  'Iasi', 'Iași', 'Bari', 'Tampico', 'Vancouver', 'Florianopolis', 'Florianópolis',
  'Sao Leopoldo', 'São Leopoldo', 'Templeton', 'Tucuman', 'Tucumán', 'Lleida',
  'Reus', 'Makarska', 'Cluj-Napoca', 'Cluj Napoca', 'Lyon Challenger',
];
const _WTA_125K_EXTRA = String(process.env.TENNIS_WTA125K_EXTRA || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const _WTA_125K_TOURNAMENTS = new RegExp(
  '\\b(' + [..._WTA_125K_BASE, ..._WTA_125K_EXTRA]
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|') + ')\\b',
  'i'
);

function classifyTierString(sport, league) {
  const lg = String(league || '').trim();
  if (!lg) return null;
  const sp = String(sport || '').toLowerCase();

  if (sp === 'tennis') {
    // 2026-05-19 audit P0-4: ATP/WTA Challenger pode vir como 'ATP Vancouver Challenger'
    // (city no meio). /ATP.*Challenger/ captura ambas variações 'ATP Challenger Foo'
    // e 'ATP Foo Challenger'.
    if (/ATP\b.*Challenger/i.test(lg)) return 'atp_challenger';
    if (/WTA\b.*Challenger/i.test(lg)) return 'wta_challenger';
    // 2026-05-19 audit P0-4: regex \b125K?\b matchava 'ATP 125', 'Some 125 Event'
    // → mis-route pra wta125k tier (calib bucket errado, Markov stake errado).
    // Fix: exigir contexto WTA explícito antes do 125.
    if (/\bWTA\s*125K?\b/i.test(lg)) return 'wta125k';
    if (/^ITF\s|ITF Futures|ITF (Men|Women)/i.test(lg)) return 'itf';
    // 2026-05-18: Pinnacle/Sofa emitem league sem prefixo "WTA 125K" — só o
    // city ("Trnava", "Saint Malo"). Audit log 2026-05-18 mostrou MT-EV-CAP
    // 31.8% handicapGames Jones vs Kotliar (WTA 125k) cair em fallback default
    // v1. Table-driven catch antes do regex genérico ^WTA\s ou null.
    // 2026-05-19 audit P0-4: bug B (city collision com ATP Challenger) — gate
    // exclude se houver contexto ATP/Challenger anywhere (evita mis-route de
    // 'ATP Vancouver Challenger' → wta125k).
    if (_WTA_125K_TOURNAMENTS.test(lg) && !/\b(ATP|Challenger)\b/i.test(lg)) return 'wta125k';
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
    // 2026-05-18: br_continental CHECKED FIRST — antes ordem invertida fazia
    // "Brasileirao Serie A" casar /Serie A\b/ → top5_uefa errado. Mesmo bug
    // potencial: "Austria Bundesliga" → Bundesliga regex top5. Anchorar é
    // frágil (ESPN emite "Italian Serie A" OU "Serie A" inconsistente).
    if (/Brasileir|Copa do Brasil|Libertadores|Sudamericana/i.test(lg)) return 'br_continental';
    // 2026-05-19 audit P0-4: country exclude alinhado com _footballTier (lib/league-tier.js:62)
    // — antes faltavam Indian/Welsh/Finnish/Norwegian/Swedish/Danish/Albanian/Hungarian/
    // Czech/Polish/Romanian/Ukrainian/Israeli/Cypriot/Maltese → 'Indian Premier League'
    // virava top5_uefa enquanto numeric era 3. Mismatch entre os 2 classifiers
    // bagunçava Kelly mult vs EV cap.
    if (/Austrian|Austria.*Bundesliga|Swiss|Belg|Dutch|Eredivisie|Portuguese|Primeira Liga|Greek|Turkish|Russian|Scottish|Indian|Welsh|Finnish|Norwegian|Swedish|Danish|Albanian|Hungarian|Czech|Polish|Romanian|Ukrainian|Israeli|Cypriot|Maltese/i.test(lg)) return 'other';
    // 2026-05-19 audit P0-4 (bug E): tier2 leagues (Championship/Bundesliga 2/etc)
    // MUST check BEFORE top5_uefa — 'Bundesliga 2' matchava /Bundesliga/ → top5
    // espúrio. Alinha com _footballTier numeric (tier=2).
    if (/Championship|La Liga 2|Serie B\b|Bundesliga 2|Ligue 2|Saudi Pro|MLS/i.test(lg)) return 'other';
    if (/Premier League|La Liga|Bundesliga|Serie A\b|Ligue 1|Champions League|Europa League/i.test(lg)) return 'top5_uefa';
    return 'other';
  }

  return null;
}

module.exports = { classifyTierString };

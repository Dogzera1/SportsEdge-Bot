'use strict';

/**
 * league-classifier.js — classifica liga em tier abstrato (cross-tournament).
 *
 * Tennis: ATP Slam, ATP Masters, ATP Challenger, ATP 250/500, ITF M, WTA Slam,
 *         WTA Masters, WTA 125K, WTA 250/500, ITF W
 * Esports: Major, Tier 1, Tier 2, Tier 3
 * Football: Top 5, Major Other, Cups, Continental, Outros
 *
 * Usado pra agrupar cards no dashboard MT shadow + leak guard per-tier futuro.
 */

function classifyTennisLeague(league) {
  if (!league) return 'Outros';
  const low = String(league).toLowerCase();
  const isWta = /\bwta\b|\bwomen\b/.test(low);
  const isAtp = /\batp\b(?!.*\bchallenger\b)|\bmen\b/.test(low);
  // Default tour quando string não diz explicitamente — tries ATP first
  const tour = isWta ? 'WTA' : (isAtp ? 'ATP' : null);

  // Slam (gender via prefix se houver)
  if (/(australian open|aus open|french open|roland garros|wimbledon|us open)/.test(low)) {
    return tour ? `${tour} Slam` : 'Slam';
  }
  // Challenger (sempre ATP — WTA não usa "Challenger")
  if (/\bchallenger\b/.test(low)) return 'ATP Challenger';
  // ITF (M / W)
  if (/\b(m15|m25)\b|\bitf m\b/.test(low)) return 'ITF M';
  if (/\b(w15|w25|w50|w60|w75|w80|w100)\b|\bitf w\b/.test(low)) return 'ITF W';
  // WTA 125K
  if (/\bwta\b.*\b(125k|125)\b|\b125k\b/.test(low)) return 'WTA 125K';
  // Masters 1000
  if (/(madrid|monte\s*carlo|paris\s+master|paris\s+bercy|miami\s+open|indian\s*wells|cincinnati|shanghai\s*master|toronto\s*master|montreal\s*master|canadian\s*open|rome\s*master|italian\s*open)/.test(low)
      || /^(atp|wta)\s+(madrid|rome|roma|monte\s*carlo|paris|cincinnati|shanghai|miami|indian\s*wells|toronto|montreal)\b/.test(low)) {
    return tour === 'WTA' ? 'WTA Masters' : 'ATP Masters';
  }
  // 250/500 default por tour
  if (tour === 'WTA') return 'WTA 250/500';
  if (tour === 'ATP') return 'ATP 250/500';
  return 'Outros';
}

function classifyEsportsLeague(league) {
  if (!league) return 'Outros';
  const low = String(league).toLowerCase();
  // Major events (champion mundial / The International / MSI)
  if (/\b(worlds|msi|the\s+international|riyadh\s+masters|major\s+championship)\b/.test(low)) return 'Major';
  // Tier 3 / sub-leagues: presença de "challenger" / "academy" sempre indica
  // sub-circuit, mesmo em organizadores grandes (LCK Challengers, ESL Challenger).
  if (/\b(challenger|challengers|academy|secondary|tier\s*2|tier\s*3|circuito)\b/.test(low)) return 'Tier 3';
  // Tier 1 — leagues principais e organizadores grandes (sem suffix challenger)
  if (/\b(lck|lpl|lec|lcs|cblol|vcs|pcs|ljl|hltv|esl\s+pro|blast\s+premier|skyesports|iem)\b/.test(low)) return 'Tier 1';
  return 'Tier 2';
}

function classifyFootballLeague(league) {
  if (!league) return 'Outros';
  const low = String(league).toLowerCase();
  if (/(premier\s*league|la\s*liga|serie\s*a|bundesliga|ligue\s*1)\b/.test(low)) return 'Top 5';
  if (/(brasileirão|brasileirao|série\s*a|serie\s*b|primera|championship|eredivisie|jupiler)\b/.test(low)) return 'Major Other';
  if (/(champions\s*league|europa|conference|libertadores|sul-americana|sudamericana)\b/.test(low)) return 'Continental';
  if (/\b(cup|copa|taça|fa\s*cup|league\s*cup|carabao)\b/.test(low)) return 'Cups';
  return 'Outros';
}

function classifyLeague(sport, league) {
  if (!sport) return 'Outros';
  const sp = String(sport).toLowerCase();
  if (sp === 'tennis') return classifyTennisLeague(league);
  if (['lol', 'cs2', 'dota2', 'valorant'].includes(sp)) return classifyEsportsLeague(league);
  if (sp === 'football') return classifyFootballLeague(league);
  return 'Outros';
}

// Tier color palette (consistent cross-sport)
const TIER_COLORS = {
  // Tennis
  'ATP Slam':       '#fbbf24', // gold
  'WTA Slam':       '#f472b6', // pink-gold
  'ATP Masters':    '#3b82f6', // blue
  'WTA Masters':    '#a855f7', // purple
  'WTA 125K':       '#a78bfa', // light purple
  'ATP Challenger': '#10b981', // green
  'ATP 250/500':    '#06b6d4', // teal
  'WTA 250/500':    '#ec4899', // hot pink
  'ITF M':          '#64748b', // slate
  'ITF W':          '#94a3b8', // light slate
  // Esports
  'Major':          '#fbbf24',
  'Tier 1':         '#3b82f6',
  'Tier 2':         '#10b981',
  'Tier 3':         '#64748b',
  // Football
  'Top 5':          '#3b82f6',
  'Major Other':    '#10b981',
  'Continental':    '#fbbf24',
  'Cups':           '#a855f7',
  'Outros':         '#64748b',
};

module.exports = {
  classifyLeague,
  classifyTennisLeague,
  classifyEsportsLeague,
  classifyFootballLeague,
  TIER_COLORS,
};

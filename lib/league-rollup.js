/**
 * league-rollup.js — Agrupa event_name em buckets de circuito/organização
 * (UFC, PFL, ATP, WTA, PDC…) para o ROI por liga e para o stake multiplier.
 *
 * Ideia: um evento ("UFC 300: Pereira vs Hill") vira o bucket do tour ("UFC"),
 * de forma que todas as tips de UFC somam sample no mesmo lugar.
 */

'use strict';

function rollupLeague(sport, eventName) {
  const raw = String(eventName || '').trim();
  if (!raw) return '(sem liga)';

  if (sport === 'tennis') {
    if (/challenger/i.test(raw))            return 'ATP Challenger';
    if (/^ITF\b|\bITF\b/i.test(raw))        return 'ITF';
    if (/^WTA\b|\bWTA\b/i.test(raw))        return 'WTA';
    if (/^ATP\b|\bATP\b/i.test(raw))        return 'ATP';
    return raw;
  }
  if (sport === 'tabletennis') {
    if (/\bWTT\b|world table tennis/i.test(raw)) return 'WTT';
    if (/\bTT Elite\b/i.test(raw))               return 'TT Elite';
    if (/\bSetka\b/i.test(raw))                  return 'Setka Cup';
    if (/\bChallenger\b/i.test(raw))             return 'WTT Challenger';
    return raw;
  }
  if (sport === 'mma') {
    if (/\bUFC\b/i.test(raw))                     return 'UFC';
    if (/bellator/i.test(raw))                    return 'Bellator';
    if (/\bPFL\b/i.test(raw))                     return 'PFL';
    if (/\bONE\b(?!\s*[a-z])/i.test(raw))         return 'ONE Championship';
    if (/\bLFA\b/i.test(raw))                     return 'LFA';
    if (/\bKSW\b/i.test(raw))                     return 'KSW';
    if (/\bCage Warriors\b/i.test(raw))           return 'Cage Warriors';
    if (/boxing|matchroom|top rank|queensberry|pbc/i.test(raw)) return 'Boxing';
    return raw;
  }
  if (sport === 'darts') {
    if (/\bPDC\b/i.test(raw))                     return 'PDC';
    if (/\bWDF\b/i.test(raw))                     return 'WDF';
    if (/modus/i.test(raw))                       return 'MODUS';
    if (/premier league/i.test(raw))              return 'PDC Premier League';
    return raw;
  }
  if (sport === 'snooker') {
    if (/world snooker|wst\b/i.test(raw))         return 'World Snooker Tour';
    return raw;
  }
  if (sport === 'valorant') {
    if (/\bVCT\b/i.test(raw)) {
      if (/americas/i.test(raw))                  return 'VCT Americas';
      if (/emea/i.test(raw))                      return 'VCT EMEA';
      if (/pacific/i.test(raw))                   return 'VCT Pacific';
      if (/china/i.test(raw))                     return 'VCT China';
      if (/challengers|ascension/i.test(raw))     return 'VCT Challengers';
      if (/game changers/i.test(raw))             return 'VCT Game Changers';
      return 'VCT';
    }
    return raw;
  }
  if (sport === 'esports') {
    const tiers = ['LCK','LPL','LEC','LCS','LLA','LCO','LJL','CBLOL','VCS','PCS','LTA N','LTA S','LTA'];
    for (const t of tiers) {
      const re = new RegExp('\\b' + t.replace(/ /g,'\\s+') + '\\b', 'i');
      if (re.test(raw)) return t;
    }
    if (/prime\s*league/i.test(raw))              return 'Prime League';
    if (/la\s*ligue|lfl/i.test(raw))              return 'LFL';
    if (/\bLES\b|superliga\s*espa/i.test(raw))    return 'Superliga (ES)';
    if (/ultraliga/i.test(raw))                   return 'Ultraliga';
    if (/elite\s*series|\bbe\b\s*-\s*nl/i.test(raw)) return 'Elite Series';
    if (/northern\s*league|\bnlc\b/i.test(raw))   return 'NLC';
    if (/^dpc|\bDPC\b/i.test(raw))                return 'DPC';
    if (/the\s*international|\bTI\d*\b/i.test(raw)) return 'The International';
    if (/esl\s*one/i.test(raw))                   return 'ESL One';
    if (/blast/i.test(raw))                       return 'BLAST';
    return raw;
  }
  if (sport === 'cs') {
    if (/blast/i.test(raw))                       return 'BLAST';
    if (/esl\s*pro\s*league/i.test(raw))          return 'ESL Pro League';
    if (/iem|intel\s*extreme/i.test(raw))         return 'IEM';
    if (/major/i.test(raw))                       return 'Major';
    if (/esea/i.test(raw))                        return 'ESEA';
    return raw;
  }
  return raw;
}

module.exports = { rollupLeague };

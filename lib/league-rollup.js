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
  // 2026-05-18: split post-Abr/2026 — sport='esports' é legacy, novos buckets
  // são 'lol' e 'dota2'. Sem rollup, stake-adjuster fragmentava sample.
  if (sport === 'esports' || sport === 'lol') {
    const tiers = ['LCK','LPL','LEC','LCS','LLA','LCO','LJL','CBLOL','VCS','PCS','LTA N','LTA S','LTA'];
    for (const t of tiers) {
      const re = new RegExp('\\b' + t.replace(/ /g,'\\s+') + '\\b', 'i');
      if (re.test(raw)) return t;
    }
    if (/worlds|world\s*champ/i.test(raw))         return 'Worlds';
    if (/\bmsi\b|mid.?season/i.test(raw))          return 'MSI';
    if (/first\s*stand/i.test(raw))                return 'First Stand';
    if (/prime\s*league/i.test(raw))               return 'Prime League';
    if (/la\s*ligue|\blfl\b/i.test(raw))           return 'LFL';
    if (/\bLES\b|superliga\s*espa/i.test(raw))     return 'Superliga (ES)';
    if (/ultraliga/i.test(raw))                    return 'Ultraliga';
    if (/elite\s*series|\bbe\b\s*-\s*nl/i.test(raw)) return 'Elite Series';
    if (/northern\s*league|\bnlc\b/i.test(raw))    return 'NLC';
    if (/circuito\s*desafiante|\bcd\b/i.test(raw)) return 'Circuito Desafiante';
    if (sport === 'esports') {
      if (/^dpc|\bDPC\b/i.test(raw))               return 'DPC';
      if (/the\s*international|\bTI\d*\b/i.test(raw)) return 'The International';
      if (/esl\s*one/i.test(raw))                  return 'ESL One';
      if (/blast/i.test(raw))                      return 'BLAST';
    }
    return raw;
  }
  if (sport === 'dota2') {
    if (/^dpc|\bDPC\b/i.test(raw))                 return 'DPC';
    if (/the\s*international|\bTI\d*\b/i.test(raw)) return 'The International';
    if (/esl\s*one/i.test(raw))                    return 'ESL One';
    if (/riyadh\s*master/i.test(raw))              return 'Riyadh Masters';
    if (/blast/i.test(raw))                        return 'BLAST';
    if (/pgl/i.test(raw))                          return 'PGL';
    if (/dreamleague/i.test(raw))                  return 'DreamLeague';
    return raw;
  }
  // 2026-05-18: cs2 alias do cs (mesma rollup). Antes events cs2 caíam em raw.
  if (sport === 'cs' || sport === 'cs2') {
    if (/blast/i.test(raw))                        return 'BLAST';
    if (/esl\s*pro\s*league|\bepl\b/i.test(raw))   return 'ESL Pro League';
    if (/iem|intel\s*extreme/i.test(raw))          return 'IEM';
    if (/\bewc\b|esports\s*world\s*cup/i.test(raw)) return 'EWC';
    if (/major/i.test(raw))                        return 'Major';
    if (/esea/i.test(raw))                         return 'ESEA';
    if (/\bcct\b|champion.*tour/i.test(raw))       return 'CCT';
    if (/european\s*pro\s*league/i.test(raw))      return 'European Pro League';
    if (/game\s*masters/i.test(raw))               return 'Game Masters';
    return raw;
  }
  // 2026-05-18: football rollup — antes raw fragmentado (PL 2025-26 ≠ PL 2026-27).
  if (sport === 'football') {
    if (/champions\s*league/i.test(raw))           return 'Champions League';
    if (/europa\s*league/i.test(raw))              return 'Europa League';
    if (/conference\s*league/i.test(raw))          return 'Conference League';
    // Exclude non-top5 Premier League substrings (Russian/Indian/etc) primeiro
    if (/(russian|indian|scottish|welsh)\s*premier/i.test(raw)) return raw;
    if (/premier\s*league/i.test(raw))             return 'Premier League';
    if (/la\s*liga/i.test(raw))                    return 'La Liga';
    if (/(austrian|austria)\s*bundesliga/i.test(raw)) return raw;
    if (/bundesliga(?!\s*2)/i.test(raw))           return 'Bundesliga';
    if (/brasileir.{1,4}\s*s.rie\s*a/i.test(raw))  return 'Brasileirão A';
    if (/brasileir.{1,4}\s*s.rie\s*b/i.test(raw))  return 'Brasileirão B';
    if (/italian\s*serie\s*a|\bserie\s*a(?!\s*[bn])/i.test(raw) && !/brasileir/i.test(raw)) return 'Serie A';
    if (/ligue\s*1/i.test(raw))                    return 'Ligue 1';
    if (/copa\s*libertadores/i.test(raw))          return 'Copa Libertadores';
    if (/copa\s*sudamericana/i.test(raw))          return 'Copa Sudamericana';
    if (/copa\s*do\s*brasil/i.test(raw))           return 'Copa do Brasil';
    if (/championship/i.test(raw))                 return 'Championship';
    if (/\bmls\b/i.test(raw))                      return 'MLS';
    if (/eredivisie/i.test(raw))                   return 'Eredivisie';
    if (/primeira\s*liga/i.test(raw))              return 'Primeira Liga';
    if (/super\s*lig|s.per\s*lig/i.test(raw))      return 'Süper Lig';
    if (/saudi\s*pro/i.test(raw))                  return 'Saudi Pro';
    return raw;
  }
  // 2026-05-18: basket rollup — NBA/EuroLeague agregam sample. Exclude G League.
  if (sport === 'basket' || sport === 'basketball') {
    if (/nba\s*(g[\s-]?league|summer\s*league|2k\s*league|d[-\s]?league|development)/i.test(raw)) return 'NBA G/Summer';
    if (/\bnba\b/i.test(raw))                      return 'NBA';
    if (/euroleague/i.test(raw))                   return 'EuroLeague';
    if (/eurocup|euro\s*cup/i.test(raw))           return 'EuroCup';
    if (/\bwnba\b/i.test(raw))                     return 'WNBA';
    if (/\bacb\b|liga\s*endesa/i.test(raw))        return 'ACB';
    if (/\bnbb\b/i.test(raw))                      return 'NBB';
    if (/\bnbl\b/i.test(raw))                      return 'NBL';
    if (/\bcba\b|chinese/i.test(raw))              return 'CBA';
    return raw;
  }
  return raw;
}

module.exports = { rollupLeague };

/**
 * name-match.js — Matching unificado e auditável de nomes (times, lutadores, jogadores)
 *
 * Evita falsos positivos comuns do `includes` nu:
 *   "ig".includes em "big" → true (errado: Invictus vs BIG)
 *   "t1".includes em "t10" → true (errado)
 *   "sk".includes em "skt" → true (talvez errado dependendo do contexto)
 *
 * Regras (em ordem):
 *   1. exact   — strings normalizadas iguais
 *   2. alias   — se `aliases` mapeia A↔B via chave comum
 *   3. strict-substring — includes SÓ quando ambas strings têm ≥ 4 caracteres
 *   4. none    — sem match
 *
 * Retorna `{ match, score, method }` para auditoria (logs de settlement).
 */

const { norm } = require('./utils');

/**
 * Expande um nome normalizado em variantes via alias map.
 * @param {string} n — nome já normalizado
 * @param {Object<string,string[]>} aliases — ex: { fnatic: ['fnc'], t1: ['skt','skt1'] }
 * @returns {Set<string>}
 */
function expandAliases(n, aliases) {
  const variants = new Set([n]);
  if (!aliases) return variants;
  for (const [key, list] of Object.entries(aliases)) {
    if (n === key || list.includes(n)) {
      variants.add(key);
      list.forEach(a => variants.add(a));
    }
  }
  return variants;
}

/**
 * Tenta casar dois nomes com regras auditáveis.
 * @param {string} a
 * @param {string} b
 * @param {Object} [opts]
 * @param {Object<string,string[]>} [opts.aliases]
 * @param {number} [opts.minSubstrLen=4] — evita matches espúrios de siglas curtas (ex: "ig"→"big")
 * @param {number} [opts.minSubstrScore=0.5] — shorter/longer mínimo; rejeita substring fraco
 *   Ex: "Real" dentro de "UnrealTournament" (score 0.25) → rejeitado
 *   Legítimos típicos (score ≥ 0.5): "Liquid" em "Team Liquid" (0.55), "Fnatic" em "Fnatic Esports" (0.43 — rejeita por default; use alias)
 * @returns {{ match: boolean, score: number, method: 'exact'|'alias'|'substring'|'substring_weak'|'none' }}
 *   - `substring_weak` = casaria por substring mas o score é abaixo do threshold (logado para auditoria; NÃO é match)
 */
function nameMatches(a, b, opts = {}) {
  const { aliases, minSubstrLen = 4, minSubstrScore = 0.5 } = opts;
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return { match: false, score: 0, method: 'none' };

  if (na === nb) return { match: true, score: 1.0, method: 'exact' };

  if (aliases) {
    const va = expandAliases(na, aliases);
    const vb = expandAliases(nb, aliases);
    for (const x of va) if (vb.has(x)) return { match: true, score: 0.95, method: 'alias' };
  }

  // Substring só quando ambos têm tamanho suficiente (evita "ig"→"big")
  // E com threshold mínimo de score (evita "Real"→"UnrealTournament")
  if (na.length >= minSubstrLen && nb.length >= minSubstrLen) {
    if (na.includes(nb) || nb.includes(na)) {
      const shorter = Math.min(na.length, nb.length);
      const longer  = Math.max(na.length, nb.length);
      const score = +(shorter / longer).toFixed(2);
      if (score >= minSubstrScore) {
        return { match: true, score, method: 'substring' };
      }
      return { match: false, score, method: 'substring_weak' };
    }
  }

  return { match: false, score: 0, method: 'none' };
}

module.exports = { nameMatches, expandAliases };

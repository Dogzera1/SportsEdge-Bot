const { norm } = require('./utils');

function tennisSxNameLike(a, b) {
  const clean = (s) => {
    let n = norm(String(s || ''));
    for (const suf of ['gaming', 'esports', 'team', 'club', 'academy', 'gg', 'esport']) {
      if (n.endsWith(suf) && n.length > suf.length + 3) n = n.slice(0, -suf.length);
    }
    return n;
  };
  const na = clean(a);
  const nb = clean(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  if (na.length >= 6 && nb.length >= 6) {
    if (na.startsWith(nb.slice(0, 6)) || nb.startsWith(na.slice(0, 6))) return true;
  }
  return false;
}

/**
 * Extrai o sobrenome de um nome de tenista, lidando com formatos:
 * - "First Last"     → "Last"
 * - "Last, First"    → "Last"
 * - "J. Last"        → "Last"
 * - "J.Last"         → "Last"   (inicial colada ao sobrenome)
 */
function extractSurname(name) {
  const s = String(name || '').trim();
  // "Last, First" → sobrenome é a parte antes da vírgula
  const commaIdx = s.indexOf(',');
  if (commaIdx > 0) return s.slice(0, commaIdx).trim();
  // "X.LastName" → inicial colada (sem espaço)
  const abbrMatch = s.match(/^[A-Za-z]\.([A-Za-z]{3,})$/);
  if (abbrMatch) return abbrMatch[1];
  // "First Last" / "F. Last" → último token
  const tokens = s.split(/\s+/).filter(Boolean);
  return tokens.length ? tokens[tokens.length - 1] : s;
}

/**
 * Normaliza "Last, First" → "First Last" para comparações de substring.
 */
function normalizeNameOrder(name) {
  const s = String(name || '').trim();
  const commaIdx = s.indexOf(',');
  if (commaIdx <= 0) return s;
  return `${s.slice(commaIdx + 1).trim()} ${s.slice(0, commaIdx).trim()}`;
}

function tennisSinglePlayerNameMatch(displayA, displayB) {
  if (tennisSxNameLike(displayA, displayB)) return true;
  const na = norm(displayA);
  const nb = norm(displayB);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 5 && nb.length >= 5 && (na.includes(nb) || nb.includes(na))) return true;

  // Tenta também com nomes normalizados para "First Last"
  const normA = norm(normalizeNameOrder(displayA));
  const normB = norm(normalizeNameOrder(displayB));
  if (normA.length >= 5 && normB.length >= 5 && (normA.includes(normB) || normB.includes(normA))) return true;

  // Compara sobrenomes (lida com "Last, First", "J.Sinner", "J. Sinner")
  const surnameA = norm(extractSurname(displayA));
  const surnameB = norm(extractSurname(displayB));
  if (surnameA.length >= 4 && surnameA === surnameB) return true;

  // Fallback: último token (lógica original)
  const tokensA = String(displayA || '').trim().split(/\s+/).filter(Boolean);
  const tokensB = String(displayB || '').trim().split(/\s+/).filter(Boolean);
  const la = tokensA.length ? norm(tokensA[tokensA.length - 1]) : '';
  const lb = tokensB.length ? norm(tokensB[tokensB.length - 1]) : '';
  return la.length >= 4 && lb.length >= 4 && la === lb;
}

function tennisPairMatchesPlayers(p1, p2, t1, t2) {
  return (tennisSinglePlayerNameMatch(p1, t1) && tennisSinglePlayerNameMatch(p2, t2))
    || (tennisSinglePlayerNameMatch(p1, t2) && tennisSinglePlayerNameMatch(p2, t1));
}

/**
 * 2026-05-06: Detecta caso ambíguo onde sobrenome de p1 e t1/t2 são idênticos
 * (e.g. "Cerundolo F." vs "Cerundolo J.M." em mesma chave). Caller deve abortar
 * o match em vez de chutar. Retorna true quando NÃO há disambiguation possível
 * via initial/given name.
 */
function tennisAmbiguousSurnameMatch(displayA, displayB) {
  if (!displayA || !displayB) return false;
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  const tokensA = String(displayA).trim().split(/\s+/).filter(Boolean);
  const tokensB = String(displayB).trim().split(/\s+/).filter(Boolean);
  if (tokensA.length < 2 || tokensB.length < 2) return false;
  // Ambos têm sobrenome igual (último token >=4 chars) MAS first/initial diferentes
  const lastA = norm(tokensA[tokensA.length - 1]);
  const lastB = norm(tokensB[tokensB.length - 1]);
  if (lastA.length < 4 || lastA !== lastB) return false;
  const firstA = norm(tokensA[0]);
  const firstB = norm(tokensB[0]);
  // Se primeiros tokens diferentes (>=1 char distinct), é caso ambíguo (irmãos / pais).
  // Não conta inicial (J. Cerundolo vs J.M. Cerundolo poderia matchear; cuidado).
  if (firstA && firstB && firstA[0] !== firstB[0]) return true;
  return false;
}

module.exports = { tennisSinglePlayerNameMatch, tennisPairMatchesPlayers, tennisAmbiguousSurnameMatch };

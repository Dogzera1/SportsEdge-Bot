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

function tennisSinglePlayerNameMatch(displayA, displayB) {
  if (tennisSxNameLike(displayA, displayB)) return true;
  const na = norm(displayA);
  const nb = norm(displayB);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 5 && nb.length >= 5 && (na.includes(nb) || nb.includes(na))) return true;
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

module.exports = { tennisSinglePlayerNameMatch, tennisPairMatchesPlayers };

// lib/lol-champions.js
// Canonical champion key = lowercased, punctuation/space/'&' stripped, then alias-folded.
// Both the training matrices and the query path call this, so as long as it is consistent
// the exact string is irrelevant; ALIASES only fixes cross-source spelling drift.
const ALIASES = {
  monkeyking: 'wukong',
  nunuwillump: 'nunu',
  renataglasc: 'renata',
  drmundo: 'drmundo',
  jarvaniv: 'jarvaniv',
  leesin: 'leesin',
  masteryi: 'masteryi',
  missfortune: 'missfortune',
  reksai: 'reksai',
  tahmkench: 'tahmkench',
  twistedfate: 'twistedfate',
  xinzhao: 'xinzhao',
  aurelionsol: 'aurelionsol',
  ksante: 'ksante',
  belveth: 'belveth',
};

function normalizeChampion(name) {
  if (name == null) return null;
  let k = String(name).toLowerCase().replace(/&/g, '').replace(/[^a-z0-9]/g, '');
  if (!k) return null;
  if (ALIASES[k]) k = ALIASES[k];
  return k;
}

module.exports = { normalizeChampion, ALIASES };

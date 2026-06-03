// lib/lol-champions.js
// Canonical champion key = lowercased, punctuation/space/'&' stripped, then alias-folded.
// Both the training matrices and the query path call this, so as long as it is consistent
// the exact string is irrelevant; ALIASES only fixes cross-source spelling drift.
// Only cross-source spelling drift, where the stripped form differs between sources.
// Multi-word/punctuated names (Dr. Mundo, Lee Sin, Rek'Sai, K'Sante, …) already converge
// via the strip step, so they need no alias entry.
const ALIASES = {
  monkeyking: 'wukong',  // Oracle's Elixir "MonkeyKing" vs common "Wukong"
  nunuwillump: 'nunu',   // "Nunu & Willump" vs "Nunu"
  renataglasc: 'renata', // "Renata Glasc" vs "Renata"
};

function normalizeChampion(name) {
  if (name == null) return null;
  let k = String(name).toLowerCase().replace(/&/g, '').replace(/[^a-z0-9]/g, '');
  if (!k) return null;
  if (ALIASES[k]) k = ALIASES[k];
  return k;
}

// Canonical roles = Oracle's Elixir codes: top, jng, mid, bot, sup. Folds player/UI/source aliases
// (ADC, JGL, support, …) so every input vocabulary converges to the artifact keys. Unknown tokens
// pass through (cleaned); empty/null → '' (forms no lane in the engine).
const ROLE_ALIASES = {
  top: 'top',
  jng: 'jng', jgl: 'jng', jungle: 'jng', jg: 'jng', jung: 'jng', jungler: 'jng',
  mid: 'mid', middle: 'mid', mids: 'mid',
  bot: 'bot', adc: 'bot', adcarry: 'bot', bottom: 'bot', carry: 'bot', marksman: 'bot', ad: 'bot',
  sup: 'sup', supp: 'sup', support: 'sup', sp: 'sup', support2: 'sup',
};
function normalizeRole(role) {
  if (role == null) return '';
  const k = String(role).toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return '';
  return ROLE_ALIASES[k] || k;
}

// Player handles on scoreboards/livestats carry a short team-tag prefix ("SLY Kryze", "GL OMON").
// Drop a leading tag (1-4 alphanumerics + space) so the bare nickname matches the mastery table,
// which is trained on tag-less oracleselixir names. A single-word handle ("Faker") is left as-is.
function stripPlayerTeamTag(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return null;
  const m = s.match(/^[A-Za-z0-9]{1,4}\s+(\S.*)$/);
  return m ? m[1].trim() : s;
}

module.exports = { normalizeChampion, ALIASES, normalizeRole, ROLE_ALIASES, stripPlayerTeamTag };

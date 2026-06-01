'use strict';
/**
 * dota-match-explain.js — Display-only Dota AI reading.
 * Prob is the Elo (the model). The AI reads the draft using its OWN Dota knowledge
 * (synergies/counters/timings) — labeled as general knowledge (may not match the live patch).
 */
const KEYS = ['overview', 'draftRead', 'keyHeroes', 'verdict'];

function buildDotaExplainPrompt({ pred, draft, teams, fairOdds, edge }) {
  const t = teams || {};
  const el = pred.components && pred.components.elo;
  const dr = pred.components && pred.components.draft;
  const lines = [];
  lines.push('Dados da partida de Dota 2 (modelo estatístico display-only — NÃO são apostas):');
  lines.push(`- Times: Azul=${t.blue || '(não informado)'}, Vermelho=${t.red || '(não informado)'}`);
  if (el) lines.push(`- P(Azul vence) ~ ${Math.round((pred.probBlue) * 100)}% (${pred.label}); Elo: Azul ${el.ratingBlue} vs Vermelho ${el.ratingRed}`);
  if (fairOdds) { let o = `- Odd justa: Azul ${fairOdds.team1} / Vermelho ${fairOdds.team2}`; if (edge != null) o += `; edge vs odd da casa: ${(edge * 100).toFixed(1)}%`; lines.push(o); }
  if (dr) lines.push(`- Força de draft (winrate meta, dado): Azul ${(dr.blueWR * 100).toFixed(1)}% vs Vermelho ${(dr.redWR * 100).toFixed(1)}%`);
  if (draft) { const f = (a) => (a || []).join(', '); lines.push(`- Heróis Azul: ${f(draft.blue)}`); lines.push(`- Heróis Vermelho: ${f(draft.red)}`); }
  lines.push('');
  lines.push('Você é um analista de Dota 2. O prob acima vem do Elo (NÃO o altere). Para a leitura do draft, USE O SEU CONHECIMENTO sobre os heróis (sinergias, counters, win conditions, power spikes, timings).');
  lines.push('Responda APENAS um JSON compacto, nada fora dele, em PT-BR:');
  lines.push('{"overview":"…","draftRead":"…","keyHeroes":"…","verdict":"…"}');
  lines.push('Regras: cada campo 1-2 frases; o verdict se apoia no Elo/odd justa (não invente probabilidade); a leitura de draft é o seu conhecimento geral (pode não refletir o patch atual); NÃO recomende stake nem diga "aposte".');
  return lines.join('\n');
}

function parseDotaExplain(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj; try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!KEYS.some(k => typeof obj[k] === 'string' && obj[k].trim())) return null;
  const out = {}; for (const k of KEYS) out[k] = (typeof obj[k] === 'string') ? obj[k] : '';
  return out;
}
module.exports = { buildDotaExplainPrompt, parseDotaExplain };

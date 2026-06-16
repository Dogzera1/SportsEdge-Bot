'use strict';
/**
 * tennis-match-explain.js — Display-only Tennis AI reading.
 * The probabilities/odds come from the model (the AI must NOT alter them). The AI reads the
 * matchup (style, surface fit, H2H) using its OWN tennis knowledge — labeled general knowledge.
 * Never recommends stake.
 */
const KEYS = ['overview', 'matchupRead', 'marketsRead', 'verdict'];

function buildTennisExplainPrompt({ pred, players, surface, bestOf }) {
  const p = players || {};
  const h = pred.headline || {};
  const m = pred.markets || {};
  const n1 = p.player1 || 'J1';
  const n2 = p.player2 || 'J2';
  const lines = [];
  lines.push('Dados da partida de tênis (modelo estatístico display-only — NÃO são apostas):');
  lines.push(`- Jogadores: ${n1} vs ${n2} | superfície: ${surface} | ${bestOf === 5 ? 'Melhor de 5 sets' : 'Melhor de 3 sets'} | tier: ${h.tier || '?'}`);
  lines.push(`- P(${n1} vence) = ${(h.probP1 * 100).toFixed(1)}% (${h.label}; conf ${h.confidence}). Markov de saque: ${(h.markovProbP1 * 100).toFixed(1)}%${h.divergenceFlag ? ' (DIVERGE do modelo — favorece quem saca melhor)' : ''}.`);
  for (const f of (pred.factors || [])) lines.push(`- Fator ${f.name}: ${n1} ${f.p1}% vs ${n2} ${f.p2}% (peso ${f.weight}) — ${f.detail}`);
  if (m.ml) lines.push(`- ML odd justa: ${n1} ${m.ml.fairOddP1} / ${n2} ${m.ml.fairOddP2}`);
  if (Array.isArray(m.totalGames) && m.totalGames.length) {
    const tg = m.totalGames[Math.floor(m.totalGames.length / 2)];
    lines.push(`- Total de games linha ${tg.line}: over ${(tg.pOver * 100).toFixed(0)}% (justa ${tg.fairOddOver}) / under ${(tg.pUnder * 100).toFixed(0)}% (justa ${tg.fairOddUnder})`);
  }
  if (Array.isArray(m.handicapGames) && m.handicapGames.length) {
    const hg = m.handicapGames.find(x => x.line < 0) || m.handicapGames[0];
    lines.push(`- Handicap games ${n1} ${hg.line}: ${(hg.prob * 100).toFixed(0)}% (justa ${hg.fairOdd})`);
  }
  if (m.tiebreak) lines.push(`- P(haver tiebreak na partida): ${(m.tiebreak.pMatchHasTiebreak * 100).toFixed(0)}%`);
  lines.push('');
  lines.push('Você é um analista de tênis. As probabilidades/odds acima vêm do modelo (NÃO as altere). Para a leitura do confronto (estilo de jogo, ajuste por superfície, H2H, forma), USE O SEU CONHECIMENTO de tênis.');
  lines.push('Responda APENAS um JSON compacto, nada fora dele, em PT-BR:');
  lines.push('{"overview":"…","matchupRead":"…","marketsRead":"…","verdict":"…"}');
  lines.push('Regras: cada campo 1-3 frases; overview = resumo do confronto; matchupRead = leitura de estilo/superfície/H2H (seu conhecimento, pode não refletir lesões/forma recentes); marketsRead = o que os números de games/handicap/tiebreak sugerem (sem inventar edge); verdict = conclusão apoiada no modelo; NÃO recomende stake nem diga "aposte".');
  return lines.join('\n');
}

function parseTennisExplain(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj; try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!KEYS.some(k => typeof obj[k] === 'string' && obj[k].trim())) return null;
  const out = {}; for (const k of KEYS) out[k] = (typeof obj[k] === 'string') ? obj[k] : '';
  return out;
}

module.exports = { buildTennisExplainPrompt, parseTennisExplain };

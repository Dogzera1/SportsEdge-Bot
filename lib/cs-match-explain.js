'use strict';
/**
 * cs-match-explain.js — Display-only CS AI reading.
 * Prob is the Elo (the model). The AI reads the matchup using its OWN CS knowledge
 * (form, playstyle, context) — must NOT invent map/player stats we don't have.
 */
const KEYS = ['overview', 'matchupRead', 'verdict'];

function buildCsExplainPrompt({ pred, teams, fairOdds, edge }) {
  const t = teams || {};
  const el = pred.components && pred.components.elo;
  const lines = [];
  lines.push('Dados da partida de Counter-Strike (CS2) — modelo estatístico display-only, NÃO são apostas:');
  lines.push(`- Times: ${t.team1 || '(não informado)'} vs ${t.team2 || '(não informado)'}`);
  if (el) {
    lines.push(`- P(${t.team1 || 'Time 1'} vence) ~ ${Math.round(pred.probTeam1 * 100)}% (${pred.label}); Elo: ${t.team1 || 'T1'} ${el.ratingTeam1} vs ${t.team2 || 'T2'} ${el.ratingTeam2}`);
  }
  if (fairOdds) {
    let o = `- Odd justa: ${t.team1 || 'T1'} ${fairOdds.team1} / ${t.team2 || 'T2'} ${fairOdds.team2}`;
    if (edge != null) o += `; edge vs odd da casa: ${(edge * 100).toFixed(1)}%`;
    lines.push(o);
  }
  lines.push('');
  lines.push('Você é um analista de Counter-Strike. O prob acima vem do Elo (NÃO o altere). Explique o confronto com o seu conhecimento (forma recente, estilo de jogo, contexto do confronto/rivalidade).');
  lines.push('Responda APENAS um JSON compacto, nada fora dele, em PT-BR:');
  lines.push('{"overview":"…","matchupRead":"…","verdict":"…"}');
  lines.push('Regras: cada campo 1-2 frases; NÃO invente estatísticas que não estão nos dados (sem winrate por mapa, sem rating de jogador específico); o verdict se apoia no Elo/odd justa (não invente probabilidade); NÃO recomende stake nem diga "aposte".');
  return lines.join('\n');
}

function parseCsExplain(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!KEYS.some(k => typeof obj[k] === 'string' && obj[k].trim())) return null;
  const out = {};
  for (const k of KEYS) out[k] = (typeof obj[k] === 'string') ? obj[k] : '';
  return out;
}
module.exports = { buildCsExplainPrompt, parseCsExplain };

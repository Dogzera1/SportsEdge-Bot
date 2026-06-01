'use strict';
/**
 * lol-match-explain.js — Display-only LLM "match reading".
 * Pure helpers: build the prompt from the already-computed game-profile, and parse
 * the model's JSON answer into sections. No network here (the endpoint calls aiPost).
 *
 * DISPLAY-ONLY: the analysis is qualitative; it must never feed stake/EV/Kelly.
 */
const KEYS = ['early', 'mid', 'late', 'winCondition', 'keyMatchup', 'verdict'];

function _side(w) { return w === 'blue' ? 'Azul' : w === 'red' ? 'Vermelho' : 'equilíbrio'; }

function buildExplainPrompt({ gameProfile, draft, teams, probPct, label }) {
  const gp = gameProfile || {};
  const t = teams || {};
  const lines = [];
  lines.push('Dados da partida de LoL (modelo estatístico display-only — NÃO são apostas):');
  lines.push(`- Times: Azul=${t.blue || '(não informado)'}, Vermelho=${t.red || '(não informado)'}`);
  if (probPct != null) lines.push(`- P(Azul vence) ~ ${probPct}% (${label || ''}), via Elo do time`);
  if (gp.fairOdds) {
    let odds = `- Odd justa: Azul ${gp.fairOdds.team1} / Vermelho ${gp.fairOdds.team2}`;
    if (gp.edge != null) odds += `; edge vs odd da casa: ${(gp.edge * 100).toFixed(1)}%`;
    lines.push(odds);
  }
  if (gp.phases) {
    const { early, mid, late } = gp.phases;
    if (early && early.anchor) lines.push(`- EARLY (medido): ${_side(early.winner)} — Δ aos 15min ${early.anchor.golddiff15}g, ${early.anchor.xpdiff15}xp, ${early.anchor.csdiff15}cs`);
    if (mid) lines.push(`- MID (estimado): ${_side(mid.winner)}`);
    if (late) lines.push(`- LATE (estimado/scaling): ${_side(late.winner)}`);
  }
  if (gp.expectedTime) lines.push(`- Tempo esperado: ${gp.expectedTime.bucket} (~${Math.round(gp.expectedTime.seconds / 60)} min)`);
  if (gp.winCondition) lines.push(`- Win condition (computada): ${gp.winCondition}`);
  if (gp.compStyle) lines.push(`- Estilo de comp: Azul=${gp.compStyle.blue.style}, Vermelho=${gp.compStyle.red.style}`);
  if (draft) {
    const fmt = (arr) => (arr || []).map(p => `${p.role}:${p.champion}`).join(' ');
    lines.push(`- Draft Azul: ${fmt(draft.blue)}  | Draft Vermelho: ${fmt(draft.red)}`);
  }
  lines.push('');
  lines.push('Você é um analista de LoL. Com base SOMENTE nos dados acima, escreva a leitura em PT-BR.');
  lines.push('Responda APENAS um JSON compacto, nada fora dele:');
  lines.push('{"early":"…","mid":"…","late":"…","winCondition":"…","keyMatchup":"…","verdict":"…"}');
  lines.push('Regras: cada campo 1-2 frases; seja MEDIDO — draft sozinho é sinal fraco, o Elo do time domina o resultado; NÃO recomende stake nem diga "aposte"; no verdict comente valor apenas em relação à odd justa; não invente nada fora dos dados acima.');
  return lines.join('\n');
}

function parseExplainResponse(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const hasAny = KEYS.some(k => typeof obj[k] === 'string' && obj[k].trim());
  if (!hasAny) return null;
  const out = {};
  for (const k of KEYS) out[k] = (typeof obj[k] === 'string') ? obj[k] : '';
  return out;
}

module.exports = { buildExplainPrompt, parseExplainResponse };

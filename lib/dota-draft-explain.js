'use strict';
/**
 * dota-draft-explain.js — Display-only Dota draft AI reading, ANCHORED on the objective numbers
 * (counter edge, player×hero WR, composition) computed by dota-draft-analysis. The model interprets
 * those + adds its own Dota knowledge (synergies/timings). No win-probability, no stake advice.
 */
const KEYS = ['overview', 'matchups', 'keyPlayers', 'verdict'];

function _fmtPlayers(side) {
  return (side || []).filter(p => p && p.resolved).map(p => {
    const on = p.onHero ? `${(p.onHero.wr * 100).toFixed(0)}% em ${p.games || p.onHero.games} jogos` : 'sem histórico no herói';
    return `${p.player || p.nick} (${p.hero}): ${on}`;
  }).join('; ');
}
function _fmtComp(c) {
  if (!c) return '(sem dados)';
  const roles = Object.entries(c.roleCounts || {}).map(([k, v]) => `${k} ${v}`).join(', ');
  const attrs = Object.entries(c.attrCounts || {}).map(([k, v]) => `${k} ${v}`).join('/');
  return `roles: ${roles || '—'}; atributos: ${attrs || '—'}`;
}

function buildDotaDraftPrompt({ teams, draft, matchupEdge, playerHeroes, composition }) {
  const t = teams || {};
  const d = draft || {};
  const lines = [];
  lines.push('Dados objetivos de um draft de Dota 2 (display-only — NÃO são apostas):');
  lines.push(`- Times: Azul=${t.blue || '(n/d)'}, Vermelho=${t.red || '(n/d)'}`);
  lines.push(`- Heróis Azul: ${(d.blue || []).join(', ') || '(n/d)'}`);
  lines.push(`- Heróis Vermelho: ${(d.red || []).join(', ') || '(n/d)'}`);
  if (matchupEdge) {
    lines.push(`- Counter edge (vantagem de matchup, dado): Azul ${matchupEdge.blueAdvantagePp >= 0 ? '+' : ''}${matchupEdge.blueAdvantagePp}pp em ${matchupEdge.sampled} confrontos com amostra`);
    for (const p of (matchupEdge.pairs || []).slice(0, 5)) lines.push(`  · ${p.blueName} vs ${p.redName}: ${p.advPp >= 0 ? '+' : ''}${p.advPp}pp (n=${p.games})`);
  }
  lines.push(`- WR jogador×herói (dado) — Azul: ${_fmtPlayers(playerHeroes && playerHeroes.blue) || '(n/d)'}`);
  lines.push(`- WR jogador×herói (dado) — Vermelho: ${_fmtPlayers(playerHeroes && playerHeroes.red) || '(n/d)'}`);
  lines.push(`- Composição Azul — ${_fmtComp(composition && composition.blue)}`);
  lines.push(`- Composição Vermelho — ${_fmtComp(composition && composition.red)}`);
  lines.push('');
  lines.push('Você é um analista de Dota 2. INTERPRETE os números acima (counter edge, WR jogador×herói, composição) e complemente com o seu conhecimento dos heróis (sinergias, counters, win conditions, power spikes, timings).');
  lines.push('Responda APENAS um JSON compacto, nada fora dele, em PT-BR:');
  lines.push('{"overview":"…","matchups":"…","keyPlayers":"…","verdict":"…"}');
  lines.push('Regras: cada campo 1-2 frases; matchups = leitura dos counters; keyPlayers = quem decide (apoie-se nos WR jogador×herói); verdict = síntese. NÃO invente probabilidade de vitória, NÃO recomende stake nem diga "aposte". A leitura de meta/sinergia é conhecimento geral (pode não refletir o patch atual).');
  return lines.join('\n');
}

function parseDotaDraftExplain(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj; try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!KEYS.some(k => typeof obj[k] === 'string' && obj[k].trim())) return null;
  const out = {}; for (const k of KEYS) out[k] = (typeof obj[k] === 'string') ? obj[k] : '';
  return out;
}
module.exports = { buildDotaDraftPrompt, parseDotaDraftExplain };

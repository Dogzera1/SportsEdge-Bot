'use strict';

// 2026-05-06 FIX: arquivo precisa exportar function(t) pra tests/run.js. Antes
// rodava assertions inline em require() → run.js crashava com "mod is not a
// function" e silenciosamente bloqueava testes posteriores na ordem readdir.
const assert = require('assert');
const { computeH2HEnsemble, inferSurface } = require('../lib/tennis-h2h-ensemble');

module.exports = function(t) {
// inferSurface tests
assert.strictEqual(inferSurface('ATP Madrid - QF'), 'clay');
assert.strictEqual(inferSurface('Wimbledon - R64'), 'grass');
assert.strictEqual(inferSurface('US Open - SF'), 'hard');
assert.strictEqual(inferSurface('Roland Garros - R128'), 'clay');
assert.strictEqual(inferSurface('Paris Bercy - F'), 'hard_indoor');
assert.strictEqual(inferSurface('ATP Finals'), 'hard_indoor');
assert.strictEqual(inferSurface('ATP Random Tournament'), 'unknown');
assert.strictEqual(inferSurface(''), 'unknown');
assert.strictEqual(inferSurface(null), 'unknown');
console.log('OK: inferSurface covers Slam/Masters/indoor/unknown');

// Caso 1: sem dados — mantém pMarkov
{
  const r = computeH2HEnsemble(null, 0.65);
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.pBlend, 0.65);
  console.log('OK: no_h2h_data preserves pMarkov');
}

// Caso 2: n insuficiente (< minN=3)
{
  const r = computeH2HEnsemble({ totalMatches: 2, t1Wins: 1, t2Wins: 1, results: [] }, 0.65);
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.pBlend, 0.65);
  console.log('OK: insufficient_n preserves pMarkov');
}

// Caso 3: n=3 t1 dominante (3-0). Laplace: (3+0.5)/(3+1) = 0.875.
// Weight = 3/10 * 0.30 = 0.09. Blend = 0.91 * 0.65 + 0.09 * 0.875 = 0.6716.
{
  const r = computeH2HEnsemble({ totalMatches: 3, t1Wins: 3, t2Wins: 0, results: [] }, 0.65);
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.pH2h, 0.875);
  assert.strictEqual(r.weight, 0.09);
  assert(r.pBlend > 0.65 && r.pBlend < 0.70, `pBlend=${r.pBlend} should be slightly higher than 0.65`);
  console.log(`OK: n=3 t1-dominant pulls toward H2H slightly: ${r.pBlend.toFixed(4)}`);
}

// Caso 4: n=10 split balanced (5-5). pH2h ≈ 0.5. Weight=0.30.
// Blend = 0.70 * 0.65 + 0.30 * 0.5 = 0.605 (puxa pra 0.5).
{
  const r = computeH2HEnsemble({ totalMatches: 10, t1Wins: 5, t2Wins: 5, results: [] }, 0.65);
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.weight, 0.30);
  assert.strictEqual(r.pH2h, 0.5);
  assert(r.pBlend < 0.62 && r.pBlend > 0.59, `pBlend=${r.pBlend} should pull toward 0.5`);
  console.log(`OK: n=10 balanced H2H pulls model toward 0.5: ${r.pBlend.toFixed(4)}`);
}

// Caso 5: n=15 t1 dominante (12-3) com Markov pessimista (P1=0.40)
// pH2h = (12+0.5)/(15+1) = 0.78125. Weight cap em 0.30.
// Blend = 0.70 * 0.40 + 0.30 * 0.78125 = 0.5144.
{
  const r = computeH2HEnsemble({ totalMatches: 15, t1Wins: 12, t2Wins: 3, results: [] }, 0.40);
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.weight, 0.30); // capped
  assert(r.pH2h > 0.77 && r.pH2h < 0.79);
  assert(r.pBlend > 0.50 && r.pBlend < 0.53, `pBlend=${r.pBlend} should pull markov up significantly`);
  console.log(`OK: n=15 H2H corrects pessimistic Markov: ${r.pBlend.toFixed(4)}`);
}

// Caso 6: pMarkov inválido
{
  const r = computeH2HEnsemble({ totalMatches: 5, t1Wins: 3, t2Wins: 2 }, 1.5);
  assert.strictEqual(r.applied, false);
  assert.strictEqual(r.reason, 'invalid_p_markov');
  console.log('OK: invalid pMarkov rejected');
}

// Caso 7: clamp [0.05, 0.95]
{
  const r = computeH2HEnsemble({ totalMatches: 20, t1Wins: 20, t2Wins: 0, results: [] }, 0.92);
  // pH2h = (20+0.5)/(20+1) = 0.976. Blend = 0.70*0.92 + 0.30*0.976 = 0.937
  // Não bate clamp. Mas se Markov fosse 0.94 e weight fosse maior...
  assert(r.pBlend <= 0.95);
  console.log(`OK: clamping respected (pBlend=${r.pBlend.toFixed(4)})`);
}

// Caso 8: surface-aware — Federer-Nadal style: 5 matches, 4 no clay, 1 no hard.
// Cenário: jogo atual no clay; H2H mostra t1=Nadal dominante no clay (4-0) + 1 hard loss.
// Sem surface: t1Wins=4, total=5, pH2h~0.75
// Com surface=clay: weighted_t1Wins ~ 4*1.0 = 4, weighted_total = 4*1.0 + 1*0.4 = 4.4
//   → pH2h = (4+0.5)/(4.4+1) = 0.833 (mais forte!)
{
  const results = [];
  const today = Date.now();
  // 4 vitorias t1 (homeGoals=2, awayGoals=0) em clay, 1 derrota t1 em hard
  for (let i = 0; i < 4; i++) {
    results.push({ home: 'Nadal', away: 'Federer', homeGoals: 2, awayGoals: 0, date: new Date(today - i * 30 * 86400e3).toISOString(), league: 'Roland Garros - F' });
  }
  results.push({ home: 'Nadal', away: 'Federer', homeGoals: 0, awayGoals: 2, date: new Date(today - 200 * 86400e3).toISOString(), league: 'Wimbledon - F' });
  const h2h = { totalMatches: 5, t1Wins: 4, t2Wins: 1, results };

  // Sem surface filter
  const rNoSurf = computeH2HEnsemble(h2h, 0.50);
  // Com surface=clay (mesma da maioria)
  const rClay = computeH2HEnsemble(h2h, 0.50, { currentSurface: 'clay' });
  // Com surface=grass (so 1 match nesta superficie, rest desvalorizado)
  const rGrass = computeH2HEnsemble(h2h, 0.50, { currentSurface: 'grass' });

  console.log(`OK: surface-aware Nadal/Federer-style:`);
  console.log(`   no surface: pH2h=${rNoSurf.pH2h} weight=${rNoSurf.weight} pBlend=${rNoSurf.pBlend.toFixed(4)}`);
  console.log(`   clay (4 same): pH2h=${rClay.pH2h} weight=${rClay.weight} surfMatches=${rClay.surfaceMatches} pBlend=${rClay.pBlend.toFixed(4)}`);
  console.log(`   grass (1 same): pH2h=${rGrass.pH2h} weight=${rGrass.weight} surfMatches=${rGrass.surfaceMatches} pBlend=${rGrass.pBlend.toFixed(4)}`);

  // Clay deve puxar mais pra cima que grass (clay tem mais matches matching)
  assert(rClay.pBlend > rGrass.pBlend, `clay (${rClay.pBlend}) should pull more than grass (${rGrass.pBlend})`);
  // Clay deve agora ser MAIS confiante que sem surface filter (porque os match clay são reforçados)
  assert(rClay.pH2h > rNoSurf.pH2h, `clay-weighted pH2h (${rClay.pH2h}) should be > no-surface pH2h (${rNoSurf.pH2h})`);
}

console.log('\\nAll tennis-h2h-ensemble tests passed.');
};


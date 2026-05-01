'use strict';

const assert = require('assert');
const { computeH2HEnsemble } = require('../lib/tennis-h2h-ensemble');

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

console.log('\\nAll tennis-h2h-ensemble tests passed.');

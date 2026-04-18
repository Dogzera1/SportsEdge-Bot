#!/usr/bin/env node
'use strict';

// scripts/test-tennis-trained.js
// Sanity: carrega weights + prediz alguns cenários sintéticos.

const { predictTrainedTennis, hasTrainedModel } = require('../lib/tennis-model-trained');

if (!hasTrainedModel()) {
  console.error('Trained model not loaded — lib/tennis-weights.json ausente?');
  process.exit(1);
}

// Cenário 1: p1 muito superior em Elo surface (ex: Djokovic vs qualifier)
const c1 = predictTrainedTennis({
  eloOverall1: 2100, eloOverall2: 1600,
  eloSurface1: 2150, eloSurface2: 1580,
  gamesSurface1: 50, gamesSurface2: 20,
  surface: 'hard',
  rankPoints1: 8000, rankPoints2: 800,
  age1: 33, age2: 25,
  bestOf: 3,
});
console.log('\nC1 — Djokovic-like vs challenger-like (hard):');
console.log(`  trainedP1=${(c1.p1 * 100).toFixed(1)}%  (raw=${(c1.raw * 100).toFixed(1)}%, nSignals=${c1.nSignals})`);

// Cenário 2: empate total, clay
const c2 = predictTrainedTennis({
  eloOverall1: 1800, eloOverall2: 1800,
  eloSurface1: 1800, eloSurface2: 1800,
  gamesSurface1: 30, gamesSurface2: 30,
  surface: 'clay',
  bestOf: 3,
});
console.log('\nC2 — equals on clay:');
console.log(`  trainedP1=${(c2.p1 * 100).toFixed(1)}%  (esperado ~50%)`);

// Cenário 3: p2 ranking muito melhor mas elo surface ruim (transition player)
const c3 = predictTrainedTennis({
  eloOverall1: 1800, eloOverall2: 1900,
  eloSurface1: 1850, eloSurface2: 1700,  // p1 é melhor em clay embora overall menor
  gamesSurface1: 25, gamesSurface2: 5,
  surface: 'clay',
  rankPoints1: 2000, rankPoints2: 3500,
  bestOf: 3,
});
console.log('\nC3 — p1 worse overall/rank mas p1 >> p2 no clay:');
console.log(`  trainedP1=${(c3.p1 * 100).toFixed(1)}%`);

// Cenário 4: p1 fadigado
const c4 = predictTrainedTennis({
  eloOverall1: 1800, eloOverall2: 1800,
  eloSurface1: 1800, eloSurface2: 1800,
  gamesSurface1: 30, gamesSurface2: 30,
  surface: 'hard',
  fatigueMin7d_1: 500, fatigueMin7d_2: 60, // p1 jogou 5 matches, p2 apenas 1
  matches14d_1: 6, matches14d_2: 1,
  daysSinceLast1: 1, daysSinceLast2: 5,
  bestOf: 3,
});
console.log('\nC4 — equals mas p1 está fadigado:');
console.log(`  trainedP1=${(c4.p1 * 100).toFixed(1)}% (esperado <50%)`);

// Cenário 5: Grand slam bo5, p1 muito superior
const c5 = predictTrainedTennis({
  eloOverall1: 2050, eloOverall2: 1750,
  eloSurface1: 2050, eloSurface2: 1750,
  gamesSurface1: 40, gamesSurface2: 40,
  surface: 'grass',
  bestOf: 5,
});
console.log('\nC5 — p1 bem superior em grass Bo5 (Wimbledon):');
console.log(`  trainedP1=${(c5.p1 * 100).toFixed(1)}% (esperado >75%, pois bo5 amplifica skill gap)`);

console.log('\n✓ trained predict OK');

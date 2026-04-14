/**
 * Testes do cálculo de Kelly.
 */

const { calcKellyWithP, calcKellyFraction } = require('../lib/utils');

module.exports = function runTests(t) {
  t.test('Kelly negativo (p*odds < 1) retorna 0u', () => {
    // p=0.40, odds=2.00 → kelly = (0.4*2 - 1) / 1 = -0.2 → negativo
    const stake = calcKellyWithP(0.40, '2.00', 0.25);
    t.assert(stake === '0u', `esperado 0u, got ${stake}`);
  });

  t.test('Kelly positivo gera stake > 0', () => {
    // p=0.60, odds=2.00 → kelly = (0.6*2 - 1)/1 = 0.2 * 0.25 = 0.05 (5% banca)
    const stake = calcKellyWithP(0.60, '2.00', 0.25);
    const units = parseFloat(stake);
    t.assert(units > 0, `esperado > 0, got ${stake}`);
  });

  t.test('Kelly com p inválido (>1) retorna 0.5u', () => {
    const stake = calcKellyWithP(1.5, '2.00', 0.25);
    t.assert(stake === '0.5u', `got ${stake}`);
  });

  t.test('Kelly com odds <= 1 retorna 0.5u', () => {
    const stake = calcKellyWithP(0.60, '1.00', 0.25);
    t.assert(stake === '0.5u', `got ${stake}`);
  });

  t.test('calcKellyFraction com EV zero retorna 0.5u', () => {
    const stake = calcKellyFraction('0%', '2.00', 0.25);
    t.assert(stake === '0.5u', `got ${stake}`);
  });

  t.test('Fração menor resulta em stake menor ou igual (edge pequeno, sem cap)', () => {
    // p=0.52, odds=2.00 → kelly full = 0.04; 1/10 vs 1/6 dão valores bem diferentes
    const small = parseFloat(calcKellyWithP(0.52, '2.00', 0.10));
    const big   = parseFloat(calcKellyWithP(0.52, '2.00', 1/6));
    t.assert(small <= big, `1/10=${small} deveria ser ≤ 1/6=${big}`);
  });
};

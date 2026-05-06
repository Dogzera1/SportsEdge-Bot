'use strict';

// Regression test pra calcKellyWithP cap fix (round 13/14):
// 1. Cap respeita confKey (não frac inflada por stage boost)
// 2. Back-compat sem confKey usa frac

const { calcKellyWithP } = require('../lib/utils');

function parseStake(s) {
  return parseFloat(String(s).replace(/u/gi, '').replace(',', '.')) || 0;
}

module.exports = function (t) {
  // Cenário: T1 Academy LCK final, MÉDIA conf, stage boost empurra frac >= 0.25
  // Antes do fix: maxStake=4 (cap de ALTA) → stake até 4u
  // Pós-fix com confKey=MÉDIA: maxStake=3 → stake max 3u
  t.test('confKey=MEDIA cap em 3u mesmo com frac alta', () => {
    // p alto + odd baixo + frac alta = kelly stake alto
    const s = calcKellyWithP(0.85, 1.42, 0.25, { sport: 'lol', confKey: 'MEDIA' });
    const u = parseStake(s);
    t.assert(u <= 3, `MÉDIA cap=3u, got ${u}`);
  });

  t.test('confKey=ALTA cap em 4u', () => {
    const s = calcKellyWithP(0.85, 1.42, 0.30, { sport: 'lol', confKey: 'ALTA' });
    const u = parseStake(s);
    t.assert(u <= 4, `ALTA cap=4u, got ${u}`);
  });

  t.test('confKey=BAIXA cap em 1.5u', () => {
    const s = calcKellyWithP(0.85, 1.42, 0.20, { sport: 'lol', confKey: 'BAIXA' });
    const u = parseStake(s);
    t.assert(u <= 1.5, `BAIXA cap=1.5u, got ${u}`);
  });

  t.test('confKey=MÉDIA (com acento) também detected', () => {
    const s = calcKellyWithP(0.85, 1.42, 0.30, { sport: 'lol', confKey: 'MÉDIA' });
    const u = parseStake(s);
    t.assert(u <= 3, `MÉDIA cap=3u, got ${u}`);
  });

  t.test('back-compat: sem confKey usa frac (comportamento antigo)', () => {
    // frac=0.25 → maxStake=4 (legacy)
    const s = calcKellyWithP(0.85, 1.42, 0.25, { sport: 'lol' });
    const u = parseStake(s);
    t.assert(u <= 4, `sem confKey usa frac → cap 4u, got ${u}`);
  });

  t.test('Kelly negativo retorna 0u (não cap)', () => {
    const s = calcKellyWithP(0.40, 1.50, 0.25, { sport: 'lol', confKey: 'ALTA' });
    t.assert(s === '0u', `Kelly neg → 0u, got ${s}`);
  });

  t.test('Floor 0.5u quando Kelly positivo mas pequeno', () => {
    const s = calcKellyWithP(0.52, 2.00, 0.05, { sport: 'lol', confKey: 'BAIXA' });
    const u = parseStake(s);
    t.assert(u >= 0.5, `floor 0.5u, got ${u}`);
  });
};

'use strict';

/**
 * test-market-tip-processor-gates.js — valida que shouldSendMarketTip retorna
 * gates_evaluated[] (snapshot per-tip dos gates rodados) preservando backward
 * compat de {ok, reason}.
 *
 * 2026-05-17: adicionado junto com refactor R2 (gate_state populating).
 */

const assert = require('assert');
const { shouldSendMarketTip } = require('../lib/market-tip-processor');

function runTests() {
  let passed = 0;
  let failed = 0;
  const fail = (name, err) => { failed++; console.error(`FAIL: ${name} — ${err.message}`); };
  const pass = (name) => { passed++; console.log(`OK: ${name}`); };

  // T1: tip passa todos gates — gates_evaluated lista todos com passed=true
  try {
    const tip = { ev: 15, pModel: 0.65, odd: 1.85, market: 'total', side: 'over', line: 2.5, sport: 'lol' };
    const r = shouldSendMarketTip(tip, { minEv: 8, minPmodel: 0.55, sport: 'lol' });
    assert.strictEqual(r.ok, true, 'expected ok=true');
    assert.strictEqual(r.reason, null, 'expected reason=null on pass');
    assert.ok(Array.isArray(r.gates_evaluated), 'gates_evaluated must be array');
    assert.ok(r.gates_evaluated.length >= 5, `expected >=5 gates evaluated, got ${r.gates_evaluated.length}`);
    const allPassed = r.gates_evaluated.every(g => g.passed === true);
    assert.strictEqual(allPassed, true, 'all gates must be passed=true');
    const names = r.gates_evaluated.map(g => g.gate);
    assert.ok(names.includes('ev_min'), 'expected ev_min gate');
    assert.ok(names.includes('ev_max'), 'expected ev_max gate');
    assert.ok(names.includes('pmodel_min'), 'expected pmodel_min gate');
    assert.ok(names.includes('odd_min'), 'expected odd_min gate');
    assert.ok(names.includes('pmodel_max'), 'expected pmodel_max gate');
    pass('T1: tip passa — gates_evaluated lista todos com passed=true');
  } catch (e) { fail('T1', e); }

  // T2: EV < minEv → fail em ev_min, gates_evaluated com 1 item failed
  try {
    const tip = { ev: 3, pModel: 0.65, odd: 1.85, market: 'total', side: 'over', sport: 'lol' };
    const r = shouldSendMarketTip(tip, { minEv: 8, minPmodel: 0.55, sport: 'lol' });
    assert.strictEqual(r.ok, false, 'expected ok=false');
    assert.ok(/EV.*<.*8%/.test(r.reason), `expected EV<8 reason, got: ${r.reason}`);
    assert.strictEqual(r.gates_evaluated.length, 1, 'expected early-return at ev_min — 1 gate evaluated');
    assert.strictEqual(r.gates_evaluated[0].gate, 'ev_min');
    assert.strictEqual(r.gates_evaluated[0].passed, false);
    assert.strictEqual(r.gates_evaluated[0].value, 3);
    assert.strictEqual(r.gates_evaluated[0].threshold, 8);
    pass('T2: EV<min — early-return ev_min, gates_evaluated.length=1');
  } catch (e) { fail('T2', e); }

  // T3: EV > maxEv → fail em ev_max (2 gates evaluated: ev_min passed, ev_max failed)
  try {
    const tip = { ev: 50, pModel: 0.65, odd: 1.85, market: 'total', side: 'over', sport: 'lol' };
    const r = shouldSendMarketTip(tip, { minEv: 8, minPmodel: 0.55, sport: 'lol' });
    assert.strictEqual(r.ok, false);
    assert.ok(/EV.*>.*25%.*suspeito/.test(r.reason), `expected EV>max reason, got: ${r.reason}`);
    assert.strictEqual(r.gates_evaluated.length, 2);
    assert.strictEqual(r.gates_evaluated[0].gate, 'ev_min');
    assert.strictEqual(r.gates_evaluated[0].passed, true);
    assert.strictEqual(r.gates_evaluated[1].gate, 'ev_max');
    assert.strictEqual(r.gates_evaluated[1].passed, false);
    pass('T3: EV>max — gates_evaluated=[ev_min:pass, ev_max:fail]');
  } catch (e) { fail('T3', e); }

  // T4: pModel < minPmodel → fail em pmodel_min após ev_min/ev_max passados
  try {
    const tip = { ev: 12, pModel: 0.40, odd: 1.85, market: 'total', side: 'over', sport: 'lol' };
    const r = shouldSendMarketTip(tip, { minEv: 8, minPmodel: 0.55, sport: 'lol' });
    assert.strictEqual(r.ok, false);
    assert.ok(/pModel.*<.*55/.test(r.reason), `expected pModel<55 reason, got: ${r.reason}`);
    assert.strictEqual(r.gates_evaluated.length, 3);
    assert.strictEqual(r.gates_evaluated[2].gate, 'pmodel_min');
    assert.strictEqual(r.gates_evaluated[2].passed, false);
    pass('T4: pModel<min — gates_evaluated[2] = pmodel_min:fail');
  } catch (e) { fail('T4', e); }

  // T5: pModel > _pmCap (overconfident) → fail em pmodel_max
  try {
    const tip = { ev: 12, pModel: 0.92, odd: 1.85, market: 'total', side: 'over', sport: 'football' };
    const r = shouldSendMarketTip(tip, { minEv: 8, minPmodel: 0.55, sport: 'football' });
    // football cap default 0.75
    assert.strictEqual(r.ok, false);
    assert.ok(/ceiling/.test(r.reason), `expected ceiling reason, got: ${r.reason}`);
    const lastGate = r.gates_evaluated[r.gates_evaluated.length - 1];
    assert.strictEqual(lastGate.gate, 'pmodel_max');
    assert.strictEqual(lastGate.passed, false);
    pass('T5: pModel>cap football — last gate = pmodel_max:fail');
  } catch (e) { fail('T5', e); }

  // T6: backward compat — caller que só lê {ok, reason} continua funcionando
  try {
    const tip = { ev: 15, pModel: 0.65, odd: 1.85, market: 'total', side: 'over', sport: 'lol' };
    const { ok, reason } = shouldSendMarketTip(tip, { minEv: 8, minPmodel: 0.55, sport: 'lol' });
    assert.strictEqual(ok, true);
    assert.strictEqual(reason, null);
    pass('T6: backward compat — {ok, reason} destructure ainda funciona');
  } catch (e) { fail('T6', e); }

  // T7: odd < minOdd → fail em odd_min
  try {
    const tip = { ev: 12, pModel: 0.65, odd: 1.20, market: 'total', side: 'over', sport: 'lol' };
    const r = shouldSendMarketTip(tip, { minEv: 8, minPmodel: 0.55, sport: 'lol' });
    assert.strictEqual(r.ok, false);
    assert.ok(/odd.*<.*1\.40.*floor/.test(r.reason), `expected odd floor reason, got: ${r.reason}`);
    const lastGate = r.gates_evaluated[r.gates_evaluated.length - 1];
    assert.strictEqual(lastGate.gate, 'odd_min');
    assert.strictEqual(lastGate.passed, false);
    pass('T7: odd<floor — last gate = odd_min:fail');
  } catch (e) { fail('T7', e); }

  // T8: tip null/undefined → safe early-return ev_min
  try {
    const r = shouldSendMarketTip(null, { minEv: 8, minPmodel: 0.55 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.gates_evaluated.length, 1);
    assert.strictEqual(r.gates_evaluated[0].gate, 'ev_min');
    assert.strictEqual(r.gates_evaluated[0].passed, false);
    pass('T8: tip=null — early-return ev_min sem crash');
  } catch (e) { fail('T8', e); }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests();

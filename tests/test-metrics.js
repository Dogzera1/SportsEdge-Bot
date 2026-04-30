/**
 * Tests for lib/metrics — counter/timing/gauge in-memory.
 */

const m = require('../lib/metrics');

module.exports = function runTests(t) {
  t.test('reset zera tudo', () => {
    m.incr('foo');
    m.reset();
    const s = m.snapshot();
    t.assert(Object.keys(s.counters).length === 0, 'counters não zerou');
  });

  t.test('incr soma counter', () => {
    m.reset();
    m.incr('tips_emitted', { sport: 'lol' });
    m.incr('tips_emitted', { sport: 'lol' });
    m.incr('tips_emitted', { sport: 'tennis' });
    const s = m.snapshot();
    t.assert(s.counters['tips_emitted|sport=lol'] === 2, `lol=${s.counters['tips_emitted|sport=lol']}`);
    t.assert(s.counters['tips_emitted|sport=tennis'] === 1);
  });

  t.test('incr com tags ordenados consistentemente', () => {
    m.reset();
    m.incr('rejection', { reason: 'ev_low', sport: 'lol' });
    m.incr('rejection', { sport: 'lol', reason: 'ev_low' });
    const s = m.snapshot();
    const keys = Object.keys(s.counters);
    t.assert(keys.length === 1, `keys=${keys.length} (deve ser 1, ordem dos tags não importa)`);
    const v = Object.values(s.counters)[0];
    t.assert(v === 2, `value=${v}`);
  });

  t.test('timing agrega count/avg/min/max', () => {
    m.reset();
    m.timing('latency', 100);
    m.timing('latency', 200);
    m.timing('latency', 300);
    const s = m.snapshot();
    const lat = s.timings['latency'];
    t.assert(lat.count === 3, `count=${lat.count}`);
    t.assert(lat.avg_ms === 200, `avg=${lat.avg_ms}`);
    t.assert(lat.min_ms === 100, `min=${lat.min_ms}`);
    t.assert(lat.max_ms === 300, `max=${lat.max_ms}`);
  });

  t.test('gauge guarda último valor', () => {
    m.reset();
    m.gauge('size', 100);
    m.gauge('size', 200);
    m.gauge('size', 150);
    const s = m.snapshot();
    t.assert(s.gauges.size.value === 150, `value=${s.gauges.size.value}`);
  });

  t.test('snapshot1h agrega rolling window', () => {
    m.reset();
    m.incr('foo', null, 5);
    m.incr('foo', null, 3);
    const s = m.snapshot1h();
    t.assert(s.counters.foo === 8, `foo=${s.counters.foo}`);
    t.assert(s.window_min === 60, 'janela 60min');
  });

  t.test('incr inválido (sem metric) é no-op', () => {
    m.reset();
    m.incr('');
    m.incr(null);
    const s = m.snapshot();
    t.assert(Object.keys(s.counters).length === 0, 'não deve criar counter');
  });

  t.test('timing com NaN é no-op', () => {
    m.reset();
    m.timing('lat', NaN);
    m.timing('lat', Infinity);
    const s = m.snapshot();
    t.assert(!s.timings.lat, 'não deve criar timing inválido');
  });

  t.test('mergeSnapshot soma counters', () => {
    m.reset();
    m.incr('x', null, 3);
    m.mergeSnapshot({ counters: { 'x': 5 } });
    const s = m.snapshot();
    t.assert(s.counters.x === 8, `x=${s.counters.x}`);
  });

  t.test('mergeSnapshot prefix isola', () => {
    m.reset();
    m.incr('x', null, 3);
    m.mergeSnapshot({ counters: { 'x': 5 } }, { prefix: 'bot:' });
    const s = m.snapshot();
    t.assert(s.counters.x === 3);
    t.assert(s.counters['bot:x'] === 5);
  });

  t.test('mergeSnapshot timings agrega corretamente', () => {
    m.reset();
    m.timing('latency', 100);
    m.timing('latency', 200);
    // Local: count=2, sum=300, avg=150, min=100, max=200
    m.mergeSnapshot({
      timings: { 'latency': { count: 1, avg_ms: 50, min_ms: 50, max_ms: 50 } },
    });
    const s = m.snapshot();
    const lat = s.timings.latency;
    t.assert(lat.count === 3, `count=${lat.count}`);
    t.assert(lat.min_ms === 50, `min=${lat.min_ms}`);
    t.assert(lat.max_ms === 200, `max=${lat.max_ms}`);
    // avg = (300 + 50)/3 ≈ 116.7
    t.assert(Math.abs(lat.avg_ms - 116.7) < 1, `avg=${lat.avg_ms}`);
  });

  t.test('mergeSnapshot gauges last-write-wins', () => {
    m.reset();
    m.gauge('cpu', 50);
    m.mergeSnapshot({ gauges: { 'cpu': { value: 75 } } });
    const s = m.snapshot();
    t.assert(s.gauges.cpu.value === 75);
  });

  t.test('mergeSnapshot input inválido é no-op', () => {
    m.reset();
    m.incr('x', null, 1);
    t.assert(m.mergeSnapshot(null) === false);
    t.assert(m.mergeSnapshot('string') === false);
    const s = m.snapshot();
    t.assert(s.counters.x === 1, 'estado preservado');
  });

  t.test('mergeSnapshot ignora valores inválidos', () => {
    m.reset();
    m.mergeSnapshot({
      counters: { 'a': 5, 'b': NaN, 'c': null, 'd': 'string' },
      gauges: { 'g1': { value: 10 }, 'g2': null },
    });
    const s = m.snapshot();
    t.assert(s.counters.a === 5);
    t.assert(!('b' in s.counters), 'NaN deve ser ignorado');
    t.assert(!('c' in s.counters), 'null deve ser ignorado');
    t.assert(!('d' in s.counters), 'string deve ser ignorada');
    t.assert(s.gauges.g1.value === 10);
    t.assert(!('g2' in s.gauges), 'null gauge ignorado');
  });
};

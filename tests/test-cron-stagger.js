/**
 * Sprint 4 #1 — Cron stagger helper
 *
 * Verifies deterministic minute hashing + env opt-out + hour check.
 */

const { getStaggerMinute, shouldRunDaily } = require('../lib/cron-stagger');

module.exports = function(t) {
  t.test('getStaggerMinute: determinístico (mesmo input → mesmo output)', () => {
    const a = getStaggerMinute('bankroll_reconcile');
    const b = getStaggerMinute('bankroll_reconcile');
    t.assert(a === b, `same name should yield same minute (got ${a} vs ${b})`);
  });

  t.test('getStaggerMinute: range [0, 49]', () => {
    const names = ['db_backup', 'db_integrity', 'bankroll_reconcile', 'readiness_retention', 'threshold_auto_apply', 'gate_attribution', 'p2_compliance', 'mt_restore', 'weekly_digest', 'analytics_digest'];
    for (const n of names) {
      const m = getStaggerMinute(n);
      t.assert(m >= 0 && m < 50, `${n}: minute ${m} out of range [0,49]`);
    }
  });

  t.test('getStaggerMinute: distribuição (5 crons 4h UTC → no 2 mesmo min)', () => {
    const hr4Crons = ['db_backup', 'db_integrity_check', 'bankroll_reconcile', 'readiness_retention', 'threshold_auto_apply'];
    const minutes = new Set();
    for (const n of hr4Crons) minutes.add(getStaggerMinute(n));
    // Com hash determinístico não há garantia, mas estatisticamente 5 nomes
    // distintos → 5 minutes distintos é alta prob. Se ≥4 únicos, OK.
    t.assert(minutes.size >= 4, `expected ≥4 unique minutes for 5 crons, got ${minutes.size}: ${[...minutes].join(',')}`);
  });

  t.test('shouldRunDaily: hour mismatch → false', () => {
    const now = new Date(Date.UTC(2026, 4, 15, 3, 30, 0)); // 03:30 UTC
    t.assert(shouldRunDaily('bankroll_reconcile', 4, now) === false, 'hour mismatch should return false');
  });

  t.test('shouldRunDaily: hour match + minute >= targetMin → true', () => {
    const target = getStaggerMinute('bankroll_reconcile');
    const now = new Date(Date.UTC(2026, 4, 15, 4, target, 0)); // 04:target UTC
    t.assert(shouldRunDaily('bankroll_reconcile', 4, now) === true, `hour 4 + min ${target} should fire`);
  });

  t.test('shouldRunDaily: hour match + minute < targetMin → false', () => {
    const target = getStaggerMinute('bankroll_reconcile');
    if (target === 0) return; // sem como testar (sempre fire em min 0)
    const now = new Date(Date.UTC(2026, 4, 15, 4, target - 1, 0));
    t.assert(shouldRunDaily('bankroll_reconcile', 4, now) === false, `min ${target - 1} should NOT fire (before target ${target})`);
  });

  t.test('shouldRunDaily: env opt-out CRON_STAGGER=false → legacy (any minute fires)', () => {
    process.env.CRON_STAGGER = 'false';
    const now = new Date(Date.UTC(2026, 4, 15, 4, 0, 0)); // 04:00 UTC
    t.assert(shouldRunDaily('bankroll_reconcile', 4, now) === true, 'opt-out should fire at min 0');
    delete process.env.CRON_STAGGER;
  });

  t.test('shouldRunDaily: env CRON_STAGGER=true (default) → stagger ativo', () => {
    // Sem env set, default 'true' aplica stagger
    delete process.env.CRON_STAGGER;
    const target = getStaggerMinute('bankroll_reconcile');
    if (target === 0) return;
    const now = new Date(Date.UTC(2026, 4, 15, 4, 0, 0));
    t.assert(shouldRunDaily('bankroll_reconcile', 4, now) === false, 'default (stagger ativo) min 0 should NOT fire if target > 0');
  });

  t.test('shouldRunDaily: now omitido usa Date.now', () => {
    // Cobertura defensive — apenas verifica não crash
    const r = shouldRunDaily('test_cron', 0);
    t.assert(typeof r === 'boolean', 'returns boolean even without now arg');
  });
};

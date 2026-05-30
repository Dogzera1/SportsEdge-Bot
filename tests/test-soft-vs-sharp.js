'use strict';
// Unit tests for lib/soft-vs-sharp (money-affecting: gates a real tip emit vs a soft book).
// Runner convention: module.exports = function(t) { t.test(name, fn); t.assert(cond,msg) }

const { evaluateSoftVsSharp } = require('../lib/soft-vs-sharp');

const NOW = Date.parse('2026-05-30T12:00:00Z');
const FRESH = new Date(NOW - 5 * 60000).toISOString();   // 5min old → within 15min window
const STALE = new Date(NOW - 30 * 60000).toISOString();  // 30min old → past window
const ENV = { SOFT_VS_SHARP_ENABLED: 'true', SOFT_VS_SHARP_MIN_EV: '3', SOFT_VS_SHARP_MAX_AGE_MIN: '15' };
const evt = (over = {}) => ({ mode: 'pinnacle', superBook: 'betano', superOdd: 2.10, evPct: 6.5, pinImpliedPct: 50.0, side: 't1', matchLabel: 'A vs B', ...over });

module.exports = function (t) {
  t.test('disabled by default (no env) → disabled', () => {
    const r = evaluateSoftVsSharp({ superEvt: evt(), capturedAt: FRESH, env: {}, nowMs: NOW });
    t.assert(r.ok === false && r.reason === 'disabled', JSON.stringify(r));
  });
  t.test('null event → no_event', () => {
    const r = evaluateSoftVsSharp({ superEvt: null, capturedAt: FRESH, env: ENV, nowMs: NOW });
    t.assert(r.ok === false && r.reason === 'no_event', JSON.stringify(r));
  });
  t.test('crossbook mode → no_sharp_anchor (requires Pinnacle anchor)', () => {
    const r = evaluateSoftVsSharp({ superEvt: evt({ mode: 'crossbook' }), capturedAt: FRESH, env: ENV, nowMs: NOW });
    t.assert(r.ok === false && r.reason === 'no_sharp_anchor', JSON.stringify(r));
  });
  t.test('EV below min → ev_below_min', () => {
    const r = evaluateSoftVsSharp({ superEvt: evt({ evPct: 1.0 }), capturedAt: FRESH, env: ENV, nowMs: NOW });
    t.assert(r.ok === false && r.reason === 'ev_below_min', JSON.stringify(r));
  });
  t.test('odd too high → odd_out_of_range', () => {
    const r = evaluateSoftVsSharp({ superEvt: evt({ superOdd: 5.5 }), capturedAt: FRESH, env: ENV, nowMs: NOW });
    t.assert(r.ok === false && r.reason === 'odd_out_of_range', JSON.stringify(r));
  });
  t.test('odd too low → odd_out_of_range', () => {
    const r = evaluateSoftVsSharp({ superEvt: evt({ superOdd: 1.10 }), capturedAt: FRESH, env: ENV, nowMs: NOW });
    t.assert(r.ok === false && r.reason === 'odd_out_of_range', JSON.stringify(r));
  });
  t.test('bad fair prob (pinImpliedPct 0) → bad_fair_prob', () => {
    const r = evaluateSoftVsSharp({ superEvt: evt({ pinImpliedPct: 0 }), capturedAt: FRESH, env: ENV, nowMs: NOW });
    t.assert(r.ok === false && r.reason === 'bad_fair_prob', JSON.stringify(r));
  });
  t.test('stale captured_at → stale', () => {
    const r = evaluateSoftVsSharp({ superEvt: evt(), capturedAt: STALE, env: ENV, nowMs: NOW });
    t.assert(r.ok === false && r.reason === 'stale', JSON.stringify(r));
  });
  t.test('unparseable captured_at → captured_at_unparseable (money safety)', () => {
    const r = evaluateSoftVsSharp({ superEvt: evt(), capturedAt: 'not-a-date', env: ENV, nowMs: NOW });
    t.assert(r.ok === false && r.reason === 'captured_at_unparseable', JSON.stringify(r));
  });
  t.test('absent captured_at (live source) → emit', () => {
    const r = evaluateSoftVsSharp({ superEvt: evt(), capturedAt: null, env: ENV, nowMs: NOW });
    t.assert(r.ok === true && r.reason === 'emit' && Math.abs(r.fairP - 0.5) < 1e-9, JSON.stringify(r));
  });
  t.test('fresh + EV ok → emit with fairP/odd/evPct/book', () => {
    const r = evaluateSoftVsSharp({ superEvt: evt(), capturedAt: FRESH, env: ENV, nowMs: NOW });
    t.assert(r.ok === true && r.reason === 'emit', JSON.stringify(r));
    t.assert(Math.abs(r.fairP - 0.5) < 1e-9 && r.odd === 2.10 && r.evPct === 6.5 && r.book === 'betano', JSON.stringify(r));
  });
};

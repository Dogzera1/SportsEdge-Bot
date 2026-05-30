'use strict';
// Unit tests for lib/edge-shrink (money-affecting: anchors model→fair before EV).
// Runner convention: module.exports = function(t) { t.test(name, fn); t.assert(cond,msg) }

const { applyEdgeShrink, resolveShrink, backtestShrink } = require('../lib/edge-shrink');

module.exports = function (t) {
  // ── applyEdgeShrink ──────────────────────────────────────────────
  t.test('applyEdgeShrink shrink=1 → trust model (no-op)', () => {
    t.assert(applyEdgeShrink(0.70, 0.55, 1) === 0.70);
  });
  t.test('applyEdgeShrink shrink=0 → fully market', () => {
    t.assert(applyEdgeShrink(0.70, 0.55, 0) === 0.55);
  });
  t.test('applyEdgeShrink shrink=0.5 → midpoint', () => {
    t.assert(Math.abs(applyEdgeShrink(0.70, 0.55, 0.5) - 0.625) < 1e-9);
  });
  t.test('applyEdgeShrink pFair null → no-op', () => {
    t.assert(applyEdgeShrink(0.70, null, 0.5) === 0.70);
  });
  t.test('applyEdgeShrink shrink>1 clamps to no-op', () => {
    t.assert(applyEdgeShrink(0.70, 0.55, 1.5) === 0.70);
  });
  t.test('applyEdgeShrink shrink<0 clamps to fair', () => {
    t.assert(applyEdgeShrink(0.70, 0.55, -0.3) === 0.55);
  });
  t.test('applyEdgeShrink bad pModel → returned as-is', () => {
    t.assert(applyEdgeShrink(undefined, 0.55, 0.5) === undefined);
  });

  // ── resolveShrink ────────────────────────────────────────────────
  t.test('resolveShrink default 1.0 (no env)', () => {
    t.assert(resolveShrink('handicapGames', {}) === 1.0);
  });
  t.test('resolveShrink blanket TENNIS_MT_EDGE_SHRINK', () => {
    t.assert(resolveShrink('handicapGames', { TENNIS_MT_EDGE_SHRINK: '0.6' }) === 0.6);
  });
  t.test('resolveShrink per-market (HG) beats blanket', () => {
    t.assert(resolveShrink('handicapGames', { TENNIS_MT_EDGE_SHRINK: '0.6', TENNIS_HG_EDGE_SHRINK: '0.4' }) === 0.4);
  });
  t.test('resolveShrink out-of-range ignored → default', () => {
    t.assert(resolveShrink('handicapGames', { TENNIS_HG_EDGE_SHRINK: '9' }) === 1.0);
  });
  t.test('resolveShrink totalGames maps to TG tag', () => {
    t.assert(resolveShrink('totalGames', { TENNIS_TG_EDGE_SHRINK: '0.7' }) === 0.7);
  });

  // ── backtestShrink (re-gate mechanics + ROI math) ────────────────
  t.test('backtestShrink ROI math: single winner odd 2.0 → +100', () => {
    const r = backtestShrink([{ p_model: 0.6, p_implied: 0.5, odd: 2.0, result: 'win' }], { grid: [1], minEv: 8 });
    t.assert(r[0].n === 1 && r[0].roi === 100, JSON.stringify(r[0]));
  });
  t.test('backtestShrink re-gates overconfident loser out at low shrink', () => {
    // p_model 0.80 vs fair 0.50: shrink=1 → EV 60% (in); shrink=0.1 → p_used 0.53, EV 6% (filtered)
    const tips = [{ p_model: 0.80, p_implied: 0.50, odd: 2.0, result: 'loss' }];
    const r = backtestShrink(tips, { grid: [1, 0.1], minEv: 8 });
    const at1 = r.find(x => x.shrink === 1);
    const at01 = r.find(x => x.shrink === 0.1);
    t.assert(at1.n === 1 && at1.roi === -100, `at1 ${JSON.stringify(at1)}`);
    t.assert(at01.n === 0 && at01.roi === null, `at01 ${JSON.stringify(at01)}`);
  });
  t.test('backtestShrink excludes void from settled n', () => {
    const r = backtestShrink([
      { p_model: 0.6, p_implied: 0.5, odd: 2.0, result: 'void' },
      { p_model: 0.6, p_implied: 0.5, odd: 2.0, result: 'win' },
    ], { grid: [1], minEv: 8 });
    t.assert(r[0].n === 1 && r[0].roi === 100, JSON.stringify(r[0]));
  });
  t.test('backtestShrink mean CLV averaged over captured only', () => {
    const r = backtestShrink([
      { p_model: 0.6, p_implied: 0.5, odd: 2.0, result: 'win', clv_pct: 4 },
      { p_model: 0.6, p_implied: 0.5, odd: 2.0, result: 'loss', clv_pct: 2 },
    ], { grid: [1], minEv: 8 });
    t.assert(r[0].meanClv === 3, JSON.stringify(r[0]));
  });
};

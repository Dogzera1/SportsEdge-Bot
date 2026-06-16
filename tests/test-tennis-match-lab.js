'use strict';
const { _serveStatsFromProfile, _pOverFromPdf } = require('../lib/tennis-match-lab');

module.exports = function (t) {
  t.test('_serveStatsFromProfile converts 0-1 fractions to 0-100 percent + games', () => {
    const out = _serveStatsFromProfile({ firstInPct: 0.62, firstWonPct: 0.74, secondWonPct: 0.52, matches: 9 });
    t.assert(Math.abs(out.firstServePct - 62) < 1e-9, `firstServePct ${out.firstServePct}`);
    t.assert(Math.abs(out.firstServePointsPct - 74) < 1e-9, `firstServePointsPct ${out.firstServePointsPct}`);
    t.assert(Math.abs(out.secondServePointsPct - 52) < 1e-9, `secondServePointsPct ${out.secondServePointsPct}`);
    t.assert(out.games === 9, `games ${out.games}`);
  });

  t.test('_serveStatsFromProfile returns null when fields missing', () => {
    t.assert(_serveStatsFromProfile(null) === null, 'null prof');
    t.assert(_serveStatsFromProfile({ firstInPct: 0.6 }) === null, 'partial prof');
  });

  t.test('_pOverFromPdf sums probability mass strictly above the line', () => {
    const pdf = { '20': 0.1, '21': 0.2, '22': 0.3, '23': 0.4 };
    t.assert(Math.abs(_pOverFromPdf(pdf, 21.5) - 0.7) < 1e-9, `over21.5 ${_pOverFromPdf(pdf, 21.5)}`);
    t.assert(Math.abs(_pOverFromPdf(pdf, 22.5) - 0.4) < 1e-9, `over22.5 ${_pOverFromPdf(pdf, 22.5)}`);
    t.assert(_pOverFromPdf({}, 21.5) === 0, 'empty pdf');
  });
};

'use strict';
const { _serveStatsFromProfile, _pOverFromPdf } = require('../lib/tennis-match-lab');

module.exports = function (t) {
  t.test('_serveStatsFromProfile converts 0-1 fractions to 0-100 percent + games', () => {
    const out = _serveStatsFromProfile({ firstInPct: 0.62, firstWonPct: 0.74, secondWonPct: 0.52, matches: 9 });
    t.assert(Math.abs(out.firstServePct - 62) < 1e-9, `firstServePct ${out.firstServePct}`);
    t.assert(Math.abs(out.firstServePointsPct - 74) < 1e-9, `firstServePointsPct ${out.firstServePointsPct}`);
    t.assert(Math.abs(out.secondServePointsPct - 52) < 1e-9, `secondServePointsPct ${out.secondServePointsPct}`);
    t.assert(out.games === 9, `games ${out.games}`);
    t.assert(Math.abs(out.spw - (0.62 * 0.74 + 0.38 * 0.52)) < 1e-9, `spw ${out.spw}`);
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
    t.assert(_pOverFromPdf(null, 21.5) === 0, 'null pdf');
  });

  const { analyzeTennisMatch } = require('../lib/tennis-match-lab');

  t.test('analyzeTennisMatch: no players -> lean fraco, empty markets, no db needed', () => {
    const out = analyzeTennisMatch(null, { player1: '', player2: '' });
    t.assert(out.ok === true, 'ok');
    t.assert(out.headline.label === 'lean fraco', `label ${out.headline.label}`);
    t.assert(out.headline.probP1 === 0.5, `probP1 ${out.headline.probP1}`);
    t.assert(Object.keys(out.markets).length === 0, 'markets empty');
  });

  {
    const fs = require('fs'); const path = require('path');
    const DB_PATH = path.join(__dirname, '..', 'sportsedge.db');
    if (!fs.existsSync(DB_PATH)) {
      t.test('analyzeTennisMatch real-DB (skipped: no sportsedge.db)', () => {});
    } else {
      const Database = require('better-sqlite3');
      const db = new Database(DB_PATH, { readonly: true });
      const row = db.prepare(`SELECT team1, team2 FROM match_results WHERE game='tennis' AND team1 IS NOT NULL AND team2 IS NOT NULL ORDER BY resolved_at DESC LIMIT 1`).get();
      t.test('analyzeTennisMatch real-DB: structural invariants + fairOdd=1/p', () => {
        const out = analyzeTennisMatch(db, { player1: row ? row.team1 : 'Novak Djokovic', player2: row ? row.team2 : 'Carlos Alcaraz', surface: 'hard', bestOf: 3, league: 'ATP Test' });
        t.assert(out.ok === true, 'ok');
        const h = out.headline;
        t.assert(h.probP1 >= 0 && h.probP1 <= 1, `probP1 range ${h.probP1}`);
        t.assert(Math.abs(h.probP1 + h.probP2 - 1) < 0.02, `probs sum ${h.probP1 + h.probP2}`);
        t.assert(['forte', 'lean', 'lean fraco'].includes(h.label), `label ${h.label}`);
        t.assert(typeof h.divergenceFlag === 'boolean', 'divergenceFlag bool');
        const ml = out.markets.ml;
        t.assert(Math.abs(ml.fairOddP1 - +(1 / ml.probP1).toFixed(2)) < 0.01, `fairOddP1 ${ml.fairOddP1}`);
        t.assert(Array.isArray(out.markets.handicapGames) && out.markets.handicapGames.length > 0, 'handicapGames');
        t.assert(Array.isArray(out.markets.totalGames) && out.markets.totalGames.length > 0, 'totalGames');
        out.markets.handicapGames.forEach(r => t.assert(r.prob >= 0 && r.prob <= 1 && Math.abs(r.fairOdd - +(1 / r.prob).toFixed(2)) < 0.01, `hg ${r.line}`));
        t.assert(['profiles', 'solved'].includes(out.serve.source), `serve source ${out.serve.source}`);
      });
      t.test('analyzeTennisMatch real-DB: edge computed when bookOdds given', () => {
        const out = analyzeTennisMatch(db, { player1: row ? row.team1 : 'A', player2: row ? row.team2 : 'B', surface: 'hard', bestOf: 3, league: 'ATP Test', bookOdds: { mlP1: 2.5 } });
        const ml = out.markets.ml;
        t.assert(Math.abs(ml.edgeP1 - +((ml.probP1 * 2.5) - 1).toFixed(3)) < 1e-9, `edgeP1 ${ml.edgeP1}`);
        t.assert(ml.edgeP2 === null, 'edgeP2 null (no mlP2 odd)');
      });
    }
  }
};

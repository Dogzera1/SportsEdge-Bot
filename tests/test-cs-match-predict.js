'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

module.exports = function (t) {
  const { predictMatch } = require('../lib/cs-match-predict');
  const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });

  t.test('cs-predict: 2 times reais → prob em (0,1), elo presente, label válido', () => {
    const top = db.prepare(`SELECT team1 t, COUNT(*) n FROM match_results WHERE game='cs2' AND team1!='' GROUP BY team1 ORDER BY n DESC LIMIT 2`).all();
    t.assert(top.length === 2, 'precisa de 2 times no cs2');
    const out = predictMatch(db, { team1: top[0].t, team2: top[1].t });
    t.assert(out.prob > 0 && out.prob < 1, `prob fora de (0,1): ${out.prob}`);
    t.assert(out.components.elo && typeof out.components.elo.ratingTeam1 === 'number', 'elo ausente');
    t.assert(['forte', 'lean', 'lean fraco'].includes(out.label), `label inválido: ${out.label}`);
    t.assert(Math.abs(out.prob - out.probTeam1) < 1e-9, 'prob != probTeam1');
  });

  t.test('cs-predict: times inexistentes → prob 0.5, elo null, lean fraco', () => {
    const out = predictMatch(db, { team1: 'ZZZ_fake_aaa', team2: 'ZZZ_fake_bbb' });
    t.assert(out.prob === 0.5, `esperava 0.5, veio ${out.prob}`);
    t.assert(out.components.elo === null, 'elo deveria ser null');
    t.assert(out.label === 'lean fraco', `label: ${out.label}`);
  });

  t.test('cs-predict: airtight money-path (source sem refs proibidas)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cs-match-predict.js'), 'utf8');
    for (const bad of ['cs-ml', 'getCsElo', 'stake', 'kelly', 'bankroll', 'getLolProbability']) {
      t.assert(!src.includes(bad), `referência proibida no predict: ${bad}`);
    }
  });

  db.close();
};

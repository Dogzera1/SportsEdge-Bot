'use strict';
const assert = require('assert');
const { buildExplainPrompt, parseExplainResponse } = require('../lib/lol-match-explain');

const GP = {
  phases: {
    early: { winner: 'red', bars: 2, measured: true, anchor: { golddiff15: -120, xpdiff15: -50, csdiff15: -4 }, confidence: 0.8 },
    mid:   { winner: 'even', bars: 0, measured: false, label: 'transição', confidence: 0.4 },
    late:  { winner: 'blue', bars: 3, measured: false, label: 'estimativa', confidence: 0.45 },
  },
  expectedTime: { seconds: 1980, bucket: 'médio' },
  winCondition: 'Azul quer arrastar; vermelho quer fechar cedo.',
  compStyle: { blue: { style: 'teamfight', confidence: 0.6 }, red: { style: 'pick', confidence: 0.5 } },
  fairOdds: { team1: 1.36, team2: 3.77 },
  edge: 0.138,
};
const DRAFT = { blue: [{ champion: 'Aatrox', role: 'top' }], red: [{ champion: 'Gnar', role: 'top' }] };
const TEAMS = { blue: 'T1', red: 'Gen.G' };

module.exports = function(t) {
  t.test('buildExplainPrompt includes anchored data + JSON+no-stake instruction', () => {
    const p = buildExplainPrompt({ gameProfile: GP, draft: DRAFT, teams: TEAMS, probPct: 73, label: 'forte' });
    assert.ok(/P\(Azul vence\) ~ 73% \(forte\)/.test(p), 'prob line');
    assert.ok(/Odd justa: Azul 1\.36 \/ Vermelho 3\.77/.test(p), 'fair odds line');
    assert.ok(/edge vs odd da casa: 13\.8%/.test(p), 'edge line when present');
    assert.ok(/EARLY \(medido\): Vermelho/.test(p) && /-120g, -50xp, -4cs/.test(p), 'early anchor');
    assert.ok(/APENAS um JSON/.test(p), 'json-only instruction');
    assert.ok(/NÃO recomende stake/.test(p), 'no-stake instruction');
    assert.ok(/USE O SEU CONHECIMENTO/.test(p), 'hybrid: own knowledge for late/draft');
  });
  t.test('buildExplainPrompt omits edge line when edge is null', () => {
    const gp2 = Object.assign({}, GP, { edge: null });
    const p = buildExplainPrompt({ gameProfile: gp2, draft: DRAFT, teams: TEAMS, probPct: 73, label: 'forte' });
    assert.ok(!/edge vs odd da casa/.test(p), 'no edge line');
    assert.ok(/Odd justa: Azul 1\.36/.test(p), 'still shows fair odds');
  });
  t.test('parseExplainResponse extracts JSON with prose around it', () => {
    const txt = 'Claro! {"early":"a","mid":"b","late":"c","winCondition":"d","keyMatchup":"e","verdict":"f"} pronto';
    const o = parseExplainResponse(txt);
    assert.strictEqual(o.early, 'a'); assert.strictEqual(o.verdict, 'f');
  });
  t.test('parseExplainResponse returns null for non-JSON', () => {
    assert.strictEqual(parseExplainResponse('sem json aqui'), null);
  });
  t.test('parseExplainResponse fills missing keys with empty string', () => {
    const o = parseExplainResponse('{"early":"x"}');
    assert.strictEqual(o.early, 'x'); assert.strictEqual(o.mid, ''); assert.strictEqual(o.verdict, '');
  });
};

'use strict';
const assert = require('assert');
const { buildDotaExplainPrompt, parseDotaExplain } = require('../lib/dota-match-explain');

const PRED = { prob: 0.59, probBlue: 0.59, components: { elo: { pBlue: 0.59, confidence: 1, ratingBlue: 1535, ratingRed: 1470 }, draft: { blueWR: 0.53, redWR: 0.51, factor: 1.3 } }, label: 'lean' };
const DRAFT = { blue: ['Invoker','Juggernaut','Crystal Maiden','Axe','Lion'], red: ['Pudge','Anti-Mage','Lina','Tidehunter','Witch Doctor'] };

module.exports = function(t) {
  t.test('prompt has Elo, ratings, draft, heroes + own-knowledge + no-stake', () => {
    const p = buildDotaExplainPrompt({ pred: PRED, draft: DRAFT, teams: { blue: 'Team A', red: 'Team B' }, fairOdds: { team1: 1.69, team2: 2.44 }, edge: null });
    assert.ok(/Elo/.test(p) && /1535/.test(p), 'elo + ratings');
    assert.ok(/Invoker/.test(p) && /Anti-Mage/.test(p), 'heroes');
    assert.ok(/conhecimento/i.test(p), 'authorizes own knowledge');
    assert.ok(/APENAS um JSON/.test(p) && /NÃO recomende stake/.test(p), 'json + no-stake');
  });
  t.test('parse 4 keys with prose around', () => {
    const o = parseDotaExplain('ok {"overview":"a","draftRead":"b","keyHeroes":"c","verdict":"d"} fim');
    assert.strictEqual(o.overview, 'a'); assert.strictEqual(o.verdict, 'd');
  });
  t.test('parse null for non-json; fills missing keys', () => {
    assert.strictEqual(parseDotaExplain('nada'), null);
    const o = parseDotaExplain('{"overview":"x"}'); assert.strictEqual(o.overview, 'x'); assert.strictEqual(o.verdict, '');
  });
};

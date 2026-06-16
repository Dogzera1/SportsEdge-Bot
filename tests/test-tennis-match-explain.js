'use strict';
const { buildTennisExplainPrompt, parseTennisExplain } = require('../lib/tennis-match-explain');

const FAKE_PRED = {
  headline: { probP1: 0.58, probP2: 0.42, label: 'lean', confidence: 0.6, tier: 'masters', markovProbP1: 0.55, divergenceFlag: false },
  factors: [{ name: 'Surface Elo', p1: 60, p2: 40, weight: 0.5, detail: 'Sinner 2100 vs Alcaraz 2080' }],
  markets: {
    ml: { fairOddP1: 1.72, fairOddP2: 2.38 },
    totalGames: [{ line: 21.5, pOver: 0.52, pUnder: 0.48, fairOddOver: 1.92, fairOddUnder: 2.08 }],
    handicapGames: [{ line: -3.5, prob: 0.46, fairOdd: 2.17 }],
    tiebreak: { pMatchHasTiebreak: 0.61 },
  },
};

module.exports = function (t) {
  t.test('buildTennisExplainPrompt embeds data + honesty contract', () => {
    const s = buildTennisExplainPrompt({ pred: FAKE_PRED, players: { player1: 'Sinner', player2: 'Alcaraz' }, surface: 'clay', bestOf: 3 });
    t.assert(s.includes('Sinner') && s.includes('Alcaraz'), 'players');
    t.assert(/58\.0%|58%/.test(s), 'probP1');
    t.assert(s.includes('NÃO as altere'), 'honesty: do not alter');
    t.assert(s.includes('APENAS um JSON'), 'json-only instruction');
    t.assert(/não recomende stake/i.test(s), 'no stake');
    t.assert(s.includes('Surface Elo'), 'factor included');
  });

  t.test('parseTennisExplain extracts the 4 keys', () => {
    const out = parseTennisExplain('lixo antes {"overview":"a","matchupRead":"b","marketsRead":"c","verdict":"d"} lixo depois');
    t.assert(out && out.overview === 'a' && out.matchupRead === 'b' && out.marketsRead === 'c' && out.verdict === 'd', JSON.stringify(out));
  });

  t.test('parseTennisExplain fills missing keys with empty string', () => {
    const out = parseTennisExplain('{"overview":"só isso"}');
    t.assert(out && out.overview === 'só isso' && out.verdict === '', JSON.stringify(out));
  });

  t.test('parseTennisExplain returns null on garbage', () => {
    t.assert(parseTennisExplain('sem json aqui') === null, 'no json');
    t.assert(parseTennisExplain('{"x":1}') === null, 'no known keys');
  });
};

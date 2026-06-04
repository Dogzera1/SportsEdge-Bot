// tests/test-dota-draft-explain.js — Dota draft AI prompt (anchored on objective numbers) + parser.
const { buildDotaDraftPrompt, parseDotaDraftExplain } = require('../lib/dota-draft-explain');

module.exports = function (t) {
  const data = {
    teams: { blue: 'Team A', red: 'Team B' },
    draft: { blue: ['Anti-Mage'], red: ['Crystal Maiden'] },
    matchupEdge: { blueAdvantagePp: 10, sampled: 1, pairs: [{ blueName: 'Anti-Mage', redName: 'Crystal Maiden', advPp: 10, games: 100 }] },
    playerHeroes: { blue: [{ resolved: true, player: 'Nisha', hero: 'Anti-Mage', onHero: { wr: 0.65, games: 80 } }], red: [] },
    composition: { blue: { roleCounts: { Carry: 1 }, attrCounts: { agi: 1 } }, red: { roleCounts: { Support: 1 }, attrCounts: { int: 1 } } },
  };

  const p = buildDotaDraftPrompt(data);
  t.test('prompt is a non-empty string', () => t.assert(typeof p === 'string' && p.length > 200));
  t.test('prompt includes the objective numbers', () => t.assert(p.includes('Anti-Mage') && p.includes('Nisha') && p.includes('matchup')));
  t.test('prompt asks for the 4-key JSON', () => t.assert(p.includes('overview') && p.includes('matchups') && p.includes('keyPlayers') && p.includes('verdict')));
  t.test('prompt forbids inventing probability/stake', () => t.assert(/probabilidade|aposte|stake/i.test(p)));

  t.test('parse extracts 4 keys', () => {
    const r = parseDotaDraftExplain('lixo {"overview":"o","matchups":"m","keyPlayers":"k","verdict":"v"} fim');
    t.assert(r && r.overview === 'o' && r.matchups === 'm' && r.keyPlayers === 'k' && r.verdict === 'v');
  });
  t.test('parse returns null on no json', () => t.assert(parseDotaDraftExplain('sem json') === null));
  t.test('parse returns null when no known key', () => t.assert(parseDotaDraftExplain('{"foo":"bar"}') === null));
};

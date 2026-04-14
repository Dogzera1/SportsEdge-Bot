/**
 * Testes do matching de nomes (settlement).
 * Roda via: node tests/run.js
 */

const { nameMatches } = require('../lib/name-match');

const LOL_ALIASES_SAMPLE = {
  fnatic:     ['fnc'],
  t1:         ['skt', 'skt1'],
  cloud9:     ['c9'],
  invictusgaming: ['ig'],
  geng:       ['gen', 'gengolden'],
};

module.exports = function runTests(t) {
  t.test('exact match case-insensitive', () => {
    const r = nameMatches('Fnatic', 'fnatic');
    t.assert(r.match && r.method === 'exact', `got ${JSON.stringify(r)}`);
  });

  t.test('alias: FNC ↔ Fnatic', () => {
    const r = nameMatches('FNC', 'Fnatic', { aliases: LOL_ALIASES_SAMPLE });
    t.assert(r.match && r.method === 'alias', `got ${JSON.stringify(r)}`);
  });

  t.test('alias: SKT ↔ T1', () => {
    const r = nameMatches('SKT', 'T1', { aliases: LOL_ALIASES_SAMPLE });
    t.assert(r.match && r.method === 'alias', `got ${JSON.stringify(r)}`);
  });

  t.test('NÃO casar "IG" com "BIG" (short-alias trap)', () => {
    const r = nameMatches('IG', 'BIG', { aliases: LOL_ALIASES_SAMPLE });
    t.assert(!r.match, `falso positivo: ${JSON.stringify(r)}`);
  });

  t.test('NÃO casar "T1" com "T10" (short-substring trap)', () => {
    const r = nameMatches('T1', 'T10');
    t.assert(!r.match, `falso positivo: ${JSON.stringify(r)}`);
  });

  t.test('substring legítimo com tamanho suficiente', () => {
    const r = nameMatches('Team Liquid', 'Liquid');
    t.assert(r.match && r.method === 'substring', `got ${JSON.stringify(r)}`);
  });

  t.test('retorna none para strings vazias', () => {
    const r = nameMatches('', 'Fnatic');
    t.assert(!r.match && r.method === 'none', `got ${JSON.stringify(r)}`);
  });
};

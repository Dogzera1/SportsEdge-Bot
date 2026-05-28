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
    t.assert(r.score >= 0.5, `score ${r.score} deveria ser ≥ 0.5`);
  });

  t.test('substring_weak: "Real" em "UnrealTournament" rejeitado por score baixo', () => {
    const r = nameMatches('Real', 'UnrealTournament');
    t.assert(!r.match, `deveria rejeitar: ${JSON.stringify(r)}`);
    t.assert(r.method === 'substring_weak', `esperado substring_weak, got ${r.method}`);
    t.assert(r.score < 0.5, `score ${r.score} deveria ser < 0.5`);
  });

  t.test('substring_weak: "Bayern" em "BayernLeverkusen" rejeitado (entidades diferentes)', () => {
    const r = nameMatches('Bayern', 'BayernLeverkusen');
    t.assert(!r.match, `deveria rejeitar: ${JSON.stringify(r)}`);
    t.assert(r.method === 'substring_weak', `got ${r.method}`);
  });

  t.test('threshold configurável via minSubstrScore', () => {
    // Com threshold 0.3, "Real" em "UnrealTournament" passa
    const r = nameMatches('Real', 'UnrealTournament', { minSubstrScore: 0.2 });
    t.assert(r.match && r.method === 'substring', `got ${JSON.stringify(r)}`);
  });

  t.test('retorna none para strings vazias', () => {
    const r = nameMatches('', 'Fnatic');
    t.assert(!r.match && r.method === 'none', `got ${JSON.stringify(r)}`);
  });

  // 2026-05-28: P0 LoL #4607 regression — Academy/Reserves/Youth são ROSTERS
  // diferentes, não suffixes. Pré-fix: token_prefix bate via ORG_SUFFIX_TOKENS.
  // Pós-fix: token_prefix falha + substring rejeita (len<minSubstrLen=4).
  t.test('NÃO casar "T1" com "T1 Academy" (rosters diferentes — P0 #4607)', () => {
    const r = nameMatches('T1', 'T1 Academy', { aliases: LOL_ALIASES_SAMPLE });
    t.assert(!r.match, `falso positivo: ${JSON.stringify(r)} — academy é roster diferente`);
  });

  t.test('NÃO casar "FaZe" com "FaZe Academy" (CS academy roster)', () => {
    const r = nameMatches('FaZe', 'FaZe Academy');
    t.assert(!r.match, `falso positivo: ${JSON.stringify(r)}`);
  });

  t.test('NÃO casar "NAVI" com "NAVI Junior" (developmental squad — minSubstrScore reject)', () => {
    // Nota: 'junior' NÃO está em ORG_SUFFIX_TOKENS, então token_prefix falha por
    // remainder não-vazio. Substring 'navi' (4) ⊂ 'navijunior' (10), score=0.4 < 0.5 → reject.
    const r = nameMatches('NAVI', 'NAVI Junior');
    t.assert(!r.match, `falso positivo: ${JSON.stringify(r)}`);
  });

  // Token_prefix legítimo ainda funciona pra suffixes reais
  t.test('AINDA casar "UCAM" com "UCAM Esports Club" (suffix legitimo)', () => {
    const r = nameMatches('UCAM', 'UCAM Esports Club');
    t.assert(r.match && r.method === 'token_prefix', `regression: ${JSON.stringify(r)}`);
  });

  t.test('AINDA casar "Misa" com "Misa Esports" (suffix legitimo)', () => {
    const r = nameMatches('Misa', 'Misa Esports');
    t.assert(r.match && r.method === 'token_prefix', `regression: ${JSON.stringify(r)}`);
  });
};

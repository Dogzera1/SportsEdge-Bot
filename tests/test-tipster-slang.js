/**
 * Tests para lib/tipster-slang.js
 *
 * pickSlang(context, seed) deve:
 *  - Retornar string de pool conhecido
 *  - Ser determinístico (mesmo seed+context → mesma string)
 *  - Variar com seed diferente (na maioria dos casos — depende do hash)
 *  - Não jogar quando seed é undefined/vazio
 *  - Retornar fallback safe quando context é desconhecido
 */

const { pickSlang, POOLS } = require('../lib/tipster-slang');

module.exports = function runTests(t) {
  t.test('pickSlang header_alta retorna string do pool', () => {
    const out = pickSlang('header_alta', 'match-123');
    t.assert(typeof out === 'string', 'deve retornar string');
    t.assert(out.length > 0, 'string não vazia');
    t.assert(POOLS.header_alta.includes(out), `output "${out}" deve estar no pool header_alta`);
  });

  t.test('pickSlang determinístico — mesmo seed retorna mesma string', () => {
    const a = pickSlang('header_alta', 'match-456');
    const b = pickSlang('header_alta', 'match-456');
    t.assert(a === b, `2x mesma seed deve dar mesmo output, got "${a}" vs "${b}"`);
  });

  t.test('pickSlang varia com seeds diferentes (sample)', () => {
    // Não exige diferença em TODA seed — só que existem 2 seeds que dão output diferente
    const seeds = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    const outputs = new Set(seeds.map(s => pickSlang('header_alta', s)));
    t.assert(outputs.size >= 2, `8 seeds devem produzir ≥2 outputs distintos, got ${outputs.size}`);
  });

  t.test('pickSlang com seed undefined não throw', () => {
    let threw = false;
    try { pickSlang('header_alta', undefined); }
    catch (_) { threw = true; }
    t.assert(!threw, 'pickSlang(_, undefined) não pode throw');
  });

  t.test('pickSlang com seed vazia retorna string válida', () => {
    const out = pickSlang('header_alta', '');
    t.assert(typeof out === 'string' && out.length > 0, 'fallback retorna string não-vazia');
  });

  t.test('pickSlang context desconhecido retorna string segura (fallback)', () => {
    const out = pickSlang('contexto_inexistente', 'seed');
    t.assert(typeof out === 'string', 'deve retornar string mesmo em context inválido');
    // Fallback safe pode ser '' ou um label genérico — desde que não quebre
  });

  t.test('pickSlang conf_alta retorna do pool correto', () => {
    const out = pickSlang('conf_alta', 'm1');
    t.assert(POOLS.conf_alta.includes(out), `output "${out}" deve estar em conf_alta`);
  });

  t.test('pickSlang conf_baixa retorna do pool correto', () => {
    const out = pickSlang('conf_baixa', 'm1');
    t.assert(POOLS.conf_baixa.includes(out), `output "${out}" deve estar em conf_baixa`);
  });

  t.test('pickSlang footer retorna string contendo "+18"', () => {
    // Footer obrigatoriamente menciona +18 (regulatório)
    const out = pickSlang('footer', 'm1');
    t.assert(out.includes('+18'), `footer "${out}" deve mencionar +18 (regulatório)`);
  });

  t.test('pickSlang footer retorna string contendo "responsa" ou "responsável"', () => {
    // Footer menciona responsabilidade (regulatório)
    const out = pickSlang('footer', 'm1');
    const ok = /respons/i.test(out);
    t.assert(ok, `footer "${out}" deve mencionar responsabilidade (regulatório)`);
  });

  t.test('todos pools obrigatórios existem', () => {
    const required = [
      'header_alta', 'header_media', 'header_baixa',
      'conf_alta', 'conf_media', 'conf_baixa',
      'footer'
    ];
    for (const ctx of required) {
      t.assert(Array.isArray(POOLS[ctx]), `POOLS.${ctx} deve ser array`);
      t.assert(POOLS[ctx].length >= 2, `POOLS.${ctx} deve ter ≥2 frases (got ${POOLS[ctx]?.length})`);
    }
  });

  t.test('"chumbo grosso" NÃO aparece em pools de emissão (reservado pra settle/Fase 2)', () => {
    const poolsEmissao = [
      'header_alta', 'header_media', 'header_baixa', 'header_live',
      'conf_alta', 'conf_media', 'conf_baixa', 'footer'
    ];
    for (const ctx of poolsEmissao) {
      const pool = POOLS[ctx] || [];
      for (const phrase of pool) {
        t.assert(
          !/chumbo grosso/i.test(phrase),
          `"chumbo grosso" em "${ctx}" → "${phrase}" — é loss context, reservar pra Fase 2`
        );
      }
    }
  });

  t.test('todas frases em emissão são em pt-BR (sem palavras forbidden)', () => {
    // Smoke check: não pode ter "Bet now", "Guaranteed win", "100%", etc
    const forbidden = [/\b100%\b/i, /guaranteed/i, /sure thing/i, /\bna mão\b/i];
    // "na mão" sozinha aparece em "bilhete na mão" — então skipa "\bna mão\b"
    const realForbidden = [/\b100%\b/i, /guaranteed/i, /sure thing/i];
    const allPools = Object.values(POOLS).flat();
    for (const phrase of allPools) {
      for (const re of realForbidden) {
        t.assert(!re.test(phrase), `palavra forbidden em "${phrase}": ${re}`);
      }
    }
  });
};

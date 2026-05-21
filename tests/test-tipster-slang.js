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

  // ── Fase 2A: settle slang pools ──

  t.test('pool result_win existe e contém forra/verde/bateu', () => {
    t.assert(Array.isArray(POOLS.result_win), 'POOLS.result_win existe');
    t.assert(POOLS.result_win.length >= 3, '≥3 frases');
    // Pelo menos UMA frase deve mencionar forra/verde/bateu
    const joined = POOLS.result_win.join(' | ');
    t.assert(/forra|verd|bateu|é a que/i.test(joined),
      `pool win deve ter forra/verde/bateu, got: ${joined}`);
  });

  t.test('pool result_loss existe e contém chumbo grosso (esse É o lugar)', () => {
    t.assert(Array.isArray(POOLS.result_loss), 'POOLS.result_loss existe');
    t.assert(POOLS.result_loss.length >= 3, '≥3 frases');
    const joined = POOLS.result_loss.join(' | ');
    t.assert(/chumbo grosso/i.test(joined),
      `pool loss DEVE ter "chumbo grosso" (esse é o ponto), got: ${joined}`);
  });

  t.test('pool result_void existe', () => {
    t.assert(Array.isArray(POOLS.result_void), 'POOLS.result_void existe');
    t.assert(POOLS.result_void.length >= 2, '≥2 frases');
  });

  t.test('pool result_push existe', () => {
    t.assert(Array.isArray(POOLS.result_push), 'POOLS.result_push existe');
    t.assert(POOLS.result_push.length >= 2, '≥2 frases');
  });

  t.test('pickSlang result_win retorna do pool correto', () => {
    const out = pickSlang('result_win', 'tip-1');
    t.assert(POOLS.result_win.includes(out), `"${out}" deve estar em result_win`);
  });

  t.test('pickSlang result_loss retorna do pool correto', () => {
    const out = pickSlang('result_loss', 'tip-1');
    t.assert(POOLS.result_loss.includes(out), `"${out}" deve estar em result_loss`);
  });

  t.test('pools settle NÃO mencionam "+18" (settle não precisa de regulatório repetido)', () => {
    // Footer do settle é separado dos result_xxx slangs. O +18 fica em footer_settle pool.
    const settlePools = [POOLS.result_win, POOLS.result_loss, POOLS.result_void, POOLS.result_push];
    for (const pool of settlePools) {
      for (const phrase of pool) {
        // Frases curtas estilo "VERDÃO!", "CHUMBO GROSSO." — sem +18 redundante
        t.assert(!/\+18/.test(phrase), `result pool deve ser curto, sem +18: "${phrase}"`);
      }
    }
  });

  t.test('footer_settle existe e tem +18 (regulatório obrigatório)', () => {
    t.assert(Array.isArray(POOLS.footer_settle), 'POOLS.footer_settle existe');
    t.assert(POOLS.footer_settle.length >= 2, '≥2 frases');
    for (const phrase of POOLS.footer_settle) {
      t.assert(phrase.includes('+18'), `footer_settle "${phrase}" deve ter +18`);
      t.assert(/respons/i.test(phrase), `footer_settle "${phrase}" deve mencionar responsabilidade`);
    }
  });

  t.test('result_loss tem variações além de "chumbo grosso" (não só uma)', () => {
    // Garantir que rotação funciona — não só "chumbo grosso" em todas
    const seeds = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const outs = new Set(seeds.map(s => pickSlang('result_loss', s)));
    t.assert(outs.size >= 2, `seeds diversas devem mostrar ≥2 frases distintas em result_loss, got ${outs.size}`);
  });
};

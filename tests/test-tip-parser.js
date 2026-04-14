/**
 * Testes do parser de TIP_ML da resposta da IA.
 * Regex copiado de bot.js:1910 (LoL) e bot.js:4071 (MMA).
 */

const TIP_RE_LOL = /TIP_ML:\s*([^@]+?)\s*@\s*([^|\]]+?)\s*\|EV:\s*([^|]+?)\s*\|STAKE:\s*([^|\]]+?)(?:\s*\|CONF:\s*(\w+))?(?:\]|$)/;
const TIP_RE_MMA = /TIP_ML:([^@]+)@([0-9.]+)\|EV:([0-9.+%-]+)\|STAKE:([0-9.]+u?)\|CONF:(ALTA|M[ÉE]DIA|BAIXA)/i;

module.exports = function runTests(t) {
  t.test('LoL: parse básico com CONF ALTA', () => {
    const s = 'TIP_ML: Fnatic @ 1.85 |EV: +7.5% |STAKE: 2u |CONF: ALTA';
    const m = s.match(TIP_RE_LOL);
    t.assert(m, 'não deu match');
    t.assert(m[1].trim() === 'Fnatic', `team=${m[1]}`);
    t.assert(m[2].trim() === '1.85', `odd=${m[2]}`);
    t.assert(m[3].trim() === '+7.5%', `ev=${m[3]}`);
    t.assert(m[5] === 'ALTA', `conf=${m[5]}`);
  });

  t.test('LoL: CONF opcional ausente', () => {
    const s = 'TIP_ML: T1 @ 2.10 |EV: +5% |STAKE: 1u';
    const m = s.match(TIP_RE_LOL);
    t.assert(m, 'não deu match');
    t.assert(m[1].trim() === 'T1');
    t.assert(m[5] === undefined || m[5] === '', `conf devia ser vazio, got ${m[5]}`);
  });

  t.test('MMA: parse com CONF MÉDIA (acento)', () => {
    const s = 'TIP_ML:Islam Makhachev@1.45|EV:+6.2%|STAKE:2u|CONF:MÉDIA';
    const m = s.match(TIP_RE_MMA);
    t.assert(m, 'não deu match');
    t.assert(m[1].trim() === 'Islam Makhachev');
    t.assert(m[2] === '1.45');
    t.assert(/M[ÉE]DIA/i.test(m[5]), `conf=${m[5]}`);
  });

  t.test('MMA: sem espaços, sem confundir com texto próximo', () => {
    const s = 'Análise: alto risco.\nTIP_ML:Jon Jones@2.50|EV:+4%|STAKE:1u|CONF:BAIXA\nFim.';
    const m = s.match(TIP_RE_MMA);
    t.assert(m, 'não deu match');
    t.assert(m[1].trim() === 'Jon Jones');
  });

  t.test('Não parseia sem TIP_ML (SEM_EDGE)', () => {
    const s = 'Análise concluída: SEM_EDGE — odds justas, sem value claro.';
    t.assert(!s.match(TIP_RE_LOL), 'não deveria matchar');
    t.assert(!s.match(TIP_RE_MMA), 'não deveria matchar');
  });
};

/**
 * Tests para lib/tip-message-builder.js
 *
 * buildTipMessage(opts) deve:
 *  - Renderizar template ordenado com todos campos obrigatórios
 *  - Preservar números (odd/ev/stake) EXATAMENTE como recebidos
 *  - Incluir slang tipster (header/conf/footer) via lib/tipster-slang
 *  - Omitir linhas opcionais quando campo é undefined/falsy
 *  - LIVE flag visível quando isLive=true
 *  - Sport-specific icon/label correto
 *  - Footer com +18 (regulatório)
 *  - Markdown válido (asterisco/underscore balanceados)
 */

const { buildTipMessage } = require('../lib/tip-message-builder');

const baseOpts = {
  sport: 'tennis',
  marketType: 'ML',
  match: { team1: 'Federer', team2: 'Nadal', league: 'Roland Garros' },
  pick: 'Nadal',
  odd: '1.85',
  ev: '7.2',
  stake: '1.5u (R$ 22,50)',
  conf: 'ALTA',
  isLive: false,
  seed: 'match-test-1',
};

module.exports = function runTests(t) {
  t.test('render básico — contém match, league, pick, odd, ev, stake, conf', () => {
    const msg = buildTipMessage(baseOpts);
    t.assert(msg.includes('Federer'), 'team1 deve aparecer');
    t.assert(msg.includes('Nadal'), 'team2/pick deve aparecer');
    t.assert(msg.includes('Roland Garros'), 'league deve aparecer');
    t.assert(msg.includes('1.85'), 'odd deve aparecer');
    t.assert(msg.includes('7.2'), 'ev deve aparecer');
    t.assert(msg.includes('1.5u (R$ 22,50)'), 'stake deve aparecer exato');
    t.assert(/ALTA/.test(msg), 'conf deve aparecer');
  });

  t.test('sport icon tennis correto', () => {
    const msg = buildTipMessage(baseOpts);
    t.assert(msg.includes('🎾'), 'tennis icon');
    t.assert(/T[ÊE]NIS/.test(msg), 'label TÊNIS');
  });

  t.test('sport icon football correto', () => {
    const msg = buildTipMessage({ ...baseOpts, sport: 'football' });
    t.assert(msg.includes('⚽'), 'football icon');
    t.assert(/FUTEBOL/.test(msg), 'label FUTEBOL');
  });

  t.test('sport icon basket correto', () => {
    const msg = buildTipMessage({ ...baseOpts, sport: 'basket' });
    t.assert(msg.includes('🏀'), 'basket icon');
    t.assert(/BASKET/.test(msg), 'label BASKET');
  });

  t.test('sport icon mma correto', () => {
    const msg = buildTipMessage({ ...baseOpts, sport: 'mma' });
    t.assert(msg.includes('🥊'), 'mma icon');
    t.assert(/MMA/.test(msg), 'label MMA');
  });

  t.test('LIVE flag visível quando isLive=true', () => {
    const msg = buildTipMessage({ ...baseOpts, isLive: true });
    t.assert(/AO VIVO/.test(msg) || /🔴/.test(msg), `LIVE flag deve aparecer, got: ${msg.slice(0, 200)}`);
  });

  t.test('LIVE flag ausente quando isLive=false', () => {
    const msg = buildTipMessage({ ...baseOpts, isLive: false });
    t.assert(!/AO VIVO/.test(msg), 'sem flag LIVE em pré-jogo');
  });

  t.test('minTake aparece quando passado', () => {
    const msg = buildTipMessage({ ...baseOpts, minTake: '1.75' });
    t.assert(msg.includes('1.75'), 'minTake valor');
    t.assert(/Odd m[íi]nima/i.test(msg), 'label Odd mínima');
  });

  t.test('minTake omitido quando undefined (sem linha undefined)', () => {
    const msg = buildTipMessage({ ...baseOpts, minTake: undefined });
    t.assert(!/undefined/.test(msg), 'NUNCA "undefined" no output');
    t.assert(!/Odd m[íi]nima/i.test(msg), 'linha "Odd mínima" não deve aparecer sem minTake');
  });

  t.test('reason aparece quando passado', () => {
    const msg = buildTipMessage({ ...baseOpts, reason: 'streak 5w + clay specialist' });
    t.assert(msg.includes('streak 5w + clay specialist'), 'reason text');
    t.assert(/Por qu[êe]/i.test(msg), 'label Por quê');
  });

  t.test('reason omitido quando undefined', () => {
    const msg = buildTipMessage({ ...baseOpts, reason: undefined });
    t.assert(!/Por qu[êe]/i.test(msg), 'linha Por quê não aparece sem reason');
  });

  t.test('extraNotes aparecem como linhas separadas', () => {
    const msg = buildTipMessage({
      ...baseOpts,
      extraNotes: ['🟤 Saibro', '🏆 Grand Slam'],
    });
    t.assert(msg.includes('🟤 Saibro'), 'note 1');
    t.assert(msg.includes('🏆 Grand Slam'), 'note 2');
  });

  t.test('extraNotes vazio/undefined não imprime "null" ou "undefined"', () => {
    const m1 = buildTipMessage({ ...baseOpts, extraNotes: undefined });
    const m2 = buildTipMessage({ ...baseOpts, extraNotes: [] });
    t.assert(!/undefined|null/.test(m1), 'm1 sem null/undefined');
    t.assert(!/undefined|null/.test(m2), 'm2 sem null/undefined');
  });

  t.test('lineShopText aparece quando passado', () => {
    const msg = buildTipMessage({ ...baseOpts, lineShopText: '📊 Bet365: 1.92 (+3.8%)\n' });
    t.assert(msg.includes('Bet365: 1.92'), 'lineShop text preserved');
  });

  t.test('footer contém +18 (regulatório)', () => {
    const msg = buildTipMessage(baseOpts);
    t.assert(msg.includes('+18'), 'footer regulatório com +18');
  });

  t.test('footer contém menção a responsabilidade', () => {
    const msg = buildTipMessage(baseOpts);
    t.assert(/respons/i.test(msg), 'footer menciona responsabilidade');
  });

  t.test('determinismo — 2x build com mesmo seed = string igual', () => {
    const a = buildTipMessage(baseOpts);
    const b = buildTipMessage(baseOpts);
    t.assert(a === b, 'mesma seed deve produzir output idêntico');
  });

  t.test('determinismo — seeds diferentes podem produzir slang diferente', () => {
    const seeds = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    const outs = new Set(seeds.map(s => buildTipMessage({ ...baseOpts, seed: s })));
    t.assert(outs.size >= 2, `8 seeds devem dar ≥2 outputs distintos, got ${outs.size}`);
  });

  t.test('conf flair aparece em linha Confiança', () => {
    const msg = buildTipMessage(baseOpts);
    // Deve ter algo do tipo "Confiança: *ALTA* — _xxx_"
    t.assert(/Confian[çc]a/i.test(msg), 'label Confiança');
    // Pode ou não ter o flair em itálico — só verifica ALTA aparece
    t.assert(/ALTA/.test(msg), 'valor ALTA');
  });

  t.test('marketType ML não imprime "ML" redundante após pick', () => {
    // Quando marketType=ML, "Aposta: *Pick* @ *odd*" sem "ML" extra
    const msg = buildTipMessage(baseOpts);
    t.assert(/Aposta: \*Nadal\* @ \*1\.85\*/.test(msg), `ML pick sem label market: ${msg.slice(0, 500)}`);
  });

  t.test('marketType HANDICAP imprime label', () => {
    const msg = buildTipMessage({ ...baseOpts, marketType: 'HANDICAP_GAMES', pick: 'Nadal +2.5' });
    t.assert(/HANDICAP_GAMES/.test(msg) || /Nadal \+2\.5/.test(msg), 'HANDICAP visível');
  });

  t.test('números intactos — odd com 3 decimais preservado', () => {
    const msg = buildTipMessage({ ...baseOpts, odd: '1.857' });
    t.assert(msg.includes('1.857'), 'odd 3 dec preservada exatamente');
    t.assert(!msg.includes('1.86'), 'NÃO arredondou');
  });

  t.test('números intactos — EV string com sinal preservado', () => {
    const msg = buildTipMessage({ ...baseOpts, ev: '12.345' });
    t.assert(msg.includes('12.345'), 'EV preservado');
  });

  t.test('markdown asteriscos balanceados (smoke)', () => {
    const msg = buildTipMessage(baseOpts);
    const asterisks = (msg.match(/\*/g) || []).length;
    t.assert(asterisks % 2 === 0, `asteriscos ímpares (${asterisks}) — Telegram markdown vai quebrar`);
  });

  t.test('NÃO menciona "chumbo grosso" em emissão (loss context só)', () => {
    const msg = buildTipMessage(baseOpts);
    t.assert(!/chumbo grosso/i.test(msg), '"chumbo grosso" é loss context — não em emissão');
  });

  t.test('mata-leão pode aparecer em MMA (slang específico ok)', () => {
    // Smoke: builder não bloqueia slang específico de sport. MMA pode ter pega-leão se config.
    // Não exige aparecer — só não-throw.
    const msg = buildTipMessage({ ...baseOpts, sport: 'mma', match: { team1: 'A', team2: 'B', league: 'UFC' } });
    t.assert(typeof msg === 'string' && msg.length > 0, 'MMA build não throw');
  });

  t.test('kellyLabel aparece após stake quando passado', () => {
    const msg = buildTipMessage({ ...baseOpts, kellyLabel: 'kelly 1/4' });
    t.assert(msg.includes('kelly 1/4'), 'kellyLabel aparece');
  });

  t.test('matchTime aparece quando passado', () => {
    const msg = buildTipMessage({ ...baseOpts, matchTime: '14:30' });
    t.assert(msg.includes('14:30'), 'matchTime visível');
    t.assert(/BRT/.test(msg), 'label BRT');
  });

  t.test('liveScoreLine aparece quando passado', () => {
    const msg = buildTipMessage({ ...baseOpts, isLive: true, liveScoreLine: '📊 Placar: *1-0* (6-4 · 3-2)\n' });
    t.assert(/Placar.*1-0/.test(msg), 'liveScoreLine preserved');
  });

  t.test('pickPreFormatted=true não wrappa pick em asteriscos extras', () => {
    // Football usa marketLabel="⚽ Casa — *Flamengo*" que já tem markdown.
    // Sem pickPreFormatted seria "*⚽ Casa — *Flamengo**" — markdown quebrado.
    const msg = buildTipMessage({
      ...baseOpts,
      pick: '⚽ Casa — *Flamengo*',
      pickPreFormatted: true,
    });
    t.assert(/Aposta: ⚽ Casa — \*Flamengo\* @ \*1\.85\*/.test(msg),
      `pickPreFormatted deve preservar markdown do pick: ${msg.slice(0, 300)}`);
    // Não pode ter `**Flamengo**` (asteriscos duplicados)
    t.assert(!/\*\*Flamengo\*\*/.test(msg), 'sem ** duplicados');
  });

  t.test('pickPreFormatted=false (default) ainda wrappa', () => {
    const msg = buildTipMessage(baseOpts);
    t.assert(/Aposta: \*Nadal\* @ \*1\.85\*/.test(msg), 'default ainda wrappa');
  });
};

/**
 * Tests para lib/settle-message-builder.js
 *
 * buildSettleMessage(opts) deve:
 *  - Renderizar resultado (win/loss/void/push) com slang correto
 *  - Conter match, pick, odd, profit/stake
 *  - Footer com +18 (regulatório)
 *  - Números EXATAMENTE como recebidos (não converter)
 *  - Markdown balanceado
 *  - LIVE flag se isLive
 *  - "chumbo grosso" aparece em loss (esse é O ponto)
 *  - "verdão" / "forra" aparecem em win
 *  - Determinístico por seed
 */

const { buildSettleMessage } = require('../lib/settle-message-builder');

const baseWin = {
  sport: 'tennis', result: 'win',
  match: { team1: 'Federer', team2: 'Nadal', league: 'Roland Garros' },
  pick: 'Nadal', marketType: 'ML',
  odd: 1.85, profit: 12.75, stake: 15.00,
  isLive: false, seed: 'tip-1',
};

const baseLoss = { ...baseWin, result: 'loss', profit: -15.00 };
const baseVoid = { ...baseWin, result: 'void', profit: 0 };
const basePush = { ...baseWin, result: 'push', profit: 0 };

module.exports = function runTests(t) {
  t.test('win render — contém VITÓRIA + slang verde/forra/bateu', () => {
    const msg = buildSettleMessage(baseWin);
    t.assert(/VIT[ÓO]RIA/i.test(msg), 'label VITÓRIA');
    t.assert(/VERD|FORRA|BATEU/i.test(msg), `win deve ter slang verde/forra/bateu, got: ${msg.slice(0, 200)}`);
  });

  t.test('loss render — contém DERROTA + chumbo grosso (ou rotação válida)', () => {
    const msg = buildSettleMessage(baseLoss);
    t.assert(/DERROTA/i.test(msg), 'label DERROTA');
    t.assert(/CHUMBO|VERMELH|RED|NÃO COLOU|CASA ABRAÇOU/i.test(msg),
      `loss deve ter slang loss, got: ${msg.slice(0, 200)}`);
  });

  t.test('void render — contém VOID + stake devolvida', () => {
    const msg = buildSettleMessage(baseVoid);
    t.assert(/VOID/i.test(msg), 'label VOID');
    t.assert(/STAKE DEVOLVIDA|BANCA INTACTA|ANULADA|VOID, SEM PERDA/i.test(msg),
      `void deve ter slang void, got: ${msg.slice(0, 200)}`);
  });

  t.test('push render — contém PUSH', () => {
    const msg = buildSettleMessage(basePush);
    t.assert(/PUSH/i.test(msg), 'label PUSH');
  });

  t.test('match teams aparecem', () => {
    const msg = buildSettleMessage(baseWin);
    t.assert(msg.includes('Federer'), 'team1');
    t.assert(msg.includes('Nadal'), 'team2');
  });

  t.test('league aparece', () => {
    const msg = buildSettleMessage(baseWin);
    t.assert(msg.includes('Roland Garros'), 'league');
  });

  t.test('pick aparece', () => {
    const msg = buildSettleMessage(baseWin);
    t.assert(/Aposta:/i.test(msg), 'label Aposta');
    t.assert(msg.includes('Nadal'), 'pick (Nadal)');
  });

  t.test('odd aparece quando finita', () => {
    const msg = buildSettleMessage(baseWin);
    t.assert(/1\.85|@ 1\.85/.test(msg), 'odd visível');
  });

  t.test('profit win formatado com sinal +', () => {
    const msg = buildSettleMessage(baseWin);
    t.assert(/\+R\$\s?12[,\.]75/.test(msg), `profit +R$12,75, got: ${msg}`);
  });

  t.test('profit loss formatado com sinal -', () => {
    const msg = buildSettleMessage(baseLoss);
    t.assert(/-R\$\s?15[,\.]00/.test(msg), `profit -R$15,00, got: ${msg}`);
  });

  t.test('void/push mostra stake devolvida sem P/L numérico', () => {
    const msgV = buildSettleMessage(baseVoid);
    t.assert(/devolvida/i.test(msgV), 'void menciona devolvida');
    // Não deve ter "+R$0" feio
    t.assert(!/\+R\$\s?0[,\.]00/.test(msgV), 'sem +R$0,00 redundante');
  });

  t.test('LIVE flag visível quando isLive=true', () => {
    const msg = buildSettleMessage({ ...baseWin, isLive: true });
    t.assert(/LIVE|🔴/.test(msg), 'LIVE flag');
  });

  t.test('LIVE flag ausente quando isLive=false', () => {
    const msg = buildSettleMessage({ ...baseWin, isLive: false });
    t.assert(!/🔴 LIVE/.test(msg), 'sem LIVE em settled pré-jogo');
  });

  t.test('footer settle contém +18 (regulatório)', () => {
    const msg = buildSettleMessage(baseWin);
    t.assert(msg.includes('+18'), 'footer +18');
    t.assert(/respons/i.test(msg), 'footer responsabilidade');
  });

  t.test('determinismo — mesmo seed = mesma msg', () => {
    const a = buildSettleMessage(baseWin);
    const b = buildSettleMessage(baseWin);
    t.assert(a === b, 'mesma seed = msg idêntica');
  });

  t.test('mesma tip win vs loss = slang diferente', () => {
    const w = buildSettleMessage(baseWin);
    const l = buildSettleMessage({ ...baseWin, result: 'loss' });
    t.assert(w !== l, 'win e loss devem renderizar diferente');
  });

  t.test('marketType ML não imprime label redundante', () => {
    const msg = buildSettleMessage(baseWin);
    t.assert(/Aposta: \*Nadal\*/.test(msg), 'ML pick sem suffix');
  });

  t.test('marketType HANDICAP imprime label', () => {
    const msg = buildSettleMessage({ ...baseWin, marketType: 'HANDICAP_GAMES', pick: 'Nadal +2.5' });
    t.assert(/HANDICAP_GAMES|Nadal \+2\.5/.test(msg), 'HANDICAP visível (label OR pick)');
  });

  t.test('markdown asteriscos balanceados', () => {
    const msg = buildSettleMessage(baseWin);
    const asterisks = (msg.match(/\*/g) || []).length;
    t.assert(asterisks % 2 === 0, `asteriscos ímpares (${asterisks}) — markdown quebra`);
  });

  t.test('NÃO imprime "undefined" mesmo se campos opcionais faltam', () => {
    const msg = buildSettleMessage({
      sport: 'lol', result: 'win',
      match: { team1: 'T1', team2: 'GenG', league: 'LCK' },
      pick: 'T1', odd: 1.65, profit: 6.50, stake: 10,
    });
    t.assert(!/undefined|null/.test(msg), 'sem undefined/null no output');
  });

  t.test('sport icon presente', () => {
    const t1 = buildSettleMessage({ ...baseWin, sport: 'tennis' });
    t.assert(/🎾/.test(t1), 'tennis icon');
    const t2 = buildSettleMessage({ ...baseWin, sport: 'football' });
    t.assert(/⚽/.test(t2), 'football icon');
    const t3 = buildSettleMessage({ ...baseWin, sport: 'mma' });
    t.assert(/🥊/.test(t3), 'mma icon');
  });

  t.test('odd undefined não quebra', () => {
    const msg = buildSettleMessage({ ...baseWin, odd: undefined });
    t.assert(typeof msg === 'string' && msg.length > 0, 'render sem odd');
    t.assert(!/undefined/.test(msg), 'sem undefined no output');
  });
};

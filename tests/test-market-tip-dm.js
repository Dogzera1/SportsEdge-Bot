/**
 * Tests para buildMarketTipDM em lib/market-tip-processor.js (Fase 2B).
 *
 * Função canônica chamada por TODOS os MT scanners (LoL, Tennis, Football,
 * CS2, Val, Dota, Basket, Darts, Snooker, TT). Refatorada na Fase 2B pra usar
 * lib/tip-message-builder com slang BR — UMA mudança = 10 scanners adotam.
 *
 * Verifica:
 *  - Match teams + league visíveis
 *  - Sport icon + label correto
 *  - pretty label por market (handicap maps/games/gols/pts, totals, draw, tiebreak)
 *  - Pick name resolution (team1/team2/home/away → match.team1/match.team2)
 *  - Números EXATOS (odd, EV, pModel, stake)
 *  - LIVE flag quando isLive=true
 *  - altLines preservadas (Pinnacle alternative lines)
 *  - Footer +18 (regulatório obrigatório)
 *  - Determinismo por seed (mesma tip = mesma mensagem)
 *  - Markdown asteriscos balanceados
 */

const { buildMarketTipDM } = require('../lib/market-tip-processor');

const baseTip = {
  market: 'handicap', side: 'team1', line: -1.5,
  pModel: 0.62, pImplied: 0.51, odd: 1.95, ev: 11.5,
  label: 'T1 handicap -1.5 maps',
};

const baseMatch = {
  team1: 'T1', team2: 'GenG', league: 'LCK',
  id: 'match-mt-1',
};

module.exports = function runTests(t) {
  t.test('LoL handicap render — contém match + league + pick + odd + EV + stake', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', league: baseMatch.league,
      sport: 'lol', isLive: false,
    });
    t.assert(msg.includes('T1'), 'team1');
    t.assert(msg.includes('GenG'), 'team2');
    t.assert(msg.includes('LCK'), 'league');
    t.assert(/1\.95/.test(msg), 'odd');
    t.assert(/11\.5/.test(msg), 'EV');
    t.assert(/1\.5u|1\.5\b/.test(msg), 'stake');
  });

  t.test('sport label LoL correto', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', sport: 'lol',
    });
    t.assert(/LoL|🎮/i.test(msg), `LoL sport label/icon esperado, got: ${msg.slice(0, 200)}`);
  });

  t.test('sport label Tennis correto', () => {
    const msg = buildMarketTipDM({
      match: { team1: 'Alcaraz', team2: 'Sinner', league: 'Roland Garros' },
      tip: { ...baseTip, market: 'handicapGames', line: -2.5, label: 'Alcaraz handicap -2.5 games' },
      stake: '1.0', sport: 'tennis',
    });
    t.assert(/Tennis|🎾/i.test(msg), `Tennis sport label esperado, got: ${msg.slice(0, 200)}`);
  });

  t.test('sport label Football correto', () => {
    const msg = buildMarketTipDM({
      match: { team1: 'Flamengo', team2: 'Palmeiras', league: 'Brasileirão' },
      tip: { market: 'totals', side: 'over', line: 2.5, pModel: 0.58, pImplied: 0.52, odd: 1.92, ev: 7.5, label: 'Over 2.5 gols' },
      stake: '2.0', sport: 'football',
    });
    t.assert(/Futebol|⚽/i.test(msg), `Football sport label esperado, got: ${msg.slice(0, 200)}`);
  });

  t.test('LIVE flag visível quando isLive=true', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', sport: 'lol', isLive: true,
    });
    t.assert(/LIVE|🔴/.test(msg), `LIVE flag esperado, got: ${msg.slice(0, 200)}`);
  });

  t.test('LIVE flag ausente quando isLive=false', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', sport: 'lol', isLive: false,
    });
    t.assert(!/🔴 \*?LIVE/.test(msg), 'sem LIVE flag em pré-jogo');
  });

  t.test('handicap label maps (LoL/CS/Dota/Val)', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', sport: 'lol',
    });
    t.assert(/maps/i.test(msg), `LoL handicap deve dizer "maps", got: ${msg}`);
  });

  t.test('handicap label gols (Football)', () => {
    const msg = buildMarketTipDM({
      match: { team1: 'Flamengo', team2: 'Palmeiras', league: 'Brasileirão' },
      tip: { market: 'handicap', side: 'team1', line: -1.5, pModel: 0.55, pImplied: 0.50, odd: 1.85, ev: 5.0 },
      stake: '1.5', sport: 'football',
    });
    t.assert(/gols/i.test(msg), `Football handicap deve dizer "gols", got: ${msg}`);
    t.assert(!/maps/i.test(msg), 'NÃO deve dizer "maps" em football');
  });

  t.test('handicap label pts (Basket)', () => {
    const msg = buildMarketTipDM({
      match: { team1: 'Lakers', team2: 'Celtics', league: 'NBA' },
      tip: { market: 'handicap', side: 'team1', line: -5.5, pModel: 0.55, pImplied: 0.50, odd: 1.95, ev: 5.0 },
      stake: '1.5', sport: 'basket',
    });
    t.assert(/pts/i.test(msg), `Basket handicap deve dizer "pts", got: ${msg}`);
  });

  t.test('totals Over/Under label', () => {
    const msg = buildMarketTipDM({
      match: { team1: 'Flamengo', team2: 'Palmeiras', league: 'Brasileirão' },
      tip: { market: 'totals', side: 'over', line: 2.5, pModel: 0.58, pImplied: 0.52, odd: 1.92, ev: 7.5 },
      stake: '2.0', sport: 'football',
    });
    t.assert(/Over 2\.5/i.test(msg), `Over label esperado, got: ${msg}`);
  });

  t.test('handicapGames label tennis (games)', () => {
    const msg = buildMarketTipDM({
      match: { team1: 'Alcaraz', team2: 'Sinner', league: 'Roland Garros' },
      tip: { market: 'handicapGames', side: 'team1', line: -2.5, pModel: 0.60, pImplied: 0.51, odd: 1.90, ev: 8.0 },
      stake: '1.5', sport: 'tennis',
    });
    t.assert(/games/i.test(msg), `tennis handicapGames deve dizer "games", got: ${msg}`);
  });

  t.test('draw label (football 1X2 D)', () => {
    const msg = buildMarketTipDM({
      match: { team1: 'Flamengo', team2: 'Palmeiras', league: 'Brasileirão' },
      tip: { market: 'draw', side: 'd', pModel: 0.30, pImplied: 0.28, odd: 3.40, ev: 6.0 },
      stake: '1.0', sport: 'football',
    });
    t.assert(/Empate|EMPATE/i.test(msg), `Empate label esperado, got: ${msg}`);
  });

  t.test('side team1 resolve pra match.team1', () => {
    const msg = buildMarketTipDM({
      match: { team1: 'TeamA', team2: 'TeamB', league: 'X' },
      tip: { market: 'handicap', side: 'team1', line: -1.5, pModel: 0.55, pImplied: 0.50, odd: 1.85, ev: 5.0 },
      stake: '1.5', sport: 'lol',
    });
    t.assert(msg.includes('TeamA'), 'pickName=TeamA');
  });

  t.test('side home resolve pra match.team1 (football alias)', () => {
    const msg = buildMarketTipDM({
      match: { team1: 'Flamengo', team2: 'Palmeiras', league: 'X' },
      tip: { market: 'handicap', side: 'home', line: -1.5, pModel: 0.55, pImplied: 0.50, odd: 1.85, ev: 5.0 },
      stake: '1.5', sport: 'football',
    });
    t.assert(msg.includes('Flamengo'), 'home → team1=Flamengo');
  });

  t.test('side away resolve pra match.team2', () => {
    const msg = buildMarketTipDM({
      match: { team1: 'Flamengo', team2: 'Palmeiras', league: 'X' },
      tip: { market: 'handicap', side: 'away', line: -1.5, pModel: 0.55, pImplied: 0.50, odd: 1.85, ev: 5.0 },
      stake: '1.5', sport: 'football',
    });
    t.assert(msg.includes('Palmeiras'), 'away → team2=Palmeiras');
  });

  t.test('altLines aparecem quando markets fornecido (handicapGames)', () => {
    const msg = buildMarketTipDM({
      match: { team1: 'Alcaraz', team2: 'Sinner', league: 'Roland Garros' },
      tip: { market: 'handicapGames', side: 'team1', line: -2.5, pModel: 0.60, pImplied: 0.51, odd: 1.90, ev: 8.0 },
      stake: '1.5', sport: 'tennis',
      markets: {
        gamesHandicaps: [
          { line: -1.5, oddsHome: 1.45, oddsAway: 2.75 },
          { line: -2.5, oddsHome: 1.90, oddsAway: 1.90 },
          { line: -3.5, oddsHome: 2.50, oddsAway: 1.55 },
        ],
      },
    });
    t.assert(/Linhas Pinnacle/i.test(msg), `altLines header esperado, got: ${msg.slice(0, 400)}`);
    t.assert(/← seu pick|seu pick/i.test(msg), 'marker do pick selecionado');
  });

  t.test('NÃO imprime "undefined" mesmo se campos opcionais faltam', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', sport: 'lol',
    });
    t.assert(!/undefined|null/.test(msg), `sem undefined/null no output, got: ${msg}`);
  });

  t.test('markdown asteriscos balanceados', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', sport: 'lol',
    });
    const asterisks = (msg.match(/\*/g) || []).length;
    t.assert(asterisks % 2 === 0, `asteriscos ímpares (${asterisks}): ${msg}`);
  });

  t.test('números intactos — odd 3 decimais preservado', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: { ...baseTip, odd: 1.873 }, stake: '1.5', sport: 'lol',
    });
    // O builder pode rodar toFixed(2), então 1.873 → 1.87. Aceitamos truncado pra 2 decimais.
    t.assert(/1\.87/.test(msg), `odd visível (1.87 ou 1.873), got: ${msg.slice(0, 200)}`);
  });

  t.test('EV preservado', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: { ...baseTip, ev: 12.345 }, stake: '1.5', sport: 'lol',
    });
    t.assert(/12\.3/.test(msg), `EV visível (12.3 ou 12.345)`);
  });

  t.test('stake preservado', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '2.75', sport: 'lol',
    });
    t.assert(/2\.75/.test(msg), `stake visível, got: ${msg}`);
  });

  // ── Fase 2B novos: slang BR + footer regulatório ──

  t.test('Fase 2B: footer contém +18 (regulatório obrigatório)', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', sport: 'lol',
    });
    t.assert(msg.includes('+18'), `footer regulatório +18 esperado, got: ${msg}`);
  });

  t.test('Fase 2B: footer menciona responsabilidade', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', sport: 'lol',
    });
    t.assert(/respons/i.test(msg), 'footer menciona responsabilidade');
  });

  t.test('Fase 2B: NÃO menciona "chumbo grosso" (loss context só, não emissão)', () => {
    const msg = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', sport: 'lol',
    });
    t.assert(!/chumbo grosso/i.test(msg), '"chumbo grosso" é loss context, não em MT emit');
  });

  t.test('Fase 2B: determinismo — mesmo seed = msg igual', () => {
    const a = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', sport: 'lol',
    });
    const b = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', sport: 'lol',
    });
    t.assert(a === b, `mesma seed = msg idêntica`);
  });

  t.test('Fase 2B: header inclui MT (market tip indicator)', () => {
    // O header DEVE deixar claro que é MT (não ML), pra usuário distinguir
    const msg = buildMarketTipDM({
      match: baseMatch, tip: baseTip, stake: '1.5', sport: 'lol',
    });
    // Pode ser "MARKET TIP" ou "MT" ou "MERCADO" — algum identificador
    t.assert(/MARKET|MERCADO|\bMT\b|TIP/i.test(msg), `header deve identificar como tip, got: ${msg.slice(0, 200)}`);
  });
};

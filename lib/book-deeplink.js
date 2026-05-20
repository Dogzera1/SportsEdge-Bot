'use strict';

// Gera URL deeplink por bookmaker. Maioria das casas BR não aceita prefill de stake
// via URL, então o objetivo é só abrir a casa certa (app/site). User cola stake/odd
// manualmente — DM mostra valores em code blocks pra long-press copy.
//
// Sharp-friendly books (permitem API e costumam não banir): Pinnacle, SX.Bet,
// Matchbook, Betfair Exchange. Books retail (Bet365, Betano) não têm prefill e
// podem banir conta em dias se detectarem automação.

function _slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildBookDeeplink(bookmaker, ctx = {}) {
  const book = _slug(bookmaker);
  const sport = _slug(ctx.sport);
  const t1 = encodeURIComponent(ctx.team1 || ctx.participant1 || '');
  const t2 = encodeURIComponent(ctx.team2 || ctx.participant2 || '');

  if (book.includes('pinnacle')) {
    // 2026-05-20: Pinnacle Brasil licenciada (pinnacle.bet.br) — pós jul/2024
    // regulamentação. Default BR; override via PINNACLE_REGION=int pra .com.
    // matchupId é o melhor deep-link. Sem ele, cai na categoria do sport.
    const region = String(process.env.PINNACLE_REGION || 'br').toLowerCase();
    const baseHost = (region === 'int' || region === 'com') ? 'www.pinnacle.com/pt' : 'www.pinnacle.bet.br/pt';
    if (ctx.matchupId) {
      return `https://${baseHost}/matchup/${encodeURIComponent(ctx.matchupId)}`;
    }
    const sportPath = {
      lol: 'esports/leagues', esports: 'esports/leagues',
      dota2: 'esports/leagues', cs: 'esports/leagues', valorant: 'esports/leagues',
      tennis: 'tennis/matchups',
      football: 'soccer/matchups',
      mma: 'mma/matchups',
      darts: 'darts/matchups', snooker: 'snooker/matchups',
      tabletennis: 'table-tennis/matchups',
    }[sport] || '';
    return `https://${baseHost}/${sportPath}`;
  }

  if (book.includes('sxbet') || book.includes('sx')) {
    return `https://sx.bet/`;
  }

  if (book.includes('matchbook')) {
    return `https://www.matchbook.com/`;
  }

  if (book.includes('betfair')) {
    return `https://www.betfair.com/exchange/plus/`;
  }

  if (book.includes('stake')) {
    // Stake tem search por team — query param `q`
    return `https://stake.bet.br/sportsbook?q=${t1}+vs+${t2}`;
  }

  if (book.includes('bet365')) {
    // bet365.bet.br é a licenciada brasileira (desde mar/2025). App detecta
    // login. Sem prefill de stake/odd — user cola manualmente.
    // 2026-05-20: search by team — abre página com filtro pelos teams (user
    // localiza market rapidamente). Bet365 BR search funciona via #/HO/N/?q=...
    const region = String(process.env.BET365_REGION || 'br').toLowerCase();
    const teamsQ = (ctx.team1 || ctx.team2)
      ? encodeURIComponent(`${ctx.team1 || ''} ${ctx.team2 || ''}`.trim())
      : '';
    if (region === 'eu' || region === 'int') {
      return teamsQ ? `https://www.bet365.com/#/AC/B${ctx.sport === 'tennis' ? 13 : 1}/?searchquery=${teamsQ}` : `https://www.bet365.com/`;
    }
    return teamsQ ? `https://www.bet365.bet.br/#/AC/B${ctx.sport === 'tennis' ? 13 : 1}/?searchquery=${teamsQ}` : `https://www.bet365.bet.br/`;
  }

  if (book.includes('betano')) {
    // 2026-05-20: search query — Betano aceita /search?q=teams. App ou site
    // abre lista de eventos filtrados pelos teams.
    const teamsQ = (ctx.team1 || ctx.team2)
      ? encodeURIComponent(`${ctx.team1 || ''} ${ctx.team2 || ''}`.trim())
      : '';
    return teamsQ ? `https://www.betano.bet.br/search?query=${teamsQ}` : `https://www.betano.bet.br/sport`;
  }

  if (book.includes('kto')) {
    const teamsQ = (ctx.team1 || ctx.team2)
      ? encodeURIComponent(`${ctx.team1 || ''} ${ctx.team2 || ''}`.trim())
      : '';
    return teamsQ ? `https://www.kto.com/pt-br/search?q=${teamsQ}` : `https://www.kto.com/pt-br/apostas-esportivas`;
  }

  if (book.includes('superbet')) {
    const teamsQ = (ctx.team1 || ctx.team2)
      ? encodeURIComponent(`${ctx.team1 || ''} ${ctx.team2 || ''}`.trim())
      : '';
    return teamsQ ? `https://superbet.bet.br/search?q=${teamsQ}` : `https://superbet.bet.br/`;
  }

  if (book.includes('theoddsapi')) {
    // TheOddsAPI é aggregator — não tem site próprio. Retorna Pinnacle como proxy.
    return buildBookDeeplink('Pinnacle', ctx);
  }

  // Fallback: google search pela casa + partida
  return `https://www.google.com/search?q=${encodeURIComponent(bookmaker)}+${t1}+${t2}`;
}

// Telegram reply_markup pra tip. Retorna objeto pronto pra spread em sendMessage
// params: { reply_markup: { inline_keyboard: [[{text, url}]] } }. Retorna null
// quando book não identificado.
//
// Se user configurou BET365_SECONDARY_BUTTON=true (ou deixou default), adiciona
// 2a linha com botão "🔍 Ver Bet365" pra check manual (Bet365 não tem feed de
// odds no sistema — user compara manualmente se odd lá vale mais que primary).
// Só adiciona se primary book != Bet365.
function tipBetButton(bookmaker, ctx = {}) {
  if (!bookmaker) return null;
  const url = buildBookDeeplink(bookmaker, ctx);
  if (!url) return null;
  const stakeR = ctx.stakeReais ? ` R$${Number(ctx.stakeReais).toFixed(2)}` : '';
  const odd = ctx.odd ? ` @ ${Number(ctx.odd).toFixed(2)}` : '';

  const rows = [[
    { text: `🎯 Abrir ${bookmaker}${stakeR}${odd}`, url },
  ]];

  const secondaryEnabled = process.env.BET365_SECONDARY_BUTTON !== 'false';
  const primaryIsBet365 = /bet365/i.test(String(bookmaker));
  if (secondaryEnabled && !primaryIsBet365) {
    const bet365Url = buildBookDeeplink('Bet365', ctx);
    rows.push([
      { text: '🔍 Ver Bet365 (comparar)', url: bet365Url },
    ]);
  }

  return { reply_markup: { inline_keyboard: rows } };
}

module.exports = { buildBookDeeplink, tipBetButton };

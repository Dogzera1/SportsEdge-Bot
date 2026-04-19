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
    // Pinnacle matchupId é o melhor. Se não tiver, cai na categoria do sport.
    if (ctx.matchupId) {
      return `https://www.pinnacle.com/pt/matchup/${encodeURIComponent(ctx.matchupId)}`;
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
    return `https://www.pinnacle.com/pt/${sportPath}`;
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
    // Opcional: BET365_REGION=eu pra usar www.bet365.com (conta internacional).
    const region = String(process.env.BET365_REGION || 'br').toLowerCase();
    if (region === 'eu' || region === 'int') return `https://www.bet365.com/`;
    return `https://www.bet365.bet.br/`;
  }

  if (book.includes('betano')) {
    return `https://www.betano.bet.br/sport`;
  }

  if (book.includes('kto')) {
    return `https://www.kto.com/pt-br/apostas-esportivas`;
  }

  if (book.includes('superbet')) {
    return `https://superbet.bet.br/`;
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
// quando book não identificado (callsite trata fallback).
function tipBetButton(bookmaker, ctx = {}) {
  if (!bookmaker) return null;
  const url = buildBookDeeplink(bookmaker, ctx);
  if (!url) return null;
  const stakeR = ctx.stakeReais ? ` R$${Number(ctx.stakeReais).toFixed(2)}` : '';
  const odd = ctx.odd ? ` @ ${Number(ctx.odd).toFixed(2)}` : '';
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: `🎯 Abrir ${bookmaker}${stakeR}${odd}`, url },
      ]],
    },
  };
}

module.exports = { buildBookDeeplink, tipBetButton };

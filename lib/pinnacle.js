/**
 * pinnacle.js — Cliente genérico da Pinnacle Guest API (funciona do BR, sem auth real).
 *
 * Endpoint usado pelo próprio frontend pinnacle.com. X-API-Key pública.
 *
 * Sport IDs confirmados:
 *   6=Boxing, 10=Darts, 12=E-Sports, 22=MMA, 28=Snooker, 29=Soccer, 33=Tennis
 *
 * Over PINNACLE_API_KEY via env caso a key pública rotacione.
 */
'use strict';

const { safeParse, cachedHttpGet, log } = require('./utils');

const API_BASE = 'https://guest.api.arcadia.pinnacle.com';
const API_KEY = process.env.PINNACLE_API_KEY || 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'X-API-Key': API_KEY,
  'Referer': 'https://www.pinnacle.com/',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9'
};

function americanToDecimal(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p === 0) return null;
  if (p > 0) return +((p / 100) + 1).toFixed(3);
  return +((100 / Math.abs(p)) + 1).toFixed(3);
}

async function _get(path, { ttlMs = 3 * 60 * 1000 } = {}) {
  const url = `${API_BASE}${path}`;
  const r = await cachedHttpGet(url, {
    provider: 'pinnacle', ttlMs, headers: HEADERS, cacheKey: `pinnacle:${url}`
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  return safeParse(r.body, null);
}

async function listSportMatchups(sportId) {
  const data = await _get(`/0.1/sports/${sportId}/matchups?brandId=0`);
  return Array.isArray(data) ? data : [];
}

async function getMatchupMarkets(matchupId) {
  return _get(`/0.1/matchups/${matchupId}/markets/related/straight`);
}

/**
 * Extrai odds moneyline de um matchup (home/away), convertendo American → Decimal.
 * @param {Object} matchup — item de listSportMatchups
 * @returns {Object|null} { id, league, group, startTime, status, team1, team2, oddsT1, oddsT2 }
 */
async function extractMoneyline(matchup) {
  try {
    const home = (matchup.participants || []).find(p => p.alignment === 'home');
    const away = (matchup.participants || []).find(p => p.alignment === 'away');
    if (!home?.name || !away?.name) return null;

    const markets = await getMatchupMarkets(matchup.id);
    if (!Array.isArray(markets)) return null;
    const ml = markets.find(x => x.type === 'moneyline' && x.period === 0 && x.status === 'open');
    if (!ml?.prices) return null;

    const ph = ml.prices.find(p => p.designation === 'home');
    const pa = ml.prices.find(p => p.designation === 'away');
    const oddsHome = americanToDecimal(ph?.price);
    const oddsAway = americanToDecimal(pa?.price);
    if (!oddsHome || !oddsAway) return null;

    return {
      id: matchup.id,
      league: matchup.league?.name || null,
      leagueId: matchup.league?.id,
      group: matchup.league?.group,
      startTime: matchup.startTime,
      status: matchup.isLive ? 'live' : 'upcoming',
      team1: home.name,
      team2: away.name,
      oddsT1: oddsHome,
      oddsT2: oddsAway,
    };
  } catch (e) {
    log('WARN', 'PINNACLE', `matchup ${matchup?.id}: ${e.message}`);
    return null;
  }
}

/**
 * Fluxo completo para qualquer esporte: lista matchups + extrai moneylines.
 * @param {number|string} sportId
 * @param {Function} [leagueFilter] — (matchup) => boolean para filtrar antes de pegar odds
 */
async function fetchSportMatchOdds(sportId, leagueFilter) {
  const matchups = await listSportMatchups(sportId);
  if (!matchups.length) return [];
  const filtered = typeof leagueFilter === 'function'
    ? matchups.filter(leagueFilter)
    : matchups;
  const out = [];
  for (const m of filtered) {
    const row = await extractMoneyline(m);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Ranking implícito via de-juice das odds Pinnacle.
 * Pinnacle é o book mais afiado do mundo; suas odds de-juiced são um proxy decente
 * de ranking real quando não temos rank oficial (snooker.org etc.)
 *
 * Retorna { probA, probB } onde A=team1/home, B=team2/away (de-juice simples).
 */
function impliedProbsFromOdds(oddsA, oddsB) {
  const a = Number(oddsA), b = Number(oddsB);
  if (!a || !b || a <= 1 || b <= 1) return null;
  const ra = 1 / a, rb = 1 / b;
  const vig = ra + rb;
  return { probA: ra / vig, probB: rb / vig };
}

module.exports = {
  listSportMatchups,
  getMatchupMarkets,
  extractMoneyline,
  fetchSportMatchOdds,
  americanToDecimal,
  impliedProbsFromOdds,
};

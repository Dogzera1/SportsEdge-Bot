/**
 * pinnacle-snooker.js — Odds de snooker via endpoint guest da Pinnacle.
 *
 * Funciona do Brasil (diferente da Betfair Exchange que bloqueia IPs BR).
 * Endpoints públicos usados pelo próprio site pinnacle.com — sem auth real,
 * apenas API Key pública fixa (a mesma usada pelo frontend).
 *
 * Sport ID snooker = 28 (confirmado via GET /0.1/sports).
 * Preços em formato **American odds** (ex: +305, -499) — convertemos para decimal.
 */
'use strict';

const { safeParse, cachedHttpGet, log } = require('./utils');

const API_BASE = 'https://guest.api.arcadia.pinnacle.com';
// X-API-Key fixa usada pelo frontend pinnacle.com. Pública, rotativa raramente.
// Override via PINNACLE_API_KEY caso Pinnacle troque e o deploy precise ser ajustado sem release.
const API_KEY = process.env.PINNACLE_API_KEY || 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'X-API-Key': API_KEY,
  'Referer': 'https://www.pinnacle.com/',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9'
};

const SPORT_ID_SNOOKER = 28;

// Converte American odds (ex: +305, -499) para decimal odds (ex: 4.05, 1.20)
function americanToDecimal(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p === 0) return null;
  if (p > 0)  return +((p / 100) + 1).toFixed(3);
  return +((100 / Math.abs(p)) + 1).toFixed(3);
}

async function _get(path, { ttlMs = 3 * 60 * 1000 } = {}) {
  const url = `${API_BASE}${path}`;
  const r = await cachedHttpGet(url, {
    provider: 'pinnacle',
    ttlMs,
    headers: HEADERS,
    cacheKey: `pinnacle:${url}`
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  return safeParse(r.body, null);
}

/** Lista matchups de snooker (todas as ligas ativas) */
async function listMatchups() {
  const data = await _get(`/0.1/sports/${SPORT_ID_SNOOKER}/matchups?brandId=0`);
  return Array.isArray(data) ? data : [];
}

/** Busca odds moneyline + totals de um matchup específico */
async function getMatchupOdds(matchupId) {
  return _get(`/0.1/matchups/${matchupId}/markets/related/straight`);
}

/**
 * Fluxo completo: busca todos os matchups ativos de snooker + odds moneyline
 * Retorna array normalizado { id, eventId, eventName, league, startTime, t1, t2, oddsT1, oddsT2, status }
 */
async function fetchSnookerMatchOdds() {
  const matchups = await listMatchups();
  if (!matchups.length) return [];

  const out = [];
  for (const m of matchups) {
    try {
      const home = (m.participants || []).find(p => p.alignment === 'home');
      const away = (m.participants || []).find(p => p.alignment === 'away');
      if (!home?.name || !away?.name) continue;

      const markets = await getMatchupOdds(m.id);
      if (!Array.isArray(markets)) continue;
      const ml = markets.find(x => x.type === 'moneyline' && x.period === 0 && x.status === 'open');
      if (!ml?.prices) continue;
      const ph = ml.prices.find(p => p.designation === 'home');
      const pa = ml.prices.find(p => p.designation === 'away');
      const oddsHome = americanToDecimal(ph?.price);
      const oddsAway = americanToDecimal(pa?.price);
      if (!oddsHome || !oddsAway) continue;

      out.push({
        id: m.id,
        league: m.league?.name || 'Snooker',
        leagueId: m.league?.id,
        group: m.league?.group,
        startTime: m.startTime,
        status: m.isLive ? 'live' : 'upcoming',
        team1: home.name,
        team2: away.name,
        oddsT1: oddsHome,
        oddsT2: oddsAway,
      });
    } catch (e) {
      log('WARN', 'PINNACLE', `matchup ${m.id}: ${e.message}`);
    }
  }
  return out;
}

module.exports = {
  fetchSnookerMatchOdds,
  listMatchups,
  getMatchupOdds,
  americanToDecimal,
  SPORT_ID_SNOOKER,
};

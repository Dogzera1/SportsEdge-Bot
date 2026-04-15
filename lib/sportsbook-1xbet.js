/**
 * sportsbook-1xbet.js — cliente pro endpoint /bookies/1xbet/* do hltv-proxy.
 *
 * Por quê: Pinnacle TT com matchupCount=0, Sofascore só lista (sem odds).
 * 1xBet tem 770+ TT matches por dia. Scraping direto bloqueia IP residencial/cloud,
 * mas nosso proxy usa curl_cffi com impersonate Chrome → passa.
 *
 * Env reusa HLTV_PROXY_BASE (mesmo serviço Python).
 */
const { cachedHttpGet, safeParse } = require('./utils');

const BROWSER_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'ngrok-skip-browser-warning': 'true',
};

function _base() {
  return (process.env.HLTV_PROXY_BASE || '').trim().replace(/\/+$/, '');
}

function _enabled() {
  if (!_base()) return false;
  const v = String(process.env.ONEXBET_ENABLED || '').toLowerCase();
  // default on se proxy existe
  return v !== 'false' && v !== '0' && v !== 'no';
}

async function _fetchFeed(live, count = 200) {
  const base = _base();
  if (!base) return [];
  const url = `${base}/bookies/1xbet/table-tennis?live=${live ? 1 : 0}&count=${count}`;
  const r = await cachedHttpGet(url, {
    ttlMs: live ? 30 * 1000 : 120 * 1000,  // live 30s, pre-match 2min
    provider: '1xbet',
    headers: BROWSER_HEADERS,
    cacheKey: `1xbet-tt:${live ? 'live' : 'line'}`,
  }).catch(() => null);
  if (!r || r.status !== 200) return [];
  const j = safeParse(r.body, null);
  return Array.isArray(j?.matches) ? j.matches : [];
}

/**
 * Busca matches de TT do 1xBet (pre-match + live) normalizados pro formato do bot.
 * @returns {Promise<Array<{id,team1,team2,league,status,time,odds:{t1,t2,bookmaker}}>>}
 */
async function getTableTennisMatches() {
  if (!_enabled()) return [];

  const [line, live] = await Promise.all([
    _fetchFeed(false).catch(() => []),
    _fetchFeed(true).catch(() => []),
  ]);

  // Dedup por matchId (live override line)
  const byId = new Map();
  for (const m of line) byId.set(m.matchId, { ...m, live: false });
  for (const m of live) byId.set(m.matchId, { ...m, live: true });

  const out = [];
  for (const m of byId.values()) {
    if (!m.team1 || !m.team2 || !m.odds?.t1 || !m.odds?.t2) continue;
    out.push({
      id: `ttennis_1xbet_${m.matchId}`,
      team1: m.team1,
      team2: m.team2,
      league: m.league || 'Table Tennis',
      sport_key: 'table_tennis',
      status: m.live ? 'live' : 'upcoming',
      time: m.startTime || null,
      odds: {
        t1: String(m.odds.t1),
        t2: String(m.odds.t2),
        bookmaker: '1xBet',
      },
    });
  }
  return out;
}

module.exports = { getTableTennisMatches, _enabled };

/**
 * api-football.js — Wrapper para API-Football (api-sports.io)
 * Env: API_FOOTBALL_KEY  (header x-apisports-key)
 * Free tier: 100 req/dia, cobertura de ~900 ligas
 * Docs: https://www.api-football.com/documentation-v3
 */
const https = require('https');
const { URL } = require('url');

const KEY  = process.env.API_FOOTBALL_KEY || '';
const BASE = 'https://v3.football.api-sports.io';

const _cache = new Map();

function _cacheGet(k) {
  const v = _cache.get(k);
  if (!v) return null;
  if (Date.now() > v.exp) { _cache.delete(k); return null; }
  return v.data;
}
function _cacheSet(k, d, ttlMs) {
  _cache.set(k, { data: d, exp: Date.now() + ttlMs });
}

function httpGetJson(path, { ttlMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (!KEY) { reject(new Error('API_FOOTBALL_KEY não configurado')); return; }
    const url = new URL(BASE + path);
    const cacheKey = url.toString();
    if (ttlMs > 0) {
      const cached = _cacheGet(cacheKey);
      if (cached) { resolve(cached); return; }
    }
    const req = https.request(url, {
      method: 'GET',
      headers: { 'x-apisports-key': KEY, Accept: 'application/json' },
      timeout: 12000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`api-football HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(body || '{}');
          if (ttlMs > 0) _cacheSet(cacheKey, json, ttlMs);
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('api-football timeout')));
    req.end();
  });
}

// Mapa TheOddsAPI sport_key → API-Football league ID
// https://www.api-football.com/documentation-v3#tag/Leagues
const LEAGUE_MAP = {
  'soccer_brazil_campeonato':          71,
  'soccer_brazil_serie_b':             72,
  'soccer_brazil_serie_c':             75,
  'soccer_england_epl':                39,
  'soccer_england_championship':       40,
  'soccer_england_league1':            41,
  'soccer_england_league2':            42,
  'soccer_germany_bundesliga':         78,
  'soccer_germany_2_bundesliga':       79,
  'soccer_germany_3_liga':             80,
  'soccer_spain_la_liga':             140,
  'soccer_spain_segunda_division':    141,
  'soccer_italy_serie_a':             135,
  'soccer_italy_serie_b':             136,
  'soccer_france_ligue_1':             61,
  'soccer_france_ligue_2':             62,
  'soccer_portugal_primeira_liga':     94,
  'soccer_portugal_segunda_liga':      95,
  'soccer_netherlands_eredivisie':     88,
  'soccer_netherlands_eerste_divisie': 89,
  'soccer_belgium_first_division_a':  144,
  'soccer_belgium_first_division_b':  145,
  'soccer_turkey_super_lig':          203,
  'soccer_turkey_1_lig':              204,
  'soccer_sweden_allsvenskan':        113,
  'soccer_sweden_superettan':         114,
  'soccer_norway_eliteserien':        103,
  'soccer_norway_obos_ligaen':        104,
  'soccer_argentina_primera_division':128,
  'soccer_chile_campeonato':          265,
  'soccer_colombia_primera_a':        239,
  'soccer_mexico_ligamx':             262,
  'soccer_usa_mls':                   253,
  'soccer_japan_j_league':             98,
  'soccer_south_korea_kleague1':      292,
  'soccer_australia_aleague':         188,
};

function getLeagueId(sportKey) {
  return LEAGUE_MAP[sportKey] || null;
}

// Rastreio de quota diária (100 req/dia free tier)
const DAILY_BUDGET = parseInt(process.env.API_FOOTBALL_DAILY_BUDGET || '80', 10);
let _dailyCount = 0;
let _dailyDate  = new Date().toDateString();

function apiFootballAllowed() {
  const today = new Date().toDateString();
  if (today !== _dailyDate) { _dailyCount = 0; _dailyDate = today; }
  return _dailyCount < DAILY_BUDGET;
}

function apiFootballConsume() {
  _dailyCount++;
}

/**
 * Retorna partidas agendadas nos próximos daysAhead dias para uma liga.
 * @param {number} leagueId
 * @param {string|null} sportKey  — chave TheOddsAPI (para preencher sport_key no objeto)
 * @param {number} daysAhead
 * @returns {Promise<Array>}
 */
async function getUpcomingFixtures(leagueId, { sportKey = null, daysAhead = 7 } = {}) {
  if (!leagueId || !KEY) return [];
  if (!apiFootballAllowed()) return [];

  const season = new Date().getFullYear();
  const next   = Math.max(1, Math.min(daysAhead * 3, 50)); // estimativa conservadora
  apiFootballConsume();

  const data = await httpGetJson(
    `/fixtures?league=${leagueId}&season=${season}&next=${next}`,
    { ttlMs: 60 * 60 * 1000 }
  ).catch(() => null);

  if (!data?.response) return [];

  const cutoff = Date.now() + daysAhead * 24 * 60 * 60 * 1000;
  return (data.response || [])
    .filter(f => {
      const ts = f?.fixture?.timestamp ? f.fixture.timestamp * 1000 : 0;
      return ts > Date.now() && ts <= cutoff;
    })
    .map(f => ({
      id:        `af_${f.fixture.id}`,
      game:      'football',
      sport_key: sportKey,
      status:    'upcoming',
      team1:     f.teams?.home?.name || '',
      team2:     f.teams?.away?.name || '',
      league:    f.league?.name || '',
      time:      f.fixture?.date || null,
      odds:      null,
      _source:   'api-football',
      _fixtureId: f.fixture.id,
      _homeId:   f.teams?.home?.id   || null,
      _awayId:   f.teams?.away?.id   || null,
      _leagueId: leagueId,
    }));
}

module.exports = { getLeagueId, getUpcomingFixtures, apiFootballAllowed };

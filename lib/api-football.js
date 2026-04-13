/**
 * api-football.js — Wrapper para API-Football (api-sports.io)
 * Env: API_FOOTBALL_KEY  (header x-apisports-key)
 * Free tier: 100 req/dia, cobertura de ~900 ligas
 * Docs: https://www.api-football.com/documentation-v3
 */
const https = require('https');
const { URL } = require('url');

const KEY  = process.env.API_FOOTBALL_KEY || process.env.API_SPORTS_KEY || process.env.APISPORTS_KEY || '';
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

// Ligas de calendário civil (Jan-Dez): Brasil, Escandinávia, Ásia-Pacífico, Américas.
// As demais (Europa, Turquia, México) usam temporada cross-year (Ago-Mai),
// cujo "season" no api-football é o ano em que começa (2025 = 2025/26).
const CALENDAR_YEAR_LEAGUES = new Set([
  'soccer_brazil_campeonato',
  'soccer_brazil_serie_b',
  'soccer_brazil_serie_c',
  'soccer_sweden_allsvenskan',
  'soccer_sweden_superettan',
  'soccer_norway_eliteserien',
  'soccer_norway_obos_ligaen',
  'soccer_usa_mls',
  'soccer_japan_j_league',
  'soccer_south_korea_kleague1',
  'soccer_australia_aleague',
  'soccer_argentina_primera_division',
  'soccer_chile_campeonato',
  'soccer_colombia_primera_a',
]);

function seasonFor(sportKey) {
  const now = new Date();
  const year = now.getUTCFullYear();
  if (sportKey && CALENDAR_YEAR_LEAGUES.has(sportKey)) return year;
  // Cross-year: antes de julho ainda estamos na temporada que começou no ano anterior.
  return now.getUTCMonth() + 1 >= 7 ? year : year - 1;
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

  const season = seasonFor(sportKey);
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

// Cache de fixtures por liga (evita chamadas repetidas na mesma janela)
const _fixtureCache = new Map(); // `${leagueId}_${season}` → { data: [], exp: ts }

/**
 * Busca fixtures de uma liga e cacheia por 1h.
 * Reutiliza cache para enriquecer múltiplos jogos da mesma liga no mesmo ciclo.
 */
async function getLeagueFixtures(leagueId, season) {
  const cacheKey = `${leagueId}_${season}`;
  const cached = _fixtureCache.get(cacheKey);
  if (cached && Date.now() < cached.exp) return cached.data;

  if (!KEY || !apiFootballAllowed()) return [];
  apiFootballConsume();

  const data = await httpGetJson(
    `/fixtures?league=${leagueId}&season=${season}&next=50&status=NS`,
    { ttlMs: 60 * 60 * 1000 }
  ).catch(() => null);

  const fixtures = data?.response || [];
  _fixtureCache.set(cacheKey, { data: fixtures, exp: Date.now() + 60 * 60 * 1000 });
  return fixtures;
}

/**
 * Normaliza um nome de time para comparação fuzzy (remove acentos, lowercase).
 */
function _normName(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
}

function _nameMatch(a, b) {
  const na = _normName(a), nb = _normName(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // match parcial: primeira palavra
  return na.split(' ')[0] === nb.split(' ')[0];
}

/**
 * Busca stats da temporada atual para um time (goalsFor/Against médias).
 * @param {number} teamId
 * @param {number} leagueId
 * @param {number} season
 * @returns {Promise<{goalsFor: number|null, goalsAgainst: number|null}|null>}
 */
async function getTeamStats(teamId, leagueId, season) {
  if (!KEY || !teamId || !apiFootballAllowed()) return null;
  apiFootballConsume();

  const data = await httpGetJson(
    `/teams/statistics?team=${teamId}&league=${leagueId}&season=${season}`,
    { ttlMs: 3 * 60 * 60 * 1000 }
  ).catch(() => null);

  const r = data?.response;
  if (!r) return null;

  const gfAvg = parseFloat(r.goals?.for?.average?.total || '');
  const gaAvg = parseFloat(r.goals?.against?.average?.total || '');

  // Forma recente: últimas 5 partidas em formato W/D/L
  const form = typeof r.form === 'string' ? [...r.form.slice(-10)].map(c => {
    if (c === 'W') return 'W';
    if (c === 'D') return 'D';
    if (c === 'L') return 'L';
    return null;
  }).filter(Boolean) : null;

  return {
    goalsFor:     isNaN(gfAvg) ? null : gfAvg,
    goalsAgainst: isNaN(gaAvg) ? null : gaAvg,
    form:         form?.length ? form : null,
  };
}

/**
 * Busca H2H entre dois times (últimos 10 resultados).
 * @param {number} homeId
 * @param {number} awayId
 * @returns {Promise<{results: Array}|null>}
 */
async function getH2H(homeId, awayId) {
  if (!KEY || !homeId || !awayId || !apiFootballAllowed()) return null;
  apiFootballConsume();

  const data = await httpGetJson(
    `/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`,
    { ttlMs: 6 * 60 * 60 * 1000 }
  ).catch(() => null);

  const fixtures = data?.response;
  if (!Array.isArray(fixtures) || !fixtures.length) return null;

  const results = fixtures.map(f => ({
    home:      f.teams?.home?.name || '',
    away:      f.teams?.away?.name || '',
    homeGoals: f.goals?.home ?? null,
    awayGoals: f.goals?.away ?? null,
    date:      f.fixture?.date || null,
  })).filter(r => r.homeGoals !== null && r.awayGoals !== null);

  return results.length ? { results } : null;
}

/**
 * Enriquece um jogo de futebol com form + H2H via API-Football.
 * Usa cache de fixtures da liga para minimizar chamadas à API.
 *
 * @param {string} team1     - nome do time da casa
 * @param {string} team2     - nome do visitante
 * @param {string} sportKey  - chave TheOddsAPI (ex: 'soccer_sweden_superettan')
 * @param {string|null} time - ISO date string da partida
 * @returns {Promise<{homeFormData, awayFormData, h2hData, fixtureId}|null>}
 */
async function enrichMatch(team1, team2, sportKey, time) {
  if (!KEY) return null;
  const leagueId = getLeagueId(sportKey);
  if (!leagueId) return null;

  const season = seasonFor(sportKey);
  const fixtures = await getLeagueFixtures(leagueId, season);
  if (!fixtures.length) return null;

  // Encontra o fixture correspondente ao jogo
  const fx = fixtures.find(f => {
    const hn = f.teams?.home?.name || '';
    const an = f.teams?.away?.name || '';
    return _nameMatch(hn, team1) && _nameMatch(an, team2);
  });

  if (!fx) return null;

  const homeId = fx.teams?.home?.id;
  const awayId = fx.teams?.away?.id;
  if (!homeId || !awayId) return null;

  // Budget: 2 req (stats) + 1 req (h2h) — só se ainda tiver saldo
  const [homeStats, awayStats] = await Promise.all([
    getTeamStats(homeId, leagueId, season),
    getTeamStats(awayId, leagueId, season),
  ]);

  const h2hRaw = apiFootballAllowed() ? await getH2H(homeId, awayId) : null;

  return {
    fixtureId:    fx.fixture?.id || null,
    homeFormData: homeStats ? {
      form:         homeStats.form || null,
      homeForm:     null,
      awayForm:     null,
      goalsFor:     homeStats.goalsFor,
      goalsAgainst: homeStats.goalsAgainst,
      games:        null,
    } : null,
    awayFormData: awayStats ? {
      form:         awayStats.form || null,
      homeForm:     null,
      awayForm:     null,
      goalsFor:     awayStats.goalsFor,
      goalsAgainst: awayStats.goalsAgainst,
      games:        null,
    } : null,
    h2hData: h2hRaw || null,
  };
}

module.exports = { getLeagueId, getUpcomingFixtures, apiFootballAllowed, enrichMatch };

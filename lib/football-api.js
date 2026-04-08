/**
 * football-api.js — Wrapper para API-Football (api-sports.io)
 * Free tier: 100 req/dia. Usa cache agressivo no SQLite para minimizar chamadas.
 */

const https = require('https');

const API_KEY  = process.env.API_SPORTS_KEY || process.env.APIFOOTBALL_KEY || '';
const BASE_URL = 'v3.football.api-sports.io';

// Cache global: suspensão detectada
let apiFootballSuspendedUntil = 0;
let _lastSuspendLogTs = 0;
const SUSPEND_TTL_MS = parseInt(process.env.APIFOOTBALL_SUSPEND_TTL_MS || '', 10) || (6 * 60 * 60 * 1000);
let _lastSkipBatchLogTs = 0;

// Cache em memória para sessão (complementar ao cache SQLite)
const memCache = new Map();
const MEM_TTL  = 30 * 60 * 1000; // 30min

function isSuspended() {
  return Date.now() < apiFootballSuspendedUntil;
}

function getApiFootballSuspendedUntil() {
  return apiFootballSuspendedUntil;
}

function _markSuspended(reason = '') {
  apiFootballSuspendedUntil = Date.now() + SUSPEND_TTL_MS;
  const now = Date.now();
  if (now - _lastSuspendLogTs > 60 * 1000) {
    _lastSuspendLogTs = now;
    const untilStr = new Date(apiFootballSuspendedUntil).toLocaleString('pt-BR');
    console.warn(`[FOOTBALL-API] Conta suspensa detectada. Desativando por ${Math.round(SUSPEND_TTL_MS/3600000)}h (até ${untilStr}). ${reason}`.trim());
  }
}

function _looksLikeSuspension(bodyText, parsedJson) {
  const hay = String(bodyText || '') + ' ' + JSON.stringify(parsedJson || {});
  const s = hay.toLowerCase();
  return s.includes('account suspended') || s.includes('suspended');
}

function apiFetch(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) { reject(new Error('API_SPORTS_KEY não configurada')); return; }
    if (isSuspended()) { reject(new Error('API-Football suspensa (cooldown ativo)')); return; }

    const cacheKey = endpoint + JSON.stringify(params);
    const cached = memCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < MEM_TTL) {
      resolve(cached.data); return;
    }

    const qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const path = `/v3/${endpoint}${qs ? '?' + qs : ''}`;

    const req = https.request({
      hostname: BASE_URL,
      path,
      method: 'GET',
      headers: {
        'x-rapidapi-key': API_KEY,
        'x-rapidapi-host': BASE_URL,
        'Accept': 'application/json'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d || '{}');

          // Suspensão conta: evitar spam/slowdown
          if (_looksLikeSuspension(d, json) || res.statusCode === 403) {
            _markSuspended((json?.message || '').toString());
            reject(new Error('API-Football: account suspended')); return;
          }

          if (json.errors && Object.keys(json.errors).length) {
            reject(new Error(JSON.stringify(json.errors))); return;
          }
          memCache.set(cacheKey, { data: json.response || [], ts: Date.now() });
          resolve(json.response || []);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('API-Football timeout')));
    req.end();
  });
}

// Ligas-alvo configuráveis via FOOTBALL_LEAGUES env (The Odds API keys separadas por vírgula)
// IDs correspondentes na API-Football:
const LEAGUE_MAP = {
  'soccer_brazil_campeonato': 71,
  'soccer_brazil_serie_b':    72,
  'soccer_brazil_serie_c':    73,
  'soccer_argentina_primera': 11,
  'soccer_spain_segunda_division': 141,
  // Alemanha
  'soccer_germany_3liga':     80,
  'soccer_germany_3_liga':    80,
  'soccer_england_league1':   41,
  'soccer_england_league2':   42,
  // França / Itália / Portugal / Holanda / Bélgica / Turquia / Suécia / Noruega
  'soccer_france_ligue_2':            62,
  'soccer_italy_serie_b':             135,
  'soccer_portugal_segunda_liga':     111,
  'soccer_netherlands_eerste_divisie': 88,
  'soccer_belgium_first_division_b':  144,
  'soccer_turkey_1_lig':              203,
  'soccer_sweden_superettan':         114,
  'soccer_norway_obos_ligaen':        104,
  'soccer_usa_mls':           253,
  'soccer_chile_primera_division': 265,
  'soccer_colombia_primera_a': 239,
  'soccer_uruguay_primera_division': 268
};

function getSeasonsToTry(dateISO = null) {
  // Plano free da API-Football limita temporadas (seu log: 2022–2024).
  // Override: FOOTBALL_API_SEASONS="2024,2023,2022"
  const env = (process.env.FOOTBALL_API_SEASONS || '').trim();
  if (env) {
    const parsed = env.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
    if (parsed.length) return parsed;
  }
  // Default seguro para free plan
  const baseYear = dateISO ? new Date(dateISO).getFullYear() : new Date().getFullYear();
  // tenta ano do jogo e volta até 2022, mas não passa de 2024
  const years = [];
  for (let y = Math.min(2024, baseYear); y >= 2022; y--) years.push(y);
  return years;
}

function getLeagueIds() {
  const configured = (process.env.FOOTBALL_LEAGUES || 'soccer_brazil_serie_b,soccer_brazil_serie_c')
    .split(',').map(s => s.trim()).filter(Boolean);
  return configured.map(k => LEAGUE_MAP[k]).filter(Boolean);
}

/**
 * Busca fixtures futuros (próximos 7 dias) para os IDs de liga configurados.
 * Retorna array de fixtures formatados.
 */
async function getUpcomingFixtures(season = new Date().getFullYear()) {
  const leagueIds = getLeagueIds();
  const dateFrom = new Date().toISOString().slice(0,10);
  const dateTo = new Date(Date.now() + 7 * 86400000).toISOString().slice(0,10);

  const results = await Promise.allSettled(
    leagueIds.map(id =>
      apiFetch('fixtures', { league: id, season, from: dateFrom, to: dateTo, timezone: 'America/Sao_Paulo' })
        .catch(e => {
          const msg = e?.message || '';
          if (msg.includes('requests') || msg.includes('exceeded') || msg.includes('rate')) {
            console.warn(`[FOOTBALL-API] Quota API-Football esgotada (liga ${id} season ${season}): ${msg}`);
          } else {
            console.warn(`[FOOTBALL-API] Erro buscando fixtures liga ${id} season ${season}: ${msg}`);
          }
          return [];
        })
    )
  );

  const fixtures = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const f of r.value) {
      const s = f.fixture?.status?.short;
      if (!['NS', 'TBD'].includes(s)) continue; // só não iniciados
      fixtures.push({
        id:       f.fixture.id,
        date:     f.fixture.date,
        venue:    f.fixture.venue?.name || '',
        city:     f.fixture.venue?.city || '',
        leagueId: f.league.id,
        league:   f.league.name,
        country:  f.league.country,
        round:    f.league.round || '',
        season:   f.league.season,
        home:     { id: f.teams.home.id, name: f.teams.home.name },
        away:     { id: f.teams.away.id, name: f.teams.away.name },
        goals:    f.goals  // null antes do jogo
      });
    }
  }
  return fixtures;
}

/**
 * Busca forma dos últimos N jogos de um time.
 */
async function getTeamForm(teamId, leagueId, season, last = 10) {
  const data = await apiFetch('fixtures', {
    team: teamId, league: leagueId, season, last,
    timezone: 'America/Sao_Paulo'
  });
  const form = [], homeForm = [], awayForm = [];
  let goalsFor = 0, goalsAgainst = 0, games = 0;

  for (const f of data) {
    if (!f.fixture?.status?.short?.match(/FT|AET|PEN/)) continue;
    const isHome = f.teams.home.id === teamId;
    const gf = isHome ? f.goals.home : f.goals.away;
    const ga = isHome ? f.goals.away : f.goals.home;
    if (gf === null || ga === null) continue;

    goalsFor     += gf;
    goalsAgainst += ga;
    games++;

    const result = gf > ga ? 'W' : gf === ga ? 'D' : 'L';
    form.push(result);
    if (isHome) homeForm.push(result);
    else        awayForm.push(result);
  }

  return {
    form,
    homeForm,
    awayForm,
    goalsFor:     games > 0 ? goalsFor / games : null,
    goalsAgainst: games > 0 ? goalsAgainst / games : null,
    games
  };
}

/**
 * Busca H2H entre dois times (últimos 10 confrontos).
 */
async function getH2H(homeId, awayId) {
  const data = await apiFetch('fixtures/headtohead', { h2h: `${homeId}-${awayId}`, last: 10 });
  const results = [];
  for (const f of data) {
    if (!f.fixture?.status?.short?.match(/FT|AET|PEN/)) continue;
    results.push({
      home:      f.teams.home.name,
      away:      f.teams.away.name,
      homeGoals: f.goals.home,
      awayGoals: f.goals.away,
      date:      f.fixture.date?.slice(0,10)
    });
  }
  return { results };
}

/**
 * Busca standings (posição na tabela) para a liga.
 */
async function getStandings(leagueId, season) {
  const data = await apiFetch('standings', { league: leagueId, season });
  const map = {};
  for (const group of data) {
    for (const entry of (group.league?.standings?.[0] || [])) {
      map[entry.team.id] = {
        position: entry.rank,
        points:   entry.points,
        played:   entry.all.played,
        won:      entry.all.win,
        drawn:    entry.all.draw,
        lost:     entry.all.lose,
        goalsFor: entry.all.goals.for,
        goalsAgainst: entry.all.goals.against,
        form:     (entry.form || '').split('').filter(Boolean) // ['W','D','L',...]
      };
    }
  }
  return map;
}

/**
 * Busca predições da API-Football para uma fixture.
 * (apenas disponível em planos pagos, mas tenta graciosamente)
 */
async function getPredictions(fixtureId) {
  try {
    const data = await apiFetch('predictions', { fixture: fixtureId });
    const pred = data[0]?.predictions;
    if (!pred) return null;
    return {
      winner:    pred.winner?.name || null,
      winOrDraw: pred.win_or_draw,
      advice:    pred.advice || null,
      percent:   pred.percent // { home, draw, away }
    };
  } catch(_) { return null; }
}

/**
 * Calcula dias desde o último jogo de um time (proxy de cansaço).
 */
async function getDaysSinceLastMatch(teamId) {
  try {
    const data = await apiFetch('fixtures', { team: teamId, last: 1 });
    if (!data.length) return 7;
    const lastDate = new Date(data[0].fixture.date);
    return Math.floor((Date.now() - lastDate.getTime()) / 86400000);
  } catch(_) { return 7; }
}

/**
 * Busca fixture + IDs dos times pelo nome e data.
 * Retorna { fixtureId, homeId, awayId, leagueId, season } ou null.
 * Usado tanto para settlement quanto para buscar form/standings com IDs reais.
 */
async function findFixtureWithTeams(homeTeam, awayTeam, dateISO) {
  try {
    const date = (dateISO || '').slice(0, 10);
    if (!date) return null;

    const leagueIds = getLeagueIds();
    const seasonsToTry = getSeasonsToTry(dateISO);
    const normStr = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

    for (const season of seasonsToTry) {
      for (const leagueId of leagueIds) {
        const fixtures = await apiFetch('fixtures', {
          league: leagueId, season, date, timezone: 'America/Sao_Paulo'
        }).catch(() => []);

        for (const f of fixtures) {
          const fHome = normStr(f.teams?.home?.name || '');
          const fAway = normStr(f.teams?.away?.name || '');
          const qHome = normStr(homeTeam);
          const qAway = normStr(awayTeam);
          if ((fHome.includes(qHome) || qHome.includes(fHome)) &&
              (fAway.includes(qAway) || qAway.includes(fAway))) {
            return {
              fixtureId: f.fixture.id,
              homeId:    f.teams.home.id,
              awayId:    f.teams.away.id,
              leagueId,
              season
            };
          }
        }
      }
    }
    return null;
  } catch(_) { return null; }
}

/** Compat: retorna só o fixtureId */
async function findFixtureId(homeTeam, awayTeam, dateISO) {
  const r = await findFixtureWithTeams(homeTeam, awayTeam, dateISO);
  return r?.fixtureId ?? null;
}

/**
 * Cache de fixtures da próxima semana por liga — carregado em batch uma vez por loop.
 * Evita N chamadas à API por partida (1 chamada por liga em vez de N×ligas×partidas).
 */
let _fixturesBatchCache = { data: [], ts: 0 };
const FIXTURES_BATCH_TTL = 6 * 60 * 60 * 1000; // 6h

async function getUpcomingFixturesCached() {
  // Evita spam quando conta suspensa
  if (isSuspended()) {
    const now = Date.now();
    if (now - _lastSkipBatchLogTs > 60 * 1000) {
      _lastSkipBatchLogTs = now;
      console.warn('[FOOTBALL-API] Suspensa: pulando batch cache fixtures');
    }
    return [];
  }
  if (Date.now() - _fixturesBatchCache.ts < FIXTURES_BATCH_TTL && _fixturesBatchCache.data.length) {
    return _fixturesBatchCache.data;
  }

  const seasons = getSeasonsToTry();
  const results = await Promise.all(seasons.map(y => getUpcomingFixtures(y).catch(() => [])));
  const combined = results.flat();
  if (combined.length) {
    _fixturesBatchCache = { data: combined, ts: Date.now() };
    console.info(`[FOOTBALL-API] Batch cache: ${combined.length} fixtures (seasons: ${seasons.join(',')})`);
  } else {
    console.warn(`[FOOTBALL-API] Batch cache vazio — possível quota esgotada ou seasons [${seasons.join(',')}] sem fixtures NS/TBD nas ligas configuradas`);
  }
  return combined;
}

/**
 * Busca fixture no batch pré-carregado — sem chamadas à API.
 * Retorna o mesmo formato que findFixtureWithTeams.
 */
function findInBatch(fixtures, homeTeam, awayTeam) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const qH = norm(homeTeam), qA = norm(awayTeam);
  const found = fixtures.find(f => {
    const fH = norm(f.home?.name), fA = norm(f.away?.name);
    const fwd = (fH.includes(qH) || qH.includes(fH)) && (fA.includes(qA) || qA.includes(fA));
    const rev = (fH.includes(qA) || qA.includes(fH)) && (fA.includes(qH) || qH.includes(fA));
    return fwd || rev;
  });
  if (!found) return null;
  return {
    fixtureId: found.id,
    homeId:    found.home.id,
    awayId:    found.away.id,
    leagueId:  found.leagueId,
    season:    found.season
  };
}

module.exports = {
  isSuspended,
  getApiFootballSuspendedUntil,
  getUpcomingFixtures,
  getUpcomingFixturesCached,
  findInBatch,
  getTeamForm,
  getH2H,
  getStandings,
  getPredictions,
  getDaysSinceLastMatch,
  findFixtureId,
  findFixtureWithTeams,
  getLeagueIds,
  LEAGUE_MAP
};

/**
 * football-api.js — Wrapper para API-Football (api-sports.io)
 * Free tier: 100 req/dia. Usa cache agressivo no SQLite para minimizar chamadas.
 */

const https = require('https');

const API_KEY  = process.env.API_SPORTS_KEY || process.env.APIFOOTBALL_KEY || '';
const BASE_URL = 'v3.football.api-sports.io';

// Cache em memória para sessão (complementar ao cache SQLite)
const memCache = new Map();
const MEM_TTL  = 30 * 60 * 1000; // 30min

function apiFetch(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) { reject(new Error('API_SPORTS_KEY não configurada')); return; }

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
          const json = JSON.parse(d);
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
  'soccer_germany_3liga':     80,
  'soccer_england_league1':   41,
  'soccer_england_league2':   42,
  'soccer_usa_mls':           253,
  'soccer_chile_primera_division': 265,
  'soccer_colombia_primera_a': 239,
  'soccer_uruguay_primera_division': 268
};

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
        .catch(() => [])
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
 * Busca fixture ID da API-Football pelo nome dos times e data aproximada.
 * Usado para associar tips (gravadas com ID da Odds API) ao fixture ID para settlement.
 * @param {string} homeTeam - nome do time da casa (Odds API)
 * @param {string} awayTeam - nome do time visitante (Odds API)
 * @param {string} dateISO  - data/hora ISO do jogo (Odds API)
 * @returns {number|null}   - fixture ID ou null se não encontrado
 */
async function findFixtureId(homeTeam, awayTeam, dateISO) {
  try {
    const date = (dateISO || '').slice(0, 10);
    if (!date) return null;

    const leagueIds = getLeagueIds();
    const season = new Date(dateISO).getFullYear();
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

    for (const leagueId of leagueIds) {
      const fixtures = await apiFetch('fixtures', {
        league: leagueId, season, date, timezone: 'America/Sao_Paulo'
      }).catch(() => []);

      for (const f of fixtures) {
        const fHome = norm(f.teams?.home?.name || '');
        const fAway = norm(f.teams?.away?.name || '');
        const qHome = norm(homeTeam);
        const qAway = norm(awayTeam);
        // Aceita match parcial (nomes podem diferir ligeiramente entre APIs)
        if ((fHome.includes(qHome) || qHome.includes(fHome)) &&
            (fAway.includes(qAway) || qAway.includes(fAway))) {
          return f.fixture.id;
        }
      }
    }
    return null;
  } catch(_) { return null; }
}

module.exports = {
  getUpcomingFixtures,
  getTeamForm,
  getH2H,
  getStandings,
  getPredictions,
  getDaysSinceLastMatch,
  findFixtureId,
  getLeagueIds,
  LEAGUE_MAP
};

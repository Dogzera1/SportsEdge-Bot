/**
 * football-data.js — Wrapper para football-data.org v4
 * Auth: header "X-Auth-Token"
 *
 * Docs: https://docs.football-data.org/ (quickstart em https://www.football-data.org/documentation/quickstart)
 */
const https = require('https');
const { URL } = require('url');

const TOKEN = process.env.FOOTBALL_DATA_TOKEN || process.env.FOOTBALL_DATA_KEY || '';
const BASE = 'https://api.football-data.org/v4';

const memCache = new Map();

function cacheGet(key) {
  const v = memCache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) { memCache.delete(key); return null; }
  return v.data;
}
function cacheSet(key, data, ttlMs) {
  memCache.set(key, { data, exp: Date.now() + ttlMs });
}

function httpGetJson(path, { ttlMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) { reject(new Error('FOOTBALL_DATA_TOKEN não configurado')); return; }
    const url = new URL(BASE + path);
    const cacheKey = url.toString();
    if (ttlMs > 0) {
      const cached = cacheGet(cacheKey);
      if (cached) { resolve(cached); return; }
    }
    const req = https.request(url, {
      method: 'GET',
      headers: { 'X-Auth-Token': TOKEN, 'Accept': 'application/json' },
      timeout: 12000
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`football-data HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(body || '{}');
          if (ttlMs > 0) cacheSet(cacheKey, json, ttlMs);
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('football-data timeout')));
    req.end();
  });
}

// Mapa TheOddsAPI league key -> football-data.org competition code
// Obs: coverage/free vs paid varia por competição.
const COMP_MAP = {
  'soccer_brazil_campeonato': 'BSA',
  'soccer_brazil_serie_b': 'BSB',
  'soccer_england_championship': 'ELC',
  'soccer_england_league1': 'EL1',
  'soccer_england_league2': 'EL2',
  'soccer_france_ligue_1': 'FL1',
  'soccer_france_ligue_2': 'FL2',
  'soccer_germany_bundesliga': 'BL1',
  'soccer_germany_2_bundesliga': 'BL2',
  'soccer_spain_la_liga': 'PD',
  'soccer_spain_segunda_division': 'SD',
  'soccer_italy_serie_a': 'SA',
  'soccer_italy_serie_b': 'SB',
  'soccer_portugal_primeira_liga': 'PPL',
  'soccer_portugal_segunda_liga': 'PPL', // fallback: muitas vezes 2ª não disponível; manter para não quebrar
  'soccer_netherlands_eredivisie': 'DED',
  'soccer_netherlands_eerste_divisie': 'DED', // fallback
};

function getCompetitionCode(leagueKey) {
  return COMP_MAP[leagueKey] || null;
}

function normTeam(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function findScheduledMatchByTeams(competitionCode, team1, team2, dateISO) {
  const date = (dateISO || '').slice(0, 10);
  if (!competitionCode || !date) return null;
  const q1 = normTeam(team1);
  const q2 = normTeam(team2);
  const data = await httpGetJson(`/competitions/${competitionCode}/matches?dateFrom=${date}&dateTo=${date}&status=SCHEDULED`, { ttlMs: 10 * 60 * 1000 });
  const matches = data?.matches || [];
  const m = matches.find(x => {
    const h = normTeam(x?.homeTeam?.name);
    const a = normTeam(x?.awayTeam?.name);
    const fwd = (h.includes(q1) || q1.includes(h)) && (a.includes(q2) || q2.includes(a));
    const rev = (h.includes(q2) || q2.includes(h)) && (a.includes(q1) || q1.includes(a));
    return fwd || rev;
  });
  if (!m) return null;
  return {
    matchId: m.id,
    competitionCode,
    competitionId: m.competition?.id || null,
    homeId: m.homeTeam?.id || null,
    awayId: m.awayTeam?.id || null,
    seasonStartYear: m.season?.startDate ? parseInt(String(m.season.startDate).slice(0, 4), 10) : null,
    homeName: m.homeTeam?.name || null,
    awayName: m.awayTeam?.name || null,
  };
}

async function getStandings(competitionCode) {
  if (!competitionCode) return null;
  const data = await httpGetJson(`/competitions/${competitionCode}/standings`, { ttlMs: 60 * 60 * 1000 });
  const table = data?.standings?.[0]?.table || [];
  const map = {};
  for (const row of table) {
    const id = row.team?.id;
    if (!id) continue;
    map[id] = {
      position: row.position,
      points: row.points,
      played: row.playedGames,
      won: row.won,
      drawn: row.draw,
      lost: row.lost,
      goalsFor: row.goalsFor,
      goalsAgainst: row.goalsAgainst,
      form: (row.form || '').split(',').map(s => s.trim()[0]).filter(Boolean) // "W,L,D"
    };
  }
  return map;
}

async function getTeamRecentForm(teamId, { competitionId = null, limit = 10 } = {}) {
  if (!teamId) return null;
  const comps = competitionId ? `&competitions=${competitionId}` : '';
  const data = await httpGetJson(`/teams/${teamId}/matches?status=FINISHED&limit=${limit}${comps}`, { ttlMs: 30 * 60 * 1000 });
  const matches = data?.matches || [];
  const form = [];
  let gf = 0, ga = 0, games = 0;
  for (const m of matches) {
    const hs = m?.score?.fullTime?.home;
    const as = m?.score?.fullTime?.away;
    if (hs == null || as == null) continue;
    const isHome = m?.homeTeam?.id === teamId;
    const gfor = isHome ? hs : as;
    const gag  = isHome ? as : hs;
    gf += gfor; ga += gag; games++;
    form.push(gfor > gag ? 'W' : gfor === gag ? 'D' : 'L');
  }
  return {
    form,
    homeForm: null,
    awayForm: null,
    goalsFor: games ? gf / games : null,
    goalsAgainst: games ? ga / games : null,
    games
  };
}

async function getHeadToHead(matchId, { limit = 10 } = {}) {
  if (!matchId) return { results: [] };
  const data = await httpGetJson(`/matches/${matchId}/head2head?limit=${limit}`, { ttlMs: 6 * 60 * 60 * 1000 });
  const matches = data?.matches || [];
  const results = [];
  for (const m of matches) {
    const hs = m?.score?.fullTime?.home;
    const as = m?.score?.fullTime?.away;
    if (hs == null || as == null) continue;
    results.push({
      home: m?.homeTeam?.name || '',
      away: m?.awayTeam?.name || '',
      homeGoals: hs,
      awayGoals: as,
      date: (m?.utcDate || '').slice(0, 10)
    });
  }
  return { results };
}

module.exports = {
  getCompetitionCode,
  findScheduledMatchByTeams,
  getStandings,
  getTeamRecentForm,
  getHeadToHead,
};


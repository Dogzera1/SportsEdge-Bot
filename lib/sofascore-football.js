/**
 * Enriquecimento de futebol via API não oficial Sofascore (documentação:
 * https://github.com/pseudo-r/Public-Sofascore-API ).
 *
 * Env:
 * - SOFASCORE_PROXY_BASE — URL do prefixo `/api/v1/sofascore` do proxy Django (ex.: http://127.0.0.1:8000/api/v1/sofascore).
 *   Sem isso, Node costuma levar 403 em api.sofascore.com.
 * - SOFASCORE_DIRECT=true — tenta api.sofascore.com mesmo assim (só ajuda em hosts “confiáveis”).
 * - SOFASCORE_ENRICH_FOOTBALL — default: ligado se SOFASCORE_PROXY_BASE existir; senão desligado (use `true` para forçar).
 *
 * Rotas usadas no proxy: `/schedule/football/{date}/`, `/event/{id}/h2h`, `/team/{id}/events/last/0`.
 * O README oficial do proxy só lista schedule/event/team; pode ser preciso estender o Django para h2h/last.
 */
const { safeParse, cachedHttpGet } = require('./utils');

const BROWSER_HEADERS = {
  Accept: 'application/json,text/plain,*/*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Origin: 'https://www.sofascore.com',
  Referer: 'https://www.sofascore.com/'
};

function normTeam(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function teamsMatchEvent(homeName, awayName, t1, t2) {
  const h = normTeam(homeName);
  const a = normTeam(awayName);
  const q1 = normTeam(t1);
  const q2 = normTeam(t2);
  if (!h || !a || !q1 || !q2) return false;
  const fwd = (h.includes(q1) || q1.includes(h)) && (a.includes(q2) || q2.includes(a));
  const rev = (h.includes(q2) || q2.includes(h)) && (a.includes(q1) || q1.includes(a));
  return fwd || rev;
}

function _scoreCurrent(ev, side) {
  const o = side === 'home' ? ev?.homeScore : ev?.awayScore;
  if (o == null) return null;
  if (typeof o === 'number') return o;
  if (o.current != null) return o.current;
  if (o.display != null) return parseInt(String(o.display), 10);
  if (o.normaltime?.current != null) return o.normaltime.current;
  return null;
}

function resultLetterForTeam(ev, teamId) {
  const hid = ev?.homeTeam?.id;
  const aid = ev?.awayTeam?.id;
  const hs = _scoreCurrent(ev, 'home');
  const as = _scoreCurrent(ev, 'away');
  if (hs == null || as == null || !teamId) return null;
  const isHome = hid === teamId;
  const isAway = aid === teamId;
  if (!isHome && !isAway) return null;
  if (hs > as) return isHome ? 'W' : 'L';
  if (as > hs) return isAway ? 'W' : 'L';
  return 'D';
}

function collectEventsFromSchedulePayload(data) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x);
      return;
    }
    if (node.homeTeam && node.awayTeam && node.id != null) {
      out.push(node);
      return;
    }
    for (const k of Object.keys(node)) visit(node[k]);
  };
  visit(data);
  return out;
}

function buildUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

async function httpJson(url, { ttlMs = 5 * 60 * 1000, provider = 'sofascore' } = {}) {
  const r = await cachedHttpGet(url, {
    ttlMs,
    provider,
    headers: BROWSER_HEADERS,
    cacheKey: `sofascore:${url}`
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  return safeParse(r.body, null);
}

function _directEnabled() {
  const v = String(process.env.SOFASCORE_DIRECT || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function scheduleUrlsForDate(isoDate) {
  const d = String(isoDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return [];
  const proxy = (process.env.SOFASCORE_PROXY_BASE || '').trim().replace(/\/+$/, '');
  const direct = _directEnabled();
  const urls = [];
  if (proxy) {
    urls.push(buildUrl(proxy, `/schedule/football/${d}/`));
    urls.push(buildUrl(proxy, `/schedule/football/${d}`));
  }
  if (direct) {
    urls.push(`https://api.sofascore.com/api/v1/sport/football/scheduled-events/${d}`);
    urls.push(`https://api.sofascore.app/api/v1/sport/football/scheduled-events/${d}`);
  }
  return [...new Set(urls)];
}

function eventH2hUrls(eventId) {
  const id = parseInt(String(eventId), 10);
  if (!Number.isFinite(id)) return [];
  const proxy = (process.env.SOFASCORE_PROXY_BASE || '').trim().replace(/\/+$/, '');
  const direct = _directEnabled();
  const urls = [];
  if (proxy) {
    urls.push(buildUrl(proxy, `/event/${id}/h2h/`));
    urls.push(buildUrl(proxy, `/event/${id}/h2h`));
  }
  if (direct) {
    urls.push(`https://api.sofascore.com/api/v1/event/${id}/h2h`);
    urls.push(`https://api.sofascore.app/api/v1/event/${id}/h2h`);
  }
  return [...new Set(urls)];
}

function teamEventsUrls(teamId) {
  const id = parseInt(String(teamId), 10);
  if (!Number.isFinite(id)) return [];
  const proxy = (process.env.SOFASCORE_PROXY_BASE || '').trim().replace(/\/+$/, '');
  const direct = _directEnabled();
  const urls = [];
  if (proxy) {
    urls.push(buildUrl(proxy, `/team/${id}/events/last/0`));
  }
  if (direct) {
    urls.push(`https://api.sofascore.com/api/v1/team/${id}/events/last/0`);
    urls.push(`https://api.sofascore.app/api/v1/team/${id}/events/last/0`);
  }
  return [...new Set(urls)];
}

async function fetchFirstJson(urlList) {
  for (const u of urlList) {
    const j = await httpJson(u, { ttlMs: 3 * 60 * 1000 }).catch(() => null);
    if (j) return j;
  }
  return null;
}

function collectH2hEvents(data) {
  if (!data || typeof data !== 'object') return [];
  const out = [];
  const pushArr = a => { if (Array.isArray(a)) for (const x of a) out.push(x); };
  pushArr(data.events);
  pushArr(data?.h2h?.events);
  pushArr(data?.teamDuel?.events);
  pushArr(data?.duels?.[0]?.events);
  if (out.length) return out;
  return collectEventsFromSchedulePayload(data);
}

function parseH2hToResults(h2hJson) {
  const events = collectH2hEvents(h2hJson);
  const results = [];
  for (const ev of events) {
    const hs = _scoreCurrent(ev, 'home');
    const as = _scoreCurrent(ev, 'away');
    if (hs == null || as == null) continue;
    results.push({
      home: ev?.homeTeam?.name || '',
      away: ev?.awayTeam?.name || '',
      homeGoals: hs,
      awayGoals: as,
      date: (ev?.startTimestamp
        ? new Date(ev.startTimestamp * 1000).toISOString()
        : (ev?.time?.start || ev?.startDate || '')).slice(0, 10)
    });
    if (results.length >= 10) break;
  }
  return { results };
}

function formFromTeamEvents(json, teamId) {
  const events = json?.events || json?.results || [];
  const form = [];
  let gf = 0;
  let ga = 0;
  let games = 0;
  for (const ev of events) {
    const letter = resultLetterForTeam(ev, teamId);
    if (!letter) continue;
    form.push(letter);
    const hid = ev?.homeTeam?.id;
    const hs = _scoreCurrent(ev, 'home');
    const as = _scoreCurrent(ev, 'away');
    if (hs == null || as == null) continue;
    const isHome = hid === teamId;
    gf += isHome ? hs : as;
    ga += isHome ? as : hs;
    games++;
    if (form.length >= 10) break;
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

/**
 * @param {string} team1 - mandante (Odds API)
 * @param {string} team2 - visitante
 * @param {string} commenceIso - ISO commence_time
 * @returns {Promise<null|{ homeFormData, awayFormData, h2hData, eventId, homeTeamId, awayTeamId }>}
 */
async function enrichMatch(team1, team2, commenceIso) {
  const hasProxy = !!(process.env.SOFASCORE_PROXY_BASE || '').trim();
  const envFb = String(process.env.SOFASCORE_ENRICH_FOOTBALL || '').toLowerCase();
  const enabled = envFb === 'true' || envFb === '1' || envFb === 'yes'
    || (envFb !== 'false' && envFb !== '0' && envFb !== 'no' && hasProxy);
  if (!enabled) return null;

  const d0 = String(commenceIso || '').slice(0, 10);
  const dates = new Set();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d0)) {
    dates.add(d0);
    try {
      const t = new Date(commenceIso);
      const prev = new Date(t);
      prev.setUTCDate(prev.getUTCDate() - 1);
      dates.add(prev.toISOString().slice(0, 10));
      const next = new Date(t);
      next.setUTCDate(next.getUTCDate() + 1);
      dates.add(next.toISOString().slice(0, 10));
    } catch (_) {}
  }
  if (!dates.size) return null;

  let found = null;
  for (const d of dates) {
    const urls = scheduleUrlsForDate(d);
    const json = await fetchFirstJson(urls);
    if (!json) continue;
    const events = collectEventsFromSchedulePayload(json);
    for (const ev of events) {
      const hname = ev?.homeTeam?.name || ev?.homeTeam?.shortName || '';
      const aname = ev?.awayTeam?.name || ev?.awayTeam?.shortName || '';
      if (!teamsMatchEvent(hname, aname, team1, team2)) continue;
      found = {
        eventId: ev.id,
        homeTeamId: ev.homeTeam?.id,
        awayTeamId: ev.awayTeam?.id,
        homeName: hname,
        awayName: aname
      };
      break;
    }
    if (found) break;
  }
  if (!found?.eventId || !found.homeTeamId || !found.awayTeamId) return null;

  const h2hUrls = eventH2hUrls(found.eventId);
  const h2hJson = await fetchFirstJson(h2hUrls);
  const h2hData = h2hJson ? parseH2hToResults(h2hJson) : { results: [] };

  const [homeJson, awayJson] = await Promise.all([
    fetchFirstJson(teamEventsUrls(found.homeTeamId)),
    fetchFirstJson(teamEventsUrls(found.awayTeamId))
  ]);

  const homeFormData = homeJson ? formFromTeamEvents(homeJson, found.homeTeamId) : null;
  const awayFormData = awayJson ? formFromTeamEvents(awayJson, found.awayTeamId) : null;

  const hasAny = (homeFormData?.form?.length || awayFormData?.form?.length || h2hData.results.length);
  if (!hasAny) return null;

  return {
    homeFormData,
    awayFormData,
    h2hData,
    eventId: found.eventId,
    homeTeamId: found.homeTeamId,
    awayTeamId: found.awayTeamId
  };
}

module.exports = { enrichMatch, normTeam, teamsMatchEvent };

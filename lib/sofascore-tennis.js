/**
 * sofascore-tennis.js — Enriquecimento de tênis via proxy Sofascore.
 *
 * Env:
 * - SOFASCORE_PROXY_BASE   — URL do proxy (ex: https://xxx.ngrok-free.app/api/v1/sofascore)
 * - SOFASCORE_DIRECT=true  — tenta api.sofascore.com direto (só em hosts confiáveis)
 * - SOFASCORE_ENRICH_TENNIS — default: ligado se proxy existir
 */
const { safeParse, cachedHttpGet } = require('./utils');

const BROWSER_HEADERS = {
  Accept: 'application/json,text/plain,*/*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Origin: 'https://www.sofascore.com',
  Referer: 'https://www.sofascore.com/',
  'ngrok-skip-browser-warning': 'true'
};

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function lastName(s) {
  const tokens = String(s || '').trim().split(/\s+/).filter(Boolean);
  return tokens.length ? tokens[tokens.length - 1] : '';
}

function namesMatch(evName, query) {
  const a = normName(evName);
  const b = normName(query);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  // fallback: sobrenome
  const la = normName(lastName(evName));
  const lb = normName(lastName(query));
  return la.length >= 4 && la === lb;
}

function _directEnabled() {
  const v = String(process.env.SOFASCORE_DIRECT || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function buildUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function scheduleUrls(isoDate) {
  const d = String(isoDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return [];
  const proxy = (process.env.SOFASCORE_PROXY_BASE || '').trim().replace(/\/+$/, '');
  const urls = [];
  if (proxy) urls.push(buildUrl(proxy, `/schedule/tennis/${d}/`));
  if (_directEnabled()) urls.push(`https://api.sofascore.com/api/v1/sport/tennis/scheduled-events/${d}`);
  return [...new Set(urls)];
}

function eventH2hUrls(id) {
  const n = parseInt(String(id), 10);
  if (!Number.isFinite(n)) return [];
  const proxy = (process.env.SOFASCORE_PROXY_BASE || '').trim().replace(/\/+$/, '');
  const urls = [];
  if (proxy) urls.push(buildUrl(proxy, `/event/${n}/h2h/`));
  if (_directEnabled()) urls.push(`https://api.sofascore.com/api/v1/event/${n}/h2h`);
  return [...new Set(urls)];
}

function teamEventsUrls(id) {
  const n = parseInt(String(id), 10);
  if (!Number.isFinite(n)) return [];
  const proxy = (process.env.SOFASCORE_PROXY_BASE || '').trim().replace(/\/+$/, '');
  const urls = [];
  if (proxy) urls.push(buildUrl(proxy, `/team/${n}/events/last/0`));
  if (_directEnabled()) urls.push(`https://api.sofascore.com/api/v1/team/${n}/events/last/0`);
  return [...new Set(urls)];
}

async function httpJson(url, { ttlMs = 10 * 60 * 1000 } = {}) {
  const r = await cachedHttpGet(url, {
    ttlMs, provider: 'sofascore', headers: BROWSER_HEADERS,
    cacheKey: `sofascore-tennis:${url}`
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  return safeParse(r.body, null);
}

async function fetchFirstJson(urls) {
  for (const u of urls) {
    const j = await httpJson(u).catch(() => null);
    if (j) return j;
  }
  return null;
}

function collectEvents(data) {
  const out = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) visit(x); return; }
    if (node.homeTeam && node.awayTeam && node.id != null) { out.push(node); return; }
    for (const k of Object.keys(node)) visit(node[k]);
  };
  visit(data);
  return out;
}

function resultLetterForPlayer(ev, playerId) {
  const hid = ev?.homeTeam?.id;
  const aid = ev?.awayTeam?.id;
  if (!playerId) return null;
  const wc = ev?.winnerCode; // 1=home, 2=away, 3=draw
  if (wc === 1) return hid === playerId ? 'W' : aid === playerId ? 'L' : null;
  if (wc === 2) return aid === playerId ? 'W' : hid === playerId ? 'L' : null;
  return null;
}

function formFromPlayerEvents(json, playerId, limit = 15) {
  const events = json?.events || json?.results || [];
  const recent = [];
  let wins = 0, losses = 0;
  for (const ev of events) {
    const letter = resultLetterForPlayer(ev, playerId);
    if (!letter) continue;
    recent.push(letter);
    if (letter === 'W') wins++;
    else if (letter === 'L') losses++;
    if (recent.length >= limit) break;
  }
  const total = wins + losses;
  if (!total) return null;
  return {
    wins, losses,
    winRate: Math.round((wins / total) * 100),
    recent,
    streak: _streak(recent),
  };
}

function _streak(recent) {
  if (!recent?.length) return 0;
  const first = recent[0];
  let n = 0;
  for (const r of recent) {
    if (r === first) n++; else break;
  }
  return first === 'W' ? n : -n;
}

function h2hFromJson(data, player1Id, player2Id) {
  const events = [];
  const push = arr => { if (Array.isArray(arr)) for (const x of arr) events.push(x); };
  push(data?.events);
  push(data?.h2h?.events);
  push(data?.teamDuel?.events);
  push(data?.duels?.[0]?.events);

  let t1Wins = 0, t2Wins = 0;
  for (const ev of events) {
    const wc = ev?.winnerCode;
    const hid = ev?.homeTeam?.id;
    const aid = ev?.awayTeam?.id;
    if (wc === 1) {
      if (hid === player1Id) t1Wins++;
      else if (hid === player2Id) t2Wins++;
    } else if (wc === 2) {
      if (aid === player1Id) t1Wins++;
      else if (aid === player2Id) t2Wins++;
    }
  }
  const totalMatches = t1Wins + t2Wins;
  return { t1Wins, t2Wins, totalMatches };
}

/**
 * @param {string} p1 - nome do jogador 1 (na Odds API)
 * @param {string} p2 - nome do jogador 2
 * @param {string} commenceIso
 * @returns {Promise<null|{ form1, form2, h2h, eventId, player1Id, player2Id, surface, tournament }>}
 */
async function enrichMatch(p1, p2, commenceIso) {
  const hasProxy = !!(process.env.SOFASCORE_PROXY_BASE || '').trim();
  const env = String(process.env.SOFASCORE_ENRICH_TENNIS || '').toLowerCase();
  const enabled = env === 'true' || env === '1' || env === 'yes'
    || (env !== 'false' && env !== '0' && env !== 'no' && hasProxy);
  if (!enabled) return null;

  const d0 = String(commenceIso || '').slice(0, 10);
  const dates = new Set();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d0)) {
    dates.add(d0);
    try {
      const t = new Date(commenceIso);
      const prev = new Date(t); prev.setUTCDate(prev.getUTCDate() - 1);
      dates.add(prev.toISOString().slice(0, 10));
      const next = new Date(t); next.setUTCDate(next.getUTCDate() + 1);
      dates.add(next.toISOString().slice(0, 10));
    } catch (_) {}
  }
  if (!dates.size) return null;

  let found = null;
  for (const d of dates) {
    const json = await fetchFirstJson(scheduleUrls(d));
    if (!json) continue;
    const events = collectEvents(json);
    for (const ev of events) {
      const hn = ev?.homeTeam?.name || ev?.homeTeam?.shortName || '';
      const an = ev?.awayTeam?.name || ev?.awayTeam?.shortName || '';
      const fwd = namesMatch(hn, p1) && namesMatch(an, p2);
      const rev = namesMatch(hn, p2) && namesMatch(an, p1);
      if (!fwd && !rev) continue;
      found = {
        eventId: ev.id,
        player1Id: fwd ? ev.homeTeam?.id : ev.awayTeam?.id,
        player2Id: fwd ? ev.awayTeam?.id : ev.homeTeam?.id,
        surface: ev?.groundType || ev?.tournament?.groundType || null,
        tournament: ev?.tournament?.name || null,
      };
      break;
    }
    if (found) break;
  }
  if (!found?.eventId || !found.player1Id || !found.player2Id) return null;

  const [h2hJson, p1Events, p2Events] = await Promise.all([
    fetchFirstJson(eventH2hUrls(found.eventId)),
    fetchFirstJson(teamEventsUrls(found.player1Id)),
    fetchFirstJson(teamEventsUrls(found.player2Id)),
  ]);

  const form1 = p1Events ? formFromPlayerEvents(p1Events, found.player1Id) : null;
  const form2 = p2Events ? formFromPlayerEvents(p2Events, found.player2Id) : null;
  const h2h = h2hJson ? h2hFromJson(h2hJson, found.player1Id, found.player2Id) : { t1Wins: 0, t2Wins: 0, totalMatches: 0 };

  if (!form1 && !form2 && !h2h.totalMatches) return null;

  return {
    form1, form2, h2h,
    eventId: found.eventId,
    player1Id: found.player1Id,
    player2Id: found.player2Id,
    surface: found.surface,
    tournament: found.tournament,
  };
}

function eventStatsUrls(id) {
  const n = parseInt(String(id), 10);
  if (!Number.isFinite(n)) return [];
  const proxy = (process.env.SOFASCORE_PROXY_BASE || '').trim().replace(/\/+$/, '');
  const urls = [];
  if (proxy) urls.push(buildUrl(proxy, `/event/${n}/statistics`));
  if (_directEnabled()) urls.push(`https://api.sofascore.com/api/v1/event/${n}/statistics`);
  return [...new Set(urls)];
}

/**
 * Extrai stats agregadas de serve/return dos últimos N matches finished de um jogador.
 * Útil para identificar especialistas (saibro com saque fraco, etc.).
 *
 * Agregados retornados:
 *   - firstServePct: % de 1º saques dentro (média)
 *   - firstServePointsPct: % de pontos ganhos no 1º saque
 *   - secondServePointsPct: % de pontos ganhos no 2º saque
 *   - breakPointsSavedPct: defesa de break points
 *   - breakPointsConvertedPct: conversão em break points
 *   - acesPerMatch, dfsPerMatch
 *   - sample: N matches agregados
 *
 * @returns {Promise<object | null>}
 */
async function getPlayerServeStats(playerId, maxGames = 5) {
  const n = parseInt(String(playerId), 10);
  if (!Number.isFinite(n)) return null;
  const json = await fetchFirstJson(teamEventsUrls(n));
  if (!json?.events) return null;
  const finished = json.events.filter(e => e?.status?.type === 'finished').slice(0, maxGames);
  if (!finished.length) return null;

  const acc = {
    firstServe: { made: 0, total: 0 },
    firstServePoints: { made: 0, total: 0 },
    secondServePoints: { made: 0, total: 0 },
    breakPointsSaved: { made: 0, total: 0 },
    breakPointsConverted: { made: 0, total: 0 },
    aces: 0,
    dfs: 0,
    games: 0,
  };

  for (const ev of finished) {
    const isHome = ev?.homeTeam?.id === n;
    const stats = await fetchFirstJson(eventStatsUrls(ev.id)).catch(() => null);
    const periods = stats?.statistics || [];
    const all = periods.find(p => p.period === 'ALL');
    if (!all?.groups) continue;
    for (const grp of all.groups) {
      for (const it of (grp.statisticsItems || [])) {
        const v = isHome ? { value: it.homeValue, total: it.homeTotal } : { value: it.awayValue, total: it.awayTotal };
        if (!Number.isFinite(v.value)) continue;
        switch (it.key) {
          case 'firstServeAccuracy':
            if (Number.isFinite(v.total)) { acc.firstServe.made += v.value; acc.firstServe.total += v.total; }
            break;
          case 'firstServePointsAccuracy':
            if (Number.isFinite(v.total)) { acc.firstServePoints.made += v.value; acc.firstServePoints.total += v.total; }
            break;
          case 'secondServePointsAccuracy':
            if (Number.isFinite(v.total)) { acc.secondServePoints.made += v.value; acc.secondServePoints.total += v.total; }
            break;
          case 'breakPointsSaved':
            if (Number.isFinite(v.total)) { acc.breakPointsSaved.made += v.value; acc.breakPointsSaved.total += v.total; }
            break;
          case 'breakPointsConversion':
            if (Number.isFinite(v.total)) { acc.breakPointsConverted.made += v.value; acc.breakPointsConverted.total += v.total; }
            break;
          case 'aces': acc.aces += v.value; break;
          case 'doubleFaults': acc.dfs += v.value; break;
        }
      }
    }
    acc.games++;
  }

  if (!acc.games) return null;
  const pct = o => o.total > 0 ? Math.round((o.made / o.total) * 100) : null;
  return {
    games: acc.games,
    firstServePct: pct(acc.firstServe),
    firstServePointsPct: pct(acc.firstServePoints),
    secondServePointsPct: pct(acc.secondServePoints),
    breakPointsSavedPct: pct(acc.breakPointsSaved),
    breakPointsConvertedPct: pct(acc.breakPointsConverted),
    acesPerMatch: +(acc.aces / acc.games).toFixed(1),
    dfsPerMatch: +(acc.dfs / acc.games).toFixed(1),
  };
}

module.exports = { enrichMatch, getPlayerServeStats, namesMatch };

/**
 * sofascore-darts.js — Wrapper Sofascore para darts (PDC + variantes).
 *
 * Fornece:
 *  - listLiveAndUpcoming(daysAhead)  → eventos com odds H2H disponíveis
 *  - getOdds(eventId)                → { t1, t2, bookmaker }
 *  - getStats(eventId)               → { avg3dartsHome, avg3dartsAway, t180sH, t180sA, ... }
 *  - getPlayerRecentAvg(playerId)    → média 3-dart dos últimos N jogos (rolling 10)
 *
 * Config via env:
 *  - SOFASCORE_PROXY_BASE   — URL do Public-Sofascore-API
 *  - SOFASCORE_DIRECT=true  — permite chamar api.sofascore.com direto
 */
const { safeParse, cachedHttpGet, log } = require('./utils');

const BROWSER_HEADERS = {
  Accept: 'application/json,text/plain,*/*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Origin: 'https://www.sofascore.com',
  Referer: 'https://www.sofascore.com/',
  'ngrok-skip-browser-warning': 'true'
};

// Torneios PDC aceitos por default. Config via DARTS_TOURNAMENT_WHITELIST=pdc,modus,...
const DEFAULT_PDC_SLUGS = [
  'pdc-world-championship', 'premier-league-darts', 'world-matchplay',
  'world-grand-prix', 'uk-open', 'players-championship', 'european-tour',
  'grand-slam', 'world-series-finals', 'masters', 'world-cup',
  'european-championship', 'nordic-darts', 'bahrain-darts',
  'us-darts-masters', 'international-open', 'super-series', 'modus',
  'pdc', 'champions-league', 'czech-darts-open', 'austrian-darts-open',
  'german-darts-open', 'dutch-darts', 'hungarian-darts', 'belgian-darts',
  'baltic-sea-darts', 'world-series', 'finals'
];

// Sofascore bloqueia Node.js diretamente (TLS fingerprint + Cloudflare).
// O proxy Public-Sofascore-API (Django + curl_cffi) bypassa o WAF — é ESSENCIAL.
// Direct access só funciona com ferramentas tipo curl; no Node sempre dá 403.
function _directEnabled() {
  const v = String(process.env.SOFASCORE_DIRECT || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function _buildUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

// Mapeia paths Sofascore nativos → rotas do proxy Django
// api.sofascore.com/api/v1/sport/darts/events/live → proxy/sport/darts/live/
// api.sofascore.com/api/v1/event/{id}/odds/1/all    → proxy/event/{id}/odds/
// api.sofascore.com/api/v1/event/{id}/statistics    → proxy/event/{id}/statistics/
function _toProxyPath(nativePath) {
  // /sport/darts/events/live → /sport/darts/live/
  const m1 = nativePath.match(/^\/sport\/([^/]+)\/events\/live\/?$/);
  if (m1) return `/sport/${m1[1]}/live/`;
  // /event/{id}/odds/1/all → /event/{id}/odds/
  const m2 = nativePath.match(/^\/event\/([^/]+)\/odds\/1\/all\/?$/);
  if (m2) return `/event/${m2[1]}/odds/`;
  // /event/{id}/statistics → /event/{id}/statistics/
  const m3 = nativePath.match(/^\/event\/([^/]+)\/statistics\/?$/);
  if (m3) return `/event/${m3[1]}/statistics/`;
  // /sport/darts/scheduled-events/{date} → /schedule/darts/{date}/
  const m4 = nativePath.match(/^\/sport\/([^/]+)\/scheduled-events\/([^/]+)\/?$/);
  if (m4) return `/schedule/${m4[1]}/${m4[2]}/`;
  // /team/{id}/events/last/{page} → /team/{id}/events/last/{page}/
  const m5 = nativePath.match(/^\/team\/([^/]+)\/events\/last\/([^/]+)\/?$/);
  if (m5) return `/team/${m5[1]}/events/last/${m5[2]}/`;
  // Fallback: passa o path como está (proxy aceita /event/{id}/, /team/{id}/)
  return nativePath.endsWith('/') ? nativePath : nativePath + '/';
}

function _urls(path) {
  const proxy = (process.env.SOFASCORE_PROXY_BASE || '').trim().replace(/\/+$/, '');
  const urls = [];
  if (proxy) urls.push(_buildUrl(proxy, _toProxyPath(path)));
  if (_directEnabled()) urls.push(`https://api.sofascore.com/api/v1${path}`);
  return [...new Set(urls)];
}

async function _httpJson(url, { ttlMs = 5 * 60 * 1000 } = {}) {
  const r = await cachedHttpGet(url, {
    ttlMs, provider: 'sofascore', headers: BROWSER_HEADERS,
    cacheKey: `sofascore-darts:${url}`
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  return safeParse(r.body, null);
}

async function _fetchFirstJson(paths, opts) {
  for (const path of paths) {
    for (const u of _urls(path)) {
      const j = await _httpJson(u, opts).catch(() => null);
      if (j) return j;
    }
  }
  return null;
}

function _isWhitelisted(tournament) {
  const raw = process.env.DARTS_TOURNAMENT_WHITELIST;
  const list = raw
    ? raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_PDC_SLUGS;
  const slug = (tournament?.uniqueTournament?.slug || tournament?.slug || '').toLowerCase();
  const name = (tournament?.uniqueTournament?.name || tournament?.name || '').toLowerCase();
  return list.some(k => slug.includes(k) || name.includes(k.replace(/-/g, ' ')));
}

function _fractionalToDecimal(frac) {
  if (frac == null) return null;
  const s = String(frac).trim();
  if (/^\d+\.?\d*$/.test(s)) {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  }
  const m = s.match(/^(\d+)\/(\d+)$/);
  if (!m) return null;
  const num = parseInt(m[1], 10), den = parseInt(m[2], 10);
  if (!den) return null;
  return +(num / den + 1).toFixed(3);
}

// ── Lista de eventos (live + próximos) ──────────────────────────────────────
async function listLiveAndUpcoming() {
  const liveJson = await _fetchFirstJson(['/sport/darts/events/live']);
  const live = Array.isArray(liveJson?.events) ? liveJson.events : [];

  // Próximas 48h — concatena hoje + amanhã + depois
  const today = new Date();
  const dayStrs = [0, 1, 2].map(d => {
    const x = new Date(today.getTime() + d * 86400000);
    return x.toISOString().slice(0, 10);
  });
  const upcoming = [];
  for (const d of dayStrs) {
    const j = await _fetchFirstJson([`/sport/darts/scheduled-events/${d}`]);
    if (Array.isArray(j?.events)) upcoming.push(...j.events);
  }

  const total = live.length + upcoming.length;
  // Merge (dedupe por id) + filtra status + whitelist
  const byId = new Map();
  let filteredByWhitelist = 0;
  let filteredByStatus = 0;
  for (const ev of [...live, ...upcoming]) {
    const id = ev?.id;
    if (!id) continue;
    if (!_isWhitelisted(ev.tournament)) { filteredByWhitelist++; continue; }
    const status = ev?.status?.type || '';
    if (status === 'finished' || status === 'canceled' || status === 'postponed') { filteredByStatus++; continue; }
    byId.set(id, ev);
  }
  log('INFO', 'SOFA-DARTS', `eventos: total=${total} live=${live.length} upcoming=${upcoming.length} → aceitos=${byId.size} (removidos: whitelist=${filteredByWhitelist} status=${filteredByStatus})`);
  return [...byId.values()];
}

// ── Odds H2H ────────────────────────────────────────────────────────────────
async function getOdds(eventId) {
  const j = await _fetchFirstJson([`/event/${eventId}/odds/1/all`]);
  if (!j) return null;
  const markets = Array.isArray(j.markets) ? j.markets : [];
  const fulltime = markets.find(m => m.marketName === 'Full time' || m.marketId === 1);
  if (!fulltime || !Array.isArray(fulltime.choices)) return null;
  const c1 = fulltime.choices.find(c => c.name === '1' || c.name === 'Home');
  const c2 = fulltime.choices.find(c => c.name === '2' || c.name === 'Away');
  const t1 = _fractionalToDecimal(c1?.fractionalValue);
  const t2 = _fractionalToDecimal(c2?.fractionalValue);
  if (!t1 || !t2) return null;
  return { t1: String(t1), t2: String(t2), bookmaker: 'Sofascore' };
}

// ── Stats do match (3-dart avg, 180s, etc) ──────────────────────────────────
async function getStats(eventId) {
  const j = await _fetchFirstJson([`/event/${eventId}/statistics`]);
  if (!j || !Array.isArray(j.statistics)) return null;
  const all = j.statistics.find(s => s.period === 'ALL') || j.statistics[0];
  const group = (all?.groups || []).find(g => g.groupName === 'Attacking') || all?.groups?.[0];
  if (!group) return null;
  const items = Array.isArray(group.statisticsItems) ? group.statisticsItems : [];
  const pick = (key) => items.find(x => x.key === key) || null;
  const avg3 = pick('Average3Darts');
  const t180 = pick('Thrown180');
  const to140 = pick('ThrownOver140');
  const to100 = pick('ThrownOver100');
  const hc = pick('HighestCheckout');
  const co100 = pick('CheckoutsOver100');
  return {
    avg3dartsHome: Number(avg3?.homeValue) || null,
    avg3dartsAway: Number(avg3?.awayValue) || null,
    t180sHome: Number(t180?.homeValue) || 0,
    t180sAway: Number(t180?.awayValue) || 0,
    over140Home: Number(to140?.homeValue) || 0,
    over140Away: Number(to140?.awayValue) || 0,
    over100Home: Number(to100?.homeValue) || 0,
    over100Away: Number(to100?.awayValue) || 0,
    highestCheckoutHome: Number(hc?.homeValue) || 0,
    highestCheckoutAway: Number(hc?.awayValue) || 0,
    checkoutsOver100Home: Number(co100?.homeValue) || 0,
    checkoutsOver100Away: Number(co100?.awayValue) || 0,
  };
}

// ── Rolling average 3-dart dos últimos N jogos ──────────────────────────────
// Sofascore expõe estatísticas por match, então agrega os últimos N finished.
async function getPlayerRecentAvg(playerId, maxGames = 10) {
  const j = await _fetchFirstJson([`/team/${playerId}/events/last/0`], { ttlMs: 30 * 60 * 1000 });
  const events = j?.events || [];
  const finished = events.filter(e => e?.status?.type === 'finished').slice(0, maxGames);
  if (!finished.length) return null;

  let sum = 0, n = 0, wins = 0, losses = 0;
  for (const ev of finished) {
    const isHome = ev?.homeTeam?.id === playerId;
    const stats = await getStats(ev.id).catch(() => null);
    const avg = isHome ? stats?.avg3dartsHome : stats?.avg3dartsAway;
    if (avg && Number.isFinite(avg)) { sum += avg; n++; }
    const wc = ev?.winnerCode;
    if (wc === 1) isHome ? wins++ : losses++;
    else if (wc === 2) isHome ? losses++ : wins++;
  }
  return {
    avgLast: n ? +(sum / n).toFixed(2) : null,
    games: n,
    wins, losses,
    winRate: (wins + losses) > 0 ? +(wins / (wins + losses) * 100).toFixed(1) : null
  };
}

/**
 * Busca resultado de um evento via Sofascore event details.
 * Serve para settlement de darts e snooker.
 *
 * @param {number|string} eventId — ID nativo do Sofascore (sem prefixo `darts_`/`snooker_`)
 * @returns {Promise<{ resolved: boolean, winner: string|null, status: string, score?: string } | null>}
 */
async function getEventResult(eventId) {
  const j = await _fetchFirstJson([`/event/${eventId}`]);
  const ev = j?.event || j;
  if (!ev) return null;
  const status = ev?.status?.type || 'unknown';
  if (status !== 'finished') {
    return { resolved: false, winner: null, status };
  }
  // winnerCode: 1=home, 2=away, 3=draw. Na prática darts/snooker = sempre 1 ou 2.
  const wc = ev?.winnerCode;
  let winner = null;
  if (wc === 1) winner = ev?.homeTeam?.name || null;
  else if (wc === 2) winner = ev?.awayTeam?.name || null;
  const s1 = ev?.homeScore?.current ?? ev?.homeScore?.display;
  const s2 = ev?.awayScore?.current ?? ev?.awayScore?.display;
  const score = (s1 != null && s2 != null) ? `${s1}-${s2}` : null;
  return { resolved: !!winner, winner, status, score };
}

/**
 * Head-to-head entre dois jogadores.
 * Usa /team/{id1}/events/last/0 (últimos 30 eventos) e filtra os matches contra id2.
 * Cobre ~12 meses de histórico — suficiente para o sinal.
 *
 * @returns {{ p1Wins, p2Wins, totalMatches } | null}
 */
async function getHeadToHead(id1, id2) {
  const n1 = parseInt(String(id1), 10);
  const n2 = parseInt(String(id2), 10);
  if (!Number.isFinite(n1) || !Number.isFinite(n2) || n1 === n2) return null;

  const j = await _fetchFirstJson([`/team/${n1}/events/last/0`], { ttlMs: 60 * 60 * 1000 });
  const events = j?.events || [];
  if (!events.length) return null;

  let p1Wins = 0, p2Wins = 0;
  for (const ev of events) {
    const hid = ev?.homeTeam?.id;
    const aid = ev?.awayTeam?.id;
    if ((hid !== n1 || aid !== n2) && (hid !== n2 || aid !== n1)) continue;
    const wc = ev?.winnerCode;
    if (wc !== 1 && wc !== 2) continue;
    const p1IsHome = hid === n1;
    const p1Won = (wc === 1 && p1IsHome) || (wc === 2 && !p1IsHome);
    if (p1Won) p1Wins++; else p2Wins++;
  }
  const totalMatches = p1Wins + p2Wins;
  if (totalMatches < 1) return null;
  return { p1Wins, p2Wins, totalMatches };
}

module.exports = {
  listLiveAndUpcoming,
  getOdds,
  getStats,
  getPlayerRecentAvg,
  getHeadToHead,
  getEventResult,
};

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
const { safeParse, cachedHttpGet } = require('./utils');

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
  'grand-slam', 'world-series-finals'
];

function _directEnabled() {
  const v = String(process.env.SOFASCORE_DIRECT || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function _buildUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function _urls(path) {
  const proxy = (process.env.SOFASCORE_PROXY_BASE || '').trim().replace(/\/+$/, '');
  const urls = [];
  if (proxy) urls.push(_buildUrl(proxy, path));
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

  // Merge (dedupe por id) + filtra status
  const byId = new Map();
  for (const ev of [...live, ...upcoming]) {
    const id = ev?.id;
    if (!id) continue;
    if (!_isWhitelisted(ev.tournament)) continue;
    const status = ev?.status?.type || '';
    if (status === 'finished' || status === 'canceled' || status === 'postponed') continue;
    byId.set(id, ev);
  }
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

module.exports = {
  listLiveAndUpcoming,
  getOdds,
  getStats,
  getPlayerRecentAvg,
};

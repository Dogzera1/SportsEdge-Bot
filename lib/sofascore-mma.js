/**
 * sofascore-mma.js — Enriquecimento de MMA via proxy Sofascore.
 *
 * Env:
 * - SOFASCORE_PROXY_BASE   — URL do proxy
 * - SOFASCORE_DIRECT=true  — tenta api.sofascore.com direto
 * - SOFASCORE_ENRICH_MMA   — default: ligado se proxy existir
 *
 * Saída compatível com esportsPreFilter (form1/form2 no mesmo shape de mmaRecordToEnrich).
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
  const t = String(s || '').trim().split(/\s+/).filter(Boolean);
  return t.length ? t[t.length - 1] : '';
}

function namesMatch(evName, query) {
  const a = normName(evName);
  const b = normName(query);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
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
  if (proxy) urls.push(buildUrl(proxy, `/schedule/mma/${d}/`));
  if (_directEnabled()) urls.push(`https://api.sofascore.com/api/v1/sport/mma/scheduled-events/${d}`);
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
    cacheKey: `sofascore-mma:${url}`
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

function winRateFromFighterEvents(json, fighterId, limit = 15) {
  const events = json?.events || json?.results || [];
  let wins = 0, losses = 0;
  const recent = [];
  for (const ev of events) {
    const wc = ev?.winnerCode;
    const hid = ev?.homeTeam?.id;
    const aid = ev?.awayTeam?.id;
    if (wc !== 1 && wc !== 2) continue;
    if (hid !== fighterId && aid !== fighterId) continue;
    const won = (wc === 1 && hid === fighterId) || (wc === 2 && aid === fighterId);
    if (won) { wins++; recent.push('W'); }
    else { losses++; recent.push('L'); }
    if (recent.length >= limit) break;
  }
  const total = wins + losses;
  if (!total) return null;
  return {
    wins, losses,
    winRate: Math.round((wins / total) * 100),
    recent,
  };
}

/**
 * @param {string} f1 - nome do lutador 1
 * @param {string} f2 - nome do lutador 2
 * @param {string} commenceIso
 */
async function enrichMatch(f1, f2, commenceIso) {
  const hasProxy = !!(process.env.SOFASCORE_PROXY_BASE || '').trim();
  const env = String(process.env.SOFASCORE_ENRICH_MMA || '').toLowerCase();
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
      const fwd = namesMatch(hn, f1) && namesMatch(an, f2);
      const rev = namesMatch(hn, f2) && namesMatch(an, f1);
      if (!fwd && !rev) continue;
      found = {
        eventId: ev.id,
        fighter1Id: fwd ? ev.homeTeam?.id : ev.awayTeam?.id,
        fighter2Id: fwd ? ev.awayTeam?.id : ev.homeTeam?.id,
        weightClass: ev?.tournament?.name || null,
      };
      break;
    }
    if (found) break;
  }
  if (!found?.eventId || !found.fighter1Id || !found.fighter2Id) return null;

  const [e1, e2] = await Promise.all([
    fetchFirstJson(teamEventsUrls(found.fighter1Id)),
    fetchFirstJson(teamEventsUrls(found.fighter2Id)),
  ]);

  const form1 = e1 ? winRateFromFighterEvents(e1, found.fighter1Id) : null;
  const form2 = e2 ? winRateFromFighterEvents(e2, found.fighter2Id) : null;

  if (!form1 && !form2) return null;

  return {
    form1, form2,
    h2h: { t1Wins: 0, t2Wins: 0, totalMatches: 0 },
    oddsMovement: null,
    eventId: found.eventId,
    fighter1Id: found.fighter1Id,
    fighter2Id: found.fighter2Id,
    weightClass: found.weightClass,
  };
}

module.exports = { enrichMatch, namesMatch };

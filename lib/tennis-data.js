const { cachedHttpGet, safeParse } = require('./utils');

const ESPN_HOST = 'https://site.api.espn.com';

function _tourSlug(tour) {
  const t = String(tour || '').toLowerCase();
  if (t === 'atp') return 'atp';
  if (t === 'wta') return 'wta';
  throw new Error('tour inválido (use atp|wta)');
}

async function _espnGetJson(path, opts = {}) {
  const url = `${ESPN_HOST}${path}`;
  const r = await cachedHttpGet(url, {
    provider: 'espn:tennis',
    ttlMs: opts.ttlMs ?? (60 * 60 * 1000),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    cacheKey: `espn_tennis:${path}`
  });
  if (!r || r.status !== 200) return null;
  return safeParse(r.body, null);
}

async function getRankings(tour, limit = 200) {
  const slug = _tourSlug(tour);
  const j = await _espnGetJson(`/apis/site/v2/sports/tennis/${slug}/rankings`, { ttlMs: 3 * 60 * 60 * 1000 });
  const ranks = j?.rankings?.[0]?.ranks || [];
  const out = ranks.map(r => ({
    rank: r.current,
    points: r.points,
    name: r.athlete?.displayName || '',
    id: r.athlete?.id || ''
  }));
  return out.slice(0, Math.max(1, Number(limit) || 200));
}

async function getScoreboard(tour, opts = {}) {
  const slug = _tourSlug(tour);
  const dates = opts.dates != null && String(opts.dates).trim() ? String(opts.dates).trim() : '';
  const path = dates
    ? `/apis/site/v2/sports/tennis/${slug}/scoreboard?dates=${encodeURIComponent(dates)}`
    : `/apis/site/v2/sports/tennis/${slug}/scoreboard`;
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : (dates ? 5 * 60 * 1000 : 3 * 60 * 1000);
  const j = await _espnGetJson(path, { ttlMs });
  if (!j) return null;
  return j;
}

async function getCalendar(tour, year) {
  const slug = _tourSlug(tour);
  const y = parseInt(String(year), 10);
  if (!Number.isFinite(y) || y < 1990 || y > 2100) throw new Error('year inválido');
  // ESPN calendar endpoint (consistente com outros esportes da ESPN)
  // Retorno varia por tour; mantemos bruto para o caller filtrar.
  const j = await _espnGetJson(`/apis/site/v2/sports/tennis/${slug}/schedule?dates=${y}`, { ttlMs: 24 * 60 * 60 * 1000 });
  return j;
}

async function getPlayerInfo(tour, playerId) {
  const slug = _tourSlug(tour);
  const id = String(playerId || '').trim();
  if (!id) throw new Error('playerId vazio');
  const j = await _espnGetJson(`/apis/site/v2/sports/tennis/${slug}/athletes/${encodeURIComponent(id)}`, { ttlMs: 24 * 60 * 60 * 1000 });
  return j;
}

module.exports = { getRankings, getScoreboard, getCalendar, getPlayerInfo };


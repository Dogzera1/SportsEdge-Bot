'use strict';

/**
 * odds-aggregator-client.js
 *
 * Cliente do agregador BR de odds (Supabase Postgres + REST API). Lê a view
 * `vw_jogos_publicos` que já agrega snapshots_odds mais recente por (jogo, casa).
 *
 * Schema relevante:
 *   jogo: { id, slug, mandante: { nome, nome_curto, slug }, visitante: { ... },
 *           inicio, status, odds: [ { casa, mercados: { '1x2': {...} }, atualizado_em } ] }
 *
 * Format mapping (Supabase → bot _allOdds):
 *   mercados['1x2']['1'] → h (home)
 *   mercados['1x2']['x'] → d (draw)
 *   mercados['1x2']['2'] → a (away)
 *
 * Env:
 *   SUPABASE_URL              — https://<project>.supabase.co
 *   SUPABASE_ANON_KEY         — anon JWT (read-only via RLS)
 *
 * Uso:
 *   const cli = require('./lib/odds-aggregator-client');
 *   await cli.enrichMatches(footballMatches);  // mutates _allOdds in-place
 */

const https = require('https');
const url = require('url');

const _cache = { ts: 0, data: [], lastErrorAt: 0, lastErrorMsg: null };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5min — scrapers rodam ~10-30min

function _supabaseUrl() {
  return (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
}

function _supabaseKey() {
  return (process.env.SUPABASE_ANON_KEY || '').trim();
}

function _normTeam(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function _httpGetJson(targetUrl, headers, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const opts = url.parse(targetUrl);
    opts.headers = headers;
    opts.timeout = timeoutMs;
    const req = https.get(opts, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Busca jogos com odds agregadas. Filtra por janela de tempo (default 14d).
 * Cache 5min em memória.
 */
async function fetchUpcomingJogos({ daysAhead = 14, force = false } = {}) {
  const SU = _supabaseUrl(), SK = _supabaseKey();
  if (!SU || !SK) return null;
  const now = Date.now();
  if (!force && _cache.data.length && (now - _cache.ts) < CACHE_TTL_MS) return _cache.data;
  // Throttle erros — evita spam quando Supabase down
  if (!force && _cache.lastErrorAt && (now - _cache.lastErrorAt) < 60_000) return null;
  const startIso = new Date(now - 6 * 60 * 60 * 1000).toISOString(); // -6h pra cobrir live
  const endIso = new Date(now + daysAhead * 86_400_000).toISOString();
  const target = `${SU}/rest/v1/vw_jogos_publicos?select=*&inicio=gte.${encodeURIComponent(startIso)}&inicio=lt.${encodeURIComponent(endIso)}`;
  const headers = {
    apikey: SK,
    Authorization: `Bearer ${SK}`,
    'User-Agent': 'SportsEdgeBot/1.0',
  };
  try {
    const arr = await _httpGetJson(target, headers, 12000);
    if (Array.isArray(arr)) {
      _cache.data = arr;
      _cache.ts = now;
      _cache.lastErrorAt = 0;
      _cache.lastErrorMsg = null;
      return arr;
    }
    return null;
  } catch (e) {
    _cache.lastErrorAt = now;
    _cache.lastErrorMsg = e.message;
    return null;
  }
}

/**
 * Match jogo Supabase com (team1, team2) do bot. Tenta nome cheio + nome_curto + slug.
 * @returns { jogo, swap } | null
 */
function findJogoByTeams(jogos, team1, team2) {
  if (!Array.isArray(jogos)) return null;
  const t1n = _normTeam(team1), t2n = _normTeam(team2);
  if (!t1n || !t2n) return null;
  for (const j of jogos) {
    const m = j.mandante || {}, v = j.visitante || {};
    const mNames = [m.nome, m.nome_curto, m.slug].filter(Boolean).map(_normTeam);
    const vNames = [v.nome, v.nome_curto, v.slug].filter(Boolean).map(_normTeam);
    const matches = (a, b) => a.some(x => x === b || x.includes(b) || b.includes(x));
    const fwd = matches(mNames, t1n) && matches(vNames, t2n);
    const rev = matches(mNames, t2n) && matches(vNames, t1n);
    if (fwd) return { jogo: j, swap: false };
    if (rev) return { jogo: j, swap: true };
  }
  return null;
}

/**
 * Converte jogo Supabase pro formato `_allOdds` do bot (1X2 home/draw/away).
 * Aplica swap se mandante=team2 (rev).
 */
function jogoToAllOdds(jogo, swap = false) {
  const out = [];
  const odds = jogo?.odds || [];
  for (const o of odds) {
    const m1x2 = o.mercados?.['1x2'];
    if (!m1x2) continue;
    const h = parseFloat(m1x2['1']);
    const d = parseFloat(m1x2['x']);
    const a = parseFloat(m1x2['2']);
    if (!Number.isFinite(h) || !Number.isFinite(a)) continue;
    if (swap) {
      out.push({
        h: String(a), d: Number.isFinite(d) ? String(d) : null, a: String(h),
        bookmaker: o.casa, _supabase: true, _capturedAt: o.atualizado_em,
      });
    } else {
      out.push({
        h: String(h), d: Number.isFinite(d) ? String(d) : null, a: String(a),
        bookmaker: o.casa, _supabase: true, _capturedAt: o.atualizado_em,
      });
    }
  }
  return out;
}

/**
 * Enrich football matches com odds BR do agregador. Mutates `match.odds._allOdds`.
 * - Append-only: não sobrescreve books já presentes (TheOddsAPI tem prioridade)
 * - Dedup por bookmaker (case-insensitive)
 * - Skipa matches não-football
 */
async function enrichMatches(matches) {
  if (!Array.isArray(matches) || !matches.length) return { enriched: 0, totalJogos: 0 };
  const jogos = await fetchUpcomingJogos({ daysAhead: 14 });
  if (!jogos?.length) return { enriched: 0, totalJogos: 0, error: _cache.lastErrorMsg };
  let enriched = 0;
  for (const m of matches) {
    if (m.game && m.game !== 'football') continue;
    const found = findJogoByTeams(jogos, m.team1, m.team2);
    if (!found) continue;
    const brOdds = jogoToAllOdds(found.jogo, found.swap);
    if (!brOdds.length) continue;
    if (!m.odds) m.odds = {};
    if (!Array.isArray(m.odds._allOdds)) m.odds._allOdds = [];
    const seen = new Set(m.odds._allOdds.map(o => String(o.bookmaker || '').toLowerCase()));
    for (const bo of brOdds) {
      const key = String(bo.bookmaker || '').toLowerCase();
      if (seen.has(key)) continue;
      m.odds._allOdds.push(bo);
      seen.add(key);
    }
    enriched++;
  }
  return { enriched, totalJogos: jogos.length };
}

function getStatus() {
  return {
    cached: _cache.data.length,
    cacheAgeMs: _cache.ts ? (Date.now() - _cache.ts) : null,
    lastErrorMsg: _cache.lastErrorMsg,
    lastErrorAt: _cache.lastErrorAt || null,
    configured: !!(_supabaseUrl() && _supabaseKey()),
  };
}

module.exports = {
  fetchUpcomingJogos,
  findJogoByTeams,
  jogoToAllOdds,
  enrichMatches,
  getStatus,
};

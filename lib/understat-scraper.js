'use strict';

/**
 * lib/understat-scraper.js — fetch xG (expected goals) per match do understat.com.
 *
 * Understat publica xG calculado de cada chute em 6 ligas top:
 *   EPL, La_Liga, Bundesliga, Serie_A, Ligue_1, RFPL
 *
 * Endpoints (sem API formal — JSON embedado em HTML via JSON.parse):
 *   - Match page: https://understat.com/match/<matchId>
 *     Variável `var match_info = JSON.parse('...')` + `var rostersData...` + `var shotsData...`
 *   - League season: https://understat.com/league/<league>/<year>
 *     Variável `var matchesData = JSON.parse('...')` (lista todos matches da season)
 *
 * Strategy:
 *   1. fetchSeasonMatches(league, year) → lista [{ id, date, h, a, xG: {h, a}, ... }]
 *   2. fetchMatchShots(matchId) → array de chutes com xG individual (refinado)
 *
 * Usado pra alimentar Poisson model de football com λ_xG ao invés de só
 * goals históricos. xG é melhor preditor pra Over/Under (lit shows ~30%
 * Brier reduction).
 */

const https = require('https');

const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12000;

// Mapping nome amigável → slug understat
const LEAGUE_SLUGS = {
  'Premier League': 'EPL',
  'La Liga': 'La_Liga',
  'Bundesliga': 'Bundesliga',
  'Serie A': 'Serie_A',
  'Ligue 1': 'Ligue_1',
  'RFPL': 'RFPL',
  'Russian Premier League': 'RFPL',
};

function httpGetHtml(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': HTTP_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: TIMEOUT_MS,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

/**
 * Decodifica string JSON encoded como hex/escape (\\x40 → @, etc).
 * Understat encoda dados em JSON.parse('escaped string').
 */
function _decodeUnderstatJson(escaped) {
  // Replace \xNN → caractere correspondente
  return escaped.replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  );
}

/**
 * Extrai variável JSON.parse('...') do HTML.
 */
function _extractJsonVar(html, varName) {
  // Pattern: var <name> = JSON.parse('<encoded>');
  const re = new RegExp(`var\\s+${varName}\\s*=\\s*JSON\\.parse\\('((?:\\\\'|[^'])*)'\\)`, 's');
  const m = html.match(re);
  if (!m) return null;
  try {
    const decoded = _decodeUnderstatJson(m[1]);
    return JSON.parse(decoded);
  } catch (_) { return null; }
}

/**
 * Lista todos matches de uma liga + season (year = season start).
 * @param {string} league — slug (EPL, La_Liga, ...)
 * @param {number} year   — e.g. 2025 = season 2025/26
 * @returns {Array<{id, isResult, date, h: {id, title, short_title}, a: {...}, goals: {h, a}, xG: {h, a}}>}
 */
async function fetchSeasonMatches(league, year) {
  const slug = LEAGUE_SLUGS[league] || league;
  const url = `https://understat.com/league/${slug}/${year}`;
  const r = await httpGetHtml(url);
  if (r.status !== 200) return { ok: false, reason: 'http_fail', status: r.status };
  const matches = _extractJsonVar(r.body, 'matchesData');
  if (!Array.isArray(matches)) return { ok: false, reason: 'parse_fail' };
  return { ok: true, league: slug, year, matches };
}

/**
 * Detalhe de um match — shots + xG agregado por team.
 * Shape do shotsData: { h: [{xG, situation, ...}], a: [...] }
 */
async function fetchMatchShots(matchId) {
  const url = `https://understat.com/match/${matchId}`;
  const r = await httpGetHtml(url);
  if (r.status !== 200) return { ok: false, reason: 'http_fail', status: r.status };
  const matchInfo = _extractJsonVar(r.body, 'match_info');
  const shotsData = _extractJsonVar(r.body, 'shotsData');
  if (!matchInfo || !shotsData) return { ok: false, reason: 'parse_fail' };
  const xgH = (shotsData.h || []).reduce((s, sh) => s + (parseFloat(sh.xG) || 0), 0);
  const xgA = (shotsData.a || []).reduce((s, sh) => s + (parseFloat(sh.xG) || 0), 0);
  return {
    ok: true,
    matchId,
    info: matchInfo,
    xG: { h: +xgH.toFixed(3), a: +xgA.toFixed(3) },
    shots_h: shotsData.h?.length || 0,
    shots_a: shotsData.a?.length || 0,
  };
}

/**
 * Bulk: scrape season matches + persist em DB.
 */
async function syncLeagueSeason(db, league, year, opts = {}) {
  const limit = opts.limit ?? 500;
  const r = await fetchSeasonMatches(league, year);
  if (!r.ok) return { ok: false, reason: r.reason };

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO understat_matches (
      match_id, league, season_year, date,
      team_h, team_a, goals_h, goals_a, xg_h, xg_a, is_result, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let inserted = 0, errors = 0;
  for (const m of r.matches.slice(0, limit)) {
    try {
      const goalsH = m.goals?.h != null ? parseInt(m.goals.h, 10) : null;
      const goalsA = m.goals?.a != null ? parseInt(m.goals.a, 10) : null;
      const xgH = m.xG?.h != null ? parseFloat(m.xG.h) : null;
      const xgA = m.xG?.a != null ? parseFloat(m.xG.a) : null;
      upsert.run(
        String(m.id),
        r.league,
        year,
        m.datetime || m.date || null,
        m.h?.title || m.h?.short_title || null,
        m.a?.title || m.a?.short_title || null,
        goalsH, goalsA, xgH, xgA,
        m.isResult ? 1 : 0
      );
      inserted++;
    } catch (e) { errors++; }
  }
  return { ok: true, league: r.league, year, inserted, errors, total_seen: r.matches.length };
}

module.exports = { fetchSeasonMatches, fetchMatchShots, syncLeagueSeason, LEAGUE_SLUGS };

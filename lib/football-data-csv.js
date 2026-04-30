'use strict';

/**
 * lib/football-data-csv.js — sync histórico football-data.co.uk.
 *
 * Free CSV per liga × season com:
 *   - Resultados (FTHG, FTAG, FTR)
 *   - Odds históricas open/close (B365H, B365D, B365A, BWH, ...)
 *   - Stats (corners, yellows, reds)
 *
 * URL pattern: https://www.football-data.co.uk/mmz4281/<season>/<league>.csv
 *   season: '2425' = 2024/25, '2526' = 2025/26
 *   league: E0 (EPL), E1, E2 (Championship), SP1 (La Liga), D1 (Bundesliga),
 *           I1 (Serie A), F1 (Ligue 1), N1 (Eredivisie), B1 (Belgium)
 *
 * Reliable e estável há 20+ anos. Sem auth, sem rate limit.
 */

const https = require('https');

const HTTP_UA = 'Mozilla/5.0 sportsedge-bot';
const TIMEOUT_MS = 20000;

const LEAGUE_CODES = {
  'Premier League': 'E0',
  'EPL': 'E0',
  'Championship': 'E1',
  'League One': 'E2',
  'La Liga': 'SP1',
  'La Liga 2': 'SP2',
  'Bundesliga': 'D1',
  'Bundesliga 2': 'D2',
  'Serie A': 'I1',
  'Serie B': 'I2',
  'Ligue 1': 'F1',
  'Ligue 2': 'F2',
  'Eredivisie': 'N1',
  'Belgium': 'B1',
  'Portugal': 'P1',
  'Turkey': 'T1',
  'Greece': 'G1',
  'Scotland': 'SC0',
};

function httpGetText(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': HTTP_UA, 'Accept': 'text/csv,text/plain' },
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
 * Parse CSV simples (sem quoting complexo).
 */
function _parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cells[j] ? cells[j].trim() : null;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Fetch e parse CSV per liga × season.
 * @param {string} league — slug (EPL, La Liga, etc) ou code direto (E0, SP1)
 * @param {string} season — formato '2425' (2024/25) ou '2526'
 */
async function fetchLeagueSeason(league, season) {
  const code = LEAGUE_CODES[league] || league;
  if (!code) return { ok: false, reason: 'unknown_league', league };
  if (!/^\d{4}$/.test(season)) return { ok: false, reason: 'bad_season_format' };
  const url = `https://www.football-data.co.uk/mmz4281/${season}/${code}.csv`;
  const r = await httpGetText(url);
  if (r.status !== 200) return { ok: false, reason: 'http_fail', status: r.status, url };
  const rows = _parseCsv(r.body);
  if (!rows.length) return { ok: false, reason: 'empty_csv' };
  return { ok: true, league: code, season, rows, url };
}

/**
 * Bulk: persiste em DB.
 */
async function syncLeagueSeason(db, league, season, opts = {}) {
  const r = await fetchLeagueSeason(league, season);
  if (!r.ok) return r;

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO football_data_csv (
      match_id, league, season, date,
      home, away, fthg, ftag, ftr,
      hthg, htag, htr,
      home_corners, away_corners,
      home_yellows, away_yellows,
      home_reds, away_reds,
      b365_h, b365_d, b365_a,
      bw_h, bw_d, bw_a,
      ps_h, ps_d, ps_a,
      ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const _num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const _int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

  let inserted = 0, errors = 0;
  for (const row of r.rows) {
    try {
      const date = row.Date || '';
      const home = row.HomeTeam || '';
      const away = row.AwayTeam || '';
      if (!date || !home || !away) { errors++; continue; }
      const matchId = `fd_${r.league}_${r.season}_${date.replace(/\//g, '')}_${home.replace(/\s/g, '')}`;
      upsert.run(
        matchId, r.league, r.season, date,
        home, away,
        _int(row.FTHG), _int(row.FTAG), row.FTR || null,
        _int(row.HTHG), _int(row.HTAG), row.HTR || null,
        _int(row.HC), _int(row.AC),
        _int(row.HY), _int(row.AY),
        _int(row.HR), _int(row.AR),
        _num(row.B365H), _num(row.B365D), _num(row.B365A),
        _num(row.BWH), _num(row.BWD), _num(row.BWA),
        _num(row.PSH || row.PH), _num(row.PSD || row.PD), _num(row.PSA || row.PA)
      );
      inserted++;
    } catch (_) { errors++; }
  }
  return { ok: true, league: r.league, season, inserted, errors, total: r.rows.length };
}

module.exports = { fetchLeagueSeason, syncLeagueSeason, LEAGUE_CODES };

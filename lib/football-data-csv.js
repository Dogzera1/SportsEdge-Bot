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
      home_shots, away_shots,
      home_shots_target, away_shots_target,
      ou25_over_close, ou25_under_close, ah_line,
      ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  // 2026-05-02: dual-write em match_results pra alimentar trained Poisson com
  // top-5 EU. football-data tem cobertura histórica completa de PL/La Liga/
  // Serie A/Bundesliga/Ligue 1, mas só populava football_data_csv (usado por
  // features). Sem match_results, train-football-poisson achava ~100 PL e 0 La Liga.
  let mrUpsert = null;
  try {
    mrUpsert = db.prepare(`
      INSERT INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
      VALUES (?, 'football', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id, game) DO UPDATE SET
        team1 = excluded.team1, team2 = excluded.team2,
        winner = excluded.winner, final_score = excluded.final_score,
        resolved_at = excluded.resolved_at, league = excluded.league
    `);
  } catch (_) { /* schema mismatch — pula dual-write silenciosamente */ }

  const _num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const _int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const _parseDdMmYy = (d) => {
    // football-data usa "01/08/24" (DD/MM/YY) ou "01/08/2024" (DD/MM/YYYY)
    const parts = String(d).split('/');
    if (parts.length !== 3) return null;
    const dd = parts[0].padStart(2, '0');
    const mm = parts[1].padStart(2, '0');
    let yy = parts[2];
    if (yy.length === 2) yy = (parseInt(yy, 10) >= 50 ? '19' : '20') + yy;
    return `${yy}-${mm}-${dd} 14:00:00`;
  };

  let inserted = 0, errors = 0, mrInserted = 0;
  // Wrap em transaction (fsync único). 380+ rows/season × 5 ligas → sem tx é fsync por linha.
  const tx = db.transaction(() => {
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
          _num(row.PSH || row.PH), _num(row.PSD || row.PD), _num(row.PSA || row.PA),
          _int(row.HS), _int(row.AS),
          _int(row.HST), _int(row.AST),
          // Closing OU/AH (PCH... = closing). Tenta múltiplas variantes.
          _num(row['PC>2.5'] || row['P>2.5'] || row['B365C>2.5']),
          _num(row['PC<2.5'] || row['P<2.5'] || row['B365C<2.5']),
          _num(row.AHCh || row.AHh || row.PAHh)
        );
        inserted++;

        if (mrUpsert) {
          const fthg = _int(row.FTHG);
          const ftag = _int(row.FTAG);
          const ftr = String(row.FTR || '').toUpperCase();
          if (Number.isFinite(fthg) && Number.isFinite(ftag) && /^[HDA]$/.test(ftr)) {
            const winner = ftr === 'H' ? home : ftr === 'A' ? away : 'Draw';
            const score = `${fthg}-${ftag}`;
            const resolvedAt = _parseDdMmYy(date);
            if (resolvedAt) {
              mrUpsert.run(matchId, home, away, winner, score, r.league, resolvedAt);
              mrInserted++;
            }
          }
        }
      } catch (_) { errors++; }
    }
  });
  tx();
  return { ok: true, league: r.league, season, inserted, errors, total: r.rows.length, mr_inserted: mrInserted };
}

module.exports = { fetchLeagueSeason, syncLeagueSeason, LEAGUE_CODES };

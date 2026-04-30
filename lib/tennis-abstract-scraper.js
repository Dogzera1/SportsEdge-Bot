'use strict';

/**
 * lib/tennis-abstract-scraper.js — fetch serve/return stats per player de
 * tennisabstract.com. Mantido por Jeff Sackmann mesmo dono dos CSVs.
 *
 * Endpoints:
 *   - Player overview: https://www.tennisabstract.com/cgi-bin/player.cgi?p=<player>
 *   - Career stats:    https://www.tennisabstract.com/cgi-bin/player-classic.cgi?p=<player>&f=A2025qq
 *
 * Stats relevantes pro Markov tennis (alimenta tennis-markov-model.js):
 *   - 1st serve % (firstServePct)
 *   - 1st serve points won % (firstServeWinPct)
 *   - 2nd serve points won % (secondServeWinPct)
 *   - Break points saved % (bpSavedPct)
 *   - Service games won %
 *   - Return games won %
 *
 * Hoje o Markov usa serve% empirical do Sackmann CSV (per-match, no per-player
 * rolling). Tennis Abstract dá rolling 12 meses pre-computed.
 */

const https = require('https');

const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function httpGetHtml(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': HTTP_UA, 'Accept': 'text/html' },
      timeout: 15000,
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
 * Tennis Abstract usa player slug formato `FirstLastInitial` ou `FirstLast`.
 * E.g., "Carlos Alcaraz" → "CarlosAlcaraz", "Jannik Sinner" → "JannikSinner".
 */
function _toPlayerSlug(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove diacritics
    .replace(/[^A-Za-z]/g, '');
}

/**
 * Parse stats da página /cgi-bin/player.cgi.
 * Página tem JS embedado com `var careerstats = '...';` containing HTML table.
 */
function _extractCareerStats(html) {
  // Padrão na página: <td>Stat name</td><td>Value</td>
  // Pra robusto, busca linhas específicas por label.
  const stats = {};
  const fields = [
    { key: 'firstServePct', re: /1st\s*Serve\s*%[\s\S]{0,80}?<td[^>]*>([\d.]+)%/i },
    { key: 'firstServeWinPct', re: /1st\s*Serve\s*(?:Points\s*)?Won[\s\S]{0,80}?<td[^>]*>([\d.]+)%/i },
    { key: 'secondServeWinPct', re: /2nd\s*Serve\s*(?:Points\s*)?Won[\s\S]{0,80}?<td[^>]*>([\d.]+)%/i },
    { key: 'bpSavedPct', re: /(?:BP|Break\s*Points?)\s*Saved[\s\S]{0,80}?<td[^>]*>([\d.]+)%/i },
    { key: 'svGamesWonPct', re: /(?:SV|Service)\s*Games\s*Won[\s\S]{0,80}?<td[^>]*>([\d.]+)%/i },
    { key: 'rtGamesWonPct', re: /(?:RT|Return)\s*Games\s*Won[\s\S]{0,80}?<td[^>]*>([\d.]+)%/i },
    { key: 'acePct', re: /Ace\s*%[\s\S]{0,80}?<td[^>]*>([\d.]+)%/i },
    { key: 'dfPct', re: /(?:DF|Double\s*Fault)\s*%[\s\S]{0,80}?<td[^>]*>([\d.]+)%/i },
  ];
  for (const f of fields) {
    const m = html.match(f.re);
    if (m) stats[f.key] = parseFloat(m[1]);
  }
  return stats;
}

/**
 * Public API. Busca stats per-player.
 * @param {string} playerName — e.g. "Carlos Alcaraz"
 * @returns {{ok, player?, stats?, reason?}}
 */
async function fetchPlayerStats(playerName) {
  if (!playerName) return { ok: false, reason: 'no_name' };
  const slug = _toPlayerSlug(playerName);
  if (!slug) return { ok: false, reason: 'no_slug' };
  const url = `https://www.tennisabstract.com/cgi-bin/player.cgi?p=${slug}`;
  const r = await httpGetHtml(url);
  if (r.status !== 200) return { ok: false, reason: 'http_fail', status: r.status, slug };
  // Página tem `<title>Player Name | Tennis Abstract...</title>` — confirma que achou
  const titleMatch = r.body.match(/<title>([^<]+)<\/title>/);
  if (!titleMatch || !titleMatch[1].toLowerCase().includes('tennis abstract')) {
    return { ok: false, reason: 'page_not_player', slug };
  }
  const stats = _extractCareerStats(r.body);
  if (Object.keys(stats).length === 0) {
    return { ok: false, reason: 'no_stats_parsed', slug, body_len: r.body.length };
  }
  return { ok: true, player: playerName, slug, stats };
}

/**
 * Bulk: fetch + persist em DB.
 */
async function syncPlayerStats(db, playerNames, opts = {}) {
  const delay = opts.delayMs ?? 1500;
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO tennis_player_serve_stats (
      player_norm, player_name, slug,
      first_serve_pct, first_serve_win_pct, second_serve_win_pct,
      bp_saved_pct, sv_games_won_pct, rt_games_won_pct, ace_pct, df_pct,
      source, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tennisabstract', datetime('now'))
  `);
  let inserted = 0, errors = 0;
  for (const name of playerNames) {
    const r = await fetchPlayerStats(name);
    if (r.ok) {
      try {
        const norm = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
        const s = r.stats;
        upsert.run(
          norm, name, r.slug,
          s.firstServePct ?? null, s.firstServeWinPct ?? null, s.secondServeWinPct ?? null,
          s.bpSavedPct ?? null, s.svGamesWonPct ?? null, s.rtGamesWonPct ?? null,
          s.acePct ?? null, s.dfPct ?? null
        );
        inserted++;
      } catch (_) { errors++; }
    } else {
      errors++;
    }
    if (delay > 0) await new Promise(res => setTimeout(res, delay));
  }
  return { ok: true, inserted, errors, total: playerNames.length };
}

module.exports = { fetchPlayerStats, syncPlayerStats };

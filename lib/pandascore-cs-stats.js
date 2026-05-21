'use strict';

/**
 * lib/pandascore-cs-stats.js — busca per-map rounds via PandaScore CS API.
 * Alternativa pra HLTV /results CF block (commit 6d91140 Plan B bloqueado).
 *
 * PandaScore expõe:
 *   GET /csgo/matches/{psMatchId} → { id, opponents, games[], results, winner }
 *   Cada game (map) tem: { id, position, winner_team_id, length, rounds_score }
 *
 * Vantagens vs HLTV scraping:
 *   - API JSON, sem CF challenge
 *   - Already authenticated via PANDASCORE_TOKEN
 *   - Bot já usa PS pra /csgo/matches/running + past (consistent source)
 *
 * Uso:
 *   const { fetchCsMatchMapStats } = require('./pandascore-cs-stats');
 *   const r = await fetchCsMatchMapStats(psMatchId);
 *   // r = { maps: [{ map: 1, rounds_t1: 16, rounds_t2: 12, winner: '...', length_s: 1834 }, ...] }
 */

const https = require('https');
const { log } = require('./utils');

function _httpGetJson(url, headers) {
  return new Promise((resolve) => {
    https.get(url, {
      timeout: 20000,
      rejectUnauthorized: false,
      headers,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, body, raw: d });
      });
    })
    .on('error', e => resolve({ status: 0, err: e.message }))
    .on('timeout', () => resolve({ status: 0, err: 'timeout' }));
  });
}

/**
 * Busca match details de PandaScore + parse per-map stats.
 *
 * @param {string|number} psMatchId — PandaScore numeric ID (sem prefix)
 * @returns {Promise<{ok:boolean, team1?:string, team2?:string, maps?:array, reason?:string}>}
 */
async function fetchCsMatchMapStats(psMatchId) {
  const token = process.env.PANDASCORE_TOKEN;
  if (!token) return { ok: false, reason: 'PANDASCORE_TOKEN missing' };
  const idStr = String(psMatchId || '').replace(/^cs2?_ps_/, '').replace(/^csgo_ps_/, '');
  if (!/^\d+$/.test(idStr)) return { ok: false, reason: 'invalid_psMatchId' };

  const url = `https://api.pandascore.co/csgo/matches/${idStr}`;
  const r = await _httpGetJson(url, { 'Authorization': `Bearer ${token}` });
  if (r.status !== 200) {
    return { ok: false, reason: `ps_http_${r.status}`, err: r.err };
  }
  const m = r.body;
  if (!m || !Array.isArray(m.games)) {
    return { ok: false, reason: 'ps_no_games' };
  }

  const t1 = m.opponents?.[0]?.opponent?.name || null;
  const t2 = m.opponents?.[1]?.opponent?.name || null;
  const t1Id = m.opponents?.[0]?.opponent?.id;
  const t2Id = m.opponents?.[1]?.opponent?.id;
  if (!t1 || !t2) return { ok: false, reason: 'ps_no_opponents' };

  const maps = [];
  for (const g of m.games) {
    if (!g || g.status !== 'finished' || !Array.isArray(g.results)) continue;
    // results: [{ score: N, team_id: X }, { score: M, team_id: Y }]
    const r1 = g.results.find(x => x.team_id === t1Id);
    const r2 = g.results.find(x => x.team_id === t2Id);
    if (!r1 || !r2 || !Number.isFinite(r1.score) || !Number.isFinite(r2.score)) continue;
    let winnerName = null;
    if (g.winner_type === 'Player' || g.winner_type === 'Team') {
      if (g.winner?.id === t1Id) winnerName = t1;
      else if (g.winner?.id === t2Id) winnerName = t2;
    }
    if (!winnerName) {
      winnerName = r1.score > r2.score ? t1 : (r2.score > r1.score ? t2 : null);
    }
    maps.push({
      map: g.position || (maps.length + 1),
      mapName: null, // PS não expõe mapName em todos os matches CS
      rounds_t1: r1.score,
      rounds_t2: r2.score,
      winner: winnerName,
      length_s: Number.isFinite(g.length) ? g.length : null,
    });
  }

  if (!maps.length) return { ok: false, reason: 'ps_no_finished_games' };

  return { ok: true, team1: t1, team2: t2, maps };
}

module.exports = {
  fetchCsMatchMapStats,
};

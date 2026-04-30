'use strict';

/**
 * lib/thespike-valorant-scraper.js — agent + map stats per team de
 * thespike.gg (Valorant pro stats).
 *
 * Endpoints:
 *   - Team profile: https://www.thespike.gg/team/<teamSlug>/<teamId>
 *   - Match list:   https://www.thespike.gg/team/<teamSlug>/<teamId>/matches
 *   - Map stats embed em /team/<slug>/<id>?tab=stats
 *
 * Stats relevantes:
 *   - Map win rate per team (Bind, Haven, Ascent, Lotus, etc.)
 *   - Agent composition rate per team (Jett, Phoenix, Sova, etc.)
 *   - Recent form últimos 30d
 *
 * Hoje VLR.gg cobre matches mas não agrega map win rate per team.
 * thespike.gg tem essa view pre-computed.
 */

const https = require('https');

const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function httpGetHtml(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': HTTP_UA, 'Accept': 'text/html' },
      timeout: 12000,
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
 * Parse map stats da página de team.
 * Pattern observado: tabela com cols [Map name, Played, Won, WinRate].
 */
function _extractMapStats(html) {
  const stats = [];
  // Tabela com map names. Match contra <tr><td>MapName</td>...
  const rowRe = /<tr[^>]*>\s*<td[^>]*>(?:<[^>]*>)*\s*([A-Z][a-z]+)\s*(?:<\/[^>]*>)*\s*<\/td>\s*([\s\S]*?)<\/tr>/gi;
  const validMaps = new Set(['Ascent', 'Bind', 'Breeze', 'Fracture', 'Haven', 'Icebox', 'Lotus', 'Pearl', 'Split', 'Sunset', 'Abyss']);
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const mapName = m[1];
    if (!validMaps.has(mapName)) continue;
    // Extrai numbers do resto da row
    const numbers = [...m[2].matchAll(/<td[^>]*>\s*([\d.]+%?)\s*<\/td>/g)].map(c => c[1]);
    if (numbers.length < 2) continue;
    const played = parseInt(numbers[0], 10);
    const won = parseInt(numbers[1], 10);
    const winRate = numbers[2] ? parseFloat(numbers[2].replace('%', '')) : (played > 0 ? (won / played * 100) : 0);
    if (Number.isFinite(played) && played > 0) {
      stats.push({ map: mapName, played, won, win_rate: winRate });
    }
  }
  return stats;
}

/**
 * Parse agent composition stats.
 */
function _extractAgentStats(html) {
  const stats = [];
  // Agent rows: <tr><td>AgentName</td>...
  const validAgents = new Set([
    'Astra', 'Breach', 'Brimstone', 'Chamber', 'Clove', 'Cypher', 'Deadlock',
    'Fade', 'Gekko', 'Harbor', 'Iso', 'Jett', 'Kayo', 'Killjoy', 'Neon',
    'Omen', 'Phoenix', 'Raze', 'Reyna', 'Sage', 'Skye', 'Sova', 'Tejo',
    'Viper', 'Vyse', 'Yoru'
  ]);
  const rowRe = /<tr[^>]*>\s*<td[^>]*>(?:<[^>]*>)*\s*([A-Z][a-z]+)\s*(?:<\/[^>]*>)*\s*<\/td>\s*([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const agent = m[1];
    if (!validAgents.has(agent)) continue;
    const numbers = [...m[2].matchAll(/<td[^>]*>\s*([\d.]+%?)\s*<\/td>/g)].map(c => c[1]);
    if (numbers.length < 1) continue;
    stats.push({
      agent,
      pick_pct: parseFloat((numbers[0] || '0').replace('%', '')) || null,
      win_rate: numbers.length >= 2 ? parseFloat((numbers[1] || '0').replace('%', '')) : null,
    });
  }
  return stats;
}

/**
 * Public API.
 */
async function fetchTeamStats(teamSlug, teamId) {
  if (!teamSlug || !teamId) return { ok: false, reason: 'missing_args' };
  const url = `https://www.thespike.gg/team/${teamSlug}/${teamId}`;
  const r = await httpGetHtml(url);
  if (r.status !== 200) return { ok: false, reason: 'http_fail', status: r.status };
  const maps = _extractMapStats(r.body);
  const agents = _extractAgentStats(r.body);
  if (!maps.length && !agents.length) {
    return { ok: false, reason: 'no_stats_parsed', body_len: r.body.length };
  }
  return { ok: true, slug: teamSlug, id: teamId, maps, agents };
}

/**
 * Bulk: persiste em DB. Espera lista de { slug, id, name }.
 */
async function syncTeamStats(db, teams, opts = {}) {
  const delay = opts.delayMs ?? 1500;
  const upsertMap = db.prepare(`
    INSERT OR REPLACE INTO valorant_team_map_stats (
      team_slug, team_id, team_name, map, played, won, win_rate, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const upsertAgent = db.prepare(`
    INSERT OR REPLACE INTO valorant_team_agent_stats (
      team_slug, team_id, team_name, agent, pick_pct, win_rate, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  let teamsOk = 0, errors = 0;
  for (const t of teams) {
    const r = await fetchTeamStats(t.slug, t.id);
    if (!r.ok) { errors++; await new Promise(res => setTimeout(res, delay)); continue; }
    try {
      const tx = db.transaction(() => {
        for (const m of r.maps) upsertMap.run(t.slug, t.id, t.name || null, m.map, m.played, m.won, m.win_rate);
        for (const a of r.agents) upsertAgent.run(t.slug, t.id, t.name || null, a.agent, a.pick_pct, a.win_rate);
      });
      tx();
      teamsOk++;
    } catch (_) { errors++; }
    await new Promise(res => setTimeout(res, delay));
  }
  return { ok: true, teams_ok: teamsOk, errors, total: teams.length };
}

module.exports = { fetchTeamStats, syncTeamStats };

'use strict';

/**
 * lib/golgg-kills-scraper.js — extrai total kills per-mapa do gol.gg.
 *
 * Strategy:
 *   1. Acha série via DB (`golgg_<id>` em match_results) por team1+team2+date,
 *      OU faz lookup live via tournament-matchlist HTML.
 *   2. Da série gameId, fetcha /game/stats/<id>/page-summary/ HTML.
 *   3. Extrai navegação dos games da série (links pra outros gameIds).
 *   4. Pra mapIndex pedido, fetcha /game/stats/<targetId>/page-fullstats/ ou
 *      page-summary e extrai player KDA.
 *   5. Soma kills dos 10 players → total_kills.
 *
 * Public API: fetchKillsViaGolgg({ team1, team2, mapIndex, sentAt, db })
 *   → { totalKills?, mapNotPlayed?, reason?, gameid? }
 */

const https = require('https');

const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 12000;

function _normTeam(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

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
 * Extrai gameIds da navegação da série (página /game/stats/<id>/page-summary/).
 * gol.gg renderiza tabs Game 1/Game 2/... como `<a href="../<gameId>/page-summary/">`.
 * Retorna array ordenado por map number.
 */
function _extractSeriesGameIds(html, currentGameId) {
  // Pattern principal: <a href="..(/game)?/stats/<id>/page-(summary|game|fullstats)/">Game N</a>
  // Captura tanto links relativos (../<id>/) quanto absolutos.
  const ids = [];
  const seen = new Set();
  // Inclui o currentGameId (página atual) na lista — aparece como ativo
  if (currentGameId) {
    ids.push({ gameId: String(currentGameId), order: 0, isCurrent: true });
    seen.add(String(currentGameId));
  }
  // Regex captura href + possível "Game N" próximo (até 60 chars adiante)
  const linkRe = /href=["'][^"']*\/stats\/(\d+)\/page-(?:summary|game|fullstats)[^"']*["'][^>]*>([\s\S]{0,80}?)<\/a>/gi;
  let m;
  let order = 1;
  while ((m = linkRe.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    const label = m[2].replace(/<[^>]+>/g, '').trim();
    // Game N pattern (case insensitive)
    const gameMatch = label.match(/game\s*(\d+)/i);
    const mapNum = gameMatch ? parseInt(gameMatch[1], 10) : null;
    ids.push({ gameId: id, order: mapNum || order++, label, isCurrent: false });
    seen.add(id);
  }
  // Sort por map order (game number prioritized; fallback ordem aparição)
  ids.sort((a, b) => a.order - b.order);
  return ids;
}

/**
 * Extrai total kills da player KDA table em /game/stats/<id>/page-fullstats/ ou
 * /page-summary/.
 *
 * Padrões testados:
 *   1. Cells com formato "K/D/A" tipo "5/2/8" — players têm múltiplos
 *   2. Coluna explícita "Kills" — header column
 *   3. Sumário de team kills (rare)
 */
function _extractTotalKills(html) {
  // Estratégia 1: tables com <td>K/D/A</td> ou separados em 3 cells.
  // gol.gg page-fullstats tem tabela com cell tipo "5/2/8" pra cada player (10 rows).
  // Soma só os primeiros valores (kills).
  const kdaCells = [...html.matchAll(/<td[^>]*>\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*<\/td>/g)];
  if (kdaCells.length >= 10) {
    // Pega os 10 primeiros (5 blue + 5 red players)
    const players = kdaCells.slice(0, 10);
    const totalKills = players.reduce((s, m) => s + parseInt(m[1], 10), 0);
    if (Number.isFinite(totalKills) && totalKills > 0) {
      return { totalKills, source: 'kda_cells' };
    }
  }

  // Estratégia 2: tabela team-summary com "Kills" header.
  // Procura padrão "Total Kills" ou "Team Kills" + número.
  const totalKillsMatch = html.match(/total\s*kills[:\s<>\/td]*?(\d+)/i);
  if (totalKillsMatch) {
    const k = parseInt(totalKillsMatch[1], 10);
    if (Number.isFinite(k) && k > 0 && k < 200) {
      return { totalKills: k, source: 'total_kills_text' };
    }
  }

  // Estratégia 3: scoreboard "X - Y" próximo a "Kills".
  const scoreMatch = html.match(/kills[:\s<>\/]*?(\d+)\s*[-–]\s*(\d+)/i);
  if (scoreMatch) {
    const k1 = parseInt(scoreMatch[1], 10);
    const k2 = parseInt(scoreMatch[2], 10);
    if (Number.isFinite(k1) && Number.isFinite(k2) && (k1 + k2) > 0 && (k1 + k2) < 200) {
      return { totalKills: k1 + k2, source: 'scoreboard' };
    }
  }

  return null;
}

/**
 * Busca série gol.gg via match_results local.
 * match_id format: 'golgg_<seriesGameId>'.
 */
function _findSeriesIdFromDb(db, team1, team2, sentAt) {
  if (!db || !team1 || !team2) return null;
  const t1n = _normTeam(team1), t2n = _normTeam(team2);
  if (!t1n || !t2n) return null;
  const dateHint = sentAt ? String(sentAt).slice(0, 10) : '';
  try {
    // Match exato (norm) com janela ±10d
    const tipMs = sentAt ? Date.parse(String(sentAt).includes('T') ? sentAt : String(sentAt).replace(' ', 'T')) : Date.now();
    const before = new Date(tipMs - 10 * 86400000).toISOString().slice(0, 10);
    const after = new Date(tipMs + 10 * 86400000).toISOString().slice(0, 10);
    const row = db.prepare(`
      SELECT match_id, team1, team2, resolved_at, league
      FROM match_results
      WHERE game = 'lol'
        AND match_id LIKE 'golgg_%'
        AND substr(resolved_at, 1, 10) BETWEEN ? AND ?
        AND ((lower(replace(replace(replace(team1,' ',''),'-',''),'.','')) = ? AND lower(replace(replace(replace(team2,' ',''),'-',''),'.','')) = ?)
          OR (lower(replace(replace(replace(team1,' ',''),'-',''),'.','')) = ? AND lower(replace(replace(replace(team2,' ',''),'-',''),'.','')) = ?))
      ORDER BY ABS(julianday(resolved_at) - julianday(?)) ASC
      LIMIT 1
    `).get(before, after, t1n, t2n, t2n, t1n, dateHint || new Date().toISOString().slice(0, 10));
    if (!row) return null;
    const m = String(row.match_id).match(/^golgg_(\d+)$/);
    return m ? { seriesGameId: m[1], league: row.league, t1: row.team1, t2: row.team2, date: row.resolved_at } : null;
  } catch (_) {
    return null;
  }
}

/**
 * Search live no gol.gg /tournament/list/ + matchlist quando DB não tem.
 * Pesquisa pesada — só usado quando DB lookup falha.
 */
async function _findSeriesIdFromGolggLive(team1, team2, sentAt, leagueHint) {
  // Fallback live ainda não implementado — gol.gg listing requer match
  // do tournament name (e.g., "Esports World Cup 2026") que não temos
  // diretamente. Sync diário (sync-golgg-matches.js) cobre isso.
  return null;
}

/**
 * Public API.
 */
async function fetchKillsViaGolgg({ team1, team2, mapIndex, sentAt, db, leagueHint }) {
  if (!team1 || !team2 || !mapIndex) return { reason: 'invalid_input' };

  // Step 1: acha série gameId
  let series = _findSeriesIdFromDb(db, team1, team2, sentAt);
  if (!series) {
    series = await _findSeriesIdFromGolggLive(team1, team2, sentAt, leagueHint);
  }
  if (!series) return { reason: 'series_not_found' };

  // Step 2: fetcha series page-summary pra extrair game nav
  const seriesUrl = `https://gol.gg/game/stats/${series.seriesGameId}/page-summary/`;
  const r1 = await httpGetHtml(seriesUrl);
  if (r1.status !== 200) return { reason: 'series_http_fail', status: r1.status };

  const gameIds = _extractSeriesGameIds(r1.body, series.seriesGameId);
  if (!gameIds.length) return { reason: 'no_games_in_series' };

  // Step 3: encontra target game pelo mapIndex
  // Se gameIds tem `order` válido (de "Game N" label), usa exato.
  // Caso contrário, fallback pra ordem aparição.
  let target = gameIds.find(g => g.order === mapIndex);
  if (!target) {
    // Ordem aparição: posição mapIndex-1 do array sortado
    target = gameIds[mapIndex - 1];
  }
  if (!target) {
    // mapIndex > games totais = sweep não jogou esse mapa
    return { mapNotPlayed: true, available_count: gameIds.length };
  }

  // Step 4: fetcha target game page (tenta page-fullstats primeiro, fallback summary)
  let targetUrl = `https://gol.gg/game/stats/${target.gameId}/page-fullstats/`;
  let r2 = await httpGetHtml(targetUrl);
  if (r2.status !== 200) {
    targetUrl = `https://gol.gg/game/stats/${target.gameId}/page-summary/`;
    r2 = await httpGetHtml(targetUrl);
    if (r2.status !== 200) return { reason: 'target_http_fail', status: r2.status, gameid: target.gameId };
  }

  // Step 5: extrai total kills
  const result = _extractTotalKills(r2.body);
  if (!result) return { reason: 'kills_parse_fail', gameid: target.gameId, body_len: r2.body.length };

  return { totalKills: result.totalKills, source: `golgg_${result.source}`, gameid: target.gameId };
}

module.exports = {
  fetchKillsViaGolgg,
  _extractSeriesGameIds, // exposto pra tests
  _extractTotalKills,
};

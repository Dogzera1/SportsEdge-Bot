/**
 * vlr.js — scraper VLR.gg para dados de mapas Valorant.
 *
 * Riot não expõe API pública de Valorant esports. VLR.gg é a fonte
 * de-facto; parse HTML via regex (frágil por design).
 *
 * Rate limit: chamador deve aguardar ≥2s entre requests.
 */

const https = require('https');

const VALORANT_MAPS = /^(Ascent|Bind|Breeze|Fracture|Haven|Icebox|Lotus|Pearl|Split|Sunset|Abyss|Corrode)$/;

function _httpGet(path) {
  return new Promise((ok, ko) => {
    const req = https.request({
      host: 'www.vlr.gg',
      path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SportsEdge/1.0)' }
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => ok({ status: res.statusCode, body: b }));
    });
    req.on('error', ko);
    req.setTimeout(15000, () => { req.destroy(); ko(new Error('vlr timeout')); });
    req.end();
  });
}

/** Lista IDs de matches recentes em /matches/results?page=N */
async function fetchResults(page = 1) {
  const r = await _httpGet(`/matches/results?page=${page}`);
  if (r.status !== 200) return [];
  const ids = [...new Set([...r.body.matchAll(/href="\/(\d+)\/[a-z0-9-]+"/g)].map(m => m[1]))];
  return ids;
}

/**
 * Parseia o bloco vm-stats-game-header da página /{matchId}/?map=N.
 * Retorna { team1, team2, mapName, winner } ou null.
 */
function _parseMapHeader(html) {
  const u = html.replace(/<!--[\s\S]*?-->/g, '');
  const hdrIdx = u.indexOf('vm-stats-game-header');
  if (hdrIdx < 0) return null;
  const block = u.substring(hdrIdx, hdrIdx + 4000);

  // Team 1 (primeiro .team antes de .map)
  const t1Slice = block.match(/<div class="team"[^>]*>([\s\S]*?)<div class="map">/);
  if (!t1Slice) return null;
  const t1Name = (t1Slice[1].match(/<div class="team-name">\s*([^<]+?)\s*<\/div>/) || [])[1];
  const t1Win  = /class="score\s+mod-win"/.test(t1Slice[1]);

  // Team 2 (após .map, classe mod-right)
  const t2Slice = block.match(/<div class="team mod-right"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div style="text-align: center/);
  if (!t2Slice) return null;
  const t2Name = (t2Slice[1].match(/<div class="team-name">\s*([^<]+?)\s*<\/div>/) || [])[1];
  const t2Win  = /class="score\s+mod-win"/.test(t2Slice[1]);

  // Map name
  const mapMatch = block.match(/<div class="map">[\s\S]*?<span[^>]*>\s*([A-Z][a-z]+)\s*(?:<|\s)/);
  const mapName = mapMatch?.[1];

  if (!t1Name || !t2Name || !mapName) return null;
  if (!VALORANT_MAPS.test(mapName)) return null;
  const winner = t1Win ? t1Name.trim() : (t2Win ? t2Name.trim() : null);
  if (!winner) return null;

  return { team1: t1Name.trim(), team2: t2Name.trim(), mapName, winner };
}

/**
 * Parseia TODOS os blocos vm-stats-game-header de um match page.
 * VLR serve todos os maps num único HTML — 1 request basta.
 */
function _parseAllMapHeaders(html) {
  const u = html.replace(/<!--[\s\S]*?-->/g, '');
  const parts = u.split('vm-stats-game-header').slice(1);
  const out = [];
  for (const part of parts) {
    const block = 'vm-stats-game-header' + part.substring(0, 4000);
    const parsed = _parseMapHeader(block);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Retorna { team1, team2, maps: [{pos, name, winner}] } via um único fetch.
 */
async function fetchMatchMaps(matchId) {
  const r = await _httpGet(`/${matchId}/`);
  if (r.status !== 200) return null;
  const headers = _parseAllMapHeaders(r.body);
  if (!headers.length) return null;
  const team1 = headers[0].team1;
  const team2 = headers[0].team2;
  const maps = headers.map((h, i) => ({
    pos: i + 1,
    name: h.mapName,
    winner: h.winner,
  }));
  return { team1, team2, maps };
}

module.exports = { fetchResults, fetchMatchMaps };

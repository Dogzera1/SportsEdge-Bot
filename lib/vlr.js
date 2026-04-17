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

// ── Live stats (partidas em curso) ──────────────────────────────────────────
//
// Complementa o PandaScore pro bot de Valorant: expõe mapa atual + split CT/Atk
// por time, current round, placar parcial dentro do mapa, format e score de série.
// Cache curto (15s) via cachedHttpGet pra não martelar o VLR durante loops.

const { cachedHttpGet } = require('./utils');
const VLR_BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

function _normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
function _namesMatch(vlrName, query) {
  const a = _normName(vlrName), b = _normName(query);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}
function _vlrEnabled() {
  const v = String(process.env.VLR_ENABLED || 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

// ── Circuit breaker: se VLR falhar repetidamente (parse quebrou, site fora),
// desliga temporariamente pra parar de spamar log/network. Reseta após cooldown.
const _vlrBreaker = { failures: 0, openedAt: 0 };
const VLR_BREAKER_THRESHOLD = parseInt(process.env.VLR_BREAKER_THRESHOLD || '4', 10);
const VLR_BREAKER_COOLDOWN_MS = parseInt(process.env.VLR_BREAKER_COOLDOWN_MS || String(15 * 60 * 1000), 10);
function _vlrOpen() {
  if (_vlrBreaker.openedAt && (Date.now() - _vlrBreaker.openedAt) > VLR_BREAKER_COOLDOWN_MS) {
    _vlrBreaker.openedAt = 0;
    _vlrBreaker.failures = 0;
  }
  return _vlrBreaker.openedAt > 0;
}
function _vlrNoteFail() {
  _vlrBreaker.failures++;
  if (_vlrBreaker.failures >= VLR_BREAKER_THRESHOLD && !_vlrBreaker.openedAt) {
    _vlrBreaker.openedAt = Date.now();
  }
}
function _vlrNoteSuccess() {
  _vlrBreaker.failures = 0;
  _vlrBreaker.openedAt = 0;
}
function vlrBreakerStatus() {
  return {
    failures: _vlrBreaker.failures,
    open: _vlrOpen(),
    openedAt: _vlrBreaker.openedAt || null,
    cooldownMs: VLR_BREAKER_COOLDOWN_MS,
  };
}

async function _cachedGet(path, ttlMs, cacheKey) {
  if (_vlrOpen()) return null;
  const url = `https://www.vlr.gg${path}`;
  const r = await cachedHttpGet(url, {
    ttlMs, provider: 'vlr', headers: VLR_BROWSER,
    cacheKey: cacheKey || `vlr:${path}`,
  }).catch(() => null);
  if (!r || r.status !== 200) { _vlrNoteFail(); return null; }
  _vlrNoteSuccess();
  return r.body || '';
}

/** Procura em /matches a partida live que bate com team1/team2. */
async function findLiveMatch(team1, team2) {
  if (!_vlrEnabled() || !team1 || !team2) return null;
  const html = await _cachedGet('/matches', 30_000, 'vlr:matches-list');
  if (!html) return null;
  const blocks = [...html.matchAll(/<a[^>]*class="[^"]*match-item[^"]*"[^>]*href="(\/(\d+)\/[^"]+)"[\s\S]*?<\/a>/g)];
  for (const b of blocks) {
    const [block, , id] = b;
    if (!/live-now|match-item-live|\bLIVE\b/i.test(block)) continue;
    const names = [...block.matchAll(/match-item-vs-team-name[^>]*>\s*<div[^>]*class="text-of"[^>]*>([^<]+)<\/div>/g)]
      .map(m => m[1].trim());
    if (names.length < 2) continue;
    const [a, c] = names;
    const fwd = _namesMatch(a, team1) && _namesMatch(c, team2);
    const rev = _namesMatch(a, team2) && _namesMatch(c, team1);
    if (!fwd && !rev) continue;
    return { matchId: id, teamsOnVlr: [a, c] };
  }
  return null;
}

/** Parse completo da página /vlr.gg/{matchId} (mapas, sides, score). */
async function getMatchStats(matchId) {
  if (!_vlrEnabled() || !matchId) return null;
  const html = await _cachedGet(`/${matchId}`, 15_000, `vlr:match:${matchId}`);
  if (!html) return null;

  const seriesM = html.match(/match-header-vs-score"[\s\S]*?js-spoiler[\s\S]*?<span[^>]*>(\d+)<\/span>[\s\S]*?<span[^>]*>(\d+)<\/span>/);
  const seriesScore = seriesM ? { t1: parseInt(seriesM[1], 10), t2: parseInt(seriesM[2], 10) } : null;

  const headerTeams = [...html.matchAll(/match-header-link-name[\s\S]*?<div[^>]*class="wf-title-med[^"]*"[^>]*>([^<]+)</g)]
    .map(m => m[1].trim()).slice(0, 2);

  const fmtM = html.match(/match-header-vs-note[^>]*>([^<]+)<\/div>/);
  const format = fmtM ? fmtM[1].trim() : null;

  const liveM = html.match(/js-map-switch[^"]*mod-live[^"]*"[^>]*data-game-id="(\d+)"/);
  const activeM = html.match(/js-map-switch[^"]*mod-active[^"]*"[^>]*data-game-id="(\d+)"/);
  const liveMapGameId = liveM ? liveM[1] : null;
  const activeMapGameId = activeM ? activeM[1] : null;

  const mapBlocks = [...html.matchAll(/<div class="vm-stats-game(?:\s+[^"]*)?"\s+data-game-id="(\d+)">([\s\S]*?)(?=<div class="vm-stats-game(?:\s+[^"]*)?"\s+data-game-id=|<div class="vm-stats-gamesnav|$)/g)];
  const games = [];
  for (const mb of mapBlocks) {
    const [, gameId, body] = mb;
    const mapName = (body.match(/<div class="map">[\s\S]*?<span[^>]*>\s*([A-Z][a-z]+)\s*(?:<|\s)/) || [])[1] || null;
    const durationM = body.match(/map-duration[^>]*>\s*([^<]+?)\s*</);
    const duration = durationM ? durationM[1].trim() : null;

    // Extrai 2 blocos "team" (esquerdo e direito com mod-right). O lookahead
    // precisa ser específico pra não casar com "team-name" (div interno de nome).
    const teamSlice = (cls) => {
      const re = new RegExp(`<div class="team${cls}"[^>]*>([\\s\\S]*?)(?=<div class="team[\\s"]|<div class="map">|<div class="vm-stats|<\\/div>\\s*<div style="text-align: center)`);
      const m = body.match(re);
      return m ? m[1] : '';
    };
    const leftBody  = teamSlice('');
    const rightBody = teamSlice('\\s+mod-right');

    const parseTeam = (blk) => {
      if (!blk) return null;
      const name = (blk.match(/<div class="team-name">\s*([^<]+?)\s*<\/div>/) || [])[1];
      const score = parseInt((blk.match(/class="score(?:\s+[^"]*)?"[^>]*>\s*(\d+)/) || [])[1] || '0', 10);
      const ct  = parseInt((blk.match(/class="mod-ct"[^>]*>\s*(\d+)/) || [])[1] || '0', 10);
      const atk = parseInt((blk.match(/class="mod-t"[^>]*>\s*(\d+)/) || [])[1] || '0', 10);
      const won = /class="score\s+mod-win/.test(blk);
      return name ? { name: name.trim(), score, ct, atk, won } : null;
    };
    const teams = [parseTeam(leftBody), parseTeam(rightBody)].filter(Boolean);

    games.push({
      gameId, mapName, duration, teams,
      isLive: gameId === liveMapGameId,
      isActive: gameId === activeMapGameId,
      _roundHistoryBody: body, // preservado p/ derivar sides exatos no summarizeLive
    });
  }

  return {
    matchId: String(matchId), headerTeams, format, seriesScore,
    liveMapGameId, activeMapGameId, games,
  };
}

/**
 * Parseia a linha de rounds de um mapa específico (vlr-rounds-row). Cada round
 * tem 2 rnd-sq — primeiro pra TEAM1 (VLR top row), segundo pra TEAM2. Classe
 * "mod-win mod-ct" = venceu jogando CT; "mod-win mod-t" = venceu jogando Atk.
 * Retorna { t1StartSide, t2StartSide, lastRoundPlayed, rounds[] } ou null.
 */
function _parseRoundHistory(gameBody) {
  if (!gameBody) return null;
  // Extrai apenas os cols com rnd-num (pula o col de header com team names).
  const cols = [...gameBody.matchAll(/<div class="vlr-rounds-row-col"(?:\s+title="[^"]*")?\s*>([\s\S]*?)<\/div>\s*(?=<div class="vlr-rounds-row-col|<\/div>\s*<\/div>\s*<\/div>)/g)];
  const rounds = [];
  let t1StartSide = null, t2StartSide = null;
  for (const c of cols) {
    const body = c[1];
    const numM = body.match(/<div class="rnd-num">\s*(\d+)\s*<\/div>/);
    if (!numM) continue;
    const num = parseInt(numM[1], 10);
    const rndSqs = [...body.matchAll(/<div class="rnd-sq([^"]*)"/g)].map(m => m[1].trim());
    if (rndSqs.length < 2) continue;
    // Round 1 define os sides iniciais.
    let winner = null, winnerSide = null;
    if (/mod-win/.test(rndSqs[0])) {
      winner = 't1';
      winnerSide = /mod-ct/.test(rndSqs[0]) ? 'CT' : (/mod-t/.test(rndSqs[0]) ? 'Atk' : null);
    } else if (/mod-win/.test(rndSqs[1])) {
      winner = 't2';
      winnerSide = /mod-ct/.test(rndSqs[1]) ? 'CT' : (/mod-t/.test(rndSqs[1]) ? 'Atk' : null);
    }
    rounds.push({ num, winner, winnerSide });
    if (num === 1 && winnerSide) {
      if (winner === 't1') { t1StartSide = winnerSide; t2StartSide = winnerSide === 'CT' ? 'Atk' : 'CT'; }
      else                 { t2StartSide = winnerSide; t1StartSide = winnerSide === 'CT' ? 'Atk' : 'CT'; }
    }
  }
  const lastRoundPlayed = rounds.length ? Math.max(...rounds.map(r => r.num)) : 0;
  return { t1StartSide, t2StartSide, lastRoundPlayed, rounds };
}

// Deriva o side do round N a partir do side inicial (half 1).
// Rounds 1–12 = side inicial; 13–24 = invertido; 25+ = overtime (marca "OT").
function _sideAtRound(startSide, round) {
  if (!startSide || !round) return '?';
  if (round <= 12) return startSide;
  if (round <= 24) return startSide === 'CT' ? 'Atk' : 'CT';
  return 'OT';
}

/**
 * Resumo compacto. Alinha t1/t2 do retorno com os nomes team1/team2 passados
 * (que vêm do PandaScore/TheOdds) — usa fuzzy match nos nomes do VLR.
 */
function summarizeLive(stats, team1, team2) {
  if (!stats || !Array.isArray(stats.games) || !stats.games.length) return null;
  const liveGame = stats.games.find(g => g.isLive)
    || stats.games.find(g => g.isActive)
    || stats.games[stats.games.length - 1];
  if (!liveGame || !liveGame.teams || liveGame.teams.length < 2) return null;

  const [a, b] = liveGame.teams;
  const aIsT1 = _namesMatch(a.name, team1) || _namesMatch(team1, a.name);
  const t1 = aIsT1 ? a : b;
  const t2 = aIsT1 ? b : a;

  const totalRounds = (t1.score || 0) + (t2.score || 0);
  const currentRound = totalRounds + 1;

  // Deriva sides exatos via histórico round-a-round (round 1 define os sides iniciais).
  const history = liveGame._roundHistoryBody ? _parseRoundHistory(liveGame._roundHistoryBody) : null;
  const vlrT1Start = history?.t1StartSide || null;
  const vlrT2Start = history?.t2StartSide || null;
  // VLR t1 (top row) = a; VLR t2 (bottom row) = b. Mapeia pros nossos user-team.
  const userT1Start = aIsT1 ? vlrT1Start : vlrT2Start;
  const userT2Start = aIsT1 ? vlrT2Start : vlrT1Start;

  const sideFallback = (team) => {
    // Fallback heurístico quando history ausente — só confiável no half 1.
    if (totalRounds <= 0) return '?';
    if (totalRounds < 12) {
      if ((team.ct || 0) > 0 && (team.atk || 0) === 0) return 'CT';
      if ((team.atk || 0) > 0 && (team.ct || 0) === 0) return 'Atk';
    }
    return '?';
  };

  const t1Side = _sideAtRound(userT1Start, currentRound) || sideFallback(t1);
  const t2Side = _sideAtRound(userT2Start, currentRound) || sideFallback(t2);

  return {
    matchId: stats.matchId,
    format: stats.format,
    seriesScore: stats.seriesScore,
    currentMap: liveGame.mapName,
    gameId: liveGame.gameId,
    isLive: !!liveGame.isLive,
    currentRound,
    duration: liveGame.duration,
    t1: { name: t1.name, score: t1.score, ct: t1.ct, atk: t1.atk, side: t1Side, startSide: userT1Start || null },
    t2: { name: t2.name, score: t2.score, ct: t2.ct, atk: t2.atk, side: t2Side, startSide: userT2Start || null },
    // Flag pra consumidor decidir se é seguro apostar (side ambíguo em OT ou sem history).
    sideConfident: !!(userT1Start && userT2Start && currentRound <= 24),
    overtime: currentRound > 24,
  };
}

module.exports = { fetchResults, fetchMatchMaps, findLiveMatch, getMatchStats, summarizeLive, vlrBreakerStatus };

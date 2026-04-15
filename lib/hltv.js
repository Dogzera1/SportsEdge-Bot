/**
 * hltv.js — Enriquecimento de CS2 via HLTV (proxy-first, igual Sofascore).
 *
 * Por quê: HLTV é a fonte canônica de stats CS (rankings, forma, H2H, mapas).
 * Não tem API oficial — só HTML scraping, e Cloudflare bloqueia curl direto.
 * Solução: proxy ngrok que repassa hltv.org (mesmo padrão SOFASCORE_PROXY_BASE).
 *
 * Env:
 *   HLTV_PROXY_BASE   — URL do proxy (ex: https://xxx.ngrok-free.app)
 *   HLTV_DIRECT=true  — tenta hltv.org direto (raramente passa do CF)
 *   HLTV_ENRICH_CS    — default: ligado se proxy existir
 *
 * Parsing: regex sobre HTML (sem cheerio pra não adicionar dependência).
 * HLTV muda layout periodicamente — quando quebrar, validar regex.
 */
const { safeParse, cachedHttpGet } = require('./utils');

const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://www.hltv.org/',
  'ngrok-skip-browser-warning': 'true'
};

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function namesMatch(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function _directEnabled() {
  const v = String(process.env.HLTV_DIRECT || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function _enabled() {
  const hasProxy = !!(process.env.HLTV_PROXY_BASE || '').trim();
  const env = String(process.env.HLTV_ENRICH_CS || '').toLowerCase();
  return env === 'true' || env === '1' || env === 'yes'
    || (env !== 'false' && env !== '0' && env !== 'no' && hasProxy);
}

function buildUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function _urls(path) {
  const proxy = (process.env.HLTV_PROXY_BASE || '').trim().replace(/\/+$/, '');
  const urls = [];
  if (proxy) urls.push(buildUrl(proxy, path));
  if (_directEnabled()) urls.push(`https://www.hltv.org${path}`);
  return [...new Set(urls)];
}

async function httpHtml(url, { ttlMs = 15 * 60 * 1000 } = {}) {
  const r = await cachedHttpGet(url, {
    ttlMs, provider: 'hltv', headers: BROWSER_HEADERS,
    cacheKey: `hltv:${url}`
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  const body = String(r.body || '');
  // Detecta página de bloqueio Cloudflare
  if (/just a moment|cf-browser-verification|cloudflare/i.test(body) && body.length < 5000) return null;
  return body;
}

async function fetchFirstHtml(urls) {
  for (const u of urls) {
    const html = await httpHtml(u).catch(() => null);
    if (html) return { url: u, html };
  }
  return null;
}

// ────────────────────────────────────────
// Parsers regex
// ────────────────────────────────────────

/**
 * Extrai lista de teams do ranking top 30.
 * URL: /ranking/teams
 * Estrutura: `<div class="ranked-team standard-box">` com <span class="name">{Team}</span>
 *            e <span class="position">#1</span> + <a href="/team/{id}/{slug}">
 */
function parseTopTeams(html) {
  const teams = [];
  const blockRe = /<div class="ranked-team standard-box">([\s\S]*?)<\/div>\s*<\/div>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1];
    const pos = (block.match(/<span class="position">#?(\d+)/) || [])[1];
    const name = (block.match(/<span class="name">([^<]+)<\/span>/) || [])[1];
    const teamLink = (block.match(/href="\/team\/(\d+)\/([^"]+)"/) || []);
    const points = (block.match(/\((\d+)\s*points?\)/i) || [])[1];
    if (name && teamLink[1]) {
      teams.push({
        rank: pos ? parseInt(pos, 10) : null,
        name: name.trim(),
        teamId: parseInt(teamLink[1], 10),
        slug: teamLink[2] || '',
        points: points ? parseInt(points, 10) : null,
      });
    }
  }
  return teams;
}

/**
 * Extrai matches recentes da página do team.
 * URL: /team/{id}/{slug}
 * Tabela "Recent results" → linhas com data, oponente, score W/L
 */
function parseTeamRecent(html, limit = 10) {
  const out = [];
  // Bloco "Recent results" — table com class result-con
  const sectionRe = /Recent results([\s\S]*?)(?:<\/section>|<div class="standard-headline)/i;
  const sectionMatch = sectionRe.exec(html);
  const section = sectionMatch ? sectionMatch[1] : html;

  const rowRe = /<a[^>]+class="[^"]*a-reset[^"]*"[^>]+href="\/matches\/(\d+)[^"]*"[\s\S]*?<\/a>/g;
  let m;
  while ((m = rowRe.exec(section)) !== null && out.length < limit) {
    const block = m[0];
    const matchId = parseInt(m[1], 10);
    const score = (block.match(/<td class="score-cell">[\s\S]*?(\d+)\s*[-:]\s*(\d+)/i) || []);
    const opp = (block.match(/<div class="team-cell[^"]*">\s*<div[^>]*>([^<]+)</i) || [])[1];
    const winLoss = block.includes('won') || /score-cell[^"]*won/i.test(block) ? 'W'
                  : block.includes('lost') || /score-cell[^"]*lost/i.test(block) ? 'L' : null;
    out.push({
      matchId,
      opponent: opp ? opp.trim() : null,
      score: score[1] && score[2] ? `${score[1]}-${score[2]}` : null,
      result: winLoss,
    });
  }
  return out;
}

function _streak(recent) {
  if (!recent?.length) return 0;
  const first = recent[0]?.result;
  if (!first) return 0;
  let n = 0;
  for (const r of recent) {
    if (r.result === first) n++; else break;
  }
  return first === 'W' ? n : -n;
}

function summarizeForm(recent) {
  if (!recent?.length) return null;
  const useful = recent.filter(r => r.result === 'W' || r.result === 'L');
  if (!useful.length) return null;
  const wins = useful.filter(r => r.result === 'W').length;
  const losses = useful.length - wins;
  return {
    wins, losses,
    winRate: Math.round((wins / useful.length) * 100),
    recent: useful.map(r => r.result),
    streak: _streak(useful),
  };
}

/**
 * Tenta achar um team_id pelo nome via /search?term=
 * URL: /search?term={query} → snippet HTML com /team/{id}/{slug}
 */
async function findTeamId(name) {
  const q = encodeURIComponent(String(name || '').trim());
  if (!q) return null;
  const found = await fetchFirstHtml(_urls(`/search?term=${q}`));
  if (!found) return null;
  // Match primeiro link de team
  const m = found.html.match(/href="\/team\/(\d+)\/([^"]+)"[^>]*>([^<]+)</i);
  if (!m) return null;
  return { teamId: parseInt(m[1], 10), slug: m[2], name: m[3].trim() };
}

async function getTeamRecentMatches(teamId, slug = 'team', limit = 10) {
  if (!teamId) return null;
  const found = await fetchFirstHtml(_urls(`/team/${teamId}/${slug}`));
  if (!found) return null;
  const recent = parseTeamRecent(found.html, limit);
  return summarizeForm(recent);
}

/**
 * Enrichment principal de um match CS.
 * @param {string} team1
 * @param {string} team2
 * @param {string} commenceIso - opcional, pra restringir busca
 * @returns {Promise<null | { form1, form2, h2h, team1Id, team2Id }>}
 */
async function enrichMatch(team1, team2, commenceIso) {
  if (!_enabled()) return null;

  const [t1Search, t2Search] = await Promise.all([
    findTeamId(team1).catch(() => null),
    findTeamId(team2).catch(() => null),
  ]);
  if (!t1Search?.teamId || !t2Search?.teamId) return null;

  const [form1, form2] = await Promise.all([
    getTeamRecentMatches(t1Search.teamId, t1Search.slug).catch(() => null),
    getTeamRecentMatches(t2Search.teamId, t2Search.slug).catch(() => null),
  ]);

  // H2H simplificado: filtra recent de team1 onde opponent === team2
  let h2h = null;
  try {
    const found = await fetchFirstHtml(_urls(`/team/${t1Search.teamId}/${t1Search.slug}`));
    if (found) {
      const recent = parseTeamRecent(found.html, 50);
      const matches = recent.filter(r => namesMatch(r.opponent || '', team2));
      const t1w = matches.filter(r => r.result === 'W').length;
      const t2w = matches.filter(r => r.result === 'L').length;
      h2h = { t1Wins: t1w, t2Wins: t2w, totalMatches: t1w + t2w };
    }
  } catch (_) {}

  if (!form1 && !form2 && !h2h?.totalMatches) return null;

  return {
    form1, form2,
    h2h: h2h || { t1Wins: 0, t2Wins: 0, totalMatches: 0 },
    team1Id: t1Search.teamId,
    team2Id: t2Search.teamId,
  };
}

/**
 * Top 30 ranking — útil pra contexto em logs e como fator ML auxiliar.
 */
async function getTopTeams() {
  if (!_enabled()) return [];
  const found = await fetchFirstHtml(_urls('/ranking/teams'));
  if (!found) return [];
  return parseTopTeams(found.html);
}

/**
 * Usa endpoint /api/matches do proxy (JSON parseado) pra encontrar HLTV match_id
 * pelos nomes dos times — necessário pra chamar scorebot.
 */
async function getHltvMatchId(team1, team2, commenceIso) {
  if (!_enabled()) return null;
  const proxy = (process.env.HLTV_PROXY_BASE || '').trim().replace(/\/+$/, '');
  if (!proxy) return null;

  const url = buildUrl(proxy, '/api/matches');
  const r = await cachedHttpGet(url, {
    ttlMs: 60 * 1000, provider: 'hltv', headers: BROWSER_HEADERS,
    cacheKey: `hltv:api-matches`
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  const j = safeParse(r.body, null);
  const arr = j?.matches || [];
  if (!arr.length) return null;

  const targetMs = commenceIso ? new Date(commenceIso).getTime() : null;
  const windowMs = 12 * 60 * 60 * 1000;

  let best = null;
  let bestScore = 0;
  for (const m of arr) {
    const [t1, t2] = m.teams || [];
    if (!t1 || !t2) continue;
    const fwd = namesMatch(t1, team1) && namesMatch(t2, team2);
    const rev = namesMatch(t1, team2) && namesMatch(t2, team1);
    if (!fwd && !rev) continue;
    // penaliza se a data estiver longe
    let dateBonus = 1;
    if (targetMs && m.startUnixMs) {
      const diff = Math.abs(m.startUnixMs - targetMs);
      if (diff > windowMs) continue;
      dateBonus = 1 - (diff / windowMs) * 0.5;
    }
    const liveBonus = m.live ? 1.2 : 1;
    const score = dateBonus * liveBonus;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  if (!best) return null;
  return { matchId: best.matchId, live: !!best.live, url: best.url, event: best.event };
}

/**
 * Snapshot ao vivo do scorebot HLTV (proxy abre WS, coleta N segundos, devolve JSON).
 * @param {number} matchId — HLTV match id
 * @param {number} seconds — 2..20, default 10
 */
async function getScoreboard(matchId, seconds = 10) {
  if (!_enabled() || !matchId) return null;
  const proxy = (process.env.HLTV_PROXY_BASE || '').trim().replace(/\/+$/, '');
  if (!proxy) return null;
  const s = Math.max(2, Math.min(20, parseInt(seconds, 10) || 10));
  const url = buildUrl(proxy, `/api/scorebot/${matchId}?snapshot=${s}`);
  const r = await cachedHttpGet(url, {
    ttlMs: 8 * 1000, provider: 'hltv', headers: BROWSER_HEADERS,
    cacheKey: `hltv:scorebot:${matchId}:${s}`
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  return safeParse(r.body, null);
}

/**
 * Extrai resumo compacto do scoreboard pra passar pra IA.
 */
function summarizeScoreboard(sb) {
  if (!sb?.scoreboard) return null;
  const s = sb.scoreboard;
  const terr = s.terroristScore ?? 0;
  const ct = s.counterTerroristScore ?? 0;
  const round = s.currentRound ?? (terr + ct + 1);
  const mapName = s.mapName || 'unknown';

  const players = (arr, side) => (arr || []).map(p => ({
    name: p.nick || p.name,
    hp: p.hp ?? null,
    money: p.money ?? null,
    k: p.score ?? p.kills ?? 0,
    d: p.deaths ?? 0,
    a: p.assists ?? 0,
    side,
  }));

  return {
    mapName,
    round,
    scoreT: terr,
    scoreCT: ct,
    bombPlanted: !!s.bombPlanted,
    live: !!s.live,
    frozen: !!s.frozen,
    players: [...players(s.TERRORIST, 'T'), ...players(s.CT, 'CT')],
  };
}

module.exports = {
  enrichMatch,
  getTeamRecentMatches,
  findTeamId,
  getTopTeams,
  namesMatch,
  getHltvMatchId,
  getScoreboard,
  summarizeScoreboard,
  _enabled,
};

/**
 * pinnacle.js — Cliente genérico da Pinnacle Guest API (funciona do BR, sem auth real).
 *
 * Endpoint usado pelo próprio frontend pinnacle.com. X-API-Key pública.
 *
 * Sport IDs confirmados:
 *   6=Boxing, 10=Darts, 12=E-Sports, 22=MMA, 28=Snooker, 29=Soccer, 33=Tennis
 *
 * Over PINNACLE_API_KEY via env caso a key pública rotacione.
 */
'use strict';

const { safeParse, cachedHttpGet, log } = require('./utils');

const API_BASE = 'https://guest.api.arcadia.pinnacle.com';
const API_KEY = process.env.PINNACLE_API_KEY || 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'X-API-Key': API_KEY,
  'Referer': 'https://www.pinnacle.com/',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9'
};

function americanToDecimal(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p === 0) return null;
  if (p > 0) return +((p / 100) + 1).toFixed(3);
  return +((100 / Math.abs(p)) + 1).toFixed(3);
}

async function _get(path, { ttlMs = 3 * 60 * 1000 } = {}) {
  const url = `${API_BASE}${path}`;
  const r = await cachedHttpGet(url, {
    provider: 'pinnacle', ttlMs, headers: HEADERS, cacheKey: `pinnacle:${url}`
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  return safeParse(r.body, null);
}

async function listSportMatchups(sportId) {
  const data = await _get(`/0.1/sports/${sportId}/matchups?brandId=0`);
  return Array.isArray(data) ? data : [];
}

async function getMatchupMarkets(matchupId) {
  return _get(`/0.1/matchups/${matchupId}/markets/related/straight`);
}

/**
 * Extrai odds moneyline de um matchup (home/away), convertendo American → Decimal.
 * @param {Object} matchup — item de listSportMatchups
 * @returns {Object|null} { id, league, group, startTime, status, team1, team2, oddsT1, oddsT2 }
 */
async function extractMoneyline(matchup) {
  try {
    const home = (matchup.participants || []).find(p => p.alignment === 'home');
    const away = (matchup.participants || []).find(p => p.alignment === 'away');
    if (!home?.name || !away?.name) return null;

    const markets = await getMatchupMarkets(matchup.id);
    if (!Array.isArray(markets)) return null;
    const ml = markets.find(x => x.type === 'moneyline' && x.period === 0 && x.status === 'open');
    if (!ml?.prices) return null;

    const ph = ml.prices.find(p => p.designation === 'home');
    const pa = ml.prices.find(p => p.designation === 'away');
    const oddsHome = americanToDecimal(ph?.price);
    const oddsAway = americanToDecimal(pa?.price);
    if (!oddsHome || !oddsAway) return null;

    return {
      id: matchup.id,
      league: matchup.league?.name || null,
      leagueId: matchup.league?.id,
      group: matchup.league?.group,
      startTime: matchup.startTime,
      status: matchup.isLive ? 'live' : 'upcoming',
      team1: home.name,
      team2: away.name,
      oddsT1: oddsHome,
      oddsT2: oddsAway,
    };
  } catch (e) {
    log('WARN', 'PINNACLE', `matchup ${matchup?.id}: ${e.message}`);
    return null;
  }
}

/**
 * Fluxo completo para qualquer esporte: lista matchups + extrai moneylines.
 * @param {number|string} sportId
 * @param {Function} [leagueFilter] — (matchup) => boolean para filtrar antes de pegar odds
 */
async function fetchSportMatchOdds(sportId, leagueFilter) {
  const matchups = await listSportMatchups(sportId);
  if (!matchups.length) return [];
  const filtered = typeof leagueFilter === 'function'
    ? matchups.filter(leagueFilter)
    : matchups;
  const out = [];
  for (const m of filtered) {
    const row = await extractMoneyline(m);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Ranking implícito via de-juice das odds Pinnacle.
 * Pinnacle é o book mais afiado do mundo; suas odds de-juiced são um proxy decente
 * de ranking real quando não temos rank oficial (snooker.org etc.)
 *
 * Retorna { probA, probB } onde A=team1/home, B=team2/away (de-juice simples).
 */
function impliedProbsFromOdds(oddsA, oddsB) {
  const a = Number(oddsA), b = Number(oddsB);
  if (!a || !b || a <= 1 || b <= 1) return null;
  const ra = 1 / a, rb = 1 / b;
  const vig = ra + rb;
  return { probA: ra / vig, probB: rb / vig };
}

/**
 * Extrai moneyline de um period específico de um matchup (série).
 *
 * @param {number|string} matchupId — ID da série-raiz
 * @param {number} period — 0=série, 1..5=mapa N
 * @returns {Promise<{ oddsHome, oddsAway, status, period } | null>}
 */
async function getMatchupMoneylineByPeriod(matchupId, period) {
  const markets = await getMatchupMarkets(matchupId);
  if (!Array.isArray(markets)) return null;
  // Pode haver múltiplos moneyline entries pro mesmo period (alt lines) — pega o primeiro aberto
  const ml = markets.find(m =>
    m.type === 'moneyline' &&
    m.period === period &&
    m.status === 'open' &&
    Array.isArray(m.prices) &&
    m.prices.length >= 2
  );
  if (!ml) return null;
  const ph = ml.prices.find(p => p.designation === 'home');
  const pa = ml.prices.find(p => p.designation === 'away');
  const oddsHome = americanToDecimal(ph?.price);
  const oddsAway = americanToDecimal(pa?.price);
  if (!oddsHome || !oddsAway) return null;
  return { oddsHome, oddsAway, status: ml.status, period };
}

/**
 * Extrai mercados de handicap pra um period. Pinnacle expõe handicaps inteiros
 * e meio-pontos; filtramos meio-pontos (0.5) pra evitar push.
 *
 * @param {number|string} matchupId
 * @param {number} period — 0=série, 1..5=mapa N
 * @returns {Promise<Array<{ line, oddsHome, oddsAway, period }>>}
 */
async function getMatchupHandicaps(matchupId, period, opts = {}) {
  const markets = await getMatchupMarkets(matchupId);
  if (!Array.isArray(markets)) return [];
  // BUG FIX 2026-04-23: Pinnacle tennis cria VIRTUAL matchups separados pra
  // sets e games. Ex: parent Lajovic vs Rinderknech tem 2 virtuais:
  //   matchupId X "(Sets)": spreads só ±1.5 sets
  //   matchupId Y "(Games)": spreads 1.0/1.5/2.0/2.5/3.0 games
  // getMatchupMarkets(parent) retorna markets de AMBOS. Sem filtrar, scanner
  // misturava → 97% hit fake em handicapSets/home.
  //
  // Heurística: agrupa markets por matchupId e escolhe o grupo com MAIS lines
  // distintas. Em tennis Bo3, virtual games sempre tem ≥3 lines (1.0, 2.0, etc)
  // enquanto sets tem 1-2 (só ±1.5). Em esports (não-virtualizado), há 1 grupo
  // só e o fallback passa tudo.
  //
  // Override pra retornar tudo (esports legacy ou debug): opts.includeAll=true.
  const includeAll = opts.includeAll === true;

  // Parse all candidates sem dedup
  const all = [];
  for (const m of markets) {
    if (m.type !== 'spread' && m.type !== 'handicap') continue;
    if (m.period !== period) continue;
    if (m.status !== 'open') continue;
    if (!Array.isArray(m.prices) || m.prices.length < 2) continue;
    const ph = m.prices.find(p => p.designation === 'home');
    const pa = m.prices.find(p => p.designation === 'away');
    if (!ph || !pa) continue;
    const oddsHome = americanToDecimal(ph.price);
    const oddsAway = americanToDecimal(pa.price);
    if (!oddsHome || !oddsAway) continue;
    const line = Number(ph.points);
    if (!Number.isFinite(line)) continue;
    if (Math.abs(line * 2) % 2 !== 1) continue; // meio-ponto only
    all.push({ matchupId: Number(m.matchupId), line, oddsHome, oddsAway, period });
  }

  if (!all.length) return [];

  // Agrupa por matchupId
  const byMatch = new Map();
  for (const r of all) {
    if (!byMatch.has(r.matchupId)) byMatch.set(r.matchupId, []);
    byMatch.get(r.matchupId).push(r);
  }

  // Se há >1 grupo e não é includeAll, escolhe o com mais lines distintas (= games virtual)
  let chosen = all;
  if (byMatch.size > 1 && !includeAll) {
    let bestId = null, bestCount = 0;
    for (const [mid, list] of byMatch) {
      const uniq = new Set(list.map(l => l.line));
      if (uniq.size > bestCount) { bestCount = uniq.size; bestId = mid; }
    }
    chosen = byMatch.get(bestId) || all;
  }

  const seen = new Set();
  return chosen
    .filter(r => { if (seen.has(r.line)) return false; seen.add(r.line); return true; })
    .map(({ line, oddsHome, oddsAway, period }) => ({ line, oddsHome, oddsAway, period }));
}

/**
 * Extrai totals (over/under) pra um period.
 *
 * @param {number|string} matchupId
 * @param {number} period
 * @returns {Promise<Array<{ line, oddsOver, oddsUnder, period }>>}
 */
async function getMatchupTotals(matchupId, period, opts = {}) {
  const markets = await getMatchupMarkets(matchupId);
  if (!Array.isArray(markets)) return [];
  // Mesma heurística de getMatchupHandicaps: agrupa por matchupId e escolhe o
  // virtual com MAIOR range de lines. Em tennis Bo3, (Games) tem line 22, 23,
  // 23.5, etc (5+ lines) enquanto (Sets) tem só 2.5 (1 line). Games vence.
  const includeAll = opts.includeAll === true;
  const all = [];
  for (const m of markets) {
    if (m.type !== 'total') continue;
    if (m.period !== period) continue;
    if (m.status !== 'open') continue;
    if (!Array.isArray(m.prices) || m.prices.length < 2) continue;
    const po = m.prices.find(p => p.designation === 'over');
    const pu = m.prices.find(p => p.designation === 'under');
    if (!po || !pu) continue;
    const oddsOver = americanToDecimal(po.price);
    const oddsUnder = americanToDecimal(pu.price);
    if (!oddsOver || !oddsUnder) continue;
    const line = Number(po.points);
    if (!Number.isFinite(line)) continue;
    if (Math.abs(line * 2) % 2 !== 1) continue;
    all.push({ matchupId: Number(m.matchupId), line, oddsOver, oddsUnder, period });
  }
  if (!all.length) return [];
  const byMatch = new Map();
  for (const r of all) {
    if (!byMatch.has(r.matchupId)) byMatch.set(r.matchupId, []);
    byMatch.get(r.matchupId).push(r);
  }
  // groupByMatchup: retorna [{ matchupId, lines: [...] }] separados.
  // Útil pra tennis onde Pinnacle agrupa games (matchupId X) e aces (matchupId Y)
  // em virtuais distintos. Caller usa heurística (mediana) pra identificar.
  if (opts.groupByMatchup === true) {
    const dedupGroup = (list) => {
      const seen = new Set();
      return list
        .filter(r => { if (seen.has(r.line)) return false; seen.add(r.line); return true; })
        .map(({ line, oddsOver, oddsUnder, period }) => ({ line, oddsOver, oddsUnder, period }));
    };
    return [...byMatch.entries()].map(([mid, list]) => ({
      matchupId: mid,
      lines: dedupGroup(list),
    }));
  }
  let chosen = all;
  if (byMatch.size > 1 && !includeAll) {
    let bestId = null, bestCount = 0;
    for (const [mid, list] of byMatch) {
      const uniq = new Set(list.map(l => l.line));
      if (uniq.size > bestCount) { bestCount = uniq.size; bestId = mid; }
    }
    chosen = byMatch.get(bestId) || all;
  }
  const seen = new Set();
  return chosen
    .filter(r => { if (seen.has(r.line)) return false; seen.add(r.line); return true; })
    .map(({ line, oddsOver, oddsUnder, period }) => ({ line, oddsOver, oddsUnder, period }));
}

module.exports = {
  listSportMatchups,
  getMatchupMarkets,
  extractMoneyline,
  fetchSportMatchOdds,
  americanToDecimal,
  impliedProbsFromOdds,
  getMatchupMoneylineByPeriod,
  getMatchupHandicaps,
  getMatchupTotals,
};

'use strict';

/**
 * clv-capture.js — captura CLV pra TODAS as tips pending (regular + market shadow)
 * via fetch agressivo de odds atuais. Roda como cron dedicado (2-3min) além
 * do checkCLV legacy que roda no auto-analysis cycle.
 *
 * Estratégia:
 * - Pra CADA tip pending sem CLV, busca odd atual via endpoint apropriado
 * - Se odd atual difere da odd original ≥0.005, grava como close_odd/clv_odds
 * - Cron roda constantemente → captura múltiplas vezes (último valor prevalece)
 *   = a odd mais próxima do kickoff vira a close_odd definitiva
 *
 * Cobertura pré-fix (audit scripts/clv-coverage.js):
 *   Market tips shadow: 20-63% por sport
 *   Regular tips: 0-30% (football/cs zerados)
 *
 * Cobertura pós-fix esperada:
 *   90%+ pra tips com match feed ativo (cross-match com team pair normaliz.)
 */

const { log } = require('./utils');

function _norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

/**
 * Pega odd atual pra uma tip MARKET (handicap/total/games). Retorna null se não achar.
 *
 * @param {object} tip — row de market_tips_shadow
 * @param {function} fetchMarkets — (team1, team2) => Promise<{handicaps, totals}|null>
 */
async function _fetchCurrentMarketOdd(tip, fetchMarkets) {
  try {
    const markets = await fetchMarkets(tip.team1, tip.team2);
    if (!markets) return null;

    // Handicap (maps esports OR games tennis OR asian football)
    if (tip.market === 'handicap' || tip.market === 'handicapSets' || tip.market === 'handicapGames') {
      const h = (markets.handicaps || []).find(x => Math.abs(Number(x.line) - Number(tip.line)) < 0.01);
      if (!h) return null;
      const isT1 = tip.side === 'home' || tip.side === 'team1';
      return isT1 ? Number(h.oddsHome) : Number(h.oddsAway);
    }
    // Totals (maps esports OR games tennis OR goals football)
    if (tip.market === 'total' || tip.market === 'totals' || tip.market === 'totalGames') {
      const t = (markets.totals || []).find(x => Math.abs(Number(x.line) - Number(tip.line)) < 0.01);
      if (!t) return null;
      return tip.side === 'over' ? Number(t.oddsOver) : Number(t.oddsUnder);
    }
    // Markets não-pricable via /odds-markets (totalKills, duration, aces, tiebreak)
    // ficam sem close_odd. Aceitável — eles não têm dados de close via este path.
    return null;
  } catch { return null; }
}

/**
 * Football tem fonte de odds diferente (TheOddsAPI via /football-matches, não Pinnacle).
 * /odds-markets retorna 400 pra football → CLV nunca era capturado. Este path lê
 * odds.ou25 (over/under 2.5 gols) e odds.d (draw) direto do feed /football-matches.
 *
 * @param {object} tip — row de market_tips_shadow (sport='football')
 * @param {Array} fbMatches — payload de /football-matches (cache do caller)
 */
function _fetchCurrentFootballOdd(tip, fbMatches) {
  if (!Array.isArray(fbMatches) || !fbMatches.length) return null;
  const n1 = _norm(tip.team1), n2 = _norm(tip.team2);
  if (!n1 || !n2) return null;
  const match = fbMatches.find(m => {
    const mn1 = _norm(m.team1), mn2 = _norm(m.team2);
    if (!mn1 || !mn2) return false;
    const direct = (mn1.includes(n1) || n1.includes(mn1)) && (mn2.includes(n2) || n2.includes(mn2));
    const swap = !direct && (mn1.includes(n2) || n2.includes(mn1)) && (mn2.includes(n1) || n1.includes(mn2));
    return direct || swap;
  });
  if (!match || !match.odds) return null;
  const o = match.odds;
  // OVER/UNDER 2.5 gols: line é fixed 2.5 no feed (TheOddsAPI default).
  if (tip.market === 'totals' && Number(tip.line) === 2.5) {
    if (tip.side === 'over' && o.ou25?.over) return Number(o.ou25.over);
    if (tip.side === 'under' && o.ou25?.under) return Number(o.ou25.under);
    return null;
  }
  // Draw (1X2_D)
  if (tip.market === 'draw' && tip.side === 'd' && o.d) return Number(o.d);
  return null;
}

/**
 * Captura CLV pra tips market_tips_shadow pending sem close_odd.
 *
 * @param {object} db — sqlite db
 * @param {function} serverGet — serverGet(path) do bot.js
 * @returns {Promise<{checked, updated}>}
 */
async function captureMarketTipsClv(db, serverGet) {
  const out = { checked: 0, updated: 0, errors: 0 };
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, sport, team1, team2, league, market, line, side, odd, created_at
      FROM market_tips_shadow
      WHERE result IS NULL
        AND close_odd IS NULL
        AND market IN ('handicap', 'handicapSets', 'handicapGames', 'total', 'totals', 'totalGames', 'draw')
        AND created_at >= datetime('now', '-3 days')
        AND created_at <= datetime('now', '-5 minutes')
      ORDER BY created_at DESC
      LIMIT 300
    `).all();
  } catch (e) { return { ...out, errors: 1, error: e.message }; }

  if (!rows.length) return out;

  // Cache por (sport, team1, team2) pra evitar múltiplos fetches no mesmo match
  const fetchCache = new Map();
  const cached = (sport, t1, t2) => {
    const k = `${sport}|${_norm(t1)}|${_norm(t2)}`;
    return fetchCache.get(k) || null;
  };
  const setCache = (sport, t1, t2, v) => {
    const k = `${sport}|${_norm(t1)}|${_norm(t2)}`;
    fetchCache.set(k, v || 'empty');
  };

  const fetchMarkets = (sport) => async (t1, t2) => {
    const c = cached(sport, t1, t2);
    if (c === 'empty') return null;
    if (c) return c;
    const url = `/odds-markets?team1=${encodeURIComponent(t1)}&team2=${encodeURIComponent(t2)}&period=0`;
    const r = await serverGet(url).catch(() => null);
    setCache(sport, t1, t2, r);
    return r || null;
  };

  const updStmt = db.prepare(`
    UPDATE market_tips_shadow
    SET close_odd = ?, clv_pct = ?, close_captured_at = datetime('now')
    WHERE id = ?
  `);

  // Football lazy-fetch: TheOddsAPI tem rate-limit, busca uma vez se houver football tip.
  let fbMatchesPromise = null;
  const getFootballMatches = () => {
    if (!fbMatchesPromise) {
      fbMatchesPromise = serverGet('/football-matches').catch(() => []);
    }
    return fbMatchesPromise;
  };

  for (const tip of rows) {
    out.checked++;
    let currentOdd;
    if (tip.sport === 'football') {
      const fbMatches = await getFootballMatches();
      currentOdd = _fetchCurrentFootballOdd(tip, fbMatches);
    } else {
      currentOdd = await _fetchCurrentMarketOdd(tip, fetchMarkets(tip.sport));
    }
    if (!currentOdd || !Number.isFinite(currentOdd) || currentOdd <= 1) continue;
    const openOdd = Number(tip.odd);
    if (!Number.isFinite(openOdd) || openOdd <= 1) continue;
    if (Math.abs(currentOdd - openOdd) < 0.005) continue;
    const clvPct = (openOdd / currentOdd - 1) * 100;
    try {
      updStmt.run(currentOdd, +clvPct.toFixed(2), tip.id);
      out.updated++;
    } catch (_) { out.errors++; }
  }

  return out;
}

module.exports = {
  captureMarketTipsClv,
  _norm, _fetchCurrentMarketOdd, _fetchCurrentFootballOdd,
};

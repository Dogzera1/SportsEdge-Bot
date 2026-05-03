'use strict';

/**
 * lib/league-trust.js — Bayesian league trust score (Sprint 3.1).
 *
 * Cada (sport, liga[, market]) recebe um trust ∈ [0.15, 1.20] baseado em
 * rolling 60d de ROI + n. Caller multiplica stake_final = stake × trust.
 *
 * Diferente do leak guard (binário on/off), trust score é gradient — liga
 * "morna" recebe stake reduzido sem ser totalmente bloqueada (deixa amostra
 * crescer pra reabilitar).
 *
 * Dados: combina tips (ML real) + market_tips_shadow. Métrica = profit/staked
 * em unidades. Esfaque por (sport, liga, market_type).
 *
 * Buckets:
 *   n < 5  → trust = 0.50 (cold start, conservador)
 *   n 5-9  → trust escala: ROI≥+5% = 0.80, ROI 0-5% = 0.65, ROI<0 = 0.40
 *   n 10-29→ ROI≥+10% = 1.00, ROI 0-10% = 0.85, ROI -5..0 = 0.55, ROI<-5 = 0.25
 *   n ≥30  → ROI≥+15% = 1.20 (boost!), ROI 5-15% = 1.00, ROI 0-5% = 0.80,
 *            ROI -5..0 = 0.45, ROI<-5 = 0.15 (quase blocked)
 *
 * Cache: TTL 30min por (sport|league|market) — evita query/tip.
 *
 * Env opt-out: LEAGUE_TRUST_DISABLED=true.
 */

const { log } = require('./utils');

const _cache = new Map(); // key → { trust, n, roi, fetchedAt }
const CACHE_TTL_MS = 30 * 60 * 1000;

function _cacheKey(sport, league, market) {
  return `${(sport || '').toLowerCase()}|${(league || '').trim()}|${(market || '').toLowerCase()}`;
}

/**
 * Calcula trust pra (sport, liga[, market]). Retorna { trust, n, roi, source }.
 *
 * @param {object} db sqlite better-sqlite3
 * @param {string} sport ex 'tennis'
 * @param {string} league ex 'ATP Madrid - R3'
 * @param {string} [market] ex 'HANDICAP_GAMES' ou 'handicapGames' — opcional, mais granular
 * @param {object} [opts] { windowDays=60, cacheBypass=false }
 * @returns {{ trust: number, n: number, roi: number|null, source: string, cached: boolean }}
 */
function getLeagueTrust(db, sport, league, market = null, opts = {}) {
  if (/^(1|true|yes)$/i.test(String(process.env.LEAGUE_TRUST_DISABLED || ''))) {
    return { trust: 1.0, n: 0, roi: null, source: 'disabled', cached: false };
  }
  const cleanSport = String(sport || '').toLowerCase().trim();
  const cleanLeague = String(league || '').trim();
  if (!cleanSport || !cleanLeague) {
    return { trust: 0.7, n: 0, roi: null, source: 'no_league', cached: false };
  }
  const key = _cacheKey(cleanSport, cleanLeague, market);
  if (!opts.cacheBypass) {
    const cached = _cache.get(key);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      return { ...cached, cached: true };
    }
  }
  const windowDays = opts.windowDays || parseInt(process.env.LEAGUE_TRUST_WINDOW_DAYS || '60', 10);

  let stats = { n: 0, profit: 0, staked: 0 };
  try {
    // Combina ML real + MT shadow numa pool (units-normalized).
    // ML real: profit_reais/stake_reais → divide por unit_value pra normalizar (~1u = R$1).
    // MT shadow: profit_units já é em unidades.
    const realRow = db.prepare(`
      SELECT
        COUNT(*) AS n,
        SUM(CASE WHEN result='win' THEN COALESCE(stake_reais,0) * (odds-1) ELSE 0 END)
        - SUM(CASE WHEN result='loss' THEN COALESCE(stake_reais,0) ELSE 0 END) AS profit,
        SUM(CASE WHEN result IN ('win','loss') THEN COALESCE(stake_reais,0) ELSE 0 END) AS staked
      FROM tips
      WHERE sport = ?
        AND event_name = ?
        AND COALESCE(is_shadow,0) = 0
        AND COALESCE(archived,0) = 0
        AND result IN ('win','loss')
        AND sent_at >= datetime('now', '-' || ? || ' days')
        ${market ? 'AND market_type = ?' : ''}
    `).get(cleanSport, cleanLeague, windowDays, ...(market ? [String(market).toUpperCase()] : []));
    if (realRow) {
      stats.n += realRow.n || 0;
      stats.profit += realRow.profit || 0;
      stats.staked += realRow.staked || 0;
    }
  } catch (e) {
    try { require('./utils').log('DEBUG', 'LEAGUE-TRUST', `real query err sport=${cleanSport} league=${cleanLeague}: ${e.message}`); } catch (_) {}
  }

  try {
    // 2026-04-29 root-cause fix: market_tips_shadow loga TODA detecção (sem dedup
    // por design — mesma tip emitida 7x pelo scanner = 7 rows). Antes de agregar,
    // dedup por (team1, team2, market, line, side) e mantém mais recente.
    // Sem essa dedup, ATP Madrid R3 mostrava ROI -19% com 42 raw vs +30% real.
    const rawRows = db.prepare(`
      SELECT id, team1, team2, market, side, line, odd, stake_units, result, created_at
      FROM market_tips_shadow
      WHERE sport = ?
        AND league = ?
        AND result IN ('win','loss')
        AND created_at >= datetime('now', '-' || ? || ' days')
        ${market ? 'AND market = ?' : ''}
    `).all(cleanSport, cleanLeague, windowDays, ...(market ? [String(market)] : []));
    // 2026-05-03 FIX: dedup tracking inconsistent results entre cópias do mesmo
    // tip emitido em ciclos múltiplos. Antes silently pegava max created_at —
    // se 7 rows tivessem resultados conflitantes (ex: 6 WIN + 1 LOSS por settle
    // bug), dedup escolhia LOSS sem aviso. Agora loga WARN diag pra investigação.
    const dedup = new Map();
    const conflicts = new Map();
    for (const r of rawRows) {
      const k = `${r.team1}|${r.team2}|${r.market}|${r.line}|${r.side}`;
      const prev = dedup.get(k);
      if (!prev) {
        dedup.set(k, r);
        conflicts.set(k, new Set([r.result]));
      } else {
        conflicts.get(k).add(r.result);
        if ((r.created_at || '') > (prev.created_at || '')) dedup.set(k, r);
      }
    }
    let _conflictCount = 0;
    for (const [, results] of conflicts) {
      if (results.size > 1) _conflictCount++;
    }
    if (_conflictCount > 0) {
      try { require('./utils').log('WARN', 'LEAGUE-TRUST', `dedup conflicts sport=${cleanSport} league=${cleanLeague}: ${_conflictCount} keys com results divergentes (settle bug suspeito)`); } catch (_) {}
    }
    for (const r of dedup.values()) {
      stats.n++;
      const stake = Number(r.stake_units) || 1;
      const odd = Number(r.odd) || 0;
      if (r.result === 'win') { stats.profit += stake * (odd - 1); stats.staked += stake; }
      else if (r.result === 'loss') { stats.profit -= stake; stats.staked += stake; }
    }
  } catch (e) {
    try { require('./utils').log('DEBUG', 'LEAGUE-TRUST', `shadow query err sport=${cleanSport} league=${cleanLeague}: ${e.message}`); } catch (_) {}
  }

  const roi = stats.staked > 0 ? (stats.profit / stats.staked) * 100 : null;
  let trust;
  let source;

  if (stats.n < 5) {
    trust = 0.50;
    source = 'cold_start';
  } else if (stats.n < 10) {
    if (roi >= 5) trust = 0.80;
    else if (roi >= 0) trust = 0.65;
    else trust = 0.40;
    source = 'small_sample';
  } else if (stats.n < 30) {
    if (roi >= 10) trust = 1.00;
    else if (roi >= 0) trust = 0.85;
    else if (roi >= -5) trust = 0.55;
    else trust = 0.25;
    source = 'med_sample';
  } else {
    if (roi >= 15) trust = 1.20;
    else if (roi >= 5) trust = 1.00;
    else if (roi >= 0) trust = 0.80;
    else if (roi >= -5) trust = 0.45;
    else trust = 0.15;
    source = 'large_sample';
  }

  // Override env: LEAGUE_TRUST_FLOOR / _CEILING pra calibrar agressividade.
  const floor = parseFloat(process.env.LEAGUE_TRUST_FLOOR || '0.15');
  const ceiling = parseFloat(process.env.LEAGUE_TRUST_CEILING || '1.20');
  trust = Math.max(floor, Math.min(ceiling, trust));

  const result = {
    trust: +trust.toFixed(3),
    n: stats.n,
    roi: roi != null ? +roi.toFixed(2) : null,
    source,
    fetchedAt: Date.now(),
  };
  _cache.set(key, result);
  return { ...result, cached: false };
}

/**
 * Aplica trust ao stake. Retorna { stake_final, trust, info }.
 * @param {number} stakeRaw stake antes do ajuste
 * @returns {{ stakeFinal: number, trust: number, applied: boolean, info: object }}
 */
function applyTrustToStake(db, sport, league, market, stakeRaw) {
  const t = getLeagueTrust(db, sport, league, market);
  const stakeFinal = +(stakeRaw * t.trust).toFixed(3);
  return {
    stakeFinal,
    trust: t.trust,
    applied: t.trust !== 1.0,
    info: { n: t.n, roi: t.roi, source: t.source, cached: t.cached },
  };
}

function clearCache() {
  _cache.clear();
}

module.exports = { getLeagueTrust, applyTrustToStake, clearCache };

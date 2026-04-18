'use strict';

/**
 * lol-regional-strength.js — Elo inter-regional para LoL.
 *
 * Problema: createEloSystem pool teams de todas as regiões no mesmo contexto
 * 'tier1'. Com poucos jogos inter-regionais por ano (MSI, Worlds, First Stand),
 * os ratings de LCK/LPL/LEC/LCS não se calibram entre si — um LCK 1900 pode não
 * equivaler a um LPL 1900.
 *
 * Solução: roda um mini-Elo no nível DE REGIÃO. Cada região é um "jogador".
 * Cada match inter-regional atualiza as forças das regiões. Na inferência,
 * aplica o delta regional como offset Elo em cima do rating do time.
 *
 * Output: para cada região conhecida (LCK/LPL/LEC/LCS/LCP/VCS/PCS/CBLOL/LJL/LLA/TCL),
 * devolve um offset em pontos Elo (±). Esperável: LCK/LPL positivos, tier-2 negativos.
 */

const { log } = require('./utils');

const TAG = 'LOL-REGIONAL';

// Regiões tier-1 (que ligas regulares representam o topo doméstico)
const REGIONS = [
  { key: 'LCK',   patterns: [/^LCK$/i, /^LCK 20\d\d/i] },
  { key: 'LPL',   patterns: [/^LPL$/i, /^LPL 20\d\d/i] },
  { key: 'LEC',   patterns: [/^LEC$/i, /^LEC 20\d\d/i] },
  { key: 'LCS',   patterns: [/^LCS$/i, /^LCS 20\d\d/i, /^NALCS/i] },
  { key: 'LCP',   patterns: [/^LCP$/i, /^LCP 20\d\d/i] },
  { key: 'VCS',   patterns: [/^VCS$/i, /^VCS 20\d\d/i] },
  { key: 'PCS',   patterns: [/^PCS$/i, /^PCS 20\d\d/i] },
  { key: 'CBLOL', patterns: [/^CBLOL$/i, /^CBLOL 20\d\d/i] },
  { key: 'LJL',   patterns: [/^LJL$/i, /^LJL 20\d\d/i] },
  { key: 'LLA',   patterns: [/^LLA$/i, /^LLA 20\d\d/i] },
  { key: 'TCL',   patterns: [/^TCL$/i, /^TCL 20\d\d/i] },
];

const INTER_REGIONAL_PATTERNS = [
  /worlds/i, /msi/i, /^first stand/i, /red bull/i, /mid[- ]?season/i,
];

function classifyLeagueRegion(league) {
  const l = String(league || '').trim();
  for (const r of REGIONS) {
    for (const p of r.patterns) {
      if (p.test(l)) return r.key;
    }
  }
  return null; // não é regular domestic de uma região tier-1
}

function isInterRegional(league) {
  const l = String(league || '');
  return INTER_REGIONAL_PATTERNS.some(p => p.test(l));
}

function normTeam(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Deriva team → region mapeando pela liga doméstica mais frequente nos últimos N dias.
 * Retorna Map<normTeamName, regionKey>.
 */
function buildTeamRegionMap(db, lookbackDays = 730, maxDateIso = null) {
  const maxClause = maxDateIso ? `AND resolved_at <= ?` : '';
  const params = maxDateIso ? [maxDateIso, maxDateIso] : [];
  const rows = db.prepare(`
    SELECT team1 AS team, league FROM match_results
    WHERE game='lol' AND resolved_at >= datetime('now','-${lookbackDays} days') ${maxClause}
    UNION ALL
    SELECT team2 AS team, league FROM match_results
    WHERE game='lol' AND resolved_at >= datetime('now','-${lookbackDays} days') ${maxClause}
  `).all(...params);

  // team → { region → count }
  const counts = new Map();
  for (const r of rows) {
    const region = classifyLeagueRegion(r.league);
    if (!region) continue;
    const tn = normTeam(r.team);
    if (!tn) continue;
    if (!counts.has(tn)) counts.set(tn, new Map());
    const m = counts.get(tn);
    m.set(region, (m.get(region) || 0) + 1);
  }

  const teamRegion = new Map();
  for (const [tn, m] of counts) {
    let best = null, bestN = 0;
    for (const [region, n] of m) {
      if (n > bestN) { bestN = n; best = region; }
    }
    if (best && bestN >= 3) teamRegion.set(tn, best); // mínimo 3 jogos para ser credível
  }
  return teamRegion;
}

/**
 * Calcula forças regionais rodando mini-Elo em matches inter-regionais.
 *
 * @param {object} db - better-sqlite3
 * @param {object} [opts]
 * @param {number} [opts.lookbackDays=730]
 * @param {number} [opts.k=24]                K-factor por match.
 * @param {number} [opts.recencyHalfLifeDays=365] Decay exponencial — jogos mais antigos pesam menos.
 * @returns {{ offsets: Record<regionKey, number>, teamRegion: Map<string, string>, interRegionalMatches: number, meta: object }}
 */
function computeRegionalStrengths(db, opts = {}) {
  const lookbackDays = opts.lookbackDays ?? 730;
  const K = opts.k ?? 24;
  const halfLife = opts.recencyHalfLifeDays ?? 365;
  const maxDateIso = opts.maxDateIso || null; // pra backtest sem leakage

  const teamRegion = buildTeamRegionMap(db, lookbackDays, maxDateIso);

  // Pega matches inter-regionais
  const maxClause = maxDateIso ? `AND resolved_at <= ?` : '';
  const params = maxDateIso ? [maxDateIso] : [];
  const rows = db.prepare(`
    SELECT team1, team2, winner, final_score, league, resolved_at
    FROM match_results
    WHERE game='lol' AND resolved_at >= datetime('now','-${lookbackDays} days')
      AND winner IS NOT NULL AND winner != ''
      ${maxClause}
    ORDER BY resolved_at ASC
  `).all(...params);

  // Inicializa forças em 0 (baseline). Expresso em Elo points (±).
  const strength = {};
  for (const r of REGIONS) strength[r.key] = 0;

  const nowTs = Date.now();
  let used = 0;
  for (const m of rows) {
    if (!isInterRegional(m.league)) continue;
    const r1 = teamRegion.get(normTeam(m.team1));
    const r2 = teamRegion.get(normTeam(m.team2));
    if (!r1 || !r2 || r1 === r2) continue;

    const winnerIs1 = normTeam(m.winner) === normTeam(m.team1);
    const s1 = winnerIs1 ? 1 : 0;

    // Expected baseado só nos offsets regionais (team-level rating é agnóstico aqui —
    // o sinal é "quando region X joga region Y, X ganha N%?"). Teams são amostra
    // aleatória da região em tournaments, então isso capta a força média.
    const diff = strength[r1] - strength[r2];
    const expected = 1 / (1 + Math.pow(10, -diff / 400));

    // Time decay
    let decay = 1.0;
    if (m.resolved_at) {
      const days = (nowTs - new Date(m.resolved_at).getTime()) / (1000 * 60 * 60 * 24);
      if (days > 0 && halfLife > 0) decay = Math.pow(0.5, days / halfLife);
    }

    // Margin bump (2-0 vs 2-1)
    const marginMatch = String(m.final_score || '').match(/(\d+)-(\d+)/);
    let marginMult = 1.0;
    if (marginMatch) {
      const s1s = parseInt(marginMatch[1], 10), s2s = parseInt(marginMatch[2], 10);
      const margin = Math.abs(s1s - s2s);
      if (margin >= 2) marginMult = 1.25;
      else if (margin === 0) marginMult = 0.8; // BO1 dúvida
    }

    const k = K * decay * marginMult;
    strength[r1] += k * (s1 - expected);
    strength[r2] -= k * (s1 - expected);
    used++;
  }

  // Normaliza soma = 0 (offsets relativos, não absolutos)
  const keys = Object.keys(strength);
  const mean = keys.reduce((a, k) => a + strength[k], 0) / keys.length;
  const offsets = {};
  for (const k of keys) offsets[k] = Math.round((strength[k] - mean) * 10) / 10;

  return {
    offsets,
    teamRegion,
    interRegionalMatches: used,
    meta: { lookbackDays, k: K, halfLife },
  };
}

// Cache singleton
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function getCachedRegionalStrengths(db, opts) {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL_MS) return _cache;
  try {
    _cache = computeRegionalStrengths(db, opts);
    _cacheTs = now;
  } catch (e) {
    log('WARN', TAG, `computeRegionalStrengths failed: ${e.message}`);
    _cache = { offsets: {}, teamRegion: new Map(), interRegionalMatches: 0, meta: {} };
    _cacheTs = now;
  }
  return _cache;
}

function invalidateRegionalCache() {
  _cache = null;
  _cacheTs = 0;
}

/**
 * Helper: dado team + league, devolve offset em Elo points (0 se desconhecido).
 */
function getTeamRegionalOffset(db, team, league) {
  const { offsets, teamRegion } = getCachedRegionalStrengths(db);
  // 1. Se a match league for doméstica conhecida, usa ela direto.
  const leagueRegion = classifyLeagueRegion(league);
  if (leagueRegion && offsets[leagueRegion] !== undefined) return offsets[leagueRegion];
  // 2. Fallback: região histórica do time.
  const tr = teamRegion.get(normTeam(team));
  if (tr && offsets[tr] !== undefined) return offsets[tr];
  return 0;
}

module.exports = {
  computeRegionalStrengths,
  getCachedRegionalStrengths,
  invalidateRegionalCache,
  getTeamRegionalOffset,
  classifyLeagueRegion,
  isInterRegional,
  REGIONS,
};

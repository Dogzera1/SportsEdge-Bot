'use strict';

/**
 * valorant-regional-strength.js — Elo inter-regional pra Valorant.
 *
 * Espelha lib/lol-regional-strength.js mas adaptado pros 4 regions VCT:
 *   Americas, EMEA, Pacific, China
 *
 * Eventos inter-regionais: VCT Masters (Tokyo/Madrid/Shanghai/Bangkok),
 * VCT Champions, LOCK//IN, LOCK IN.
 *
 * Output: offset em pts Elo per region (±). Esperável:
 *   EMEA / Pacific positivos historicamente
 *   Americas stable
 *   China melhorando
 */

const { log } = require('./utils');
const TAG = 'VAL-REGIONAL';

const REGIONS = [
  { key: 'AMER',    patterns: [/vct americas/i, /^vcl nortam/i, /\bgc americas/i] },
  { key: 'EMEA',    patterns: [/vct emea/i, /vcl emea/i, /vcl (france|spain|portugal|dach|turkey|türkiye|nordic|east|northern europe|italy|benelux|balkans|mena|middle east|poland|cis)/i] },
  { key: 'PACIFIC', patterns: [/vct pacific/i, /vcl (korea|japan|hong kong|taiwan|indonesia|malaysia|philippines|thailand|vietnam|oceania|sea|south asia)/i] },
  { key: 'CHINA',   patterns: [/vct china/i, /vcl china/i] },
];

const INTER_REGIONAL_PATTERNS = [
  /masters\s+(tokyo|madrid|shanghai|bangkok|reykjavik|berlin|copenhagen)/i,
  /valorant champions/i,
  /\bvct champions\b/i,
  /lock[^a-z]*in/i, // LOCK//IN, LOCK IN, LOCKIN
];

function classifyLeagueRegion(league) {
  const l = String(league || '').trim();
  for (const r of REGIONS) {
    for (const p of r.patterns) {
      if (p.test(l)) return r.key;
    }
  }
  return null;
}

function isInterRegional(league) {
  const l = String(league || '');
  return INTER_REGIONAL_PATTERNS.some(p => p.test(l));
}

function normTeam(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function buildTeamRegionMap(db, lookbackDays = 730, maxDateIso = null) {
  const maxClause = maxDateIso ? `AND resolved_at <= ?` : '';
  const params = maxDateIso ? [maxDateIso, maxDateIso] : [];
  const rows = db.prepare(`
    SELECT team1 AS team, league FROM match_results
    WHERE game='valorant' AND resolved_at >= datetime('now','-${lookbackDays} days') ${maxClause}
    UNION ALL
    SELECT team2 AS team, league FROM match_results
    WHERE game='valorant' AND resolved_at >= datetime('now','-${lookbackDays} days') ${maxClause}
  `).all(...params);

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
    if (best && bestN >= 3) teamRegion.set(tn, best);
  }
  return teamRegion;
}

function computeRegionalStrengths(db, opts = {}) {
  const lookbackDays = opts.lookbackDays ?? 730;
  const K = opts.k ?? 24;
  const halfLife = opts.recencyHalfLifeDays ?? 365;
  const maxDateIso = opts.maxDateIso || null;

  const teamRegion = buildTeamRegionMap(db, lookbackDays, maxDateIso);

  const maxClause = maxDateIso ? `AND resolved_at <= ?` : '';
  const params = maxDateIso ? [maxDateIso] : [];
  const rows = db.prepare(`
    SELECT team1, team2, winner, final_score, league, resolved_at
    FROM match_results
    WHERE game='valorant' AND resolved_at >= datetime('now','-${lookbackDays} days')
      AND winner IS NOT NULL AND winner != ''
      ${maxClause}
    ORDER BY resolved_at ASC
  `).all(...params);

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
    const diff = strength[r1] - strength[r2];
    const expected = 1 / (1 + Math.pow(10, -diff / 400));

    let decay = 1.0;
    if (m.resolved_at) {
      const days = (nowTs - new Date(m.resolved_at).getTime()) / (1000 * 60 * 60 * 24);
      if (days > 0 && halfLife > 0) decay = Math.pow(0.5, days / halfLife);
    }

    const marginMatch = String(m.final_score || '').match(/(\d+)-(\d+)/);
    let marginMult = 1.0;
    if (marginMatch) {
      const s1s = parseInt(marginMatch[1], 10), s2s = parseInt(marginMatch[2], 10);
      const margin = Math.abs(s1s - s2s);
      if (margin >= 2) marginMult = 1.25;
      else if (margin === 0) marginMult = 0.8;
    }

    const k = K * decay * marginMult;
    strength[r1] += k * (s1 - expected);
    strength[r2] -= k * (s1 - expected);
    used++;
  }

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

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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
 * Aplica offset regional no Elo do time. Chamada a partir do valorant-ml.
 * Se ambos times são da mesma região, offset se cancela (diferença = 0) — no-op.
 */
function applyRegionalOffsets(db, team1, team2, league, elo1, elo2) {
  const cache = getCachedRegionalStrengths(db);
  if (!cache.offsets || cache.interRegionalMatches < 5) return { elo1, elo2, offset1: 0, offset2: 0 };
  const r1 = cache.teamRegion.get(normTeam(team1));
  const r2 = cache.teamRegion.get(normTeam(team2));
  const o1 = r1 ? (cache.offsets[r1] || 0) : 0;
  const o2 = r2 ? (cache.offsets[r2] || 0) : 0;
  return {
    elo1: elo1 + o1,
    elo2: elo2 + o2,
    offset1: o1,
    offset2: o2,
    region1: r1,
    region2: r2,
  };
}

module.exports = {
  classifyLeagueRegion,
  isInterRegional,
  computeRegionalStrengths,
  getCachedRegionalStrengths,
  invalidateRegionalCache,
  applyRegionalOffsets,
  REGIONS: REGIONS.map(r => r.key),
};

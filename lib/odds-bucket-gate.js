'use strict';

/**
 * odds-bucket-gate.js
 *
 * Gate cross-sport que bloqueia tips em faixas (buckets) de odds identificadas
 * como leak via scripts/roi-by-odds-bucket.js.
 *
 * Env vars:
 *   ODDS_BUCKET_BLOCK=2.20-3.00,3.50-99        # cross-sport
 *   VALORANT_ODDS_BUCKET_BLOCK=2.20-99         # per-sport override ADDITIVE
 *   LOL_ODDS_BUCKET_BLOCK=3.00-99
 *
 * Formato bucket: "MIN-MAX" (MIN inclusive, MAX exclusive). Separar por vírgula.
 *
 * API:
 *   const { isBucketBlocked } = require('./lib/odds-bucket-gate');
 *   const r = isBucketBlocked('lol', 2.45);
 *   // r = { blocked: true, bucket: '2.20-3.00', source: 'global' }
 *   // r = { blocked: false }
 */

function parseBuckets(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const min = parseFloat(m[1]);
    const max = parseFloat(m[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) continue;
    out.push({ min, max, label: `${min.toFixed(2)}-${max.toFixed(2)}` });
  }
  return out;
}

function normSport(sport) {
  const s = String(sport || '').toLowerCase().trim();
  if (s === 'cs' || s === 'cs2' || s === 'counterstrike') return 'CS';
  if (s === 'lol' || s === 'esports' || s === 'leagueoflegends') return 'LOL';
  if (s === 'dota' || s === 'dota2') return 'DOTA2';
  if (s === 'val' || s === 'valorant') return 'VALORANT';
  if (s === 'tennis') return 'TENNIS';
  if (s === 'mma') return 'MMA';
  if (s === 'football' || s === 'soccer') return 'FOOTBALL';
  if (s === 'darts') return 'DARTS';
  if (s === 'snooker') return 'SNOOKER';
  if (s === 'tt' || s === 'tabletennis') return 'TT';
  return s.toUpperCase();
}

/**
 * @param {string} sport - 'lol' | 'dota2' | 'cs' | 'valorant' | 'tennis' | 'mma' | 'football' | ...
 * @param {number} odd
 * @returns {{blocked: boolean, bucket?: string, source?: 'global'|'sport'}}
 */
function isBucketBlocked(sport, odd) {
  const o = Number(odd);
  if (!Number.isFinite(o) || o <= 1) return { blocked: false };

  const S = normSport(sport);
  const global = parseBuckets(process.env.ODDS_BUCKET_BLOCK);
  const perSport = parseBuckets(process.env[`${S}_ODDS_BUCKET_BLOCK`]);

  for (const b of perSport) {
    if (o >= b.min && o < b.max) return { blocked: true, bucket: b.label, source: 'sport' };
  }
  for (const b of global) {
    if (o >= b.min && o < b.max) return { blocked: true, bucket: b.label, source: 'global' };
  }
  return { blocked: false };
}

module.exports = { isBucketBlocked, parseBuckets, normSport };

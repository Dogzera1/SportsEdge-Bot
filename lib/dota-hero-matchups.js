'use strict';
/**
 * dota-hero-matchups.js — Display-only: counter edge of a draft from dota_hero_matchups
 * (populated by sync-opendota-hero-matchups). Accepts hero names (resolved to hero_id via
 * dota_hero_stats, reusing dota-draft-parse.normalizeHeroName) or numeric hero_ids. No stake/EV.
 */
const { normalizeHeroName } = require('./dota-draft-parse');

// caches (~30min): name->id map + matchup table
let _idCache = null, _idTs = 0, _muCache = null, _muTs = 0;
const TTL = 30 * 60 * 1000;

function _idMap(db) {
  const now = Date.now();
  if (_idCache && (now - _idTs) < TTL) return _idCache;
  const m = new Map();
  try {
    for (const r of db.prepare('SELECT hero_id, localized_name FROM dota_hero_stats WHERE localized_name IS NOT NULL').all()) {
      m.set(String(r.localized_name).toLowerCase(), r.hero_id);
    }
  } catch (_) { /* table missing */ }
  _idCache = m; _idTs = now;
  return m;
}

function _muMap(db) {
  const now = Date.now();
  if (_muCache && (now - _muTs) < TTL) return _muCache;
  const m = new Map();
  try {
    for (const r of db.prepare('SELECT hero_id, vs_hero_id, games, wr FROM dota_hero_matchups').all()) {
      m.set(`${r.hero_id}:${r.vs_hero_id}`, { games: r.games, wr: r.wr });
    }
  } catch (_) { /* table missing */ }
  _muCache = m; _muTs = now;
  return m;
}

function resolveHeroId(db, h) {
  if (typeof h === 'number') return h;
  const canon = normalizeHeroName(db, h);   // canonical localized_name or null
  if (!canon) return null;
  return _idMap(db).get(String(canon).toLowerCase()) || null;
}

/**
 * Counter edge of blue draft vs red draft.
 * @returns {{ blueAdvantagePp:number, sampled:number, pairs:Array<{blue,red,advPp,games}> }}
 *   blueAdvantagePp = sum over pairs of (wr_blue_vs_red - 0.5)*100, only pairs with games>=minGames.
 */
function getMatchupEdge(db, blueHeroes, redHeroes, { minGames = 20 } = {}) {
  const blue = (blueHeroes || []).map(h => resolveHeroId(db, h)).filter(Boolean);
  const red = (redHeroes || []).map(h => resolveHeroId(db, h)).filter(Boolean);
  const mu = _muMap(db);
  let sum = 0, sampled = 0;
  const pairs = [];
  for (const b of blue) {
    for (const r of red) {
      const m = mu.get(`${b}:${r}`);
      if (!m || m.wr == null || (m.games || 0) < minGames) continue;
      const adv = m.wr - 0.5;
      sum += adv; sampled++;
      pairs.push({ blue: b, red: r, advPp: +(adv * 100).toFixed(1), games: m.games });
    }
  }
  pairs.sort((a, b) => Math.abs(b.advPp) - Math.abs(a.advPp));
  return { blueAdvantagePp: +(sum * 100).toFixed(1), sampled, pairs };
}

function _invalidateMatchupCache() { _idCache = null; _idTs = 0; _muCache = null; _muTs = 0; }

module.exports = { getMatchupEdge, resolveHeroId, _invalidateMatchupCache };

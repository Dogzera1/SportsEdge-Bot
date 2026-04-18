'use strict';

/**
 * dota-hero-features.js — features derivadas da meta de heróis Dota 2.
 *
 * Consome `dota_hero_stats` (populado via sync externo OpenDota) pra:
 *   - getTeamDraftStrength(heroes)  → aggregate meta strength do draft
 *   - getDraftMatchupFactor(b, r)   → diff entre draft blue vs red (pp pra logit)
 *
 * Uso típico (livephase pós-draft):
 *   const { getDraftMatchupFactor } = require('./dota-hero-features');
 *   const f = getDraftMatchupFactor(db, bluePicks, redPicks);
 *   // f.factor: shift positivo = blue draft melhor. Usar como feature no MC/Elo.
 */

const { log } = require('./utils');
const TAG = 'DOTA-HEROES';

/** Cache simples in-memory 30min */
const CACHE_TTL = 30 * 60 * 1000;
let _metaCache = null;
let _metaCacheTs = 0;

function _loadMetaMap(db) {
  const now = Date.now();
  if (_metaCache && (now - _metaCacheTs) < CACHE_TTL) return _metaCache;
  try {
    const rows = db.prepare(`
      SELECT hero_id, localized_name, pro_pick, pro_win, pro_winrate, pro_pickban_rate
      FROM dota_hero_stats
      WHERE pro_pick > 0
    `).all();
    const byName = new Map();
    for (const r of rows) {
      const key = String(r.localized_name || '').toLowerCase().trim();
      if (!key) continue;
      byName.set(key, {
        heroId: r.hero_id,
        name: r.localized_name,
        proPick: r.pro_pick || 0,
        proWin: r.pro_win || 0,
        proWR: r.pro_winrate || 0.5,
        proPickban: r.pro_pickban_rate || 0,
      });
    }
    _metaCache = byName;
    _metaCacheTs = now;
    return byName;
  } catch (e) {
    log('DEBUG', TAG, `meta load err: ${e.message}`);
    return new Map();
  }
}

/**
 * Força de meta do draft: WR médio ponderado + bonus pra picks high-priority (pickban alto).
 *
 * @param {object} db
 * @param {Array<string>} heroes — nomes de heróis (localized_name)
 * @returns {{ avgWR, highPriorityCount, sample, missingHeroes } | null}
 */
function getTeamDraftStrength(db, heroes) {
  if (!Array.isArray(heroes) || !heroes.length) return null;
  const meta = _loadMetaMap(db);
  let wrSum = 0, pickSum = 0, count = 0, highPri = 0;
  const missing = [];
  for (const h of heroes) {
    const key = String(h || '').toLowerCase().trim();
    const entry = meta.get(key);
    if (!entry || entry.proPick < 10) {
      // Hero com pickban < 10 em últimos 90d = sem data credível; usa neutro 0.5
      missing.push(h);
      wrSum += 0.5; // neutro
      pickSum += 1;
      count++;
      continue;
    }
    // Weight por pickban rate (hero dominante vale mais pro "draft strength")
    const weight = 1 + (entry.proPickban || 0);
    wrSum += entry.proWR * weight;
    pickSum += weight;
    count++;
    if (entry.proPickban >= 0.15) highPri++;  // top tier: >=15% pickban
  }
  if (count < 3) return null;  // draft muito incompleto
  return {
    avgWR: +(wrSum / pickSum).toFixed(4),
    highPriorityCount: highPri,
    sample: count,
    missingHeroes: missing,
  };
}

/**
 * Matchup factor blue vs red drafts.
 * Retorna shift pra P(blue win) baseado na diferença de força de meta.
 *
 * Range típico: [-5, +5] pp (draft forte vs fraco raramente passa disso).
 *
 * @returns {{ factor, blueWR, redWR, detail } | null}
 */
function getDraftMatchupFactor(db, bluePicks, redPicks) {
  const blueSt = getTeamDraftStrength(db, bluePicks);
  const redSt  = getTeamDraftStrength(db, redPicks);
  if (!blueSt || !redSt) return null;
  const diff = blueSt.avgWR - redSt.avgWR;
  // Scale: diff de 0.10 (10pp WR) → 4pp no factor. High priority diff também contribui.
  const wrFactor = diff * 40;  // 0.10 → 4pp
  const priorityDiff = blueSt.highPriorityCount - redSt.highPriorityCount;
  const priorityFactor = priorityDiff * 0.5;  // cada hero high-priority extra = +0.5pp
  const factor = +(wrFactor + priorityFactor).toFixed(2);
  return {
    factor,
    blueWR: blueSt.avgWR,
    redWR: redSt.avgWR,
    detail: `blueWR ${(blueSt.avgWR*100).toFixed(1)}% (${blueSt.highPriorityCount} hp) vs redWR ${(redSt.avgWR*100).toFixed(1)}% (${redSt.highPriorityCount} hp) → ${factor >= 0 ? '+' : ''}${factor}pp`,
  };
}

function invalidateMetaCache() {
  _metaCache = null;
  _metaCacheTs = 0;
}

module.exports = {
  getTeamDraftStrength,
  getDraftMatchupFactor,
  invalidateMetaCache,
};

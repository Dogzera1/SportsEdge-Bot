'use strict';

/**
 * mt-market-promote.js — per (sport, market) promote state pra MT auto-promote.
 *
 * Substitui o gate sport-level <SPORT>_MARKET_TIPS_ENABLED por decisão granular.
 * Backward compat: legacy env continua válida — interpretada como "todos os
 * markets enabled pra esse sport". Linhas em mt_market_promote_state OVERRIDE
 * o legacy env por (sport, market) específico.
 */

const { log } = require('./utils');

const _cache = new Map();

function _key(sport, market) {
  return `${String(sport || '').toLowerCase()}|${String(market || '').toUpperCase()}`;
}

function _clearCache() { _cache.clear(); }

function loadMtMarketPromoteCache(db) {
  try {
    _cache.clear();
    const rows = db.prepare(`SELECT sport, market, enabled FROM mt_market_promote_state`).all();
    for (const r of rows) {
      _cache.set(_key(r.sport, r.market), Boolean(r.enabled));
    }
    if (rows.length) log('INFO', 'MT-MARKET-PROMOTE', `Loaded ${rows.length} market state rows`);
  } catch (e) {
    log('DEBUG', 'MT-MARKET-PROMOTE', `load err: ${e.message}`);
  }
}

function isMtMarketPromoted(sport, market) {
  const k = _key(sport, market);
  if (_cache.has(k)) return _cache.get(k);
  const up = String(sport || '').toUpperCase();
  return process.env[`${up}_MARKET_TIPS_ENABLED`] === 'true';
}

function setMtMarketPromote(db, sport, market, enabled, opts = {}) {
  const { source = 'auto', reason = null } = opts;
  const sp = String(sport || '').toLowerCase();
  const mk = String(market || '').toUpperCase();
  if (!sp || !mk) return;
  const tsCol = enabled ? 'promoted_at' : 'reverted_at';
  db.prepare(`
    INSERT INTO mt_market_promote_state (sport, market, enabled, ${tsCol}, source, reason)
    VALUES (?, ?, ?, datetime('now'), ?, ?)
    ON CONFLICT(sport, market) DO UPDATE SET
      enabled = excluded.enabled,
      ${tsCol} = excluded.${tsCol},
      source = excluded.source,
      reason = excluded.reason
  `).run(sp, mk, enabled ? 1 : 0, source, reason);
  _cache.set(_key(sp, mk), Boolean(enabled));
}

module.exports = {
  isMtMarketPromoted,
  setMtMarketPromote,
  loadMtMarketPromoteCache,
  _clearCache,
};

'use strict';

/**
 * sport-mt-calib.js — factory de calibração MT para esports (lol/cs2/dota2/valorant).
 *
 * Aplica calibração isotonic (PAV + Beta smoothing) sobre P do pricing
 * pre-jogo em mercados handicap (team1/team2) e total (over/under).
 *
 * Resolve overconfidence sistemática do pricing baseado em mapScoreDistribution
 * que produz pModel inflados em buckets EV alto (gap +80-120pp em LoL total
 * over EV>30%).
 *
 * Schema mesmo do tennis-markov-calib (v2.1 side-aware):
 *   markets[market].bins                                  v1 default
 *   markets[market].tiers[tier].bins                      v2 tier-aware
 *   markets[market].sides[side].bins                      v2.1 side at root
 *   markets[market].tiers[tier].sides[side].bins          v2.1 tier+side
 *
 * Disable per sport via <SPORT>_MT_CALIB_DISABLED=true.
 *
 * Uso:
 *   const calib = require('./sport-mt-calib').createSportMtCalib('lol');
 *   const pCalib = calib.applyCalib(pRaw, 'total', { side: 'over' });
 */

const fs = require('fs');
const path = require('path');

const _CHECK_INTERVAL_MS = 30 * 60 * 1000;

function createSportMtCalib(sport) {
  if (!sport || typeof sport !== 'string') throw new Error('sport required');
  const SPORT = sport.toLowerCase();
  const CALIB_PATH = process.env[`${SPORT.toUpperCase()}_MT_CALIB_PATH`]
    || path.join(__dirname, `${SPORT}-mt-calib.json`);

  let _cached = null;
  let _cachedMtimeMs = 0;
  let _lastCheckTs = 0;
  let _watcher = null;

  function _setupWatcher() {
    if (_watcher) return;
    try {
      if (!fs.existsSync(CALIB_PATH)) return;
      _watcher = fs.watch(CALIB_PATH, { persistent: false }, () => {
        _cached = null;
        _cachedMtimeMs = 0;
        _lastCheckTs = 0;
      });
      _watcher.unref?.();
    } catch (_) { /* fail-open: TTL ainda funciona */ }
  }

  function _invalidate() {
    _cached = null;
    _cachedMtimeMs = 0;
    _lastCheckTs = 0;
  }

  function _load() {
    _setupWatcher();
    const now = Date.now();
    if (_cached && (now - _lastCheckTs) < _CHECK_INTERVAL_MS) return _cached;
    try {
      if (!fs.existsSync(CALIB_PATH)) { _lastCheckTs = now; return _cached; }
      const stat = fs.statSync(CALIB_PATH);
      if (_cached && stat.mtimeMs === _cachedMtimeMs) {
        _lastCheckTs = now;
        return _cached;
      }
      const raw = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8'));
      if (!raw.markets) { _lastCheckTs = now; return _cached; }
      _cached = raw;
      _cachedMtimeMs = stat.mtimeMs;
      _lastCheckTs = now;
      return _cached;
    } catch (_) {
      _lastCheckTs = now;
      return _cached;
    }
  }

  function isCalibEnabled() {
    const disableEnv = `${SPORT.toUpperCase()}_MT_CALIB_DISABLED`;
    if (/^(1|true|yes)$/i.test(String(process.env[disableEnv] || ''))) return false;
    return !!_load();
  }

  function applyCalib(pRaw, market, opts = {}) {
    if (!Number.isFinite(pRaw) || pRaw < 0 || pRaw > 1) return pRaw;
    if (!isCalibEnabled()) return pRaw;
    const c = _load();
    if (!c) return pRaw;
    let m = null;
    if (opts.isLive && c.markets?.live?.[market]?.bins?.length) {
      m = c.markets.live[market];
    }
    if (!m && opts.tier && opts.side
        && c.markets?.[market]?.tiers?.[opts.tier]?.sides?.[opts.side]?.bins?.length) {
      m = c.markets[market].tiers[opts.tier].sides[opts.side];
    }
    if (!m && opts.tier && c.markets?.[market]?.tiers?.[opts.tier]?.bins?.length) {
      m = c.markets[market].tiers[opts.tier];
    }
    if (!m && opts.side && c.markets?.[market]?.sides?.[opts.side]?.bins?.length) {
      m = c.markets[market].sides[opts.side];
    }
    if (!m) m = c.markets[market];
    if (!m || !Array.isArray(m.bins) || !m.bins.length) return pRaw;
    const bins = m.bins;
    if (pRaw <= bins[0].mid) return bins[0].pCalib;
    if (pRaw >= bins[bins.length - 1].mid) return bins[bins.length - 1].pCalib;
    for (let i = 0; i < bins.length - 1; i++) {
      const a = bins[i], b = bins[i + 1];
      if (pRaw >= a.mid && pRaw <= b.mid) {
        const span = b.mid - a.mid;
        if (span <= 0) return a.pCalib;
        const t = (pRaw - a.mid) / span;
        return a.pCalib + t * (b.pCalib - a.pCalib);
      }
    }
    return pRaw;
  }

  function getCalibMeta() {
    const c = _load();
    if (!c) return null;
    return {
      sport: SPORT,
      fittedAt: c.fittedAt,
      nSamples: c.nSamples,
      markets: Object.fromEntries(Object.entries(c.markets || {}).map(([k, v]) => [k, {
        nBins: v.bins?.length || 0,
        nTotal: v.nTotal,
        sides: v.sides ? Object.fromEntries(Object.entries(v.sides).map(([s, vs]) => [s, { nBins: vs.bins?.length || 0, nTotal: vs.nTotal }])) : undefined,
        tiers: v.tiers ? Object.fromEntries(Object.entries(v.tiers).map(([t, vt]) => [t, {
          nBins: vt.bins?.length || 0,
          nTotal: vt.nTotal,
          sides: vt.sides ? Object.fromEntries(Object.entries(vt.sides).map(([s, vts]) => [s, { nBins: vts.bins?.length || 0, nTotal: vts.nTotal }])) : undefined,
        }])) : undefined,
      }])),
    };
  }

  return { applyCalib, isCalibEnabled, getCalibMeta, _invalidate, CALIB_PATH };
}

// Singleton per sport — caching factory pra callers que precisam só passar a instance.
const _instances = new Map();
function getSportMtCalib(sport) {
  const k = String(sport || '').toLowerCase();
  if (!k) return null;
  if (!_instances.has(k)) _instances.set(k, createSportMtCalib(k));
  return _instances.get(k);
}

module.exports = { createSportMtCalib, getSportMtCalib };

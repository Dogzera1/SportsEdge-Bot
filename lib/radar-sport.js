const { sportApi, sportData } = require('radar-sport-api');

// Wrapper mínimo com cache em memória + throttle simples.
// Uso: expor via server endpoint para testes/integração incremental.

const _cache = new Map(); // key -> { exp, data }
let _lastCallTs = 0;

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function _cacheGet(key) {
  const v = _cache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) { _cache.delete(key); return null; }
  return v.data;
}

function _cacheSet(key, data, ttlMs) {
  _cache.set(key, { exp: Date.now() + ttlMs, data });
}

async function radarGetInfo({ book = 'betfair', region = 'Europe:Berlin', method, value, ttlMs = 5 * 60 * 1000, minDelayMs = 900 }) {
  if (!method) throw new Error('radar: method obrigatório');
  if (value == null) throw new Error('radar: value obrigatório');

  const key = `info:${book}:${region}:${method}:${String(value)}`;
  const cached = _cacheGet(key);
  if (cached) return cached;

  const now = Date.now();
  const wait = Math.max(0, (_lastCallTs + minDelayMs) - now);
  if (wait) await _sleep(wait);
  _lastCallTs = Date.now();

  const api = new sportApi(book, { getCommonContents: false });
  const data = await api.getInfo(region, method, value);
  _cacheSet(key, data, ttlMs);
  return data;
}

async function radarGetByPath({ book = 'betfair', path, ttlMs = 5 * 60 * 1000, minDelayMs = 900 }) {
  if (!path) throw new Error('radar: path obrigatório');

  const key = `path:${book}:${String(path)}`;
  const cached = _cacheGet(key);
  if (cached) return cached;

  const now = Date.now();
  const wait = Math.max(0, (_lastCallTs + minDelayMs) - now);
  if (wait) await _sleep(wait);
  _lastCallTs = Date.now();

  const api = new sportData(book, { getCommonContents: false });
  const data = await api.getByPath(String(path));
  _cacheSet(key, data, ttlMs);
  return data;
}

module.exports = {
  radarGetInfo,
  radarGetByPath,
};


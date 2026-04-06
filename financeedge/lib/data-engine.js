/**
 * data-engine.js
 * Busca OHLCV via CCXT (Binance/Bybit).
 * Cache em memória + SQLite para rate-limit safety.
 */
const { log, sleep } = require('./utils');

// Cache em memória: { "BTC/USDT_1h": { ts, candles[] } }
const ohlcvCache = {};
const CACHE_TTL = {
  '1m':  60 * 1000,
  '5m':  5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h':  60 * 60 * 1000,
  '4h':  4 * 60 * 60 * 1000,
  '1d':  24 * 60 * 60 * 1000,
};

let exchange = null;
let exchangeName = 'binance';

function initExchange(name, options = {}) {
  try {
    const ccxt = require('ccxt');
    const ExchangeClass = ccxt[name];
    if (!ExchangeClass) throw new Error(`Exchange '${name}' não suportada pela ccxt`);
    exchange = new ExchangeClass({
      enableRateLimit: true,
      timeout: 15000,
      ...options
    });
    exchangeName = name;
    log('INFO', 'DATA', `Exchange inicializada: ${name}`);
    return exchange;
  } catch (e) {
    log('ERROR', 'DATA', `Falha ao inicializar ${name}: ${e.message}`);
    return null;
  }
}

/**
 * Busca candles OHLCV. Retorna array de objetos:
 * { ts, open, high, low, close, volume }
 */
async function fetchOHLCV(symbol, timeframe = '1h', limit = 200) {
  const cacheKey = `${symbol}_${timeframe}`;
  const ttl = CACHE_TTL[timeframe] || 60 * 60 * 1000;
  const now = Date.now();

  // Retorna cache se ainda válido
  if (ohlcvCache[cacheKey] && (now - ohlcvCache[cacheKey].ts) < ttl) {
    return ohlcvCache[cacheKey].candles;
  }

  if (!exchange) {
    log('WARN', 'DATA', 'Exchange não inicializada — usando dados simulados');
    return generateSimulatedOHLCV(symbol, limit);
  }

  try {
    const raw = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    if (!raw || !raw.length) return ohlcvCache[cacheKey]?.candles || [];

    const candles = raw.map(([ts, open, high, low, close, volume]) => ({
      ts, open, high, low, close, volume
    }));

    ohlcvCache[cacheKey] = { ts: now, candles };
    log('DEBUG', 'DATA', `${symbol} ${timeframe}: ${candles.length} candles`);
    return candles;
  } catch (e) {
    log('WARN', 'DATA', `fetchOHLCV ${symbol}: ${e.message}`);
    // Retorna cache antigo se disponível
    return ohlcvCache[cacheKey]?.candles || [];
  }
}

/**
 * Busca preço atual (ticker).
 */
async function fetchPrice(symbol) {
  if (!exchange) return null;
  try {
    const ticker = await exchange.fetchTicker(symbol);
    return ticker?.last || ticker?.close || null;
  } catch (e) {
    log('WARN', 'DATA', `fetchPrice ${symbol}: ${e.message}`);
    return null;
  }
}

/**
 * Busca múltiplos símbolos em paralelo com delay entre requests.
 */
async function fetchMultiple(symbols, timeframe = '1h', limit = 200) {
  const results = {};
  for (const symbol of symbols) {
    results[symbol] = await fetchOHLCV(symbol, timeframe, limit);
    await sleep(300); // respeita rate limit
  }
  return results;
}

/**
 * Gera OHLCV simulado (modo offline / sem exchange configurada).
 * Útil para testes e desenvolvimento.
 */
function generateSimulatedOHLCV(symbol, limit = 200) {
  const basePrices = {
    'BTC/USDT': 65000,
    'ETH/USDT': 3200,
    'BNB/USDT': 580,
    'SOL/USDT': 150,
  };
  const base = basePrices[symbol] || 100;
  const now = Date.now();
  const msPerHour = 60 * 60 * 1000;
  const candles = [];
  let price = base;

  for (let i = limit; i >= 0; i--) {
    const ts = now - i * msPerHour;
    const change = (Math.random() - 0.48) * 0.02; // leve viés de alta
    price = price * (1 + change);
    const open = price;
    const high = price * (1 + Math.random() * 0.01);
    const low = price * (1 - Math.random() * 0.01);
    const close = price * (1 + (Math.random() - 0.5) * 0.005);
    const volume = base * 100 * (0.5 + Math.random());
    candles.push({ ts, open, high, low, close, volume });
  }
  return candles;
}

/**
 * Invalida cache de um símbolo (força re-fetch no próximo ciclo).
 */
function invalidateCache(symbol, timeframe) {
  const key = `${symbol}_${timeframe}`;
  delete ohlcvCache[key];
}

/**
 * Status do cache em memória.
 */
function getCacheStatus() {
  return Object.entries(ohlcvCache).map(([key, val]) => ({
    key,
    age: Math.round((Date.now() - val.ts) / 1000),
    candles: val.candles.length
  }));
}

module.exports = {
  initExchange,
  fetchOHLCV,
  fetchPrice,
  fetchMultiple,
  generateSimulatedOHLCV,
  invalidateCache,
  getCacheStatus,
};

/**
 * betfair.js — Cliente mínimo da Betfair Exchange API (delayed free key).
 *
 * Auth: interactive login (username+password+appKey) → sessionToken 12h.
 *       keepAlive automático a cada 20min para manter sessão viva.
 *
 * Env necessário:
 *   BF_APP_KEY  — Delayed Application Key (created via developer.betfair.com)
 *   BF_USER     — username da conta Betfair
 *   BF_PASS     — password da conta Betfair
 *
 * Documentação: https://docs.developer.betfair.com/
 *
 * Limitações (delayed key free):
 *   - Dados com ~1-3s de atraso
 *   - Apenas leitura (não permite apostar via API com delayed key)
 *   - Rate limit soft: ~5 req/s; cache agressivo é essencial
 */
'use strict';

const https = require('https');
const { log } = require('./utils');

const APP_KEY = process.env.BF_APP_KEY || '';
const USER    = process.env.BF_USER    || '';
const PASS    = process.env.BF_PASS    || '';

const _state = {
  token: null,
  tokenTs: 0,
  keepAliveTimer: null,
};

function isConfigured() {
  return !!(APP_KEY && USER && PASS);
}

function _post(host, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path, method: 'POST', headers, timeout: 15000
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: data }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function login() {
  if (!isConfigured()) throw new Error('Betfair não configurado (BF_APP_KEY/BF_USER/BF_PASS)');
  const body = `username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASS)}`;
  const r = await _post('identitysso.betfair.com', '/api/login', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
    'X-Application': APP_KEY,
    'Content-Length': Buffer.byteLength(body)
  }, body);
  if (r.status !== 200) throw new Error(`Betfair login HTTP ${r.status}`);
  const j = JSON.parse(r.body);
  if (j.status !== 'SUCCESS') throw new Error(`Betfair login: ${j.status} ${j.error || ''}`);
  _state.token = j.token;
  _state.tokenTs = Date.now();
  log('INFO', 'BETFAIR', 'login OK');
  _scheduleKeepAlive();
  return j.token;
}

async function keepAlive() {
  if (!_state.token) return null;
  try {
    const r = await _post('identitysso.betfair.com', '/api/keepAlive', {
      'Accept': 'application/json',
      'X-Application': APP_KEY,
      'X-Authentication': _state.token,
      'Content-Length': 0
    }, '');
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      if (j.status === 'SUCCESS') return true;
    }
    log('WARN', 'BETFAIR', 'keepAlive falhou; forçando novo login');
    _state.token = null;
    return false;
  } catch (e) {
    log('WARN', 'BETFAIR', `keepAlive erro: ${e.message}`);
    _state.token = null;
    return false;
  }
}

function _scheduleKeepAlive() {
  if (_state.keepAliveTimer) clearInterval(_state.keepAliveTimer);
  // KeepAlive a cada 20 min (token expira em 12h de uso / 4h inatividade)
  _state.keepAliveTimer = setInterval(() => { keepAlive().catch(() => {}); }, 20 * 60 * 1000);
  _state.keepAliveTimer.unref?.();
}

async function _ensureToken() {
  if (!_state.token) return login();
  // Renovar preventivamente se passou 8h (abaixo do TTL 12h)
  if (Date.now() - _state.tokenTs > 8 * 60 * 60 * 1000) return login();
  return _state.token;
}

async function rpc(method, params) {
  const token = await _ensureToken();
  const body = JSON.stringify([{
    jsonrpc: '2.0',
    method: `SportsAPING/v1.0/${method}`,
    params,
    id: 1
  }]);
  const r = await _post('api.betfair.com', '/exchange/betting/json-rpc/v1', {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Application': APP_KEY,
    'X-Authentication': token,
    'Content-Length': Buffer.byteLength(body)
  }, body);
  if (r.status === 401 || r.status === 403) {
    log('WARN', 'BETFAIR', `rpc ${method} auth expirado; forçando novo login`);
    _state.token = null;
    const freshToken = await login();
    // retry com token novo
    const retry = await _post('api.betfair.com', '/exchange/betting/json-rpc/v1', {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Application': APP_KEY,
      'X-Authentication': freshToken,
      'Content-Length': Buffer.byteLength(body)
    }, body);
    if (retry.status !== 200) throw new Error(`Betfair ${method}: HTTP ${retry.status}`);
    const arr = JSON.parse(retry.body);
    if (arr[0]?.error) throw new Error(`Betfair ${method}: ${JSON.stringify(arr[0].error)}`);
    return arr[0]?.result || null;
  }
  if (r.status !== 200) throw new Error(`Betfair ${method}: HTTP ${r.status}`);
  const arr = JSON.parse(r.body);
  if (arr[0]?.error) throw new Error(`Betfair ${method}: ${JSON.stringify(arr[0].error)}`);
  return arr[0]?.result || null;
}

// ── Operações úteis ─────────────────────────────────────────────────────────

// Snooker eventTypeId = 6422 (fixo e público na Betfair)
const EVENT_TYPE_SNOOKER = '6422';

async function listSnookerEvents(daysAhead = 14) {
  const fromIso = new Date().toISOString();
  const toIso = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  return rpc('listEvents', {
    filter: {
      eventTypeIds: [EVENT_TYPE_SNOOKER],
      marketStartTime: { from: fromIso, to: toIso }
    }
  });
}

async function listMatchOddsMarkets(eventIds) {
  if (!Array.isArray(eventIds) || !eventIds.length) return [];
  return rpc('listMarketCatalogue', {
    filter: {
      eventIds,
      marketTypeCodes: ['MATCH_ODDS']
    },
    marketProjection: ['RUNNER_DESCRIPTION', 'EVENT', 'MARKET_START_TIME', 'COMPETITION'],
    maxResults: 100
  });
}

async function listMarketBook(marketIds) {
  if (!Array.isArray(marketIds) || !marketIds.length) return [];
  return rpc('listMarketBook', {
    marketIds,
    priceProjection: { priceData: ['EX_BEST_OFFERS'] }
  });
}

/**
 * Fluxo completo: listSnookerEvents → listMarketCatalogue → listMarketBook,
 * retornando array normalizado { eventId, eventName, marketId, startTime, runners: [{name, backPrice, layPrice}] }
 */
async function fetchSnookerMatchOdds(daysAhead = 14) {
  if (!isConfigured()) return [];
  const events = await listSnookerEvents(daysAhead).catch(e => {
    log('WARN', 'BETFAIR', `listSnookerEvents: ${e.message}`);
    return [];
  });
  if (!events.length) return [];
  const eventIds = events.map(e => e.event.id);
  const markets = await listMatchOddsMarkets(eventIds).catch(e => {
    log('WARN', 'BETFAIR', `listMatchOddsMarkets: ${e.message}`);
    return [];
  });
  if (!markets.length) return [];
  const marketIds = markets.map(m => m.marketId);
  const book = await listMarketBook(marketIds).catch(e => {
    log('WARN', 'BETFAIR', `listMarketBook: ${e.message}`);
    return [];
  });
  const bookById = new Map(book.map(b => [b.marketId, b]));

  const out = [];
  for (const m of markets) {
    const bk = bookById.get(m.marketId);
    if (!bk) continue;
    const runners = m.runners.map(r => {
      const pr = bk.runners.find(x => x.selectionId === r.selectionId);
      const back = pr?.ex?.availableToBack?.[0]?.price || null;
      const lay  = pr?.ex?.availableToLay?.[0]?.price || null;
      return { name: r.runnerName, selectionId: r.selectionId, backPrice: back, layPrice: lay };
    });
    if (runners.length !== 2) continue; // match_odds snooker deveria ser 1v1
    out.push({
      eventId: m.event?.id,
      eventName: m.event?.name,
      marketId: m.marketId,
      competition: m.competition?.name || null,
      startTime: m.marketStartTime,
      runners
    });
  }
  return out;
}

module.exports = {
  isConfigured,
  login,
  keepAlive,
  rpc,
  listSnookerEvents,
  listMatchOddsMarkets,
  listMarketBook,
  fetchSnookerMatchOdds,
  EVENT_TYPE_SNOOKER,
};

require('dotenv').config({ override: true });
const http = require('http');
const path = require('path');
const url = require('url');
const fs = require('fs');
const initDatabase = require('./lib/database');
const { log, sendJson, safeParse, httpGet, httpsPost } = require('./lib/utils');
const { initExchange, fetchOHLCV, fetchPrice, getCacheStatus } = require('./lib/data-engine');
const { generateSignal } = require('./lib/financial-ml');
const { calcStakeUsdt, calcStopTakeProfit, checkCircuitBreaker, CONFIG } = require('./lib/risk-manager');
const { paperOpen, paperClose, calcUnrealizedPnL } = require('./lib/executor');

const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT) || 3001;
const MODE = (process.env.MODE || 'paper').toLowerCase(); // 'paper' ou 'real'
const AI_KEY = process.env.DEEPSEEK_API_KEY || process.env.CLAUDE_API_KEY || '';
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();

function getClientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').toString();
  const ip = xf.split(',')[0]?.trim();
  return ip || req.socket?.remoteAddress || 'unknown';
}

function isAdminRequest(req) {
  if (!ADMIN_KEY) return false;
  const xk = (req.headers['x-admin-key'] || '').toString().trim();
  if (xk && xk === ADMIN_KEY) return true;
  const auth = (req.headers['authorization'] || '').toString().trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token && token === ADMIN_KEY) return true;
  }
  return false;
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY) { sendJson(res, { ok: false, error: 'admin_key_not_configured' }, 503); return false; }
  if (!isAdminRequest(req)) { sendJson(res, { ok: false, error: 'unauthorized' }, 401); return false; }
  return true;
}

const _rl = new Map();
function rateLimit(req, res, limitPerMin, bucket) {
  const ip = getClientIp(req);
  const key = `${bucket}|${ip}`;
  const now = Date.now();
  const winMs = 60 * 1000;
  const cur = _rl.get(key);
  if (!cur || now >= cur.resetAt) { _rl.set(key, { count: 1, resetAt: now + winMs }); return true; }
  if (cur.count >= limitPerMin) {
    const retryAfterSec = Math.max(1, Math.ceil((cur.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    sendJson(res, { ok: false, error: 'rate_limited', bucket, limitPerMin, retryAfterSec }, 429);
    return false;
  }
  cur.count++;
  return true;
}

const ADMIN_ROUTES_ANY = new Set(['/users']);
const ADMIN_ROUTES_POST = new Set([
  '/open-trade',
  '/close-trade',
  '/set-bankroll',
  '/circuit-breaker',
  '/save-user',
  '/record-analysis',
  '/ai',
  '/reset-trades',
]);
const EXPENSIVE_ROUTES = new Set(['/ai']);

let DB_PATH = (process.env.DB_PATH || 'financeedge.db').trim().replace(/^=+/, '');
try {
  const dbDir = path.dirname(path.resolve(DB_PATH));
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
} catch (e) {
  DB_PATH = 'financeedge.db';
}
const { db, stmts } = initDatabase(DB_PATH);

// Configura exchange (opcional — usa simulação se não configurado)
const EXCHANGE_NAME = process.env.EXCHANGE_NAME || 'binance';
const EXCHANGE_KEY = process.env.EXCHANGE_API_KEY || '';
const EXCHANGE_SECRET = process.env.EXCHANGE_API_SECRET || '';
if (EXCHANGE_KEY && EXCHANGE_SECRET) {
  initExchange(EXCHANGE_NAME, { apiKey: EXCHANGE_KEY, secret: EXCHANGE_SECRET });
} else {
  initExchange(EXCHANGE_NAME, {});
}

// Símbolos monitorados (configurável via env)
const SYMBOLS = (process.env.SYMBOLS || 'BTC/USDT,ETH/USDT').split(',').map(s => s.trim());
const TIMEFRAME = process.env.TIMEFRAME || '1h';

let lastAnalysisAt = null;
let circuitBreakerActive = false;

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  res.on('error', e => log('ERROR', 'RES', e.message));

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key, x-api-key'
      });
      res.end();
      return;
    }

    const bucket = EXPENSIVE_ROUTES.has(p) ? `expensive:${p}` : `general:${p}`;
    const limit = EXPENSIVE_ROUTES.has(p) ? 10 : 60;
    if (!rateLimit(req, res, limit, bucket)) return;

    const needsAdmin =
      ADMIN_ROUTES_ANY.has(p) ||
      (req.method === 'POST' && ADMIN_ROUTES_POST.has(p));
    if (needsAdmin && !requireAdmin(req, res)) return;

    // ── Health ──
    if (p === '/health') {
      const bk = stmts.getBankroll.get();
      const openCount = stmts.openTradeCount.get();
      sendJson(res, {
        status: circuitBreakerActive ? 'circuit_breaker' : 'ok',
        mode: MODE,
        exchange: EXCHANGE_NAME,
        symbols: SYMBOLS,
        timeframe: TIMEFRAME,
        lastAnalysis: lastAnalysisAt,
        openTrades: openCount?.c || 0,
        bankroll: bk ? { current: bk.current_usdt, initial: bk.initial_usdt } : null,
        circuitBreaker: circuitBreakerActive,
      });
      return;
    }

    // ── Preços atuais ──
    if (p === '/prices') {
      const prices = {};
      for (const sym of SYMBOLS) {
        const price = await fetchPrice(sym).catch(() => null);
        prices[sym] = price;
      }
      sendJson(res, prices);
      return;
    }

    // ── Análise manual de símbolo ──
    if (p === '/analyze') {
      const symbol = parsed.query.symbol || SYMBOLS[0];
      const timeframe = parsed.query.timeframe || TIMEFRAME;
      try {
        const candles = await fetchOHLCV(symbol, timeframe, 200);
        const signal = generateSignal(candles, symbol, timeframe);
        if (signal) {
          stmts.insertSignal.run({
            symbol: signal.symbol,
            timeframe: signal.timeframe,
            direction: signal.direction,
            confidence: signal.confidence,
            evPct: signal.evPct,
            rsi: signal.rsi,
            macdHist: signal.macdHist,
            bbPosition: signal.bbPosition,
            atr: signal.atr,
            price: signal.price,
            volume: signal.volume,
          });
        }
        sendJson(res, signal || { signal: null, symbol, reason: 'Sem sinal claro' });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
      return;
    }

    // ── Sinais recentes ──
    if (p === '/signals') {
      const limit = parseInt(parsed.query.limit) || 20;
      const signals = stmts.getLatestSignals.all(limit);
      sendJson(res, signals);
      return;
    }

    // ── Abrir trade (paper) ──
    if (p === '/open-trade' && req.method === 'POST') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          if (circuitBreakerActive) {
            sendJson(res, { ok: false, error: 'Circuit breaker ativo — bot pausado' }, 403);
            return;
          }
          const { symbol, direction, evPct, confidence, atr, price, timeframe: tf } = safeParse(body, {});
          if (!symbol || !direction || !price) {
            sendJson(res, { error: 'symbol, direction e price obrigatórios' }, 400);
            return;
          }
          const alreadyOpen = stmts.tradeExistsOpen.get(symbol);
          if (alreadyOpen) {
            sendJson(res, { ok: false, skipped: true, reason: `Trade ${symbol} já aberto` });
            return;
          }
          const bk = stmts.getBankroll.get();
          if (!bk) { sendJson(res, { error: 'Bankroll não inicializado' }, 500); return; }

          const odds = 2.0; // equivalente a 50/50 — ajustar conforme modelo
          const { stakeUsdt, stakePct, kellyFraction } = calcStakeUsdt(bk.current_usdt, evPct || 5, odds, confidence || 'MÉDIA');
          const { stopLoss, takeProfit } = calcStopTakeProfit(price, direction, atr, 1.5, 2.0);

          const execution = paperOpen(
            { symbol, direction, price, timeframe: tf || TIMEFRAME },
            stakeUsdt, stopLoss, takeProfit
          );

          const result = stmts.insertTrade.run({
            symbol,
            direction,
            entryPrice: execution.entryPrice,
            stopLoss: execution.stopLoss,
            takeProfit: execution.takeProfit,
            stakeUsdt: execution.stakeUsdt,
            stakePct,
            signalConfidence: confidence || 'MÉDIA',
            signalEv: evPct || null,
            kellyFraction,
            timeframe: tf || TIMEFRAME,
            mode: MODE,
            botToken: '',
          });

          log('INFO', 'TRADE', `Aberto: ${symbol} ${direction.toUpperCase()} @ ${execution.entryPrice} | stake $${execution.stakeUsdt}`);
          sendJson(res, { ok: true, tradeId: result.lastInsertRowid, ...execution });
        } catch (e) { sendJson(res, { error: e.message }, 500); }
      });
      return;
    }

    // ── Fechar trade (paper) ──
    if (p === '/close-trade' && req.method === 'POST') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { tradeId, exitPrice } = safeParse(body, {});
          if (!tradeId || !exitPrice) {
            sendJson(res, { error: 'tradeId e exitPrice obrigatórios' }, 400); return;
          }
          const trade = stmts.getTradeById.get(parseInt(tradeId));
          if (!trade) { sendJson(res, { error: 'Trade não encontrado' }, 404); return; }

          const closeResult = paperClose(trade, parseFloat(exitPrice));
          stmts.closeTrade.run(
            closeResult.exitPrice,
            closeResult.result,
            closeResult.pnlUsdt,
            closeResult.pnlPct,
            closeResult.feesUsdt,
            trade.id
          );

          // Atualiza banca
          const bk = stmts.getBankroll.get();
          if (bk) {
            const newBanca = parseFloat((bk.current_usdt + closeResult.pnlUsdt).toFixed(4));
            stmts.updateBankroll.run(newBanca);
          }

          log('INFO', 'TRADE', `Fechado: #${trade.id} ${trade.symbol} P&L: $${closeResult.pnlUsdt} (${closeResult.pnlPct}%)`);
          sendJson(res, { ok: true, ...closeResult });
        } catch (e) { sendJson(res, { error: e.message }, 500); }
      });
      return;
    }

    // ── Trades abertos ──
    if (p === '/open-trades') {
      const trades = stmts.getOpenTrades.all();
      const enriched = [];
      for (const t of trades) {
        const price = await fetchPrice(t.symbol).catch(() => null);
        const unrealized = price ? calcUnrealizedPnL(t, price) : null;
        enriched.push({ ...t, currentPrice: price, unrealized });
      }
      sendJson(res, enriched);
      return;
    }

    // ── Histórico de trades ──
    if (p === '/trades-history') {
      const limit = parseInt(parsed.query.limit) || 30;
      const trades = stmts.getSettledTrades.all(limit);
      sendJson(res, trades);
      return;
    }

    // ── ROI / Estatísticas ──
    if (p === '/roi') {
      const row = stmts.getROI.get();
      const bk = stmts.getBankroll.get();
      const settled = row?.total || 0;
      const winRate = settled > 0 ? ((row.wins / settled) * 100).toFixed(1) : '0.0';
      const roi = bk ? (((bk.current_usdt - bk.initial_usdt) / bk.initial_usdt) * 100).toFixed(2) : '0.00';

      sendJson(res, {
        overall: {
          total: settled,
          wins: row?.wins || 0,
          losses: row?.losses || 0,
          winRate,
          totalPnlUsdt: row?.total_pnl_usdt || 0,
          avgPnlPct: row?.avg_pnl_pct || 0,
          avgEv: row?.avg_ev || 0,
          roi,
        },
        bankroll: bk ? {
          initial: bk.initial_usdt,
          current: bk.current_usdt,
          profit: parseFloat((bk.current_usdt - bk.initial_usdt).toFixed(4)),
          growthPct: parseFloat(roi),
        } : null,
        circuitBreaker: circuitBreakerActive,
        mode: MODE,
      });
      return;
    }

    // ── Bankroll ──
    if (p === '/bankroll') {
      const bk = stmts.getBankroll.get();
      if (!bk) { sendJson(res, { error: 'Bankroll não inicializado' }, 500); return; }
      sendJson(res, {
        initial: bk.initial_usdt,
        current: bk.current_usdt,
        profit: parseFloat((bk.current_usdt - bk.initial_usdt).toFixed(4)),
        growthPct: parseFloat(((bk.current_usdt - bk.initial_usdt) / bk.initial_usdt * 100).toFixed(2)),
        updatedAt: bk.updated_at,
      });
      return;
    }

    if (p === '/set-bankroll' && req.method === 'POST') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { valor } = safeParse(body, {});
          const v = parseFloat(valor);
          if (!v || v <= 0) { sendJson(res, { error: 'valor inválido' }, 400); return; }
          stmts.resetBankroll.run(v, v);
          log('INFO', 'BANCA', `Banca redefinida: $${v.toFixed(2)}`);
          sendJson(res, { ok: true, current: v });
        } catch (e) { sendJson(res, { error: e.message }, 500); }
      });
      return;
    }

    // ── Circuit breaker manual ──
    if (p === '/circuit-breaker' && req.method === 'POST') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', () => {
        const { active } = safeParse(body, {});
        circuitBreakerActive = active === true;
        log('INFO', 'RISK', `Circuit breaker: ${circuitBreakerActive ? 'ATIVADO' : 'DESATIVADO'}`);
        sendJson(res, { ok: true, circuitBreaker: circuitBreakerActive });
      });
      return;
    }

    // ── Usuários ──
    if (p === '/save-user' && req.method === 'POST') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { userId, username, subscribed } = safeParse(body, {});
          if (!userId) { sendJson(res, { error: 'Missing userId' }, 400); return; }
          stmts.upsertUser.run(userId, username || '', subscribed ? 1 : 0);
          sendJson(res, { ok: true });
        } catch (e) { sendJson(res, { error: e.message }, 500); }
      });
      return;
    }

    if (p === '/users') {
      const users = stmts.getSubscribedUsers.all();
      sendJson(res, users);
      return;
    }

    // ── Cache de dados ──
    if (p === '/cache-status') {
      sendJson(res, getCacheStatus());
      return;
    }

    // ── Record Analysis (chamado pelo bot) ──
    if (p === '/record-analysis' && req.method === 'POST') {
      lastAnalysisAt = new Date().toISOString();
      sendJson(res, { ok: true });
      return;
    }

    // ── Proxy AI (DeepSeek/Claude) ──
    if (p === '/ai' && req.method === 'POST') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const payload = safeParse(body, null);
          if (!payload) { sendJson(res, { error: 'Invalid JSON' }, 400); return; }
          const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
          if (!DEEPSEEK_KEY && !process.env.CLAUDE_API_KEY) {
            sendJson(res, { error: 'Nenhuma AI key configurada' }, 401); return;
          }
          if (DEEPSEEK_KEY) {
            const r = await httpsPost('https://api.deepseek.com/chat/completions', {
              model: 'deepseek-chat',
              max_tokens: payload.max_tokens || 1000,
              messages: payload.messages
            }, { 'Authorization': `Bearer ${DEEPSEEK_KEY}`, 'content-type': 'application/json' });
            const ds = safeParse(r.body, {});
            const text = ds.choices?.[0]?.message?.content || '';
            sendJson(res, { content: [{ type: 'text', text }] });
          } else {
            const r = await httpsPost('https://api.anthropic.com/v1/messages', payload, {
              'x-api-key': process.env.CLAUDE_API_KEY,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json'
            });
            res.writeHead(r.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(r.body);
          }
        } catch (e) { sendJson(res, { error: e.message }, 500); }
      });
      return;
    }

    // ── Reset (dev/test) ──
    if (p === '/reset-trades' && req.method === 'POST') {
      const count = db.prepare("SELECT COUNT(*) as c FROM trades").get().c;
      db.prepare("DELETE FROM trades").run();
      db.prepare("UPDATE bankroll SET current_usdt = initial_usdt, updated_at = datetime('now')").run();
      circuitBreakerActive = false;
      log('INFO', 'ADMIN', `Trades resetados: ${count} registros removidos`);
      sendJson(res, { ok: true, deleted: count });
      return;
    }

    sendJson(res, { error: 'Not found' }, 404);
  } catch (e) {
    log('ERROR', 'SERVER', `Unhandled em ${p}: ${e.message}`);
    if (!res.headersSent) sendJson(res, { error: e.message }, 500);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', 'SERVER', `FinanceEdge API em http://0.0.0.0:${PORT} | modo=${MODE.toUpperCase()}`);
  log('INFO', 'SERVER', `Símbolos: ${SYMBOLS.join(', ')} | Timeframe: ${TIMEFRAME}`);

  // Limpeza periódica de OHLCV antigo (48h)
  setInterval(() => {
    try {
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      stmts.cleanOldOHLCV.run(cutoff);
    } catch (_) {}
  }, 6 * 60 * 60 * 1000);
});

module.exports = { server, db, stmts };

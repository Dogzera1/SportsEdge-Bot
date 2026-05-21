#!/usr/bin/env node
'use strict';

/**
 * scripts/pinnacle-executor-example.js — REFERENCE executor implementation.
 *
 * Bot dispara POST { event_id, market_id, side, stake_brl, expected_odd, ... }
 * pra este serviço. Este executor implementa a interação real com Pinnacle.
 *
 * 3 modos suportados (escolher via PINNACLE_EXECUTOR_MODE env):
 *   1. 'mock'      — sempre retorna sucesso fake (testing/dev)
 *   2. 'playwright' — TODO: launch headless browser, login, place bet
 *   3. 'api'        — TODO: usar Pinnacle Public API se user tem contractual access
 *
 * Default 'mock' pra deploy seguro.
 *
 * Deploy: este script roda como Railway worker separado (Node.js service).
 *   - Set PINNACLE_EXECUTOR_PORT=3001
 *   - Set PINNACLE_EXECUTOR_TOKEN=<random secret>
 *   - Set PINNACLE_USERNAME / PINNACLE_PASSWORD (Phase 'playwright')
 *   - Set PINNACLE_API_KEY (Phase 'api', se aplicável)
 *
 * Bot configures:
 *   - PINNACLE_EXECUTOR_URL=https://<this-service>.railway.app
 *   - PINNACLE_EXECUTOR_TOKEN=<same secret as executor>
 */

const http = require('http');

const PORT = parseInt(process.env.PINNACLE_EXECUTOR_PORT || '3001', 10);
const TOKEN = process.env.PINNACLE_EXECUTOR_TOKEN || '';
const MODE = String(process.env.PINNACLE_EXECUTOR_MODE || 'mock').toLowerCase();

console.log(`[executor] mode=${MODE} port=${PORT} token=${TOKEN ? 'set' : 'UNSET'}`);

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 100000) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
    });
  });
}

async function placeBetMock(payload) {
  // Mock: simula latency + retorna fake ticket
  await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
  return {
    ok: true,
    ticket_id: `MOCK-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    actual_odd: payload.expected_odd,
    stake_brl: payload.stake_brl,
    status: 'placed',
  };
}

async function placeBetPlaywright(payload) {
  // TODO Phase 2.1: implementar Playwright flow
  //   const { chromium } = require('playwright');
  //   const browser = await chromium.launch({ headless: true });
  //   const context = await browser.newContext({ /* user agent, cookies session */ });
  //   const page = await context.newPage();
  //   await page.goto('https://www.pinnacle.com/login');
  //   // ... login form fill
  //   await page.fill('#email', process.env.PINNACLE_USERNAME);
  //   await page.fill('#password', process.env.PINNACLE_PASSWORD);
  //   await page.click('button[type="submit"]');
  //   await page.waitForNavigation();
  //   // Navigate to event
  //   await page.goto(`https://www.pinnacle.com/en/event/${payload.event_id}`);
  //   // Click market + side
  //   await page.click(`[data-market-id="${payload.market_id}"] [data-side="${payload.side}"]`);
  //   // Input stake
  //   await page.fill('input[name="stake"]', String(payload.stake_brl));
  //   // Submit + parse receipt
  //   await page.click('button.place-bet');
  //   const ticket = await page.textContent('.bet-receipt .ticket-id');
  //   const actualOdd = await page.textContent('.bet-receipt .odd');
  //   await browser.close();
  //   return { ok: true, ticket_id: ticket, actual_odd: parseFloat(actualOdd), ... };
  return {
    ok: false,
    error: 'playwright mode not implemented — see Phase 2.1 TODO comments',
  };
}

async function placeBetApi(payload) {
  // TODO Phase 2.2: integrar Pinnacle Public API se user tem access
  //   const apiKey = process.env.PINNACLE_API_KEY;
  //   const url = 'https://api.pinnacle.com/v1/bets/place';
  //   POST { eventId, marketId, ... } with auth header
  return {
    ok: false,
    error: 'api mode not implemented — Pinnacle Public API requires contractual access',
  };
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    return sendJson(res, 200, { ok: true, mode: MODE, ts: new Date().toISOString() });
  }
  if (req.url === '/place-bet' && req.method === 'POST') {
    // Token auth
    if (TOKEN && req.headers['x-executor-token'] !== TOKEN) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    const payload = await readBody(req);
    if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid_json' });
    if (!payload.event_id || !payload.market_id || !payload.side || !Number.isFinite(payload.stake_brl) || payload.stake_brl <= 0) {
      return sendJson(res, 400, { ok: false, error: 'missing required fields' });
    }
    try {
      let result;
      if (MODE === 'playwright') result = await placeBetPlaywright(payload);
      else if (MODE === 'api') result = await placeBetApi(payload);
      else result = await placeBetMock(payload);
      sendJson(res, result.ok ? 200 : 502, result);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }
  sendJson(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`[executor] listening :${PORT}`);
});

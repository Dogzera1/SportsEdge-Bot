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

// 2026-05-21: Persistent browser context — single login session reused across bets.
// Cold-start every bet seria 5-10s pra login. Quente: ~2s pra navigate+place.
// Stored via Playwright storageState (cookies + localStorage) em /tmp.
let _persistentBrowser = null;
let _persistentContext = null;
const STORAGE_STATE_PATH = '/tmp/pinnacle-session.json';
const fs = require('fs');

async function _getOrCreateContext() {
  // Lazy require Playwright (only loaded if mode=playwright)
  const { chromium } = require('playwright');
  if (_persistentBrowser && _persistentContext) {
    try {
      // Quick health check — context.pages() throws se closed
      _persistentContext.pages();
      return { browser: _persistentBrowser, context: _persistentContext };
    } catch (_) {
      _persistentBrowser = null;
      _persistentContext = null;
    }
  }
  _persistentBrowser = await chromium.launch({
    headless: !/^(0|false|no)$/i.test(String(process.env.PLAYWRIGHT_HEADLESS ?? 'true')),
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const contextOpts = {
    userAgent: process.env.PLAYWRIGHT_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'pt-BR',
  };
  // Reuse session if storageState exists
  if (fs.existsSync(STORAGE_STATE_PATH)) {
    contextOpts.storageState = STORAGE_STATE_PATH;
    console.log('[executor] reusing storageState from', STORAGE_STATE_PATH);
  }
  _persistentContext = await _persistentBrowser.newContext(contextOpts);
  return { browser: _persistentBrowser, context: _persistentContext };
}

async function _ensureLoggedIn(context) {
  const username = process.env.PINNACLE_USERNAME;
  const password = process.env.PINNACLE_PASSWORD;
  if (!username || !password) throw new Error('PINNACLE_USERNAME/PASSWORD não setadas');
  const page = await context.newPage();
  // Pinnacle BR redirect: pinnacle.com → pinnacle.com/pt/ ou /br/
  const base = process.env.PINNACLE_BASE_URL || 'https://www.pinnacle.com/pt/';
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Detect if logged in (has "logout" or "balance" element)
  const isLogged = await page.locator('text=Sair, text=Logout, [data-test-id="user-balance"]').first().isVisible().catch(() => false);
  if (isLogged) {
    await page.close();
    return true;
  }
  // Trigger login modal
  await page.locator('[data-test-id="login-button"], button:has-text("Entrar"), button:has-text("Login")').first().click({ timeout: 10000 });
  // Fill credentials (Pinnacle uses customerId+password — pode variar)
  await page.locator('input[name="customerId"], input[name="username"], input[type="email"]').first().fill(username, { timeout: 10000 });
  await page.locator('input[name="password"], input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"], button:has-text("Entrar"), button:has-text("Login")').first().click();
  // Wait login complete (balance visible or URL change)
  await page.waitForLoadState('networkidle', { timeout: 30000 });
  // Save state pra reuse
  await context.storageState({ path: STORAGE_STATE_PATH });
  console.log('[executor] login OK, storageState saved');
  await page.close();
  return true;
}

async function placeBetPlaywright(payload) {
  let context;
  try {
    const ctx = await _getOrCreateContext();
    context = ctx.context;
    await _ensureLoggedIn(context);
  } catch (e) {
    return { ok: false, error: `playwright init/login: ${e.message}` };
  }

  const page = await context.newPage();
  try {
    // Navigate to event page. Pinnacle URL pattern: /pt/<sport>/<league>/<teams>/<event_id>
    // ou direct: /pt/event/<event_id>. Tentamos genérico.
    const eventUrl = process.env.PINNACLE_EVENT_URL_TEMPLATE
      ? process.env.PINNACLE_EVENT_URL_TEMPLATE.replace('{event_id}', payload.event_id)
      : `https://www.pinnacle.com/pt/event/${payload.event_id}`;
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Click market + side. Pinnacle DOM:
    //   [data-test-id="market-${marketId}"] [data-test-id="side-${side}"]
    // ou: button:has-text("<oddValue>") quando market é único.
    const marketSelector = `[data-market-type="${payload.market_id}"], [data-test-id="market-${payload.market_id}"]`;
    const sideSelector = `[data-side="${payload.side}"], [data-test-id="side-${payload.side}"], button:has-text("${payload.expected_odd}")`;
    await page.locator(marketSelector).first().locator(sideSelector).first().click({ timeout: 15000 });

    // Input stake (modal/sidebar abre após click no odd)
    await page.locator('input[name="stake"], input[data-test-id="stake-input"]').first().fill(String(payload.stake_brl), { timeout: 10000 });

    // Wait for odd refresh (Pinnacle pode re-cotacao após adicionar bet slip)
    await page.waitForTimeout(1000);

    // Check current odd vs expected (slippage guard)
    const currentOddText = await page.locator('[data-test-id="current-odd"], .bet-slip-odd').first().textContent().catch(() => null);
    const currentOdd = currentOddText ? parseFloat(currentOddText.replace(',', '.')) : payload.expected_odd;
    const slippagePct = Math.abs(currentOdd - payload.expected_odd) / payload.expected_odd * 100;
    if (slippagePct > (payload.max_slippage_pct || 2)) {
      await page.close();
      return { ok: false, error: `slippage ${slippagePct.toFixed(1)}% > max ${payload.max_slippage_pct}% (expected=${payload.expected_odd} current=${currentOdd})` };
    }

    // Submit
    await page.locator('button[data-test-id="place-bet-button"], button:has-text("Confirmar Aposta"), button:has-text("Place Bet")').first().click({ timeout: 10000 });

    // Parse receipt
    await page.waitForSelector('[data-test-id="bet-receipt"], .bet-receipt, text=/ticket|recibo|confirmed/i', { timeout: 15000 });
    const ticketText = await page.locator('[data-test-id="ticket-id"], .ticket-number').first().textContent().catch(() => null);
    const ticketId = ticketText ? ticketText.trim() : `PW-${Date.now()}`;

    // Save updated storageState (cookies refresh)
    await context.storageState({ path: STORAGE_STATE_PATH });
    await page.close();

    return {
      ok: true,
      ticket_id: ticketId,
      actual_odd: currentOdd,
      stake_brl: payload.stake_brl,
      status: 'placed',
    };
  } catch (e) {
    try { await page.screenshot({ path: `/tmp/pinnacle-err-${Date.now()}.png` }).catch(() => {}); } catch (_) {}
    try { await page.close(); } catch (_) {}
    return { ok: false, error: `playwright bet: ${e.message}` };
  }
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

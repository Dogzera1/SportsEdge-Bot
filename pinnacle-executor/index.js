#!/usr/bin/env node
'use strict';

/**
 * pinnacle-executor — HTTP service que recebe POST /place-bet do bot SportsEdge
 * e executa apostas reais na Pinnacle.com via Playwright.
 *
 * Deploy:
 *   Railway worker separado. PORT auto-assigned. Env vars setados no dashboard.
 *
 * Endpoints:
 *   GET  /healthz       → { ok, mode, ts }
 *   POST /place-bet     → executes bet, returns { ok, ticket_id, actual_odd, ... }
 *
 * Auth: x-executor-token header (compartilhado com bot).
 *
 * Modes (PINNACLE_EXECUTOR_MODE):
 *   - 'mock'       → fake tickets pra testing (default)
 *   - 'playwright' → real bet via chromium headless
 *   - 'api'        → Pinnacle Public API (requires contractual access)
 */

const http = require('http');

const PORT = parseInt(process.env.PINNACLE_EXECUTOR_PORT || process.env.PORT || '3001', 10);
const TOKEN = (process.env.PINNACLE_EXECUTOR_TOKEN || '').trim();
const MODE = String(process.env.PINNACLE_EXECUTOR_MODE || 'mock').toLowerCase();

function log(level, tag, msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`${ts} [${level}] [${tag}] ${msg}\n`);
}

log('INFO', 'BOOT', `mode=${MODE} port=${PORT} token=${TOKEN ? 'set(' + TOKEN.length + ')' : 'UNSET'}`);

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes = 100000) {
  return new Promise((resolve) => {
    let data = '';
    let aborted = false;
    req.on('data', c => {
      if (aborted) return;
      data += c;
      if (data.length > maxBytes) {
        aborted = true;
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// ─── Mode: mock (fake response, no real bet) ────────────────────────────
async function placeBetMock(payload) {
  await new Promise(r => setTimeout(r, 600 + Math.random() * 1000));
  return {
    ok: true,
    ticket_id: `MOCK-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    actual_odd: payload.expected_odd,
    stake_brl: payload.stake_brl,
    status: 'placed',
  };
}

// ─── Mode: playwright (real bet via chromium headless) ──────────────────
let _persistentBrowser = null;
let _persistentContext = null;
const fs = require('fs');
const STORAGE_STATE_PATH = process.env.PLAYWRIGHT_STORAGE_PATH || '/tmp/pinnacle-session.json';

// 2026-05-21 idempotency cache: tip_id → { ts, result } pra anti-dup HTTP retry
// Cleanup automático após 10min (sweep no place-bet handler)
const _idempotencyCache = new Map();
function _cleanIdempotency() {
  const now = Date.now();
  for (const [k, v] of _idempotencyCache.entries()) {
    if (now - v.ts > 10 * 60 * 1000) _idempotencyCache.delete(k);
  }
}

async function _getOrCreateContext() {
  const { chromium } = require('playwright');
  if (_persistentBrowser && _persistentContext) {
    try {
      _persistentContext.pages();
      return { browser: _persistentBrowser, context: _persistentContext };
    } catch (_) {
      _persistentBrowser = null;
      _persistentContext = null;
    }
  }
  _persistentBrowser = await chromium.launch({
    headless: !/^(0|false|no)$/i.test(String(process.env.PLAYWRIGHT_HEADLESS ?? 'true')),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });
  const contextOpts = {
    userAgent: process.env.PLAYWRIGHT_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'pt-BR',
  };
  if (fs.existsSync(STORAGE_STATE_PATH)) {
    contextOpts.storageState = STORAGE_STATE_PATH;
    log('INFO', 'PLAYWRIGHT', `reusing storageState ${STORAGE_STATE_PATH}`);
  }
  _persistentContext = await _persistentBrowser.newContext(contextOpts);
  return { browser: _persistentBrowser, context: _persistentContext };
}

async function _ensureLoggedIn(context) {
  const username = process.env.PINNACLE_USERNAME;
  const password = process.env.PINNACLE_PASSWORD;
  if (!username || !password) throw new Error('PINNACLE_USERNAME/PASSWORD não configuradas');
  const page = await context.newPage();
  // 2026-05-21: BR default — pinnacle.bet.br (apex domain pós-regulação jul/2024).
  // pinnacle.com/pt/ ainda funciona internacional (PINNACLE_BASE_URL override).
  const base = process.env.PINNACLE_BASE_URL || 'https://pinnacle.bet.br/';
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // 2026-05-21 fix: aguardar network idle ANTES de procurar login button.
  // Audit log mostrou locator.click timeout 10s em #4063/#4065 → page ainda
  // estava carregando assets quando tentou clicar. SPA Angular precisa de
  // mais tempo pra renderizar elementos interativos. Soft fail (ignore).
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // Detect logged in via balance/account elements
  const isLogged = await page.locator(
    'text=/sair|logout/i, [data-test-id="user-balance"], [data-test-id="account-menu"]'
  ).first().isVisible().catch(() => false);
  if (isLogged) {
    log('INFO', 'PLAYWRIGHT', 'already logged in (storageState valid)');
    await page.close();
    return true;
  }
  // 2026-05-21 fix: timeout 10s → 30s. Pinnacle BR SPA pode demorar pra
  // hydratar elementos. + log title/URL pra diagnóstico se ainda falhar.
  try {
    await page.locator(
      '[data-test-id="login-button"], button:has-text("Entrar"), button:has-text("Login"), a:has-text("Entrar"), a:has-text("Login")'
    ).first().click({ timeout: 30000 });
  } catch (e) {
    // Diagnóstico: dump title + URL + visible buttons pra logs
    let title = '', url = '', buttons = '';
    try { title = await page.title(); } catch (_) {}
    try { url = page.url(); } catch (_) {}
    try {
      const btnTexts = await page.locator('button, a[role="button"]').allTextContents().catch(() => []);
      buttons = btnTexts.slice(0, 10).map(b => b.trim().slice(0, 30)).filter(Boolean).join(' | ');
    } catch (_) {}
    log('ERROR', 'PLAYWRIGHT', `login-button not found after 30s. title="${title}" url="${url}" visible_buttons="${buttons}"`);
    throw new Error(`login-button locator timeout 30s. title="${title}" buttons="${buttons.slice(0,200)}"`);
  }
  // Fill credentials
  await page.locator(
    'input[name="customerId"], input[name="username"], input[type="email"]'
  ).first().fill(username, { timeout: 15000 });
  await page.locator(
    'input[name="password"], input[type="password"]'
  ).first().fill(password);
  await page.locator(
    'button[type="submit"]:has-text("Entrar"), button[type="submit"]:has-text("Login"), button[data-test-id="login-submit"]'
  ).first().click();
  await page.waitForLoadState('networkidle', { timeout: 45000 });
  await context.storageState({ path: STORAGE_STATE_PATH });
  log('INFO', 'PLAYWRIGHT', 'login OK, storageState saved');
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
    const eventUrl = (process.env.PINNACLE_EVENT_URL_TEMPLATE || 'https://pinnacle.bet.br/event/{event_id}')
      .replace('{event_id}', payload.event_id);
    await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Click market + side (multi-selector resilient)
    const marketSelector = `[data-market-type="${payload.market_id}"], [data-test-id="market-${payload.market_id}"], [data-market="${payload.market_id}"]`;
    const sideSelector = `[data-side="${payload.side}"], [data-test-id="side-${payload.side}"], button:has-text("${payload.expected_odd}")`;
    await page.locator(marketSelector).first().locator(sideSelector).first().click({ timeout: 15000 });

    // Fill stake
    await page.locator(
      'input[name="stake"], input[data-test-id="stake-input"], input[type="number"]'
    ).first().fill(String(payload.stake_brl), { timeout: 10000 });

    await page.waitForTimeout(1000); // odd refresh

    // Slippage check — ASYMMETRIC (audit P1-4 fix):
    //   - Odd DOWN (Pinnacle baixou) = nos prejudica, reject se shift > max
    //   - Odd UP (Pinnacle subiu = melhor pra user) = SEMPRE aceita (free edge)
    const currentOddText = await page.locator(
      '[data-test-id="current-odd"], .bet-slip-odd, [data-test-id="bet-slip-price"]'
    ).first().textContent().catch(() => null);
    const currentOdd = currentOddText
      ? parseFloat(String(currentOddText).replace(',', '.').replace(/[^\d.]/g, ''))
      : payload.expected_odd;
    const expected = payload.expected_odd;
    // Negative shift (Pinnacle baixou) é prejudicial; positive (subiu) é bom
    const slipDownPct = currentOdd < expected ? ((expected - currentOdd) / expected * 100) : 0;
    if (slipDownPct > (payload.max_slippage_pct || 2)) {
      await page.close();
      return {
        ok: false,
        error: `slippage DOWN ${slipDownPct.toFixed(2)}% > max ${payload.max_slippage_pct}% (expected=${expected} current=${currentOdd})`,
      };
    }
    // Positive slip log (free edge — Pinnacle subiu)
    if (currentOdd > expected) {
      const slipUpPct = ((currentOdd - expected) / expected * 100);
      log('INFO', 'SLIPPAGE-UP', `accepting positive slip +${slipUpPct.toFixed(2)}% (expected=${expected} current=${currentOdd})`);
    }

    // Confirm bet
    await page.locator(
      'button[data-test-id="place-bet-button"], button:has-text("Confirmar Aposta"), button:has-text("Place Bet"), button[type="submit"]:has-text("Confirmar")'
    ).first().click({ timeout: 10000 });

    // Parse receipt
    await page.waitForSelector(
      '[data-test-id="bet-receipt"], .bet-receipt, [data-test-id="bet-confirmation"]',
      { timeout: 15000 }
    );
    const ticketText = await page.locator(
      '[data-test-id="ticket-id"], .ticket-number, [data-test-id="bet-id"]'
    ).first().textContent().catch(() => null);
    const ticketId = ticketText ? ticketText.trim() : `PW-${Date.now()}`;

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
    // Debug screenshot
    try {
      const ts = Date.now();
      await page.screenshot({ path: `/tmp/pinnacle-err-${ts}.png` }).catch(() => {});
      log('WARN', 'PLAYWRIGHT', `screenshot saved: /tmp/pinnacle-err-${ts}.png`);
    } catch (_) {}
    try { await page.close(); } catch (_) {}
    return { ok: false, error: `playwright bet: ${e.message}` };
  }
}

// ─── Mode: api (Pinnacle Public API) ────────────────────────────────────
async function placeBetApi(payload) {
  // Stub — Pinnacle Public API requires contractual access (B2B partnerships).
  // Quando user tiver acesso, implementar aqui via fetch:
  //   const apiKey = process.env.PINNACLE_API_KEY;
  //   POST https://api.pinnacle.com/v1/bets/place
  return {
    ok: false,
    error: 'api mode not implemented — Pinnacle Public API requires contractual access (contact Pinnacle BD)',
  };
}

// ─── HTTP server ────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Healthz (no auth)
  if (req.url === '/healthz' || req.url === '/') {
    return sendJson(res, 200, { ok: true, mode: MODE, port: PORT, ts: new Date().toISOString() });
  }

  // Place bet
  if (req.url === '/place-bet' && req.method === 'POST') {
    // Auth
    if (TOKEN && req.headers['x-executor-token'] !== TOKEN) {
      log('WARN', 'AUTH', `unauthorized request from ${req.socket.remoteAddress}`);
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }

    const payload = await readBody(req);
    if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid_json_or_too_large' });
    if (!payload.event_id || !payload.market_id || !payload.side) {
      return sendJson(res, 400, { ok: false, error: 'missing required fields (event_id, market_id, side)' });
    }
    if (!Number.isFinite(payload.stake_brl) || payload.stake_brl <= 0) {
      return sendJson(res, 400, { ok: false, error: 'invalid stake_brl' });
    }

    // 2026-05-21 audit RH-1: idempotency via tip_id cache. Anti HTTP retry → 2x bet.
    // Cache map { tip_id: { ts, result } } com TTL 10min. Cobre Railway proxy retry +
    // bot retry. Persistence via /tmp não usado (acceptable: restart limpa state).
    if (payload.tip_id) {
      const cached = _idempotencyCache.get(String(payload.tip_id));
      if (cached && (Date.now() - cached.ts) < 10 * 60 * 1000) {
        log('INFO', 'IDEMPOTENT', `tip_id=${payload.tip_id} já processado — retornando cached result`);
        return sendJson(res, 200, { ...cached.result, idempotent: true });
      }
    }

    log('INFO', 'BET-REQ', `${payload.sport}/${payload.market_id}/${payload.side} stake=R$${payload.stake_brl} odd=${payload.expected_odd} event=${payload.event_id} tip=${payload.tip_id || '?'}`);

    try {
      let result;
      if (MODE === 'playwright') result = await placeBetPlaywright(payload);
      else if (MODE === 'api') result = await placeBetApi(payload);
      else result = await placeBetMock(payload);

      // Cache result em idempotency (apenas se tem tip_id + result resolved)
      if (payload.tip_id && result) {
        _idempotencyCache.set(String(payload.tip_id), { ts: Date.now(), result });
        _cleanIdempotency(); // sweep TTL
      }

      if (result.ok) {
        log('INFO', 'BET-OK', `ticket=${result.ticket_id} odd=${result.actual_odd} stake=R$${result.stake_brl}`);
      } else {
        log('WARN', 'BET-FAIL', `error=${result.error}`);
      }
      return sendJson(res, result.ok ? 200 : 502, result);
    } catch (e) {
      log('ERROR', 'BET-EXCEPTION', e.message);
      // Cache exception result tb pra anti-retry
      if (payload.tip_id) {
        _idempotencyCache.set(String(payload.tip_id), { ts: Date.now(), result: { ok: false, error: e.message } });
      }
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, () => {
  log('INFO', 'BOOT', `listening :${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('INFO', 'SHUTDOWN', 'SIGTERM received, closing...');
  if (_persistentBrowser) {
    try { await _persistentBrowser.close(); } catch (_) {}
  }
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => process.kill(process.pid, 'SIGTERM'));

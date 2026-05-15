/**
 * Integration test /record-tip — boota server.js subprocess + exercita
 * paths críticos via HTTP. Pega bug class detectada em audit log 2026-05-15
 * (catch ReferenceError p1, commit 593607a) + outras regressões de handler.
 *
 * Subprocess approach: spawn `node server.js` com PORT/DB_PATH temp.
 * ~700ms boot + reuso pra toda suite. Kill no teardown.
 *
 * NÃO requer TEST_MODE em server.js. External API calls em background
 * (Pinnacle 500, CSV 404) são esperados e não afetam /record-tip handler.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const HEALTH_TIMEOUT_MS = 30000;
const HTTP_TIMEOUT_MS = 5000;

const ADMIN_KEY = 'test'; // bate com env passado pro subprocess

function httpJson(port, method, requestPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    const req = http.request({ port, method, path: requestPath, headers, timeout: HTTP_TIMEOUT_MS }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitHealth(port, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await httpJson(port, 'GET', '/health');
      if (r.status === 200) return Date.now() - t0;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`server not healthy after ${maxMs}ms`);
}

module.exports = async function runTests(t) {
  // ─── Setup: spawn server subprocess ─────────────────────────────────────
  const tmpDb = path.join(os.tmpdir(), `test-record-tip-${Date.now()}.db`);
  // Port aleatório no range 30000-39999 pra evitar colisão com dev local
  const port = 30000 + Math.floor(Math.random() * 10000);
  const env = {
    ...process.env,
    DB_PATH: tmpDb,
    PORT: String(port),
    ADMIN_KEY: 'test',
    ADMIN_KEY_OPEN: 'true', // permite admin sem key durante teste
    AI_DISABLED: 'true',
    NODE_ENV: 'test',
    // silencia external polls que printam ruído (best effort — não bloqueia se ignored)
    BOT_DISABLED: 'true',
  };

  let serverStdout = '', serverStderr = '';
  const proc = spawn('node', ['server.js'], {
    env,
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', d => { serverStdout += d.toString(); });
  proc.stderr.on('data', d => { serverStderr += d.toString(); });

  let bootMs;
  try {
    bootMs = await waitHealth(port, HEALTH_TIMEOUT_MS);
  } catch (e) {
    proc.kill();
    try { fs.unlinkSync(tmpDb); } catch {}
    throw new Error(`server boot failed: ${e.message}\nstdout tail:\n${serverStdout.slice(-800)}\nstderr tail:\n${serverStderr.slice(-400)}`);
  }

  // Cleanup teardown se qualquer test crashar
  const teardown = () => {
    try { proc.kill(); } catch (_) {}
    try { fs.unlinkSync(tmpDb); } catch (_) {}
    try { fs.unlinkSync(tmpDb + '-shm'); } catch (_) {}
    try { fs.unlinkSync(tmpDb + '-wal'); } catch (_) {}
  };

  try {
    // ─── Test 1: /health smoke ────────────────────────────────────────────
    await t.test(`server boota healthy em <${HEALTH_TIMEOUT_MS}ms (real: ${bootMs}ms)`, async () => {
      const r = await httpJson(port, 'GET', '/health');
      t.assert(r.status === 200, `expected 200, got ${r.status}`);
      t.assert(r.body.db === 'connected', `db: ${r.body.db}`);
    });

    const AUTH = { 'x-admin-key': ADMIN_KEY };

    // ─── Test 2: /record-tip missing matchId → 400 ─────────────────────────
    await t.test('rejects POST /record-tip sem matchId → 400', async () => {
      const r = await httpJson(port, 'POST', '/record-tip?sport=dota2', {}, AUTH);
      t.assert(r.status === 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
      t.assert(/matchId/.test(JSON.stringify(r.body)), `expected matchId mention, got ${JSON.stringify(r.body)}`);
    });

    // ─── Test 3: /record-tip missing p1/p2 → 400 ──────────────────────────
    await t.test('rejects POST /record-tip sem p1/p2 → 400', async () => {
      const r = await httpJson(port, 'POST', '/record-tip?sport=dota2', {
        matchId: 'test_dota2_1',
        eventName: 'Test League',
      }, AUTH);
      t.assert(r.status === 400, `expected 400, got ${r.status}`);
      t.assert(/p1|p2/.test(JSON.stringify(r.body)), `expected p1/p2 mention, got ${JSON.stringify(r.body)}`);
    });

    // ─── Test 4: /record-tip invalid odds → 400 ───────────────────────────
    await t.test('rejects POST /record-tip com odds <= 1 → 400', async () => {
      const r = await httpJson(port, 'POST', '/record-tip?sport=dota2', {
        matchId: 'test_dota2_invalid_odds',
        eventName: 'Test League',
        p1: 'TeamA',
        p2: 'TeamB',
        tipParticipant: 'TeamA',
        odds: 0.5,
        ev: 8.5,
      }, AUTH);
      t.assert(r.status === 400, `expected 400, got ${r.status} body=${JSON.stringify(r.body)}`);
      t.assert(/odds/.test(JSON.stringify(r.body)), `expected odds mention, got ${JSON.stringify(r.body)}`);
    });

    // ─── Test 5: /record-tip auth gate — sem x-admin-key → 401 ────────────
    await t.test('rejects POST /record-tip sem x-admin-key → 401', async () => {
      const r = await httpJson(port, 'POST', '/record-tip?sport=dota2', {
        matchId: 'test_dota2_noauth',
        eventName: 'Test League',
        p1: 'TeamA',
        p2: 'TeamB',
        tipParticipant: 'TeamA',
        odds: 1.85,
        ev: 8.5,
      });
      t.assert(r.status === 401, `expected 401, got ${r.status} body=${JSON.stringify(r.body)}`);
      t.assert(/unauthorized/i.test(JSON.stringify(r.body)), `expected unauthorized, got ${JSON.stringify(r.body)}`);
    });

    // ─── Test 6: /record-tip valid body — não crasha, retorna JSON ─────────
    // Não asserta sucesso específico (pode rejeitar por shadow gates etc),
    // mas confirma handler NÃO crasha + retorna shape válido.
    await t.test('POST /record-tip valid body responde JSON estruturado (não 5xx)', async () => {
      const r = await httpJson(port, 'POST', '/record-tip?sport=dota2', {
        matchId: 'test_dota2_valid_' + Date.now(),
        eventName: 'Test League',
        p1: 'TeamA',
        p2: 'TeamB',
        tipParticipant: 'TeamA',
        tipTeam: 'TeamA',
        odds: 1.85,
        ev: 8.5,
        modelP: 0.62,
        confidence: 'MEDIA',
        stakeUnits: 1.0,
      }, AUTH);
      t.assert(typeof r.body === 'object' && r.body !== null, `expected JSON object, got ${typeof r.body}`);
      t.assert(r.status >= 200 && r.status < 500, `expected non-server-error, got ${r.status} body=${JSON.stringify(r.body)}`);
      t.assert('ok' in r.body || 'error' in r.body, `expected ok/error key, got ${JSON.stringify(r.body)}`);
    });

    // ─── Test 7: UNIQUE constraint race → 409 sem crash (P0 fix 593607a) ──
    // Disparar 2 POSTs simultâneos com mesma matchId. Um ganha race + insert
    // OK; outro pega UNIQUE constraint → catch fire → 409 retornado.
    // Sem o fix do commit 593607a, catch crasharia com "p1 is not defined"
    // ReferenceError → handler nunca responde → bot.js timeout 5s.
    await t.test('UNIQUE race: 2 POSTs concorrentes não crasham handler (P0 593607a)', async () => {
      const body = {
        matchId: 'test_dota2_race_' + Date.now(),
        eventName: 'Race League',
        p1: 'RacerA',
        p2: 'RacerB',
        tipParticipant: 'RacerA',
        tipTeam: 'RacerA',
        odds: 1.85,
        ev: 8.5,
        modelP: 0.62,
        confidence: 'MEDIA',
        stakeUnits: 1.0,
      };
      const [r1, r2] = await Promise.all([
        httpJson(port, 'POST', '/record-tip?sport=dota2', body, AUTH),
        httpJson(port, 'POST', '/record-tip?sport=dota2', body, AUTH),
      ]);
      // Ambos devem retornar resposta JSON válida (não timeout / não crash)
      for (let i = 0; i < 2; i++) {
        const r = i === 0 ? r1 : r2;
        t.assert(r.status >= 200 && r.status < 500, `request ${i+1}: expected non-5xx, got ${r.status} body=${JSON.stringify(r.body)}`);
        t.assert(typeof r.body === 'object', `request ${i+1}: expected JSON body, got ${typeof r.body}`);
      }
      // Pelo menos um deve ter sucesso (ok=true OR skipped=true).
      // Race-loser pode retornar 409 (commit 593607a fix) OU 200 com skipped=true (dedup hit antes).
      const oks = [r1, r2].filter(r => r.status === 200 || r.status === 409);
      t.assert(oks.length === 2, `expected both 200/409, got statuses ${[r1.status, r2.status].join(',')}`);
    });

  } finally {
    teardown();
  }
};

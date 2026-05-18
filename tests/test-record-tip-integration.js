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

    // ─── Test 7a: ev_sanity_cap → skipped quando ev > RECORD_TIP_EV_CAP_PCT ──
    // Handler chama _emitSkip → {ok:true,skipped:true,reason:'ev_sanity_cap',sport,evN,cap,matchId}.
    await t.test('ev_sanity_cap: ev=75 não-shadow → skipped reason=ev_sanity_cap', async () => {
      const r = await httpJson(port, 'POST', '/record-tip?sport=dota2', {
        matchId: 'test_dota2_ev_high_' + Date.now(),
        eventName: 'Test League',
        p1: 'EVAlpha',
        p2: 'EVBeta',
        tipParticipant: 'EVAlpha',
        odds: 2.5,
        ev: 75, // > cap 50
      }, AUTH);
      t.assert(r.status === 200, `expected 200 (skipped), got ${r.status}`);
      t.assert(r.body.skipped === true, `expected skipped=true, got ${JSON.stringify(r.body)}`);
      t.assert(r.body.reason === 'ev_sanity_cap', `expected reason=ev_sanity_cap, got ${r.body.reason}`);
      t.assert(r.body.cap === 50, `expected cap=50 (default RECORD_TIP_EV_CAP_PCT), got ${r.body.cap}`);
    });

    // ─── Test 7b: ev_sanity_cap bypassed for shadow tip ────────────────────
    // Mesma EV alta + isShadow=true → NÃO deve cair em ev_sanity_cap.
    await t.test('ev_sanity_cap: isShadow=true bypassa cap mesmo com ev=75', async () => {
      const r = await httpJson(port, 'POST', '/record-tip?sport=dota2', {
        matchId: 'test_dota2_ev_shadow_' + Date.now(),
        eventName: 'Test League',
        p1: 'EVShadowA',
        p2: 'EVShadowB',
        tipParticipant: 'EVShadowA',
        odds: 2.5,
        ev: 75,
        isShadow: true,
      }, AUTH);
      // NÃO deve ser ev_sanity_cap (pode ser outra reason ou ok). Asserta apenas
      // que reason ≠ ev_sanity_cap — comprova bypass.
      t.assert(r.status >= 200 && r.status < 500, `expected non-5xx, got ${r.status}`);
      t.assert(r.body.reason !== 'ev_sanity_cap', `shadow should bypass ev_sanity_cap, got reason=${r.body.reason}`);
    });

    // ─── Test 7c: sequential duplicate POST → segundo dedup ────────────────
    // 2 POSTs serializados com mesmo matchId+pick. Primeiro INSERT, segundo
    // detecta via recentDupe SELECT (L24286+) e retorna skipped=true reason=duplicate
    // OU race-loser 409 (caso o race se materialize em sqlite).
    await t.test('sequential duplicate POST → segundo skipped (não crasha)', async () => {
      const body = {
        matchId: 'test_dota2_dupe_seq_' + Date.now(),
        eventName: 'Dedup League',
        p1: 'DupeA',
        p2: 'DupeB',
        tipParticipant: 'DupeA',
        tipTeam: 'DupeA',
        odds: 1.85,
        ev: 8.5,
        modelP: 0.62,
        confidence: 'MEDIA',
        stakeUnits: 1.0,
      };
      const r1 = await httpJson(port, 'POST', '/record-tip?sport=dota2', body, AUTH);
      const r2 = await httpJson(port, 'POST', '/record-tip?sport=dota2', body, AUTH);
      t.assert(r1.status >= 200 && r1.status < 500, `r1: expected non-5xx, got ${r1.status}`);
      t.assert(r2.status >= 200 && r2.status < 500, `r2: expected non-5xx, got ${r2.status}`);
      // r2 deve ter skipped=true OU status 409. Não pode crashar (5xx) nem
      // duplicar INSERT (caso aceitasse, integration semantic quebrada).
      const r2Body = JSON.stringify(r2.body);
      t.assert(
        r2.body.skipped === true || r2.status === 409,
        `r2 should be skipped or 409 race, got status=${r2.status} body=${r2Body}`
      );
    });

    // ─── Test 7d: temporal_gate_post_match — match já resolved > slack ──
    // server.js L24003-24018: query match_results WHERE match_id = ?; se
    // resolved_at > 60s no passado → skip reason=temporal_gate_post_match.
    // Test usa SEGUNDA conexão SQLite (WAL allows multi-conn) pra seed
    // direto. /admin/upsert-match-result usa DEFAULT resolved_at=now,
    // não satisfaz gate. INSERT explícito com resolved_at antigo dispara.
    await t.test('temporal_gate_post_match: match resolved >60s atrás → rejected', async () => {
      const Database = require('better-sqlite3');
      const matchId = 'test_dota2_temporal_' + Date.now();
      const seedDb = new Database(tmpDb, { timeout: 5000 });
      try {
        seedDb.prepare(`
          INSERT OR REPLACE INTO match_results
            (match_id, game, team1, team2, winner, final_score, league, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(matchId, 'dota2', 'TemporalA', 'TemporalB', 'TemporalA', 'Bo3 2-0', 'Test League', '2024-01-01 00:00:00');
      } finally {
        seedDb.close();
      }
      const r = await httpJson(port, 'POST', '/record-tip?sport=dota2', {
        matchId,
        eventName: 'Test League',
        p1: 'TemporalA',
        p2: 'TemporalB',
        tipParticipant: 'TemporalA',
        odds: 1.85,
        ev: 8.5,
      }, AUTH);
      t.assert(r.status === 200, `expected 200 (skipped), got ${r.status} body=${JSON.stringify(r.body)}`);
      t.assert(r.body.skipped === true, `expected skipped=true, got ${JSON.stringify(r.body)}`);
      t.assert(r.body.reason === 'temporal_gate_post_match', `expected reason=temporal_gate_post_match, got ${r.body.reason}`);
      t.assert(typeof r.body.ageS === 'number' || typeof r.body.age_s === 'number', `expected age in seconds, got ${JSON.stringify(r.body)}`);
    });

    // ─── Test 7e: league_blocked via league_blocks table ──────────────────
    // server.js L24493-24501: query league_blocks WHERE sport=? AND league=?
    // AND unblocked_at IS NULL → _emitSkip('league_blocked').
    // Seed: INSERT em league_blocks com unblocked_at=NULL (entry ativo).
    await t.test('league_blocked: eventName em league_blocks → rejected', async () => {
      const Database = require('better-sqlite3');
      const blockedLeague = 'TestBlockedLeague_' + Date.now();
      const seedDb = new Database(tmpDb, { timeout: 5000 });
      try {
        seedDb.prepare(`
          INSERT INTO league_blocks (sport, league, reason, auto)
          VALUES (?, ?, ?, ?)
        `).run('dota2', blockedLeague, 'test_seed', 0);
      } finally {
        seedDb.close();
      }
      const r = await httpJson(port, 'POST', '/record-tip?sport=dota2', {
        matchId: 'test_dota2_leagueblock_' + Date.now(),
        eventName: blockedLeague,
        p1: 'LeagueBlockA',
        p2: 'LeagueBlockB',
        tipParticipant: 'LeagueBlockA',
        odds: 1.85,
        ev: 8.5,
      }, AUTH);
      t.assert(r.status === 200, `expected 200 (skipped), got ${r.status} body=${JSON.stringify(r.body)}`);
      t.assert(r.body.skipped === true, `expected skipped=true, got ${JSON.stringify(r.body)}`);
      t.assert(r.body.reason === 'league_blocked', `expected reason=league_blocked, got ${r.body.reason}`);
      t.assert(r.body.block && r.body.block.reason === 'test_seed', `expected block.reason=test_seed, got ${JSON.stringify(r.body.block)}`);
    });

    // ─── Test 7f: voided_odds_wrong_match via voided_tips table ────────────
    // server.js L24343-24345: isVoidedMatch SELECT 1 FROM voided_tips
    // WHERE sport=? AND match_id=? → _emitSkip('voided_odds_wrong_match').
    // Seed: INSERT em voided_tips com sport+match_id.
    await t.test('voided_odds_wrong_match: matchId previamente voidado → rejected', async () => {
      const Database = require('better-sqlite3');
      const matchId = 'test_dota2_voided_' + Date.now();
      const seedDb = new Database(tmpDb, { timeout: 5000 });
      try {
        seedDb.prepare(`
          INSERT INTO voided_tips (sport, match_id, p1_norm, p2_norm, reason)
          VALUES (?, ?, ?, ?, ?)
        `).run('dota2', matchId, 'voida', 'voidb', 'odds_wrong_test');
      } finally {
        seedDb.close();
      }
      const r = await httpJson(port, 'POST', '/record-tip?sport=dota2', {
        matchId,
        eventName: 'Voided Test League',
        p1: 'VoidA',
        p2: 'VoidB',
        tipParticipant: 'VoidA',
        odds: 1.85,
        ev: 8.5,
      }, AUTH);
      t.assert(r.status === 200, `expected 200 (skipped), got ${r.status} body=${JSON.stringify(r.body)}`);
      t.assert(r.body.skipped === true, `expected skipped=true, got ${JSON.stringify(r.body)}`);
      t.assert(r.body.reason === 'voided_odds_wrong_match', `expected reason=voided_odds_wrong_match, got ${r.body.reason}`);
    });

    // ─── Test 7g: voided_odds_wrong_pair_recent ────────────────────────────
    // server.js L24674-24679: stmts.isVoidedPairRecent SELECT 1 FROM voided_tips
    // WHERE sport=? AND market_type=? AND (p1_norm,p2_norm) OR (p2_norm,p1_norm)
    // AND created_at >= now-90 days.
    // Seed: INSERT voided_tips com pair + market_type=ML (default) + match_id
    // DIFERENTE do POST (pra wrong_match não disparar antes).
    await t.test('voided_odds_wrong_pair_recent: pair previamente voidada → rejected', async () => {
      const Database = require('better-sqlite3');
      const p1Norm = 'pairvoida'; // normalized lowercase, sem espaços
      const p2Norm = 'pairvoidb';
      const seedDb = new Database(tmpDb, { timeout: 5000 });
      try {
        seedDb.prepare(`
          INSERT INTO voided_tips (sport, match_id, p1_norm, p2_norm, market_type, reason)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run('dota2', 'test_voided_pair_seed_' + Date.now(), p1Norm, p2Norm, 'ML', 'pair_test_seed');
      } finally {
        seedDb.close();
      }
      // POST com matchId NOVO (não conflita com wrong_match) mas pair MATCH.
      // Note: handler norm() lowercase + strip — então p1='PairVoidA' vira 'pairvoida'.
      const r = await httpJson(port, 'POST', '/record-tip?sport=dota2', {
        matchId: 'test_dota2_pair_NEW_' + Date.now(),
        eventName: 'Pair Void Test League',
        p1: 'PairVoidA',
        p2: 'PairVoidB',
        tipParticipant: 'PairVoidA',
        odds: 1.85,
        ev: 8.5,
      }, AUTH);
      t.assert(r.status === 200, `expected 200 (skipped), got ${r.status} body=${JSON.stringify(r.body)}`);
      t.assert(r.body.skipped === true, `expected skipped=true, got ${JSON.stringify(r.body)}`);
      t.assert(r.body.reason === 'voided_odds_wrong_pair_recent', `expected reason=voided_odds_wrong_pair_recent, got ${r.body.reason}`);
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

  // ─── Bloco env-driven: spawn segundo subprocess com env override ─────────
  // Pattern reutilizável pra paths env-gated: ml_disabled_per_sport,
  // ml_not_in_tier1_leagues, match_stop_loss, time_of_day_blocked. Cada um
  // requer env distinto no boot, então cada test instancia subprocess próprio.
  // Helper: spawn subprocess com env override + run single POST. Retorna response.
  async function withEnvServer(envOverride, doRequest) {
    const tmpDbX = path.join(os.tmpdir(), `test-rt-env-${Date.now()}-${Math.random().toString(36).slice(2,8)}.db`);
    const portX = 30000 + Math.floor(Math.random() * 10000);
    const envX = { ...env, DB_PATH: tmpDbX, PORT: String(portX), ...envOverride };
    const procX = spawn('node', ['server.js'], { env: envX, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    procX.stdout.on('data', () => {});
    procX.stderr.on('data', () => {});
    try {
      await waitHealth(portX, HEALTH_TIMEOUT_MS);
      return await doRequest(portX);
    } finally {
      try { procX.kill(); } catch (_) {}
      try { fs.unlinkSync(tmpDbX); } catch (_) {}
      try { fs.unlinkSync(tmpDbX + '-shm'); } catch (_) {}
      try { fs.unlinkSync(tmpDbX + '-wal'); } catch (_) {}
    }
  }

  await t.test('ml_disabled_per_sport: DOTA2_ML_DISABLED=true + HARD_REJECT → rejected', async () => {
    const tmpDb2 = path.join(os.tmpdir(), `test-rt-mldis-${Date.now()}.db`);
    const port2 = 30000 + Math.floor(Math.random() * 10000);
    const env2 = {
      ...env,
      DB_PATH: tmpDb2,
      PORT: String(port2),
      DOTA2_ML_DISABLED: 'true',
      ML_DISABLED_HARD_REJECT: 'true', // bypass auto-route → emite skip reason
    };
    const proc2 = spawn('node', ['server.js'], { env: env2, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout2 = '', stderr2 = '';
    proc2.stdout.on('data', d => { stdout2 += d.toString(); });
    proc2.stderr.on('data', d => { stderr2 += d.toString(); });
    try {
      await waitHealth(port2, HEALTH_TIMEOUT_MS);
      const r = await httpJson(port2, 'POST', '/record-tip?sport=dota2', {
        matchId: 'test_dota2_mldis_' + Date.now(),
        eventName: 'ML Disabled Test',
        p1: 'MLDisA',
        p2: 'MLDisB',
        tipParticipant: 'MLDisA',
        odds: 1.85,
        ev: 8.5,
      }, { 'x-admin-key': 'test' });
      t.assert(r.status === 200, `expected 200 (skipped), got ${r.status} body=${JSON.stringify(r.body)}`);
      t.assert(r.body.skipped === true, `expected skipped=true, got ${JSON.stringify(r.body)}`);
      t.assert(r.body.reason === 'ml_disabled_per_sport', `expected reason=ml_disabled_per_sport, got ${r.body.reason}`);
      t.assert(r.body.env === 'DOTA2_ML_DISABLED', `expected env echo, got ${r.body.env}`);
    } finally {
      try { proc2.kill(); } catch (_) {}
      try { fs.unlinkSync(tmpDb2); } catch (_) {}
      try { fs.unlinkSync(tmpDb2 + '-shm'); } catch (_) {}
      try { fs.unlinkSync(tmpDb2 + '-wal'); } catch (_) {}
    }
  });

  // ─── ml_not_in_tier1_leagues via env DOTA2_ML_TIER1_LEAGUES csv ────────
  // server.js L24370-24383: se env <SPORT>_ML_TIER1_LEAGUES set + eventName
  // NÃO substring-match nenhuma liga csv → _emitSkip('ml_not_in_tier1_leagues').
  // HARD_REJECT bypassa _autoRouteToShadow.
  await t.test('ml_not_in_tier1_leagues: eventName fora csv DOTA2_ML_TIER1_LEAGUES → rejected', async () => {
    const r = await withEnvServer(
      {
        DOTA2_ML_TIER1_LEAGUES: 'the international,esl one,riyadh masters',
        ML_TIER1_HARD_REJECT: 'true',
      },
      (portX) => httpJson(portX, 'POST', '/record-tip?sport=dota2', {
        matchId: 'test_dota2_tier1_' + Date.now(),
        eventName: 'Some Random Regional League',
        p1: 'Tier1A',
        p2: 'Tier1B',
        tipParticipant: 'Tier1A',
        odds: 1.85,
        ev: 8.5,
      }, { 'x-admin-key': 'test' })
    );
    t.assert(r.status === 200, `expected 200 (skipped), got ${r.status} body=${JSON.stringify(r.body)}`);
    t.assert(r.body.skipped === true, `expected skipped=true, got ${JSON.stringify(r.body)}`);
    t.assert(r.body.reason === 'ml_not_in_tier1_leagues', `expected reason=ml_not_in_tier1_leagues, got ${r.body.reason}`);
    t.assert(r.body.league === 'Some Random Regional League', `expected league echo, got ${r.body.league}`);
  });

  // ─── P2 dedup is_shadow filter (commit 0e14ae7 hoje 2026-05-17) ─────────
  // Validate: shadow tip com mesmo match_id NÃO bloqueia real subsequente.
  // Antes do fix: existingCross / recentDupe não filtravam is_shadow → shadow
  // legacy archived=0 result=NULL bloqueava real (bug basket P0 fix hoje).
  // Test:
  //   1. POST shadow tip
  //   2. POST real tip mesmo matchId → deve passar (dedup só real-vs-real)
  await t.test('P2 dedup: shadow tip não bloqueia real subsequente (commit 0e14ae7)', async () => {
    const tmpDbZ = path.join(os.tmpdir(), `test-rt-shadow-dedup-${Date.now()}.db`);
    const portZ = 30000 + Math.floor(Math.random() * 10000);
    const envZ = { ...env, DB_PATH: tmpDbZ, PORT: String(portZ) };
    const procZ = spawn('node', ['server.js'], { env: envZ, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    procZ.stdout.on('data', () => {});
    procZ.stderr.on('data', () => {});
    try {
      await waitHealth(portZ, HEALTH_TIMEOUT_MS);
      const matchId = 'test_dedup_p2_' + Date.now();
      const body = (isShadow) => ({
        matchId, eventName: 'P2 Dedup Test',
        p1: 'P2A', p2: 'P2B', tipParticipant: 'P2A',
        odds: 1.85, ev: 8.5,
        modelP: 0.62, confidence: 'MEDIA', stakeUnits: 1.0,
        marketType: 'ML',
        isShadow,
      });
      // 1) Shadow tip first
      const rShadow = await httpJson(portZ, 'POST', '/record-tip?sport=dota2', body(1), { 'x-admin-key': 'test' });
      t.assert(rShadow.status >= 200 && rShadow.status < 500, `shadow tip should not 5xx, got ${rShadow.status}`);
      // 2) Real tip MESMO matchId — antes do fix bloqueado, agora deve passar
      const rReal = await httpJson(portZ, 'POST', '/record-tip?sport=dota2', body(0), { 'x-admin-key': 'test' });
      t.assert(rReal.status >= 200 && rReal.status < 500, `real tip non-5xx, got ${rReal.status}`);
      // Real DEVE conseguir gravar (não bloqueado por shadow). Status 200 (ok ou skipped por outro motivo) OR 409 race aceitos.
      // O essencial: reason NÃO pode ser 'duplicate' (=existingCross block by shadow).
      if (rReal.body && rReal.body.skipped === true) {
        t.assert(rReal.body.reason !== 'duplicate',
          `real should not be blocked by shadow (P2): got reason=${rReal.body.reason}`);
      }
    } finally {
      try { procZ.kill(); } catch (_) {}
      try { fs.unlinkSync(tmpDbZ); } catch (_) {}
      try { fs.unlinkSync(tmpDbZ + '-shm'); } catch (_) {}
      try { fs.unlinkSync(tmpDbZ + '-wal'); } catch (_) {}
    }
  });

  // ─── /admin/tip-debug endpoint (commit b2e8151 hoje 2026-05-17) ─────────
  // Endpoint admin read-only retorna gate_state + tip data por id. Pega:
  //   - parse error handling (commit aaa711a parse_error symmetric)
  //   - 404 tip not found
  //   - auth gate
  await t.test('/admin/tip-debug: 404 tip not found + 401 auth', async () => {
    const tmpDbQ = path.join(os.tmpdir(), `test-rt-debug-${Date.now()}.db`);
    const portQ = 30000 + Math.floor(Math.random() * 10000);
    const envQ = { ...env, DB_PATH: tmpDbQ, PORT: String(portQ) };
    const procQ = spawn('node', ['server.js'], { env: envQ, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    procQ.stdout.on('data', () => {});
    procQ.stderr.on('data', () => {});
    try {
      await waitHealth(portQ, HEALTH_TIMEOUT_MS);
      // 1) No auth → 401
      const rNoAuth = await httpJson(portQ, 'GET', '/admin/tip-debug?id=9999', undefined);
      t.assert(rNoAuth.status === 401, `expected 401 no-auth, got ${rNoAuth.status}`);
      // 2) Auth + non-existent id → 404
      const r404 = await httpJson(portQ, 'GET', '/admin/tip-debug?id=999999999', undefined, { 'x-admin-key': 'test' });
      t.assert(r404.status === 404, `expected 404 not_found, got ${r404.status}`);
      t.assert(r404.body.error === 'tip_not_found', `expected error=tip_not_found, got ${JSON.stringify(r404.body)}`);
      // 3) Auth + invalid id (no param) → 400
      const r400 = await httpJson(portQ, 'GET', '/admin/tip-debug', undefined, { 'x-admin-key': 'test' });
      t.assert(r400.status === 400, `expected 400 missing-id, got ${r400.status}`);
    } finally {
      try { procQ.kill(); } catch (_) {}
      try { fs.unlinkSync(tmpDbQ); } catch (_) {}
      try { fs.unlinkSync(tmpDbQ + '-shm'); } catch (_) {}
      try { fs.unlinkSync(tmpDbQ + '-wal'); } catch (_) {}
    }
  });

  // ─── match_stop_loss: 2026-05-18 P4 TDD pending coverage ───────────────
  // server.js L25597-25627: env MATCH_STOP_LOSS_UNITS > 0 + cumulative loss
  // ≥ threshold em mesma série (Bo3/Bo5) últimas 6h → _emitSkip('match_stop_loss').
  // Test: env override = 2 units. Seed 2 prior tips loss em mesmo baseMatchId
  // (cada 1u = 2u total). POST nova tip → expect skipped reason=match_stop_loss.
  // is_shadow=0 obrigatório (gate só conta perdas reais).
  await t.test('match_stop_loss: cumulative loss em série >= threshold → rejected', async () => {
    const Database = require('better-sqlite3');
    const tmpDbS = path.join(os.tmpdir(), `test-rt-stoploss-${Date.now()}.db`);
    const portS = 30000 + Math.floor(Math.random() * 10000);
    const envS = { ...env, DB_PATH: tmpDbS, PORT: String(portS), MATCH_STOP_LOSS_UNITS: '2' };
    const procS = spawn('node', ['server.js'], { env: envS, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    procS.stdout.on('data', () => {});
    procS.stderr.on('data', () => {});
    try {
      await waitHealth(portS, HEALTH_TIMEOUT_MS);
      const baseMatchId = 'test_stoploss_' + Date.now();

      // Seed 2 prior LOSSES (cada 1u stake) no MESMO base series. Total 2u loss
      // ≥ threshold 2u → gate dispara. is_shadow=0 obrigatório (loss conta real).
      // sent_at recente garante dentro da janela 6h do gate.
      //
      // IMPORTANTE: usar pair DIFERENTE nas seed rows pra evitar trigger do gate
      // pair-level `recent_loss_same_pair` (server.js:25243), que precede o
      // match_stop_loss. Match_stop_loss usa SOMENTE match_id LIKE — pair
      // irrelevante. Em prod o pair-level dispara primeiro quando aplicável,
      // match_stop_loss cobre o case "pair diferente mesma série" (ex: trade
      // de team1/team2 entre maps Bo5 raramente — mas semanticamente o gate
      // captura cumulative loss na série independent do pair).
      const seedDb = new Database(tmpDbS, { timeout: 5000 });
      try {
        const cols = seedDb.prepare('PRAGMA table_info(tips)').all();
        t.assert(cols.length > 0, `tips table should exist post-boot, got ${cols.length} cols`);
        const insertStmt = `INSERT OR IGNORE INTO tips
          (sport, match_id, tip_participant, participant1, participant2, odds, ev, stake, confidence, result, sent_at, is_shadow, archived)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-30 minutes'), 0, 0)`;
        const r1 = seedDb.prepare(insertStmt).run('dota2', baseMatchId + '_map1', 'PriorAlpha', 'PriorAlpha', 'PriorBeta', 1.85, 8.5, '1u', 'MEDIA', 'loss');
        const r2 = seedDb.prepare(insertStmt).run('dota2', baseMatchId + '_map2', 'PriorBeta', 'PriorAlpha', 'PriorBeta', 2.10, 6.2, '1u', 'MEDIA', 'loss');
        t.assert(r1.changes === 1 && r2.changes === 1, `seed should insert 2 rows, got r1=${r1.changes} r2=${r2.changes}`);
      } finally {
        seedDb.close();
      }

      // POST new tip same baseMatchId, DIFFERENT pair (pra evitar recent_loss_same_pair)
      const r = await httpJson(portS, 'POST', '/record-tip?sport=dota2', {
        matchId: baseMatchId + '_map3',
        eventName: 'Stop Loss Test League',
        p1: 'NewTeamA',
        p2: 'NewTeamB',
        tipParticipant: 'NewTeamA',
        odds: 1.85,
        ev: 8.5,
      }, { 'x-admin-key': 'test' });
      t.assert(r.status === 200, `expected 200 (skipped), got ${r.status} body=${JSON.stringify(r.body)}`);
      t.assert(r.body.skipped === true, `expected skipped=true, got ${JSON.stringify(r.body)}`);
      t.assert(r.body.reason === 'match_stop_loss', `expected reason=match_stop_loss, got ${r.body.reason}`);
      t.assert(r.body.units_lost >= 2.0, `expected units_lost >= 2.0, got ${r.body.units_lost}`);
      t.assert(r.body.threshold === 2, `expected threshold=2, got ${r.body.threshold}`);
    } finally {
      try { procS.kill(); } catch (_) {}
      try { fs.unlinkSync(tmpDbS); } catch (_) {}
      try { fs.unlinkSync(tmpDbS + '-shm'); } catch (_) {}
      try { fs.unlinkSync(tmpDbS + '-wal'); } catch (_) {}
    }
  });
};

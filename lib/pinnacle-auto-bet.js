'use strict';

/**
 * lib/pinnacle-auto-bet.js — automatização de apostas na Pinnacle.
 *
 * ⚠️ FINANCEIRO — DEFAULT SAFETY MAXIMUM:
 *   - PINNACLE_AUTO_BET_ENABLED=false  (MASTER KILL SWITCH, default OFF)
 *   - PINNACLE_AUTO_BET_DRY=true       (DRY RUN default — log payload, no real bet)
 *   - PINNACLE_AUTO_BET_REQUIRE_CONFIRM=true  (Telegram approval before fire)
 *   - PINNACLE_MAX_STAKE_BRL=20        (cap per bet)
 *   - PINNACLE_DAILY_CAP_BRL=100       (cap diário cross-bets)
 *   - PINNACLE_HOURLY_CAP_COUNT=3      (max 3 bets/hora)
 *   - PINNACLE_MIN_EV_PCT=5            (rejeita auto-bet com EV<5%)
 *
 * Architecture (Phase 1 — scaffold):
 *   - Dry-run mode default: gera payload, valida limites, retorna {dry:true, would_bet:{...}}
 *   - Não executa Playwright/HTTP até user explicit enable via env + remove DRY
 *   - Hooks de safety: rate limit, stake cap, EV min, kill switch
 *   - DB tracking: tips.pinnacle_bet_id, tips.pinnacle_bet_status, tips.pinnacle_actual_odd
 *
 * Phase 2 (próxima sessão):
 *   - Playwright integration (browser_use OR similar)
 *   - Pinnacle login flow + session cookies
 *   - Bet placement: navigate to event, select market, input stake, confirm
 *   - Receipt parsing (ticket_id, actual_odd, stake confirmed)
 *
 * Phase 3:
 *   - Reconciliation cron: query Pinnacle "bets history" → cruza com tips.pinnacle_bet_id
 *   - Auto-settle quando Pinnacle marca bet won/lost (vs nosso settle path)
 *
 * Caller pattern:
 *   const { tryAutoBet } = require('./pinnacle-auto-bet');
 *   const r = await tryAutoBet(db, { tip, eventId, marketId, side, line, stakeBrl, expectedOdd });
 *   // r = { ok, dry, would_bet?, ticket_id?, reason? }
 */

const { log } = require('./utils');

// In-memory rate limit tracking (cross-restart reset OK — daily cap reseta via DB query)
const _hourlyBetTs = []; // epoch ms
function _hourlyCount() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (_hourlyBetTs.length && _hourlyBetTs[0] < cutoff) _hourlyBetTs.shift();
  return _hourlyBetTs.length;
}

function _dailyCount(db) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(stake_reais), 0) AS sumR
      FROM tips
      WHERE pinnacle_bet_id IS NOT NULL
        AND date(sent_at) = ?
    `).get(today);
    return { count: r?.n || 0, totalBrl: r?.sumR || 0 };
  } catch (_) {
    return { count: 0, totalBrl: 0 };
  }
}

/**
 * @param {Database} db
 * @param {object} opts — { tip, eventId, marketId, side, line, stakeBrl, expectedOdd, evPct, sport, league }
 * @returns {Promise<{ok, dry, reason?, would_bet?, ticket_id?, actual_odd?}>}
 */
async function tryAutoBet(db, opts = {}) {
  const { tip, eventId, marketId, side, line, stakeBrl, expectedOdd, evPct, sport, league } = opts;

  // ── Gate 0: master kill switch (MUST explicitly enable)
  if (!/^(1|true|yes)$/i.test(String(process.env.PINNACLE_AUTO_BET_ENABLED ?? ''))) {
    return { ok: false, dry: true, reason: 'PINNACLE_AUTO_BET_ENABLED=false (master kill switch)' };
  }

  // ── Gate 1: dry-run default
  const isDry = !/^(0|false|no)$/i.test(String(process.env.PINNACLE_AUTO_BET_DRY ?? 'true'));

  // ── Gate 2: stake cap per-bet
  const maxStake = parseFloat(process.env.PINNACLE_MAX_STAKE_BRL || '20');
  if (!Number.isFinite(stakeBrl) || stakeBrl <= 0) {
    return { ok: false, dry: isDry, reason: 'invalid_stake' };
  }
  if (stakeBrl > maxStake) {
    return { ok: false, dry: isDry, reason: `stake R$${stakeBrl.toFixed(2)} > max R$${maxStake.toFixed(2)}` };
  }

  // ── Gate 3: min EV (não auto-bet em edge fraco)
  const minEv = parseFloat(process.env.PINNACLE_MIN_EV_PCT || '5');
  if (Number.isFinite(evPct) && evPct < minEv) {
    return { ok: false, dry: isDry, reason: `EV ${evPct.toFixed(1)}% < ${minEv}% min auto-bet` };
  }

  // ── Gate 4: rate limit per-hora
  const hourlyCap = parseInt(process.env.PINNACLE_HOURLY_CAP_COUNT || '3', 10);
  const hcnt = _hourlyCount();
  if (hcnt >= hourlyCap) {
    return { ok: false, dry: isDry, reason: `hourly cap ${hcnt}/${hourlyCap} atingido` };
  }

  // ── Gate 5: daily cap (count + valor)
  const dailyCapCnt = parseInt(process.env.PINNACLE_DAILY_CAP_COUNT || '10', 10);
  const dailyCapBrl = parseFloat(process.env.PINNACLE_DAILY_CAP_BRL || '100');
  const dCnt = _dailyCount(db);
  if (dCnt.count >= dailyCapCnt) {
    return { ok: false, dry: isDry, reason: `daily cap count ${dCnt.count}/${dailyCapCnt} atingido` };
  }
  if (dCnt.totalBrl + stakeBrl > dailyCapBrl) {
    return { ok: false, dry: isDry, reason: `daily cap R$ ${dCnt.totalBrl.toFixed(2)}+${stakeBrl.toFixed(2)} > R$${dailyCapBrl.toFixed(2)}` };
  }

  // ── Gate 6: confirmation flow (DM admin → user confirms via Telegram)
  // Phase 1: log "would_bet" — confirmation flow é Phase 2 quando Playwright integrado.
  // Por agora apenas log e retorna dry payload.
  const requireConfirm = !/^(0|false|no)$/i.test(String(process.env.PINNACLE_AUTO_BET_REQUIRE_CONFIRM ?? 'true'));

  const payload = {
    tip_id: tip?.id ?? null,
    sport, league,
    event_id: eventId,
    market_id: marketId,
    side, line,
    stake_brl: stakeBrl,
    expected_odd: expectedOdd,
    ev_pct: evPct,
    requested_at: new Date().toISOString(),
    require_confirm: requireConfirm,
  };

  // ── Phase 1: DRY-RUN — log + skip
  if (isDry) {
    log('INFO', 'PINNACLE-AUTO-BET', `DRY: would bet ${stakeBrl.toFixed(2)} BRL @ ${expectedOdd} on ${sport}/${marketId}/${side} | EV ${evPct?.toFixed(1)}% | event=${eventId}`);
    try { require('./metrics').incr('pinnacle_auto_bet_dry', { sport, market: marketId }); } catch (_) {}
    return { ok: true, dry: true, would_bet: payload, reason: 'dry_run_default' };
  }

  // ── Phase 2: REAL EXECUTION via external executor service
  // Architecture: bot fires HTTP POST → executor service (Playwright/Pinnacle API)
  // → returns ticket. Decouples bot logic from execution mechanism. User implementa
  // executor em separate Railway worker (mirror agregador-odds pattern).
  //
  // Executor contract:
  //   POST {PINNACLE_EXECUTOR_URL}/place-bet
  //   Body: { event_id, market_id, side, line, stake_brl, expected_odd, max_slippage_pct, sport, league }
  //   Headers: { 'Content-Type': 'application/json', 'x-executor-token': <PINNACLE_EXECUTOR_TOKEN> }
  //   Response 200: { ok: true, ticket_id, actual_odd, stake_brl, status }
  //   Response 4xx/5xx: { ok: false, error, retryable? }
  const executorUrl = (process.env.PINNACLE_EXECUTOR_URL || '').trim().replace(/\/+$/, '');
  if (!executorUrl) {
    log('ERROR', 'PINNACLE-AUTO-BET', `REAL bet attempted mas PINNACLE_EXECUTOR_URL não configurado. Setar URL OR voltar DRY=true. Payload: ${JSON.stringify(payload)}`);
    try { require('./metrics').incr('pinnacle_auto_bet_no_executor', { sport }); } catch (_) {}
    return { ok: false, dry: false, reason: 'executor_url_not_configured' };
  }

  const maxSlippagePct = parseFloat(process.env.PINNACLE_MAX_SLIPPAGE_PCT || '2');
  const executorToken = process.env.PINNACLE_EXECUTOR_TOKEN || '';
  const executorPayload = {
    event_id: eventId,
    market_id: marketId,
    side, line,
    stake_brl: stakeBrl,
    expected_odd: expectedOdd,
    max_slippage_pct: maxSlippagePct,
    sport, league,
    tip_id: tip?.id ?? null,
  };

  try {
    const r = await _httpPostJson(executorUrl + '/place-bet', executorPayload, executorToken);
    if (!r || r.status !== 200) {
      log('ERROR', 'PINNACLE-AUTO-BET', `executor HTTP ${r?.status || 0}: ${(r?.body || '').slice(0, 200)}`);
      try { require('./metrics').incr('pinnacle_auto_bet_executor_fail', { sport, status: String(r?.status || 0) }); } catch (_) {}
      return { ok: false, dry: false, reason: `executor_http_${r?.status || 0}`, err: r?.err };
    }
    const body = r.json || {};
    if (!body.ok) {
      log('ERROR', 'PINNACLE-AUTO-BET', `executor returned ok=false: ${body.error || 'unknown'}`);
      try { require('./metrics').incr('pinnacle_auto_bet_executor_reject', { sport }); } catch (_) {}
      return { ok: false, dry: false, reason: `executor_reject: ${body.error || 'unknown'}` };
    }
    // SUCCESS — registrar no DB
    if (tip?.id) {
      markBetExecuted(db, tip.id, {
        ticket_id: body.ticket_id,
        actual_odd: body.actual_odd,
        status: body.status || 'placed',
      });
    }
    log('INFO', 'PINNACLE-AUTO-BET', `REAL bet placed: tip#${tip?.id || '?'} ticket=${body.ticket_id} odd=${body.actual_odd} stake=R$${stakeBrl.toFixed(2)} ${sport}/${marketId}/${side}`);
    try { require('./metrics').incr('pinnacle_auto_bet_placed', { sport, market: marketId }); } catch (_) {}
    return {
      ok: true,
      dry: false,
      ticket_id: body.ticket_id,
      actual_odd: body.actual_odd,
      stake_brl: body.stake_brl || stakeBrl,
      status: body.status || 'placed',
    };
  } catch (e) {
    log('ERROR', 'PINNACLE-AUTO-BET', `executor exception: ${e.message}`);
    try { require('./metrics').incr('pinnacle_auto_bet_executor_err', { sport }); } catch (_) {}
    return { ok: false, dry: false, reason: `executor_exception: ${e.message}` };
  }
}

/**
 * HTTP POST JSON pra executor. Suporta self-signed certs (Railway worker domain).
 * Timeout 30s pra cobrir bet placement (Playwright/API latency).
 */
function _httpPostJson(url, payload, executorToken) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const data = JSON.stringify(payload);
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? require('https') : require('http');
      const req = lib.request({
        host: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method: 'POST',
        timeout: 30000,
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(executorToken ? { 'x-executor-token': executorToken } : {}),
        },
      }, (r) => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch (_) {}
          resolve({ status: r.statusCode, body, json });
        });
      });
      req.on('error', e => resolve({ status: 0, err: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
      req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, err: e.message });
    }
  });
}

/**
 * Marca uma tip como aposta executada (chamado por Phase 2 Playwright path
 * OR manual via /admin/pinnacle-bet-confirm endpoint).
 *
 * @param {Database} db
 * @param {number} tipId
 * @param {object} betInfo — { ticket_id, actual_odd, stake_confirmed_brl, status }
 */
function markBetExecuted(db, tipId, betInfo = {}) {
  try {
    const cols = db.prepare(`PRAGMA table_info(tips)`).all().map(c => c.name);
    if (!cols.includes('pinnacle_bet_id')) return false;
    db.prepare(`
      UPDATE tips
      SET pinnacle_bet_id = ?,
          pinnacle_bet_status = ?,
          pinnacle_actual_odd = ?,
          pinnacle_bet_at = ?
      WHERE id = ?
    `).run(
      String(betInfo.ticket_id || ''),
      String(betInfo.status || 'placed'),
      Number.isFinite(betInfo.actual_odd) ? betInfo.actual_odd : null,
      new Date().toISOString(),
      tipId
    );
    _hourlyBetTs.push(Date.now());
    log('INFO', 'PINNACLE-AUTO-BET', `tip#${tipId} bet executed: ticket=${betInfo.ticket_id} odd=${betInfo.actual_odd}`);
    return true;
  } catch (e) {
    log('WARN', 'PINNACLE-AUTO-BET', `markBetExecuted tip#${tipId}: ${e.message}`);
    return false;
  }
}

/**
 * Helper consolidado pra wire cross-sport — 1-liner em cada dispatch path.
 * Faz fire-and-forget IIFE internamente. Lê stake_reais do DB (já gravado por
 * /record-tip server-side). Não bloqueia tip flow em caso de erro.
 *
 * @param {Database} db
 * @param {object} opts — { tipId, eventId, marketId, side, line, expectedOdd, evPct, sport, league }
 */
function fireAutoBetHook(db, opts = {}) {
  if (!opts.tipId) return;
  // Fire-and-forget IIFE
  (async () => {
    try {
      let tipRow;
      try {
        tipRow = db.prepare(`SELECT id, stake_reais, is_shadow, is_live, archived FROM tips WHERE id = ?`).get(opts.tipId);
      } catch (_) { /* DB error not blocking */ }
      // 2026-05-21: APENAS tips REAIS auto-bet (NÃO shadow, NÃO live).
      // - shadow tip = research universe (P2 principle)
      // - live tip = odds movem rápido, latency Playwright torna slippage frequente
      // Pré-match only nesta fase. Live wire em Phase 4 (após validação real prematch).
      if (!tipRow) return;
      if (tipRow.is_shadow === 1) return;
      if (tipRow.archived === 1) return;
      if (tipRow.is_live === 1) return; // pré-match only (live em phase futura)
      const stakeBrl = parseFloat(tipRow.stake_reais) || 0;
      if (stakeBrl <= 0) return;
      await tryAutoBet(db, {
        tip: { id: opts.tipId },
        eventId: opts.eventId,
        marketId: opts.marketId || 'ML',
        side: opts.side,
        line: opts.line ?? null,
        stakeBrl,
        expectedOdd: opts.expectedOdd,
        evPct: opts.evPct,
        sport: opts.sport,
        league: opts.league,
      });
    } catch (_) { /* hook não bloqueia tip flow */ }
  })();
}

module.exports = {
  tryAutoBet,
  markBetExecuted,
  fireAutoBetHook,
};

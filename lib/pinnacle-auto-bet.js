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

  // ── Phase 2: NOT IMPLEMENTED — explicit error pra prevenir accidental real bet
  // Quando Playwright/API integration estiver pronta:
  //   1. Browser launch (headless: false debug / headless: true prod)
  //   2. Login pinnacle.com via PINNACLE_USERNAME + PINNACLE_PASSWORD env
  //   3. Navigate event → market → input stake → click confirm
  //   4. Parse receipt → ticket_id + actual_odd
  //   5. Update DB tips.pinnacle_bet_id + pinnacle_actual_odd
  log('ERROR', 'PINNACLE-AUTO-BET', `ATTEMPT REAL BET BLOCKED: implementation not ready. Set PINNACLE_AUTO_BET_DRY=true. Payload: ${JSON.stringify(payload)}`);
  try { require('./metrics').incr('pinnacle_auto_bet_real_attempt_blocked', { sport }); } catch (_) {}
  return { ok: false, dry: false, reason: 'real_bet_not_implemented_phase2' };
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

module.exports = {
  tryAutoBet,
  markBetExecuted,
};

'use strict';

/**
 * velocity-tracker.js
 *
 * Detecta movimento RÁPIDO de odd Pinnacle (= sharp money entrando).
 * Diferente de stale-line:
 *   - Stale: Pinnacle moveu, outra casa NÃO → aposta na casa atrasada
 *   - Velocity: Pinnacle move >X% em <Y min → aposta no LADO QUE CAIU
 *     em qualquer book (incluindo Pinnacle) ANTES do consenso chegar lá
 *
 * Lógica:
 *   - Reusa ring buffer do stale-line-detector (pin odd history)
 *   - Calcula velocity = (odd_now / odd_5min_ago - 1) * 100
 *   - Quando |velocity| > VELOCITY_THRESHOLD_PCT em VELOCITY_WINDOW_MIN
 *     → sharp move detectado
 *   - Direção: se odd CAIU, lado virou favorito (sharp money entrou nele)
 *
 * Stale + Super + Velocity formam stack complementar:
 *   - Stale = casa não acompanhou (timing-based)
 *   - Super = casa diverge muito (state-based)
 *   - Velocity = Pinnacle se move rápido (momentum-based, mais cedo)
 *
 * Env:
 *   VELOCITY_DISABLED=true → desliga
 *   VELOCITY_THRESHOLD_PCT (default 3) — magnitude mínima do movimento
 *   VELOCITY_WINDOW_MIN (default 5)    — janela em minutos pra calcular
 */

const _lastDmAt = new Map();

// 2026-05-06 FIX: TTL eviction. Map crescia monotônico (entry per match),
// nunca limpava. Cooldown DM 1h então entries >1h podem ser dropadas.
const _DM_TTL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of _lastDmAt) if ((now - ts) > _DM_TTL_MS) _lastDmAt.delete(k);
}, 60 * 60 * 1000).unref();

function _normMatch(team1, team2) {
  return [team1, team2].map(s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')).sort().join('-');
}

/**
 * Recebe ring buffer compartilhado do stale-line e calcula velocity.
 * @param {Map} ringBuf — _ringBuf de stale-line-detector (key: sport|matchKey|side, val: [{ts, odd}])
 * @param {object} args { sport, team1, team2, side }
 * @returns evento ou null
 */
function checkVelocity(ringBuf, args) {
  if (/^(1|true|yes)$/i.test(String(process.env.VELOCITY_DISABLED || ''))) return null;
  const { sport, team1, team2, side } = args;
  const matchKey = _normMatch(team1, team2);
  const k = `${sport}|${matchKey}|${side}`;
  const buf = ringBuf.get(k);
  if (!buf || buf.length < 2) return null;

  const windowMin = parseInt(process.env.VELOCITY_WINDOW_MIN || '5', 10);
  const cutoff = Date.now() - windowMin * 60 * 1000;
  // Pega entry MAIS RECENTE depois do cutoff (=== odd há ~5min)
  const oldEntries = buf.filter(e => e.ts <= cutoff);
  if (!oldEntries.length) return null;
  const oldOdd = oldEntries[oldEntries.length - 1].odd;
  const newOdd = buf[buf.length - 1].odd;
  if (!Number.isFinite(oldOdd) || !Number.isFinite(newOdd) || oldOdd <= 1 || newOdd <= 1) return null;

  const velocityPct = (newOdd / oldOdd - 1) * 100;
  const threshold = parseFloat(process.env.VELOCITY_THRESHOLD_PCT || '3');
  if (Math.abs(velocityPct) < threshold) return null;

  return {
    sport, matchKey, matchLabel: `${team1} vs ${team2}`,
    side,
    oldOdd: +oldOdd.toFixed(3),
    newOdd: +newOdd.toFixed(3),
    velocityPct: +velocityPct.toFixed(2),
    windowMin,
    direction: velocityPct < 0 ? 'down' : 'up', // down = lado virou favorito
  };
}

// Dedup DM: cooldown 1h por (sport, matchKey) — IGNORA side de propósito.
// Sharp move Flamengo↑ é o mesmo evento que Vasco↓ no match Flamengo×Vasco
// (descoberto 2026-04-26: usuário recebeu 2 SHARP MOVE no mesmo minuto, lados
// opostos do mesmo jogo). Side fica no payload do evento mas não na dedup key.
// Backstop DB cross-restart via velocity_events.
function shouldDm(sport, matchKey, side, cooldownMs = 60 * 60 * 1000, db = null) {
  const k = `${sport}|${matchKey}`; // sem side
  const last = _lastDmAt.get(k) || 0;
  if (Date.now() - last < cooldownMs) return false;
  if (db) {
    try {
      const cutoffSec = Math.ceil(cooldownMs / 1000);
      const row = db.prepare(`
        SELECT detected_at FROM velocity_events
        WHERE sport = ? AND match_label = ?
          AND detected_at >= datetime('now', '-${cutoffSec} seconds')
        ORDER BY detected_at DESC LIMIT 1
      `).get(sport, matchKey);
      if (row) {
        _lastDmAt.set(k, Date.now());
        return false;
      }
    } catch (_) {}
  }
  _lastDmAt.set(k, Date.now());
  return true;
}

function persistEvent(db, evt) {
  if (!db || !evt) return;
  try {
    db.prepare(`
      INSERT INTO velocity_events
        (sport, match_label, pick_side, old_odd, new_odd, velocity_pct, window_min, direction)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(evt.sport, evt.matchLabel, evt.side, evt.oldOdd, evt.newOdd, evt.velocityPct, evt.windowMin, evt.direction);
  } catch (_) {}
}

function getRecentEvents(db, opts = {}) {
  if (!db) return [];
  const hours = opts.hours || 24;
  const sport = opts.sport || null;
  const conds = [`detected_at >= datetime('now', '-${hours} hours')`];
  const params = [];
  if (sport) { conds.push('sport = ?'); params.push(sport); }
  return db.prepare(`
    SELECT * FROM velocity_events
    WHERE ${conds.join(' AND ')}
    ORDER BY detected_at DESC
    LIMIT 100
  `).all(...params);
}

/**
 * Velocity cross-book — detecta book individual com movimento >threshold em janela.
 * Usado quando Pinnacle não disponível: rastreia cada book separadamente via
 * ring buffer com key `${sport}|${matchKey}|${bookSlug}|${side}`.
 *
 * @param {Map} ringBuf — buffer compartilhado (mesmo do stale-line crossbook)
 * @param {object} args { sport, team1, team2, side, books: [{bookmaker}] }
 * @returns evento ou null (com bookmaker do mover mais forte)
 */
function checkVelocityCrossBook(ringBuf, args) {
  if (/^(1|true|yes)$/i.test(String(process.env.VELOCITY_DISABLED || ''))) return null;
  const { sport, team1, team2, side, books } = args;
  if (!Array.isArray(books) || !books.length) return null;
  const matchKey = _normMatch(team1, team2);
  const windowMin = parseInt(process.env.VELOCITY_WINDOW_MIN || '5', 10);
  const cutoff = Date.now() - windowMin * 60 * 1000;
  const threshold = parseFloat(process.env.VELOCITY_THRESHOLD_PCT || '3');

  let bestMove = null;
  for (const b of books) {
    if (!b?.bookmaker) continue;
    const bookSlug = String(b.bookmaker).toLowerCase().replace(/[^a-z0-9]/g, '');
    // Stale-line modo crossbook usa key `${sport}|${matchKey}|${bookSlug}|${side}`
    const k = `${sport}|${matchKey}|${bookSlug}|${side}`;
    const buf = ringBuf.get(k);
    if (!buf || buf.length < 2) continue;
    const oldEntries = buf.filter(e => e.ts <= cutoff);
    if (!oldEntries.length) continue;
    const oldOdd = oldEntries[oldEntries.length - 1].odd;
    const newOdd = buf[buf.length - 1].odd;
    if (!Number.isFinite(oldOdd) || !Number.isFinite(newOdd) || oldOdd <= 1 || newOdd <= 1) continue;
    const velocityPct = (newOdd / oldOdd - 1) * 100;
    if (Math.abs(velocityPct) < threshold) continue;
    if (!bestMove || Math.abs(velocityPct) > Math.abs(bestMove.velocityPct)) {
      bestMove = { bookmaker: b.bookmaker, oldOdd, newOdd, velocityPct };
    }
  }
  if (!bestMove) return null;

  return {
    sport, matchKey, matchLabel: `${team1} vs ${team2}`, side,
    oldOdd: +bestMove.oldOdd.toFixed(3),
    newOdd: +bestMove.newOdd.toFixed(3),
    velocityPct: +bestMove.velocityPct.toFixed(2),
    windowMin,
    direction: bestMove.velocityPct < 0 ? 'down' : 'up',
    moverBook: bestMove.bookmaker,
    mode: 'crossbook',
  };
}

/**
 * 2026-05-12: Steam BOOST — espelho inverso do CLV pre-dispatch gate.
 *
 * Quando velocity FAVORÁVEL ao nosso side detectada (Pinnacle odd caiu nos
 * últimos N min nesse lado = sharp money entrou confirmando), boost stake.
 * Bloqueio inverso (odd subiu = sharp contra) já existe em market-tip-processor.
 *
 * Lógica:
 *   velocityPct <= -STEAM_BOOST_THRESHOLD_PCT (default -3) → boost
 *   mult = STEAM_BOOST_MULT (default 1.20) capado em STEAM_BOOST_MAX_MULT (1.50)
 *
 * Returns { mult, reason, evt } | { mult: 1.0, reason: 'no_signal' }
 *
 * Opt-out: STEAM_BOOST_DISABLED=true. Independent do gate de BLOCK (que skipa).
 */
function getSteamBoost(ringBuf, args) {
  if (/^(1|true|yes)$/i.test(String(process.env.STEAM_BOOST_DISABLED || ''))) {
    return { mult: 1.0, reason: 'disabled' };
  }
  const threshold = Math.abs(parseFloat(process.env.STEAM_BOOST_THRESHOLD_PCT || '3'));
  const baseMult = parseFloat(process.env.STEAM_BOOST_MULT || '1.20');
  const maxMult = parseFloat(process.env.STEAM_BOOST_MAX_MULT || '1.50');
  // Reusa checkVelocity mas com window específico do boost (default 10min)
  const windowPrev = process.env.VELOCITY_WINDOW_MIN;
  process.env.VELOCITY_WINDOW_MIN = process.env.STEAM_BOOST_WINDOW_MIN || '10';
  const thresholdPrev = process.env.VELOCITY_THRESHOLD_PCT;
  process.env.VELOCITY_THRESHOLD_PCT = String(threshold);
  let evt = null;
  try { evt = checkVelocity(ringBuf, args); }
  catch (_) { evt = null; }
  if (windowPrev !== undefined) process.env.VELOCITY_WINDOW_MIN = windowPrev; else delete process.env.VELOCITY_WINDOW_MIN;
  if (thresholdPrev !== undefined) process.env.VELOCITY_THRESHOLD_PCT = thresholdPrev; else delete process.env.VELOCITY_THRESHOLD_PCT;
  if (!evt) return { mult: 1.0, reason: 'no_signal' };
  // Sharp confirmou nosso side → velocityPct CAIU significativamente
  if (evt.velocityPct <= -threshold) {
    const mult = Math.min(maxMult, baseMult);
    return { mult, reason: 'sharp_confirm', evt };
  }
  // Sharp contra (já tratado em pre-dispatch block); retornamos mult=1 sem boost.
  return { mult: 1.0, reason: 'sharp_against', evt };
}

module.exports = { checkVelocity, checkVelocityCrossBook, shouldDm, persistEvent, getRecentEvents, getSteamBoost };

'use strict';

/**
 * stale-line-detector.js
 *
 * Detecta janelas onde Pinnacle moveu >threshold em N minutos mas outra casa
 * (BR ou soft EU) ainda está com odd antiga. Sinal: aposta na casa stale com
 * odd defasada antes dela ajustar (janela típica 5-15min em soft books).
 *
 * Lógica:
 *   1. Ring buffer em-memória: pra cada (sport|matchKey|side), guarda últimas
 *      N leituras Pinnacle (default 16, 1 por minuto = 15min de história).
 *   2. A cada call de checkStaleLines: pega pin atual + pin de 15min atrás.
 *   3. Se |Δ| > MIN_PIN_MOVE (default 5%) E _allOdds tem casa não-Pinnacle
 *      ainda dentro de TOL (default 2%) da odd antiga → STALE detectado.
 *   4. Lado a apostar: o que Pinnacle FAVORECEU (odd que CAIU). Casa stale
 *      ainda oferece odd alta no lado que ficou favorito.
 *   5. Persiste em stale_line_events. Cooldown DM 1h por matchKey.
 *
 * Direção do sinal:
 *   - Pinnacle moveu DOWN (odd diminuiu = lado ficou MAIS favorito):
 *     casa BR ainda alta → APOSTAR ESTE LADO (BR overpriced no fav).
 *   - Pinnacle moveu UP (odd aumentou = lado ficou MAIS underdog):
 *     casa BR ainda baixa → FADE este lado (apostar oposto onde casa BR está
 *     muito cara). Mas pra V1, alertamos só o caso simples.
 *
 * Env:
 *   STALE_LINE_DISABLED=true → desliga
 *   STALE_LINE_PIN_MOVE_PCT  → threshold Pinnacle (default 5)
 *   STALE_LINE_BR_TOL_PCT    → tol da casa stale (default 2)
 *   STALE_LINE_HISTORY_MIN   → histórico em minutos (default 15)
 */

const HISTORY_MAX = 32;
const _ringBuf = new Map(); // key=`${sport}|${matchKey}|${side}` → [{ ts, odd }]
const _lastDmAt = new Map(); // key=`${sport}|${matchKey}` → ms

function _normMatch(team1, team2) {
  return [team1, team2].map(s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')).sort().join('-');
}

function _track(sport, matchKey, side, odd, ts = Date.now()) {
  const k = `${sport}|${matchKey}|${side}`;
  const buf = _ringBuf.get(k) || [];
  buf.push({ ts, odd: Number(odd) });
  while (buf.length > HISTORY_MAX) buf.shift();
  _ringBuf.set(k, buf);
}

function _getOldOdd(sport, matchKey, side, minMinutesAgo = 15) {
  const k = `${sport}|${matchKey}|${side}`;
  const buf = _ringBuf.get(k);
  if (!buf || buf.length < 2) return null;
  const cutoff = Date.now() - minMinutesAgo * 60 * 1000;
  // Pega entry mais antiga depois do cutoff (mais próximo de 15min atrás)
  const candidates = buf.filter(e => e.ts <= cutoff);
  if (!candidates.length) return null;
  return candidates[candidates.length - 1].odd; // mais recente dentro do bucket "antigo"
}

/**
 * Processa um match-side, atualiza ring + retorna evento stale se detectado.
 * @param {object} args { sport, team1, team2, side, pinOdd, brBooks: [{bookmaker, odd}] }
 * @returns {object|null} { stale: true, ... } ou null
 */
function checkStaleLines(args) {
  if (/^(1|true|yes)$/i.test(String(process.env.STALE_LINE_DISABLED || ''))) return null;
  const { sport, team1, team2, side, pinOdd, brBooks } = args;
  const matchKey = _normMatch(team1, team2);
  const pinNum = parseFloat(pinOdd);
  if (!Number.isFinite(pinNum) || pinNum <= 1) return null;

  // Track
  _track(sport, matchKey, side, pinNum);

  // Get old odd
  const histMin = parseInt(process.env.STALE_LINE_HISTORY_MIN || '15', 10) || 15;
  const pinOld = _getOldOdd(sport, matchKey, side, histMin);
  if (pinOld == null) return null;

  // Move check
  const pinDeltaPct = (pinNum / pinOld - 1) * 100;
  const minMove = parseFloat(process.env.STALE_LINE_PIN_MOVE_PCT || '5');
  if (Math.abs(pinDeltaPct) < minMove) return null;

  // Find stale BR book: ainda dentro de tol da odd antiga
  if (!Array.isArray(brBooks) || !brBooks.length) return null;
  const brTol = parseFloat(process.env.STALE_LINE_BR_TOL_PCT || '2');
  let stale = null;
  for (const b of brBooks) {
    if (!b?.bookmaker || /pinnacle/i.test(b.bookmaker)) continue;
    const brOdd = parseFloat(b.odd);
    if (!Number.isFinite(brOdd) || brOdd <= 1) continue;
    const brVsOldPct = Math.abs((brOdd / pinOld - 1) * 100);
    if (brVsOldPct <= brTol) {
      // BR ainda alinhada com odd antiga → stale
      const brVsNewPct = (brOdd / pinNum - 1) * 100;
      stale = {
        bookmaker: b.bookmaker,
        odd: brOdd,
        brVsNewPct: +brVsNewPct.toFixed(2),
      };
      break;
    }
  }

  if (!stale) return null;

  return {
    stale: true,
    sport, matchKey,
    matchLabel: `${team1} vs ${team2}`,
    side,
    pinOld: +pinOld.toFixed(3),
    pinNew: +pinNum.toFixed(3),
    pinDeltaPct: +pinDeltaPct.toFixed(2),
    brBook: stale.bookmaker,
    brOdd: +stale.odd.toFixed(3),
    brImpliedDeltaPct: stale.brVsNewPct,
  };
}

function shouldDm(sport, matchKey, cooldownMs = 60 * 60 * 1000) {
  const k = `${sport}|${matchKey}`;
  const last = _lastDmAt.get(k) || 0;
  if (Date.now() - last < cooldownMs) return false;
  _lastDmAt.set(k, Date.now());
  return true;
}

function persistEvent(db, evt) {
  if (!db || !evt) return;
  try {
    db.prepare(`
      INSERT INTO stale_line_events
        (sport, match_label, pick_side, pin_old, pin_new, pin_delta_pct, br_book, br_odd, br_implied_delta_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(evt.sport, evt.matchLabel, evt.side, evt.pinOld, evt.pinNew, evt.pinDeltaPct, evt.brBook, evt.brOdd, evt.brImpliedDeltaPct);
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
    SELECT * FROM stale_line_events
    WHERE ${conds.join(' AND ')}
    ORDER BY detected_at DESC
    LIMIT 100
  `).all(...params);
}

module.exports = { checkStaleLines, shouldDm, persistEvent, getRecentEvents, _track, _getOldOdd, _ringBuf };

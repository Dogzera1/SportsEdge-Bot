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

// 2026-05-06 FIX: TTL eviction. Antes Maps cresciam monotônico (~14k chaves
// × 32 entries em 7d = 100-300MB/semana silencioso). Sweep horário remove
// entries cujo último update >24h atrás (history útil já passou).
const _TTL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let removedRing = 0, removedDm = 0;
  for (const [k, buf] of _ringBuf) {
    const last = buf[buf.length - 1];
    if (!last || (now - last.ts) > _TTL_MS) { _ringBuf.delete(k); removedRing++; }
  }
  for (const [k, ts] of _lastDmAt) {
    if ((now - ts) > _TTL_MS) { _lastDmAt.delete(k); removedDm++; }
  }
  if (removedRing || removedDm) {
    try { require('./metrics').incr('detector_sweep', { detector: 'stale_line', kind: 'evicted' }); } catch (_) {}
  }
}, 60 * 60 * 1000).unref();

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
 *
 * Aceita 2 modos:
 *   1. Pinnacle anchor (legacy): { sport, team1, team2, side, pinOdd, brBooks }
 *      Compara Pinnacle move vs casa BR estática.
 *   2. Cross-book (sem Pinnacle): { sport, team1, team2, side, books: [{bookmaker, odd}] }
 *      Track per-book em ring buffer. Se ≥1 book moveu >threshold mas outro
 *      ficou estagnado, marca este book stale (oferece odd defasada).
 *
 * @returns {object|null} { stale: true, ... } ou null
 */
function checkStaleLines(args) {
  if (/^(1|true|yes)$/i.test(String(process.env.STALE_LINE_DISABLED || ''))) return null;
  const { sport, team1, team2, side, pinOdd, brBooks, books } = args;
  const matchKey = _normMatch(team1, team2);
  const histMin = parseInt(process.env.STALE_LINE_HISTORY_MIN || '15', 10) || 15;
  const minMove = parseFloat(process.env.STALE_LINE_PIN_MOVE_PCT || '5');
  const brTol = parseFloat(process.env.STALE_LINE_BR_TOL_PCT || '2');

  // Modo 1: Pinnacle anchor (legacy)
  const pinNum = parseFloat(pinOdd);
  if (Number.isFinite(pinNum) && pinNum > 1) {
    _track(sport, matchKey, side, pinNum);
    const pinOld = _getOldOdd(sport, matchKey, side, histMin);
    if (pinOld == null) return null;
    const pinDeltaPct = (pinNum / pinOld - 1) * 100;
    if (Math.abs(pinDeltaPct) < minMove) return null;
    if (!Array.isArray(brBooks) || !brBooks.length) return null;
    let stale = null;
    for (const b of brBooks) {
      if (!b?.bookmaker || /pinnacle/i.test(b.bookmaker)) continue;
      const brOdd = parseFloat(b.odd);
      if (!Number.isFinite(brOdd) || brOdd <= 1) continue;
      const brVsOldPct = Math.abs((brOdd / pinOld - 1) * 100);
      if (brVsOldPct <= brTol) {
        const brVsNewPct = (brOdd / pinNum - 1) * 100;
        stale = { bookmaker: b.bookmaker, odd: brOdd, brVsNewPct: +brVsNewPct.toFixed(2) };
        break;
      }
    }
    if (!stale) return null;
    return {
      stale: true, mode: 'pinnacle',
      sport, matchKey, matchLabel: `${team1} vs ${team2}`, side,
      pinOld: +pinOld.toFixed(3), pinNew: +pinNum.toFixed(3),
      pinDeltaPct: +pinDeltaPct.toFixed(2),
      brBook: stale.bookmaker, brOdd: +stale.odd.toFixed(3),
      brImpliedDeltaPct: stale.brVsNewPct,
    };
  }

  // Modo 2: Cross-book sem Pinnacle
  if (!Array.isArray(books) || books.length < 2) return null;
  const valid = books
    .filter(b => b?.bookmaker && Number.isFinite(parseFloat(b.odd)) && parseFloat(b.odd) > 1)
    .map(b => ({ bookmaker: b.bookmaker, odd: parseFloat(b.odd) }));
  if (valid.length < 2) return null;

  // Track each book separately (key inclui bookmaker)
  for (const b of valid) {
    const bookKey = `${matchKey}|${b.bookmaker.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    _track(sport, bookKey, side, b.odd);
  }

  // Pra cada book, calcula Δ% vs sua própria odd antiga
  const moves = [];
  for (const b of valid) {
    const bookKey = `${matchKey}|${b.bookmaker.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const oldOdd = _getOldOdd(sport, bookKey, side, histMin);
    if (oldOdd == null) continue;
    const deltaPct = (b.odd / oldOdd - 1) * 100;
    moves.push({ bookmaker: b.bookmaker, odd: b.odd, oldOdd, deltaPct });
  }
  if (moves.length < 2) return null;

  // Encontra book com max move (mercado moveu) E book stale (ficou parado)
  const movers = moves.filter(m => Math.abs(m.deltaPct) >= minMove);
  if (!movers.length) return null;
  const stales = moves.filter(m => Math.abs(m.deltaPct) <= brTol);
  if (!stales.length) return null;

  // Best stale: maior move dos movers vs book mais estagnado
  const topMover = movers.reduce((a, b) => Math.abs(b.deltaPct) > Math.abs(a.deltaPct) ? b : a);
  const stale = stales[0];

  // Stale só faz sentido se mover e stale têm direção esperada (mover indica mercado novo, stale = book antigo)
  // brVsNewPct = stale.odd / topMover.odd - 1 (quanto stale ainda paga acima do "novo preço")
  const brVsNewPct = (stale.odd / topMover.odd - 1) * 100;

  return {
    stale: true, mode: 'crossbook',
    sport, matchKey, matchLabel: `${team1} vs ${team2}`, side,
    pinOld: +topMover.oldOdd.toFixed(3),
    pinNew: +topMover.odd.toFixed(3),
    pinDeltaPct: +topMover.deltaPct.toFixed(2),
    moverBook: topMover.bookmaker,
    brBook: stale.bookmaker,
    brOdd: +stale.odd.toFixed(3),
    brImpliedDeltaPct: +brVsNewPct.toFixed(2),
    sampleSize: moves.length,
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

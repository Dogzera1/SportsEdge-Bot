'use strict';

/**
 * arb-detector.js
 *
 * Detecta arbitragem entre 2+ books no _allOdds. Lógica:
 *   2-way (esports t1/t2):  1/best_t1 + 1/best_t2 < 1
 *   3-way (football h/d/a): 1/best_h + 1/best_d + 1/best_a < 1
 * Books precisam ser DIFERENTES pra cada lado (cross-book).
 *
 * Output: arb_pct = (1 - sum_implied) × 100. Tip-friendly: "arb 1.2%"
 * significa apostar proporcional dá 1.2% lucro garantido vs total stake.
 *
 * Stake calc (2-way):
 *   stake_A / stake_B = (1/odd_A) / (1/odd_B) = odd_B / odd_A
 *   Total stake = 100 (ex). Pega proporcional.
 *
 * Env:
 *   ARB_DISABLED=true → desliga
 *   ARB_MIN_MARGIN_PCT (default 0.5)  — mínimo lucro pra alertar
 *   ARB_MIN_ODD (default 1.30)        — ignora longshots
 *   ARB_MAX_ODD (default 8.00)
 *   ARB_PREFERRED_ONLY=true           — só books em PREFERRED_BOOKMAKERS
 */

const _lastDmAt = new Map(); // key=`${sport}|${matchKey}|${marketType}` → ms

function _normMatch(team1, team2) {
  return [team1, team2].map(s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')).sort().join('-');
}
function _normBook(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function _filterPreferred(books) {
  const raw = process.env.PREFERRED_BOOKMAKERS;
  if (!raw || !/^(1|true|yes)$/i.test(String(process.env.ARB_PREFERRED_ONLY || ''))) return books;
  const allowed = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return books.filter(b => {
    const book = String(b.bookmaker || '').toLowerCase();
    return allowed.some(a => book.includes(a) || a.includes(book));
  });
}

function _bestOddPerSide(books, sideKey) {
  let best = null;
  for (const b of books) {
    const odd = parseFloat(b[sideKey]);
    if (!Number.isFinite(odd) || odd <= 1) continue;
    if (!best || odd > best.odd) best = { bookmaker: b.bookmaker, odd };
  }
  return best;
}

/**
 * Detecta 2-way arb (esports/tennis ML).
 * @param {object} args { sport, team1, team2, allOdds: [{bookmaker, t1, t2}] }
 */
function detect2WayArb(args) {
  if (/^(1|true|yes)$/i.test(String(process.env.ARB_DISABLED || ''))) return null;
  const { sport, team1, team2, allOdds } = args;
  if (!Array.isArray(allOdds) || allOdds.length < 2) return null;
  const filtered = _filterPreferred(allOdds);
  if (filtered.length < 2) return null;

  const minOdd = parseFloat(process.env.ARB_MIN_ODD || '1.30');
  const maxOdd = parseFloat(process.env.ARB_MAX_ODD || '8.00');

  const bestT1 = _bestOddPerSide(filtered, 't1');
  const bestT2 = _bestOddPerSide(filtered, 't2');
  if (!bestT1 || !bestT2) return null;
  if (_normBook(bestT1.bookmaker) === _normBook(bestT2.bookmaker)) return null; // mesmo book = sem arb
  if (bestT1.odd < minOdd || bestT2.odd < minOdd) return null;
  if (bestT1.odd > maxOdd || bestT2.odd > maxOdd) return null;

  const impliedSum = (1 / bestT1.odd) + (1 / bestT2.odd);
  if (impliedSum >= 1) return null;
  const arbPct = +((1 - impliedSum) * 100).toFixed(3);

  const minMargin = parseFloat(process.env.ARB_MIN_MARGIN_PCT || '0.5');
  if (arbPct < minMargin) return null;

  return {
    sport, matchKey: _normMatch(team1, team2), matchLabel: `${team1} vs ${team2}`,
    marketType: 'ML',
    sideA: team1, sideB: team2,
    oddA: +bestT1.odd.toFixed(3), oddB: +bestT2.odd.toFixed(3),
    bookA: bestT1.bookmaker, bookB: bestT2.bookmaker,
    impliedSum: +impliedSum.toFixed(4),
    arbPct,
  };
}

/**
 * Detecta 3-way arb (football h/d/a).
 */
function detect3WayArb(args) {
  if (/^(1|true|yes)$/i.test(String(process.env.ARB_DISABLED || ''))) return null;
  const { sport, team1, team2, allOdds } = args;
  if (!Array.isArray(allOdds) || allOdds.length < 2) return null;
  const filtered = _filterPreferred(allOdds);
  if (filtered.length < 2) return null;

  const minOdd = parseFloat(process.env.ARB_MIN_ODD || '1.30');
  const maxOdd = parseFloat(process.env.ARB_MAX_ODD || '15.00'); // 3-way longshot mais alto

  const bestH = _bestOddPerSide(filtered, 'h');
  const bestD = _bestOddPerSide(filtered, 'd');
  const bestA = _bestOddPerSide(filtered, 'a');
  if (!bestH || !bestD || !bestA) return null;
  // Não exige 3 books distintos: 2 ja vale (1 cobre 2 lados, outro o 3º)
  // Mas as 3 odds não podem ser todas do mesmo book
  const books = new Set([_normBook(bestH.bookmaker), _normBook(bestD.bookmaker), _normBook(bestA.bookmaker)]);
  if (books.size < 2) return null;
  if (bestH.odd < minOdd || bestD.odd < minOdd || bestA.odd < minOdd) return null;
  if (bestH.odd > maxOdd || bestD.odd > maxOdd || bestA.odd > maxOdd) return null;

  const impliedSum = (1 / bestH.odd) + (1 / bestD.odd) + (1 / bestA.odd);
  if (impliedSum >= 1) return null;
  const arbPct = +((1 - impliedSum) * 100).toFixed(3);

  const minMargin = parseFloat(process.env.ARB_MIN_MARGIN_PCT || '0.5');
  if (arbPct < minMargin) return null;

  return {
    sport, matchKey: _normMatch(team1, team2), matchLabel: `${team1} vs ${team2}`,
    marketType: '1X2',
    sideA: 'home', sideB: 'draw_away_combo', // pra schema; details em meta
    oddA: +bestH.odd.toFixed(3), oddB: +bestA.odd.toFixed(3), // armazena home + away (skip draw na col)
    bookA: bestH.bookmaker, bookB: bestA.bookmaker,
    // Extras pra 3-way (não no schema padrão, mas usado na DM):
    _extra: {
      bestH, bestD, bestA,
    },
    impliedSum: +impliedSum.toFixed(4),
    arbPct,
  };
}

// Dedup DM: cooldown 1h por (sport, matchKey, marketType). Memória in-process
// + opcional check em DB pra sobreviver a restart de bot (descoberto 2026-04-26:
// usuário recebeu mesma ARB 30min depois quando bot reiniciou e _lastDmAt zerou).
//
// 2026-05-03 FIX: persistEvent armazena `evt.matchLabel` ("team1 vs team2"), mas
// shouldDm consultava `match_label = matchKey` (forma normalizada — diferente).
// Backstop persistente NUNCA batia (caller passa matchKey, BD tem matchLabel) →
// 2 DMs garantidas pós-restart. Aceita matchLabel opcional + fallback pra LIKE
// matching no campo cru.
function shouldDm(sport, matchKey, marketType, cooldownMs = 60 * 60 * 1000, db = null, matchLabel = null) {
  const k = `${sport}|${matchKey}|${marketType}`;
  const last = _lastDmAt.get(k) || 0;
  if (Date.now() - last < cooldownMs) return false;
  if (db) {
    try {
      const cutoffSec = Math.ceil(cooldownMs / 1000);
      // Tenta primeiro com matchLabel exato (caller passou). Fallback: LIKE com
      // tokens do matchKey (alfanumérico) — robusto se matchLabel armazenado
      // diferir levemente do passado (ex: caller esqueceu de passar matchLabel).
      let row = null;
      if (matchLabel) {
        row = db.prepare(`
          SELECT detected_at FROM arb_events
          WHERE sport = ? AND match_label = ? AND market_type = ?
            AND detected_at >= datetime('now', '-${cutoffSec} seconds')
          ORDER BY detected_at DESC LIMIT 1
        `).get(sport, matchLabel, marketType);
      }
      if (!row) {
        // Fallback: LIKE por tokens do matchKey. matchKey já é hyphen-separated
        // alfanumérico ("team1norm-team2norm" sorted) — extrai tokens 4+ chars.
        const tokens = String(matchKey || '').split('-').filter(s => s.length >= 4);
        if (tokens.length >= 1) {
          const conds = tokens.map(() => 'lower(replace(replace(match_label, " ", ""), ".", "")) LIKE ?').join(' AND ');
          const params = [sport, marketType, ...tokens.map(t => `%${t}%`)];
          row = db.prepare(`
            SELECT detected_at FROM arb_events
            WHERE sport = ? AND market_type = ?
              AND detected_at >= datetime('now', '-${cutoffSec} seconds')
              AND ${conds}
            ORDER BY detected_at DESC LIMIT 1
          `).get(...params);
        }
      }
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
      INSERT INTO arb_events
        (sport, match_label, market_type, side_a, side_b, odd_a, odd_b, book_a, book_b, implied_sum, arb_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(evt.sport, evt.matchLabel, evt.marketType, evt.sideA, evt.sideB, evt.oddA, evt.oddB, evt.bookA, evt.bookB, evt.impliedSum, evt.arbPct);
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
    SELECT * FROM arb_events
    WHERE ${conds.join(' AND ')}
    ORDER BY detected_at DESC
    LIMIT 100
  `).all(...params);
}

/** Helper: stake split pra 2-way. Total = 100u por padrão. */
function stakeSplit2Way(oddA, oddB, total = 100) {
  const s = (1 / oddA) + (1 / oddB);
  return {
    stakeA: +(total * (1 / oddA) / s).toFixed(2),
    stakeB: +(total * (1 / oddB) / s).toFixed(2),
    payout: +(total / s).toFixed(2),
    profit: +(total / s - total).toFixed(2),
  };
}

module.exports = { detect2WayArb, detect3WayArb, shouldDm, persistEvent, getRecentEvents, stakeSplit2Way };

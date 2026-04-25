'use strict';

/**
 * bookmaker-delta.js
 *
 * Calcula delta médio (Pinnacle vs casa BR) por (sport, bookmaker) com base
 * em amostras manuais coletadas via /odd-sample. Usado pra ESTIMAR best odd
 * em casas BR sem scraping.
 *
 * delta_pct = (br_odd / pinnacle_odd - 1) * 100
 * Soft books costumam ter delta negativo em favoritos (overround maior) e
 * delta positivo em underdogs (juice menor pra atrair). Média é 0.5-2% positivo
 * em alguns casos, -1 a -3% em outros.
 *
 * API:
 *   addSample(db, sport, bookmaker, pinnacleOdd, brOdd, matchLabel?)
 *   getDeltaForSport(db, sport, bookmaker, opts?)  → null se n<minN
 *   getAllDeltas(db, opts?)
 *   estimateBrOdd(pinnacleOdd, deltaPct)
 */

const KNOWN_BR_BOOKS = ['betano', 'sportingbet', 'kto', 'novibet', 'estrelabet', 'betway', 'pixbet', 'bet365br', 'rivalo'];

function _normBook(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function _normSport(s) { return String(s || '').toLowerCase().trim(); }

function addSample(db, sport, bookmaker, pinnacleOdd, brOdd, matchLabel = null) {
  const sp = _normSport(sport);
  const bk = _normBook(bookmaker);
  const pin = parseFloat(pinnacleOdd), br = parseFloat(brOdd);
  if (!sp || !bk || !Number.isFinite(pin) || !Number.isFinite(br) || pin <= 1 || br <= 1) {
    return { ok: false, error: 'invalid_args' };
  }
  const deltaPct = +((br / pin - 1) * 100).toFixed(3);
  const r = db.prepare(`
    INSERT INTO bookmaker_delta_samples (sport, bookmaker, pinnacle_odd, br_odd, delta_pct, match_label)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sp, bk, pin, br, deltaPct, matchLabel);
  return { ok: true, id: r.lastInsertRowid, deltaPct, sport: sp, bookmaker: bk };
}

/**
 * @returns null se sample size < minN; senão { avgDelta, n, sport, bookmaker, pinnacleAvg, brAvg }
 */
function getDeltaForSport(db, sport, bookmaker, opts = {}) {
  const sp = _normSport(sport);
  const bk = _normBook(bookmaker);
  const minN = opts.minN || 10;
  const days = opts.days || 90;
  const row = db.prepare(`
    SELECT COUNT(*) AS n,
           AVG(delta_pct) AS avg_delta,
           AVG(pinnacle_odd) AS avg_pin,
           AVG(br_odd) AS avg_br,
           MIN(captured_at) AS first_at,
           MAX(captured_at) AS last_at
    FROM bookmaker_delta_samples
    WHERE sport = ? AND bookmaker = ?
      AND captured_at >= datetime('now', ?)
  `).get(sp, bk, `-${days} days`);
  if (!row || !row.n || row.n < minN) return null;
  return {
    sport: sp, bookmaker: bk,
    n: row.n,
    avgDeltaPct: +row.avg_delta.toFixed(2),
    avgPinnacle: +row.avg_pin.toFixed(2),
    avgBr: +row.avg_br.toFixed(2),
    firstAt: row.first_at, lastAt: row.last_at,
  };
}

function getAllDeltas(db, opts = {}) {
  const minN = opts.minN || 5; // mais permissivo pra display
  const days = opts.days || 90;
  const rows = db.prepare(`
    SELECT sport, bookmaker, COUNT(*) AS n,
           AVG(delta_pct) AS avg_delta,
           AVG(pinnacle_odd) AS avg_pin,
           AVG(br_odd) AS avg_br,
           MIN(captured_at) AS first_at,
           MAX(captured_at) AS last_at
    FROM bookmaker_delta_samples
    WHERE captured_at >= datetime('now', ?)
    GROUP BY sport, bookmaker
    HAVING n >= ?
    ORDER BY sport, n DESC
  `).all(`-${days} days`, minN);
  return rows.map(r => ({
    sport: r.sport,
    bookmaker: r.bookmaker,
    n: r.n,
    avgDeltaPct: +r.avg_delta.toFixed(2),
    avgPinnacle: +r.avg_pin.toFixed(2),
    avgBr: +r.avg_br.toFixed(2),
    firstAt: r.first_at, lastAt: r.last_at,
  }));
}

/** Estima brOdd a partir de pinnacleOdd + delta histórico (em %). */
function estimateBrOdd(pinnacleOdd, deltaPct) {
  const pin = parseFloat(pinnacleOdd);
  if (!Number.isFinite(pin) || pin <= 1) return null;
  const d = parseFloat(deltaPct);
  if (!Number.isFinite(d)) return pin;
  return +(pin * (1 + d / 100)).toFixed(3);
}

module.exports = {
  addSample,
  getDeltaForSport,
  getAllDeltas,
  estimateBrOdd,
  KNOWN_BR_BOOKS,
};

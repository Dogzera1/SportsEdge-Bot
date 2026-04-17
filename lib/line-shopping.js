'use strict';
// Vetor 3 — Line Shopping cross-bookmaker
// Recebe um objeto de odds (shape: { t1, t2, bookmaker, _alternative?, _allOdds? })
// e um lado de pick ('t1' | 't2'), retorna o melhor preço disponível + Pinnacle anchor.

function _normBook(s) { return String(s || '').toLowerCase(); }
function _isPinnacle(book) { return /pinnacle/i.test(String(book || '')); }

// oddsObj: shape do /odds — { t1, t2, bookmaker, _alternative?, _allOdds? }
// pickSide: 't1' | 't2'
// Retorna: { bestBook, bestOdd, pinnacleOdd, deltaPct, lift, books } ou null se inválido
function computeLineShop(oddsObj, pickSide) {
  if (!oddsObj || (pickSide !== 't1' && pickSide !== 't2')) return null;

  const primaryBook = oddsObj.bookmaker || null;
  const primaryOdd  = parseFloat(oddsObj[pickSide]);
  if (!primaryBook || !Number.isFinite(primaryOdd) || primaryOdd <= 1) return null;

  const entries = [{ book: primaryBook, odd: primaryOdd }];

  // _allOdds tem prioridade (tem todos os books); senão tenta _alternative
  if (Array.isArray(oddsObj._allOdds) && oddsObj._allOdds.length) {
    for (const c of oddsObj._allOdds) {
      if (!c?.bookmaker || _normBook(c.bookmaker) === _normBook(primaryBook)) continue;
      const o = parseFloat(c[pickSide]);
      if (Number.isFinite(o) && o > 1) entries.push({ book: c.bookmaker, odd: o });
    }
  } else if (oddsObj._alternative) {
    const alt = oddsObj._alternative;
    const o = parseFloat(alt[pickSide]);
    if (alt.bookmaker && Number.isFinite(o) && o > 1) entries.push({ book: alt.bookmaker, odd: o });
  }

  // Dedup por book (mantém odd mais alta)
  const byBook = new Map();
  for (const e of entries) {
    const key = _normBook(e.book);
    const prev = byBook.get(key);
    if (!prev || e.odd > prev.odd) byBook.set(key, e);
  }
  const unique = Array.from(byBook.values());

  const best = unique.reduce((a, b) => (b.odd > a.odd ? b : a));
  const pinEntry = unique.find(e => _isPinnacle(e.book));
  const pinnacleOdd = pinEntry ? pinEntry.odd : null;
  const deltaPct = pinnacleOdd ? ((best.odd - pinnacleOdd) / pinnacleOdd) * 100 : null;

  return {
    bestBook: best.book,
    bestOdd: Math.round(best.odd * 1000) / 1000,
    pinnacleOdd: pinnacleOdd != null ? Math.round(pinnacleOdd * 1000) / 1000 : null,
    deltaPct: deltaPct != null ? Math.round(deltaPct * 100) / 100 : null,
    books: unique.map(e => ({ book: e.book, odd: Math.round(e.odd * 1000) / 1000 })),
  };
}

// Helper: decide se vale mostrar "melhor em <book>" na DM
// Regra: delta >= MIN_DELTA_PCT E best != Pinnacle (se for Pinnacle, nada a dizer)
function shouldRecommendAltBook(lineShop, minDeltaPct = 1.5) {
  if (!lineShop || lineShop.deltaPct == null) return false;
  if (_isPinnacle(lineShop.bestBook)) return false;
  return lineShop.deltaPct >= minDeltaPct;
}

module.exports = { computeLineShop, shouldRecommendAltBook };

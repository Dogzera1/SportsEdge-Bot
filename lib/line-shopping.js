'use strict';
// Vetor 3 — Line Shopping cross-bookmaker
// Recebe um objeto de odds (shape: { t1, t2, bookmaker, _alternative?, _allOdds? })
// e um lado de pick ('t1' | 't2'), retorna o melhor preço disponível + Pinnacle anchor.

function _normBook(s) { return String(s || '').toLowerCase(); }
function _isPinnacle(book) { return /pinnacle/i.test(String(book || '')); }

// oddsObj: shape do /odds — { <pickSide>, bookmaker, _alternative?, _allOdds? }
// pickSide: qualquer key que indique lado da aposta ('t1', 't2', 'h', 'd', 'a', etc)
// Retorna: { bestBook, bestOdd, pinnacleOdd, deltaPct, lift, books } ou null se inválido
function computeLineShop(oddsObj, pickSide) {
  if (!oddsObj || !pickSide || typeof pickSide !== 'string') return null;

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

// Spread gate: bestOdd vs Pinnacle sharp anchor. Quando ratio > maxRatio, é
// forte indício de odd errada/stale no soft book (ex: SX.Bet 1.74 vs Pinnacle
// 1.083 = ratio 1.61x → emite tip com "valor" que não existe no mercado real).
// Retorna { reject, ratio, bestOdd, pinnacleOdd, bestBook } ou { reject: false }.
//
// 2026-05-03 FIX: quando pinnacleOdd ausente (football EU sem Pinnacle), antes
// retornava { reject: false } sempre — qualquer book pegava swap inverificável.
// Agora fallback usa mediana dos demais books como proxy. Threshold por mediana
// é mais leniente (1.7x default) porque mediana NÃO é sharp (vig médio agregado).
function checkBookmakerSpread(oddsObj, pickSide, maxRatio) {
  const ls = computeLineShop(oddsObj, pickSide);
  if (!ls || !ls.bestOdd) return { reject: false };
  if (_isPinnacle(ls.bestBook)) return { reject: false, ratio: 1, ...ls };
  const threshold = Number.isFinite(+maxRatio) && +maxRatio > 1 ? +maxRatio : 1.5;
  if (ls.pinnacleOdd != null) {
    const ratio = ls.bestOdd / ls.pinnacleOdd;
    return {
      reject: ratio > threshold,
      ratio: Math.round(ratio * 1000) / 1000,
      threshold,
      bestOdd: ls.bestOdd, pinnacleOdd: ls.pinnacleOdd, bestBook: ls.bestBook,
    };
  }
  // Fallback sem Pinnacle: mediana dos demais books (ignora self bestBook).
  const others = (ls.books || [])
    .filter(b => _normBook(b.book) !== _normBook(ls.bestBook))
    .map(b => b.odd)
    .filter(o => Number.isFinite(o) && o > 1)
    .sort((a, b) => a - b);
  if (others.length < 2) return { reject: false, fallback: 'no_ref', bestOdd: ls.bestOdd, bestBook: ls.bestBook };
  const median = others.length % 2 === 0
    ? (others[others.length / 2 - 1] + others[others.length / 2]) / 2
    : others[Math.floor(others.length / 2)];
  const medianRatio = ls.bestOdd / median;
  // Threshold mediano (default 1.7x): mediana já tem vig médio ~5%, então delta
  // permitido um pouco maior que sharp. Override via env LINE_SHOP_MEDIAN_RATIO.
  const medianThreshold = parseFloat(process.env.LINE_SHOP_MEDIAN_RATIO || '1.7');
  return {
    reject: medianRatio > medianThreshold,
    ratio: Math.round(medianRatio * 1000) / 1000,
    threshold: medianThreshold,
    bestOdd: ls.bestOdd, pinnacleOdd: null, bestBook: ls.bestBook,
    refMedian: Math.round(median * 1000) / 1000,
    fallback: 'median',
  };
}

// Monta linha pronta pra DM (Telegram markdown). Retorna '' se não houver info útil.
// minDeltaPct: threshold pra destacar alt book (1.5% default)
// opts.sport + opts.db: ativa append de "🇧🇷 Estimativa BR" baseado em delta
//   histórico (BR_ODD_ESTIMATE_DM env precisa true).
function formatLineShopDM(oddsObj, pickSide, minDeltaPctOrOpts, optsArg) {
  // Backwards-compatible: aceita (oddsObj, pickSide, minDeltaPct) OU (oddsObj, pickSide, opts)
  let minDeltaPct = 1.5, opts = {};
  if (typeof minDeltaPctOrOpts === 'number') {
    minDeltaPct = minDeltaPctOrOpts;
    if (optsArg && typeof optsArg === 'object') opts = optsArg;
  } else if (minDeltaPctOrOpts && typeof minDeltaPctOrOpts === 'object') {
    opts = minDeltaPctOrOpts;
    if (typeof opts.minDeltaPct === 'number') minDeltaPct = opts.minDeltaPct;
  }
  const ls = computeLineShop(oddsObj, pickSide);
  if (!ls) return '';
  let s;
  if (shouldRecommendAltBook(ls, minDeltaPct) && ls.pinnacleOdd != null) {
    s = `🏦 *Melhor: ${ls.bestBook} @ ${ls.bestOdd.toFixed(2)}* (Pinnacle @ ${ls.pinnacleOdd.toFixed(2)}, +${ls.deltaPct.toFixed(1)}%)\n`;
  } else {
    s = `🏦 Casa: *${ls.bestBook}* @ ${ls.bestOdd.toFixed(2)}\n`;
  }
  // Append BR estimate quando opts fornece sport+db E env ativa
  if (opts.sport && opts.db) {
    try { s += formatBrEstimateDM(oddsObj, pickSide, opts.sport, opts.db); } catch (_) {}
  }
  return s;
}

// Estimativas BR baseadas em delta histórico (lib/bookmaker-delta).
// Cache em memória 1h pra evitar query DB por tip. Default off — env opt-in
// via BR_ODD_ESTIMATE_DM=true (precisa db ref e n>=minN samples).
const _brDeltaCache = { byKey: new Map(), ts: 0 };
const _BR_CACHE_TTL = 60 * 60 * 1000;

function _getBrDeltas(db, sport, minN = 10) {
  if (!db) return [];
  const now = Date.now();
  if (now - _brDeltaCache.ts > _BR_CACHE_TTL) {
    _brDeltaCache.byKey.clear();
    try {
      const { getAllDeltas, KNOWN_BR_BOOKS } = require('./bookmaker-delta');
      const allDeltas = getAllDeltas(db, { days: 90, minN });
      for (const d of allDeltas) {
        if (KNOWN_BR_BOOKS.includes(d.bookmaker)) {
          const key = `${d.sport}|${d.bookmaker}`;
          _brDeltaCache.byKey.set(key, d);
        }
      }
      _brDeltaCache.ts = now;
    } catch (_) {}
  }
  const out = [];
  for (const [k, v] of _brDeltaCache.byKey) {
    if (k.startsWith(`${sport}|`) && v.n >= minN) out.push(v);
  }
  return out.sort((a, b) => b.avgDeltaPct - a.avgDeltaPct);
}

// Linha extra DM: estima best odd em casas BR conhecidas com base em delta histórico.
// Mostra TOP 2 BR books que têm n>=10 samples vs Pinnacle.
// Ex: "🇧🇷 Estimativa BR: Betano ~2.09 (Δ +2.0% n=12) | Bet365 ~2.07 (Δ +1.0% n=8)"
function formatBrEstimateDM(oddsObj, pickSide, sport, db) {
  if (!process.env.BR_ODD_ESTIMATE_DM || /^(0|false|no)$/i.test(String(process.env.BR_ODD_ESTIMATE_DM))) return '';
  const ls = computeLineShop(oddsObj, pickSide);
  if (!ls || !ls.pinnacleOdd) return '';
  const deltas = _getBrDeltas(db, sport, 10);
  if (!deltas.length) return '';
  const top = deltas.slice(0, 2);
  const parts = top.map(d => {
    const est = +(ls.pinnacleOdd * (1 + d.avgDeltaPct / 100)).toFixed(2);
    const sign = d.avgDeltaPct >= 0 ? '+' : '';
    return `${d.bookmaker} ~${est.toFixed(2)} (Δ ${sign}${d.avgDeltaPct.toFixed(1)}% n=${d.n})`;
  });
  return `🇧🇷 _Estimativa BR: ${parts.join(' · ')}_\n`;
}

module.exports = { computeLineShop, shouldRecommendAltBook, formatLineShopDM, formatBrEstimateDM, checkBookmakerSpread };

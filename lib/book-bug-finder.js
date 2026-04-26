'use strict';

/**
 * book-bug-finder.js
 *
 * Detecta bugs de pricing nas casas BR — não só outliers (super-odd já cobre)
 * mas inconsistências MATEMATICAMENTE erradas dentro do mesmo book:
 *
 *   1. Implied sum < 100% num mercado (1X2 ou OU2.5) → arb intra-book grátis
 *   2. Cross-market: BTTS vs OU2.5 — implied(BTTS sim) e implied(Over 2.5) deveriam
 *      correlacionar; quando divergem >threshold = bug ou edge
 *   3. OU monotônico violado: implied(Over 3.5) > implied(Over 2.5) é impossível
 *      (mas só temos 2.5 hoje — placeholder pro dia que scraper publicar 3.5)
 *
 * Diferente de super-odd:
 *   super-odd: book A vs OUTROS books (cross-book outlier) → promo/erro
 *   bug-finder: book A consigo MESMO (intra-book inconsistency) → bug puro
 *
 * Env:
 *   BUG_FINDER_DISABLED=true             → desliga
 *   BUG_FINDER_MIN_ARB_PCT=0.5           → ignora arb <0.5% (ruído de rounding)
 *   BUG_FINDER_BTTS_OU_DIV=0.20          → divergência BTTS↔OU pra flag (default 20pp)
 *   BUG_FINDER_DM_COOLDOWN_MIN=120       → cooldown DM por (casa,jogo,bug_type)
 */

const _lastDmAt = new Map();

function _impliedFromOdd(o) {
  const v = parseFloat(o);
  return Number.isFinite(v) && v > 1 ? 1 / v : null;
}

function _round(n, d = 4) {
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

/**
 * Detecta arb 1X2 dentro do mesmo book.
 * Retorna {bug:'arb_1x2', impliedSum, profitPct, casa, ...} ou null.
 */
function detect1x2Arb(casa, jogoId, mercados, opts = {}) {
  const m = mercados?.['1x2'] || mercados?.['1X2'];
  if (!m) return null;
  const oH = parseFloat(m['1'] ?? m.home ?? m.h);
  const oD = parseFloat(m['x'] ?? m.X ?? m.draw ?? m.d);
  const oA = parseFloat(m['2'] ?? m.away ?? m.a);
  if (![oH, oD, oA].every(v => Number.isFinite(v) && v > 1)) return null;
  const sum = (1 / oH) + (1 / oD) + (1 / oA);
  const minArb = parseFloat(opts.minArbPct ?? process.env.BUG_FINDER_MIN_ARB_PCT ?? '0.5') / 100;
  if (sum >= 1 - minArb) return null;
  const profitPct = +((1 / sum - 1) * 100).toFixed(3);
  return {
    bug: 'arb_1x2', casa, jogoId,
    odds: { h: oH, d: oD, a: oA },
    impliedSum: _round(sum, 4),
    impliedPct: _round(sum * 100, 2),
    profitPct,
  };
}

/**
 * Detecta arb OU 2.5 dentro do mesmo book (over+under implied <1).
 */
function detectOuArb(casa, jogoId, mercados, opts = {}) {
  const ou = mercados?.['over-under'] ?? mercados?.['over_under'] ?? mercados?.ou;
  if (!ou || typeof ou !== 'object') return null;
  const oOver = parseFloat(ou.over);
  const oUnder = parseFloat(ou.under);
  if (![oOver, oUnder].every(v => Number.isFinite(v) && v > 1)) return null;
  const sum = (1 / oOver) + (1 / oUnder);
  const minArb = parseFloat(opts.minArbPct ?? process.env.BUG_FINDER_MIN_ARB_PCT ?? '0.5') / 100;
  if (sum >= 1 - minArb) return null;
  const profitPct = +((1 / sum - 1) * 100).toFixed(3);
  return {
    bug: 'arb_ou25', casa, jogoId,
    odds: { over: oOver, under: oUnder },
    impliedSum: _round(sum, 4),
    impliedPct: _round(sum * 100, 2),
    profitPct,
  };
}

/**
 * Detecta arb BTTS dentro do mesmo book.
 */
function detectBttsArb(casa, jogoId, mercados, opts = {}) {
  const b = mercados?.btts;
  if (!b || typeof b !== 'object') return null;
  const oYes = parseFloat(b.sim ?? b.yes);
  const oNo = parseFloat(b.nao ?? b.no);
  if (![oYes, oNo].every(v => Number.isFinite(v) && v > 1)) return null;
  const sum = (1 / oYes) + (1 / oNo);
  const minArb = parseFloat(opts.minArbPct ?? process.env.BUG_FINDER_MIN_ARB_PCT ?? '0.5') / 100;
  if (sum >= 1 - minArb) return null;
  const profitPct = +((1 / sum - 1) * 100).toFixed(3);
  return {
    bug: 'arb_btts', casa, jogoId,
    odds: { yes: oYes, no: oNo },
    impliedSum: _round(sum, 4),
    impliedPct: _round(sum * 100, 2),
    profitPct,
  };
}

/**
 * Detecta divergência BTTS vs OU2.5 (mesmo book).
 *
 * Heurística: P(over 2.5) e P(BTTS sim) devem ser próximos em magnitude pra ligas
 * típicas — empate europeu mostra correlação ~0.85. Quando divergem em mais de
 * BUG_FINDER_BTTS_OU_DIV (default 0.20 = 20pp absolute), o book provavelmente
 * tem bug em UM dos dois mercados.
 *
 * NÃO é bug puro como arb intra-book — é heurística de inconsistência. Útil pra
 * descobrir qual mercado errar (se BTTS=80% mas Over=40%, alguma coisa tá errada).
 */
function detectBttsOuDivergence(casa, jogoId, mercados, opts = {}) {
  const ou = mercados?.['over-under'] ?? mercados?.['over_under'] ?? mercados?.ou;
  const b = mercados?.btts;
  if (!ou || !b) return null;
  const oOver = parseFloat(ou.over), oUnder = parseFloat(ou.under);
  const oYes = parseFloat(b.sim ?? b.yes), oNo = parseFloat(b.nao ?? b.no);
  if (![oOver, oUnder, oYes, oNo].every(v => Number.isFinite(v) && v > 1)) return null;
  // Devig: extrai P "verdadeira" multiplicativa
  const sumOu = (1 / oOver) + (1 / oUnder);
  const sumBtts = (1 / oYes) + (1 / oNo);
  const pOver = (1 / oOver) / sumOu;
  const pBtts = (1 / oYes) / sumBtts;
  const diff = Math.abs(pOver - pBtts);
  const threshold = parseFloat(opts.divThreshold ?? process.env.BUG_FINDER_BTTS_OU_DIV ?? '0.20');
  if (diff < threshold) return null;
  // Se BTTS muito maior que Over → BTTS odd Yes baixa demais (book errou Yes)
  // Se Over muito maior que BTTS → Over odd baixa demais (book errou Over)
  const culprit = pBtts > pOver ? 'btts_yes_too_low' : 'over_25_too_low';
  return {
    bug: 'btts_ou_divergence', casa, jogoId,
    pOverDevig: _round(pOver, 4),
    pBttsDevig: _round(pBtts, 4),
    divPp: _round(diff * 100, 2),
    odds: { over: oOver, under: oUnder, btts_yes: oYes, btts_no: oNo },
    culprit,
  };
}

/**
 * Roda todos detectores num snapshot único.
 */
function findBugsInSnapshot({ casa_slug, jogo_id, mercados }, opts = {}) {
  if (/^(1|true|yes)$/i.test(String(process.env.BUG_FINDER_DISABLED || ''))) return [];
  if (!mercados) return [];
  const bugs = [];
  const detectors = [detect1x2Arb, detectOuArb, detectBttsArb, detectBttsOuDivergence];
  for (const fn of detectors) {
    try {
      const evt = fn(casa_slug, jogo_id, mercados, opts);
      if (evt) bugs.push(evt);
    } catch (_) {}
  }
  return bugs;
}

/**
 * Cooldown DM por (casa, jogo, bug_type).
 */
function shouldDm(casa, jogoId, bugType, cooldownMs = null) {
  const cd = cooldownMs ?? (parseInt(process.env.BUG_FINDER_DM_COOLDOWN_MIN || '120', 10) * 60 * 1000);
  const k = `${casa}|${jogoId}|${bugType}`;
  const last = _lastDmAt.get(k) || 0;
  if (Date.now() - last < cd) return false;
  _lastDmAt.set(k, Date.now());
  return true;
}

/**
 * Persistir em book_bug_events (schema criado via migration).
 * Best-effort — silencia se tabela não existir.
 */
function persistEvent(db, evt) {
  if (!db || !evt) return;
  try {
    db.prepare(`
      INSERT INTO book_bug_events (casa, jogo_id, bug_type, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(evt.casa, evt.jogoId, evt.bug, JSON.stringify(evt));
  } catch (_) {}
}

function getRecentEvents(db, opts = {}) {
  if (!db) return [];
  const hours = opts.hours || 24;
  const casa = opts.casa || null;
  const conds = [`detected_at >= datetime('now', '-${hours} hours')`];
  const params = [];
  if (casa) { conds.push('casa = ?'); params.push(casa); }
  try {
    return db.prepare(`
      SELECT * FROM book_bug_events
      WHERE ${conds.join(' AND ')}
      ORDER BY detected_at DESC
      LIMIT 200
    `).all(...params);
  } catch (_) { return []; }
}

module.exports = {
  detect1x2Arb,
  detectOuArb,
  detectBttsArb,
  detectBttsOuDivergence,
  findBugsInSnapshot,
  shouldDm,
  persistEvent,
  getRecentEvents,
};

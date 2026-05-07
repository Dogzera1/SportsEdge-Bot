'use strict';

/**
 * super-odd-detector.js
 *
 * Detecta quando casa não-Pinnacle tem odd >SUPER_ODD_RATIO acima de Pinnacle.
 * Default 1.20 = 20% acima. Sinais possíveis:
 *   - Super odd promocional (Betano/Sportingbet rodam diariamente)
 *   - Erro de book (odd esquecida pós-movimentação)
 *   - Pre-news edge (info não incorporada ainda na casa soft)
 *
 * Uso: pra cada match com _allOdds (LoL, Football, etc), passa pelo detect.
 *
 * Env:
 *   SUPER_ODD_DISABLED=true → desliga
 *   SUPER_ODD_RATIO        → ratio mínimo (default 1.20)
 *   SUPER_ODD_MIN_ODD      → ignora odds baixas (default 1.50, abaixo é ruído)
 *   SUPER_ODD_MAX_ODD      → ignora longshots (default 6.00, alto risco)
 *
 * EV estimado: assume Pinnacle implied como verdade. EV = (super_odd × pinnacle_implied) - 1.
 */

const _lastDmAt = new Map(); // key=`${sport}|${matchKey}|${side}` → ms

// 2026-05-06 FIX: TTL eviction. Cooldown DM 1h então entries >6h podem sair.
const _DM_TTL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of _lastDmAt) if ((now - ts) > _DM_TTL_MS) _lastDmAt.delete(k);
}, 60 * 60 * 1000).unref();

function _normMatch(team1, team2) {
  return [team1, team2].map(s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')).sort().join('-');
}

function _median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Detecta super-odd em um lado específico.
 *
 * Aceita 2 modos:
 *   1. Pinnacle anchor (legacy):
 *      { sport, team1, team2, side, pinOdd, otherBooks: [{bookmaker, odd}] }
 *   2. Cross-book (sem Pinnacle):
 *      { sport, team1, team2, side, books: [{bookmaker, odd}] }
 *      Referência = mediana dos outros books (excluindo o que está sob análise)
 *
 * Cross-book é util quando Pinnacle não disponível (TheOddsAPI off, scraper só BR).
 *
 * @returns {object|null} evento ou null
 */
function detectSuperOdd(args) {
  if (/^(1|true|yes)$/i.test(String(process.env.SUPER_ODD_DISABLED || ''))) return null;
  const { sport, team1, team2, side, pinOdd, otherBooks, books } = args;

  const minOdd = parseFloat(process.env.SUPER_ODD_MIN_ODD || '1.50');
  const maxOdd = parseFloat(process.env.SUPER_ODD_MAX_ODD || '6.00');
  // Detect floor (default 1.13): persiste em super_odd_events e fica visível
  // em /admin/super-odd-events e /casa-stats. DM threshold é separado (DM_RATIO).
  // Refatorado 2026-04-26: KTO Brasileirão away tinha 3 eventos +11-17% acima
  // da mediana (não pegos com floor 1.20). Tier soft permite captura sem spam DM.
  const minRatio = parseFloat(process.env.SUPER_ODD_RATIO_DETECT || process.env.SUPER_ODD_RATIO || '1.13');

  // Modo 1: Pinnacle anchor
  if (Number.isFinite(parseFloat(pinOdd))) {
    const pin = parseFloat(pinOdd);
    if (pin <= 1 || pin < minOdd || pin > maxOdd) return null;
    if (!Array.isArray(otherBooks) || !otherBooks.length) return null;
    let bestSuper = null;
    for (const b of otherBooks) {
      if (!b?.bookmaker || /pinnacle/i.test(b.bookmaker)) continue;
      const odd = parseFloat(b.odd);
      if (!Number.isFinite(odd) || odd <= 1) continue;
      const ratio = odd / pin;
      if (ratio < minRatio) continue;
      if (!bestSuper || ratio > bestSuper.ratio) bestSuper = { bookmaker: b.bookmaker, odd, ratio };
    }
    if (!bestSuper) return null;
    const matchKey = _normMatch(team1, team2);
    // 2026-05-03 FIX: aplicar devig quando Pinnacle das outras pernas disponível
    // (args.pinOddsAll ou args.pinOddOpposite). Antes EV usava 1/pin (raw vig) →
    // EV inflado em ~vig (2-3% Pinnacle ML 2-way / 4-5% 3-way football).
    let truePinP = 1 / pin;
    let pinImpliedPct = +(100 / pin).toFixed(2);
    let devigInfo = null;
    try {
      const _devig = require('./devig');
      let oddsForDevig = null;
      if (Array.isArray(args.pinOddsAll) && args.pinOddsAll.length >= 2) {
        oddsForDevig = args.pinOddsAll.filter(o => Number.isFinite(parseFloat(o)) && parseFloat(o) > 1);
      } else if (Number.isFinite(parseFloat(args.pinOddOpposite))) {
        oddsForDevig = [pin, parseFloat(args.pinOddOpposite)];
      }
      if (oddsForDevig && oddsForDevig.length >= 2) {
        const idx = oddsForDevig.findIndex(o => Math.abs(parseFloat(o) - pin) < 1e-9);
        if (idx >= 0) {
          const r = _devig.devigEnsemble(oddsForDevig);
          if (r && Array.isArray(r.probs) && r.probs[idx] > 0) {
            truePinP = r.probs[idx];
            pinImpliedPct = +(truePinP * 100).toFixed(2);
            devigInfo = { method: r.method, k: r.k, z: r.z, overround: +(r.overround || 0).toFixed(4) };
          }
        }
      }
    } catch (_) { /* devig fail-safe → fallback raw 1/pin */ }
    const evPct = +((bestSuper.odd * truePinP - 1) * 100).toFixed(2);
    return {
      sport, matchKey, matchLabel: `${team1} vs ${team2}`, side,
      pinOdd: +pin.toFixed(3), pinImpliedPct,
      superBook: bestSuper.bookmaker, superOdd: +bestSuper.odd.toFixed(3),
      ratio: +bestSuper.ratio.toFixed(3), evPct,
      mode: 'pinnacle',
      devig: devigInfo,
    };
  }

  // Modo 2: Cross-book (mediana como referência)
  if (!Array.isArray(books) || books.length < 3) return null;
  // Coleta odds válidas
  const validBooks = books
    .filter(b => b?.bookmaker && Number.isFinite(parseFloat(b.odd)) && parseFloat(b.odd) > 1)
    .map(b => ({ bookmaker: b.bookmaker, odd: parseFloat(b.odd) }));
  if (validBooks.length < 3) return null;

  // Pra cada book, calcula mediana dos OUTROS books (leave-one-out) e detecta outlier
  let bestSuper = null;
  for (const target of validBooks) {
    if (target.odd < minOdd || target.odd > maxOdd) continue;
    const otherOdds = validBooks.filter(b => b.bookmaker !== target.bookmaker).map(b => b.odd);
    if (otherOdds.length < 2) continue;
    const ref = _median(otherOdds);
    if (!ref || ref <= 1) continue;
    const ratio = target.odd / ref;
    if (ratio < minRatio) continue;
    if (!bestSuper || ratio > bestSuper.ratio) {
      bestSuper = { bookmaker: target.bookmaker, odd: target.odd, ratio, ref };
    }
  }
  if (!bestSuper) return null;

  const matchKey = _normMatch(team1, team2);
  // 2026-05-03 FIX (mode 2 cross-book): aplicar devig quando args.booksAll fornece
  // todos os lados do mesmo book pra computar overround. Antes EV usava 1/median
  // (raw vig) → cross-book mediana ainda contém vig 5-7% médio. Devig baseado em
  // overround do MESMO book de referência (best lado oposto) reduz EV ~3-5pp.
  let truePinP = 1 / bestSuper.ref;
  let refImpliedPct = +(100 / bestSuper.ref).toFixed(2);
  let devigInfo = null;
  try {
    const _devig = require('./devig');
    if (Array.isArray(args.booksAllSides) && args.booksAllSides.length >= 2) {
      // booksAllSides: array de { sideRefOdd, booksWith2 } — caller passa odds agregadas
      // de pelo menos 2 books com ambos lados. Usa mediana das de-vigged probs.
      const dvProbs = [];
      for (const entry of args.booksAllSides) {
        const refO = parseFloat(entry?.sideRefOdd);
        const oppO = parseFloat(entry?.oppositeOdd);
        if (Number.isFinite(refO) && Number.isFinite(oppO) && refO > 1 && oppO > 1) {
          const r = _devig.devigEnsemble([refO, oppO]);
          if (r?.probs?.[0] > 0 && r.probs[0] < 1) dvProbs.push(r.probs[0]);
        }
      }
      if (dvProbs.length) {
        dvProbs.sort((a, b) => a - b);
        truePinP = dvProbs[Math.floor(dvProbs.length / 2)];
        refImpliedPct = +(truePinP * 100).toFixed(2);
        devigInfo = { method: 'crossbook_median', n: dvProbs.length };
      }
    }
  } catch (_) { /* fallback raw 1/median */ }
  const evPct = +((bestSuper.odd * truePinP - 1) * 100).toFixed(2);
  return {
    sport, matchKey, matchLabel: `${team1} vs ${team2}`, side,
    pinOdd: +bestSuper.ref.toFixed(3), // usa ref no campo pinOdd pro schema
    devig: devigInfo,
    pinImpliedPct: refImpliedPct,
    superBook: bestSuper.bookmaker, superOdd: +bestSuper.odd.toFixed(3),
    ratio: +bestSuper.ratio.toFixed(3), evPct,
    mode: 'crossbook',
    refMedian: +bestSuper.ref.toFixed(3),
    sampleSize: validBooks.length,
  };
}

function shouldDm(sport, matchKey, side, cooldownMs = 60 * 60 * 1000) {
  const k = `${sport}|${matchKey}|${side}`;
  const last = _lastDmAt.get(k) || 0;
  if (Date.now() - last < cooldownMs) return false;
  _lastDmAt.set(k, Date.now());
  return true;
}

function persistEvent(db, evt) {
  if (!db || !evt) return;
  try {
    db.prepare(`
      INSERT INTO super_odd_events
        (sport, match_label, pick_side, pinnacle_odd, pinnacle_implied_pct, super_book, super_odd, ratio, ev_pct_estimated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(evt.sport, evt.matchLabel, evt.side, evt.pinOdd, evt.pinImpliedPct, evt.superBook, evt.superOdd, evt.ratio, evt.evPct);
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
    SELECT * FROM super_odd_events
    WHERE ${conds.join(' AND ')}
    ORDER BY detected_at DESC
    LIMIT 100
  `).all(...params);
}

module.exports = { detectSuperOdd, shouldDm, persistEvent, getRecentEvents };

'use strict';

/**
 * lib/brier-holdout-eval.js
 *
 * Helper pra eval de isotonic JSON em holdout sample (P3 pendency 2026-05-18).
 *
 * Carrega 14d (configurável) de tips reais settled de `market_tips_shadow` per
 * sport. Aplica isotonic blocks ao `p_model` armazenado, calcula Brier + ECE
 * versus `result` (win/loss).
 *
 * Caveat: sample pode incluir tips usadas no training do isotonic — não é
 * "true" holdout disjoint. Comparison OLD vs NEW em MESMO sample ainda é
 * meaningful pra rollback detection: se NEW > OLD * threshold, fit regrediu.
 *
 * 2026-05-18 (P3 full step 1): prefer column `model_p_raw` (mig 117) quando
 * disponível. p_model em shadow é POST-isotonic — eval em p_model mede
 * combined model performance (não isolated isotonic fit). model_p_raw é
 * raw pre-isotonic capturado caller-side. Fallback p_model preserva
 * comportamento legacy quando caller não plumbou raw ainda.
 *
 * P3 full true-holdout (disjoint train/eval split por --holdout-days flag em
 * cada fit script) fica como pendência separada (heavy refactor 4 scripts).
 *
 * Usage:
 *   const { evalIsotonicOnShadow } = require('./brier-holdout-eval');
 *   const m = evalIsotonicOnShadow(db, 'lol', isotonicJson, { days: 14 });
 *   // → { n, brier, ece, sampleAge: { oldest, newest } }
 */

function _applyIsotonicBlocks(blocks, p) {
  if (!Array.isArray(blocks) || blocks.length === 0) return p;
  for (const b of blocks) {
    if (p >= b.pMin && p <= b.pMax) return b.yMean;
  }
  // fora dos blocks = identity (raw value retained)
  return p;
}

function _brierScore(p, outcome) {
  return (p - outcome) * (p - outcome);
}

/**
 * Expected Calibration Error (10 bins, equal-width [0,1]).
 * |avg_predicted - avg_outcome| per bin, weighted by bin sample size.
 */
function _computeEce(samples) {
  if (!samples.length) return null;
  const nBins = 10;
  const bins = Array.from({ length: nBins }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  for (const { p, y } of samples) {
    let idx = Math.floor(p * nBins);
    if (idx >= nBins) idx = nBins - 1;
    if (idx < 0) idx = 0;
    bins[idx].n++;
    bins[idx].sumP += p;
    bins[idx].sumY += y;
  }
  let ece = 0;
  for (const b of bins) {
    if (b.n === 0) continue;
    const avgP = b.sumP / b.n;
    const avgY = b.sumY / b.n;
    ece += (b.n / samples.length) * Math.abs(avgP - avgY);
  }
  return ece;
}

/**
 * Eval isotonic JSON em holdout shadow sample. Apply blocks → calc brier+ECE.
 *
 * @param {object} db better-sqlite3 instance
 * @param {string} sport 'lol' | 'tennis' | 'dota2' | 'cs2' | etc
 * @param {object} isotonicJson { blocks: [{ pMin, pMax, yMean, n }, ...] }
 * @param {object} opts { days = 14, minSamples = 30 }
 * @returns {object|null} { n, brier, ece, sampleAge } ou null se sample insuficiente
 */
function evalIsotonicOnShadow(db, sport, isotonicJson, opts = {}) {
  const days = Math.max(1, Math.min(180, parseInt(String(opts.days || '14'), 10) || 14));
  const minSamples = Math.max(5, parseInt(String(opts.minSamples || '30'), 10) || 30);
  const blocks = (isotonicJson && Array.isArray(isotonicJson.blocks)) ? isotonicJson.blocks : [];
  if (!blocks.length) return null;

  // Detect column model_p_raw (mig 117). Fallback p_model se col missing OR
  // todos rows tem raw NULL (caller plumbing incremental).
  let _hasRawCol = false;
  try {
    const cols = db.prepare("PRAGMA table_info(market_tips_shadow)").all();
    _hasRawCol = cols.some(c => c.name === 'model_p_raw');
  } catch (_) {}

  let rows;
  try {
    const rawCol = _hasRawCol ? 'model_p_raw' : 'NULL AS model_p_raw';
    rows = db.prepare(`
      SELECT p_model, ${rawCol}, result, created_at
      FROM market_tips_shadow
      WHERE sport = ?
        AND result IN ('win', 'loss')
        AND p_model IS NOT NULL
        AND p_model > 0
        AND p_model < 1
        AND created_at >= datetime('now', '-' || ? || ' days')
        AND COALESCE(would_be_rejected_by, '') = ''
      ORDER BY created_at DESC
      LIMIT 5000
    `).all(sport, days);
  } catch (_) {
    // market_tips_shadow inexistente OU cols faltando — skip silenciosamente
    return null;
  }

  if (rows.length < minSamples) return null;

  const samples = [];
  let nUsingRaw = 0;
  for (const r of rows) {
    // Prefer model_p_raw (pre-isotonic) quando disponível; fallback p_model (post-iso legacy).
    const rawCandidate = Number(r.model_p_raw);
    const useRaw = Number.isFinite(rawCandidate) && rawCandidate > 0 && rawCandidate < 1;
    const pRaw = useRaw ? rawCandidate : Number(r.p_model);
    if (useRaw) nUsingRaw++;
    if (!Number.isFinite(pRaw) || pRaw <= 0 || pRaw >= 1) continue;
    const outcome = r.result === 'win' ? 1 : 0;
    const pCalib = _applyIsotonicBlocks(blocks, pRaw);
    samples.push({ p: pCalib, y: outcome });
  }
  if (samples.length < minSamples) return null;

  let brierSum = 0;
  for (const s of samples) brierSum += _brierScore(s.p, s.y);
  const brier = brierSum / samples.length;
  const ece = _computeEce(samples);

  return {
    n: samples.length,
    brier: +brier.toFixed(4),
    ece: ece != null ? +ece.toFixed(4) : null,
    n_using_raw: nUsingRaw,
    n_using_post_iso: samples.length - nUsingRaw,
    sampleAge: {
      oldest: rows[rows.length - 1]?.created_at || null,
      newest: rows[0]?.created_at || null,
    },
  };
}

module.exports = { evalIsotonicOnShadow, _applyIsotonicBlocks, _brierScore, _computeEce };

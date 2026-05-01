'use strict';

/**
 * roi-drift-cusum.js — Cumulative Sum drift detector pra ROI per-sport.
 *
 * Detecta mudança de regime no ROI (sport "vira" negativo silenciosamente)
 * antes do gate optimizer semanal pegar. CUSUM com k=0.5σ + h=4σ default
 * — sensível o suficiente pra n~30 picks mas robusto contra ruído normal.
 *
 * Algoritmo:
 *   1. Train slice = primeiros 70% das tips settled na janela (baseline)
 *   2. Computa μ + σ do per-tip ROI no train (target distribution)
 *   3. Tail slice = últimos 30% das tips
 *   4. CUSUM: S_high += (x - μ - kσ); S_low += (μ - x - kσ); reset em 0
 *   5. Breach quando S_high > hσ (drift positivo) ou S_low > hσ (negativo)
 *
 * Output: lista de {sport, direction, baselineRoi, recentRoi, breachAtTip}
 */

function _mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function _stdev(arr) {
  if (arr.length < 2) return 0;
  const m = _mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

/**
 * @param {object} db — better-sqlite3 db
 * @param {object} [opts]
 * @param {number} [opts.k=0.5]   — slack em multiplos de σ
 * @param {number} [opts.h=4]     — breach threshold em multiplos de σ
 * @param {number} [opts.days=60] — janela total de tips
 * @param {number} [opts.minN=30] — n minimo settled pra rodar
 * @param {number} [opts.trainFrac=0.7] — fração inicial usada como baseline
 * @param {string[]} [opts.sports] — override default sports list
 * @returns {Array<{sport, direction, breachAtTip, nTotal, baselineRoi, recentRoi, sigma, k, h}>}
 */
function runRoiDriftCusum(db, opts = {}) {
  const k = opts.k ?? 0.5;
  const h = opts.h ?? 4;
  const days = opts.days ?? 60;
  const minN = opts.minN ?? 30;
  const trainFrac = opts.trainFrac ?? 0.7;
  const sports = opts.sports || [
    'lol', 'cs', 'dota2', 'valorant',
    'tennis', 'football', 'mma',
    'darts', 'snooker', 'tabletennis',
  ];

  const alerts = [];
  for (const sport of sports) {
    let tips;
    try {
      tips = db.prepare(`
        SELECT result, profit_reais, stake_reais, sent_at
        FROM tips
        WHERE sport = ?
          AND result IN ('win','loss')
          AND COALESCE(is_shadow, 0) = 0
          AND COALESCE(archived, 0) = 0
          AND stake_reais > 0
          AND sent_at >= datetime('now', '-' || ? || ' days')
        ORDER BY sent_at ASC
      `).all(sport, days);
    } catch (_) { continue; }
    if (!tips || tips.length < minN) continue;

    // Per-tip ROI (profit / stake), unitless
    const rois = tips.map(t => Number(t.profit_reais || 0) / Number(t.stake_reais || 1));

    const trainCutoff = Math.max(10, Math.floor(rois.length * trainFrac));
    const trainSlice = rois.slice(0, trainCutoff);
    const tailSlice = rois.slice(trainCutoff);
    if (tailSlice.length < 5) continue;

    const mu = _mean(trainSlice);
    const sigma = _stdev(trainSlice);
    if (!Number.isFinite(sigma) || sigma <= 0.001) continue; // sem variance, sem CUSUM

    const breachHigh = h * sigma;
    const breachLow = h * sigma;
    const slack = k * sigma;

    let sHigh = 0, sLow = 0;
    let breachIdx = -1;
    let breachDir = null;
    for (let i = 0; i < tailSlice.length; i++) {
      const dev = tailSlice[i] - mu;
      sHigh = Math.max(0, sHigh + dev - slack);
      sLow = Math.max(0, sLow - dev - slack);
      if (sHigh > breachHigh) { breachIdx = i; breachDir = 'positive'; break; }
      if (sLow > breachLow) { breachIdx = i; breachDir = 'negative'; break; }
    }

    if (breachIdx >= 0) {
      const recentSlice = tailSlice.slice(0, breachIdx + 1);
      alerts.push({
        sport,
        direction: breachDir,
        breachAtTip: trainCutoff + breachIdx + 1,
        nTotal: tips.length,
        baselineRoi: +(mu * 100).toFixed(2),       // %
        recentRoi: +(_mean(recentSlice) * 100).toFixed(2),
        sigma: +sigma.toFixed(4),
        nBreachTips: recentSlice.length,
        k, h,
      });
    }
  }
  return alerts;
}

module.exports = { runRoiDriftCusum };

/**
 * sport-unit.js — Per-sport tier-based unit value.
 *
 * Cada sport tem banca inicial R$100 (default). Unit value é discretizada em tiers
 * baseados no ratio current_banca / initial_banca — não flutua continuamente, só
 * quando cruza faixa.
 *
 * Tier scheme (defino 2026-04-21):
 *   ratio  <0.40   → R$0.50 (drenou 60%+, proteção emergencial)
 *   ratio  0.40–0.60 → R$0.60
 *   ratio  0.60–0.80 → R$0.80
 *   ratio  0.80–1.20 → R$1.00 (zona normal ±20%, unit base)
 *   ratio  1.20–1.50 → R$1.20
 *   ratio  1.50–2.00 → R$1.50
 *   ratio  2.00–3.00 → R$2.00
 *   ratio  ≥3.00     → R$3.00
 *
 * Override via env: SPORT_UNIT_TIERS (JSON array [[minRatio, unitValue], ...] sorted desc).
 */

'use strict';

const DEFAULT_INITIAL_BANCA = 100;

function _parseTiersFromEnv() {
  const raw = process.env.SPORT_UNIT_TIERS;
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr
      .map(([ratio, value]) => [Number(ratio), Number(value)])
      .filter(([r, v]) => Number.isFinite(r) && Number.isFinite(v) && v > 0)
      .sort((a, b) => b[0] - a[0]); // desc por ratio
  } catch (_) { return null; }
}

const DEFAULT_TIERS = [
  [3.00, 3.00],
  [2.00, 2.00],
  [1.50, 1.50],
  [1.20, 1.20],
  [0.80, 1.00],
  [0.60, 0.80],
  [0.40, 0.60],
  [0.00, 0.50],
];

function getTiers() {
  return _parseTiersFromEnv() || DEFAULT_TIERS;
}

/**
 * Retorna unit value (R$) pro sport dado baseado em current/initial bankroll.
 * @param {number} currentBanca — saldo atual do sport em R$
 * @param {number} initialBanca — saldo inicial (default R$100)
 * @returns {number} unit value em R$
 */
function getSportUnitValue(currentBanca, initialBanca = DEFAULT_INITIAL_BANCA) {
  const init = Number(initialBanca) > 0 ? Number(initialBanca) : DEFAULT_INITIAL_BANCA;
  const curr = Number(currentBanca) || 0;
  if (curr <= 0) return getTiers()[getTiers().length - 1][1]; // drenado → tier mais baixo
  const ratio = curr / init;
  for (const [minRatio, unitVal] of getTiers()) {
    if (ratio >= minRatio) return unitVal;
  }
  return getTiers()[getTiers().length - 1][1];
}

/**
 * Descreve o tier atual — útil pra debug/dashboard.
 */
function describeTier(currentBanca, initialBanca = DEFAULT_INITIAL_BANCA) {
  const uv = getSportUnitValue(currentBanca, initialBanca);
  const ratio = initialBanca > 0 ? Number(currentBanca) / Number(initialBanca) : 0;
  return {
    unit_value: uv,
    ratio: +ratio.toFixed(3),
    current_banca: +Number(currentBanca).toFixed(2),
    initial_banca: Number(initialBanca),
  };
}

module.exports = {
  DEFAULT_INITIAL_BANCA,
  getSportUnitValue,
  describeTier,
  getTiers,
};

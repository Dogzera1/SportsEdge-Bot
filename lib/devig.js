'use strict';

/**
 * devig.js — Remoção de vig pra calcular probabilidade implícita "verdadeira".
 *
 * Dois métodos padrão da indústria:
 *
 * 1. Multiplicative (proportional): p_i = (1/o_i) / Σ(1/o_j)
 *    - Simples, rápido, funciona bem quando o vig é baixo e distribuído
 *      proporcionalmente (Pinnacle é o caso típico).
 *
 * 2. Power: resolve k tal que Σ(1/o_i)^k = 1, então p_i = (1/o_i)^k
 *    - Mais correto matematicamente pra bookmakers que aplicam vig de forma
 *      não-uniforme (mais vig em favoritos/underdogs extremos).
 *    - Canônico para sharp books quando odds são 2-way ou 3-way.
 *
 * Uso:
 *   const { devigMultiplicative, devigPower } = require('./devig');
 *   const { p1, p2 } = devigMultiplicative('1.80', '2.10');
 *   const { p1, p2, k } = devigPower('1.80', '2.10');
 */

function _parseOdd(o) {
  const n = typeof o === 'number' ? o : parseFloat(o);
  return Number.isFinite(n) && n > 1 ? n : null;
}

/**
 * Multiplicative (proportional) devig — duas vias.
 * @returns {{ p1, p2, overround } | null}
 */
function devigMultiplicative(odd1, odd2) {
  const o1 = _parseOdd(odd1), o2 = _parseOdd(odd2);
  if (!o1 || !o2) return null;
  const r1 = 1 / o1, r2 = 1 / o2;
  const overround = r1 + r2;
  return {
    p1: r1 / overround,
    p2: r2 / overround,
    overround,
  };
}

/**
 * Multiplicative devig — N-vias.
 * @param {Array<string|number>} odds
 * @returns {{ probs: number[], overround: number } | null}
 */
function devigMultiplicativeN(odds) {
  const rs = [];
  for (const o of odds) {
    const n = _parseOdd(o);
    if (!n) return null;
    rs.push(1 / n);
  }
  const overround = rs.reduce((a, b) => a + b, 0);
  return { probs: rs.map(r => r / overround), overround };
}

/**
 * Power-method devig. Resolve k por bisection tal que Σ(1/o_i)^k = 1.
 * @param {Array<string|number>|string|number} odds1  — primeiro odd OU array de odds
 * @param {string|number} [odd2]                      — segundo odd (caso 2-via)
 * @returns {{ p1?, p2?, probs?, k, overround } | null}
 */
function devigPower(odds1, odd2) {
  let odds;
  if (Array.isArray(odds1)) odds = odds1;
  else if (odd2 !== undefined) odds = [odds1, odd2];
  else return null;

  const rs = [];
  for (const o of odds) {
    const n = _parseOdd(o);
    if (!n) return null;
    rs.push(1 / n);
  }
  const overround = rs.reduce((a, b) => a + b, 0);

  // Se overround é efetivamente 1, k=1 (sem vig)
  if (Math.abs(overround - 1) < 1e-9) {
    const probs = rs.slice();
    const out = { probs, k: 1, overround };
    if (probs.length === 2) { out.p1 = probs[0]; out.p2 = probs[1]; }
    return out;
  }

  // Bisection em k: Σ r_i^k = 1.
  // Quando overround > 1, precisa k > 1 (empurra probs pra baixo). k < 1 vice-versa.
  let lo = 0.5, hi = 2.0;
  const sumAt = (k) => rs.reduce((s, r) => s + Math.pow(r, k), 0);

  // Expande intervalo se necessário
  let tries = 0;
  while (sumAt(lo) < 1 && tries < 20) { lo /= 2; tries++; }
  tries = 0;
  while (sumAt(hi) > 1 && tries < 20) { hi *= 2; tries++; }

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  const probs = rs.map(r => Math.pow(r, k));

  const out = { probs, k, overround };
  if (probs.length === 2) { out.p1 = probs[0]; out.p2 = probs[1]; }
  return out;
}

module.exports = {
  devigMultiplicative,
  devigMultiplicativeN,
  devigPower,
};

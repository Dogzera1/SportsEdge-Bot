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
  // 2026-05-06 FIX: bracket inicial [0.5, 2.0] falhava em arb scenarios
  // (overround<1 = freebie/erro) — sumAt(2.0) já <1, expansão pra baixo só
  // dividia hi (sem tocar em lo). Agora abre bracket simétrico se overround<1.
  let lo, hi;
  if (overround < 1) {
    // Arb / livro errado — k < 1 puxa probs pra cima (Σ menor = precisa
    // expandir pra atingir 1). Bracket [0.05, 1.5]: cobre arbs até ~95% off.
    lo = 0.05; hi = 1.5;
  } else {
    lo = 0.5; hi = 2.0;
  }
  const sumAt = (k) => rs.reduce((s, r) => s + Math.pow(r, k), 0);

  // Expande intervalo se necessário (defensivo pra ambos os casos).
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

/**
 * Shin method (Shin 1992, 1993) — assume parte do overround vem de informed
 * traders, não vig uniforme. Resolve z (proporção de informed) tal que:
 *   p_i = (sqrt(z² + 4(1-z) * (1/o_i)² / Σ(1/o_j)) - z) / (2(1-z))
 * com Σ p_i = 1. Z = 0 → equivale a multiplicative; z > 0 → puxa probs do
 * favorito pra baixo (informed traders empurram odd do favorito mais que do
 * underdog → vig assimétrico real).
 *
 * Quando usar Shin vs Power:
 *   - Power: vig uniforme (Pinnacle típico, mercado eficiente)
 *   - Shin: assimetria favorito/underdog (Bet365/casas BR, livro retail)
 *   - Para mismatch pesado (|odds_diff| > 1.5), Shin extrai prob justa
 *     ~2-4pp mais perto da realidade que power. Lit: Smith et al. 2009,
 *     "Bookmaker odds as forecasts" (RIQE 28).
 *
 * Implementação: bisection em z ∈ [0, 0.4]. z>0.4 é raro (40% informed = casa
 * extremamente exposta). Convergência em ~30 iter.
 *
 * @param {Array<string|number>|string|number} odds1
 * @param {string|number} [odd2]
 * @returns {{ p1?, p2?, probs?, z, overround } | null}
 */
function devigShin(odds1, odd2) {
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

  // Sem vig → z=0, probs = rs
  if (Math.abs(overround - 1) < 1e-9) {
    const probs = rs.slice();
    const out = { probs, z: 0, overround };
    if (probs.length === 2) { out.p1 = probs[0]; out.p2 = probs[1]; }
    return out;
  }

  // Shin probs em função de z:
  //   p_i(z) = (sqrt(z² + 4(1-z) * r_i² / overround) - z) / (2(1-z))
  // Procuramos z tal que Σ p_i(z) = 1.
  const probsAt = (z) => {
    if (z >= 1) return rs.map(() => 0);
    const denom = 2 * (1 - z);
    return rs.map(r => {
      const inner = z * z + 4 * (1 - z) * r * r / overround;
      return (Math.sqrt(Math.max(0, inner)) - z) / denom;
    });
  };
  const sumAt = (z) => probsAt(z).reduce((s, p) => s + p, 0);

  // Bisection: z=0 → soma = sqrt(r_i²/overround) summed = Σr_i / sqrt(overround) > 1
  // (porque Σr_i = overround > 1, mas Σ ~r/sqrt(overround) < overround/sqrt(overround) = sqrt(overround))
  // Atual: aumentar z reduz soma. Procurar z onde soma = 1.
  let lo = 0, hi = 0.4;
  if (sumAt(lo) < 1) {
    // Edge case: market quase sem vig — fallback multiplicative.
    const probs = rs.map(r => r / overround);
    const out = { probs, z: 0, overround, fallback: 'no_shin_solution' };
    if (probs.length === 2) { out.p1 = probs[0]; out.p2 = probs[1]; }
    return out;
  }
  if (sumAt(hi) > 1) {
    // z>0.4 necessário — overround muito alto, mercado retail extremo. Expand uma vez.
    hi = 0.7;
    if (sumAt(hi) > 1) hi = 0.95;
  }

  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid; else hi = mid;
  }
  const z = (lo + hi) / 2;
  const probs = probsAt(z);

  const out = { probs, z, overround };
  if (probs.length === 2) { out.p1 = probs[0]; out.p2 = probs[1]; }
  return out;
}

/**
 * 2026-05-01: ensemble auto-select. Roteia entre power e Shin baseado em
 * assimetria (|o1 - o2| pra 2-way). Default: power se assimetria <1.5; Shin
 * se ≥1.5 (favorito pesado, vig assimétrico). Override via opts.method.
 *
 * Lit: para 2-way mismatches (favorito @ 1.30 vs dog @ 4.50), Shin extrai
 * probs justas ~2-4pp diferentes de power, viés sistemático em direção à
 * realidade (Smith et al 2009 + Constantinou & Fenton 2012).
 *
 * @param {Array<string|number>|string|number} odds1
 * @param {string|number} [odd2]
 * @param {object} [opts] — { method: 'auto'|'power'|'shin'|'multiplicative', asymmetryThreshold: 1.5 }
 * @returns {{ probs, p1?, p2?, method, k?, z?, overround } | null}
 */
function devigEnsemble(odds1, odd2, opts = {}) {
  const method = opts.method || 'auto';
  const threshold = parseFloat(opts.asymmetryThreshold ?? 1.5);

  if (method === 'multiplicative') {
    if (Array.isArray(odds1)) {
      const r = devigMultiplicativeN(odds1);
      return r ? { ...r, method: 'multiplicative' } : null;
    }
    const r = devigMultiplicative(odds1, odd2);
    return r ? { ...r, method: 'multiplicative', probs: [r.p1, r.p2] } : null;
  }
  if (method === 'power') {
    const r = devigPower(odds1, odd2);
    return r ? { ...r, method: 'power' } : null;
  }
  if (method === 'shin') {
    const r = devigShin(odds1, odd2);
    return r ? { ...r, method: 'shin' } : null;
  }

  // Auto: assimetria-based pra 2-way; power pra 3-way (Shin generaliza mal pra >2).
  const oddsArr = Array.isArray(odds1) ? odds1 : [odds1, odd2];
  if (oddsArr.length !== 2) {
    const r = devigPower(odds1, odd2);
    return r ? { ...r, method: 'power_3way' } : null;
  }
  const o1 = _parseOdd(oddsArr[0]), o2 = _parseOdd(oddsArr[1]);
  if (!o1 || !o2) return null;
  const asymmetry = Math.abs(o1 - o2);
  if (asymmetry >= threshold) {
    const r = devigShin(o1, o2);
    if (r) return { ...r, method: 'shin' };
  }
  const r = devigPower(o1, o2);
  return r ? { ...r, method: 'power' } : null;
}

module.exports = {
  devigMultiplicative,
  devigMultiplicativeN,
  devigPower,
  devigShin,
  devigEnsemble,
};

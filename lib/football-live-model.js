'use strict';

/**
 * football-live-model.js — predicts probabilidades de mercados live em football
 * via Poisson residual scaling.
 *
 * Premissa: λ_residual = λ_full × (1 - elapsed/90) com clamp [0, λ_full].
 * Gols já marcados ENTRAM na predição como score atual fixo. P(total final >= N)
 * = P(score_atual + gols_residuais >= N) onde gols_residuais ~ Poisson(λ_residual).
 *
 * Mercados cobertos:
 *   total live (Over/Under N.5 baseado em score atual + λ_residual)
 *   BTTS live (atualiza dado quem já marcou)
 *   1X2 live (P(home wins | tempo restante e score atual))
 *
 * Caveats:
 *   - Cartões/expulsões NÃO modelados (lift modesto: -0.05 λ por red card)
 *   - In-game momentum (ex: time em ataque furioso) não capturado
 *   - elapsed = minutos jogados (45 = HT, 90+ = stoppage)
 *
 * Uso:
 *   const { predictFootballLive } = require('./football-live-model');
 *   const r = predictFootballLive({
 *     lamH: 1.6, lamA: 0.9,    // pre-game lambdas (do trained Poisson)
 *     elapsed: 30,              // minutos jogados
 *     scoreH: 1, scoreA: 0,     // score atual
 *   });
 *   // r = { lamHResid, lamAResid, markets: { ou, btts, 1x2 } }
 */

const MAX_GOALS = 8;

function _factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

function _poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / _factorial(k);
}

function _poissonMatrix(lamH, lamA, maxGoals = MAX_GOALS) {
  const pmfH = [], pmfA = [];
  for (let k = 0; k <= maxGoals; k++) pmfH[k] = _poissonPmf(k, lamH);
  for (let k = 0; k <= maxGoals; k++) pmfA[k] = _poissonPmf(k, lamA);
  let sH = 0, sA = 0;
  for (let k = 0; k <= maxGoals; k++) { sH += pmfH[k]; sA += pmfA[k]; }
  if (sH > 0) for (let k = 0; k <= maxGoals; k++) pmfH[k] /= sH;
  if (sA > 0) for (let k = 0; k <= maxGoals; k++) pmfA[k] /= sA;
  const mat = [];
  for (let i = 0; i <= maxGoals; i++) { mat[i] = []; for (let j = 0; j <= maxGoals; j++) mat[i][j] = pmfH[i] * pmfA[j]; }
  return { mat, pmfH, pmfA };
}

/**
 * Predict markets live a partir de lambdas pre-game + state atual.
 *
 * @param {object} args
 * @param {number} args.lamH — λ pre-game home (full match)
 * @param {number} args.lamA — λ pre-game away
 * @param {number} args.elapsed — minutos jogados (45 HT, 90 FT)
 * @param {number} [args.scoreH=0] — gols home atuais
 * @param {number} [args.scoreA=0] — gols away atuais
 * @param {number} [args.regulationMinutes=90]
 * @param {number} [args.dcRho=-0.10] — Dixon-Coles correction pra residual
 * @returns {object|null} { lamHResid, lamAResid, markets: { ou, btts, dc, ah } }
 */
function predictFootballLive({ lamH, lamA, elapsed, scoreH = 0, scoreA = 0, regulationMinutes = 90, dcRho = -0.10 } = {}) {
  if (!Number.isFinite(lamH) || !Number.isFinite(lamA)) return null;
  if (lamH <= 0 || lamA <= 0) return null;
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;

  // Tempo restante. Stoppage: clamp a 90 max pra evitar λ negativo. Live tip
  // perto de 90' tem λ_residual ~0 — modelo prevê outcome quase fixo.
  const remaining = Math.max(0, regulationMinutes - elapsed);
  const fraction = remaining / regulationMinutes;
  const lamHResid = lamH * fraction;
  const lamAResid = lamA * fraction;

  // Matrix de gols RESIDUAIS (não totais)
  const { mat: residMat } = _poissonMatrix(lamHResid, lamAResid, MAX_GOALS);

  // Aplicar Dixon-Coles correction nos residuais.
  // Caveat: DC é fitado pra full-match. Em live, low-scoring tail residual é
  // menor. Aplica com ρ atenuado por fraction (DC fica gradativamente menos
  // relevante conforme se aproxima de 90').
  const rhoEff = dcRho * Math.max(0, fraction); // proporção
  if (Number.isFinite(rhoEff) && rhoEff !== 0) {
    residMat[0][0] *= (1 - lamHResid * lamAResid * rhoEff);
    if (residMat[0][1]) residMat[0][1] *= (1 + lamHResid * rhoEff);
    if (residMat[1][0]) residMat[1][0] *= (1 + lamAResid * rhoEff);
    if (residMat[1][1]) residMat[1][1] *= (1 - rhoEff);
    let tot = 0;
    for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) tot += residMat[i][j];
    if (tot > 0) for (let i = 0; i <= MAX_GOALS; i++) for (let j = 0; j <= MAX_GOALS; j++) residMat[i][j] /= tot;
  }

  // Build markets a partir de score atual + residuais
  // P(final = scoreH+i, scoreA+j) = residMat[i][j]
  const markets = { ou: {}, btts: null, dc: null, ah: {}, ouHome: {}, ouAway: {} };

  // Total Over/Under (lines 0.5..4.5 + 5.5)
  for (const lineNum of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]) {
    const lineKey = lineNum.toFixed(1);
    const threshold = Math.floor(lineNum); // current_total_final > threshold = over
    let pOver = 0;
    for (let i = 0; i <= MAX_GOALS; i++) {
      for (let j = 0; j <= MAX_GOALS; j++) {
        const totalFinal = (scoreH + i) + (scoreA + j);
        if (totalFinal > threshold) pOver += residMat[i][j];
      }
    }
    markets.ou[lineKey] = { over: +pOver.toFixed(4), under: +(1 - pOver).toFixed(4) };
  }

  // BTTS — already happened OR will happen
  // 2026-05-06 FIX: somava pmf [1..MAX_GOALS=8] mas matrix residual nesse
  // ponto NÃO é renormalizada pra cap=8. Pra lambda > 4, pmf além de 8 vaza
  // ~5% → BTTS yes subestimado. Fix: dividir por Σ pmf[0..MAX] (= mass total).
  const _pmfMass = (lambda) => {
    let s = 0;
    for (let k = 0; k <= MAX_GOALS; k++) s += _poissonPmf(k, lambda);
    return s || 1;
  };
  let pBttsYes = 0;
  if (scoreH >= 1 && scoreA >= 1) {
    pBttsYes = 1; // já bateu
  } else if (scoreH >= 1) {
    // Home já marcou. BTTS yes ⟺ away marca pelo menos 1 no remaining.
    const massA = _pmfMass(lamAResid);
    let pAwayScores = 0;
    for (let j = 1; j <= MAX_GOALS; j++) pAwayScores += _poissonPmf(j, lamAResid);
    pBttsYes = pAwayScores / massA;
  } else if (scoreA >= 1) {
    const massH = _pmfMass(lamHResid);
    let pHomeScores = 0;
    for (let i = 1; i <= MAX_GOALS; i++) pHomeScores += _poissonPmf(i, lamHResid);
    pBttsYes = pHomeScores / massH;
  } else {
    // 0-0 ainda: BTTS yes ⟺ ambos marcam 1+
    const massH = _pmfMass(lamHResid), massA = _pmfMass(lamAResid);
    let pHome1 = 0, pAway1 = 0;
    for (let i = 1; i <= MAX_GOALS; i++) pHome1 += _poissonPmf(i, lamHResid);
    for (let j = 1; j <= MAX_GOALS; j++) pAway1 += _poissonPmf(j, lamAResid);
    pBttsYes = (pHome1 / massH) * (pAway1 / massA); // independência residual (sem DC)
  }
  markets.btts = { yes: +pBttsYes.toFixed(4), no: +(1 - pBttsYes).toFixed(4) };

  // 1X2 (final result)
  let pH = 0, pD = 0, pA = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const finalH = scoreH + i, finalA = scoreA + j;
      if (finalH > finalA) pH += residMat[i][j];
      else if (finalH === finalA) pD += residMat[i][j];
      else pA += residMat[i][j];
    }
  }
  markets.dc = {
    h_d: +(pH + pD).toFixed(4),
    d_a: +(pD + pA).toFixed(4),
    h_a: +(pH + pA).toFixed(4),
  };

  // Asian Handicap (line .5 only) — applied to home final
  for (const line of [-1.5, -0.5, 0.5, 1.5]) {
    let pHome = 0;
    for (let i = 0; i <= MAX_GOALS; i++) {
      for (let j = 0; j <= MAX_GOALS; j++) {
        const finalH = scoreH + i, finalA = scoreA + j;
        if ((finalH + line) > finalA) pHome += residMat[i][j];
      }
    }
    markets.ah[line.toFixed(1)] = { home: +pHome.toFixed(4), away: +(1 - pHome).toFixed(4) };
  }

  // Team totals (gols home, gols away final)
  for (const lineNum of [0.5, 1.5, 2.5]) {
    const lineKey = lineNum.toFixed(1);
    const threshold = Math.floor(lineNum);
    let pHomeOver = 0, pAwayOver = 0;
    for (let k = Math.max(0, threshold + 1 - scoreH); k <= MAX_GOALS; k++) pHomeOver += _poissonPmf(k, lamHResid);
    for (let k = Math.max(0, threshold + 1 - scoreA); k <= MAX_GOALS; k++) pAwayOver += _poissonPmf(k, lamAResid);
    pHomeOver = Math.min(1, Math.max(0, pHomeOver));
    pAwayOver = Math.min(1, Math.max(0, pAwayOver));
    markets.ouHome[lineKey] = { over: +pHomeOver.toFixed(4), under: +(1 - pHomeOver).toFixed(4) };
    markets.ouAway[lineKey] = { over: +pAwayOver.toFixed(4), under: +(1 - pAwayOver).toFixed(4) };
  }

  return {
    lamH: +lamH.toFixed(3),
    lamA: +lamA.toFixed(3),
    lamHResid: +lamHResid.toFixed(3),
    lamAResid: +lamAResid.toFixed(3),
    elapsed, scoreH, scoreA, fraction: +fraction.toFixed(3),
    markets,
    pH: +pH.toFixed(4), pD: +pD.toFixed(4), pA: +pA.toFixed(4),
  };
}

module.exports = { predictFootballLive };

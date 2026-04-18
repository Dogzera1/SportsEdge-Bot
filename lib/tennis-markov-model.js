'use strict';

/**
 * tennis-markov-model.js — Motor ponto-a-ponto pra precificar TODOS os mercados
 * de tênis a partir de 2 inputs: p1Serve (prob team1 vence um ponto sacando) e
 * p2Serve (prob team2 vence um ponto sacando).
 *
 * Arquitetura canônica: P(ponto) → P(game) → P(set) → P(match). Com inputs
 * estáveis, uma só simulação Monte Carlo produz:
 *   - Match winner
 *   - Set correct score (2-0, 2-1, 0-2, 1-2 / 3-0..0-3)
 *   - Total games over/under
 *   - Total sets over/under
 *   - Tiebreak in match (yes/no)
 *   - Straight sets (yes/no)
 *
 * Game win prob fechado (Wikipedia / Barnett-Clarke):
 *   G(p) = p^4 + 4·p^4·q + 10·p^4·q^2 + 20·p^3·q^3 · p^2/(p^2+q^2)
 *
 * Referências:
 *   - Newton & Keller (2005) "Probability of Winning at Tennis"
 *   - Klaassen & Magnus (2001) "Are Points in Tennis Independent and Identically Distributed?"
 */

function _clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0.01, Math.min(0.99, n));
}

/**
 * Closed-form: prob do servidor vencer um game dado que vence cada ponto com prob p.
 */
function gameWinProb(p) {
  const q = 1 - p;
  const pNoDeuce = Math.pow(p, 4) * (1 + 4 * q + 10 * q * q);
  const pDeuceReached = 20 * Math.pow(p, 3) * Math.pow(q, 3);
  const pWinFromDeuce = (p * p) / (p * p + q * q);
  return pNoDeuce + pDeuceReached * pWinFromDeuce;
}

/**
 * Monte Carlo: simula 1 tiebreak até 7 pts com margem 2.
 * Ordem de saque: A serve pt1; B serve pts 2-3; A serve 4-5; alternando pares.
 * @returns {1|0} 1 se A vence, 0 se B vence
 */
function _simTiebreak(pA, pB) {
  let a = 0, b = 0, pointsPlayed = 0;
  while (true) {
    // Primeiro ponto: A serve. Depois pares alternando: B,B,A,A,B,B,...
    let serveIsA;
    if (pointsPlayed === 0) serveIsA = true;
    else {
      const group = Math.floor((pointsPlayed - 1) / 2);
      serveIsA = group % 2 === 1;
    }
    const pServerWins = serveIsA ? pA : pB;
    const serverWins = Math.random() < pServerWins;
    // Quem ganha o ponto: se server wins, é o sacador; senão, o retornador.
    if (serveIsA) {
      if (serverWins) a++; else b++;
    } else {
      if (serverWins) b++; else a++;
    }
    pointsPlayed++;
    if (a >= 7 && a - b >= 2) return 1;
    if (b >= 7 && b - a >= 2) return 0;
  }
}

/**
 * MC: simula 1 set completo.
 * @returns {{ winnerA: 0|1, gamesA: number, gamesB: number, wentToTiebreak: boolean }}
 */
function _simSet(pA, pB, serveAStart) {
  let gA = 0, gB = 0;
  let serveA = serveAStart;
  while (true) {
    // Joga 1 game
    const pServe = serveA ? pA : pB;
    const serverWinsGame = Math.random() < gameWinProb(pServe);
    if (serveA) {
      if (serverWinsGame) gA++; else gB++;
    } else {
      if (serverWinsGame) gB++; else gA++;
    }

    // Set encerrou?
    if (gA >= 6 && gA - gB >= 2) return { winnerA: 1, gamesA: gA, gamesB: gB, wentToTiebreak: false };
    if (gB >= 6 && gB - gA >= 2) return { winnerA: 0, gamesA: gA, gamesB: gB, wentToTiebreak: false };
    if (gA === 7 && gB === 5) return { winnerA: 1, gamesA: 7, gamesB: 5, wentToTiebreak: false };
    if (gB === 7 && gA === 5) return { winnerA: 0, gamesA: 7, gamesB: 5, wentToTiebreak: false };
    if (gA === 6 && gB === 6) {
      const tbWinA = _simTiebreak(pA, pB);
      if (tbWinA) return { winnerA: 1, gamesA: 7, gamesB: 6, wentToTiebreak: true };
      return { winnerA: 0, gamesA: 6, gamesB: 7, wentToTiebreak: true };
    }
    serveA = !serveA;
  }
}

/**
 * MC: simula 1 match completo.
 */
function _simMatch(pA, pB, bestOf) {
  const setsToWin = Math.ceil(bestOf / 2);
  let sA = 0, sB = 0, gamesTotal = 0, tbCount = 0;
  const setScores = []; // ['6-4', '7-6', ...]
  let serveAStartsSet = true;

  while (sA < setsToWin && sB < setsToWin) {
    const r = _simSet(pA, pB, serveAStartsSet);
    if (r.winnerA) sA++; else sB++;
    setScores.push(`${r.gamesA}-${r.gamesB}`);
    gamesTotal += r.gamesA + r.gamesB;
    if (r.wentToTiebreak) tbCount++;
    // No next set, o servidor que começou o set anterior era o que abriu;
    // no próximo set, abre quem não abriu (ou quem sacou o último game do set).
    // Aproximação: alterna quem abre o set.
    serveAStartsSet = !serveAStartsSet;
  }

  return {
    winnerA: sA > sB ? 1 : 0,
    setsA: sA, setsB: sB,
    setScores, gamesTotal, tbCount,
  };
}

/**
 * Precifica todos os mercados principais de tênis via Monte Carlo.
 *
 * @param {object} args
 * @param {number} args.p1Serve — P(time1 vence ponto quando saca). [0.5, 0.85] típico.
 * @param {number} args.p2Serve — P(time2 vence ponto quando saca).
 * @param {number} args.bestOf  — 3 ou 5.
 * @param {number} [args.iters=20000] — iterações MC.
 * @returns {{
 *   pMatch: number,         // P(time1 vence)
 *   setDist: Record<string, number>,  // { '2-0': p, '2-1': p, '1-2': p, '0-2': p }
 *   totalGamesAvg: number,
 *   totalGamesPdf: Record<number, number>, // {12: p, 13: p, ...}
 *   pOver21_5: number,
 *   pOver22_5: number,
 *   pOver23_5: number,
 *   pStraightSets: number,   // P(sets N-0)
 *   pTiebreakMatch: number,  // P(ao menos 1 TB no match)
 *   pTiebreakFirstSet: number,
 *   totalSetsAvg: number,
 * }}
 */
function priceTennisMatch({ p1Serve, p2Serve, bestOf = 3, iters = 20000 }) {
  const pA = _clamp01(p1Serve);
  const pB = _clamp01(p2Serve);
  const bo = bestOf === 5 ? 5 : 3;

  let matchWinsA = 0;
  let tbMatchCount = 0;
  let tbFirstSetCount = 0;
  let straightCount = 0;
  let gamesSum = 0;
  let setsSum = 0;
  const setScoreCounts = new Map(); // 'sA-sB' → count
  const gamesPdf = new Map();

  for (let i = 0; i < iters; i++) {
    const r = _simMatch(pA, pB, bo);
    matchWinsA += r.winnerA;
    const label = `${r.setsA}-${r.setsB}`;
    setScoreCounts.set(label, (setScoreCounts.get(label) || 0) + 1);
    gamesSum += r.gamesTotal;
    setsSum += (r.setsA + r.setsB);
    gamesPdf.set(r.gamesTotal, (gamesPdf.get(r.gamesTotal) || 0) + 1);
    if (r.tbCount > 0) tbMatchCount++;
    // Primeiro set foi TB?
    if (r.setScores[0] === '7-6' || r.setScores[0] === '6-7') tbFirstSetCount++;
    // Straight sets: vencedor fechou N-0
    if (Math.abs(r.setsA - r.setsB) === Math.ceil(bo / 2)) straightCount++;
  }

  const pMatch = matchWinsA / iters;
  const setDist = {};
  for (const [k, v] of setScoreCounts) setDist[k] = v / iters;
  const totalGamesPdf = {};
  for (const [k, v] of gamesPdf) totalGamesPdf[k] = v / iters;

  // P(over X games) = soma da pdf para k > X
  const pOver = (line) => {
    let s = 0;
    for (const [k, v] of Object.entries(totalGamesPdf)) {
      if (Number(k) > line) s += v;
    }
    return s;
  };

  return {
    pMatch: +pMatch.toFixed(4),
    setDist: Object.fromEntries(Object.entries(setDist).map(([k, v]) => [k, +v.toFixed(4)])),
    totalGamesAvg: +(gamesSum / iters).toFixed(2),
    totalGamesPdf,
    pOver21_5: +pOver(21.5).toFixed(4),
    pOver22_5: +pOver(22.5).toFixed(4),
    pOver23_5: +pOver(23.5).toFixed(4),
    pStraightSets: +(straightCount / iters).toFixed(4),
    pTiebreakMatch: +(tbMatchCount / iters).toFixed(4),
    pTiebreakFirstSet: +(tbFirstSetCount / iters).toFixed(4),
    totalSetsAvg: +(setsSum / iters).toFixed(3),
  };
}

/**
 * Helper: dado P(match) do modelo treinado (pMatch) e P_serve médio assumido
 * (e.g., 0.64 hard, 0.61 clay, 0.68 grass), resolve por bisection a split
 * (p1Serve, p2Serve) tal que priceTennisMatch(p1, p2) == pMatch, mantendo
 * a soma p1+p2 = 2×pServeAvg.
 *
 * Útil quando só temos P(match) de um modelo agregado (Elo/trained) e queremos
 * destilar de volta para ponto-a-ponto pra precificar totals/aces.
 *
 * @param {number} pMatchTarget
 * @param {number} [pServeAvg=0.64] — serve point win rate médio da superfície
 * @param {number} [bestOf=3]
 * @returns {{ p1Serve: number, p2Serve: number }}
 */
function solvePointProbs(pMatchTarget, pServeAvg = 0.64, bestOf = 3) {
  const tgt = _clamp01(pMatchTarget);
  const sum = 2 * _clamp01(pServeAvg);
  // Se p1=p2, pMatch=0.5. Empurra diff em direção ao alvo.
  // Bisection no diff = p1 - p2. Diff positivo → p1 maior → pMatch maior.
  let lo = -0.30, hi = 0.30; // diff range realista
  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2;
    const p1 = (sum + mid) / 2;
    const p2 = (sum - mid) / 2;
    // Iters baixos aqui para velocidade; refina depois
    const pM = priceTennisMatch({ p1Serve: p1, p2Serve: p2, bestOf, iters: 4000 }).pMatch;
    if (pM < tgt) lo = mid; else hi = mid;
  }
  const diff = (lo + hi) / 2;
  return { p1Serve: (sum + diff) / 2, p2Serve: (sum - diff) / 2 };
}

/**
 * Extrai (p1Serve, p2Serve) a partir de serve/return stats dos dois jogadores,
 * ajustados por Klaassen-Magnus (subtract league average, add opponent's
 * return deficit).
 *
 * @param {object} ss1 - serve stats player 1 (formato tennis-model serveSubModel input):
 *   { firstServePct, firstServePointsPct, secondServePointsPct, breakPointsSavedPct }
 * @param {object} ss2 - serve stats player 2 (mesmo formato)
 * @param {object} [opts]
 * @param {string} [opts.surface='hard'] - 'hard'|'clay'|'grass'|'indoor'
 * @returns {{ p1Serve, p2Serve, spw1, spw2, spwAvg } | null}
 */
function extractServeProbs(ss1, ss2, opts = {}) {
  if (!ss1 || !ss2) return null;
  const spw = (s) => {
    const fs = s.firstServePct;
    const fsp = s.firstServePointsPct;
    const ssp = s.secondServePointsPct;
    if (fs == null || fsp == null || ssp == null) return null;
    return (fs / 100) * (fsp / 100) + (1 - fs / 100) * (ssp / 100);
  };
  const spw1 = spw(ss1);
  const spw2 = spw(ss2);
  if (spw1 == null || spw2 == null) return null;

  // SPW médio ATP/WTA por superfície (referência Sackmann):
  //   hard:   0.637   clay:   0.611   grass:  0.662   indoor: 0.648
  const surface = String(opts.surface || 'hard').toLowerCase();
  const spwAvg = { hard: 0.637, clay: 0.611, grass: 0.662, indoor: 0.648 }[surface] || 0.637;

  // Klaassen-Magnus adjustment:
  //   effP1 = spw1 - spwAvg + (1 - spw2)
  //         = spw1 - spw2 + (1 - spwAvg)
  // Equivalente: effP1 - 0.5 = (spw1 - spw2)/2 + small correction.
  // Simplificação robusta: p1Serve = spw1 + ((1 - spw2) - (1 - spwAvg)) / 2
  //                                = spw1 + (spwAvg - spw2) / 2
  // Mantém centrado em spwAvg quando spw1=spw2=spwAvg.
  const p1Serve = spw1 + (spwAvg - spw2) / 2;
  const p2Serve = spw2 + (spwAvg - spw1) / 2;

  return {
    p1Serve: _clamp01(p1Serve),
    p2Serve: _clamp01(p2Serve),
    spw1: +spw1.toFixed(4),
    spw2: +spw2.toFixed(4),
    spwAvg,
  };
}

module.exports = {
  gameWinProb,
  priceTennisMatch,
  solvePointProbs,
  extractServeProbs,
  // exposto pra testing
  _simMatch, _simSet, _simTiebreak,
};

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
  // Agregados per-player pra precificação de games handicap (match-level)
  let totalGamesA = 0, totalGamesB = 0;
  const setScores = []; // ['6-4', '7-6', ...]
  let serveAStartsSet = true;

  while (sA < setsToWin && sB < setsToWin) {
    const r = _simSet(pA, pB, serveAStartsSet);
    if (r.winnerA) sA++; else sB++;
    setScores.push(`${r.gamesA}-${r.gamesB}`);
    gamesTotal += r.gamesA + r.gamesB;
    totalGamesA += r.gamesA;
    totalGamesB += r.gamesB;
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
    // Games margin (A - B) usado pra precificar handicap de games (match-level).
    // Ex: 6-4 6-3 → margin +5. 4-6 6-3 7-5 → margin +1.
    gamesMargin: totalGamesA - totalGamesB,
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
  const gamesMarginPdf = new Map(); // (gamesA - gamesB) → count (match-level)

  for (let i = 0; i < iters; i++) {
    const r = _simMatch(pA, pB, bo);
    matchWinsA += r.winnerA;
    const label = `${r.setsA}-${r.setsB}`;
    setScoreCounts.set(label, (setScoreCounts.get(label) || 0) + 1);
    gamesSum += r.gamesTotal;
    setsSum += (r.setsA + r.setsB);
    gamesPdf.set(r.gamesTotal, (gamesPdf.get(r.gamesTotal) || 0) + 1);
    gamesMarginPdf.set(r.gamesMargin, (gamesMarginPdf.get(r.gamesMargin) || 0) + 1);
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
  const gamesMarginPdfObj = {};
  for (const [k, v] of gamesMarginPdf) gamesMarginPdfObj[k] = v / iters;

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
    gamesMarginPdf: gamesMarginPdfObj,
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
 * P(home cobre handicap de GAMES com line). line positivo = home recebe vantagem.
 * Ex: line=+1.5 → cobre se (gamesA - gamesB + 1.5) > 0 → margin >= -1 → abs margin positiva ou -1.
 *
 * @param {Object} gamesMarginPdf — do priceTennisMatch
 * @param {number} line — positivo (home +X.5) ou negativo (home -X.5)
 * @returns {number} P(home cobre)
 */
function handicapGamesProb(gamesMarginPdf, line) {
  if (!gamesMarginPdf || typeof gamesMarginPdf !== 'object') return null;
  let pHome = 0;
  for (const [kStr, v] of Object.entries(gamesMarginPdf)) {
    const margin = Number(kStr);
    if (margin + line > 0) pHome += v;
  }
  return +pHome.toFixed(4);
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
 * MC: simula set a partir de state parcial (games já jogados + TB opcional).
 * @param {number} initGA games já de A
 * @param {number} initGB games já de B
 * @param {boolean} serveANext quem saca o próximo game
 * @param {boolean} inTB se está em tiebreak (com initGA=initGB=6)
 * @param {number} tbA pontos já no TB
 * @param {number} tbB pontos já no TB
 */
function _simPartialSet(pA, pB, initGA, initGB, serveANext, inTB, tbA = 0, tbB = 0) {
  let gA = initGA, gB = initGB;
  // Se já estamos em TB, termina o TB primeiro
  if (inTB && gA === 6 && gB === 6) {
    // Simula TB a partir de (tbA, tbB). Servidor inicial do TB é quem serviria
    // o próximo game no set normal (serveANext).
    let a = tbA, b = tbB, pointsPlayed = tbA + tbB;
    while (true) {
      if (a >= 7 && a - b >= 2) return { winnerA: 1, gamesA: 7, gamesB: 6, wentToTiebreak: true };
      if (b >= 7 && b - a >= 2) return { winnerA: 0, gamesA: 6, gamesB: 7, wentToTiebreak: true };
      // Server alternation: pt 0 é o serveANext; depois pares alternam.
      let serveIsA;
      if (pointsPlayed === 0) serveIsA = serveANext;
      else {
        const group = Math.floor((pointsPlayed - 1) / 2);
        serveIsA = group % 2 === 1 ? serveANext : !serveANext;
      }
      const pServerWins = serveIsA ? pA : pB;
      const srvWins = Math.random() < pServerWins;
      if (serveIsA) { if (srvWins) a++; else b++; }
      else { if (srvWins) b++; else a++; }
      pointsPlayed++;
    }
  }

  // Set normal: joga games até fechar
  let serveA = serveANext;
  while (true) {
    const pServe = serveA ? pA : pB;
    const serverWinsGame = Math.random() < gameWinProb(pServe);
    if (serveA) { if (serverWinsGame) gA++; else gB++; }
    else { if (serverWinsGame) gB++; else gA++; }

    if (gA >= 6 && gA - gB >= 2) return { winnerA: 1, gamesA: gA, gamesB: gB, wentToTiebreak: false };
    if (gB >= 6 && gB - gA >= 2) return { winnerA: 0, gamesA: gA, gamesB: gB, wentToTiebreak: false };
    if (gA === 7 && gB === 5) return { winnerA: 1, gamesA: 7, gamesB: 5, wentToTiebreak: false };
    if (gB === 7 && gA === 5) return { winnerA: 0, gamesA: 7, gamesB: 5, wentToTiebreak: false };
    if (gA === 6 && gB === 6) {
      // TB começa; servidor inicial = quem seria o próximo serveA (próximo game)
      const nextServer = !serveA;
      const tbWinA = _simTiebreakWithServer(pA, pB, nextServer);
      if (tbWinA) return { winnerA: 1, gamesA: 7, gamesB: 6, wentToTiebreak: true };
      return { winnerA: 0, gamesA: 6, gamesB: 7, wentToTiebreak: true };
    }
    serveA = !serveA;
  }
}

/**
 * Tiebreak com servidor inicial customizado (usado no _simPartialSet).
 */
function _simTiebreakWithServer(pA, pB, firstServerIsA) {
  let a = 0, b = 0, pointsPlayed = 0;
  while (true) {
    let serveIsA;
    if (pointsPlayed === 0) serveIsA = firstServerIsA;
    else {
      const group = Math.floor((pointsPlayed - 1) / 2);
      serveIsA = group % 2 === 1 ? firstServerIsA : !firstServerIsA;
    }
    const pServerWins = serveIsA ? pA : pB;
    const srvWins = Math.random() < pServerWins;
    if (serveIsA) { if (srvWins) a++; else b++; }
    else { if (srvWins) b++; else a++; }
    pointsPlayed++;
    if (a >= 7 && a - b >= 2) return 1;
    if (b >= 7 && b - a >= 2) return 0;
  }
}

/**
 * Precifica match live (com state parcial). MC simula a partir do ponto atual.
 * @param {object} args
 * @param {object} args.state state atual:
 *   - setsA, setsB: sets já vencidos por cada um
 *   - gamesA, gamesB: games no set atual (em andamento)
 *   - currentServerIsA: quem saca o game ATUAL (ou TB ponto atual)
 *   - inTiebreak: se true, gamesA=gamesB=6 e estamos em TB
 *   - tbPointsA, tbPointsB: pontos no TB em andamento (0 se fora de TB)
 */
function priceTennisLive({ p1Serve, p2Serve, bestOf = 3, state, iters = 15000 }) {
  const pA = _clamp01(p1Serve);
  const pB = _clamp01(p2Serve);
  const bo = bestOf === 5 ? 5 : 3;
  const setsToWin = Math.ceil(bo / 2);
  const st = state || {};
  const initSetsA = Number(st.setsA) || 0;
  const initSetsB = Number(st.setsB) || 0;
  const initGA = Math.max(0, Number(st.gamesA) || 0);
  const initGB = Math.max(0, Number(st.gamesB) || 0);
  const srvA = st.currentServerIsA !== false && st.currentServerIsA != null
    ? !!st.currentServerIsA : ((initGA + initGB) % 2 === 0); // fallback: quem começou sacando volta ao início do set
  const inTB = !!st.inTiebreak || (initGA === 6 && initGB === 6);
  const tbA = Math.max(0, Number(st.tbPointsA) || 0);
  const tbB = Math.max(0, Number(st.tbPointsB) || 0);

  // Se match já terminou:
  if (initSetsA >= setsToWin) return { pMatch: 1, _terminal: 'A_already_won' };
  if (initSetsB >= setsToWin) return { pMatch: 0, _terminal: 'B_already_won' };

  let matchWinsA = 0;
  let remainingGamesSum = 0;
  let tbMatchCount = 0;

  for (let it = 0; it < iters; it++) {
    let sA = initSetsA, sB = initSetsB;
    let gamesSoFar = 0;
    let matchTb = (initGA === 6 && initGB === 6); // se já em TB, conta
    // 1. Termina set atual (parcial)
    const rCur = _simPartialSet(pA, pB, initGA, initGB, srvA, inTB, tbA, tbB);
    if (rCur.winnerA) sA++; else sB++;
    gamesSoFar += (rCur.gamesA - initGA) + (rCur.gamesB - initGB);
    if (rCur.wentToTiebreak) matchTb = true;

    // 2. Sets restantes
    let nextSetServeA = !srvA; // próximo set abre com quem não abriu o anterior
    while (sA < setsToWin && sB < setsToWin) {
      const rs = _simSet(pA, pB, nextSetServeA);
      if (rs.winnerA) sA++; else sB++;
      gamesSoFar += rs.gamesA + rs.gamesB;
      if (rs.wentToTiebreak) matchTb = true;
      nextSetServeA = !nextSetServeA;
    }
    if (sA > sB) matchWinsA++;
    remainingGamesSum += gamesSoFar;
    if (matchTb) tbMatchCount++;
  }

  return {
    pMatch: +(matchWinsA / iters).toFixed(4),
    remainingGamesAvg: +(remainingGamesSum / iters).toFixed(2),
    pTiebreakRemainingOrNow: +(tbMatchCount / iters).toFixed(4),
    state: { setsA: initSetsA, setsB: initSetsB, gamesA: initGA, gamesB: initGB, inTB },
  };
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
  const rpwAvg = 1 - spwAvg;

  // Klaassen-Magnus adjustment (full):
  //   effP1_SPW = avgSPW + (spw1 - avgSPW) - (rpw2 - avgRPW)
  //
  // Quando rpw1/rpw2 fornecidos (de tennis_match_stats walk-forward), usa a
  // forma completa. Sem eles, fallback usa shortcut (1-spw_oponente) como proxy
  // pra RPW (assume oponentes médios) — preserva comportamento legado.
  //
  // Lift esperado da forma completa: +1-2pp accuracy quando players têm RPW
  // diferenciado (e.g., Sinner elite return vs Isner fraco). Shortcut perde
  // esse sinal por confundir "saque fraco do opp" com "retorno forte meu".
  const rpw1 = Number.isFinite(opts.rpw1) ? opts.rpw1 : null;
  const rpw2 = Number.isFinite(opts.rpw2) ? opts.rpw2 : null;
  const useFull = rpw1 != null && rpw2 != null;

  let p1Serve, p2Serve;
  if (useFull) {
    p1Serve = spwAvg + (spw1 - spwAvg) - (rpw2 - rpwAvg);
    p2Serve = spwAvg + (spw2 - spwAvg) - (rpw1 - rpwAvg);
  } else {
    // Shortcut legado: usa (1-spw_opp) como proxy de RPW.
    p1Serve = spw1 + (spwAvg - spw2) / 2;
    p2Serve = spw2 + (spwAvg - spw1) / 2;
  }

  return {
    p1Serve: _clamp01(p1Serve),
    p2Serve: _clamp01(p2Serve),
    spw1: +spw1.toFixed(4),
    spw2: +spw2.toFixed(4),
    rpw1: rpw1 != null ? +rpw1.toFixed(4) : null,
    rpw2: rpw2 != null ? +rpw2.toFixed(4) : null,
    spwAvg,
    method: useFull ? 'km_full' : 'km_shortcut',
  };
}

// ─── Ace market pricing (Poisson-based) ──────────────────────────────────

function _factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

/**
 * Poisson CDF P(X ≤ k) dado rate λ.
 * Para k grande, iteração direta com estabilidade numérica.
 */
function _poissonCdf(k, lambda) {
  if (lambda <= 0) return 1;
  if (k < 0) return 0;
  // Método estável: acumula termos sem overflow.
  let logP = -lambda; // log(e^-λ × λ^0 / 0!) = -λ
  let sum = Math.exp(logP);
  for (let i = 1; i <= k; i++) {
    logP += Math.log(lambda) - Math.log(i);
    sum += Math.exp(logP);
  }
  return Math.min(1, sum);
}

/**
 * Precifica mercados de aces via Poisson.
 *
 * @param {object} args
 * @param {number} args.acesPerMatch1 — média aces/match do team1 (últimos N)
 * @param {number} args.acesPerMatch2 — média aces/match do team2
 * @param {number} [args.bestOf=3] — 3 ou 5 (BO5 escala ~1.4x)
 * @param {string} [args.surface='hard'] — 'hard'|'clay'|'grass'|'indoor'
 * @param {number[]} [args.lines=[8.5, 10.5, 12.5, 15.5, 18.5, 22.5]] — linhas a precificar
 * @returns {{ totalAcesAvg: number, lambda1: number, lambda2: number, pOver: Record<string, number> } | null}
 */
function estimateTennisAces({ acesPerMatch1, acesPerMatch2, bestOf = 3, surface = 'hard', lines = [8.5, 10.5, 12.5, 15.5, 18.5, 22.5] }) {
  const a1 = Number(acesPerMatch1);
  const a2 = Number(acesPerMatch2);
  if (!Number.isFinite(a1) || !Number.isFinite(a2) || a1 < 0 || a2 < 0) return null;

  // BO5 multiplier: ~1.4x pontos de saque vs BO3.
  const boMult = bestOf === 5 ? 1.4 : 1.0;
  // Surface ajuste relativo (multiplier sobre média do jogador).
  // Hard baseline 1.0; grass +40% (quadra rápida), indoor +15% (fast), clay -40% (bola lenta).
  const surfKey = String(surface || 'hard').toLowerCase();
  const surfMult = /grass/.test(surfKey) ? 1.40
    : /indoor/.test(surfKey) ? 1.15
    : /clay|saibro/.test(surfKey) ? 0.60
    : 1.0;

  // acesPerMatch é surface-agnóstico (média últimos matches).
  // Ajustamos PARCIALMENTE pela superfície — assume jogador é usado a mix.
  // Factor: 0.5*surfMult + 0.5*1.0 (metade default, metade surface-adjust).
  const adj = 0.5 * surfMult + 0.5;
  const lambda1 = a1 * boMult * adj;
  const lambda2 = a2 * boMult * adj;
  const total = lambda1 + lambda2;

  const pOver = {};
  for (const line of lines) {
    const k = Math.floor(line);
    const cdf = _poissonCdf(k, total);
    pOver[String(line)] = +(1 - cdf).toFixed(4);
  }

  return {
    totalAcesAvg: +total.toFixed(2),
    lambda1: +lambda1.toFixed(2),
    lambda2: +lambda2.toFixed(2),
    pOver,
    surface: surfKey,
    surfMult,
    bestOf,
  };
}

/**
 * Estima total de Double Faults per match. Análogo a aces mas inverso:
 * jogadores com dfPerMatchAvg alto erram mais. Surface também afeta:
 * clay aumenta DF (saque mais lento, devolvedor pressiona), hard neutro,
 * grass diminui (saque rápido = menos chance segundo serve fail).
 *
 * @param {object} args { dfPerMatch1, dfPerMatch2, bestOf, surface, lines }
 * @returns {object|null}
 */
function estimateTennisDoubleFaults({ dfPerMatch1, dfPerMatch2, bestOf = 3, surface = 'hard', lines = [3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 10.5] }) {
  const d1 = Number(dfPerMatch1);
  const d2 = Number(dfPerMatch2);
  if (!Number.isFinite(d1) || !Number.isFinite(d2) || d1 < 0 || d2 < 0) return null;

  const boMult = bestOf === 5 ? 1.4 : 1.0;
  const surfKey = String(surface || 'hard').toLowerCase();
  // Inverso de aces: clay AUMENTA DF, grass diminui
  const surfMult = /grass/.test(surfKey) ? 0.85
    : /indoor/.test(surfKey) ? 0.95
    : /clay|saibro/.test(surfKey) ? 1.15
    : 1.0;

  const adj = 0.5 * surfMult + 0.5;
  const lambda1 = d1 * boMult * adj;
  const lambda2 = d2 * boMult * adj;
  const total = lambda1 + lambda2;

  const pOver = {};
  for (const line of lines) {
    const k = Math.floor(line);
    const cdf = _poissonCdf(k, total);
    pOver[String(line)] = +(1 - cdf).toFixed(4);
  }

  return {
    totalDfAvg: +total.toFixed(2),
    lambda1: +lambda1.toFixed(2),
    lambda2: +lambda2.toFixed(2),
    pOver,
    surface: surfKey,
    surfMult,
    bestOf,
  };
}

module.exports = {
  gameWinProb,
  priceTennisMatch,
  priceTennisLive,
  solvePointProbs,
  extractServeProbs,
  estimateTennisAces,
  estimateTennisDoubleFaults,
  handicapGamesProb,
  // exposto pra testing
  _simMatch, _simSet, _simTiebreak, _simPartialSet, _poissonCdf,
};

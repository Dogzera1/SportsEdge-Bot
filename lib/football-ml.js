/**
 * football-ml.js — Pré-filtro ML para futebol (1X2 + over/under)
 *
 * Recebe dados estruturados de forma, H2H, standings e odds
 * e retorna probabilidades estimadas + score de edge antes de chamar a IA.
 */

/**
 * @param {object} home   - { form, homeForm, goalsFor, goalsAgainst, position, fatigue }
 * @param {object} away   - { form, awayForm, goalsFor, goalsAgainst, position, fatigue }
 * @param {object} h2h    - { results: [{home, away, homeGoals, awayGoals}] } últimos 5
 * @param {object} odds   - { h: homeOdd, d: drawOdd, a: awayOdd, ou25: {over, under} }
 * @returns {object}      - { homeProb, drawProb, awayProb, over25Prob, edge, pass, direction, market }
 */
function calcFootballScore(home, away, h2h, odds) {
  const safeNum = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };

  // ── Odds de mercado → probabilidades implícitas de-juiced ──
  const oH = safeNum(odds?.h);
  const oD = safeNum(odds?.d);
  const oA = safeNum(odds?.a);

  if (!oH || !oD || !oA || oH <= 1 || oD <= 1 || oA <= 1) {
    return { pass: false, reason: 'sem_odds_validas' };
  }

  const rawH = 1 / oH, rawD = 1 / oD, rawA = 1 / oA;
  const overround = rawH + rawD + rawA;
  const mktH = rawH / overround;  // prob de-juiced casa
  const mktD = rawD / overround;  // prob de-juiced empate
  const mktA = rawA / overround;  // prob de-juiced fora
  const marginPct = (overround - 1) * 100;

  // ── Modelo de forma (últimos 5 jogos) ──
  // form = array de 'W'|'D'|'L', do mais recente ao mais antigo
  const formScore = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return null;
    const pts = arr.slice(0, 5).reduce((s, r) => s + (r === 'W' ? 3 : r === 'D' ? 1 : 0), 0);
    return pts / (Math.min(arr.length, 5) * 3); // 0–1
  };

  const homeFormScore  = formScore(home?.form);
  const homeHFormScore = formScore(home?.homeForm); // forma em casa especificamente
  const awayFormScore  = formScore(away?.form);
  const awayAFormScore = formScore(away?.awayForm);  // forma fora especificamente

  // ── Gols: ataque vs defesa ──
  const homeAttack  = safeNum(home?.goalsFor);    // média de gols marcados
  const homeDefense = safeNum(home?.goalsAgainst); // média de gols sofridos
  const awayAttack  = safeNum(away?.goalsFor);
  const awayDefense = safeNum(away?.goalsAgainst);

  // Over 2.5 estimativa baseada em médias de gols
  let over25Prob = null;
  if (homeAttack !== null && awayAttack !== null && homeDefense !== null && awayDefense !== null) {
    const expectedGoals = (homeAttack + awayDefense) / 2 + (awayAttack + homeDefense) / 2;
    // Aproximação Poisson simplificada: P(>2.5 gols) ≈ 1 - P(0) - P(1) - P(2)
    const lambda = Math.max(0.5, Math.min(5, expectedGoals));
    const e = Math.exp(-lambda);
    const p0 = e;
    const p1 = e * lambda;
    const p2 = e * lambda * lambda / 2;
    over25Prob = Math.max(0, Math.min(1, 1 - p0 - p1 - p2));
  }

  // ── H2H ──
  let h2hScore = null; // positivo → favorece home, negativo → favorece away
  if (h2h?.results?.length >= 3) {
    let hWins = 0, draws = 0, aWins = 0;
    for (const r of h2h.results.slice(0, 5)) {
      if (r.homeGoals > r.awayGoals) hWins++;
      else if (r.homeGoals === r.awayGoals) draws++;
      else aWins++;
    }
    const total = hWins + draws + aWins;
    h2hScore = (hWins - aWins) / total; // -1 a +1
  }

  // ── Posição na tabela ──
  const homePos = safeNum(home?.position);
  const awayPos = safeNum(away?.position);
  let posScore = null;
  if (homePos !== null && awayPos !== null) {
    const diff = (awayPos - homePos); // positivo = home melhor
    posScore = Math.max(-1, Math.min(1, diff / 10));
  }

  // ── Cansaço (dias desde último jogo) ──
  const homeFatigue = safeNum(home?.fatigue) || 7; // default 7 dias
  const awayFatigue = safeNum(away?.fatigue) || 7;
  // < 4 dias = muito cansado; > 7 = descansado
  const fatigueScore = (awayFatigue - homeFatigue) / 7; // positivo = home mais descansado

  // ── Modelo combinado → probabilidades ajustadas ──
  const weights = {
    homeForm:  0.20,
    homeHForm: 0.15,
    awayForm:  0.20,
    awayAForm: 0.15,
    h2h:       0.20,
    pos:       0.10,
  };

  // Acumulador de edge para home (positivo) vs away (negativo)
  let edgeSum = 0, wSum = 0;

  if (homeFormScore !== null && awayFormScore !== null) {
    edgeSum += (homeFormScore - awayFormScore) * weights.homeForm;
    wSum += weights.homeForm;
  }
  if (homeHFormScore !== null) {
    edgeSum += (homeHFormScore - 0.5) * weights.homeHForm;
    wSum += weights.homeHForm;
  }
  if (awayAFormScore !== null) {
    edgeSum += (0.5 - awayAFormScore) * weights.awayAForm;
    wSum += weights.awayAForm;
  }
  if (h2hScore !== null) {
    edgeSum += h2hScore * weights.h2h;
    wSum += weights.h2h;
  }
  if (posScore !== null) {
    edgeSum += posScore * weights.pos;
    wSum += weights.pos;
  }
  edgeSum += fatigueScore * 0.05;

  const rawEdge = wSum > 0 ? edgeSum / wSum : 0;

  // Home advantage base: ~5pp
  const homeAdv = 0.05;

  // Distribuição base: ajustar probabilidades de mercado com o rawEdge do modelo
  const shift = rawEdge * 0.15; // máximo ±15pp de deslocamento

  let modelH = Math.max(0.05, Math.min(0.85, mktH + shift + homeAdv));
  let modelA = Math.max(0.05, Math.min(0.85, mktA - shift));
  let modelD = Math.max(0.10, 1 - modelH - modelA);

  // Normalizar para somar 100%
  const total = modelH + modelD + modelA;
  modelH = modelH / total;
  modelD = modelD / total;
  modelA = modelA / total;

  // ── Calcular EV por mercado ──
  const evH  = ((modelH * oH) - 1) * 100;
  const evD  = ((modelD * oD) - 1) * 100;
  const evA  = ((modelA * oA) - 1) * 100;

  // Over/under EV
  let evOver = null, evUnder = null;
  if (over25Prob !== null && odds?.ou25) {
    const oOver  = safeNum(odds.ou25.over);
    const oUnder = safeNum(odds.ou25.under);
    if (oOver && oOver > 1)  evOver  = ((over25Prob * oOver) - 1) * 100;
    if (oUnder && oUnder > 1) evUnder = (((1 - over25Prob) * oUnder) - 1) * 100;
  }

  // ── Melhor edge ──
  const candidates = [
    { market: '1X2_H', ev: evH,    odd: oH, prob: modelH, label: 'Casa' },
    { market: '1X2_D', ev: evD,    odd: oD, prob: modelD, label: 'Empate' },
    { market: '1X2_A', ev: evA,    odd: oA, prob: modelA, label: 'Fora' },
    evOver  !== null ? { market: 'OVER_2.5',  ev: evOver,  odd: odds?.ou25?.over,  prob: over25Prob,       label: 'Over 2.5' }  : null,
    evUnder !== null ? { market: 'UNDER_2.5', ev: evUnder, odd: odds?.ou25?.under, prob: 1 - over25Prob,   label: 'Under 2.5' } : null,
  ].filter(Boolean).sort((a, b) => b.ev - a.ev);

  const best = candidates[0];

  // ── Gates pré-filtro ──
  const EV_THRESHOLD = 5.0; // %
  const EV_OU_THRESHOLD = 4.0;

  const evThreshold = (best?.market?.startsWith('1X2') ? EV_THRESHOLD : EV_OU_THRESHOLD);
  const pass = !!(best && best.ev >= evThreshold);

  return {
    pass,
    direction: best?.label || null,
    market: best?.market || null,
    bestEv: best?.ev ? parseFloat(best.ev.toFixed(2)) : 0,
    bestOdd: best?.odd || null,
    modelH: parseFloat((modelH * 100).toFixed(1)),
    modelD: parseFloat((modelD * 100).toFixed(1)),
    modelA: parseFloat((modelA * 100).toFixed(1)),
    mktH: parseFloat((mktH * 100).toFixed(1)),
    mktD: parseFloat((mktD * 100).toFixed(1)),
    mktA: parseFloat((mktA * 100).toFixed(1)),
    over25Prob: over25Prob !== null ? parseFloat((over25Prob * 100).toFixed(1)) : null,
    evH: parseFloat(evH.toFixed(2)),
    evD: parseFloat(evD.toFixed(2)),
    evA: parseFloat(evA.toFixed(2)),
    evOver, evUnder,
    marginPct: parseFloat(marginPct.toFixed(1)),
    rawEdge: parseFloat(rawEdge.toFixed(3)),
    candidates
  };
}

module.exports = { calcFootballScore };

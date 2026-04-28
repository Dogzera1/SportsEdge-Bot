/**
 * football-ml.js — Pré-filtro ML para futebol (1X2 + over/under)
 *
 * Recebe dados estruturados de forma, H2H, standings e odds
 * e retorna probabilidades estimadas + score de edge antes de chamar a IA.
 */

/**
 * Home advantage por liga (em probabilidade, ex: 0.08 = +8pp ao mandante).
 * Fonte: médias históricas de home win rate por liga menos o expected de 33%.
 * Valor padrão usado para ligas não mapeadas: 0.06 (6pp).
 */
const HOME_ADV_BY_LEAGUE = {
  71:  0.08,  // Brasileirão Série A — média histórica ~43% home win
  72:  0.09,  // Série B — home advantage levemente maior que A
  73:  0.10,  // Série C — home advantage alto em estádios menores
  11:  0.07,  // Argentina Primera División
  41:  0.06,  // England League One
  42:  0.06,  // England League Two
  80:  0.06,  // Germany 3. Liga
  141: 0.05,  // Spain Segunda División — mais equilibrada
  253: 0.04,  // MLS — viagens longas reduzem home advantage
  265: 0.07,  // Chile Primera División
  239: 0.08,  // Colombia Liga BetPlay
  268: 0.07,  // Uruguay Primera División
};
const HOME_ADV_DEFAULT = 0.06;

/**
 * Calcula P(total > 2.5) usando Poisson bivariado independente com lambdas separados.
 * Cada lambda usa média geométrica entre ataque do time e defesa do adversário,
 * o que captura corretamente jogos entre extremos (time ofensivo vs defesa fechada).
 *
 * @param {number} homeAttack  - média de gols marcados pelo time da casa
 * @param {number} homeDefense - média de gols sofridos pelo time da casa
 * @param {number} awayAttack  - média de gols marcados pelo visitante
 * @param {number} awayDefense - média de gols sofridos pelo visitante
 * @returns {{ over25: number, lambdaHome: number, lambdaAway: number }}
 */
function calcPoisson(homeAttack, homeDefense, awayAttack, awayDefense) {
  // Lambda por time: média geométrica entre força ofensiva e fraqueza defensiva do oponente.
  // Boost de 15% no mandante e redução de 10% no visitante — média histórica de ligas europeias.
  const HOME_BOOST = 1.15;
  const AWAY_REDUC = 0.90;
  const lambdaHome = Math.max(0.3, Math.min(4, Math.sqrt(homeAttack * awayDefense) * HOME_BOOST));
  const lambdaAway = Math.max(0.3, Math.min(4, Math.sqrt(awayAttack * homeDefense) * AWAY_REDUC));

  // P(total = k) via convolução de duas Poisson independentes
  // P(H=i) × P(A=j) para todos i+j <= 2
  const pH = k => Math.exp(-lambdaHome) * Math.pow(lambdaHome, k) / factorial(k);
  const pA = k => Math.exp(-lambdaAway) * Math.pow(lambdaAway, k) / factorial(k);

  // P(total <= 2) = P(0,0) + P(1,0) + P(0,1) + P(2,0) + P(1,1) + P(0,2)
  const pUnder = pH(0)*pA(0) + pH(1)*pA(0) + pH(0)*pA(1) +
                 pH(2)*pA(0) + pH(1)*pA(1) + pH(0)*pA(2);

  // BTTS Yes = P(home >=1) × P(away >=1) assumindo independência (Poisson product).
  // P(X=0) = exp(-λ) → P(X>=1) = 1 - exp(-λ).
  const pHomeScores = 1 - Math.exp(-lambdaHome);
  const pAwayScores = 1 - Math.exp(-lambdaAway);
  const bttsYes = Math.max(0, Math.min(1, pHomeScores * pAwayScores));

  return {
    over25: Math.max(0, Math.min(1, 1 - pUnder)),
    bttsYes,
    lambdaHome,
    lambdaAway
  };
}

function factorial(n) {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

/**
 * @param {object} home    - { form, homeForm, goalsFor, goalsAgainst, position, fatigue }
 * @param {object} away    - { form, awayForm, goalsFor, goalsAgainst, position, fatigue }
 * @param {object} h2h     - { results: [{home, away, homeGoals, awayGoals}] }
 * @param {object} odds    - { h: homeOdd, d: drawOdd, a: awayOdd, ou25: {over, under} }
 * @param {object} [meta]  - { leagueId?: number } para home advantage por liga
 * @returns {object}
 */
function calcFootballScore(home, away, h2h, odds, meta = {}) {
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
  const mktH = rawH / overround;
  const mktD = rawD / overround;
  const mktA = rawA / overround;
  const marginPct = (overround - 1) * 100;

  // ── Home advantage por liga ──
  const leagueId = safeNum(meta?.leagueId);
  const homeAdv = leagueId !== null
    ? (HOME_ADV_BY_LEAGUE[leagueId] ?? HOME_ADV_DEFAULT)
    : HOME_ADV_DEFAULT;

  // ── Modelo de forma (últimos 5 jogos) ──
  const formScore = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return null;
    const pts = arr.slice(0, 5).reduce((s, r) => s + (r === 'W' ? 3 : r === 'D' ? 1 : 0), 0);
    return pts / (Math.min(arr.length, 5) * 3); // 0–1
  };

  const homeFormScore  = formScore(home?.form);
  const homeHFormScore = formScore(home?.homeForm);
  const awayFormScore  = formScore(away?.form);
  const awayAFormScore = formScore(away?.awayForm);

  // ── Poisson bivariado com lambdas separados ──
  const homeAttack  = safeNum(home?.goalsFor);
  const homeDefense = safeNum(home?.goalsAgainst);
  const awayAttack  = safeNum(away?.goalsFor);
  const awayDefense = safeNum(away?.goalsAgainst);

  let over25Prob = null;
  let bttsProb = null;
  let lambdaHome = null, lambdaAway = null;
  if (homeAttack !== null && awayAttack !== null && homeDefense !== null && awayDefense !== null) {
    const p = calcPoisson(homeAttack, homeDefense, awayAttack, awayDefense);
    over25Prob = p.over25;
    bttsProb = p.bttsYes;
    lambdaHome = p.lambdaHome;
    lambdaAway = p.lambdaAway;
  }

  // ── H2H ──
  let h2hScore = null;
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
    posScore = Math.max(-1, Math.min(1, (awayPos - homePos) / 10));
  }

  // ── Cansaço ──
  const homeFatigue = safeNum(home?.fatigue) || 7;
  const awayFatigue = safeNum(away?.fatigue) || 7;
  const fatigueScore = (awayFatigue - homeFatigue) / 7;

  // ── Elo (aprendido no DB por settlement) ──
  const homeElo = safeNum(home?.elo);
  const awayElo = safeNum(away?.elo);
  let eloScore = null;
  if (homeElo !== null && awayElo !== null) {
    // normaliza: 400 pontos ≈ "diferença grande"
    eloScore = Math.max(-1, Math.min(1, (homeElo - awayElo) / 400));
  }

  // ── Modelo combinado → edge direcionado ──
  const weights = {
    homeForm:  0.20,
    homeHForm: 0.15,
    awayForm:  0.20,
    awayAForm: 0.15,
    h2h:       0.20,
    pos:       0.10,
    elo:       0.20,
  };

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
  if (eloScore !== null) {
    edgeSum += eloScore * weights.elo;
    wSum += weights.elo;
  }
  edgeSum += fatigueScore * 0.05;

  const rawEdge = wSum > 0 ? edgeSum / wSum : 0;

  // Deslocamento máximo ±15pp em relação ao mercado (edge do modelo)
  const shift = rawEdge * 0.15;

  // Home advantage: distribui 70% saindo do visitante e 30% do empate
  // (ligas com HA alto o draw cai menos do que o away)
  let modelH = Math.max(0.05, Math.min(0.85, mktH + shift + homeAdv));
  let modelA = Math.max(0.05, Math.min(0.85, mktA - shift - homeAdv * 0.70));
  let modelD = Math.max(0.08, Math.min(0.60, mktD - homeAdv * 0.30));

  const total = modelH + modelD + modelA;
  modelH = modelH / total;
  modelD = modelD / total;
  modelA = modelA / total;

  // ── EV por mercado ──
  const evH = ((modelH * oH) - 1) * 100;
  const evD = ((modelD * oD) - 1) * 100;
  const evA = ((modelA * oA) - 1) * 100;

  let evOver = null, evUnder = null;
  if (over25Prob !== null && odds?.ou25) {
    const oOver  = safeNum(odds.ou25.over);
    const oUnder = safeNum(odds.ou25.under);
    if (oOver  && oOver  > 1) evOver  = ((over25Prob       * oOver)  - 1) * 100;
    if (oUnder && oUnder > 1) evUnder = (((1 - over25Prob) * oUnder) - 1) * 100;
  }

  // BTTS via Poisson product (P(home>=1) × P(away>=1)).
  let evBttsYes = null, evBttsNo = null;
  if (bttsProb !== null && odds?.btts) {
    const oYes = safeNum(odds.btts.yes);
    const oNo  = safeNum(odds.btts.no);
    if (oYes && oYes > 1) evBttsYes = ((bttsProb       * oYes) - 1) * 100;
    if (oNo  && oNo  > 1) evBttsNo  = (((1 - bttsProb) * oNo)  - 1) * 100;
  }

  // ── Melhor edge ──
  const candidates = [
    { market: '1X2_H',    ev: evH,    odd: oH,              prob: modelH,          label: 'Casa' },
    { market: '1X2_D',    ev: evD,    odd: oD,              prob: modelD,          label: 'Empate' },
    { market: '1X2_A',    ev: evA,    odd: oA,              prob: modelA,          label: 'Fora' },
    evOver    !== null ? { market: 'OVER_2.5',  ev: evOver,    odd: odds?.ou25?.over,  prob: over25Prob,       label: 'Over 2.5' }  : null,
    evUnder   !== null ? { market: 'UNDER_2.5', ev: evUnder,   odd: odds?.ou25?.under, prob: 1 - over25Prob,   label: 'Under 2.5' } : null,
    evBttsYes !== null ? { market: 'BTTS_YES',  ev: evBttsYes, odd: odds?.btts?.yes,   prob: bttsProb,         label: 'Ambas Marcam' } : null,
    evBttsNo  !== null ? { market: 'BTTS_NO',   ev: evBttsNo,  odd: odds?.btts?.no,    prob: 1 - bttsProb,     label: 'NÃO Ambas Marcam' } : null,
  ].filter(Boolean).sort((a, b) => b.ev - a.ev);

  const best = candidates[0];

  const EV_THRESHOLD    = 5.0;
  const EV_OU_THRESHOLD = 4.0;
  const evThreshold = best?.market?.startsWith('1X2') ? EV_THRESHOLD : EV_OU_THRESHOLD;
  const pass = !!(best && best.ev >= evThreshold);

  return {
    pass,
    direction:  best?.label || null,
    market:     best?.market || null,
    bestEv:     best?.ev ? parseFloat(best.ev.toFixed(2)) : 0,
    bestOdd:    best?.odd || null,
    modelH:     parseFloat((modelH * 100).toFixed(1)),
    modelD:     parseFloat((modelD * 100).toFixed(1)),
    modelA:     parseFloat((modelA * 100).toFixed(1)),
    mktH:       parseFloat((mktH * 100).toFixed(1)),
    mktD:       parseFloat((mktD * 100).toFixed(1)),
    mktA:       parseFloat((mktA * 100).toFixed(1)),
    over25Prob: over25Prob !== null ? parseFloat((over25Prob * 100).toFixed(1)) : null,
    bttsProb:   bttsProb   !== null ? parseFloat((bttsProb   * 100).toFixed(1)) : null,
    lambdaHome: lambdaHome !== null ? parseFloat(lambdaHome.toFixed(2)) : null,
    lambdaAway: lambdaAway !== null ? parseFloat(lambdaAway.toFixed(2)) : null,
    homeAdv:    parseFloat((homeAdv * 100).toFixed(1)),
    evH:        parseFloat(evH.toFixed(2)),
    evD:        parseFloat(evD.toFixed(2)),
    evA:        parseFloat(evA.toFixed(2)),
    evOver, evUnder,
    marginPct:  parseFloat(marginPct.toFixed(1)),
    rawEdge:    parseFloat(rawEdge.toFixed(3)),
    candidates
  };
}

module.exports = { calcFootballScore, HOME_ADV_BY_LEAGUE };

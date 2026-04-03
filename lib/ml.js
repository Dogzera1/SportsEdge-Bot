function esportsPreFilter(match, odds, enrich, hasLiveStats, gamesContext, compScore) {
  // Se não tem odds, manda para a IA para avaliação — sem odds não dá pra calcular edge real
  if (!odds?.t1 || parseFloat(odds.t1) <= 1) return { pass: true, direction: null, score: 0, t1Edge: 0, t2Edge: 0 };

  const o1 = parseFloat(odds.t1);
  const o2 = parseFloat(odds.t2 || '2.00');

  // ── 1xBet margin awareness ──
  // 1xBet tem margem ~6-10% em esports. Precisamos de vantagem REAL acima desta margem.
  const raw1 = 1 / o1;
  const raw2 = 1 / o2;
  const overround = raw1 + raw2;
  const marginPct = (overround - 1) * 100; // ex: 7.5

  // De-juiced implied probabilities (base bayesiana)
  const impliedP1 = raw1 / overround;
  const impliedP2 = raw2 / overround;

  const safeNum = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };

  let scorePoints = 0;
  let factorCount = 0;

  // 1. Diferencial de Forma Recente (Win Rate) — peso 0.25
  // Só conta se ambos os times têm jogos registrados (wins+losses > 0)
  const wr1 = safeNum(enrich?.form1?.winRate);
  const wr2 = safeNum(enrich?.form2?.winRate);
  const f1Games = (enrich?.form1?.wins || 0) + (enrich?.form1?.losses || 0);
  const f2Games = (enrich?.form2?.wins || 0) + (enrich?.form2?.losses || 0);
  if (wr1 !== null && wr2 !== null && f1Games > 0 && f2Games > 0) {
    scorePoints += (wr1 - wr2) * 0.25;
    factorCount++;
  }

  // 2. Histórico Direto (H2H) — peso 0.30
  const h2h = enrich?.h2h;
  if (h2h && (h2h.t1Wins + h2h.t2Wins > 0)) {
    const t1W = parseInt(h2h.t1Wins) || 0;
    const t2W = parseInt(h2h.t2Wins) || 0;
    const h2hWinRateT1 = (t1W / (t1W + t2W)) * 100;
    const h2hWinRateT2 = (t2W / (t1W + t2W)) * 100;
    scorePoints += (h2hWinRateT1 - h2hWinRateT2) * 0.30;
    factorCount++;
  }

  // 3. Vantagem de meta/composição (WR de campeões em pro play) — peso 0.35
  // compScore = diferença em pp do WR médio dos campeões: positivo = t1(blue) favorecido
  if (compScore !== null && !isNaN(compScore)) {
    scorePoints += compScore * 0.35;
    factorCount++;
  }

  // 4. Dados ao vivo (estado do jogo) — peso extra se disponível
  if (hasLiveStats && typeof gamesContext === 'string') {
    factorCount++; // ao vivo = dado extra que a IA pode usar melhor que o ML
  }

  // Sem dados suficientes — deixa passar para a IA avaliar
  if (factorCount < 1) return { pass: true, direction: null, score: 0, t1Edge: 0, t2Edge: 0 };

  // ── Conversão logística heurística ──
  // scorePoints vai tipicamente entre [-20, +20]
  // Usamos implied probability como prior bayesiano e injetamos o ajuste do modelo
  let logOddsBase = Math.log(impliedP1 / (1 - impliedP1));
  logOddsBase += (scorePoints * 0.05);
  const modelP1 = 1 / (1 + Math.exp(-logOddsBase));
  const modelP2 = 1 - modelP1;

  // Edge = diferença entre probabilidade do modelo e break-even da bookie
  // Para ter valor REAL, o edge precisa superar a margem da 1xBet
  const t1Edge = (modelP1 - impliedP1) * 100;
  const t2Edge = (modelP2 - impliedP2) * 100;

  const direction = t1Edge >= t2Edge ? 't1' : 't2';
  const maxEdge = Math.max(t1Edge, t2Edge);

  // Só bloqueia (pass: false) quando há compScore — sinal forte de draft/ao vivo.
  // Form e H2H são sinais fracos: entram no score mas nunca barram a tip.
  // Início de campeonatos naturalmente tem form 0 — não pode impedir a IA de avaliar.
  const hasStrongSignal = (compScore !== null && !isNaN(compScore)) || hasLiveStats;
  if (!hasStrongSignal) return { pass: true, direction, score: maxEdge, t1Edge, t2Edge };

  // Com sinal forte (draft conhecido ou jogo ao vivo), exige edge real > 3pp
  const MIN_EDGE = 3.0;
  if (maxEdge >= MIN_EDGE) {
    return { pass: true, direction, score: maxEdge, t1Edge, t2Edge };
  }

  // Edge insuficiente mesmo com sinal forte — economiza tokens da IA
  return { pass: false, direction: null, score: maxEdge, t1Edge, t2Edge };
}

module.exports = { esportsPreFilter };

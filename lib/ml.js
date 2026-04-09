const { getDynamicWeights } = require('./ml-weights');

function esportsPreFilter(match, odds, enrich, hasLiveStats, gamesContext, compScore, stmts = null) {
  // Se não tem odds, manda para a IA para avaliação — sem odds não dá pra calcular edge real
  if (!odds?.t1 || parseFloat(odds.t1) <= 1) return { pass: true, direction: null, score: 0, t1Edge: 0, t2Edge: 0, modelP1: 0.5, modelP2: 0.5, impliedP1: 0.5, impliedP2: 0.5, factorCount: 0 };

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

  // Pesos dinâmicos (ajustados semanalmente por accuracy real)
  const weights = stmts ? getDynamicWeights(stmts) : { forma: 0.25, h2h: 0.30, comp: 0.35 };

  let formFactorUsed = false;
  let h2hFactorUsed = false;
  let compFactorUsed = false;

  // 1. Diferencial de Forma Recente (Win Rate) — peso dinâmico (padrão 0.25)
  // Só conta se ambos os times têm jogos registrados (wins+losses > 0)
  const wr1 = safeNum(enrich?.form1?.winRate);
  const wr2 = safeNum(enrich?.form2?.winRate);
  const f1Games = (enrich?.form1?.wins || 0) + (enrich?.form1?.losses || 0);
  const f2Games = (enrich?.form2?.wins || 0) + (enrich?.form2?.losses || 0);
  if (wr1 !== null && wr2 !== null && f1Games > 0 && f2Games > 0) {
    scorePoints += (wr1 - wr2) * weights.forma;
    factorCount++;
    formFactorUsed = true;
  }

  // 2. Histórico Direto (H2H) — peso dinâmico (padrão 0.30)
  const h2h = enrich?.h2h;
  if (h2h && (h2h.t1Wins + h2h.t2Wins > 0)) {
    const t1W = parseInt(h2h.t1Wins) || 0;
    const t2W = parseInt(h2h.t2Wins) || 0;
    const h2hWinRateT1 = (t1W / (t1W + t2W)) * 100;
    const h2hWinRateT2 = (t2W / (t1W + t2W)) * 100;
    scorePoints += (h2hWinRateT1 - h2hWinRateT2) * weights.h2h;
    factorCount++;
    h2hFactorUsed = true;
  }

  // 3. Vantagem de meta/composição (WR de campeões em pro play) — peso dinâmico (padrão 0.35)
  // compScore = diferença em pp do WR médio dos campeões: positivo = t1(blue) favorecido
  if (compScore !== null && !isNaN(compScore)) {
    scorePoints += compScore * weights.comp;
    factorCount++;
    compFactorUsed = true;
  }

  // 4. Dados ao vivo (estado do jogo) — peso extra se disponível
  if (hasLiveStats && typeof gamesContext === 'string') {
    factorCount++; // ao vivo = dado extra que a IA pode usar melhor que o ML
  }

  // Sem dados suficientes — deixa passar para a IA avaliar
  if (factorCount < 1) return { pass: true, direction: null, score: 0, t1Edge: 0, t2Edge: 0, modelP1: impliedP1, modelP2: impliedP2, impliedP1, impliedP2, factorCount: 0, factorActive: [] };

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

  // Track which factors contributed to this score
  const factorActive = [];
  if (formFactorUsed) factorActive.push('forma');
  if (h2hFactorUsed) factorActive.push('h2h');
  if (compFactorUsed) factorActive.push('comp');

  const hasComp = compScore !== null && !isNaN(compScore);

  if (hasComp) {
    // Com compScore disponível, exige edge real > 3pp
    if (maxEdge < 3.0) return { pass: false, direction: null, score: maxEdge, t1Edge, t2Edge, modelP1, modelP2, impliedP1, impliedP2, factorCount, factorActive };
    return { pass: true, direction, score: maxEdge, t1Edge, t2Edge, modelP1, modelP2, impliedP1, impliedP2, factorCount, factorActive };
  }

  // Sem compScore mas com forma+H2H (factorCount >= 2): bloqueia quando edge é fraco
  // Raciocínio: temos dados objetivos mostrando que não há vantagem real — IA não deveria apostar
  if (factorCount >= 2) {
    const MIN_EDGE_NO_COMP = parseFloat(process.env.LOL_MIN_EDGE_NO_COMP ?? '4.0') || 4.0;
    if (maxEdge < MIN_EDGE_NO_COMP) {
      return { pass: false, direction: null, score: maxEdge, t1Edge, t2Edge, modelP1, modelP2, impliedP1, impliedP2, factorCount, factorActive };
    }
  }

  // Sem dados suficientes (factorCount <= 1) ou edge > threshold: deixa a IA avaliar
  return { pass: true, direction, score: maxEdge, t1Edge, t2Edge, modelP1, modelP2, impliedP1, impliedP2, factorCount, factorActive };
}

/**
 * Estima a probabilidade de clean sweep (t1 ganha 2-0) em série Bo3/Bo5.
 * Retorna um objeto { cleanSweepP1, cleanSweepP2, score } onde:
 *   - cleanSweepP1: probabilidade de t1 ganhar 2-0 (0-1)
 *   - cleanSweepP2: probabilidade de t2 ganhar 2-0 (0-1)
 *   - score: diferença em pp (positivo = t1 favorito para clean sweep)
 */
function calcHandicapScore(match, enrich, mlOdds) {
  const safeNum = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };

  // Base: win rate recente — equipes dominantes têm mais clean sweeps
  const wr1 = safeNum(enrich?.form1?.winRate) ?? 50;
  const wr2 = safeNum(enrich?.form2?.winRate) ?? 50;
  const wrDiff = wr1 - wr2; // positivo = t1 melhor forma

  // H2H: histórico de séries — t1Wins/t2Wins já é série, não mapa
  const h2h = enrich?.h2h;
  let h2hScore = 0;
  if (h2h && (h2h.t1Wins + h2h.t2Wins) > 0) {
    const total = h2h.t1Wins + h2h.t2Wins;
    h2hScore = ((h2h.t1Wins / total) - 0.5) * 100; // -50 a +50
  }

  // ML implied probability como prior (se disponível)
  let mlImplied1 = 0.5;
  if (mlOdds?.t1 && mlOdds?.t2) {
    const r1 = 1 / parseFloat(mlOdds.t1);
    const r2 = 1 / parseFloat(mlOdds.t2);
    const or = r1 + r2;
    mlImplied1 = r1 / or;
  }

  // Clean sweep probability: favorito forte tem ~60% de 2-0, fraco tem ~35%
  // Fórmula: base de clean sweep = mlImplied^1.5 (potência amplifica a dominância)
  const baseCleanSweep1 = Math.pow(Math.max(0.1, Math.min(0.9, mlImplied1)), 1.5);
  const baseCleanSweep2 = Math.pow(Math.max(0.1, Math.min(0.9, 1 - mlImplied1)), 1.5);

  // Ajuste por forma e H2H
  const formAdjust = (wrDiff * 0.003) + (h2hScore * 0.002);

  const rawP1 = Math.max(0.05, Math.min(0.80, baseCleanSweep1 + formAdjust));
  const rawP2 = Math.max(0.05, Math.min(0.80, baseCleanSweep2 - formAdjust));

  // Normalizar
  const total = rawP1 + rawP2 + 0.2; // ~20% de empate (2-1 ambos lados, não clean sweep)
  const cleanSweepP1 = rawP1 / total;
  const cleanSweepP2 = rawP2 / total;

  const score = (cleanSweepP1 - cleanSweepP2) * 100;

  return { cleanSweepP1, cleanSweepP2, score };
}

/**
 * Estima a probabilidade do t1 conseguir o primeiro dragão/barão/torre
 * baseado nos win rates de campeões em pro play.
 *
 * @param {Array} champStats - Array de { champion, role, wins, total, first_dragon_wr, first_baron_wr }
 * @param {Array} t1Champs - ['Wukong', 'Zyra', ...] (campeões do t1, até 5)
 * @param {Array} t2Champs - campeões do t2
 * @param {string} objective - 'dragon' | 'baron' | 'tower'
 * @returns {{ p1, p2, edge, hasData }}
 */
function calcObjectiveScore(champStats, t1Champs, t2Champs, objective = 'dragon') {
  if (!Array.isArray(champStats) || !champStats.length) {
    return { p1: 0.5, p2: 0.5, edge: 0, hasData: false };
  }

  const wrField = objective === 'baron' ? 'first_baron_wr' : 'first_dragon_wr';

  const getAvgObjWr = (champs) => {
    if (!Array.isArray(champs) || !champs.length) return null;
    const stats = champs
      .map(c => champStats.find(s => s.champion?.toLowerCase() === c?.toLowerCase()))
      .filter(s => s && s[wrField] != null && s.total > 5);
    if (!stats.length) return null;
    return stats.reduce((sum, s) => sum + s[wrField], 0) / stats.length;
  };

  const wr1 = getAvgObjWr(t1Champs);
  const wr2 = getAvgObjWr(t2Champs);

  if (wr1 === null && wr2 === null) return { p1: 0.5, p2: 0.5, edge: 0, hasData: false };

  const p1Raw = wr1 ?? 50;
  const p2Raw = wr2 ?? 50;
  const total = p1Raw + p2Raw;
  const p1 = total > 0 ? p1Raw / total : 0.5;
  const p2 = 1 - p1;
  const edge = (p1 - 0.5) * 100;

  return { p1, p2, edge: Math.round(edge * 10) / 10, hasData: true };
}

/**
 * Estima probabilidade de método de vitória em MMA.
 *
 * @param {Object} f1Stats - { koRate, subRate, decisionRate, slpm, strAcc, strDef, tdDef }
 * @param {Object} f2Stats - mesmos campos do oponente
 * @returns {{ ko_tko, submission, decision, confidence }}
 *   ko_tko: prob de vitória por KO/TKO (qualquer side)
 *   submission: prob de vitória por Finalização
 *   decision: prob de ir a Decisão
 *   confidence: 'high' | 'medium' | 'low' baseado em quantidade de dados
 */
function calcMethodScore(f1Stats, f2Stats) {
  const s = (v, fallback = 0) => { const n = parseFloat(v); return isNaN(n) ? fallback : n; };

  // Taxas históricas de método (média histórica UFC para calibração)
  const BASE_KO  = 0.33;
  const BASE_SUB = 0.18;
  const BASE_DEC = 0.49;

  // Finishing rate dos lutadores
  const f1KoRate  = s(f1Stats?.koRate,  BASE_KO);
  const f1SubRate = s(f1Stats?.subRate, BASE_SUB);
  const f2KoRate  = s(f2Stats?.koRate,  BASE_KO);
  const f2SubRate = s(f2Stats?.subRate, BASE_SUB);

  // KO/TKO: striker dominante vs defesa fraca de striking
  // Fator: se f1 é striker (alta slpm, acc>45%) e f2 tem strDef < 55%, KO mais provável
  const f1Slpm   = s(f1Stats?.slpm, 3.0);
  const f2Slpm   = s(f2Stats?.slpm, 3.0);
  const f1StrAcc = s(f1Stats?.strAcc, 0.43);
  const f2StrDef = s(f2Stats?.strDef, 0.57);
  const f1StrDef = s(f1Stats?.strDef, 0.57);
  const f2StrAcc = s(f2Stats?.strAcc, 0.43);

  // Strike pressure do f1 contra defesa do f2
  const strikerPressure1 = (f1Slpm / 5.0) * (f1StrAcc / 0.43) * ((1 - f2StrDef) / 0.43);
  const strikerPressure2 = (f2Slpm / 5.0) * (f2StrAcc / 0.43) * ((1 - f1StrDef) / 0.43);
  const avgStrikePressure = (strikerPressure1 + strikerPressure2) / 2;

  // Submission: grappler vs fraca defesa de takedown
  const f1TdDef = s(f1Stats?.tdDef, 0.63);
  const f2TdDef = s(f2Stats?.tdDef, 0.63);
  const avgSubThreat = ((f1SubRate + f2SubRate) / 2) * (1 + (1 - f1TdDef) * 0.5 + (1 - f2TdDef) * 0.5);

  // Combinar taxas históricas com indicadores de matchup
  const koAdjust  = BASE_KO  * avgStrikePressure;
  const subAdjust = BASE_SUB * Math.min(2.0, avgSubThreat / BASE_SUB);

  let ko_tko     = Math.max(0.10, Math.min(0.60, (f1KoRate + f2KoRate) / 2 * 0.6 + koAdjust * 0.4));
  let submission = Math.max(0.05, Math.min(0.40, (f1SubRate + f2SubRate) / 2 * 0.6 + subAdjust * 0.4));
  let decision   = Math.max(0.20, 1 - ko_tko - submission);

  // Renormalizar
  const total = ko_tko + submission + decision;
  ko_tko     = ko_tko / total;
  submission = submission / total;
  decision   = decision / total;

  // Confidence baseada em quantidade de dados disponíveis
  const dataFields = [f1Stats?.koRate, f1Stats?.slpm, f2Stats?.koRate, f2Stats?.slpm].filter(v => v != null);
  const confidence = dataFields.length >= 4 ? 'high' : dataFields.length >= 2 ? 'medium' : 'low';

  return {
    ko_tko:     Math.round(ko_tko     * 1000) / 1000,
    submission: Math.round(submission * 1000) / 1000,
    decision:   Math.round(decision   * 1000) / 1000,
    confidence
  };
}

module.exports = { esportsPreFilter, calcHandicapScore, calcObjectiveScore, calcMethodScore };

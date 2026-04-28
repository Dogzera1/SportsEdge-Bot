'use strict';

/**
 * lol-kills-model.js — Predict total kills per map em LoL pro.
 *
 * Premissa: kills é Poisson-distributed com λ = soma das médias per-player.
 * Casas geralmente usam fórmula simples (média liga × 1.05 boost), então
 * modelo player-level captura edge quando teams têm KDA divergente do average.
 *
 * Uso:
 *   const { predictMapKills } = require('./lol-kills-model');
 *   const result = predictMapKills(team1Stats, team2Stats);
 *   // result = { lambda, pOver(line), pUnder(line), pPush(line) }
 *
 * Caveats:
 *   - Poisson assume variância = média (LoL pro empírico σ ≈ √μ × 1.1, ok)
 *   - Não modela meta shifts (champ pool change, patch impacto)
 *   - Pesquisa: kills LoL pro game 2024 média 26-32, std 6-8
 */

// CDF Poisson via série truncada (suficiente até λ ~50)
function _poissonCdf(k, lambda) {
  if (lambda <= 0) return k >= 0 ? 1 : 0;
  if (k < 0) return 0;
  let s = 0;
  let term = Math.exp(-lambda); // P(X=0)
  s += term;
  for (let i = 1; i <= k; i++) {
    term = term * lambda / i; // P(X=i) = P(X=i-1) * λ / i
    s += term;
  }
  return Math.min(1, s);
}

function _poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let term = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) term = term * lambda / i;
  return term;
}

/**
 * Soma kills médios per-player. Cada jogador tem kills (média per-game últimos 60d).
 * @param {object} rosterStats — output de getTeamRosterStats
 * @returns {number|null} soma kills média ou null se sample insuficiente
 */
function _sumRosterKills(rosterStats) {
  if (!rosterStats || !rosterStats.roster) return null;
  let sum = 0, count = 0;
  for (const pos of Object.values(rosterStats.roster)) {
    if (pos && Number.isFinite(pos.kills)) { sum += pos.kills; count++; }
  }
  if (count < 3) return null; // precisa pelo menos 3 jogadores com stats
  // Se faltam 1-2 players, extrapola pra 5 (médias do que tem)
  if (count < 5) sum = sum * (5 / count);
  return sum;
}

// League baselines empíricos (kills/game médios LoL pro 2024-2025).
// Usado pra escalar λ player-aggregated quando contexto é fora do baseline médio.
// Conservative — aplicado como multiplicador suave (max ±10%).
const LEAGUE_KILLS_BASELINE = {
  LCK: 24.5, LPL: 30.5, LEC: 27.0, LCS: 28.5, LTA: 28.0,
  CBLOL: 28.5, VCS: 31.0, PCS: 28.0, LJL: 27.0, LLA: 28.0,
  // International (2024 worlds avg ~26-28)
  Worlds: 27.0, MSI: 27.5, EWC: 28.0,
  // Tier 2
  EMEA_MASTERS: 28.0, NACL: 28.5, LCK_CL: 25.0, LDL: 30.0,
  __default: 28.0,
};

function _normLeague(name) {
  const s = String(name || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (s.includes('LCKCHALLENGER') || s === 'LCKCL') return 'LCK_CL';
  if (s.includes('EMEAMASTER')) return 'EMEA_MASTERS';
  if (s.includes('NACL') || s.includes('NORTHAMERICAN') && s.includes('CHALLENGER')) return 'NACL';
  if (s.includes('WORLDS') || s.includes('WORLDCHAMPIONSHIP')) return 'Worlds';
  if (s.includes('MIDSEASON') || s === 'MSI') return 'MSI';
  if (s.includes('ESPORTSWORLDCUP') || s === 'EWC') return 'EWC';
  for (const k of ['LCK', 'LPL', 'LEC', 'LCS', 'LTA', 'CBLOL', 'VCS', 'PCS', 'LJL', 'LLA', 'LDL']) {
    if (s.includes(k)) return k;
  }
  return null;
}

/**
 * Predict total kills per map. Retorna λ + funções de probabilidade.
 * @param {object} t1Stats — getTeamRosterStats(team1)
 * @param {object} t2Stats — getTeamRosterStats(team2)
 * @param {object} [opts]
 * @param {string} [opts.league] — nome da liga pra ajuste de baseline
 * @param {boolean} [opts.team1IsBlue] — true se team1 está blue side (HLTV blue tem ~+0.5 kills boost)
 * @returns {object|null} { lambda, pOver, pUnder, pPush, confidence } ou null
 */
function predictMapKills(t1Stats, t2Stats, opts = {}) {
  const k1 = _sumRosterKills(t1Stats);
  const k2 = _sumRosterKills(t2Stats);
  if (k1 == null || k2 == null) return null;
  let lambda = k1 + k2;
  if (lambda < 10 || lambda > 60) return null; // out-of-distribution = unreliable

  // ── League baseline adjustment ──
  // Player-aggregated λ pode discordar do baseline real da liga. Aplica shrinkage
  // suave em direção ao baseline (peso 0.20 do baseline, 0.80 do agregado).
  // Exemplo: LCK baseline 24.5 + λ_player 28 → λ_adj = 28*0.8 + 24.5*0.2 = 27.3 (-2.5%)
  // Cap conservative: shift máximo ±10% do λ original.
  let leagueShiftPct = 0;
  const leagueKey = _normLeague(opts.league);
  if (leagueKey && LEAGUE_KILLS_BASELINE[leagueKey]) {
    const baseline = LEAGUE_KILLS_BASELINE[leagueKey];
    const blendWeight = parseFloat(process.env.LOL_KILLS_LEAGUE_BLEND ?? '0.20');
    const adjusted = lambda * (1 - blendWeight) + baseline * blendWeight;
    const shift = adjusted - lambda;
    const maxShift = lambda * 0.10;
    const clampedShift = Math.max(-maxShift, Math.min(maxShift, shift));
    lambda = +(lambda + clampedShift).toFixed(2);
    leagueShiftPct = +(clampedShift / (lambda - clampedShift) * 100).toFixed(1);
  }

  // ── Blue side advantage ──
  // Empirical LoL pro: blue side ~+0.4-0.6 kills (early game vision priority + objectives).
  // Quando team1IsBlue é null/undefined, sem ajuste (neutro).
  const blueBoost = parseFloat(process.env.LOL_KILLS_BLUE_BOOST ?? '0.5');
  if (typeof opts.team1IsBlue === 'boolean' && Number.isFinite(blueBoost) && blueBoost > 0) {
    // O modelo prevê SOMA de kills (não diff). Side advantage não muda total esperado
    // significativamente — adiciona delta pequeno ao λ porque blue side tipicamente
    // FORÇA mais teamfights (vision priority + drake control). Empirical: +0.3-0.5 total kills.
    lambda = +(lambda + blueBoost).toFixed(2);
  }

  // ── Map index specific scaling ──
  // Mapa 1: clean games, padrão da liga. Mapa 2: ajuste de meta após mapa 1
  // (perdedor adapta, ligeiramente +kills). Mapa 3 (decisivo): tendência
  // a games mais cuidadosos pré-late OR mais explosivos quando time fav joga
  // pra fechar — net empirical -3% kills (medos). Mapas 4-5 raros (Bo5).
  // Default scales: 1.0 / 1.02 / 0.97 / 1.0 / 1.0. Override por env.
  if (Number.isFinite(opts.mapIndex)) {
    const mapKey = `LOL_KILLS_MAP${opts.mapIndex}_FACTOR`;
    const defaults = { 1: 1.00, 2: 1.02, 3: 0.97, 4: 1.0, 5: 1.0 };
    const factor = parseFloat(process.env[mapKey]) || defaults[opts.mapIndex] || 1.0;
    if (factor !== 1.0) {
      lambda = +(lambda * factor).toFixed(2);
    }
  }

  // Confidence baseado em variance dos KDAs (rosters mais consistentes = previsão mais firme)
  const v1 = t1Stats?.kdaVar ?? 1;
  const v2 = t2Stats?.kdaVar ?? 1;
  const conf = Math.max(0.3, Math.min(0.9, 1 - (v1 + v2) / 8));

  return {
    lambda: +lambda.toFixed(2),
    leagueShiftPct,
    leagueKey,
    pOver(line) {
      // Pinnacle line geralmente é X.5, então P(over X.5) = 1 - CDF(X) = 1 - P(X ≤ X)
      const intLine = Math.floor(line);
      return +(1 - _poissonCdf(intLine, lambda)).toFixed(4);
    },
    pUnder(line) {
      const intLine = Math.floor(line);
      return +_poissonCdf(intLine, lambda).toFixed(4);
    },
    pPush(line) {
      // X.5 lines não tem push. Inteiros sim.
      if (Math.floor(line) !== line) return 0;
      return +_poissonPmf(line, lambda).toFixed(4);
    },
    confidence: +conf.toFixed(2),
  };
}

/**
 * Predict kills inflight (durante mapa em andamento). Reescala λ_full pelo
 * tempo restante e adiciona kills atuais como baseline fixo.
 *
 * @param {object} t1Stats — getTeamRosterStats(team1)
 * @param {object} t2Stats — getTeamRosterStats(team2)
 * @param {object} opts — mesmo de predictMapKills (league, team1IsBlue, mapIndex)
 * @param {object} liveState — { gameTimeSeconds, currentKillsTotal }
 * @returns {object|null} { lambda (residual), pOver, pUnder, ... }
 */
function predictMapKillsLive(t1Stats, t2Stats, opts = {}, liveState = {}) {
  const baseline = predictMapKills(t1Stats, t2Stats, opts);
  if (!baseline) return null;

  const { gameTimeSeconds, currentKillsTotal } = liveState;
  if (!Number.isFinite(gameTimeSeconds) || gameTimeSeconds < 0) return null;
  if (!Number.isFinite(currentKillsTotal) || currentKillsTotal < 0) return null;

  // LoL pro avg game ~32 min (1920s). Override via env.
  const avgGameSeconds = parseFloat(process.env.LOL_AVG_GAME_SECONDS ?? '1920');
  const fraction = Math.max(0, Math.min(1, 1 - gameTimeSeconds / avgGameSeconds));
  const lambdaResid = baseline.lambda * fraction;

  return {
    lambda: +lambdaResid.toFixed(2),
    lambdaFull: baseline.lambda,
    fraction: +fraction.toFixed(3),
    currentKills: currentKillsTotal,
    gameTimeSeconds,
    isLive: true,
    leagueShiftPct: baseline.leagueShiftPct,
    leagueKey: baseline.leagueKey,
    pOver(line) {
      // P(final > line) onde final = currentKills + Poisson(lambdaResid)
      // = P(Poisson(lambdaResid) > line - currentKills)
      const need = line - currentKillsTotal; // X.5 line
      if (need <= 0) return 1; // line já bateu
      const intNeed = Math.floor(need); // P(X > intNeed) = 1 - CDF(intNeed)
      return +(1 - _poissonCdf(intNeed, lambdaResid)).toFixed(4);
    },
    pUnder(line) {
      const need = line - currentKillsTotal;
      if (need <= 0) return 0;
      const intNeed = Math.floor(need);
      return +_poissonCdf(intNeed, lambdaResid).toFixed(4);
    },
    pPush(line) {
      if (Math.floor(line) !== line) return 0;
      const need = line - currentKillsTotal;
      if (need < 0) return 0;
      return +_poissonPmf(need, lambdaResid).toFixed(4);
    },
    confidence: baseline.confidence,
  };
}

/**
 * Scan pinnacle totals e retorna tips de kills com EV positivo.
 * @param {object} args { pinTotals, predict, minEv = 5, minPModel = 0.55 }
 * @returns {Array} tips
 */
function scanKillsMarkets({ pinTotals, predict, minEv = 5, maxEv = 30, minPModel = 0.55, maxPModel = 0.90, minOdd = 1.50, maxOdd = 3.50 } = {}) {
  // BUG FIX (audit 2026-04-25): modelo Poisson com lambda from player KDA agregado
  // pode discordar fortemente de Pinnacle line quando matchup é atypical (rosters
  // atualizados não capturados em OE, meta shift, etc). EV >30% ou pModel >90% =
  // modelo discordando demais de Pinnacle = red-flag de overconfidence.
  // Cap default: maxEv=30, maxPModel=0.90.
  if (!Array.isArray(pinTotals) || !predict) return [];
  const tips = [];
  for (const t of pinTotals) {
    const line = parseFloat(t.line ?? t.points);
    const oddOver = parseFloat(t.oddsOver ?? t.over);
    const oddUnder = parseFloat(t.oddsUnder ?? t.under);
    if (!Number.isFinite(line)) continue;

    if (Number.isFinite(oddOver) && oddOver >= minOdd && oddOver <= maxOdd) {
      const p = predict.pOver(line);
      if (p >= minPModel && p <= maxPModel) {
        const ev = (p * oddOver - 1) * 100;
        if (ev >= minEv && ev <= maxEv) {
          tips.push({
            market: 'total_kills', side: 'over', line, odd: oddOver,
            pModel: p, pImplied: 1 / oddOver, ev: +ev.toFixed(2),
            label: `Over ${line} kills`,
          });
        }
      }
    }
    if (Number.isFinite(oddUnder) && oddUnder >= minOdd && oddUnder <= maxOdd) {
      const p = predict.pUnder(line);
      if (p >= minPModel && p <= maxPModel) {
        const ev = (p * oddUnder - 1) * 100;
        if (ev >= minEv && ev <= maxEv) {
          tips.push({
            market: 'total_kills', side: 'under', line, odd: oddUnder,
            pModel: p, pImplied: 1 / oddUnder, ev: +ev.toFixed(2),
            label: `Under ${line} kills`,
          });
        }
      }
    }
  }
  return tips.sort((a, b) => b.ev - a.ev);
}

module.exports = { predictMapKills, predictMapKillsLive, scanKillsMarkets, _poissonCdf, _poissonPmf };

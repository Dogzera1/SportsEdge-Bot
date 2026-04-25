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

/**
 * Predict total kills per map. Retorna λ + funções de probabilidade.
 * @param {object} t1Stats — getTeamRosterStats(team1)
 * @param {object} t2Stats — getTeamRosterStats(team2)
 * @returns {object|null} { lambda, pOver, pUnder, pPush, confidence } ou null
 */
function predictMapKills(t1Stats, t2Stats) {
  const k1 = _sumRosterKills(t1Stats);
  const k2 = _sumRosterKills(t2Stats);
  if (k1 == null || k2 == null) return null;
  const lambda = k1 + k2;
  if (lambda < 10 || lambda > 60) return null; // out-of-distribution = unreliable

  // Confidence baseado em variance dos KDAs (rosters mais consistentes = previsão mais firme)
  const v1 = t1Stats?.kdaVar ?? 1;
  const v2 = t2Stats?.kdaVar ?? 1;
  const conf = Math.max(0.3, Math.min(0.9, 1 - (v1 + v2) / 8));

  return {
    lambda: +lambda.toFixed(2),
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

module.exports = { predictMapKills, scanKillsMarkets, _poissonCdf, _poissonPmf };

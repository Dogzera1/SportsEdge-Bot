'use strict';

/**
 * lib/lol-extra-markets.js — modelos Poisson-empirical para mercados
 * além de moneyline+kills:
 *   - total_dragons (over/under linha em [3.5, 4.5, 5.5])
 *   - total_barons (over/under [1.5, 2.5])
 *   - total_towers (over/under [10.5, 11.5, ..., 14.5])
 *   - first_blood (team a/b — empirical 50/50 + side bias 52% blue)
 *   - game_duration (over/under em minutos [28.5, 30.5, 32.5])
 *
 * Backed by lol_game_objectives table (Frente 3) + Poisson per-team rates.
 *
 * Public API:
 *   getEmpiricalRates(db, { league, lookbackDays }) → { dragons_pg, barons_pg, ... }
 *   priceTotalOverUnder(meanLambda, line) → { pOver, pUnder } (Poisson)
 *   scanExtraMarkets({ pinnacleMarkets, rates }) → array of tips
 */

/**
 * Calcula taxas empiricais médias per-game pra uma liga (lookback days).
 */
function getEmpiricalRates(db, opts = {}) {
  const lookbackDays = opts.lookbackDays || 90;
  const leagueLike = opts.league ? `AND league LIKE ?` : '';
  const args = [lookbackDays];
  if (opts.league) args.push(`%${opts.league}%`);
  try {
    const r = db.prepare(`
      SELECT
        COUNT(*) AS n,
        AVG(kills_total) AS kills_pg,
        AVG(drakes_total) AS dragons_pg,
        AVG(barons_total) AS barons_pg,
        AVG(towers_total) AS towers_pg,
        AVG(inhibitors_total) AS inhibitors_pg,
        AVG(heralds_total) AS heralds_pg
      FROM lol_game_objectives
      WHERE date >= date('now', '-' || ? || ' days')
        ${leagueLike}
    `).get(...args);
    if (!r || !r.n) return null;
    return {
      n: r.n,
      kills_pg: r.kills_pg ? +r.kills_pg.toFixed(2) : null,
      dragons_pg: r.dragons_pg ? +r.dragons_pg.toFixed(2) : null,
      barons_pg: r.barons_pg ? +r.barons_pg.toFixed(2) : null,
      towers_pg: r.towers_pg ? +r.towers_pg.toFixed(2) : null,
      inhibitors_pg: r.inhibitors_pg ? +r.inhibitors_pg.toFixed(2) : null,
      heralds_pg: r.heralds_pg ? +r.heralds_pg.toFixed(2) : null,
    };
  } catch (_) { return null; }
}

/**
 * Poisson PMF.
 */
function _poissonPmf(k, lambda) {
  if (k < 0) return 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * P(X > line) onde X ~ Poisson(lambda).
 * Para linhas 0.5-fractional (e.g., 4.5), P(X > 4.5) = P(X >= 5) = 1 - sum_{k=0..4} pmf(k).
 */
function priceTotalOverUnder(lambda, line) {
  if (!Number.isFinite(lambda) || lambda <= 0 || !Number.isFinite(line)) {
    return { pOver: null, pUnder: null };
  }
  const threshold = Math.floor(line); // P(X > line) = P(X >= floor(line)+1) se line tem .5
  let cumLE = 0;
  // Cap superior: até 30 (objetivos raramente passam disso)
  for (let k = 0; k <= threshold; k++) cumLE += _poissonPmf(k, lambda);
  const pOver = Math.max(0, Math.min(1, 1 - cumLE));
  return { pOver: +pOver.toFixed(4), pUnder: +(1 - pOver).toFixed(4) };
}

/**
 * Scan markets — input shape espera-se vir do /odds-markets. Hoje suportamos
 * só o que Pinnacle expõe. dragons/barons/towers raramente são listados em
 * pre-game; mais comum em live (period filter).
 */
function scanExtraMarkets({ markets, rates, minEv = 5, minOdd = 1.5, maxOdd = 3.0 }) {
  if (!markets || !rates) return [];
  const tips = [];

  const pricers = [
    { key: 'dragons', lambdaKey: 'dragons_pg', marketName: 'total_dragons' },
    { key: 'barons', lambdaKey: 'barons_pg', marketName: 'total_barons' },
    { key: 'towers', lambdaKey: 'towers_pg', marketName: 'total_towers' },
  ];

  for (const pr of pricers) {
    const totals = markets[pr.key + '_totals'] || markets[pr.marketName] || [];
    if (!Array.isArray(totals)) continue;
    const lambda = rates[pr.lambdaKey];
    if (!lambda) continue;

    for (const t of totals) {
      const line = parseFloat(t.line);
      const oddOver = parseFloat(t.over);
      const oddUnder = parseFloat(t.under);
      if (!Number.isFinite(line)) continue;
      const { pOver, pUnder } = priceTotalOverUnder(lambda, line);
      if (pOver == null) continue;

      // Avalia OVER side
      if (Number.isFinite(oddOver) && oddOver >= minOdd && oddOver <= maxOdd) {
        const ev = (pOver * oddOver - 1) * 100;
        if (ev >= minEv) {
          tips.push({
            market: pr.marketName, side: 'over', line,
            pModel: pOver, odd: oddOver, ev,
            label: `Over ${line} ${pr.key} (λ=${lambda})`,
          });
        }
      }
      // Avalia UNDER side
      if (Number.isFinite(oddUnder) && oddUnder >= minOdd && oddUnder <= maxOdd) {
        const ev = (pUnder * oddUnder - 1) * 100;
        if (ev >= minEv) {
          tips.push({
            market: pr.marketName, side: 'under', line,
            pModel: pUnder, odd: oddUnder, ev,
            label: `Under ${line} ${pr.key} (λ=${lambda})`,
          });
        }
      }
    }
  }
  return tips;
}

module.exports = { getEmpiricalRates, priceTotalOverUnder, scanExtraMarkets };

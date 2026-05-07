'use strict';

/**
 * dota-extras-scanner.js — scanner de mercados Dota2 além de ML/handicap:
 *   - Total kills por mapa (over/under)
 *   - Duration do mapa em minutos (over/under)
 *
 * Pricing: distribuição Normal aproximada sobre médias pro scene recentes.
 *   - Kills/map: μ≈50, σ≈14  (Dota 7.38, big games)
 *   - Duration/map: μ≈38, σ≈8 min
 *
 * Essas médias são defaults conservadores. Idealmente cada pricing é ajustado
 * pela intensidade prevista da série (draft aggressive vs late-scale). Por ora,
 * usamos defaults globais — logShadow captura CLV pra calibrar depois.
 *
 * Integra com /odds-markets?period=N (1..5 = map N) pra buscar linhas Pinnacle.
 */

// 2026-05-06 FIX: usar devigEnsemble (auto power/Shin) — Dota extras
// (kills/duration) tem variância alta entre lados; multiplicativo enviesava
// EV em underdog longshot.
const { devigEnsemble } = require('./devig');

const DEFAULTS = {
  KILLS_MEAN: 50,
  KILLS_STD: 14,
  DURATION_MEAN_MIN: 38,
  DURATION_STD_MIN: 8,
};

// Approx Φ(z) = (1 + erf(z/√2))/2. erf aprox Abramowitz-Stegun 7.1.26.
function _erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}
function _normCdf(x, mu, sigma) {
  const z = (x - mu) / (sigma || 1);
  return 0.5 * (1 + _erf(z / Math.SQRT2));
}

function _ev(pModel, odd) {
  if (!Number.isFinite(pModel) || !Number.isFinite(odd) || odd <= 1) return null;
  return (pModel * odd - 1) * 100;
}

function _dejuice2way(a, b) {
  const r = devigEnsemble(a, b);
  return r ? { pA: r.p1, pB: r.p2 } : null;
}

/**
 * Classifica o tipo de total pelo valor da linha (heurística):
 *   - ≤ 5.5  → total de mapas da série (já tratado por scanMarkets genérico)
 *   - 15-99  → total de kills por mapa
 *   - 25-80 e (era duração) → ambíguo; preferência vai pra kills se ≥30
 * Pinnacle Dota separa por period: period=1..5 é MAP N (kills e duration).
 */
function _classifyLine(line) {
  const L = Number(line);
  if (!Number.isFinite(L)) return null;
  if (L <= 5.5) return 'maps';
  if (L >= 15 && L <= 99) return 'kills';
  return null;
}

/**
 * Varre totals de mapa N (period=1..5) pra achar tips de kills over/under.
 *
 * @param {object} args
 * @param {Array}  args.totals  — [{ line, oddsOver, oddsUnder, period }]
 * @param {number} args.mapNumber — map N (1..5)
 * @param {object} [args.tuning] — { killsMean, killsStd }
 * @param {number} [args.minEv=4]
 * @returns {Array<{market, line, side, pModel, pImplied, odd, ev, label, mapNumber}>}
 */
function scanKills({ totals, mapNumber, tuning = {}, minEv = 4 }) {
  const mu  = Number(tuning.killsMean) || DEFAULTS.KILLS_MEAN;
  const sig = Number(tuning.killsStd)  || DEFAULTS.KILLS_STD;
  const tips = [];
  for (const t of (totals || [])) {
    if (_classifyLine(t.line) !== 'kills') continue;
    const pUnder = _normCdf(Number(t.line), mu, sig);
    const pOver  = 1 - pUnder;
    const dj = _dejuice2way(t.oddsOver, t.oddsUnder);
    const evO = _ev(pOver,  t.oddsOver);
    const evU = _ev(pUnder, t.oddsUnder);
    if (evO != null && evO >= minEv) {
      tips.push({
        market: 'totalKills', line: t.line, side: 'over', mapNumber,
        pModel: +pOver.toFixed(4),
        pImplied: dj ? +dj.pA.toFixed(4) : null,
        odd: t.oddsOver, ev: +evO.toFixed(2),
        label: `Over ${t.line} kills (map ${mapNumber})`,
      });
    }
    if (evU != null && evU >= minEv) {
      tips.push({
        market: 'totalKills', line: t.line, side: 'under', mapNumber,
        pModel: +pUnder.toFixed(4),
        pImplied: dj ? +dj.pB.toFixed(4) : null,
        odd: t.oddsUnder, ev: +evU.toFixed(2),
        label: `Under ${t.line} kills (map ${mapNumber})`,
      });
    }
  }
  return tips;
}

/**
 * Varre totals de duração (em minutos) quando Pinnacle expõe.
 * Heurística: linha entre 25-50 min = duration (kills seria >15 mas tipicamente ≥40).
 * Para reduzir falsos positivos, exige period ≥ 1 (map-scoped) e meta marcando duration.
 *
 * Obs: Pinnacle não padroniza label "duration" em `/odds-markets`; essa fn só
 * dispara quando chamador explicita totals de duration (via getMatchupMarkets
 * filtrado por m.type === 'total' com `units` minutos, se disponível).
 */
function scanDuration({ totals, mapNumber, tuning = {}, minEv = 4, maxEv = 25 }) {
  // BUG FIX: modelo é static (mu=38, sig=8) — não ajusta por matchup. Pinnacle line
  // varia per-match (35-55min). Quando Pinnacle line >> mu (ex 47.5 vs 38), model
  // diz P(under)=88% mas Pinnacle pricing implica ~42% — modelo overconfident.
  // EV >25% é red-flag: modelo discordando muito de Pinnacle indica modelo errado,
  // não edge real. Cap maxEv default 25%.
  const mu  = Number(tuning.durationMeanMin) || DEFAULTS.DURATION_MEAN_MIN;
  const sig = Number(tuning.durationStdMin)  || DEFAULTS.DURATION_STD_MIN;
  const tips = [];
  for (const t of (totals || [])) {
    const L = Number(t.line);
    if (!(L >= 20 && L <= 55)) continue;
    const pUnder = _normCdf(L, mu, sig);
    const pOver  = 1 - pUnder;
    const dj = _dejuice2way(t.oddsOver, t.oddsUnder);
    const evO = _ev(pOver,  t.oddsOver);
    const evU = _ev(pUnder, t.oddsUnder);
    if (evO != null && evO >= minEv && evO <= maxEv) {
      tips.push({
        market: 'duration', line: L, side: 'over', mapNumber,
        pModel: +pOver.toFixed(4),
        pImplied: dj ? +dj.pA.toFixed(4) : null,
        odd: t.oddsOver, ev: +evO.toFixed(2),
        label: `Over ${L}min (map ${mapNumber})`,
      });
    }
    if (evU != null && evU >= minEv && evU <= maxEv) {
      tips.push({
        market: 'duration', line: L, side: 'under', mapNumber,
        pModel: +pUnder.toFixed(4),
        pImplied: dj ? +dj.pB.toFixed(4) : null,
        odd: t.oddsUnder, ev: +evU.toFixed(2),
        label: `Under ${L}min (map ${mapNumber})`,
      });
    }
  }
  return tips;
}

module.exports = { scanKills, scanDuration, DEFAULTS };

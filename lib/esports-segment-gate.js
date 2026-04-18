'use strict';

/**
 * esports-segment-gate.js — decide se um match esports cai em segmento onde
 * o modelo é comprovadamente fraco, baseado em backtest per-(tier × bestOf).
 *
 * Política baseada em data/{game}-backtest-per-segment.json (scripts/backtest-esports-per-segment.js):
 *   - Segmentos com Brier > 0.25 → SKIP (noise puro, model não funciona)
 *   - Segmentos com Brier 0.24-0.25 → edge bonus +3pp (exige margem extra)
 *   - Outros → passa normal
 *
 * Fallback: ENV override pra ajuste fino sem mexer no código.
 *   ESPORTS_SEGMENT_GATE_OFF=true  — desativa todos os gates
 *   {GAME}_SEGMENT_GATE_OFF=true   — desativa um sport
 */

const { leagueTier, parseBestOf } = require('./esports-runtime-features');

// Policy table: hard-coded baseado em backtest 2026-04-18.
// Estrutura: { [game]: { [tierKey]: { [boKey]: { skip: bool, minEdgeBonus: number, brier: number } } } }
const POLICY = {
  valorant: {
    tier1: { Bo1: { skip: false, minEdgeBonus: 0, brier: 0.218 },
             Bo3: { skip: false, minEdgeBonus: 0, brier: 0.221 },
             Bo5: { skip: false, minEdgeBonus: 0, brier: 0.235 } },
    tier2: { Bo1: { skip: true,  minEdgeBonus: 0, brier: 0.255, reason: 'Valorant tier2 Bo1 Brier 0.255 (noise)' },
             Bo3: { skip: true,  minEdgeBonus: 0, brier: 0.278, reason: 'Valorant tier2 Bo3 Brier 0.278 (noise puro)' },
             Bo5: { skip: false, minEdgeBonus: 2, brier: 0.222 } },
    // Tier3 (fallback quando leagueTier não reconhece) — leniente, sem skip
    tier3: { Bo1: { skip: false, minEdgeBonus: 2, brier: 0.25, reason: 'Valorant tier3 (sinal fraco do regex)' },
             Bo3: { skip: false, minEdgeBonus: 2, brier: 0.25, reason: 'Valorant tier3 (sinal fraco do regex)' },
             Bo5: { skip: false, minEdgeBonus: 1, brier: 0.22 } },
  },
  cs2: {
    tier1: { Bo1: { skip: false, minEdgeBonus: 1, brier: 0.231 },
             Bo3: { skip: false, minEdgeBonus: 0, brier: 0.216 },
             Bo5: { skip: false, minEdgeBonus: 0, brier: 0.214 } },
    tier2: { Bo1: { skip: false, minEdgeBonus: 3, brier: 0.242, reason: 'CS2 tier2 Bo1 Brier 0.242' },
             Bo3: { skip: false, minEdgeBonus: 1, brier: 0.229 },
             Bo5: { skip: false, minEdgeBonus: 3, brier: 0.244, reason: 'CS2 tier2 Bo5 Brier 0.244' } },
  },
  dota2: {
    tier1: { Bo1: { skip: false, minEdgeBonus: 0, brier: 0.225 },
             Bo2: { skip: false, minEdgeBonus: 0, brier: 0.196 },  // sweet spot
             Bo3: { skip: false, minEdgeBonus: 0, brier: 0.233 },
             Bo5: { skip: false, minEdgeBonus: 0, brier: 0.225 } },
    tier2: { Bo1: { skip: false, minEdgeBonus: 0, brier: 0.220 },
             Bo2: { skip: false, minEdgeBonus: 0, brier: 0.188 },  // sweet spot extremo
             Bo3: { skip: false, minEdgeBonus: 0, brier: 0.238 },
             Bo5: { skip: false, minEdgeBonus: 2, brier: 0.241 } },
  },
  lol: {
    tier1: { Bo1: { skip: false, minEdgeBonus: 0, brier: 0.22 },
             Bo3: { skip: false, minEdgeBonus: 0, brier: 0.22 },
             Bo5: { skip: false, minEdgeBonus: 0, brier: 0.20 } },
    tier2: { Bo1: { skip: false, minEdgeBonus: 1, brier: 0.23 },
             Bo3: { skip: false, minEdgeBonus: 1, brier: 0.23 },
             Bo5: { skip: false, minEdgeBonus: 1, brier: 0.23 } },
  },
};

/**
 * @param {string} game - 'lol' | 'dota2' | 'cs2' | 'valorant'
 * @param {string} league - nome da liga pra derivar tier
 * @param {number|string} bestOfOrFormat - bestOf numérico ou string 'Bo3'
 * @returns {{ skip: boolean, minEdgeBonus: number, reason: string|null, tier: number, bestOf: number }}
 */
function esportsSegmentGate(game, league, bestOfOrFormat) {
  const g = String(game || '').toLowerCase();
  if (process.env.ESPORTS_SEGMENT_GATE_OFF === 'true') {
    return { skip: false, minEdgeBonus: 0, reason: null, tier: null, bestOf: null };
  }
  if (process.env[`${g.toUpperCase()}_SEGMENT_GATE_OFF`] === 'true') {
    return { skip: false, minEdgeBonus: 0, reason: null, tier: null, bestOf: null };
  }
  // leagueTier retorna 3=top (LCK/LPL/Majors), 2=mid (Challengers/tier-2), 1=other/obscuro
  // Invertemos pra naming natural: tier1=top, tier2=mid, tier3=other
  const raw = leagueTier(league); // 1, 2, 3
  const tier = raw === 3 ? 1 : raw === 2 ? 2 : 3;
  let bo;
  if (typeof bestOfOrFormat === 'number') bo = bestOfOrFormat;
  else bo = parseBestOf(bestOfOrFormat, null);
  const tierKey = `tier${tier}`;
  const boKey = `Bo${bo}`;
  const policy = POLICY[g]?.[tierKey]?.[boKey];
  if (!policy) {
    return { skip: false, minEdgeBonus: 0, reason: null, tier, bestOf: bo };
  }
  return {
    skip: !!policy.skip,
    minEdgeBonus: policy.minEdgeBonus || 0,
    reason: policy.reason || null,
    tier, bestOf: bo, brier: policy.brier,
  };
}

module.exports = { esportsSegmentGate, _POLICY: POLICY };

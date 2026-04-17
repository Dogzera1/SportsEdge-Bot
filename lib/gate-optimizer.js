// ── Gate Optimizer ──
// Grid search retroativo: testa diferentes caps de sharp divergence por sport
// e mede impacto em ROI/Brier. Encontra cap "ótimo" (max ROI com n suficiente).
//
// Filosofia: caps atuais (12pp CS/Tennis/Val, 15pp LoL/Dota/etc) foram chutados.
// Backtest mostra qual cap REALMENTE entrega melhor performance no nosso dataset.

function _computeMetrics(tips) {
  if (!tips.length) return { n: 0, wins: 0, losses: 0, roi: null, brier: null, profit_reais: 0, stake_reais: 0 };
  let wins = 0, losses = 0, stakeR = 0, profitR = 0, brierSum = 0, brierN = 0;
  for (const t of tips) {
    if (t.result === 'win') wins++;
    else if (t.result === 'loss') losses++;
    stakeR += Number(t.stake_reais) || 0;
    profitR += Number(t.profit_reais) || 0;
    const odds = Number(t.odds);
    const pStored = Number(t.model_p_pick);
    if (odds > 1 && (t.result === 'win' || t.result === 'loss')) {
      const p = (Number.isFinite(pStored) && pStored > 0 && pStored < 1) ? pStored : (1 / odds);
      const pClamp = Math.max(0.01, Math.min(0.99, p));
      const o = t.result === 'win' ? 1 : 0;
      brierSum += (pClamp - o) ** 2;
      brierN++;
    }
  }
  const decided = wins + losses;
  return {
    n: tips.length,
    wins, losses,
    hit_rate: decided > 0 ? parseFloat((wins / decided * 100).toFixed(1)) : null,
    roi: stakeR > 0 ? parseFloat(((profitR / stakeR) * 100).toFixed(2)) : null,
    profit_reais: parseFloat(profitR.toFixed(2)),
    stake_reais: parseFloat(stakeR.toFixed(2)),
    brier: brierN > 0 ? parseFloat((brierSum / brierN).toFixed(3)) : null,
  };
}

function _divergencePp(odds, modelP) {
  const o = Number(odds);
  const p = Number(modelP);
  if (!Number.isFinite(o) || !Number.isFinite(p) || o <= 1 || p <= 0 || p >= 1) return null;
  const impliedRaw = 1 / o;
  // Aproximação dejuiced: assume vig 5%. Se tivesse odd da outra perna, cálculo seria preciso.
  // Pra grid retroativo essa aproximação é suficiente.
  const impliedDejuiced = impliedRaw / 1.025;
  return Math.abs(p - impliedDejuiced) * 100;
}

const CURRENT_CAPS = {
  esports: 15, dota: 15, mma: 10, tennis: 15, football: 10,
  cs: 12, valorant: 12, darts: 15, snooker: 15, tabletennis: 20,
};

const DEFAULT_GRID = [6, 8, 10, 12, 15, 18, 20, 25, 30, 99];

function runGateOptimizer(db, opts = {}) {
  if (!db) return { ok: false, error: 'db indisponível' };
  const days = parseInt(opts.days || 90, 10);
  const sportFilter = opts.sport || null;
  const caps = opts.caps || DEFAULT_GRID;

  const baseQuery = `
    SELECT sport, odds, model_p_pick, ev, stake_reais, profit_reais, result, event_name
    FROM tips
    WHERE result IN ('win','loss')
      AND model_p_pick IS NOT NULL
      AND settled_at >= datetime('now', ?)
      ${sportFilter ? 'AND sport = ?' : ''}
  `;
  let tips;
  try {
    tips = sportFilter
      ? db.prepare(baseQuery).all(`-${days} days`, sportFilter)
      : db.prepare(baseQuery).all(`-${days} days`);
  } catch (e) { return { ok: false, error: e.message }; }

  if (!tips.length) return { ok: true, days, total_tips: 0, sports: [], note: 'Sem tips com model_p_pick no período.' };

  // Group by sport
  const bySport = new Map();
  for (const t of tips) {
    if (!bySport.has(t.sport)) bySport.set(t.sport, []);
    bySport.get(t.sport).push(t);
  }

  const sports = [];
  for (const [sport, sportTips] of bySport.entries()) {
    const baseline = _computeMetrics(sportTips);
    const byCap = [];
    for (const cap of caps) {
      const filtered = sportTips.filter(t => {
        const d = _divergencePp(t.odds, t.model_p_pick);
        return d == null || d <= cap;
      });
      const m = _computeMetrics(filtered);
      byCap.push({ cap_pp: cap, ...m, blocked: sportTips.length - filtered.length });
    }
    // Optimal: max ROI com n>=20 (sample mínimo)
    const eligible = byCap.filter(b => b.n >= 20 && b.roi != null);
    const optimal = eligible.length > 0 ? eligible.sort((a, b) => b.roi - a.roi)[0] : null;
    const currentCap = CURRENT_CAPS[sport] || 15;
    const currentResult = byCap.find(b => b.cap_pp === currentCap) || null;
    sports.push({
      sport,
      total_tips: baseline.n,
      current_cap_pp: currentCap,
      current: currentResult ? { cap_pp: currentResult.cap_pp, roi: currentResult.roi, n: currentResult.n, brier: currentResult.brier } : null,
      optimal: optimal ? { cap_pp: optimal.cap_pp, roi: optimal.roi, n: optimal.n, brier: optimal.brier, blocked: optimal.blocked } : null,
      delta_roi: (optimal && currentResult) ? parseFloat((optimal.roi - currentResult.roi).toFixed(2)) : null,
      recommendation: _recommendation(currentResult, optimal, sport),
      by_cap: byCap,
    });
  }
  sports.sort((a, b) => Math.abs(b.delta_roi || 0) - Math.abs(a.delta_roi || 0));

  return {
    ok: true,
    at: Date.now(),
    days,
    total_tips: tips.length,
    sports_evaluated: sports.length,
    sports,
  };
}

function _recommendation(current, optimal, sport) {
  if (!optimal) return `⚪ Sample insuficiente (n<20 em todos os caps testados)`;
  if (!current) return `⚠️ Cap atual ${CURRENT_CAPS[sport]}pp não tem dados — checar`;
  const delta = optimal.roi - current.roi;
  if (Math.abs(delta) < 1) return `✅ Cap atual ${current.cap_pp}pp está próximo do ótimo (delta ${delta.toFixed(2)}pp)`;
  if (delta > 0) {
    const direction = optimal.cap_pp > current.cap_pp ? 'AFROUXAR' : 'APERTAR';
    return `🟢 ${direction} cap ${current.cap_pp}pp → ${optimal.cap_pp}pp = +${delta.toFixed(2)}pp ROI (env: ${sport.toUpperCase()}_MAX_DIVERGENCE_PP=${optimal.cap_pp})`;
  }
  return `🟡 Otimização marginal (delta ${delta.toFixed(2)}pp)`;
}

module.exports = { runGateOptimizer, CURRENT_CAPS, DEFAULT_GRID };

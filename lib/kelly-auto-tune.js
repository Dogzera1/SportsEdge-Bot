'use strict';

/**
 * kelly-auto-tune.js
 *
 * Daily auto-tune do Kelly multiplier per-sport baseado em ROI + CLV rolling
 * 30d (post-reset-aware). Complementa `gate-optimizer.js` (weekly, só sugere).
 *
 * Filosofia conservadora:
 *   - Sobe mult só com evidence forte (ROI ≥ +5% AND CLV ≥ 0% AND n ≥ 30)
 *   - Cai mult com sinal ruim (ROI ≤ -5% OR CLV ≤ -3%) + n ≥ 20
 *   - Step size pequeno: +0.05 / -0.10 (mais lento subir que descer)
 *   - Bounds duros: [0.20, 1.20] — evita zerar ou dobrar Kelly num dia
 *
 * Persistência: gates_runtime_state com gate_key='kelly_mult'.
 * getKellyFraction consulta runtime state antes do default hardcoded.
 *
 * Env opt-out: KELLY_AUTO_TUNE=false
 */

const DEFAULT_CONFIG = {
  days: 30,
  minNUp: 30,
  minNDown: 20,
  roiUpThreshold: 5,
  roiDownThreshold: -5,
  clvUpThreshold: 0,
  clvDownThreshold: -3,
  stepUp: 0.05,
  stepDown: 0.10,
  multFloor: 0.20,
  multCeiling: 1.20,
  // Cooldown: bloqueia novos adjusts dentro dessa janela após último UP/DOWN.
  // Default 5d evita oscilação dia-sim/dia-não em sports com ROI±5% volátil.
  // Env override via KELLY_AUTO_TUNE_COOLDOWN_DAYS.
  cooldownDays: parseInt(process.env.KELLY_AUTO_TUNE_COOLDOWN_DAYS || '5', 10) || 5,
};

function _computeSportMetrics(db, sport, days) {
  // 2026-05-03 FIX: removido filtro `market_type IS NULL OR market_type = 'ML'`.
  // Antes auto-tune ignorava MT promovidas (HANDICAP_GAMES/TOTAL_GAMES/OVER_2.5/etc),
  // ficando cego ao ROI real do bucket pós-promo. Agora considera todas tips reais
  // (is_shadow=0). Opt-out via env KELLY_AUTO_TUNE_ML_ONLY=true (preserva legacy).
  const mlOnly = /^(1|true|yes)$/i.test(String(process.env.KELLY_AUTO_TUNE_ML_ONLY || ''));
  const mtFilter = mlOnly ? "AND (market_type IS NULL OR market_type = 'ML')" : '';
  const rows = db.prepare(`
    SELECT result, stake_reais, profit_reais, odds, clv_odds
    FROM tips
    WHERE sport = ?
      AND result IN ('win','loss')
      AND settled_at >= datetime('now', ?)
      AND (archived IS NULL OR archived = 0)
      AND COALESCE(is_shadow, 0) = 0
      ${mtFilter}
  `).all(sport, `-${days} days`);

  if (!rows.length) return { sport, n: 0 };

  let profit = 0, stake = 0, clvSum = 0, clvN = 0;
  for (const r of rows) {
    profit += Number(r.profit_reais) || 0;
    stake += Number(r.stake_reais) || 0;
    const o = Number(r.odds), co = Number(r.clv_odds);
    if (o > 1 && co > 1) {
      clvSum += (o / co - 1) * 100;
      clvN++;
    }
  }
  return {
    sport,
    n: rows.length,
    roi: stake > 0 ? +((profit / stake) * 100).toFixed(2) : null,
    avg_clv: clvN >= 5 ? +(clvSum / clvN).toFixed(2) : null,
    clv_n: clvN,
    profit, stake,
  };
}

function _decideAdjustment(metrics, currentMult, cfg) {
  const { n, roi, avg_clv } = metrics;
  const { minNUp, minNDown, roiUpThreshold, roiDownThreshold, clvUpThreshold, clvDownThreshold, stepUp, stepDown, multFloor, multCeiling } = cfg;

  // DOWN: n >= minNDown AND (ROI <= -5% OR CLV <= -3%)
  if (n >= minNDown && (
    (roi != null && roi <= roiDownThreshold) ||
    (avg_clv != null && avg_clv <= clvDownThreshold)
  )) {
    const newMult = Math.max(multFloor, +(currentMult - stepDown).toFixed(2));
    if (newMult === currentMult) return { action: 'hold_floor', mult: currentMult, reason: `already at floor ${multFloor}` };
    const reason = `ROI=${roi ?? '?'}% CLV=${avg_clv ?? '?'}% n=${n} — DOWN step ${stepDown}`;
    return { action: 'down', mult: newMult, prev: currentMult, reason };
  }

  // UP: n >= minNUp AND ROI >= +5% AND CLV >= 0% (both required)
  if (n >= minNUp && roi != null && roi >= roiUpThreshold && avg_clv != null && avg_clv >= clvUpThreshold) {
    const newMult = Math.min(multCeiling, +(currentMult + stepUp).toFixed(2));
    if (newMult === currentMult) return { action: 'hold_ceiling', mult: currentMult, reason: `already at ceiling ${multCeiling}` };
    const reason = `ROI=${roi}% CLV=${avg_clv}% n=${n} — UP step ${stepUp}`;
    return { action: 'up', mult: newMult, prev: currentMult, reason };
  }

  // HOLD: insufficient evidence or mixed signals
  const reason = n < minNDown ? `n=${n} < min ${minNDown}` :
                 (roi != null && roi < 0) ? `ROI ${roi}% negativo mas não passa threshold DOWN (${roiDownThreshold}%)` :
                 `ROI=${roi ?? '?'}% CLV=${avg_clv ?? '?'}% n=${n} — sem evidence pra mexer`;
  return { action: 'hold', mult: currentMult, reason };
}

/**
 * Main entry: roda o tune pra cada sport em `sports`.
 * @returns {Array<{sport, action, mult, prev?, reason, metrics}>}
 */
function runKellyAutoTune(db, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...opts };
  const sports = opts.sports || ['lol', 'cs', 'tennis', 'football', 'dota2', 'valorant', 'mma', 'darts', 'snooker', 'tabletennis'];
  const defaultMult = opts.defaultMult || {
    lol: 1.00, cs: 1.00, football: 1.00,
    tennis: 0.80, tabletennis: 0.80,
    mma: 0.70, valorant: 0.70,
    dota2: 0.20,
    darts: 0.40, snooker: 0.40,
  };
  const { getGateValue, getGateMeta, setAuto, GATE_KEYS } = require('./gates-runtime-state');
  const KELLY_KEY = 'kelly_mult';
  const cooldownMs = Math.max(0, cfg.cooldownDays) * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const results = [];
  for (const sport of sports) {
    const current = getGateValue(sport, KELLY_KEY);
    const currentMult = Number.isFinite(current) ? current : (defaultMult[sport] ?? 1.0);
    const metrics = _computeSportMetrics(db, sport, cfg.days);
    if (!metrics.n) {
      results.push({ sport, action: 'skip', mult: currentMult, reason: 'sem tips', metrics });
      continue;
    }
    const decision = _decideAdjustment(metrics, currentMult, cfg);
    // Cooldown: bloqueia adjust se último auto-mudança foi há < cooldownMs.
    // Manual sets (source='manual') não são afetados — cooldown só protege
    // contra oscilação do auto-loop em sports com ROI volátil em janela 30d.
    if ((decision.action === 'up' || decision.action === 'down') && cooldownMs > 0) {
      const meta = getGateMeta(sport, KELLY_KEY);
      if (meta?.source === 'auto' && meta?.updatedAt) {
        const ageMs = now - Number(meta.updatedAt);
        if (ageMs < cooldownMs) {
          const remainingDays = Math.ceil((cooldownMs - ageMs) / (24 * 60 * 60 * 1000));
          const reason = `cooldown ${remainingDays}d (último ${decision.action} em ${new Date(Number(meta.updatedAt)).toISOString().slice(0, 10)})`;
          results.push({ sport, action: 'cooldown', mult: currentMult, blocked: decision.action, reason, metrics });
          continue;
        }
      }
    }
    if (decision.action === 'up' || decision.action === 'down') {
      setAuto(db, sport, KELLY_KEY, decision.mult, {
        reason: decision.reason,
        evidence: { roi: metrics.roi, clv: metrics.avg_clv, n: metrics.n, prev: decision.prev },
      });
    }
    results.push({ sport, ...decision, metrics });
  }
  return { at: now, days: cfg.days, cooldownDays: cfg.cooldownDays, results };
}

module.exports = { runKellyAutoTune, DEFAULT_CONFIG, _computeSportMetrics, _decideAdjustment };

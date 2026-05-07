'use strict';

/**
 * gate-attribution.js — gate-by-gate counterfactual analysis em janela rolling.
 *
 * Para cada tip real settled (is_shadow=0) na janela, aplica os gates atuais
 * RETROATIVAMENTE e mede:
 *   - quais gates teriam bloqueado a tip
 *   - se bloqueada: era win? (lost_profit) ou loss? (saved_loss)
 *   - histogram de gate_reasons
 *
 * Output responde: "cada gate individualmente agrega valor (saved_loss > lost_profit)
 * ou está cortando edge junto?"
 *
 * P2 compliance: lê APENAS is_shadow=0 (real settled). Shadow não entra —
 * universo de gates é diferente (shadow tem EV>=0, real tem EV>=minEv 5-8%).
 *
 * Reusa lógica de scripts/backtest-v2.js — gates atuais hardcoded aqui pra
 * disponibilidade offline (sem dependência do bot rodando).
 *
 * Uso:
 *   const { runGateAttribution } = require('./lib/gate-attribution');
 *   const r = runGateAttribution(db, { days: 30 });
 *   // r.bySport[lol].gates[lol_tier2_ev].n / saved_loss / lost_profit
 *
 * Envs:
 *   GATE_ATTRIBUTION_AUTO=true            (default true) — master switch cron
 *   GATE_ATTRIBUTION_DAYS=30              — janela settled
 *   GATE_ATTRIBUTION_MIN_N_PER_GATE=5     — n mínimo per gate pra reportar
 */

// ── Gates atuais (mirror scripts/backtest-v2.js — manter sincronizado) ──
const SHARP_CAP_PP = {
  esports: 15, dota: 15, mma: 10, tennis: 12, football: 10,
  cs: 12, valorant: 12, darts: 15, snooker: 15, tabletennis: 20,
};
const EV_SANITY_MAX = 50;
const LOL_TIER2_EV_CAP = 25;
const CS_TIER1_RE = /\b(major|iem\b|katowice|cologne|esl pro league|epl\b|blast premier|esports world cup|ewc|austin|rio|shanghai|paris)\b/i;
const TIER1_REGEX = {
  esports: /\b(lck|lec|lcs|lpl|msi\b|worlds|cblol|dota.*?(major|riyadh|the international|ti\d|dpc))\b/i,
  cs: CS_TIER1_RE,
  valorant: /\b(vct.*?(champions|masters|internationals)|game changers championship|valorant.*?champions)\b/i,
  tennis: /\b(grand slam|wimbledon|us open|roland garros|australian open|atp masters|wta 1000|atp 1000|atp finals|wta finals)\b/i,
  mma: /\b(ufc \d{3,}|ufc on |ufc fight night|ufc apex)\b/i,
  football: /\b(premier league|la liga|bundesliga|serie a$|ligue 1|champions league|brasileirao|brasileirão|copa libertadores)\b/i,
};

function _tierOf(sport, eventName) {
  const re = TIER1_REGEX[sport];
  if (!re) return 'unknown';
  return re.test(String(eventName || '')) ? 'tier1' : 'tier2plus';
}

function _isLolTier1(s) {
  return /\b(lck|lec|lcs|lpl|msi|worlds|cblol|cbloldbrazil|lla|pcs|lco|vcs|esports world cup)\b/i.test(s || '');
}

/**
 * Aplica gates retroativamente a uma tip. Retorna {passed, reasons[]}.
 * Cada reason é um label categórico estável (sem números, pra agregar).
 */
function _applyGates(tip) {
  const reasons = [];
  const odds = parseFloat(tip.odds);
  const ev = parseFloat(tip.ev);
  const modelP = parseFloat(tip.model_p_pick);

  if (ev > EV_SANITY_MAX) reasons.push('ev_sanity_gt50');

  if (Number.isFinite(modelP) && Number.isFinite(odds) && odds > 1) {
    const impliedRaw = 1 / odds;
    const impliedDejuiced = impliedRaw / 1.025;
    const divPp = Math.abs(modelP - impliedDejuiced) * 100;
    const cap = SHARP_CAP_PP[tip.sport] ?? 15;
    if (divPp > cap) reasons.push('sharp_divergence');
  }

  if (tip.sport === 'esports' && !_isLolTier1(tip.event_name) && ev > LOL_TIER2_EV_CAP) {
    reasons.push('lol_tier2_ev_cap');
  }

  if (tip.sport === 'cs' && _tierOf('cs', tip.event_name) === 'tier2plus' && tip.confidence === 'ALTA') {
    reasons.push('cs_tier2_alta_rebaixada');
  }

  if (tip.sport === 'mma' && ev > 18) {
    reasons.push('mma_high_ev_non_sharp');
  }

  return { passed: reasons.length === 0, reasons };
}

/**
 * @param {object} db - sqlite better-sqlite3
 * @param {object} [opts]
 * @param {number} [opts.days=30] - janela settled
 * @param {number} [opts.minNPerGate=5] - n mínimo per gate pra reportar
 * @returns {{
 *   total: number,
 *   blocked: number,
 *   blockedPct: number,
 *   savedLoss: number,
 *   lostProfit: number,
 *   netSaved: number,
 *   gates: Object<string, {n, savedLoss, lostProfit, net, hitRate}>,
 *   bySport: Object<string, {...}>,
 * }}
 */
function runGateAttribution(db, opts = {}) {
  const days = opts.days || parseInt(process.env.GATE_ATTRIBUTION_DAYS || '30', 10);
  const minNPerGate = opts.minNPerGate || parseInt(process.env.GATE_ATTRIBUTION_MIN_N_PER_GATE || '5', 10);

  const tips = db.prepare(`
    SELECT id, sport, event_name, odds, ev, stake_reais, profit_reais, result,
           confidence, model_p_pick
    FROM tips
    WHERE COALESCE(is_shadow, 0) = 0
      AND COALESCE(archived, 0) = 0
      AND result IN ('win','loss')
      AND settled_at IS NOT NULL
      AND settled_at >= datetime('now', '-' || ? || ' days')
  `).all(days);

  const out = {
    total: tips.length,
    blocked: 0,
    blockedPct: 0,
    savedLoss: 0,
    lostProfit: 0,
    netSaved: 0,
    gates: {}, // gate_reason → {n, savedLoss, lostProfit, net, hitRate}
    bySport: {},
  };
  if (!tips.length) return out;

  const gateAgg = (gate) => {
    if (!out.gates[gate]) out.gates[gate] = { n: 0, wins: 0, losses: 0, savedLoss: 0, lostProfit: 0 };
    return out.gates[gate];
  };
  const sportAgg = (sport) => {
    if (!out.bySport[sport]) {
      out.bySport[sport] = {
        total: 0, blocked: 0, savedLoss: 0, lostProfit: 0, netSaved: 0,
        gates: {},
      };
    }
    return out.bySport[sport];
  };

  for (const t of tips) {
    const sport = String(t.sport || 'unknown').toLowerCase();
    const sp = sportAgg(sport);
    sp.total++;
    const { passed, reasons } = _applyGates(t);
    if (passed) continue;

    out.blocked++;
    sp.blocked++;
    const stake = Number(t.stake_reais) || 0;
    const profit = Number(t.profit_reais) || 0;
    const isWin = t.result === 'win';
    const isLoss = t.result === 'loss';

    if (isLoss) {
      out.savedLoss += stake;
      sp.savedLoss += stake;
    } else if (isWin) {
      out.lostProfit += profit;
      sp.lostProfit += profit;
    }

    for (const reason of reasons) {
      const g = gateAgg(reason);
      g.n++;
      if (isWin) g.wins++;
      else if (isLoss) g.losses++;
      if (isLoss) g.savedLoss += stake;
      else if (isWin) g.lostProfit += profit;

      if (!sp.gates[reason]) sp.gates[reason] = { n: 0, savedLoss: 0, lostProfit: 0 };
      sp.gates[reason].n++;
      if (isLoss) sp.gates[reason].savedLoss += stake;
      else if (isWin) sp.gates[reason].lostProfit += profit;
    }
  }

  // Finalizar agregados
  out.netSaved = +(out.savedLoss - out.lostProfit).toFixed(2);
  out.savedLoss = +out.savedLoss.toFixed(2);
  out.lostProfit = +out.lostProfit.toFixed(2);
  out.blockedPct = out.total > 0 ? +(out.blocked / out.total * 100).toFixed(1) : 0;

  for (const reason of Object.keys(out.gates)) {
    const g = out.gates[reason];
    if (g.n < minNPerGate) {
      delete out.gates[reason];
      continue;
    }
    g.savedLoss = +g.savedLoss.toFixed(2);
    g.lostProfit = +g.lostProfit.toFixed(2);
    g.net = +(g.savedLoss - g.lostProfit).toFixed(2);
    const decided = g.wins + g.losses;
    g.hitRate = decided > 0 ? +(g.wins / decided * 100).toFixed(1) : null;
  }

  for (const sport of Object.keys(out.bySport)) {
    const sp = out.bySport[sport];
    sp.netSaved = +(sp.savedLoss - sp.lostProfit).toFixed(2);
    sp.savedLoss = +sp.savedLoss.toFixed(2);
    sp.lostProfit = +sp.lostProfit.toFixed(2);
    sp.blockedPct = sp.total > 0 ? +(sp.blocked / sp.total * 100).toFixed(1) : 0;
    for (const reason of Object.keys(sp.gates)) {
      const g = sp.gates[reason];
      if (g.n < minNPerGate) { delete sp.gates[reason]; continue; }
      g.savedLoss = +g.savedLoss.toFixed(2);
      g.lostProfit = +g.lostProfit.toFixed(2);
      g.net = +(g.savedLoss - g.lostProfit).toFixed(2);
    }
  }

  return out;
}

module.exports = { runGateAttribution };

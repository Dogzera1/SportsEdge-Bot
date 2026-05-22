'use strict';

/**
 * cross-significance.js — Cross-Significance Analyzer (CSA), 2026-05-22.
 *
 * Compara performance per-bucket entre shadow (research universe) e real
 * (dispatched universe) em granularidade fina:
 *   sport × market × {dir} × {side} × {tier?}
 *
 * Computa Wilson IC95 (hit rate) + normal-approx IC95 (ROI per-tip return)
 * pra cada bucket. Classifica:
 *   EDGE   = real IC95 ROI lower > 0   (estatisticamente confirmado lucro)
 *   LEAK   = shadow IC95 ROI upper < 0 (estatisticamente confirmado prejuízo)
 *            AND real ROI < 0 (não contradiz)
 *   WATCH  = shadow LEAK mas real inconc/positivo (conflito monitorável)
 *   INCONC = IC95 cruza zero
 *   NA     = sample insuficiente (n < minN)
 *
 * Output é hierárquico:
 *   by_sport[sport][market] = { agg, by_side, by_dir, by_dir_side, by_tier? }
 *
 * P2 compliant: nunca auto-altera config. Sugestões em DM admin via cron
 * (Fase 2). Real-only data alimenta classificação EDGE; shadow alimenta LEAK
 * + WATCH apenas.
 *
 * P3 compliant: orthogonal a runHgNegReadiness (HG- tennis específico),
 * runShadowVsRealDrift (macro), runGateAttribution (gate-level counterfactual).
 * Esta lib é granular-bucket cross.
 */

// ─────────────────────────────────────────────────────────────────────────
// Estatística
// ─────────────────────────────────────────────────────────────────────────

/** Wilson IC95 binomial proportion. Retorna [lo, hi] em 0..1. */
function wilsonHitIc95(w, n, z = 1.96) {
  if (n <= 0) return { lo: 0, hi: 0, p: 0 };
  const p = w / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin), p };
}

/** ROI IC95 normal-approx via per-tip return variance. Retorna em %. */
function roiIc95FromTips(profits, stakes, z = 1.96) {
  const n = profits.length;
  if (n === 0) return { lo: 0, hi: 0, p: 0, se: 0 };
  const totalStake = stakes.reduce((a, b) => a + b, 0);
  const totalProfit = profits.reduce((a, b) => a + b, 0);
  const roi = totalStake > 0 ? (totalProfit / totalStake) * 100 : 0;
  // Per-unit returns (per real-money stake)
  const rets = profits.map((p, i) => (stakes[i] > 0 ? p / stakes[i] : 0));
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / n) * 100;
  return { lo: roi - z * se, hi: roi + z * se, p: roi, se };
}

/**
 * ROI IC95 para SHADOW aggregate (não temos profits per-tip, só totais).
 * Approximação: var per-tip ≈ p*(odd-1)^2 + (1-p)*1 - mean^2 (units of stake).
 * SE_total = sqrt(n * var) * avg_stake; SE_roi = (SE_total / total_stake) * 100.
 */
function roiIc95FromShadowAgg({ wins, losses, total_stake, total_profit, n, avg_odd }, z = 1.96) {
  const settled = wins + losses;
  if (settled === 0 || total_stake <= 0) return { lo: null, hi: null, p: 0, se: null };
  const roi = (total_profit / total_stake) * 100;
  const p = wins / settled;
  const odd = avg_odd > 1 ? avg_odd : 2.0;
  const meanPerTip = p * (odd - 1) - (1 - p);
  const varPerTip = p * (odd - 1) * (odd - 1) + (1 - p) - meanPerTip * meanPerTip;
  const avgStake = total_stake / Math.max(1, n);
  const seTotal = Math.sqrt(settled * Math.max(0, varPerTip)) * avgStake;
  const seRoi = (seTotal / total_stake) * 100;
  return { lo: roi - z * seRoi, hi: roi + z * seRoi, p: roi, se: seRoi };
}

// ─────────────────────────────────────────────────────────────────────────
// Tier classifier (hybrid — apenas tennis + esports, demais sports agnostic)
// ─────────────────────────────────────────────────────────────────────────

function _classifyTennisTier(eventName) {
  const s = String(eventName || '').toLowerCase();
  if (/grand slam|wimbledon|us open|french open|roland garros|australian open|atp finals|wta finals/.test(s)) return 'slam';
  if (/masters 1000|atp 1000|wta 1000|indian wells|miami|monte.?carlo|madrid|rome|cincinnati|shanghai|paris masters/.test(s)) return 'masters';
  if (/atp 500|wta 500|atp 250|wta 250|atp(?!\s+challenger)|atp\s+(?:geneva|estoril|marrakech|bastad|umag|stockholm|sofia|antwerp)/.test(s)) return 'atp250-500';
  if (/wta 125|wta(?!\s+125)/.test(s)) return 'wta_tour';
  if (/challenger/.test(s)) return 'challenger';
  if (/itf|college/.test(s)) return 'itf';
  return 'other';
}

function _classifyEsportsTier(eventName, league) {
  const s = String(eventName || league || '').toLowerCase();
  // Tier1: top leagues per sport
  if (/lck|lpl|lec|lcs|msi|worlds|first stand|champions queue/.test(s)) return 'tier1'; // lol
  if (/iem|blast|esl pro league|major|esl one rio|katowice|cologne|austin|copenhagen/.test(s)) return 'tier1'; // cs
  if (/the international|major|dpc|riyadh masters|esl one|dreamleague/.test(s)) return 'tier1'; // dota2
  if (/vct (?:americas|emea|pacific|china)|champions|masters madrid|masters tokyo|masters shanghai/.test(s)) return 'tier1'; // valorant
  // Tier2: regional leagues
  if (/cblol|lck challengers|lec masters|lcs challengers|nlc|lvp|liga master|league of legends/.test(s)) return 'tier2'; // lol
  if (/esea|esl impact|wpl|asia open|cct|sea|funspark|elisa|gamers club/.test(s)) return 'tier2'; // cs
  if (/dpc south america|china pro league|qualifier|d2cl|space|pgl|epic league/.test(s)) return 'tier2'; // dota2
  if (/challengers|vct (?:brazil|game changers|ascension)|polaris|knights/.test(s)) return 'tier2'; // valorant
  return 'other';
}

function classifyTier(sport, eventName, league) {
  if (sport === 'tennis') return _classifyTennisTier(eventName);
  if (['lol', 'cs', 'dota2', 'valorant'].includes(sport)) return _classifyEsportsTier(eventName, league);
  return null;
}

const SPORTS_WITH_TIER = new Set(['tennis', 'lol', 'cs', 'dota2', 'valorant']);

// ─────────────────────────────────────────────────────────────────────────
// Bucket extraction (sport-aware)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Extrai bucket key (side, dir) de uma tip real.
 * Tenta primeiro match_id sintético `::mt::<market>::<side>::ln<sign><line>`.
 * Fallback ML: parse tip_participant vs participant1/2.
 *
 * @returns {{side, dir, line}|null}
 */
function parseRealTipBucket(tip, market) {
  const mid = String(tip.match_id || '');
  // Synthetic MT pattern
  const m = mid.match(/::mt::([^:]+)::([^:]+)::ln([NP])?(\d+(?:\.\d+)?)/i);
  if (m) {
    const side = String(m[2]).toLowerCase();
    const sign = m[3];
    const line = parseFloat(m[4]);
    let dir = null;
    if (sign === 'N') dir = 'NEG';
    else if (sign === 'P') dir = 'POS';
    return { side, dir, line: isFinite(line) ? (sign === 'N' ? -line : line) : null };
  }
  // ML fallback: side via tip_participant vs participants
  if (String(market || tip.market_type || '').toUpperCase() === 'ML') {
    const tp = String(tip.tip_participant || '').toLowerCase();
    const p1 = String(tip.participant1 || '').toLowerCase();
    const p2 = String(tip.participant2 || '').toLowerCase();
    if (tp && p1 && tp.includes(p1.split(' ')[0])) return { side: 'home', dir: null, line: null };
    if (tp && p2 && tp.includes(p2.split(' ')[0])) return { side: 'away', dir: null, line: null };
  }
  return null;
}

/** Shadow row já tem side/line direto. */
function parseShadowBucket(row) {
  const side = String(row.side || '').toLowerCase();
  const line = Number.isFinite(row.line) ? row.line : null;
  let dir = null;
  if (line != null) {
    if (line < 0) dir = 'NEG';
    else if (line > 0) dir = 'POS';
    // line === 0 → null (PK)
  }
  return { side, dir, line };
}

// ─────────────────────────────────────────────────────────────────────────
// Stat aggregation
// ─────────────────────────────────────────────────────────────────────────

function realBucketStats(tips) {
  let w = 0, l = 0, v = 0, pending = 0;
  const profits = [], stakes = [];
  let oddSum = 0, evSum = 0, clvSum = 0, clvN = 0, oddCount = 0;
  for (const t of tips) {
    if (!t.result || !['win', 'loss', 'void'].includes(t.result)) { pending++; continue; }
    if (t.result === 'void') { v++; continue; }
    if (t.result === 'win') w++; else l++;
    profits.push(Number(t.profit_reais) || 0);
    stakes.push(Number(t.stake_reais) || 0);
    oddSum += Number(t.odds) || 0;
    evSum += Number(t.ev) || 0;
    oddCount++;
    if (t.clv_odds && t.odds && t.odds > 1) {
      const clv = (Number(t.clv_odds) / Number(t.odds) - 1) * 100;
      if (Number.isFinite(clv)) { clvSum += clv; clvN++; }
    }
  }
  const settled = w + l;
  const wic = wilsonHitIc95(w, settled);
  const ric = roiIc95FromTips(profits, stakes);
  return {
    n: settled + v, settled, w, l, v, pending,
    hit: settled > 0 ? +(wic.p * 100).toFixed(1) : null,
    hit_ic95: [+(wic.lo * 100).toFixed(1), +(wic.hi * 100).toFixed(1)],
    roi: +ric.p.toFixed(2),
    roi_ic95: [+ric.lo.toFixed(2), +ric.hi.toFixed(2)],
    stake: +stakes.reduce((a, b) => a + b, 0).toFixed(2),
    profit: +profits.reduce((a, b) => a + b, 0).toFixed(2),
    avg_odd: oddCount > 0 ? +(oddSum / oddCount).toFixed(2) : null,
    avg_ev: oddCount > 0 ? +(evSum / oddCount).toFixed(1) : null,
    avg_clv: clvN > 0 ? +(clvSum / clvN).toFixed(2) : null,
    clv_n: clvN,
  };
}

function shadowBucketStats(rows) {
  let n = 0, w = 0, l = 0, v = 0, ts = 0, tp = 0, oddS = 0;
  for (const r of rows) {
    n++;
    if (r.result === 'win') { w++; ts += Number(r.stake_units) || 1; tp += Number(r.profit_units) || 0; }
    else if (r.result === 'loss') { l++; ts += Number(r.stake_units) || 1; tp += Number(r.profit_units) || 0; }
    else if (r.result === 'void') { v++; }
    oddS += Number(r.odd) || 0;
  }
  const settled = w + l;
  const wic = wilsonHitIc95(w, settled);
  const avgOdd = n > 0 ? oddS / n : 0;
  const ric = roiIc95FromShadowAgg({ wins: w, losses: l, total_stake: ts, total_profit: tp, n, avg_odd: avgOdd });
  return {
    n: settled + v, settled, w, l, v,
    hit: settled > 0 ? +(wic.p * 100).toFixed(1) : null,
    hit_ic95: [+(wic.lo * 100).toFixed(1), +(wic.hi * 100).toFixed(1)],
    roi: settled > 0 ? +ric.p.toFixed(2) : null,
    roi_ic95: ric.lo !== null ? [+ric.lo.toFixed(2), +ric.hi.toFixed(2)] : null,
    stake: +ts.toFixed(2),
    profit: +tp.toFixed(2),
    avg_odd: avgOdd > 0 ? +avgOdd.toFixed(2) : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Significance classifier
// ─────────────────────────────────────────────────────────────────────────

function classifyBucket(real, shadow, minN) {
  const realN = real?.settled ?? 0;
  const shadowN = shadow?.settled ?? 0;
  // Default
  let type = 'INCONC', conf = 'low', toArm = null, suggestion = null;

  // EDGE: real IC.lo > 0 with sample
  if (realN >= minN && real.roi_ic95 && real.roi_ic95[0] > 0) {
    type = 'EDGE';
    conf = realN >= 50 ? 'high' : realN >= 30 ? 'medium' : 'low';
  }
  // LEAK: shadow IC.hi < 0 AND real either no data OR negative
  else if (shadowN >= Math.max(50, minN) && shadow.roi_ic95 && shadow.roi_ic95[1] < 0) {
    if (realN === 0 || (real.roi != null && real.roi < 0)) {
      type = 'LEAK';
      conf = shadowN >= 200 ? 'high' : shadowN >= 100 ? 'medium' : 'low';
    } else {
      type = 'WATCH'; // shadow leak but real positive — conflict
      conf = 'low';
    }
  }
  // NA: too few samples both
  else if (realN < minN && shadowN < minN) {
    type = 'NA';
  }
  // TO_ARM: real positive trend, close to edge threshold
  if (type === 'INCONC' && realN >= 5 && real.hit_ic95 && real.hit_ic95[0] > 50 && real.roi > 0) {
    const needed = Math.max(0, minN - realN);
    toArm = { current_n: realN, needed_n: needed, target_n: minN, hit_ic95_lo: real.hit_ic95[0] };
  }

  return { type, conf, toArm, suggestion };
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────────────

const _normMarket = (m) => String(m || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const _normMarketShadow = (m) => {
  // shadow uses lowercased camelCase: 'handicapGames', 'totalGames', 'ML'
  const u = String(m || '').toLowerCase();
  if (u === 'handicapgames') return 'HANDICAPGAMES';
  if (u === 'totalgames') return 'TOTALGAMES';
  if (u === 'handicapsets') return 'HANDICAPSETS';
  if (u === 'totalsets') return 'TOTALSETS';
  return u.toUpperCase().replace(/[^A-Z0-9]/g, '');
};

/**
 * @param {object} db
 * @param {object} [opts]
 * @param {string[]} [opts.sports=['tennis','lol']] sports a analisar
 * @param {number} [opts.days=30]
 * @param {boolean} [opts.includeArchived=true]
 * @param {number} [opts.minN=20] minimum sample pra IC95 confiável
 * @returns {object}
 */
function runCrossSignificance(db, opts = {}) {
  const cfg = {
    sports: opts.sports || ['tennis', 'lol'],
    days: opts.days || 30,
    includeArchived: opts.includeArchived !== false,
    minN: opts.minN || 20,
  };

  const result = { ts: new Date().toISOString(), cfg, by_sport: {}, alerts: [] };

  for (const sport of cfg.sports) {
    const archivedCond = cfg.includeArchived ? '' : 'AND (archived IS NULL OR archived = 0)';
    const realRows = db.prepare(`
      SELECT id, sport, match_id, event_name, participant1, participant2,
             tip_participant, market_type, odds, ev, stake_reais, profit_reais,
             result, is_live, sent_at, clv_odds, open_odds
      FROM tips
      WHERE sport = ?
        AND COALESCE(is_shadow, 0) = 0
        ${archivedCond}
        AND market_type IS NOT NULL
        AND sent_at >= datetime('now', '-' || ? || ' days')
    `).all(sport, cfg.days);

    const shadowRows = db.prepare(`
      SELECT sport, market, side, line, odd, result, stake_units, profit_units,
             is_live, league, created_at
      FROM market_tips_shadow
      WHERE sport = ?
        AND result IN ('win','loss','void')
        AND created_at >= datetime('now', '-' || ? || ' days')
    `).all(sport, cfg.days);

    // Discover markets present
    const realMarkets = new Set(realRows.map(r => _normMarket(r.market_type)).filter(Boolean));
    const shadowMarkets = new Set(shadowRows.map(r => _normMarketShadow(r.market)).filter(Boolean));
    const allMarkets = new Set([...realMarkets, ...shadowMarkets]);

    result.by_sport[sport] = {};

    for (const marketNorm of allMarkets) {
      const realM = realRows.filter(r => _normMarket(r.market_type) === marketNorm);
      const shadowM = shadowRows.filter(r => _normMarketShadow(r.market) === marketNorm);
      result.by_sport[sport][marketNorm] = _computeMarketBuckets(sport, marketNorm, realM, shadowM, cfg.minN, result.alerts);
    }
  }

  // Sort alerts: EDGE first, then LEAK, then WATCH, then TO_ARM
  const order = { NEW_EDGE: 0, NEW_LEAK: 1, WATCH: 2, TO_ARM_CLOSE: 3 };
  result.alerts.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));

  return result;
}

function _computeMarketBuckets(sport, marketNorm, realTips, shadowRows, minN, alertsOut) {
  // Group by bucket dimensions
  const out = {};

  // agg (overall)
  out.agg = _bucketEntry(realTips, shadowRows, minN);

  // by_side
  const sides = {};
  for (const t of realTips) {
    const b = parseRealTipBucket(t, marketNorm);
    if (!b?.side) continue;
    (sides[b.side] = sides[b.side] || { real: [], shadow: [] }).real.push(t);
  }
  for (const r of shadowRows) {
    const b = parseShadowBucket(r);
    if (!b?.side) continue;
    (sides[b.side] = sides[b.side] || { real: [], shadow: [] }).shadow.push(r);
  }
  out.by_side = {};
  for (const [side, lists] of Object.entries(sides)) {
    out.by_side[side] = _bucketEntry(lists.real || [], lists.shadow || [], minN);
  }

  // by_dir (NEG/POS) — only if market has line/dir semantics
  const dirs = {};
  let hasDir = false;
  for (const t of realTips) {
    const b = parseRealTipBucket(t, marketNorm);
    if (!b?.dir) continue;
    hasDir = true;
    (dirs[b.dir] = dirs[b.dir] || { real: [], shadow: [] }).real.push(t);
  }
  for (const r of shadowRows) {
    const b = parseShadowBucket(r);
    if (!b?.dir) continue;
    hasDir = true;
    (dirs[b.dir] = dirs[b.dir] || { real: [], shadow: [] }).shadow.push(r);
  }
  if (hasDir) {
    out.by_dir = {};
    for (const [dir, lists] of Object.entries(dirs)) {
      out.by_dir[dir] = _bucketEntry(lists.real || [], lists.shadow || [], minN);
    }
  }

  // by_dir_side cross 2x2
  if (hasDir) {
    const ds = {};
    for (const t of realTips) {
      const b = parseRealTipBucket(t, marketNorm);
      if (!b?.dir || !b?.side) continue;
      const k = `${b.dir}_${b.side}`;
      (ds[k] = ds[k] || { real: [], shadow: [] }).real.push(t);
    }
    for (const r of shadowRows) {
      const b = parseShadowBucket(r);
      if (!b?.dir || !b?.side) continue;
      const k = `${b.dir}_${b.side}`;
      (ds[k] = ds[k] || { real: [], shadow: [] }).shadow.push(r);
    }
    out.by_dir_side = {};
    for (const [k, lists] of Object.entries(ds)) {
      out.by_dir_side[k] = _bucketEntry(lists.real || [], lists.shadow || [], minN);
    }
  }

  // by_tier (only for tennis + esports)
  if (SPORTS_WITH_TIER.has(sport)) {
    const tiers = {};
    for (const t of realTips) {
      const tier = classifyTier(sport, t.event_name, null);
      if (!tier) continue;
      (tiers[tier] = tiers[tier] || { real: [], shadow: [] }).real.push(t);
    }
    for (const r of shadowRows) {
      const tier = classifyTier(sport, null, r.league);
      if (!tier) continue;
      (tiers[tier] = tiers[tier] || { real: [], shadow: [] }).shadow.push(r);
    }
    out.by_tier = {};
    for (const [tier, lists] of Object.entries(tiers)) {
      out.by_tier[tier] = _bucketEntry(lists.real || [], lists.shadow || [], minN);
    }
  }

  // Generate alerts from this market's buckets
  _emitAlerts(sport, marketNorm, out, alertsOut);

  return out;
}

function _bucketEntry(realTips, shadowRows, minN) {
  const real = realBucketStats(realTips);
  const shadow = shadowBucketStats(shadowRows);
  const classification = classifyBucket(real, shadow, minN);
  return {
    real, shadow,
    significance: classification.type,
    confidence: classification.conf,
    to_arm: classification.toArm,
    suggestion: _buildSuggestion(classification, real, shadow),
  };
}

function _buildSuggestion(classif, real, shadow) {
  if (classif.type === 'EDGE') {
    // Suggest Kelly boost proportional to IC.lo
    const lo = real.roi_ic95?.[0] ?? 0;
    let mult = 1.10;
    if (lo > 20) mult = 1.40;
    else if (lo > 10) mult = 1.30;
    else if (lo > 5) mult = 1.20;
    return { action: 'KELLY_BOOST', mult, note: `IC95 ROI lo=${lo}% confirma edge` };
  }
  if (classif.type === 'LEAK') {
    return { action: 'KELLY_CUT', mult: 0.70, note: `shadow IC95 ROI hi=${shadow.roi_ic95?.[1]}% confirma leak` };
  }
  if (classif.type === 'WATCH') {
    return { action: 'MONITOR', note: 'shadow leak mas real ainda inconclusivo — investigar conflito' };
  }
  return null;
}

function _emitAlerts(sport, market, buckets, alertsOut) {
  function emit(bucketKey, entry) {
    if (entry.significance === 'EDGE' && entry.confidence !== 'low') {
      alertsOut.push({
        type: 'NEW_EDGE', sport, market, bucket: bucketKey,
        sample: entry.real.settled, roi: entry.real.roi, ic_lo: entry.real.roi_ic95?.[0],
        suggestion: entry.suggestion,
      });
    } else if (entry.significance === 'LEAK' && entry.confidence !== 'low') {
      alertsOut.push({
        type: 'NEW_LEAK', sport, market, bucket: bucketKey,
        shadow_n: entry.shadow.settled, shadow_roi: entry.shadow.roi,
        ic_hi: entry.shadow.roi_ic95?.[1],
        suggestion: entry.suggestion,
      });
    } else if (entry.to_arm && entry.to_arm.needed_n <= 10) {
      alertsOut.push({
        type: 'TO_ARM_CLOSE', sport, market, bucket: bucketKey,
        current_n: entry.to_arm.current_n, needed: entry.to_arm.needed_n,
        hit_ic_lo: entry.to_arm.hit_ic95_lo, roi: entry.real.roi,
      });
    }
  }

  emit('agg', buckets.agg);
  for (const [k, v] of Object.entries(buckets.by_side || {})) emit(`side:${k}`, v);
  for (const [k, v] of Object.entries(buckets.by_dir || {})) emit(`dir:${k}`, v);
  for (const [k, v] of Object.entries(buckets.by_dir_side || {})) emit(`dir_side:${k}`, v);
  for (const [k, v] of Object.entries(buckets.by_tier || {})) emit(`tier:${k}`, v);
}

module.exports = {
  runCrossSignificance,
  wilsonHitIc95,
  roiIc95FromTips,
  roiIc95FromShadowAgg,
  classifyTier,
  parseRealTipBucket,
  parseShadowBucket,
  realBucketStats,
  shadowBucketStats,
  classifyBucket,
};

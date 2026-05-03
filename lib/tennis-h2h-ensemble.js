'use strict';

/**
 * tennis-h2h-ensemble.js — H2H second-opinion model pra blendar com Markov.
 *
 * Inspirado em Wang & Drekic 2026 (Journal of Quantitative Analysis Sports):
 * ensemble point-based + H2H-only models reaches ~70% accuracy. Nosso Markov
 * já é point-based; adicionar H2H-pure como segundo opinador.
 *
 * Surface-aware (2026-05-01): matches em superfície igual têm weight 1.0,
 * matches em superfície diferente weight 0.4. Federer-Nadal H2H 24-16 no clay
 * é >> indicativo que H2H 24-16 mistos. Prevent overfitting pra rivalidades
 * com viés de superfície.
 *
 * Heurística:
 *   - p_h2h = (sum(weighted_wins) + alpha) / (sum(weighted_n) + 2*alpha)
 *   - weight per match = surface_match (1.0 same, 0.4 diff) × recency (1.0 <365d, 0.5 >365d)
 *   - alpha = 0.5 (prior uniforme: 50/50 sem dados)
 *   - blend weight escala com effective_n: max 30% quando effective_n>=10
 *
 * Uso típico: depois do Markov + TB + isotonic mas antes de injury risk.
 */

// Surface inference de league string. Regex compostos pra cobrir variações.
// Defaults Madrid/Monte Carlo/Roland → clay; Wimbledon/Halle → grass; demais hard.
function inferSurface(league) {
  const s = String(league || '').toLowerCase();
  if (!s) return 'unknown';
  // Clay: Roland, Madrid, Rome, Monte Carlo, Hamburg, Munich, Bastad, Estoril,
  // Geneva, Lyon, Barcelona, Buenos Aires, Rio, Houston, Casablanca, Marrakech,
  // ATP/WTA Challengers em quadra de saibro
  if (/roland.garros|french.open|madrid|monte.carlo|montecarlo|rome|italian.open|hamburg|munich|bastad|estoril|geneva|lyon|barcelona|buenos.aires|rio.de.janeiro|houston|casablanca|marrakech|umag|gstaad|kitzbuhel|prague|cordoba|santiago|kitzbuehel|aix.en.provence|cagliari|mauthausen/.test(s)) return 'clay';
  // Grass: Wimbledon, Halle, Stuttgart (grass), Eastbourne, Queen's, Newport,
  // Mallorca, Bad Homburg, s-Hertogenbosch, Birmingham
  if (/wimbledon|halle|eastbourne|queen.?s|newport|s.hertogenbosch|hertogenbosch|birmingham|stuttgart.grass|bad.homburg|mallorca/.test(s)) return 'grass';
  // Indoor hard: Paris-Bercy/Masters, Vienna, Stockholm, Sofia, Antwerp, Basel
  if (/paris.bercy|paris.master|atp.finals|wta.finals|vienna|stockholm|sofia|antwerp|basel|metz|nur.sultan/.test(s)) return 'hard_indoor';
  // Outdoor hard: US Open, Australian Open, Indian Wells, Miami, Cincinnati,
  // Toronto/Montreal, Shanghai, Beijing, Dubai, Tokyo, Acapulco, Doha
  if (/us.open|australian.open|indian.wells|miami|cincinnati|toronto|montreal|shanghai|beijing|china.open|dubai|tokyo|acapulco|doha|atlanta|washington|winston.salem|los.cabos/.test(s)) return 'hard';
  // WTA-specific: Wuhan, Guadalajara, Tianjin
  if (/wuhan|guadalajara|tianjin|adelaide|brisbane|hobart/.test(s)) return 'hard';
  // Default: hard (mais comum no calendário ATP/WTA)
  return 'unknown';
}

/**
 * Calcula p ensemble blendando p_markov com p_h2h.
 *
 * @param {object} h2hData — payload do /h2h endpoint: {totalMatches, t1Wins, t2Wins, results}
 * @param {number} pMarkov — probabilidade atual do modelo Markov para player1 (já calibrado)
 * @param {object} opts — { minN: 3, maxWeight: 0.30, alpha: 0.5, recencyBoostDays: 365 }
 * @returns {{ pBlend, pH2h, weight, applied, reason }}
 */
function computeH2HEnsemble(h2hData, pMarkov, opts = {}) {
  const minN = Number.isFinite(opts.minN) ? opts.minN : 3;
  const maxWeight = Number.isFinite(opts.maxWeight) ? opts.maxWeight : 0.30;
  const alpha = Number.isFinite(opts.alpha) ? opts.alpha : 0.5;
  const recencyBoostDays = Number.isFinite(opts.recencyBoostDays) ? opts.recencyBoostDays : 365;

  // Sanity inputs
  if (!Number.isFinite(pMarkov) || pMarkov <= 0 || pMarkov >= 1) {
    return { pBlend: pMarkov, pH2h: null, weight: 0, applied: false, reason: 'invalid_p_markov' };
  }
  if (!h2hData || typeof h2hData !== 'object') {
    return { pBlend: pMarkov, pH2h: null, weight: 0, applied: false, reason: 'no_h2h_data' };
  }

  const total = Number(h2hData.totalMatches) || 0;
  const t1w = Number(h2hData.t1Wins) || 0;
  if (total < minN) {
    return { pBlend: pMarkov, pH2h: null, weight: 0, applied: false, reason: `insufficient_n (${total} < ${minN})` };
  }

  // Recency + surface weighted H2H. Weight per match:
  //   recency: 1.0 se <365d, 0.5 se ≥365d
  //   surface: 1.0 se mesma superfície, 0.4 se diferente (penaliza misto)
  //            (clay-clay, hard-hard, etc → 1.0; clay-grass → 0.4)
  //   final = recency × surface
  // Sem opts.currentSurface, surface_factor = 1.0 (compatibilidade backward).
  const currentSurface = opts.currentSurface ? String(opts.currentSurface).toLowerCase() : null;
  const sameSurfaceWeight = Number.isFinite(opts.sameSurfaceWeight) ? opts.sameSurfaceWeight : 1.0;
  const diffSurfaceWeight = Number.isFinite(opts.diffSurfaceWeight) ? opts.diffSurfaceWeight : 0.4;

  let weightedT1Wins = 0, weightedTotal = 0;
  let surfaceMatches = 0;
  const now = Date.now();
  const results = Array.isArray(h2hData.results) ? h2hData.results : [];
  // 2026-05-03 FIX: aceitar player1Name pra resolver corretamente isT1Win quando
  // r.home alterna entre player1/player2 (matches são salvos com home conforme
  // posicionamento no source). Antes assumia r.home === player1 sempre — quando
  // metade dos H2H tinha home flippado, contava vitórias do lado errado, podendo
  // virar P_h2h pra o lado oposto da realidade.
  const _normName = s => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
  const player1Norm = opts.player1Name ? _normName(opts.player1Name) : null;
  if (results.length === total) {
    let homeFlipDetected = false;
    for (const r of results) {
      const dt = r.date ? new Date(r.date).getTime() : 0;
      const ageDays = dt > 0 ? (now - dt) / (24 * 60 * 60 * 1000) : recencyBoostDays;
      const recencyW = ageDays <= recencyBoostDays ? 1.0 : 0.5;
      let surfaceW = 1.0;
      if (currentSurface) {
        const matchSurface = inferSurface(r.league);
        if (matchSurface !== 'unknown') {
          const compatible = (matchSurface === currentSurface)
            || (matchSurface === 'hard_indoor' && currentSurface === 'hard')
            || (matchSurface === 'hard' && currentSurface === 'hard_indoor');
          surfaceW = compatible ? sameSurfaceWeight : diffSurfaceWeight;
          if (compatible) surfaceMatches++;
        }
      }
      const w = recencyW * surfaceW;
      const homeWon = (r.homeGoals || 0) > (r.awayGoals || 0);
      let isT1Win;
      if (player1Norm) {
        const homeNorm = _normName(r.home);
        const awayNorm = _normName(r.away);
        const homeIsP1 = homeNorm && (homeNorm === player1Norm
          || homeNorm.includes(player1Norm) || player1Norm.includes(homeNorm));
        const awayIsP1 = awayNorm && (awayNorm === player1Norm
          || awayNorm.includes(player1Norm) || player1Norm.includes(awayNorm));
        if (homeIsP1 && !awayIsP1) {
          isT1Win = homeWon;
        } else if (awayIsP1 && !homeIsP1) {
          isT1Win = !homeWon;
          if (!homeFlipDetected) homeFlipDetected = true;
        } else {
          // Ambíguo (sem name match em nenhum lado, ou ambos casaram). Fallback
          // para agregado proporcional — não conta esse match.
          continue;
        }
      } else {
        // Sem player1Name (caller legado): mantém heurística antiga (homeWon = t1Win).
        isT1Win = homeWon;
      }
      if (isT1Win) weightedT1Wins += w;
      weightedTotal += w;
    }
    // Se em todo o sample não conseguimos resolver (player names não bateram),
    // fallback para agregado uniforme.
    if (player1Norm && weightedTotal === 0) {
      weightedT1Wins = t1w;
      weightedTotal = total;
    }
  } else {
    weightedT1Wins = t1w;
    weightedTotal = total;
  }

  // Laplace smoothing
  const pH2h = weightedTotal > 0 ? (weightedT1Wins + alpha) / (weightedTotal + 2 * alpha) : 0.5;

  // Weight scales linearly até maxWeight quando effective_n>=10.
  // Effective_n usa weightedTotal (não n cru) — surface-mismatch reduz peso.
  // Floor: weightedTotal / 10 → cap maxWeight.
  const effectiveN = weightedTotal;
  const weight = Math.min(maxWeight, (effectiveN / 10) * maxWeight);

  // Blend
  const pBlend = (1 - weight) * pMarkov + weight * pH2h;
  const pBlendClamped = Math.max(0.05, Math.min(0.95, pBlend));

  return {
    pBlend: pBlendClamped,
    pH2h: +pH2h.toFixed(4),
    weight: +weight.toFixed(3),
    applied: true,
    reason: 'ok',
    n: total,
    t1Wins: t1w,
    weightedT1Wins: +weightedT1Wins.toFixed(2),
    weightedTotal: +weightedTotal.toFixed(2),
    surfaceMatches: currentSurface ? surfaceMatches : null,
    currentSurface: currentSurface,
  };
}

module.exports = { computeH2HEnsemble, inferSurface };

// ── Agents Extended ──
// 6 agents adicionais sobre os já existentes em lib/dashboard.js:
//   bankrollGuardian, preMatchFinalCheck, modelCalibrationWatcher,
//   cutAdvisor, liveStormManager, iaHealthMonitor

const http = require('http');
const https = require('https');
const url = require('url');

function agentHttpGet(targetUrl, timeoutMs = 10000, headers = {}) {
  return new Promise((resolve) => {
    const startTs = Date.now();
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET', protocol: u.protocol, hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, headers: { 'User-Agent': 'AgentsExtended/1.0', ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, latency: Date.now() - startTs }));
    });
    req.on('error', e => resolve({ status: 0, latency: Date.now() - startTs, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, latency: Date.now() - startTs, error: 'timeout' }); });
    req.end();
  });
}

// ════════════════════════════════════════════════════════════════════
// 1. Bankroll Guardian
// ════════════════════════════════════════════════════════════════════
async function runBankrollGuardian(serverBase, db) {
  const out = { at: Date.now(), sports: [], overall: null, alerts: [] };
  if (!db) return { ok: false, error: 'db indisponível' };

  const SPORTS_LIST = ['esports', 'mma', 'tennis', 'football', 'cs', 'valorant', 'darts', 'snooker', 'tabletennis'];
  let totalCurrent = 0, totalInitial = 0, totalPeak = 0;

  for (const sport of SPORTS_LIST) {
    try {
      const equity = await agentHttpGet(`${serverBase}/equity-curve?sport=${sport}&days=30`, 10000).catch(() => null);
      if (!equity?.body) continue;
      const data = JSON.parse(equity.body);
      if (data?.error || !data.series) continue;

      const initial = Number(data.initial_banca) || 0;
      const current = Number(data.current_banca) || initial;
      const peak = Number(data.peak_banca) || initial;
      const drawdownPct = peak > 0 ? ((peak - current) / peak) * 100 : 0;
      const growth = initial > 0 ? ((current - initial) / initial) * 100 : 0;

      const sportItem = {
        sport,
        initial_banca: initial,
        current_banca: current,
        peak_banca: peak,
        drawdown_pct: parseFloat(drawdownPct.toFixed(2)),
        growth_pct: parseFloat(growth.toFixed(2)),
        max_drawdown_pct: data.max_drawdown_pct,
        sharpe: data.sharpe_annualized,
        days_settled: data.days_settled,
      };

      // Severity por DD
      if (drawdownPct >= 25) {
        sportItem.severity = 'critical';
        sportItem.action_recommended = 'BLOCK_BOT';
        out.alerts.push({ sport, severity: 'critical', drawdown_pct: drawdownPct, action: 'BLOCK_BOT', message: `${sport}: DD ${drawdownPct.toFixed(1)}% — bloquear emissão até intervenção` });
      } else if (drawdownPct >= 15) {
        sportItem.severity = 'warning';
        sportItem.action_recommended = 'AUTO_SHADOW';
        out.alerts.push({ sport, severity: 'warning', drawdown_pct: drawdownPct, action: 'AUTO_SHADOW', message: `${sport}: DD ${drawdownPct.toFixed(1)}% — auto-shadow temporário (1h)` });
      } else if (drawdownPct >= 10) {
        sportItem.severity = 'info';
        sportItem.action_recommended = 'REVIEW';
        out.alerts.push({ sport, severity: 'info', drawdown_pct: drawdownPct, action: 'REVIEW', message: `${sport}: DD ${drawdownPct.toFixed(1)}% — revisar perdas recentes` });
      } else {
        sportItem.severity = 'ok';
      }

      out.sports.push(sportItem);
      totalCurrent += current;
      totalInitial += initial;
      totalPeak += peak;
    } catch (_) {}
  }

  const overallDD = totalPeak > 0 ? ((totalPeak - totalCurrent) / totalPeak) * 100 : 0;
  out.overall = {
    total_current: parseFloat(totalCurrent.toFixed(2)),
    total_initial: parseFloat(totalInitial.toFixed(2)),
    total_peak: parseFloat(totalPeak.toFixed(2)),
    overall_drawdown_pct: parseFloat(overallDD.toFixed(2)),
    overall_growth_pct: totalInitial > 0 ? parseFloat((((totalCurrent - totalInitial) / totalInitial) * 100).toFixed(2)) : null,
  };
  out.summary = {
    sports_evaluated: out.sports.length,
    alerts: out.alerts.length,
    critical: out.alerts.filter(a => a.severity === 'critical').length,
    warning: out.alerts.filter(a => a.severity === 'warning').length,
  };
  out.ok = true;
  return out;
}

// ════════════════════════════════════════════════════════════════════
// 2. Pre-Match Final Check
// ════════════════════════════════════════════════════════════════════
async function runPreMatchFinalCheck(serverBase, db, opts = {}) {
  const out = { at: Date.now(), tips_checked: 0, alerts: [] };
  if (!db) return { ok: false, error: 'db indisponível' };
  const windowMin = parseInt(opts.windowMin || 30, 10);
  const oddsMoveThreshold = parseFloat(opts.oddsMoveThreshold || 0.10); // 10%

  // Pega tips pendentes de pré-jogo recentes (sent_at <48h — mais antigas
  // sao settlement-stale, nao cancelamento; deixa pro Health Sentinel pegar).
  let tips = [];
  try {
    tips = db.prepare(`
      SELECT id, sport, match_id, event_name, participant1, participant2,
             tip_participant, odds, ev, sent_at, is_live
      FROM tips
      WHERE result IS NULL
        AND COALESCE(is_live, 0) = 0
        AND sent_at IS NOT NULL
        AND sent_at >= datetime('now', '-48 hours')
      ORDER BY sent_at DESC
      LIMIT 100
    `).all();
  } catch (e) { return { ok: false, error: e.message }; }

  for (const tip of tips) {
    try {
      // Re-fetch odds atual via /odds (LoL/Dota) ou via *-matches (outros)
      const sportToEndpoint = {
        esports: '/lol-matches', dota: '/dota-matches', cs: '/cs-matches', valorant: '/valorant-matches',
        tennis: '/tennis-matches', mma: '/mma-matches', football: '/football-matches',
        darts: '/darts-matches', snooker: '/snooker-matches', tabletennis: '/tabletennis-matches',
      };
      const ep = sportToEndpoint[tip.sport];
      if (!ep) continue;

      const r = await agentHttpGet(`${serverBase}${ep}`, 10000).catch(() => null);
      if (!r?.body) continue;
      const matches = JSON.parse(r.body);
      if (!Array.isArray(matches)) continue;

      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const m = matches.find(x => norm(x.team1) === norm(tip.participant1) && norm(x.team2) === norm(tip.participant2));
      if (!m) {
        // Match não encontrado: 99% das vezes é tip cujo match já jogou (endpoint só
        // retorna upcoming/live). Só flagga 'cancelamento' se MUITO recente (<90min),
        // tempo médio de match LoL Bo1. Acima disso assume já-jogado e silent — settlement
        // ou Health Sentinel (settlement_stale) cuida.
        const sentMs = new Date((tip.sent_at || '').replace(' ', 'T') + 'Z').getTime();
        const sentAgeMin = (Date.now() - sentMs) / 60000;
        if (sentAgeMin > 90) continue; // skip silencioso
        out.alerts.push({
          tip_id: tip.id, sport: tip.sport, severity: 'warning',
          alert: 'match_missing',
          detail: `Tip #${tip.id} (${tip.participant1} vs ${tip.participant2}) não encontrada em ${ep} — possível cancelamento (tip há ${Math.round(sentAgeMin)}min)`,
        });
        continue;
      }

      // Filtro de janela: só checar se match começa em <windowMin
      const matchTs = new Date(m.time || 0).getTime();
      const minutesUntilMatch = (matchTs - Date.now()) / 60000;
      if (matchTs <= 0 || minutesUntilMatch < 0 || minutesUntilMatch > windowMin) continue;

      out.tips_checked++;

      // Match cancelado/postponed?
      if (m.status === 'cancelled' || m.status === 'postponed') {
        out.alerts.push({
          tip_id: tip.id, sport: tip.sport, severity: 'critical',
          alert: 'match_cancelled',
          detail: `Tip #${tip.id} ${m.team1} vs ${m.team2}: status=${m.status}`,
        });
        continue;
      }

      // Compare odd da tip vs odd atual da pick
      if (m.odds?.t1 && m.odds?.t2) {
        const pickIsT1 = norm(tip.tip_participant).includes(norm(m.team1)) || norm(m.team1).includes(norm(tip.tip_participant));
        const currentOdd = parseFloat(pickIsT1 ? m.odds.t1 : m.odds.t2);
        const tipOdd = parseFloat(tip.odds);
        if (currentOdd > 1 && tipOdd > 1) {
          const driftPct = (tipOdd - currentOdd) / tipOdd;
          if (driftPct > oddsMoveThreshold) {
            out.alerts.push({
              tip_id: tip.id, sport: tip.sport, severity: driftPct > 0.20 ? 'critical' : 'warning',
              alert: 'odds_moved_adverse',
              detail: `Tip #${tip.id} ${tip.tip_participant}: tip @${tipOdd} → mercado @${currentOdd} (${(driftPct * 100).toFixed(1)}% adverso)`,
              tip_odd: tipOdd, current_odd: currentOdd, drift_pct: parseFloat((driftPct * 100).toFixed(2)),
              minutes_until_match: parseFloat(minutesUntilMatch.toFixed(1)),
            });
          }
        }
      }
    } catch (_) {}
  }

  out.summary = {
    tips_checked: out.tips_checked,
    alerts: out.alerts.length,
    critical: out.alerts.filter(a => a.severity === 'critical').length,
    warning: out.alerts.filter(a => a.severity === 'warning').length,
  };
  out.ok = true;
  return out;
}

// ════════════════════════════════════════════════════════════════════
// 3. Model Calibration Watcher
// ════════════════════════════════════════════════════════════════════
async function runModelCalibrationWatcher(db) {
  const out = { at: Date.now(), sports: [], alerts: [] };
  if (!db) return { ok: false, error: 'db indisponível' };

  const SPORTS_LIST = ['esports', 'mma', 'tennis', 'football', 'cs', 'valorant', 'darts', 'snooker', 'tabletennis'];

  for (const sport of SPORTS_LIST) {
    try {
      // Brier 30d (recent)
      const recent = db.prepare(`
        SELECT odds, model_p_pick, result FROM tips
        WHERE sport = ? AND result IN ('win','loss')
          AND settled_at >= datetime('now', '-30 days')
          AND odds > 1
      `).all(sport);
      // Brier baseline 90d-30d (prior)
      const baseline = db.prepare(`
        SELECT odds, model_p_pick, result FROM tips
        WHERE sport = ? AND result IN ('win','loss')
          AND settled_at BETWEEN datetime('now', '-90 days') AND datetime('now', '-30 days')
          AND odds > 1
      `).all(sport);

      const calcBrier = (rows) => {
        if (!rows.length) return null;
        let sum = 0, n = 0;
        for (const r of rows) {
          const odds = Number(r.odds);
          const pStored = Number(r.model_p_pick);
          let p = (Number.isFinite(pStored) && pStored > 0 && pStored < 1) ? pStored : (1 / odds);
          p = Math.max(0.01, Math.min(0.99, p));
          const o = r.result === 'win' ? 1 : 0;
          sum += (p - o) ** 2; n++;
        }
        return { brier: sum / n, n };
      };

      const recentBrier = calcBrier(recent);
      const baselineBrier = calcBrier(baseline);

      if (!recentBrier) continue; // sem dados recentes

      const item = {
        sport,
        recent_brier: parseFloat(recentBrier.brier.toFixed(3)),
        recent_n: recentBrier.n,
        baseline_brier: baselineBrier ? parseFloat(baselineBrier.brier.toFixed(3)) : null,
        baseline_n: baselineBrier ? baselineBrier.n : 0,
        drift: baselineBrier ? parseFloat((recentBrier.brier - baselineBrier.brier).toFixed(3)) : null,
      };

      // Drift > 0.03 (Brier piorou 3 pontos) → alerta
      if (item.drift != null && item.drift > 0.03) {
        item.severity = 'warning';
        const suggestions = [`Investigar lib/${sport}-ml.js`, `Considerar shadow ${sport.toUpperCase()}_SHADOW=true por 1 sem`];
        if (sport === 'esports') suggestions.push('Rodar /recalcWeights');
        item.suggestions = suggestions;
        out.alerts.push({
          sport, severity: 'warning',
          message: `Modelo ${sport} degradou: Brier ${item.baseline_brier} → ${item.recent_brier} (drift +${item.drift})`,
          suggestions,
        });
      } else if (item.drift != null && item.drift < -0.03) {
        item.severity = 'info';
        item.note = `Modelo ${sport} melhorou: Brier ${item.baseline_brier} → ${item.recent_brier}`;
      } else {
        item.severity = 'ok';
      }
      out.sports.push(item);
    } catch (_) {}
  }

  out.summary = {
    sports_evaluated: out.sports.length,
    alerts: out.alerts.length,
  };
  out.ok = true;
  return out;
}

// ════════════════════════════════════════════════════════════════════
// 4. Cut Advisor
// ════════════════════════════════════════════════════════════════════
async function runCutAdvisor(serverBase) {
  const out = { at: Date.now(), candidates: [], scale_ups: [] };
  try {
    const matrixR = await agentHttpGet(`${serverBase}/roi-matrix?days=30`, 15000);
    const matrix = JSON.parse(matrixR.body);
    if (!matrix?.matrix) return { ok: false, error: 'roi-matrix indisponível' };

    for (const b of matrix.matrix) {
      // Estimativa de tip rate diário (tips/dia)
      const dailyRate = b.n / 30;
      const avgStake = b.stake_reais && b.n > 0 ? b.stake_reais / b.n : 0;
      const expectedDailyLoss = b.roi != null ? (dailyRate * avgStake * Math.abs(b.roi / 100)) : 0;

      if (b.health === 'vermelho' || b.health === 'vermelho_sem_clv') {
        out.candidates.push({
          bucket: `${b.sport}|${b.phase}|${b.tier}`,
          n: b.n, roi: b.roi, clv_avg: b.clv_avg,
          daily_tip_rate: parseFloat(dailyRate.toFixed(2)),
          avg_stake_reais: parseFloat(avgStake.toFixed(2)),
          expected_daily_loss_reais: parseFloat(expectedDailyLoss.toFixed(2)),
          recommendation: b.n >= 30
            ? `CUT NOW: shadow ${b.sport.toUpperCase()}_SHADOW=true (salva ~R$${expectedDailyLoss.toFixed(2)}/dia)`
            : `WAIT: small sample (n=${b.n}, esperar n>=30)`,
          suggestion_env: b.n >= 30 ? `${b.sport.toUpperCase()}_SHADOW=true` : null,
        });
      } else if (b.health === 'verde' || b.health === 'verde_sem_clv') {
        const expectedDailyProfit = (dailyRate * avgStake * (b.roi / 100));
        out.scale_ups.push({
          bucket: `${b.sport}|${b.phase}|${b.tier}`,
          n: b.n, roi: b.roi, clv_avg: b.clv_avg,
          expected_daily_profit_reais: parseFloat(expectedDailyProfit.toFixed(2)),
          recommendation: b.n >= 30
            ? `SCALE UP: aumentar Kelly fraction nesse bucket`
            : `OBSERVE: aguardar n>=30 antes de scale`,
        });
      }
    }
    // Ordena por impacto
    out.candidates.sort((a, b) => b.expected_daily_loss_reais - a.expected_daily_loss_reais);
    out.scale_ups.sort((a, b) => b.expected_daily_profit_reais - a.expected_daily_profit_reais);

    out.summary = {
      candidates: out.candidates.length,
      ready_to_cut: out.candidates.filter(c => c.suggestion_env).length,
      scale_ups: out.scale_ups.length,
      total_daily_loss_at_risk_reais: parseFloat(out.candidates.reduce((a, c) => a + c.expected_daily_loss_reais, 0).toFixed(2)),
    };
    out.ok = true;
    return out;
  } catch (e) { return { ok: false, error: e.message }; }
}

// ════════════════════════════════════════════════════════════════════
// 5. Live Storm Manager
// ════════════════════════════════════════════════════════════════════
async function runLiveStormManager(serverBase) {
  const out = { at: Date.now(), live_total: 0, by_sport: {}, storm_active: false, recommendations: [] };
  try {
    const snapR = await agentHttpGet(`${serverBase}/live-snapshot`, 10000);
    const snap = JSON.parse(snapR.body);
    if (!snap?.sports) return { ok: false, error: 'live-snapshot indisponível' };

    let total = 0;
    for (const [sport, items] of Object.entries(snap.sports)) {
      const n = Array.isArray(items) ? items.length : 0;
      out.by_sport[sport] = n;
      total += n;
    }
    out.live_total = total;
    out.storm_threshold = parseInt(process.env.LIVE_STORM_THRESHOLD || '15', 10);
    out.storm_active = total >= out.storm_threshold;

    if (out.storm_active) {
      // Recomenda priorização
      const bySize = Object.entries(out.by_sport).sort((a, b) => b[1] - a[1]);
      out.recommendations.push(`Live Storm ativo (${total} partidas). Sports a priorizar: ${bySize.slice(0, 3).map(([s, n]) => `${s}(${n})`).join(', ')}`);
      out.recommendations.push(`Sugestão: aumentar cooldown sports >5 partidas pra liberar CPU`);
      out.recommendations.push(`Considerar: ENV LIVE_STORM_FAST_POLL_SPORTS="dota,lol" pra reduzir interval só nos prioritários`);
    } else {
      out.recommendations.push(`Volume normal (${total} partidas live). Sem ação necessária.`);
    }
    out.ok = true;
    return out;
  } catch (e) { return { ok: false, error: e.message }; }
}

// ════════════════════════════════════════════════════════════════════
// 6. IA Health Monitor
// ════════════════════════════════════════════════════════════════════
async function runIaHealthMonitor(serverBase, getClassifiedBuffer) {
  const out = { at: Date.now(), tests: {}, parse_failure_rate_24h: null, alerts: [] };
  const buffer = typeof getClassifiedBuffer === 'function' ? getClassifiedBuffer() : [];
  const recent = buffer.slice(-5000);

  // 1) Parse failure rate (24h)
  const parseFailures = recent.filter(l => /Sem TIP_ML na resposta|IA sem TIP_ML parse/i.test(l.text || '')).length;
  const iaResponses = recent.filter(l => /\[AUTO.*\] (Iniciando|Analisando)/i.test(l.text || '')).length;
  if (iaResponses > 0) {
    out.parse_failure_rate_24h = parseFloat((parseFailures / iaResponses * 100).toFixed(1));
    if (out.parse_failure_rate_24h > 15) {
      out.alerts.push({
        severity: 'warning',
        message: `IA parse failure rate ${out.parse_failure_rate_24h}% (>15% threshold) — possível drift de formato`,
        suggestion: 'Revisar prompts em bot.js e _parseTipMl regex',
      });
    }
  }

  // 2) Backoff status
  const backoffActive = recent.find(l => /DeepSeek 429: backoff (\d+)min/i.test(l.text || ''));
  if (backoffActive) {
    out.backoff_recent = (l => {
      const m = (l.text || '').match(/backoff (\d+)min/);
      return { at: l.t, minutes: m ? parseInt(m[1], 10) : null, ageMin: Math.round((Date.now() - l.t) / 60000) };
    })(backoffActive);
  }

  // 3) Sanity test: prompt fixo conhecido
  try {
    const sanityPrompt = 'Responda APENAS com a palavra OK seguida de um ponto, sem nada mais.';
    const r = await agentHttpGet(`${serverBase}/claude?_sanity=1`, 30000).catch(() => null);
    // /claude é POST então não dá pra testar via GET. Skip por ora — adicionar /claude/sanity endpoint depois.
    out.tests.sanity = { skipped: true, reason: '/claude endpoint é POST' };
  } catch (_) {}

  // 4) IA error logs recentes (1h)
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const iaErrors = recent.filter(l => l.t > oneHourAgo && /IA erro:|claude erro|deepseek.*erro/i.test(l.text || ''));
  out.ia_errors_1h = iaErrors.length;
  if (iaErrors.length > 5) {
    out.alerts.push({
      severity: 'critical',
      message: `${iaErrors.length} erros IA na última hora`,
      suggestion: 'Verificar DEEPSEEK_API_KEY e quota',
    });
  }

  out.summary = {
    parse_failure_rate_24h: out.parse_failure_rate_24h,
    ia_errors_1h: out.ia_errors_1h,
    backoff_active: !!backoffActive,
    alerts: out.alerts.length,
  };
  out.ok = true;
  return out;
}

// ════════════════════════════════════════════════════════════════════
// 7b. Backtest Validator — automatiza o scripts/backtest-v2.js
//     Roda diariamente, calcula Brier modelo vs baseline (apostar implied
//     dejuiced), detecta edge real vs ruido, alerta marcos (n=30, n=100, n=300).
// ════════════════════════════════════════════════════════════════════
const _GATES = {
  SHARP_CAP_PP: { esports: 15, dota: 15, mma: 10, tennis: 12, football: 10, cs: 12, valorant: 12, darts: 15, snooker: 15, tabletennis: 20 },
  EV_SANITY_MAX: 50,
  LOL_TIER2_EV_CAP: 25,
  LOL_TIER1_RE: /\b(lck|lec|lcs|lpl|msi|worlds|cblol|cbloldbrazil|lla|pcs|lco|vcs|esports world cup)\b/i,
  CS_TIER1_RE: /\b(major|iem\b|katowice|cologne|esl pro league|epl\b|blast premier|esports world cup|ewc|austin|rio|shanghai|paris)\b/i,
};
const _isLolTier1 = (s) => _GATES.LOL_TIER1_RE.test(s || '');
const _isCsTier1 = (s) => _GATES.CS_TIER1_RE.test(s || '');

function _applyGatesRetroactive(tip) {
  const reasons = [];
  const odds = parseFloat(tip.odds);
  const ev = parseFloat(tip.ev);
  const modelP = parseFloat(tip.model_p_pick);

  if (ev > _GATES.EV_SANITY_MAX) reasons.push(`ev_sanity_${ev.toFixed(0)}>50`);

  if (Number.isFinite(modelP) && Number.isFinite(odds) && odds > 1) {
    const impliedRaw = 1 / odds;
    const impliedDejuiced = impliedRaw / 1.025;
    const divPp = Math.abs(modelP - impliedDejuiced) * 100;
    const cap = _GATES.SHARP_CAP_PP[tip.sport] ?? 15;
    if (divPp > cap) reasons.push(`sharp_div_${divPp.toFixed(0)}>${cap}`);
  }
  if (tip.sport === 'esports' && !_isLolTier1(tip.event_name) && ev > _GATES.LOL_TIER2_EV_CAP) {
    reasons.push(`lol_tier2_ev_${ev.toFixed(0)}>25`);
  }
  if (tip.sport === 'cs' && !_isCsTier1(tip.event_name) && tip.confidence === 'ALTA') {
    reasons.push(`cs_tier2_alta_rebaixada`);
  }
  if (tip.sport === 'mma' && ev > 18) {
    reasons.push(`mma_high_ev_check_book`);
  }

  return { passed: reasons.length === 0, reasons };
}

function _brierScore(p, outcome) {
  const pClamped = Math.max(0.01, Math.min(0.99, p));
  return (pClamped - outcome) ** 2;
}

async function runBacktestValidator(db, opts = {}) {
  if (!db) return { ok: false, error: 'db indisponível' };
  const days = opts.days || 90;

  let tips;
  try {
    tips = db.prepare(`
      SELECT id, sport, event_name, participant1, participant2, tip_participant,
             odds, ev, stake_reais, profit_reais, confidence, is_live,
             sent_at, settled_at, result, model_p_pick
      FROM tips
      WHERE result IN ('win','loss','push')
        AND settled_at IS NOT NULL
        AND settled_at >= datetime('now', ?)
      ORDER BY sent_at ASC
    `).all(`-${days} days`);
  } catch (e) { return { ok: false, error: e.message }; }

  if (!tips.length) return { ok: true, days, total_tips: 0, sports: [], verdict: { overall: 'no_data' } };

  // Per-sport buckets
  const bySport = new Map();
  let totalReal = { n: 0, wins: 0, losses: 0, stakeR: 0, profitR: 0, brierSum: 0, brierN: 0, baselineBrier: 0, baselineN: 0 };
  let totalHyp = { n: 0, wins: 0, losses: 0, stakeR: 0, profitR: 0, brierSum: 0, brierN: 0, blocked: 0, savedLoss: 0, lostProfit: 0 };

  for (const tip of tips) {
    const sport = tip.sport;
    const odds = parseFloat(tip.odds);
    const stakeR = Number(tip.stake_reais) || 0;
    const profitR = tip.result === 'push' ? 0 : Number(tip.profit_reais) || 0;
    const isWin = tip.result === 'win';
    const isLoss = tip.result === 'loss';
    const pStored = parseFloat(tip.model_p_pick);
    const pUsed = (Number.isFinite(pStored) && pStored > 0 && pStored < 1) ? pStored : (odds > 1 ? 1 / odds : 0.5);

    if (!bySport.has(sport)) bySport.set(sport, {
      sport,
      real: { n: 0, wins: 0, losses: 0, stakeR: 0, profitR: 0, brierSum: 0, brierN: 0, baselineBrier: 0, baselineN: 0 },
      hyp:  { n: 0, wins: 0, losses: 0, stakeR: 0, profitR: 0, brierSum: 0, brierN: 0, blocked: 0, savedLoss: 0, lostProfit: 0 },
    });
    const sb = bySport.get(sport);

    // REAL
    sb.real.n++;
    if (isWin) sb.real.wins++; else if (isLoss) sb.real.losses++;
    sb.real.stakeR += stakeR;
    sb.real.profitR += profitR;
    if (isWin || isLoss) {
      sb.real.brierSum += _brierScore(pUsed, isWin ? 1 : 0);
      sb.real.brierN++;
      if (odds > 1) {
        sb.real.baselineBrier += _brierScore(1 / odds, isWin ? 1 : 0);
        sb.real.baselineN++;
        totalReal.baselineBrier += _brierScore(1 / odds, isWin ? 1 : 0);
        totalReal.baselineN++;
      }
    }

    totalReal.n++;
    if (isWin) totalReal.wins++; else if (isLoss) totalReal.losses++;
    totalReal.stakeR += stakeR;
    totalReal.profitR += profitR;
    if (isWin || isLoss) { totalReal.brierSum += _brierScore(pUsed, isWin ? 1 : 0); totalReal.brierN++; }

    // HYP — gates retroativos
    const gateResult = _applyGatesRetroactive(tip);
    if (!gateResult.passed) {
      sb.hyp.blocked++;
      totalHyp.blocked++;
      if (isWin) { sb.hyp.lostProfit += profitR; totalHyp.lostProfit += profitR; }
      else if (isLoss) { sb.hyp.savedLoss += Math.abs(profitR); totalHyp.savedLoss += Math.abs(profitR); }
      continue;
    }
    sb.hyp.n++;
    if (isWin) sb.hyp.wins++; else if (isLoss) sb.hyp.losses++;
    sb.hyp.stakeR += stakeR;
    sb.hyp.profitR += profitR;
    if (isWin || isLoss) {
      sb.hyp.brierSum += _brierScore(pUsed, isWin ? 1 : 0);
      sb.hyp.brierN++;
    }
    totalHyp.n++;
    if (isWin) totalHyp.wins++; else if (isLoss) totalHyp.losses++;
    totalHyp.stakeR += stakeR;
    totalHyp.profitR += profitR;
    if (isWin || isLoss) { totalHyp.brierSum += _brierScore(pUsed, isWin ? 1 : 0); totalHyp.brierN++; }
  }

  // Veredito por sport
  const verdictSport = (sb) => {
    const r = sb.real;
    const decided = r.wins + r.losses;
    const roi = r.stakeR > 0 ? (r.profitR / r.stakeR) * 100 : 0;
    const brier = r.brierN > 0 ? r.brierSum / r.brierN : null;
    const baselineBrier = r.baselineN > 0 ? r.baselineBrier / r.baselineN : null;
    const brierEdge = (brier != null && baselineBrier != null) ? (baselineBrier - brier) : null;

    if (r.n < 30) return { code: 'insufficient', label: '⚪ Sample insuficiente', detail: `n=${r.n} (precisa ≥30)` };
    if (brierEdge != null && brierEdge > 0.005 && roi > 3) return { code: 'edge_real', label: '🟢 Edge calibrado', detail: `Brier ${brier.toFixed(3)} < baseline ${baselineBrier.toFixed(3)} | ROI +${roi.toFixed(1)}%` };
    if (brierEdge != null && brierEdge > 0.005) return { code: 'good_calib_lo_roi', label: '🟡 Calibração boa, ROI baixo', detail: `Brier ${brier.toFixed(3)} < baseline ${baselineBrier.toFixed(3)} | ROI ${roi.toFixed(1)}% (variância ou bookie price tight)` };
    if (brierEdge != null && brierEdge < -0.005) return { code: 'noise', label: '🔴 Modelo gerando ruído', detail: `Brier ${brier.toFixed(3)} > baseline ${baselineBrier.toFixed(3)} (PIOR que apostar implied)` };
    if (roi > 5) return { code: 'roi_no_calib', label: '🟢 ROI positivo, calibração neutra', detail: `ROI +${roi.toFixed(1)}% mas Brier ≈ baseline` };
    if (roi < -10) return { code: 'bleed', label: '🔴 BLEED', detail: `ROI ${roi.toFixed(1)}%` };
    return { code: 'breakeven', label: '🟡 Break-even', detail: `ROI ${roi.toFixed(1)}% | Brier ≈ baseline` };
  };

  const sports = [];
  for (const sb of bySport.values()) {
    const v = verdictSport(sb);
    const r = sb.real, h = sb.hyp;
    const realRoi = r.stakeR > 0 ? (r.profitR / r.stakeR) * 100 : 0;
    const hypRoi = h.stakeR > 0 ? (h.profitR / h.stakeR) * 100 : 0;
    const netGate = h.savedLoss - h.lostProfit;
    sports.push({
      sport: sb.sport,
      n: r.n,
      wins: r.wins, losses: r.losses,
      hit_rate: r.wins + r.losses > 0 ? parseFloat((r.wins / (r.wins + r.losses) * 100).toFixed(1)) : null,
      roi: parseFloat(realRoi.toFixed(2)),
      profit_reais: parseFloat(r.profitR.toFixed(2)),
      brier: r.brierN > 0 ? parseFloat((r.brierSum / r.brierN).toFixed(3)) : null,
      baseline_brier: r.baselineN > 0 ? parseFloat((r.baselineBrier / r.baselineN).toFixed(3)) : null,
      brier_edge: (r.brierN > 0 && r.baselineN > 0) ? parseFloat(((r.baselineBrier / r.baselineN) - (r.brierSum / r.brierN)).toFixed(3)) : null,
      gates_blocked: h.blocked,
      gates_saved_loss_reais: parseFloat(h.savedLoss.toFixed(2)),
      gates_lost_profit_reais: parseFloat(h.lostProfit.toFixed(2)),
      gates_net_reais: parseFloat(netGate.toFixed(2)),
      hyp_n: h.n,
      hyp_roi: h.stakeR > 0 ? parseFloat(hypRoi.toFixed(2)) : null,
      verdict: v,
    });
  }

  // Veredito overall
  const totalRealRoi = totalReal.stakeR > 0 ? (totalReal.profitR / totalReal.stakeR) * 100 : 0;
  const totalBrier = totalReal.brierN > 0 ? totalReal.brierSum / totalReal.brierN : null;
  const totalBaselineBrier = totalReal.baselineN > 0 ? totalReal.baselineBrier / totalReal.baselineN : null;
  const totalBrierEdge = (totalBrier != null && totalBaselineBrier != null) ? (totalBaselineBrier - totalBrier) : null;
  const totalNetGate = totalHyp.savedLoss - totalHyp.lostProfit;

  let overallVerdict;
  if (totalReal.n < 30) overallVerdict = { code: 'insufficient', label: '⚪ Aguardando dados (n<30)' };
  else if (totalBrierEdge != null && totalBrierEdge > 0.005 && totalRealRoi > 3) overallVerdict = { code: 'edge_real', label: '🟢 Modelo TEM edge real' };
  else if (totalBrierEdge != null && totalBrierEdge < -0.005) overallVerdict = { code: 'noise', label: '🔴 Modelo gerando RUÍDO (pior que random)' };
  else if (totalRealRoi < -5) overallVerdict = { code: 'bleed', label: '🔴 ROI BLEED' };
  else overallVerdict = { code: 'inconclusive', label: '🟡 Inconclusivo (n<100 ou edge marginal)' };

  // Marcos atingidos
  const milestones = [];
  for (const s of sports) {
    if (s.n >= 30 && s.n < 35) milestones.push({ sport: s.sport, milestone: 'n=30 (sample mínimo pra veredito)' });
    if (s.n >= 100 && s.n < 105) milestones.push({ sport: s.sport, milestone: 'n=100 (sample relevante)' });
    if (s.n >= 300 && s.n < 305) milestones.push({ sport: s.sport, milestone: 'n=300 (sample maduro)' });
  }

  return {
    ok: true,
    at: Date.now(),
    days,
    total_tips: totalReal.n,
    overall: {
      n: totalReal.n,
      roi: parseFloat(totalRealRoi.toFixed(2)),
      profit_reais: parseFloat(totalReal.profitR.toFixed(2)),
      brier: totalBrier != null ? parseFloat(totalBrier.toFixed(3)) : null,
      baseline_brier: totalBaselineBrier != null ? parseFloat(totalBaselineBrier.toFixed(3)) : null,
      brier_edge: totalBrierEdge != null ? parseFloat(totalBrierEdge.toFixed(3)) : null,
      gates_net_reais: parseFloat(totalNetGate.toFixed(2)),
      gates_blocked: totalHyp.blocked,
      hyp_roi: totalHyp.stakeR > 0 ? parseFloat(((totalHyp.profitR / totalHyp.stakeR) * 100).toFixed(2)) : null,
      verdict: overallVerdict,
    },
    sports,
    milestones,
    summary: {
      total_sports: sports.length,
      edge_real: sports.filter(s => s.verdict.code === 'edge_real').length,
      bleed: sports.filter(s => s.verdict.code === 'bleed' || s.verdict.code === 'noise').length,
      insufficient: sports.filter(s => s.verdict.code === 'insufficient').length,
      breakeven: sports.filter(s => s.verdict.code === 'breakeven' || s.verdict.code === 'good_calib_lo_roi').length,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// 7. News Monitor — RSS feeds + keyword scan + tip impact detection
// ════════════════════════════════════════════════════════════════════
// Sources estaveis por sport. Cada item: { sport, url, parser? }.
// Default parser usa parseRss() abaixo. Custom parser pra sites com format proprio.
const NEWS_SOURCES = [
  // CS
  { sport: 'cs', label: 'HLTV news', url: 'https://www.hltv.org/rss/news' },
  // MMA
  { sport: 'mma', label: 'Sherdog', url: 'https://www.sherdog.com/rss/news.xml' },
  { sport: 'mma', label: 'MMA Fighting', url: 'https://www.mmafighting.com/rss/index.xml' },
  // Tennis
  { sport: 'tennis', label: 'Tennis.com', url: 'https://www.tennis.com/rss' },
  // Esports (LoL/Dota): RSS oficial é raro; usamos Google News com query especifica.
  { sport: 'esports', label: 'Google News LoL', url: 'https://news.google.com/rss/search?q=%22league+of+legends%22+esports&hl=en-US&gl=US&ceid=US:en' },
  { sport: 'esports', label: 'Google News Dota 2', url: 'https://news.google.com/rss/search?q=%22dota+2%22+roster+OR+lineup&hl=en-US&gl=US&ceid=US:en' },
  // Valorant
  { sport: 'valorant', label: 'Google News VCT', url: 'https://news.google.com/rss/search?q=%22vct%22+OR+%22valorant+champions%22&hl=en-US&gl=US&ceid=US:en' },
];

// Keywords criticas vs warning. Critical = match impossivel/cancelado.
const NEWS_KEYWORDS = {
  critical: [
    /\b(cancel(?:led|ed)?|postpon(?:ed|ement)|withdraw(?:al|n)?|forfeit|disqualif(?:y|ied)|DQ\b)/i,
    /\b(VAC ban|account ban|suspend(?:ed|ion))/i,
  ],
  warning: [
    /\b(injur(?:y|ed)|sick|illness|stand-?in|substitute(?:d)?|sub\b|out\b|won't play|will not play)/i,
    /\b(roster (?:change|swap)|lineup change|new (?:player|coach))/i,
    /\b(hospitaliz(?:ed|ation)|emergency|family (?:matter|emergency))/i,
  ],
};

function _parseRssTitles(xml) {
  const items = [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h window
  const itemRx = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRx.exec(xml)) !== null && items.length < 30) {
    const block = m[1];
    const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) ||
                   /<title>(.*?)<\/title>/.exec(block))?.[1]?.trim();
    if (!title) continue;
    const pubStr = /<pubDate>(.*?)<\/pubDate>/.exec(block)?.[1]?.trim();
    let pubTs = null;
    if (pubStr) {
      const t = new Date(pubStr).getTime();
      if (!isNaN(t)) {
        if (t < cutoff) continue;
        pubTs = t;
      }
    }
    const link = /<link>(.*?)<\/link>/.exec(block)?.[1]?.trim();
    items.push({
      title: title
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
      link: link || null,
      pubTs,
    });
  }
  return items;
}

function _classifyNews(title) {
  for (const re of NEWS_KEYWORDS.critical) if (re.test(title)) return 'critical';
  for (const re of NEWS_KEYWORDS.warning) if (re.test(title)) return 'warning';
  return null;
}

async function runNewsMonitor(serverBase, db, opts = {}) {
  const out = { at: Date.now(), fetched: {}, alerts: [] };
  if (!db) return { ok: false, error: 'db indisponível' };

  // 1. Pega tips pendentes pra cruzar com nomes mencionados em news
  let pendingTips = [];
  try {
    pendingTips = db.prepare(`
      SELECT id, sport, participant1, participant2, tip_participant, sent_at, event_name
      FROM tips
      WHERE result IS NULL
      ORDER BY sent_at DESC LIMIT 100
    `).all();
  } catch (_) {}
  // Build lookup: lowercase team name → list of tip ids
  const teamToTips = new Map();
  for (const t of pendingTips) {
    [t.participant1, t.participant2].forEach(name => {
      if (!name) return;
      const key = String(name).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      if (!key) return;
      if (!teamToTips.has(key)) teamToTips.set(key, []);
      teamToTips.get(key).push(t);
    });
  }

  // 2. Fetch RSS de todas sources em paralelo
  const fetchPromises = NEWS_SOURCES.map(async (src) => {
    const r = await agentHttpGet(src.url, 8000, { 'Accept': 'application/rss+xml, text/xml, */*' });
    if (r.status !== 200 || !r.body) return { ...src, items: [], error: r.error || `HTTP ${r.status}` };
    try {
      return { ...src, items: _parseRssTitles(r.body), latency: r.latency };
    } catch (e) { return { ...src, items: [], error: e.message }; }
  });
  const results = await Promise.all(fetchPromises);

  // 3. Pra cada item, classifica + cruza com tips pendentes
  const seenAlerts = new Set();
  for (const src of results) {
    out.fetched[src.label] = { count: src.items?.length || 0, error: src.error || null };
    for (const item of (src.items || [])) {
      const classification = _classifyNews(item.title);
      if (!classification) continue;
      // Procura nome de time/jogador no título
      const titleLow = item.title.toLowerCase();
      const matchedTips = [];
      for (const [teamKey, tips] of teamToTips.entries()) {
        if (teamKey.length < 3) continue;
        // Match por palavra completa (evita "G2" matchando "G2A")
        const teamWordRe = new RegExp(`\\b${teamKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (teamWordRe.test(titleLow)) {
          for (const t of tips) if (t.sport === src.sport) matchedTips.push(t);
        }
      }
      // Sem match com tips: ainda pode interessar (preview), mas só inclui se critical
      if (matchedTips.length === 0 && classification !== 'critical') continue;
      const dedupKey = `${src.label}::${item.title.slice(0, 80)}`;
      if (seenAlerts.has(dedupKey)) continue;
      seenAlerts.add(dedupKey);
      out.alerts.push({
        severity: classification,
        sport: src.sport,
        source: src.label,
        title: item.title.slice(0, 220),
        link: item.link,
        pub_ts: item.pubTs,
        matched_tip_ids: matchedTips.map(t => t.id),
        matched_tips_count: matchedTips.length,
      });
    }
  }

  // 4. Sort: critical primeiro, depois com tip match, depois recentes
  out.alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    if (a.matched_tips_count !== b.matched_tips_count) return b.matched_tips_count - a.matched_tips_count;
    return (b.pub_ts || 0) - (a.pub_ts || 0);
  });

  out.summary = {
    sources_fetched: results.length,
    sources_ok: results.filter(r => !r.error).length,
    total_alerts: out.alerts.length,
    critical: out.alerts.filter(a => a.severity === 'critical').length,
    warning: out.alerts.filter(a => a.severity === 'warning').length,
    tips_affected: new Set(out.alerts.flatMap(a => a.matched_tip_ids)).size,
  };
  out.ok = true;
  return out;
}

// ════════════════════════════════════════════════════════════════════
// Decision Tree (runbook automatizado)
// ════════════════════════════════════════════════════════════════════
function getDecisionTree() {
  return {
    playbooks: [
      {
        situation: 'Bucket virou CUT no Weekly Review',
        steps: [
          '1. Anote sport/phase/tier do bucket vermelho',
          '2. Setar env no Railway: <SPORT>_SHADOW=true',
          '3. Restart serviço (ou aguarda auto-deploy)',
          '4. Confirmar via /agents/weekly-review que bucket sumiu da lista CUT',
          '5. Acompanhar 14 dias em shadow — se CLV recuperar, restore manual',
        ],
        triggers: ['weekly-review action HIGH/CUT', 'cut-advisor candidate ready_to_cut'],
      },
      {
        situation: 'Auto-healer aplicou fix mutex_stale 3x em 24h',
        steps: [
          '1. Investigar root cause: provável MMA com IA cap travando',
          '2. Reduzir MMA_MAX_IA_CALLS_PER_CYCLE no Railway (default 18 → 10)',
          '3. Considerar AUTO_ANALYSIS_MUTEX_STALE_MIN=5 (era 15)',
          '4. Se persistir, mover MMA pra scheduler independente como Valorant/CS',
        ],
        triggers: ['auto-healer mutex_stale repeated'],
      },
      {
        situation: 'Bankroll Guardian disparou DD>15%',
        steps: [
          '1. Auto-shadow temporário já foi aplicado pelo guardian',
          '2. Abrir /agents/cut-advisor pra ver bucket que mais perdeu',
          '3. Se bucket é tier 2-3, considerar cap permanente (ex: LOL_MAX_DIVERGENCE_PP=10)',
          '4. Aguardar 24h antes de unshadow — auto-restore quando DD<10%',
        ],
        triggers: ['bankroll-guardian DD>=15'],
      },
      {
        situation: 'Pre-Match Final Check: odds moveram >15% adverso',
        steps: [
          '1. Tip ainda não foi enviada com odd nova — usuário recebeu odd antiga',
          '2. Considerar enviar correção via DM admin pra usuários afetados',
          '3. Se padrão repete num sport, reduzir TENNIS_PINNACLE_TTL_LIVE (move odds rápido)',
        ],
        triggers: ['pre-match-check odds_moved_adverse'],
      },
      {
        situation: 'Model Calibration: drift +0.03 em sport',
        steps: [
          '1. Sport com modelo degradado — tips ficando menos calibradas',
          '2. Para esports: rodar /recalcWeights via admin command',
          '3. Para outros sports: revisar lib/<sport>-ml.js — talvez novo meta/regulamento',
          '4. Como mitigação imediata: aumentar EV mínimo do sport em +2pp',
        ],
        triggers: ['model-calibration drift > 0.03'],
      },
      {
        situation: 'Live Storm: >15 partidas live simultâneas',
        steps: [
          '1. Sistema está sobrecarregado',
          '2. Setar LIVE_STORM_FAST_POLL_SPORTS="dota,lol" (priorizar tier1 com edge real)',
          '3. Aumentar interval dos sports menos prioritários temporariamente',
          '4. Após storm, reverter envs',
        ],
        triggers: ['live-storm storm_active'],
      },
      {
        situation: 'IA Health: parse failure rate >15%',
        steps: [
          '1. DeepSeek mudou formato de resposta',
          '2. Pegar últimas 10 respostas via /logs/history grep IA-RESP',
          '3. Comparar com regex em _parseTipMl (bot.js linha 70+)',
          '4. Atualizar regex se mudou',
        ],
        triggers: ['ia-health parse_failure_rate_24h > 15'],
      },
    ],
  };
}

module.exports = {
  runBankrollGuardian,
  runPreMatchFinalCheck,
  runModelCalibrationWatcher,
  runCutAdvisor,
  runLiveStormManager,
  runIaHealthMonitor,
  runNewsMonitor,
  runBacktestValidator,
  getDecisionTree,
};

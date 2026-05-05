'use strict';

/**
 * readiness-learner.js
 *
 * Fecha o loop "detectei leak → ajo → verifico → escalo ou restauro".
 *
 * Contexto: /shadow-readiness?source=real flag cells como LEAK quando ROI < -3%
 * com n≥30. Os 11 guards existentes (mt-leak-guard, league-blocklist,
 * kelly-auto-tune, brier-cap, etc.) reagem a triggers próprios e nem sempre
 * pegam o mesmo cell. O learner usa o veredicto consolidado do readiness
 * como source-of-truth pra decidir e aplicar ações reversíveis com tracking.
 *
 * Ações aplicadas (escalation order):
 *   L1 kelly_cut    — gates_runtime_state(sport,'kelly_mult') *=0.7,
 *                     source='auto_readiness' (bloqueia kelly-auto-tune sobrescrita)
 *   L2 league_block — insere ligas LEAK em league_blocklist com cooldown 14d
 *                     source='auto_readiness'
 *   L3 hard_disable — market_tips_runtime_state.disabled=1 (full corte do market)
 *
 * Verify: re-roda /shadow-readiness após `expires_at` (default +14d). Se ROI
 * subiu pra ≥0% E CLV ≥0% → reverte (status='verified_ok'). Se piorou →
 * escala (próximo nível). Se estável → mantém + estende expires_at.
 *
 * Persistência: tabela `readiness_corrections_log` (mig 089).
 *
 * Opt-in: env READINESS_LEARNER_AUTO=true. Cron weekly.
 */

const { log } = require('./utils');

const DEFAULTS = {
  days: 30,
  // Critérios pra acionar correção (devem bater com /shadow-readiness criteria)
  roiCutoffPct: -3,        // ROI ≤ -3% gera trigger
  minN: 30,                // amostra mínima settled
  leagueMinN: 10,          // liga: amostra mínima
  // Step sizes
  kellyCutFactor: 0.7,     // multiplica mult atual por 0.7 (corte 30%)
  kellyFloor: 0.20,        // não cortar abaixo disso
  leagueCooldownDays: 14,
  expiresAfterDays: 14,    // re-avaliar correção após N dias
  // Verify
  recoverRoiPct: 0,        // ROI ≥ 0% pra considerar recovery
  recoverClvPct: 0,        // CLV ≥ 0% pra considerar recovery
  worsenRoiPct: -8,        // se ROI < -8% após correção → piorou (escalar)
};

function _normSport(s) { return String(s || '').toLowerCase().trim(); }

/**
 * Executa o readiness loop manualmente (sem fetch HTTP, query direta no DB).
 * Espelha lógica do endpoint /shadow-readiness?source=real&groupBy=sport_market
 * + groupBy=sport_league. Retorna agg pronto pra diagnose.
 */
function _readReadinessSnapshot(db, opts = {}) {
  const days = opts.days || DEFAULTS.days;
  // Por (sport, market_type)
  const byMarket = db.prepare(`
    WITH dedup AS (
      SELECT MAX(id) AS id
      FROM tips
      WHERE is_shadow = 0
        AND (archived IS NULL OR archived = 0)
        AND (sent_at >= datetime('now', ?) OR result IS NULL)
      GROUP BY sport,
               COALESCE(NULLIF(TRIM(match_id), ''), 'id:' || CAST(id AS TEXT)),
               REPLACE(REPLACE(lower(COALESCE(tip_participant, '')), ' ', ''), '-', ''),
               UPPER(COALESCE(market_type, 'ML'))
    )
    SELECT t.sport,
           UPPER(COALESCE(t.market_type, 'ML')) AS market_type,
           COUNT(*) AS n,
           SUM(CASE WHEN t.result='win' THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN t.result='loss' THEN 1 ELSE 0 END) AS losses,
           SUM(COALESCE(t.profit_reais, 0)) AS profit_r,
           SUM(COALESCE(t.stake_reais, 0)) AS stake_r,
           AVG(CASE WHEN t.clv_odds > 1 AND t.odds > 1 THEN (t.odds / t.clv_odds - 1) * 100 END) AS avg_clv,
           SUM(CASE WHEN t.clv_odds > 1 AND t.odds > 1 THEN 1 ELSE 0 END) AS clv_n,
           AVG(CASE WHEN t.model_p_pick > 0 AND t.model_p_pick < 1 THEN t.model_p_pick * 100 END) AS expected_win_pp
    FROM tips t
    JOIN dedup d ON d.id = t.id
    GROUP BY t.sport, UPPER(COALESCE(t.market_type, 'ML'))
  `).all(`-${days} days`);

  // Por (sport, league/event_name)
  const byLeague = db.prepare(`
    WITH dedup AS (
      SELECT MAX(id) AS id
      FROM tips
      WHERE is_shadow = 0
        AND (archived IS NULL OR archived = 0)
        AND (sent_at >= datetime('now', ?) OR result IS NULL)
        AND (market_type IS NULL OR UPPER(market_type) = 'ML')
      GROUP BY sport,
               COALESCE(NULLIF(TRIM(match_id), ''), 'id:' || CAST(id AS TEXT)),
               REPLACE(REPLACE(lower(COALESCE(tip_participant, '')), ' ', ''), '-', '')
    )
    SELECT t.sport,
           COALESCE(t.event_name, 'unknown') AS league,
           COUNT(*) AS n,
           SUM(CASE WHEN t.result='win' THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN t.result='loss' THEN 1 ELSE 0 END) AS losses,
           SUM(COALESCE(t.profit_reais, 0)) AS profit_r,
           SUM(COALESCE(t.stake_reais, 0)) AS stake_r,
           AVG(CASE WHEN t.clv_odds > 1 AND t.odds > 1 THEN (t.odds / t.clv_odds - 1) * 100 END) AS avg_clv,
           SUM(CASE WHEN t.clv_odds > 1 AND t.odds > 1 THEN 1 ELSE 0 END) AS clv_n
    FROM tips t
    JOIN dedup d ON d.id = t.id
    GROUP BY t.sport, COALESCE(t.event_name, 'unknown')
  `).all(`-${days} days`);

  const enrich = (r) => {
    const settled = (r.wins || 0) + (r.losses || 0);
    const winRatePct = settled > 0 ? r.wins / settled * 100 : null;
    const expPct = r.expected_win_pp != null ? r.expected_win_pp : null;
    const calibGap = (winRatePct != null && expPct != null) ? +(winRatePct - expPct).toFixed(2) : null;
    const roi = r.stake_r > 0 ? +(r.profit_r / r.stake_r * 100).toFixed(2) : null;
    const avgClv = r.avg_clv != null ? +r.avg_clv.toFixed(2) : null;
    return { ...r, settled, win_rate_pct: winRatePct, calibration_gap_pp: calibGap, roi_pct: roi, avg_clv_pct: avgClv };
  };
  return {
    byMarket: byMarket.map(enrich),
    byLeague: byLeague.map(enrich),
  };
}

/**
 * Diagnose ROOT CAUSE (não sintoma). Cada cell de leak vai pra UM bucket:
 *   calib_drift     — modelo overconfident (calib_gap_pp < -3pp)
 *                     → action=prob_shrink (encolhe p em direção a 0.5)
 *   ev_inflated     — EV > realizado (ROI<EV*0.7) com CLV neg
 *                     → action=ev_shrink (corta EV%)
 *   model_uncalib   — calib OK + CLV OK + ROI ruim com n suficiente
 *                     → action=ev_calib_refit (gatilho out-of-cycle)
 *   variance_only   — calib OK, n médio (30-60), ROI ruim
 *                     → action=null (espera mais amostra)
 *   unfixable       — escalation_count ≥ 2 e leak persiste
 *                     → action=gate_kelly_cut (last resort)
 *
 * Retorna { action, reason, factor?, evidence } ou null.
 */
function _diagnose(db, cell, scope) {
  const cfg = DEFAULTS;
  if (scope === 'market') {
    if (cell.settled < cfg.minN) return null;
    if (cell.roi_pct == null || cell.roi_pct > cfg.roiCutoffPct) return null;
  } else if (scope === 'league') {
    if (cell.settled < cfg.leagueMinN) return null;
    if (cell.roi_pct == null || cell.roi_pct > cfg.roiCutoffPct) return null;
  }

  // Histórico de tentativas anteriores
  const where = scope === 'market'
    ? `sport = ? AND market = ? AND status IN ('active','escalated')`
    : `sport = ? AND league = ? AND status IN ('active','escalated')`;
  const args = scope === 'market' ? [cell.sport, cell.market_type] : [cell.sport, cell.league];
  const history = db.prepare(`
    SELECT * FROM readiness_corrections_log
    WHERE ${where}
    ORDER BY applied_at DESC
  `).all(...args);

  const escalations = history.filter(h => h.escalation_count > 0).length;
  const hasActive = history.some(h => h.status === 'active');

  // Se já há correção ativa pra esse target, espera o verify cycle
  if (hasActive) return null;

  // ─── League scope: única ação é league_block (não há learning per-liga) ───
  if (scope === 'league') {
    return {
      action: 'league_block',
      reason: `liga ${cell.league}: roi=${cell.roi_pct.toFixed(1)}% n=${cell.settled}`,
      evidence: { roi: cell.roi_pct, n: cell.settled, clv: cell.avg_clv_pct },
    };
  }

  // ─── Diagnose por causa raiz (market scope) ────────────────────────
  const calibGap = cell.calibration_gap_pp;
  const clv = cell.avg_clv_pct;
  const roi = cell.roi_pct;

  // L4: unfixable — após 2+ escalations sem recovery, gate como last resort
  if (escalations >= 2) {
    return {
      action: 'gate_kelly_cut',
      reason: `unfixable: ${escalations} escalations sem recovery — kelly cut last resort`,
      evidence: { escalations, roi, calibGap, clv },
    };
  }

  // L1: calibration drift (modelo overconfident)
  // calib_gap_pp < -3pp = real hit rate é >3pp menor que p_predicted
  // Solução: encolher p em direção a 0.5 proporcional ao gap
  if (calibGap != null && calibGap < -3) {
    // Factor derivado: gap=-3 → 0.85, gap=-6 → 0.70, gap=-10 → 0.55, gap=-15 → 0.40
    // Floor 0.40 (não encolhe mais que 60% pra preservar algum sinal)
    const factor = Math.max(0.40, 1 - Math.abs(calibGap) / 30);
    return {
      action: 'prob_shrink',
      reason: `calib drift: gap ${calibGap.toFixed(1)}pp (real=${cell.win_rate_pct?.toFixed(1)}% vs esperado=${cell.expected_win_rate_pct?.toFixed(1)}%)`,
      factor: +factor.toFixed(3),
      evidence: { calibGap, roi, clv, real_hit: cell.win_rate_pct, expected_hit: cell.expected_win_rate_pct },
    };
  }

  // L2: EV inflado (modelo superestima edge, mercado precifica melhor)
  // CLV negativo significa que close line piora em relação à open — model
  // pega odd estofada. Combine com ROI < -3% pra confirmar leak material.
  if (clv != null && clv < -1 && roi < -3) {
    // Factor derivado de CLV: clv=-1.5 → 0.85, clv=-3 → 0.70, clv=-5 → 0.50
    const factor = Math.max(0.40, 1 - Math.abs(clv) / 10);
    return {
      action: 'ev_shrink',
      reason: `ev inflado: CLV ${clv.toFixed(1)}% indica modelo precifica acima do close (n=${cell.settled})`,
      factor: +factor.toFixed(3),
      evidence: { clv, roi, calibGap, clv_n: cell.clv_n },
    };
  }

  // L3: model uncalib (calib OK, CLV OK, mas ROI ruim com n suficiente)
  // Pode ser: bucket EV mal calibrado (EV calc errado mesmo com p correto),
  // ou mercado tem edge mas EV não captura. Triggera refit out-of-cycle.
  if (cell.settled >= 60 && (clv == null || clv >= -1)) {
    // Não tem calib_gap claro, não tem CLV bleed — model parece OK mas ROI vaza
    return {
      action: 'ev_calib_refit',
      reason: `unexplained leak: roi=${roi.toFixed(1)}% n=${cell.settled} calib OK clv OK — refit ev-calibration`,
      evidence: { roi, clv, calibGap, settled: cell.settled },
    };
  }

  // n médio (30-60), calib OK → variance, espera amostra crescer
  if (cell.settled < 60) {
    return null;
  }

  // Fallback: leak material sem signal claro de causa → ev_shrink conservador
  return {
    action: 'ev_shrink',
    reason: `leak indeterminado: roi=${roi.toFixed(1)}% n=${cell.settled} — ev_shrink conservador 0.85`,
    factor: 0.85,
    evidence: { roi, clv, calibGap },
  };
}

/**
 * Aplica correção. Filosofia: prefer LEARNING (prob/ev shrink, ev_calib_refit)
 * sobre GATES (kelly_cut, hard_disable, league_block). Gates só como L4
 * last-resort após 2+ escalations sem recovery.
 *
 * Persiste em readiness_corrections_log (tracking) + learned_corrections
 * (aplicação live em /record-tip) + infra de gates quando necessário.
 */
function _applyCorrection(db, cell, scope, decision, opts = {}) {
  const cfg = DEFAULTS;
  const dryRun = !!opts.dryRun;
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + cfg.expiresAfterDays * 24 * 60 * 60 * 1000).toISOString();

  let valueBefore = null;
  let valueAfter = null;
  let applied = false;

  // ─── LEARNING ACTIONS (causa) ─────────────────────────────────────
  if (decision.action === 'prob_shrink' || decision.action === 'ev_shrink') {
    const lc = require('./learned-corrections');
    const market = scope === 'market' ? cell.market_type : null;
    const leaguePattern = scope === 'league' ? cell.league : null;
    valueBefore = { factor: 1.0, market, league_pattern: leaguePattern };
    valueAfter = { factor: decision.factor, market, league_pattern: leaguePattern, type: decision.action };
    if (!dryRun) {
      const r = lc.setAuto(db, {
        sport: cell.sport,
        market,
        league_pattern: leaguePattern,
        correction_type: decision.action,
        factor: decision.factor,
        evidence: { ...decision.evidence, applied_by: 'readiness-learner', n: cell.settled },
        expiresInDays: cfg.expiresAfterDays,
      });
      applied = !!r?.id;
      if (applied) valueAfter.learned_correction_id = r.id;
    }
  } else if (decision.action === 'ev_calib_refit') {
    // Triggera refresh global da ev-calibration. Não tem target específico —
    // refit per (sport, bucket) pega TODAS as buckets recém-realocadas.
    valueBefore = { ev_calib: 'stale' };
    valueAfter = { ev_calib: 'refit_triggered' };
    if (!dryRun) {
      try {
        const evCalib = require('./ev-calibration');
        const snap = evCalib.refreshEvCalibration(db);
        applied = !!snap;
        valueAfter.snapshot_size = snap?.bySportBucket?.size || 0;
      } catch (e) { log('WARN', 'READINESS-LEARNER', `ev_calib_refit: ${e.message}`); }
    }
  }
  // ─── GATE ACTIONS (sintoma — last resort) ─────────────────────────
  else if (decision.action === 'gate_kelly_cut') {
    const grs = require('./gates-runtime-state');
    try { grs.loadFromDb(db); } catch (_) {}
    const cur = grs.getGateValue(cell.sport, 'kelly_mult') ?? 1.0;
    const target = Math.max(cfg.kellyFloor, +(cur * cfg.kellyCutFactor).toFixed(3));
    valueBefore = { kelly_mult: cur };
    valueAfter = { kelly_mult: target };
    if (!dryRun) {
      grs.setAuto(db, cell.sport, 'kelly_mult', target, {
        reason: `last_resort_gate:${decision.reason}`,
        evidence: { source: 'readiness-learner', last_resort: true, applied_at: nowIso },
      });
      applied = true;
    }
  } else if (decision.action === 'league_block') {
    // Liga-level só usa block (não há learning lever per liga)
    const cooldownUntil = new Date(Date.now() + cfg.leagueCooldownDays * 24 * 60 * 60 * 1000).toISOString();
    valueBefore = { blocked: false };
    valueAfter = { blocked: true, cooldown_until: cooldownUntil };
    if (!dryRun) {
      try {
        db.prepare(`
          INSERT OR REPLACE INTO league_blocklist
            (entry, source, reason, roi_pct, clv_pct, n_tips, created_at, cooldown_until)
          VALUES (?, 'auto_readiness', ?, ?, ?, ?, ?, ?)
        `).run(cell.league, decision.reason, cell.roi_pct, cell.avg_clv_pct, cell.settled, nowIso, cooldownUntil);
        applied = true;
      } catch (e) { log('WARN', 'READINESS-LEARNER', `league_block insert: ${e.message}`); }
    }
  } else if (decision.action === 'hard_disable') {
    valueBefore = { disabled: false };
    valueAfter = { disabled: true };
    if (!dryRun) {
      try {
        db.prepare(`
          INSERT OR REPLACE INTO market_tips_runtime_state
            (sport, market, side, league, disabled, source, reason, clv_pct, clv_n, roi_pct, updated_at)
          VALUES (?, ?, NULL, NULL, 1, 'auto_readiness', ?, ?, ?, ?, ?)
        `).run(cell.sport, cell.market_type, decision.reason, cell.avg_clv_pct, cell.clv_n || 0, cell.roi_pct, nowIso);
        applied = true;
      } catch (e) { log('WARN', 'READINESS-LEARNER', `hard_disable insert: ${e.message}`); }
    }
  }

  if (applied || dryRun) {
    try {
      const insertResult = db.prepare(`
        INSERT INTO readiness_corrections_log
          (sport, market, league, action_type, value_before, value_after,
           n_at_time, roi_at_time, clv_at_time, calib_gap_at_time,
           applied_at, expires_at, status, status_reason, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cell.sport,
        scope === 'market' ? cell.market_type : null,
        scope === 'league' ? cell.league : null,
        decision.action,
        JSON.stringify(valueBefore),
        JSON.stringify(valueAfter),
        cell.settled,
        cell.roi_pct,
        cell.avg_clv_pct,
        cell.calibration_gap_pp,
        nowIso,
        expiresIso,
        dryRun ? 'dry_run' : 'active',
        decision.reason,
        opts.source || 'auto',
      );
      return { applied: !dryRun, action: decision.action, scope, sport: cell.sport, market: cell.market_type, league: cell.league, reason: decision.reason, log_id: insertResult.lastInsertRowid };
    } catch (e) {
      log('WARN', 'READINESS-LEARNER', `corrections_log insert: ${e.message}`);
      return { applied: false, error: e.message };
    }
  }

  return { applied: false, action: decision.action };
}

/**
 * Verifica correções ativas: lê métricas atuais, decide manter/recover/escalar.
 */
function _verifyActiveCorrections(db, snapshot, opts = {}) {
  const cfg = DEFAULTS;
  const dryRun = !!opts.dryRun;
  const verified = [];

  const dueCorrections = db.prepare(`
    SELECT * FROM readiness_corrections_log
    WHERE status = 'active'
      AND (expires_at IS NULL OR expires_at <= datetime('now'))
    ORDER BY applied_at ASC
  `).all();

  for (const c of dueCorrections) {
    const cell = c.market
      ? snapshot.byMarket.find(x => x.sport === c.sport && x.market_type === c.market)
      : c.league
        ? snapshot.byLeague.find(x => x.sport === c.sport && x.league === c.league)
        : null;

    if (!cell || cell.settled === 0) {
      // Sem dados pós-correção — extend expires +7d
      if (!dryRun) {
        db.prepare(`UPDATE readiness_corrections_log
                     SET expires_at = datetime('now', '+7 days'),
                         last_verified_at = datetime('now'),
                         status_reason = 'no_post_correction_data — extended'
                     WHERE id = ?`).run(c.id);
      }
      verified.push({ id: c.id, action: 'extended', reason: 'no_data' });
      continue;
    }

    const recovered = cell.roi_pct != null && cell.roi_pct >= cfg.recoverRoiPct
                   && (cell.avg_clv_pct == null || cell.avg_clv_pct >= cfg.recoverClvPct);
    const worsened = cell.roi_pct != null && cell.roi_pct < cfg.worsenRoiPct;

    if (recovered) {
      // Reverter correção: marcar verified_ok + remover ação aplicada
      if (!dryRun) {
        _revertCorrection(db, c);
        db.prepare(`UPDATE readiness_corrections_log
                     SET status = 'verified_ok',
                         status_reason = 'recovered: roi=' || ? || '% clv=' || COALESCE(?, 'na'),
                         last_verified_at = datetime('now')
                     WHERE id = ?`).run(cell.roi_pct, cell.avg_clv_pct, c.id);
      }
      verified.push({ id: c.id, action: 'recovered', sport: c.sport, market: c.market, league: c.league, roi: cell.roi_pct, clv: cell.avg_clv_pct });
    } else if (worsened) {
      // Marcar como escalation_pending — próxima execução do learner vai escalar
      if (!dryRun) {
        db.prepare(`UPDATE readiness_corrections_log
                     SET status = 'escalated',
                         status_reason = 'worsened: roi=' || ? || '% — needs escalation',
                         last_verified_at = datetime('now'),
                         escalation_count = escalation_count + 1
                     WHERE id = ?`).run(cell.roi_pct, c.id);
      }
      verified.push({ id: c.id, action: 'escalated', sport: c.sport, market: c.market, league: c.league, roi: cell.roi_pct });
    } else {
      // Estável — extend expires +14d
      if (!dryRun) {
        db.prepare(`UPDATE readiness_corrections_log
                     SET expires_at = datetime('now', '+14 days'),
                         last_verified_at = datetime('now'),
                         status_reason = 'stable: roi=' || ? || '% — extended'
                     WHERE id = ?`).run(cell.roi_pct, c.id);
      }
      verified.push({ id: c.id, action: 'stable', sport: c.sport, market: c.market, league: c.league, roi: cell.roi_pct });
    }
  }
  return verified;
}

/**
 * Reverte ação aplicada (restaura estado anterior).
 */
function _revertCorrection(db, c) {
  try {
    const before = c.value_before ? JSON.parse(c.value_before) : {};
    const after = c.value_after ? JSON.parse(c.value_after) : {};
    if (c.action_type === 'prob_shrink' || c.action_type === 'ev_shrink') {
      const lc = require('./learned-corrections');
      if (after.learned_correction_id) lc.revert(db, after.learned_correction_id, `readiness_revert:correction_${c.id}`);
    } else if (c.action_type === 'ev_calib_refit') {
      // Refit é no-op pra revert — próximo refit é o que vale
    } else if (c.action_type === 'gate_kelly_cut' || c.action_type === 'kelly_cut') {
      const grs = require('./gates-runtime-state');
      const prevMult = before.kelly_mult ?? 1.0;
      grs.setAuto(db, c.sport, 'kelly_mult', prevMult, {
        reason: `readiness_revert:correction_${c.id}`,
        evidence: { source: 'readiness-learner', revert: true },
      });
    } else if (c.action_type === 'league_block') {
      db.prepare(`DELETE FROM league_blocklist WHERE entry = ? AND source = 'auto_readiness'`).run(c.league);
    } else if (c.action_type === 'hard_disable') {
      db.prepare(`DELETE FROM market_tips_runtime_state
                   WHERE sport = ? AND market = ? AND source = 'auto_readiness'`).run(c.sport, c.market);
    }
    return true;
  } catch (e) {
    log('WARN', 'READINESS-LEARNER', `revert correction ${c.id}: ${e.message}`);
    return false;
  }
}

/**
 * Reverte manualmente uma correção (chamado via /admin/readiness-correction-revert).
 */
function revertCorrection(db, correctionId, reason = 'manual') {
  const c = db.prepare(`SELECT * FROM readiness_corrections_log WHERE id = ?`).get(correctionId);
  if (!c) return { ok: false, error: 'not_found' };
  if (c.status !== 'active') return { ok: false, error: `already ${c.status}` };
  const ok = _revertCorrection(db, c);
  db.prepare(`UPDATE readiness_corrections_log
               SET status = 'reverted', status_reason = ?, last_verified_at = datetime('now')
               WHERE id = ?`).run(reason, correctionId);
  return { ok, id: correctionId };
}

/**
 * Roda o ciclo completo: snapshot → diagnose+aplicar novos → verify ativos.
 */
function runReadinessLearner(db, opts = {}) {
  const out = { applied: [], verified: [], skipped: 0, snapshot_n: 0 };
  if (!db) return { ...out, error: 'no_db' };
  try {
    const snap = _readReadinessSnapshot(db, opts);
    out.snapshot_n = snap.byMarket.length + snap.byLeague.length;

    // 1. Verify correções ativas (expiraram?)
    out.verified = _verifyActiveCorrections(db, snap, opts);

    // 2. Diagnose + aplicar novas correções por (sport, market)
    for (const cell of snap.byMarket) {
      const decision = _diagnose(db, cell, 'market');
      if (!decision) { out.skipped++; continue; }
      const r = _applyCorrection(db, cell, 'market', decision, opts);
      if (r?.applied || r?.action) out.applied.push(r);
    }
    // 3. Diagnose + aplicar por (sport, league)
    for (const cell of snap.byLeague) {
      const decision = _diagnose(db, cell, 'league');
      if (!decision) { out.skipped++; continue; }
      const r = _applyCorrection(db, cell, 'league', decision, opts);
      if (r?.applied || r?.action) out.applied.push(r);
    }
    return out;
  } catch (e) {
    return { ...out, error: e.message };
  }
}

/**
 * Lista correções ativas + history (default 30d).
 */
function listCorrections(db, opts = {}) {
  const days = opts.days || 60;
  const status = opts.status || null;
  let where = `applied_at >= datetime('now', '-${days} days')`;
  const args = [];
  if (status) { where += ` AND status = ?`; args.push(status); }
  const rows = db.prepare(`
    SELECT * FROM readiness_corrections_log
    WHERE ${where}
    ORDER BY applied_at DESC
    LIMIT 200
  `).all(...args);
  return rows.map(r => ({
    ...r,
    value_before: r.value_before ? JSON.parse(r.value_before) : null,
    value_after: r.value_after ? JSON.parse(r.value_after) : null,
  }));
}

module.exports = {
  runReadinessLearner,
  revertCorrection,
  listCorrections,
  DEFAULTS,
  _readReadinessSnapshot,
  _diagnose,
};

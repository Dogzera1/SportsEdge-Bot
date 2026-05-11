'use strict';

/**
 * ml-auto-promote.js — auto-promote ML shadow → real per sport, com breakdown
 * granular (P1) por tier + bucket de odd, e blocklist de liga problemática.
 *
 * Espelho do mt-auto-promote.js mas pra ML tips (tabela `tips`, market_type='ML',
 * is_shadow=1 vs 0). Toggle de shadow é via env `<SPORT>_SHADOW=true`, lido no
 * boot do bot.js em `_splitBucketShadow` (linhas 4520-4527).
 *
 * Fluxo (cron 12h):
 *   1. PROMOTE (shadow→real): sport-level. Lê shadow puro (pre-promote eval P2).
 *      Se n_settled ≥ minN AND ROI ≥ +X AND IC95% lower > threshold → unset
 *      `<SPORT>_SHADOW`. Persiste em `settings` table (ml_promote_<sport>).
 *      Bot precisa rebootar pra recarregar env (não mexemos in-memory pra evitar
 *      race com pollFns); log INFO + DM admin avisam.
 *   2. REVERT (real→shadow): sport-level real (sintoma — sport JÁ em real).
 *      Se ROI 14d ≤ revertRoi → seta `<SPORT>_SHADOW=true` (in-memory + settings).
 *   3. LEAGUE_BLOCK: per (sport, league via event_name). Real-only.
 *      Se ROI ≤ -10% n ≥ 10 → adiciona em ml_league_blocklist.
 *      league_blocklist genérica (mig 045) cobre regex substring; aqui é
 *      sport+league exato com source='auto_ml'.
 *   4. AUDIT (não-action): tier × bucket breakdown logado em ml_auto_promote_log
 *      action='audit'. Visibilidade pro humano sem auto-trigger (P1 ajuda manual
 *      decisão; auto-action sport-level só).
 *
 * P2 compliance: PROMOTE shadow ok, REVERT/LEAGUE real-only (default).
 *   Opt-out: ML_AUTO_PROMOTE_REAL_ONLY=false (legacy mistura).
 *
 * Envs:
 *   ML_AUTO_PROMOTE                  (default true)  — master switch
 *   ML_AUTO_PROMOTE_REAL_ONLY        (default true)
 *   ML_AUTO_PROMOTE_MIN_SETTLED      (default 150)
 *   ML_AUTO_PROMOTE_MIN_ROI          (default 2)
 *   ML_AUTO_PROMOTE_REQUIRE_CI       (default true)
 *   ML_AUTO_PROMOTE_CI_LOWER_THRESHOLD (default 0)
 *   ML_AUTO_PROMOTE_REVERT_ROI       (default -3)
 *   ML_AUTO_PROMOTE_REVERT_DAYS      (default 14)
 *   ML_AUTO_PROMOTE_LEAGUE_MIN_N     (default 10)
 *   ML_AUTO_PROMOTE_LEAGUE_ROI       (default -10)
 *   ML_AUTO_PROMOTE_LEAGUE_RESTORE   (default -3)
 *   ML_AUTO_PROMOTE_WINDOW_DAYS      (default 120)  — > FROZEN_HOLDOUT_DAYS pra cron ver dados
 *   ML_AUTO_PROMOTE_AUDIT_TIER_BUCKET (default true) — registra audit rows
 */

const { log } = require('./utils');
const { getLeagueTierKey } = require('./league-tier');

const SPORTS = ['lol', 'dota2', 'cs', 'cs2', 'valorant', 'tennis', 'football', 'basket', 'mma', 'tabletennis', 'darts', 'snooker'];

function _normLeague(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function _envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

function _envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

function _bucketOf(odd) {
  const o = Number(odd) || 0;
  if (o < 1.4) return '<1.4';
  if (o < 1.6) return '1.4-1.6';
  if (o < 2.0) return '1.6-2.0';
  if (o < 2.5) return '2.0-2.5';
  if (o < 4.0) return '2.5-4.0';
  return '>4.0';
}

function _parseStake(text) {
  const v = parseFloat(String(text || '').replace(/u/i, ''));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

// Cache em memória — populado por loadMlLeagueBlocklist + refresh pós cycle.
const _leagueBlockCache = new Set();

function loadMlLeagueBlocklist(db) {
  try {
    _leagueBlockCache.clear();
    const rows = db.prepare(`SELECT sport, league_norm FROM ml_league_blocklist`).all();
    for (const r of rows) {
      _leagueBlockCache.add(`${r.sport}|${r.league_norm}`);
    }
    if (_leagueBlockCache.size) {
      log('INFO', 'ML-AUTO-PROMOTE', `Loaded ${_leagueBlockCache.size} ML league blocks`);
    }
  } catch (e) {
    log('DEBUG', 'ML-AUTO-PROMOTE', `loadMlLeagueBlocklist err: ${e.message}`);
  }
}

function isMlLeagueBlocked(sport, league) {
  if (!sport || !league) return false;
  return _leagueBlockCache.has(`${String(sport).toLowerCase()}|${_normLeague(league)}`);
}

function _logDecision(db, args) {
  try {
    db.prepare(`
      INSERT INTO ml_auto_promote_log (sport, tier, bucket, league, action, reason, n, roi_pct, clv_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      args.sport, args.tier || null, args.bucket || null, args.league || null,
      args.action, args.reason || null,
      args.n != null ? args.n : null,
      args.roi != null ? args.roi : null,
      args.clv != null ? args.clv : null,
    );
  } catch (e) {
    log('DEBUG', 'ML-AUTO-PROMOTE', `log decision err: ${e.message}`);
  }
}

function _setMlShadowEnv(db, sport, shadowOn) {
  const up = String(sport).toUpperCase();
  const envKey = `${up}_SHADOW`;
  const settingKey = `ml_shadow_${sport}`;
  if (shadowOn) {
    process.env[envKey] = 'true';
  } else {
    // Limpa env in-memory. Bot.js seed roda só no boot; mantém o env unset aqui
    // pra que próximo restart com env Railway atualizada já saia em real.
    delete process.env[envKey];
  }
  try {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(settingKey, shadowOn ? 'true' : 'false');
  } catch (e) {
    log('WARN', 'ML-AUTO-PROMOTE', `_setMlShadowEnv settings persist failed sport=${sport} shadowOn=${shadowOn}: ${e.message}`);
  }
}

function _isCurrentlyShadow(sport) {
  const up = String(sport).toUpperCase();
  return process.env[`${up}_SHADOW`] === 'true';
}

/**
 * Tira linhas de tips (sport stake odds result event_name) e agrega
 * { n, settled, stake_sum, profit_sum, profit_sq, clv_sum, clv_n } per bucket-fn.
 * Stake parsed do texto "Xu". Profit = (odd-1)*stake em win, -stake em loss.
 */
function _aggregate(rows, keyFn) {
  const acc = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!acc.has(k)) acc.set(k, {
      key: k, n: 0, settled: 0, stake_sum: 0, profit_sum: 0, profit_sq: 0,
      clv_sum: 0, clv_n: 0,
    });
    const a = acc.get(k);
    a.n++;
    const stake = _parseStake(r.stake);
    const odd = Number(r.odds) || 0;
    let profit = null;
    if (r.result === 'win') { a.settled++; a.stake_sum += stake; profit = (odd - 1) * stake; a.profit_sum += profit; }
    else if (r.result === 'loss') { a.settled++; a.stake_sum += stake; profit = -stake; a.profit_sum += profit; }
    if (profit != null) a.profit_sq += (profit / stake) * (profit / stake); // unit-normalized pra IC
    if (r.clv_pct != null && Number.isFinite(r.clv_pct)) { a.clv_sum += r.clv_pct; a.clv_n++; }
  }
  return [...acc.values()];
}

function _computeRoiCi(n, sumProfit, stakeSum, profitSqUnit) {
  if (!Number.isFinite(n) || n < 2 || stakeSum <= 0) return null;
  // Mean ROI por tip (unit-normalized profit / 1u stake equivalente).
  const mean = sumProfit / stakeSum;
  // Variance estimada usando profit_sq unit-normalized (cada tip contribuição
  // (profit/stake)²) — approx válida quando stakes próximas de 1u, típico em ML.
  const variance = (profitSqUnit - n * mean * mean) / (n - 1);
  if (!Number.isFinite(variance) || variance < 0) return null;
  const se = Math.sqrt(variance / n);
  return {
    mean_pp: +(mean * 100).toFixed(2),
    se_pp: +(se * 100).toFixed(2),
    lower_pp: +((mean - 1.96 * se) * 100).toFixed(2),
    upper_pp: +((mean + 1.96 * se) * 100).toFixed(2),
  };
}

function _fetchTips(db, days, isShadow) {
  const holdoutClause = require('./frozen-holdout').getHoldoutSql('ml_auto_promote', 'sent_at');
  return db.prepare(`
    SELECT sport, stake, odds, result, event_name, clv_pct
    FROM tips
    WHERE is_shadow = ?
      AND COALESCE(archived, 0) = 0
      AND result IN ('win','loss','void','push')
      AND COALESCE(market_type, 'ML') = 'ML'
      AND sent_at >= datetime('now', '-' || ? || ' days')
      ${holdoutClause}
  `).all(isShadow ? 1 : 0, days);
}

async function runMlAutoPromoteCycle(db, opts = {}) {
  if (/^(0|false|no)$/i.test(String(process.env.ML_AUTO_PROMOTE ?? 'true'))) {
    return { ok: true, skipped: 'disabled' };
  }
  // Default 120d (não 30) pra não colidir com FROZEN_HOLDOUT_DAYS=60 padrão:
  // holdout filtra `sent_at < now-60d`, window filtra `sent_at >= now-Xd`.
  // Window > holdout pra haver interseção não-vazia. Com 120d, cron vê 60d de
  // dados out-of-sample (dias 60-120) — janela honesta de evaluation.
  const days = _envInt('ML_AUTO_PROMOTE_WINDOW_DAYS', 120);
  const minSettled = _envInt('ML_AUTO_PROMOTE_MIN_SETTLED', 150);
  const minRoi = _envFloat('ML_AUTO_PROMOTE_MIN_ROI', 2);
  const requireCi = !/^(0|false|no)$/i.test(String(process.env.ML_AUTO_PROMOTE_REQUIRE_CI ?? 'true'));
  const ciLowerThreshold = _envFloat('ML_AUTO_PROMOTE_CI_LOWER_THRESHOLD', 0);
  const revertDays = _envInt('ML_AUTO_PROMOTE_REVERT_DAYS', 14);
  const revertRoi = _envFloat('ML_AUTO_PROMOTE_REVERT_ROI', -3);
  const leagueMinN = _envInt('ML_AUTO_PROMOTE_LEAGUE_MIN_N', 10);
  const leagueRoiCut = _envFloat('ML_AUTO_PROMOTE_LEAGUE_ROI', -10);
  const leagueRoiRestore = _envFloat('ML_AUTO_PROMOTE_LEAGUE_RESTORE', -3);
  const realOnly = !/^(0|false|no)$/i.test(String(process.env.ML_AUTO_PROMOTE_REAL_ONLY ?? 'true'));
  const auditTierBucket = !/^(0|false|no)$/i.test(String(process.env.ML_AUTO_PROMOTE_AUDIT_TIER_BUCKET ?? 'true'));

  const decisions = {
    promoted: [], reverted: [],
    league_blocked: [], league_unblocked: [],
    rejected_by_ci: [], audit_granularity: [],
  };

  // ── Sport-level promote/revert ──
  try {
    const shadowRows = _fetchTips(db, days, true);
    // Pra revert lemos real (sintoma) — janela revertDays
    const revertSrcRows = realOnly
      ? _fetchTips(db, revertDays, false)
      : _fetchTips(db, revertDays, true);

    const shadowBySport = new Map(
      _aggregate(shadowRows, r => String(r.sport || '').toLowerCase()).map(a => [a.key, a])
    );
    const revertBySport = new Map(
      _aggregate(revertSrcRows, r => String(r.sport || '').toLowerCase()).map(a => [a.key, a])
    );

    // Itera união de sports (shadow ∪ revert) — sport promovido não tem shadow
    // rows mas pode precisar de revert; sport ainda em shadow pode não ter
    // volume real ainda.
    const sportsSeen = new Set([...shadowBySport.keys(), ...revertBySport.keys()]);
    for (const sport of sportsSeen) {
      if (!sport || !SPORTS.includes(sport)) continue;
      const shadowOn = _isCurrentlyShadow(sport);
      const a = shadowBySport.get(sport);

      if (shadowOn && a) {
        // PROMOTE path: avalia shadow stats.
        const settled = a.settled;
        const roi = a.stake_sum > 0 ? (a.profit_sum / a.stake_sum * 100) : null;
        const clv = a.clv_n > 0 ? (a.clv_sum / a.clv_n) : null;
        const ci = _computeRoiCi(settled, a.profit_sum, a.stake_sum, a.profit_sq);
        const ciPasses = !requireCi || (ci && ci.lower_pp > ciLowerThreshold);

        if (settled >= minSettled && roi != null && roi >= minRoi && ciPasses) {
          _setMlShadowEnv(db, sport, false);
          const ciStr = ci ? ` IC95%[${ci.lower_pp},${ci.upper_pp}]pp` : '';
          _logDecision(db, { sport, action: 'promote', reason: `auto: ROI ${roi.toFixed(1)}%${ciStr} n=${settled}`, n: settled, roi, clv });
          decisions.promoted.push({ sport, roi: +roi.toFixed(1), n: settled, clv: clv != null ? +clv.toFixed(1) : null, ci });
          log('INFO', 'ML-AUTO-PROMOTE', `${sport}: PROMOVIDO (shadow→real) ROI=${roi.toFixed(1)}%${ciStr} n=${settled}`);
        } else if (settled >= minSettled && roi != null && roi >= minRoi && !ciPasses) {
          const ciStr = ci ? ` IC95%[${ci.lower_pp},${ci.upper_pp}]pp` : ' IC=null';
          _logDecision(db, { sport, action: 'reject_ci', reason: `IC lower ≤ ${ciLowerThreshold}: mean ROI ${roi.toFixed(1)}%${ciStr}`, n: settled, roi });
          decisions.rejected_by_ci.push({ sport, roi: +roi.toFixed(1), n: settled, ci, reason: 'ic_lower_zero_or_negative' });
          log('INFO', 'ML-AUTO-PROMOTE', `${sport}: SKIP promote (IC inclui zero) ROI=${roi.toFixed(1)}%${ciStr} n=${settled}`);
        }
      } else if (!shadowOn) {
        // REVERT path: sport em real, avalia real stats janela revertDays.
        const rv = revertBySport.get(sport);
        const rvSettled = rv ? rv.settled : 0;
        const rvRoi = (rv && rv.stake_sum > 0) ? (rv.profit_sum / rv.stake_sum * 100) : null;
        if (rvSettled >= Math.min(minSettled, 30) && rvRoi != null && rvRoi <= revertRoi) {
          _setMlShadowEnv(db, sport, true);
          _logDecision(db, { sport, action: 'revert', reason: `auto: ROI ${rvRoi.toFixed(1)}% n=${rvSettled} (${revertDays}d)`, n: rvSettled, roi: rvRoi });
          decisions.reverted.push({ sport, roi: +rvRoi.toFixed(1), n: rvSettled });
          log('WARN', 'ML-AUTO-PROMOTE', `${sport}: REVERTIDO (real→shadow) ROI=${rvRoi.toFixed(1)}% n=${rvSettled} (${revertDays}d)`);
        }
      }
    }
  } catch (e) {
    log('WARN', 'ML-AUTO-PROMOTE', `sport-level err: ${e.message}`);
  }

  // ── League-level block/unblock per (sport, league via event_name) ──
  // Real path (default). Tier 1/2 ligas com edge negativo persistente bloqueadas
  // pra emissão de tip ML real (gate adicional além de league_blocklist genérica).
  try {
    const leagueRows = realOnly ? _fetchTips(db, days, false) : _fetchTips(db, days, true);
    const byKey = _aggregate(leagueRows, r => {
      const sp = String(r.sport || '').toLowerCase();
      const ln = _normLeague(r.event_name);
      if (!sp || !ln) return null;
      return `${sp}|${ln}`;
    });

    const upsertBlock = db.prepare(`
      INSERT INTO ml_league_blocklist (sport, league_norm, league_raw, source, reason, n, roi_pct, since)
      VALUES (?, ?, ?, 'auto', ?, ?, ?, datetime('now'))
      ON CONFLICT(sport, league_norm) DO UPDATE SET
        reason = excluded.reason, n = excluded.n, roi_pct = excluded.roi_pct
    `);
    const deleteBlock = db.prepare(`DELETE FROM ml_league_blocklist WHERE sport=? AND league_norm=?`);
    const existingBlocks = db.prepare(`SELECT sport, league_norm, league_raw FROM ml_league_blocklist WHERE source='auto'`).all();
    const existingMap = new Map(existingBlocks.map(b => [`${b.sport}|${b.league_norm}`, b]));
    // Mapeia league_norm → league_raw original (primeira ocorrência)
    const rawByKey = new Map();
    for (const r of leagueRows) {
      const sp = String(r.sport || '').toLowerCase();
      const ln = _normLeague(r.event_name);
      const k = `${sp}|${ln}`;
      if (sp && ln && !rawByKey.has(k)) rawByKey.set(k, String(r.event_name || '').trim());
    }

    for (const a of byKey) {
      const [sport, leagueNorm] = a.key.split('|');
      const leagueRaw = rawByKey.get(a.key) || leagueNorm;
      const settled = a.settled;
      const roi = a.stake_sum > 0 ? (a.profit_sum / a.stake_sum * 100) : null;
      const isBlocked = existingMap.has(a.key);

      if (!isBlocked && settled >= leagueMinN && roi != null && roi <= leagueRoiCut) {
        const reason = `ROI ${roi.toFixed(1)}% n=${settled}`;
        upsertBlock.run(sport, leagueNorm, leagueRaw, reason, settled, +roi.toFixed(2));
        _leagueBlockCache.add(a.key);
        _logDecision(db, { sport, league: leagueRaw, action: 'league_block', reason: `auto: ${reason}`, n: settled, roi });
        decisions.league_blocked.push({ sport, league: leagueRaw, roi: +roi.toFixed(1), n: settled });
        log('WARN', 'ML-AUTO-PROMOTE', `${sport} ${leagueRaw}: BLOCKED ${reason}`);
      } else if (isBlocked && roi != null && settled >= leagueMinN && roi >= leagueRoiRestore) {
        deleteBlock.run(sport, leagueNorm);
        _leagueBlockCache.delete(a.key);
        const reason = `ROI ${roi.toFixed(1)}% n=${settled}`;
        _logDecision(db, { sport, league: leagueRaw, action: 'league_unblock', reason: `auto restore: ${reason}`, n: settled, roi });
        decisions.league_unblocked.push({ sport, league: leagueRaw, roi: +roi.toFixed(1), n: settled });
        log('INFO', 'ML-AUTO-PROMOTE', `${sport} ${leagueRaw}: UNBLOCKED ${reason}`);
      }
    }
  } catch (e) {
    log('WARN', 'ML-AUTO-PROMOTE', `league-level err: ${e.message}`);
  }

  // ── P1 GRANULARIDADE: audit per (sport, tier, bucket) ──
  // Não auto-aciona — registra breakdown pra humano inspecionar via
  // /admin/ml-auto-promote-history. Cobre tanto shadow (pre-promote eval)
  // quanto real (sintoma) — separamos action='audit_shadow'/'audit_real'.
  if (auditTierBucket) {
    try {
      const audit = (rows, suffix) => {
        const agg = _aggregate(rows, r => {
          const sp = String(r.sport || '').toLowerCase();
          if (!sp) return null;
          const tier = getLeagueTierKey(sp, r.event_name || '');
          const bucket = _bucketOf(r.odds);
          return `${sp}|${tier}|${bucket}`;
        });
        for (const a of agg) {
          if (a.settled < 20) continue; // ruído
          const [sport, tier, bucket] = a.key.split('|');
          const roi = a.stake_sum > 0 ? (a.profit_sum / a.stake_sum * 100) : null;
          if (roi == null) continue;
          const clv = a.clv_n > 0 ? (a.clv_sum / a.clv_n) : null;
          _logDecision(db, {
            sport, tier, bucket,
            action: `audit_${suffix}`,
            reason: `${suffix} ROI ${roi.toFixed(1)}% n=${a.settled}`,
            n: a.settled, roi, clv,
          });
          decisions.audit_granularity.push({ source: suffix, sport, tier, bucket, n: a.settled, roi: +roi.toFixed(1), clv: clv != null ? +clv.toFixed(1) : null });
        }
      };
      audit(_fetchTips(db, days, true), 'shadow');
      audit(_fetchTips(db, days, false), 'real');
    } catch (e) {
      log('WARN', 'ML-AUTO-PROMOTE', `audit granular err: ${e.message}`);
    }
  }

  // Refresh in-memory cache
  loadMlLeagueBlocklist(db);

  const total = decisions.promoted.length + decisions.reverted.length
              + decisions.league_blocked.length + decisions.league_unblocked.length;
  if (total) {
    log('INFO', 'ML-AUTO-PROMOTE', `Ciclo: promoted=${decisions.promoted.length} reverted=${decisions.reverted.length} league_blocked=${decisions.league_blocked.length} league_unblocked=${decisions.league_unblocked.length} audit_rows=${decisions.audit_granularity.length}`);
  } else {
    log('DEBUG', 'ML-AUTO-PROMOTE', `Ciclo sem mudanças (audit_rows=${decisions.audit_granularity.length} rejected_ci=${decisions.rejected_by_ci.length})`);
  }
  // Diag: holdout efetivo + shadow state observado per-sport + sample counts
  // (debug rápido pra ver POR QUE um sport não decide). Sample/shadow_state
  // capturados durante o loop sport-level.
  const _frozen = require('./frozen-holdout');
  const shadowStates = {};
  for (const sp of SPORTS) {
    shadowStates[sp] = {
      shadow_env: process.env[`${sp.toUpperCase()}_SHADOW`] || null,
      is_shadow: _isCurrentlyShadow(sp),
    };
  }
  // Sample por sport (shadow + real settled count, ROI bruto pre-gate)
  const sampleDiag = {};
  try {
    const shRows = _fetchTips(db, days, true);
    const rlRows = _fetchTips(db, revertDays, false);
    const aggSh = _aggregate(shRows, r => String(r.sport || '').toLowerCase());
    const aggRl = _aggregate(rlRows, r => String(r.sport || '').toLowerCase());
    for (const a of aggSh) {
      sampleDiag[a.key] = sampleDiag[a.key] || {};
      sampleDiag[a.key].shadow_settled = a.settled;
      sampleDiag[a.key].shadow_roi_pct = a.stake_sum > 0 ? +(a.profit_sum / a.stake_sum * 100).toFixed(2) : null;
    }
    for (const a of aggRl) {
      sampleDiag[a.key] = sampleDiag[a.key] || {};
      sampleDiag[a.key].real_settled = a.settled;
      sampleDiag[a.key].real_roi_pct = a.stake_sum > 0 ? +(a.profit_sum / a.stake_sum * 100).toFixed(2) : null;
    }
  } catch (_) {}
  const config = {
    window_days: days,
    holdout_days: _frozen.getHoldoutDays('ml_auto_promote'),
    holdout_cutoff: _frozen.getHoldoutCutoffIso('ml_auto_promote'),
    min_settled: minSettled,
    min_roi: minRoi,
    revert_days: revertDays,
    revert_roi: revertRoi,
    require_ci: requireCi,
    ci_lower_threshold: ciLowerThreshold,
    real_only: realOnly,
    shadow_states: shadowStates,
    sample_by_sport: sampleDiag,
  };
  return { ok: true, decisions, config, totals: { ...Object.fromEntries(Object.entries(decisions).map(([k, v]) => [k, v.length])) } };
}

module.exports = {
  runMlAutoPromoteCycle,
  isMlLeagueBlocked,
  loadMlLeagueBlocklist,
};

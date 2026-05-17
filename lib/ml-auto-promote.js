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
 *   ML_AUTO_PROMOTE_MIN_CLV          (default -100 = bypass; set -20 ou -5 pra gate ativo)
 *   ML_AUTO_PROMOTE_MIN_CLV_SAMPLES  (default 10 — bypass CLV gate quando clv_n < N)
 *   ML_AUTO_PROMOTE_REVERT_ROI       (default -3)
 *   ML_AUTO_PROMOTE_REVERT_DAYS      (default 14)
 *   ML_AUTO_PROMOTE_LEAGUE_MIN_N     (default 10)
 *   ML_AUTO_PROMOTE_LEAGUE_ROI       (default -10)
 *   ML_AUTO_PROMOTE_LEAGUE_RESTORE   (default -3)
 *   ML_AUTO_PROMOTE_WINDOW_DAYS      (default 120)  — > FROZEN_HOLDOUT_DAYS pra cron ver dados
 *   ML_AUTO_PROMOTE_AUDIT_TIER_BUCKET (default true) — registra audit rows
 *
 * Per-sport overrides (2026-05-17 — tips antigas não refletem comportamento atual):
 *   ML_AUTO_PROMOTE_WINDOW_DAYS_<SPORT>  — narrows PROMOTE window pra sport (ex:
 *     LOL=7 vs default 120). Aplica só em PROMOTE eval + audit/diag shadow.
 *     REVERT/LEAGUE continuam com janela própria (revertDays/days).
 *   ML_AUTO_PROMOTE_EVAL_SINCE_<SPORT>   — ISO date (ex: '2026-05-14') que corta
 *     todas as tips anteriores pra esse sport, em TODAS as paths (PROMOTE,
 *     REVERT, LEAGUE, audit, diag). Cross-cutting. Mais restritivo ganha vs
 *     WINDOW_DAYS — se SINCE > now-WINDOW_DAYS, SINCE prevalece.
 *     ADICIONALMENTE: sport com EVAL_SINCE setado BYPASSA FROZEN_HOLDOUT
 *     (user explicitou walk-forward; senão interseção vazia). Outros sports
 *     mantêm holdout normalmente.
 *   Default zero-change: sem nada setado, comportamento legacy preservado.
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

// 2026-05-14: bucket-level block cache (mig 105 ml_bucket_blocklist).
const _bucketBlockCache = new Set();

function loadMlBucketBlocklist(db) {
  try {
    _bucketBlockCache.clear();
    const rows = db.prepare(`SELECT sport, tier, bucket FROM ml_bucket_blocklist`).all();
    for (const r of rows) {
      _bucketBlockCache.add(`${r.sport}|${r.tier}|${r.bucket}`);
    }
    if (_bucketBlockCache.size) {
      log('INFO', 'ML-AUTO-PROMOTE', `Loaded ${_bucketBlockCache.size} ML bucket blocks`);
    }
  } catch (e) {
    // mig 105 não aplicada ainda — silent skip.
    log('DEBUG', 'ML-AUTO-PROMOTE', `loadMlBucketBlocklist err: ${e.message}`);
  }
}

// Consumer Wave 5.2: bot.js ML emit path consulta antes de gravar real tip.
// odds = decimal odd da tip; tier = getLeagueTierKey resolved; sport lowercase.
function isMlBucketBlocked(sport, tier, odds) {
  if (!sport || !tier || !Number.isFinite(odds)) return false;
  const bucket = _bucketOf(odds);
  if (!bucket) return false;
  return _bucketBlockCache.has(`${String(sport).toLowerCase()}|${tier}|${bucket}`);
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

// Infere se sport está em shadow mode. Múltiplos mecanismos podem ativar
// shadow:
//   1. <SPORT>_SHADOW=true env (seed do bot.js, _splitBucketShadow Set)
//   2. <SPORT>_ML_DISABLED=true (server.js _autoRouteToShadow rota tips pra shadow)
//   3. AUTO_SHADOW_NEGATIVE_CLV bot.js (flip por CLV degradado, in-memory)
//   4. settings.ml_shadow_<sport> (persisted por este próprio cron)
//   5. Bankroll Guardian (in-memory cfg.shadowMode)
//
// Como o cron roda em processo diferente do bot (server.js vs bot.js), não
// vê (3) e (5). Fallback robusto: se sport tem ratio is_shadow=1 alto em
// tips recentes, está EFETIVAMENTE em shadow mode (independente do mecanismo).
function _isCurrentlyShadow(sport, db) {
  const up = String(sport).toUpperCase();
  // Sinais diretos (envs + settings)
  if (process.env[`${up}_SHADOW`] === 'true') return true;
  if (process.env[`${up}_ML_DISABLED`] === 'true') return true;
  if (db) {
    try {
      const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`ml_shadow_${sport}`);
      if (row && String(row.value) === 'true') return true;
      if (row && String(row.value) === 'false') return false;
    } catch (_) {}
    // Fallback empírico: 7d ratio de tips ML is_shadow=1 vs total. ≥70% → shadow.
    try {
      const r = db.prepare(`
        SELECT
          SUM(CASE WHEN is_shadow=1 THEN 1 ELSE 0 END) AS sh,
          SUM(CASE WHEN is_shadow=0 THEN 1 ELSE 0 END) AS re
        FROM tips
        WHERE sport=? AND COALESCE(archived,0)=0
          AND COALESCE(market_type,'ML')='ML'
          AND sent_at >= datetime('now','-7 days')
      `).get(sport);
      const sh = Number(r?.sh) || 0;
      const re = Number(r?.re) || 0;
      const tot = sh + re;
      if (tot >= 5 && sh / tot >= 0.7) return true;
    } catch (_) {}
  }
  return false;
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
    SELECT sport, stake, odds, result, event_name, clv_pct, sent_at
    FROM tips
    WHERE is_shadow = ?
      AND COALESCE(archived, 0) = 0
      AND result IN ('win','loss','void','push')
      AND COALESCE(market_type, 'ML') = 'ML'
      AND sent_at >= datetime('now', '-' || ? || ' days')
      ${holdoutClause}
  `).all(isShadow ? 1 : 0, days);
}

// Variante sem holdout — usada quando sport tem EVAL_SINCE_<SPORT> setado
// (user explicitou fronteira walk-forward; holdout vira redundante e
// conflita: holdout exige sent_at < now-60d, EVAL_SINCE exige sent_at >= cutoff
// → interseção vazia quando EVAL_SINCE é recente).
function _fetchTipsNoHoldout(db, days, isShadow) {
  return db.prepare(`
    SELECT sport, stake, odds, result, event_name, clv_pct, sent_at
    FROM tips
    WHERE is_shadow = ?
      AND COALESCE(archived, 0) = 0
      AND result IN ('win','loss','void','push')
      AND COALESCE(market_type, 'ML') = 'ML'
      AND sent_at >= datetime('now', '-' || ? || ' days')
  `).all(isShadow ? 1 : 0, days);
}

function _hasSinceForSport(sport) {
  const sinceStr = process.env[`ML_AUTO_PROMOTE_EVAL_SINCE_${String(sport || '').toUpperCase()}`];
  if (!sinceStr) return false;
  return !Number.isNaN(new Date(sinceStr).getTime());
}

// 2026-05-17 — per-sport cutoff helper (motivo: tips antigas emitidas sob
// model state diferente não refletem comportamento atual; user pediu cortar
// influência delas em auto-promote sem mexer na janela global).
//
// applyWindowOverride=true → ML_AUTO_PROMOTE_WINDOW_DAYS_<SPORT> narrows defaultDays
// applyWindowOverride=false → só EVAL_SINCE_<SPORT> aplica (cross-cutting)
// Mais restritivo (cutoff mais recente) sempre ganha.
function _effectiveCutoffMs(sport, defaultDays, opts = {}) {
  const { applyWindowOverride = true } = opts;
  const upper = String(sport || '').toUpperCase();
  const effDays = applyWindowOverride
    ? _envInt(`ML_AUTO_PROMOTE_WINDOW_DAYS_${upper}`, defaultDays)
    : defaultDays;
  let cutoffMs = Date.now() - effDays * 86400000;
  const sinceStr = process.env[`ML_AUTO_PROMOTE_EVAL_SINCE_${upper}`];
  if (sinceStr) {
    const d = new Date(sinceStr);
    if (!Number.isNaN(d.getTime()) && d.getTime() > cutoffMs) {
      cutoffMs = d.getTime();
    }
  }
  return cutoffMs;
}

// Envelope query usa MAX dos days efetivos (pra fetch cobrir todos sports);
// filter per-sport aplica cutoff específico. Mantém _fetchTips intocado.
//
// 2026-05-17 — quando algum sport tem EVAL_SINCE_<SPORT> setado, holdout é
// bypassed pra aquele sport (EVAL_SINCE já é a fronteira walk-forward
// explícita do user). Implementação:
//   - se NENHUM sport tem EVAL_SINCE → query única com holdout (legacy fast path)
//   - se ALGUM sport tem EVAL_SINCE → query sem holdout + re-aplica holdout
//     em JS apenas pros sports sem EVAL_SINCE setado
function _fetchTipsFiltered(db, defaultDays, isShadow, opts = {}) {
  const { applyWindowOverride = true } = opts;
  let maxDays = defaultDays;
  if (applyWindowOverride) {
    for (const sp of SPORTS) {
      const d = _envInt(`ML_AUTO_PROMOTE_WINDOW_DAYS_${sp.toUpperCase()}`, defaultDays);
      if (d > maxDays) maxDays = d;
    }
  }
  const sportsWithSince = new Set(SPORTS.filter(_hasSinceForSport));
  let rows;
  if (sportsWithSince.size === 0) {
    rows = _fetchTips(db, maxDays, isShadow);
  } else {
    rows = _fetchTipsNoHoldout(db, maxDays, isShadow);
    const holdoutCutoffIso = require('./frozen-holdout').getHoldoutCutoffIso('ml_auto_promote');
    if (holdoutCutoffIso) {
      const holdoutCutoffMs = new Date(holdoutCutoffIso).getTime();
      rows = rows.filter(r => {
        const sport = String(r.sport || '').toLowerCase();
        if (sportsWithSince.has(sport)) return true;
        const tipMs = new Date(String(r.sent_at || '').replace(' ', 'T') + 'Z').getTime();
        return Number.isFinite(tipMs) && tipMs < holdoutCutoffMs;
      });
    }
  }
  return rows.filter(r => {
    const sport = String(r.sport || '').toLowerCase();
    const cutoffMs = _effectiveCutoffMs(sport, defaultDays, opts);
    const sentAt = String(r.sent_at || '');
    if (!sentAt) return false;
    const tipMs = new Date(sentAt.replace(' ', 'T') + 'Z').getTime();
    return Number.isFinite(tipMs) && tipMs >= cutoffMs;
  });
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
  // 2026-05-14: CLV gate. CLV sustained-negative + ROI positivo é red flag —
  // modelo NÃO bate Pinnacle close (variance puxou ROI). Audit valorant
  // 11/05: promove ROI 16.9% n=54 mas CLV=-42% (divergence severe).
  // Default -100 preserva comportamento legacy (sem CLV gate); ative com
  // ML_AUTO_PROMOTE_MIN_CLV=-20 (extremos) ou =-5 (estrito).
  const minClv = _envFloat('ML_AUTO_PROMOTE_MIN_CLV', -100);
  // Min samples pra gate CLV aplicar — evita bloqueio em 1-sample variance.
  // Audit 2026-05-14: valorant shadow CLV -42% baseado em 1 sample só
  // (coverage 2.6%). Gate sample <10 bypassa CLV check (não bloqueia).
  // Default 10 mirror /shadow-readiness MIN_CLV_SAMPLES.
  const minClvSamples = _envInt('ML_AUTO_PROMOTE_MIN_CLV_SAMPLES', 10);
  // 2026-05-14: bucket_block gate. Audit_granular detecta (sport, tier, bucket)
  // com ROI≤threshold + n≥minN → registra em ml_bucket_blocklist (mig 105).
  // Caso disparador: tennis tier3 bucket "2.5-4.0" shadow n=55 ROI -50.6%
  // (P1 violation — bleeder visível mas só audit-only).
  // Default: gate ON, threshold -30% (ROI severo), minN=10. Opt-out
  // ML_AUTO_PROMOTE_BUCKET_BLOCK_DISABLED=true.
  const bucketBlockEnabled = !/^(1|true|yes)$/i.test(String(process.env.ML_AUTO_PROMOTE_BUCKET_BLOCK_DISABLED || ''));
  const bucketBlockRoi = _envFloat('ML_AUTO_PROMOTE_BUCKET_BLOCK_ROI', -30);
  const bucketBlockMinN = _envInt('ML_AUTO_PROMOTE_BUCKET_BLOCK_MIN_N', 10);
  // 2026-05-15 Sprint cleanup — P2 enforcement: block é SINTOMA (decisão de
  // tratamento em real), trigger correto é real data não shadow. Default true
  // alinha com pattern Wave 2 (EV_CALIB_REAL_ONLY, LEAGUE_TRUST_REAL_ONLY,
  // MT_AUTO_PROMOTE_REAL_ONLY). Opt-out false reverte pra legacy shadow trigger.
  // Real min_n separado pra acomodar volume real menor.
  const bucketBlockRealOnly = !/^(0|false|no)$/i.test(String(process.env.ML_BUCKET_BLOCK_REAL_ONLY ?? 'true'));
  const bucketBlockRealMinN = _envInt('ML_BUCKET_BLOCK_REAL_MIN_N', 5);
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
    // PROMOTE shadow eval: aplica A (per-sport WINDOW_DAYS) + B (EVAL_SINCE).
    const shadowRows = _fetchTipsFiltered(db, days, true, { applyWindowOverride: true });
    // Pra revert lemos real (sintoma) — janela revertDays. Não aplica A (REVERT
    // tem janela própria curta); B é cross-cutting e sempre vale.
    const revertSrcRows = realOnly
      ? _fetchTipsFiltered(db, revertDays, false, { applyWindowOverride: false })
      : _fetchTipsFiltered(db, revertDays, true, { applyWindowOverride: false });

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
      const shadowOn = _isCurrentlyShadow(sport, db);
      const a = shadowBySport.get(sport);

      if (shadowOn && a) {
        // PROMOTE path: avalia shadow stats.
        const settled = a.settled;
        const roi = a.stake_sum > 0 ? (a.profit_sum / a.stake_sum * 100) : null;
        const clv = a.clv_n > 0 ? (a.clv_sum / a.clv_n) : null;
        const ci = _computeRoiCi(settled, a.profit_sum, a.stake_sum, a.profit_sq);
        const ciPasses = !requireCi || (ci && ci.lower_pp > ciLowerThreshold);
        // CLV gate: bloqueia promote quando CLV sustentado negativo (divergence
        // com ROI = variance, não edge). clv=null bypassa (sem CLV captured).
        // clv_n < minClvSamples bypassa (sample tiny, não-representative — evita
        // bloqueio em 1-2 samples variance). minClv=-100 default = bypass legacy.
        const clvN = a.clv_n || 0;
        const clvPasses = clv == null || clvN < minClvSamples || clv >= minClv;

        if (settled >= minSettled && roi != null && roi >= minRoi && ciPasses && clvPasses) {
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
        } else if (settled >= minSettled && roi != null && roi >= minRoi && ciPasses && !clvPasses) {
          _logDecision(db, { sport, action: 'reject_clv', reason: `CLV ${clv.toFixed(1)}% < min ${minClv}% (n=${clvN}): ROI ${roi.toFixed(1)}% mas divergence severe (variance != edge)`, n: settled, roi, clv });
          decisions.rejected_by_ci.push({ sport, roi: +roi.toFixed(1), n: settled, clv: +clv.toFixed(1), clv_n: clvN, reason: 'clv_below_min' });
          log('INFO', 'ML-AUTO-PROMOTE', `${sport}: SKIP promote (CLV ${clv.toFixed(1)}% < ${minClv}% n=${clvN} — variance != edge) ROI=${roi.toFixed(1)}% n=${settled}`);
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
    // LEAGUE eval: precisa janela longa pra ter sample por liga. Aplica só B
    // (EVAL_SINCE) — A narrows demais.
    const leagueRows = realOnly
      ? _fetchTipsFiltered(db, days, false, { applyWindowOverride: false })
      : _fetchTipsFiltered(db, days, true, { applyWindowOverride: false });
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
  // Loga breakdown via _logDecision. 2026-05-14: agora também dispara bucket_block
  // quando shadow ROI ≤ bucketBlockRoi (default -30%) E n ≥ bucketBlockMinN (default 10).
  // Source 'auto_bucket_block_shadow' marca origem. Persiste em ml_bucket_blocklist
  // (mig 105). Consumer Wave 5.2 (bot.js path emit ML).
  if (auditTierBucket) {
    try {
      const upsertBucketBlock = bucketBlockEnabled ? db.prepare(`
        INSERT INTO ml_bucket_blocklist (sport, tier, bucket, since, source, reason, n, roi_pct)
        VALUES (?, ?, ?, datetime('now'), 'auto_bucket_block_shadow', ?, ?, ?)
        ON CONFLICT(sport, tier, bucket) DO UPDATE SET
          since = excluded.since, source = excluded.source, reason = excluded.reason,
          n = excluded.n, roi_pct = excluded.roi_pct
      `) : null;
      const audit = (rows, suffix) => {
        const agg = _aggregate(rows, r => {
          const sp = String(r.sport || '').toLowerCase();
          if (!sp) return null;
          const tier = getLeagueTierKey(sp, r.event_name || '');
          const bucket = _bucketOf(r.odds);
          return `${sp}|${tier}|${bucket}`;
        });
        for (const a of agg) {
          if (a.settled < 20) continue; // ruído pra audit log
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
          // Auto bucket_block: P2-strict. Block é SINTOMA (rejeita real tip
          // emission); trigger deve vir de real data, não shadow. Default
          // ML_BUCKET_BLOCK_REAL_ONLY=true; opt-out false reverte pra shadow.
          const triggerSource = bucketBlockRealOnly ? 'real' : 'shadow';
          const triggerMinN = bucketBlockRealOnly ? bucketBlockRealMinN : bucketBlockMinN;
          if (upsertBucketBlock && suffix === triggerSource && a.settled >= triggerMinN && roi <= bucketBlockRoi) {
            try {
              upsertBucketBlock.run(sport, tier, bucket, `auto: ${suffix} ROI ${roi.toFixed(1)}% n=${a.settled}`, a.settled, +roi.toFixed(2));
              _logDecision(db, {
                sport, tier, bucket,
                action: 'bucket_block',
                reason: `auto: ROI ${roi.toFixed(1)}% ≤ ${bucketBlockRoi}% n=${a.settled} (shadow universe)`,
                n: a.settled, roi, clv,
              });
              decisions.audit_granularity.push({ source: 'bucket_block', sport, tier, bucket, n: a.settled, roi: +roi.toFixed(1) });
              log('WARN', 'ML-AUTO-PROMOTE', `${sport}|${tier}|${bucket}: BUCKET_BLOCK ROI=${roi.toFixed(1)}% n=${a.settled}`);
            } catch (e) { log('DEBUG', 'ML-AUTO-PROMOTE', `bucket_block upsert err: ${e.message}`); }
          }
        }
      };
      audit(_fetchTipsFiltered(db, days, true, { applyWindowOverride: true }), 'shadow');
      audit(_fetchTipsFiltered(db, days, false, { applyWindowOverride: false }), 'real');
    } catch (e) {
      log('WARN', 'ML-AUTO-PROMOTE', `audit granular err: ${e.message}`);
    }
  }

// Refresh in-memory cache
  loadMlLeagueBlocklist(db);
  loadMlBucketBlocklist(db);

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
      ml_disabled_env: process.env[`${sp.toUpperCase()}_ML_DISABLED`] || null,
      settings_value: (() => { try { return db.prepare(`SELECT value FROM settings WHERE key=?`).get(`ml_shadow_${sp}`)?.value || null; } catch { return null; } })(),
      is_shadow: _isCurrentlyShadow(sp, db),
    };
  }
  // Sample por sport (shadow + real settled count, ROI bruto pre-gate)
  const sampleDiag = {};
  try {
    const shRows = _fetchTipsFiltered(db, days, true, { applyWindowOverride: true });
    const rlRows = _fetchTipsFiltered(db, revertDays, false, { applyWindowOverride: false });
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
  // Per-sport overrides (2026-05-17): mostra envs setadas + cutoff efetivo.
  // Útil pra confirmar via /admin/ml-auto-promote que a config tá ativa.
  const perSportOverrides = {};
  for (const sp of SPORTS) {
    const up = sp.toUpperCase();
    const winDaysOverride = process.env[`ML_AUTO_PROMOTE_WINDOW_DAYS_${up}`] || null;
    const sinceOverride = process.env[`ML_AUTO_PROMOTE_EVAL_SINCE_${up}`] || null;
    if (winDaysOverride || sinceOverride) {
      const cutoffMs = _effectiveCutoffMs(sp, days, { applyWindowOverride: true });
      perSportOverrides[sp] = {
        window_days: winDaysOverride,
        eval_since: sinceOverride,
        effective_cutoff_iso: new Date(cutoffMs).toISOString(),
      };
    }
  }
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
    per_sport_overrides: perSportOverrides,
    shadow_states: shadowStates,
    sample_by_sport: sampleDiag,
  };
  return { ok: true, decisions, config, totals: { ...Object.fromEntries(Object.entries(decisions).map(([k, v]) => [k, v.length])) } };
}

module.exports = {
  runMlAutoPromoteCycle,
  isMlLeagueBlocked,
  loadMlLeagueBlocklist,
  isMlBucketBlocked,
  loadMlBucketBlocklist,
};

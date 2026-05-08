'use strict';

/**
 * mt-auto-promote.js — auto-promote MT shadow → real per (sport, market) +
 * blocklist por liga problemática.
 *
 * Fluxo (cron 12h):
 *   1. Avalia (sport, market) nos últimos N dias (default 30).
 *   2. Se n_settled ≥ 30 AND ROI ≥ +2% → seta `<SPORT>_MARKET_TIPS_ENABLED=true`
 *      (env runtime + settings table). Tips reais MT desse sport passam a ser
 *      criadas, aparecem em "tips recentes" e contam na banca.
 *   3. Reverso: se ROI cair ≤ -5% nos últimos 14d com n_settled ≥ 30 → revert.
 *   4. Per liga (sport, market, league): se n_settled ≥ 10 AND ROI ≤ -10% →
 *      adiciona em mt_market_league_blocklist. Helper `isMtLeagueBlockedForMarket`
 *      consulta cache em memória (loaded no boot + atualizado pós-cycle).
 *   5. Audit log de cada decisão em mt_auto_promote_log.
 *
 * 2026-05-07 (P2 fix shadow=causa, real=sintoma):
 *   - PROMOTE (shadow→real) lê SHADOW (pre-promote eval permitido P2).
 *   - REVERT (real→shadow) e LEAGUE_BLOCK/UNBLOCK leem REAL (sintoma).
 *   - Pattern unificado com runMarketTipsLeakGuard etc: INNER JOIN tips
 *     is_shadow=0 + market_type + janela 14d + team norm.
 *   - Opt-out: MT_AUTO_PROMOTE_REAL_ONLY=false (legacy, mistura).
 *
 * Envs:
 *   MT_AUTO_PROMOTE                 (default true) — master switch
 *   MT_AUTO_PROMOTE_REAL_ONLY       (default true) — REVERT/LEAGUE usam real
 *   MT_AUTO_PROMOTE_MIN_SETTLED     (default 150)
 *   MT_AUTO_PROMOTE_MIN_ROI         (default 2)    — ROI floor pra promover
 *   MT_AUTO_PROMOTE_REQUIRE_CI      (default true) — IC95% gate no promote
 *   MT_AUTO_PROMOTE_CI_LOWER_THRESHOLD (default 0)
 *   MT_AUTO_PROMOTE_REVERT_ROI      (default -3)   — ROI ceiling pra reverter
 *   MT_AUTO_PROMOTE_REVERT_DAYS     (default 14)
 *   MT_AUTO_PROMOTE_LEAGUE_MIN_N    (default 10)
 *   MT_AUTO_PROMOTE_LEAGUE_ROI      (default -10)  — ROI cutoff pra blockar liga
 *   MT_AUTO_PROMOTE_LEAGUE_RESTORE  (default -3)   — ROI pra desbloquear liga
 *   MT_AUTO_PROMOTE_WINDOW_DAYS     (default 30)
 *   MT_AUTO_PROMOTE_DM_ADMIN        (default true) — DM admin a cada decisão
 */

const { log } = require('./utils');

const SPORTS = ['lol', 'dota2', 'cs', 'cs2', 'valorant', 'tennis', 'football', 'mma', 'tabletennis', 'darts', 'snooker'];

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

// Cache em memória — populated por loadMtMarketLeagueBlocklist + refreshed pós cycle.
const _leagueBlockCache = new Set();

function loadMtMarketLeagueBlocklist(db) {
  try {
    _leagueBlockCache.clear();
    const rows = db.prepare(`SELECT sport, market, league_norm FROM mt_market_league_blocklist`).all();
    for (const r of rows) {
      _leagueBlockCache.add(`${r.sport}|${r.market}|${r.league_norm}`);
    }
    if (_leagueBlockCache.size) {
      log('INFO', 'MT-AUTO-PROMOTE', `Loaded ${_leagueBlockCache.size} league blocks`);
    }
  } catch (e) {
    log('DEBUG', 'MT-AUTO-PROMOTE', `loadMtMarketLeagueBlocklist err: ${e.message}`);
  }
}

function isMtLeagueBlockedForMarket(sport, market, league) {
  if (!sport || !market || !league) return false;
  return _leagueBlockCache.has(`${sport}|${market}|${_normLeague(league)}`);
}

function _logDecision(db, args) {
  try {
    db.prepare(`
      INSERT INTO mt_auto_promote_log (sport, market, league, action, reason, n, roi_pct, clv_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      args.sport, args.market || null, args.league || null,
      args.action, args.reason || null,
      args.n != null ? args.n : null,
      args.roi != null ? args.roi : null,
      args.clv != null ? args.clv : null,
    );
  } catch (e) {
    log('DEBUG', 'MT-AUTO-PROMOTE', `log decision err: ${e.message}`);
  }
}

function _setMtPromoteEnv(db, sport, enabled) {
  const up = String(sport).toUpperCase();
  const envKey = `${up}_MARKET_TIPS_ENABLED`;
  const settingKey = `mt_promote_${sport}`;
  if (enabled) {
    process.env[envKey] = 'true';
  } else {
    delete process.env[envKey];
  }
  try {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(settingKey, enabled ? 'true' : 'false');
  } catch (e) {
    // Não-fatal: env já foi setado em memória (process.env). Persistir em settings
    // table é só pra recuperação pós-restart. Log WARN porque indica DB lock/disk
    // issue que pode afetar outras escritas.
    log('WARN', 'MT-AUTO-PROMOTE', `_setMtPromoteEnv settings persist failed sport=${sport} enabled=${enabled}: ${e.message}`);
  }
}

function _isCurrentlyPromoted(sport) {
  const up = String(sport).toUpperCase();
  const aliasEnv = { DOTA2: 'DOTA', CS2: 'CS' }[up];
  return process.env[`${up}_MARKET_TIPS_ENABLED`] === 'true'
    || (aliasEnv && process.env[`${aliasEnv}_MARKET_TIPS_ENABLED`] === 'true');
}

// _NORM SQL helper — espelha _normTeam em mt-result-propagator.js:37
// (lower + remove space/dash/dot/apostrofe). JOIN com tips real exige same norm.
const _NORM_SQL = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(lower(${col}),' ',''),'-',''),'.',''),'''','')`;

// JOIN canônico market_tips_shadow ↔ tips real (is_shadow=0). Pattern unificado
// com runMarketTipsLeakGuard / runMarketTipsRoiGuardSided / runMtBucketGuardCycle.
// Garante que decisões de SINTOMA (revert, league_block) só vejam settles que
// efetivamente foram dispatched como tip real.
const _JOIN_REAL_SQL = `
  INNER JOIN tips t ON
    t.sport = mts.sport
    AND UPPER(t.market_type) = UPPER(mts.market)
    AND COALESCE(t.is_shadow, 0) = 0
    AND (t.archived IS NULL OR t.archived = 0)
    AND t.result IN ('win','loss','void','push')
    AND ABS(julianday(COALESCE(t.sent_at, t.settled_at)) - julianday(mts.created_at)) < 14
    AND (
      (${_NORM_SQL('t.participant1')} = ${_NORM_SQL('mts.team1')} AND ${_NORM_SQL('t.participant2')} = ${_NORM_SQL('mts.team2')})
      OR
      (${_NORM_SQL('t.participant1')} = ${_NORM_SQL('mts.team2')} AND ${_NORM_SQL('t.participant2')} = ${_NORM_SQL('mts.team1')})
    )
`;

// Stats por (sport) — agrega TODOS os mercados. Usado pra decisão sport-level.
// 2026-05-06: adicionado profit_sq (sum of profit²) pra computar variance e
// IC 95% sem segunda query. SQLite math: variance = (sum_sq - n × mean²) / (n - 1).
//
// Shadow-only path. Usado para PROMOTE (pre-promote evaluation — P2 explicit
// allow). Sport ainda não tem real volume, shadow é único universo disponível.
function _statsBySport(db, days) {
  // Frozen holdout: exclui últimos N dias se FROZEN_HOLDOUT_DAYS setado
  // (override FROZEN_HOLDOUT_MT_AUTO_PROMOTE_DAYS). Default OFF.
  const holdoutClause = require('./frozen-holdout').getHoldoutSql('mt_auto_promote', 'created_at');
  return db.prepare(`
    SELECT sport,
      COUNT(CASE WHEN result IN ('win','loss') THEN 1 END) AS settled,
      SUM(CASE WHEN result IN ('win','loss') THEN COALESCE(stake_units, 1) ELSE 0 END) AS stake_u,
      SUM(COALESCE(profit_units, 0)) AS profit_u,
      SUM(COALESCE(profit_units, 0) * COALESCE(profit_units, 0)) AS profit_sq,
      AVG(clv_pct) AS avg_clv,
      SUM(CASE WHEN clv_pct IS NOT NULL THEN 1 ELSE 0 END) AS clv_n
    FROM market_tips_shadow
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      ${holdoutClause}
    GROUP BY sport
  `).all(days);
}

// Real path. Usado para REVERT (sintoma — sport JÁ promovido, decisão deveria
// usar tips real). Shadow rows são filtradas pelo INNER JOIN tips is_shadow=0.
// Sport sem volume real → JOIN volta vazio → revert nunca dispara (intencional).
function _statsBySportReal(db, days) {
  const holdoutClause = require('./frozen-holdout').getHoldoutSql('mt_auto_promote', 'mts.created_at');
  return db.prepare(`
    SELECT mts.sport AS sport,
      COUNT(CASE WHEN mts.result IN ('win','loss') THEN 1 END) AS settled,
      SUM(CASE WHEN mts.result IN ('win','loss') THEN COALESCE(mts.stake_units, 1) ELSE 0 END) AS stake_u,
      SUM(COALESCE(mts.profit_units, 0)) AS profit_u,
      SUM(COALESCE(mts.profit_units, 0) * COALESCE(mts.profit_units, 0)) AS profit_sq,
      AVG(mts.clv_pct) AS avg_clv,
      SUM(CASE WHEN mts.clv_pct IS NOT NULL THEN 1 ELSE 0 END) AS clv_n
    FROM market_tips_shadow mts
    ${_JOIN_REAL_SQL}
    WHERE mts.created_at >= datetime('now', '-' || ? || ' days')
      ${holdoutClause}
    GROUP BY mts.sport
  `).all(days);
}

/**
 * Computa IC 95% do ROI baseado em SE clássico.
 * Assume stake unitário (stake_units ≈ 1) — válido pra MT shadow onde
 * stake_units default = 1. Profit_units já é signed (positivo win, negativo loss).
 *
 * @param {number} n - amostra
 * @param {number} sumProfit - sum profit_units
 * @param {number} sumProfitSq - sum profit_units²
 * @returns {{lower_pp, upper_pp, se_pp, mean_pp} | null}
 */
function _computeRoiCi(n, sumProfit, sumProfitSq) {
  if (!Number.isFinite(n) || n < 2) return null;
  const mean = sumProfit / n;
  const variance = (sumProfitSq - n * mean * mean) / (n - 1);
  if (!Number.isFinite(variance) || variance < 0) return null;
  const se = Math.sqrt(variance / n);
  return {
    mean_pp: +(mean * 100).toFixed(2),
    se_pp: +(se * 100).toFixed(2),
    lower_pp: +((mean - 1.96 * se) * 100).toFixed(2),
    upper_pp: +((mean + 1.96 * se) * 100).toFixed(2),
  };
}

// Stats por (sport, league) — usado pra decisão de league block.
// Agregamos por league SEM market porque a maioria dos sports MT só tem 1-2
// mercados ativos; granularidade extra (sport,market,league) gera samples
// minúsculos. Liga ruim em totals geralmente é ruim em handicap também
// (ineficiência da liga, não do mercado).
//
// Shadow-only path. Mantido pra opt-out legacy (MT_AUTO_PROMOTE_REAL_ONLY=false).
// Default usa _statsBySportLeagueReal — league_block é SINTOMA.
function _statsBySportLeague(db, days) {
  const holdoutClause = require('./frozen-holdout').getHoldoutSql('mt_auto_promote', 'created_at');
  return db.prepare(`
    SELECT sport, market, league,
      COUNT(CASE WHEN result IN ('win','loss') THEN 1 END) AS settled,
      SUM(CASE WHEN result IN ('win','loss') THEN COALESCE(stake_units, 1) ELSE 0 END) AS stake_u,
      SUM(COALESCE(profit_units, 0)) AS profit_u
    FROM market_tips_shadow
    WHERE created_at >= datetime('now', '-' || ? || ' days')
      ${holdoutClause}
      AND league IS NOT NULL AND TRIM(league) != ''
      AND market IS NOT NULL AND TRIM(market) != ''
    GROUP BY sport, market, league
  `).all(days);
}

// Real path para league_block / league_unblock. Pattern unificado: INNER JOIN
// tips is_shadow=0 + market_type + janela 14d + team norm. Liga sem volume real
// → JOIN volta vazio → block nunca dispara (intencional pré-promote).
function _statsBySportLeagueReal(db, days) {
  const holdoutClause = require('./frozen-holdout').getHoldoutSql('mt_auto_promote', 'mts.created_at');
  return db.prepare(`
    SELECT mts.sport AS sport, mts.market AS market, mts.league AS league,
      COUNT(CASE WHEN mts.result IN ('win','loss') THEN 1 END) AS settled,
      SUM(CASE WHEN mts.result IN ('win','loss') THEN COALESCE(mts.stake_units, 1) ELSE 0 END) AS stake_u,
      SUM(COALESCE(mts.profit_units, 0)) AS profit_u
    FROM market_tips_shadow mts
    ${_JOIN_REAL_SQL}
    WHERE mts.created_at >= datetime('now', '-' || ? || ' days')
      ${holdoutClause}
      AND mts.league IS NOT NULL AND TRIM(mts.league) != ''
      AND mts.market IS NOT NULL AND TRIM(mts.market) != ''
    GROUP BY mts.sport, mts.market, mts.league
  `).all(days);
}

async function runMtAutoPromoteCycle(db, opts = {}) {
  if (/^(0|false|no)$/i.test(String(process.env.MT_AUTO_PROMOTE ?? 'true'))) {
    return { ok: true, skipped: 'disabled' };
  }
  const days = _envInt('MT_AUTO_PROMOTE_WINDOW_DAYS', 30);
  // 2026-05-06: minSettled 30 → 150 (default). Audit response apontou que com
  // 11 sports × 7+ markets × tiers × regimes rodando "n≥30" simultaneamente,
  // multiple comparisons sem correção fazem ~5-10% dos promotes serem ruído
  // estatístico. n=150 reduz P(false positive) drasticamente.
  const minSettled = _envInt('MT_AUTO_PROMOTE_MIN_SETTLED', 150);
  const minRoi = _envFloat('MT_AUTO_PROMOTE_MIN_ROI', 2);
  // 2026-05-06: novo gate IC 95% lower bound. Default true. Promove só se
  // ROI lower bound > MT_AUTO_PROMOTE_CI_LOWER_THRESHOLD (default 0).
  // Opt-out via MT_AUTO_PROMOTE_REQUIRE_CI=false (mantém legacy: só média).
  const requireCi = !/^(0|false|no)$/i.test(String(process.env.MT_AUTO_PROMOTE_REQUIRE_CI ?? 'true'));
  const ciLowerThreshold = _envFloat('MT_AUTO_PROMOTE_CI_LOWER_THRESHOLD', 0);
  const revertDays = _envInt('MT_AUTO_PROMOTE_REVERT_DAYS', 14);
  // 2026-05-06: -5 → -3. Walk-forward tennis mostrou ROI walk-forward -4,8% sem
  // disparar revert. Tighter threshold reverte mais cedo quando edge não persiste.
  const revertRoi = _envFloat('MT_AUTO_PROMOTE_REVERT_ROI', -3);
  const leagueMinN = _envInt('MT_AUTO_PROMOTE_LEAGUE_MIN_N', 10);
  const leagueRoiCut = _envFloat('MT_AUTO_PROMOTE_LEAGUE_ROI', -10);
  const leagueRoiRestore = _envFloat('MT_AUTO_PROMOTE_LEAGUE_RESTORE', -3);
  // 2026-05-07 (P2 fix shadow=causa, real=sintoma): REVERT (real→shadow) e
  // LEAGUE_BLOCK/UNBLOCK são SINTOMA — decisões devem usar tips real.
  // PROMOTE (shadow→real) é pre-promote eval — explicitly allowed em P2,
  // continua usando shadow puro. Default true espelha pattern dos 5 violators
  // já consertados (runMarketTipsLeakGuard etc).
  // Opt-out: MT_AUTO_PROMOTE_REAL_ONLY=false (legacy).
  const realOnly = !/^(0|false|no)$/i.test(String(process.env.MT_AUTO_PROMOTE_REAL_ONLY ?? 'true'));

  const decisions = { promoted: [], reverted: [], league_blocked: [], league_unblocked: [], rejected_by_ci: [] };

  // ── Sport-level promote / revert ──
  try {
    // Promote check: shadow puro (pre-promote eval permitido P2).
    const sportRows = _statsBySport(db, days);
    // Revert check: real (sintoma — sport JÁ promovido). Sport sem volume real
    // → revertRows volta vazio → revert nunca dispara (intencional).
    const revertRows = realOnly
      ? _statsBySportReal(db, revertDays)
      : _statsBySport(db, revertDays);
    const revertBy = new Map(revertRows.map(r => [r.sport, r]));

    for (const r of sportRows) {
      const sport = String(r.sport || '').toLowerCase();
      if (!sport || !SPORTS.includes(sport)) continue;
      const settled = Number(r.settled) || 0;
      const roi = (r.stake_u > 0) ? (Number(r.profit_u) / Number(r.stake_u) * 100) : null;
      const clv = (r.clv_n > 0) ? (Number(r.avg_clv) || 0) : null;
      const promoted = _isCurrentlyPromoted(sport);
      // IC 95% do ROI per-tip (assume stake≈1u, válido pra MT shadow).
      const ci = _computeRoiCi(settled, Number(r.profit_u) || 0, Number(r.profit_sq) || 0);
      const ciPasses = !requireCi || (ci && ci.lower_pp > ciLowerThreshold);

      if (!promoted && settled >= minSettled && roi != null && roi >= minRoi && ciPasses) {
        _setMtPromoteEnv(db, sport, true);
        const ciStr = ci ? ` IC95%[${ci.lower_pp},${ci.upper_pp}]pp` : '';
        _logDecision(db, { sport, action: 'promote', reason: `auto: ROI ${roi.toFixed(1)}%${ciStr} n=${settled}`, n: settled, roi, clv });
        decisions.promoted.push({ sport, roi: +roi.toFixed(1), n: settled, clv: clv != null ? +clv.toFixed(1) : null, ci });
        log('INFO', 'MT-AUTO-PROMOTE', `${sport}: PROMOVIDO ROI=${roi.toFixed(1)}%${ciStr} n=${settled}`);
      } else if (!promoted && settled >= minSettled && roi != null && roi >= minRoi && !ciPasses) {
        // Critério de média OK mas IC inclui zero — ruído estatístico.
        const ciStr = ci ? ` IC95%[${ci.lower_pp},${ci.upper_pp}]pp` : ' IC=null';
        _logDecision(db, { sport, action: 'reject_ci', reason: `IC lower ≤ ${ciLowerThreshold}: mean ROI ${roi.toFixed(1)}%${ciStr}`, n: settled, roi });
        decisions.rejected_by_ci.push({ sport, roi: +roi.toFixed(1), n: settled, ci, reason: 'ic_lower_zero_or_negative' });
        log('INFO', 'MT-AUTO-PROMOTE', `${sport}: SKIP (IC inclui zero) ROI=${roi.toFixed(1)}%${ciStr} n=${settled}`);
      } else if (promoted) {
        const rv = revertBy.get(r.sport);
        const rvSettled = rv ? (Number(rv.settled) || 0) : 0;
        const rvRoi = (rv && rv.stake_u > 0) ? (Number(rv.profit_u) / Number(rv.stake_u) * 100) : null;
        if (rvSettled >= Math.min(minSettled, 20) && rvRoi != null && rvRoi <= revertRoi) {
          _setMtPromoteEnv(db, sport, false);
          _logDecision(db, { sport, action: 'revert', reason: `auto: ROI ${rvRoi.toFixed(1)}% n=${rvSettled} (${revertDays}d)`, n: rvSettled, roi: rvRoi });
          decisions.reverted.push({ sport, roi: +rvRoi.toFixed(1), n: rvSettled });
          log('WARN', 'MT-AUTO-PROMOTE', `${sport}: REVERTIDO ROI=${rvRoi.toFixed(1)}% n=${rvSettled} (${revertDays}d)`);
        }
      }
    }
  } catch (e) {
    log('WARN', 'MT-AUTO-PROMOTE', `sport-level err: ${e.message}`);
  }

  // ── League-level block / unblock per (sport, market, league) ──
  // Real path (default) — block decisions só agem em ligas com volume real.
  try {
    const leagueRows = realOnly
      ? _statsBySportLeagueReal(db, days)
      : _statsBySportLeague(db, days);
    const seenKeys = new Set();
    const upsertBlock = db.prepare(`
      INSERT INTO mt_market_league_blocklist (sport, market, league_norm, league_raw, source, reason, n, roi_pct, since)
      VALUES (?, ?, ?, ?, 'auto', ?, ?, ?, datetime('now'))
      ON CONFLICT(sport, market, league_norm) DO UPDATE SET
        reason = excluded.reason, n = excluded.n, roi_pct = excluded.roi_pct
    `);
    const deleteBlock = db.prepare(`DELETE FROM mt_market_league_blocklist WHERE sport=? AND market=? AND league_norm=?`);
    const existingBlocks = db.prepare(`SELECT sport, market, league_norm, league_raw FROM mt_market_league_blocklist WHERE source='auto'`).all();
    const existingMap = new Map(existingBlocks.map(b => [`${b.sport}|${b.market}|${b.league_norm}`, b]));

    for (const r of leagueRows) {
      const sport = String(r.sport || '').toLowerCase();
      const market = String(r.market || '').trim();
      const leagueRaw = String(r.league || '').trim();
      const leagueNorm = _normLeague(leagueRaw);
      if (!sport || !market || !leagueNorm) continue;
      const key = `${sport}|${market}|${leagueNorm}`;
      seenKeys.add(key);
      const settled = Number(r.settled) || 0;
      const roi = (r.stake_u > 0) ? (Number(r.profit_u) / Number(r.stake_u) * 100) : null;
      const isBlocked = existingMap.has(key);

      if (!isBlocked && settled >= leagueMinN && roi != null && roi <= leagueRoiCut) {
        const reason = `ROI ${roi.toFixed(1)}% n=${settled}`;
        upsertBlock.run(sport, market, leagueNorm, leagueRaw, reason, settled, +roi.toFixed(2));
        _leagueBlockCache.add(key);
        _logDecision(db, { sport, market, league: leagueRaw, action: 'league_block', reason: `auto: ${reason}`, n: settled, roi });
        decisions.league_blocked.push({ sport, market, league: leagueRaw, roi: +roi.toFixed(1), n: settled });
        log('WARN', 'MT-AUTO-PROMOTE', `${sport}/${market} ${leagueRaw}: BLOCKED ${reason}`);
      } else if (isBlocked && roi != null && settled >= leagueMinN && roi >= leagueRoiRestore) {
        deleteBlock.run(sport, market, leagueNorm);
        _leagueBlockCache.delete(key);
        const reason = `ROI ${roi.toFixed(1)}% n=${settled}`;
        _logDecision(db, { sport, market, league: leagueRaw, action: 'league_unblock', reason: `auto restore: ${reason}`, n: settled, roi });
        decisions.league_unblocked.push({ sport, market, league: leagueRaw, roi: +roi.toFixed(1), n: settled });
        log('INFO', 'MT-AUTO-PROMOTE', `${sport}/${market} ${leagueRaw}: UNBLOCKED ${reason}`);
      }
    }
  } catch (e) {
    log('WARN', 'MT-AUTO-PROMOTE', `league-level err: ${e.message}`);
  }

  // Refresh in-memory cache from DB (covers manual edits + race conditions).
  loadMtMarketLeagueBlocklist(db);

  const total = decisions.promoted.length + decisions.reverted.length
              + decisions.league_blocked.length + decisions.league_unblocked.length;
  if (total) {
    log('INFO', 'MT-AUTO-PROMOTE', `Ciclo: promoted=${decisions.promoted.length} reverted=${decisions.reverted.length} league_blocked=${decisions.league_blocked.length} league_unblocked=${decisions.league_unblocked.length}`);
  }
  return { ok: true, decisions, totals: { ...Object.fromEntries(Object.entries(decisions).map(([k, v]) => [k, v.length])) } };
}

module.exports = {
  runMtAutoPromoteCycle,
  isMtLeagueBlockedForMarket,
  loadMtMarketLeagueBlocklist,
};

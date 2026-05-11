'use strict';

/**
 * mt-preflight.js — Pre-flight check ANTES de promover MT pra real.
 *
 * Cruza TODOS os disables ativos (PERMANENT env + RUNTIME state +
 * LEAGUE_BLOCKLIST) contra shadow recente no MESMO scope. Sinaliza:
 *   - stale_contradicted: sample recente n>=min_recent com ROI>0 ou direção oposta
 *   - still_leak: sample recente confirma ROI<0
 *   - insufficient_recent: sample recente n<min_recent (manter por precaução)
 *
 * P2-compliant: SÓ recomenda — recommended_action é decisão humana, jamais
 * auto-execute. Resolve antipattern "auto-disable write-once never-revalidated"
 * que escondia tier1 winners atrás de blocks com sample velho/pequeno.
 *
 * Usado por:
 *   - server.js endpoint GET /admin/mt-promote-preflight (interactive)
 *   - bot.js cron runMtPreflightCron (daily DM se achar stales)
 */

function _queryShadowScope(db, sport, days, market, side, league) {
  const conds = [
    'sport = ?',
    `created_at >= datetime('now', '-' || ? || ' days')`,
    `result IN ('win','loss','void')`,
  ];
  const args = [sport, days];
  if (market) { conds.push('LOWER(market) = LOWER(?)'); args.push(market); }
  if (side) { conds.push('LOWER(side) = LOWER(?)'); args.push(side); }
  if (league) { conds.push("LOWER(COALESCE(league,'')) LIKE ?"); args.push('%' + String(league).toLowerCase() + '%'); }
  try {
    const r = db.prepare(`
      SELECT
        COUNT(*) AS n,
        SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN result='void' THEN 1 ELSE 0 END) AS voids,
        ROUND(SUM(profit_units)*1.0/NULLIF(SUM(stake_units),0)*100,2) AS roi_pct,
        ROUND(AVG(clv_pct),2) AS avg_clv_pct,
        ROUND(AVG(ev_pct),1) AS avg_ev_pct
      FROM market_tips_shadow
      WHERE ${conds.join(' AND ')}
    `).get(...args);
    return r || { n: 0 };
  } catch (e) { return { n: 0, error: e.message }; }
}

function _computeVerdict(original, recent, minRecent) {
  if (!recent || recent.n < minRecent) return 'insufficient_recent';
  const recRoi = recent.roi_pct;
  if (recRoi == null) return 'insufficient_recent';
  if (!original || original.roi_pct == null) {
    return recRoi > 0 ? 'stale_contradicted' : 'still_leak';
  }
  const origRoi = original.roi_pct;
  if (origRoi < 0 && recRoi > 0) return 'stale_contradicted';
  if (origRoi < 0 && recRoi <= 0) return 'still_leak';
  if (origRoi >= 0 && recRoi > 0) return 'stale_contradicted';
  return 'still_leak';
}

function _ageDays(ts) {
  if (!ts) return null;
  try { return Math.round((Date.now() - new Date(ts).getTime()) / 86400000); }
  catch (_) { return null; }
}

/**
 * Run preflight for one sport.
 * @returns { ok, sport, ts, window_days, min_recent_n, summary, blockers[],
 *            ready_to_promote, ready_after_recommended_actions, next_steps }
 */
function runPreflightForSport(db, sport, opts = {}) {
  const sportLower = String(sport || '').toLowerCase().trim();
  if (!sportLower) return { ok: false, error: 'missing sport' };
  const days = Math.max(7, Math.min(60, parseInt(opts.days || '14', 10) || 14));
  const minRecent = Math.max(5, Math.min(50, parseInt(opts.minRecent || '15', 10) || 15));

  const blockers = [];

  // 1) PERMANENT (env MT_PERMANENT_DISABLE_LIST)
  const permRaw = String(process.env.MT_PERMANENT_DISABLE_LIST ?? 'tennis|totalGames|over,lol|total').trim();
  const permEntries = permRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const entry of permEntries) {
    const parts = entry.split('|');
    if (parts.length < 2 || parts[0] !== sportLower) continue;
    const market = parts[1], side = parts[2] || null;
    const recent = _queryShadowScope(db, sportLower, days, market, side, null);
    const verdict = _computeVerdict(null, recent, minRecent);
    const scopeLabel = side ? `${sportLower}|${market}|${side}` : `${sportLower}|${market}`;
    blockers.push({
      scope: scopeLabel,
      type: 'PERMANENT',
      source: 'MT_PERMANENT_DISABLE_LIST env',
      original_sample: null,
      recent_shadow: recent,
      verdict,
      recommended_action: verdict === 'stale_contradicted'
        ? `Edit Railway env: remove "${entry}" from MT_PERMANENT_DISABLE_LIST`
        : 'keep',
      rationale: verdict === 'stale_contradicted'
        ? `recent ${days}d shadow n=${recent.n} ROI=${recent.roi_pct}% — block contradicted`
        : verdict === 'insufficient_recent'
          ? `recent shadow n=${recent.n} < min ${minRecent} — keep by precaution`
          : `recent ROI=${recent.roi_pct}% confirms leak`,
    });
  }

  // 2) RUNTIME (market_tips_runtime_state)
  let runtimeRows = [];
  try {
    runtimeRows = db.prepare(`
      SELECT sport, market, side, league, source, reason, roi_pct, clv_pct, clv_n, updated_at
      FROM market_tips_runtime_state
      WHERE disabled = 1 AND sport = ?
    `).all(sportLower);
  } catch (_) {
    try {
      runtimeRows = db.prepare(`
        SELECT sport, market, side, source, reason, roi_pct, clv_pct, clv_n, updated_at
        FROM market_tips_runtime_state
        WHERE disabled = 1 AND sport = ?
      `).all(sportLower);
    } catch (__) { runtimeRows = []; }
  }
  for (const row of runtimeRows) {
    const recent = _queryShadowScope(db, sportLower, days, row.market, row.side, row.league);
    const original = {
      roi_pct: row.roi_pct,
      clv_pct: row.clv_pct,
      n: row.clv_n,
      ts: row.updated_at,
      reason: row.reason,
      source: row.source,
      age_days: _ageDays(row.updated_at),
    };
    const verdict = _computeVerdict(original, recent, minRecent);
    const scopeParts = [sportLower, row.market, row.side, row.league].filter(Boolean);
    const scopeLabel = scopeParts.join('|');
    blockers.push({
      scope: scopeLabel,
      type: 'RUNTIME',
      source: row.source,
      original_sample: original,
      recent_shadow: recent,
      verdict,
      recommended_action: verdict === 'stale_contradicted'
        ? `POST /admin/mt-restore?sport=${sportLower}&market=${encodeURIComponent(row.market)}${row.side ? '&side=' + encodeURIComponent(row.side) : ''}&force=1`
        : 'keep',
      rationale: verdict === 'stale_contradicted'
        ? `original ${original.ts ? String(original.ts).slice(0, 10) : '?'} (${original.age_days}d ago) n=${original.n} ROI=${original.roi_pct}% vs recent n=${recent.n} ROI=${recent.roi_pct}% — direction reversed`
        : verdict === 'insufficient_recent'
          ? `recent shadow n=${recent.n} < min ${minRecent} — keep`
          : `recent ROI=${recent.roi_pct}% confirms leak`,
    });
  }

  // 3) LEAGUE_BLOCKLIST (mt_market_league_blocklist)
  let leagueRows = [];
  try {
    leagueRows = db.prepare(`
      SELECT sport, market, league_norm, league_raw, source, reason, since, n, roi_pct
      FROM mt_market_league_blocklist
      WHERE sport = ?
    `).all(sportLower);
  } catch (_) { leagueRows = []; }
  for (const row of leagueRows) {
    const recent = _queryShadowScope(db, sportLower, days, row.market, null, row.league_raw);
    const original = {
      roi_pct: row.roi_pct,
      n: row.n,
      ts: row.since,
      reason: row.reason,
      source: row.source,
      age_days: _ageDays(row.since),
    };
    const verdict = _computeVerdict(original, recent, minRecent);
    const scopeLabel = `${sportLower}|${row.market}|${row.league_raw}`;
    blockers.push({
      scope: scopeLabel,
      type: 'LEAGUE_BLOCKLIST',
      source: row.source,
      original_sample: original,
      recent_shadow: recent,
      verdict,
      recommended_action: verdict === 'stale_contradicted'
        ? `POST /admin/mt-unblock-league?sport=${sportLower}&market=${encodeURIComponent(row.market)}&league=${encodeURIComponent(row.league_raw)}`
        : 'keep',
      rationale: verdict === 'stale_contradicted'
        ? `original (${original.age_days}d ago) n=${original.n} ROI=${original.roi_pct}% vs recent n=${recent.n} ROI=${recent.roi_pct}% — contradicted`
        : verdict === 'insufficient_recent'
          ? `recent shadow n=${recent.n} < min ${minRecent} — keep`
          : `recent ROI=${recent.roi_pct}% confirms leak`,
    });
  }

  const stale = blockers.filter(b => b.verdict === 'stale_contradicted').length;
  const stillLeak = blockers.filter(b => b.verdict === 'still_leak').length;
  const insufficient = blockers.filter(b => b.verdict === 'insufficient_recent').length;

  return {
    ok: true,
    sport: sportLower,
    ts: new Date().toISOString(),
    window_days: days,
    min_recent_n: minRecent,
    disclaimer: 'preflight cruza disables ativos × shadow recente. recommended_action é decisão humana — NÃO auto-execute. P2-compliant.',
    summary: {
      total_blockers: blockers.length,
      stale_contradicted: stale,
      still_leak: stillLeak,
      insufficient_recent: insufficient,
    },
    blockers,
    ready_to_promote: blockers.length === 0,
    ready_after_recommended_actions: stale > 0 && stillLeak === 0,
    next_steps: stale > 0
      ? `${stale} stale block(s) detected. Execute recommended_action de cada e re-rode preflight.`
      : (blockers.length === 0
        ? 'no blockers found — promote pode prosseguir após verificar shadow performance via /shadow-readiness'
        : 'all blockers ainda válidos ou sem evidência recente — manter shadow-only por agora'),
  };
}

const DEFAULT_SPORTS = ['lol', 'cs', 'dota2', 'valorant', 'tennis', 'football', 'basket', 'mma', 'darts', 'snooker', 'tt'];

/**
 * Run preflight pra todos sports + agrega stales.
 * @returns { ok, ts, window_days, min_recent_n, sports: { sport: result },
 *            total_stales, sports_with_stales, all_stales: [...] }
 */
function runPreflightAllSports(db, opts = {}) {
  const sports = Array.isArray(opts.sports) && opts.sports.length ? opts.sports : DEFAULT_SPORTS;
  const days = opts.days || 14;
  const minRecent = opts.minRecent || 15;
  const out = {
    ok: true,
    ts: new Date().toISOString(),
    window_days: days,
    min_recent_n: minRecent,
    sports: {},
    total_stales: 0,
    sports_with_stales: [],
    all_stales: [],
  };
  for (const sport of sports) {
    const r = runPreflightForSport(db, sport, { days, minRecent });
    out.sports[sport] = r;
    const staleBlockers = (r.blockers || []).filter(b => b.verdict === 'stale_contradicted');
    if (staleBlockers.length) {
      out.sports_with_stales.push(sport);
      out.total_stales += staleBlockers.length;
      for (const b of staleBlockers) {
        out.all_stales.push({ sport, ...b });
      }
    }
  }
  return out;
}

module.exports = {
  runPreflightForSport,
  runPreflightAllSports,
  DEFAULT_SPORTS,
};

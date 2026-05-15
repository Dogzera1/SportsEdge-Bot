'use strict';

/**
 * mt-promote-explain.js — diagnóstico de gates MT promote.
 *
 * Simula todos os gates aplicáveis a uma tip hipotética e retorna pass/fail
 * por gate, com env fix sugerido pra cada falha. Usado pra:
 *   1. Endpoint /admin/mt-promote-explain (debug ad-hoc de tip shadow específica)
 *   2. Cron diário (agrega blockers em tips shadow das últimas 24h)
 *
 * Sem side-effects: lê env, DB (read-only), retorna análise.
 *
 * Gates simulados (ordem de execução em recordMarketTipAsRegular + scanners):
 *   1. MT_MIN_ODD                                  (env)
 *   2. <SPORT>_MARKET_TIP_MIN_EV                   (env, default 8)
 *   3. <SPORT>_MARKET_TIP_MIN_PMODEL               (env, default 0.55)
 *   4. perMarketEvGate (LOL_MT_TT_MIN_EV etc)      (env)
 *   5. <SPORT>_MARKET_TIPS_ENABLED                 (env, must be true)
 *   6. MT_PERMANENT_DISABLE_LIST                   (env, default inclui leaks)
 *   7. runtime disable (market_tips_runtime_state) (DB)
 *   8. league_block (mt_market_league_blocklist)   (DB)
 *   9. MT_EV_CAP (getEvMaxCap per-sport)           (env + default)
 *  10. MAX_TIPS_PER_TOURNAMENT_PER_DAY             (env, default 8) — exige league + count DB
 *  11. DAILY_TIP_LIMIT_<SPORT>                     (env, default null)
 *
 * Gates NÃO simulados (dependem fetch externo, marca como skipped):
 *  - CLV_PREDISPATCH_GATE (velocity tracker in-memory ring buf)
 *  - drawdown (precisa fetch /bankroll — caller pode passar drawdown_pct)
 *  - /stake-multiplier (serverGet)
 *  - LEAGUE_TRUST stake floor (depende de stake passado)
 *  - applyGlobalRisk full chain
 */

function _envBool(name, def = false) {
  const v = String(process.env[name] ?? '').toLowerCase().trim();
  if (!v) return def;
  return /^(1|true|yes|on)$/.test(v);
}

function _envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

function _envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

function _normSport(sport) {
  return String(sport || '').toLowerCase().trim();
}

function _normLeague(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function _sportUp(sport) {
  return String(sport || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Espelha _MT_MARKET_TYPE_MAP em bot.js — mapping market scanner → market_type DB
const MARKET_SHORT_KEY = {
  HANDICAP: 'HC',
  HANDICAPSETS: 'HS',
  HANDICAPGAMES: 'HG',
  TOTAL: 'TT',
  TOTALGAMES: 'TG',
  TOTALACES: 'TA',
};

function _perMarketEvGate(sport, market, defaultEv) {
  const sp = _sportUp(sport);
  const mk = String(market || '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  const shortKey = MARKET_SHORT_KEY[mk] || (/^TOTAL_KILLS_MAP\d+$/.test(mk) ? 'TK' : null);
  const candidates = [
    shortKey ? `${sp}_MT_${shortKey}_MIN_EV` : null,
    `${sp}_MT_${mk}_MIN_EV`,
  ].filter(Boolean);
  for (const k of candidates) {
    const v = parseFloat(process.env[k]);
    if (Number.isFinite(v) && v >= 0) return { value: v, env_key: k };
  }
  return { value: defaultEv, env_key: null };
}

// DB-driven via mig 108 (env fallback union-ed em loadSet).
const _mtPermDisable = require('./mt-permanent-disable');
function _getPermanentDisableSet(db) {
  return _mtPermDisable.loadSet(db);
}

// Espelha _isCurrentlyPromoted + isMarketTipsPromoteEnabled
function _isSportPromoteEnabled(sport) {
  const up = _sportUp(sport);
  const alias = { DOTA2: 'DOTA', CS2: 'CS' }[up];
  const envOk = process.env[`${up}_MARKET_TIPS_ENABLED`] === 'true'
    || (alias && process.env[`${alias}_MARKET_TIPS_ENABLED`] === 'true');
  return { enabled: !!envOk, env_keys: [`${up}_MARKET_TIPS_ENABLED`].concat(alias ? [`${alias}_MARKET_TIPS_ENABLED`] : []) };
}

function _checkRuntimeDisable(db, sport, market, side, league) {
  try {
    const rows = db.prepare(`
      SELECT sport, market, side, league, tier, source, reason
      FROM market_tips_runtime_state
      WHERE disabled = 1 AND sport = ? AND market = ?
    `).all(_normSport(sport), String(market || '').toLowerCase());
    for (const r of rows) {
      const matchSide = !r.side || (side && String(r.side).toLowerCase() === String(side).toLowerCase());
      const matchLeague = !r.league || (league && _normLeague(r.league) === _normLeague(league));
      if (matchSide && matchLeague) {
        return { blocked: true, entry: r };
      }
    }
    return { blocked: false };
  } catch (e) {
    return { blocked: false, error: e.message };
  }
}

function _checkLeagueBlock(db, sport, market, league) {
  if (!sport || !market || !league) return { blocked: false };
  try {
    const row = db.prepare(`
      SELECT league_raw, since, source, reason
      FROM mt_market_league_blocklist
      WHERE sport = ? AND market = ? AND league_norm = ?
    `).get(_normSport(sport), String(market || '').toLowerCase(), _normLeague(league));
    return row ? { blocked: true, entry: row } : { blocked: false };
  } catch (e) {
    return { blocked: false, error: e.message };
  }
}

// EV cap per-sport (espelha mt-tier-classifier.getEvMaxCap)
const EV_MAX_DEFAULTS = {
  tennis: 25, lol: 20, cs2: 20, cs: 20, football: 20, dota2: 20,
  valorant: 20, basket: 25, mma: 30, darts: 30, snooker: 30,
};

function _getEvMaxCap(sport) {
  const sp = _normSport(sport);
  const up = sp.toUpperCase();
  if (_envBool(`${up}_MT_EV_MAX_DISABLED`)) return { value: Infinity, source: `${up}_MT_EV_MAX_DISABLED=true` };
  const env = parseFloat(process.env[`${up}_MT_EV_MAX`]);
  if (Number.isFinite(env) && env > 0) return { value: env, source: `${up}_MT_EV_MAX=${env}` };
  return { value: EV_MAX_DEFAULTS[sp] ?? 30, source: 'default' };
}

function _checkExposureCap(db, sport, league) {
  const cap = _envInt('MAX_TIPS_PER_TOURNAMENT_PER_DAY', 8);
  if (cap <= 0 || !league) return { pass: true, cap, detail: 'cap=0 ou sem league' };
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM tips
      WHERE sport = ? AND event_name = ?
        AND COALESCE(is_shadow, 0) = 0
        AND COALESCE(archived, 0) = 0
        AND date(sent_at) = date('now')
    `).get(_normSport(sport), league);
    const n = r?.n || 0;
    return { pass: n < cap, cap, count: n, detail: `${n}/${cap} tips hoje` };
  } catch (e) {
    return { pass: true, cap, error: e.message };
  }
}

function _checkDailyTipLimit(db, sport) {
  const up = _sportUp(sport);
  const sportLimit = parseInt(process.env[`DAILY_TIP_LIMIT_${up}`] || '', 10);
  const globalLimit = parseInt(process.env.DAILY_TIP_LIMIT || '', 10);
  const limit = Number.isFinite(sportLimit) && sportLimit > 0 ? sportLimit
    : Number.isFinite(globalLimit) && globalLimit > 0 ? globalLimit : null;
  if (limit == null) return { pass: true, limit: null, detail: 'sem limite configurado' };
  try {
    const tzH = parseFloat(process.env.DAILY_TZ_OFFSET_H ?? '-3');
    const offsetMod = `${tzH >= 0 ? '+' : '-'}${Math.abs(tzH)} hours`;
    const reverseMod = `${tzH >= 0 ? '-' : '+'}${Math.abs(tzH)} hours`;
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM tips
      WHERE sport = ?
        AND sent_at >= datetime(datetime('now', ?), 'start of day', ?)
        AND (archived IS NULL OR archived = 0)
        AND COALESCE(is_shadow, 0) = 0
    `).get(_normSport(sport), offsetMod, reverseMod);
    const n = r?.n || 0;
    return { pass: n < limit, limit, count: n, detail: `${n}/${limit} tips hoje` };
  } catch (e) {
    return { pass: true, limit, error: e.message };
  }
}

/**
 * Roda todos gates simulados pra uma tip hipotética. Retorna análise estruturada.
 *
 * @param {Object} args
 * @param {Object} args.db - better-sqlite3 db handle
 * @param {string} args.sport - 'lol', 'tennis', etc
 * @param {string} args.market - 'total', 'handicapGames', etc (lowercase scanner format)
 * @param {string} args.side - 'over', 'under', 'home', 'away', 'team1', 'team2'
 * @param {number} args.odd - decimal odd
 * @param {number} args.ev - EV percentual (24.9 = +24.9%)
 * @param {number} args.pmodel - probabilidade modelo (0.77 = 77%)
 * @param {string} [args.league] - opcional, exato como aparece no DB
 * @param {string} [args.team1], [args.team2] - opcional, pra log
 * @param {number} [args.line] - opcional, line MT
 * @returns {Object} { ok, would_promote, first_blocker, all_blockers, gates[] }
 */
function explainMtPromoteGates(args = {}) {
  const { db, sport, market, side, odd, ev, pmodel, league, team1, team2, line } = args;
  if (!sport || !market || !side) {
    return { ok: false, error: 'sport, market, side obrigatórios' };
  }
  const sp = _normSport(sport);
  const up = _sportUp(sp);
  const gates = [];

  // 1. MT_MIN_ODD
  const minOdd = _envFloat('MT_MIN_ODD', 1.4);
  gates.push({
    name: 'MT_MIN_ODD',
    pass: Number.isFinite(odd) && odd >= minOdd,
    detail: `odd ${odd} >= ${minOdd}`,
    env_fix: Number.isFinite(odd) && odd < minOdd ? `MT_MIN_ODD=${odd}` : null,
  });

  // 2. <SPORT>_MARKET_TIP_MIN_EV (default 8)
  const minEvKey = `${up}_MARKET_TIP_MIN_EV`;
  const minEv = _envFloat(minEvKey, 8);
  gates.push({
    name: minEvKey,
    pass: Number.isFinite(ev) && ev >= minEv,
    detail: `EV ${ev}% >= ${minEv}%`,
    env_fix: Number.isFinite(ev) && ev < minEv ? `${minEvKey}=${Math.floor(ev)}` : null,
  });

  // 3. <SPORT>_MARKET_TIP_MIN_PMODEL (default 0.55)
  const minPmKey = `${up}_MARKET_TIP_MIN_PMODEL`;
  const minPm = _envFloat(minPmKey, 0.55);
  gates.push({
    name: minPmKey,
    pass: Number.isFinite(pmodel) && pmodel >= minPm,
    detail: `pModel ${pmodel} >= ${minPm}`,
    env_fix: Number.isFinite(pmodel) && pmodel < minPm ? `${minPmKey}=${pmodel.toFixed(2)}` : null,
  });

  // 4. perMarketEvGate
  const pme = _perMarketEvGate(sp, market, minEv);
  if (pme.env_key) {
    gates.push({
      name: pme.env_key,
      pass: Number.isFinite(ev) && ev >= pme.value,
      detail: `EV ${ev}% >= ${pme.value}% (per-market override)`,
      env_fix: ev < pme.value ? `${pme.env_key}=${Math.floor(ev)}` : null,
    });
  }

  // 5. <SPORT>_MARKET_TIPS_ENABLED (env)
  const sportPromote = _isSportPromoteEnabled(sp);
  gates.push({
    name: 'SPORT_MARKET_TIPS_ENABLED',
    pass: sportPromote.enabled,
    detail: sportPromote.enabled ? `${sportPromote.env_keys[0]}=true` : `${sportPromote.env_keys.join(' OR ')} != true`,
    env_fix: sportPromote.enabled ? null : `${sportPromote.env_keys[0]}=true`,
  });

  // 6. MT permanent disable (DB-driven via mig 108 + env fallback)
  const permSet = _getPermanentDisableSet(db);
  const permKeys = [
    `${sp}|${String(market).toLowerCase()}|${String(side).toLowerCase()}`,
    `${sp}|${String(market).toLowerCase()}`,
  ];
  const permHit = permKeys.find(k => permSet.has(k));
  gates.push({
    name: 'MT_PERMANENT_DISABLE_LIST',
    pass: !permHit,
    detail: permHit ? `hit "${permHit}"` : `nenhum match (probed ${permKeys.join(', ')})`,
    env_fix: permHit ? `remove "${permHit}" do MT_PERMANENT_DISABLE_LIST` : null,
  });

  // 7. runtime disable (DB)
  if (db) {
    const rtd = _checkRuntimeDisable(db, sp, market, side, league);
    gates.push({
      name: 'MT_RUNTIME_DISABLE',
      pass: !rtd.blocked,
      detail: rtd.blocked
        ? `entry: sport=${rtd.entry.sport} mkt=${rtd.entry.market} side=${rtd.entry.side || '-'} league=${rtd.entry.league || '-'} reason="${rtd.entry.reason}"`
        : 'sem entry runtime',
      env_fix: rtd.blocked ? `DELETE FROM market_tips_runtime_state WHERE sport='${sp}' AND market='${market}' AND source='${rtd.entry.source}'` : null,
    });
  }

  // 8. league_block (DB)
  if (db && league) {
    const lb = _checkLeagueBlock(db, sp, market, league);
    gates.push({
      name: 'MT_LEAGUE_BLOCK',
      pass: !lb.blocked,
      detail: lb.blocked
        ? `${sp}|${market}|${_normLeague(league)} bloqueada desde ${lb.entry.since} (${lb.entry.source}): ${lb.entry.reason}`
        : `league "${league}" não está em mt_market_league_blocklist`,
      env_fix: lb.blocked ? `DELETE FROM mt_market_league_blocklist WHERE sport='${sp}' AND market='${market}' AND league_norm='${_normLeague(league)}'` : null,
    });
  }

  // 9. MT_EV_CAP
  const evCap = _getEvMaxCap(sp);
  gates.push({
    name: 'MT_EV_CAP',
    pass: !Number.isFinite(ev) || ev <= evCap.value,
    detail: `EV ${ev}% <= ${evCap.value}% (source: ${evCap.source})`,
    env_fix: Number.isFinite(ev) && ev > evCap.value ? `${up}_MT_EV_MAX=${Math.ceil(ev)}` : null,
  });

  // 10. exposure cap (DB)
  if (db && league) {
    const exp = _checkExposureCap(db, sp, league);
    gates.push({
      name: 'MAX_TIPS_PER_TOURNAMENT_PER_DAY',
      pass: exp.pass,
      detail: exp.detail,
      env_fix: !exp.pass ? `MAX_TIPS_PER_TOURNAMENT_PER_DAY=${exp.count + 1}` : null,
    });
  }

  // 11. DAILY_TIP_LIMIT (DB)
  if (db) {
    const dt = _checkDailyTipLimit(db, sp);
    gates.push({
      name: 'DAILY_TIP_LIMIT',
      pass: dt.pass,
      detail: dt.detail,
      env_fix: !dt.pass ? `DAILY_TIP_LIMIT_${up}=${dt.count + 1}` : null,
    });
  }

  const blockers = gates.filter(g => !g.pass);
  return {
    ok: true,
    params: { sport: sp, market, side, odd, ev, pmodel, league, team1, team2, line },
    would_promote: blockers.length === 0,
    first_blocker: blockers[0]?.name || null,
    all_blockers: blockers.map(g => g.name),
    gates,
    notes: [
      'Gates simulados são determinísticos (env + DB). Gates runtime-dependent (CLV velocity, drawdown, /stake-multiplier, league_trust stake floor) NÃO são checados.',
      'Se all_blockers=[] aqui, a tip AINDA pode cair em shadow por gate runtime (ex: drawdown taper, daily stop-loss).',
    ],
  };
}

/**
 * Cron diário: agrega blockers em tips shadow das últimas 24h e DM admin com
 * top-N gates que estão bloqueando tips promotables (ev >= min_ev + pmodel >= min_pm).
 * Útil pra detectar gates com tuning errado (e.g. MT_EV_CAP bloqueando demais).
 *
 * @param {Object} db - sqlite handle
 * @param {Object} opts
 * @param {number} [opts.hoursBack=24] - janela
 * @param {number} [opts.maxTips=500] - cap pra não rodar gate analysis em volume enorme
 * @param {Function} [opts.dmFn] - função opcional pra DM admin com summary
 * @returns {Object} { examined, blockers_by_count, single_blocker_tips }
 */
async function runMtPromoteExplainDigest(db, opts = {}) {
  const hoursBack = opts.hoursBack || 24;
  const maxTips = opts.maxTips || 500;
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, sport, market, side, league, team1, team2, odd, ev_pct, p_model, line, created_at
      FROM market_tips_shadow
      WHERE created_at >= datetime('now', '-' || ? || ' hours')
        AND ev_pct >= 8
        AND p_model >= 0.55
      ORDER BY created_at DESC
      LIMIT ?
    `).all(hoursBack, maxTips);
  } catch (e) {
    return { ok: false, error: `query market_tips_shadow: ${e.message}` };
  }

  const examined = rows.length;
  const blockerCounts = new Map(); // blocker → { count, ev_total, sports_set }
  const singleBlockerTips = []; // tips bloqueadas por exatamente 1 gate (low-hanging fruit)

  for (const r of rows) {
    const analysis = explainMtPromoteGates({
      db,
      sport: r.sport,
      market: r.market,
      side: r.side,
      odd: r.odd,
      ev: r.ev_pct,
      pmodel: r.p_model,
      league: r.league,
      team1: r.team1,
      team2: r.team2,
      line: r.line,
    });
    if (!analysis.ok || analysis.would_promote) continue;
    for (const b of analysis.all_blockers) {
      const cur = blockerCounts.get(b) || { count: 0, sports: new Set(), example_tip: null };
      cur.count++;
      cur.sports.add(r.sport);
      if (!cur.example_tip) {
        cur.example_tip = {
          id: r.id, sport: r.sport, team1: r.team1, team2: r.team2,
          market: r.market, side: r.side, ev: r.ev_pct, pmodel: r.p_model,
          league: r.league, gates_failed: analysis.all_blockers,
        };
      }
      blockerCounts.set(b, cur);
    }
    if (analysis.all_blockers.length === 1) {
      singleBlockerTips.push({
        id: r.id, sport: r.sport, team1: r.team1, team2: r.team2,
        market: r.market, side: r.side, ev: r.ev_pct, pmodel: r.p_model,
        league: r.league, blocker: analysis.all_blockers[0],
        env_fix: analysis.gates.find(g => !g.pass)?.env_fix,
      });
    }
  }

  const blockerSummary = Array.from(blockerCounts.entries())
    .map(([name, info]) => ({
      blocker: name,
      count: info.count,
      sports: Array.from(info.sports),
      example: info.example_tip,
    }))
    .sort((a, b) => b.count - a.count);

  const result = {
    ok: true,
    // 2026-05-15 audit P2: disclaimer P2-compliance. Output deste módulo é
    // research-only (lista blockers + low-hanging-fruit pra humano avaliar) —
    // NÃO auto-execute mudanças de gate. Espelha padrão mt-preflight.js.
    disclaimer: 'P2-compliant: research-only recommendation. NÃO auto-execute gate changes. Use /admin/mt-disable, /admin/mt-promote etc após review humana.',
    window_hours: hoursBack,
    examined,
    blockers_by_count: blockerSummary,
    single_blocker_count: singleBlockerTips.length,
    single_blocker_tips: singleBlockerTips.slice(0, 20),
    ts: new Date().toISOString(),
  };

  if (typeof opts.dmFn === 'function' && examined > 0) {
    const topN = blockerSummary.slice(0, 5);
    if (topN.length) {
      let txt = `📊 *MT Promote Explain — últimas ${hoursBack}h*\n\n`;
      txt += `Tips shadow analisadas: ${examined}\n`;
      txt += `Tips com blocker único: ${singleBlockerTips.length}\n\n`;
      txt += `*Top blockers:*\n`;
      for (const b of topN) {
        txt += `• \`${b.blocker}\` — ${b.count} tips (${b.sports.join('/')})\n`;
      }
      if (singleBlockerTips.length > 0) {
        txt += `\n*Low-hanging fruit (1 gate só):*\n`;
        for (const t of singleBlockerTips.slice(0, 3)) {
          txt += `• ${t.sport} ${t.team1} vs ${t.team2}: ${t.market}/${t.side} EV=${t.ev}% — blocker: \`${t.blocker}\`${t.env_fix ? `\n  fix: \`${t.env_fix}\`` : ''}\n`;
        }
      }
      try { await opts.dmFn(txt); } catch (_) { /* DM opcional */ }
    }
  }

  return result;
}

module.exports = {
  explainMtPromoteGates,
  runMtPromoteExplainDigest,
  EV_MAX_DEFAULTS,
};

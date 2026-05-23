/**
 * match-id-resolver.js — resolve aggregator-BR-style match_id ('agg_<slug>')
 * para canonical_match_id em match_results table.
 *
 * Motivação: tips emitidas pelo aggregator BR usam slug-format
 * (agg_coritiba-vs-bahia-ba-20260525::mt::t) mas match_results contém IDs
 * de sources (espn_, sofa_, api_, csv_, dataset_, ps_). Settle path consulta
 * WHERE match_id = ? AND game = ? — nunca bate, tip fica stuck.
 *
 * Estratégia:
 *   1. Pass-through: se match_id não tem prefixo 'agg_', retorna unchanged
 *   2. Cache hit: lookup direto em match_id_aliases table
 *   3. Parse slug: extrai team1, team2, data
 *   4. Fuzzy match: query match_results dentro de janela ±2 dias,
 *      ranqueia por score Jaccard normalizado bidirecional
 *   5. Persist: insere alias quando score >= threshold (default 0.80)
 *
 * Safety:
 *   - Threshold alto (0.80) — env override MATCH_ID_ALIAS_MIN_SCORE
 *   - Date window ±2d — env override MATCH_ID_ALIAS_DATE_WINDOW
 *   - INSERT OR IGNORE — first match wins, manual override possível via SQL
 *   - resolved_by + confidence persistidos pra auditoria via /admin/alias-audit
 *
 * Aplicado em settle paths (server.js single match_id lookup).
 * Backward compat: matchId sem 'agg_' prefix passa unchanged.
 */
'use strict';

const { log } = require('./utils');

const MIN_SCORE = (() => {
  const v = parseFloat(process.env.MATCH_ID_ALIAS_MIN_SCORE);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.80;
})();

// 2026-05-23 (P1-8 audit): default 2→4d. resolved_at em match_results é
// INGEST time (datetime('now') no upsert), NÃO match date. CSV backfills,
// Sofascore daily sync, manual upserts podem ingest hours/days após kickoff.
// ±2d window perde matches reais quando ingest desfasado. ±4d cobre 95% dos
// casos. Env MATCH_ID_ALIAS_DATE_WINDOW override permanece (max 7d).
const DATE_WINDOW_DAYS = (() => {
  const v = parseInt(process.env.MATCH_ID_ALIAS_DATE_WINDOW || '4', 10);
  return Number.isFinite(v) && v >= 0 && v <= 7 ? v : 4;
})();

function _norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Filter length >= 3: drop suffix codes BR (sp, rj, ba, mg, pr, rs, sc) e
// abreviações de clubes (fc, ac, ec, sc, cf, ca, ud) que poluem Jaccard
// quando aparecem só num lado. Exemplo: 'sao paulo sp' vs 'sao paulo fc'
// scoraria 0.5 com >=2 (sp/fc diferentes), 1.0 com >=3 (ambos dropped).
function _tokens(s) {
  return new Set(_norm(s).split(/\s+/).filter(t => t.length >= 3));
}

function _jaccard(a, b) {
  const A = _tokens(a), B = _tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Score bidirecional (max de t1×t1 + t2×t2 vs t1×t2 + t2×t1).
 * Cobre ordem invertida home/away.
 */
function _scorePair(aT1, aT2, bT1, bT2) {
  const direct = (_jaccard(aT1, bT1) + _jaccard(aT2, bT2)) / 2;
  const swapped = (_jaccard(aT1, bT2) + _jaccard(aT2, bT1)) / 2;
  return Math.max(direct, swapped);
}

/**
 * Parse 'agg_coritiba-vs-bahia-ba-20260525::mt::t' → { t1, t2, date }
 * Formato aggregator: agg_<slug1>-vs-<slug2>-<YYYYMMDD>[::<extras>]
 */
function parseAggSlug(matchId) {
  const s = String(matchId || '');
  if (!s.startsWith('agg_')) return null;
  // Strip trailing ::extras
  const core = s.slice(4).split('::')[0];
  // Extract last 8-digit date
  const m = core.match(/^(.+)-(\d{8})$/);
  if (!m) return null;
  const [, teams, dateRaw] = m;
  // teams like 'coritiba-vs-bahia-ba' OR 'sporting-de-gijon-vs-almeria'
  const parts = teams.split('-vs-');
  if (parts.length !== 2) return null;
  const t1 = parts[0].replace(/-/g, ' ').trim();
  const t2 = parts[1].replace(/-/g, ' ').trim();
  // YYYYMMDD → YYYY-MM-DD
  const date = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
  return { t1, t2, date };
}

/**
 * Resolver principal. Retorna canonical_match_id OR original (se não-agg) OR null.
 *
 * @param {Database} db — better-sqlite3 instance
 * @param {string} matchId — tip.match_id
 * @param {string} game — 'football' | 'mma' | etc
 * @returns {string|null}
 */
function resolveAlias(db, matchId, game) {
  if (!matchId || typeof matchId !== 'string') return null;
  if (!matchId.startsWith('agg_')) return matchId;
  if (!db || !game) return null;

  // 2. Cache hit — verify canonical row STILL EXISTS em match_results
  // (P0-2 audit fix 2026-05-23): se canonical foi deletado/reagendado, alias
  // ponteiro dangling — settle returns null silently OR pior, wrong-match.
  try {
    const cached = db.prepare(
      `SELECT a.canonical_match_id, mr.match_id AS mr_match_id
         FROM match_id_aliases a
         LEFT JOIN match_results mr
           ON mr.match_id = a.canonical_match_id AND mr.game = a.game
        WHERE a.alias = ? AND a.game = ?`
    ).get(matchId, game);
    if (cached?.canonical_match_id) {
      // Canonical existe em match_results — alias válido
      if (cached.mr_match_id) return cached.canonical_match_id;
      // Canonical deletado/missing — alias stale. Log + retorna null pra re-resolve
      log('WARN', 'MATCH-ID-RESOLVER',
        `stale alias detected: ${matchId.slice(0,50)} → ${cached.canonical_match_id} (canonical missing) — invalidating`);
      try {
        db.prepare(`DELETE FROM match_id_aliases WHERE alias = ? AND game = ?`).run(matchId, game);
      } catch (_) {}
      // Fall through pra re-fuzzy abaixo
    }
  } catch (e) {
    log('WARN', 'MATCH-ID-RESOLVER', `cache lookup err: ${e.message}`);
    return null;
  }

  // 3. Parse slug
  const parsed = parseAggSlug(matchId);
  if (!parsed) return null;

  // 4. Fuzzy match em janela de data
  let candidates;
  try {
    candidates = db.prepare(`
      SELECT match_id, team1, team2, resolved_at
        FROM match_results
       WHERE game = ?
         AND date(resolved_at) BETWEEN date(?, ?) AND date(?, ?)
    `).all(game, parsed.date, `-${DATE_WINDOW_DAYS} days`, parsed.date, `+${DATE_WINDOW_DAYS} days`);
  } catch (e) {
    log('WARN', 'MATCH-ID-RESOLVER', `candidates query err: ${e.message}`);
    return null;
  }

  if (!candidates.length) return null;

  let best = null, bestScore = 0;
  for (const c of candidates) {
    const score = _scorePair(parsed.t1, parsed.t2, c.team1, c.team2);
    if (score > bestScore) { best = c; bestScore = score; }
  }

  if (!best || bestScore < MIN_SCORE) return null;

  // 5. Persist alias (INSERT OR IGNORE — first match wins)
  try {
    db.prepare(`
      INSERT OR IGNORE INTO match_id_aliases
        (alias, game, canonical_match_id, resolved_by, confidence)
      VALUES (?, ?, ?, 'fuzzy_team_date', ?)
    `).run(matchId, game, best.match_id, +bestScore.toFixed(3));
    log('INFO', 'MATCH-ID-RESOLVER',
      `${game} ${matchId.slice(0, 50)} → ${best.match_id} (score=${bestScore.toFixed(2)} | ${parsed.t1} vs ${parsed.t2} matched ${best.team1} vs ${best.team2})`);
  } catch (e) {
    log('WARN', 'MATCH-ID-RESOLVER', `persist err: ${e.message}`);
  }

  return best.match_id;
}

module.exports = { resolveAlias, parseAggSlug, _scorePair, _jaccard, _norm };

/**
 * mt-permanent-disable.js — source-of-truth DB-driven para blocklist permanente MT.
 *
 * Antes (env-only): MT_PERMANENT_DISABLE_LIST="tennis|totalGames|over,..."
 *   Problema: hardcoded em 8+ arquivos com defaults inconsistentes (bot.js
 *   default tinha 5 entries, server.js+mt-preflight tinham 2 → mercado que
 *   bot bloqueava silenciosamente aparecia "OK" em audit endpoints).
 *
 * Agora (DB-driven): tabela `mt_permanent_disable_list` é canônica.
 *   Env MT_PERMANENT_DISABLE_LIST vira fallback transicional (deprecada).
 *   Audit trail via added_by + added_at + reason.
 *
 * Granularidade (P1):
 *   - sport: 'tennis' / 'lol' / 'cs' / etc (lowercase)
 *   - market: 'totalgames' / 'total' / 'total_kills_map2' (lowercase)
 *   - side: 'over' / 'under' / null/'' pra block do market inteiro
 *
 * Cache TTL 60s evita query DB em hot path (entrada por tip).
 */

let _cache = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 60 * 1000;

function _key(sport, market, side) {
  const s = String(sport || '').toLowerCase().trim();
  const m = String(market || '').toLowerCase().trim();
  const sd = String(side || '').toLowerCase().trim();
  return sd ? `${s}|${m}|${sd}` : `${s}|${m}`;
}

function invalidateCache() {
  _cache = null;
  _cacheExpiry = 0;
}

/**
 * Carrega Set<entryKey> com union(DB rows, env fallback).
 * Env fallback aplicado se env explícito (não-null). Preserva backwards-compat
 * com Railway envs ativos. Quando env removida do Railway, só DB conta.
 *
 * @param {Database} db better-sqlite3
 * @param {Object} opts { skipCache?: boolean }
 * @returns {Set<string>} Set de keys lowercase.
 */
function loadSet(db, opts = {}) {
  const now = Date.now();
  if (!opts.skipCache && _cache && now < _cacheExpiry) return _cache;

  const set = new Set();

  // 1) DB (canônico)
  try {
    if (db) {
      const rows = db.prepare(`
        SELECT sport, market, side FROM mt_permanent_disable_list
      `).all();
      for (const r of rows) {
        set.add(_key(r.sport, r.market, r.side));
      }
    }
  } catch (e) {
    // Tabela pode não existir em DB legacy pré-mig108; cair em env fallback.
  }

  // 2) Env fallback (transição — entries env são merged ao Set DB)
  // Quando env explícita (não-undefined), parsing csv:
  if (process.env.MT_PERMANENT_DISABLE_LIST !== undefined) {
    const raw = String(process.env.MT_PERMANENT_DISABLE_LIST || '').trim();
    for (const entry of raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
      const parts = entry.split('|');
      if (parts.length < 2) continue;
      set.add(_key(parts[0], parts[1], parts[2] || ''));
    }
  }

  _cache = set;
  _cacheExpiry = now + CACHE_TTL_MS;
  return set;
}

/**
 * Adiciona entry ao DB + invalida cache.
 *
 * @returns {boolean} true se inserido (não existia), false se já existia.
 */
function addEntry(db, sport, market, side, opts = {}) {
  if (!db) throw new Error('db required');
  const s = String(sport || '').toLowerCase().trim();
  const m = String(market || '').toLowerCase().trim();
  const sd = String(side || '').toLowerCase().trim();
  if (!s || !m) throw new Error('sport and market required');

  try {
    const r = db.prepare(`
      INSERT INTO mt_permanent_disable_list (sport, market, side, reason, added_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (sport, market, side) DO UPDATE SET
        reason = COALESCE(excluded.reason, mt_permanent_disable_list.reason),
        added_by = COALESCE(excluded.added_by, mt_permanent_disable_list.added_by)
    `).run(s, m, sd, opts.reason || null, opts.addedBy || 'manual');
    invalidateCache();
    return r.changes > 0;
  } catch (e) {
    invalidateCache();
    throw e;
  }
}

/**
 * Remove entry do DB + invalida cache.
 *
 * @returns {boolean} true se removido, false se não existia.
 */
function removeEntry(db, sport, market, side) {
  if (!db) throw new Error('db required');
  const s = String(sport || '').toLowerCase().trim();
  const m = String(market || '').toLowerCase().trim();
  const sd = String(side || '').toLowerCase().trim();
  try {
    const r = db.prepare(`
      DELETE FROM mt_permanent_disable_list WHERE sport=? AND market=? AND side=?
    `).run(s, m, sd);
    invalidateCache();
    return r.changes > 0;
  } catch (e) {
    invalidateCache();
    throw e;
  }
}

/**
 * Lista entries pra endpoints admin / debugging.
 * NÃO faz merge com env fallback (mostra só DB-driven).
 *
 * @returns {Array<{sport, market, side, reason, added_at, added_by}>}
 */
function listAll(db) {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT sport, market, side, reason, added_at, added_by
      FROM mt_permanent_disable_list
      ORDER BY sport, market, side
    `).all();
  } catch (e) {
    return [];
  }
}

/**
 * isBlocked(sport, market, side?) — checa Set carregado.
 * Compatível com pattern atual (sport|market e sport|market|side).
 */
function isBlocked(db, sport, market, side) {
  const set = loadSet(db);
  const sportL = String(sport || '').toLowerCase().trim();
  const marketL = String(market || '').toLowerCase().trim();
  const sideL = String(side || '').toLowerCase().trim();
  if (set.has(`${sportL}|${marketL}`)) return true;
  if (sideL && set.has(`${sportL}|${marketL}|${sideL}`)) return true;
  return false;
}

module.exports = {
  loadSet,
  addEntry,
  removeEntry,
  listAll,
  isBlocked,
  invalidateCache,
};

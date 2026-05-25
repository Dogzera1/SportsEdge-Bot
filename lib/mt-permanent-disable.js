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

function _key(sport, market, side, tier) {
  // 2026-05-25 (mig 128): key format passou de 3→4 segments. Empty side/tier
  // = '' (não omitido) pra parser/lookup determinístico.
  //   `lol|total||` = block all sides + all tiers (legacy NULL tier)
  //   `lol|total||tier2` = block all sides + tier2 only
  //   `tennis|totalgames|over|` = block over + all tiers
  //   `tennis|totalgames|over|tier1` = block over + tier1 only
  const s = String(sport || '').toLowerCase().trim();
  const m = String(market || '').toLowerCase().trim();
  const sd = String(side || '').toLowerCase().trim();
  const t = String(tier || '').toLowerCase().trim();
  return `${s}|${m}|${sd}|${t}`;
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

  // 1) DB (canônico) — SELECT incluindo tier (mig 128)
  try {
    if (db) {
      const rows = db.prepare(`
        SELECT sport, market, side, tier FROM mt_permanent_disable_list
      `).all();
      for (const r of rows) {
        set.add(_key(r.sport, r.market, r.side, r.tier));
      }
    }
  } catch (e) {
    // Tabela pode não existir em DB legacy pré-mig108; cair em env fallback.
    // Coluna tier pode não existir pré-mig128; SELECT 'tier' retorna NULL.
  }

  // 2) Env fallback (transição — entries env são merged ao Set DB)
  // Quando env explícita (não-undefined), parsing csv:
  // Formato suportado: `sport|market`, `sport|market|side`, `sport|market|side|tier`
  if (process.env.MT_PERMANENT_DISABLE_LIST !== undefined) {
    const raw = String(process.env.MT_PERMANENT_DISABLE_LIST || '').trim();
    for (const entry of raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
      const parts = entry.split('|');
      if (parts.length < 2) continue;
      set.add(_key(parts[0], parts[1], parts[2] || '', parts[3] || ''));
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
  // 2026-05-25 (mig 128): opts.tier opcional. NULL/'' = bloqueia todos tiers
  // (backwards compat). 'tier1'/'tier2'/'tier3' = bloqueia apenas aquele tier.
  // PK (sport, market, side) preservada — caller que precisa multi-tier per
  // s/m/side deve usar tier diferente (admin tier3 separado).
  const tier = opts.tier ? String(opts.tier).toLowerCase().trim() : null;
  if (!s || !m) throw new Error('sport and market required');

  try {
    const r = db.prepare(`
      INSERT INTO mt_permanent_disable_list (sport, market, side, reason, added_by, tier)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (sport, market, side) DO UPDATE SET
        reason = COALESCE(excluded.reason, mt_permanent_disable_list.reason),
        added_by = COALESCE(excluded.added_by, mt_permanent_disable_list.added_by),
        tier = excluded.tier
    `).run(s, m, sd, opts.reason || null, opts.addedBy || 'manual', tier);
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
      SELECT sport, market, side, reason, added_at, added_by, tier
      FROM mt_permanent_disable_list
      ORDER BY sport, market, side, COALESCE(tier, '')
    `).all();
  } catch (e) {
    return [];
  }
}

/**
 * isBlocked(sport, market, side?, tier?) — checa Set carregado.
 * Compatível com pattern atual (callers sem tier preservam old behavior).
 *
 * 2026-05-25 (mig 128): key format 4-segment. Checa 4 variants:
 *   - `sport|market||` (no side, no tier) — block whole market all tiers
 *   - `sport|market||tier` (no side, this tier) — block whole market this tier
 *   - `sport|market|side|` (this side, no tier) — block side all tiers
 *   - `sport|market|side|tier` (this side, this tier) — block side this tier
 *
 * Tier opt-in: caller passa tier OPCIONAL. Sem tier → tier-specific entries
 * ignoradas (apenas tier='' entries bloqueiam). Com tier → ambas categorias
 * (tier='' "all" + tier matching).
 */
function isBlocked(db, sport, market, side, tier) {
  const set = loadSet(db);
  const sportL = String(sport || '').toLowerCase().trim();
  const marketL = String(market || '').toLowerCase().trim();
  const sideL = String(side || '').toLowerCase().trim();
  const tierL = String(tier || '').toLowerCase().trim();
  // Whole-market checks (side='')
  if (set.has(`${sportL}|${marketL}||`)) return true;
  if (tierL && set.has(`${sportL}|${marketL}||${tierL}`)) return true;
  // Side-specific checks
  if (sideL) {
    if (set.has(`${sportL}|${marketL}|${sideL}|`)) return true;
    if (tierL && set.has(`${sportL}|${marketL}|${sideL}|${tierL}`)) return true;
  }
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

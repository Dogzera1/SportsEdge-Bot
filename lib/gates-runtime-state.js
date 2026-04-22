'use strict';

/**
 * gates-runtime-state.js
 *
 * Persistência DB-backed pros gates auto-tunados (pre-match EV bonus,
 * max stake cap). Mesmo shape do league_blocklist e odds_bucket_blocklist:
 * cache em memória + DB authoritative + suporte a manual override + auto.
 *
 * Schema (migration 053):
 *   gates_runtime_state (sport, gate_key, value, source, reason, evidence, updated_at)
 *
 * gate_key conhecido:
 *   'pre_match_ev_bonus' — pp adicionados ao threshold EV em tips !isLive
 *   'max_stake_units'    — clamp final no stake após todos multipliers
 *
 * API:
 *   loadFromDb(db)              → popula cache; retorna {n, byKey}
 *   getGateValue(sport, key)    → retorna value ou null
 *   setAuto(db, sport, key, v, meta) → upsert source='auto' + cache
 *   setManual(db, sport, key, v, meta) → upsert source='manual' + cache
 *   removeAuto(db, sport, key)  → delete (mas só se source='auto')
 *   getAll()                    → snapshot Map<sport|key, row>
 */

const _cache = new Map(); // key=`${sport}|${key}` → { value, source, reason, evidence, updatedAt }

function _normSport(s) {
  return String(s || '').toLowerCase().trim();
}
function _key(sport, gateKey) {
  return `${_normSport(sport)}|${gateKey}`;
}

function loadFromDb(db) {
  if (!db) return { n: 0 };
  _cache.clear();
  try {
    const rows = db.prepare(`SELECT * FROM gates_runtime_state`).all();
    for (const r of rows) {
      _cache.set(_key(r.sport, r.gate_key), {
        value: Number(r.value),
        source: r.source,
        reason: r.reason || null,
        evidence: r.evidence || null,
        updatedAt: r.updated_at,
      });
    }
    const byKey = {};
    for (const [k, v] of _cache) byKey[k] = v;
    return { n: rows.length, byKey };
  } catch (e) {
    return { n: 0, error: e.message };
  }
}

function getGateValue(sport, gateKey) {
  const e = _cache.get(_key(sport, gateKey));
  return e ? e.value : null;
}

function getGateMeta(sport, gateKey) {
  return _cache.get(_key(sport, gateKey)) || null;
}

function _persist(db, sport, gateKey, value, source, meta = {}) {
  if (!db) return;
  const sp = _normSport(sport);
  const evidenceStr = meta.evidence
    ? (typeof meta.evidence === 'string' ? meta.evidence : JSON.stringify(meta.evidence))
    : null;
  try {
    db.prepare(`
      INSERT INTO gates_runtime_state (sport, gate_key, value, source, reason, evidence, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sport, gate_key) DO UPDATE SET
        value = excluded.value,
        source = excluded.source,
        reason = excluded.reason,
        evidence = excluded.evidence,
        updated_at = excluded.updated_at
    `).run(sp, gateKey, Number(value), source, meta.reason || null, evidenceStr, Date.now());
    _cache.set(_key(sp, gateKey), {
      value: Number(value), source,
      reason: meta.reason || null,
      evidence: evidenceStr,
      updatedAt: Date.now(),
    });
    return true;
  } catch (_) { return false; }
}

function setAuto(db, sport, gateKey, value, meta = {}) {
  return _persist(db, sport, gateKey, value, 'auto', meta);
}
function setManual(db, sport, gateKey, value, meta = {}) {
  return _persist(db, sport, gateKey, value, 'manual', meta);
}

function removeAuto(db, sport, gateKey) {
  const sp = _normSport(sport);
  const k = _key(sp, gateKey);
  const cur = _cache.get(k);
  if (!cur || cur.source !== 'auto') return false; // proteção: não remove manual
  try {
    db.prepare(`DELETE FROM gates_runtime_state WHERE sport=? AND gate_key=? AND source='auto'`).run(sp, gateKey);
    _cache.delete(k);
    return true;
  } catch (_) { return false; }
}

function getAll() {
  return new Map(_cache);
}

module.exports = {
  loadFromDb, getGateValue, getGateMeta,
  setAuto, setManual, removeAuto, getAll,
  GATE_KEYS: { PRE_MATCH_EV_BONUS: 'pre_match_ev_bonus', MAX_STAKE_UNITS: 'max_stake_units' },
};

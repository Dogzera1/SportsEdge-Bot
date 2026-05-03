'use strict';

/**
 * odds-bucket-gate.js
 *
 * Gate cross-sport que bloqueia tips em faixas (buckets) de odds identificadas
 * como leak via scripts/roi-by-odds-bucket.js + auto-guard runOddsBucketGuardCycle.
 *
 * Camadas (qualquer match → blocked):
 *   1. Per-sport env override (<SPORT>_ODDS_BUCKET_BLOCK)
 *   2. Cross-sport env (ODDS_BUCKET_BLOCK)
 *   3. DB (table odds_bucket_blocklist) — auto + manual + env-seeded
 *
 * Formato bucket: "MIN-MAX" (MIN inclusive, MAX exclusive). Separar por vírgula.
 * Entries DB são "sport:MIN-MAX" lowercase, ou "*:MIN-MAX" pra cross-sport.
 */

// In-memory state (populated via loadFromDb)
const _dbBlocklist = new Set();        // entries strings "sport:min-max"
const _autoBlocked = new Map();         // entry → { reason, since, roi, clv, n }
const _cooldowns = new Map();           // entry → expire_ts

function parseBuckets(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const min = parseFloat(m[1]);
    const max = parseFloat(m[2]);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) continue;
    out.push({ min, max, label: `${min.toFixed(2)}-${max.toFixed(2)}` });
  }
  return out;
}

function normSport(sport) {
  const s = String(sport || '').toLowerCase().trim();
  if (s === 'cs' || s === 'cs2' || s === 'counterstrike') return 'CS';
  if (s === 'lol' || s === 'esports' || s === 'leagueoflegends') return 'LOL';
  if (s === 'dota' || s === 'dota2') return 'DOTA2';
  if (s === 'val' || s === 'valorant') return 'VALORANT';
  if (s === 'tennis') return 'TENNIS';
  if (s === 'mma') return 'MMA';
  if (s === 'football' || s === 'soccer') return 'FOOTBALL';
  if (s === 'darts') return 'DARTS';
  if (s === 'snooker') return 'SNOOKER';
  if (s === 'tt' || s === 'tabletennis') return 'TT';
  return s.toUpperCase();
}

function _normSportLower(sport) {
  return normSport(sport).toLowerCase();
}

function _entryFor(sport, min, max) {
  return `${_normSportLower(sport)}:${min.toFixed(2)}-${max.toFixed(2)}`;
}

function _parseEntry(entry) {
  // "sport:MIN-MAX" → { sport, min, max }
  const i = entry.indexOf(':');
  if (i < 0) return null;
  const sport = entry.slice(0, i);
  const range = entry.slice(i + 1);
  const m = range.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { sport, min: parseFloat(m[1]), max: parseFloat(m[2]) };
}

function loadFromDb(db) {
  if (!db) return;
  try {
    const rows = db.prepare(`SELECT * FROM odds_bucket_blocklist`).all();
    const now = Date.now();
    let restored = 0, autoCount = 0, cooldownCount = 0;
    for (const r of rows) {
      if (r.source === 'cooldown') {
        if (r.cooldown_until && r.cooldown_until > now) {
          _cooldowns.set(r.entry, r.cooldown_until);
          cooldownCount++;
        } else {
          try { db.prepare(`DELETE FROM odds_bucket_blocklist WHERE entry = ?`).run(r.entry); } catch (_) {}
        }
        continue;
      }
      _dbBlocklist.add(r.entry);
      restored++;
      if (r.source === 'auto') {
        _autoBlocked.set(r.entry, {
          reason: r.reason || '',
          since: r.created_at || now,
          roi: r.roi_pct,
          clv: r.clv_pct,
          n: r.n_tips,
        });
        autoCount++;
      }
    }
    return { restored, autoCount, cooldownCount };
  } catch (e) {
    return { error: e.message };
  }
}

function persistEntry(db, entry, source, meta = {}) {
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO odds_bucket_blocklist (entry, source, reason, roi_pct, clv_pct, n_tips, created_at, cooldown_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry) DO UPDATE SET
        source = excluded.source,
        reason = excluded.reason,
        roi_pct = excluded.roi_pct,
        clv_pct = excluded.clv_pct,
        n_tips = excluded.n_tips,
        created_at = excluded.created_at,
        cooldown_until = excluded.cooldown_until
    `).run(
      entry, source,
      meta.reason || null,
      meta.roi != null ? Number(meta.roi) : null,
      meta.clv != null ? Number(meta.clv) : null,
      meta.n != null ? Number(meta.n) : null,
      meta.since || Date.now(),
      meta.cooldownUntil || null,
    );
  } catch (_) { /* swallow */ }
}

function deleteEntry(db, entry, cooldownUntil = null) {
  if (!db) return;
  try {
    if (cooldownUntil) {
      db.prepare(`UPDATE odds_bucket_blocklist SET source = 'cooldown', cooldown_until = ?, reason = 'unblock manual' WHERE entry = ?`).run(cooldownUntil, entry);
    } else {
      db.prepare(`DELETE FROM odds_bucket_blocklist WHERE entry = ?`).run(entry);
    }
  } catch (_) { /* swallow */ }
}

function autoBlock(db, sport, min, max, meta = {}) {
  const entry = _entryFor(sport, min, max);
  if (_dbBlocklist.has(entry)) return false;
  const cooldownUntil = _cooldowns.get(entry) || 0;
  if (Date.now() < cooldownUntil) return false;
  _dbBlocklist.add(entry);
  _autoBlocked.set(entry, {
    reason: meta.reason || '',
    since: meta.since || Date.now(),
    roi: meta.roi,
    clv: meta.clv,
    n: meta.n,
  });
  persistEntry(db, entry, 'auto', meta);
  return entry;
}

function autoRestore(db, entry) {
  if (!_autoBlocked.has(entry)) return false;
  _dbBlocklist.delete(entry);
  _autoBlocked.delete(entry);
  deleteEntry(db, entry);
  return true;
}

function getAutoBlocks() { return new Map(_autoBlocked); }
function getDbBlocklist() { return new Set(_dbBlocklist); }
function getCooldowns() { return new Map(_cooldowns); }

/**
 * @returns {{blocked: boolean, bucket?: string, source?: 'global'|'sport'|'auto'|'manual'|'env'}}
 */
// 2026-05-03: defaults per-sport quando env unset. Aplicado entre per-sport env
// e DB entries pra que env override (vazio explícito desliga, valor sobrescreve).
// TENNIS bucket 2.50-4.00: ML regular ROI -33% em 30d (n=122, hit 27.9%); buckets
// 2.5-3.0 hit 19% ROI -47% e 3.0-4.0 hit 23.5% ROI -23.7%. Modelo overconfident
// em underdog (pmodel >> realized) com CLV positivo — sintoma de calib mal feita.
// Pra desligar (refit modelo): set TENNIS_ODDS_BUCKET_BLOCK= (vazio) no env.
const _DEFAULT_PER_SPORT_BLOCK = {
  TENNIS: '2.50-4.00',
};

function isBucketBlocked(sport, odd) {
  const o = Number(odd);
  if (!Number.isFinite(o) || o <= 1) return { blocked: false };

  const S = normSport(sport);
  const sLower = S.toLowerCase();

  // 1. Per-sport env (override explícito; env vazio desliga default)
  const perSportEnvKey = `${S}_ODDS_BUCKET_BLOCK`;
  const envSet = perSportEnvKey in process.env;
  const perSportRaw = envSet
    ? process.env[perSportEnvKey]
    : (_DEFAULT_PER_SPORT_BLOCK[S] || '');
  const perSport = parseBuckets(perSportRaw);
  for (const b of perSport) {
    if (o >= b.min && o < b.max) return { blocked: true, bucket: b.label, source: envSet ? 'sport' : 'sport_default' };
  }

  // 2. DB entries (auto + manual + env-seeded)
  for (const entry of _dbBlocklist) {
    const p = _parseEntry(entry);
    if (!p) continue;
    if (p.sport !== '*' && p.sport !== sLower) continue;
    if (o >= p.min && o < p.max) {
      const isAuto = _autoBlocked.has(entry);
      return { blocked: true, bucket: `${p.min.toFixed(2)}-${p.max.toFixed(2)}`, source: isAuto ? 'auto' : 'manual', entry };
    }
  }

  // 3. Cross-sport env (last resort)
  const global = parseBuckets(process.env.ODDS_BUCKET_BLOCK);
  for (const b of global) {
    if (o >= b.min && o < b.max) return { blocked: true, bucket: b.label, source: 'global' };
  }

  return { blocked: false };
}

module.exports = {
  isBucketBlocked,
  parseBuckets,
  normSport,
  loadFromDb,
  autoBlock,
  autoRestore,
  persistEntry,
  deleteEntry,
  getAutoBlocks,
  getDbBlocklist,
  getCooldowns,
  _entryFor,
  _parseEntry,
};

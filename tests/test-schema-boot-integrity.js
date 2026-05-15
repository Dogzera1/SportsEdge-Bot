/**
 * Sprint 3 #2 — Schema boot integrity
 *
 * Verifica que initDatabase() em fresh DB produz schema esperado.
 *
 * Background: lib/database.js usa arquitetura dual-source:
 *   1. Initial DDL inline (lines 109-362) — cria tables base em v1 state
 *   2. applyMigrations(db) — evolui v1 → current schema (109+ migs)
 *
 * Risco original (memory project_session_2026_05_15): testar applyMigrations
 * em isolamento (sem initial DDL) falha em mig 002 "no such table: tips".
 * Esse comportamento é POR DESIGN — applyMigrations exige initial DDL antes.
 *
 * Este test cobre o caminho completo (DDL + migrations) garantindo:
 *   - fresh boot succeeds (no migration errors)
 *   - critical tables exist
 *   - critical columns present (catches regressions onde mig X é adicionada
 *     mas initial DDL não acompanha + mig depende de coluna do DDL)
 *   - indexes esperados existem
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function freshDb() {
  const tempPath = path.join(os.tmpdir(), `sportsedge-schema-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const initDatabase = require('../lib/database');
  const { db } = initDatabase(tempPath);
  return {
    db,
    cleanup: () => {
      try { db.close(); } catch (_) {}
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(tempPath + suffix); } catch (_) {}
      }
    },
  };
}

module.exports = function(t) {
  // Cache single boot pra todos os tests (mais rápido + previne side-effect issues)
  let _db, _cleanup;
  try {
    const r = freshDb();
    _db = r.db;
    _cleanup = r.cleanup;
  } catch (e) {
    // Se boot falha, todos os tests falham com mensagem clara
    t.test('fresh DB boot succeeds', () => {
      throw new Error(`initDatabase failed on fresh DB: ${e.message}`);
    });
    return;
  }

  t.test('fresh DB boot: no migration errors (global._schemaIncomplete unset)', () => {
    t.assert(!global._schemaIncomplete, `Schema incomplete: ${global._schemaIncomplete}`);
  });

  t.test('fresh DB: critical core tables exist', () => {
    const tables = _db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    const critical = [
      'tips', 'users', 'matches', 'events', 'match_results',
      'bankroll', 'market_tips_shadow', 'market_tips_runtime_state',
      'schema_migrations',
      // Recent additions (audit P0/P1 — verifies migrations 105-110 ran)
      'ml_bucket_blocklist',          // mig 105
      'mt_permanent_disable_list',    // mig 108
      'match_result_sources',          // mig 109
      'bankroll_drift_log',           // mig 110
    ];
    for (const name of critical) {
      t.assert(tables.includes(name), `missing table: ${name}`);
    }
  });

  t.test('fresh DB: tips has post-migration columns', () => {
    const cols = _db.prepare(`PRAGMA table_info(tips)`).all().map(c => c.name);
    const expected = [
      // From initial DDL
      'sport', 'match_id', 'participant1', 'participant2',
      'odds', 'ev', 'stake', 'confidence', 'sent_at', 'result',
      'settled_at', 'market_type',
      // Added by migrations
      'archived',        // mig 028
      'is_shadow',       // mig 096 (recent UNIQUE constraint pre-flag)
      'is_live',         // initial DDL
      'profit_reais',    // mig 010+ era
      'stake_reais',     // mig 010+ era
    ];
    for (const col of expected) {
      t.assert(cols.includes(col), `tips missing column: ${col}`);
    }
  });

  t.test('fresh DB: market_tips_shadow exists with profit_units', () => {
    const cols = _db.prepare(`PRAGMA table_info(market_tips_shadow)`).all().map(c => c.name);
    t.assert(cols.includes('profit_units'), 'market_tips_shadow missing profit_units (settle path)');
    t.assert(cols.includes('result'), 'market_tips_shadow missing result');
    t.assert(cols.includes('sport'), 'market_tips_shadow missing sport');
    t.assert(cols.includes('market'), 'market_tips_shadow missing market');
  });

  t.test('fresh DB: schema_migrations populated with 100+ rows', () => {
    const count = _db.prepare(`SELECT COUNT(*) AS c FROM schema_migrations`).get().c;
    t.assert(count >= 100, `expected >= 100 migrations applied, got ${count}`);
  });

  t.test('fresh DB: critical indexes exist (hot path)', () => {
    const indexes = _db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map(r => r.name);
    const critical = [
      'idx_tips_realonly',           // mig 103
      'idx_tfl_settled_logged',       // mig 104
      'idx_tips_p1_norm_propagator',  // mig 106
      'idx_tips_archived_sport',      // mig 028
    ];
    for (const name of critical) {
      t.assert(indexes.includes(name), `missing index: ${name}`);
    }
  });

  t.test('fresh DB: bankroll seeded com 13 sports', () => {
    const count = _db.prepare(`SELECT COUNT(*) AS c FROM bankroll`).get().c;
    t.assert(count >= 13, `bankroll seed expected >= 13 sports, got ${count}`);
    const lol = _db.prepare(`SELECT current_banca FROM bankroll WHERE sport = 'lol'`).get();
    t.assert(lol && lol.current_banca === 100, `lol initial bankroll should be 100, got ${lol && lol.current_banca}`);
  });

  t.test('fresh DB: dup mig 029 fix preserves applied state', () => {
    // Sprint 3 #1 fix renamed 029_dota_hero_stats_extend → 028a_dota_hero_stats_extend.
    // Fresh DB applies 028a (new ID). Verify it's in schema_migrations.
    const r = _db.prepare(`SELECT id FROM schema_migrations WHERE id = '028a_dota_hero_stats_extend'`).get();
    t.assert(r != null, '028a_dota_hero_stats_extend should be applied on fresh DB');
    const dotaHeroCols = _db.prepare(`PRAGMA table_info(dota_hero_stats)`).all().map(c => c.name);
    t.assert(dotaHeroCols.includes('attack_type'), 'dota_hero_stats.attack_type should exist (mig 028a)');
    t.assert(dotaHeroCols.includes('source'), 'dota_hero_stats.source should exist (mig 028a)');
  });

  // Cleanup teardown via process exit (Node deletes temp files; also explicit attempt)
  if (typeof _cleanup === 'function') {
    process.on('exit', _cleanup);
  }
};

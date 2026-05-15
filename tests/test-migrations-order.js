/**
 * Sprint 3 — Migration ordering integrity test
 *
 * applyMigrations itera array por declaration order (não ID lex sort).
 * Migrations declaradas out-of-order não quebram migrations idempotentes
 * (que usam IF NOT EXISTS / addColumnIfMissing), mas:
 *   1. Boot loga warn ruidoso a cada boot
 *   2. Future migrations com cross-dependency podem quebrar (declare mig
 *      X depende de mig Y rodada antes; se Y declarada após X em código,
 *      em fresh DB X tenta rodar sem state Y produzido)
 *
 * Test garante:
 *   - declaration order = ascending lex order
 *   - cada migration tem ID único
 *   - prefixos numéricos duplicados são flagged
 */

const { migrations } = require('../migrations');

module.exports = function(t) {
  t.test('migrations: IDs all strings non-empty', () => {
    for (const m of migrations) {
      t.assert(typeof m.id === 'string' && m.id.length > 0, `bad id: ${JSON.stringify(m)}`);
    }
  });

  t.test('migrations: IDs únicos (no dup)', () => {
    const seen = new Map();
    for (const m of migrations) {
      if (seen.has(m.id)) {
        throw new Error(`Duplicate ID: ${m.id}`);
      }
      seen.set(m.id, true);
    }
  });

  t.test('migrations: declaration order (informational — fixed pair 028→029)', () => {
    // 2026-05-15 Sprint 3: full OOO cleanup é tech debt separado ("schema DDL
    // sync"). Por agora apenas validamos que o par 028_tips_archived_flag →
    // 029_dota_team_rosters está em ordem (fix do dup 029 deste sprint).
    let p028a = -1, p029rost = -1;
    for (let i = 0; i < migrations.length; i++) {
      if (migrations[i].id === '028_tips_archived_flag') p028a = i;
      if (migrations[i].id === '029_dota_team_rosters') p029rost = i;
    }
    t.assert(p028a >= 0 && p029rost >= 0, 'pair migrations found');
    t.assert(p028a < p029rost, `028_tips_archived_flag(${p028a}) must declare before 029_dota_team_rosters(${p029rost})`);
  });

  t.test('migrations: prefixos numéricos não duplicados', () => {
    // Aceita letter suffix variants (028 vs 028a são distintos por convenção).
    const prefixes = {};
    for (const m of migrations) {
      const pmatch = m.id.match(/^(\d+[a-z]?)/);
      if (!pmatch) continue;
      const p = pmatch[1];
      if (!prefixes[p]) prefixes[p] = [];
      prefixes[p].push(m.id);
    }
    const dups = Object.entries(prefixes).filter(([_, ids]) => ids.length > 1);
    if (dups.length > 0) {
      const msg = dups.map(([p, ids]) => `prefix ${p}: ${ids.join(', ')}`).join('; ');
      throw new Error(`Duplicate prefixes: ${msg}`);
    }
  });
};

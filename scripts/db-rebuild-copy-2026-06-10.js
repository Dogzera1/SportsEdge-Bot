// @ONESHOT P0 2026-06-10 — rebuild copy do sportsedge.db pulando match_result_sources
// (page-level corruption: integrity_check/VACUUM/DELETE → SQLITE_CORRUPT).
// Executado IN-CONTAINER via `railway ssh` (base64 → /tmp/rebuild.js → node).
// Runbook: docs/P0-db-recovery-2026-06-10.md (Variante B). Pós-cópia: swap mv + redeploy.
const B = require('/app/node_modules/better-sqlite3');
const fs = require('fs');
const SRC = '/data/sportsedge.db';
const DST = '/data/sportsedge_new.db';
try { fs.unlinkSync(DST); } catch (_) {}
try { fs.unlinkSync(DST + '-wal'); } catch (_) {}
try { fs.unlinkSync(DST + '-shm'); } catch (_) {}
const src = new B(SRC, { readonly: true });
const dst = new B(DST);
dst.pragma('journal_mode = OFF');   // build mais rápido; WAL no fim
dst.pragma('synchronous = OFF');
const objs = src.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
const tables = objs.filter(o => o.type === 'table');
const rest = objs.filter(o => o.type !== 'table'); // índices/triggers/views depois dos dados (insert mais rápido)
for (const o of tables) { try { dst.exec(o.sql); } catch (e) { console.log('SCHEMA_FAIL', o.name, e.message); } }
const failures = [];
let totalRows = 0;
for (const o of tables) {
  if (o.name === 'match_result_sources') { console.log('SKIP_DATA', o.name, '(corrupta — audit trail descartavel, re-popula)'); continue; }
  try {
    const cols = src.prepare(`PRAGMA table_info("${o.name}")`).all().map(c => c.name);
    const colList = cols.map(c => '"' + c + '"').join(',');
    const ins = dst.prepare(`INSERT OR IGNORE INTO "${o.name}" (${colList}) VALUES (${cols.map(() => '?').join(',')})`);
    let n = 0;
    let batch = [];
    // batch 5000: limita pico de memória (container roda bot+server ~470/512MB)
    const flush = dst.transaction(rows => { for (const r of rows) { ins.run(cols.map(c => r[c])); n++; } });
    for (const row of src.prepare(`SELECT * FROM "${o.name}"`).iterate()) {
      batch.push(row);
      if (batch.length >= 5000) { flush(batch); batch = []; }
    }
    if (batch.length) flush(batch);
    totalRows += n;
    console.log('OK', o.name, n);
  } catch (e) { failures.push(o.name + ': ' + e.message); console.log('DATA_FAIL', o.name, e.message); }
}
for (const o of rest) { try { dst.exec(o.sql); } catch (e) { console.log('IDX_FAIL', o.name, e.message); } }
dst.pragma('synchronous = NORMAL');
dst.pragma('journal_mode = WAL');
const integ = dst.pragma('integrity_check', { simple: false });
console.log('NEW_INTEGRITY', JSON.stringify(integ.slice(0, 3)));
console.log('TOTAL_ROWS', totalRows, 'FAILURES', failures.length, failures.slice(0, 5).join(' | '));
src.close(); dst.close();

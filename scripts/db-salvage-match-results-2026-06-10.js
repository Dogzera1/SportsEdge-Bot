// @ONESHOT P0 2026-06-10 (parte 2) — salvage de match_results por bisect de rowid
// (cópia integral falhou: páginas podres no meio da btree) + top-up de tabelas
// quentes escritas desde a cópia inicial. Roda IN-CONTAINER (railway ssh).
const B = require('/app/node_modules/better-sqlite3');
const src = new B('/data/sportsedge.db', { readonly: true });
const dst = new B('/data/sportsedge_new.db');
dst.pragma('synchronous = OFF');

// — salvage match_results —
const cols = src.prepare('PRAGMA table_info("match_results")').all().map(c => c.name);
const colList = cols.map(c => '"' + c + '"').join(',');
const ins = dst.prepare('INSERT OR IGNORE INTO "match_results" (' + colList + ') VALUES (' + cols.map(() => '?').join(',') + ')');
let MAX = 600000;
try { const m = src.prepare('SELECT MAX(rowid) m FROM match_results').get(); if (m && m.m) MAX = m.m; } catch (e) { console.log('MAXROWID_FAIL (fallback 600k):', e.message); }
let saved = 0, lost = 0; const badRanges = [];
const insMany = dst.transaction(rows => { for (const r of rows) ins.run(cols.map(c => r[c])); });
function copyRange(a, b) {
  try {
    const rows = src.prepare('SELECT * FROM match_results WHERE rowid >= ? AND rowid <= ?').all(a, b);
    insMany(rows); saved += rows.length;
  } catch (e) {
    if (b - a <= 64) { lost += (b - a + 1); badRanges.push(a + '-' + b); return; }
    const mid = (a + b) >> 1; copyRange(a, mid); copyRange(mid + 1, b);
  }
}
for (let a = 1; a <= MAX; a += 8192) copyRange(a, Math.min(a + 8191, MAX));
console.log('SALVAGED', saved, 'LOST_ROWID_SLOTS~', lost, 'BAD_RANGES', badRanges.length, badRanges.slice(0, 8).join(','));

// — top-up tabelas quentes (writes desde a cópia inicial; INSERT OR IGNORE = idempotente) —
for (const t of ['tips', 'market_tips_shadow', 'tip_settlement_audit', 'bankroll', 'bankroll_history', 'clv_log', 'analyzed_dedup']) {
  try {
    const tc = src.prepare('PRAGMA table_info("' + t + '")').all().map(c => c.name);
    if (!tc.length) { console.log('TOPUP_SKIP', t, '(nao existe)'); continue; }
    const ti = dst.prepare('INSERT OR IGNORE INTO "' + t + '" (' + tc.map(c => '"' + c + '"').join(',') + ') VALUES (' + tc.map(() => '?').join(',') + ')');
    const tx = dst.transaction(rs => { for (const r of rs) ti.run(tc.map(c => r[c])); });
    const before = dst.prepare('SELECT COUNT(*) c FROM "' + t + '"').get().c;
    tx(src.prepare('SELECT * FROM "' + t + '"').all());
    const after = dst.prepare('SELECT COUNT(*) c FROM "' + t + '"').get().c;
    console.log('TOPUP', t, '+' + (after - before));
  } catch (e) { console.log('TOPUP_FAIL', t, e.message); }
}
dst.pragma('synchronous = NORMAL');
console.log('INTEG2', JSON.stringify(dst.pragma('integrity_check', { simple: false }).slice(0, 3)));
const mrCount = dst.prepare('SELECT COUNT(*) c FROM match_results').get().c;
console.log('MATCH_RESULTS_NEW', mrCount);
src.close(); dst.close();

const Database = require('better-sqlite3');
const db = new Database('sportsedge.db', { readonly: true });
const tables = ['dota_live_snapshots','super_odd_events','bookmaker_delta_samples','book_bug_events','velocity_events','arb_events','stale_line_events'];
for (const t of tables) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    const dateCols = cols.filter(c => /_at$|_ts$|^ts$|date|time|created|detected|sampled|captured|logged/i.test(c.name)).map(c => `${c.name}(${c.type})`);
    const n = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    console.log(`${t} [n=${n}] date-cols: ${dateCols.join(', ') || '(NENHUMA — todas: '+cols.map(c=>c.name).join(',')+')'}`);
  } catch (e) { console.log(`${t}: ERR ${e.message}`); }
}
db.close();

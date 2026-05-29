const fs = require('fs');
const path = require('path');
function load(name) {
  try { let t = fs.readFileSync(path.join(__dirname, name + '.json'), 'utf8'); if (t.charCodeAt(0)===0xFEFF) t=t.slice(1); return JSON.parse(t); }
  catch(e){ return {__err:String(e.message)}; }
}
const show = (label, name, max=900) => { const d = load(name); console.log(`\n### ${label}\n` + JSON.stringify(d).slice(0,max)); };
show('SPORT-LEAK-SUMMARY', 'sport_leak_summary', 2600);
show('DB-STATS', 'db_stats', 3400);
show('MEMORY-BREAKDOWN', 'memory_breakdown', 1100);
show('BOOT-DIAG', 'boot_diag', 2000);
show('REAL-PL', 'real_pl', 250);
show('RECONCILIATION', 'reconciliation', 1900);
show('NIGHTLY-RETRAIN', 'nightly_retrain', 600);
show('CLV-COVERAGE', 'clv_coverage', 2200);
show('GATE-ATTRIBUTION', 'gate_attr', 1500);
show('HEALTH-OVERVIEW', 'health_overview', 1400);
show('FEED-HEALTH', 'feed_health', 1700);
show('SHADOW-VS-REAL', 'shadow_vs_real', 1400);

const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const SPORTS = ['lol','cs','dota2','valorant','tennis','football','basket','mma','darts','snooker','tabletennis'];
function load(name) {
  try {
    let t = fs.readFileSync(path.join(DIR, name + '.json'), 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); // strip BOM
    return JSON.parse(t);
  } catch (e) { return null; }
}
const out = [];
const h = load('health');
if (h) {
  out.push(`HEALTH app=${h.status} db=${h.db} lastAnalysis=${h.lastAnalysis} pending=${JSON.stringify(h.pendingTips)}`);
  if (h.alerts) out.push(`  alerts=${JSON.stringify(h.alerts).slice(0,600)}`);
  out.push(`  sources=${JSON.stringify(h.sources).slice(0,500)}`);
}
const p = load('p2_status');
if (p) {
  out.push(`P2 compliance=${p.compliance_summary||p.compliance} commit=${(p.version&&p.version.commit_short)||p.commit_short} msg="${((p.version&&p.version.commit_message)||'').slice(0,70)}"`);
  if (p.issues && p.issues.length) out.push(`  P2_ISSUES(${p.issues.length})=${JSON.stringify(p.issues).slice(0,900)}`);
  const cfg = p.config || p.envs || {};
  out.push(`  P2_keys=${Object.keys(cfg).join(',')}`);
  // dump full config values compactly
  out.push(`  P2_config=${JSON.stringify(cfg).slice(0,800)}`);
  if (p.frozen_holdout) out.push(`  frozen_holdout=${JSON.stringify(p.frozen_holdout).slice(0,200)}`);
}
const rm = load('risk_metrics');
if (rm) out.push(`RISK30d=${JSON.stringify(rm)}`);
const e = load('env_audit');
if (e) out.push(`ENV-AUDIT=${JSON.stringify(e)}`);
const o = load('overfeaturing');
if (o) out.push(`OVERFEAT=${JSON.stringify(o)}`);
const hd = load('holdout');
if (hd) out.push(`HOLDOUT=${JSON.stringify(hd)}`);
const dl = load('disable_list');
if (dl) {
  const list = dl.list || dl.disabled || dl.entries || (Array.isArray(dl)?dl:[]);
  out.push(`DISABLE-LIST count=${Array.isArray(list)?list.length:'obj'}`);
  out.push(`  ${JSON.stringify(dl).slice(0,1400)}`);
}
const c = load('cron_status');
if (c) {
  const crons = c.crons || c.list || (Array.isArray(c)?c:[]);
  const arr = Array.isArray(crons)?crons:[];
  const stale = arr.filter(x => x && (x.is_stale || x.stale || x.status==='stale' || (x.age_min && x.expected_min && x.age_min > x.expected_min*3)));
  out.push(`CRON total=${arr.length} stale=${stale.length}`);
  stale.forEach(s => out.push(`  STALE ${s.name||s.id||s.cron}: age=${s.age_min||s.ageMin||s.last_run_min_ago}min expected=${s.expected_min||s.interval_min||'?'} lastErr=${(s.last_error||s.lastError||'').toString().slice(0,80)}`));
  // crons com erro recente mesmo se nao stale
  const withErr = arr.filter(x => x && (x.last_error||x.lastError) && !stale.includes(x));
  withErr.slice(0,15).forEach(s => out.push(`  ERR ${s.name||s.id}: ${(s.last_error||s.lastError).toString().slice(0,90)}`));
}
out.push('\n=== ROI por sport ===');
for (const s of SPORTS) {
  const d = load('sportdetail_' + s);
  if (!d) { out.push(`${s}: (no file)`); continue; }
  out.push(`${s}: ${JSON.stringify(d).slice(0,700)}`);
}
fs.writeFileSync(path.join(DIR, '_summary.txt'), out.join('\n'));
console.log(out.join('\n'));

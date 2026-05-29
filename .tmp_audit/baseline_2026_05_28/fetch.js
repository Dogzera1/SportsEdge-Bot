// Baseline fetch p/ auditoria 2026-05-28 — roda no ambiente real (rede + FS projeto)
const fs = require('fs');
const path = require('path');
const KEY = '14725836';
const BASE = 'https://sportsedge-bot-production.up.railway.app';
const OUT = __dirname;
const SPORTS = ['lol','cs','dota2','valorant','tennis','football','basket','mma','darts','snooker','tabletennis'];

const core = {
  health:        `${BASE}/health`,
  p2_status:     `${BASE}/admin/p2-status?key=${KEY}`,
  risk_metrics:  `${BASE}/admin/risk-metrics?days=30&key=${KEY}`,
  env_audit:     `${BASE}/admin/env-audit?key=${KEY}`,
  cron_status:   `${BASE}/admin/cron-status?key=${KEY}`,
  overfeaturing: `${BASE}/admin/overfeaturing-audit?days=30&key=${KEY}`,
  holdout:       `${BASE}/admin/holdout-status?key=${KEY}`,
  disable_list:  `${BASE}/admin/mt-disable-list?key=${KEY}`,
};
for (const s of SPORTS) core[`sportdetail_${s}`] = `${BASE}/admin/sport-detail?sport=${s}&key=${KEY}`;

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 50000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'x-admin-key': KEY } });
    const txt = await r.text();
    clearTimeout(t);
    let json = null; try { json = JSON.parse(txt); } catch (_) {}
    return { status: r.status, txt, json };
  } catch (e) { clearTimeout(t); return { status: 0, err: String(e.message || e) }; }
}

(async () => {
  const results = {};
  // concurrency cap manual
  const entries = Object.entries(core);
  const CONC = 6;
  for (let i = 0; i < entries.length; i += CONC) {
    const slice = entries.slice(i, i + CONC);
    await Promise.all(slice.map(async ([name, url]) => {
      const res = await getJson(url);
      results[name] = res;
      fs.writeFileSync(path.join(OUT, `${name}.json`), res.txt || JSON.stringify(res));
    }));
  }

  const out = [];
  const r = results;
  const j = (k) => r[k] && r[k].json;

  if (j('health')) {
    const h = r.health.json;
    out.push(`HEALTH status=${r.health.status} app=${h.status} db=${h.db} lastAnalysis=${h.lastAnalysis} pendingTips=${JSON.stringify(h.pendingTips)}`);
    if (h.alerts) out.push(`  alerts=${JSON.stringify(h.alerts).slice(0,500)}`);
    if (h.botGauges) out.push(`  botGauges=${JSON.stringify(h.botGauges).slice(0,400)}`);
  }
  if (j('p2_status')) {
    const p = r.p2_status.json;
    out.push(`P2 compliance=${p.compliance_summary||p.compliance} commit=${(p.version&&p.version.commit_short)||p.commit_short} msg=${(p.version&&p.version.commit_message||'').slice(0,60)}`);
    if (p.issues && p.issues.length) out.push(`  P2_ISSUES(${p.issues.length})=${JSON.stringify(p.issues).slice(0,700)}`);
    if (p.config) out.push(`  P2_config_keys=${Object.keys(p.config).join(',')}`);
  } else out.push(`P2 FAIL status=${r.p2_status.status} ${(r.p2_status.txt||r.p2_status.err||'').slice(0,150)}`);

  if (j('risk_metrics')) out.push(`RISK30d=${JSON.stringify(r.risk_metrics.json).slice(0,1800)}`);
  else out.push(`RISK FAIL status=${r.risk_metrics.status} ${(r.risk_metrics.txt||r.risk_metrics.err||'').slice(0,150)}`);

  if (j('env_audit')) {
    const e = r.env_audit.json;
    const issues = e.issues || e.findings || e.problems || e.gotchas || [];
    out.push(`ENV-AUDIT issues=${Array.isArray(issues)?issues.length:JSON.stringify(Object.keys(e))} ${Array.isArray(issues)&&issues.length?JSON.stringify(issues).slice(0,900):''}`);
  } else out.push(`ENV-AUDIT FAIL status=${r.env_audit.status} ${(r.env_audit.txt||r.env_audit.err||'').slice(0,150)}`);

  if (j('cron_status')) {
    const c = r.cron_status.json;
    const crons = c.crons || c.list || (Array.isArray(c)?c:[]);
    const arr = Array.isArray(crons)?crons:[];
    const stale = arr.filter(x => x && (x.is_stale || x.stale || x.status==='stale'));
    out.push(`CRON total=${arr.length} stale=${stale.length} ${stale.length?JSON.stringify(stale.map(s=>({n:s.name||s.id,age:s.age_min||s.ageMin||s.last_run_min_ago}))).slice(0,600):''}`);
  } else out.push(`CRON FAIL status=${r.cron_status.status} ${(r.cron_status.txt||r.cron_status.err||'').slice(0,150)}`);

  if (j('overfeaturing')) { const o = r.overfeaturing.json; out.push(`OVERFEAT=${JSON.stringify(o).slice(0,600)}`); }
  else out.push(`OVERFEAT FAIL status=${r.overfeaturing.status} ${(r.overfeaturing.txt||'').slice(0,120)}`);

  if (j('holdout')) { const hd = r.holdout.json; out.push(`HOLDOUT default_days=${hd.default_days} systems=${hd.per_system?Object.keys(hd.per_system).join(','):'?'}`); }
  else out.push(`HOLDOUT FAIL status=${r.holdout.status}`);

  if (j('disable_list')) {
    const d = r.disable_list.json;
    const list = d.list || d.disabled || d.entries || (Array.isArray(d)?d:[]);
    out.push(`DISABLE-LIST count=${Array.isArray(list)?list.length:JSON.stringify(Object.keys(d))} ${Array.isArray(list)?JSON.stringify(list).slice(0,800):JSON.stringify(d).slice(0,500)}`);
  } else out.push(`DISABLE-LIST FAIL status=${r.disable_list.status}`);

  out.push('\n=== ROI por sport (sport-detail) ===');
  for (const s of SPORTS) {
    const k = `sportdetail_${s}`;
    if (!j(k)) { out.push(`${s}: FAIL status=${r[k]&&r[k].status}`); continue; }
    const d = r[k].json;
    // tentar extrair ROI real/shadow + n
    const real = d.real || d.roi_real || (d.roi&&d.roi.real) || {};
    const shadow = d.shadow || d.roi_shadow || (d.roi&&d.roi.shadow) || {};
    const pend = d.pending ?? d.pendingTips ?? '?';
    const last = d.last_tip || d.lastTip || '?';
    const sumKeys = Object.keys(d).slice(0,12).join(',');
    out.push(`${s}: pending=${JSON.stringify(pend)} real=${JSON.stringify(real).slice(0,200)} shadow=${JSON.stringify(shadow).slice(0,160)} [keys:${sumKeys}]`);
  }

  out.push(`\nSaved ${Object.keys(results).length} JSON files → ${OUT}`);
  fs.writeFileSync(path.join(OUT, '_summary.txt'), out.join('\n'));
  console.log(out.join('\n'));
})();

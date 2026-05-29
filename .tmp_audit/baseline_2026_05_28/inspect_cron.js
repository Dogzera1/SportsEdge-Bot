const fs = require('fs');
const path = require('path');
function load(name) {
  let t = fs.readFileSync(path.join(__dirname, name + '.json'), 'utf8');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  return JSON.parse(t);
}
const c = load('cron_status');
console.log('CRON top-level keys:', Object.keys(c).join(', '));
console.log('summary:', JSON.stringify(c.summary));
const cr = c.crons;
if (cr) {
  const arr = Array.isArray(cr) ? cr : Object.entries(cr).map(([n,v]) => (typeof v==='object'?{name:n,...v}:{name:n,val:v}));
  console.log('crons count:', arr.length);
  console.log('sample:', JSON.stringify(arr[0]).slice(0,300));
  const prob = arr.filter(x => x.is_stale || x.stale || x.last_error || x.lastError || x.status==='stale' || x.status==='error' || x.healthy===false);
  console.log('PROBLEM crons:', prob.length);
  prob.forEach(x => console.log('  ', JSON.stringify(x).slice(0,220)));
  const aged = arr.map(x => ({ n: x.name, age: x.age_min ?? x.ageMin ?? x.last_run_min_ago ?? x.minutes_since ?? x.age ?? x.age_minutes ?? null, exp: x.expected_min ?? x.interval_min ?? x.interval ?? x.interval_minutes ?? null, err: x.last_error||x.lastError||null }))
    .filter(x => x.age != null).sort((a,b) => b.age - a.age);
  console.log('TOP 15 oldest crons:');
  aged.slice(0,15).forEach(x => console.log(`  ${x.n}: age=${x.age}min exp=${x.exp} err=${x.err?String(x.err).slice(0,60):''}`));
}
console.log('polls:', JSON.stringify(c.polls).slice(0,900));

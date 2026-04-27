#!/usr/bin/env node
// Lista tips MT shadow liquidadas (win/loss) que provavelmente estão erradas.
// Heurística (mesma lógica do void no settle pós-3b90e6d):
//  - esports total/handicap/handicapSets: line fora do range possível pro Bo real
//  - bestOf mismatch: shadow.best_of != actual bestOf parseado de final_score
// Uso:
//   node scripts/audit-mt-settled-suspects.js                  # default 14d, todos sports
//   node scripts/audit-mt-settled-suspects.js --sport=cs2 --days=30
//   DB_PATH=/data/sportsedge.db node scripts/audit-mt-settled-suspects.js

const path = require('path');
const Database = require('better-sqlite3');

const args = Object.fromEntries(process.argv.slice(2)
  .filter(a => a.startsWith('--'))
  .map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? '1']; }));

const DB_PATH = (process.env.DB_PATH || 'sportsedge.db').trim().replace(/^=+/, '');
const SPORT = args.sport || null;
const DAYS = Math.max(1, Math.min(180, parseInt(args.days || '14', 10) || 14));

const db = new Database(path.resolve(DB_PATH), { readonly: true });

const conds = [
  `result IN ('win','loss')`,
  `created_at >= datetime('now', '-${DAYS} days')`,
  `sport IN ('lol','dota2','cs2','valorant')`,
  `market IN ('handicap','handicapSets','total')`,
  `best_of IS NOT NULL AND best_of > 0`,
  `line IS NOT NULL`,
];
const params = [];
if (SPORT) { conds.push('sport = ?'); params.push(SPORT); }

const rows = db.prepare(`
  SELECT id, sport, team1, team2, league, market, line, side, odd, best_of,
         result, profit_units, created_at, settled_at
  FROM market_tips_shadow
  WHERE ${conds.join(' AND ')}
  ORDER BY id DESC
`).all(...params);

const suspects = [];
for (const r of rows) {
  const bo = r.best_of;
  const maxMargin = Math.ceil(bo / 2);
  const minTotal = Math.ceil(bo / 2);
  const maxTotal = bo;
  let reason = null;

  if (r.market === 'total') {
    if (r.line >= maxTotal) reason = `total line=${r.line} >= maxTotal=${maxTotal} (Bo${bo}) → under trivial`;
    else if (r.line < minTotal) reason = `total line=${r.line} < minTotal=${minTotal} (Bo${bo}) → over trivial`;
  } else if (r.market === 'handicap' || r.market === 'handicapSets') {
    if (Math.abs(r.line) > maxMargin) reason = `${r.market} |line|=${Math.abs(r.line)} > maxMargin=${maxMargin} (Bo${bo}) → trivial`;
  }
  if (reason) suspects.push({ ...r, _reason: reason });
}

console.log(`\n=== MT SETTLED SUSPECTS — line fora do range pro Bo real ===`);
console.log(`DB=${DB_PATH} sport=${SPORT || 'all'} days=${DAYS}`);
console.log(`Total settled scanned: ${rows.length} | Suspects: ${suspects.length}\n`);

if (!suspects.length) { console.log('Nenhum suspect encontrado.'); process.exit(0); }

console.log('id     sport   market         line  bo  side    result  profit  team1 vs team2');
console.log('-----------------------------------------------------------------------------------------');
for (const s of suspects) {
  const id = String(s.id).padEnd(6);
  const sport = String(s.sport).padEnd(7);
  const market = String(s.market).padEnd(14);
  const line = String(s.line).padStart(5);
  const bo = `Bo${s.best_of}`.padStart(3);
  const side = String(s.side || '-').padEnd(7);
  const result = String(s.result).padEnd(7);
  const profit = (s.profit_units != null ? s.profit_units.toFixed(2) : '-').padStart(7);
  console.log(`${id} ${sport} ${market} ${line}  ${bo} ${side} ${result} ${profit}  ${s.team1} vs ${s.team2}`);
}

console.log(`\nIDs (csv pra unsettle): ${suspects.map(s => s.id).join(',')}`);
console.log(`\nNext: POST /admin/unsettle-market-tips?ids=<csv> e depois /admin/settle-market-tips-shadow`);
console.log(`Ou de uma vez: POST /admin/mt-resettle-suspects?sport=${SPORT || 'all'}&days=${DAYS}&apply=1`);

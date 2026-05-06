const db = require('better-sqlite3')('sportsedge.db');

const imports = db.prepare('SELECT key, rows, imported_at FROM dataset_imports').all();
console.log('=== dataset_imports ===');
imports.forEach(x => console.log(' ', x.key.slice(0, 70), '| rows:', x.rows, '| at:', x.imported_at));

const range = db.prepare('SELECT MAX(resolved_at) as newest, MIN(resolved_at) as oldest, COUNT(*) as total FROM match_results WHERE game=?').get('football');
console.log('\n=== football match_results ===');
console.log('  Total:', range.total, '| From:', range.oldest, '| To:', range.newest);

const leagues = db.prepare('SELECT league, COUNT(*) as c FROM match_results WHERE game=? GROUP BY league ORDER BY c DESC LIMIT 10').all('football');
console.log('\n=== leagues ===');
leagues.forEach(x => console.log(' ', x.league, '=', x.c));

const recent2025 = db.prepare("SELECT team1, team2, resolved_at, league FROM match_results WHERE game='football' AND resolved_at >= '2025-01-01' ORDER BY resolved_at DESC LIMIT 5").all();
console.log('\n=== most recent 2025+ ===');
recent2025.forEach(x => console.log(' ', x.team1, 'vs', x.team2, '|', x.league, '|', x.resolved_at));

// Check if teams from logs are found
const testTeam = 'Frosinone';
const found = db.prepare("SELECT COUNT(*) as c FROM match_results WHERE game='football' AND (lower(team1) LIKE lower(?) OR lower(team2) LIKE lower(?))").get(`%${testTeam}%`, `%${testTeam}%`);
console.log('\n=== test Frosinone ===', found);

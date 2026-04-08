const db = require('better-sqlite3')('sportsedge.db');
const res = db.prepare("SELECT * FROM match_results WHERE game='tennis' LIMIT 3").all();
console.log(JSON.stringify(res, null, 2));

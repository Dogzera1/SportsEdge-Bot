#!/usr/bin/env node
// MMA coverage report — lista fighters presentes nas odds Pinnacle/feeds mas AUSENTES
// do esports_elo (MMA) ou com <3 lutas. Esses fighters fazem buildEsportsTrainedContext
// retornar null → trained model não fires → IA fica sem apoio → SEM_EDGE.
//
// Uso: node scripts/mma-coverage-report.js [--days=7]
//   Saída: JSON com {missing: [...], low_games: [...], top_gaps_by_event: [...]}
//   Útil como input pra priorizar backfill Sherdog/Tapology.

const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', process.env.DB_PATH || 'sportsedge.db'));

const argv = require('minimist')(process.argv.slice(2));
const days = parseInt(argv.days || '7', 10);

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Build MMA elo coverage set
const eloRows = db.prepare(`
  SELECT team1, team2, winner, league, resolved_at
  FROM match_results
  WHERE game = 'mma'
    AND team1 IS NOT NULL AND team2 IS NOT NULL
    AND winner IS NOT NULL AND resolved_at IS NOT NULL
`).all();

const fighterGames = new Map();
function bump(name) {
  if (!name) return;
  const k = norm(name);
  fighterGames.set(k, (fighterGames.get(k) || 0) + 1);
}
for (const r of eloRows) { bump(r.team1); bump(r.team2); }

// Fighters seen in recent tips (sport=mma, last N days)
const tipFighters = db.prepare(`
  SELECT DISTINCT participant1 AS p1, participant2 AS p2, event_name AS event
  FROM tips
  WHERE sport = 'mma'
    AND sent_at >= datetime('now', '-${days} days')
`).all();

// Fighters seen in rejections (captured more broadly)
let rejFighters = [];
try {
  rejFighters = db.prepare(`
    SELECT DISTINCT context AS ctx FROM rejections
    WHERE sport = 'mma' AND ts >= strftime('%s','now','-${days} days')*1000
  `).all().map(r => {
    try { const o = JSON.parse(r.ctx || '{}'); return o.teams || ''; }
    catch(_) { return ''; }
  });
} catch(_) {}

const seen = new Set();
const missing = [];
const lowGames = [];
const allPairs = [];

for (const row of tipFighters) {
  for (const name of [row.p1, row.p2]) {
    const k = norm(name);
    if (seen.has(k)) continue;
    seen.add(k);
    const games = fighterGames.get(k) || 0;
    if (games === 0) missing.push({ name, games: 0, event: row.event });
    else if (games < 3) lowGames.push({ name, games, event: row.event });
  }
  allPairs.push({ p1: row.p1, p2: row.p2, event: row.event });
}

// Events with most gaps (priority pra backfill)
const eventGaps = new Map();
for (const m of [...missing, ...lowGames]) {
  const ev = m.event || '?';
  eventGaps.set(ev, (eventGaps.get(ev) || 0) + 1);
}
const topEvents = [...eventGaps.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([event, gaps]) => ({ event, gaps }));

const report = {
  at: new Date().toISOString(),
  days_window: days,
  total_elo_fighters: fighterGames.size,
  total_tip_fighters: seen.size,
  missing_from_elo: missing.length,
  low_games_under3: lowGames.length,
  coverage_pct: seen.size > 0 ? +((seen.size - missing.length) / seen.size * 100).toFixed(1) : 0,
  missing: missing.slice(0, 50),
  low_games: lowGames.slice(0, 30),
  top_gap_events: topEvents,
};

console.log(JSON.stringify(report, null, 2));

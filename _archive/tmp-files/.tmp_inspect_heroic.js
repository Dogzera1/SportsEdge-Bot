const Database = require('better-sqlite3');
const db = new Database('sportsedge.db', { readonly: true });

console.log('=== Shadow rows HEROIC/Monte (recent) ===');
const shadow = db.prepare(`
  SELECT id, sport, team1, team2, league, market, line, side, odd, ev_pct, p_model,
         result, profit_units, stake_units, is_live, created_at, settled_at, best_of
  FROM market_tips_shadow
  WHERE (team1 LIKE '%HEROIC%' OR team1 LIKE '%Heroic%' OR team2 LIKE '%HEROIC%' OR team2 LIKE '%Heroic%'
      OR team1 LIKE '%Monte%' OR team2 LIKE '%Monte%')
    AND created_at >= datetime('now', '-5 days')
  ORDER BY created_at DESC LIMIT 10
`).all();
console.log(JSON.stringify(shadow, null, 2));

console.log('\n=== match_results HEROIC/Monte ===');
const mr = db.prepare(`
  SELECT id, game, team1, team2, league, winner, final_score, resolved_at, match_id
  FROM match_results
  WHERE game = 'cs2'
    AND (team1 LIKE '%HEROIC%' OR team1 LIKE '%Heroic%' OR team2 LIKE '%HEROIC%' OR team2 LIKE '%Heroic%'
      OR team1 LIKE '%Monte%' OR team2 LIKE '%Monte%')
    AND resolved_at >= datetime('now', '-7 days')
  ORDER BY resolved_at DESC LIMIT 15
`).all();
console.log(JSON.stringify(mr, null, 2));

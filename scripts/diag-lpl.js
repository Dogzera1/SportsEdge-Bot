/* eslint-disable no-console */
'use strict';

const initDatabase = require('../lib/database');

const { db } = initDatabase(process.env.DB_PATH || 'sportsedge.db');

function q(sql, params) {
  return db.prepare(sql).all(params || []);
}

const leaguesTop = q(
  "SELECT league, COUNT(1) AS c FROM match_results WHERE game='lol' GROUP BY league ORDER BY c DESC LIMIT 30"
);
const lplLeagues = q(
  "SELECT league, COUNT(1) AS c FROM match_results WHERE game='lol' AND lower(league) LIKE 'lpl%' GROUP BY league ORDER BY c DESC LIMIT 30"
);
const lplTeams = q(
  "SELECT DISTINCT t FROM (SELECT team1 AS t FROM match_results WHERE game='lol' AND lower(league) LIKE 'lpl%' UNION SELECT team2 AS t FROM match_results WHERE game='lol' AND lower(league) LIKE 'lpl%') WHERE t IS NOT NULL AND trim(t)!='' ORDER BY t COLLATE NOCASE LIMIT 80"
);

console.log(JSON.stringify({ leaguesTop, lplLeagues, lplTeamCount: lplTeams.length, lplTeams: lplTeams.slice(0, 40) }, null, 2));


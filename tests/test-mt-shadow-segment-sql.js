'use strict';

/**
 * tests/test-mt-shadow-segment-sql.js
 *
 * Valida que a SQL embutida em /market-tips-by-sport (server.js linha ~9655)
 * classifica markets corretamente em map vs series. Usa SQLite in-memory com
 * a mesma expressão CASE WHEN ... LIKE ... GLOB ...
 *
 * Sample data espelha snapshot prod 2026-05-10:
 *   LoL → total / total_kills_map1 / total_kills_map2 / total_kills_map3 / handicap
 *   CS  → total / handicap
 *   Dota2 → total / handicap / totalKills / mapWinner / map2Winner
 *
 * 2026-05-18: migrado de node:test pra runner custom (tests/run.js).
 */

const Database = require('better-sqlite3');

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE market_tips_shadow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT, market TEXT
    );
    INSERT INTO market_tips_shadow (sport, market) VALUES
      ('lol', 'total'),
      ('lol', 'total_kills_map1'),
      ('lol', 'total_kills_map2'),
      ('lol', 'total_kills_map3'),
      ('lol', 'handicap'),
      ('cs', 'total'),
      ('cs', 'handicap'),
      ('dota2', 'totalKills'),
      ('dota2', 'mapWinner'),
      ('dota2', 'map1Winner'),
      ('dota2', 'map2Winner'),
      ('valorant', 'correctScore');
  `);
  return db;
}

const SEGMENT_EXPR = `CASE
  WHEN lower(market) LIKE '%\\_map%' ESCAPE '\\' THEN 'map'
  WHEN lower(market) GLOB 'map[0-9]*winner' THEN 'map'
  WHEN lower(market) = 'mapwinner' THEN 'map'
  ELSE 'series'
END`;

module.exports = function(t) {
  t.test('SQL CASE classifica market real prod corretamente', () => {
    const db = setup();
    try {
      const rows = db.prepare(`
        SELECT sport, market, ${SEGMENT_EXPR} AS segment
        FROM market_tips_shadow
        ORDER BY id
      `).all();

      const expected = {
        'lol|total': 'series',
        'lol|total_kills_map1': 'map',
        'lol|total_kills_map2': 'map',
        'lol|total_kills_map3': 'map',
        'lol|handicap': 'series',
        'cs|total': 'series',
        'cs|handicap': 'series',
        'dota2|totalKills': 'series',
        'dota2|mapWinner': 'map',
        'dota2|map1Winner': 'map',
        'dota2|map2Winner': 'map',
        'valorant|correctScore': 'series',
      };
      for (const r of rows) {
        const key = `${r.sport}|${r.market}`;
        t.assert(r.segment === expected[key], `${key} → expected ${expected[key]} got ${r.segment}`);
      }
    } finally {
      db.close();
    }
  });

  t.test('GROUP BY (sport, segment) agrega contagens corretas', () => {
    const db = setup();
    try {
      const rows = db.prepare(`
        SELECT sport, ${SEGMENT_EXPR} AS segment, COUNT(*) AS n
        FROM market_tips_shadow
        GROUP BY sport, segment
        ORDER BY sport, segment
      `).all();

      // Esperado:
      //   cs       series 2 (total, handicap)
      //   dota2    map    3 (mapWinner, map1Winner, map2Winner)
      //   dota2    series 1 (totalKills)
      //   lol      map    3 (kills_map1/2/3)
      //   lol      series 2 (total, handicap)
      //   valorant series 1 (correctScore)
      const got = Object.fromEntries(rows.map(r => [`${r.sport}|${r.segment}`, r.n]));
      const want = {
        'cs|series': 2,
        'dota2|map': 3,
        'dota2|series': 1,
        'lol|map': 3,
        'lol|series': 2,
        'valorant|series': 1,
      };
      const gotKeys = Object.keys(got).sort();
      const wantKeys = Object.keys(want).sort();
      t.assert(gotKeys.length === wantKeys.length, `key count ${gotKeys.length} != ${wantKeys.length}`);
      for (const k of wantKeys) {
        t.assert(got[k] === want[k], `${k} → expected ${want[k]} got ${got[k]}`);
      }
    } finally {
      db.close();
    }
  });
};

#!/usr/bin/env node
// Calibração semanal: compara win rate real por nível de confiança
// Uso: node scripts/calibrate.js
require('dotenv').config({ override: true });
const initDatabase = require('../lib/database');

const DB_PATH = process.env.DB_PATH || 'sportsedge.db';
const { db } = initDatabase(DB_PATH);

const sports = ['mma', 'esports', 'tennis'];
console.log('\n=== CALIBRAÇÃO SportsEdge Bot ===\n');
console.log(`Data: ${new Date().toLocaleString('pt-BR')}\n`);

for (const sport of sports) {
  const rows = db.prepare(`
    SELECT confidence, COUNT(*) as total,
      SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
      ROUND(100.0 * SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate
    FROM tips WHERE sport = ? AND result IS NOT NULL
    GROUP BY confidence ORDER BY confidence
  `).all(sport);

  if (!rows.length) { console.log(`[${sport.toUpperCase()}] Sem tips settladas ainda.`); continue; }

  const total = rows.reduce((s, r) => s + r.total, 0);
  console.log(`[${sport.toUpperCase()}] ${total} tips settladas:`);
  for (const r of rows) {
    const flag = r.confidence === 'BAIXA' && r.total >= 30 && r.win_rate < 45 ? ' ⚠️  WIN RATE BAIXO — considere aumentar threshold de EV' : '';
    console.log(`  ${r.confidence || 'N/A'}: ${r.wins}/${r.total} (${r.win_rate}% WR)${flag}`);
  }

  // Overall ROI
  const roi = db.prepare(`
    SELECT
      ROUND(SUM(CASE WHEN result='win' THEN (odds - 1) * CAST(REPLACE(stake, 'u', '') AS REAL) ELSE -CAST(REPLACE(stake, 'u', '') AS REAL) END), 2) as profit,
      ROUND(SUM(CAST(REPLACE(stake, 'u', '') AS REAL)), 2) as staked
    FROM tips WHERE sport = ? AND result IS NOT NULL AND stake IS NOT NULL
  `).get(sport);
  if (roi?.staked > 0) {
    const roiPct = ((roi.profit / roi.staked) * 100).toFixed(1);
    console.log(`  ROI: ${roiPct}% (profit: ${roi.profit > 0 ? '+' : ''}${roi.profit}u em ${roi.staked}u apostados)`);
  }
  console.log('');
}

process.exit(0);

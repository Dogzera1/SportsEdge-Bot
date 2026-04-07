#!/usr/bin/env node
'use strict';

require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');
const { norm } = require('../lib/utils');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || args.includes('-n');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db'))
  .toString()
  .trim()
  .replace(/^=+/, '');

function hasTable(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch (_) {
    return false;
  }
}

function getCols(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  } catch (_) {
    return [];
  }
}

function pickClosingField(tipCols) {
  if (tipCols.includes('closing_odds')) return 'closing_odds';
  if (tipCols.includes('clv_odds')) return 'clv_odds';
  return null;
}

function safeNumber(x) {
  const n = parseFloat(x);
  return isFinite(n) ? n : null;
}

async function main() {
  console.log(`DB: ${DB_PATH}`);
  console.log(`Dry-run: ${DRY_RUN ? 'ON' : 'OFF'}`);

  const { db } = initDatabase(DB_PATH);

  if (!hasTable(db, 'tips')) {
    console.log('Tabela tips ausente.');
    process.exit(0);
  }

  const tipCols = getCols(db, 'tips');
  const closingField = pickClosingField(tipCols);
  if (!closingField) {
    console.log('Campo closing inexistente.');
    console.log('Esperado: closing_odds/clv_odds.');
    process.exit(0);
  }

  const hasOddsHistory = hasTable(db, 'odds_history');
  const hasMatches = hasTable(db, 'matches');
  const hasClvPct = tipCols.includes('clv_pct');
  const hasClvUpdatedAt = tipCols.includes('clv_updated_at');
  const hasCurrentOdds = tipCols.includes('current_odds');

  const selectSql = `
    SELECT
      id, sport, match_id, participant1, participant2, tip_participant,
      odds, open_odds, current_odds, sent_at, settled_at, result
    FROM tips
    WHERE result IN ('win', 'loss')
      AND (${closingField} IS NULL OR ${closingField} = 0)
    ORDER BY sent_at ASC
  `;

  let tips = [];
  try {
    tips = db.prepare(selectSql).all();
  } catch (e) {
    console.log('Falha query tips.');
    console.log(e.message);
    process.exit(0);
  }

  if (!tips.length) {
    console.log('Nada para backfill.');
    process.exit(0);
  }

  const getMatchTime = (hasMatches && getCols(db, 'matches').includes('match_time'))
    ? db.prepare('SELECT match_time FROM matches WHERE id = ? LIMIT 1')
    : null;

  const getLastOddsAny = hasOddsHistory
    ? db.prepare(`
        SELECT participant1, participant2, odds_p1, odds_p2, recorded_at
        FROM odds_history
        WHERE sport = ? AND match_key = ?
        ORDER BY recorded_at DESC
        LIMIT 1
      `)
    : null;

  const getLastOddsBefore = (hasOddsHistory && getMatchTime)
    ? db.prepare(`
        SELECT participant1, participant2, odds_p1, odds_p2, recorded_at
        FROM odds_history
        WHERE sport = ? AND match_key = ? AND recorded_at <= ?
        ORDER BY recorded_at DESC
        LIMIT 1
      `)
    : null;

  const updateSqlParts = [];
  updateSqlParts.push(`${closingField} = @closingOdds`);
  if (hasClvPct) updateSqlParts.push(`clv_pct = @clvPct`);
  if (hasClvUpdatedAt) updateSqlParts.push(`clv_updated_at = datetime('now')`);

  const updateTip = db.prepare(`
    UPDATE tips
    SET ${updateSqlParts.join(', ')}
    WHERE id = @id
  `);

  const tx = db.transaction((rows) => {
    let updated = 0;
    for (const tip of rows) {
      const tipOdds = safeNumber(tip.odds);
      if (!tipOdds || tipOdds <= 1) continue;

      const p1 = tip.participant1 || '';
      const p2 = tip.participant2 || '';
      const tp = tip.tip_participant || '';
      if (!p1 || !p2 || !tp) continue;

      const matchKey = `${norm(p1)}_${norm(p2)}`;

      let matchTime = null;
      if (getMatchTime && tip.match_id) {
        try {
          matchTime = getMatchTime.get(String(tip.match_id))?.match_time || null;
        } catch (_) {}
      }

      let oh = null;
      if (getLastOddsBefore && matchTime) {
        try { oh = getLastOddsBefore.get(tip.sport, matchKey, matchTime); } catch (_) {}
      }
      if (!oh && getLastOddsAny) {
        try { oh = getLastOddsAny.get(tip.sport, matchKey); } catch (_) {}
      }

      let closingOdds = null;

      if (oh) {
        const ohP1 = oh.participant1 || '';
        const ohP2 = oh.participant2 || '';
        const tipPick = norm(tp);
        const isP1 =
          tipPick === norm(p1) || tipPick === norm(ohP1);
        const isP2 =
          tipPick === norm(p2) || tipPick === norm(ohP2);

        if (isP1) closingOdds = safeNumber(oh.odds_p1);
        else if (isP2) closingOdds = safeNumber(oh.odds_p2);
        else {
          // fallback: se não casar, usa odds_p1 (primeira coluna)
          closingOdds = safeNumber(oh.odds_p1) || safeNumber(oh.odds_p2);
        }
      }

      if (!closingOdds || closingOdds <= 1) {
        // fallback: último odds conhecido no tip
        const fallback =
          (hasCurrentOdds ? safeNumber(tip.current_odds) : null) ||
          safeNumber(tip.open_odds) ||
          tipOdds;
        if (fallback && fallback > 1) closingOdds = fallback;
      }

      if (!closingOdds || closingOdds <= 1) continue;

      const clvPct = (tipOdds / closingOdds - 1) * 100;

      if (!DRY_RUN) {
        updateTip.run({
          id: tip.id,
          closingOdds,
          clvPct: hasClvPct ? clvPct : undefined
        });
      }
      updated++;
    }
    return updated;
  });

  const updated = tx(tips);

  console.log(`Tips alvo: ${tips.length}`);
  console.log(`Tips atualizadas: ${updated}`);
  if (hasOddsHistory) console.log('Fonte: odds_history.');
  else console.log('Fonte: fallback tip.');

  db.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});


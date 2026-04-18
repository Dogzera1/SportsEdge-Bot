#!/usr/bin/env node
'use strict';

// scripts/rerun-pending-tips.js
//
// Re-analisa tips pendentes (result NULL ou 'pending') com os novos modelos
// treinados. Pra cada tip, recomputa P via predictTrainedEsports/predictTrainedTennis
// mantendo as odds originais, e calcula novo EV.
//
// Uso:
//   node scripts/rerun-pending-tips.js                 # dry-run (default)
//   node scripts/rerun-pending-tips.js --apply         # grava em model_p1/p2/current_ev/current_confidence

require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');
const { predictTrainedEsports, hasTrainedModel } = require('../lib/esports-model-trained');
const { predictTrainedTennis, hasTrainedModel: hasTrainedTennis } = require('../lib/tennis-model-trained');
const { buildTrainedContext } = require('../lib/esports-runtime-features');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const VERBOSE = argv.includes('--verbose');

const { db } = initDatabase(DB_PATH);

// Map sport → game code do trained model esports
const SPORT_TO_ES_GAME = {
  esports: 'lol',     // esports = LoL (separado de dota/cs/valorant)
  lol: 'lol',
  dota: 'dota2',
  dota2: 'dota2',
  cs: 'cs2',
  cs2: 'cs2',
  valorant: 'valorant',
};

function pick(row) {
  return row.tip_participant === row.participant1 ? 'p1' : 'p2';
}

function fairFromOdds(o1, o2) {
  const r1 = 1 / o1, r2 = 1 / o2;
  const or = r1 + r2;
  return { p1: r1 / or, p2: r2 / or, margin: or - 1 };
}

async function main() {
  const tips = db.prepare(`
    SELECT id, sport, match_id, participant1, participant2, tip_participant,
           odds, ev, stake, confidence, is_live, sent_at,
           model_p1, model_p2, current_odds, event_name
    FROM tips
    WHERE result IS NULL OR result = 'pending'
    ORDER BY sent_at DESC
  `).all();

  console.log(`[rerun] ${tips.length} tips pendentes`);
  if (!tips.length) return;

  const updateStmt = db.prepare(`
    UPDATE tips SET model_p1=?, model_p2=?, current_ev=?, current_confidence=?, current_updated_at=datetime('now') WHERE id=?
  `);

  const out = [];
  let updates = 0, skipped = 0;

  for (const t of tips) {
    const sport = t.sport.toLowerCase();
    const esGame = SPORT_TO_ES_GAME[sport];
    const oddsStored = parseFloat(t.odds) || 0;
    if (!oddsStored) { skipped++; continue; }

    let newP1 = null, newP2 = null, method = '', conf = null;

    try {
      if (sport === 'tennis' && hasTrainedTennis()) {
        // pra tênis precisaríamos reconstruir o contexto (Elo/surface/enrich) — pulamos
        // porque o runtime real já enrichar durante o bot. Aqui marca "pendente de retry".
        skipped++;
        continue;
      }
      if (esGame && hasTrainedModel(esGame)) {
        const match = { team1: t.participant1, team2: t.participant2, league: t.event_name || '', format: 'Bo3' };
        const ctx = buildTrainedContext(db, esGame, match);
        if (!ctx) { skipped++; continue; }
        const p = predictTrainedEsports(esGame, ctx);
        if (!p) { skipped++; continue; }
        newP1 = p.p1; newP2 = p.p2; method = p.method; conf = p.confidence;
      } else { skipped++; continue; }
    } catch (e) { skipped++; continue; }

    // EV: usa odds originais + P do modelo no lado da tip
    const pickSide = pick(t);
    const newPpick = pickSide === 'p1' ? newP1 : newP2;
    const oddPick = oddsStored; // odds originais do tip
    const newEV = (newPpick * oddPick - 1) * 100;
    const oldPpick = pickSide === 'p1' ? (t.model_p1 || 0.5) : (t.model_p2 || 0.5);
    const oldEV = (oldPpick * oddPick - 1) * 100;
    const fair = fairFromOdds(oddPick, pickSide === 'p1' ? (t.current_odds || 2) : (t.current_odds || 2));

    const row = {
      id: t.id,
      sport,
      match: `${t.participant1} vs ${t.participant2}`,
      pick: t.tip_participant,
      odds: oddPick,
      oldP: (oldPpick * 100).toFixed(1) + '%',
      newP: (newPpick * 100).toFixed(1) + '%',
      oldEV: oldEV.toFixed(1) + '%',
      newEV: newEV.toFixed(1) + '%',
      delta: ((newPpick - oldPpick) * 100).toFixed(1) + 'pp',
      method,
      verdict: newEV >= 5 ? '✅ mantém' : newEV >= 0 ? '⚠️ enfraqueceu' : '❌ negativo',
    };
    out.push(row);

    if (APPLY) {
      updateStmt.run(newP1, newP2, newEV, conf, t.id);
      updates++;
    }
  }

  // Print table
  console.log(`\n${'ID'.padEnd(4)} ${'pick'.padEnd(22)} ${'odds'.padEnd(6)} ${'oldP'.padEnd(8)} ${'newP'.padEnd(8)} ${'Δ'.padEnd(8)} ${'oldEV'.padEnd(8)} ${'newEV'.padEnd(8)} verdict`);
  console.log('─'.repeat(100));
  for (const r of out) {
    console.log(`${String(r.id).padEnd(4)} ${r.pick.slice(0, 21).padEnd(22)} ${String(r.odds).padEnd(6)} ${r.oldP.padEnd(8)} ${r.newP.padEnd(8)} ${r.delta.padEnd(8)} ${r.oldEV.padEnd(8)} ${r.newEV.padEnd(8)} ${r.verdict}`);
    if (VERBOSE) console.log(`     ${r.match} | ${r.method}`);
  }

  console.log(`\n[rerun] total=${tips.length} | avaliados=${out.length} | skipped=${skipped} | ${APPLY ? `applied=${updates}` : 'dry-run (use --apply pra salvar)'}`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

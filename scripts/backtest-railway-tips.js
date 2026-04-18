#!/usr/bin/env node
'use strict';

// scripts/backtest-railway-tips.js
//
// Puxa TODAS tips de prod (Railway) via /tips-history e roda backtest
// retrospectivo com os novos modelos treinados localmente.
//
// Uso:
//   node scripts/backtest-railway-tips.js
//   node scripts/backtest-railway-tips.js --ev-threshold 5 --sports esports,tennis,mma

require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');
const { predictTrainedEsports, hasTrainedModel } = require('../lib/esports-model-trained');
const { buildTrainedContext } = require('../lib/esports-runtime-features');
const { predictTrainedTennis, hasTrainedModel: hasTrainedTennis, getTennisRecentMomentum } = require('../lib/tennis-model-trained');
const { getTennisElo, extractSurface } = require('../lib/tennis-ml');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const RAILWAY_BASE = process.env.RAILWAY_BASE || 'https://sportsedge-bot-production.up.railway.app';

const argv = process.argv.slice(2);
function argVal(n, d) {
  const i = argv.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const EV_THRESHOLD = parseFloat(argVal('ev-threshold', '5'));
const SPORTS = argVal('sports', 'esports,tennis,mma,football,dota,cs,valorant').split(',').map(s => s.trim());

const { db } = initDatabase(DB_PATH);

const SPORT_TO_GAME = {
  esports: 'lol', lol: 'lol',
  dota: 'dota2', dota2: 'dota2',
  cs: 'cs2', cs2: 'cs2',
  valorant: 'valorant',
};

function getJson(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function fetchTipsFor(sport) {
  const url = `${RAILWAY_BASE}/tips-history?limit=200&sport=${encodeURIComponent(sport)}`;
  try {
    const arr = await getJson(url);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function predictNew(sport, t) {
  const odds = parseFloat(t.odds) || 0;
  if (!odds) return null;

  if (sport === 'tennis') {
    if (!hasTrainedTennis()) return null;
    const league = t.event_name || '';
    const surface = extractSurface(league);
    const elo = getTennisElo(db, t.participant1, t.participant2, surface, 0.5, 0.5);
    if (!elo || !elo.found1 || !elo.found2) return null;
    const m1 = getTennisRecentMomentum(db, t.participant1, t.sent_at);
    const m2 = getTennisRecentMomentum(db, t.participant2, t.sent_at);
    const winStreakDiff = (m1?.streak || 0) - (m2?.streak || 0);
    const wrLast10Diff = (m1?.wrLast10 != null && m2?.wrLast10 != null)
      ? (m1.wrLast10 - m2.wrLast10) : 0;
    return predictTrainedTennis({
      eloOverall1: elo.eloOverall1 || elo.elo1,
      eloOverall2: elo.eloOverall2 || elo.elo2,
      eloSurface1: elo.eloSurface1 || elo.elo1,
      eloSurface2: elo.eloSurface2 || elo.elo2,
      gamesSurface1: elo.surfMatches1, gamesSurface2: elo.surfMatches2,
      surface,
      bestOf: /grand slam|wimbledon|us open|roland|australian/i.test(league) ? 5 : 3,
      winStreakDiff, wrLast10Diff,
    });
  }
  const game = SPORT_TO_GAME[sport];
  if (!game || !hasTrainedModel(game)) return null;
  const match = { team1: t.participant1, team2: t.participant2, league: t.event_name || '', format: 'Bo3' };
  const ctx = buildTrainedContext(db, game, match);
  if (!ctx) return null;
  return predictTrainedEsports(game, ctx);
}

function stats(rows, label) {
  if (!rows.length) return null;
  const brier = rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rows.length;
  const hits = rows.filter(r => (r.p >= 0.5 ? 1 : 0) === r.y).length;
  const logLoss = rows.reduce((s, r) => {
    const p = Math.max(1e-9, Math.min(1 - 1e-9, r.p));
    return s - (r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p));
  }, 0) / rows.length;
  return { n: rows.length, brier, acc: hits / rows.length, logLoss };
}

async function main() {
  console.log(`[backtest-railway] fetching tips from ${RAILWAY_BASE}`);
  const all = {};
  for (const s of SPORTS) {
    const tips = await fetchTipsFor(s);
    all[s] = tips;
    const settled = tips.filter(t => t.result === 'win' || t.result === 'loss');
    console.log(`  ${s.padEnd(10)} total=${tips.length} settled=${settled.length}`);
  }

  console.log(`\n══════════════ BACKTEST POR SPORT ══════════════`);

  let globalOld = [], globalNew = [];
  let globalProfit = 0, globalProfitFiltered = 0;

  for (const sport of SPORTS) {
    const tips = all[sport];
    if (!tips || !tips.length) continue;
    const settled = tips.filter(t => t.result === 'win' || t.result === 'loss');
    if (!settled.length) continue;

    const evaluated = [];
    let skipped = 0;
    for (const t of settled) {
      const pred = predictNew(sport, t);
      if (!pred) { skipped++; continue; }
      const pickSide = t.tip_participant === t.participant1 ? 'p1' : 'p2';
      const oldPpick = pickSide === 'p1' ? (t.model_p1 || 0.5) : (t.model_p2 || 0.5);
      const newPpick = pickSide === 'p1' ? pred.p1 : pred.p2;
      const odds = parseFloat(t.odds);
      const newEV = (newPpick * odds - 1) * 100;
      const y = t.result === 'win' ? 1 : 0;
      evaluated.push({
        id: t.id, sport, pick: t.tip_participant, odds,
        oldP: oldPpick, newP: newPpick,
        oldEV: (oldPpick * odds - 1) * 100,
        newEV,
        outcome: y,
        profit: +t.profit_reais || 0,
        result: t.result,
      });
    }

    if (!evaluated.length) {
      console.log(`\n── ${sport.toUpperCase()} — n=${settled.length} settled, 0 avaliáveis (skipped=${skipped}) ──`);
      continue;
    }

    const oldPairs = evaluated.map(r => ({ p: r.oldP, y: r.outcome }));
    const newPairs = evaluated.map(r => ({ p: r.newP, y: r.outcome }));
    const sOld = stats(oldPairs);
    const sNew = stats(newPairs);

    const profitTotal = evaluated.reduce((s, r) => s + r.profit, 0);
    const profitKept = evaluated.filter(r => r.newEV >= EV_THRESHOLD).reduce((s, r) => s + r.profit, 0);
    const nKept = evaluated.filter(r => r.newEV >= EV_THRESHOLD).length;

    console.log(`\n── ${sport.toUpperCase()} — avaliados=${evaluated.length}/${settled.length} (skipped=${skipped}) ──`);
    console.log(`Brier:    old=${sOld.brier.toFixed(4)}  new=${sNew.brier.toFixed(4)}  ${sNew.brier < sOld.brier ? '✅' : '❌'} (Δ=${(sNew.brier - sOld.brier).toFixed(4)})`);
    console.log(`LogLoss:  old=${sOld.logLoss.toFixed(4)}  new=${sNew.logLoss.toFixed(4)}`);
    console.log(`Hit@0.5:  old=${(sOld.acc * 100).toFixed(1)}%  new=${(sNew.acc * 100).toFixed(1)}%`);
    console.log(`Profit real: R$${profitTotal.toFixed(2)} | Se filtrado (newEV≥${EV_THRESHOLD}%): ${nKept} tips, R$${profitKept.toFixed(2)}`);

    globalOld.push(...oldPairs);
    globalNew.push(...newPairs);
    globalProfit += profitTotal;
    globalProfitFiltered += profitKept;
  }

  // ── Global agregado ──
  console.log(`\n══════════════ AGREGADO (todas settled avaliadas) ══════════════`);
  const sG_old = stats(globalOld);
  const sG_new = stats(globalNew);
  if (sG_old && sG_new) {
    console.log(`N total:  ${sG_new.n}`);
    console.log(`Brier:    old=${sG_old.brier.toFixed(4)}  new=${sG_new.brier.toFixed(4)}  Δ=${(sG_new.brier - sG_old.brier).toFixed(4)}`);
    console.log(`LogLoss:  old=${sG_old.logLoss.toFixed(4)}  new=${sG_new.logLoss.toFixed(4)}`);
    console.log(`Hit@0.5:  old=${(sG_old.acc * 100).toFixed(1)}%  new=${(sG_new.acc * 100).toFixed(1)}%`);
    console.log(`Profit real: R$${globalProfit.toFixed(2)} | Filtered (newEV≥${EV_THRESHOLD}%): R$${globalProfitFiltered.toFixed(2)} (Δ R$${(globalProfitFiltered - globalProfit).toFixed(2)})`);
  }

  console.log(`\n(note: tennis 'skipped' frequentemente = times sem histórico no Elo local — DB de match_results é limitado)`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

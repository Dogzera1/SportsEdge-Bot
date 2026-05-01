#!/usr/bin/env node
'use strict';

// scripts/backtest-new-models.js
//
// Backtest retrospectivo: re-avalia TODAS as tips (settled + pending) com os
// novos modelos treinados. Pra settled tips, compara performance (Brier, hit
// rate, ROI hipotético se seguíssemos o filtro do novo modelo).
//
// Uso:
//   node scripts/backtest-new-models.js
//   node scripts/backtest-new-models.js --ev-threshold 5  (filtro novo modelo)

require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');
const { predictTrainedEsports, hasTrainedModel } = require('../lib/esports-model-trained');
const { buildTrainedContext } = require('../lib/esports-runtime-features');
const { predictTrainedTennis, hasTrainedModel: hasTrainedTennis } = require('../lib/tennis-model-trained');
const { getTennisElo, extractSurface } = require('../lib/tennis-ml');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const argv = process.argv.slice(2);
function argVal(n, d) {
  const i = argv.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const EV_THRESHOLD = parseFloat(argVal('ev-threshold', '5'));

const { db } = initDatabase(DB_PATH);

const SPORT_TO_GAME = {
  esports: 'lol', lol: 'lol',
  dota: 'dota2', dota2: 'dota2',
  cs: 'cs2', cs2: 'cs2',
  valorant: 'valorant',
};

async function main() {
  // Filtra tips pra POST-TRAINING period — re-avaliar tips que estavam no train
  // set conflate train+test e infla métricas. Pega o trainedAt mais recente
  // entre todos os modelos pra ser conservador.
  const fs = require('fs');
  const trainedAts = [];
  for (const f of ['lol-weights.json', 'dota2-weights.json', 'cs2-weights.json',
                   'valorant-weights.json', 'tennis-weights.json']) {
    try {
      const w = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8'));
      if (w.trainedAt) trainedAts.push(new Date(w.trainedAt).toISOString());
    } catch (_) {}
  }
  const cutoff = trainedAts.length ? trainedAts.sort().pop() : null;
  if (cutoff) {
    console.log(`[backtest] cutoff: tips com sent_at > ${cutoff} (post-training period)`);
  }
  const sql = cutoff
    ? `SELECT id, sport, match_id, participant1, participant2, tip_participant,
              odds, ev, stake, confidence, is_live, sent_at, result,
              model_p1, model_p2, event_name, profit_reais, stake_reais
       FROM tips WHERE sent_at > ? ORDER BY sent_at ASC`
    : `SELECT id, sport, match_id, participant1, participant2, tip_participant,
              odds, ev, stake, confidence, is_live, sent_at, result,
              model_p1, model_p2, event_name, profit_reais, stake_reais
       FROM tips ORDER BY sent_at ASC`;
  const tips = cutoff ? db.prepare(sql).all(cutoff) : db.prepare(sql).all();

  console.log(`[backtest] ${tips.length} tips totais (pós-cutoff)`);
  const settled = tips.filter(t => t.result === 'win' || t.result === 'loss');
  const pending = tips.filter(t => t.result === null || t.result === 'pending');
  console.log(`[backtest] settled: ${settled.length} | pending: ${pending.length}`);

  // Processar cada tip
  const rows = [];
  let skipped = 0;

  for (const t of tips) {
    const sport = t.sport.toLowerCase();
    const odds = parseFloat(t.odds) || 0;
    if (!odds) { skipped++; continue; }

    let newP1, newP2, method;

    if (sport === 'tennis') {
      if (!hasTrainedTennis()) { skipped++; continue; }
      const league = t.event_name || '';
      const surface = extractSurface(league);
      const elo = getTennisElo(db, t.participant1, t.participant2, surface, 0.5, 0.5);
      if (!elo || !elo.found1 || !elo.found2) { skipped++; continue; }
      const p = predictTrainedTennis({
        eloOverall1: elo.eloOverall1 || elo.elo1,
        eloOverall2: elo.eloOverall2 || elo.elo2,
        eloSurface1: elo.eloSurface1 || elo.elo1,
        eloSurface2: elo.eloSurface2 || elo.elo2,
        gamesSurface1: elo.surfMatches1, gamesSurface2: elo.surfMatches2,
        surface,
        bestOf: /grand slam|wimbledon|us open|roland|australian/i.test(league) ? 5 : 3,
      });
      if (!p) { skipped++; continue; }
      newP1 = p.p1; newP2 = p.p2; method = p.method;
    } else {
      const game = SPORT_TO_GAME[sport];
      if (!game || !hasTrainedModel(game)) { skipped++; continue; }
      const match = { team1: t.participant1, team2: t.participant2, league: t.event_name || '', format: 'Bo3' };
      const ctx = buildTrainedContext(db, game, match);
      if (!ctx) { skipped++; continue; }
      const p = predictTrainedEsports(game, ctx);
      if (!p) { skipped++; continue; }
      newP1 = p.p1; newP2 = p.p2; method = p.method;
    }

    const pickSide = t.tip_participant === t.participant1 ? 'p1' : 'p2';
    const oldPpick = pickSide === 'p1' ? (t.model_p1 || 0.5) : (t.model_p2 || 0.5);
    const newPpick = pickSide === 'p1' ? newP1 : newP2;
    const oldEV = (oldPpick * odds - 1) * 100;
    const newEV = (newPpick * odds - 1) * 100;
    const outcome = t.result === 'win' ? 1 : t.result === 'loss' ? 0 : null;

    rows.push({
      id: t.id, sport,
      pick: t.tip_participant, odds,
      oldPpick, newPpick, oldEV, newEV,
      result: t.result, outcome,
      profit_reais: t.profit_reais,
      stake: t.stake,
    });
  }

  // ── Summary por sport ──
  const bySport = {};
  for (const r of rows) {
    if (!bySport[r.sport]) bySport[r.sport] = { total: 0, settled: 0, skipped: 0 };
    bySport[r.sport].total++;
    if (r.outcome !== null) bySport[r.sport].settled++;
  }
  console.log(`\n── Cobertura por sport ──`);
  for (const [s, v] of Object.entries(bySport)) {
    console.log(`  ${s.padEnd(10)} avaliados=${v.total} settled=${v.settled}`);
  }

  // ── Métricas sobre settled ──
  const settledRows = rows.filter(r => r.outcome !== null);
  console.log(`\n[backtest] settled avaliados: ${settledRows.length}`);
  if (settledRows.length === 0) { console.log('sem settled avaliáveis'); return; }

  function brier(arr) { return arr.reduce((s, r) => s + (r[0] - r[1]) ** 2, 0) / arr.length; }
  function logLoss(arr) {
    return arr.reduce((s, r) => {
      const p = Math.max(1e-9, Math.min(1 - 1e-9, r[0]));
      return s - (r[1] * Math.log(p) + (1 - r[1]) * Math.log(1 - p));
    }, 0) / arr.length;
  }
  function hitRate(arr) { return arr.filter(r => (r[0] >= 0.5 ? 1 : 0) === r[1]).length / arr.length; }

  const oldPairs = settledRows.map(r => [r.oldPpick, r.outcome]);
  const newPairs = settledRows.map(r => [r.newPpick, r.outcome]);

  console.log(`\n── Modelo antigo (stored) vs Novo (trained) em ${settledRows.length} settled ──`);
  console.log(`Brier:    old=${brier(oldPairs).toFixed(4)}  new=${brier(newPairs).toFixed(4)}  ${brier(newPairs) < brier(oldPairs) ? '✅ novo melhor' : '❌ novo pior'}`);
  console.log(`LogLoss:  old=${logLoss(oldPairs).toFixed(4)}  new=${logLoss(newPairs).toFixed(4)}`);
  console.log(`Hit@0.5:  old=${(hitRate(oldPairs) * 100).toFixed(1)}%  new=${(hitRate(newPairs) * 100).toFixed(1)}%`);

  // ── ROI real (settled apenas) ──
  const realProfit = settledRows.reduce((s, r) => s + (+r.profit_reais || 0), 0);
  const realStake = settledRows.reduce((s, r) => s + (+r.stake || 0), 0);
  console.log(`\n── ROI real (todas settled executadas) ──`);
  console.log(`Tips: ${settledRows.length} | Stake total (u): ${realStake.toFixed(2)} | Profit: R$${realProfit.toFixed(2)}`);

  // ── ROI hipotético: só tips com newEV >= threshold ──
  const kept = settledRows.filter(r => r.newEV >= EV_THRESHOLD);
  const skippedByNew = settledRows.filter(r => r.newEV < EV_THRESHOLD);
  console.log(`\n── Cenário: só acatar tips com newEV ≥ ${EV_THRESHOLD}% ──`);
  console.log(`Aceitas: ${kept.length} / ${settledRows.length} (${((kept.length / settledRows.length) * 100).toFixed(0)}%)`);
  const profitKept = kept.reduce((s, r) => s + (+r.profit_reais || 0), 0);
  const stakeKept = kept.reduce((s, r) => s + (+r.stake || 0), 0);
  console.log(`Profit subset: R$${profitKept.toFixed(2)} (stake R$${stakeKept.toFixed(2)})`);
  const wouldSkipProfit = skippedByNew.reduce((s, r) => s + (+r.profit_reais || 0), 0);
  console.log(`Profit das tips FILTRADAS pelo novo modelo: R$${wouldSkipProfit.toFixed(2)}  ${wouldSkipProfit < 0 ? '✅ novo modelo evitaria essas' : '⚠️ novo modelo pulou ganhadoras'}`);

  // ── Hit rate por bucket de P (novo modelo) ──
  const buckets = [[0, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]];
  console.log(`\n── Calibração novo modelo (buckets de newPpick) ──`);
  console.log(`bucket          n    hits   WR      avg_P`);
  for (const [lo, hi] of buckets) {
    const inB = settledRows.filter(r => r.newPpick >= lo && r.newPpick < hi);
    if (!inB.length) continue;
    const hits = inB.filter(r => r.outcome === 1).length;
    const wr = (hits / inB.length * 100).toFixed(1);
    const avgP = (inB.reduce((s, r) => s + r.newPpick, 0) / inB.length * 100).toFixed(1);
    console.log(`${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%          ${String(inB.length).padStart(3)}  ${String(hits).padStart(3)}    ${wr}%   ${avgP}%`);
  }

  // ── Tabela detalhada ──
  console.log(`\n── Detalhe settled (${settledRows.length} tips) ──`);
  console.log(`${'ID'.padEnd(4)} ${'result'.padEnd(7)} ${'pick'.padEnd(22)} ${'odd'.padEnd(6)} ${'oldP'.padEnd(7)} ${'newP'.padEnd(7)} ${'oldEV'.padEnd(8)} ${'newEV'.padEnd(8)} ${'profit'.padEnd(10)} verdict`);
  console.log('─'.repeat(100));
  for (const r of settledRows) {
    const profStr = (+r.profit_reais || 0).toFixed(2);
    const wouldSkip = r.newEV < EV_THRESHOLD;
    const verdict = r.outcome === 1
      ? (wouldSkip ? '⚠️ filtrada mas venceu' : '✅ aceita e venceu')
      : (wouldSkip ? '✅ filtrada (perdeu)' : '❌ aceita e perdeu');
    console.log(
      `${String(r.id).padEnd(4)} ${String(r.result).padEnd(7)} ${String(r.pick).slice(0, 21).padEnd(22)} ${String(r.odds).padEnd(6)} ${(r.oldPpick * 100).toFixed(0) + '%'.padEnd(3)} ${(r.newPpick * 100).toFixed(0) + '%'.padEnd(3)} ${r.oldEV.toFixed(1) + '%'.padEnd(4)} ${r.newEV.toFixed(1) + '%'.padEnd(4)} R$${profStr.padEnd(7)} ${verdict}`
    );
  }

  console.log(`\n[backtest] total=${tips.length} avaliados=${rows.length} skipped=${skipped}`);
  console.log(`\n⚠️  AMOSTRA PEQUENA (${settledRows.length} settled) — métricas têm variância alta. Use como sinal, não conclusão.`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

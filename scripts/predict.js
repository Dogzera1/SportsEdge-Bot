#!/usr/bin/env node
'use strict';
/**
 * scripts/predict.js — Predições standalone para próximas partidas
 *
 * Roda o modelo ML (sem IA) nas partidas do DB que ainda não foram resolvidas,
 * mostrando as probabilidades estimadas e edge vs odds de fechamento.
 *
 * Uso:
 *   node scripts/predict.js [--sport lol|tennis|all] [--min-edge N]
 *
 * Requer que a tabela matches e match_results estejam populadas.
 * Para odds ao vivo, use o bot principal; este script usa odds armazenadas em odds_history.
 */

require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');
const { esportsPreFilter } = require('../lib/ml');
const { getDynamicWeights } = require('../lib/ml-weights');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const args = process.argv.slice(2);
const sportArg = (() => { const i = args.indexOf('--sport'); return i >= 0 ? args[i + 1] : 'all'; })();
const minEdgeArg = (() => { const i = args.indexOf('--min-edge'); return i >= 0 ? parseFloat(args[i + 1]) || 0 : 0; })();

const sigmoid = x => 1 / (1 + Math.exp(-x));
const round2 = x => Math.round(x * 100) / 100;

// ── Helpers ────────────────────────────────────────────────────────────────

function buildForm(db, team, game, cutoff = null) {
  const cutoffClause = cutoff
    ? `AND resolved_at < '${cutoff}'`
    : "AND resolved_at >= datetime('now', '-45 days')";
  const rows = db.prepare(`
    SELECT * FROM match_results
    WHERE (lower(team1) = lower(?) OR lower(team2) = lower(?))
      AND game = ?
      ${cutoffClause}
    ORDER BY resolved_at DESC LIMIT 10
  `).all(team, team, game);

  const wins = rows.filter(r => r.winner?.toLowerCase() === team.toLowerCase()).length;
  const losses = rows.length - wins;
  const winRate = rows.length > 0 ? (wins / rows.length) * 100 : 50;
  return { wins, losses, winRate, games: rows.length };
}

function buildH2H(db, t1, t2, game, cutoff = null) {
  const cutoffClause = cutoff
    ? `AND resolved_at < '${cutoff}'`
    : "AND resolved_at >= datetime('now', '-90 days')";
  const rows = db.prepare(`
    SELECT * FROM match_results
    WHERE ((lower(team1) = lower(?) AND lower(team2) = lower(?))
        OR (lower(team1) = lower(?) AND lower(team2) = lower(?)))
      AND game = ?
      ${cutoffClause}
    ORDER BY resolved_at DESC LIMIT 10
  `).all(t1, t2, t2, t1, game);

  const t1Wins = rows.filter(r => r.winner?.toLowerCase() === t1.toLowerCase()).length;
  const t2Wins = rows.filter(r => r.winner?.toLowerCase() === t2.toLowerCase()).length;
  return { t1Wins, t2Wins, total: rows.length };
}

function getLastOdds(db, sport, p1, p2) {
  const row = db.prepare(`
    SELECT odds_p1, odds_p2 FROM odds_history
    WHERE sport = ?
      AND (
        (lower(participant1) LIKE lower(?) AND lower(participant2) LIKE lower(?))
        OR (lower(participant1) LIKE lower(?) AND lower(participant2) LIKE lower(?))
      )
    ORDER BY recorded_at DESC LIMIT 1
  `).get(sport, `%${p1.slice(0, 8)}%`, `%${p2.slice(0, 8)}%`, `%${p2.slice(0, 8)}%`, `%${p1.slice(0, 8)}%`);
  return row;
}

function formatEdge(edge) {
  const sign = edge >= 0 ? '+' : '';
  return `${sign}${round2(edge)}pp`;
}

// ── LoL Predictions ────────────────────────────────────────────────────────

function predictLol(db, stmts) {
  console.log('\n── LoL: Predições (forma + H2H) ──\n');

  // Pega partidas LoL de hoje/amanhã ainda não resolvidas
  const matches = db.prepare(`
    SELECT DISTINCT mr.team1, mr.team2, mr.league
    FROM (
      SELECT team1, team2, league, MAX(resolved_at) as last_date
      FROM match_results WHERE game='lol' GROUP BY team1, team2
    ) mr
    WHERE mr.last_date >= datetime('now', '-1 day')
    LIMIT 50
  `).all();

  // Também pega da tabela matches se houver partidas upcoming
  const upcoming = db.prepare(`
    SELECT participant1_name as t1, participant2_name as t2, event_name as league, match_time
    FROM matches WHERE sport = 'esports' AND winner IS NULL
      AND (match_time IS NULL OR match_time >= datetime('now', '-2 hours'))
    ORDER BY match_time ASC LIMIT 20
  `).all();

  const toPredict = [
    ...upcoming.map(m => ({ team1: m.t1, team2: m.t2, league: m.league, source: 'upcoming', match_time: m.match_time })),
    ...matches.map(m => ({ team1: m.team1, team2: m.team2, league: m.league, source: 'recent' }))
  ].filter((m, i, arr) =>
    arr.findIndex(x => x.team1 === m.team1 && x.team2 === m.team2) === i
  );

  if (!toPredict.length) {
    console.log('  Sem partidas LoL upcoming no DB.');
    return;
  }

  let shown = 0;
  for (const m of toPredict) {
    const form1 = buildForm(db, m.team1, 'lol');
    const form2 = buildForm(db, m.team2, 'lol');
    const h2h   = buildH2H(db, m.team1, m.team2, 'lol');

    if (form1.games < 2 && form2.games < 2) continue;

    const oddsRow = getLastOdds(db, 'esports', m.team1, m.team2);
    const odds = oddsRow ? { t1: String(oddsRow.odds_p1), t2: String(oddsRow.odds_p2) } : null;

    const enrich = { form1, form2, h2h };
    const ml = esportsPreFilter(null, odds || { t1: '2.00', t2: '2.00' }, enrich, false, null, null, stmts);

    const edge = ml.t1Edge >= ml.t2Edge ? ml.t1Edge : ml.t2Edge;
    if (edge < minEdgeArg) continue;

    shown++;
    const favorite = ml.modelP1 >= ml.modelP2 ? m.team1 : m.team2;
    const favProb  = Math.max(ml.modelP1, ml.modelP2);
    const pick     = ml.direction === 't1' ? m.team1 : m.team2;
    const edgeFmt  = formatEdge(ml.direction === 't1' ? ml.t1Edge : ml.t2Edge);

    console.log(`  ${m.team1} vs ${m.team2} [${m.league || '?'}]`);
    if (m.match_time) console.log(`    ⏰ ${m.match_time}`);
    console.log(`    Modelo: ${m.team1} ${round2(ml.modelP1 * 100)}% | ${m.team2} ${round2(ml.modelP2 * 100)}%`);
    if (odds) {
      console.log(`    Odds: ${m.team1} @ ${oddsRow.odds_p1} | ${m.team2} @ ${oddsRow.odds_p2}`);
      console.log(`    ${ml.pass ? '✅' : '❌'} Pick: ${pick} | Edge: ${edgeFmt} | Fatores: [${ml.factorActive?.join(', ')}]`);
    } else {
      console.log(`    (sem odds registradas)`);
      console.log(`    Favorito: ${favorite} (${round2(favProb * 100)}%) | Fatores: [${ml.factorActive?.join(', ')}]`);
    }

    console.log(`    Forma: ${m.team1} ${form1.wins}W-${form1.losses}L (${round2(form1.winRate)}%) | ${m.team2} ${form2.wins}W-${form2.losses}L (${round2(form2.winRate)}%)`);
    if (h2h.total > 0) {
      console.log(`    H2H: ${m.team1} ${h2h.t1Wins}W | ${m.team2} ${h2h.t2Wins}W`);
    }
    console.log('');
  }

  if (!shown) {
    console.log(`  Nenhuma partida com edge >= ${minEdgeArg}pp.`);
  } else {
    console.log(`  Total: ${shown} partida(s) analisada(s).`);
  }
}

// ── Walk-forward accuracy report ───────────────────────────────────────────

function walkForwardReport(db) {
  console.log('\n── Walk-Forward: Acurácia Histórica do Modelo (LoL) ──\n');

  const allMatches = db.prepare(
    "SELECT * FROM match_results WHERE game='lol' ORDER BY resolved_at ASC"
  ).all();

  if (allMatches.length < 60) {
    console.log('  Dados insuficientes para walk-forward (<60 partidas).');
    return;
  }

  const weights = db.prepare('SELECT factor, weight FROM ml_factor_weights').all();
  const wMap = {};
  for (const w of weights) wMap[w.factor] = w.weight;
  const w_forma = wMap.forma || 0.25;
  const w_h2h   = wMap.h2h   || 0.30;

  // Usa os últimos 30% como conjunto de avaliação walk-forward
  const splitIdx = Math.floor(allMatches.length * 0.7);
  const evalSet = allMatches.slice(splitIdx);

  let correct = 0, total = 0;
  const byMonth = {};

  for (let i = splitIdx; i < allMatches.length; i++) {
    const m = allMatches[i];
    const t1 = m.team1.toLowerCase(), t2 = m.team2.toLowerCase();
    const cutoff = m.resolved_at;

    // Forma (45d antes)
    const cutoffDate = new Date(cutoff);
    const formCutoff = new Date(cutoffDate);
    formCutoff.setDate(formCutoff.getDate() - 45);
    const formCutoffStr = formCutoff.toISOString().slice(0, 19).replace('T', ' ');

    const form1 = allMatches.slice(0, i).filter(mm =>
      (mm.team1.toLowerCase() === t1 || mm.team2.toLowerCase() === t1) &&
      mm.resolved_at >= formCutoffStr && mm.resolved_at < cutoff
    );
    const form2 = allMatches.slice(0, i).filter(mm =>
      (mm.team1.toLowerCase() === t2 || mm.team2.toLowerCase() === t2) &&
      mm.resolved_at >= formCutoffStr && mm.resolved_at < cutoff
    );

    if (form1.length < 2 || form2.length < 2) continue;

    const wr1 = (form1.filter(mm => mm.winner?.toLowerCase() === t1).length / form1.length) * 100;
    const wr2 = (form2.filter(mm => mm.winner?.toLowerCase() === t2).length / form2.length) * 100;

    const h2hCutoff = new Date(cutoffDate);
    h2hCutoff.setDate(h2hCutoff.getDate() - 90);
    const h2hCutoffStr = h2hCutoff.toISOString().slice(0, 19).replace('T', ' ');

    const h2h = allMatches.slice(0, i).filter(mm => {
      const mt1 = mm.team1.toLowerCase(), mt2 = mm.team2.toLowerCase();
      return ((mt1 === t1 && mt2 === t2) || (mt1 === t2 && mt2 === t1)) &&
             mm.resolved_at >= h2hCutoffStr && mm.resolved_at < cutoff;
    });
    const h2hT1 = h2h.filter(mm => mm.winner?.toLowerCase() === t1).length;
    const h2hT2 = h2h.filter(mm => mm.winner?.toLowerCase() === t2).length;
    const h2hTotal = h2hT1 + h2hT2;
    const f_h2h = h2hTotal > 0 ? ((h2hT1 / h2hTotal) - 0.5) * 100 : 0;

    const scorePoints = (wr1 - wr2) * w_forma + f_h2h * w_h2h;
    const logit = scorePoints * 0.05; // escala do ml.js
    const p1 = 1 / (1 + Math.exp(-logit));
    const predWinner = p1 >= 0.5 ? t1 : t2;
    const actual = m.winner?.toLowerCase();

    if (!actual) continue;

    const isCorrect = predWinner === actual;
    total++;
    if (isCorrect) correct++;

    // Por mês
    const month = cutoff.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { correct: 0, total: 0 };
    byMonth[month].total++;
    if (isCorrect) byMonth[month].correct++;
  }

  const overallAcc = total ? round2(correct / total * 100) : 0;
  console.log(`  Pesos usados: forma=${w_forma} h2h=${w_h2h}`);
  console.log(`  Overall: ${correct}/${total} (${overallAcc}%)\n`);

  console.log('  Por mês:');
  for (const [month, v] of Object.entries(byMonth).sort()) {
    const acc = round2(v.correct / v.total * 100);
    const bar = '█'.repeat(Math.round(acc / 5));
    console.log(`    ${month}  ${String(v.correct).padStart(3)}/${String(v.total).padStart(3)} (${String(acc).padStart(5)}%)  ${bar}`);
  }
}

// ── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== SportsEdge Predict ===');
  console.log(`DB: ${DB_PATH}`);
  if (minEdgeArg > 0) console.log(`Min edge: ${minEdgeArg}pp\n`);

  const { db, stmts } = initDatabase(DB_PATH);

  try {
    if (sportArg === 'all' || sportArg === 'lol') predictLol(db, stmts);
    if (sportArg === 'all' || sportArg === 'lol') walkForwardReport(db);
  } catch (e) {
    console.error('Erro:', e);
    process.exit(1);
  }

  db.close();
}

main();

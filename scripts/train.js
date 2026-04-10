#!/usr/bin/env node
'use strict';
/**
 * scripts/train.js — Pipeline de treino de pesos ML
 *
 * 1. LoL — Regressão logística (SGD) em features forma+H2H extraídas de match_results
 *    Otimiza w_forma e w_h2h para minimizar log-loss sem look-ahead.
 *    Valida em walk-forward (20% mais recentes).
 *
 * 2. Tênis — Análise de calibração H2H por superfície.
 *
 * Uso:
 *   node scripts/train.js [--sport lol|tennis|all] [--dry-run]
 *
 * Flags:
 *   --sport lol|tennis|all  (padrão: all)
 *   --dry-run               mostra resultado mas não salva no DB
 */

require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');
const { DEFAULT_WEIGHTS } = require('../lib/ml-weights');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const sportArg = (() => {
  const i = args.indexOf('--sport');
  return i >= 0 ? args[i + 1] : 'all';
})();

// ── Utils ──────────────────────────────────────────────────────────────────
const sigmoid = x => 1 / (1 + Math.exp(-x));
const logLoss = (p, y) => -(y * Math.log(Math.max(1e-9, p)) + (1 - y) * Math.log(Math.max(1e-9, 1 - p)));
const brierScore = (p, y) => (p - y) ** 2;
const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const round2 = x => Math.round(x * 100) / 100;
const round4 = x => Math.round(x * 10000) / 10000;

// ── LOL TRAINING ───────────────────────────────────────────────────────────

/**
 * Constrói dataset de features a partir de match_results sem look-ahead.
 * Para cada jogo, calcula forma e H2H usando apenas jogos ANTERIORES.
 */
function buildLolDataset(allMatches) {
  // Ordena por resolved_at ASC (mais antigo primeiro)
  const sorted = [...allMatches].sort((a, b) => a.resolved_at < b.resolved_at ? -1 : 1);

  const FORM_WINDOW_DAYS = 45;
  const H2H_WINDOW_DAYS  = 90;
  const MIN_GAMES_FORM   = 3;
  const MIN_GAMES_H2H    = 1;

  const dataset = [];

  for (let i = 0; i < sorted.length; i++) {
    const match = sorted[i];
    const cutoff = match.resolved_at;
    const t1 = match.team1.toLowerCase();
    const t2 = match.team2.toLowerCase();

    // Filtro de janela temporal
    const formCutoff = offsetDate(cutoff, -FORM_WINDOW_DAYS);
    const h2hCutoff  = offsetDate(cutoff, -H2H_WINDOW_DAYS);

    // Forma t1: jogos anteriores dentro da janela
    const form1 = sorted.slice(0, i).filter(m => {
      const tm1 = m.team1.toLowerCase(), tm2 = m.team2.toLowerCase();
      return (tm1 === t1 || tm2 === t1) && m.resolved_at >= formCutoff && m.resolved_at < cutoff;
    });

    // Forma t2
    const form2 = sorted.slice(0, i).filter(m => {
      const tm1 = m.team1.toLowerCase(), tm2 = m.team2.toLowerCase();
      return (tm1 === t2 || tm2 === t2) && m.resolved_at >= formCutoff && m.resolved_at < cutoff;
    });

    if (form1.length < MIN_GAMES_FORM || form2.length < MIN_GAMES_FORM) continue;

    const wins1 = form1.filter(m => m.winner?.toLowerCase() === t1).length;
    const wins2 = form2.filter(m => m.winner?.toLowerCase() === t2).length;
    const wr1 = (wins1 / form1.length) * 100;
    const wr2 = (wins2 / form2.length) * 100;
    const f_forma = wr1 - wr2; // [-100, +100]

    // H2H
    const h2hMatches = sorted.slice(0, i).filter(m => {
      const mt1 = m.team1.toLowerCase(), mt2 = m.team2.toLowerCase();
      return ((mt1 === t1 && mt2 === t2) || (mt1 === t2 && mt2 === t1)) &&
             m.resolved_at >= h2hCutoff && m.resolved_at < cutoff;
    });

    if (h2hMatches.length < MIN_GAMES_H2H) {
      // Sem H2H suficiente — não inclui fator h2h (usa 0)
    }

    const h2hT1 = h2hMatches.filter(m => m.winner?.toLowerCase() === t1).length;
    const h2hT2 = h2hMatches.filter(m => m.winner?.toLowerCase() === t2).length;
    const h2hTotal = h2hT1 + h2hT2;
    const f_h2h = h2hTotal > 0 ? ((h2hT1 / h2hTotal) - 0.5) * 100 : 0; // [-50, +50]
    const hasH2H = h2hTotal >= MIN_GAMES_H2H;

    // Label: 1 = t1 ganhou
    const y = match.winner?.toLowerCase() === t1 ? 1 : 0;

    dataset.push({
      f_forma,
      f_h2h,
      hasH2H,
      y,
      resolved_at: match.resolved_at,
      team1: match.team1,
      team2: match.team2,
      winner: match.winner,
      league: match.league,
    });
  }

  return dataset;
}

function offsetDate(isoStr, days) {
  const d = new Date(isoStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Regressão logística via SGD mini-batch.
 * Modelo: p1 = sigmoid(w_forma * f_forma + w_h2h * f_h2h)
 * (sem intercepto: assumimos que sem dados → p = 0.5 = sigmoid(0))
 */
function trainLogistic(dataset, opts = {}) {
  const {
    lr       = 0.0005,
    epochs   = 200,
    l2       = 0.01,   // regularização L2
    verbose  = false,
  } = opts;

  // Inicializa com pesos padrão convertidos para escala logit
  // w_forma padrão 0.25, f_forma em [-100,+100] → escala inicial ~0.002
  // w_h2h padrão 0.30, f_h2h em [-50,+50] → escala inicial ~0.003
  let w_forma = 0.002;
  let w_h2h   = 0.003;

  const n = dataset.length;
  if (!n) return { w_forma, w_h2h };

  // Normaliza features para melhor convergência
  const formaStd = std(dataset.map(d => d.f_forma)) || 1;
  const h2hStd   = std(dataset.map(d => d.f_h2h))   || 1;

  let prevLoss = Infinity;

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Shuffle dataset para SGD
    const shuffled = shuffle([...dataset]);

    let totalLoss = 0;

    for (const sample of shuffled) {
      const fForma = sample.f_forma / formaStd;
      const fH2h   = sample.hasH2H ? sample.f_h2h / h2hStd : 0;

      const logit = w_forma * fForma + w_h2h * fH2h;
      const p = sigmoid(logit);
      const err = p - sample.y;

      // Gradiente + L2 regularização
      w_forma -= lr * (err * fForma + l2 * w_forma);
      w_h2h   -= lr * (err * fH2h   + l2 * w_h2h);

      totalLoss += logLoss(p, sample.y);
    }

    const avgLoss = totalLoss / n;

    if (verbose && epoch % 20 === 0) {
      console.log(`  Epoch ${epoch}: loss=${round4(avgLoss)} w_forma=${round4(w_forma)} w_h2h=${round4(w_h2h)}`);
    }

    // Early stopping se loss não melhora
    if (Math.abs(prevLoss - avgLoss) < 1e-7) break;
    prevLoss = avgLoss;
  }

  // Converte de volta para escala de scorePoints (compatível com ml.js)
  // No ml.js: scorePoints += (wr1-wr2) * w_forma  →  aqui f_forma = wr1-wr2
  // logit = w_forma * f_forma/formaStd = (w_forma/formaStd) * f_forma
  // Queremos que em ml.js: (wr1-wr2) * w_forma_new = w_forma * f_forma/formaStd
  // → w_forma_new = w_forma / formaStd
  const wFormaScaled = w_forma / formaStd;
  const wH2hScaled   = w_h2h   / h2hStd;

  // Normaliza para que a soma de pesos (forma + h2h) ≈ TARGET_SUM
  const TARGET_SUM = DEFAULT_WEIGHTS.forma + DEFAULT_WEIGHTS.h2h; // 0.55
  const rawSum = Math.abs(wFormaScaled) + Math.abs(wH2hScaled);
  const scale = rawSum > 0 ? TARGET_SUM / rawSum : 1;

  const WEIGHT_FLOOR = 0.08;
  const WEIGHT_CAP   = 0.55;
  const wFormaFinal = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CAP, Math.abs(wFormaScaled) * scale));
  const wH2hFinal   = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CAP, Math.abs(wH2hScaled)   * scale));

  return { w_forma: round4(wFormaFinal), w_h2h: round4(wH2hFinal) };
}

function std(arr) {
  if (!arr.length) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Avalia o modelo em um conjunto de dados e retorna métricas.
 */
function evalModel(dataset, w_forma, w_h2h) {
  let correct = 0, totalLoss = 0, totalBrier = 0;
  const byLeague = {};

  for (const s of dataset) {
    const logit = w_forma * s.f_forma + w_h2h * (s.hasH2H ? s.f_h2h : 0);
    const p = sigmoid(logit);
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === s.y) correct++;
    totalLoss  += logLoss(p, s.y);
    totalBrier += brierScore(p, s.y);

    if (!byLeague[s.league]) byLeague[s.league] = { correct: 0, total: 0 };
    byLeague[s.league].total++;
    if (pred === s.y) byLeague[s.league].correct++;
  }

  return {
    accuracy:   dataset.length ? round2(correct / dataset.length * 100) : 0,
    logLoss:    dataset.length ? round4(totalLoss / dataset.length)     : 0,
    brierScore: dataset.length ? round4(totalBrier / dataset.length)    : 0,
    n:          dataset.length,
    byLeague,
  };
}

async function trainLol(db, stmts) {
  console.log('\n── LoL: Treinando pesos forma+H2H ──');

  const allMatches = db.prepare("SELECT * FROM match_results WHERE game='lol' ORDER BY resolved_at ASC").all();
  console.log(`  ${allMatches.length} partidas LoL no histórico`);

  if (allMatches.length < 50) {
    console.log('  ⚠️  Dados insuficientes (<50 partidas). Usando pesos padrão.');
    return;
  }

  console.log('  Construindo dataset de features (sem look-ahead)...');
  const dataset = buildLolDataset(allMatches);
  console.log(`  Dataset: ${dataset.length} amostras com forma >= 3 jogos`);

  if (dataset.length < 30) {
    console.log('  ⚠️  Dataset pequeno (<30 amostras). Usando pesos padrão.');
    return;
  }

  // Walk-forward split: treina em 80%, testa em 20% mais recentes
  const splitIdx = Math.floor(dataset.length * 0.8);
  const trainSet = dataset.slice(0, splitIdx);
  const testSet  = dataset.slice(splitIdx);

  console.log(`  Split: treino=${trainSet.length} | teste=${testSet.length}`);

  // Baseline com pesos padrão
  const baseW_forma = DEFAULT_WEIGHTS.forma;
  const baseW_h2h   = DEFAULT_WEIGHTS.h2h;
  const baseEval    = evalModel(testSet, baseW_forma, baseW_h2h);
  console.log(`\n  Baseline (pesos padrão forma=${baseW_forma} h2h=${baseW_h2h}):`);
  console.log(`    Acurácia: ${baseEval.accuracy}% | LogLoss: ${baseEval.logLoss} | Brier: ${baseEval.brierScore}`);

  // Treina modelo
  console.log('\n  Treinando modelo...');
  const { w_forma, w_h2h } = trainLogistic(trainSet, { verbose: false, epochs: 300, lr: 0.0005 });

  const trainEval = evalModel(trainSet, w_forma, w_h2h);
  const testEval  = evalModel(testSet,  w_forma, w_h2h);

  console.log(`\n  Treinado (w_forma=${w_forma} w_h2h=${w_h2h}):`);
  console.log(`    Train → Acurácia: ${trainEval.accuracy}% | LogLoss: ${trainEval.logLoss} | Brier: ${trainEval.brierScore}`);
  console.log(`    Test  → Acurácia: ${testEval.accuracy}% | LogLoss: ${testEval.logLoss} | Brier: ${testEval.brierScore}`);

  const improvement = testEval.accuracy - baseEval.accuracy;
  const improvLog   = baseEval.logLoss - testEval.logLoss;
  console.log(`\n  Δ Acurácia: ${improvement >= 0 ? '+' : ''}${round2(improvement)}pp`);
  console.log(`  Δ LogLoss:  ${improvLog >= 0 ? '-' : '+'}${round4(Math.abs(improvLog))} (negativo = melhorou)`);

  // Acurácia por liga
  const topLeagues = Object.entries(testEval.byLeague)
    .filter(([, v]) => v.total >= 5)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 8);

  if (topLeagues.length) {
    console.log('\n  Acurácia por liga (teste):');
    for (const [league, v] of topLeagues) {
      const acc = round2(v.correct / v.total * 100);
      console.log(`    ${league.padEnd(35)} ${v.correct}/${v.total} (${acc}%)`);
    }
  }

  // Só salva se modelo melhorou ou empatou no log-loss
  if (!isDryRun && improvLog >= -0.005) {
    stmts.upsertFactorWeight.run('forma', w_forma, 0, 0);
    stmts.upsertFactorWeight.run('h2h',   w_h2h,   0, 0);
    console.log(`\n  ✅ Pesos salvos no DB: forma=${w_forma} h2h=${w_h2h}`);
  } else if (isDryRun) {
    console.log(`\n  🔵 Dry-run: pesos NÃO salvos. Seria: forma=${w_forma} h2h=${w_h2h}`);
  } else {
    console.log(`\n  ⚠️  Modelo não melhorou significativamente. Mantendo pesos atuais.`);
  }

  return { w_forma, w_h2h, testEval, baseEval };
}

// ── TENNIS CALIBRATION ─────────────────────────────────────────────────────

async function trainTennis(db) {
  console.log('\n── Tênis: Análise de calibração H2H+Ranking ──');

  const allMatches = db.prepare(
    "SELECT * FROM match_results WHERE game='tennis' ORDER BY resolved_at ASC"
  ).all();
  console.log(`  ${allMatches.length} partidas de tênis no histórico`);

  if (allMatches.length < 100) {
    console.log('  ⚠️  Dados insuficientes.');
    return;
  }

  // Para tênis, faz análise simples de H2H accuracy por superfície
  const bySurface = {};

  for (let i = 0; i < allMatches.length; i++) {
    const m = allMatches[i];
    const t1 = m.team1.toLowerCase();
    const t2 = m.team2.toLowerCase();
    const league = m.league || '';

    // Extrai superfície
    const surface = league.toLowerCase().includes('clay')  ? 'clay'
                  : league.toLowerCase().includes('grass') ? 'grass'
                  : league.toLowerCase().includes('hard')  ? 'hard'
                  : 'unknown';

    if (!bySurface[surface]) bySurface[surface] = { h2hCorrect: 0, h2hTotal: 0 };

    // H2H simples antes desta partida
    const h2h = allMatches.slice(0, i).filter(mm => {
      const mt1 = mm.team1.toLowerCase(), mt2 = mm.team2.toLowerCase();
      return (mt1 === t1 && mt2 === t2) || (mt1 === t2 && mt2 === t1);
    }).slice(-5);

    if (h2h.length >= 2) {
      const t1wins = h2h.filter(mm => mm.winner?.toLowerCase() === t1).length;
      const pred = t1wins > h2h.length / 2 ? t1 : t2;
      const actual = m.winner?.toLowerCase();
      bySurface[surface].h2hTotal++;
      if (pred === actual) bySurface[surface].h2hCorrect++;
    }
  }

  console.log('\n  Acurácia H2H por superfície:');
  for (const [surf, v] of Object.entries(bySurface)) {
    if (!v.h2hTotal) continue;
    const acc = round2(v.h2hCorrect / v.h2hTotal * 100);
    console.log(`    ${surf.padEnd(10)} ${v.h2hCorrect}/${v.h2hTotal} (${acc}%)`);
  }
}

// ── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== SportsEdge ML Training Pipeline ===');
  console.log(`DB: ${DB_PATH}`);
  if (isDryRun) console.log('🔵 Modo dry-run: nenhuma escrita no DB\n');

  const { db, stmts } = initDatabase(DB_PATH);

  const runLol    = sportArg === 'all' || sportArg === 'lol';
  const runTennis = sportArg === 'all' || sportArg === 'tennis';

  try {
    if (runLol)    await trainLol(db, stmts);
    if (runTennis) await trainTennis(db);
  } catch (e) {
    console.error('\nErro no treino:', e);
    process.exit(1);
  }

  console.log('\n=== Treino concluído ===\n');
  db.close();
}

main();

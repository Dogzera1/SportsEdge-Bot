#!/usr/bin/env node
'use strict';
/**
 * scripts/train.js — Pipeline de treino de pesos ML
 *
 * 1. LoL — Regressão logística (SGD) em features forma+H2H+streak extraídas de match_results
 *    Validação: 4-fold walk-forward (time-series safe — sem look-ahead futuro)
 *    Métricas: Acurácia, LogLoss, Brier Score, ROC-AUC
 *    Novas features: f_streak (sequência recente de W/L)
 *    Infra: match_stats.kill_diff_10 / gold_diff_10 usados quando disponíveis
 *
 * 2. Tênis — Análise de calibração H2H por superfície.
 *
 * Uso:
 *   node scripts/train.js [--sport lol|tennis|all] [--dry-run] [--verbose]
 */

require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');
const { DEFAULT_WEIGHTS } = require('../lib/ml-weights');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isVerbose = args.includes('--verbose');
const sportArg = (() => { const i = args.indexOf('--sport'); return i >= 0 ? args[i + 1] : 'all'; })();

// ── Utils ──────────────────────────────────────────────────────────────────
const sigmoid = x => 1 / (1 + Math.exp(-x));
const logLoss  = (p, y) => -(y * Math.log(Math.max(1e-9, p)) + (1 - y) * Math.log(Math.max(1e-9, 1 - p)));
const brier    = (p, y) => (p - y) ** 2;
const mean     = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const round2   = x => Math.round(x * 100) / 100;
const round4   = x => Math.round(x * 10000) / 10000;

function stdDev(arr) {
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

function offsetDate(isoStr, days) {
  const d = new Date(isoStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * ROC-AUC via método trapezoidal.
 * preds: [{prob, label}] onde label=1 é positivo.
 */
function rocAuc(preds) {
  if (!preds.length) return 0.5;
  const sorted = [...preds].sort((a, b) => b.prob - a.prob);
  const pos = preds.filter(p => p.label === 1).length;
  const neg = preds.length - pos;
  if (!pos || !neg) return 0.5;

  let tp = 0, fp = 0, auc = 0;
  let prevTp = 0, prevFp = 0;

  for (const { prob, label } of sorted) {
    if (label === 1) tp++;
    else fp++;
    const tpr = tp / pos;
    const fpr = fp / neg;
    // trapezoidal rule: area += (fpr - prev_fpr) * (tpr + prev_tpr) / 2
    auc += (fpr - prevFp / neg) * (tpr + prevTp / pos) / 2;
    prevTp = tp; prevFp = fp;
  }
  return round4(auc);
}

// ── LOL DATASET BUILDER ────────────────────────────────────────────────────

/**
 * Calcula streak recente de um time: +N = N vitórias seguidas, -N = N derrotas.
 * Usa apenas jogos antes de `cutoff`.
 */
function calcStreak(pastMatches, teamLower) {
  if (!pastMatches.length) return 0;
  // Ordena do mais recente para o mais antigo
  const recent = [...pastMatches].sort((a, b) => b.resolved_at < a.resolved_at ? -1 : 1);
  let streak = 0;
  const firstResult = recent[0]?.winner?.toLowerCase() === teamLower;
  for (const m of recent) {
    const won = m.winner?.toLowerCase() === teamLower;
    if (won === firstResult) streak += (won ? 1 : -1);
    else break;
  }
  return streak; // [-10, +10] tipicamente
}

/**
 * Constrói dataset de features a partir de match_results sem look-ahead.
 * Features por amostra:
 *   f_forma   — diferencial de win rate 45d ([-100, +100])
 *   f_h2h     — diferencial H2H 90d ([-50, +50])
 *   f_streak  — diferencial de streak recente ([-10, +10])
 *   f_kd10    — diferencial de kill_diff_10 médio dos últimos jogos (se disponível, else 0)
 *   hasH2H, hasKd10 — flags de disponibilidade
 */
function buildLolDataset(allMatches, matchStatsMap = {}) {
  const sorted = [...allMatches].sort((a, b) => a.resolved_at < b.resolved_at ? -1 : 1);

  const FORM_WINDOW_DAYS   = 45;
  const H2H_WINDOW_DAYS    = 90;
  const STREAK_WINDOW_DAYS = 30;
  const MIN_GAMES_FORM     = 3;

  const dataset = [];

  for (let i = 0; i < sorted.length; i++) {
    const match = sorted[i];
    const cutoff = match.resolved_at;
    const t1 = match.team1.toLowerCase();
    const t2 = match.team2.toLowerCase();

    const formCutoff   = offsetDate(cutoff, -FORM_WINDOW_DAYS);
    const h2hCutoff    = offsetDate(cutoff, -H2H_WINDOW_DAYS);
    const streakCutoff = offsetDate(cutoff, -STREAK_WINDOW_DAYS);

    const prior = sorted.slice(0, i);

    // Forma (45d)
    const form1 = prior.filter(m => {
      const mt1 = m.team1.toLowerCase(), mt2 = m.team2.toLowerCase();
      return (mt1 === t1 || mt2 === t1) && m.resolved_at >= formCutoff && m.resolved_at < cutoff;
    });
    const form2 = prior.filter(m => {
      const mt1 = m.team1.toLowerCase(), mt2 = m.team2.toLowerCase();
      return (mt1 === t2 || mt2 === t2) && m.resolved_at >= formCutoff && m.resolved_at < cutoff;
    });

    if (form1.length < MIN_GAMES_FORM || form2.length < MIN_GAMES_FORM) continue;

    const wr1 = form1.filter(m => m.winner?.toLowerCase() === t1).length / form1.length * 100;
    const wr2 = form2.filter(m => m.winner?.toLowerCase() === t2).length / form2.length * 100;
    const f_forma = wr1 - wr2;

    // H2H (90d)
    const h2hRows = prior.filter(m => {
      const mt1 = m.team1.toLowerCase(), mt2 = m.team2.toLowerCase();
      return ((mt1 === t1 && mt2 === t2) || (mt1 === t2 && mt2 === t1)) &&
             m.resolved_at >= h2hCutoff && m.resolved_at < cutoff;
    });
    const h2hT1 = h2hRows.filter(m => m.winner?.toLowerCase() === t1).length;
    const h2hTot = h2hRows.length;
    const f_h2h = h2hTot > 0 ? ((h2hT1 / h2hTot) - 0.5) * 100 : 0;
    const hasH2H = h2hTot >= 1;

    // Streak (30d)
    const streak1Rows = prior.filter(m => {
      const mt1 = m.team1.toLowerCase(), mt2 = m.team2.toLowerCase();
      return (mt1 === t1 || mt2 === t1) && m.resolved_at >= streakCutoff && m.resolved_at < cutoff;
    });
    const streak2Rows = prior.filter(m => {
      const mt1 = m.team1.toLowerCase(), mt2 = m.team2.toLowerCase();
      return (mt1 === t2 || mt2 === t2) && m.resolved_at >= streakCutoff && m.resolved_at < cutoff;
    });
    const s1 = calcStreak(streak1Rows, t1);
    const s2 = calcStreak(streak2Rows, t2);
    const f_streak = s1 - s2; // [-10, +10]

    // Kill diff @10 (de match_stats, se disponível)
    const stats = matchStatsMap[match.match_id];
    const f_kd10  = stats?.kill_diff_10 != null ? stats.kill_diff_10 : 0;
    const hasKd10 = f_kd10 !== 0 && stats?.kill_diff_10 != null;

    const y = match.winner?.toLowerCase() === t1 ? 1 : 0;

    dataset.push({ f_forma, f_h2h, f_streak, f_kd10, hasH2H, hasKd10, y,
                   resolved_at: match.resolved_at, league: match.league,
                   team1: match.team1, team2: match.team2 });
  }

  return dataset;
}

// ── LOGISTIC REGRESSION (SGD) ──────────────────────────────────────────────

/**
 * Treina regressão logística com SGD.
 * Features: [f_forma, f_h2h, f_streak, f_kd10]
 * Retorna { w_forma, w_h2h, w_streak, w_kd10 }
 */
function trainLogistic(dataset, opts = {}) {
  const { lr = 0.0005, epochs = 300, l2 = 0.01 } = opts;

  // Normalização de features
  const formaStd  = stdDev(dataset.map(d => d.f_forma))  || 1;
  const h2hStd    = stdDev(dataset.map(d => d.f_h2h))    || 1;
  const streakStd = stdDev(dataset.map(d => d.f_streak)) || 1;
  const kd10Std   = stdDev(dataset.filter(d => d.hasKd10).map(d => d.f_kd10)) || 1;

  // Pesos iniciais (escala bruta antes de normalizar para saída)
  let w_forma  = 0.002;
  let w_h2h    = 0.003;
  let w_streak = 0.001;
  let w_kd10   = 0.001;

  let prevLoss = Infinity;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const shuffled = shuffle([...dataset]);
    let totalLoss = 0;

    for (const s of shuffled) {
      const fF = s.f_forma  / formaStd;
      const fH = s.hasH2H   ? s.f_h2h    / h2hStd    : 0;
      const fS = s.f_streak / streakStd;
      const fK = s.hasKd10  ? s.f_kd10   / kd10Std   : 0;

      const logit = w_forma * fF + w_h2h * fH + w_streak * fS + w_kd10 * fK;
      const p   = sigmoid(logit);
      const err = p - s.y;

      w_forma  -= lr * (err * fF + l2 * w_forma);
      w_h2h    -= lr * (err * fH + l2 * w_h2h);
      w_streak -= lr * (err * fS + l2 * w_streak);
      w_kd10   -= lr * (err * fK + l2 * w_kd10);

      totalLoss += logLoss(p, s.y);
    }

    const avgLoss = totalLoss / dataset.length;
    if (isVerbose && epoch % 50 === 0) {
      console.log(`    Epoch ${epoch}: loss=${round4(avgLoss)}`);
    }
    if (Math.abs(prevLoss - avgLoss) < 1e-7) break;
    prevLoss = avgLoss;
  }

  // Converte para escala de scorePoints (ml.js usa w * feature_value sem normalização)
  const wF = w_forma  / formaStd;
  const wH = w_h2h    / h2hStd;
  const wS = w_streak / streakStd;
  const wK = w_kd10   / kd10Std;

  // Normaliza forma+h2h para soma ≈ TARGET_SUM (compatível com DEFAULT_WEIGHTS)
  const TARGET_SUM = DEFAULT_WEIGHTS.forma + DEFAULT_WEIGHTS.h2h; // 0.55
  const rawSum = Math.abs(wF) + Math.abs(wH);
  const scale  = rawSum > 0 ? TARGET_SUM / rawSum : 1;

  const FLOOR = 0.08, CAP = 0.55;
  return {
    w_forma:  round4(Math.max(FLOOR, Math.min(CAP, Math.abs(wF) * scale))),
    w_h2h:    round4(Math.max(FLOOR, Math.min(CAP, Math.abs(wH) * scale))),
    w_streak: round4(Math.max(0.02,  Math.min(0.20, Math.abs(wS)))),
    w_kd10:   round4(Math.max(0.02,  Math.min(0.30, Math.abs(wK)))),
  };
}

// ── EVALUATION ─────────────────────────────────────────────────────────────

function predict(sample, weights) {
  const { w_forma, w_h2h, w_streak, w_kd10 } = weights;
  const logit = w_forma  * sample.f_forma
              + w_h2h    * (sample.hasH2H  ? sample.f_h2h   : 0)
              + w_streak * sample.f_streak
              + w_kd10   * (sample.hasKd10 ? sample.f_kd10  : 0);
  return sigmoid(logit);
}

function evalModel(dataset, weights) {
  let correct = 0, totalLL = 0, totalBrier = 0;
  const preds = [];
  const byLeague = {};

  for (const s of dataset) {
    const p    = predict(s, weights);
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === s.y) correct++;
    totalLL    += logLoss(p, s.y);
    totalBrier += brier(p, s.y);
    preds.push({ prob: p, label: s.y });

    if (!byLeague[s.league]) byLeague[s.league] = { correct: 0, total: 0 };
    byLeague[s.league].total++;
    if (pred === s.y) byLeague[s.league].correct++;
  }

  return {
    accuracy:   dataset.length ? round2(correct / dataset.length * 100)  : 0,
    logLoss:    dataset.length ? round4(totalLL    / dataset.length)      : 0,
    brierScore: dataset.length ? round4(totalBrier / dataset.length)      : 0,
    auc:        rocAuc(preds),
    n:          dataset.length,
    byLeague,
  };
}

// ── 4-FOLD WALK-FORWARD CV ──────────────────────────────────────────────────

/**
 * Walk-forward cross-validation (time-series safe).
 * k folds, cada fold treina em tudo até um ponto e testa no próximo bloco.
 *
 * Ex: k=4, n=200 →
 *   Fold 1: treino [0, 50),   teste [50, 100)
 *   Fold 2: treino [0, 100),  teste [100, 150)
 *   Fold 3: treino [0, 150),  teste [150, 200)
 *
 * Dataset deve estar ordenado cronologicamente.
 */
function walkForwardCV(dataset, k = 4, trainOpts = {}) {
  const n     = dataset.length;
  const block = Math.floor(n / (k + 1));  // tamanho de cada bloco

  const foldResults = [];

  for (let fold = 0; fold < k; fold++) {
    const trainEnd = block * (fold + 1);
    const testEnd  = Math.min(block * (fold + 2), n);

    if (testEnd <= trainEnd) continue;

    const trainSet = dataset.slice(0, trainEnd);
    const testSet  = dataset.slice(trainEnd, testEnd);

    if (trainSet.length < 20 || testSet.length < 5) continue;

    const weights = trainLogistic(trainSet, trainOpts);
    const metrics = evalModel(testSet, weights);

    foldResults.push({ fold: fold + 1, trainN: trainSet.length, testN: testSet.length, ...metrics, weights });
  }

  // Estatísticas agregadas
  const accs  = foldResults.map(f => f.accuracy);
  const aucs  = foldResults.map(f => f.auc);
  const lls   = foldResults.map(f => f.logLoss);

  return {
    folds: foldResults,
    cv_accuracy:    round2(mean(accs)),
    cv_accuracy_std: round2(stdDev(accs)),
    cv_auc:         round4(mean(aucs)),
    cv_auc_std:     round4(stdDev(aucs)),
    cv_logLoss:     round4(mean(lls)),
  };
}

// ── LOL TRAINING MAIN ──────────────────────────────────────────────────────

async function trainLol(db, stmts) {
  console.log('\n── LoL: Treinando pesos (forma + H2H + streak) ──');

  const allMatches = db.prepare("SELECT * FROM match_results WHERE game='lol' ORDER BY resolved_at ASC").all();
  console.log(`  ${allMatches.length} partidas LoL no histórico`);

  if (allMatches.length < 50) {
    console.log('  ⚠️  Dados insuficientes (<50 partidas).');
    return;
  }

  // Carrega match_stats se disponível (kill_diff_10, gold_diff_10)
  let matchStatsMap = {};
  try {
    const statsRows = db.prepare("SELECT match_id, kill_diff_10, gold_diff_10 FROM match_stats WHERE game='lol'").all();
    for (const r of statsRows) matchStatsMap[r.match_id] = r;
    if (statsRows.length) console.log(`  ${statsRows.length} partidas com match_stats (kill_diff_10)`);
  } catch (_) { /* tabela ainda não existe */ }

  console.log('  Construindo dataset (sem look-ahead)...');
  const dataset = buildLolDataset(allMatches, matchStatsMap);
  console.log(`  Dataset: ${dataset.length} amostras`);

  const hasKd10 = dataset.filter(d => d.hasKd10).length;
  if (hasKd10) console.log(`  Amostras com kill_diff_10: ${hasKd10}`);

  if (dataset.length < 30) {
    console.log('  ⚠️  Dataset pequeno (<30). Usando pesos padrão.');
    return;
  }

  // ── Baseline (pesos padrão, sem streak) ──
  const baseWeights = { w_forma: DEFAULT_WEIGHTS.forma, w_h2h: DEFAULT_WEIGHTS.h2h, w_streak: 0, w_kd10: 0 };
  const baseTest    = evalModel(dataset.slice(Math.floor(dataset.length * 0.8)), baseWeights);
  console.log(`\n  Baseline (forma=${baseWeights.w_forma} h2h=${baseWeights.w_h2h} streak=0):`);
  console.log(`    Acc=${baseTest.accuracy}%  AUC=${baseTest.auc}  LogLoss=${baseTest.logLoss}  Brier=${baseTest.brierScore}`);

  // ── 4-fold Walk-Forward CV ──
  console.log('\n  4-fold Walk-Forward CV...');
  const cv = walkForwardCV(dataset, 4, { lr: 0.0005, epochs: 300, l2: 0.01 });

  console.log(`\n  CV Results (${cv.folds.length} folds):`);
  console.log(`  ${'Fold'.padEnd(5)} ${'Train'.padEnd(7)} ${'Test'.padEnd(6)} ${'Acc%'.padEnd(8)} ${'AUC'.padEnd(7)} ${'LL'.padEnd(8)} w_forma  w_h2h  w_streak`);
  console.log(`  ${'-'.repeat(75)}`);
  for (const f of cv.folds) {
    const wf = f.weights;
    console.log(`  ${String(f.fold).padEnd(5)} ${String(f.trainN).padEnd(7)} ${String(f.testN).padEnd(6)} ${String(f.accuracy).padEnd(8)} ${String(f.auc).padEnd(7)} ${String(f.logLoss).padEnd(8)} ${String(wf.w_forma).padEnd(8)} ${String(wf.w_h2h).padEnd(6)} ${wf.w_streak}`);
  }
  console.log(`  ${'-'.repeat(75)}`);
  console.log(`  ${'Média'.padEnd(5)} ${' '.repeat(14)} ${String(cv.cv_accuracy).padEnd(8)} ${String(cv.cv_auc).padEnd(7)} ${cv.cv_logLoss}`);
  console.log(`  ${'±σ'.padEnd(5)} ${' '.repeat(14)} ${String(cv.cv_accuracy_std).padEnd(8)} ${cv.cv_auc_std}`);

  // ── Treino final em todos os dados ──
  console.log('\n  Treino final (dataset completo)...');
  const finalWeights = trainLogistic(dataset, { lr: 0.0005, epochs: 400, l2: 0.01 });

  // Avalia no 20% mais recente para comparação direta
  const testSet   = dataset.slice(Math.floor(dataset.length * 0.8));
  const finalEval = evalModel(testSet, finalWeights);

  console.log(`\n  Final: forma=${finalWeights.w_forma} h2h=${finalWeights.w_h2h} streak=${finalWeights.w_streak} kd10=${finalWeights.w_kd10}`);
  console.log(`  Test(20%): Acc=${finalEval.accuracy}%  AUC=${finalEval.auc}  LogLoss=${finalEval.logLoss}  Brier=${finalEval.brierScore}`);

  const dAcc = round2(finalEval.accuracy - baseTest.accuracy);
  const dAuc = round4(finalEval.auc - baseTest.auc);
  console.log(`  Δ vs baseline: Acc ${dAcc >= 0 ? '+' : ''}${dAcc}pp  AUC ${dAuc >= 0 ? '+' : ''}${dAuc}`);

  // ── Acurácia por liga (teste) ──
  const topLeagues = Object.entries(finalEval.byLeague)
    .filter(([, v]) => v.total >= 5)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 10);

  if (topLeagues.length) {
    console.log('\n  Por liga (teste):');
    for (const [league, v] of topLeagues) {
      const acc = round2(v.correct / v.total * 100);
      const bar = '█'.repeat(Math.round(acc / 10));
      console.log(`    ${league.padEnd(35)} ${v.correct}/${v.total} (${acc}%) ${bar}`);
    }
  }

  // ── Salva pesos no DB ──
  const improvLog = baseTest.logLoss - finalEval.logLoss;
  if (!isDryRun && improvLog >= -0.005) {
    stmts.upsertFactorWeight.run('forma',  finalWeights.w_forma,  0, 0);
    stmts.upsertFactorWeight.run('h2h',    finalWeights.w_h2h,    0, 0);
    // Salva streak e kd10 se tiver melhoria real
    if (finalWeights.w_streak > 0.03) {
      db.prepare(`INSERT INTO ml_factor_weights (factor, weight, wins, total) VALUES ('streak', ?, 0, 0)
        ON CONFLICT(factor) DO UPDATE SET weight=excluded.weight`).run(finalWeights.w_streak);
    }
    if (hasKd10 > 10 && finalWeights.w_kd10 > 0.03) {
      db.prepare(`INSERT INTO ml_factor_weights (factor, weight, wins, total) VALUES ('kd10', ?, 0, 0)
        ON CONFLICT(factor) DO UPDATE SET weight=excluded.weight`).run(finalWeights.w_kd10);
    }
    console.log('\n  ✅ Pesos salvos no DB.');
  } else if (isDryRun) {
    console.log('\n  🔵 Dry-run: pesos NÃO salvos.');
  } else {
    console.log('\n  ⚠️  Modelo não melhorou — pesos mantidos.');
  }

  return { finalWeights, finalEval, cv };
}

// ── TENNIS CALIBRATION ─────────────────────────────────────────────────────

async function trainTennis(db) {
  console.log('\n── Tênis: Calibração H2H por superfície ──');

  const allMatches = db.prepare("SELECT * FROM match_results WHERE game='tennis' ORDER BY resolved_at ASC").all();
  console.log(`  ${allMatches.length} partidas`);
  if (allMatches.length < 100) { console.log('  ⚠️  Dados insuficientes.'); return; }

  const bySurface = {};

  for (let i = 0; i < allMatches.length; i++) {
    const m  = allMatches[i];
    const t1 = m.team1.toLowerCase();
    const t2 = m.team2.toLowerCase();
    const lg = (m.league || '').toLowerCase();
    const surf = lg.includes('clay') ? 'clay' : lg.includes('grass') ? 'grass' : lg.includes('hard') ? 'hard' : 'unknown';

    if (!bySurface[surf]) bySurface[surf] = { correct: 0, total: 0 };

    const h2h = allMatches.slice(0, i).filter(mm => {
      const mt1 = mm.team1.toLowerCase(), mt2 = mm.team2.toLowerCase();
      return (mt1 === t1 && mt2 === t2) || (mt1 === t2 && mt2 === t1);
    }).slice(-5);

    if (h2h.length >= 2) {
      const t1wins = h2h.filter(mm => mm.winner?.toLowerCase() === t1).length;
      const pred   = t1wins > h2h.length / 2 ? t1 : t2;
      bySurface[surf].total++;
      if (pred === m.winner?.toLowerCase()) bySurface[surf].correct++;
    }
  }

  console.log('\n  Acurácia H2H por superfície:');
  for (const [surf, v] of Object.entries(bySurface)) {
    if (!v.total) continue;
    const acc = round2(v.correct / v.total * 100);
    console.log(`    ${surf.padEnd(10)} ${v.correct}/${v.total} (${acc}%)`);
  }
}

// ── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== SportsEdge ML Training Pipeline ===');
  console.log(`DB: ${DB_PATH}`);
  if (isDryRun) console.log('🔵 Dry-run: sem escrita no DB\n');

  const { db, stmts } = initDatabase(DB_PATH);

  try {
    if (sportArg === 'all' || sportArg === 'lol')    await trainLol(db, stmts);
    if (sportArg === 'all' || sportArg === 'tennis') await trainTennis(db);
  } catch (e) {
    console.error('\nErro:', e);
    process.exit(1);
  }

  console.log('\n=== Treino concluído ===\n');
  db.close();
}

main();

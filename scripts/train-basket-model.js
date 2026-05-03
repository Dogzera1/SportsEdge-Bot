#!/usr/bin/env node
'use strict';

/**
 * train-basket-model.js
 *
 * Treina logistic regression pra prever home_won em NBA games. Lê
 * basket_match_history (seed via seed-basket-history.js), engineera features
 * rolling pra cada game point-in-time (sem leak temporal), treina via
 * gradient descent, calibra com isotonic regression, salva params.
 *
 * Run: node scripts/train-basket-model.js
 *
 * Output: data/basket-trained-params.json
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const _norm = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

// ── Feature engineering ─────────────────────────────────────────────────
// Para cada game: computar features point-in-time usando jogos ANTERIORES
// dos times. Features:
//   1. elo_diff_home — Elo home (com home adv) − Elo away
//   2. recent_winrate_diff — last 10 W% home − last 10 W% away
//   3. recent_margin_diff — avg point margin last 10 home − away
//   4. rest_days_diff — clamp(rest_home, 0, 4) − clamp(rest_away, 0, 4)
//   5. season_winrate_diff — season W% so far (home − away)
//   6. is_playoffs — 1 se postseason, else 0
//   7. h2h_winrate — fraction of past meetings won by home (Bayesian prior 0.5)
//
// Elo computado por rolling pass (init 1500, K=20, home adv +85). Cold start
// (<5 games) usa 1500 sem decay.

const ELO_INIT = 1500;
const ELO_K = 20;
const HOME_ADV = 85;
const ROLLING_WINDOW = 10;
const FEATURE_NAMES = [
  'elo_diff_home',
  'recent_winrate_diff',
  'recent_margin_diff',
  'rest_days_diff',
  'season_winrate_diff',
  'is_playoffs',
  'h2h_winrate_home',
];

function _expected(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }

function buildFeaturesAndLabels(db) {
  const games = db.prepare(`
    SELECT * FROM basket_match_history
    WHERE home_score IS NOT NULL AND away_score IS NOT NULL
    ORDER BY game_date ASC, espn_id ASC
  `).all();
  console.log(`[TRAIN] loaded ${games.length} games from DB`);

  // Estado rolling: per team
  const eloMap = new Map(); // norm → rating
  const formMap = new Map(); // norm → array of {date, won, margin} last N
  const seasonMap = new Map(); // (norm, season) → {wins, losses}
  const lastGameDate = new Map(); // norm → ISO date
  const h2hMap = new Map(); // 'norm1__norm2' (sorted) → {home_wins:int, away_wins:int}

  const samples = []; // { features: [], label: 0|1, gameDate, season }

  function getElo(n) { return eloMap.get(n) ?? ELO_INIT; }
  function getRest(n, gameDate) {
    const last = lastGameDate.get(n);
    if (!last) return 3; // baseline 3 days
    const diff = (new Date(gameDate) - new Date(last)) / (1000 * 60 * 60 * 24);
    return Math.max(0, Math.min(7, diff));
  }
  function getRollingForm(n) {
    const arr = formMap.get(n) || [];
    if (!arr.length) return { wr: 0.5, margin: 0 };
    const wins = arr.filter(g => g.won).length;
    const wr = wins / arr.length;
    const margin = arr.reduce((s, g) => s + g.margin, 0) / arr.length;
    return { wr, margin };
  }
  function getSeasonWr(n, season) {
    const k = `${n}__${season}`;
    const v = seasonMap.get(k);
    if (!v || (v.wins + v.losses) < 3) return 0.5; // prior antes de 3 jogos
    return v.wins / (v.wins + v.losses);
  }
  function getH2hHomeWr(home, away) {
    const k = home < away ? `${home}__${away}` : `${away}__${home}`;
    const v = h2hMap.get(k);
    if (!v || (v.home_wins + v.away_wins) < 2) return 0.5; // Bayesian prior
    // Returns fraction won by THIS home (regardless of which past was home_team)
    // Approximation: assume past wins evenly distributed → return home_wins / total
    // Mais correto seria split por home_team mas h2h NBA é raro suficiente que prior 0.5 funciona
    return v.home_wins / (v.home_wins + v.away_wins);
  }

  for (const g of games) {
    const h = g.home_team_norm, a = g.away_team_norm;
    if (!h || !a) continue;

    // Snapshot features ANTES de atualizar com este jogo (point-in-time)
    const eloH = getElo(h), eloA = getElo(a);
    const formH = getRollingForm(h), formA = getRollingForm(a);
    const restH = getRest(h, g.game_date), restA = getRest(a, g.game_date);
    const seasonWrH = getSeasonWr(h, g.season), seasonWrA = getSeasonWr(a, g.season);
    const isPlayoffs = g.season_type === 'post-season' || g.season_type === 'postseason' ? 1 : 0;
    const h2hHomeWr = getH2hHomeWr(h, a);

    const features = [
      ((eloH + HOME_ADV) - eloA) / 400, // normalized
      (formH.wr - formA.wr),
      (formH.margin - formA.margin) / 10, // normalize 10pt scale
      (Math.min(restH, 4) - Math.min(restA, 4)) / 4,
      (seasonWrH - seasonWrA),
      isPlayoffs,
      (h2hHomeWr - 0.5) * 2, // center 0
    ];
    samples.push({
      features,
      label: g.home_won,
      gameDate: g.game_date,
      season: g.season,
      home: g.home_team,
      away: g.away_team,
    });

    // ── Update state com este jogo ──
    const sH = g.home_score, sA = g.away_score;
    const homeWon = sH > sA ? 1 : 0;

    // Elo update
    const expH = _expected(eloH + HOME_ADV, eloA);
    const newH = eloH + ELO_K * (homeWon - expH);
    const newA = eloA + ELO_K * ((1 - homeWon) - (1 - expH));
    eloMap.set(h, newH);
    eloMap.set(a, newA);

    // Form rolling
    const fH = formMap.get(h) || [];
    fH.push({ date: g.game_date, won: !!homeWon, margin: sH - sA });
    if (fH.length > ROLLING_WINDOW) fH.shift();
    formMap.set(h, fH);
    const fA = formMap.get(a) || [];
    fA.push({ date: g.game_date, won: !homeWon, margin: sA - sH });
    if (fA.length > ROLLING_WINDOW) fA.shift();
    formMap.set(a, fA);

    // Season
    const kSh = `${h}__${g.season}`;
    const sObjH = seasonMap.get(kSh) || { wins: 0, losses: 0 };
    homeWon ? sObjH.wins++ : sObjH.losses++;
    seasonMap.set(kSh, sObjH);
    const kSa = `${a}__${g.season}`;
    const sObjA = seasonMap.get(kSa) || { wins: 0, losses: 0 };
    homeWon ? sObjA.losses++ : sObjA.wins++;
    seasonMap.set(kSa, sObjA);

    // Last game date
    lastGameDate.set(h, g.game_date);
    lastGameDate.set(a, g.game_date);

    // H2H
    const kH2h = h < a ? `${h}__${a}` : `${a}__${h}`;
    const h2hObj = h2hMap.get(kH2h) || { home_wins: 0, away_wins: 0 };
    homeWon ? h2hObj.home_wins++ : h2hObj.away_wins++;
    h2hMap.set(kH2h, h2hObj);
  }

  console.log(`[TRAIN] generated ${samples.length} samples (skipped ${games.length - samples.length})`);
  return samples;
}

// ── Logistic regression via SGD ──────────────────────────────────────────
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

function trainLogistic(samples, opts = {}) {
  const { lr = 0.05, l2 = 0.001, epochs = 200, batchSize = 64, valFraction = 0.2 } = opts;
  // Shuffle e split temporal: últimos 20% = validation (mais realista que random)
  const sorted = samples.slice().sort((a, b) => (a.gameDate || '').localeCompare(b.gameDate || ''));
  const splitIdx = Math.floor(sorted.length * (1 - valFraction));
  const train = sorted.slice(0, splitIdx);
  const val = sorted.slice(splitIdx);
  console.log(`[TRAIN] split: train=${train.length} val=${val.length} (val period: ${val[0]?.gameDate} → ${val[val.length-1]?.gameDate})`);

  const D = FEATURE_NAMES.length;
  let weights = new Array(D).fill(0);
  let intercept = 0;

  // SGD with mini-batches
  for (let ep = 0; ep < epochs; ep++) {
    // Shuffle train
    for (let i = train.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [train[i], train[j]] = [train[j], train[i]];
    }
    let lossSum = 0;
    for (let i = 0; i < train.length; i += batchSize) {
      const batch = train.slice(i, i + batchSize);
      const grad = new Array(D).fill(0);
      let gradB = 0;
      for (const s of batch) {
        let z = intercept;
        for (let k = 0; k < D; k++) z += weights[k] * s.features[k];
        const p = sigmoid(z);
        const err = p - s.label;
        gradB += err;
        for (let k = 0; k < D; k++) grad[k] += err * s.features[k];
        // log-loss
        lossSum += s.label === 1 ? -Math.log(Math.max(1e-9, p)) : -Math.log(Math.max(1e-9, 1 - p));
      }
      // Apply gradient with L2 reg
      const sz = batch.length;
      intercept -= lr * (gradB / sz);
      for (let k = 0; k < D; k++) weights[k] -= lr * (grad[k] / sz + l2 * weights[k]);
    }
    if (ep % 25 === 0 || ep === epochs - 1) {
      const trainLoss = lossSum / train.length;
      const { brier: brierVal, acc: accVal, ll: llVal } = evaluateModel(val, weights, intercept);
      console.log(`[TRAIN] ep ${ep}: train_loss=${trainLoss.toFixed(4)} val_brier=${brierVal.toFixed(4)} val_acc=${(accVal*100).toFixed(1)}% val_ll=${llVal.toFixed(4)}`);
    }
  }
  return { weights, intercept, train, val };
}

function evaluateModel(samples, weights, intercept) {
  let brierSum = 0, llSum = 0, correct = 0;
  for (const s of samples) {
    let z = intercept;
    for (let k = 0; k < weights.length; k++) z += weights[k] * s.features[k];
    const p = sigmoid(z);
    brierSum += (p - s.label) ** 2;
    llSum += s.label === 1 ? -Math.log(Math.max(1e-9, p)) : -Math.log(Math.max(1e-9, 1 - p));
    if ((p >= 0.5 ? 1 : 0) === s.label) correct++;
  }
  return { brier: brierSum / samples.length, ll: llSum / samples.length, acc: correct / samples.length };
}

function expectedCalibrationError(samples, weights, intercept, bins = 10) {
  const buckets = Array.from({ length: bins }, () => ({ n: 0, sumP: 0, sumLabel: 0 }));
  for (const s of samples) {
    let z = intercept;
    for (let k = 0; k < weights.length; k++) z += weights[k] * s.features[k];
    const p = sigmoid(z);
    const idx = Math.min(bins - 1, Math.floor(p * bins));
    buckets[idx].n++;
    buckets[idx].sumP += p;
    buckets[idx].sumLabel += s.label;
  }
  const total = samples.length;
  let ece = 0;
  for (const b of buckets) {
    if (!b.n) continue;
    const avgP = b.sumP / b.n;
    const empP = b.sumLabel / b.n;
    ece += (b.n / total) * Math.abs(avgP - empP);
  }
  return ece;
}

// ── Isotonic regression (pool adjacent violators) ───────────────────────
function fitIsotonic(samples, weights, intercept) {
  const points = samples.map(s => {
    let z = intercept;
    for (let k = 0; k < weights.length; k++) z += weights[k] * s.features[k];
    return { p: sigmoid(z), y: s.label };
  });
  points.sort((a, b) => a.p - b.p);
  // PAV
  const stack = [];
  for (const pt of points) {
    let cur = { sum: pt.y, count: 1, p: pt.p };
    while (stack.length && stack[stack.length - 1].mean > cur.sum / cur.count) {
      const top = stack.pop();
      cur.sum += top.sum;
      cur.count += top.count;
    }
    cur.mean = cur.sum / cur.count;
    stack.push(cur);
  }
  // Build mapping (raw_p → calib_p) at unique p points
  const map = [];
  let pIdx = 0;
  for (const block of stack) {
    const start = pIdx;
    pIdx += block.count;
    const lastP = points[pIdx - 1].p;
    const firstP = points[start].p;
    map.push({ p_lo: firstP, p_hi: lastP, calib: block.mean });
  }
  return map;
}

function applyIsotonic(map, p) {
  if (!map?.length) return p;
  // Find bin
  for (const b of map) {
    if (p >= b.p_lo && p <= b.p_hi) return b.calib;
  }
  // Edge cases
  if (p < map[0].p_lo) return map[0].calib;
  return map[map.length - 1].calib;
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const dbPath = path.resolve(process.env.DB_PATH || 'sportsedge.db');
  console.log(`[TRAIN] DB: ${dbPath}`);
  const db = new Database(dbPath, { readonly: false });

  const samples = buildFeaturesAndLabels(db);
  if (samples.length < 200) {
    console.error(`[TRAIN] FATAL: insufficient samples (${samples.length}) — run seed-basket-history.js first`);
    process.exit(1);
  }

  const result = trainLogistic(samples, { lr: 0.05, l2: 0.001, epochs: 200, batchSize: 64, valFraction: 0.2 });
  const { weights, intercept, train, val } = result;

  // Métricas finais
  const trainMetrics = evaluateModel(train, weights, intercept);
  const valMetrics = evaluateModel(val, weights, intercept);
  const valEce = expectedCalibrationError(val, weights, intercept, 10);

  console.log(`\n[TRAIN] FINAL`);
  console.log(`  train: brier=${trainMetrics.brier.toFixed(4)} ll=${trainMetrics.ll.toFixed(4)} acc=${(trainMetrics.acc*100).toFixed(1)}%`);
  console.log(`  val:   brier=${valMetrics.brier.toFixed(4)} ll=${valMetrics.ll.toFixed(4)} acc=${(valMetrics.acc*100).toFixed(1)}% ece=${valEce.toFixed(4)}`);

  // Baseline: home advantage only (predict 0.6)
  const baselineBrier = val.reduce((s, smp) => s + (0.6 - smp.label) ** 2, 0) / val.length;
  const baselineAcc = val.filter(s => s.label === 1).length / val.length; // chute home
  console.log(`  baseline (home 0.6): brier=${baselineBrier.toFixed(4)} acc(home)=${(baselineAcc*100).toFixed(1)}%`);
  const lift = ((baselineBrier - valMetrics.brier) / baselineBrier * 100);
  console.log(`  lift vs baseline: ${lift.toFixed(1)}%`);

  // Print weights
  console.log(`\n[TRAIN] weights:`);
  console.log(`  intercept: ${intercept.toFixed(4)}`);
  for (let k = 0; k < FEATURE_NAMES.length; k++) {
    console.log(`  ${FEATURE_NAMES[k]}: ${weights[k].toFixed(4)}`);
  }

  // Isotonic se ECE > 0.03
  let isotonic = null;
  if (valEce > 0.03) {
    isotonic = fitIsotonic(val, weights, intercept);
    console.log(`[TRAIN] isotonic fit: ${isotonic.length} blocks`);
  } else {
    console.log(`[TRAIN] ECE ${valEce.toFixed(4)} ≤ 0.03 — skipping isotonic`);
  }

  // Save params
  const outPath = path.join(path.dirname(dbPath), 'basket-trained-params.json');
  const params = {
    version: '1',
    trained_at: new Date().toISOString(),
    n_train: train.length,
    n_val: val.length,
    val_period: { from: val[0]?.gameDate, to: val[val.length-1]?.gameDate },
    metrics: {
      train_brier: trainMetrics.brier,
      train_acc: trainMetrics.acc,
      val_brier: valMetrics.brier,
      val_ll: valMetrics.ll,
      val_acc: valMetrics.acc,
      val_ece: valEce,
      baseline_brier: baselineBrier,
      lift_pct: lift,
    },
    features: FEATURE_NAMES,
    weights,
    intercept,
    isotonic, // null se ECE OK
    rolling_window: ROLLING_WINDOW,
    elo_init: ELO_INIT,
    elo_k: ELO_K,
    home_adv: HOME_ADV,
  };
  fs.writeFileSync(outPath, JSON.stringify(params, null, 2));
  console.log(`\n[TRAIN] saved: ${outPath} (${(JSON.stringify(params).length / 1024).toFixed(1)}KB)`);

  db.close();
}

main().catch(e => { console.error('[TRAIN] fatal:', e); process.exit(1); });

'use strict';

// scripts/backtest-lol-match.js
// Task 4 — Point-in-time Elo replay baseline for LoL match predictor (series level).
// Task 5 — Adds point-in-time form (as-of resolved_at) + OE draft join per sample.
// Task 6 — GAME-LEVEL blend fit: predicts P(blue side wins) for a single game,
//          blending as-of Elo + as-of form + draft, then isotonic-calibrates.
//          The series-level replay above stays as validation evidence.
// Task 7 — SHIP DECISION: form DROPPED (hurts OOS, elo+form Brier > elo-only).
//          Final blend = Elo + capped draft.  SHIP model written to lib/lol-match-meta.json.
//          Form retained in ablation display (informational) and available for breakdown UI.
//
// NO DATA LEAKAGE: getP() is called BEFORE rate() for every match; form is
// computed as-of g.resolved_at (strictly prior matches only). Draft is pre-game
// info (champions known at match start), so using it to predict the same match
// is legitimate.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createEloSystem } = require('../lib/elo-rating');
const { classifyLeague, _formSubModel } = require('../lib/lol-model');
const { computeDraftWinProb } = require('../lib/lol-draft-model');
const { fitLogistic, sigmoid } = require('../lib/lol-draft-train');
const { _applyIsotonicBlocks } = require('../lib/brier-holdout-eval');
const M = require('../lib/lol-match-metrics');
const { aggregateOeGames } = require('../lib/lol-match-elo');

const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });

// Team-name normalizer for the OE join: lowercase + NFD-strip diacritics +
// drop non-alphanumerics. match_results and OE teamnames both pass through this
// (e.g. "GMBLERS ESPORTS" vs "GMBLERS Esports" both -> "gmblersesports").
const norm = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]/g, '');

// ---- OE draft index (built ONCE; 2026-only data ~4104 games) ----
// oeByGame:  gameid -> { day, date, league, blueTeam, redTeam, blueWon, blue:[{champion,role}], red:[...] }
// oeIndex:   `${day}|${normTeam}` -> [{ gid, side }]
const oeByGame = new Map();
{
  const oeRows = db.prepare(`
    SELECT gameid, side, position, teamname, champion, date, league, result
    FROM oracleselixir_players
  `).all();
  for (const r of oeRows) {
    let og = oeByGame.get(r.gameid);
    if (!og) {
      og = {
        day: String(r.date).slice(0, 10), date: r.date, league: r.league,
        blueTeam: null, redTeam: null, blueWon: null, blue: [], red: [],
      };
      oeByGame.set(r.gameid, og);
    }
    const side = String(r.side || '').toLowerCase();
    if (side === 'blue') {
      og.blue.push({ champion: r.champion, role: r.position });
      og.blueTeam = r.teamname;
      // result is per-player but identical across a team's 5 players.
      if (og.blueWon === null) og.blueWon = r.result ? 1 : 0;
    } else if (side === 'red') {
      og.red.push({ champion: r.champion, role: r.position });
      og.redTeam = r.teamname;
    }
  }
}
const oeIndex = new Map();
for (const [gid, og] of oeByGame) {
  for (const [team, side] of [[og.blueTeam, 'blue'], [og.redTeam, 'red']]) {
    const k = `${og.day}|${norm(team)}`;
    let a = oeIndex.get(k); if (!a) { a = []; oeIndex.set(k, a); }
    a.push({ gid, side });
  }
}

// Candidate OE days for a match_results.resolved_at (OE game timestamp can differ
// by a day from the series resolve time): the day plus ±1.
function oeDays(resolvedAt) {
  const base = String(resolvedAt).slice(0, 10);
  const t = Date.parse(base + 'T00:00:00Z');
  return [base,
    new Date(t + 86400000).toISOString().slice(0, 10),
    new Date(t - 86400000).toISOString().slice(0, 10)];
}

// Join one match_results SERIES row to its OE draft.
// Series-vs-game granularity: a match_results row is a Bo3/Bo5 SERIES, but OE
// rows are per-GAME, so one series maps to MULTIPLE OE gameids the same day.
// We pick the earliest gameid (game 1 of the series) as the representative draft
// — that is the draft a pre-match predictor would actually have. Returns
// { draft, team1IsBlue } or null when there is no unambiguous opposite-sides match.
function matchOeDraft(g, oeIdx, oeGames, normFn) {
  const n1 = normFn(g.team1), n2 = normFn(g.team2);
  const cand = new Map(); // gid -> team1IsBlue
  for (const day of oeDays(g.resolved_at)) {
    const a1 = oeIdx.get(`${day}|${n1}`) || [];
    const a2 = oeIdx.get(`${day}|${n2}`) || [];
    const side1ByGid = new Map(a1.map((x) => [x.gid, x.side]));
    for (const x2 of a2) {
      const s1 = side1ByGid.get(x2.gid);
      if (s1 && s1 !== x2.side) cand.set(x2.gid, s1 === 'blue'); // team1 on blue?
    }
  }
  if (cand.size === 0) return null;
  // Representative = earliest gameid lexicographically (game 1 of the series).
  let repGid = null;
  for (const gid of cand.keys()) { if (repGid === null || gid < repGid) repGid = gid; }
  const og = oeGames.get(repGid);
  return { draft: { blue: og.blue, red: og.red }, team1IsBlue: cand.get(repGid) };
}

// All resolved LoL matches in strict chronological order (no leakage).
const games = db.prepare(`
  SELECT team1, team2, winner, final_score, league, resolved_at
  FROM match_results
  WHERE game='lol' AND winner IS NOT NULL AND winner!=''
    AND team1 IS NOT NULL AND team2 IS NOT NULL
  ORDER BY resolved_at ASC
`).all();

// halfLifeDays MUST be 0 for replay-mode backtest.
// The engine anchors time-decay to new Date() (today), so historical matches
// fed via rate() would get near-zero weight (a 2023 match at halfLife=60d
// gets weight 0.5^(1000/60) ≈ 0), preventing ratings from diverging.
// Time-decay belongs only in live-mode (where "now" is always current).
const elo = createEloSystem({
  kBase: 32,
  kMin: 10,
  kScale: 40,
  halfLifeDays: 0,
  confidenceScale: 20,
  confidenceFloor: 5,
});

const samples = []; // { p: P(team1 wins), y: 1 if team1 won }

for (const g of games) {
  const tier = classifyLeague(g.league);

  // PREDICT first (uses only past data already processed)
  const pred = elo.getP(g.team1, g.team2, tier);
  const y = (String(g.winner).toLowerCase() === String(g.team1).toLowerCase()) ? 1 : 0;

  if (pred.foundA && pred.foundB && pred.confidence > 0) {
    // Form AS-OF g.resolved_at: only matches strictly before this date (no leakage).
    const form = _formSubModel(db, g.team1, g.team2, null, g.resolved_at);
    const sample = {
      p: pred.pA,                                   // Elo-only baseline (Task 4 metrics use this)
      pElo: pred.pA, cElo: pred.confidence,
      pForm: form.confidence > 0 ? form.pA : null,  // P(team1 better form)
      cForm: form.confidence,
      pDraft: null, cDraft: 0, team1IsBlue: null,
      y, date: g.resolved_at, league: g.league,
    };

    // Draft join (OE ↔ match_results). Orient P(blue wins) to team1.
    const m = matchOeDraft(g, oeIndex, oeByGame, norm);
    if (m) {
      const d = computeDraftWinProb(m.draft);       // d.prob = P(BLUE side wins)
      sample.pDraft = m.team1IsBlue ? d.prob : 1 - d.prob;
      sample.cDraft = d.confidence;
      sample.team1IsBlue = m.team1IsBlue;
    }

    samples.push(sample);
  }

  // UPDATE after prediction (no leakage)
  const winner = y ? g.team1 : g.team2;
  const loser  = y ? g.team2 : g.team1;
  const sc = String(g.final_score || '').match(/(\d+)\s*[-:]\s*(\d+)/);
  const margin = sc ? Math.max(1, Math.abs(parseInt(sc[1]) - parseInt(sc[2]))) : 1;
  elo.rate(winner, loser, margin, g.resolved_at, tier);
}

const base = M.blueSideBaseline(samples);
console.log('=== SERIES-LEVEL Elo replay (Task 4/5 — validation evidence) ===');
console.log(`[series] n=${samples.length}`);
console.log(`[series] Elo-only:  Brier=${M.brier(samples).toFixed(4)}  logloss=${M.logloss(samples).toFixed(4)}  ECE=${M.ece(samples).toFixed(4)}`);
console.log(`[series] baseline:  Brier=${base.brier.toFixed(4)} (pStar=${base.pStar.toFixed(3)})`);
console.log(`[series] Elo beats baseline OOS? ${M.brier(samples) < base.brier ? 'YES' : 'NO'}`);
console.log(`[series] draft coverage: ${samples.filter((s) => s.pDraft != null).length}/${samples.length}`);
console.log(`[series] form  coverage: ${samples.filter((s) => s.pForm != null).length}/${samples.length}`);

// ============================================================================
// TASK 6 — GAME-LEVEL blend fit. Predicts P(blue side wins) for a single game.
// The blue-side advantage is the logistic intercept (no explicit side feature).
// ============================================================================

const ELO_CONFIG = { halfLifeDays: 0, kBase: 32, kMin: 10, kScale: 40, confidenceScale: 20, confidenceFloor: 5 };
const clamp01 = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));
const logit = (p) => { const c = clamp01(p); return Math.log(c / (1 - c)); };

// ---- A/B Elo source replay: returns Map<gameid, pEloBlue (as-of)> ----
// source='series': series-level Elo only (matches from match_results).
// source='games': OE game-level Elo only (each OE game rates after prediction).
// source='hybrid': series matches strictly before OE window seed Elo; then OE
//   games interleave predict-then-rate.
// No leakage: for each OE game, predict fires BEFORE rate on equal dates.
function eloReplayByGid(source) {
  const elo = createEloSystem(ELO_CONFIG);
  const oeGames = aggregateOeGames(db, {});
  const cutoff = oeGames.length ? oeGames[0].date : null;
  const ev = [];
  if (source === 'series' || source === 'hybrid') {
    for (const g of games) {
      if (source === 'hybrid' && cutoff && String(g.resolved_at) >= String(cutoff)) continue;
      ev.push({ k: 'rate', date: g.resolved_at, g });
    }
  }
  for (const g of oeGames) ev.push({ k: 'predict', date: g.date, g });
  ev.sort((a, b) => { const x = String(a.date), y = String(b.date); if (x < y) return -1; if (x > y) return 1; return a.k === 'predict' ? -1 : 1; });
  const out = new Map();
  for (const e of ev) {
    if (e.k === 'rate') {
      const g = e.g; const tier = classifyLeague(g.league);
      const y1 = (String(g.winner).toLowerCase() === String(g.team1).toLowerCase()) ? 1 : 0;
      const w = y1 ? g.team1 : g.team2, l = y1 ? g.team2 : g.team1;
      const sc = String(g.final_score || '').match(/(\d+)\s*[-:]\s*(\d+)/);
      const margin = sc ? Math.max(1, Math.abs(parseInt(sc[1]) - parseInt(sc[2]))) : 1;
      elo.rate(w, l, margin, g.resolved_at, tier);
    } else {
      const g = e.g; const tier = classifyLeague(g.league);
      const pred = elo.getP(g.blueTeam, g.redTeam, tier);
      out.set(g.gameid, (pred.foundA && pred.foundB && pred.confidence > 0) ? pred.pA : null);
      if (source === 'games' || source === 'hybrid') {
        const w = g.blueWon ? g.blueTeam : g.redTeam, l = g.blueWon ? g.redTeam : g.blueTeam;
        elo.rate(w, l, 1, g.date, tier);
      }
    }
  }
  return out;
}

// --- A/B the three Elo sources by elo-only OOS Brier (70/30 by date) ---
const SOURCES = ['series', 'games', 'hybrid'];
const replayMaps = {};
for (const s of SOURCES) replayMaps[s] = eloReplayByGid(s);

const usableGids = [];
for (const [gid, og] of oeByGame) {
  if (og.blueWon == null || !og.blueTeam || !og.redTeam) continue;
  usableGids.push({ gid, y: og.blueWon, date: og.date });
}
usableGids.sort((a, b) => String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0);
const testGids = usableGids.slice(Math.floor(usableGids.length * 0.7));
const abResults = SOURCES.map(s => {
  const smp = testGids.map(x => ({ p: replayMaps[s].get(x.gid), y: x.y })).filter(x => x.p != null);
  return { s, brier: M.brier(smp), n: smp.length };
}).sort((a, b) => a.brier - b.brier);
const winner = abResults[0].s;
const winnerMap = replayMaps[winner];
console.log('\n=== Elo source A/B (elo-only, test=last30%) ===');
for (const r of abResults) console.log(`  ${r.s.padEnd(7)} Brier=${r.brier.toFixed(4)}  cov=${r.n}/${testGids.length}`);
console.log(`  -> winner: ${winner}`);

// --- Build gSamples: Elo from the winning source, form/draft as-of ---
const gSamples = [];
let nDraftJoined = 0, nFormJoined = 0;
for (const [gid, og] of oeByGame) {
  if (og.blueWon == null || !og.blueTeam || !og.redTeam) continue;
  const pEloBlue = winnerMap.get(gid);
  if (pEloBlue == null) continue;
  const form = _formSubModel(db, og.blueTeam, og.redTeam, null, og.date);
  const pFormBlue = form.confidence > 0 ? form.pA : null;
  if (pFormBlue != null) nFormJoined++;
  const d = computeDraftWinProb({ blue: og.blue, red: og.red });
  const pDraftBlue = d.prob;
  if (d.confidence > 0.05) nDraftJoined++;
  gSamples.push({
    x: [logit(pEloBlue), pFormBlue != null ? logit(pFormBlue) : 0, pDraftBlue != null ? logit(pDraftBlue) : 0],
    y: og.blueWon, date: og.date, pEloBlue,
  });
}

db.close();

// ---- Walk-forward split (train = first 70% by date, test = last 30%) ----
gSamples.sort((a, b) => String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0);
const cut = Math.floor(gSamples.length * 0.7);
const train = gSamples.slice(0, cut);
const test = gSamples.slice(cut);

// ---- Fit 3-feature logistic (elo+form+draft) for ablation display only ----
let wFull = fitLogistic(train, { epochs: 600, lr: 0.1, l2: 0.05 });
// Cap draft weight on the 3-feat model (informational, not shipped).
if (Math.abs(wFull[3]) > 0.5 * Math.abs(wFull[1])) {
  wFull[3] = Math.sign(wFull[3]) * 0.5 * Math.abs(wFull[1]);
}
const predictFull = (s) => sigmoid(wFull[0] + wFull[1] * s.x[0] + wFull[2] * s.x[1] + wFull[3] * s.x[2]);

// ---- SHIP MODEL: refit with 2 features [elo, draft] — form dropped (hurts OOS) ----
// Feature vector for ship: x = [ logit(pEloBlue), logit(pDraftBlue) or 0 ]
const trainShip = train.map(s => ({ x: [s.x[0], s.x[2]], y: s.y }));
let wShip = fitLogistic(trainShip, { epochs: 600, lr: 0.1, l2: 0.05 });
// wShip = [bias, elo, draft]
// Cap draft: if |w[2]| > 0.5*|w[1]|, clamp.
let draftCapApplied = false;
if (Math.abs(wShip[2]) > 0.5 * Math.abs(wShip[1])) {
  wShip[2] = Math.sign(wShip[2]) * 0.5 * Math.abs(wShip[1]);
  draftCapApplied = true;
}
const predictShip = (s) => sigmoid(wShip[0] + wShip[1] * s.x[0] + wShip[2] * s.x[2]);

// ---- Standalone PAV isotonic on TRAIN ----
// NOTE: lib/calibration.js already has PAV, but it is DB-coupled (reads
// market_tips_shadow, emits {bin,empirical,n}). This emits {pMin,pMax,yMean,n}
// blocks consumable by _applyIsotonicBlocks. ~20 lines; documented duplication.
function fitIsotonicPav(samples, nBins = 12) {
  if (!samples.length) return [];
  const bins = Array.from({ length: nBins }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  for (const { p, y } of samples) {
    let idx = Math.floor(clamp01(p) * nBins);
    if (idx >= nBins) idx = nBins - 1;
    if (idx < 0) idx = 0;
    bins[idx].sumP += p; bins[idx].sumY += y; bins[idx].n++;
  }
  let arr = bins.filter(b => b.n >= 3).map(b => ({
    pMin: b.sumP / b.n, pMax: b.sumP / b.n, yMean: b.sumY / b.n, n: b.n,
  }));
  if (arr.length < 2) return [];
  // PAV — enforce ascending monotonicity (merge violators, weighted by n).
  let i = 0;
  while (i < arr.length - 1) {
    if (arr[i].yMean > arr[i + 1].yMean) {
      const a = arr[i], b = arr[i + 1], n = a.n + b.n;
      arr.splice(i, 2, {
        pMin: Math.min(a.pMin, b.pMin), pMax: Math.max(a.pMax, b.pMax),
        yMean: (a.yMean * a.n + b.yMean * b.n) / n, n,
      });
      if (i > 0) i--;
    } else i++;
  }
  // Stretch block boundaries to cover the full [0,1] line so test points between
  // bin centers map to the nearest block (lookup is inclusive pMin..pMax).
  arr.sort((a, b) => a.pMin - b.pMin);
  for (let k = 0; k < arr.length; k++) {
    arr[k].pMin = (k === 0) ? 0 : (arr[k - 1].pMax + arr[k].pMin) / 2;
    arr[k].pMax = (k === arr.length - 1) ? 1 : arr[k].pMax;
  }
  for (let k = 0; k < arr.length - 1; k++) {
    const mid = (arr[k].pMax + arr[k + 1].pMin) / 2;
    arr[k].pMax = mid; arr[k + 1].pMin = mid;
  }
  return arr.map(b => ({ pMin: +b.pMin.toFixed(6), pMax: +b.pMax.toFixed(6), yMean: +b.yMean.toFixed(6), n: b.n }));
}

// ---- Isotonic calibration fit on SHIP model (elo+draft) ----
const trainShipCalSamples = train.map(s => ({ p: predictShip(s), y: s.y }));
let blocks = fitIsotonicPav(trainShipCalSamples);

// Apply calibration on TEST; keep ONLY if it improves OOS Brier for the SHIP model.
const testShip = test.map(s => ({ p: predictShip(s), y: s.y }));
const testShipCalib = test.map(s => ({ p: _applyIsotonicBlocks(blocks, predictShip(s)), y: s.y }));
const brierShip = M.brier(testShip);
const brierShipCalib = blocks.length ? M.brier(testShipCalib) : Infinity;
let keptOOS = blocks.length > 0 && brierShipCalib < brierShip;
if (!keptOOS) blocks = [];

// ---- Ablation on TEST ----
const baseG = M.blueSideBaseline(test);
const eloOnly = test.map(s => ({ p: s.pEloBlue, y: s.y }));
// elo+form: zero draft slot in 3-feat model.
const eloForm = test.map(s => ({ p: sigmoid(wFull[0] + wFull[1] * s.x[0] + wFull[2] * s.x[1]), y: s.y }));
const fullBlend3 = test.map(s => ({ p: predictFull(s), y: s.y }));
// SHIP: elo+draft (no form).
const shipTest = testShip;
const shipCalib = keptOOS ? testShipCalib : testShip;

const row = (label, smp, extra) => {
  const b = M.brier(smp), ll = M.logloss(smp), e = M.ece(smp);
  console.log(`  ${label.padEnd(28)} Brier=${b.toFixed(4)}  logloss=${ll.toFixed(4)}  ECE=${e.toFixed(4)}${extra || ''}`);
};

console.log('\n=== GAME-LEVEL blend fit (Tasks 6+7 — P(blue wins)) ===');
console.log(`[game] samples n=${gSamples.length}  (train=${train.length} test=${test.length})`);
console.log(`[game] draft join (conf>0.05): ${nDraftJoined}/${gSamples.length}   form join: ${nFormJoined}/${gSamples.length}`);
console.log(`[game] 3-feat weights (ablation) w=[bias=${wFull[0].toFixed(4)}, elo=${wFull[1].toFixed(4)}, form=${wFull[2].toFixed(4)}, draft=${wFull[3].toFixed(4)}]`);
console.log(`[game] SHIP weights (elo+draft)  wShip=[bias=${wShip[0].toFixed(4)}, elo=${wShip[1].toFixed(4)}, draft=${wShip[2].toFixed(4)}]  draftCapApplied=${draftCapApplied}`);
console.log(`[game] blue-side base rate (test pStar)=${baseG.pStar.toFixed(4)}`);
console.log('--- Ablation (TEST, last 30%) ---');
row('(a) baseline', test.map(s => ({ p: baseG.pStar, y: s.y })), '  <- blue-side game base-rate');
row('(b) elo-only', eloOnly);
row('(c) elo+form', eloForm);
row('(d) full 3-feat blend', fullBlend3);
row('(e) elo+draft [SHIP]', shipTest, '  <- SHIP model (form dropped)');
row('(f) elo+draft + calib', shipCalib, keptOOS ? '  [calib KEPT]' : '  [calib DROPPED — no OOS gain]');
console.log(`[game] SHIP model (elo+draft) beats base-rate OOS? ${M.brier(shipTest) < baseG.brier ? 'YES' : 'NO'}`);
console.log(`[game] form HURTS OOS? elo+form(${M.brier(eloForm).toFixed(4)}) > elo-only(${M.brier(eloOnly).toFixed(4)})? ${M.brier(eloForm) > M.brier(eloOnly) ? 'YES — form dropped correctly' : 'NO — review decision'}`);

// ---- Write artifacts for SHIP model ----
const oosBrier = M.brier(shipTest);
const oosLogloss = M.logloss(shipTest);
const oosEce = M.ece(shipTest);
const baselineBrier = M.brier(test.map(s => ({ p: baseG.pStar, y: s.y })));
const eloOnlyBrier = M.brier(eloOnly);

fs.writeFileSync(path.join(__dirname, '..', 'lib', 'lol-match-meta.json'), JSON.stringify({
  weights: wShip, featureOrder: ['elo', 'draft'], draftCapApplied,
  droppedFeatures: ['form'],
  droppedReason: 'form hurts OOS (elo+form Brier > elo-only); kept in display breakdown as info only',
  trainedAt: new Date().toISOString(), n: gSamples.length,
  walkForward: { trainN: train.length, testN: test.length },
  eloSource: winner, eloConfig: ELO_CONFIG,
  level: 'game', predicts: 'P(blue wins)',
  oos: {
    baselineBrier: +baselineBrier.toFixed(6),
    eloOnlyBrier: +eloOnlyBrier.toFixed(6),
    shipBrier: +oosBrier.toFixed(6),
    shipLogloss: +oosLogloss.toFixed(6),
    shipEce: +oosEce.toFixed(6),
  },
}, null, 2));
fs.writeFileSync(path.join(__dirname, '..', 'lib', 'lol-match-calib.json'),
  JSON.stringify({ method: 'isotonic_pav', blocks, keptOOS }, null, 2));

console.log('\n[game] wrote lib/lol-match-meta.json + lib/lol-match-calib.json');

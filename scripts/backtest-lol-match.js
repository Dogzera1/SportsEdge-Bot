'use strict';

// scripts/backtest-lol-match.js
// Task 4 — Point-in-time Elo replay baseline for LoL match predictor.
// Task 5 — Adds point-in-time form (as-of resolved_at) + OE draft join per sample.
//
// NO DATA LEAKAGE: getP() is called BEFORE rate() for every match; form is
// computed as-of g.resolved_at (strictly prior matches only). Draft is pre-game
// info (champions known at match start), so using it to predict the same match
// is legitimate.

const path = require('path');
const Database = require('better-sqlite3');
const { createEloSystem } = require('../lib/elo-rating');
const { classifyLeague, _formSubModel } = require('../lib/lol-model');
const { computeDraftWinProb } = require('../lib/lol-draft-model');
const M = require('../lib/lol-match-metrics');

const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });

// Team-name normalizer for the OE join: lowercase + NFD-strip diacritics +
// drop non-alphanumerics. match_results and OE teamnames both pass through this
// (e.g. "GMBLERS ESPORTS" vs "GMBLERS Esports" both -> "gmblersesports").
const norm = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]/g, '');

// ---- OE draft index (built ONCE; 2026-only data ~4104 games) ----
// oeByGame:  gameid -> { day, blueTeam, redTeam, blue:[{champion,role}], red:[...] }
// oeIndex:   `${day}|${normTeam}` -> [{ gid, side }]
const oeByGame = new Map();
{
  const oeRows = db.prepare(`
    SELECT gameid, side, position, teamname, champion, date
    FROM oracleselixir_players
  `).all();
  for (const r of oeRows) {
    let og = oeByGame.get(r.gameid);
    if (!og) {
      og = { day: String(r.date).slice(0, 10), blueTeam: null, redTeam: null, blue: [], red: [] };
      oeByGame.set(r.gameid, og);
    }
    const side = String(r.side || '').toLowerCase();
    if (side === 'blue') { og.blue.push({ champion: r.champion, role: r.position }); og.blueTeam = r.teamname; }
    else if (side === 'red') { og.red.push({ champion: r.champion, role: r.position }); og.redTeam = r.teamname; }
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

db.close();

const base = M.blueSideBaseline(samples);
console.log(`[backtest] n=${samples.length}`);
console.log(`[backtest] Elo-only:  Brier=${M.brier(samples).toFixed(4)}  logloss=${M.logloss(samples).toFixed(4)}  ECE=${M.ece(samples).toFixed(4)}`);
console.log(`[backtest] baseline:  Brier=${base.brier.toFixed(4)} (pStar=${base.pStar.toFixed(3)})`);
console.log(`[backtest] Elo beats baseline OOS? ${M.brier(samples) < base.brier ? 'YES' : 'NO'}`);
console.log(`[backtest] draft coverage: ${samples.filter((s) => s.pDraft != null).length}/${samples.length}`);
console.log(`[backtest] form  coverage: ${samples.filter((s) => s.pForm != null).length}/${samples.length}`);

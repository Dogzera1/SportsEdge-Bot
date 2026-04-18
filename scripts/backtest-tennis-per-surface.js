#!/usr/bin/env node
'use strict';

/**
 * backtest-tennis-per-surface.js
 *
 * Walk-forward Elo por superfície em match_results tennis. Segmenta resultado
 * por (surface × tier × bestOf) pra identificar onde o modelo realmente tem
 * edge vs onde quebra.
 *
 * Métricas por segmento: Brier, LogLoss, Accuracy, ECE, n.
 *
 * Saída: tabela console + JSON em data/tennis-backtest-per-surface.json.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { tournamentTier, tennisProhibitedTournament, detectSurface } = require('../lib/tennis-model');

const DB_PATH = path.resolve(__dirname, '..', 'sportsedge.db');
const OUT_PATH = path.resolve(__dirname, '..', 'data', 'tennis-backtest-per-surface.json');
const MIN_WARMUP = 10; // mínimo de matches por jogador antes de contar predição
const K_BASE = 32;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
}

function eloExpected(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function parseBestOf(finalScore, league) {
  const s = String(finalScore || '') + ' ' + String(league || '');
  if (/grand slam|\[g\]|wimbledon|us open|roland|australian open/i.test(s)) return 5;
  if (/\bbo5\b/i.test(s)) return 5;
  return 3;
}

function surfaceKey(league) {
  const s = detectSurface(league);
  if (s === 'grama') return 'grass';
  if (s === 'saibro') return 'clay';
  return 'hard';
}

function brier(p, y) { return (p - y) ** 2; }
function logloss(p, y) {
  const eps = 1e-12;
  const pc = Math.max(eps, Math.min(1 - eps, p));
  return -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
}
function computeECE(preds, outcomes, n = 10) {
  const buckets = Array.from({ length: n }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  for (let i = 0; i < preds.length; i++) {
    const idx = Math.min(n - 1, Math.floor(preds[i] * n));
    buckets[idx].sumP += preds[i]; buckets[idx].sumY += outcomes[i]; buckets[idx].n++;
  }
  let e = 0;
  for (const b of buckets) {
    if (!b.n) continue;
    e += (b.n / preds.length) * Math.abs(b.sumP / b.n - b.sumY / b.n);
  }
  return e;
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT team1, team2, winner, final_score, league, resolved_at
    FROM match_results
    WHERE game = 'tennis'
      AND winner IS NOT NULL AND winner != ''
      AND team1 IS NOT NULL AND team1 != ''
      AND team2 IS NOT NULL AND team2 != ''
      AND resolved_at IS NOT NULL
    ORDER BY resolved_at ASC
  `).all();
  console.log(`[backtest-tn] ${rows.length} matches loaded`);

  // Fix data bias: 98% das rows históricas têm team1=winner. Shuffle determinístico.
  function _hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return h; }
  const shuffled = rows.map(r => {
    const seed = _hash((r.team1 || '') + '|' + (r.team2 || '') + '|' + (r.resolved_at || ''));
    if (seed % 2 === 1) return { ...r, team1: r.team2, team2: r.team1 };
    return r;
  });
  // Substitui rows pelo shuffled pro resto do fluxo
  rows.length = 0;
  for (const r of shuffled) rows.push(r);

  // Estado Elo: player → { overall, hard, clay, grass, games:{overall, hard, clay, grass} }
  const state = new Map();
  function getP(name) {
    const k = norm(name);
    if (!state.has(k)) {
      state.set(k, {
        name, overall: 1500, hard: 1500, clay: 1500, grass: 1500,
        games: { overall: 0, hard: 0, clay: 0, grass: 0 },
      });
    }
    return state.get(k);
  }

  // Segmentos: surface × tier × bestOf
  const segments = new Map(); // key → { preds:[], outs:[], brier:0, ll:0, correct:0, n:0 }
  const segKey = (surf, tier, bo) => `${surf}|${tier}|Bo${bo}`;

  let predicted = 0, skipped = 0, excluded = 0;

  for (const r of rows) {
    const surf = surfaceKey(r.league);
    const tier = tournamentTier(r.league);
    const bo = parseBestOf(r.final_score, r.league);

    // Exclusão ITF low-tier (consistente com wire em produção)
    const proh = tennisProhibitedTournament(r.league);
    if (proh.prohibited) {
      excluded++;
      continue;
    }

    const p1 = getP(r.team1);
    const p2 = getP(r.team2);

    // Só prediz após warmup mínimo
    const shouldPredict = (p1.games.overall >= MIN_WARMUP) && (p2.games.overall >= MIN_WARMUP);
    if (!shouldPredict) { skipped++; /* mas atualiza Elo abaixo */ }

    // Blend: 60% surface + 40% overall, se tem games suficientes na superfície
    const hasSurf = p1.games[surf] >= 3 && p2.games[surf] >= 3;
    const rating1 = hasSurf ? 0.6 * p1[surf] + 0.4 * p1.overall : p1.overall;
    const rating2 = hasSurf ? 0.6 * p2[surf] + 0.4 * p2.overall : p2.overall;
    const pA = eloExpected(rating1, rating2);
    const y = norm(r.winner) === norm(r.team1) ? 1 : 0;

    if (shouldPredict) {
      predicted++;
      const key = segKey(surf, tier, bo);
      if (!segments.has(key)) segments.set(key, { preds: [], outs: [], n: 0 });
      const seg = segments.get(key);
      seg.preds.push(pA); seg.outs.push(y); seg.n++;
    }

    // Update Elo (sempre, independente de predicted)
    const score1 = y;
    const k = K_BASE * (1 + 0.5 * Math.max(0, 1 - p1.games.overall / 40));
    const expW = eloExpected(rating1, rating2);
    const delta = k * (score1 - expW);
    p1.overall += delta;
    p2.overall -= delta;
    p1[surf] += delta;
    p2[surf] -= delta;
    p1.games.overall++; p2.games.overall++;
    p1.games[surf]++; p2.games[surf]++;
  }

  console.log(`[backtest-tn] predicted=${predicted} skipped_warmup=${skipped} excluded_itf=${excluded}`);

  // Compila métricas por segmento
  const results = [];
  for (const [key, seg] of segments) {
    if (seg.n < 30) continue; // mínimo pra estatística
    let briSum = 0, llSum = 0, correct = 0;
    for (let i = 0; i < seg.n; i++) {
      briSum += brier(seg.preds[i], seg.outs[i]);
      llSum += logloss(seg.preds[i], seg.outs[i]);
      if ((seg.preds[i] >= 0.5 ? 1 : 0) === seg.outs[i]) correct++;
    }
    const [surf, tier, bo] = key.split('|');
    results.push({
      surface: surf, tier, bestOf: bo,
      n: seg.n,
      brier: +(briSum / seg.n).toFixed(4),
      logloss: +(llSum / seg.n).toFixed(4),
      acc: +(correct / seg.n).toFixed(4),
      ece: +computeECE(seg.preds, seg.outs).toFixed(4),
    });
  }
  results.sort((a, b) => b.n - a.n);

  // Overall baseline
  let oBri = 0, oLl = 0, oCor = 0, oN = 0;
  const oPreds = [], oOuts = [];
  for (const seg of segments.values()) {
    for (let i = 0; i < seg.n; i++) {
      oBri += brier(seg.preds[i], seg.outs[i]);
      oLl += logloss(seg.preds[i], seg.outs[i]);
      if ((seg.preds[i] >= 0.5 ? 1 : 0) === seg.outs[i]) oCor++;
      oN++;
      oPreds.push(seg.preds[i]); oOuts.push(seg.outs[i]);
    }
  }
  const overall = {
    n: oN,
    brier: +(oBri / oN).toFixed(4),
    logloss: +(oLl / oN).toFixed(4),
    acc: +(oCor / oN).toFixed(4),
    ece: +computeECE(oPreds, oOuts).toFixed(4),
  };

  console.log('\n── OVERALL ──');
  console.log(`n=${overall.n} | Brier=${overall.brier} | LogLoss=${overall.logloss} | Acc=${(overall.acc*100).toFixed(1)}% | ECE=${overall.ece}`);

  console.log('\n── POR SEGMENTO (n ≥ 30) ──');
  console.log('Surface  Tier         Bo  | n     Brier    LL       Acc     ECE   | vs overall Brier');
  console.log('---------|------------|-----|-------|--------|--------|--------|------|------');
  for (const s of results) {
    const delta = s.brier - overall.brier;
    const deltaStr = (delta >= 0 ? '+' : '') + delta.toFixed(4);
    const flag = Math.abs(delta) >= 0.015 ? (delta < 0 ? ' ✓ strong' : ' ✗ weak') : '';
    console.log(`${s.surface.padEnd(8)} ${s.tier.padEnd(11)} ${s.bestOf.padEnd(4)} | ${String(s.n).padStart(5)} | ${s.brier.toFixed(4)} | ${s.logloss.toFixed(4)} | ${(s.acc*100).toFixed(1).padStart(5)}% | ${s.ece.toFixed(4)} | ${deltaStr.padStart(7)}${flag}`);
  }

  // Save
  const outDir = path.dirname(OUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ overall, segments: results, meta: { ranAt: new Date().toISOString(), nMatches: rows.length, predicted, excluded, skipped } }, null, 2));
  console.log(`\n→ Saved: ${OUT_PATH}`);

  // Destaques
  const strong = results.filter(s => s.brier < overall.brier - 0.015);
  const weak = results.filter(s => s.brier > overall.brier + 0.015);
  console.log('\n── RECOMENDAÇÃO ──');
  if (strong.length) {
    console.log('Segmentos FORTES (Brier ≥1.5pp melhor que overall):');
    for (const s of strong) console.log(`  ✓ ${s.surface}/${s.tier}/Bo${s.bestOf} → Brier ${s.brier} (n=${s.n})`);
  }
  if (weak.length) {
    console.log('Segmentos FRACOS (Brier ≥1.5pp pior que overall):');
    for (const s of weak) console.log(`  ✗ ${s.surface}/${s.tier}/Bo${s.bestOf} → Brier ${s.brier} (n=${s.n}) — considerar downweight`);
  }
  if (!strong.length && !weak.length) {
    console.log('Modelo relativamente homogêneo across segments.');
  }
}

main();

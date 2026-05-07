#!/usr/bin/env node
'use strict';

/**
 * calibrate-lol-momentum.js
 *
 * Calibra o parâmetro `momentum` do lol-series-model via ajuste de distribuição
 * de placares finais (Bo3: 2-0 / 2-1 / 1-2 / 0-2, Bo5: 3-0 / 3-1 / 3-2 / 2-3 / 1-3 / 0-3).
 *
 * Por que não calibramos P(winner) diretamente: momentum afeta marginalmente a P
 * de série quando pMap≈0.5. O sinal forte está na FREQUÊNCIA de sweeps (2-0 / 3-0)
 * — se momentum>0, sweeps são mais comuns do que independência prevê.
 *
 * Método:
 *   1. Bootstrap Elo nos primeiros 80% dos matches (cronológico).
 *   2. Pros últimos 20%, deriva pMap = mapProbFromSeries(Elo pA, bestOf).
 *   3. Pra cada momentum candidato, pré-computa lookup table
 *      P(score_outcome | pMap bucket, bestOf, momentum) via Monte Carlo (20k iters).
 *   4. Score = log-likelihood do placar observado sob cada momentum.
 *   5. Reporta melhor momentum + intervalo de confiança approximado.
 *
 * Limitações:
 *   - Sem sequência de mapas (quem ganhou mapa N), momentum não-independente é
 *     apenas inferido via distribuição agregada de placares.
 *   - Confunde sinal de momentum com erro do Elo no pMap estimado.
 */

const path = require('path');
const Database = require('better-sqlite3');
const { createEloSystem } = require('../lib/elo-rating');
const { mapProbFromSeries, seriesProbFromMap } = require('../lib/lol-series-model');
const { classifyLeague } = require('../lib/lol-model');

const DB_PATH = path.resolve(__dirname, '..', 'sportsedge.db');
// 2026-05-07: expandir candidates pra capturar momentum maior (shadow audit
// suggests current 0.03 underfits — UNDER 2.5 ROI -22% ⇒ sweep prob overestimate)
const MOMENTUM_CANDIDATES = [0, 0.015, 0.03, 0.045, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20];
const PMAP_BUCKETS = 41; // 0.30 .. 0.70 em passos de 0.01 (favoritos extremos são raros)
const PMAP_MIN = 0.30, PMAP_MAX = 0.70;
const MC_ITERS = 20000;
const TRAIN_FRACTION = 0.80;

// 2026-05-07: tier filter — refit por tier separadamente. CLI:
//   node scripts/calibrate-lol-momentum.js --tier-filter=tier1
//   --tier-filter=all (default)
// Tier classification matches bot.js:8451 _lolTier:
//   tier1: LCK/LPL/LCS/LEC/Worlds/MSI/EWC/First Stand
//   tier2: Challengers/Academy/CBLOL/LFL/etc
const _argvLol = process.argv.slice(2);
const _tierFilterArg = _argvLol.find(a => a.startsWith('--tier-filter='));
const TIER_FILTER = _tierFilterArg ? _tierFilterArg.split('=')[1].toLowerCase() : 'all';
function _matchesTierFilter(league) {
  if (TIER_FILTER === 'all') return true;
  const lg = String(league || '');
  if (TIER_FILTER === 'tier1') return /^(LCK|LPL|LCS|LEC|Worlds|MSI|Esports World Cup|EWC|First Stand)/i.test(lg);
  if (TIER_FILTER === 'tier2') return /Challengers|Academy|NACL|LFL|CBLOL|Prime League|TCL|LCP|Ultraliga|Arabian|Hitpoint|Ebl|Lit|Lrn|Lrs|Les|Liga Portuguesa|GLL|Hellenic/i.test(lg);
  return true;
}

function parseScore(finalScore) {
  // "Bo3 2-1" → { bestOf: 3, s1: 2, s2: 1 }
  if (!finalScore) return null;
  const m = String(finalScore).match(/Bo(\d)\s+(\d+)-(\d+)/i);
  if (!m) return null;
  const bo = parseInt(m[1], 10), s1 = parseInt(m[2], 10), s2 = parseInt(m[3], 10);
  if (bo < 3) return null; // BO1 não informa nada sobre momentum
  const winsNeeded = Math.ceil(bo / 2);
  if (Math.max(s1, s2) !== winsNeeded) return null;
  return { bestOf: bo, s1, s2 };
}

function simulateScoreDist(pMap, bestOf, momentum, iters) {
  const winsNeeded = Math.ceil(bestOf / 2);
  const counts = new Map();
  for (let it = 0; it < iters; it++) {
    let w1 = 0, w2 = 0, lastWinner = 0;
    while (w1 < winsNeeded && w2 < winsNeeded) {
      let p = pMap;
      if (lastWinner === 1) p += momentum;
      else if (lastWinner === 2) p -= momentum;
      if (p < 0.05) p = 0.05; else if (p > 0.95) p = 0.95;
      if (Math.random() < p) { w1++; lastWinner = 1; }
      else { w2++; lastWinner = 2; }
    }
    const key = `${w1}-${w2}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const dist = {};
  for (const [k, v] of counts) dist[k] = v / iters;
  return dist;
}

function quantizePMap(p) {
  const clamped = Math.max(PMAP_MIN, Math.min(PMAP_MAX, p));
  const step = (PMAP_MAX - PMAP_MIN) / (PMAP_BUCKETS - 1);
  const idx = Math.round((clamped - PMAP_MIN) / step);
  return { idx, p: PMAP_MIN + idx * step };
}

async function main() {
  console.log('Connecting to DB:', DB_PATH);
  const db = new Database(DB_PATH, { readonly: true });

  // 1. Carrega matches LoL cronologicamente
  const all = db.prepare(`
    SELECT team1, team2, winner, final_score, league, resolved_at
    FROM match_results
    WHERE game = 'lol' AND winner IS NOT NULL AND winner != ''
      AND final_score LIKE 'Bo%'
      AND resolved_at >= datetime('now', '-2 years')
    ORDER BY resolved_at ASC
  `).all();
  console.log(`Total LoL matches (2y): ${all.length}`);

  // Parse + filter series only
  const series = [];
  let tierFilteredOut = 0;
  for (const r of all) {
    const sc = parseScore(r.final_score);
    if (!sc) continue;
    // 2026-05-07: tier filter aplicado aqui pra fit per-tier (refit recomendado
    // quando bot opera com LOL_MOMENTUM_TIER1 / LOL_MOMENTUM_TIER2 envs)
    if (!_matchesTierFilter(r.league)) { tierFilteredOut++; continue; }
    series.push({ ...r, ...sc });
  }
  console.log(`BO3/BO5 series: ${series.length} (tier-filter='${TIER_FILTER}', filtered out: ${tierFilteredOut})`);

  // Split chronológico
  const splitIdx = Math.floor(series.length * TRAIN_FRACTION);
  const train = series.slice(0, splitIdx);
  const test = series.slice(splitIdx);
  console.log(`Train: ${train.length} | Test: ${test.length}`);

  // 2. Bootstrap Elo no train
  const elo = createEloSystem({
    initialRating: 1500,
    kBase: 32, kMin: 10, kScale: 40,
    halfLifeDays: 60, homeAdvantage: 0,
    marginFactor: 0.5, confidenceScale: 20, confidenceFloor: 5,
  });
  // Mini match_results em memória pro bootstrap? Nope — usa o DB direto via método.
  // createEloSystem.bootstrap espera rows do DB. Como já filtramos, recriamos stmt.
  // Mais simples: processa train manualmente aplicando updates.
  for (const m of train) {
    const tier = classifyLeague(m.league);
    const winner1 = (m.winner || '').trim() === (m.team1 || '').trim();
    const winnerName = winner1 ? m.team1 : m.team2;
    const loserName  = winner1 ? m.team2 : m.team1;
    const margin = Math.abs(m.s1 - m.s2); // 2-0 → 2, 2-1 → 1
    elo.rate(winnerName, loserName, margin, m.resolved_at, tier);
  }
  console.log('Elo bootstrap done.');

  // 3. Pré-computa lookup: dist[bestOf][momentumIdx][pMapIdx] = { '2-0': 0.36, ... }
  console.log('Pre-computing score distributions...');
  const lookup = { 3: [], 5: [] };
  for (const bo of [3, 5]) {
    for (let mi = 0; mi < MOMENTUM_CANDIDATES.length; mi++) {
      const m = MOMENTUM_CANDIDATES[mi];
      const row = [];
      for (let bi = 0; bi < PMAP_BUCKETS; bi++) {
        const step = (PMAP_MAX - PMAP_MIN) / (PMAP_BUCKETS - 1);
        const pMap = PMAP_MIN + bi * step;
        row.push(simulateScoreDist(pMap, bo, m, MC_ITERS));
      }
      lookup[bo].push(row);
    }
  }
  console.log('Lookup done.');

  // 4. Scoring: log-likelihood por momentum
  const logL = new Array(MOMENTUM_CANDIDATES.length).fill(0);
  const nCounted = new Array(MOMENTUM_CANDIDATES.length).fill(0);
  let skipped = 0;

  for (const m of test) {
    const tier = classifyLeague(m.league);
    const exp = elo.getP(m.team1, m.team2, tier);
    if (!exp.foundA || !exp.foundB || exp.confidence < 0.3) { skipped++; continue; }
    const pSeries = exp.pA;
    const pMap = mapProbFromSeries(pSeries, m.bestOf);
    const { idx } = quantizePMap(pMap);
    const label = `${m.s1}-${m.s2}`;
    for (let mi = 0; mi < MOMENTUM_CANDIDATES.length; mi++) {
      const dist = lookup[m.bestOf][mi][idx];
      const p = (dist[label] ?? 0) + 1e-6; // laplace
      logL[mi] += Math.log(p);
      nCounted[mi]++;
    }
  }
  console.log(`Scored ${nCounted[0]} matches | skipped (no Elo): ${skipped}`);

  // 5. Reporta
  console.log('\n── Log-likelihood por momentum ──');
  console.log('momentum | logL         | per-match     | Δ vs 0');
  const baseL = logL[0] / nCounted[0];
  let bestIdx = 0, bestVal = -Infinity;
  for (let mi = 0; mi < MOMENTUM_CANDIDATES.length; mi++) {
    const perMatch = logL[mi] / nCounted[mi];
    const delta = perMatch - baseL;
    if (perMatch > bestVal) { bestVal = perMatch; bestIdx = mi; }
    console.log(`${MOMENTUM_CANDIDATES[mi].toFixed(3).padStart(8)} | ${logL[mi].toFixed(2).padStart(12)} | ${perMatch.toFixed(5).padStart(13)} | ${(delta * nCounted[mi]).toFixed(2)}`);
  }
  console.log(`\nBest momentum: ${MOMENTUM_CANDIDATES[bestIdx]} (logL/match = ${bestVal.toFixed(5)})`);
  if (bestIdx === 0) {
    console.log('Interpretação: dados não distinguem momentum>0 de independência. Manter momentum=0.');
  } else {
    const lrt = 2 * (logL[bestIdx] - logL[0]); // likelihood ratio
    console.log(`LRT vs momentum=0: χ² = ${lrt.toFixed(2)} (df=1, p<0.05 se >3.84)`);
  }
}

main().catch(e => { console.error('ERR:', e); process.exit(1); });

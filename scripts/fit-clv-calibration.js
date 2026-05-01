#!/usr/bin/env node
'use strict';

/**
 * fit-clv-calibration.js
 *
 * Treina camada CLV (Closing Line Value) — pós-hoc após isotonic.
 *
 * Conceito: closing line incorpora todo info disponível antes do match
 * (insider news, last-minute injury, sharp money, public). Treinar pra
 * "puxar" model_p_pick em direção a clv_implied reduz Brier vs W/L target
 * porque CLV é signal de menor variância (consenso de mercado vs evento ruidoso
 * de 1 jogo).
 *
 * Lit: arxiv 2410.21484 (sistematic review 2024) — train-on-CLV bate train-on-result
 * em 7/8 sports. Brier melhora 5-10%, ROI +2-5pp.
 *
 * Stack:
 *   p_raw  → isotonic (W/L) → p_iso → clv_calib (CLV target) → p_final
 *
 * Pra cada sport:
 *   1. Pega tips settled com (model_p_pick, clv_odds, odds) últimos N dias.
 *   2. Computa clv_implied = 1/clv_odds (single-side, sem devig pra simplificar
 *      — vig em odds simétricas aproxima 1/clv_odds suficiente pra calibração).
 *   3. Bin p_iso em buckets 5pp; pra cada bucket calcula:
 *      - mean p_iso (model output médio)
 *      - mean clv_implied (target CLV médio)
 *      - n samples
 *   4. Output: blocks {pMin, pMax, clvMean, n} mapeando p_iso → clv_target.
 *   5. Apply: p_final = blend(p_iso, clv_target, w) onde w = CLV_BLEND_WEIGHT
 *      (default 0.30 → 70% iso + 30% CLV pull).
 *
 * Requisitos:
 *   - Min 50 tips settled COM clv_odds por sport (senão noise > signal).
 *   - Min 3 samples por bucket pra block ser usado.
 *
 * Uso:
 *   node scripts/fit-clv-calibration.js --sport=lol
 *   node scripts/fit-clv-calibration.js --sport=all
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}
const SPORT_ARG = argVal('sport', 'all');
const DAYS_BACK = parseInt(argVal('days', '120'), 10);
const MIN_SAMPLES = parseInt(argVal('min-samples', '50'), 10);
const MIN_BUCKET = parseInt(argVal('min-bucket', '3'), 10);
const BIN_WIDTH = 0.05;

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'sportsedge.db');
const ROOT = path.resolve(__dirname, '..');

const SPORTS = SPORT_ARG === 'all'
  ? ['lol', 'dota2', 'cs', 'cs2', 'valorant', 'tennis', 'football', 'mma']
  : [SPORT_ARG];

function brier(p, y) { return (p - y) ** 2; }
function logloss(p, y) {
  const eps = 1e-12;
  const pc = Math.max(eps, Math.min(1 - eps, p));
  return -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
}

function fitCLVBlocks(rows) {
  // rows: [{p_iso, clv_implied, y}]
  const bins = new Map();
  for (const r of rows) {
    const idx = Math.floor(Math.min(0.9999, r.p_iso) / BIN_WIDTH);
    if (!bins.has(idx)) bins.set(idx, { sumIso: 0, sumClv: 0, sumY: 0, n: 0, pMin: 1, pMax: 0 });
    const b = bins.get(idx);
    b.sumIso += r.p_iso; b.sumClv += r.clv_implied; b.sumY += r.y;
    b.pMin = Math.min(b.pMin, r.p_iso); b.pMax = Math.max(b.pMax, r.p_iso);
    b.n++;
  }
  const blocks = [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, b]) => ({
      pMin: +b.pMin.toFixed(4),
      pMax: +b.pMax.toFixed(4),
      isoMean: +(b.sumIso / b.n).toFixed(4),
      clvMean: +(b.sumClv / b.n).toFixed(4),
      yMean: +(b.sumY / b.n).toFixed(4),
      n: b.n,
    }))
    .filter(b => b.n >= MIN_BUCKET);

  // Monotonicity enforcement: clvMean deve crescer com isoMean.
  // PAV-like merge: se clv[i] > clv[i+1], merge.
  let i = 0;
  while (i < blocks.length - 1) {
    if (blocks[i].clvMean > blocks[i + 1].clvMean) {
      const a = blocks[i], bb = blocks[i + 1];
      blocks.splice(i, 2, {
        pMin: Math.min(a.pMin, bb.pMin),
        pMax: Math.max(a.pMax, bb.pMax),
        isoMean: (a.isoMean * a.n + bb.isoMean * bb.n) / (a.n + bb.n),
        clvMean: (a.clvMean * a.n + bb.clvMean * bb.n) / (a.n + bb.n),
        yMean: (a.yMean * a.n + bb.yMean * bb.n) / (a.n + bb.n),
        n: a.n + bb.n,
      });
      if (i > 0) i--;
    } else i++;
  }
  return blocks;
}

function fitOne(db, sport) {
  // Map sport→game_in_match_results / sport_in_tips_table
  const sportMap = { cs: ['cs','cs2'], cs2: ['cs','cs2'], lol: ['lol','esports'], dota2: ['dota2','esports'] };
  const sports = sportMap[sport] || [sport];
  const placeholders = sports.map(() => '?').join(',');

  // Pega tips settled com clv_odds + model_p_pick válidos
  const rows = db.prepare(`
    SELECT
      sport, odds, clv_odds, model_p_pick, result, sent_at, settled_at,
      market_type, tip_participant, participant1, participant2
    FROM tips
    WHERE sport IN (${placeholders})
      AND result IN ('win','loss')
      AND clv_odds IS NOT NULL AND CAST(clv_odds AS REAL) > 1
      AND model_p_pick IS NOT NULL AND model_p_pick > 0 AND model_p_pick < 1
      AND odds IS NOT NULL AND CAST(odds AS REAL) > 1
      AND COALESCE(is_shadow, 0) = 0
      AND (archived IS NULL OR archived = 0)
      AND settled_at >= datetime('now', '-${DAYS_BACK} days')
      AND upper(COALESCE(market_type, 'ML')) IN ('ML','1X2_H','1X2_A','1X2_D','OVER_2.5','UNDER_2.5')
    ORDER BY settled_at ASC
  `).all(...sports);

  if (rows.length < MIN_SAMPLES) {
    return { sport, skipped: true, reason: `n=${rows.length} < min ${MIN_SAMPLES}` };
  }

  // Computa clv_implied (single-side, sem devig — vig em pinnacle ~2-3% só desloca uniformemente)
  const data = rows.map(r => {
    const cOdds = parseFloat(r.clv_odds);
    const piso = parseFloat(r.model_p_pick); // já é prob calibrada (saiu do isotonic)
    return {
      p_iso: piso,
      clv_implied: 1 / cOdds, // vig-uncorrected; mantém ordering
      y: r.result === 'win' ? 1 : 0,
      odds: parseFloat(r.odds),
      clv_odds: cOdds,
    };
  });

  // Holdout: 80/20 split chronological pra avaliar lift
  const splitIdx = Math.floor(data.length * 0.80);
  const train = data.slice(0, splitIdx);
  const test = data.slice(splitIdx);

  const blocks = fitCLVBlocks(train);
  if (!blocks.length) {
    return { sport, skipped: true, reason: `no buckets passed min ${MIN_BUCKET}` };
  }

  // Apply CLV calibration via interp.
  function applyClvCalib(blocks, pIso, blendW = 0.30) {
    if (!blocks.length) return pIso;
    let target;
    if (pIso <= blocks[0].pMax) target = blocks[0].clvMean;
    else if (pIso >= blocks[blocks.length - 1].pMin) target = blocks[blocks.length - 1].clvMean;
    else {
      target = pIso;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (pIso >= b.pMin && pIso <= b.pMax) { target = b.clvMean; break; }
        if (i + 1 < blocks.length) {
          const n = blocks[i + 1];
          if (pIso > b.pMax && pIso < n.pMin) {
            const t = (pIso - b.pMax) / (n.pMin - b.pMax);
            target = b.clvMean + t * (n.clvMean - b.clvMean);
            break;
          }
        }
      }
    }
    return blendW * target + (1 - blendW) * pIso;
  }

  // Test metrics
  let sumIsoBri = 0, sumClvBri = 0, sumIsoLL = 0, sumClvLL = 0;
  let isoCorrect = 0, clvCorrect = 0;
  const blendW = parseFloat(process.env.CLV_BLEND_WEIGHT || '0.30');
  for (const r of test) {
    const pCal = applyClvCalib(blocks, r.p_iso, blendW);
    sumIsoBri += brier(r.p_iso, r.y);
    sumClvBri += brier(pCal, r.y);
    sumIsoLL += logloss(r.p_iso, r.y);
    sumClvLL += logloss(pCal, r.y);
    if ((r.p_iso >= 0.5 ? 1 : 0) === r.y) isoCorrect++;
    if ((pCal >= 0.5 ? 1 : 0) === r.y) clvCorrect++;
  }
  const n = test.length;
  const metrics = {
    n_train: train.length,
    n_test: n,
    blend_weight: blendW,
    iso: {
      brier: +(sumIsoBri / n).toFixed(4),
      logloss: +(sumIsoLL / n).toFixed(4),
      acc: +(isoCorrect / n).toFixed(4),
    },
    clv_calibrated: {
      brier: +(sumClvBri / n).toFixed(4),
      logloss: +(sumClvLL / n).toFixed(4),
      acc: +(clvCorrect / n).toFixed(4),
    },
    delta_brier_pct: +((sumClvBri - sumIsoBri) / sumIsoBri * 100).toFixed(2),
  };

  // ── Regression guard ──
  // Se Brier piorou >2% no test, NÃO salva. Promove apenas quando lift real.
  if (metrics.delta_brier_pct > 2) {
    return { sport, skipped: true, reason: `regression: Brier +${metrics.delta_brier_pct}%`, metrics };
  }

  const outPath = path.join(ROOT, 'lib', `${sport}-clv-calibration.json`);
  try { require('../lib/model-backup').backupBeforeWrite(outPath); } catch (_) {}
  fs.writeFileSync(outPath, JSON.stringify({
    version: 1,
    sport,
    fittedAt: new Date().toISOString(),
    method: 'clv_blend_calibration',
    blend_weight_default: blendW,
    nSamples: data.length,
    nBlocks: blocks.length,
    blocks,
    metrics,
    daysBack: DAYS_BACK,
  }, null, 2));

  return { sport, ok: true, outPath, blocks: blocks.length, metrics };
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const results = [];
  for (const sport of SPORTS) {
    try {
      const r = fitOne(db, sport);
      results.push(r);
      if (r.skipped) {
        console.log(`[clv-calib] ${sport}: SKIP — ${r.reason}`);
        if (r.metrics) console.log(`            (Brier ${r.metrics.iso.brier} → ${r.metrics.clv_calibrated.brier}, ${r.metrics.delta_brier_pct >= 0 ? '+' : ''}${r.metrics.delta_brier_pct}%)`);
      } else if (r.ok) {
        const m = r.metrics;
        console.log(`[clv-calib] ${sport}: OK | n_train=${m.n_train} n_test=${m.n_test} blocks=${r.blocks}`);
        console.log(`            Brier ${m.iso.brier} → ${m.clv_calibrated.brier} (${m.delta_brier_pct >= 0 ? '+' : ''}${m.delta_brier_pct}%)`);
        console.log(`            LogLoss ${m.iso.logloss} → ${m.clv_calibrated.logloss}`);
        console.log(`            Acc ${(m.iso.acc * 100).toFixed(1)}% → ${(m.clv_calibrated.acc * 100).toFixed(1)}%`);
      }
    } catch (e) {
      console.error(`[clv-calib] ${sport}: ERROR — ${e.message}`);
      results.push({ sport, error: e.message });
    }
  }
  db.close();

  // Summary
  console.log('\n── Summary ──');
  const ok = results.filter(r => r.ok).length;
  const skipped = results.filter(r => r.skipped).length;
  const errors = results.filter(r => r.error).length;
  console.log(`${ok} OK | ${skipped} skipped | ${errors} errors`);

  if (argv.includes('--json')) {
    console.log(JSON.stringify(results, null, 2));
  }
  process.exit(errors > 0 ? 1 : 0);
}

main();

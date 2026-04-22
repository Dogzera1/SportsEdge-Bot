#!/usr/bin/env node
'use strict';

/**
 * diag-isotonic-zones.js
 *
 * Mede ECE por sub-zona de P pra cada isotonic existente.
 * Usa walk-forward Elo nas mesmas match_results que o fit-*-isotonic usa,
 * mas mede ECE em zonas específicas pra responder:
 *
 *   "A calibração tá quebrada na zona P=[0.30, 0.50] (onde o leak aparece)?"
 *
 * Se ECE_zone > 0.05 → re-fitar com bins finos NA zona pode ajudar.
 * Se ECE_zone < 0.02 → isotonic já tá ok, leak é selection bias puro
 *                       (gate é o único fix).
 *
 * Uso:
 *   node scripts/diag-isotonic-zones.js              # roda todos sports
 *   node scripts/diag-isotonic-zones.js --game=lol
 *   node scripts/diag-isotonic-zones.js --json
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const ONE_GAME = arg('game', null);
const asJson = argv.includes('--json');

const DB_PATH = (arg('db', null) || process.env.DB_PATH || path.resolve(__dirname, '..', 'sportsedge.db'))
  .trim().replace(/^=+/, '');
const ROOT = path.resolve(__dirname, '..');

// Mapping sport → match_results.game value + isotonic file
// Nota: LoL isotonic é fit sobre BLEND output (Elo+OE+player+regional+stage),
// não sobre Elo cru. Diagnóstico aqui só é válido pros sports onde isotonic
// foi fit sobre Elo cru (dota/cs/tennis). LoL fica como "indicativo" e
// requer instrumentação no próprio bot.js pra medir blend pre-isotonic.
const TARGETS = [
  { game: 'lol',     resultsGame: 'lol',     isoFile: 'lib/lol-model-isotonic.json',    note: 'INVALID: isotonic fitado sobre blend, não Elo cru' },
  { game: 'dota2',   resultsGame: 'dota2',   isoFile: 'lib/dota2-isotonic.json' },
  { game: 'cs2',     resultsGame: 'cs',      isoFile: 'lib/cs2-isotonic.json' },
  { game: 'tennis',  resultsGame: 'tennis',  isoFile: 'lib/tennis-model-isotonic.json' },
];

// Zonas a medir
const ZONES = [
  { label: '[0.05, 0.30)',   min: 0.05, max: 0.30 },
  { label: '[0.30, 0.45)',   min: 0.30, max: 0.45 },  // ← zona do leak (P~0.40 / odds 2.20-3.00)
  { label: '[0.45, 0.55)',   min: 0.45, max: 0.55 },
  { label: '[0.55, 0.70)',   min: 0.55, max: 0.70 },
  { label: '[0.70, 0.95]',   min: 0.70, max: 0.95 },
];

function norm(s) { return String(s || '').toLowerCase().trim().replace(/\s+/g, ' '); }
function eloExpected(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }

function applyIsotonic(blocks, p) {
  if (!blocks || !blocks.length) return p;
  if (p <= blocks[0].pMax) return blocks[0].yMean;
  const last = blocks[blocks.length - 1];
  if (p >= last.pMin) return last.yMean;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (p >= b.pMin && p <= b.pMax) return b.yMean;
    if (i + 1 < blocks.length) {
      const n = blocks[i + 1];
      if (p > b.pMax && p < n.pMin) {
        const t = (p - b.pMax) / (n.pMin - b.pMax);
        return b.yMean + t * (n.yMean - b.yMean);
      }
    }
  }
  return p;
}

function computeMetricsOnIndices(preds, outs, idx, zMin, zMax, nBins = 10) {
  const n = idx.length;
  if (n === 0) return { n: 0, ece: null, hitRate: null, avgP: null };
  const sumY = idx.reduce((s, i) => s + outs[i], 0);
  const sumP = idx.reduce((s, i) => s + preds[i], 0);
  const hitRate = sumY / n;
  const avgP = sumP / n;

  // ECE via sub-bins. Para o cálculo de bins usamos o RANGE observado dos preds,
  // não a zona externa — assim mede divergência interna do conjunto.
  let pMin = Infinity, pMax = -Infinity;
  for (const i of idx) {
    if (preds[i] < pMin) pMin = preds[i];
    if (preds[i] > pMax) pMax = preds[i];
  }
  const span = Math.max(1e-6, pMax - pMin);
  const width = span / nBins;
  const bk = Array.from({ length: nBins }, () => ({ sp: 0, sy: 0, n: 0 }));
  for (const i of idx) {
    let bIdx = Math.floor((preds[i] - pMin) / width);
    if (bIdx < 0) bIdx = 0;
    if (bIdx >= nBins) bIdx = nBins - 1;
    bk[bIdx].sp += preds[i]; bk[bIdx].sy += outs[i]; bk[bIdx].n++;
  }
  let e = 0;
  for (const b of bk) {
    if (b.n) e += (b.n / n) * Math.abs(b.sp / b.n - b.sy / b.n);
  }
  return { n, ece: +e.toFixed(4), hitRate: +hitRate.toFixed(4), avgP: +avgP.toFixed(4) };
}

function indicesInRawZone(rawPreds, zMin, zMax) {
  const idx = [];
  for (let i = 0; i < rawPreds.length; i++) {
    if (rawPreds[i] >= zMin && rawPreds[i] < zMax) idx.push(i);
  }
  return idx;
}

function diagnoseGame(target, db) {
  const isoPath = path.join(ROOT, target.isoFile);
  if (!fs.existsSync(isoPath)) return { game: target.game, error: 'no isotonic file' };
  const iso = JSON.parse(fs.readFileSync(isoPath, 'utf8'));
  const blocks = iso.blocks || [];

  const rows = db.prepare(`
    SELECT team1, team2, winner, resolved_at
    FROM match_results
    WHERE game=? AND winner IS NOT NULL AND winner != ''
      AND team1 IS NOT NULL AND team2 IS NOT NULL
      AND resolved_at IS NOT NULL
    ORDER BY resolved_at ASC
  `).all(target.resultsGame);

  if (rows.length < 100) return { game: target.game, error: `only ${rows.length} rows` };

  // Walk-forward Elo (mesmo do fit-isotonic). Test = última 15%.
  const nTrain = Math.floor(rows.length * 0.85); // train+calib combined
  const test = rows.slice(nTrain);

  const state = new Map();
  function getP(name) {
    const k = norm(name);
    if (!state.has(k)) state.set(k, { overall: 1500, games: 0 });
    return state.get(k);
  }
  function predict(r) {
    const p1 = getP(r.team1), p2 = getP(r.team2);
    if (p1.games < 5 || p2.games < 5) return null;
    return { pA: eloExpected(p1.overall, p2.overall), y: norm(r.winner) === norm(r.team1) ? 1 : 0 };
  }
  function update(r) {
    const p1 = getP(r.team1), p2 = getP(r.team2);
    const y = norm(r.winner) === norm(r.team1) ? 1 : 0;
    const pA = eloExpected(p1.overall, p2.overall);
    const k = 32 * (1 + 0.3 * Math.max(0, 1 - p1.games / 50));
    const delta = k * (y - pA);
    p1.overall += delta; p2.overall -= delta;
    p1.games++; p2.games++;
  }

  for (const r of rows.slice(0, nTrain)) update(r);

  const rawP = [], calP = [], outs = [];
  for (const r of test) {
    const pr = predict(r);
    if (pr) {
      rawP.push(pr.pA);
      calP.push(applyIsotonic(blocks, pr.pA));
      outs.push(pr.y);
    }
    update(r);
  }

  // Filtra SEMPRE pelo raw P, mede raw e calib no MESMO subset (apples-to-apples).
  const zones = ZONES.map(z => {
    const idx = indicesInRawZone(rawP, z.min, z.max);
    return {
      zone: z.label,
      raw:   computeMetricsOnIndices(rawP, outs, idx, z.min, z.max),
      calib: computeMetricsOnIndices(calP, outs, idx, z.min, z.max),
    };
  });

  return {
    game: target.game,
    nTest: rawP.length,
    fittedAt: iso.fittedAt,
    nCalib: iso.nCalibSamples,
    blocks: blocks.length,
    zones,
  };
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const targets = ONE_GAME ? TARGETS.filter(t => t.game === ONE_GAME) : TARGETS;
  const out = { ranAt: new Date().toISOString(), results: [] };
  for (const t of targets) {
    out.results.push(diagnoseGame(t, db));
  }

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  for (const r of out.results) {
    console.log(`\n══════ ${r.game.toUpperCase()} ══════`);
    if (r.error) { console.log(`  ✗ ${r.error}`); continue; }
    const target = TARGETS.find(t => t.game === r.game);
    if (target?.note) console.log(`  ⚠️  ${target.note}`);
    console.log(`  fittedAt: ${r.fittedAt} | calib n=${r.nCalib} | blocks=${r.blocks} | test n=${r.nTest}`);
    console.log(`\n  Zone           |    n  | RAW: avgP/hit/ECE      | CALIB: avgP/hit/ECE     | Δ ECE`);
    console.log('  ' + '-'.repeat(98));
    for (const z of r.zones) {
      const rN = z.raw.n;
      if (rN === 0) {
        console.log(`  ${z.zone.padEnd(15)}|     0 | (sem amostras)`);
        continue;
      }
      const rR = z.raw, rC = z.calib;
      const eceDelta = rC.ece != null && rR.ece != null ? (rC.ece - rR.ece) : null;
      const flag = z.zone.includes('0.30') ? '  ← zona do leak' : '';
      const fmt = (m) => m.avgP != null
        ? `${m.avgP.toFixed(3)}/${m.hitRate.toFixed(3)}/${m.ece.toFixed(4)}`
        : '   --/--/--   ';
      console.log(
        `  ${z.zone.padEnd(15)}| ${String(rN).padStart(5)} | ` +
        `${fmt(rR)} | ${fmt(rC)} | ` +
        `${eceDelta != null ? (eceDelta >= 0 ? '+' : '') + eceDelta.toFixed(4) : '?'}${flag}`
      );
    }

    // Veredito
    const leakZone = r.zones.find(z => z.zone === '[0.30, 0.45)');
    if (leakZone && leakZone.calib.ece != null) {
      const ece = leakZone.calib.ece;
      console.log('\n  Veredito zona [0.30, 0.45):');
      if (leakZone.calib.n < 30) {
        console.log(`    ⚠️  n=${leakZone.calib.n} pequeno demais — diagnóstico ruidoso`);
      } else if (ece > 0.05) {
        console.log(`    🔴 ECE ${ece.toFixed(4)} > 0.05 — isotonic miscalibrado nesta zona, refit com bins finos pode ajudar`);
      } else if (ece > 0.02) {
        console.log(`    🟡 ECE ${ece.toFixed(4)} marginal — refit pode dar ganho pequeno; selection bias é a causa principal`);
      } else {
        console.log(`    🟢 ECE ${ece.toFixed(4)} < 0.02 — isotonic já tá calibrado, leak é selection bias puro (gate é o fix)`);
      }
    }
  }
}

main();

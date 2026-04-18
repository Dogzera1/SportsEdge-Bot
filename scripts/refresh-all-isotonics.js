#!/usr/bin/env node
'use strict';

/**
 * refresh-all-isotonics.js
 *
 * Refresh sequencial de todos os isotônicos + trained models que valem a pena.
 * Default: --json output minimal, --verbose mostra stdout completo de cada fit.
 *
 * Jobs (ordem):
 *   1. sync-oracleselixir --year (LoL data)
 *   2. extract-esports-features lol + retrain
 *   3. fit-lol-model-isotonic (blend isotonic)
 *   4. fit-tennis-model-isotonic
 *   5. fit-esports-isotonic --game=dota2
 *   6. fit-esports-isotonic --game=cs2
 *
 * Valorant skipado (regredia Brier — memory).
 *
 * Uso:
 *   node scripts/refresh-all-isotonics.js            # só isotonic refits
 *   node scripts/refresh-all-isotonics.js --retrain  # inclui retrain LoL
 *   node scripts/refresh-all-isotonics.js --sync     # inclui OE sync
 *   node scripts/refresh-all-isotonics.js --all      # full pipeline
 *   node scripts/refresh-all-isotonics.js --json     # JSON output
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const verbose = argv.includes('--verbose');
const doRetrain = argv.includes('--retrain') || argv.includes('--all');
const doSync = argv.includes('--sync') || argv.includes('--all');

const ROOT = path.resolve(__dirname, '..');

// Lê metrics antes do refresh (pra comparar depois)
function readIsotonic(p) {
  try {
    const full = path.join(ROOT, p);
    if (!fs.existsSync(full)) return null;
    const j = JSON.parse(fs.readFileSync(full, 'utf8'));
    return { fittedAt: j.fittedAt, blocks: j.blocks?.length || 0, nCalib: j.nCalibSamples || 0 };
  } catch { return null; }
}
function readWeights(p) {
  try {
    const full = path.join(ROOT, p);
    if (!fs.existsSync(full)) return null;
    const j = JSON.parse(fs.readFileSync(full, 'utf8'));
    const m = j.metrics?.ensemble_raw_test || j.metrics?.logistic_test || null;
    return { trainedAt: j.trainedAt, brier: m?.brier, acc: m?.acc };
  } catch { return null; }
}

const BEFORE = {
  lol_weights: readWeights('lib/lol-weights.json'),
  lol_iso: readIsotonic('lib/lol-model-isotonic.json'),
  tennis_iso: readIsotonic('lib/tennis-model-isotonic.json'),
  dota_iso: readIsotonic('lib/dota2-isotonic.json'),
  cs_iso: readIsotonic('lib/cs2-isotonic.json'),
};

const results = { ranAt: new Date().toISOString(), jobs: [], before: BEFORE };

function run(label, cmd) {
  const started = Date.now();
  let ok = true, err = null, out = '';
  try {
    out = execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: verbose ? 'inherit' : 'pipe', timeout: 600000 });
  } catch (e) {
    ok = false;
    err = e.message;
    if (e.stdout) out = String(e.stdout);
  }
  const dur = ((Date.now() - started) / 1000).toFixed(1);
  results.jobs.push({ label, cmd, ok, durSec: +dur, err });
  if (!asJson) console.log(`${ok ? '✓' : '✗'} ${label} (${dur}s)${err ? ' — ' + err : ''}`);
  return ok;
}

const YEAR = new Date().getFullYear();

if (doSync) {
  run('OE sync ' + YEAR, `node scripts/sync-oracleselixir.js --year=${YEAR}`);
}

if (doRetrain) {
  run('Extract LoL features', 'node scripts/extract-esports-features.js --game lol');
  run('Train LoL model', 'node scripts/train-esports-model.js --game lol');
}

run('Fit LoL isotonic (blend)', 'node scripts/fit-lol-model-isotonic.js');
run('Fit tennis isotonic', 'node scripts/fit-tennis-model-isotonic.js');
run('Fit Dota isotonic', 'node scripts/fit-esports-isotonic.js --game=dota2');
run('Fit CS2 isotonic', 'node scripts/fit-esports-isotonic.js --game=cs2');

const AFTER = {
  lol_weights: readWeights('lib/lol-weights.json'),
  lol_iso: readIsotonic('lib/lol-model-isotonic.json'),
  tennis_iso: readIsotonic('lib/tennis-model-isotonic.json'),
  dota_iso: readIsotonic('lib/dota2-isotonic.json'),
  cs_iso: readIsotonic('lib/cs2-isotonic.json'),
};
results.after = AFTER;

// Diff summary
const changes = [];
for (const k of Object.keys(AFTER)) {
  const b = BEFORE[k], a = AFTER[k];
  if (!a) continue;
  if (!b) { changes.push(`${k}: NEW`); continue; }
  if (a.fittedAt && a.fittedAt !== b.fittedAt) {
    changes.push(`${k}: re-fitted (${a.blocks} blocks, ${a.nCalib} calib)`);
  }
  if (a.trainedAt && a.trainedAt !== b.trainedAt) {
    const brierDelta = (a.brier - b.brier).toFixed(4);
    changes.push(`${k}: retrained | Brier ${b.brier?.toFixed(4)} → ${a.brier?.toFixed(4)} (${brierDelta})`);
  }
}
results.changes = changes;

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('\n── Changes ──');
  if (changes.length) for (const c of changes) console.log('  ' + c);
  else console.log('  (none — nada mudou)');
  const allOk = results.jobs.every(j => j.ok);
  console.log(`\n${allOk ? '✓ All OK' : '✗ Some jobs failed — check logs'}`);
}

process.exit(results.jobs.some(j => !j.ok) ? 1 : 0);

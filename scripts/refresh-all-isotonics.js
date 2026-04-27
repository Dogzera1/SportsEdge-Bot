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
  tennis_markov_calib: readIsotonic('lib/tennis-markov-calib.json'),
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
// Tennis Markov MT calib (handicapGames + totalGames). Pula se sample
// não cresceu ≥30 settled desde o fit anterior — evita re-fits sobre
// ruído incremental. ECE regression guard interno aborta se calib piora.
run('Fit tennis Markov MT calib', 'node scripts/fit-tennis-markov-calibration.js --min-new-samples=30');

const AFTER = {
  lol_weights: readWeights('lib/lol-weights.json'),
  lol_iso: readIsotonic('lib/lol-model-isotonic.json'),
  tennis_iso: readIsotonic('lib/tennis-model-isotonic.json'),
  dota_iso: readIsotonic('lib/dota2-isotonic.json'),
  cs_iso: readIsotonic('lib/cs2-isotonic.json'),
  tennis_markov_calib: readIsotonic('lib/tennis-markov-calib.json'),
};
results.after = AFTER;

// ── Auto-rollback on regression ──
// Compara Brier ANTES vs DEPOIS. Se new > old × 1.05 (5%+ worse) → restaura backup.
// Só aplica a weights files (isotonic metrics não são comparáveis entre refits).
// ENV: AUTO_ROLLBACK_ON_REGRESSION=true ativa. Default OFF pra dev; ON em prod (.env).
const autoRollback = process.env.AUTO_ROLLBACK_ON_REGRESSION === 'true';
const REGRESSION_THRESHOLD = parseFloat(process.env.REGRESSION_THRESHOLD_PCT || '5') / 100;
results.rollbacks = [];

if (autoRollback && doRetrain) {
  const b = BEFORE.lol_weights, a = AFTER.lol_weights;
  if (b?.brier && a?.brier && a.brier > b.brier * (1 + REGRESSION_THRESHOLD)) {
    const pctWorse = ((a.brier - b.brier) / b.brier * 100).toFixed(1);
    if (!asJson) console.log(`\n⚠️ Regression detected: LoL Brier ${b.brier.toFixed(4)} → ${a.brier.toFixed(4)} (+${pctWorse}%)`);
    try {
      const { restoreLatest } = require('../lib/model-backup');
      // restoreLatest restaura o MAIS RECENTE backup. Mas agora o mais recente é o que acabamos de salvar.
      // Queremos o ANTES: o segundo mais recente.
      const { listBackups } = require('../lib/model-backup');
      const weightsPath = path.join(ROOT, 'lib', 'lol-weights.json');
      const backups = listBackups(weightsPath);
      // Backups sorted by mtime desc. O mais recente é o backup criado AGORA (train-esports-model)
      // antes do novo write. Pra rollback queremos ele mesmo (pre-refresh state).
      if (backups.length) {
        const r = restoreLatest(weightsPath, { name: backups[0].name });
        results.rollbacks.push({ file: 'lib/lol-weights.json', restoredFrom: backups[0].name, reasonPct: +pctWorse });
        if (!asJson) console.log(`  ↺ Rolled back from ${backups[0].name}`);
      }
    } catch (e) {
      if (!asJson) console.log(`  ✗ Rollback falhou: ${e.message}`);
      results.rollbacks.push({ file: 'lib/lol-weights.json', error: e.message });
    }
  }
}

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
  if (results.rollbacks?.length) {
    console.log('\n── Rollbacks ──');
    for (const rb of results.rollbacks) {
      if (rb.error) console.log(`  ✗ ${rb.file}: ${rb.error}`);
      else console.log(`  ↺ ${rb.file} restored from ${rb.restoredFrom} (new Brier was +${rb.reasonPct}%)`);
    }
  }
  const allOk = results.jobs.every(j => j.ok);
  console.log(`\n${allOk ? '✓ All OK' : '✗ Some jobs failed — check logs'}`);
}

process.exit(results.jobs.some(j => !j.ok) ? 1 : 0);

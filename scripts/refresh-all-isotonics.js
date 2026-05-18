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

// 2026-05-06: lockfile pra evitar concurrent execution. Cron 12h prod + manual
// run = duas instances escrevendo lol-weights.json em paralelo → corruption.
// Stale lock após 6h é overrideado (script crashed sem cleanup).
const LOCK_PATH = path.join(ROOT, 'lib', '.refresh-isotonics-lock');
function _acquireLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const stat = fs.statSync(LOCK_PATH);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 6 * 60 * 60 * 1000) {
        const content = fs.readFileSync(LOCK_PATH, 'utf8');
        console.error(`[REFRESH] Lock active (age ${Math.round(ageMs / 60000)}min) — abort. Holder: ${content.slice(0, 100)}`);
        process.exit(2);
      }
      console.error(`[REFRESH] Stale lock (age ${Math.round(ageMs / 60000)}min) — overriding`);
    }
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (e) {
    console.error(`[REFRESH] Lock setup failed: ${e.message}`);
  }
}
function _releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
}
_acquireLock();
process.on('exit', _releaseLock);
process.on('SIGINT', () => { _releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { _releaseLock(); process.exit(143); });

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
// Schema basket: trained_at (snake) + metrics.val_brier (não ensemble/logistic_test).
// Normaliza pra trainedAt camelCase pra diff loop genérico funcionar.
function readBasketTrained(p) {
  try {
    const full = path.join(ROOT, p);
    if (!fs.existsSync(full)) return null;
    const j = JSON.parse(fs.readFileSync(full, 'utf8'));
    return { trainedAt: j.trained_at, brier: j.metrics?.val_brier, acc: j.metrics?.val_acc };
  } catch { return null; }
}

// basket params: salvos em `path.dirname(DB_PATH)/basket-trained-params.json`
// (default = root do projeto quando DB_PATH não setado).
const BASKET_PARAMS = path.join(path.dirname(path.resolve(process.env.DB_PATH || 'sportsedge.db')), 'basket-trained-params.json');
const BASKET_PARAMS_REL = path.relative(ROOT, BASKET_PARAMS);

const BEFORE = {
  lol_weights: readWeights('lib/lol-weights.json'),
  cs_weights: readWeights('lib/cs2-weights.json'),
  dota_weights: readWeights('lib/dota2-weights.json'),
  lol_iso: readIsotonic('lib/lol-model-isotonic.json'),
  tennis_iso: readIsotonic('lib/tennis-model-isotonic.json'),
  dota_iso: readIsotonic('lib/dota2-isotonic.json'),
  cs_iso: readIsotonic('lib/cs2-isotonic.json'),
  tennis_markov_calib: readIsotonic('lib/tennis-markov-calib.json'),
  basket_trained: readBasketTrained(BASKET_PARAMS_REL),
  // CLV calibration (layer pós-isotonic, treinada em closing line)
  lol_clv: readIsotonic('lib/lol-clv-calibration.json'),
  tennis_clv: readIsotonic('lib/tennis-clv-calibration.json'),
  dota_clv: readIsotonic('lib/dota2-clv-calibration.json'),
  cs_clv: readIsotonic('lib/cs2-clv-calibration.json'),
  football_clv: readIsotonic('lib/football-clv-calibration.json'),
};

const results = { ranAt: new Date().toISOString(), jobs: [], before: BEFORE };

// 2026-05-18 (P3 brier holdout eval): captura brier do isotonic ATUAL em shadow
// sample 14d ANTES do refit. Pós-refit re-eval em SAME sample → comparison.
// Best-effort: null = sample insuficiente OR DB unreachable (não bloqueia).
const ISOTONIC_TARGETS_BRIER = [
  { key: 'lol_iso',    sport: 'lol',      file: 'lib/lol-model-isotonic.json',    label: 'LoL iso' },
  { key: 'tennis_iso', sport: 'tennis',   file: 'lib/tennis-model-isotonic.json', label: 'Tennis iso' },
  { key: 'dota_iso',   sport: 'dota2',    file: 'lib/dota2-isotonic.json',        label: 'Dota iso' },
  { key: 'cs_iso',     sport: 'cs2',      file: 'lib/cs2-isotonic.json',          label: 'CS2 iso' },
];
const brierPre = {};
for (const t of ISOTONIC_TARGETS_BRIER) {
  brierPre[t.key] = _evalBrier(t.sport, t.file);
}

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
  // Sync LoL patch dates antes do extract — append patches novos ddragon
  // (feature days_since_patch lê data/lol-patch-dates.json). Idempotente:
  // se ddragon retorna versões já conhecidas, no-op.
  run('Sync LoL patch dates (ddragon)', 'node scripts/sync-lol-patch-dates.js');
  run('Extract LoL features', 'node scripts/extract-esports-features.js --game lol');
  run('Train LoL model', 'node scripts/train-esports-model.js --game lol');
  // 2026-05-13: CS2 + Dota2 weights retrain (P5 retroativo). Antes só LoL
  // tinha retrain wired — CS2 ficou 25d stale, Dota2 3d. Lifts confirmados
  // sobre Elo baseline: CS2 +20.4%, Dota2 +4.1% (borderline — auto-rollback
  // protege). Valorant SKIP intencional: lift +4.2% + memory "regredia Brier".
  run('Extract CS2 features', 'node scripts/extract-esports-features.js --game cs2');
  run('Train CS2 model', 'node scripts/train-esports-model.js --game cs2');
  run('Extract Dota2 features', 'node scripts/extract-esports-features.js --game dota2');
  run('Train Dota2 model', 'node scripts/train-esports-model.js --game dota2');
  // 2026-05-13: basket trained model (logistic + isotonic NBA). Antes ficava
  // stale — só rodava via POST /admin/basket-train manual. Re-treina em --all
  // pra cobrir regime change pós-trade deadline / playoffs.
  // Seed incremental antes — basket_match_history só é populado via seed
  // (não há ingest contínuo). Sem seed, train re-treina nos mesmos dados.
  // 14 dias cobre gap entre nightly runs com margem (cron 24h, ESPN backfill
  // de score se game ainda IN_PROGRESS na última checagem).
  run('Seed basket history (+14d)', 'node scripts/seed-basket-history.js 14');
  run('Train basket model', 'node scripts/train-basket-model.js');
}

run('Fit LoL isotonic (blend)', 'node scripts/fit-lol-model-isotonic.js');
run('Fit tennis isotonic', 'node scripts/fit-tennis-model-isotonic.js');
run('Fit Dota isotonic', 'node scripts/fit-esports-isotonic.js --game=dota2');
run('Fit CS2 isotonic', 'node scripts/fit-esports-isotonic.js --game=cs2');
// 2026-05-10: Valorant isotonic adicionado. Isotonic file estava stale 22d
// (último refit 2026-04-18). Symptom: 18 ev_sanity rejections com avg_ev 85%
// (modelo overconfident sem recalibração).
run('Fit Valorant isotonic', 'node scripts/fit-esports-isotonic.js --game=valorant');
// Tennis Markov MT calib (handicapGames + totalGames). Pula se sample
// não cresceu ≥30 settled desde o fit anterior — evita re-fits sobre
// ruído incremental. ECE regression guard interno aborta se calib piora.
// 2026-05-17 (audit granularidade P1): fit pre + live separados pra cascade
// `live > tier+side > tier > side > default` funcionar com bins live populados.
// Pre fitta markets.X (default flow), live fitta markets.live.X (preserva pre).
// Live precisa >=30 samples per market — script auto-skip se insuficiente.
run('Fit tennis Markov MT calib (pre)', 'node scripts/fit-tennis-markov-calibration.js --filter=pre --min-new-samples=30');
run('Fit tennis Markov MT calib (live)', 'node scripts/fit-tennis-markov-calibration.js --filter=live --min-new-samples=15');
// 2026-05-01: CLV calibration layer (camada pós-isotonic). Treina pra puxar
// model_p_pick em direção a closing line — signal de menor variância.
// Skip safe quando n<50 settled tips com clv_odds. Lit: arxiv 2410.21484.
run('Fit CLV calibration (all sports)', 'node scripts/fit-clv-calibration.js --sport=all');

const AFTER = {
  lol_weights: readWeights('lib/lol-weights.json'),
  cs_weights: readWeights('lib/cs2-weights.json'),
  dota_weights: readWeights('lib/dota2-weights.json'),
  lol_iso: readIsotonic('lib/lol-model-isotonic.json'),
  tennis_iso: readIsotonic('lib/tennis-model-isotonic.json'),
  dota_iso: readIsotonic('lib/dota2-isotonic.json'),
  cs_iso: readIsotonic('lib/cs2-isotonic.json'),
  tennis_markov_calib: readIsotonic('lib/tennis-markov-calib.json'),
  basket_trained: readBasketTrained(BASKET_PARAMS_REL),
  lol_clv: readIsotonic('lib/lol-clv-calibration.json'),
  tennis_clv: readIsotonic('lib/tennis-clv-calibration.json'),
  dota_clv: readIsotonic('lib/dota2-clv-calibration.json'),
  cs_clv: readIsotonic('lib/cs2-clv-calibration.json'),
  football_clv: readIsotonic('lib/football-clv-calibration.json'),
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
  // 2026-05-13: generalizado pra cobrir lol/cs/dota. Cada sport: compara Brier
  // antes/depois; se regrediu mais que threshold, restaura backup criado antes
  // do write (lib/model-backup auto-cria pre-write).
  const ROLLBACK_TARGETS = [
    { key: 'lol_weights', label: 'LoL', file: 'lib/lol-weights.json' },
    { key: 'cs_weights', label: 'CS2', file: 'lib/cs2-weights.json' },
    { key: 'dota_weights', label: 'Dota2', file: 'lib/dota2-weights.json' },
  ];
  for (const t of ROLLBACK_TARGETS) {
    const b = BEFORE[t.key], a = AFTER[t.key];
    if (!(b?.brier && a?.brier)) continue;
    if (a.brier <= b.brier * (1 + REGRESSION_THRESHOLD)) continue;
    const pctWorse = ((a.brier - b.brier) / b.brier * 100).toFixed(1);
    if (!asJson) console.log(`\n⚠️ Regression detected: ${t.label} Brier ${b.brier.toFixed(4)} → ${a.brier.toFixed(4)} (+${pctWorse}%)`);
    try {
      const { restoreLatest, listBackups } = require('../lib/model-backup');
      const weightsPath = path.join(ROOT, t.file);
      const backups = listBackups(weightsPath);
      if (backups.length) {
        restoreLatest(weightsPath, { name: backups[0].name });
        results.rollbacks.push({ file: t.file, restoredFrom: backups[0].name, reasonPct: +pctWorse });
        if (!asJson) console.log(`  ↺ Rolled back from ${backups[0].name}`);
      }
    } catch (e) {
      if (!asJson) console.log(`  ✗ Rollback ${t.label} falhou: ${e.message}`);
      results.rollbacks.push({ file: t.file, error: e.message });
    }
  }
}

// ── Isotonic + Markov calib sample-count regression check ──
// 2026-05-18 (P3 pendency): isotonic JSONs não têm brier comparável entre refits
// (memory), então não dá pra reusar threshold REGRESSION_THRESHOLD baseado em brier.
// Sinal alternativo: nCalibSamples drop dramático (default 50%) é proxy de fit bug
// — data filter cortou demais, regime cutoff erroneo, ou sport com sample stale.
// Fit normal varia 5-15% entre refits. Não cobre overfitting (precisaria holdout).
// Roda sempre (não gated por doRetrain) pq isotonic fitta toda invocação.
//
// 2026-05-18 (P3 minimal-viable enhancement): adiciona brier holdout eval —
// load isotonic BEFORE refit, eval em shadow sample 14d → brier_pre.
// Pós-fit, eval NEW isotonic em SAME sample → brier_post. Compare.
// Sample = market_tips_shadow tips reais settled (p_model + result win/loss).
// Caveat: sample pode incluir tips usadas no training (não é true disjoint
// holdout). Comparison OLD vs NEW em SAME sample ainda detect regression.
// Auto-rollback se brier_post > brier_pre * (1 + ISOTONIC_BRIER_REGRESSION_THRESHOLD).
const ISOTONIC_SAMPLE_DROP_PCT = parseFloat(process.env.ISOTONIC_SAMPLE_DROP_THRESHOLD_PCT || '50') / 100;
const ISOTONIC_BRIER_REGRESSION_PCT = parseFloat(process.env.ISOTONIC_BRIER_REGRESSION_THRESHOLD_PCT || '5') / 100;
const ISOTONIC_HOLDOUT_DAYS = parseInt(process.env.ISOTONIC_HOLDOUT_DAYS || '14', 10);
const ISOTONIC_HOLDOUT_MIN_N = parseInt(process.env.ISOTONIC_HOLDOUT_MIN_N || '30', 10);

// Brier eval per-sport pre/post-fit. Lazy-loaded pra evitar require em runs
// onde lib/brier-holdout-eval ainda não foi pulled (graceful fallback).
function _evalBrier(sport, isoPath) {
  try {
    const { evalIsotonicOnShadow } = require('../lib/brier-holdout-eval');
    const Database = require('better-sqlite3');
    const dbPath = path.resolve(ROOT, process.env.DB_PATH || 'sportsedge.db');
    if (!fs.existsSync(dbPath)) return null;
    const fullJsonPath = path.join(ROOT, isoPath);
    if (!fs.existsSync(fullJsonPath)) return null;
    const json = JSON.parse(fs.readFileSync(fullJsonPath, 'utf8'));
    // Conexão readonly evita conflitos com fit scripts em paralelo.
    const db = new Database(dbPath, { readonly: true, timeout: 5000 });
    try {
      return evalIsotonicOnShadow(db, sport, json, {
        days: ISOTONIC_HOLDOUT_DAYS,
        minSamples: ISOTONIC_HOLDOUT_MIN_N,
      });
    } finally {
      db.close();
    }
  } catch (_) { return null; }
}
const ISOTONIC_TARGETS = [
  { key: 'lol_iso', label: 'LoL iso', file: 'lib/lol-model-isotonic.json' },
  { key: 'tennis_iso', label: 'Tennis iso', file: 'lib/tennis-model-isotonic.json' },
  { key: 'dota_iso', label: 'Dota iso', file: 'lib/dota2-isotonic.json' },
  { key: 'cs_iso', label: 'CS2 iso', file: 'lib/cs2-isotonic.json' },
  { key: 'tennis_markov_calib', label: 'Tennis Markov calib', file: 'lib/tennis-markov-calib.json' },
];
if (autoRollback) {
  for (const t of ISOTONIC_TARGETS) {
    const b = BEFORE[t.key], a = AFTER[t.key];
    if (!(b?.nCalib && a?.nCalib)) continue;
    if (a.nCalib >= b.nCalib * (1 - ISOTONIC_SAMPLE_DROP_PCT)) continue;
    const pctDrop = ((b.nCalib - a.nCalib) / b.nCalib * 100).toFixed(1);
    if (!asJson) console.log(`\n⚠️ Sample drop: ${t.label} nCalib ${b.nCalib} → ${a.nCalib} (-${pctDrop}%)`);
    try {
      const { restoreLatest, listBackups } = require('../lib/model-backup');
      const isoPath = path.join(ROOT, t.file);
      const backups = listBackups(isoPath);
      if (backups.length) {
        restoreLatest(isoPath, { name: backups[0].name });
        results.rollbacks.push({ file: t.file, restoredFrom: backups[0].name, reasonSampleDropPct: +pctDrop });
        if (!asJson) console.log(`  ↺ Rolled back from ${backups[0].name}`);
      } else {
        if (!asJson) console.log(`  ✗ No backup available — manual review needed`);
        results.rollbacks.push({ file: t.file, error: 'no_backup_available', reasonSampleDropPct: +pctDrop });
      }
    } catch (e) {
      if (!asJson) console.log(`  ✗ Rollback ${t.label} falhou: ${e.message}`);
      results.rollbacks.push({ file: t.file, error: e.message });
    }
  }
}

// 2026-05-18 (P3 brier holdout eval): pós-fit re-eval + comparison.
// Auto-rollback se brier_post > brier_pre * (1 + ISOTONIC_BRIER_REGRESSION_PCT).
// Skip silencioso se sample insuficiente OR DB unreachable (preservação fail-soft).
const brierPost = {};
for (const t of ISOTONIC_TARGETS_BRIER) {
  brierPost[t.key] = _evalBrier(t.sport, t.file);
}
results.brier_holdout = { pre: brierPre, post: brierPost };

if (autoRollback) {
  for (const t of ISOTONIC_TARGETS_BRIER) {
    const pre = brierPre[t.key];
    const post = brierPost[t.key];
    if (!pre || !post) continue;
    if (post.brier <= pre.brier * (1 + ISOTONIC_BRIER_REGRESSION_PCT)) continue;
    const pctWorse = ((post.brier - pre.brier) / pre.brier * 100).toFixed(1);
    if (!asJson) console.log(`\n⚠️ Brier regression: ${t.label} ${pre.brier} → ${post.brier} (+${pctWorse}%) [n=${pre.n}/${post.n}]`);
    try {
      const { restoreLatest, listBackups } = require('../lib/model-backup');
      const isoPath = path.join(ROOT, t.file);
      const backups = listBackups(isoPath);
      if (backups.length) {
        restoreLatest(isoPath, { name: backups[0].name });
        results.rollbacks = results.rollbacks || [];
        results.rollbacks.push({ file: t.file, restoredFrom: backups[0].name, reasonBrierPct: +pctWorse, brier_pre: pre.brier, brier_post: post.brier });
        if (!asJson) console.log(`  ↺ Rolled back from ${backups[0].name}`);
      } else {
        if (!asJson) console.log(`  ✗ No backup available — manual review needed`);
        results.rollbacks = results.rollbacks || [];
        results.rollbacks.push({ file: t.file, error: 'no_backup_available', reasonBrierPct: +pctWorse });
      }
    } catch (e) {
      if (!asJson) console.log(`  ✗ Rollback ${t.label} falhou: ${e.message}`);
      results.rollbacks = results.rollbacks || [];
      results.rollbacks.push({ file: t.file, error: e.message });
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

// 2026-05-13: Persist fit outputs pra Railway Volume (gated por
// MODEL_PERSISTENT_DIR). Sem env = no-op. Garante que próximo boot
// recupera os refits via overlay em vez de cair pro seed git.
// Log silenciado em --json (senão polui stdout que server.js parseia).
try {
  const persist = require(path.join(ROOT, 'lib', 'model-persistence'));
  const persistLog = asJson ? (() => {}) : ((lvl, tag, msg) => console.log(`[${tag}] ${msg}`));
  const r = persist.syncFromLibToPersistent({ log: persistLog });
  results.persistence = r;
} catch (e) {
  results.persistence = { error: e.message };
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('\n── Changes ──');
  if (changes.length) for (const c of changes) console.log('  ' + c);
  else console.log('  (none — nada mudou)');
  if (results.rollbacks?.length) {
    console.log('\n── Rollbacks ──');
    for (const rb of results.rollbacks) {
      if (rb.error && !rb.restoredFrom) console.log(`  ✗ ${rb.file}: ${rb.error}${rb.reasonSampleDropPct ? ` (sample -${rb.reasonSampleDropPct}%)` : ''}`);
      else {
        const reason = rb.reasonSampleDropPct
          ? `sample dropped -${rb.reasonSampleDropPct}%`
          : `new Brier +${rb.reasonPct}%`;
        console.log(`  ↺ ${rb.file} restored from ${rb.restoredFrom} (${reason})`);
      }
    }
  }
  const allOk = results.jobs.every(j => j.ok);
  console.log(`\n${allOk ? '✓ All OK' : '✗ Some jobs failed — check logs'}`);
}

process.exit(results.jobs.some(j => !j.ok) ? 1 : 0);

'use strict';

/**
 * model-persistence.js — overlay de persistência pros arquivos de modelo.
 *
 * Problema: Railway ephemeral filesystem perde refits do nightly_retrain
 * todo deploy/restart. Modelos eram git-tracked → cada push sobrescrevia
 * o trabalho do cron. Resultado: valorant-iso ficava 25d stale apesar
 * do cron rodar diariamente.
 *
 * Solução (gated por env MODEL_PERSISTENT_DIR):
 *   - syncFromPersistentToLib() no boot: se MODEL_PERSISTENT_DIR/<file>
 *     existir → copia pra lib/ (overlay sobre seed git-tracked).
 *   - syncFromLibToPersistent() pós-fit: copia lib/<file> → MODEL_PERSISTENT_DIR.
 *
 * Sem env setada = no-op (dev/local intactos). Em prod Railway:
 *   MODEL_PERSISTENT_DIR=/data/models
 *   Volume montado em /data (Pro plan)
 *
 * Files cobertos (glob em lib/):
 *   *-isotonic.json | *-weights.json | *-clv-calibration.json
 *   tennis-markov-calib.json | basket-trained-params.json | lol-kills-calibration.json
 */

const fs = require('fs');
const path = require('path');

const LIB_DIR = __dirname;

const MODEL_FILE_PATTERNS = [
  /-isotonic\.json$/,
  /-model-isotonic\.json$/,
  /-weights\.json$/,
  /-clv-calibration\.json$/,
  /^tennis-markov-calib\.json$/,
  /^lol-kills-calibration\.json$/,
];

function _persistentDir() {
  const dir = process.env.MODEL_PERSISTENT_DIR;
  if (!dir) return null;
  const abs = path.resolve(dir);
  try {
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  } catch (_) {
    return null;
  }
}

function _listModelFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(name => MODEL_FILE_PATTERNS.some(rx => rx.test(name)));
  } catch (_) { return []; }
}

function syncFromPersistentToLib(opts = {}) {
  const log = opts.log || ((lvl, tag, msg) => console.log(`[${tag}] ${msg}`));
  const dir = _persistentDir();
  if (!dir) return { skipped: 'no_env', copied: 0 };
  const files = _listModelFiles(dir);
  let copied = 0;
  for (const name of files) {
    const src = path.join(dir, name);
    const dst = path.join(LIB_DIR, name);
    try {
      // Persistent SEMPRE é fonte de verdade — ele tem o último fit válido.
      // lib/ vem do git seed (Railway redeploy reseta mtime pra "now"), então
      // comparar mtime aqui invertia a proteção (todo deploy skipava overlay).
      // Se dev quer pushar model novo do git, deve usar /admin/refresh-isotonics
      // que escreve direto no persistent.
      fs.copyFileSync(src, dst);
      copied++;
    } catch (e) {
      log('WARN', 'MODEL-PERSIST', `sync→lib ${name}: ${e.message}`);
    }
  }
  log('INFO', 'MODEL-PERSIST', `boot sync: ${copied} arquivo(s) overlay de ${dir}`);
  return { dir, copied, total: files.length };
}

function syncFromLibToPersistent(opts = {}) {
  const log = opts.log || ((lvl, tag, msg) => console.log(`[${tag}] ${msg}`));
  const dir = _persistentDir();
  if (!dir) return { skipped: 'no_env', copied: 0 };
  const files = _listModelFiles(LIB_DIR);
  let copied = 0, skipped = 0;
  for (const name of files) {
    const src = path.join(LIB_DIR, name);
    const dst = path.join(dir, name);
    try {
      const sStat = fs.statSync(src);
      let shouldCopy = true;
      if (fs.existsSync(dst)) {
        const dStat = fs.statSync(dst);
        if (dStat.mtimeMs >= sStat.mtimeMs) shouldCopy = false;
      }
      if (shouldCopy) {
        fs.copyFileSync(src, dst);
        copied++;
      } else {
        skipped++;
      }
    } catch (e) {
      log('WARN', 'MODEL-PERSIST', `sync→persist ${name}: ${e.message}`);
    }
  }
  log('INFO', 'MODEL-PERSIST', `post-fit sync: ${copied} arquivo(s) → ${dir} (${skipped} skipped/older)`);
  return { dir, copied, skipped, total: files.length };
}

module.exports = { syncFromPersistentToLib, syncFromLibToPersistent };

'use strict';

/**
 * model-backup.js — backup rotativo de artefatos de modelo (weights, isotonic JSONs).
 *
 * Uso:
 *   const { backupBeforeWrite } = require('./model-backup');
 *   backupBeforeWrite('lib/lol-weights.json');  // → lib/backups/lol-weights-2026-04-18T11-00-00.json
 *
 * Mantém últimos N backups (default 5). Files além do limite são deletados FIFO.
 *
 * Why:
 *   - Retrain pode produzir modelo pior (overfit, bug, data quality).
 *   - Isotonic refit pode quebrar calibração em sample pequeno.
 *   - Backup permite rollback instantâneo sem re-training do zero.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_KEEP = 5;

function _backupDir(rootDir) {
  const dir = path.join(rootDir, 'lib', 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * @param {string} filePath — absolute OR relative to cwd
 * @param {object} [opts]
 * @param {number} [opts.keep=5] — qtd backups a manter (FIFO cleanup)
 * @returns {string|null} path do backup criado, ou null se source não existe
 */
function backupBeforeWrite(filePath, opts = {}) {
  const keep = opts.keep ?? DEFAULT_KEEP;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  if (!fs.existsSync(abs)) return null;

  // Backup dir: sibling of `lib/`, called `lib/backups/`. Infer from file path.
  // Se file estiver em `/path/to/project/lib/lol-weights.json`, backups vão pra
  // `/path/to/project/lib/backups/`.
  const libDir = path.dirname(abs);
  const backupsDir = path.join(libDir, 'backups');
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

  const base = path.basename(abs, path.extname(abs));
  const ext = path.extname(abs);
  const backupPath = path.join(backupsDir, `${base}-${_timestamp()}${ext}`);
  fs.copyFileSync(abs, backupPath);

  // Cleanup FIFO: mantém só `keep` backups do mesmo base
  try {
    const existing = fs.readdirSync(backupsDir)
      .filter(f => f.startsWith(`${base}-`) && f.endsWith(ext))
      .map(f => ({ name: f, path: path.join(backupsDir, f), mtime: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of existing.slice(keep)) {
      fs.unlinkSync(old.path);
    }
  } catch (_) { /* ignore cleanup errors */ }

  return backupPath;
}

/**
 * Lista backups disponíveis pra um arquivo.
 * @returns {Array<{ path, name, mtime }>}
 */
function listBackups(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  const libDir = path.dirname(abs);
  const backupsDir = path.join(libDir, 'backups');
  if (!fs.existsSync(backupsDir)) return [];
  const base = path.basename(abs, path.extname(abs));
  const ext = path.extname(abs);
  return fs.readdirSync(backupsDir)
    .filter(f => f.startsWith(`${base}-`) && f.endsWith(ext))
    .map(f => {
      const p = path.join(backupsDir, f);
      return { path: p, name: f, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Restaura o backup mais recente. Opcionalmente específico via opts.name.
 * @param {string} filePath — arquivo alvo a ser restaurado
 * @param {object} [opts]
 * @param {string} [opts.name] — nome específico do backup a restaurar
 * @returns {{ restored: string, from: string } | null}
 */
function restoreLatest(filePath, opts = {}) {
  const backups = listBackups(filePath);
  if (!backups.length) return null;
  const target = opts.name
    ? backups.find(b => b.name === opts.name)
    : backups[0]; // latest
  if (!target) return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  // Safety: backup current before overwriting (so rollback is itself reversible)
  if (fs.existsSync(abs)) backupBeforeWrite(abs);
  fs.copyFileSync(target.path, abs);
  return { restored: abs, from: target.path };
}

module.exports = { backupBeforeWrite, listBackups, restoreLatest };

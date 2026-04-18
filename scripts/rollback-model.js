#!/usr/bin/env node
'use strict';

/**
 * rollback-model.js — restaura artefato de modelo a partir de backup.
 *
 * Uso:
 *   node scripts/rollback-model.js --list                           # lista backups de todos os modelos
 *   node scripts/rollback-model.js --list --file=lib/lol-weights.json   # lista de um arquivo
 *   node scripts/rollback-model.js --file=lib/lol-weights.json     # restaura latest backup
 *   node scripts/rollback-model.js --file=lib/lol-weights.json --name=lol-weights-2026-04-18T11-26-50.json
 */

const path = require('path');
const fs = require('fs');
const { listBackups, restoreLatest } = require('../lib/model-backup');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}
const FILE = arg('file', null);
const NAME = arg('name', null);
const doList = argv.includes('--list');

const KNOWN_FILES = [
  'lib/lol-weights.json', 'lib/dota2-weights.json', 'lib/cs2-weights.json',
  'lib/valorant-weights.json', 'lib/tennis-weights.json',
  'lib/lol-model-isotonic.json', 'lib/tennis-model-isotonic.json',
  'lib/dota2-isotonic.json', 'lib/cs2-isotonic.json',
];

const ROOT = path.resolve(__dirname, '..');

if (doList) {
  const files = FILE ? [FILE] : KNOWN_FILES;
  for (const f of files) {
    const abs = path.resolve(ROOT, f);
    const backups = listBackups(abs);
    console.log(`\n${f} (${backups.length} backup${backups.length !== 1 ? 's' : ''}):`);
    for (const b of backups) {
      const sizeKb = (fs.statSync(b.path).size / 1024).toFixed(1);
      console.log(`  ${b.name} | ${new Date(b.mtime).toISOString()} | ${sizeKb} KB`);
    }
    if (!backups.length) console.log('  (nenhum)');
  }
  process.exit(0);
}

if (!FILE) {
  console.error('Usage: --list | --file=<path> [--name=<backup>]');
  process.exit(1);
}

const abs = path.resolve(ROOT, FILE);
const r = restoreLatest(abs, NAME ? { name: NAME } : {});
if (!r) {
  console.error(`No backups found for ${FILE}`);
  process.exit(1);
}
console.log(`✓ Restored ${r.restored}`);
console.log(`  from: ${r.from}`);
console.log(`\nCurrent file agora aponta pro backup. Restart bot pra ativar.`);

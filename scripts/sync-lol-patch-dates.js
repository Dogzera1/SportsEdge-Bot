#!/usr/bin/env node
'use strict';

/**
 * scripts/sync-lol-patch-dates.js
 *
 * Fetcha ddragon /api/versions.json (lista versões LoL em ordem decrescente)
 * e detecta patches novos vs data/lol-patch-dates.json. Faz append com
 * released_at = hoje (data de detecção ≈ release real ±1 dia — ddragon
 * publica versões no dia do patch).
 *
 * Uso:
 *   node scripts/sync-lol-patch-dates.js [--dry-run]
 *
 * Cron: opt-in via env LOL_PATCH_SYNC_AUTO=true. Roda dentro do nightly retrain
 * antes do extract-esports-features pra novos patches entrarem no CSV.
 */

const https = require('https');
const { addPatch, loadPatches } = require('../lib/lol-patches');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

function fetchVersions() {
  return new Promise((resolve, reject) => {
    https.get('https://ddragon.leagueoflegends.com/api/versions.json', { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

// ddragon returns: ["15.10.1", "15.9.1", ...]. We canonicalize to "MAJOR.MINOR" (drop patch sub-version).
function canonVersion(v) {
  const parts = String(v).split('.');
  if (parts.length < 2) return null;
  return `${parts[0]}.${parts[1]}`;
}

async function main() {
  let versions;
  try {
    versions = await fetchVersions();
  } catch (e) {
    console.error(`[patch-sync] fetch failed: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(versions) || !versions.length) {
    console.error(`[patch-sync] empty version list`);
    process.exit(1);
  }

  const known = new Set(loadPatches().map(p => p.version));
  const todayIso = new Date().toISOString().slice(0, 10);

  // Versões a checar: somente as ~15 mais recentes (cobertura suficiente, evita re-import histórico).
  const recent = versions.slice(0, 15);
  const seen = new Set();
  const newPatches = [];
  for (const raw of recent) {
    const v = canonVersion(raw);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    if (known.has(v)) continue;
    newPatches.push(v);
  }

  if (!newPatches.length) {
    console.log(`[patch-sync] no new patches (checked ${recent.length} ddragon versions, known=${known.size})`);
    return;
  }

  console.log(`[patch-sync] detected ${newPatches.length} new patch(es): ${newPatches.join(', ')}`);
  if (DRY_RUN) {
    console.log(`[patch-sync] dry-run — not persisted`);
    return;
  }

  let added = 0;
  for (const v of newPatches) {
    if (addPatch(v, todayIso)) added++;
  }
  console.log(`[patch-sync] persisted ${added} patch(es) released_at=${todayIso}`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });

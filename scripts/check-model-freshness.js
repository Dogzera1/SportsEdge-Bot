#!/usr/bin/env node
'use strict';

/**
 * check-model-freshness.js
 *
 * Verifica se `lib/lol-weights.json` está stale em relação ao estado atual da
 * liga/meta, usando `oracleselixir_games` como fonte de verdade.
 *
 * Critérios (ordem de prioridade):
 *   1. Patches novos desde trainedAt — >=3 patches sem retreino = retrain urgent.
 *   2. Novo split detectado (split inexistente em train appearing com N games).
 *   3. Idade absoluta >=21 dias = retrain mensal recomendado.
 *
 * Uso:
 *   node scripts/check-model-freshness.js              # report humano
 *   node scripts/check-model-freshness.js --json        # saída JSON
 *   node scripts/check-model-freshness.js --notify      # DM via telegram se stale
 *
 * Exit codes:
 *   0 = fresh
 *   1 = attention (minor stale)
 *   2 = retrain-now (major stale)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const https = require('https');

// 2026-05-06: respeita process.env.DB_PATH — antes hardcoded relative,
// em Railway com /data/sportsedge.db o script lia DB local errado.
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, '..', 'sportsedge.db');
const WEIGHTS_PATH = path.resolve(__dirname, '..', 'lib', 'lol-weights.json');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const doNotify = args.includes('--notify');

function patchKey(p) {
  // "16.07" → 16007; "15.24" → 15024. Permite ordenação numérica.
  const m = String(p || '').match(/^(\d+)\.(\d+)/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 1000 + parseInt(m[2], 10);
}

function main() {
  // 1. Weights trainedAt
  if (!fs.existsSync(WEIGHTS_PATH)) {
    report({ level: 'retrain-now', reasons: ['lol-weights.json missing'] });
    return;
  }
  const w = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8'));
  const trainedAtIso = w.trainedAt;
  const trainedAtMs = new Date(trainedAtIso).getTime();
  const ageDays = Math.floor((Date.now() - trainedAtMs) / 86400000);

  // 2. Patches em OE trained on (até trainedAt) e post-train
  const db = new Database(DB_PATH, { readonly: true });
  const trainedPatches = db.prepare(`
    SELECT DISTINCT patch FROM oracleselixir_games
    WHERE patch IS NOT NULL AND date <= ?
  `).all(trainedAtIso.replace('T', ' ').slice(0, 19)).map(r => r.patch);

  const newPatchesRows = db.prepare(`
    SELECT patch, COUNT(*) AS n, MAX(date) AS latest
    FROM oracleselixir_games
    WHERE patch IS NOT NULL AND date > ?
    GROUP BY patch ORDER BY latest DESC
  `).all(trainedAtIso.replace('T', ' ').slice(0, 19));

  const newPatches = newPatchesRows
    .filter(r => !trainedPatches.includes(r.patch))
    .sort((a, b) => patchKey(b.patch) - patchKey(a.patch));

  // 3. Splits em train vs post-train
  const trainedSplits = new Set(db.prepare(`
    SELECT DISTINCT split FROM oracleselixir_games
    WHERE split IS NOT NULL AND date <= ?
  `).all(trainedAtIso.replace('T', ' ').slice(0, 19)).map(r => r.split));

  const newSplitsRows = db.prepare(`
    SELECT split, COUNT(*) AS n FROM oracleselixir_games
    WHERE split IS NOT NULL AND date > ?
    GROUP BY split
  `).all(trainedAtIso.replace('T', ' ').slice(0, 19));

  const newSplits = newSplitsRows.filter(r => !trainedSplits.has(r.split) && r.n >= 20);

  // 4. Rows adicionadas em OE desde train
  const newRowsCount = db.prepare(`
    SELECT COUNT(*) AS n FROM oracleselixir_games WHERE date > ?
  `).get(trainedAtIso.replace('T', ' ').slice(0, 19)).n;

  // 5. Decisão
  const reasons = [];
  let level = 'fresh';

  if (newPatches.length >= 3) {
    level = 'retrain-now';
    reasons.push(`${newPatches.length} patches novos desde train: ${newPatches.map(p => p.patch).join(', ')}`);
  } else if (newPatches.length >= 1) {
    level = 'attention';
    reasons.push(`${newPatches.length} patch novo: ${newPatches.map(p => p.patch).join(', ')} (${newPatches.reduce((a, b) => a + b.n, 0)} games)`);
  }

  if (newSplits.length > 0) {
    if (level !== 'retrain-now') level = 'attention';
    reasons.push(`novos splits: ${newSplits.map(s => `${s.split}(${s.n})`).join(', ')}`);
  }

  if (ageDays >= 30) {
    level = 'retrain-now';
    reasons.push(`idade ${ageDays}d ≥ 30d (retrain mensal recomendado)`);
  } else if (ageDays >= 14 && level === 'fresh') {
    level = 'attention';
    reasons.push(`idade ${ageDays}d ≥ 14d`);
  }

  if (newRowsCount >= 2000 && level === 'fresh') {
    level = 'attention';
    reasons.push(`${newRowsCount} novas rows OE desde train`);
  }

  if (!reasons.length) reasons.push(`fresh (age=${ageDays}d, 0 patches/splits novos)`);

  const result = {
    level, ageDays, trainedAtIso,
    newPatches: newPatches.map(p => ({ patch: p.patch, games: p.n, latest: p.latest })),
    newSplits: newSplits.map(s => ({ split: s.split, games: s.n })),
    newRowsCount,
    reasons,
    recommendation: level === 'retrain-now'
      ? 'Retreinar agora: node scripts/sync-oracleselixir.js --year=' + new Date().getFullYear() + ' && node scripts/extract-esports-features.js --game lol && node scripts/train-esports-model.js --game lol && node scripts/fit-lol-model-isotonic.js'
      : level === 'attention'
      ? 'Monitorar; retreinar quando tiver ≥2 patches novos ou ≥1 split novo'
      : 'Nada a fazer.',
  };

  db.close();
  report(result);
}

function report(r) {
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    const badge = r.level === 'fresh' ? '[✓ FRESH]' : r.level === 'attention' ? '[~ ATENÇÃO]' : '[✗ RETRAIN NOW]';
    console.log(`${badge} LoL trained model freshness`);
    console.log(`trainedAt: ${r.trainedAtIso}`);
    console.log(`age: ${r.ageDays} dias`);
    if (r.newPatches?.length) {
      console.log(`\nPatches novos (${r.newPatches.length}):`);
      for (const p of r.newPatches) console.log(`  ${p.patch} → ${p.games} games (até ${(p.latest || '').slice(0, 10)})`);
    }
    if (r.newSplits?.length) {
      console.log(`\nSplits novos: ${r.newSplits.map(s => `${s.split}(${s.n || s.games})`).join(', ')}`);
    }
    console.log(`\nRazões:`);
    for (const rs of (r.reasons || [])) console.log(`  • ${rs}`);
    console.log(`\n→ ${r.recommendation}`);
  }

  if (doNotify && r.level !== 'fresh') {
    const token = process.env.TELEGRAM_TOKEN_ESPORTS;
    const adminId = process.env.ADMIN_USER_IDS?.split(',')[0];
    if (!token || !adminId) return;
    const emoji = r.level === 'retrain-now' ? '🔴' : '🟡';
    const msg = `${emoji} *Modelo LoL ${r.level.toUpperCase()}*\n\n` +
      `Idade: ${r.ageDays}d\n` +
      `Razões:\n${(r.reasons || []).map(x => `• ${x}`).join('\n')}\n\n` +
      `_${r.recommendation.slice(0, 400)}_`;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = JSON.stringify({ chat_id: adminId, text: msg, parse_mode: 'Markdown' });
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => res.on('data', () => {}));
    req.on('error', () => {});
    req.write(body); req.end();
  }

  const codes = { 'fresh': 0, 'attention': 1, 'retrain-now': 2 };
  process.exit(codes[r.level] || 0);
}

main();

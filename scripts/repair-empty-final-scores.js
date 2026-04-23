#!/usr/bin/env node
'use strict';

/**
 * repair-empty-final-scores.js
 *
 * Lista match_results com final_score='' nos esports e dispara os syncs
 * standalone (que agora têm ON CONFLICT defensivo) pra repopular.
 *
 * Uso:
 *   node scripts/repair-empty-final-scores.js                    # mostra count, NÃO executa
 *   node scripts/repair-empty-final-scores.js --apply            # roda os 3 syncs em sequência
 *   node scripts/repair-empty-final-scores.js --apply --game=lol # só lol
 *
 * Pré-requisito: scripts de sync com ON CONFLICT (commit dependente).
 */

require('dotenv').config({ override: true });
const path = require('path');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}
const APPLY = argv.includes('--apply');
const ONE_GAME = arg('game', null);

const DB_PATH = (process.env.DB_PATH || path.resolve(__dirname, '..', 'sportsedge.db'))
  .trim().replace(/^=+/, '');

const db = new Database(DB_PATH, { readonly: true });

const GAMES = ONE_GAME ? [ONE_GAME] : ['lol', 'dota2', 'cs2'];
const SYNC_MAP = {
  lol: 'sync-golgg-matches.js',
  dota2: 'sync-opendota-matches.js',
  cs2: 'sync-hltv-results.js',
};

console.log(`\n══════ REPAIR EMPTY FINAL_SCORES ══════\n`);

const before = {};
for (const g of GAMES) {
  const r = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN final_score IS NULL OR final_score = '' THEN 1 ELSE 0 END) AS empty,
      SUM(CASE WHEN winner IS NOT NULL AND winner != '' THEN 1 ELSE 0 END) AS with_winner
    FROM match_results WHERE game = ?
  `).get(g);
  before[g] = r;
  console.log(`  ${g.padEnd(8)} | total=${r.total.toString().padStart(6)} | empty_score=${r.empty.toString().padStart(5)} | with_winner=${r.with_winner.toString().padStart(6)}`);
}

console.log('');

const samples = {};
for (const g of GAMES) {
  if (before[g].empty === 0) continue;
  const rows = db.prepare(`
    SELECT match_id, team1, team2, league, resolved_at
    FROM match_results
    WHERE game = ? AND (final_score IS NULL OR final_score = '')
    ORDER BY resolved_at DESC LIMIT 5
  `).all(g);
  samples[g] = rows;
  console.log(`── ${g} samples (top 5 mais recentes com score vazio):`);
  for (const r of rows) {
    console.log(`     ${r.team1} vs ${r.team2} | ${r.league || '?'} | ${r.resolved_at}`);
  }
}

if (!APPLY) {
  console.log(`\n[dry-run] Re-rode com --apply pra disparar os syncs (gol.gg / OpenDota / HLTV).`);
  console.log(`           Os syncs vão fazer ON CONFLICT DO UPDATE — preserva score válido,`);
  console.log(`           atualiza row vazia quando fonte tiver o score real.`);
  process.exit(0);
}

db.close(); // syncs vão abrir DB próprio

console.log(`\n══════ APLICANDO SYNCS ══════\n`);
const ROOT = path.resolve(__dirname, '..');
const results = [];
for (const g of GAMES) {
  if (before[g].empty === 0) continue;
  const script = SYNC_MAP[g];
  if (!script) continue;
  console.log(`▶ Rodando ${script} pra ${g}...`);
  const t0 = Date.now();
  try {
    execSync(`node scripts/${script}`, { cwd: ROOT, stdio: 'inherit', timeout: 600000 });
    results.push({ game: g, script, ok: true, durSec: ((Date.now() - t0) / 1000).toFixed(1) });
  } catch (e) {
    results.push({ game: g, script, ok: false, error: e.message });
    console.log(`✗ ${script} falhou: ${e.message}`);
  }
}

console.log(`\n══════ DEPOIS ══════\n`);
const db2 = new Database(DB_PATH, { readonly: true });
for (const g of GAMES) {
  const r = db2.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN final_score IS NULL OR final_score = '' THEN 1 ELSE 0 END) AS empty
    FROM match_results WHERE game = ?
  `).get(g);
  const delta = before[g].empty - r.empty;
  console.log(`  ${g.padEnd(8)} | empty: ${before[g].empty} → ${r.empty} (recovered ${delta})`);
}
db2.close();

console.log(`\nSyncs status:`);
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.game}: ${r.script} (${r.durSec || '?'}s)${r.error ? ' — ' + r.error : ''}`);
}
console.log(`\nNext step: rode 'node scripts/settle-mt-shadow-esports.js' pra liquidar o que recuperou.`);

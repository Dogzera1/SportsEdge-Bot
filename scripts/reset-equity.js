#!/usr/bin/env node
// Reset equity + archive settled tips, preservando histórico.
//
// Ação:
//   1. Cópia binária do DB → sportsedge_snapshot_<YYYY-MM-DD>.db (mesmo diretório)
//   2. UPDATE tips SET archived=1 WHERE archived=0 AND result IS NOT NULL
//      (pending tips preservadas vivas; market_tips_shadow NÃO afetado — histórico contínuo)
//   3. Por sport em bankroll: initial_banca := current_banca (ROI conta de zero)
//   4. settings.bankroll_baseline_amount := SUM(current_banca)
//   5. settings.bankroll_baseline_date := hoje (YYYY-MM-DD)
//
// Uso:
//   node scripts/reset-equity.js --dry-run   # mostra o que faria, sem mutação
//   node scripts/reset-equity.js --confirm   # aplica de verdade
//
// Em produção (Railway):
//   railway run node scripts/reset-equity.js --confirm

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIRM = process.argv.includes('--confirm');

if (!DRY_RUN && !CONFIRM) {
  console.error('Erro: passe --dry-run ou --confirm explicitamente.');
  process.exit(1);
}

const DB_PATH = (process.env.DB_PATH || 'sportsedge.db').trim().replace(/^=+/, '');
const today = new Date().toISOString().slice(0, 10);

if (!fs.existsSync(DB_PATH)) {
  console.error(`DB não encontrado: ${DB_PATH}`);
  process.exit(1);
}

const dbDir = path.dirname(path.resolve(DB_PATH));
const snapshotName = `sportsedge_snapshot_${today}.db`;
const snapshotPath = path.join(dbDir, snapshotName);

console.log('='.repeat(60));
console.log(`Reset equity — ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);
console.log('='.repeat(60));
console.log(`DB: ${DB_PATH}`);
console.log(`Snapshot target: ${snapshotPath}`);
console.log('');

// ── 1. Snapshot ──
if (DRY_RUN) {
  console.log(`[DRY] copiaria ${DB_PATH} → ${snapshotPath}`);
} else {
  if (fs.existsSync(snapshotPath)) {
    console.error(`Snapshot já existe: ${snapshotPath}. Renomeie antes de re-rodar.`);
    process.exit(1);
  }
  fs.copyFileSync(DB_PATH, snapshotPath);
  const sz = (fs.statSync(snapshotPath).size / 1024 / 1024).toFixed(2);
  console.log(`[OK] snapshot criado (${sz} MB)`);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── 2. Preview ──
const tipsSettled = db.prepare(
  "SELECT COUNT(*) n FROM tips WHERE result IS NOT NULL AND (archived IS NULL OR archived = 0)"
).get().n;
const tipsPending = db.prepare(
  "SELECT COUNT(*) n FROM tips WHERE result IS NULL AND (archived IS NULL OR archived = 0)"
).get().n;

const bankrolls = db.prepare('SELECT sport, initial_banca, current_banca FROM bankroll ORDER BY sport').all();
const totalCurrent = bankrolls.reduce((a, b) => a + (b.current_banca || 0), 0);
const totalInitial = bankrolls.reduce((a, b) => a + (b.initial_banca || 0), 0);
const totalProfit = totalCurrent - totalInitial;

const baselineAmount = db.prepare("SELECT value FROM settings WHERE key='bankroll_baseline_amount'").get()?.value;
const baselineDate = db.prepare("SELECT value FROM settings WHERE key='bankroll_baseline_date'").get()?.value;

console.log('');
console.log('── ANTES ──');
console.log(`tips settled (a archivar): ${tipsSettled}`);
console.log(`tips pending (preservadas): ${tipsPending}`);
console.log(`baseline atual: R$ ${baselineAmount} em ${baselineDate}`);
console.log(`total initial (atual): R$ ${totalInitial.toFixed(2)}`);
console.log(`total current (atual): R$ ${totalCurrent.toFixed(2)}`);
console.log(`P&L acumulado: R$ ${totalProfit.toFixed(2)} (${((totalProfit / totalInitial) * 100).toFixed(2)}%)`);
console.log('');
console.log('── DEPOIS ──');
console.log(`tips settled: ${tipsSettled} archived (preservadas no DB, fora do dashboard)`);
console.log(`tips pending: ${tipsPending} intactas`);
console.log(`baseline novo: R$ ${totalCurrent.toFixed(2)} em ${today}`);
console.log(`initial por sport: = current atual (P&L parte do zero)`);
console.log('bankroll per-sport:');
for (const b of bankrolls) {
  console.log(`  ${b.sport.padEnd(12)} initial ${(b.initial_banca || 0).toFixed(2)} → ${(b.current_banca || 0).toFixed(2)}`);
}

if (DRY_RUN) {
  console.log('');
  console.log('[DRY RUN] nenhuma mutação aplicada. Re-rode com --confirm.');
  db.close();
  process.exit(0);
}

// ── 3. Apply ──
const tx = db.transaction(() => {
  const archRes = db.prepare(
    "UPDATE tips SET archived=1 WHERE result IS NOT NULL AND (archived IS NULL OR archived = 0)"
  ).run();

  const updBankroll = db.prepare('UPDATE bankroll SET initial_banca = current_banca, updated_at = CURRENT_TIMESTAMP');
  const bRes = updBankroll.run();

  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  upsert.run('bankroll_baseline_amount', String(totalCurrent.toFixed(2)));
  upsert.run('bankroll_baseline_date', today);
  upsert.run('equity_reset_at', new Date().toISOString());
  upsert.run('equity_reset_snapshot', snapshotName);

  return { archived: archRes.changes, bankrollRows: bRes.changes };
});

const result = tx();

console.log('');
console.log('[OK] reset aplicado.');
console.log(`  tips archivadas: ${result.archived}`);
console.log(`  bankroll rows atualizadas: ${result.bankrollRows}`);
console.log(`  baseline: R$ ${totalCurrent.toFixed(2)} @ ${today}`);
console.log('');
console.log(`Snapshot preservado em ${snapshotPath}`);
console.log('Reversão: copiar snapshot de volta sobre o DB + restart.');

db.close();

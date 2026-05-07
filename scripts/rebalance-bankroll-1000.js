#!/usr/bin/env node
// Rebase total bankroll para R$ 1000 (100 × 10 sports) + arquiva contaminantes pre-reset.
//
// Contexto: reset-equity.js (2026-04-24 ~10:26) arquivou tips settled mas preservou pending.
// Resultado: tips pre-reset settaram depois do reset e contaminaram current_banca.
// Este script limpa esse estado e normaliza initial_banca=100 por sport.
//
// Passos:
//   1. Snapshot binário → sportsedge_snapshot_pre_rebalance_<ts>.db
//   2. Detecta cutoff (equity_reset_at em settings, fallback: min(bankroll.updated_at) hoje)
//   3. UPDATE tips SET archived=1 WHERE sent_at < cutoff AND (archived IS NULL OR archived=0)
//   4. Para cada sport ativo: current = 100 + profit_post_reset; initial = 100
//   5. Sport legacy 'esports': initial=0, current=0
//   6. settings.bankroll_baseline_amount = '1000.00'
//   7. settings.bankroll_baseline_date = today
//
// Uso:
//   node scripts/rebalance-bankroll-1000.js --dry-run
//   node scripts/rebalance-bankroll-1000.js --confirm

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
let getSportUnitValue;
try { ({ getSportUnitValue } = require('../lib/sport-unit')); }
catch (_) {
  // Fallback inline (alinhado com lib/sport-unit.js DEFAULT_TIERS)
  getSportUnitValue = function(current, initial = 100) {
    if (!current || current <= 0) return 0.50;
    const r = current / (initial || 100);
    if (r >= 3.0) return 3.0;
    if (r >= 2.0) return 2.0;
    if (r >= 1.5) return 1.5;
    if (r >= 1.2) return 1.2;
    if (r >= 0.8) return 1.0;
    if (r >= 0.6) return 0.8;
    if (r >= 0.4) return 0.6;
    return 0.5;
  };
}

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIRM = process.argv.includes('--confirm');
if (!DRY_RUN && !CONFIRM) {
  console.error('Erro: passe --dry-run ou --confirm.');
  process.exit(1);
}

const DB_PATH = (process.env.DB_PATH || 'sportsedge.db').trim().replace(/^=+/, '');
if (!fs.existsSync(DB_PATH)) {
  console.error(`DB não encontrado: ${DB_PATH}`);
  process.exit(1);
}

const TARGET_TOTAL = 1000;
const ACTIVE_SPORTS = ['football', 'lol', 'dota2', 'tennis', 'cs', 'valorant', 'mma', 'darts', 'snooker', 'tabletennis'];
const PER_SPORT_INITIAL = TARGET_TOTAL / ACTIVE_SPORTS.length; // 100

const today = new Date().toISOString().slice(0, 10);
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dbDir = path.dirname(path.resolve(DB_PATH));
const snapshotPath = path.join(dbDir, `sportsedge_snapshot_pre_rebalance_${ts}.db`);

console.log('='.repeat(60));
console.log(`Rebalance to R$ ${TARGET_TOTAL} — ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);
console.log('='.repeat(60));
console.log(`DB: ${DB_PATH}`);
console.log(`Snapshot: ${snapshotPath}`);

if (!DRY_RUN) {
  if (fs.existsSync(snapshotPath)) {
    console.error(`Snapshot já existe: ${snapshotPath}`);
    process.exit(1);
  }
  fs.copyFileSync(DB_PATH, snapshotPath);
  console.log(`[OK] snapshot criado (${(fs.statSync(snapshotPath).size / 1024 / 1024).toFixed(2)} MB)`);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── 1. Detect cutoff ──
const resetAtRow = db.prepare("SELECT value FROM settings WHERE key='equity_reset_at'").get();
let cutoff;
if (resetAtRow?.value) {
  // ISO → 'YYYY-MM-DD HH:MM:SS' (sem ms/Z) pra comparar com tips.sent_at
  cutoff = resetAtRow.value.replace('T', ' ').slice(0, 19);
  console.log(`Cutoff (equity_reset_at): ${cutoff}`);
} else {
  const minUpd = db.prepare("SELECT MIN(updated_at) m FROM bankroll WHERE updated_at LIKE ?").get(`${today}%`);
  cutoff = minUpd?.m || `${today} 00:00:00`;
  console.log(`Cutoff (bankroll MIN updated_at hoje): ${cutoff}`);
}

// ── 2. Preview: tips contaminantes ──
const contaminants = db.prepare(`
  SELECT id, sport, sent_at, result, participant1, participant2, stake, odds, confidence
  FROM tips
  WHERE sent_at < ?
    AND (archived IS NULL OR archived = 0)
    AND COALESCE(is_shadow, 0) = 0
  ORDER BY sent_at DESC, id DESC
`).all(cutoff);

console.log('');
console.log(`── CONTAMINANTES (sent_at < ${cutoff}) ──`);
console.log(`Total: ${contaminants.length}`);
for (const t of contaminants) {
  console.log(`  #${t.id} ${t.sport.padEnd(10)} ${t.sent_at} ${String(t.result || 'pending').padEnd(7)} ${t.participant1} vs ${t.participant2} @${t.odds}`);
}

// ── 3. Post-reset profit per sport (from currently-active tips) ──
// 2026-05-07 (audit #24): inclui MT real (sem filtro market_type — antes excluía
// tennis/football/basket/cs2 promovidos) e usa profit_reais quando disponível
// (já em R$, com tier per-sport correto). Fallback hierárquico:
//   1. profit_reais stored (settle pipeline já resolveu unit_value)
//   2. stake_reais * (odds-1) win / -stake_reais loss / 0 push|void
//   3. stake_units * unit_value (per-sport tier) * (odds-1)
const postResetRows = db.prepare(`
  SELECT sport, result, stake, stake_reais, profit_reais, odds, sent_at, id, market_type
  FROM tips
  WHERE sent_at >= ?
    AND result IN ('win','loss','push','void')
    AND (archived IS NULL OR archived = 0)
    AND COALESCE(is_shadow, 0) = 0
`).all(cutoff);

// Pra fallback unit_value: precisa initial_banca per-sport pra calcular tier.
const sportInitialMap = new Map();
const bkRows = db.prepare('SELECT sport, initial_banca FROM bankroll').all();
for (const b of bkRows) sportInitialMap.set(b.sport, Number(b.initial_banca) || 100);

const profitBySport = new Map();
let usedStored = 0, usedStakeR = 0, usedFallback = 0;
for (const r of postResetRows) {
  const s = r.sport === 'esports' ? 'lol' : r.sport; // legado
  let p = 0;
  if (r.profit_reais !== null && r.profit_reais !== undefined) {
    p = Number(r.profit_reais) || 0;
    usedStored++;
  } else if (r.result === 'push' || r.result === 'void') {
    p = 0;
  } else {
    const oddsNum = parseFloat(r.odds) || 0;
    if (Number.isFinite(Number(r.stake_reais)) && Number(r.stake_reais) > 0) {
      const stakeR = Number(r.stake_reais);
      p = r.result === 'win' ? stakeR * (oddsNum - 1) : -stakeR;
      usedStakeR++;
    } else {
      const stakeU = parseFloat(String(r.stake || '0').replace(/[^\d.]/g, '')) || 0;
      const init = sportInitialMap.get(s) || PER_SPORT_INITIAL;
      // runningBanca aproximado: usa initial como tier base (rebalance assume reset → tier=1.0)
      const uv = getSportUnitValue(init, init);
      p = r.result === 'win' ? stakeU * (oddsNum - 1) * uv : -stakeU * uv;
      usedFallback++;
    }
  }
  profitBySport.set(s, (profitBySport.get(s) || 0) + p);
}
console.log(`[profit calc] ${postResetRows.length} tips: ${usedStored} stored profit_reais, ${usedStakeR} stake_reais fallback, ${usedFallback} unit-tier fallback`);

console.log('');
console.log('── POST-RESET REAL P&L (só tips sent_at >= cutoff) ──');
for (const s of ACTIVE_SPORTS) {
  const p = profitBySport.get(s) || 0;
  console.log(`  ${s.padEnd(12)} profit R$ ${p.toFixed(2)}`);
}

// ── 4. New bankroll state ──
console.log('');
console.log('── NEW BANKROLL ──');
const newState = [];
for (const s of ACTIVE_SPORTS) {
  const p = profitBySport.get(s) || 0;
  const current = +(PER_SPORT_INITIAL + p).toFixed(2);
  newState.push({ sport: s, initial: PER_SPORT_INITIAL, current });
  console.log(`  ${s.padEnd(12)} initial ${PER_SPORT_INITIAL.toFixed(2)} current ${current.toFixed(2)}  (Δ ${p >= 0 ? '+' : ''}${p.toFixed(2)})`);
}
const totalCurrent = newState.reduce((a, b) => a + b.current, 0);
console.log(`  ${'TOTAL'.padEnd(12)} initial ${TARGET_TOTAL.toFixed(2)} current ${totalCurrent.toFixed(2)}`);

// ── 5. Settings baseline ──
console.log('');
console.log(`── BASELINE ──`);
console.log(`  bankroll_baseline_amount: ${TARGET_TOTAL.toFixed(2)}`);
console.log(`  bankroll_baseline_date:   ${today}`);

if (DRY_RUN) {
  console.log('');
  console.log('[DRY RUN] nada aplicado. Re-rode com --confirm.');
  db.close();
  process.exit(0);
}

// ── 6. Apply ──
const tx = db.transaction(() => {
  const arch = db.prepare(`
    UPDATE tips SET archived=1
    WHERE sent_at < ? AND (archived IS NULL OR archived = 0) AND COALESCE(is_shadow,0)=0
  `).run(cutoff);

  const upd = db.prepare('UPDATE bankroll SET initial_banca=?, current_banca=?, updated_at=CURRENT_TIMESTAMP WHERE sport=?');
  for (const n of newState) {
    upd.run(n.initial, n.current, n.sport);
  }
  // Zera legacy 'esports' explicitamente (já deve estar em 0, mas garante)
  db.prepare("UPDATE bankroll SET initial_banca=0, current_banca=0, updated_at=CURRENT_TIMESTAMP WHERE sport='esports'").run();

  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  upsert.run('bankroll_baseline_amount', TARGET_TOTAL.toFixed(2));
  upsert.run('bankroll_baseline_date', today);
  upsert.run('bankroll_rebalanced_at', new Date().toISOString());
  upsert.run('bankroll_rebalance_snapshot', path.basename(snapshotPath));

  return { archived: arch.changes, sports: newState.length };
});

const r = tx();
console.log('');
console.log('[OK] Rebalance aplicado.');
console.log(`  tips arquivadas: ${r.archived}`);
console.log(`  sports atualizados: ${r.sports}`);
console.log(`  baseline: R$ ${TARGET_TOTAL.toFixed(2)} @ ${today}`);
console.log(`  snapshot: ${snapshotPath}`);

db.close();

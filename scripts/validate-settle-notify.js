// Smoke test do feature settle-notify (mig 100 + notifySettledTips).
// READ-ONLY. Não envia DM, não muta dados — só valida:
//  1) Mig 100 aplicada (coluna existe)
//  2) Backfill OK (count settled-sem-notified == 0)
//  3) Query principal compila + retorna shape esperado
//  4) Simula uma tip "recém-settled" via UPDATE temporário e rollback
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'sportsedge.db');
const db = new Database(DB_PATH, { readonly: false });

function header(t) { console.log(`\n=== ${t} ===`); }

header('1) Schema check');
const cols = db.prepare(`PRAGMA table_info(tips)`).all();
const col = cols.find(c => c.name === 'settle_notified_at');
console.log('  tips.settle_notified_at:', col ? `OK (${col.type})` : 'MISSING');
const idxs = db.prepare(`PRAGMA index_list(tips)`).all();
const idx = idxs.find(i => i.name === 'idx_tips_settle_notify_pending');
console.log('  idx_tips_settle_notify_pending:', idx ? 'OK' : 'MISSING');

header('2) Migration registry');
const migRow = db.prepare(`SELECT id, applied_at FROM schema_migrations WHERE id = ?`).get('100_tips_settle_notified_at');
console.log(' ', migRow ? `applied at ${migRow.applied_at}` : 'NOT APPLIED (mig 100 ainda não rodou)');

header('3) Backfill — settled-tips sem settle_notified_at');
const orphan = db.prepare(`
  SELECT COUNT(*) AS n FROM tips
   WHERE result IS NOT NULL AND settle_notified_at IS NULL
`).get();
console.log(`  orphan rows (settled mas not notified): ${orphan.n}`);

header('4) Query principal — pending notifications');
const pending = db.prepare(`
  SELECT id, sport, match_id, event_name, participant1, participant2,
         tip_participant, market_type, odds, stake, stake_reais,
         profit_reais, result, settled_at, is_live, is_shadow
    FROM tips
   WHERE result IN ('win','loss','void','push')
     AND (is_shadow IS NULL OR is_shadow = 0)
     AND (archived IS NULL OR archived = 0)
     AND settle_notified_at IS NULL
     AND settled_at IS NOT NULL
     AND settled_at >= datetime('now', '-3 days')
   ORDER BY settled_at ASC
   LIMIT 50
`).all();
console.log(`  pending agora: ${pending.length} (esperado 0 logo após mig)`);

header('5) Simulação — pega última tip real settled (mesmo archived) e re-roda query');
const sample = db.prepare(`
  SELECT id, sport, result, settled_at, profit_reais, stake_reais,
         participant1, participant2, tip_participant, market_type, odds, archived
    FROM tips
   WHERE result IN ('win','loss','void','push')
     AND (is_shadow IS NULL OR is_shadow = 0)
     AND settled_at IS NOT NULL
   ORDER BY id DESC LIMIT 1
`).get();
if (!sample) {
  console.log('  nenhuma tip real settled — pulando simulação');
} else {
  console.log('  pick:', JSON.stringify(sample, null, 2));
  // simula reset → query → restore
  db.prepare('BEGIN').run();
  try {
    db.prepare(`UPDATE tips SET settle_notified_at = NULL, settled_at = datetime('now', '-30 minutes'), archived = 0 WHERE id = ?`).run(sample.id);
    const found = db.prepare(`
      SELECT id, sport, result FROM tips
       WHERE result IN ('win','loss','void','push')
         AND (is_shadow IS NULL OR is_shadow = 0)
         AND (archived IS NULL OR archived = 0)
         AND settle_notified_at IS NULL
         AND settled_at IS NOT NULL
         AND settled_at >= datetime('now', '-3 days')
         AND id = ?
    `).get(sample.id);
    console.log('  query achou após reset:', found ? `OK (id=${found.id} sport=${found.sport} result=${found.result})` : 'FAIL');

    // simula a montagem da mensagem
    const _EMOJI = { lol: '🎮', dota2: '🕹️', cs: '🔫', valorant: '🎯', tennis: '🎾',
      football: '⚽', basket: '🏀', mma: '🥊', darts: '🎯', snooker: '🎱', tt: '🏓', tabletennis: '🏓' };
    const _LBL = { win: '✅ *VITÓRIA*', loss: '❌ *DERROTA*', void: '⚪ *VOID*', push: '🟦 *PUSH*' };
    const emoji = _EMOJI[String(sample.sport).toLowerCase()] || '📌';
    const lbl = _LBL[sample.result] || sample.result;
    const profit = Number(sample.profit_reais);
    const stakeR = Number(sample.stake_reais);
    const odd = Number(sample.odds);
    const mkt = String(sample.market_type || 'ML').toUpperCase();
    let profitLine = '';
    if (sample.result === 'void' || sample.result === 'push') {
      profitLine = Number.isFinite(stakeR) && stakeR > 0
        ? `↩️ Stake devolvida: *R$${stakeR.toFixed(2)}*` : '↩️ Stake devolvida';
    } else if (Number.isFinite(profit)) {
      const sign = profit >= 0 ? '+' : '';
      const stakeNote = Number.isFinite(stakeR) && stakeR > 0 ? ` _(stake R$${stakeR.toFixed(2)})_` : '';
      profitLine = `💰 P/L: *${sign}R$${profit.toFixed(2)}*${stakeNote}`;
    }
    const matchupLine = (sample.participant1 && sample.participant2)
      ? `*${sample.participant1}* vs *${sample.participant2}*` : '';
    const pickLine = sample.tip_participant
      ? `🎯 Aposta: *${sample.tip_participant}*${mkt !== 'ML' ? ` (${mkt})` : ''}${Number.isFinite(odd) && odd > 0 ? ` @ ${odd.toFixed(2)}` : ''}`
      : '';
    const msg = [`${emoji} ${lbl}`, matchupLine, pickLine, profitLine ? `\n${profitLine}` : ''].filter(Boolean).join('\n');
    console.log('\n  ── MSG PREVIEW ──');
    console.log(msg.split('\n').map(l => '  | ' + l).join('\n'));
    console.log('  ─────────────────');
  } finally {
    db.prepare('ROLLBACK').run();
    console.log('  rollback OK (dados não tocados)');
  }
}

header('6) Cardinalidade total por sport (real, settled, all-time)');
const byS = db.prepare(`
  SELECT sport, result, COUNT(*) AS n
    FROM tips
   WHERE result IS NOT NULL
     AND (is_shadow IS NULL OR is_shadow = 0)
   GROUP BY sport, result ORDER BY sport, result
`).all();
for (const r of byS) console.log(`  ${r.sport.padEnd(12)} ${r.result.padEnd(6)} ${r.n}`);

db.close();
console.log('\nDONE');

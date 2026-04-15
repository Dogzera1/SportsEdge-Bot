#!/usr/bin/env node
/**
 * Reavalia tips PENDENTES de tênis com os novos gates (aplicados em 2026-04-15):
 *   - EV mínimo: 7% (era 5%)
 *   - Duplas (doubles) não são suportadas pelo modelo Elo → rejeitadas
 *   - EV ≥ 30% tratado como small-sample artifact quando conf != ALTA
 *   - EV entre 7-10% com conf BAIXA → rejeitada
 *
 * Anula tips rejeitadas via tabela voided_tips e atualiza result='void'.
 *
 * Uso:   node scripts/void-bad-tennis-tips.js           (dry-run, só lista)
 *        node scripts/void-bad-tennis-tips.js --apply   (executa void)
 *
 * Env: DB_PATH (default sportsedge.db)
 */
require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');

const DB_PATH = path.resolve(process.cwd(), (process.env.DB_PATH || 'sportsedge.db').trim().replace(/^=+/, ''));
const APPLY = process.argv.includes('--apply');

function evaluate(tip) {
  const ev = parseFloat(tip.ev);
  const conf = String(tip.confidence || '').toUpperCase();
  const p1 = String(tip.participant1 || '');
  const p2 = String(tip.participant2 || '');
  const isDoubles = p1.includes('/') || p2.includes('/');

  const reasons = [];
  if (isDoubles) reasons.push('dupla (Elo só suporta singles)');
  if (ev < 7.0) reasons.push(`EV ${ev.toFixed(1)}% < 7% (novo gate base)`);
  if (ev >= 7.0 && ev < 10.0 && conf === 'BAIXA') reasons.push(`EV ${ev.toFixed(1)}% + conf BAIXA (exige MÉDIA+)`);
  if (ev >= 30.0 && conf !== 'ALTA') reasons.push(`EV ${ev.toFixed(1)}% absurdo (provável small-sample, exige conf ALTA)`);

  return { keep: reasons.length === 0, reasons };
}

(async () => {
  const { db } = await initDatabase(DB_PATH);
  const pend = db.prepare(
    "SELECT id, participant1, participant2, tip_participant, odds, ev, confidence, event_name, sent_at FROM tips WHERE sport='tennis' AND result IS NULL ORDER BY sent_at DESC"
  ).all();

  console.log(`\n=== ${pend.length} tips pendentes de tênis ===\n`);
  if (!pend.length) { console.log('Nada a fazer.'); process.exit(0); }

  const toVoid = [];
  const toKeep = [];
  for (const t of pend) {
    const res = evaluate(t);
    const tag = res.keep ? '✅ MANTER' : '❌ ANULAR';
    console.log(`${tag} [#${t.id}] ${t.participant1} vs ${t.participant2} | ${t.tip_participant} @${t.odds} EV=${t.ev}% ${t.confidence}`);
    if (!res.keep) {
      console.log(`   motivos: ${res.reasons.join('; ')}`);
      toVoid.push(t);
    } else {
      toKeep.push(t);
    }
  }

  console.log(`\nResumo: manter=${toKeep.length} anular=${toVoid.length}`);
  if (!APPLY) { console.log('\n(dry-run — use --apply para executar)'); process.exit(0); }
  if (!toVoid.length) { console.log('\nNada a anular.'); process.exit(0); }

  const updateResult = db.prepare("UPDATE tips SET result='void', settled_at=datetime('now') WHERE id=?");

  const tx = db.transaction((rows) => {
    for (const t of rows) updateResult.run(t.id);
  });
  tx(toVoid);
  console.log(`\n${toVoid.length} tips anuladas.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

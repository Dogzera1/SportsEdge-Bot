/**
 * Regression — near-regime CLV re-capture deve SOBRESCREVER clv_odds.
 *
 * Background (audit logs 2026-05-28): a janela CLV "near" (bot.js:30999 —
 * "última fica como close") re-captura odds a cada ciclo até o match start,
 * esperando sobrescrever clv_odds com o valor mais próximo do fechamento.
 * Mas todos os write paths usavam statements com guard `clv_captured_at IS NULL`
 * (mig 096, anti-race) → após a 1ª captura o overwrite virava no-op silencioso
 * e o CLV travava no 1º odd da janela (ou no open-proxy far-future). O bot
 * logava "Registrado CLV X (prev=Y)" todo ciclo pra um write que o server
 * rejeitava — CLV reportado ficava enviesado pro open, não pro close.
 *
 * Fix: stmts.updateTipCLVNear (sem guard, last-writer-wins) é usado quando o
 * bot passa regime:'near'; far/live/unknown + callers legacy (sem regime)
 * ficam set-once via stmts.updateTipCLV (guard preservado).
 *
 * Este test trava o contrato comportamental dos 2 statements REAIS de
 * lib/database.js (exercitados via initDatabase em DB temp + migrations).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

module.exports = function (t) {
  const tempPath = path.join(os.tmpdir(), `sportsedge-clv-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const initDatabase = require('../lib/database');
  const { db, stmts } = initDatabase(tempPath);
  const cleanup = () => {
    try { db.close(); } catch (_) {}
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tempPath + s); } catch (_) {} }
  };

  try {
    // Tip já capturada na janela: clv_odds=1.581 + clv_captured_at NÃO-NULL.
    const id = db.prepare(`
      INSERT INTO tips (sport, match_id, tip_participant, odds, clv_odds, clv_captured_at)
      VALUES ('tennis', 'm-clv-1', 'Player A', 1.50, 1.581, datetime('now', '-30 minutes'))
    `).run().lastInsertRowid;
    const clvOf = (rowId) => db.prepare('SELECT clv_odds FROM tips WHERE id = ?').get(rowId).clv_odds;

    t.test('updateTipCLV (set-once) NÃO sobrescreve após captura — guard mig 096 intacto', () => {
      stmts.updateTipCLV.run(1.645, 'm-clv-1', 'tennis', 'Player A');
      const v = clvOf(id);
      t.assert(Math.abs(v - 1.581) < 1e-9, `clv_odds deveria permanecer 1.581 (guard), ficou ${v}`);
    });

    t.test('updateTipCLVNear SOBRESCREVE clv_odds (tracking até o close)', () => {
      stmts.updateTipCLVNear.run(1.645, 'm-clv-1', 'tennis', 'Player A');
      const v = clvOf(id);
      t.assert(Math.abs(v - 1.645) < 1e-9, `clv_odds deveria virar 1.645 (near overwrite), ficou ${v}`);
    });

    t.test('updateTipCLVNear é scoped por side (não toca a outra perna ML do match)', () => {
      const id2 = db.prepare(`
        INSERT INTO tips (sport, match_id, tip_participant, odds, clv_odds, clv_captured_at)
        VALUES ('tennis', 'm-clv-1', 'Player B', 2.40, 2.500, datetime('now', '-30 minutes'))
      `).run().lastInsertRowid;
      stmts.updateTipCLVNear.run(1.990, 'm-clv-1', 'tennis', 'Player A');
      const vb = clvOf(id2);
      t.assert(Math.abs(vb - 2.500) < 1e-9, `Player B clv_odds não deveria mudar, ficou ${vb}`);
    });
  } finally {
    cleanup();
  }
};

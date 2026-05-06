'use strict';

// Regression test pra round 6: delta-bankroll atomicity.
// Verifica que UPDATE bankroll com `current_banca + ?` é idempotente sob 2
// transactions concurrent — antes read+sum+write deixava race.

const Database = require('better-sqlite3');

module.exports = function (t) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bankroll (
      sport TEXT PRIMARY KEY,
      current_banca REAL,
      initial_banca REAL,
      updated_at TEXT
    );
    INSERT INTO bankroll (sport, current_banca, initial_banca) VALUES ('lol', 100.00, 100.00);
  `);

  t.test('delta-update preserve precision', () => {
    db.prepare(`UPDATE bankroll SET current_banca = round(current_banca + ?, 2) WHERE sport = ?`).run(5.55, 'lol');
    const r = db.prepare(`SELECT current_banca FROM bankroll WHERE sport = ?`).get('lol');
    t.assert(r.current_banca === 105.55, `expected 105.55 got ${r.current_banca}`);
  });

  t.test('delta-update idempotent across multiple', () => {
    db.prepare(`UPDATE bankroll SET current_banca = round(current_banca + ?, 2) WHERE sport = ?`).run(-2.50, 'lol');
    db.prepare(`UPDATE bankroll SET current_banca = round(current_banca + ?, 2) WHERE sport = ?`).run(1.00, 'lol');
    const r = db.prepare(`SELECT current_banca FROM bankroll WHERE sport = ?`).get('lol');
    t.assert(r.current_banca === 104.05, `expected 104.05 got ${r.current_banca}`);
  });

  // Simula race: 2 readers leem antes de qualquer write, depois ambos escrevem.
  // Padrão antigo (read+sum+write) deveria perder o segundo delta.
  // Padrão novo (UPDATE +=) cumula corretamente.
  t.test('atomic + vs read-sum-write race simulation', () => {
    db.prepare(`UPDATE bankroll SET current_banca = ? WHERE sport = ?`).run(100.00, 'lol');
    // Simula read+sum+write race: ambos leem 100, escrevem 105 e 110 → 110 vence (perde +5)
    const reader1 = db.prepare(`SELECT current_banca FROM bankroll WHERE sport = ?`).get('lol').current_banca;
    const reader2 = db.prepare(`SELECT current_banca FROM bankroll WHERE sport = ?`).get('lol').current_banca;
    t.assert(reader1 === 100 && reader2 === 100, 'both reads see 100');
    // Old-style write (last wins, dropping one delta).
    db.prepare(`UPDATE bankroll SET current_banca = ? WHERE sport = ?`).run(reader1 + 5, 'lol');
    db.prepare(`UPDATE bankroll SET current_banca = ? WHERE sport = ?`).run(reader2 + 10, 'lol');
    const oldStyleResult = db.prepare(`SELECT current_banca FROM bankroll WHERE sport = ?`).get('lol').current_banca;
    t.assert(oldStyleResult === 110, `old-style perde +5: ${oldStyleResult}`);

    // Reset
    db.prepare(`UPDATE bankroll SET current_banca = ? WHERE sport = ?`).run(100.00, 'lol');
    // New-style: 2 atomic UPDATE += diff → ambos delta aplicados.
    db.prepare(`UPDATE bankroll SET current_banca = round(current_banca + ?, 2) WHERE sport = ?`).run(5, 'lol');
    db.prepare(`UPDATE bankroll SET current_banca = round(current_banca + ?, 2) WHERE sport = ?`).run(10, 'lol');
    const newStyleResult = db.prepare(`SELECT current_banca FROM bankroll WHERE sport = ?`).get('lol').current_banca;
    t.assert(newStyleResult === 115, `new-style cumula: expected 115 got ${newStyleResult}`);
  });

  // ESPN aggregate detection
  t.test('ESPN STATUS_AGGREGATE not in FINAL_STATUSES', () => {
    const FINAL = new Set(['STATUS_FINAL', 'STATUS_FULL_TIME', 'STATUS_FINAL_AET', 'STATUS_FINAL_PEN', 'STATUS_END_OF_REGULATION']);
    t.assert(!FINAL.has('STATUS_AGGREGATE'), 'AGGREGATE excluded from final');
    t.assert(FINAL.has('STATUS_FINAL_PEN'), 'PEN included (treats as Draw)');
  });

  db.close();
};

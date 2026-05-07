/**
 * Tests for lib/calibration — PAV isotonic curve via in-memory DB.
 */

const Database = require('better-sqlite3');
const { calibrateProbability, getCalibrationStats, invalidateCache } = require('../lib/calibration');

function _setupDb(rows) {
  const db = new Database(':memory:');
  // 2026-05-07: schema atualizado pra incluir is_shadow (lib/calibration.js
  // passou a filtrar `COALESCE(is_shadow, 0) = 0` em commit anterior — Wave 3
  // do P2 hardening).
  db.exec(`
    CREATE TABLE tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT,
      model_p_pick REAL,
      result TEXT,
      is_shadow INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      sent_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const ins = db.prepare(`INSERT INTO tips (sport, model_p_pick, result) VALUES (?, ?, ?)`);
  for (const r of rows) ins.run(r.sport || 'lol', r.p, r.result);
  return db;
}

module.exports = function runTests(t) {
  t.test('calibrateProbability sem amostra retorna probRaw unchanged', () => {
    invalidateCache();
    const db = _setupDb([]);
    const p = calibrateProbability(db, 'lol', 0.65);
    t.assert(Math.abs(p - 0.65) < 1e-9, `p=${p}, esperava 0.65`);
    db.close();
  });

  t.test('calibrateProbability clamp em [0, 1]', () => {
    invalidateCache();
    const db = _setupDb([]);
    t.assert(calibrateProbability(db, 'lol', -0.5) === 0, 'p<0 → 0');
    t.assert(calibrateProbability(db, 'lol', 1.5) === 1, 'p>1 → 1');
    db.close();
  });

  t.test('PAV monotônico: sample bem-calibrado mantém forma', () => {
    invalidateCache();
    // Sample bem-calibrado: p=0.5 → 50% wins, p=0.7 → 70% wins, p=0.9 → 90% wins
    const rows = [];
    for (let i = 0; i < 50; i++) rows.push({ p: 0.50, result: i < 25 ? 'win' : 'loss' });
    for (let i = 0; i < 50; i++) rows.push({ p: 0.70, result: i < 35 ? 'win' : 'loss' });
    for (let i = 0; i < 50; i++) rows.push({ p: 0.90, result: i < 45 ? 'win' : 'loss' });
    const db = _setupDb(rows);
    const stats = getCalibrationStats(db, 'lol');
    t.assert(stats.samples === 150, `samples=${stats.samples}`);
    if (stats.calibrated) {
      const c = stats.curve;
      // Empírical deve ser monotônico não-decrescente em bin order
      for (let i = 1; i < c.length; i++) {
        t.assert(c[i].empirical >= c[i - 1].empirical - 1e-9,
          `não-monotônico bin[${i}]=${c[i].empirical} < bin[${i-1}]=${c[i-1].empirical}`);
      }
    }
    db.close();
  });

  t.test('calibrateProbability retorna valor entre [0,1]', () => {
    invalidateCache();
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push({ p: 0.6, result: i < 60 ? 'win' : 'loss' });
    for (let i = 0; i < 100; i++) rows.push({ p: 0.8, result: i < 80 ? 'win' : 'loss' });
    const db = _setupDb(rows);
    const cal = calibrateProbability(db, 'lol', 0.65);
    t.assert(cal >= 0 && cal <= 1, `cal=${cal} fora de [0,1]`);
    db.close();
  });

  t.test('getCalibrationStats retorna shape correto', () => {
    invalidateCache();
    const db = _setupDb([{ p: 0.5, result: 'win' }]);
    const s = getCalibrationStats(db, 'lol');
    t.assert(typeof s.samples === 'number', 'samples');
    t.assert(typeof s.calibrated === 'boolean', 'calibrated bool');
    t.assert('curve' in s, 'curve key');
    t.assert(typeof s.minSamplesRequired === 'number', 'minSamplesRequired');
    db.close();
  });

  t.test('invalidateCache limpa cache (próxima call recomputa)', () => {
    // Setup com dados
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push({ p: 0.5, result: i < 50 ? 'win' : 'loss' });
    const db = _setupDb(rows);
    calibrateProbability(db, 'lol', 0.5);
    invalidateCache('lol');
    // Não tem como observar diretamente, mas garantir que não throw
    const p = calibrateProbability(db, 'lol', 0.5);
    t.assert(Number.isFinite(p), 'p ainda numérico após invalidate');
    db.close();
  });
};

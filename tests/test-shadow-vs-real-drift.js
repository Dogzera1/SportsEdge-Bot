/**
 * Tests for lib/shadow-vs-real-drift — early warning detector que dispara
 * quando shadow ROI degrada enquanto real ROI fica estável.
 *
 * Schema in-memory mirror de bot tables (tips + market_tips_shadow).
 * Janelas: recent = [windowDays, 0d), baseline = [2*windowDays, windowDays).
 */

const Database = require('better-sqlite3');
const { runShadowVsRealDriftCheck } = require('../lib/shadow-vs-real-drift');

function _setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT,
      stake TEXT,
      odds REAL,
      result TEXT,
      profit_reais REAL DEFAULT 0,
      stake_reais REAL DEFAULT 0,
      is_shadow INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      sent_at TEXT
    );
    CREATE TABLE market_tips_shadow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT,
      stake_units REAL DEFAULT 1,
      profit_units REAL DEFAULT 0,
      result TEXT,
      created_at TEXT
    );
  `);
  return db;
}

// Insere N tips reais (is_shadow=0) num sport, com daysAgo offset, usando
// stake=R$10 e profit conforme winRate.
function _insertRealTips(db, sport, n, daysAgo, winRate, profitPerWin = 10) {
  const ins = db.prepare(`
    INSERT INTO tips (sport, is_shadow, archived, result, stake_reais, profit_reais, sent_at)
    VALUES (?, 0, 0, ?, 10, ?, datetime('now', '-' || ? || ' days'))
  `);
  for (let i = 0; i < n; i++) {
    const win = (i / n) < winRate;
    ins.run(sport, win ? 'win' : 'loss', win ? profitPerWin : -10, daysAgo);
  }
}

// Insere N rows em market_tips_shadow num sport, com daysAgo offset,
// stake_units=1 e profit_units controlado.
function _insertShadowMt(db, sport, n, daysAgo, winRate, profitPerWin = 1) {
  const ins = db.prepare(`
    INSERT INTO market_tips_shadow (sport, stake_units, profit_units, result, created_at)
    VALUES (?, 1, ?, ?, datetime('now', '-' || ? || ' days'))
  `);
  for (let i = 0; i < n; i++) {
    const win = (i / n) < winRate;
    ins.run(sport, win ? profitPerWin : -1, win ? 'win' : 'loss', daysAgo);
  }
}

module.exports = function runTests(t) {
  t.test('empty DB: alerts vazios, breakdown skip por insufficient_sample', () => {
    const db = _setupDb();
    const r = runShadowVsRealDriftCheck(db);
    t.assert(r.alerts.length === 0, `alerts=${r.alerts.length}`);
    t.assert(Array.isArray(r.breakdown), 'breakdown should be array');
    t.assert(r.breakdown.every(b => b.skip_reason === 'insufficient_sample'),
      'sem dados, todos sports devem skip por insufficient_sample');
    db.close();
  });

  t.test('shadow estável + real estável: sem alert', () => {
    const db = _setupDb();
    // Shadow recent (0-14d) ROI ~+5%; baseline (14-28d) ROI ~+5%
    _insertShadowMt(db, 'lol', 50, 7, 0.55, 1);   // recent
    _insertShadowMt(db, 'lol', 50, 21, 0.55, 1);  // baseline
    // Real recent (0-14d) ROI ~+5%; baseline ROI ~+5%
    _insertRealTips(db, 'lol', 30, 7, 0.55);
    _insertRealTips(db, 'lol', 30, 21, 0.55);
    const r = runShadowVsRealDriftCheck(db);
    const lol = r.breakdown.find(b => b.sport === 'lol');
    t.assert(lol, 'lol breakdown deve existir');
    t.assert(!lol.alert, `alert deveria ser false, foi ${lol.alert}`);
    db.close();
  });

  t.test('shadow degrada + real estável: ALERT (early warning correct)', () => {
    const db = _setupDb();
    // Shadow degradou: baseline winRate 0.65 (ROI~+30%) → recent 0.40 (ROI~-20%)
    // Delta_shadow ~ -50pp (forte queda)
    _insertShadowMt(db, 'lol', 50, 7, 0.40, 1);   // recent — pior
    _insertShadowMt(db, 'lol', 50, 21, 0.65, 1);  // baseline — melhor
    // Real estável: ambas janelas ROI ~+5%
    _insertRealTips(db, 'lol', 30, 7, 0.55);
    _insertRealTips(db, 'lol', 30, 21, 0.55);
    const r = runShadowVsRealDriftCheck(db);
    const lol = r.breakdown.find(b => b.sport === 'lol');
    t.assert(lol && lol.alert, `alert deveria ser true, foi ${lol?.alert}`);
    t.assert(lol.delta_shadow < -3, `delta_shadow=${lol.delta_shadow} deveria ser ≤-3`);
    t.assert(lol.gap_pp < -5, `gap=${lol.gap_pp} deveria ser ≤-5`);
    t.assert(r.alerts.length === 1, `r.alerts.length=${r.alerts.length}, esperava 1`);
    t.assert(r.alerts[0].sport === 'lol', `alert sport=${r.alerts[0].sport}`);
    db.close();
  });

  t.test('shadow degrada + real degrada (até pior): SEM alert', () => {
    const db = _setupDb();
    // Ambos universos caíram. Real caiu MAIS que shadow → gap positivo →
    // não dispara alert (alert requer gap ≤ -5pp). Cenário "regime change
    // visível em real" — sem early warning porque real ja sofreu.
    _insertShadowMt(db, 'lol', 50, 7, 0.40, 1);
    _insertShadowMt(db, 'lol', 50, 21, 0.65, 1);
    _insertRealTips(db, 'lol', 30, 7, 0.30, 10);
    _insertRealTips(db, 'lol', 30, 21, 0.65, 10);
    const r = runShadowVsRealDriftCheck(db);
    const lol = r.breakdown.find(b => b.sport === 'lol');
    t.assert(lol, 'lol breakdown deve existir');
    t.assert(!lol.alert, `alert deveria ser false (real piorou ≥ shadow), foi ${lol.alert}`);
    db.close();
  });

  t.test('sample insuficiente em uma janela: skip', () => {
    const db = _setupDb();
    _insertShadowMt(db, 'lol', 5, 7, 0.50, 1);  // só 5 — abaixo do minNShadow=30
    _insertShadowMt(db, 'lol', 50, 21, 0.65, 1);
    _insertRealTips(db, 'lol', 30, 7, 0.55);
    _insertRealTips(db, 'lol', 30, 21, 0.55);
    const r = runShadowVsRealDriftCheck(db);
    const lol = r.breakdown.find(b => b.sport === 'lol');
    t.assert(lol && lol.skip_reason === 'insufficient_sample',
      `expected skip_reason=insufficient_sample, got ${lol?.skip_reason}`);
    t.assert(r.alerts.length === 0, 'alerts deveria estar vazio');
    db.close();
  });

  t.test('cfg honra opts: gapThresholdPp customizado', () => {
    const db = _setupDb();
    _insertShadowMt(db, 'lol', 50, 7, 0.40, 1);
    _insertShadowMt(db, 'lol', 50, 21, 0.65, 1);
    _insertRealTips(db, 'lol', 30, 7, 0.55);
    _insertRealTips(db, 'lol', 30, 21, 0.55);
    // Threshold mais permissivo (1pp) — alert dispara mais facilmente
    const r1 = runShadowVsRealDriftCheck(db, { gapThresholdPp: 1 });
    t.assert(r1.alerts.length === 1, 'gap=1pp threshold deveria disparar');
    // Threshold muito restritivo (100pp) — nunca dispara
    const r2 = runShadowVsRealDriftCheck(db, { gapThresholdPp: 100 });
    t.assert(r2.alerts.length === 0, 'gap=100pp threshold nunca dispara');
    db.close();
  });

  t.test('multi-sport: alert isolado per sport', () => {
    const db = _setupDb();
    // lol: alert
    _insertShadowMt(db, 'lol', 50, 7, 0.30, 1);
    _insertShadowMt(db, 'lol', 50, 21, 0.70, 1);
    _insertRealTips(db, 'lol', 30, 7, 0.55);
    _insertRealTips(db, 'lol', 30, 21, 0.55);
    // tennis: estável (sem alert)
    _insertShadowMt(db, 'tennis', 50, 7, 0.55, 1);
    _insertShadowMt(db, 'tennis', 50, 21, 0.55, 1);
    _insertRealTips(db, 'tennis', 30, 7, 0.55);
    _insertRealTips(db, 'tennis', 30, 21, 0.55);
    const r = runShadowVsRealDriftCheck(db);
    t.assert(r.alerts.length === 1, `alerts=${r.alerts.length}, esperava 1`);
    t.assert(r.alerts[0].sport === 'lol', `alert sport=${r.alerts[0].sport}`);
    db.close();
  });

  t.test('windowDays customizado afeta janelas', () => {
    const db = _setupDb();
    // Setup pra janela 7d (recent 0-7d, baseline 7-14d)
    _insertShadowMt(db, 'lol', 50, 3, 0.40, 1);   // recent
    _insertShadowMt(db, 'lol', 50, 10, 0.65, 1);  // baseline
    _insertRealTips(db, 'lol', 30, 3, 0.55);
    _insertRealTips(db, 'lol', 30, 10, 0.55);
    const r = runShadowVsRealDriftCheck(db, { windowDays: 7 });
    t.assert(r.cfg.windowDays === 7, `cfg.windowDays=${r.cfg.windowDays}`);
    const lol = r.breakdown.find(b => b.sport === 'lol');
    t.assert(lol && lol.alert, 'janela 7d deveria detectar alert');
    db.close();
  });
};

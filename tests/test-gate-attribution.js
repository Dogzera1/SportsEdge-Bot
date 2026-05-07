/**
 * Tests for lib/gate-attribution — counterfactual aplica gates atuais
 * retroativamente em tips reais settled. Mede saved_loss vs lost_profit
 * per gate (detecta gate cortando wins mais que losses).
 */

const Database = require('better-sqlite3');
const { runGateAttribution } = require('../lib/gate-attribution');

function _setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT,
      event_name TEXT,
      odds REAL,
      ev REAL,
      stake_reais REAL DEFAULT 0,
      profit_reais REAL DEFAULT 0,
      result TEXT,
      confidence TEXT,
      model_p_pick REAL,
      is_shadow INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      settled_at TEXT,
      sent_at TEXT
    );
  `);
  return db;
}

function _insertTip(db, opts) {
  const ins = db.prepare(`
    INSERT INTO tips (sport, event_name, odds, ev, stake_reais, profit_reais,
                      result, confidence, model_p_pick, is_shadow, archived,
                      settled_at, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
            datetime('now', '-' || ? || ' days'),
            datetime('now', '-' || ? || ' days'))
  `);
  const isShadow = opts.is_shadow != null ? opts.is_shadow : 0;
  const daysAgo = opts.daysAgo != null ? opts.daysAgo : 5;
  ins.run(
    opts.sport || 'lol',
    opts.event_name || 'LCK Spring',
    opts.odds || 1.85,
    opts.ev != null ? opts.ev : 5,
    opts.stake_reais != null ? opts.stake_reais : 10,
    opts.profit_reais != null ? opts.profit_reais : 0,
    opts.result || 'win',
    opts.confidence || 'MÉDIA',
    opts.model_p_pick != null ? opts.model_p_pick : 0.55,
    isShadow,
    daysAgo,
    daysAgo,
  );
}

module.exports = function runTests(t) {
  t.test('empty DB: total=0, blocked=0', () => {
    const db = _setupDb();
    const r = runGateAttribution(db);
    t.assert(r.total === 0, `total=${r.total}`);
    t.assert(r.blocked === 0, `blocked=${r.blocked}`);
    t.assert(Object.keys(r.gates).length === 0, 'sem gates triggered');
    db.close();
  });

  t.test('tips bem-comportadas: 0 blocked', () => {
    const db = _setupDb();
    // 10 tips lol tier1 LCK, EV moderado, odds normais — nenhum gate dispara
    for (let i = 0; i < 10; i++) {
      _insertTip(db, { sport: 'esports', event_name: 'LCK Spring',
                       odds: 1.85, ev: 6, model_p_pick: 0.55, result: i < 6 ? 'win' : 'loss',
                       profit_reais: i < 6 ? 8.5 : -10 });
    }
    const r = runGateAttribution(db);
    t.assert(r.total === 10, `total=${r.total}`);
    t.assert(r.blocked === 0, `blocked=${r.blocked}, esperava 0`);
    db.close();
  });

  t.test('gate ev_sanity_gt50: tip com EV>50 bloqueada', () => {
    const db = _setupDb();
    // 6 tips com EV insano (>50%) — todas bloqueadas pelo ev_sanity
    for (let i = 0; i < 6; i++) {
      _insertTip(db, { sport: 'lol', ev: 65, result: i < 3 ? 'win' : 'loss',
                       profit_reais: i < 3 ? 10 : -10 });
    }
    const r = runGateAttribution(db);
    t.assert(r.total === 6, `total=${r.total}`);
    t.assert(r.blocked === 6, `blocked=${r.blocked}, esperava 6`);
    t.assert(r.gates['ev_sanity_gt50'], 'gate ev_sanity_gt50 deveria estar registrado');
    t.assert(r.gates['ev_sanity_gt50'].n === 6, `gate n=${r.gates['ev_sanity_gt50'].n}`);
    // 3 wins (lost_profit) + 3 losses (saved_loss)
    t.assert(r.gates['ev_sanity_gt50'].savedLoss === 30, `savedLoss=${r.gates['ev_sanity_gt50'].savedLoss}`);
    t.assert(r.gates['ev_sanity_gt50'].lostProfit === 30, `lostProfit=${r.gates['ev_sanity_gt50'].lostProfit}`);
    db.close();
  });

  t.test('gate lol_tier2_ev_cap: LoL tier-2 com EV>25 bloqueada', () => {
    const db = _setupDb();
    // event_name não bate tier1 LoL regex → cai como tier2
    for (let i = 0; i < 6; i++) {
      _insertTip(db, { sport: 'esports', event_name: 'random tier2 league',
                       ev: 30, model_p_pick: 0.55, result: 'loss', profit_reais: -10 });
    }
    const r = runGateAttribution(db);
    t.assert(r.gates['lol_tier2_ev_cap'], 'gate lol_tier2_ev_cap registrado');
    t.assert(r.gates['lol_tier2_ev_cap'].n === 6, `n=${r.gates['lol_tier2_ev_cap'].n}`);
    db.close();
  });

  t.test('shadow tips ignorados (is_shadow=1)', () => {
    const db = _setupDb();
    // 5 tips shadow com EV insano — não devem entrar no agregado
    for (let i = 0; i < 5; i++) {
      _insertTip(db, { is_shadow: 1, ev: 65, result: 'win' });
    }
    // 3 tips real normais
    for (let i = 0; i < 3; i++) {
      _insertTip(db, { ev: 5, result: 'win' });
    }
    const r = runGateAttribution(db);
    t.assert(r.total === 3, `total=${r.total}, esperava 3 (shadow excluído)`);
    db.close();
  });

  t.test('janela days respeitada: tips antigas excluídas', () => {
    const db = _setupDb();
    _insertTip(db, { ev: 65, result: 'loss', daysAgo: 5 });
    _insertTip(db, { ev: 65, result: 'loss', daysAgo: 60 }); // fora janela 30d
    const r = runGateAttribution(db, { days: 30 });
    t.assert(r.total === 1, `total=${r.total}, esperava 1 (60d excluído)`);
    db.close();
  });

  t.test('minNPerGate: gate com n<minN é dropado do output', () => {
    const db = _setupDb();
    // Só 2 tips ativando ev_sanity — abaixo do default minNPerGate=5
    for (let i = 0; i < 2; i++) _insertTip(db, { ev: 65, result: 'loss' });
    const r = runGateAttribution(db);
    t.assert(r.blocked === 2, 'aggregate global ainda conta');
    t.assert(!r.gates['ev_sanity_gt50'], 'gate específico não aparece com n<5');
    db.close();
  });

  t.test('bySport: breakdown per sport correto', () => {
    const db = _setupDb();
    for (let i = 0; i < 6; i++) _insertTip(db, { sport: 'lol', ev: 65, result: 'loss', profit_reais: -10 });
    for (let i = 0; i < 6; i++) _insertTip(db, { sport: 'tennis', ev: 5, result: 'win', profit_reais: 8 });
    const r = runGateAttribution(db);
    t.assert(r.bySport['lol'], 'lol bucket existe');
    t.assert(r.bySport['lol'].blocked === 6, `lol.blocked=${r.bySport['lol'].blocked}`);
    t.assert(r.bySport['tennis'], 'tennis bucket existe');
    t.assert(r.bySport['tennis'].blocked === 0, `tennis.blocked=${r.bySport['tennis'].blocked}`);
    db.close();
  });

  t.test('netSaved = savedLoss - lostProfit', () => {
    const db = _setupDb();
    // 4 losses bloqueadas (saved_loss = 40) + 2 wins bloqueadas (lost_profit = 20)
    for (let i = 0; i < 4; i++) _insertTip(db, { ev: 65, result: 'loss', profit_reais: -10 });
    for (let i = 0; i < 2; i++) _insertTip(db, { ev: 65, result: 'win', profit_reais: 10 });
    const r = runGateAttribution(db);
    t.assert(r.savedLoss === 40, `savedLoss=${r.savedLoss}`);
    t.assert(r.lostProfit === 20, `lostProfit=${r.lostProfit}`);
    t.assert(r.netSaved === 20, `netSaved=${r.netSaved}, esperava 20 (40-20)`);
    db.close();
  });

  t.test('blockedPct calculado corretamente', () => {
    const db = _setupDb();
    for (let i = 0; i < 7; i++) _insertTip(db, { ev: 65, result: 'loss' }); // todas blocked
    for (let i = 0; i < 3; i++) _insertTip(db, { ev: 5, result: 'win' });   // todas pass
    const r = runGateAttribution(db);
    t.assert(r.total === 10, `total=${r.total}`);
    t.assert(r.blocked === 7, `blocked=${r.blocked}`);
    t.assert(r.blockedPct === 70, `blockedPct=${r.blockedPct}, esperava 70`);
    db.close();
  });
};

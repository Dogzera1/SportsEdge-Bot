/**
 * Tests for lib/readiness-learner.
 *
 * Cobre os 2 bugs latentes encontrados em prod 2026-05-07:
 * 1. _readReadinessSnapshot enrich() retornava expected_win_pp; _diagnose
 *    lia expected_win_rate_pct → calibSignificant sempre false.
 * 2. minN=30 default antigo escapava leaks com sample 20-29.
 *
 * Plus cenários do flow _diagnose: prob_shrink, prob_amplify, gate_kelly_up,
 * hasActive blocking, Wilson CI gating.
 */

const Database = require('better-sqlite3');
const {
  _readReadinessSnapshot,
  _diagnose,
  DEFAULTS,
} = require('../lib/readiness-learner');

function _setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT,
      match_id TEXT,
      tip_participant TEXT,
      market_type TEXT,
      event_name TEXT,
      odds REAL,
      ev REAL,
      stake_reais REAL DEFAULT 10,
      profit_reais REAL DEFAULT 0,
      result TEXT,
      model_p_pick REAL,
      clv_odds REAL,
      is_shadow INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      sent_at TEXT
    );
    CREATE TABLE readiness_corrections_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      market TEXT,
      league TEXT,
      action_type TEXT NOT NULL,
      value_before TEXT,
      value_after TEXT,
      n_at_time INTEGER,
      roi_at_time REAL,
      clv_at_time REAL,
      calib_gap_at_time REAL,
      applied_at TEXT NOT NULL,
      expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      status_reason TEXT,
      source TEXT NOT NULL DEFAULT 'auto',
      last_verified_at TEXT,
      escalation_count INTEGER DEFAULT 0
    );
  `);
  return db;
}

function _insertTips(db, opts) {
  const ins = db.prepare(`
    INSERT INTO tips (sport, match_id, tip_participant, market_type, event_name,
                      odds, ev, stake_reais, profit_reais, result, model_p_pick,
                      clv_odds, is_shadow, archived, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
            datetime('now', '-' || ? || ' days'))
  `);
  const {
    sport = 'lol', market = 'ML', n = 10, winRate = 0.5,
    odd = 1.85, modelP = 0.55, daysAgo = 5, isShadow = 0,
    league = 'LCK Spring',
  } = opts;
  // EV implied = (modelP * odd - 1) * 100
  const ev = +(((modelP * odd) - 1) * 100).toFixed(2);
  for (let i = 0; i < n; i++) {
    const win = (i / n) < winRate;
    const matchId = `${sport}_match_${Date.now()}_${i}_${Math.random()}`;
    const participant = `Team${i}_${win ? 'W' : 'L'}`;
    const profit = win ? 10 * (odd - 1) : -10;
    ins.run(sport, matchId, participant, market, league, odd, ev, 10, profit,
            win ? 'win' : 'loss', modelP, odd * 0.98, isShadow, daysAgo);
  }
}

module.exports = function runTests(t) {
  t.test('DEFAULTS.minN é 20 (pós fix 2026-05-07)', () => {
    t.assert(DEFAULTS.minN === 20, `minN=${DEFAULTS.minN}, esperava 20`);
  });

  t.test('_readReadinessSnapshot retorna cells com expected_win_rate_pct alias', () => {
    const db = _setupDb();
    _insertTips(db, { sport: 'lol', n: 24, winRate: 0.375, modelP: 0.7347 });
    const snap = _readReadinessSnapshot(db, { source: 'real', days: 30 });
    t.assert(snap.byMarket.length > 0, 'byMarket deve ter entries');
    const cell = snap.byMarket.find(c => c.sport === 'lol');
    t.assert(cell, 'lol cell existe');
    // Bug fix 2026-05-07: enrich agora exporta expected_win_rate_pct
    t.assert(cell.expected_win_rate_pct != null,
      `expected_win_rate_pct deveria estar preenchido (era undefined no bug)`);
    t.assert(Math.abs(cell.expected_win_rate_pct - 73.47) < 0.5,
      `expected_win_rate_pct=${cell.expected_win_rate_pct}, esperava ~73.47`);
    t.assert(cell.calibration_gap_pp != null, 'calib_gap deve estar preenchido');
    db.close();
  });

  t.test('_diagnose retorna prob_shrink quando calib_gap muito negativo + significativo', () => {
    const db = _setupDb();
    // 24 tips, 9 wins → real 37.5% vs expected 73.47% → gap -36pp + Wilson significant
    _insertTips(db, { sport: 'lol', n: 24, winRate: 0.375, modelP: 0.7347, odd: 1.85 });
    const snap = _readReadinessSnapshot(db, { source: 'real', days: 30 });
    const cell = snap.byMarket.find(c => c.sport === 'lol' && c.market_type === 'ML');
    t.assert(cell, 'cell existe');
    const decision = _diagnose(db, cell, 'market');
    t.assert(decision, 'decision não pode ser null');
    t.assert(decision.action === 'prob_shrink',
      `action=${decision?.action}, esperava prob_shrink`);
    t.assert(decision.direction === 'negative', 'direction negative');
    t.assert(decision.factor != null && decision.factor < 1,
      `factor deve ser < 1 (shrink), foi ${decision.factor}`);
    db.close();
  });

  t.test('_diagnose skipa quando sample < minN (n=18)', () => {
    const db = _setupDb();
    _insertTips(db, { sport: 'lol', n: 18, winRate: 0.30, modelP: 0.70 });
    const snap = _readReadinessSnapshot(db, { source: 'real', days: 30 });
    const cell = snap.byMarket.find(c => c.sport === 'lol');
    t.assert(cell.settled === 18, `settled=${cell.settled}`);
    const decision = _diagnose(db, cell, 'market');
    t.assert(decision === null, `decision deveria null pra sample <20, foi ${JSON.stringify(decision)}`);
    db.close();
  });

  t.test('_diagnose passa quando sample = minN (n=20, boundary)', () => {
    const db = _setupDb();
    // 20 tips com calib gap forte: real 25% (5 wins) vs expected 75% → gap -50pp
    _insertTips(db, { sport: 'lol', n: 20, winRate: 0.25, modelP: 0.75, odd: 2.0 });
    const snap = _readReadinessSnapshot(db, { source: 'real', days: 30 });
    const cell = snap.byMarket.find(c => c.sport === 'lol');
    t.assert(cell.settled === 20, `settled=${cell.settled}`);
    const decision = _diagnose(db, cell, 'market');
    t.assert(decision != null, 'decision não pode null em n=20');
    t.assert(decision.action === 'prob_shrink', `action=${decision.action}`);
    db.close();
  });

  t.test('_diagnose retorna ação positiva (kelly_up OR ev_boost) quando edge sustentado', () => {
    const db = _setupDb();
    // 70 tips, 65% win, model 60%, odd 1.85, sample ≥60.
    // Pode disparar gate_kelly_up (ROI>5 + n≥60) OU ev_boost (CLV>2 + ROI>5).
    // Aceito ambos: o ponto é que a decision é positive direction.
    _insertTips(db, { sport: 'tennis', market: 'HANDICAP_GAMES', n: 70,
                       winRate: 0.65, modelP: 0.60, odd: 1.85, league: 'ATP' });
    const snap = _readReadinessSnapshot(db, { source: 'real', days: 30 });
    const cell = snap.byMarket.find(c => c.sport === 'tennis');
    t.assert(cell, 'cell tennis existe');
    const decision = _diagnose(db, cell, 'market');
    t.assert(decision, 'decision não null');
    t.assert(['gate_kelly_up', 'ev_boost', 'prob_amplify'].includes(decision.action),
      `action=${decision?.action}, esperava ação positiva (kelly_up/ev_boost/amplify)`);
    t.assert(decision.direction === 'positive',
      `direction=${decision?.direction}, esperava positive`);
    db.close();
  });

  t.test('_diagnose retorna prob_amplify quando modelo underconfident significativo', () => {
    const db = _setupDb();
    // 30 tips, 80% wins (24/30), model prevê 50% → real exceeds expected ~30pp
    _insertTips(db, { sport: 'lol', n: 30, winRate: 0.80, modelP: 0.50, odd: 1.95 });
    const snap = _readReadinessSnapshot(db, { source: 'real', days: 30 });
    const cell = snap.byMarket.find(c => c.sport === 'lol');
    t.assert(cell, 'cell exists');
    const decision = _diagnose(db, cell, 'market');
    t.assert(decision, 'decision não null');
    t.assert(decision.action === 'prob_amplify',
      `action=${decision?.action}, esperava prob_amplify`);
    // factor pode ser =1 quando holdout não encontra factor melhor que baseline.
    // Desde que action='prob_amplify' e direction='positive', está correto.
    t.assert(decision.direction === 'positive', `direction=${decision.direction}`);
    t.assert(decision.factor != null, 'factor deve existir');
    db.close();
  });

  t.test('_diagnose hasActive bloqueia decisão (correção já em flight)', () => {
    const db = _setupDb();
    _insertTips(db, { sport: 'lol', n: 24, winRate: 0.30, modelP: 0.75 });
    db.prepare(`
      INSERT INTO readiness_corrections_log
        (sport, market, action_type, applied_at, status)
      VALUES ('lol', 'ML', 'prob_shrink', datetime('now', '-3 days'), 'active')
    `).run();
    const snap = _readReadinessSnapshot(db, { source: 'real', days: 30 });
    const cell = snap.byMarket.find(c => c.sport === 'lol' && c.market_type === 'ML');
    t.assert(cell, 'cell exists');
    const decision = _diagnose(db, cell, 'market');
    t.assert(decision === null, 'decision deve null quando há correção active');
    db.close();
  });

  t.test('_diagnose Wilson CI gate: skipa shrink quando gap não-significativo (sample pequeno)', () => {
    const db = _setupDb();
    // 20 tips, 10 wins → real 50% vs expected 60% → gap -10pp, mas Wilson CI
    // [0.30, 0.70] inclui 0.60 → calibSignificant=false → não dispara prob_shrink.
    _insertTips(db, { sport: 'lol', n: 20, winRate: 0.50, modelP: 0.60, odd: 1.95 });
    const snap = _readReadinessSnapshot(db, { source: 'real', days: 30 });
    const cell = snap.byMarket.find(c => c.sport === 'lol');
    t.assert(cell, 'cell exists');
    const decision = _diagnose(db, cell, 'market');
    // calibGap=-10pp existe mas não dispara prob_shrink (Wilson CI inclui expected).
    // Pode cair em outro path (ev_shrink se CLV ruim, ou null/ev_calib_refit).
    if (decision && decision.action === 'prob_shrink') {
      throw new Error('prob_shrink não deveria disparar com Wilson CI inclusivo');
    }
    db.close();
  });

  t.test('league scope dispara league_block quando ROI < cutoff e n ≥ leagueMinN', () => {
    const db = _setupDb();
    // 12 tips numa league com ROI -50%
    _insertTips(db, { sport: 'lol', n: 12, winRate: 0.20, modelP: 0.55,
                       odd: 1.95, league: 'CBLOL' });
    const snap = _readReadinessSnapshot(db, { source: 'real', days: 30 });
    const cell = snap.byLeague.find(c => c.sport === 'lol' && c.league === 'CBLOL');
    t.assert(cell, 'league cell exists');
    t.assert(cell.settled === 12, `settled=${cell.settled}`);
    const decision = _diagnose(db, cell, 'league');
    t.assert(decision, 'decision não null');
    t.assert(decision.action === 'league_block', `action=${decision.action}`);
    db.close();
  });

  t.test('snapshot ignora is_shadow=1 quando source=real (P2 compliance)', () => {
    const db = _setupDb();
    _insertTips(db, { sport: 'lol', n: 50, winRate: 0.25, isShadow: 1, modelP: 0.75 });
    _insertTips(db, { sport: 'lol', n: 25, winRate: 0.50, isShadow: 0, modelP: 0.55 });
    const snap = _readReadinessSnapshot(db, { source: 'real', days: 30 });
    const cell = snap.byMarket.find(c => c.sport === 'lol');
    t.assert(cell, 'cell exists');
    // Real: 25 tips com winRate=0.50 → 12-13 wins
    t.assert(cell.settled === 25, `settled=${cell.settled}, esperava 25 (apenas real)`);
    t.assert(cell.win_rate_pct >= 40 && cell.win_rate_pct <= 60,
      `win_rate=${cell.win_rate_pct}, esperava ~50% (real), não ~25% (shadow contaminação)`);
    db.close();
  });

  t.test('snapshot opts.source="shadow" lê is_shadow=1 (debug override)', () => {
    const db = _setupDb();
    _insertTips(db, { sport: 'lol', n: 40, winRate: 0.30, isShadow: 1, modelP: 0.70 });
    _insertTips(db, { sport: 'lol', n: 20, winRate: 0.60, isShadow: 0, modelP: 0.55 });
    const snap = _readReadinessSnapshot(db, { source: 'shadow', days: 30 });
    const cell = snap.byMarket.find(c => c.sport === 'lol');
    t.assert(cell, 'cell exists');
    t.assert(cell.settled === 40, `settled=${cell.settled}, esperava 40 (apenas shadow)`);
    t.assert(cell.win_rate_pct >= 25 && cell.win_rate_pct <= 35,
      `win_rate=${cell.win_rate_pct}, esperava ~30% (shadow)`);
    db.close();
  });
};

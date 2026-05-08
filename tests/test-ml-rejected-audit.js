/**
 * tests/test-ml-rejected-audit.js
 *
 * Smoke da lib/ml-rejected-audit em DB in-memory.
 */
const Database = require('better-sqlite3');

module.exports = function (t) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ml_gate_rejected_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      match_id TEXT,
      league TEXT,
      team1 TEXT,
      team2 TEXT,
      tip_participant TEXT,
      pick_side TEXT,
      odd REAL,
      ev_pct REAL,
      model_p_pick REAL,
      conf TEXT,
      is_live INTEGER NOT NULL DEFAULT 0,
      rejected_by_gate TEXT NOT NULL,
      gate_meta TEXT,
      rejected_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Reset cache do prepared statement entre testes (lib usa singleton)
  delete require.cache[require.resolve('../lib/ml-rejected-audit')];
  process.env.ML_REJECTED_AUDIT = 'true';
  const { recordMlGateRejection, summarize } = require('../lib/ml-rejected-audit');

  t.test('recordMlGateRejection: insere row com todos os campos', () => {
    const ok = recordMlGateRejection(db, {
      sport: 'tennis',
      match: { id: 'm1', team1: 'Maria Timofeeva', team2: 'Francesca Jones', league: 'WTA 125K Istanbul - QF', status: 'live' },
      tipParticipant: 'Maria Timofeeva',
      pickSide: 't1',
      odd: 4.82,
      evPct: 76,
      modelPPick: 0.556,
      conf: 'MÉDIA',
      isLive: true,
      rejectedByGate: 'ev_sanity',
      gateMeta: { ceiling: 50 },
    });
    t.assert(ok === true, 'retornou true');
    const r = db.prepare('SELECT * FROM ml_gate_rejected_audit').get();
    t.assert(r.sport === 'tennis', 'sport tennis');
    t.assert(r.match_id === 'm1', 'match_id m1');
    t.assert(r.tip_participant === 'Maria Timofeeva', 'pick correto');
    t.assert(r.odd === 4.82, 'odd preservada');
    t.assert(r.ev_pct === 76, 'ev_pct preservado');
    t.assert(r.is_live === 1, 'is_live=1 (live)');
    t.assert(r.rejected_by_gate === 'ev_sanity', 'gate label');
    t.assert(r.gate_meta === '{"ceiling":50}', 'gate_meta JSON-stringified');
    t.assert(typeof r.rejected_at === 'string' && r.rejected_at.endsWith('Z'), 'rejected_at ISO');
  });

  t.test('recordMlGateRejection: aceita gateMeta string', () => {
    const ok = recordMlGateRejection(db, {
      sport: 'lol',
      match: { id: 'm2', team1: 'KIWOOM DRX', team2: 'Gen.G', status: 'live' },
      tipParticipant: 'KIWOOM DRX',
      odd: 9.03,
      evPct: 74.9,
      rejectedByGate: 'ai_disabled_no_fallback',
      gateMeta: 'raw-string',
    });
    t.assert(ok === true);
    const r = db.prepare('SELECT * FROM ml_gate_rejected_audit WHERE match_id = ?').get('m2');
    t.assert(r.gate_meta === 'raw-string', 'string passou direto sem JSON.stringify');
  });

  t.test('recordMlGateRejection: rejecto sem db ou rejectedByGate retorna false', () => {
    t.assert(recordMlGateRejection(null, { sport: 'lol', rejectedByGate: 'x' }) === false);
    t.assert(recordMlGateRejection(db, { sport: 'lol' }) === false);
    t.assert(recordMlGateRejection(db, { rejectedByGate: 'x' }) === false);
  });

  t.test('recordMlGateRejection: env opt-out desativa', () => {
    process.env.ML_REJECTED_AUDIT = 'false';
    const before = db.prepare('SELECT COUNT(*) AS n FROM ml_gate_rejected_audit').get().n;
    const ok = recordMlGateRejection(db, {
      sport: 'lol',
      match: { id: 'mskip', team1: 'A', team2: 'B', status: 'live' },
      rejectedByGate: 'ev_sanity',
    });
    const after = db.prepare('SELECT COUNT(*) AS n FROM ml_gate_rejected_audit').get().n;
    t.assert(ok === false, 'retorna false quando off');
    t.assert(after === before, 'nada inserido');
    process.env.ML_REJECTED_AUDIT = 'true';
  });

  t.test('summarize: agrega por sport×gate×is_live', () => {
    // Mais 2 inserts pra ter dados ricos
    recordMlGateRejection(db, {
      sport: 'tennis', match: { id: 'm3', team1: 'X', team2: 'Y', status: 'live' },
      rejectedByGate: 'ev_sanity', odd: 4.0, evPct: 60,
    });
    recordMlGateRejection(db, {
      sport: 'lol', match: { id: 'm4', team1: 'A', team2: 'B', status: 'upcoming' },
      rejectedByGate: 'ev_sanity', odd: 2.5, evPct: 55,
    });
    const summary = summarize(db, { days: 7 });
    t.assert(Array.isArray(summary), 'summary é array');
    t.assert(summary.length >= 2, 'pelo menos 2 grupos');
    const tennisRows = summary.filter(r => r.sport === 'tennis');
    t.assert(tennisRows.length >= 1, 'tem tennis');
    t.assert(tennisRows.every(r => typeof r.n === 'number' && r.n > 0), 'n > 0');
  });

  t.test('summarize: filtro por sport', () => {
    const out = summarize(db, { days: 7, sport: 'lol' });
    t.assert(out.every(r => r.sport === 'lol'), 'só lol');
  });
};

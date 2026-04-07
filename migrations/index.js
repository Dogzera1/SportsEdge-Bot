function nowIso() {
  return new Date().toISOString();
}

function tableExists(db, tableName) {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName);
  return !!row;
}

function columnExists(db, tableName, columnName) {
  if (!tableExists(db, tableName)) return false;
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some(c => c.name === columnName);
}

function addColumnIfMissing(db, tableName, columnName, columnSqlDef) {
  if (columnExists(db, tableName, columnName)) return false;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSqlDef}`);
  return true;
}

const migrations = [
  {
    id: '001_bankroll_per_sport',
    up(db) {
      if (!tableExists(db, 'bankroll')) return;

      const cols = db.prepare('PRAGMA table_info(bankroll)').all();
      const hasSport = cols.some(c => c.name === 'sport');
      if (hasSport) return;

      let initialBanca = 100.0;
      let currentBanca = 100.0;
      try {
        const old = db.prepare('SELECT * FROM bankroll WHERE id = 1').get();
        if (old) {
          initialBanca = old.initial_banca ?? initialBanca;
          currentBanca = old.current_banca ?? currentBanca;
        }
      } catch (_) {}

      db.exec(`
        DROP TABLE bankroll;
        CREATE TABLE bankroll (
          sport TEXT PRIMARY KEY,
          initial_banca REAL NOT NULL DEFAULT 100.0,
          current_banca REAL NOT NULL DEFAULT 100.0,
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);

      db.prepare(
        "INSERT OR IGNORE INTO bankroll (sport, initial_banca, current_banca) VALUES ('esports', ?, ?)"
      ).run(initialBanca, currentBanca);
    },
  },
  {
    id: '002_tips_line_shopping_cols',
    up(db) {
      addColumnIfMissing(db, 'tips', 'clv_odds', 'clv_odds REAL');
      addColumnIfMissing(db, 'tips', 'open_odds', 'open_odds REAL');
    },
  },
  {
    id: '003_tips_finance_cols',
    up(db) {
      addColumnIfMissing(db, 'tips', 'stake_reais', 'stake_reais REAL');
      addColumnIfMissing(db, 'tips', 'profit_reais', 'profit_reais REAL');
    },
  },
  {
    id: '004_pro_champ_stats_objectives_cols',
    up(db) {
      addColumnIfMissing(db, 'pro_champ_stats', 'first_dragon_wr', 'first_dragon_wr REAL');
      addColumnIfMissing(db, 'pro_champ_stats', 'first_baron_wr', 'first_baron_wr REAL');
    },
  },
  {
    id: '005_tips_market_type_col',
    up(db) {
      addColumnIfMissing(db, 'tips', 'market_type', "market_type TEXT DEFAULT 'ML'");
    },
  },
  {
    id: '006_tips_reanalysis_cols',
    up(db) {
      addColumnIfMissing(db, 'tips', 'current_odds', 'current_odds REAL');
      addColumnIfMissing(db, 'tips', 'current_ev', 'current_ev REAL');
      addColumnIfMissing(db, 'tips', 'current_confidence', 'current_confidence TEXT');
      addColumnIfMissing(db, 'tips', 'current_updated_at', 'current_updated_at TEXT');
    },
  },
  {
    id: '007_tips_model_prob_cols',
    up(db) {
      addColumnIfMissing(db, 'tips', 'model_p1', 'model_p1 REAL');
      addColumnIfMissing(db, 'tips', 'model_p2', 'model_p2 REAL');
      addColumnIfMissing(db, 'tips', 'model_p_pick', 'model_p_pick REAL');
      addColumnIfMissing(db, 'tips', 'model_label', 'model_label TEXT');
    },
  },
  {
    id: '008_tips_reason_col',
    up(db) {
      addColumnIfMissing(db, 'tips', 'tip_reason', 'tip_reason TEXT');
    },
  },
];

function applyMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations ORDER BY applied_at').all().map(r => r.id)
  );

  const pending = migrations.filter(m => !applied.has(m.id));
  if (pending.length === 0) return { applied: 0 };

  const runAll = db.transaction(() => {
    for (const m of pending) {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        m.id,
        nowIso()
      );
    }
  });

  runAll();
  return { applied: pending.length };
}

module.exports = {
  applyMigrations,
  migrations,
};

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
  {
    id: '009_tips_last_notified_at_col',
    up(db) {
      addColumnIfMissing(db, 'tips', 'last_notified_at', 'last_notified_at TEXT');
    },
  },
  {
    id: '010_seed_ml_factor_weights',
    up(db) {
      if (!tableExists(db, 'ml_factor_weights')) return;
      db.prepare('INSERT OR IGNORE INTO ml_factor_weights (factor, weight, wins, total) VALUES (?,?,0,0)').run('forma', 0.25);
      db.prepare('INSERT OR IGNORE INTO ml_factor_weights (factor, weight, wins, total) VALUES (?,?,0,0)').run('h2h', 0.30);
      db.prepare('INSERT OR IGNORE INTO ml_factor_weights (factor, weight, wins, total) VALUES (?,?,0,0)').run('comp', 0.35);
    },
  },
  {
    id: '011_golgg_role_impact',
    up(db) {
      if (tableExists(db, 'golgg_role_impact')) return;
      db.exec(`
        CREATE TABLE IF NOT EXISTS golgg_role_impact (
          role TEXT PRIMARY KEY,
          sample_games REAL NOT NULL DEFAULT 0,
          winrate REAL,
          gpm REAL,
          dmg_pct REAL,
          kda REAL,
          source TEXT DEFAULT 'gol.gg',
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    id: '012_tips_indexes',
    up(db) {
      if (!tableExists(db, 'tips')) return;
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tips_sport_sent_at ON tips(sport, sent_at);
        CREATE INDEX IF NOT EXISTS idx_tips_sport_result_sent_at ON tips(sport, result, sent_at);
        CREATE INDEX IF NOT EXISTS idx_tips_sport_live_sent_at ON tips(sport, is_live, sent_at);
        CREATE INDEX IF NOT EXISTS idx_tips_sport_conf_sent_at ON tips(sport, confidence, sent_at);
      `);
    },
  },
  {
    // Tabela de estatísticas de jogo por partida (kill_diff_10, gold_diff_10, etc.)
    // Populada por scripts/fetch-match-stats.js (Riot API) ou manualmente.
    // Usada pelo modelo ML como features adicionais quando disponível.
    id: '013_match_stats',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS match_stats (
          match_id    TEXT NOT NULL,
          game        TEXT NOT NULL DEFAULT 'lol',
          -- Kill differential at 10 minutes (t1 perspective: positive = t1 ahead)
          kill_diff_10  REAL,
          -- Gold differential at 10 minutes (em centenas para normalização)
          gold_diff_10  REAL,
          -- First objective (t1=1, t2=0, null=desconhecido)
          first_blood   INTEGER,
          first_tower   INTEGER,
          first_dragon  INTEGER,
          first_baron   INTEGER,
          -- Duração da partida em minutos
          game_duration REAL,
          -- Total de abates na partida
          total_kills   INTEGER,
          -- Fonte dos dados
          source        TEXT DEFAULT 'riot_api',
          fetched_at    TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (match_id, game)
        );
        CREATE INDEX IF NOT EXISTS idx_match_stats_game ON match_stats(game);
      `);
    },
  },
  {
    // Seed de novos fatores ML: streak e kd10
    id: '014_seed_ml_streak_kd10',
    up(db) {
      if (!tableExists(db, 'ml_factor_weights')) return;
      db.prepare('INSERT OR IGNORE INTO ml_factor_weights (factor, weight, wins, total) VALUES (?,?,0,0)').run('streak', 0.05);
      db.prepare('INSERT OR IGNORE INTO ml_factor_weights (factor, weight, wins, total) VALUES (?,?,0,0)').run('kd10', 0.10);
    },
  },
  {
    // Shadow mode: tip é analisada e registrada no DB mas NÃO é enviada DM.
    // Usado para auditar CLV antes de promover um esporte novo (darts, snooker) para produção.
    id: '015_tips_shadow_col',
    up(db) {
      addColumnIfMissing(db, 'tips', 'is_shadow', 'is_shadow INTEGER DEFAULT 0');
    },
  },
  {
    // Bankroll inicial para darts (novo esporte)
    id: '016_seed_bankroll_darts',
    up(db) {
      if (!tableExists(db, 'bankroll')) return;
      db.prepare('INSERT OR IGNORE INTO bankroll (sport, initial_banca, current_banca) VALUES (?, 100.0, 100.0)').run('darts');
    },
  },
  {
    // Bankroll inicial para snooker (novo esporte, Betfair)
    id: '017_seed_bankroll_snooker',
    up(db) {
      if (!tableExists(db, 'bankroll')) return;
      db.prepare('INSERT OR IGNORE INTO bankroll (sport, initial_banca, current_banca) VALUES (?, 100.0, 100.0)').run('snooker');
    },
  },
  {
    // Timestamp de quando as odds foram fetched — mede latência e permite auditar staleness
    id: '018_tips_odds_fetched_at',
    up(db) {
      addColumnIfMissing(db, 'tips', 'odds_fetched_at', 'odds_fetched_at TEXT');
    },
  },
  {
    // model_version: separa tips do modelo padrão ('v1') vs experimentais ('v2', 'v2_shadow').
    // Usado pelo plano Tennis Vetor 1 — A/B test sem misturar agregados.
    id: '019_tips_model_version',
    up(db) {
      addColumnIfMissing(db, 'tips', 'model_version', `model_version TEXT DEFAULT 'v1'`);
    },
  },
  {
    // Snapshots Dota live pra Vetor 7 — Steam RT vs Pinnacle latency analysis.
    // Captura pareada (Steam RT state + odds Pinnacle dejuiced) a cada N segundos.
    id: '020_dota_live_snapshots',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dota_live_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          captured_at TEXT NOT NULL,
          match_id TEXT NOT NULL,
          team1 TEXT NOT NULL,
          team2 TEXT NOT NULL,
          game_time INTEGER,
          gold_diff INTEGER,
          kills_diff INTEGER,
          radiant_kills INTEGER,
          dire_kills INTEGER,
          model_p1 REAL,
          pinnacle_odds_t1 REAL,
          pinnacle_odds_t2 REAL,
          implied_p1_dejuiced REAL,
          divergence_pp REAL,
          source TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_dota_snap_match ON dota_live_snapshots(match_id, captured_at);
        CREATE INDEX IF NOT EXISTS idx_dota_snap_time ON dota_live_snapshots(captured_at);
      `);
    },
  },
  {
    // Vetor 3 — Line shopping cross-bookmaker.
    // Colunas pra registrar qual book tinha melhor preço na hora da tip (pra tracking CLV by-book).
    id: '021_tips_line_shop_cols',
    up(db) {
      addColumnIfMissing(db, 'tips', 'best_book', 'best_book TEXT');
      addColumnIfMissing(db, 'tips', 'best_odd', 'best_odd REAL');
      addColumnIfMissing(db, 'tips', 'pinnacle_odd', 'pinnacle_odd REAL');
      addColumnIfMissing(db, 'tips', 'line_shop_delta_pct', 'line_shop_delta_pct REAL');
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

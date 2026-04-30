function nowIso() {
  return new Date().toISOString();
}

function tableExists(db, tableName) {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName);
  return !!row;
}

// 2026-04-28: whitelist guard pra DDL — better-sqlite3 não suporta bind em
// PRAGMA/ALTER, então validar via regex antes de interpolar.
function _validIdent(s) {
  return typeof s === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}

function columnExists(db, tableName, columnName) {
  if (!_validIdent(tableName) || !_validIdent(columnName)) {
    throw new Error(`columnExists: invalid identifier (table='${tableName}' col='${columnName}')`);
  }
  if (!tableExists(db, tableName)) return false;
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some(c => c.name === columnName);
}

function addColumnIfMissing(db, tableName, columnName, columnSqlDef) {
  if (!_validIdent(tableName) || !_validIdent(columnName)) {
    throw new Error(`addColumnIfMissing: invalid identifier (table='${tableName}' col='${columnName}')`);
  }
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
  {
    // Oracle's Elixir ingest — player-level rows (position ∈ top/jng/mid/bot/sup).
    // Cobre §2a (KDA individual), §2b (champion pool), §4b (ban/pick por jogador).
    id: '023_oracleselixir_players',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS oracleselixir_players (
          gameid TEXT NOT NULL,
          participantid INTEGER NOT NULL,
          side TEXT,
          position TEXT,
          playerid TEXT,
          playername TEXT,
          teamname TEXT,
          champion TEXT,
          date TEXT,
          league TEXT,
          year INTEGER,
          split TEXT,
          playoffs INTEGER,
          patch TEXT,
          gamelength INTEGER,
          result INTEGER,
          kills INTEGER,
          deaths INTEGER,
          assists INTEGER,
          doublekills INTEGER,
          triplekills INTEGER,
          quadrakills INTEGER,
          pentakills INTEGER,
          damagetochampions INTEGER,
          dpm REAL,
          damageshare REAL,
          wardsplaced INTEGER,
          wardskilled INTEGER,
          visionscore REAL,
          vspm REAL,
          totalgold INTEGER,
          earnedgoldshare REAL,
          totalcs INTEGER,
          cspm REAL,
          goldat10 INTEGER,
          xpat10 INTEGER,
          csat10 INTEGER,
          golddiffat10 INTEGER,
          xpdiffat10 INTEGER,
          csdiffat10 INTEGER,
          goldat15 INTEGER,
          xpat15 INTEGER,
          csat15 INTEGER,
          golddiffat15 INTEGER,
          xpdiffat15 INTEGER,
          csdiffat15 INTEGER,
          ingested_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (gameid, participantid)
        );
        CREATE INDEX IF NOT EXISTS idx_oep_player ON oracleselixir_players(playerid, date);
        CREATE INDEX IF NOT EXISTS idx_oep_playername ON oracleselixir_players(playername, date);
        CREATE INDEX IF NOT EXISTS idx_oep_team_pos ON oracleselixir_players(teamname, position, date);
        CREATE INDEX IF NOT EXISTS idx_oep_champion ON oracleselixir_players(champion, patch);
      `);
    },
  },
  {
    // Oracle's Elixir ingest — dados granulares de partida pro profissional LoL.
    // Uma linha por time por game (2 linhas por gameid). Filtrado com position='team'.
    // Cobre §1d (side), §1g (GD@15/XPD@15/CSD@15), §1h (firsts), §1i (obj rates),
    // §1j (KPM/DPM/WPM/damage), §4 (bans/picks), §3a (patch).
    id: '022_oracleselixir_games',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS oracleselixir_games (
          gameid TEXT NOT NULL,
          side TEXT NOT NULL,
          date TEXT,
          league TEXT,
          year INTEGER,
          split TEXT,
          playoffs INTEGER,
          patch TEXT,
          teamid TEXT,
          teamname TEXT,
          gamelength INTEGER,
          result INTEGER,
          kills INTEGER,
          deaths INTEGER,
          firstblood INTEGER,
          team_kpm REAL,
          ckpm REAL,
          firstdragon INTEGER,
          dragons INTEGER,
          firstherald INTEGER,
          heralds INTEGER,
          void_grubs INTEGER,
          firstbaron INTEGER,
          barons INTEGER,
          firsttower INTEGER,
          towers INTEGER,
          inhibitors INTEGER,
          dpm REAL,
          wpm REAL,
          vspm REAL,
          gspd REAL,
          gpr REAL,
          goldat10 INTEGER,
          xpat10 INTEGER,
          csat10 INTEGER,
          golddiffat10 INTEGER,
          xpdiffat10 INTEGER,
          csdiffat10 INTEGER,
          goldat15 INTEGER,
          xpat15 INTEGER,
          csat15 INTEGER,
          golddiffat15 INTEGER,
          xpdiffat15 INTEGER,
          csdiffat15 INTEGER,
          killsat15 INTEGER,
          deathsat15 INTEGER,
          ban1 TEXT, ban2 TEXT, ban3 TEXT, ban4 TEXT, ban5 TEXT,
          pick1 TEXT, pick2 TEXT, pick3 TEXT, pick4 TEXT, pick5 TEXT,
          ingested_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (gameid, side)
        );
        CREATE INDEX IF NOT EXISTS idx_oe_team_date ON oracleselixir_games(teamname, date);
        CREATE INDEX IF NOT EXISTS idx_oe_league_date ON oracleselixir_games(league, date);
        CREATE INDEX IF NOT EXISTS idx_oe_patch ON oracleselixir_games(patch);
        CREATE INDEX IF NOT EXISTS idx_oe_year_split ON oracleselixir_games(year, split);
      `);
    },
  },
  {
    // Shadow log pra market tips (handicap, total, ace etc). Acumula detecções
    // sem DM — permite backtest retrospectivo de ROI/CLV por market_type.
    id: '024_market_tips_shadow',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS market_tips_shadow (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sport TEXT NOT NULL,
          match_key TEXT NOT NULL,
          team1 TEXT,
          team2 TEXT,
          league TEXT,
          best_of INTEGER,
          market TEXT NOT NULL,
          line REAL,
          side TEXT,
          label TEXT,
          p_model REAL,
          p_implied REAL,
          odd REAL,
          ev_pct REAL,
          stake_units REAL,
          created_at TEXT DEFAULT (datetime('now')),
          settled_at TEXT,
          result TEXT,
          profit_units REAL,
          meta_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_mt_shadow_sport_created ON market_tips_shadow(sport, created_at);
        CREATE INDEX IF NOT EXISTS idx_mt_shadow_match ON market_tips_shadow(match_key, market, line, side);
        CREATE INDEX IF NOT EXISTS idx_mt_shadow_unsettled ON market_tips_shadow(result, created_at) WHERE result IS NULL;
      `);
    },
  },
  {
    id: '025_market_tips_shadow_admin_dm',
    up(db) {
      if (!tableExists(db, 'market_tips_shadow')) return;
      addColumnIfMissing(db, 'market_tips_shadow', 'admin_dm_sent_at', 'admin_dm_sent_at TEXT');
      db.exec(`CREATE INDEX IF NOT EXISTS idx_mt_shadow_admin_dm ON market_tips_shadow(match_key, market, line, side, admin_dm_sent_at);`);
    },
  },
  {
    id: '026_market_tips_shadow_clv',
    up(db) {
      if (!tableExists(db, 'market_tips_shadow')) return;
      addColumnIfMissing(db, 'market_tips_shadow', 'close_odd', 'close_odd REAL');
      addColumnIfMissing(db, 'market_tips_shadow', 'clv_pct', 'clv_pct REAL');
      addColumnIfMissing(db, 'market_tips_shadow', 'close_captured_at', 'close_captured_at TEXT');
    },
  },
  {
    id: '027_tennis_match_stats',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tennis_match_stats (
          match_id TEXT PRIMARY KEY,
          tour TEXT,
          player1 TEXT,
          player2 TEXT,
          winner TEXT,
          date TEXT,
          surface TEXT,
          tourney_name TEXT,
          best_of INTEGER,
          round TEXT,
          minutes INTEGER,
          p1_ace INTEGER, p1_df INTEGER, p1_svpt INTEGER, p1_1st_in INTEGER, p1_1st_won INTEGER, p1_2nd_won INTEGER, p1_sv_gms INTEGER, p1_bp_saved INTEGER, p1_bp_faced INTEGER,
          p2_ace INTEGER, p2_df INTEGER, p2_svpt INTEGER, p2_1st_in INTEGER, p2_1st_won INTEGER, p2_2nd_won INTEGER, p2_sv_gms INTEGER, p2_bp_saved INTEGER, p2_bp_faced INTEGER,
          p1_rank INTEGER, p2_rank INTEGER,
          score TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tennis_stats_p1_date ON tennis_match_stats(player1, date);
        CREATE INDEX IF NOT EXISTS idx_tennis_stats_p2_date ON tennis_match_stats(player2, date);
        CREATE INDEX IF NOT EXISTS idx_tennis_stats_date ON tennis_match_stats(date);
      `);
    },
  },
  {
    id: '029_dota_hero_stats_extend',
    up(db) {
      // Table já existe de versão anterior — adiciona columns faltantes + index.
      if (!tableExists(db, 'dota_hero_stats')) {
        db.exec(`
          CREATE TABLE dota_hero_stats (
            hero_id INTEGER PRIMARY KEY,
            localized_name TEXT,
            primary_attr TEXT,
            roles TEXT,
            pub_pick INTEGER DEFAULT 0,
            pub_win  INTEGER DEFAULT 0,
            pub_winrate REAL,
            pro_pick INTEGER DEFAULT 0,
            pro_win  INTEGER DEFAULT 0,
            pro_ban  INTEGER DEFAULT 0,
            pro_winrate REAL,
            pro_pickban_rate REAL,
            updated_at TEXT DEFAULT (datetime('now'))
          );
        `);
      }
      addColumnIfMissing(db, 'dota_hero_stats', 'attack_type', 'attack_type TEXT');
      addColumnIfMissing(db, 'dota_hero_stats', 'source', "source TEXT DEFAULT 'opendota'");
      db.exec(`CREATE INDEX IF NOT EXISTS idx_dota_hero_stats_name ON dota_hero_stats(localized_name);`);
    },
  },
  {
    id: '028_tips_archived_flag',
    up(db) {
      if (!tableExists(db, 'tips')) return;
      addColumnIfMissing(db, 'tips', 'archived', 'archived INTEGER DEFAULT 0');
      // Tips até 2026-04-16 são "contaminadas" (bugs de dedup/Kelly/dados antigos).
      // Marca como arquivadas pra não poluírem dashboard/ROI/métricas.
      db.prepare(`UPDATE tips SET archived = 1 WHERE date(sent_at) <= '2026-04-16'`).run();
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tips_archived_sport ON tips(archived, sport);`);
    },
  },
  {
    id: '029_dota_team_rosters',
    up(db) {
      // Observa account_ids de cada time Dota via /opendota-live.
      // Permite detectar stand-in quando ≥2 dos 5 account_ids não batem com os mais frequentes.
      db.exec(`
        CREATE TABLE IF NOT EXISTS dota_team_rosters (
          team_key TEXT NOT NULL,
          account_id INTEGER NOT NULL,
          games_count INTEGER NOT NULL DEFAULT 1,
          first_seen TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (team_key, account_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dtr_team ON dota_team_rosters(team_key, games_count DESC);
      `);
    },
  },
  {
    id: '030_league_blocks',
    up(db) {
      // Tabela de bloqueios de liga (auto ou manual). /record-tip consulta antes de
      // aceitar tip; bleed-scanner insere automaticamente quando ROI<-15% n≥20.
      db.exec(`
        CREATE TABLE IF NOT EXISTS league_blocks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sport TEXT NOT NULL,
          league TEXT NOT NULL,
          reason TEXT,
          threshold_details TEXT,
          blocked_at TEXT NOT NULL DEFAULT (datetime('now')),
          unblocked_at TEXT,
          auto INTEGER NOT NULL DEFAULT 1
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_league_blocks_active
          ON league_blocks(sport, league) WHERE unblocked_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_league_blocks_history
          ON league_blocks(sport, league, blocked_at DESC);
      `);
    },
  },
  {
    id: '032_threshold_adjustments',
    up(db) {
      // Auditoria de ajustes dinâmicos de threshold (EV_min per sport etc) + tabela
      // dynamic_thresholds(sport, key) → value para /record-tip consultar.
      db.exec(`
        CREATE TABLE IF NOT EXISTS dynamic_thresholds (
          sport TEXT NOT NULL,
          key TEXT NOT NULL,
          value REAL NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_by TEXT,
          PRIMARY KEY (sport, key)
        );
        CREATE TABLE IF NOT EXISTS threshold_adjustments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sport TEXT NOT NULL,
          key TEXT NOT NULL,
          prev_value REAL,
          new_value REAL NOT NULL,
          reason TEXT,
          details TEXT,
          applied_at TEXT NOT NULL DEFAULT (datetime('now')),
          auto INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_threshold_adj_history ON threshold_adjustments(sport, key, applied_at DESC);
      `);
    },
  },
  {
    id: '033_split_esports_bankroll_lol_dota',
    up(db) {
      // Pós-split LoL/Dota (Abr/2026): se ambos lol e dota2 já foram seeded com
      // valores default independentes (R$100 cada) ao lado de esports legado, o total
      // fica inflado (esports+lol+dota2 = R$300). Divide esports ao meio nos novos
      // buckets e zera a row esports — tips com sport='esports' ficam no DB (histórico
      // preservado) mas não contam mais pra banca.
      const esp = db.prepare("SELECT initial_banca, current_banca FROM bankroll WHERE sport='esports'").get();
      const lol = db.prepare("SELECT initial_banca FROM bankroll WHERE sport='lol'").get();
      const dota = db.prepare("SELECT initial_banca FROM bankroll WHERE sport='dota2'").get();
      // Safety: só executa quando as 3 rows existem E esports tem valor positivo.
      // Fresh installs ou setups customizados (lol/dota2 já ajustados manualmente) não
      // são afetados — a migration aborta sem alteração.
      if (!esp || !lol || !dota) return;
      const espInit = Number(esp.initial_banca) || 0;
      if (espInit <= 0) return;
      const espCurr = Number(esp.current_banca) || espInit;
      const initHalf = espInit / 2;
      const currHalf = espCurr / 2;
      db.prepare("UPDATE bankroll SET initial_banca=?, current_banca=?, updated_at=datetime('now') WHERE sport='lol'").run(initHalf, currHalf);
      db.prepare("UPDATE bankroll SET initial_banca=?, current_banca=?, updated_at=datetime('now') WHERE sport='dota2'").run(initHalf, currHalf);
      db.prepare("UPDATE bankroll SET initial_banca=0, current_banca=0, updated_at=datetime('now') WHERE sport='esports'").run();
    },
  },
  {
    id: '034_bump_lol_dota_bankroll_min',
    up(db) {
      // Post-split (033): lol/dota2 ficaram com R$50 cada (metade de esports=R$100).
      // Banca <R$100 = thresholds "small" (BLOCK 45%/SHADOW 28%) mas 1 loss de 2u já
      // gera ~36% DD. Bumping pra min R$150 cada: sai de "small", usa thresholds big
      // (BLOCK 35%/SHADOW 20%/REVIEW 12%) compatíveis com variance real.
      // Preserve cumulative profit adicionando delta a ambos initial e current.
      const MIN_INITIAL = 150;
      for (const sport of ['lol', 'dota2']) {
        const r = db.prepare('SELECT initial_banca, current_banca FROM bankroll WHERE sport=?').get(sport);
        if (!r) continue;
        const currentInit = Number(r.initial_banca) || 0;
        if (currentInit >= MIN_INITIAL) continue;
        const delta = MIN_INITIAL - currentInit;
        const newCurrent = Number(r.current_banca || 0) + delta;
        db.prepare("UPDATE bankroll SET initial_banca=?, current_banca=?, updated_at=datetime('now') WHERE sport=?").run(MIN_INITIAL, newCurrent, sport);
      }
    },
  },
  {
    id: '035_rebuild_tip_reais_baseline_uv',
    up(db) {
      // Pre-034 settlement usava bk.current_banca/100 como unit_value (drifting por DD).
      // Agora usamos baseline global (R$9 pra baseline R$900). Rebuild stake_reais/
      // profit_reais pra todas tips settadas usando unit_value canônico — alinha stored
      // values com o que /overall-summary, /roi, guardian recomputam on-the-fly.
      // Depois sync bankroll.current_banca via SUM(profit_reais) por sport.
      const blRow = db.prepare("SELECT value FROM settings WHERE key = 'baseline'").get();
      let uv = 9; // fallback se settings vazio
      if (blRow?.value) {
        try {
          const parsed = JSON.parse(blRow.value);
          const amount = Number(parsed.amount || 0);
          const unitPct = Number(parsed.unit_pct || 1);
          if (amount > 0 && unitPct > 0) uv = (amount * unitPct) / 100 / 100;
          if (!uv || uv <= 0) uv = 9;
        } catch (_) {}
      }
      const tips = db.prepare(`
        SELECT id, stake, odds, result FROM tips
        WHERE result IN ('win','loss','push','void')
          AND (archived IS NULL OR archived = 0)
      `).all();
      const stmt = db.prepare(`UPDATE tips SET stake_reais = ?, profit_reais = ? WHERE id = ?`);
      for (const t of tips) {
        const stakeU = parseFloat(String(t.stake || '0').replace(/u/i, '')) || 0;
        if (!stakeU) continue;
        const odds = parseFloat(t.odds) || 1;
        const newStakeR = +(stakeU * uv).toFixed(2);
        let newProfitR = 0;
        if (t.result === 'win') newProfitR = +(stakeU * (odds - 1) * uv).toFixed(2);
        else if (t.result === 'loss') newProfitR = +(-stakeU * uv).toFixed(2);
        stmt.run(newStakeR, newProfitR, t.id);
      }
      // Resync bankroll.current_banca por sport
      const sports = db.prepare(`SELECT sport, initial_banca FROM bankroll`).all();
      for (const bk of sports) {
        const p = db.prepare(`SELECT COALESCE(SUM(profit_reais), 0) AS p FROM tips WHERE sport=? AND result IN ('win','loss','push','void') AND (archived IS NULL OR archived = 0)`).get(bk.sport);
        const newCurrent = +(Number(bk.initial_banca || 0) + Number(p?.p || 0)).toFixed(2);
        db.prepare("UPDATE bankroll SET current_banca=?, updated_at=datetime('now') WHERE sport=?").run(newCurrent, bk.sport);
      }
    },
  },
  {
    id: '036_resync_bankroll_with_esports_reclassify',
    up(db) {
      // 035 syncou via SUM(profit WHERE sport=bk.sport) — tips legadas sport='esports'
      // (que são LoL/Dota historicamente) ficaram órfãs. Aqui reclassifica por
      // match_id/event_name e distribui nos buckets lol/dota2 corretos.
      const allSettled = db.prepare(`
        SELECT sport, profit_reais, match_id, event_name FROM tips
        WHERE (archived IS NULL OR archived = 0) AND COALESCE(is_shadow, 0) = 0
          AND result IN ('win','loss','push','void')
      `).all();
      const profitBySport = {};
      for (const t of allSettled) {
        const p = Number(t.profit_reais || 0);
        let sp = t.sport;
        if (sp === 'esports') {
          const mid = String(t.match_id || '');
          const ev = String(t.event_name || '').toLowerCase();
          sp = (mid.startsWith('dota2_') || ev.includes('dota')) ? 'dota2' : 'lol';
        }
        profitBySport[sp] = (profitBySport[sp] || 0) + p;
      }
      const rows = db.prepare('SELECT sport, initial_banca FROM bankroll').all();
      for (const bk of rows) {
        const init = Number(bk.initial_banca || 0);
        const profit = profitBySport[bk.sport] || 0;
        const newCurrent = +(init + profit).toFixed(2);
        db.prepare("UPDATE bankroll SET current_banca=?, updated_at=datetime('now') WHERE sport=?").run(newCurrent, bk.sport);
      }
    },
  },
  {
    id: '037_revert_lol_dota_bankroll_bump',
    up(db) {
      // Migration 034 bumpou lol/dota2 initial pra R$150 (+R$100 delta) e somou R$100
      // em current_banca — isso mascarava o prejuízo real. Dashboard mostrava
      // banca crescendo quando performance dos bots foi negativa.
      //
      // Revert: volta lol/dota2 pra initial R$50 (post-033, metade de esports legado).
      // Current_banca recomputa via initial + SUM(profit_reclassificado) — reflete
      // resultado verdadeiro (pode ser negativo se perdas excedem allocation original).
      //
      // Trade-off: lol/dota2 voltam pra "banca pequena" no guardian (thresholds frouxos).
      // Se user quiser mais buffer, deposita via /split-bankroll 300 confirm.
      const allSettled = db.prepare(`
        SELECT sport, profit_reais, match_id, event_name FROM tips
        WHERE (archived IS NULL OR archived = 0) AND COALESCE(is_shadow, 0) = 0
          AND result IN ('win','loss','push','void')
      `).all();
      const profitBySport = {};
      for (const t of allSettled) {
        const p = Number(t.profit_reais || 0);
        let sp = t.sport;
        if (sp === 'esports') {
          const mid = String(t.match_id || '');
          const ev = String(t.event_name || '').toLowerCase();
          sp = (mid.startsWith('dota2_') || ev.includes('dota')) ? 'dota2' : 'lol';
        }
        profitBySport[sp] = (profitBySport[sp] || 0) + p;
      }
      const REVERTED_INITIAL = 50;
      for (const sport of ['lol', 'dota2']) {
        const profit = profitBySport[sport] || 0;
        const newCurrent = +(REVERTED_INITIAL + profit).toFixed(2);
        db.prepare("UPDATE bankroll SET initial_banca=?, current_banca=?, updated_at=datetime('now') WHERE sport=?").run(REVERTED_INITIAL, newCurrent, sport);
      }
    },
  },
  {
    id: '038_final_full_rebuild_alignment',
    up(db) {
      // Rebuild final (belt-and-suspenders) pra garantir alinhamento total pós-037:
      // 1. Recomputa stake_reais/profit_reais com baseline.unit_value global (canônico)
      // 2. Reclassifica esports→lol/dota2 no profitBySport
      // 3. Resync TODAS bankroll.current_banca = initial + profit_reclassificado
      // User pediu "ajuste todas tips liquidadas pra refletir novo bankroll" — aqui fica.
      const blRow = db.prepare("SELECT value FROM settings WHERE key = 'baseline'").get();
      let uv = 9;
      if (blRow?.value) {
        try {
          const parsed = JSON.parse(blRow.value);
          const amount = Number(parsed.amount || 0);
          const unitPct = Number(parsed.unit_pct || 1);
          if (amount > 0 && unitPct > 0) uv = (amount * unitPct) / 100 / 100;
          if (!uv || uv <= 0) uv = 9;
        } catch (_) {}
      }
      // Step 1: rebuild stake_reais/profit_reais
      const tips = db.prepare(`
        SELECT id, stake, odds, result FROM tips
        WHERE result IN ('win','loss','push','void')
          AND (archived IS NULL OR archived = 0)
      `).all();
      const updStmt = db.prepare(`UPDATE tips SET stake_reais = ?, profit_reais = ? WHERE id = ?`);
      for (const t of tips) {
        const stakeU = parseFloat(String(t.stake || '0').replace(/u/i, '')) || 0;
        if (!stakeU) continue;
        const odds = parseFloat(t.odds) || 1;
        const newStakeR = +(stakeU * uv).toFixed(2);
        let newProfitR = 0;
        if (t.result === 'win') newProfitR = +(stakeU * (odds - 1) * uv).toFixed(2);
        else if (t.result === 'loss') newProfitR = +(-stakeU * uv).toFixed(2);
        updStmt.run(newStakeR, newProfitR, t.id);
      }
      // Step 2 + 3: reclassifica esports→lol/dota2 e resync bankroll.current_banca
      const allSettled = db.prepare(`
        SELECT sport, profit_reais, match_id, event_name FROM tips
        WHERE (archived IS NULL OR archived = 0) AND COALESCE(is_shadow, 0) = 0
          AND result IN ('win','loss','push','void')
      `).all();
      const profitBySport = {};
      for (const t of allSettled) {
        const p = Number(t.profit_reais || 0);
        let sp = t.sport;
        if (sp === 'esports') {
          const mid = String(t.match_id || '');
          const ev = String(t.event_name || '').toLowerCase();
          sp = (mid.startsWith('dota2_') || ev.includes('dota')) ? 'dota2' : 'lol';
        }
        profitBySport[sp] = (profitBySport[sp] || 0) + p;
      }
      const bankrolls = db.prepare('SELECT sport, initial_banca FROM bankroll').all();
      for (const bk of bankrolls) {
        const init = Number(bk.initial_banca || 0);
        const profit = profitBySport[bk.sport] || 0;
        const newCurrent = +(init + profit).toFixed(2);
        db.prepare("UPDATE bankroll SET current_banca=?, updated_at=datetime('now') WHERE sport=?").run(newCurrent, bk.sport);
      }
    },
  },
  {
    id: '039_per_sport_unit_model_reset_initial',
    up(db) {
      // Switch pra modelo per-sport unit (Abr/2026-III).
      // Cada sport tem initial_banca = R$100 (1u = R$1 na zona normal ±20%).
      // esports bucket fica em 0 (legacy, não usado pra novas tips).
      const STANDARD_INITIAL = 100;
      const sports = ['lol', 'dota2', 'mma', 'tennis', 'football', 'cs', 'valorant', 'darts', 'snooker', 'tabletennis'];
      for (const sp of sports) {
        const r = db.prepare('SELECT initial_banca FROM bankroll WHERE sport=?').get(sp);
        if (!r) {
          db.prepare("INSERT INTO bankroll (sport, initial_banca, current_banca, updated_at) VALUES (?, ?, ?, datetime('now'))").run(sp, STANDARD_INITIAL, STANDARD_INITIAL);
        } else if (Number(r.initial_banca) !== STANDARD_INITIAL) {
          db.prepare("UPDATE bankroll SET initial_banca=?, updated_at=datetime('now') WHERE sport=?").run(STANDARD_INITIAL, sp);
        }
      }
      // Esports legacy: garante init=0 current=0 (não conta no total)
      db.prepare("UPDATE bankroll SET initial_banca=0, current_banca=0, updated_at=datetime('now') WHERE sport='esports'").run();
    },
  },
  {
    id: '040_rebuild_tips_with_per_sport_unit_tiers',
    up(db) {
      // Rebuild cronológico: pra cada sport, itera tips settled em ordem e
      // recompute stake_reais/profit_reais usando tier unit baseado em ratio
      // runningBanca/initialBanca, atualizando runningBanca após cada tip.
      // Tips legacy sport='esports' são reclassificadas em lol/dota2.
      let getSportUnitValue;
      try {
        ({ getSportUnitValue } = require('../lib/sport-unit'));
      } catch (e) {
        getSportUnitValue = function(current, initial = 100) {
          if (!current || current <= 0) return 0.50;
          const r = current / (initial || 100);
          if (r >= 3.0) return 3.0;
          if (r >= 2.0) return 2.0;
          if (r >= 1.5) return 1.5;
          if (r >= 1.2) return 1.2;
          if (r >= 0.8) return 1.0;
          if (r >= 0.6) return 0.8;
          if (r >= 0.4) return 0.6;
          return 0.5;
        };
      }
      const sports = ['lol', 'dota2', 'mma', 'tennis', 'football', 'cs', 'valorant', 'darts', 'snooker', 'tabletennis'];
      const updStmt = db.prepare(`UPDATE tips SET stake_reais = ?, profit_reais = ? WHERE id = ?`);
      for (const sport of sports) {
        const bk = db.prepare('SELECT initial_banca FROM bankroll WHERE sport=?').get(sport);
        if (!bk) continue;
        const initial = Number(bk.initial_banca) || 100;
        const extraSql = sport === 'dota2'
          ? " OR (sport = 'esports' AND (match_id LIKE 'dota2_%' OR LOWER(COALESCE(event_name,'')) LIKE '%dota%'))"
          : sport === 'lol'
            ? " OR (sport = 'esports' AND match_id NOT LIKE 'dota2_%' AND LOWER(COALESCE(event_name,'')) NOT LIKE '%dota%')"
            : "";
        const sportTips = db.prepare(`
          SELECT id, sport, stake, odds, result, sent_at, settled_at, match_id, event_name
          FROM tips
          WHERE (archived IS NULL OR archived = 0)
            AND COALESCE(is_shadow, 0) = 0
            AND result IN ('win','loss','push','void')
            AND (sport = ?${extraSql})
          ORDER BY COALESCE(settled_at, sent_at) ASC, id ASC
        `).all(sport);
        let runningBanca = initial;
        for (const t of sportTips) {
          const stakeU = parseFloat(String(t.stake || '0').replace(/u/i, '')) || 0;
          if (!stakeU) continue;
          const odds = parseFloat(t.odds) || 1;
          const uv = getSportUnitValue(runningBanca, initial);
          const newStakeR = +(stakeU * uv).toFixed(2);
          let newProfitR = 0;
          if (t.result === 'win')  newProfitR = +(stakeU * (odds - 1) * uv).toFixed(2);
          else if (t.result === 'loss') newProfitR = +(-stakeU * uv).toFixed(2);
          updStmt.run(newStakeR, newProfitR, t.id);
          runningBanca = +(runningBanca + newProfitR).toFixed(2);
        }
        db.prepare("UPDATE bankroll SET current_banca=?, updated_at=datetime('now') WHERE sport=?").run(runningBanca, sport);
      }
    },
  },
  {
    id: '042_archive_fuzzy_duplicates_and_resync',
    up(db) {
      // Após migrations 039/040 rebuild per-sport tier, bankroll sum conta tips
      // duplicadas (legacy sport='esports' match_id='X' + novo sport='dota2' match_id='dota2_X').
      // Dashboard display colapsa via fuzzy dedup JS mas bankroll não → gap entre hero e tips.
      // Fix: arquiva fuzzy dupes no DB (mesma chave teams+odd+stake+date dentro de bucket),
      // depois rerun sync bankroll pra refletir apenas tips ativas.
      const tips = db.prepare(`
        SELECT id, sport, participant1, participant2, tip_participant, odds, stake,
               sent_at, match_id, event_name, result, profit_reais
        FROM tips
        WHERE (archived IS NULL OR archived = 0)
          AND result IN ('win','loss','push','void')
        ORDER BY id ASC
      `).all();
      const normStr = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const bucketFor = (t) => {
        const sp = t.sport;
        if (sp === 'esports' || sp === 'lol' || sp === 'dota2' || sp === 'dota') {
          const mid = String(t.match_id || '');
          const ev = String(t.event_name || '').toLowerCase();
          if (mid.startsWith('dota2_') || ev.includes('dota')) return 'dota2_bucket';
          return 'lol_bucket';
        }
        if (sp === 'mma') return 'mma_bucket';
        return sp;
      };
      const groups = new Map();
      for (const t of tips) {
        const day = String(t.sent_at || '').slice(0, 10);
        const key = [
          bucketFor(t),
          normStr(t.participant1),
          normStr(t.participant2),
          normStr(t.tip_participant),
          String(t.odds || ''),
          String(t.stake || ''),
          day,
        ].join('|');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
      }
      const archStmt = db.prepare(`UPDATE tips SET archived = 1 WHERE id = ?`);
      for (const [, arr] of groups) {
        if (arr.length <= 1) continue;
        arr.sort((a, b) => a.id - b.id);
        const keep = arr[arr.length - 1].id;
        for (const t of arr) {
          if (t.id !== keep) archStmt.run(t.id);
        }
      }

      // Resync bankroll.current_banca usando tips não-archived reclassificadas.
      const liveTips = db.prepare(`
        SELECT sport, profit_reais, match_id, event_name FROM tips
        WHERE (archived IS NULL OR archived = 0) AND COALESCE(is_shadow, 0) = 0
          AND result IN ('win','loss','push','void')
      `).all();
      const profitBySport = {};
      for (const t of liveTips) {
        const p = Number(t.profit_reais || 0);
        let sp = t.sport;
        if (sp === 'esports') {
          const mid = String(t.match_id || '');
          const ev = String(t.event_name || '').toLowerCase();
          sp = (mid.startsWith('dota2_') || ev.includes('dota')) ? 'dota2' : 'lol';
        }
        profitBySport[sp] = (profitBySport[sp] || 0) + p;
      }
      const bankrolls = db.prepare('SELECT sport, initial_banca FROM bankroll').all();
      for (const bk of bankrolls) {
        const init = Number(bk.initial_banca || 0);
        const profit = profitBySport[bk.sport] || 0;
        const newCurrent = +(init + profit).toFixed(2);
        db.prepare("UPDATE bankroll SET current_banca=?, updated_at=datetime('now') WHERE sport=?").run(newCurrent, bk.sport);
      }
    },
  },
  {
    id: '041_sync_baseline_amount_to_sum_initials',
    up(db) {
      // Pós modelo per-sport (039/040): soma de initial_banca dos sports ativos é
      // R$1000 (10 sports × R$100), mas settings.baseline stale em R$900 (de 16/04
      // quando era unit global). Atualiza bankroll_baseline_amount pra sum(initial_banca).
      // Keys separadas — NÃO JSON 'baseline' (getBaseline() lê keys separadas).
      const sumRow = db.prepare(`SELECT COALESCE(SUM(initial_banca), 0) AS total FROM bankroll WHERE sport != 'esports'`).get();
      const newAmount = Number(sumRow?.total || 0);
      if (newAmount <= 0) return;
      db.prepare(`INSERT INTO settings (key, value) VALUES ('bankroll_baseline_amount', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(newAmount));
    },
  },
  {
    id: '043_force_rebuild_per_sport_tier_v2',
    up(db) {
      // Migration 040/042 podem ter rodado em versão antiga ou com bug silencioso
      // (schema_migrations marca applied mesmo se não fez nada útil). Este ID novo
      // força re-execução do rebuild completo + archive dupes + resync bankrolls.
      //
      // Combina 039 (init=100), 040 (rebuild tier), 042 (archive fuzzy), 041 (baseline).
      // Idempotente por natureza: roda cronológico, resultado determinístico.
      let getSportUnitValue;
      try {
        ({ getSportUnitValue } = require('../lib/sport-unit'));
      } catch (e) {
        getSportUnitValue = function(current, initial = 100) {
          if (!current || current <= 0) return 0.50;
          const r = current / (initial || 100);
          if (r >= 3.0) return 3.0;
          if (r >= 2.0) return 2.0;
          if (r >= 1.5) return 1.5;
          if (r >= 1.2) return 1.2;
          if (r >= 0.8) return 1.0;
          if (r >= 0.6) return 0.8;
          if (r >= 0.4) return 0.6;
          return 0.5;
        };
      }

      // Step 1: force initial=R$100 em todos sports ativos, esports=0
      const STANDARD_INITIAL = 100;
      const sports = ['lol', 'dota2', 'mma', 'tennis', 'football', 'cs', 'valorant', 'darts', 'snooker', 'tabletennis'];
      for (const sp of sports) {
        const r = db.prepare('SELECT initial_banca FROM bankroll WHERE sport=?').get(sp);
        if (!r) {
          db.prepare("INSERT INTO bankroll (sport, initial_banca, current_banca, updated_at) VALUES (?, ?, ?, datetime('now'))").run(sp, STANDARD_INITIAL, STANDARD_INITIAL);
        } else {
          db.prepare("UPDATE bankroll SET initial_banca=?, updated_at=datetime('now') WHERE sport=?").run(STANDARD_INITIAL, sp);
        }
      }
      db.prepare("UPDATE bankroll SET initial_banca=0, current_banca=0 WHERE sport='esports'").run();

      // Step 2: archive fuzzy duplicatas ANTES de rebuild (pra rebuild não contar dupes)
      const allTips = db.prepare(`
        SELECT id, sport, participant1, participant2, tip_participant, odds, stake,
               sent_at, match_id, event_name, result
        FROM tips
        WHERE (archived IS NULL OR archived = 0)
          AND result IN ('win','loss','push','void')
        ORDER BY id ASC
      `).all();
      const normStr = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const bucketFor = (t) => {
        const sp = t.sport;
        if (sp === 'esports' || sp === 'lol' || sp === 'dota2' || sp === 'dota') {
          const mid = String(t.match_id || '');
          const ev = String(t.event_name || '').toLowerCase();
          return (mid.startsWith('dota2_') || ev.includes('dota')) ? 'dota2_bucket' : 'lol_bucket';
        }
        if (sp === 'mma') return 'mma_bucket';
        return sp;
      };
      const groups = new Map();
      for (const t of allTips) {
        const day = String(t.sent_at || '').slice(0, 10);
        const key = [bucketFor(t), normStr(t.participant1), normStr(t.participant2), normStr(t.tip_participant), String(t.odds || ''), String(t.stake || ''), day].join('|');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
      }
      const archStmt = db.prepare(`UPDATE tips SET archived = 1 WHERE id = ?`);
      let archivedCount = 0;
      for (const [, arr] of groups) {
        if (arr.length <= 1) continue;
        arr.sort((a, b) => a.id - b.id);
        const keep = arr[arr.length - 1].id;
        for (const t of arr) {
          if (t.id !== keep) { archStmt.run(t.id); archivedCount++; }
        }
      }

      // Step 3: rebuild cronológico stake_reais/profit_reais com tier unit per-sport
      const updStmt = db.prepare(`UPDATE tips SET stake_reais = ?, profit_reais = ? WHERE id = ?`);
      for (const sport of sports) {
        const initial = STANDARD_INITIAL;
        const extraSql = sport === 'dota2'
          ? " OR (sport = 'esports' AND (match_id LIKE 'dota2_%' OR LOWER(COALESCE(event_name,'')) LIKE '%dota%'))"
          : sport === 'lol'
            ? " OR (sport = 'esports' AND match_id NOT LIKE 'dota2_%' AND LOWER(COALESCE(event_name,'')) NOT LIKE '%dota%')"
            : "";
        const sportTips = db.prepare(`
          SELECT id, stake, odds, result FROM tips
          WHERE (archived IS NULL OR archived = 0)
            AND COALESCE(is_shadow, 0) = 0
            AND result IN ('win','loss','push','void')
            AND (sport = ?${extraSql})
          ORDER BY COALESCE(settled_at, sent_at) ASC, id ASC
        `).all(sport);
        let runningBanca = initial;
        for (const t of sportTips) {
          const stakeU = parseFloat(String(t.stake || '0').replace(/u/i, '')) || 0;
          if (!stakeU) continue;
          const odds = parseFloat(t.odds) || 1;
          const uv = getSportUnitValue(runningBanca, initial);
          const newStakeR = +(stakeU * uv).toFixed(2);
          let newProfitR = 0;
          if (t.result === 'win')  newProfitR = +(stakeU * (odds - 1) * uv).toFixed(2);
          else if (t.result === 'loss') newProfitR = +(-stakeU * uv).toFixed(2);
          updStmt.run(newStakeR, newProfitR, t.id);
          runningBanca = +(runningBanca + newProfitR).toFixed(2);
        }
        db.prepare("UPDATE bankroll SET current_banca=?, updated_at=datetime('now') WHERE sport=?").run(runningBanca, sport);
      }

      // Step 4: update settings baseline amount = SUM(initial_banca) ativos.
      // IMPORTANT: getBaseline() lê keys separadas ('bankroll_baseline_amount', etc),
      // não JSON 'baseline'. Migration 041 tinha bug escrevendo no key errado.
      const sumRow = db.prepare(`SELECT COALESCE(SUM(initial_banca), 0) AS total FROM bankroll WHERE sport != 'esports'`).get();
      const newAmount = Number(sumRow?.total || 0);
      if (newAmount > 0) {
        db.prepare(`INSERT INTO settings (key, value) VALUES ('bankroll_baseline_amount', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(newAmount));
        db.prepare(`INSERT INTO settings (key, value) VALUES ('bankroll_unit_pct', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
        // Date: mantém se já existe, senão seta hoje.
        const existingDate = db.prepare(`SELECT value FROM settings WHERE key = 'bankroll_baseline_date'`).get();
        if (!existingDate?.value) {
          db.prepare(`INSERT INTO settings (key, value) VALUES ('bankroll_baseline_date', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(new Date().toISOString().slice(0, 10));
        }
      }
    },
  },
  {
    id: '044_fix_baseline_settings_key',
    up(db) {
      // Migrations 041/043 escreviam baseline em key 'baseline' (JSON) mas getBaseline()
      // lê de 'bankroll_baseline_amount' (key separada). Bug silencioso — baseline R$900
      // ficou stale. Este migration sincroniza.
      const sumRow = db.prepare(`SELECT COALESCE(SUM(initial_banca), 0) AS total FROM bankroll WHERE sport != 'esports'`).get();
      const newAmount = Number(sumRow?.total || 0);
      if (newAmount > 0) {
        db.prepare(`INSERT INTO settings (key, value) VALUES ('bankroll_baseline_amount', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(newAmount));
      }
      // Cleanup: remove key 'baseline' JSON legacy se existir (não usada).
      db.prepare(`DELETE FROM settings WHERE key = 'baseline'`).run();
    },
  },
  {
    id: '045_league_blocklist_persistence',
    up(db) {
      // Persistência do league blocklist (antes runtime-only em bot.js _leagueBlocklist).
      // Bot.js lê no startup → reconstitui Set + Map; escreve em cada mutação (block/unblock/auto).
      // Server.js lê pra expor endpoint /league-blocklist (dashboard consumo).
      db.exec(`
        CREATE TABLE IF NOT EXISTS league_blocklist (
          entry TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          reason TEXT,
          roi_pct REAL,
          clv_pct REAL,
          n_tips INTEGER,
          created_at INTEGER NOT NULL,
          cooldown_until INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_league_blocklist_source ON league_blocklist(source);
      `);
    },
  },
  {
    id: '046_dota_team_stats',
    up(db) {
      // Dota2 pro team aggregate stats via OpenDota /api/teams.
      // Populado por scripts/sync-opendota-team-stats.js (cron diário).
      // Consumido por extract-esports-features.js quando GAME=dota2 → adiciona
      //   {rating_diff, wr_diff, games_diff, has_team_stats} ao training.
      db.exec(`
        CREATE TABLE IF NOT EXISTS dota_team_stats (
          team_id INTEGER PRIMARY KEY,
          name TEXT,
          tag TEXT,
          rating REAL,
          wins INTEGER DEFAULT 0,
          losses INTEGER DEFAULT 0,
          wr REAL,
          last_match_time INTEGER,
          updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_dota_team_name ON dota_team_stats(LOWER(name));
        CREATE INDEX IF NOT EXISTS idx_dota_team_tag ON dota_team_stats(LOWER(tag));
      `);
    },
  },
  {
    id: '047_tips_current_stake',
    up(db) {
      // Adiciona tips.current_stake (era ALTER TABLE inline em server.js que não
      // rodava em contextos que só chamam migrations, crashando initDatabase).
      try { db.exec("ALTER TABLE tips ADD COLUMN current_stake TEXT"); } catch (_) { /* já existe */ }
    },
  },
  {
    id: '050_market_tips_runtime_state',
    up(db) {
      // Runtime overrides pra market tips DM. Quando shadow detecta leak
      // (CLV<cutoff + n≥cutoff), auto-insere entry pra DESATIVAR o DM real
      // mesmo que SPORT_MARKET_TIPS_ENABLED=true.
      // Auto-remove quando CLV recupera ≥0%.
      db.exec(`
        CREATE TABLE IF NOT EXISTS market_tips_runtime_state (
          sport TEXT NOT NULL,
          market TEXT NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0,
          source TEXT,           -- 'auto_clv_leak' | 'manual'
          reason TEXT,
          clv_pct REAL,
          clv_n INTEGER,
          roi_pct REAL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (sport, market)
        );
      `);
    },
  },
  {
    id: '049_cs_team_stats',
    up(db) {
      // CS2 pro team aggregate stats via HLTV scraping (lib/hltv.js + HLTV_PROXY_BASE).
      // Populado por scripts/sync-hltv-cs-teams.js (cron diário).
      // Consumido por extract-esports-features.js quando GAME='cs' → adiciona
      //   cs_rank_diff, cs_points_diff, cs_recent_wr_diff, cs_streak_diff,
      //   cs_days_idle_diff, has_cs_team_stats ao training.
      db.exec(`
        CREATE TABLE IF NOT EXISTS cs_team_stats (
          team_id INTEGER PRIMARY KEY,
          name TEXT,
          slug TEXT,
          ranking INTEGER,                -- HLTV global rank (lower = better)
          ranking_points INTEGER,
          recent_n INTEGER DEFAULT 0,
          recent_wr REAL,
          win_streak_current INTEGER DEFAULT 0,
          last_match_date INTEGER,        -- unix timestamp
          updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cs_team_name ON cs_team_stats(LOWER(name));
        CREATE INDEX IF NOT EXISTS idx_cs_team_slug ON cs_team_stats(slug);
        CREATE INDEX IF NOT EXISTS idx_cs_team_ranking ON cs_team_stats(ranking);
      `);
    },
  },
  {
    id: '048_dota_team_rolling_stats',
    up(db) {
      // Extende dota_team_stats com rolling aggregates 30d via /api/teams/{id}/matches.
      // Features orthogonais ao Elo: kill_margin, duration, recent_form, streak, days_idle.
      // Populado por scripts/sync-opendota-team-stats.js --deep flag.
      const cols = [
        "recent_n INTEGER DEFAULT 0",           // matches contabilizados (last 30d)
        "recent_wr REAL",                        // WR últimos 30d
        "avg_kill_margin REAL",                  // team_score - opp_score avg
        "avg_duration_sec REAL",                 // match length avg
        "win_streak_current INTEGER DEFAULT 0",  // +N wins, -N losses em série atual
        "days_since_last INTEGER",               // dias desde último match
      ];
      for (const col of cols) {
        try { db.exec(`ALTER TABLE dota_team_stats ADD COLUMN ${col}`); } catch (_) { /* já existe */ }
      }
    },
  },
  {
    id: '051_market_tips_runtime_state_side',
    up(db) {
      // Adiciona coluna `side` pra granularidade do mt-guard — permite desabilitar
      // apenas (market, side) específico em vez do market inteiro.
      // Ex: handicapSets|away com ROI -13.5% desabilitado, mas handicapSets|home
      // com ROI +48.8% continua ativo.
      try { db.exec("ALTER TABLE market_tips_runtime_state ADD COLUMN side TEXT"); } catch (_) { /* já existe */ }
      // PRIMARY KEY antigo era (sport, market) — insert com side=NULL duplicado falhava.
      // Deixar como está: queries distinguem via `side IS NULL` e `INSERT OR REPLACE`
      // usa row_id implicit quando há conflito. Pra ficar robusto, cria índice único:
      try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_mt_runtime_sport_market_side ON market_tips_runtime_state(sport, market, COALESCE(side, ''))"); } catch (_) {}
    },
  },
  {
    id: '052_odds_bucket_blocklist',
    up(db) {
      // Persistência do auto-guard de bucket de odds. Espelha league_blocklist:
      //   entry = "sport:MIN-MAX" (ex: "lol:3.00-99.00") ou "*:MIN-MAX" (cross-sport)
      //   source: 'auto' | 'manual' | 'env' | 'cooldown'
      // Avaliado em runOddsBucketGuardCycle (12h cron). DM admin em block/restore.
      db.exec(`
        CREATE TABLE IF NOT EXISTS odds_bucket_blocklist (
          entry TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          reason TEXT,
          roi_pct REAL,
          clv_pct REAL,
          n_tips INTEGER,
          created_at INTEGER NOT NULL,
          cooldown_until INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_odds_bucket_source ON odds_bucket_blocklist(source);
      `);
    },
  },
  {
    id: '053_gates_runtime_state_and_epoch',
    up(db) {
      // Auto-tune persistence pra pre-match EV bonus + max stake cap. Mesmo
      // shape do league/bucket blocklist (auto + manual). runGatesAutoTuneCycle
      // popula via cron 12h.
      db.exec(`
        CREATE TABLE IF NOT EXISTS gates_runtime_state (
          sport TEXT NOT NULL,
          gate_key TEXT NOT NULL,
          value REAL NOT NULL,
          source TEXT NOT NULL,
          reason TEXT,
          evidence TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (sport, gate_key)
        );
      `);
      // Epoch tracking — captura git SHA + snapshot de env vars relevantes
      // no momento do insert pra permitir filtro por regime sem mistura.
      try { db.exec("ALTER TABLE tips ADD COLUMN code_sha TEXT"); } catch (_) {}
      try { db.exec("ALTER TABLE tips ADD COLUMN gate_state TEXT"); } catch (_) {}
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_tips_code_sha ON tips(code_sha)"); } catch (_) {}
    },
  },
  {
    id: '054_mt_shadow_is_live_and_stake_backfill',
    up(db) {
      if (!tableExists(db, 'market_tips_shadow')) return;
      // is_live flag — caller passa quando match já está live no momento da scan.
      // Permite separar performance pre-match vs in-play (regimes diferentes).
      addColumnIfMissing(db, 'market_tips_shadow', 'is_live', 'is_live INTEGER DEFAULT 0');
      // Backfill stake_units NULL com Kelly fracionário. Histórico tem 100% NULL
      // em LoL/Dota/CS/Tennis (callers não passavam stakeUnits). ROI atual usa
      // COALESCE(stake_units, 1) = flat 1u, perdendo visibilidade Kelly-weighted.
      // Mesma fórmula de _defaultKellyStake (frac 0.10, cap 2u, bankroll 100u).
      const rows = db.prepare(`
        SELECT id, p_model, odd FROM market_tips_shadow
        WHERE stake_units IS NULL AND p_model IS NOT NULL AND odd IS NOT NULL AND odd > 1
      `).all();
      const upd = db.prepare('UPDATE market_tips_shadow SET stake_units = ? WHERE id = ?');
      let updated = 0;
      for (const r of rows) {
        const p = Number(r.p_model);
        const o = Number(r.odd);
        if (!Number.isFinite(p) || !Number.isFinite(o) || p <= 0 || o <= 1) continue;
        const b = o - 1;
        const fullKelly = (p * b - (1 - p)) / b;
        if (fullKelly <= 0) continue;
        let units = fullKelly * 0.10 * 100;
        if (units > 2) units = 2;
        upd.run(+units.toFixed(2), r.id);
        updated++;
      }
      // Recompute profit_units pra rows já settled (result win/loss) com novo stake.
      // Sem isso, stake muda mas profit fica fixo no flat 1u original.
      const settled = db.prepare(`
        SELECT id, odd, result, stake_units FROM market_tips_shadow
        WHERE result IN ('win','loss') AND stake_units IS NOT NULL
      `).all();
      const updProfit = db.prepare('UPDATE market_tips_shadow SET profit_units = ? WHERE id = ?');
      let profUpdated = 0;
      for (const r of settled) {
        const stake = Number(r.stake_units);
        const odd = Number(r.odd);
        if (!Number.isFinite(stake) || !Number.isFinite(odd) || stake <= 0) continue;
        const newProfit = r.result === 'win' ? +(stake * (odd - 1)).toFixed(2) : -stake;
        updProfit.run(newProfit, r.id);
        profUpdated++;
      }
      try { console.log(`[migrate 054] backfill stake_units: ${updated} rows, recompute profit: ${profUpdated} rows`); } catch (_) {}
    },
  },
  {
    id: '055_mt_shadow_model_version',
    up(db) {
      if (!tableExists(db, 'market_tips_shadow')) return;
      // model_version — identifica a geração do modelo/scanner que emitiu a tip.
      // Permite análise retrospectiva sem ambiguidade entre versões (ex: bug de
      // games vs sets handicap pré-fix vs pós-fix).
      //
      // Convenção: 'vN_short_description', ex:
      //   v1_pre_virtual_matchup_fix  — tips emitidas antes de 2026-04-23 (bug handicapSets)
      //   v2_virtual_matchup_fix      — tips pós fix heurística Pinnacle virtuais
      addColumnIfMissing(db, 'market_tips_shadow', 'model_version', 'model_version TEXT DEFAULT NULL');

      // Backfill tips históricas com 'v1_pre_virtual_matchup_fix' — tudo que
      // foi emitido antes da coluna existir é pré-fix.
      const updated = db.prepare(`
        UPDATE market_tips_shadow
        SET model_version = 'v1_pre_virtual_matchup_fix'
        WHERE model_version IS NULL
      `).run();
      try { console.log(`[migrate 055] backfill model_version: ${updated.changes} rows marked v1_pre_virtual_matchup_fix`); } catch (_) {}
    },
  },
  {
    id: '056_bookmaker_delta_samples',
    up(db) {
      // Coleta amostras manuais de odds (Pinnacle vs casa BR) pra calcular delta
      // histórico médio por (sport, bookmaker). Usado em line shopping pra estimar
      // best odd em casas BR sem scraping (reduz ROI sub-bet quando user aposta
      // em casa BR mas EV foi calculado com odd Pinnacle).
      //
      // Coleta via cmd Telegram /odd-sample <sport> <casa> <pinnacle> <br_odd>.
      // Agregado em /admin/bookmaker-deltas.
      db.exec(`
        CREATE TABLE IF NOT EXISTS bookmaker_delta_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sport TEXT NOT NULL,
          bookmaker TEXT NOT NULL,
          pinnacle_odd REAL NOT NULL,
          br_odd REAL NOT NULL,
          delta_pct REAL NOT NULL,
          match_label TEXT,
          captured_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_bookmaker_delta_sport_book
          ON bookmaker_delta_samples (sport, bookmaker);
        CREATE INDEX IF NOT EXISTS idx_bookmaker_delta_captured
          ON bookmaker_delta_samples (captured_at DESC);
      `);
    },
  },
  {
    id: '057_stale_line_events',
    up(db) {
      // Stale line detector: registra quando Pinnacle moveu >threshold mas
      // outra casa (geralmente BR) ainda está com odd antiga = oportunidade.
      // Usado pra alertar admin que tem janela de ~5-15min pra apostar
      // no lado favorecido com odd defasada.
      db.exec(`
        CREATE TABLE IF NOT EXISTS stale_line_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sport TEXT NOT NULL,
          match_label TEXT,
          pick_side TEXT,
          pin_old REAL,
          pin_new REAL,
          pin_delta_pct REAL,
          br_book TEXT,
          br_odd REAL,
          br_implied_delta_pct REAL,
          detected_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_stale_line_sport_at
          ON stale_line_events (sport, detected_at DESC);
      `);
    },
  },
  {
    id: '058_super_odd_events',
    up(db) {
      // Super-odd detector: registra quando casa não-Pinnacle tem odd
      // >threshold% acima de Pinnacle (default 20%). Sinais:
      //   - Super odd promocional (Betano/Sportingbet rodam diariamente)
      //   - Erro de book (odd esquecida pós-movimentação)
      //   - Pre-news edge (info não incorporada ainda)
      // Em todos casos, oportunidade de EV+ quando bate threshold + tip do bot.
      db.exec(`
        CREATE TABLE IF NOT EXISTS super_odd_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sport TEXT NOT NULL,
          match_label TEXT,
          pick_side TEXT,
          pinnacle_odd REAL NOT NULL,
          pinnacle_implied_pct REAL,
          super_book TEXT NOT NULL,
          super_odd REAL NOT NULL,
          ratio REAL NOT NULL,
          ev_pct_estimated REAL,
          detected_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_super_odd_sport_at
          ON super_odd_events (sport, detected_at DESC);
      `);
    },
  },
  {
    id: '060_velocity_events',
    up(db) {
      // Velocity tracker persistência: registra movimentos rápidos
      // Pinnacle (>3%/5min default = sharp money). Antes era só em-memória.
      db.exec(`
        CREATE TABLE IF NOT EXISTS velocity_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sport TEXT NOT NULL,
          match_label TEXT,
          pick_side TEXT,
          old_odd REAL NOT NULL,
          new_odd REAL NOT NULL,
          velocity_pct REAL NOT NULL,
          window_min INTEGER NOT NULL,
          direction TEXT NOT NULL,
          detected_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_velocity_sport_at
          ON velocity_events (sport, detected_at DESC);
      `);
    },
  },
  {
    id: '059_arb_events',
    up(db) {
      // Cross-book arbitrage detector: registra quando soma das implied
      // probabilities entre 2 books diferentes < 1 (= margin negativa)
      // → ganho mecânico travado independente de quem vence.
      // Casas BR às vezes desalinham com Pinnacle/Bet365 EU criando arbs
      // de 0.5-2% (raros mas legítimos).
      db.exec(`
        CREATE TABLE IF NOT EXISTS arb_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sport TEXT NOT NULL,
          match_label TEXT,
          market_type TEXT,
          side_a TEXT,
          side_b TEXT,
          odd_a REAL NOT NULL,
          odd_b REAL NOT NULL,
          book_a TEXT NOT NULL,
          book_b TEXT NOT NULL,
          implied_sum REAL NOT NULL,
          arb_pct REAL NOT NULL,
          detected_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_arb_sport_at
          ON arb_events (sport, detected_at DESC);
      `);
    },
  },
  {
    id: '061_book_bug_events',
    up(db) {
      // Book bug finder (intra-book inconsistency): registra quando casa BR
      // tem mercado com bug matemático — implied sum <100% (arb grátis dentro
      // do mesmo book) ou divergência forte BTTS↔OU2.5 que indica mispricing.
      // Diferente de super_odd_events (cross-book outlier vs mediana),
      // bug_events foca em inconsistências INTERNAS do book.
      db.exec(`
        CREATE TABLE IF NOT EXISTS book_bug_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          casa TEXT NOT NULL,
          jogo_id TEXT,
          bug_type TEXT NOT NULL,
          payload_json TEXT,
          detected_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_book_bug_casa_at
          ON book_bug_events (casa, detected_at DESC);
        CREATE INDEX IF NOT EXISTS idx_book_bug_type_at
          ON book_bug_events (bug_type, detected_at DESC);
      `);
    },
  },
  {
    id: '062_market_tip_dm_sent',
    up(db) {
      // Tabela dedicada pra dedup de market-tip DM, independente de market_tips_shadow.
      // Antes o dedup lia admin_dm_sent_at do shadow row — frágil porque UPGRADE,
      // result settlement, void cleanup e race conditions podiam zerar o sinal.
      // Chave: (sport, t1_norm, t2_norm, market, side) — IGNORA line de propósito
      // (model bouncing entre +4.5 / +2.5 no mesmo (market, side) NÃO deve gerar 2 DMs).
      db.exec(`
        CREATE TABLE IF NOT EXISTS market_tip_dm_sent (
          sport TEXT NOT NULL,
          team1_norm TEXT NOT NULL,
          team2_norm TEXT NOT NULL,
          market TEXT NOT NULL,
          side TEXT,
          last_dm_at TEXT NOT NULL,
          last_line REAL,
          last_odd REAL,
          last_ev_pct REAL,
          PRIMARY KEY (sport, team1_norm, team2_norm, market, side)
        );
        CREATE INDEX IF NOT EXISTS idx_mt_dm_sent_at
          ON market_tip_dm_sent (last_dm_at DESC);
      `);
    },
  },
  {
    id: '063_market_tips_runtime_state_league',
    up(db) {
      // Granularidade extra: leak guard agora pode bloquear (sport, market, side, league).
      // Motivo (2026-04-28): ATP Madrid|handicapGames com ROI -23% mas WTA Madrid
      // mesmo (market, side) com ROI +37%. Block global mataria o lado bom.
      // Per-league permite blocking cirúrgico.
      try { db.exec("ALTER TABLE market_tips_runtime_state ADD COLUMN league TEXT"); } catch (_) {}
      // Index único atualizado pra incluir league. SQLite UNIQUE com COALESCE
      // permite múltiplas rows com side=NULL desde que league diferente.
      try { db.exec("DROP INDEX IF EXISTS idx_mt_runtime_sport_market_side"); } catch (_) {}
      try {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mt_runtime_full ON market_tips_runtime_state(
          sport, market, COALESCE(side, ''), COALESCE(league, '')
        )`);
      } catch (_) {}
    },
  },
  {
    id: '069_football_data_csv',
    up(db) {
      // football-data.co.uk: histórico CSV per liga × season com odds
      // open + scores + cards + corners. Free, sem rate limit.
      db.exec(`
        CREATE TABLE IF NOT EXISTS football_data_csv (
          match_id TEXT PRIMARY KEY,
          league TEXT, season TEXT, date TEXT,
          home TEXT, away TEXT,
          fthg INTEGER, ftag INTEGER, ftr TEXT,
          hthg INTEGER, htag INTEGER, htr TEXT,
          home_corners INTEGER, away_corners INTEGER,
          home_yellows INTEGER, away_yellows INTEGER,
          home_reds INTEGER, away_reds INTEGER,
          b365_h REAL, b365_d REAL, b365_a REAL,
          bw_h REAL, bw_d REAL, bw_a REAL,
          ps_h REAL, ps_d REAL, ps_a REAL,
          ingested_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_fd_csv_teams ON football_data_csv(home, away, date);
        CREATE INDEX IF NOT EXISTS idx_fd_csv_league_season ON football_data_csv(league, season);
      `);
    },
  },
  {
    id: '070_football_data_csv_shots',
    up(db) {
      // Add shots cols (HS/AS/HST/AST + ou25 closing odds) pra xG proxy.
      // Usa addColumnIfMissing pra evitar silenciar erros REAIS (ex.: tabela
      // não existe, ou type inválido). Antes era try{ALTER...} catch(_){} —
      // dupe column era silenciado mas erro de schema também.
      if (!tableExists(db, 'football_data_csv')) return;
      const cols = [
        ['home_shots', 'home_shots INTEGER'],
        ['away_shots', 'away_shots INTEGER'],
        ['home_shots_target', 'home_shots_target INTEGER'],
        ['away_shots_target', 'away_shots_target INTEGER'],
        ['ou25_over_close', 'ou25_over_close REAL'],   // P>2.5 (Pinnacle closing over 2.5)
        ['ou25_under_close', 'ou25_under_close REAL'], // P<2.5
        ['ah_line', 'ah_line REAL'],                    // AHCh (Asian Handicap closing line)
      ];
      for (const [name, def] of cols) {
        try { addColumnIfMissing(db, 'football_data_csv', name, def); }
        catch (e) { console.error(`[mig 070] add col ${name} fail:`, e.message); }
      }
    },
  },
  {
    id: '068_valorant_team_stats',
    up(db) {
      // thespike.gg: map win rate + agent composition per team Valorant.
      db.exec(`
        CREATE TABLE IF NOT EXISTS valorant_team_map_stats (
          team_slug TEXT NOT NULL,
          team_id TEXT NOT NULL,
          team_name TEXT,
          map TEXT NOT NULL,
          played INTEGER, won INTEGER, win_rate REAL,
          ingested_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (team_id, map)
        );
        CREATE TABLE IF NOT EXISTS valorant_team_agent_stats (
          team_slug TEXT NOT NULL,
          team_id TEXT NOT NULL,
          team_name TEXT,
          agent TEXT NOT NULL,
          pick_pct REAL, win_rate REAL,
          ingested_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (team_id, agent)
        );
      `);
    },
  },
  {
    id: '067_stratz_hero_matchups',
    up(db) {
      // STRATZ hero matchup table — winrate advantage A vs B.
      // Alimenta dota-hero-features.js getDraftMatchupFactor.
      db.exec(`
        CREATE TABLE IF NOT EXISTS stratz_hero_matchups (
          hero_id INTEGER NOT NULL,
          vs_hero_id INTEGER NOT NULL,
          advantage REAL,
          disadvantage REAL,
          synergy REAL,
          wins_avg REAL,
          ingested_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (hero_id, vs_hero_id)
        );
        CREATE INDEX IF NOT EXISTS idx_stratz_matchups_hero ON stratz_hero_matchups(hero_id);
      `);
    },
  },
  {
    id: '066_tennis_player_serve_stats',
    up(db) {
      // Serve/return stats per player de tennisabstract.com.
      // Alimenta tennis-markov-model com input real (hoje usa empirical Sackmann).
      db.exec(`
        CREATE TABLE IF NOT EXISTS tennis_player_serve_stats (
          player_norm TEXT PRIMARY KEY,
          player_name TEXT,
          slug TEXT,
          first_serve_pct REAL,
          first_serve_win_pct REAL,
          second_serve_win_pct REAL,
          bp_saved_pct REAL,
          sv_games_won_pct REAL,
          rt_games_won_pct REAL,
          ace_pct REAL,
          df_pct REAL,
          source TEXT,
          ingested_at TEXT DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    id: '065_understat_matches',
    up(db) {
      // xG (expected goals) per match das 6 ligas top via understat.com.
      // Alimenta Poisson model de football com λ_xG melhor que goals históricos.
      db.exec(`
        CREATE TABLE IF NOT EXISTS understat_matches (
          match_id TEXT PRIMARY KEY,
          league TEXT NOT NULL,
          season_year INTEGER,
          date TEXT,
          team_h TEXT, team_a TEXT,
          goals_h INTEGER, goals_a INTEGER,
          xg_h REAL, xg_a REAL,
          is_result INTEGER DEFAULT 0,
          ingested_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_understat_teams ON understat_matches(team_h, team_a, date);
        CREATE INDEX IF NOT EXISTS idx_understat_league_date ON understat_matches(league, date);
      `);
    },
  },
  {
    id: '072_tips_tip_context_json',
    up(db) {
      // Snapshot estruturado do contexto da tip (factors, gates, modelP raw)
      // pra forensics post-mortem. NULL pra tips antigas; preenchido a partir
      // do payload do /record-tip quando bot envia campos relevantes.
      addColumnIfMissing(db, 'tips', 'tip_context_json', 'tip_context_json TEXT');
    },
  },
  {
    id: '071_index_audit_dedup',
    up(db) {
      // Index audit 2026-04-30: dropa duplicatas + adiciona compostos pra
      // queries hot do leaks digest e MT settle.
      // Drops são best-effort (catch silencioso) — index pode não existir
      // em DBs antigos que pularam migrations intermediárias.
      const _safeDrop = (name) => {
        try { db.exec(`DROP INDEX IF EXISTS ${name}`); } catch (_) {}
      };
      // Tips: idx_tips_sport_sent é dup exato de idx_tips_sport_sent_at.
      _safeDrop('idx_tips_sport_sent');
      // Tips: idx_tips_sport ⊂ idx_tips_sport_sent_at (prefix scan cobre).
      _safeDrop('idx_tips_sport');
      // Tips: idx_tips_result raramente usado isolado (queries cruzam c/ sport).
      _safeDrop('idx_tips_result');
      // Tips: idx_tips_match_id ⊂ idx_tips_match_sport (prefix).
      _safeDrop('idx_tips_match_id');
      // match_results: idx_mr_team1/team2 são dup exatos de idx_match_results_team*
      _safeDrop('idx_mr_team1');
      _safeDrop('idx_mr_team2');
      // dota_hero_stats: idx_dota_hero_name é dup de idx_dota_hero_stats_name.
      _safeDrop('idx_dota_hero_name');

      // Adiciona composto pra leaks digest query:
      //   WHERE created_at >= ? AND result IN ('win','loss')
      //   GROUP BY sport, market, side
      // Index parcial cobre o filtro de result.
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_mt_shadow_settled_grouping
          ON market_tips_shadow(created_at, sport, market, side)
          WHERE result IN ('win','loss')`);
      } catch (_) {}
      // Composto pra MT auto-restore query:
      //   WHERE sport=? AND market=? AND side=? AND created_at >= ? AND result IN ('win','loss')
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_mt_shadow_lookup_settled
          ON market_tips_shadow(sport, market, side, result, created_at)`);
      } catch (_) {}
    },
  },
  {
    id: '064_lol_game_objectives',
    up(db) {
      // Per-game objective stats scraped do gol.gg. Uma row por (golgg_gameid).
      // Inputs pro lol-kills-model refinado (objective control rates).
      db.exec(`
        CREATE TABLE IF NOT EXISTS lol_game_objectives (
          gameid TEXT PRIMARY KEY,
          series_id TEXT,
          team_blue TEXT, team_red TEXT,
          league TEXT, date TEXT,
          map_index INTEGER,
          kills_blue INTEGER, kills_red INTEGER, kills_total INTEGER,
          towers_blue INTEGER, towers_red INTEGER, towers_total INTEGER,
          inhibitors_blue INTEGER, inhibitors_red INTEGER, inhibitors_total INTEGER,
          drakes_blue INTEGER, drakes_red INTEGER, drakes_total INTEGER,
          barons_blue INTEGER, barons_red INTEGER, barons_total INTEGER,
          heralds_blue INTEGER, heralds_red INTEGER, heralds_total INTEGER,
          gold_blue INTEGER, gold_red INTEGER, gold_total INTEGER,
          source TEXT DEFAULT 'golgg',
          ingested_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_lol_obj_series ON lol_game_objectives(series_id, map_index);
        CREATE INDEX IF NOT EXISTS idx_lol_obj_teams_date ON lol_game_objectives(team_blue, team_red, date);
        CREATE INDEX IF NOT EXISTS idx_lol_obj_league_date ON lol_game_objectives(league, date);
      `);
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

  // 2026-04-28: cada migration roda em sua própria transaction. Antes runAll
  // envolvia TODAS migrations num único `db.transaction(...)` — falha em N
  // revertia 1..N-1 mas marcava nada → próximo boot retentava tudo, sempre
  // batendo o mesmo erro. Agora migrations bem-sucedidas ficam persistidas;
  // quem falhou loga + interrompe pra correção manual.
  let appliedCount = 0;
  for (const m of pending) {
    try {
      const tx = db.transaction(() => {
        m.up(db);
        db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
          m.id,
          nowIso()
        );
      });
      tx();
      appliedCount++;
    } catch (e) {
      const err = new Error(`Migration ${m.id} failed: ${e.message}`);
      err.failedMigration = m.id;
      err.appliedBefore = appliedCount;
      throw err;
    }
  }
  return { applied: appliedCount };
}

module.exports = {
  applyMigrations,
  migrations,
};

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

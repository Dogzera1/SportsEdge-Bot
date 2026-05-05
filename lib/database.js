const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { applyMigrations } = require('../migrations');

module.exports = function initDatabase(dbPath = 'sportsedge.db') {
  // Sanitize: remove tab/= artefatos do Railway
  dbPath = (dbPath || 'sportsedge.db').toString().trim().replace(/^=+/, '');

  // path.join quebra caminhos absolutos (/data/...) — usar resolve com isAbsolute
  let resolvedPath = path.isAbsolute(dbPath)
    ? dbPath
    : path.resolve(__dirname, '..', dbPath);

  // Garante que o diretório existe; fallback para raiz do projeto se não conseguir criar
  try {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    resolvedPath = path.resolve(__dirname, '..', 'sportsedge.db');
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  // 2026-04-28: synchronous=NORMAL (default é FULL no WAL mode). Reduz fsync
  // por commit em 5-10x — relevante pra hot loops de tips/settle. WAL+NORMAL
  // é seguro (durabilidade preservada exceto crash + power loss simultâneo).
  // Override via DB_SYNCHRONOUS=FULL se durabilidade absoluta for crítica.
  db.pragma(`synchronous = ${process.env.DB_SYNCHRONOUS || 'NORMAL'}`);
  // WAL guard: cap explícito do journal pra evitar crescimento ilimitado em
  // escrita pesada. Default 100MB (parametrizável via DB_JOURNAL_SIZE_LIMIT).
  // Mesmo com auto-checkpoint do better-sqlite3, picos de escrita podem
  // empilhar páginas além do checkpoint window. Cap garante FS bounded.
  const journalSizeLimit = parseInt(process.env.DB_JOURNAL_SIZE_LIMIT || String(100 * 1024 * 1024), 10) || (100 * 1024 * 1024);
  try { db.pragma(`journal_size_limit = ${journalSizeLimit}`); } catch (_) {}

  // ── Slow query log ──
  // Wrappa db.prepare() pra timing run/get/all. Queries >threshold viram
  // counter `db_slow_query` + WARN log com SQL truncado. Custo: ~µs por
  // call (Date.now + comparison). Default 100ms — bom sinal de outliers
  // sem inundar logs (queries normais p99 <50ms). Set =0 pra desligar.
  const _slowMs = parseInt(process.env.DB_SLOW_QUERY_MS ?? '100', 10);
  if (Number.isFinite(_slowMs) && _slowMs > 0) {
    let _metrics = null;
    try { _metrics = require('./metrics'); } catch (_) {}
    const _origPrepare = db.prepare.bind(db);
    db.prepare = function (sql) {
      const stmt = _origPrepare(sql);
      const sqlShort = String(sql).replace(/\s+/g, ' ').trim().slice(0, 120);
      const _wrapMethod = (methodName) => {
        const orig = stmt[methodName];
        if (typeof orig !== 'function') return;
        stmt[methodName] = function (...args) {
          const t0 = Date.now();
          const r = orig.apply(stmt, args);
          const dt = Date.now() - t0;
          if (dt >= _slowMs) {
            try {
              if (_metrics) {
                _metrics.incr('db_slow_query', { method: methodName });
                _metrics.timing('db_query_ms', dt, { method: methodName });
              }
            } catch (_) {}
            try {
              const { log } = require('./utils');
              log('WARN', 'DB-SLOW', `${methodName} ${dt}ms: ${sqlShort}${sqlShort.length === 120 ? '…' : ''}`);
            } catch (_) {}
          }
          return r;
        };
      };
      _wrapMethod('run'); _wrapMethod('get'); _wrapMethod('all'); _wrapMethod('iterate');
      return stmt;
    };
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      subscribed INTEGER DEFAULT 0,
      sport_prefs TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS athletes (
      id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      name TEXT NOT NULL,
      nickname TEXT,
      stats JSON,
      url TEXT,
      last_scraped TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      name TEXT NOT NULL,
      date TEXT,
      location TEXT,
      url TEXT,
      scraped_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      event_id TEXT,
      event_name TEXT,
      participant1_name TEXT,
      participant2_name TEXT,
      participant1_url TEXT,
      participant2_url TEXT,
      category TEXT,
      is_title INTEGER DEFAULT 0,
      is_main INTEGER DEFAULT 0,
      status TEXT DEFAULT 'upcoming',
      winner TEXT,
      method TEXT,
      round INTEGER,
      score TEXT,
      match_time TEXT,
      event_date TEXT
    );

    CREATE TABLE IF NOT EXISTS tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      match_id TEXT,
      event_name TEXT,
      participant1 TEXT,
      participant2 TEXT,
      tip_participant TEXT,
      odds REAL,
      ev REAL,
      stake TEXT,
      confidence TEXT,
      is_live INTEGER DEFAULT 0,
      sent_at TEXT DEFAULT (datetime('now')),
      result TEXT,
      settled_at TEXT,
      bot_token TEXT,
      market_type TEXT DEFAULT 'ML'
    );

    CREATE TABLE IF NOT EXISTS odds_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      match_key TEXT,
      participant1 TEXT,
      participant2 TEXT,
      odds_p1 REAL,
      odds_p2 REAL,
      bookmaker TEXT,
      recorded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS card_snapshots (
      event_id TEXT NOT NULL,
      sport TEXT NOT NULL,
      match_id TEXT NOT NULL,
      participant1_name TEXT NOT NULL,
      participant2_name TEXT NOT NULL,
      snapped_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (event_id, sport, match_id)
    );

    CREATE TABLE IF NOT EXISTS match_results (
      match_id TEXT,
      game TEXT,
      team1 TEXT,
      team2 TEXT,
      winner TEXT,
      final_score TEXT,
      league TEXT,
      resolved_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (match_id, game)
    );

    -- Resultados por mapa (Valorant, eventualmente outros) — para map-level Elo/win rate
    CREATE TABLE IF NOT EXISTS valorant_map_results (
      match_id TEXT NOT NULL,
      game_pos INTEGER NOT NULL,
      team1 TEXT,
      team2 TEXT,
      map_name TEXT,
      winner TEXT,
      resolved_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (match_id, game_pos)
    );
    CREATE INDEX IF NOT EXISTS idx_valorant_map_team ON valorant_map_results(team1, team2);
    CREATE INDEX IF NOT EXISTS idx_valorant_map_name ON valorant_map_results(map_name);

    -- Elo ratings futebol (1X2)
    CREATE TABLE IF NOT EXISTS football_elo (
      team TEXT PRIMARY KEY,
      rating REAL NOT NULL DEFAULT 1500,
      games INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Log de imports de datasets externos
    CREATE TABLE IF NOT EXISTS dataset_imports (
      key TEXT PRIMARY KEY,
      source TEXT,
      imported_at TEXT DEFAULT (datetime('now')),
      rows INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pro_champ_stats (
      champion TEXT NOT NULL,
      role TEXT NOT NULL,
      wins INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      patch TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (champion, role)
    );

    CREATE TABLE IF NOT EXISTS synced_matches (
      match_id TEXT PRIMARY KEY,
      game TEXT NOT NULL,
      synced_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pro_player_champ_stats (
      player TEXT NOT NULL,
      champion TEXT NOT NULL,
      wins INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      patch TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (player, champion)
    );

    -- Blacklist de tips com odds errada (evita re-tipar o mesmo confronto)
    CREATE TABLE IF NOT EXISTS voided_tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      match_id TEXT,
      p1_norm TEXT,
      p2_norm TEXT,
      market_type TEXT DEFAULT 'ML',
      reason TEXT DEFAULT 'odds_wrong',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_athletes_sport ON athletes(sport);
    CREATE INDEX IF NOT EXISTS idx_matches_sport ON matches(sport);
    CREATE INDEX IF NOT EXISTS idx_matches_surface ON matches(sport, category);
    CREATE INDEX IF NOT EXISTS idx_matches_time ON matches(sport, match_time);
    CREATE INDEX IF NOT EXISTS idx_tips_sport ON tips(sport);
    CREATE INDEX IF NOT EXISTS idx_odds_sport ON odds_history(sport);
    CREATE INDEX IF NOT EXISTS idx_tips_result ON tips(result);
    CREATE INDEX IF NOT EXISTS idx_match_results_team ON match_results(team1);
    CREATE INDEX IF NOT EXISTS idx_football_elo_team ON football_elo(team);
    CREATE INDEX IF NOT EXISTS idx_voided_match ON voided_tips(sport, match_id);
    CREATE INDEX IF NOT EXISTS idx_voided_pair ON voided_tips(sport, p1_norm, p2_norm, market_type, created_at);

    CREATE TABLE IF NOT EXISTS api_usage (
      provider TEXT NOT NULL,
      month TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (provider, month)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS bankroll (
      sport TEXT PRIMARY KEY,
      initial_banca REAL NOT NULL DEFAULT 100.0,
      current_banca REAL NOT NULL DEFAULT 100.0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ml_factor_weights (
      factor TEXT PRIMARY KEY,
      weight REAL NOT NULL DEFAULT 0.30,
      wins INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      last_recalc TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tip_factor_log (
      tip_id INTEGER,
      factor TEXT,
      predicted_dir TEXT,
      actual_winner TEXT,
      logged_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (tip_id, factor)
    );

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

  // Índices de performance (criados depois das tabelas)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_odds_history_recorded_at ON odds_history(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_match_results_team1_lower ON match_results(lower(team1));
    CREATE INDEX IF NOT EXISTS idx_match_results_team2_lower ON match_results(lower(team2));
    CREATE INDEX IF NOT EXISTS idx_match_results_game_resolved ON match_results(game, resolved_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tips_sport_result ON tips(sport, result);
    CREATE INDEX IF NOT EXISTS idx_tips_match_id ON tips(match_id);
    CREATE INDEX IF NOT EXISTS idx_tips_sport_result_settled ON tips(sport, result, settled_at);
    CREATE INDEX IF NOT EXISTS idx_tips_match_sport ON tips(match_id, sport);
    CREATE INDEX IF NOT EXISTS idx_tips_sport_sent ON tips(sport, sent_at);
  `);

  // Migrações versionadas (idempotentes)
  try {
    applyMigrations(db);
  } catch (migErr) {
    console.error('[DB] ERRO em applyMigrations:', migErr.message);
    // Não silencia: falha de migração pode deixar schema inconsistente
  }

  // Seed: banca inicial R$100 por sport (modelo per-sport tier unit, Abr/2026-III).
  // Esports legado fica 0/0 (migration 033 zerou; tips históricas reclassificadas
  // pra lol/dota2 via match_id no rebuild 040).
  for (const s of ['esports', 'mma', 'tennis', 'football', 'lol', 'dota2']) {
    const init = s === 'esports' ? 0 : 100;
    db.prepare('INSERT OR IGNORE INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)').run(s, init, init);
  }

  const stmts = {
    upsertUser: db.prepare(`
      INSERT INTO users (user_id, username, subscribed, sport_prefs)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username=excluded.username,
        subscribed=excluded.subscribed,
        sport_prefs=excluded.sport_prefs,
        last_seen=datetime('now')
    `),
    getSubscribedUsers: db.prepare(`SELECT user_id, username, sport_prefs FROM users WHERE subscribed = 1`),
    getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
    
    upsertAthlete: db.prepare(`
      INSERT INTO athletes (id, sport, name, nickname, stats, url, last_scraped)
      VALUES (@id, @sport, @name, @nickname, @stats, @url, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, nickname=excluded.nickname, stats=excluded.stats,
        url=excluded.url, last_scraped=datetime('now')
    `),
    getAthlete: db.prepare('SELECT * FROM athletes WHERE id = ?'),
    getAthletesByName: db.prepare('SELECT * FROM athletes WHERE sport = ? AND name LIKE ? LIMIT 5'),
    
    upsertEvent: db.prepare(`INSERT OR REPLACE INTO events (id, sport, name, date, location, url) VALUES (?, ?, ?, ?, ?, ?)`),
    getEvents: db.prepare("SELECT * FROM events WHERE sport = ? AND (date IS NULL OR date = '' OR date >= date('now', '-1 day')) ORDER BY date ASC LIMIT ?"),
    
    upsertMatch: db.prepare(`
      INSERT OR REPLACE INTO matches (id, sport, event_id, event_name, participant1_name,
        participant2_name, participant1_url, participant2_url, category, is_title, is_main,
        status, winner, method, round, score, match_time, event_date)
      VALUES (@id, @sport, @eventId, @eventName, @p1Name, @p2Name, @p1Url, @p2Url,
        @category, @isTitle, @isMain, @status, @winner, @method, @round, @score,
        @matchTime, @eventDate)
    `),
    getMatchesByEvent: db.prepare('SELECT * FROM matches WHERE event_id = ? AND sport = ? ORDER BY is_main DESC'),
    getMatchById: db.prepare('SELECT * FROM matches WHERE id = ?'),
    getUpcomingMatches: db.prepare(`
      SELECT m.*, e.date as ev_date, e.name as ev_name
      FROM matches m
      JOIN events e ON m.event_id = e.id
      WHERE m.sport = ? AND m.winner IS NULL AND e.date >= date('now')
      AND e.date <= date('now', ?)
      ORDER BY e.date ASC
    `),
    getPendingPastMatches: db.prepare(`
      SELECT DISTINCT m.id as match_id, m.event_id, m.participant1_name, m.participant2_name,
        m.winner, e.url as event_url, e.date, e.name as event_name
      FROM matches m
      JOIN events e ON m.event_id = e.id
      JOIN tips t ON t.match_id = m.id
      WHERE t.sport = ? AND t.result IS NULL AND m.winner IS NULL AND e.date < date('now')
      ORDER BY e.date DESC
    `),
    
    insertTip: db.prepare(`
      INSERT INTO tips (sport, match_id, event_name, participant1, participant2,
        tip_participant, odds, ev, stake, stake_reais, confidence, is_live, bot_token, market_type,
        model_p1, model_p2, model_p_pick, model_label, tip_reason, is_shadow, odds_fetched_at,
        code_sha, gate_state, tip_context_json)
      VALUES (@sport, @matchId, @eventName, @p1, @p2, @tipParticipant, @odds,
        @ev, @stake, @stake_reais, @confidence, @isLive, @botToken, @market_type,
        @model_p1, @model_p2, @model_p_pick, @model_label, @tip_reason, @isShadow, @odds_fetched_at,
        @code_sha, @gate_state, @tip_context_json)
    `),
    getUnsettledTips: db.prepare(`SELECT * FROM tips WHERE sport = ? AND result IS NULL AND sent_at > datetime('now', ?)`),
    // Per-tip settle por id. Usar SEMPRE (não existe versão por match_id —
    // a antiga contaminava lados opostos: a 1ª iteração marcava todas com
    // seu result e as seguintes não achavam nada por result IS NULL guard).
    settleTipById: db.prepare(`UPDATE tips SET result = ?, settled_at = datetime('now'), is_live = 0 WHERE id = ? AND result IS NULL`),
    voidTipById: db.prepare(`UPDATE tips SET result = 'void', settled_at = datetime('now'), profit_reais = 0, is_live = 0 WHERE id = ? AND sport = ? AND result IS NULL`),
    voidTipByMatch: db.prepare(`UPDATE tips SET result = 'void', settled_at = datetime('now'), profit_reais = 0, is_live = 0 WHERE match_id = ? AND sport = ? AND result IS NULL`),
    getTipById: db.prepare(`SELECT * FROM tips WHERE id = ? AND sport = ?`),
    getTipByMatchId: db.prepare(`SELECT * FROM tips WHERE match_id = ? AND sport = ? ORDER BY sent_at DESC LIMIT 1`),
    addVoidedTip: db.prepare(`
      INSERT INTO voided_tips (sport, match_id, p1_norm, p2_norm, market_type, reason)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    isVoidedMatch: db.prepare(`SELECT 1 FROM voided_tips WHERE sport = ? AND match_id = ? LIMIT 1`),
    isVoidedPairRecent: db.prepare(`
      SELECT 1 FROM voided_tips
      WHERE sport = ? AND market_type = ?
        AND (
          (p1_norm = ? AND p2_norm = ?) OR (p1_norm = ? AND p2_norm = ?)
        )
        AND created_at >= datetime('now', ?)
      LIMIT 1
    `),
    getTipsBySport: db.prepare('SELECT * FROM tips WHERE sport = ? AND result IS NOT NULL'),
    // 2026-05-03 FIX: filtro match+sport sem tip_participant escrevia mesma clv_odds em
    // 2 tips ML opostas no mesmo match (uma com CLV invertida). Adicionar tip_participant
    // pra escopo correto. Caller server.js:21079 (retroativo) prefere updateTipCLVById
    // direto via t.id.
    updateTipCLV: db.prepare('UPDATE tips SET clv_odds = ? WHERE match_id = ? AND sport = ? AND tip_participant = ?'),
    updateTipCLVById: db.prepare('UPDATE tips SET clv_odds = ? WHERE id = ?'),
    updateTipOpenOdds: db.prepare('UPDATE tips SET open_odds = ? WHERE match_id = ? AND sport = ? AND open_odds IS NULL'),
    updateTipCurrent: db.prepare(`
      UPDATE tips
      SET current_odds = ?, current_ev = ?, current_confidence = ?, current_stake = ?, current_updated_at = datetime('now')
      WHERE match_id = ? AND sport = ? AND result IS NULL
    `),
    updateTipCurrentAndNotified: db.prepare(`
      UPDATE tips
      SET current_odds = ?, current_ev = ?, current_confidence = ?, current_stake = ?, current_updated_at = datetime('now'),
          last_notified_at = datetime('now')
      WHERE match_id = ? AND sport = ? AND result IS NULL
    `),
    markTipNotified: db.prepare(`
      UPDATE tips
      SET last_notified_at = datetime('now')
      WHERE match_id = ? AND sport = ? AND result IS NULL
    `),
    updateTipLineShop: db.prepare(`
      UPDATE tips
      SET best_book = ?, best_odd = ?, pinnacle_odd = ?, line_shop_delta_pct = ?
      WHERE id = ?
    `),

    insertOddsHistory: db.prepare(`INSERT INTO odds_history (sport, match_key, participant1, participant2, odds_p1, odds_p2, bookmaker) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    getOddsMovement: db.prepare(`SELECT odds_p1, odds_p2, bookmaker, recorded_at FROM odds_history WHERE sport = ? AND match_key = ? ORDER BY recorded_at ASC LIMIT 10`),
    
    getROI: db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) as losses,
        ROUND(AVG(ev), 2) as avg_ev,
        ROUND(AVG(odds), 2) as avg_odds
      FROM tips WHERE sport = ? AND result IS NOT NULL AND result != 'void'
        AND (archived IS NULL OR archived = 0)
    `),
    getRoiByMarket: db.prepare(`
      SELECT market_type,
        COUNT(*) as total,
        SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) as losses,
        ROUND(AVG(CASE WHEN result IS NOT NULL THEN ev END), 2) as avg_ev,
        ROUND((SUM(CASE WHEN result='win' THEN (CAST(odds AS REAL)-1)*CAST(stake AS REAL) ELSE -CAST(stake AS REAL) END) / NULLIF(SUM(CAST(stake AS REAL)),0))*100, 2) as roi
      FROM tips WHERE sport = ? AND result IS NOT NULL AND result != 'void'
        AND (archived IS NULL OR archived = 0)
      GROUP BY market_type
    `),
    getCalibration: db.prepare(`
      SELECT confidence, COUNT(*) as total,
        SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
        ROUND(100.0 * SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate
      FROM tips WHERE sport = ? AND result IS NOT NULL AND result != 'void'
        AND (archived IS NULL OR archived = 0)
      GROUP BY confidence
    `),
    
    saveSnapshot: db.prepare(`
      INSERT INTO card_snapshots (event_id, sport, match_id, participant1_name, participant2_name)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_id, sport, match_id) DO UPDATE SET
        participant1_name=excluded.participant1_name,
        participant2_name=excluded.participant2_name,
        snapped_at=datetime('now')
    `),
    getSnapshot: db.prepare('SELECT * FROM card_snapshots WHERE event_id = ? AND sport = ?'),
    
    getDBStatus: db.prepare(`
      SELECT
        (SELECT COUNT() FROM users) as users,
        (SELECT COUNT() FROM athletes WHERE sport = ?) as athletes,
        (SELECT COUNT() FROM events WHERE sport = ?) as events,
        (SELECT COUNT() FROM matches WHERE sport = ?) as matches,
        (SELECT COUNT() FROM tips WHERE sport = ?) as tips,
        (SELECT COUNT() FROM tips WHERE sport = ? AND result IS NULL) as unsettled,
        (SELECT COUNT() FROM odds_history WHERE sport = ?) as odds_history
    `),
    
    cleanOldOdds: db.prepare(`DELETE FROM odds_history WHERE recorded_at < datetime('now', '-14 days')`),
    
    // BUG FIX 2026-04-23: ON CONFLICT preserva final_score quando caller passa
    // string vazia (bot scanner detecta winner mas NÃO tem score; gol.gg/OpenDota
    // sync com final_score válido vinha DEPOIS via INSERT OR IGNORE → NOOP).
    // Resultado anterior: tips com handicap/total nunca liquidavam (final_score='').
    // Agora: caller com '' não destrói; caller com score válido sobrescreve.
    upsertMatchResult: db.prepare(`
      INSERT INTO match_results (match_id, game, team1, team2, winner, final_score, league)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id, game) DO UPDATE SET
        team1 = excluded.team1,
        team2 = excluded.team2,
        winner = excluded.winner,
        final_score = COALESCE(NULLIF(excluded.final_score, ''), final_score),
        league = excluded.league
    `),
    upsertMatchResultWithDate: db.prepare(`
      INSERT INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id, game) DO UPDATE SET
        team1 = excluded.team1,
        team2 = excluded.team2,
        winner = excluded.winner,
        final_score = COALESCE(NULLIF(excluded.final_score, ''), final_score),
        league = excluded.league,
        resolved_at = excluded.resolved_at
    `),
    getTeamForm: db.prepare(`SELECT * FROM match_results WHERE (lower(team1) = lower(?) OR lower(team2) = lower(?)) AND game = ? AND resolved_at >= datetime('now', '-45 days') ORDER BY resolved_at DESC LIMIT 10`),
    getTeamFormFuzzy: db.prepare(`SELECT * FROM match_results WHERE (lower(team1) LIKE lower(?) OR lower(team2) LIKE lower(?)) AND game = ? AND resolved_at >= datetime('now', '-45 days') ORDER BY resolved_at DESC LIMIT 10`),
    getH2H: db.prepare(`SELECT * FROM match_results WHERE ((lower(team1) = lower(?) AND lower(team2) = lower(?)) OR (lower(team1) = lower(?) AND lower(team2) = lower(?))) AND game = ? AND resolved_at >= datetime('now', '-45 days') ORDER BY resolved_at DESC LIMIT 10`),
    getH2HFuzzy: db.prepare(`SELECT * FROM match_results WHERE ((lower(team1) LIKE lower(?) AND lower(team2) LIKE lower(?)) OR (lower(team1) LIKE lower(?) AND lower(team2) LIKE lower(?))) AND game = ? AND resolved_at >= datetime('now', '-45 days') ORDER BY resolved_at DESC LIMIT 10`),

    getTeamFormCustom: db.prepare(`SELECT * FROM match_results WHERE (lower(team1) = lower(?) OR lower(team2) = lower(?)) AND game = ? AND resolved_at >= datetime('now', '-' || ? || ' days') ORDER BY resolved_at DESC LIMIT ?`),
    getTeamFormFuzzyCustom: db.prepare(`SELECT * FROM match_results WHERE (lower(team1) LIKE lower(?) OR lower(team2) LIKE lower(?)) AND game = ? AND resolved_at >= datetime('now', '-' || ? || ' days') ORDER BY resolved_at DESC LIMIT ?`),
    getH2HCustom: db.prepare(`SELECT * FROM match_results WHERE ((lower(team1) = lower(?) AND lower(team2) = lower(?)) OR (lower(team1) = lower(?) AND lower(team2) = lower(?))) AND game = ? AND resolved_at >= datetime('now', '-' || ? || ' days') ORDER BY resolved_at DESC LIMIT ?`),
    getH2HFuzzyCustom: db.prepare(`SELECT * FROM match_results WHERE ((lower(team1) LIKE lower(?) AND lower(team2) LIKE lower(?)) OR (lower(team1) LIKE lower(?) AND lower(team2) LIKE lower(?))) AND game = ? AND resolved_at >= datetime('now', '-' || ? || ' days') ORDER BY resolved_at DESC LIMIT ?`),

    // Football Elo
    getFootballElo: db.prepare(`SELECT rating, games FROM football_elo WHERE lower(team)=lower(?)`),
    upsertFootballElo: db.prepare(`
      INSERT INTO football_elo (team, rating, games, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(team) DO UPDATE SET rating=excluded.rating, games=excluded.games, updated_at=excluded.updated_at
    `),

    // Dataset import log
    getDatasetImport: db.prepare(`SELECT * FROM dataset_imports WHERE key = ?`),
    upsertDatasetImport: db.prepare(`
      INSERT INTO dataset_imports (key, source, rows, imported_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET rows=excluded.rows, imported_at=excluded.imported_at
    `),

    addChampStat: db.prepare(`
      INSERT INTO pro_champ_stats (champion, role, wins, total, patch)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(champion, role) DO UPDATE SET
        wins = wins + excluded.wins,
        total = total + excluded.total,
        patch = excluded.patch,
        updated_at = datetime('now')
    `),
    getChampStat: db.prepare('SELECT * FROM pro_champ_stats WHERE champion = ? AND role = ?'),
    getChampStatAnyRole: db.prepare('SELECT * FROM pro_champ_stats WHERE champion = ? ORDER BY total DESC LIMIT 1'),
    addPlayerChampStat: db.prepare(`
      INSERT INTO pro_player_champ_stats (player, champion, wins, total, patch)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(player, champion) DO UPDATE SET
        wins = wins + excluded.wins,
        total = total + excluded.total,
        patch = excluded.patch,
        updated_at = datetime('now')
    `),
    getPlayerChampStats: db.prepare('SELECT * FROM pro_player_champ_stats WHERE player = ? ORDER BY total DESC LIMIT 5'),
    getPlayerChampStat: db.prepare('SELECT * FROM pro_player_champ_stats WHERE player = ? AND champion = ?'),
    markMatchSynced: db.prepare('INSERT OR IGNORE INTO synced_matches (match_id, game) VALUES (?, ?)'),
    isMatchSynced: db.prepare('SELECT 1 FROM synced_matches WHERE match_id = ?'),
    cleanOldSynced: db.prepare("DELETE FROM synced_matches WHERE synced_at < datetime('now', '-60 days')"),

    getApiUsage: db.prepare('SELECT count FROM api_usage WHERE provider = ? AND month = ?'),
    incrementApiUsage: db.prepare(`
      INSERT INTO api_usage (provider, month, count) VALUES (?, ?, 1)
      ON CONFLICT(provider, month) DO UPDATE SET count = count + 1
    `),
    resetApiUsage: db.prepare('DELETE FROM api_usage WHERE provider = ? AND month = ?'),

    // Bankroll / Banca (per-sport)
    getBankroll: db.prepare('SELECT * FROM bankroll WHERE sport = ?'),
    updateBankroll: db.prepare("UPDATE bankroll SET current_banca = round(?, 2), updated_at = datetime('now') WHERE sport = ?"),
    resetBankroll: db.prepare("UPDATE bankroll SET initial_banca = round(?, 2), current_banca = round(?, 2), updated_at = datetime('now') WHERE sport = ?"),
    updateTipFinanceiro: db.prepare('UPDATE tips SET stake_reais = ?, profit_reais = ? WHERE id = ?'),
    getTipsByMatchForSettle: db.prepare("SELECT * FROM tips WHERE match_id = ? AND sport = ? AND result IS NULL"),
    tipExistsByMatch: db.prepare("SELECT 1 FROM tips WHERE match_id = ? AND sport = ? LIMIT 1"),

    // ML dynamic weights
    getFactorWeight: db.prepare('SELECT weight FROM ml_factor_weights WHERE factor = ?'),
    getAllFactorWeights: db.prepare('SELECT factor, weight, wins, total FROM ml_factor_weights ORDER BY factor'),
    upsertFactorWeight: db.prepare(`INSERT INTO ml_factor_weights (factor, weight, wins, total, last_recalc) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(factor) DO UPDATE SET weight=excluded.weight, wins=excluded.wins, total=excluded.total, last_recalc=excluded.last_recalc`),
    updateFactorAccuracy: db.prepare(`INSERT INTO ml_factor_weights (factor, weight, wins, total) VALUES (?, 0.30, ?, ?) ON CONFLICT(factor) DO UPDATE SET wins=wins+excluded.wins, total=total+excluded.total`),

    // Tip factor log
    logTipFactor: db.prepare(`INSERT OR IGNORE INTO tip_factor_log (tip_id, factor, predicted_dir, actual_winner) VALUES (?, ?, ?, ?)`),
    getUnsettledFactorLogs: db.prepare(`SELECT tlf.tip_id, tlf.factor, tlf.predicted_dir, t.result, t.tip_participant, t.participant1 FROM tip_factor_log tlf JOIN tips t ON t.id = tlf.tip_id WHERE tlf.actual_winner IS NULL AND t.result IS NOT NULL`),
    updateFactorLogWinner: db.prepare(`UPDATE tip_factor_log SET actual_winner = ? WHERE tip_id = ? AND factor = ?`),
    // Janela de acurácia para pesos dinâmicos (padrão 45 dias; alinhado com match_results)
    getFactorAccuracyLast45d: db.prepare(`SELECT factor, SUM(CASE WHEN predicted_dir = actual_winner THEN 1 ELSE 0 END) as wins, COUNT(*) as total FROM tip_factor_log WHERE actual_winner IS NOT NULL AND logged_at >= datetime('now', '-45 days') GROUP BY factor`)
  };

  return { db, stmts };
};
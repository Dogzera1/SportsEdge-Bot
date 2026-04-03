const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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
      bot_token TEXT
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

    CREATE INDEX IF NOT EXISTS idx_athletes_sport ON athletes(sport);
    CREATE INDEX IF NOT EXISTS idx_matches_sport ON matches(sport);
    CREATE INDEX IF NOT EXISTS idx_matches_surface ON matches(sport, category);
    CREATE INDEX IF NOT EXISTS idx_matches_time ON matches(sport, match_time);
    CREATE INDEX IF NOT EXISTS idx_tips_sport ON tips(sport);
    CREATE INDEX IF NOT EXISTS idx_odds_sport ON odds_history(sport);
    CREATE INDEX IF NOT EXISTS idx_tips_result ON tips(result);
    CREATE INDEX IF NOT EXISTS idx_match_results_team ON match_results(team1);

    CREATE TABLE IF NOT EXISTS api_usage (
      provider TEXT NOT NULL,
      month TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      PRIMARY KEY (provider, month)
    );

    CREATE TABLE IF NOT EXISTS bankroll (
      id INTEGER PRIMARY KEY DEFAULT 1,
      initial_banca REAL NOT NULL DEFAULT 100.0,
      current_banca REAL NOT NULL DEFAULT 100.0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed da banca inicial (R$100) se ainda não existir
  db.prepare('INSERT OR IGNORE INTO bankroll (id, initial_banca, current_banca) VALUES (1, 100.0, 100.0)').run();

  // Adiciona colunas para Line Shopping e CLV caso ainda não existam
  try { db.exec('ALTER TABLE tips ADD COLUMN clv_odds REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE tips ADD COLUMN open_odds REAL'); } catch (_) {}
  // Colunas para tracking financeiro em reais
  try { db.exec('ALTER TABLE tips ADD COLUMN stake_reais REAL'); } catch (_) {}
  try { db.exec('ALTER TABLE tips ADD COLUMN profit_reais REAL'); } catch (_) {}

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
        tip_participant, odds, ev, stake, confidence, is_live, bot_token)
      VALUES (@sport, @matchId, @eventName, @p1, @p2, @tipParticipant, @odds,
        @ev, @stake, @confidence, @isLive, @botToken)
    `),
    getUnsettledTips: db.prepare(`SELECT * FROM tips WHERE sport = ? AND result IS NULL AND sent_at > datetime('now', ?)`),
    settleTip: db.prepare(`UPDATE tips SET result = ?, settled_at = datetime('now') WHERE match_id = ? AND sport = ? AND result IS NULL`),
    getTipsBySport: db.prepare('SELECT * FROM tips WHERE sport = ? AND result IS NOT NULL'),
    updateTipCLV: db.prepare('UPDATE tips SET clv_odds = ? WHERE match_id = ? AND sport = ? AND (clv_odds IS NULL OR clv_odds = 0)'),
    updateTipOpenOdds: db.prepare('UPDATE tips SET open_odds = ? WHERE match_id = ? AND sport = ? AND open_odds IS NULL'),
    
    insertOddsHistory: db.prepare(`INSERT INTO odds_history (sport, match_key, participant1, participant2, odds_p1, odds_p2, bookmaker) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    getOddsMovement: db.prepare(`SELECT odds_p1, odds_p2, bookmaker, recorded_at FROM odds_history WHERE sport = ? AND match_key = ? ORDER BY recorded_at ASC LIMIT 10`),
    
    getROI: db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) as losses,
        ROUND(AVG(ev), 2) as avg_ev,
        ROUND(AVG(odds), 2) as avg_odds
      FROM tips WHERE sport = ? AND result IS NOT NULL
    `),
    getCalibration: db.prepare(`
      SELECT confidence, COUNT(*) as total,
        SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
        ROUND(100.0 * SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate
      FROM tips WHERE sport = ? AND result IS NOT NULL GROUP BY confidence
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
    
    upsertMatchResult: db.prepare(`INSERT OR REPLACE INTO match_results (match_id, game, team1, team2, winner, final_score, league) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    getTeamForm: db.prepare(`SELECT * FROM match_results WHERE (team1 = ? OR team2 = ?) AND game = ? AND resolved_at >= datetime('now', '-45 days') ORDER BY resolved_at DESC LIMIT 10`),
    getH2H: db.prepare(`SELECT * FROM match_results WHERE ((team1 = ? AND team2 = ?) OR (team1 = ? AND team2 = ?)) AND game = ? AND resolved_at >= datetime('now', '-45 days') ORDER BY resolved_at DESC LIMIT 10`),

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

    // Bankroll / Banca
    getBankroll: db.prepare('SELECT * FROM bankroll WHERE id = 1'),
    updateBankroll: db.prepare("UPDATE bankroll SET current_banca = round(?, 2), updated_at = datetime('now') WHERE id = 1"),
    resetBankroll: db.prepare("UPDATE bankroll SET initial_banca = round(?, 2), current_banca = round(?, 2), updated_at = datetime('now') WHERE id = 1"),
    updateTipFinanceiro: db.prepare('UPDATE tips SET stake_reais = ?, profit_reais = ? WHERE id = ?'),
    getTipsByMatchForSettle: db.prepare("SELECT * FROM tips WHERE match_id = ? AND sport = ? AND result IS NULL")
  };

  return { db, stmts };
};
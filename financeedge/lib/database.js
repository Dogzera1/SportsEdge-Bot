const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

module.exports = function initDatabase(dbPath = 'financeedge.db') {
  dbPath = (dbPath || 'financeedge.db').toString().trim().replace(/^=+/, '');

  let resolvedPath = path.isAbsolute(dbPath)
    ? dbPath
    : path.resolve(__dirname, '..', dbPath);

  try {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    resolvedPath = path.resolve(__dirname, '..', 'financeedge.db');
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      subscribed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('long','short')),
      entry_price REAL NOT NULL,
      exit_price REAL,
      stop_loss REAL,
      take_profit REAL,
      stake_usdt REAL NOT NULL,
      stake_pct REAL,
      result TEXT CHECK(result IN ('win','loss','open')),
      pnl_usdt REAL,
      pnl_pct REAL,
      fees_usdt REAL DEFAULT 0,
      signal_confidence TEXT,
      signal_ev REAL,
      kelly_fraction REAL,
      timeframe TEXT DEFAULT '1h',
      mode TEXT DEFAULT 'paper',
      opened_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT,
      bot_token TEXT
    );

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      direction TEXT,
      confidence TEXT,
      ev_pct REAL,
      rsi REAL,
      macd_hist REAL,
      bb_position REAL,
      atr REAL,
      price REAL,
      volume REAL,
      generated_at TEXT DEFAULT (datetime('now')),
      acted_on INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bankroll (
      id INTEGER PRIMARY KEY DEFAULT 1,
      initial_usdt REAL NOT NULL DEFAULT 1000.0,
      current_usdt REAL NOT NULL DEFAULT 1000.0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ohlcv_cache (
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      ts INTEGER NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume REAL,
      PRIMARY KEY (symbol, timeframe, ts)
    );

    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_result ON trades(result);
    CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
    CREATE INDEX IF NOT EXISTS idx_ohlcv ON ohlcv_cache(symbol, timeframe, ts);
  `);

  db.prepare('INSERT OR IGNORE INTO bankroll (id, initial_usdt, current_usdt) VALUES (1, 1000.0, 1000.0)').run();

  const stmts = {
    upsertUser: db.prepare(`
      INSERT INTO users (user_id, username, subscribed)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username=excluded.username,
        subscribed=excluded.subscribed,
        last_seen=datetime('now')
    `),
    getSubscribedUsers: db.prepare('SELECT user_id, username FROM users WHERE subscribed = 1'),
    getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),

    insertTrade: db.prepare(`
      INSERT INTO trades (symbol, direction, entry_price, stop_loss, take_profit, stake_usdt, stake_pct,
        signal_confidence, signal_ev, kelly_fraction, timeframe, mode, bot_token)
      VALUES (@symbol, @direction, @entryPrice, @stopLoss, @takeProfit, @stakeUsdt, @stakePct,
        @signalConfidence, @signalEv, @kellyFraction, @timeframe, @mode, @botToken)
    `),
    closeTrade: db.prepare(`
      UPDATE trades SET
        exit_price = ?, result = ?, pnl_usdt = ?, pnl_pct = ?, fees_usdt = ?, closed_at = datetime('now')
      WHERE id = ?
    `),
    getOpenTrades: db.prepare("SELECT * FROM trades WHERE result = 'open' OR result IS NULL ORDER BY opened_at DESC"),
    getTradesBySymbol: db.prepare("SELECT * FROM trades WHERE symbol = ? ORDER BY opened_at DESC LIMIT 20"),
    getSettledTrades: db.prepare("SELECT * FROM trades WHERE result IN ('win','loss') ORDER BY closed_at DESC LIMIT ?"),
    getTradeById: db.prepare('SELECT * FROM trades WHERE id = ?'),
    openTradeCount: db.prepare("SELECT COUNT(*) as c FROM trades WHERE (result = 'open' OR result IS NULL)"),
    tradeExistsOpen: db.prepare("SELECT 1 FROM trades WHERE symbol = ? AND (result = 'open' OR result IS NULL) LIMIT 1"),

    insertSignal: db.prepare(`
      INSERT INTO signals (symbol, timeframe, direction, confidence, ev_pct, rsi, macd_hist, bb_position, atr, price, volume)
      VALUES (@symbol, @timeframe, @direction, @confidence, @evPct, @rsi, @macdHist, @bbPosition, @atr, @price, @volume)
    `),
    getLatestSignals: db.prepare('SELECT * FROM signals ORDER BY generated_at DESC LIMIT ?'),
    markSignalActed: db.prepare('UPDATE signals SET acted_on = 1 WHERE id = ?'),

    getBankroll: db.prepare('SELECT * FROM bankroll WHERE id = 1'),
    updateBankroll: db.prepare("UPDATE bankroll SET current_usdt = round(?, 4), updated_at = datetime('now') WHERE id = 1"),
    resetBankroll: db.prepare("UPDATE bankroll SET initial_usdt = round(?, 4), current_usdt = round(?, 4), updated_at = datetime('now') WHERE id = 1"),

    insertOHLCV: db.prepare(`
      INSERT OR REPLACE INTO ohlcv_cache (symbol, timeframe, ts, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getOHLCV: db.prepare('SELECT * FROM ohlcv_cache WHERE symbol = ? AND timeframe = ? ORDER BY ts DESC LIMIT ?'),
    cleanOldOHLCV: db.prepare("DELETE FROM ohlcv_cache WHERE ts < ?"),

    getROI: db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) as losses,
        ROUND(SUM(COALESCE(pnl_usdt, 0)), 4) as total_pnl_usdt,
        ROUND(AVG(COALESCE(pnl_pct, 0)), 4) as avg_pnl_pct,
        ROUND(AVG(signal_ev), 2) as avg_ev
      FROM trades WHERE result IN ('win','loss')
    `)
  };

  return { db, stmts };
};

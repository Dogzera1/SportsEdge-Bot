const Database = require('better-sqlite3');
const { applyMigrations } = require('../../migrations');

describe('mt-auto-promote granular stats (Phase 1.3 + 1.4)', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    delete process.env.FROZEN_HOLDOUT_DAYS;
    delete process.env.FROZEN_HOLDOUT_MT_AUTO_PROMOTE_DAYS;
    // Reset module cache so envs are re-read
    jest.resetModules();
  });

  test('_statsBySportMarket aggregates per (sport, market) — shadow only', () => {
    // Seed market_tips_shadow with 60 lol/HANDICAP_GAMES wins (+8%) and 55 lol/HANDICAP_SETS losses (-12%)
    const stmt = db.prepare(`
      INSERT INTO market_tips_shadow (sport, market, side, team1, team2, league, created_at,
        result, stake_units, profit_units, clv_pct)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-2 days'), ?, 1, ?, NULL)
    `);
    for (let i = 0; i < 60; i++) {
      stmt.run('lol', 'HANDICAP_GAMES', 'over', 'A', 'B', 'LCS', 'win', 0.08);
    }
    for (let i = 0; i < 55; i++) {
      stmt.run('lol', 'HANDICAP_SETS', 'over', 'A', 'B', 'LCS', 'loss', -0.12);
    }

    const { _statsBySportMarket } = require('../../lib/mt-auto-promote');
    const rows = _statsBySportMarket(db, 30, { applyWindowOverride: false });

    const hg = rows.find(r => r.sport === 'lol' && r.market === 'HANDICAP_GAMES');
    const hs = rows.find(r => r.sport === 'lol' && r.market === 'HANDICAP_SETS');

    expect(hg).toBeTruthy();
    expect(hg.settled).toBe(60);
    expect(hg.stake_u).toBeCloseTo(60, 1);
    expect(hg.profit_u).toBeCloseTo(60 * 0.08, 1);

    expect(hs).toBeTruthy();
    expect(hs.settled).toBe(55);
    expect(hs.stake_u).toBeCloseTo(55, 1);
    expect(hs.profit_u).toBeCloseTo(55 * -0.12, 1);
  });

  test('_statsBySportMarketReal joins with real tips per (sport, market)', () => {
    // Insert shadow tips (will be ignored by real path)
    const shadowStmt = db.prepare(`
      INSERT INTO market_tips_shadow (sport, market, side, team1, team2, league, created_at,
        result, stake_units, profit_units, clv_pct)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-2 days'), ?, 1, ?, NULL)
    `);
    for (let i = 0; i < 40; i++) {
      shadowStmt.run('lol', 'HANDICAP_GAMES', 'over', 'A', 'B', 'LCS', 'win', 0.08);
    }

    // Insert matching real tips (is_shadow=0) for HANDICAP_GAMES only
    const tipsStmt = db.prepare(`
      INSERT INTO tips (sport, market_type, participant1, participant2, sent_at, result, is_shadow, archived,
        stake, odds, profit_reais)
      VALUES (?, ?, ?, ?, datetime('now', '-2 days'), ?, 0, 0, 1, 1.9, ?)
    `);
    for (let i = 0; i < 30; i++) {
      tipsStmt.run('lol', 'HANDICAP_GAMES', 'A', 'B', 'win', 0.9);
    }
    // Add some real tips for HANDICAP_SETS with different result
    for (let i = 0; i < 20; i++) {
      tipsStmt.run('lol', 'HANDICAP_SETS', 'A', 'B', 'loss', -0.5);
    }

    const { _statsBySportMarketReal } = require('../../lib/mt-auto-promote');
    const rows = _statsBySportMarketReal(db, 30, { applyWindowOverride: false });

    // HANDICAP_GAMES should have 30 real tips
    const hg = rows.find(r => r.sport === 'lol' && r.market === 'HANDICAP_GAMES');
    expect(hg).toBeTruthy();
    expect(hg.settled).toBe(30);
    expect(hg.profit_u).toBeCloseTo(30 * 0.9, 1);

    // HANDICAP_SETS should have 20 real tips
    const hs = rows.find(r => r.sport === 'lol' && r.market === 'HANDICAP_SETS');
    expect(hs).toBeTruthy();
    expect(hs.settled).toBe(20);
    expect(hs.profit_u).toBeCloseTo(20 * -0.5, 1);
  });

  test('_statsBySportMarketReal does NOT include shadow-only tips', () => {
    // Insert shadow tips with NO matching real tips
    const shadowStmt = db.prepare(`
      INSERT INTO market_tips_shadow (sport, market, side, team1, team2, league, created_at,
        result, stake_units, profit_units, clv_pct)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-2 days'), ?, 1, ?, NULL)
    `);
    for (let i = 0; i < 25; i++) {
      shadowStmt.run('cs', 'TOTAL_KILLS', 'over', 'A', 'B', 'ESL', 'win', 0.10);
    }

    // No real tips inserted for CS

    const { _statsBySportMarketReal } = require('../../lib/mt-auto-promote');
    const rows = _statsBySportMarketReal(db, 30, { applyWindowOverride: false });

    // CS/TOTAL_KILLS should NOT appear (no real tips)
    const tk = rows.find(r => r.sport === 'cs' && r.market === 'TOTAL_KILLS');
    expect(tk).toBeUndefined();
  });

  test('_statsBySportMarketReal calculates profit_sq and clv_n', () => {
    // Insert real tips with CLV data
    const tipsStmt = db.prepare(`
      INSERT INTO tips (sport, market_type, participant1, participant2, sent_at, result, is_shadow, archived,
        stake, odds, profit_reais)
      VALUES (?, ?, ?, ?, datetime('now', '-2 days'), ?, 0, 0, 1, 1.9, ?)
    `);
    for (let i = 0; i < 10; i++) {
      tipsStmt.run('tennis', 'HANDICAP_GAMES', 'A', 'B', 'win', 0.5);
    }

    // Need to insert corresponding market_tips_shadow with clv_pct
    const shadowStmt = db.prepare(`
      INSERT INTO market_tips_shadow (sport, market, side, team1, team2, league, created_at,
        result, stake_units, profit_units, clv_pct)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-2 days'), ?, 1, ?, ?)
    `);
    for (let i = 0; i < 10; i++) {
      shadowStmt.run('tennis', 'HANDICAP_GAMES', 'over', 'A', 'B', 'ATP', 'win', 0.5, 2.5);
    }

    const { _statsBySportMarketReal } = require('../../lib/mt-auto-promote');
    const rows = _statsBySportMarketReal(db, 30, { applyWindowOverride: false });

    const hg = rows.find(r => r.sport === 'tennis' && r.market === 'HANDICAP_GAMES');
    expect(hg).toBeTruthy();
    expect(hg.settled).toBe(10);
    expect(hg.profit_sq).toBeGreaterThan(0);
    expect(hg.clv_n).toBe(10);
    expect(hg.avg_clv).toBeCloseTo(2.5, 1);
  });

  test('_statsBySportMarket returns empty when no markets match', () => {
    // Don't seed any market_tips_shadow

    const { _statsBySportMarket } = require('../../lib/mt-auto-promote');
    const rows = _statsBySportMarket(db, 30, { applyWindowOverride: false });

    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(0);
  });

  test('_statsBySportMarketReal returns empty when no real tips exist', () => {
    // Seed shadow but no real tips
    const shadowStmt = db.prepare(`
      INSERT INTO market_tips_shadow (sport, market, side, team1, team2, league, created_at,
        result, stake_units, profit_units, clv_pct)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-2 days'), ?, 1, ?, NULL)
    `);
    for (let i = 0; i < 15; i++) {
      shadowStmt.run('dota2', 'MAP_WINNER', 'team1', 'A', 'B', 'DOTA_PRO', 'win', 0.05);
    }

    const { _statsBySportMarketReal } = require('../../lib/mt-auto-promote');
    const rows = _statsBySportMarketReal(db, 30, { applyWindowOverride: false });

    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(0);
  });
});

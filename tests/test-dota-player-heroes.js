// tests/test-dota-player-heroes.js — pro-nick normalize/resolve + on-demand player×hero cache.
const Database = require('better-sqlite3');
const { normalizeProNick, resolveProPlayer, getPlayerHeroStats, _invalidateProCache } = require('../lib/dota-player-heroes');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dota_pro_players (account_id INTEGER PRIMARY KEY, name TEXT, name_norm TEXT, team_name TEXT, updated_at TEXT);
    CREATE TABLE dota_player_hero_stats (account_id INTEGER, hero_id INTEGER, games INTEGER, wins INTEGER, wr REAL, last_played INTEGER, fetched_at TEXT, PRIMARY KEY(account_id,hero_id));
  `);
  const ins = db.prepare(`INSERT INTO dota_pro_players VALUES (?,?,?,?,datetime('now'))`);
  for (const [acct, name] of [[201358612, 'Nisha'], [898455820, 'Malr1ne'], [97590558, 'Ace ♠']]) {
    ins.run(acct, name, normalizeProNick(name), 'Team X');
  }
  return db;
}

module.exports = async function (t) {
  _invalidateProCache();

  // normalizeProNick — dense key
  t.test('normalize lowercases + strips non-alnum', () => t.assert(normalizeProNick('Ace ♠') === 'ace'));
  t.test('normalize trims', () => t.assert(normalizeProNick('  Nisha ') === 'nisha'));
  t.test('normalize dotted handle stays dense', () => t.assert(normalizeProNick('Tundra.Nine') === 'tundranine'));
  t.test('normalize null -> empty', () => t.assert(normalizeProNick(null) === ''));

  // resolveProPlayer — whole + per-token fallback
  const db = freshDb();
  _invalidateProCache();
  t.test('resolve exact nick', () => t.assert(resolveProPlayer(db, 'Nisha')?.account_id === 201358612));
  t.test('resolve case/space-insensitive', () => t.assert(resolveProPlayer(db, ' nisha ')?.account_id === 201358612));
  t.test('resolve decorated nick (Ace ♠)', () => t.assert(resolveProPlayer(db, 'Ace')?.account_id === 97590558));
  t.test('resolve tagged handle token fallback', () => t.assert(resolveProPlayer(db, 'TeamX.Nisha')?.account_id === 201358612));
  t.test('resolve unknown -> null', () => t.assert(resolveProPlayer(db, 'Yatoro') === null));

  // getPlayerHeroStats — cache miss fetches, hit does not
  let calls = 0;
  const fetcher = async () => { calls++; return [{ hero_id: 1, games: 100, win: 60, last_played: 123 }, { hero_id: 5, games: 0, win: 0 }]; };
  const r1 = await getPlayerHeroStats(db, 201358612, { ttlDays: 7, fetcher });
  t.test('miss triggers fetch', () => t.assert(calls === 1));
  t.test('returns games>0 rows with wr', () => t.assert(r1.length === 1 && r1[0].hero_id === 1 && Math.abs(r1[0].wr - 0.6) < 1e-9));
  const r2 = await getPlayerHeroStats(db, 201358612, { ttlDays: 7, fetcher });
  t.test('fresh cache does not refetch', () => t.assert(calls === 1 && r2.length === 1));
  const rz = await getPlayerHeroStats(db, 0, { fetcher });
  t.test('zero account_id -> empty, no fetch', () => t.assert(rz.length === 0 && calls === 1));
};

'use strict';
/**
 * dota-player-heroes.js — Display-only: WR jogador×herói via OpenDota, on-demand + cache.
 * resolveProPlayer mapeia um nick -> account_id (tabela dota_pro_players); getPlayerHeroStats
 * lê o cache dota_player_hero_stats e busca /players/{id}/heroes se ausente/velho. No stake/EV.
 */
const https = require('https');

function normalizeProNick(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// pro-player map cache (~30min) — keyed module-level; prod has a single db.
let _proCache = null, _proTs = 0;
const PRO_TTL = 30 * 60 * 1000;
function _loadProMap(db) {
  const now = Date.now();
  if (_proCache && (now - _proTs) < PRO_TTL) return _proCache;
  const m = new Map();
  try {
    for (const r of db.prepare('SELECT account_id, name, name_norm, team_name FROM dota_pro_players').all()) {
      if (r.name_norm && !m.has(r.name_norm)) m.set(r.name_norm, { account_id: r.account_id, name: r.name, team_name: r.team_name });
    }
  } catch (_) { /* table missing (boot/test) */ }
  _proCache = m; _proTs = now;
  return m;
}
function _invalidateProCache() { _proCache = null; _proTs = 0; }

function resolveProPlayer(db, nick) {
  const raw = String(nick == null ? '' : nick).trim();
  if (!raw) return null;
  const map = _loadProMap(db);
  const whole = normalizeProNick(raw);
  if (whole && map.has(whole)) return map.get(whole);
  // fallback: try each token (handles "Tundra.Nine" / "OG ATF" / decorations)
  for (const tok of raw.split(/[\s.]+/)) {
    const k = normalizeProNick(tok);
    if (k.length >= 3 && map.has(k)) return map.get(k);
  }
  return null;
}

function _opendotaFetcher(accountId) {
  const key = process.env.OPENDOTA_API_KEY ? `?api_key=${process.env.OPENDOTA_API_KEY}` : '';
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.opendota.com/api/players/${accountId}/heroes${key}`,
      { headers: { 'User-Agent': 'SportsEdge/1.0' }, timeout: 15000 }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * WR do jogador por herói (cache dota_player_hero_stats, fetch on-demand se ausente/velho).
 * @returns Array<{hero_id, games, wins, wr, last_played}> ordenado por games desc (só games>0).
 */
async function getPlayerHeroStats(db, accountId, { ttlDays = 7, fetcher = _opendotaFetcher } = {}) {
  const acct = parseInt(accountId, 10);
  if (!acct) return [];
  const cutoff = new Date(Date.now() - ttlDays * 86400000).toISOString();
  const fresh = db.prepare('SELECT COUNT(*) c FROM dota_player_hero_stats WHERE account_id=? AND fetched_at > ?').get(acct, cutoff).c;
  if (!fresh) {
    let rows = null;
    try { rows = await fetcher(acct); } catch (_) { rows = null; }
    if (Array.isArray(rows)) {
      const now = new Date().toISOString();
      const up = db.prepare(`INSERT INTO dota_player_hero_stats (account_id,hero_id,games,wins,wr,last_played,fetched_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(account_id,hero_id) DO UPDATE SET games=excluded.games, wins=excluded.wins, wr=excluded.wr, last_played=excluded.last_played, fetched_at=excluded.fetched_at`);
      const tx = db.transaction(() => {
        for (const r of rows) {
          if (!r.hero_id) continue; // guard: OpenDota always sends hero_id, but a malformed row + composite PK would store distinct NULLs (mirrors the matchups sync guard)
          const games = r.games || 0, win = r.win || 0;
          up.run(acct, r.hero_id, games, win, games ? win / games : null, r.last_played || null, now);
        }
      });
      tx();
    }
  }
  return db.prepare('SELECT hero_id, games, wins, wr, last_played FROM dota_player_hero_stats WHERE account_id=? AND games>0 ORDER BY games DESC').all(acct);
}

module.exports = { normalizeProNick, resolveProPlayer, getPlayerHeroStats, _invalidateProCache };

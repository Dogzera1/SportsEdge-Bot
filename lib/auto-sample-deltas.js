'use strict';

/**
 * auto-sample-deltas.js
 *
 * Cron job que coleta deltas Pinnacle vs outros books automaticamente. Lê o
 * cache de odds em memória (via HTTP loopback aos endpoints /football-matches,
 * /odds), pra cada par (Pinnacle, OutroBook) calcula delta e insere em
 * bookmaker_delta_samples.
 *
 * Não substitui samples manuais BR (via /odd-sample) — complementa com
 * benchmark europeu/global pra validar infra e aproximar deltas BR.
 *
 * Cap por (sport, bookmaker): se já tem >MAX_PER_PAIR samples nas últimas 7d,
 * skipa pra não inflar tabela com dados redundantes.
 */

const http = require('http');

const MAX_PER_PAIR_7D = parseInt(process.env.AUTO_SAMPLE_MAX_PER_PAIR_7D || '300', 10);

function _normBook(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3000;
    http.get('http://localhost:' + port + path, (r) => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function _shouldSample(db, sport, bookmaker) {
  const bk = _normBook(bookmaker);
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM bookmaker_delta_samples
    WHERE sport = ? AND bookmaker = ?
      AND captured_at >= datetime('now', '-7 days')
  `).get(sport, bk);
  return (row?.n || 0) < MAX_PER_PAIR_7D;
}

function _addSample(db, sport, bookmaker, pin, br, label) {
  const bk = _normBook(bookmaker);
  const p = parseFloat(pin), b = parseFloat(br);
  if (!Number.isFinite(p) || !Number.isFinite(b) || p <= 1 || b <= 1) return false;
  if (!_shouldSample(db, sport, bk)) return false;
  const delta = +((b / p - 1) * 100).toFixed(3);
  try {
    db.prepare(`
      INSERT INTO bookmaker_delta_samples (sport, bookmaker, pinnacle_odd, br_odd, delta_pct, match_label)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sport, bk, p, b, delta, label || null);
    return true;
  } catch (_) { return false; }
}

async function _collectFootball(db) {
  let added = 0, scanned = 0;
  try {
    const matches = await fetchJson('/football-matches');
    scanned = matches.length;
    for (const m of matches) {
      const all = m.odds?._allOdds;
      if (!Array.isArray(all) || all.length < 2) continue;
      const pin = all.find(b => /pinnacle/i.test(b.bookmaker));
      if (!pin) continue;
      for (const other of all) {
        if (other === pin || /pinnacle/i.test(other.bookmaker)) continue;
        const ph = parseFloat(pin.h), oh = parseFloat(other.h);
        if (Number.isFinite(ph) && Number.isFinite(oh) && ph > 1 && oh > 1) {
          if (_addSample(db, 'football', other.bookmaker, ph, oh, m.team1 + ' vs ' + m.team2 + ' [home]')) added++;
        }
        const pa = parseFloat(pin.a), oa = parseFloat(other.a);
        if (Number.isFinite(pa) && Number.isFinite(oa) && pa > 1 && oa > 1) {
          if (_addSample(db, 'football', other.bookmaker, pa, oa, m.team1 + ' vs ' + m.team2 + ' [away]')) added++;
        }
      }
    }
  } catch (_) {}
  return { sport: 'football', scanned, added };
}

async function _collectEsports(db, game) {
  let added = 0, scanned = 0;
  try {
    const matchesPath = game === 'lol' ? '/lol-matches' : '/dota-matches';
    const matches = await fetchJson(matchesPath);
    scanned = matches.length;
    for (const m of matches.slice(0, 50)) {
      if (!m.team1 || !m.team2) continue;
      try {
        const o = await fetchJson('/odds?team1=' + encodeURIComponent(m.team1) + '&team2=' + encodeURIComponent(m.team2) + '&game=' + game);
        const all = o?._allOdds;
        if (!Array.isArray(all) || all.length < 2) continue;
        const pin = all.find(b => /pinnacle/i.test(b.bookmaker));
        if (!pin) continue;
        for (const other of all) {
          if (other === pin || /pinnacle/i.test(other.bookmaker)) continue;
          const p1 = parseFloat(pin.t1), o1 = parseFloat(other.t1);
          if (Number.isFinite(p1) && Number.isFinite(o1) && p1 > 1 && o1 > 1) {
            if (_addSample(db, game, other.bookmaker, p1, o1, m.team1 + ' vs ' + m.team2 + ' [t1]')) added++;
          }
          const p2 = parseFloat(pin.t2), o2 = parseFloat(other.t2);
          if (Number.isFinite(p2) && Number.isFinite(o2) && p2 > 1 && o2 > 1) {
            if (_addSample(db, game, other.bookmaker, p2, o2, m.team1 + ' vs ' + m.team2 + ' [t2]')) added++;
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  return { sport: game, scanned, added };
}

async function runAutoSampleDeltas(db) {
  if (/^(0|false|no)$/i.test(String(process.env.AUTO_SAMPLE_DELTAS || ''))) return null;
  const t0 = Date.now();
  const results = await Promise.all([
    _collectFootball(db),
    _collectEsports(db, 'lol'),
    _collectEsports(db, 'dota2'),
  ]);
  const totalAdded = results.reduce((a, r) => a + r.added, 0);
  const ms = Date.now() - t0;
  return { totalAdded, results, ms };
}

module.exports = { runAutoSampleDeltas };

'use strict';

/**
 * lib/hltv-results-sync.js — sync de results HLTV em bulk pra populate
 * match_results com hltv_* rows. Extract de scripts/sync-hltv-results.js
 * pra wire em cron (não só CLI manual).
 *
 * Por que: settle de per-map rounds requer matchId HLTV pra chamar
 * getCsMatchMapResults. match_results tem rows cs2_ps_* (PandaScore IDs).
 * Solução: bulk sync /results pages adiciona rows match_id='hltv_<N>'
 * com mesma resolved_at + teams. Ingest per-map então usa hltv_* rows.
 *
 * Uso:
 *   const { syncHltvResults } = require('./lib/hltv-results-sync');
 *   const r = await syncHltvResults(db, { maxPages: 5, delayMs: 2000 });
 *   // { fetched, inserted, pages, errors }
 */

const https = require('https');
const { log } = require('./utils');

const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function _buildHltvUrl(path) {
  const proxyBase = (process.env.HLTV_PROXY_BASE || '').trim().replace(/\/+$/, '');
  const direct = /^(1|true|yes)$/i.test(String(process.env.HLTV_DIRECT || ''));
  const p = path.startsWith('/') ? path : `/${path}`;
  if (proxyBase) {
    let b = proxyBase;
    if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
    return `${b}${p}`;
  }
  if (direct) return `https://www.hltv.org${p}`;
  return null;
}

function _get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      timeout: 30000,
      rejectUnauthorized: false,
      headers: {
        'User-Agent': HTTP_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.hltv.org/',
        'ngrok-skip-browser-warning': 'true',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    })
    .on('error', e => resolve({ status: 0, err: e.message }))
    .on('timeout', () => resolve({ status: 0, err: 'timeout' }));
  });
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Parse single result-con block. Mirror parseResults() de scripts/sync-hltv-results.
 */
function _parseResultsPage(html) {
  const out = [];
  // Find all result-con + date headers
  const markers = [];
  const reResultCon = /<div class="result-con/g;
  const reHeadline = /<span class="standard-headline">([^<]+)<\/span>/g;
  let m;
  while ((m = reResultCon.exec(html)) !== null) markers.push({ type: 'match', idx: m.index });
  while ((m = reHeadline.exec(html)) !== null) markers.push({ type: 'date', idx: m.index, text: m[1].trim() });
  markers.sort((a, b) => a.idx - b.idx);

  let currentDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const mk of markers) {
    if (mk.type === 'date') {
      const clean = mk.text.replace(/^Results for\s+/i, '').replace(/(\d+)(st|nd|rd|th)/, '$1');
      const d = new Date(clean);
      if (!isNaN(d.getTime())) currentDate = d.toISOString().replace('T', ' ').slice(0, 19);
      continue;
    }
    const chunk = html.slice(mk.idx, mk.idx + 4000);
    const block = '<div class="result-con' + chunk.slice('<div class="result-con'.length);
    const idM = block.match(/^[^>]*><a href="\/matches\/(\d+)\//);
    if (!idM) continue;
    const matchId = idM[1];
    const t1M = block.match(/<div class="line-align team1">[\s\S]*?<div class="team(?: team-won)?\s*">([^<]+)<\/div>/);
    if (!t1M) continue;
    const t1 = t1M[1].trim();
    const t1Won = /<div class="line-align team1">[\s\S]*?<div class="team team-won/.test(block);
    const t2M = block.match(/<div class="line-align team2">[\s\S]*?<div class="team(?: team-won)?\s*">([^<]+)<\/div>/);
    if (!t2M) continue;
    const t2 = t2M[1].trim();
    const t2Won = /<div class="line-align team2">[\s\S]*?<div class="team team-won/.test(block);
    const sM = block.match(/<td class="result-score">\s*<span class="(?:score-won|score-lost)">(\d+)<\/span>\s*-\s*<span class="(?:score-won|score-lost)">(\d+)<\/span>/);
    if (!sM) continue;
    const s1 = parseInt(sM[1], 10);
    const s2 = parseInt(sM[2], 10);
    if (!Number.isFinite(s1) || !Number.isFinite(s2) || s1 === s2) continue;
    let winner = t1Won ? t1 : t2Won ? t2 : (s1 > s2 ? t1 : t2);
    const evM = block.match(/<span class="event-name">([^<]+)<\/span>/);
    const event = evM ? evM[1].trim() : '';
    const maxS = Math.max(s1, s2);
    let finalScore;
    if (maxS > 3) {
      finalScore = s1 > s2 ? 'Bo1 1-0' : 'Bo1 0-1';
    } else {
      const bo = maxS >= 3 ? 5 : maxS >= 2 ? 3 : 1;
      finalScore = `Bo${bo} ${s1}-${s2}`;
    }
    out.push({
      match_id: `hltv_${matchId}`,
      team1: t1, team2: t2, winner,
      final_score: finalScore,
      league: event,
      resolved_at: currentDate,
    });
  }
  return out;
}

/**
 * Bulk sync HLTV results pra match_results.
 *
 * @param {Database} db
 * @param {object} opts — { maxPages=3, delayMs=2500, startOffset=0 }
 * @returns {Promise<{ok, fetched, inserted, pages, blocked, errors}>}
 */
async function syncHltvResults(db, opts = {}) {
  const maxPages = Math.max(1, Math.min(50, parseInt(opts.maxPages || 3, 10) || 3));
  const delayMs = Math.max(500, parseInt(opts.delayMs || 2500, 10) || 2500);
  const startOffset = Math.max(0, parseInt(opts.startOffset || 0, 10) || 0);
  const PAGE_SIZE = 100;

  if (!_buildHltvUrl('/results')) {
    return { ok: false, error: 'HLTV_PROXY_BASE não configurado (HLTV_DIRECT desabilitado)' };
  }

  // Idempotent insert. ON CONFLICT preserva final_score válido.
  const stmt = db.prepare(`
    INSERT INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
    VALUES (?, 'cs2', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id, game) DO UPDATE SET
      team1 = excluded.team1,
      team2 = excluded.team2,
      winner = excluded.winner,
      final_score = COALESCE(NULLIF(excluded.final_score, ''), final_score),
      league = excluded.league,
      resolved_at = excluded.resolved_at
  `);

  let offset = startOffset;
  let fetched = 0, inserted = 0, pages = 0, blocked = 0;
  const errors = [];

  for (let pg = 0; pg < maxPages; pg++) {
    const url = _buildHltvUrl(`/results?offset=${offset}`);
    const r = await _get(url);
    if (r.status === 403 || r.status === 429) {
      blocked++;
      errors.push({ offset, status: r.status });
      log('WARN', 'HLTV-RESULTS-SYNC', `offset=${offset} blocked HTTP ${r.status}`);
      break;
    }
    if (r.status !== 200) {
      errors.push({ offset, status: r.status, err: r.err });
      log('WARN', 'HLTV-RESULTS-SYNC', `offset=${offset} HTTP ${r.status} ${r.err || ''}`);
      break;
    }
    if (/just a moment|cf-browser-verification|cloudflare/i.test(r.body) && r.body.length < 5000) {
      blocked++;
      errors.push({ offset, status: 'cf_challenge' });
      log('WARN', 'HLTV-RESULTS-SYNC', `offset=${offset} CF challenge`);
      break;
    }
    const results = _parseResultsPage(r.body);
    if (!results.length) {
      log('DEBUG', 'HLTV-RESULTS-SYNC', `offset=${offset} 0 parsed`);
      offset += PAGE_SIZE;
      pages++;
      await _sleep(delayMs);
      continue;
    }
    let pageInserted = 0;
    const tx = db.transaction((rows) => {
      for (const x of rows) {
        const res = stmt.run(x.match_id, x.team1, x.team2, x.winner, x.final_score, x.league, x.resolved_at);
        if (res.changes > 0) pageInserted++;
      }
    });
    tx(results);
    fetched += results.length;
    inserted += pageInserted;
    pages++;
    offset += PAGE_SIZE;
    log('INFO', 'HLTV-RESULTS-SYNC', `offset=${offset - PAGE_SIZE}: ${results.length} parsed, +${pageInserted} inserted`);
    await _sleep(delayMs);
  }

  return { ok: true, fetched, inserted, pages, blocked, errors };
}

module.exports = {
  syncHltvResults,
  _parseResultsPage, // pra tests
};

'use strict';

/**
 * lib/golgg-objectives-scraper.js — extrai objective stats per-game do gol.gg.
 *
 * Per row patterns observados em /game/stats/<id>/page-summary/:
 *   <tr><td>Towers</td><td style='...blueside...'>X</td><td style='...redside...'>Y</td></tr>
 *   <tr><td>Inhibitors</td>...
 *   <tr><td>Dragons</td>...
 *   <tr><td>Barons</td>...
 *   <tr><td>Heralds</td>...
 *   <tr><td>Kills</td>...
 *   <tr><td>Gold</td>...
 *   <tr><td>Game time</td>...
 *
 * Output: { kills_blue, kills_red, towers_blue, towers_red, drakes_blue, ... }
 */

const https = require('https');

const HTTP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function httpGetHtml(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': HTTP_UA, 'Accept': 'text/html,application/xhtml+xml' },
      timeout: 12000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

// Stats que extraímos. Cada entry: [outputKeyBase, ...regexLabels alternativos]
const STATS = [
  { key: 'kills', labels: ['Kills'] },
  { key: 'towers', labels: ['Towers', 'Towers killed', 'Towers Killed'] },
  { key: 'inhibitors', labels: ['Inhibitors', 'Inhibitors killed'] },
  { key: 'drakes', labels: ['Dragons', 'Drakes', 'Dragons Killed'] },
  { key: 'barons', labels: ['Barons', 'Nashors', 'Nashor', 'Baron Nashors'] },
  { key: 'heralds', labels: ['Heralds', 'Rift Heralds'] },
  { key: 'gold', labels: ['Gold'] },
];

function _extractStat(html, labels) {
  for (const label of labels) {
    // Pattern: <tr><td>LABEL</td><td style='...blueside...'>X</td><td style='...redside...'>Y</td>
    const re = new RegExp(
      `<td[^>]*>\\s*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*<\\/td>\\s*` +
      `<td[^>]*blueside[^>]*>\\s*([\\d.]+)\\s*<\\/td>\\s*` +
      `<td[^>]*redside[^>]*>\\s*([\\d.]+)\\s*<\\/td>`,
      'i'
    );
    const m = html.match(re);
    if (m) {
      const blue = parseFloat(m[1]);
      const red = parseFloat(m[2]);
      if (Number.isFinite(blue) && Number.isFinite(red)) return { blue, red, label_used: label };
    }
    // Variant: classes ao invés de inline style
    const re2 = new RegExp(
      `<td[^>]*>\\s*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*<\\/td>\\s*` +
      `<td[^>]*(?:class=["'][^"']*blue[^"']*["'])?[^>]*>\\s*([\\d.]+)\\s*<\\/td>\\s*` +
      `<td[^>]*(?:class=["'][^"']*red[^"']*["'])?[^>]*>\\s*([\\d.]+)\\s*<\\/td>`,
      'i'
    );
    const m2 = html.match(re2);
    if (m2) {
      const blue = parseFloat(m2[1]);
      const red = parseFloat(m2[2]);
      if (Number.isFinite(blue) && Number.isFinite(red) && (blue + red) >= 0) {
        return { blue, red, label_used: label, fallback: true };
      }
    }
  }
  return null;
}

/**
 * Public API. Recebe gameId gol.gg, retorna objectives.
 * @param {string|number} gameId
 * @returns {{ ok, objectives?, gameid?, reason?, debug? }}
 */
async function fetchObjectivesViaGolgg(gameId) {
  if (!gameId) return { ok: false, reason: 'no_gameid' };
  const url = `https://gol.gg/game/stats/${gameId}/page-game/`;
  const r = await httpGetHtml(url);
  if (r.status !== 200) {
    // Fallback page-summary
    const r2 = await httpGetHtml(`https://gol.gg/game/stats/${gameId}/page-summary/`);
    if (r2.status !== 200) return { ok: false, reason: 'http_fail', status: r.status };
    r.body = r2.body;
    r.status = r2.status;
  }

  const objectives = {};
  const debug = {};
  for (const stat of STATS) {
    const v = _extractStat(r.body, stat.labels);
    if (v) {
      objectives[`${stat.key}_blue`] = v.blue;
      objectives[`${stat.key}_red`] = v.red;
      objectives[`${stat.key}_total`] = v.blue + v.red;
      debug[stat.key] = { label_used: v.label_used, fallback: !!v.fallback };
    } else {
      debug[stat.key] = 'not_found';
    }
  }
  if (Object.keys(objectives).length === 0) {
    return { ok: false, reason: 'no_stats_parsed', body_len: r.body.length, debug };
  }
  return { ok: true, gameid: gameId, objectives, debug };
}

/**
 * Bulk: scrape várias gameIds em paralelo (com rate limit).
 * @param {Array<string>} gameIds
 * @param {object} opts { concurrency=3, delayMs=300 }
 */
async function fetchObjectivesBulk(gameIds, opts = {}) {
  const concurrency = opts.concurrency ?? 3;
  const delayMs = opts.delayMs ?? 300;
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < gameIds.length) {
      const i = idx++;
      const gid = gameIds[i];
      const r = await fetchObjectivesViaGolgg(gid);
      results[i] = r;
      if (delayMs > 0) await new Promise(res => setTimeout(res, delayMs));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, gameIds.length) }, () => worker()));
  return results;
}

module.exports = { fetchObjectivesViaGolgg, fetchObjectivesBulk, _extractStat };

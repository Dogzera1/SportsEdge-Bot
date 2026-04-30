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
    // Pattern preciso: <tr><td>LABEL</td><td style='...blueside...'>X</td><td style='...redside...'>Y</td>
    // Encontra TODAS as ocorrências e prefere a que tem max value > 0 (tabelas
    // gol.gg às vezes têm header row com 0/0 antes da row real).
    const re = new RegExp(
      `<td[^>]*>\\s*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*<\\/td>\\s*` +
      `<td[^>]*blueside[^>]*>\\s*([\\d.]+)\\s*<\\/td>\\s*` +
      `<td[^>]*redside[^>]*>\\s*([\\d.]+)\\s*<\\/td>`,
      'gi'
    );
    const matches = [...html.matchAll(re)];
    if (matches.length) {
      // Prefere row com maior soma > 0
      let best = null;
      for (const m of matches) {
        const blue = parseFloat(m[1]);
        const red = parseFloat(m[2]);
        if (!Number.isFinite(blue) || !Number.isFinite(red)) continue;
        const sum = blue + red;
        if (sum <= 0) continue;
        if (!best || sum > best.sum) best = { blue, red, sum, label_used: label };
      }
      if (best) return { blue: best.blue, red: best.red, label_used: best.label_used };
      // Se todas matches são 0/0, retorna a primeira (caso real de 0 kills)
      if (matches[0]) {
        const blue = parseFloat(matches[0][1]);
        const red = parseFloat(matches[0][2]);
        if (Number.isFinite(blue) && Number.isFinite(red)) return { blue, red, label_used: label, all_zero: true };
      }
    }
    // Variant: classes ao invés de inline style
    const re2 = new RegExp(
      `<td[^>]*>\\s*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*<\\/td>\\s*` +
      `<td[^>]*(?:class=["'][^"']*blue[^"']*["'])?[^>]*>\\s*([\\d.]+)\\s*<\\/td>\\s*` +
      `<td[^>]*(?:class=["'][^"']*red[^"']*["'])?[^>]*>\\s*([\\d.]+)\\s*<\\/td>`,
      'gi'
    );
    const matches2 = [...html.matchAll(re2)];
    if (matches2.length) {
      let best = null;
      for (const m of matches2) {
        const blue = parseFloat(m[1]);
        const red = parseFloat(m[2]);
        if (!Number.isFinite(blue) || !Number.isFinite(red)) continue;
        const sum = blue + red;
        if (sum <= 0) continue;
        if (!best || sum > best.sum) best = { blue, red, sum, label_used: label, fallback: true };
      }
      if (best) return { blue: best.blue, red: best.red, label_used: best.label_used, fallback: true };
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
  // Tenta cada URL e parse imediatamente. Retorna na primeira que extrair stats.
  const urls = [
    `https://gol.gg/game/stats/${gameId}/page-game/`,
    `https://gol.gg/game/stats/${gameId}/page-summary/`,
    `https://gol.gg/game/stats/${gameId}/page-fullstats/`,
  ];
  let lastDebug = null;
  for (const url of urls) {
    const r = await httpGetHtml(url);
    if (r.status !== 200 || !r.body) {
      lastDebug = { url, status: r.status };
      continue;
    }
    const objectives = {};
    const debug = { url_used: url, body_len: r.body.length };
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
    if (Object.keys(objectives).length > 0) {
      return { ok: true, gameid: gameId, objectives, debug };
    }
    // Capture snippet pra última URL antes de tentar próxima
    const killsIdx = r.body.toLowerCase().indexOf('>kills<');
    debug.snippet = killsIdx >= 0 ? r.body.slice(killsIdx, killsIdx + 500) : 'no_>kills<_text';
    lastDebug = debug;
  }
  return { ok: false, reason: 'no_stats_parsed_any_url', debug: lastDebug };
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

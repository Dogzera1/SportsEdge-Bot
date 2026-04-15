/**
 * ufcstats.js — Scraper do ufcstats.com para enrichment avançado de MMA.
 *
 * Extrai per-fighter:
 *   - Record (wins-losses-draws)
 *   - Striking: SLpM, Str. Acc., SApM, Str. Def.
 *   - Grappling: TD Avg., TD Acc., TD Def., Sub. Avg.
 *   - Físico: reach (inches), stance, height, weight, DOB
 *
 * API: cuetracker-style scraping (sem API oficial).
 * Cache 24h porque stats mudam só após lutas.
 */
'use strict';

const { cachedHttpGet } = require('./utils');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9'
};

const TTL_SEARCH = 6 * 60 * 60 * 1000;   // 6h
const TTL_FIGHTER = 24 * 60 * 60 * 1000; // 24h

function _norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

async function _fetchHtml(url, ttlMs) {
  const r = await cachedHttpGet(url, {
    provider: 'ufcstats', ttlMs, headers: HEADERS,
    cacheKey: `ufcstats:${url}`
  }).catch(() => null);
  if (!r || r.status !== 200) return null;
  return String(r.body || '');
}

/**
 * Busca um fighter pelo nome.
 * Estratégia: query="Firstname" retorna todos com esse primeiro nome; filtra por match do nome completo.
 * @returns {Promise<{ id, name, record } | null>}
 */
async function searchFighter(fullName) {
  const name = String(fullName || '').trim();
  if (!name || name.length < 3) return null;

  const firstName = name.split(/\s+/)[0];
  const url = `http://ufcstats.com/statistics/fighters/search?query=${encodeURIComponent(firstName)}`;
  const html = await _fetchHtml(url, TTL_SEARCH);
  if (!html) return null;

  const rows = [...html.matchAll(/<tr class="b-statistics__table-row">([\s\S]{0,3000}?)<\/tr>/g)];
  const nNorm = _norm(name);
  for (const m of rows) {
    const row = m[1];
    const idMatch = row.match(/fighter-details\/([a-f0-9]+)/);
    if (!idMatch) continue;
    const id = idMatch[1];
    // Nome vem como "First / Last" em duas colunas separadas
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]{0,400}?)<\/td>/g)].map(t => t[1].replace(/<[^>]+>/g, '').trim());
    // tds[0] = first, tds[1] = last, tds[2] = nickname, rest = stats
    const firstTd = tds[0] || '';
    const lastTd = tds[1] || '';
    const fullRowName = `${firstTd} ${lastTd}`.trim();
    if (!fullRowName) continue;
    if (_norm(fullRowName) === nNorm || _norm(fullRowName).includes(nNorm) || nNorm.includes(_norm(fullRowName))) {
      const record = tds[7] || null; // W-L-D col
      return { id, name: fullRowName, record };
    }
  }
  return null;
}

/**
 * Extrai stats detalhadas de um fighter.
 * Label structure no HTML: <i class="b-list__box-item-title">SLpM:</i> 4.45
 * @returns {Promise<object | null>}
 */
async function getFighterStats(id) {
  const fid = String(id || '').trim();
  if (!/^[a-f0-9]+$/.test(fid)) return null;
  const html = await _fetchHtml(`http://ufcstats.com/fighter-details/${fid}`, TTL_FIGHTER);
  if (!html) return null;

  function extract(label) {
    const re = new RegExp(label.replace(/\./g, '\\.') + '[^<]*<\\/i>\\s*([^<]+)');
    const m = html.match(re);
    return m ? m[1].trim() : null;
  }

  const name = (html.match(/<span class="b-content__title-highlight">([^<]+)<\/span>/) || [])[1]?.trim() || null;
  const record = (html.match(/Record:\s*([0-9-]+)/) || [])[1] || null;

  const pct = v => {
    if (v == null) return null;
    const m = String(v).match(/([0-9.]+)/);
    return m ? parseFloat(m[1]) / 100 : null;
  };
  const num = v => {
    if (v == null) return null;
    const m = String(v).match(/([0-9.]+)/);
    return m ? parseFloat(m[1]) : null;
  };
  const inches = v => {
    if (!v || v.includes('--')) return null;
    const m = String(v).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  const heightToInches = v => {
    if (!v || v.includes('--')) return null;
    const m = String(v).match(/(\d+)'\s*(\d+)/);
    if (!m) return null;
    return parseInt(m[1], 10) * 12 + parseInt(m[2], 10);
  };

  return {
    id: fid,
    name,
    record,
    slpm: num(extract('SLpM')),         // Significant strikes landed per minute
    strAcc: pct(extract('Str. Acc.')),  // Striking accuracy %
    sapm: num(extract('SApM')),         // Significant strikes absorbed per minute
    strDef: pct(extract('Str. Def.')),  // Striking defense %
    tdAvg: num(extract('TD Avg.')),     // Takedowns per 15 min
    tdAcc: pct(extract('TD Acc.')),     // Takedown accuracy %
    tdDef: pct(extract('TD Def.')),     // Takedown defense %
    subAvg: num(extract('Sub. Avg.')),  // Submission attempts per 15 min
    reach: inches(extract('Reach:')),
    stance: extract('STANCE:'),
    height: heightToInches(extract('Height:')),
    weight: num(extract('Weight:')),
  };
}

/**
 * Conveniência: busca fighter + stats numa chamada.
 * @returns {Promise<object | null>}
 */
async function getFighterByName(name) {
  const hit = await searchFighter(name);
  if (!hit?.id) return null;
  const stats = await getFighterStats(hit.id);
  return stats || { id: hit.id, name: hit.name, record: hit.record };
}

module.exports = { searchFighter, getFighterStats, getFighterByName };

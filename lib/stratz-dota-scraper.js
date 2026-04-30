'use strict';

/**
 * lib/stratz-dota-scraper.js — STRATZ GraphQL API client.
 *
 * STRATZ é o referencial pra Dota 2 hero matchup data — rivaliza OpenDota.
 * Free tier: 100 req/min com Bearer token (https://stratz.com/api).
 * Sem token: ainda funciona com rate limit menor.
 *
 * Endpoints úteis:
 *   - heroMatchUps(heroId): vantagem disadvantage vs cada hero (winrate diff vs avg)
 *   - heroSummary(heroId): pickrate, winrate, banrate por bracket
 *   - itemBuild(heroId): meta build atual
 *
 * Inputs pro lib/dota-hero-features.js (predictMapWinner ±4pp draftShift hoje
 * usa OpenDota; STRATZ é mais granular).
 */

const https = require('https');

const GRAPHQL_URL = 'https://api.stratz.com/graphql';
const TIMEOUT_MS = 15000;

function _httpPostJson(url, body, headers) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const buf = Buffer.from(JSON.stringify(body));
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      path: u.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        'User-Agent': 'sportsedge-bot/1.0',
        ...(headers || {}),
      },
      timeout: TIMEOUT_MS,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.write(buf);
    req.end();
  });
}

function _stratzHeaders() {
  const token = (process.env.STRATZ_API_TOKEN || '').trim();
  if (token) return { 'Authorization': `Bearer ${token}` };
  return {};
}

async function _query(graphql, vars) {
  const r = await _httpPostJson(GRAPHQL_URL, { query: graphql, variables: vars }, _stratzHeaders());
  if (r.status !== 200) return { ok: false, status: r.status, body: r.body.slice(0, 200) };
  try {
    const parsed = JSON.parse(r.body);
    if (parsed.errors) return { ok: false, errors: parsed.errors };
    return { ok: true, data: parsed.data };
  } catch (e) { return { ok: false, parse_err: e.message }; }
}

/**
 * Hero matchup table: pra cada hero alvo, retorna vantagem (disadvantage) %
 * vs cada hero opositor — calculado via winrate diff entre matches em que
 * heroId encarou heroId2 vs winrate baseline de heroId.
 */
async function fetchHeroMatchups(heroId) {
  const graphql = `
    query HeroMatchups($heroId: Short!) {
      heroStats {
        heroVsHeroMatchup(heroId: $heroId) {
          advantage {
            heroId2
            synergy
            disadvantage
            winsAverage
          }
        }
      }
    }`;
  const r = await _query(graphql, { heroId });
  if (!r.ok) return r;
  const advs = r.data?.heroStats?.heroVsHeroMatchup?.advantage || [];
  return { ok: true, heroId, advantage: advs };
}

/**
 * Hero summary — pickrate, winrate atual.
 */
async function fetchHeroSummary(heroId) {
  const graphql = `
    query HeroSummary($heroId: Short!) {
      heroStats {
        winDay(heroIds: [$heroId], take: 7) { day winCount matchCount }
        winWeek(heroIds: [$heroId], take: 4) { week winCount matchCount }
      }
    }`;
  const r = await _query(graphql, { heroId });
  if (!r.ok) return r;
  return { ok: true, heroId, day: r.data?.heroStats?.winDay, week: r.data?.heroStats?.winWeek };
}

/**
 * Bulk: fetch matchups pra todos heroIds (1-145) e persiste.
 */
async function syncAllHeroMatchups(db, opts = {}) {
  const delay = opts.delayMs ?? 700; // ~85/min, dentro do limite
  const heroIds = opts.heroIds || Array.from({ length: 138 }, (_, i) => i + 1);

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO stratz_hero_matchups (
      hero_id, vs_hero_id, advantage, disadvantage, synergy, wins_avg, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let inserted = 0, errors = 0, skipped = 0;
  for (const hid of heroIds) {
    const r = await fetchHeroMatchups(hid);
    if (!r.ok) { errors++; await new Promise(res => setTimeout(res, delay)); continue; }
    if (!r.advantage || !r.advantage.length) { skipped++; await new Promise(res => setTimeout(res, delay)); continue; }
    try {
      const tx = db.transaction(() => {
        for (const a of r.advantage) {
          upsert.run(
            hid, a.heroId2,
            a.disadvantage != null ? -parseFloat(a.disadvantage) : null, // advantage = -disadvantage
            a.disadvantage != null ? parseFloat(a.disadvantage) : null,
            a.synergy != null ? parseFloat(a.synergy) : null,
            a.winsAverage != null ? parseFloat(a.winsAverage) : null
          );
          inserted++;
        }
      });
      tx();
    } catch (_) { errors++; }
    await new Promise(res => setTimeout(res, delay));
  }
  return { ok: true, inserted, errors, skipped, total_heroes: heroIds.length };
}

module.exports = { fetchHeroMatchups, fetchHeroSummary, syncAllHeroMatchups };

'use strict';

/**
 * ESPN basketball scoreboard — fonte gratuita (sem API key) pra results
 * finalizados e schedule upcoming. Espelha lib/espn-soccer.js.
 *
 * Endpoint: https://site.api.espn.com/apis/site/v2/sports/basketball/<league>/scoreboard?dates=YYYYMMDD
 *
 * Fase 1: NBA primário. WNBA + Euroleague + CBB ficam pra fase 2 quando shadow
 * NBA validar (n≥30 settled CLV≥0).
 */

const https = require('https');
const { log } = require('./utils');

// Fase 1: só NBA. Adicionar quando shadow validar:
//   'basketball/wnba', 'basketball/mens-college-basketball', 'basketball/euroleague'
const LEAGUES = [
  'nba',
];

function espnGet(path, { timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'site.api.espn.com',
      path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, body: j });
      });
    });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.end();
  });
}

function fmtYmd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function parseFinished(ev, leagueSlug) {
  try {
    const comp = Array.isArray(ev?.competitions) ? ev.competitions[0] : null;
    if (!comp) return null;
    const status = comp.status?.type?.name || comp.status?.type?.state;
    const completed = comp.status?.type?.completed === true
      || /STATUS_FINAL|post/i.test(String(status || ''));
    if (!completed) return null;
    const cps = Array.isArray(comp.competitors) ? comp.competitors : [];
    if (cps.length < 2) return null;
    const home = cps.find(c => c.homeAway === 'home') || cps[0];
    const away = cps.find(c => c.homeAway === 'away') || cps[1];
    const homeName = home?.team?.displayName || home?.team?.name || '';
    const awayName = away?.team?.displayName || away?.team?.name || '';
    const hs = parseInt(home?.score, 10);
    const as = parseInt(away?.score, 10);
    if (!homeName || !awayName || !Number.isFinite(hs) || !Number.isFinite(as)) return null;
    // No NBA não há empate (overtime resolve), mas guard defensivo.
    const winner = hs > as ? homeName : (as > hs ? awayName : null);
    if (!winner) return null;
    const tournament = ev?.league?.name || comp.league?.name || leagueSlug;
    const startIso = (ev?.date || '').replace('T', ' ').replace(/Z$/, '').slice(0, 19)
      || new Date().toISOString().slice(0, 19).replace('T', ' ');
    return {
      eventId: String(ev.id || `${leagueSlug}_${homeName}_${awayName}_${startIso}`),
      home: homeName, away: awayName,
      homeScore: hs, awayScore: as,
      winner, score: `${hs}-${as}`,
      startIso,
      tournament,
      leagueSlug,
    };
  } catch (_) { return null; }
}

function parseUpcoming(ev, leagueSlug) {
  try {
    const comp = Array.isArray(ev?.competitions) ? ev.competitions[0] : null;
    if (!comp) return null;
    const status = comp.status?.type?.state;
    // 'pre' = scheduled. 'in' = live. Ambos aceitos pra schedule (live tip path
    // pode ler tip já antes do tip-off + during).
    if (status !== 'pre' && status !== 'in') return null;
    const cps = Array.isArray(comp.competitors) ? comp.competitors : [];
    if (cps.length < 2) return null;
    const home = cps.find(c => c.homeAway === 'home') || cps[0];
    const away = cps.find(c => c.homeAway === 'away') || cps[1];
    const homeName = home?.team?.displayName || home?.team?.name || '';
    const awayName = away?.team?.displayName || away?.team?.name || '';
    if (!homeName || !awayName) return null;
    const startIso = (ev?.date || '').replace('T', ' ').replace(/Z$/, '').slice(0, 19);
    return {
      eventId: String(ev.id || `${leagueSlug}_${homeName}_${awayName}_${startIso}`),
      home: homeName,
      away: awayName,
      startIso,
      isLive: status === 'in',
      tournament: ev?.league?.name || comp.league?.name || leagueSlug,
      leagueSlug,
    };
  } catch (_) { return null; }
}

/**
 * Busca matches finalizados nos últimos `daysBack` dias.
 *
 * @param {object} opts
 * @param {number} opts.daysBack — N dias passados (default 3, max 14)
 * @param {Array<string>} [opts.leagues]
 * @returns {Promise<Array>}
 */
async function getFinishedMatches({ daysBack = 3, leagues = LEAGUES } = {}) {
  const out = [];
  const seen = new Set();
  const today = new Date();
  const backs = Math.max(1, Math.min(14, daysBack));
  let queries = 0, errors = 0;
  for (const league of leagues) {
    for (let i = 0; i <= backs; i++) {
      const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
      const ymd = fmtYmd(d);
      queries++;
      const r = await espnGet(`/apis/site/v2/sports/basketball/${league}/scoreboard?dates=${ymd}&limit=200`);
      if (r.status !== 200 || !r.body) { errors++; continue; }
      const events = Array.isArray(r.body?.events) ? r.body.events : [];
      for (const ev of events) {
        const parsed = parseFinished(ev, league);
        if (!parsed) continue;
        if (seen.has(parsed.eventId)) continue;
        seen.add(parsed.eventId);
        out.push(parsed);
      }
    }
  }
  if (errors > queries / 2) {
    log('WARN', 'ESPN-BASKET', `espn retornou erro em ${errors}/${queries} queries`);
  }
  return out;
}

/**
 * Busca matches scheduled (próximos `daysAhead` dias) + live agora.
 * Usado pelo scanner pré-jogo do bot.
 */
async function getUpcomingMatches({ daysAhead = 2, leagues = LEAGUES } = {}) {
  const out = [];
  const seen = new Set();
  const today = new Date();
  const ahead = Math.max(0, Math.min(7, daysAhead));
  let queries = 0, errors = 0;
  for (const league of leagues) {
    for (let i = 0; i <= ahead; i++) {
      const d = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
      const ymd = fmtYmd(d);
      queries++;
      const r = await espnGet(`/apis/site/v2/sports/basketball/${league}/scoreboard?dates=${ymd}&limit=200`);
      if (r.status !== 200 || !r.body) { errors++; continue; }
      const events = Array.isArray(r.body?.events) ? r.body.events : [];
      for (const ev of events) {
        const parsed = parseUpcoming(ev, league);
        if (!parsed) continue;
        if (seen.has(parsed.eventId)) continue;
        seen.add(parsed.eventId);
        out.push(parsed);
      }
    }
  }
  if (errors > queries / 2) {
    log('WARN', 'ESPN-BASKET', `espn upcoming erro em ${errors}/${queries} queries`);
  }
  return out;
}

module.exports = { getFinishedMatches, getUpcomingMatches, LEAGUES };

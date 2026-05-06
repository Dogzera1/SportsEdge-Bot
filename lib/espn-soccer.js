'use strict';

/**
 * ESPN soccer scoreboard — fonte gratuita (sem API key) pra resultados
 * finalizados. Fallback pro sofascore (que requer proxy + às vezes 403).
 *
 * Endpoint: https://site.api.espn.com/apis/site/v2/sports/soccer/<league>/scoreboard?dates=YYYYMMDD
 *
 * Cobertura: top ligas europeias + CONMEBOL + MLS + ligas nacionais populares.
 * Nem todas as ligas (ex: Superettan sueca, Liga J1, 2.Liga alemã) têm cobertura
 * profunda no ESPN — cruzar com sofascore maximiza hits.
 */

const https = require('https');
const { log } = require('./utils');

// League slugs no formato ESPN. Adicionar conforme cobertura necessária.
// Lista ordenada por volume esperado de tips (top leagues first → early exit se
// perf virar issue).
const LEAGUES = [
  // Top-5 europeias
  'eng.1',  // Premier League
  'esp.1',  // La Liga
  'ita.1',  // Serie A
  'ger.1',  // Bundesliga
  'fra.1',  // Ligue 1
  // Segunda divisão das top-5 (já apareceu na /void-audit: La Liga 2, Serie B, League 1)
  'eng.2',  // Championship
  'eng.3',  // League One
  'eng.4',  // League Two
  'esp.2',  // La Liga 2
  'ita.2',  // Serie B
  'ger.2',  // 2.Bundesliga
  'fra.2',  // Ligue 2
  // Copas europeias
  'uefa.champions',
  'uefa.europa',
  'uefa.europa.conf',
  'eng.fa',
  'eng.league_cup',
  'esp.copa_del_rey',
  'ita.coppa_italia',
  // América do Sul
  'bra.1',  // Brasileirão A
  'bra.2',  // Série B
  'conmebol.libertadores',
  'conmebol.sudamericana',
  'arg.1',
  // Outras populares
  'ned.1',
  'por.1',
  'tur.1',
  'bel.1',
  'mls',
  'sco.1',
  'uefa.nations',
  'fifa.worldq.uefa',
  'fifa.worldq.conmebol',
  // Escandinávia (Superettan apareceu no void-audit)
  'swe.1',
  'swe.2',  // Superettan
  'nor.1',
  'den.1',
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

function parseEvent(ev, leagueSlug) {
  try {
    const comp = Array.isArray(ev?.competitions) ? ev.competitions[0] : null;
    if (!comp) return null;
    const status = comp.status?.type?.name || comp.status?.type?.state;
    // 2026-05-06 FIX: regex /post/i casava POSTPONED/POST-MATCH-PENDING como
    // "completed" e ESPN às vezes traz score parcial → settle disparava win/loss
    // errado. Allowlist explícita de status finais reais.
    const statusU = String(status || '').toUpperCase();
    // STATUS_AGGREGATE NÃO incluído: trata-se de 2nd leg KO; score parcial,
    // settle correto exige aggregate score que ESPN scoreboard não fornece.
    const FINAL_STATUSES = new Set([
      'STATUS_FINAL', 'STATUS_FULL_TIME',
      'STATUS_FINAL_AET', 'STATUS_FINAL_PEN', 'STATUS_END_OF_REGULATION',
    ]);
    const completed = comp.status?.type?.completed === true && FINAL_STATUSES.has(statusU);
    if (!completed) return null;
    const cps = Array.isArray(comp.competitors) ? comp.competitors : [];
    if (cps.length < 2) return null;
    const home = cps.find(c => c.homeAway === 'home') || cps[0];
    const away = cps.find(c => c.homeAway === 'away') || cps[1];
    const homeName = home?.team?.displayName || home?.team?.name || '';
    const awayName = away?.team?.displayName || away?.team?.name || '';
    let hs = parseInt(home?.score, 10);
    let as = parseInt(away?.score, 10);
    // 2026-05-06: PEN/AET correction. Em STATUS_FINAL_PEN ESPN retorna score
    // INCLUINDO pênaltis (1-1 + 4-3 pen → home.score=5 / away.score=4).
    // Settle 1X2/OU/BTTS deveria usar score de regulamentar (90'). linescores
    // tem períodos: [1H, 2H, OT1, OT2, PEN]. Soma 1H+2H = regulamentar.
    const aet = statusU === 'STATUS_FINAL_AET';
    const pen = statusU === 'STATUS_FINAL_PEN';
    // 2026-05-06: STATUS_AGGREGATE (UCL/UEL 2nd leg) reporta score do leg atual,
    // não agregado. Tip 1X2 deveria ser settled pelo agregado (ida+volta) que
    // ESPN single-leg view não fornece. Drop matchResult silenciosamente —
    // settle cai no auto-void-stuck após cutoff. Memória + future fix:
    // ler comp.aggregateScore se ESPN expor.
    if (statusU === 'STATUS_AGGREGATE') return null;
    if (pen || aet) {
      try {
        const homeLs = Array.isArray(home?.linescores) ? home.linescores : [];
        const awayLs = Array.isArray(away?.linescores) ? away.linescores : [];
        // Períodos 1+2 = regulamentar (90'). 3+4 = OT halves. 5 = PEN.
        if (homeLs.length >= 2 && awayLs.length >= 2) {
          const reg1 = +(homeLs[0]?.value || 0) + +(homeLs[1]?.value || 0);
          const reg2 = +(awayLs[0]?.value || 0) + +(awayLs[1]?.value || 0);
          if (Number.isFinite(reg1) && Number.isFinite(reg2)) {
            hs = reg1; as = reg2;
          }
        }
      } catch (_) {}
    }
    if (!homeName || !awayName || !Number.isFinite(hs) || !Number.isFinite(as)) return null;
    // Winner em PEN é Draw regulamentar (1X2 settles como D); AET fica com winner real.
    const winner = pen ? 'Draw' : (hs > as ? homeName : (as > hs ? awayName : 'Draw'));
    const tournament = ev?.league?.name || comp.league?.name || leagueSlug;
    const startIso = (ev?.date || '').replace('T', ' ').replace(/Z$/, '').slice(0, 19)
      || new Date().toISOString().slice(0, 19).replace('T', ' ');
    // 2026-05-06: fallback eventId NÃO inclui leagueSlug — mesmo fixture
     // visível em 2 ligas (UCL + nacional) gerava 2 rows distintas em
    // match_results, dupando settle. Hash determinístico baseado em times+data.
    const _normT = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    const _dateOnly = startIso.slice(0, 10);
    const _fallbackId = `${_normT(homeName)}_${_normT(awayName)}_${_dateOnly}`;
    return {
      eventId: String(ev.id || _fallbackId),
      home: homeName, away: awayName,
      homeScore: hs, awayScore: as,
      winner, score: `${hs}-${as}`,
      aet, pen,
      startIso,
      tournament,
      leagueSlug,
    };
  } catch (_) { return null; }
}

/**
 * Busca matches finalizados nos últimos `daysBack` dias varrendo múltiplas ligas.
 * Retorna array no mesmo shape do sofascore.getFinishedMatches pra mesmo pipeline
 * de upsert em match_results.
 *
 * @param {object} opts
 * @param {number} opts.daysBack — N dias passados (default 3, max 14)
 * @param {Array<string>} [opts.leagues] — override da lista padrão
 * @returns {Promise<Array>}
 */
async function getFinishedMatches({ daysBack = 3, leagues = LEAGUES } = {}) {
  const out = [];
  const seen = new Set();
  const today = new Date();
  const dates = [];
  const backs = Math.max(1, Math.min(14, daysBack));
  for (let i = 0; i <= backs; i++) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    dates.push(fmtYmd(d));
  }
  // 2026-05-06: paralelização com concurrency=8 (era seq, 34 ligas × 4 dias =
  // 136 reqs × ~1-3s = minutos quando ESPN está lento). Concurrency 8 mantém
  // ESPN feliz e reduz latência total ~10x.
  const tasks = [];
  for (const league of leagues) {
    for (const ymd of dates) {
      tasks.push({ league, ymd });
    }
  }
  const _ESPN_CONCURRENCY = parseInt(process.env.ESPN_CONCURRENCY || '8', 10);
  let queries = 0, errors = 0;
  // Execute em batches de N concurrent
  for (let i = 0; i < tasks.length; i += _ESPN_CONCURRENCY) {
    const batch = tasks.slice(i, i + _ESPN_CONCURRENCY);
    const results = await Promise.all(batch.map(async ({ league, ymd }) => {
      queries++;
      const r = await espnGet(`/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${ymd}&limit=200`);
      if (r.status !== 200 || !r.body) { errors++; return { league, events: [] }; }
      return { league, events: Array.isArray(r.body?.events) ? r.body.events : [] };
    }));
    for (const { league, events } of results) {
      for (const ev of events) {
        const parsed = parseEvent(ev, league);
        if (!parsed) continue;
        const key = parsed.eventId;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(parsed);
      }
    }
  }
  if (errors > queries / 2) {
    log('WARN', 'ESPN-SOCCER', `espn retornou erro em ${errors}/${queries} queries — rede instável?`);
  }
  return out;
}

module.exports = { getFinishedMatches, LEAGUES };

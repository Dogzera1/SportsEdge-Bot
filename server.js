require('dotenv').config({ override: true });
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');
const initDatabase = require('./lib/database');
const { SPORTS, getSportById } = require('./lib/sports');
const { log, sendJson, safeParse, norm, httpGet, httpsPost, oddsApiAllowed } = require('./lib/utils');

// Railway sets $PORT automatically; start.js bridges it to SERVER_PORT
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT) || 3000;
const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
const ODDSPAPI_KEY = process.env.ODDS_API_KEY;  // Token da OddsPapi que já estava no seu .env
const LOL_KEY = process.env.LOL_API_KEY || '';
const PANDASCORE_TOKEN = process.env.PANDASCORE_TOKEN || '';

// DB_PATH allows pointing to a Railway volume (e.g. /data/sportsedge.db)
const fs = require('fs');
let DB_PATH = process.env.DB_PATH || 'sportsedge.db';
// Ensure the directory exists — fall back to local path if creation fails (no volume mounted)
try {
  const dbDir = path.dirname(path.resolve(DB_PATH));
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
} catch(e) {
  log('WARN', 'DB', `Não foi possível criar diretório para ${DB_PATH}: ${e.message}. Usando sportsedge.db local.`);
  DB_PATH = 'sportsedge.db';
}
const { db, stmts } = initDatabase(DB_PATH);

// Apenas Esports suportado — sem scrapers externos

// ── Odds Cache ──
const oddsCache = {};
let lastOddsUpdate = 0;
const ODDS_TTL = 4 * 60 * 60 * 1000; // 4h — conserves The Odds API monthly quota (500 req free tier)

// Esports odds: OddsPapi (free 250 req/mês). TTL 6h + tournament cache 24h ≈ 180 req/mês
let lastEsportsOddsUpdate = 0;
let lastApiResponse = ''; // Para diagnóstico
let esportsOddsFetching = false;
const ESPORTS_ODDS_TTL = 20 * 60 * 1000; // 20m — ~72 fetches/dia para Line Shopping

// Tournament ID cache: refresh once per 24h (saves 2 req/dia)
const TOURNAMENT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h



let lastAnalysisAt = null; // ISO timestamp of last successful auto-analysis cycle


// ── LoL Esports ──
const LOL_BASE = 'https://esports-api.lolesports.com/persisted/gw';
const LOL_LEAGUES = new Set([
  'worlds', 'msi', 'lcs', 'lck', 'lec', 'lpl', 'cblol-brazil', 'lla', 'pcs',
  'lco', 'vcs', 'ljl-japan', 'emea_masters', 'lfl', 'nlc', 'lta_n', 'lta_s',
  'turkiye-sampiyonluk-ligi', 'first_stand', 'americas_cup', 'lcp', 'nacl',
  'lck_challengers_league', 'primeleague', 'liga_portuguesa', 'lit', 'les',
  'hitpoint_masters', 'esports_balkan_league', 'hellenic_legends_league', 'lta_cross',
  // Road to EWC — slugs possíveis (Riot pode usar qualquer um destes)
  'road_to_ewc', 'road_to_ewc_lpl', 'road_to_ewc_lck', 'road_to_ewc_lec',
  'road_to_ewc_lcs', 'road_to_ewc_cblol', 'road_to_ewc_lcp',
  'ewc', 'ewc_lpl', 'esports_world_cup', 'esports_world_cup_lpl',
  // Slugs extras configuráveis via .env (ex: LOL_EXTRA_LEAGUES=slug1,slug2)
  ...(process.env.LOL_EXTRA_LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean),
]);

// Slugs vistos mas não reconhecidos — logados para diagnóstico
const unknownLolSlugs = new Set();

// ── Odds APIs ──
async function fetchOdds(sport) {
  if (sport === 'esports') return await fetchEsportsOdds();
  // Apenas Esports é suportado
}

// The Odds API 429 backoff state
let esportsBackoffUntil = 0;
const ESPORTS_BACKOFF_TTL = 2 * 60 * 60 * 1000; // 2h backoff on 429

async function fetchEsportsOdds() {
  if (!ODDSPAPI_KEY) return;
  if (esportsOddsFetching) return;
  const now = Date.now();
  
  if (now - lastEsportsOddsUpdate < 10 * 60 * 1000) return;

  esportsOddsFetching = true;
  lastApiResponse = 'Conectando ao v4...';
  try {
    let cachedCount = 0;
    // Baseado nos IDs que você me mandou e no Guia
    const tids = [2450, 2452, 2454, 26590, 26698, 33814, 36997, 39009, 39985, 45589, 45623, 45985, 46117, 46119, 46121, 47864, 50242, 50586];
    const tidString = tids.join(',');
    
    // Padrão do Guia (Página 3): apiKey (CamelCase), host api.oddspapi.io, v4
    const url = `https://api.oddspapi.io/v4/odds-by-tournaments?bookmaker=1xbet&tournamentIds=${tidString}&apiKey=${ODDSPAPI_KEY}`;
    
    const r = await httpGet(url).catch(e => ({ status: 500, body: e.message }));
    
    log('DEBUG', 'ODDS', `v4 Result - Status: ${r.status} | Body Snippet: ${(r.body||'').slice(0, 100)}`);
    lastApiResponse = `v4 Status: ${r.status} | Body: ${(r.body||'').slice(0, 150)}`;

    if (r.status === 200) {
      const raw = safeParse(r.body, {});
      const tournamentList = Array.isArray(raw) ? raw : (raw.data || []);
      
      for (const t of tournamentList) {
        if (!t.fixtures) continue;
        for (const f of t.fixtures) {
          if (!f.bookmakerOdds || !f.bookmakerOdds['1xbet']) continue;
          
          const bkData = f.bookmakerOdds['1xbet'];
          const p1Name = f.participant1Name || f.homeName || '';
          const p2Name = f.participant2Name || f.awayName || '';
          if (!p1Name || !p2Name) continue;

          // Normalização Seguindo o Guia (Páginas 4 e 6)
          // Percorre markets -> outcomes -> players
          const markets = bkData.markets || {};
          let oddsFound = { t1: null, t2: null };

          for (const [mid, mData] of Object.entries(markets)) {
            // Market ID 1, 183 ou 101 (Match Winner)
            if (mid === '1' || mid === '183' || mid === '101' || mData.bookmakerMarketId === '1') {
              const outcomes = mData.outcomes || {};
              const outcomesArr = Object.values(outcomes);
              
              if (outcomesArr.length >= 2) {
                try {
                  // Extrai preços seguindo o aninhamento do guia
                  const price1 = outcomesArr[0].players?.['0']?.price || outcomesArr[0].price;
                  const price2 = outcomesArr[1].players?.['0']?.price || outcomesArr[1].price;
                  if (price1 && price2) {
                    oddsFound.t1 = parseFloat(price1).toFixed(2);
                    oddsFound.t2 = parseFloat(price2).toFixed(2);
                    break; // Pegamos o primeiro mercado ML disponível
                  }
                } catch(e) {}
              }
            }
          }

          if (oddsFound.t1 && oddsFound.t2) {
            const entry = { ...oddsFound, bookmaker: '1xBet', t1Name: p1Name, t2Name: p2Name };
            const nameKey = f.fixtureId || `${norm(p1Name)}_${norm(p2Name)}`;
            oddsCache[`esports_${nameKey}`] = entry;
            cachedCount++;
          }
        }
      }
    }
    
    log('INFO', 'ODDS', `v4 PDF Pattern Sync: ${cachedCount} partidas em cache.`);
    lastEsportsOddsUpdate = Date.now();
  } catch(e) {
    log('ERROR', 'ODDS', `PDF Sync Error: ${e.message}`);
  } finally {
    esportsOddsFetching = false;
  }
}

// ── Suporte a Apelidos/Abreviações de Times ──
const LOL_ALIASES = {
  'nongshimredforce': ['ns', 'nongshim', 'nsredforce'],
  'hanwhalifeesports': ['hle', 'hanwha', 'hanwhalife'],
  'dpluskia': ['dk', 'dplus', 'dwg', 'damwon'],
  'ktrolster': ['kt'],
  'geng': ['gen', 'gengolden'],
};

function findOdds(sport, t1, t2) {
  const nt1 = norm(t1), nt2 = norm(t2);
  
  // Função auxiliar para verificar match com apelidos
  const isMatch = (orig, targetSlug) => {
    if (!orig || !targetSlug) return false;
    if (targetSlug.includes(orig)) return true;
    // Procura nos aliases
    for (const [key, aliases] of Object.entries(LOL_ALIASES)) {
      if (orig.includes(key) || key.includes(orig)) {
        if (aliases.some(a => targetSlug.includes(a))) return true;
      }
    }
    return false;
  };

  for (const [cacheKey, val] of Object.entries(oddsCache)) {
    if (!cacheKey.startsWith(`${sport}_`)) continue;
    if (!val.t1Name || !val.t2Name) continue;
    const vt1 = norm(val.t1Name);
    const vt2 = norm(val.t2Name);

    // Ordem normal: query-t1 bate com cache-t1 E query-t2 bate com cache-t2
    if (isMatch(nt1, vt1) && isMatch(nt2, vt2)) {
      return { t1: val.t1, t2: val.t2, bookmaker: val.bookmaker };
    }
    // Ordem invertida: times podem estar trocados no cache vs. query
    if (isMatch(nt1, vt2) && isMatch(nt2, vt1)) {
      return { t1: val.t2, t2: val.t1, bookmaker: val.bookmaker };
    }
  }
  return null;
}

// ── LoL Matches ──
function mapLoLEvent(e, status) {
  const t1 = e.match?.teams?.[0], t2 = e.match?.teams?.[1];
  const n1 = t1?.name || t1?.code || '', n2 = t2?.name || t2?.code || '';
  if (!n1 && !n2) return null;
  const slug = e.league?.slug || '';
  if (!LOL_LEAGUES.has(slug)) {
    // Loga slug desconhecido uma vez para facilitar diagnóstico
    if (slug && !unknownLolSlugs.has(slug)) {
      unknownLolSlugs.add(slug);
      log('WARN', 'LOL-SLUG', `Liga ignorada: slug="${slug}" nome="${e.league?.name || ''}" — adicione ao LOL_EXTRA_LEAGUES no .env se quiser cobrir`);
    }
    return null;
  }

  return {
    id: e.match?.id || Date.now().toString(),
    game: 'lol',
    league: e.league?.name || 'LoL Esports',
    team1: n1 || 'TBD',
    team2: n2 || 'TBD',
    score1: t1?.result?.gameWins ?? 0,
    score2: t2?.result?.gameWins ?? 0,
    status,
    time: e.startTime || '',
    format: e.match?.strategy?.type === 'bestOf' ? 'Bo' + e.match.strategy.count : '',
    winner: t1?.result?.outcome === 'win' ? n1 : t2?.result?.outcome === 'win' ? n2 : null
  };
}

async function getLoLMatches() {
  try {
    let live = [], upcoming = [];
    let mainEvs = [], newerToken = null;

    try {
      const sr = await httpGet(LOL_BASE + '/getSchedule?hl=pt-BR', { 'x-api-key': LOL_KEY });
      const sd = safeParse(sr.body, {});
      mainEvs = sd?.data?.schedule?.events || [];
      newerToken = sd?.data?.schedule?.pages?.newer;
    } catch(e) { log('WARN', 'LOL', 'Schedule err: ' + e.message); }

    // Detectar ligas com transmissão ao vivo
    const liveLeagues = new Set();
    mainEvs.filter(e => e.type === 'show' && e.state === 'inProgress' && LOL_LEAGUES.has(e.league?.slug))
      .forEach(e => { if (e.league?.name) liveLeagues.add(e.league.name); });

    // Matches explicitamente inProgress
    live = mainEvs.filter(e => e.type === 'match' && e.match && e.state === 'inProgress')
      .map(e => mapLoLEvent(e, 'live')).filter(Boolean);

    // Matches com score parcial em ligas com transmissão ao vivo = LIVE
    const liveFromShows = mainEvs.filter(e => {
      if (e.type !== 'match' || !e.match || e.state !== 'unstarted') return false;
      if (!liveLeagues.has(e.league?.name)) return false;
      const t1 = e.match.teams?.[0], t2 = e.match.teams?.[1];
      const w1 = t1?.result?.gameWins || 0, w2 = t2?.result?.gameWins || 0;
      if (w1 === 0 && w2 === 0) return false;
      const boCount = e.match.strategy?.count || 3;
      const winsNeeded = Math.ceil(boCount / 2);
      return !(w1 >= winsNeeded || w2 >= winsNeeded);
    }).map(e => mapLoLEvent(e, 'live')).filter(Boolean);
    liveFromShows.forEach(m => { if (!live.find(l => l.id === m.id)) live.push(m); });

    // Matches sem score dentro de transmissão ao vivo = draft
    const upcomingInShow = mainEvs.filter(e => {
      if (e.type !== 'match' || !e.match || e.state !== 'unstarted') return false;
      if (!liveLeagues.has(e.league?.name)) return false;
      const t1 = e.match.teams?.[0], t2 = e.match.teams?.[1];
      return (t1?.result?.gameWins || 0) === 0 && (t2?.result?.gameWins || 0) === 0;
    }).map(e => mapLoLEvent(e, 'draft')).filter(Boolean);

    upcoming = mainEvs.filter(e =>
      e.type === 'match' && e.match && e.state === 'unstarted' && !liveLeagues.has(e.league?.name)
    ).map(e => mapLoLEvent(e, 'upcoming')).filter(Boolean);
    upcoming = [...upcomingInShow, ...upcoming];

    try {
      const glr = await httpGet(LOL_BASE + '/getLive?hl=pt-BR', { 'x-api-key': LOL_KEY });
      const gld = safeParse(glr.body, {});
      const getLiveEvts = gld?.data?.schedule?.events || [];
      getLiveEvts.filter(e => e.type === 'match' && e.match)
        .map(e => mapLoLEvent(e, 'live')).filter(Boolean)
        .forEach(m => { if (!live.find(l => l.id === m.id)) live.push(m); });
      getLiveEvts.filter(e => e.type === 'show' && e.state === 'inProgress')
        .forEach(e => { if (e.league?.name) liveLeagues.add(e.league.name); });
    } catch(e) { log('WARN', 'LOL', 'getLive err: ' + e.message); }

    if (!upcoming.length && newerToken) {
      try {
        const nr = await httpGet(LOL_BASE + '/getSchedule?hl=pt-BR&pageToken=' + encodeURIComponent(newerToken), { 'x-api-key': LOL_KEY });
        const nd = safeParse(nr.body, {});
        upcoming = (nd?.data?.schedule?.events || [])
          .filter(e => e.type === 'match' && e.match && e.state !== 'completed')
          .map(e => mapLoLEvent(e, 'upcoming')).filter(Boolean);
      } catch(_) {}
    }

    const result = [...live, ...upcoming]
      .filter((m, i, a) => m && !(m.team1 === 'TBD' && m.team2 === 'TBD') && a.findIndex(x => x.id === m.id) === i)
      .sort((a, b) => {
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (b.status === 'live' && a.status !== 'live') return 1;
        if (a.status === 'draft' && b.status !== 'draft') return -1;
        if (b.status === 'draft' && a.status !== 'draft') return 1;
        return new Date(a.time) - new Date(b.time);
      })
      .slice(0, 25);

    await fetchOdds('esports');
    result.forEach(m => {
      const o = findOdds('esports', m.team1, m.team2);
      if (o) m.odds = o;
    });

    log('INFO', 'LOL', `${result.length} partidas (${live.length} live, ${upcoming.filter(m=>m.status==='draft').length} draft)`);
    return result;
  } catch(e) {
    log('ERROR', 'LOL', e.message);
    return [];
  }
}

// ── PandaScore LoL (cobre torneios fora do lolesports.com, ex: EWC Qualifier China) ──
async function getPandaScoreLolMatches() {
  if (!PANDASCORE_TOKEN || PANDASCORE_TOKEN === 'your-pandascore-token') return [];
  try {
    const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
    const [runningRaw, upcomingRaw] = await Promise.all([
      httpGet('https://api.pandascore.co/lol/matches/running?per_page=20', headers).catch(() => ({ body: '[]' })),
      httpGet('https://api.pandascore.co/lol/matches/upcoming?per_page=30&sort=begin_at', headers).catch(() => ({ body: '[]' }))
    ]);

    const running = safeParse(runningRaw.body, []);
    const upcoming = safeParse(upcomingRaw.body, []);

    function mapPS(m, status) {
      const t1 = m.opponents?.[0]?.opponent, t2 = m.opponents?.[1]?.opponent;
      const n1 = t1?.name || 'TBD', n2 = t2?.name || 'TBD';
      if (n1 === 'TBD' && n2 === 'TBD') return null;
      const leagueName = m.league?.name || m.serie?.full_name || 'LoL';
      const format = m.number_of_games > 1 ? `Bo${m.number_of_games}` : '';

      // Placar a partir dos games
      let s1 = 0, s2 = 0;
      if (Array.isArray(m.games)) {
        for (const g of m.games) {
          if (!g.winner) continue;
          if (g.winner.id === t1?.id) s1++;
          else if (g.winner.id === t2?.id) s2++;
        }
      }

      return {
        id: `ps_${m.id}`,
        game: 'lol',
        league: leagueName,
        team1: n1, team2: n2,
        score1: s1, score2: s2,
        status,
        time: m.begin_at || '',
        format,
        winner: m.winner?.name || null,
        _source: 'pandascore'
      };
    }

    const live = running.map(m => mapPS(m, 'live')).filter(Boolean);
    const next = upcoming
      .filter(m => {
        const t = new Date(m.begin_at).getTime();
        return !isNaN(t) && t < Date.now() + 7 * 24 * 3600 * 1000; // próximos 7 dias
      })
      .map(m => mapPS(m, 'upcoming')).filter(Boolean);

    const psMatches = [...live, ...next];
    if (psMatches.length) {
      log('INFO', 'PANDASCORE', `${psMatches.length} partidas LoL (${live.length} live)`);
    }
    return psMatches;
  } catch(e) {
    log('WARN', 'PANDASCORE', 'Erro: ' + e.message);
    return [];
  }
}

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  // Global safety net — prevents hanging requests on unhandled async errors
  res.on('error', (e) => log('ERROR', 'RES', e.message));
  try {

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-claude-key, x-sport'
    });
    res.end();
    return;
  }

  // ── Esports Endpoints (sem scrapers) ──
  if (p === '/lol-matches') {
    // Busca em paralelo: API Riot (lolesports) + PandaScore (cobre LPL China e outros)
    const [riotMatches, psMatches] = await Promise.all([
      getLoLMatches(),
      getPandaScoreLolMatches()
    ]);

    // Mescla deduplicando por nomes de times (PandaScore não sobrescreve Riot)
    const combined = [...riotMatches];
    for (const pm of psMatches) {
      const n1 = norm(pm.team1), n2 = norm(pm.team2);
      const alreadyExists = combined.some(r =>
        (norm(r.team1).includes(n1) || n1.includes(norm(r.team1))) &&
        (norm(r.team2).includes(n2) || n2.includes(norm(r.team2)))
      );
      if (!alreadyExists) {
        const o = findOdds('esports', pm.team1, pm.team2);
        if (o) pm.odds = o;
        combined.push(pm);
      }
    }

    // Reordena: live primeiro, depois por horário
    combined.sort((a, b) => {
      if (a.status === 'live' && b.status !== 'live') return -1;
      if (b.status === 'live' && a.status !== 'live') return 1;
      return new Date(a.time) - new Date(b.time);
    });

    sendJson(res, combined.slice(0, 30));
    return;
  }

  if (p === '/lol-slugs') {
    // Retorna slugs ativos (na whitelist) e slugs desconhecidos vistos no schedule
    sendJson(res, {
      allowed: [...LOL_LEAGUES],
      unknown_seen: [...unknownLolSlugs],
      hint: 'Adicione slugs desconhecidos ao LOL_EXTRA_LEAGUES no .env para cobri-los'
    });
    return;
  }

  if (p === '/lol-raw') {
    // Debug: retorna todos os eventos brutos do schedule (sem filtro de liga)
    try {
      const sr = await httpGet(LOL_BASE + '/getSchedule?hl=pt-BR', { 'x-api-key': LOL_KEY });
      const sd = safeParse(sr.body, {});
      const evs = sd?.data?.schedule?.events || [];

      // Busca getLive também
      let liveEvs = [];
      try {
        const glr = await httpGet(LOL_BASE + '/getLive?hl=pt-BR', { 'x-api-key': LOL_KEY });
        liveEvs = safeParse(glr.body, {})?.data?.schedule?.events || [];
      } catch(_) {}

      const allEvs = [...evs, ...liveEvs];

      // Agrupa por liga
      const byLeague = {};
      for (const e of allEvs) {
        const slug = e.league?.slug || '(sem slug)';
        const name = e.league?.name || '?';
        if (!byLeague[slug]) byLeague[slug] = { name, count: 0, states: {}, inWhitelist: LOL_LEAGUES.has(slug), sample: null };
        byLeague[slug].count++;
        byLeague[slug].states[e.state || 'unknown'] = (byLeague[slug].states[e.state || 'unknown'] || 0) + 1;
        if (!byLeague[slug].sample && e.type === 'match' && e.match) {
          const t1 = e.match.teams?.[0], t2 = e.match.teams?.[1];
          byLeague[slug].sample = `${t1?.name || t1?.code || 'TBD'} vs ${t2?.name || t2?.code || 'TBD'} [${e.state}]`;
        }
      }

      sendJson(res, { total_events: allEvs.length, by_league: byLeague });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/live-gameids') {
    try {
      const matchId = parsed.query.matchId;
      const games = [];
      if (matchId) {
        const dr = await httpGet(`${LOL_BASE}/getEventDetails?hl=pt-BR&id=${matchId}`, { 'x-api-key': LOL_KEY });
        const dd = safeParse(dr.body, {});
        const match = dd?.data?.event?.match;
        if (match?.games) {
          const t1 = match.teams?.[0]?.name, t2 = match.teams?.[1]?.name;
          for (const g of match.games) {
            if (!g.id || g.state === 'completed') continue;
            games.push({ gameId: g.id, matchId, team1: t1, team2: t2, gameNumber: g.number, hasLiveData: g.state === 'inProgress' });
          }
        }
      }
      sendJson(res, games);
    } catch(e) {
      log('ERROR', 'LIVE-IDS', e.message);
      sendJson(res, []);
    }
    return;
  }

  // ── PandaScore: composições de LoL (para matches com id ps_xxx) ──
  if (p === '/ps-compositions') {
    const rawId = parsed.query.matchId || '';
    const psId = rawId.replace(/^ps_/, '');
    if (!psId || !PANDASCORE_TOKEN || PANDASCORE_TOKEN === 'your-pandascore-token') {
      sendJson(res, { hasCompositions: false, error: 'Token PandaScore não configurado' });
      return;
    }
    try {
      const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
      const r = await httpGet(`https://api.pandascore.co/lol/matches/${psId}`, headers);
      if (r.status !== 200) {
        sendJson(res, { hasCompositions: false, error: `PS status ${r.status}` });
        return;
      }
      const m = safeParse(r.body, {});
      const ops = m.opponents || [];
      const t1 = ops[0]?.opponent, t2 = ops[1]?.opponent;
      const games = Array.isArray(m.games) ? m.games : [];

      // Pega o game em andamento ou o mais recente
      const activeGame = games.find(g => g.status === 'running') || games[games.length - 1];
      if (!activeGame) {
        sendJson(res, { hasCompositions: false, error: 'Nenhum game disponível' });
        return;
      }

      // Placar da série (quantos games cada time venceu)
      let s1 = 0, s2 = 0;
      for (const g of games) {
        if (!g.winner) continue;
        if (g.winner.id === t1?.id) s1++;
        else if (g.winner.id === t2?.id) s2++;
      }

      // Jogadores do game ativo
      const players = Array.isArray(activeGame.players) ? activeGame.players : [];

      function buildTeam(teamObj, side) {
        const teamId = teamObj?.id;
        const teamPlayers = players
          .filter(pl => pl.team_id === teamId || pl.side === side)
          .map(pl => ({
            role: pl.role || '?',
            name: pl.player?.name || pl.name || '?',
            champion: pl.champion?.name || pl.champion_id || '?',
            kills: pl.kills || 0,
            deaths: pl.deaths || 0,
            assists: pl.assists || 0,
            gold: pl.total_gold || 0,
            cs: pl.minions_killed || 0
          }));
        return { name: teamObj?.name || side, players: teamPlayers };
      }

      const blueTeam = buildTeam(t1, 'blue');
      const redTeam = buildTeam(t2, 'red');

      // Stats do game ativo (se running)
      const hasLiveStats = activeGame.status === 'running' && players.some(pl => pl.total_gold > 0);
      const totalGoldBlue = blueTeam.players.reduce((s, pl) => s + pl.gold, 0);
      const totalGoldRed = redTeam.players.reduce((s, pl) => s + pl.gold, 0);

      sendJson(res, {
        matchId: rawId,
        hasCompositions: blueTeam.players.length > 0 || redTeam.players.length > 0,
        hasLiveStats,
        gameNumber: activeGame.position || 1,
        seriesScore: `${s1}-${s2}`,
        gameStatus: activeGame.status || 'unknown',
        blueTeam: { ...blueTeam, totalGold: totalGoldBlue, towerKills: 0, dragons: 0 },
        redTeam: { ...redTeam, totalGold: totalGoldRed, towerKills: 0, dragons: 0 },
        _source: 'pandascore'
      });
    } catch(e) {
      log('ERROR', 'PS-COMPS', e.message);
      sendJson(res, { hasCompositions: false, error: e.message });
    }
    return;
  }

  if (p === '/live-game') {
    const gameId = parsed.query.gameId;
    if (!gameId) { sendJson(res, { error: 'Missing gameId' }, 400); return; }
    try {
      const base = `https://feed.lolesports.com/livestats/v1/window/${gameId}`;

      // 1) Buscar metadata do jogo (times, campeões, etc)
      let wr = await httpGet(base, { 'x-api-key': LOL_KEY });
      if (wr.status === 403) wr = await httpGet(base, {});
      if (wr.status !== 200) {
        sendJson(res, { error: 'Game not found: ' + wr.status, hasLiveStats: false }, 404);
        return;
      }
      const raw = safeParse(wr.body, {});

      // 2) Buscar dados mais recentes — ~90s atrás (timestamps divisíveis por 10s)
      let frames = [];
      const recentTs = new Date(Math.floor((Date.now() - 90000) / 10000) * 10000).toISOString();
      const wr2 = await httpGet(`${base}?startingTime=${encodeURIComponent(recentTs)}`, {});
      if (wr2.status === 200) {
        const raw2 = safeParse(wr2.body, {});
        frames = raw2.frames || [];
      }

      // 3) Se não achou dados recentes, tenta 3min e 5min atrás
      if (!frames.length || !frames.some(f => f.blueTeam?.totalGold > 0)) {
        for (const secAgo of [180, 300]) {
          const ts = new Date(Math.floor((Date.now() - secAgo * 1000) / 10000) * 10000).toISOString();
          const r3 = await httpGet(`${base}?startingTime=${encodeURIComponent(ts)}`, {});
          if (r3.status === 200) {
            const d3 = safeParse(r3.body, {});
            if (d3.frames?.length && d3.frames.some(f => f.blueTeam?.totalGold > 0)) {
              frames = d3.frames;
              break;
            }
          }
        }
      }

      // 4) Último recurso: usar frames iniciais
      if (!frames.length) frames = raw.frames || [];

      const blue = raw.gameMetadata?.blueTeamMetadata;
      const red = raw.gameMetadata?.redTeamMetadata;
      // Frame com mais gold = mais recente com dados reais
      const best = frames.length
        ? frames.reduce((b, f) => ((f.blueTeam?.totalGold || 0) > (b?.blueTeam?.totalGold || 0) ? f : b), frames[frames.length - 1])
        : null;
      const frameAge = best?.rfc460Timestamp
        ? Math.round((Date.now() - new Date(best.rfc460Timestamp).getTime()) / 1000)
        : null;
      const gameState = best?.gameState || 'in_progress';
      const hasLiveStats = !!(best?.blueTeam?.totalGold > 0);

      // Lookup de participantes por participantId (correto)
      function mkLookup(teamFrame) {
        const lk = {};
        (teamFrame?.participants || []).forEach(p => {
          if (p.participantId !== undefined) lk[p.participantId] = p;
        });
        return lk;
      }
      const blk = mkLookup(best?.blueTeam), rlk = mkLookup(best?.redTeam);

      function mp(meta, lk) {
        const s = lk[meta.participantId] || {};
        return {
          role: meta.role,
          name: meta.esportsPlayer?.summonerName || meta.summonerName || '?',
          champion: meta.championId,
          level: s.level || 0,
          kills: s.kills || 0,
          deaths: s.deaths || 0,
          assists: s.assists || 0,
          gold: s.totalGold || s.totalGoldEarned || 0,
          cs: s.creepScore || 0
        };
      }

      // Gold trajectory — ~15 pontos de dados
      const goldTrajectory = [];
      if (frames.length > 1) {
        const step = Math.max(1, Math.floor(frames.length / 15));
        for (let i = 0; i < frames.length; i += step) {
          const f = frames[i];
          const blueGold = f.blueTeam?.totalGold || 0;
          const redGold = f.redTeam?.totalGold || 0;
          if (blueGold > 0 || redGold > 0) {
            const gameTime = f.gameState === 'in_game'
              ? Math.round((new Date(f.rfc460Timestamp || 0).getTime() - new Date(frames[0]?.rfc460Timestamp || 0).getTime()) / 60000)
              : i;
            goldTrajectory.push({ minute: gameTime, diff: blueGold - redGold, blue: blueGold, red: redGold });
          }
        }
      }

      sendJson(res, {
        gameId,
        gameState,
        hasLiveStats,
        framesTotal: frames.length,
        dataDelay: frameAge,
        goldTrajectory,
        blueTeam: {
          name: blue?.esportsTeam?.name || 'Blue',
          totalGold: best?.blueTeam?.totalGold || 0,
          towerKills: best?.blueTeam?.towers || 0,
          dragons: Array.isArray(best?.blueTeam?.dragons) ? best.blueTeam.dragons.length : (best?.blueTeam?.dragons || 0),
          dragonTypes: Array.isArray(best?.blueTeam?.dragons) ? best.blueTeam.dragons : [],
          barons: best?.blueTeam?.barons || 0,
          totalKills: best?.blueTeam?.totalKills || 0,
          inhibitors: best?.blueTeam?.inhibitors || 0,
          players: (blue?.participantMetadata || []).map(m => mp(m, blk))
        },
        redTeam: {
          name: red?.esportsTeam?.name || 'Red',
          totalGold: best?.redTeam?.totalGold || 0,
          towerKills: best?.redTeam?.towers || 0,
          dragons: Array.isArray(best?.redTeam?.dragons) ? best.redTeam.dragons.length : (best?.redTeam?.dragons || 0),
          dragonTypes: Array.isArray(best?.redTeam?.dragons) ? best.redTeam.dragons : [],
          barons: best?.redTeam?.barons || 0,
          totalKills: best?.redTeam?.totalKills || 0,
          inhibitors: best?.redTeam?.inhibitors || 0,
          players: (red?.participantMetadata || []).map(m => mp(m, rlk))
        }
      });
    } catch(e) {
      log('ERROR', 'LIVE-GAME', e.message);
      sendJson(res, { error: e.message, hasLiveStats: false }, 500);
    }
    return;
  }

  if (p === '/health') {
    const sport = 'esports';
    const dbOk = (() => {
      try {
        stmts.getDBStatus.get(sport, sport, sport, sport, sport, sport);
        return true;
      } catch(_) {
        return false;
      }
    })();
    const pendingRow = db.prepare("SELECT COUNT(*) as c FROM tips WHERE sport='esports' AND result IS NULL").get();
    const esportsOddsAge = lastEsportsOddsUpdate > 0 ? Math.round((Date.now() - lastEsportsOddsUpdate) / 60000) : null;
    const stale = !lastAnalysisAt || (Date.now() - new Date(lastAnalysisAt).getTime() > 2 * 60 * 60 * 1000);
    const status = dbOk ? (stale ? 'degraded' : 'ok') : 'error';
    sendJson(res, {
      status,
      sport: 'esports',
      db: dbOk ? 'connected' : 'error',
      lastAnalysis: lastAnalysisAt,
      pendingTips: pendingRow?.c || 0,
      oddsLastUpdate: esportsOddsAge !== null ? `${esportsOddsAge}min ago` : 'never',
      oddsCacheSize: Object.keys(oddsCache).filter(k => k.startsWith('esports_')).length
    });
    return;
  }

  if (p === '/record-analysis' && req.method === 'POST') {
    lastAnalysisAt = new Date().toISOString();
    sendJson(res, { ok: true });
    return;
  }

  if (p === '/match-result') {
    const matchId = parsed.query.matchId || '';
    const game = parsed.query.game || 'lol';
    try {
      const sr = await httpGet(LOL_BASE + '/getSchedule?hl=pt-BR', { 'x-api-key': LOL_KEY });
      const sd = safeParse(sr.body, {});
      const events = sd?.data?.schedule?.events || [];
      const ev = events.find(e => e.match?.id === matchId && e.state === 'completed');
      if (ev) {
        const t1 = ev.match.teams?.[0], t2 = ev.match.teams?.[1];
        const winner = t1?.result?.outcome === 'win' ? t1.name : t2?.result?.outcome === 'win' ? t2.name : null;
        if (winner) {
          stmts.upsertMatchResult.run(matchId, 'lol', t1?.name||'', t2?.name||'', winner, `${t1?.result?.gameWins||0}-${t2?.result?.gameWins||0}`, ev.league?.name||'');
          sendJson(res, { matchId, game, winner, resolved: true });
          return;
        }
      }
      sendJson(res, { matchId, game, resolved: false });
    } catch(e) {
      sendJson(res, { matchId, game, resolved: false, error: e.message });
    }
    return;
  }

  sendJson(res, { error: 'Not found' }, 404);
  } catch(e) {
    log('ERROR', 'SERVER', `Unhandled in ${p}: ${e.message}`);
    if (!res.headersSent) sendJson(res, { error: e.message }, 500);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', 'SERVER', `SportsEdge API em http://0.0.0.0:${PORT}`);
  log('INFO', 'SERVER', `Esportes: LoL (Riot API + PandaScore)`);

  // Inicialização e Loop de Cache de Odds (OddsPapi 1xBet)
  fetchEsportsOdds(); // Busca imediata ao ligar
  setInterval(() => {
    fetchEsportsOdds();
  }, 15 * 60 * 1000); // Mantém o cache quente a cada 15 min

  // Cleanup de DB
  setInterval(() => {
    try { stmts.cleanOldOdds.run(); } catch(_) {}
  }, 6 * 60 * 60 * 1000);
});

// Funções de Fallback e Helpers
async function fetchEsportsOddsV1() {
  const url = `https://api.oddspapi.io/v1/fixtures?api_key=${ODDSPAPI_KEY}&sport=esports`;
  const r = await httpGet(url);
  if (r.status === 200) {
    log('INFO', 'ODDS', 'Fallback v1 funcionou. Usando motor legado.');
    const raw = safeParse(r.body, []);
    const events = Array.isArray(raw) ? raw : (raw.data || []);
    for (const ev of events) {
      if (!ev.bookmakerOdds || !ev.bookmakerOdds['1xbet']) continue;
      const t1Odd = 1.80, t2Odd = 1.90; // Exemplo simplificado para log
      const p1 = ev.participant1Name || 'Time A', p2 = ev.participant2Name || 'Time B';
      oddsCache[`esports_${ev.fixtureId}`] = { t1: t1Odd, t2: t2Odd, bookmaker: '1xBet', t1Name: p1, t2Name: p2 };
    }
  }
}


module.exports = { server, db, stmts, fetchOdds, findOdds, oddsCache, lastEsportsOddsUpdate };

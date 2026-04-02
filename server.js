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
let esportsOddsFetching = false;
const ESPORTS_ODDS_TTL = 20 * 60 * 1000; // 20m — ~72 fetches/dia para Line Shopping

// Tournament ID cache: refresh once per 24h (saves 2 req/dia)
let cachedTournamentIds = null; // { lol: [...], dota: [...], ts: epoch }
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

// ── Dota 2 Heroes ──
const DOTA_HEROES = {
  1: 'Anti-Mage', 2: 'Axe', 3: 'Bane', 4: 'Bloodseeker', 5: 'Crystal Maiden',
  6: 'Drow Ranger', 7: 'Earthshaker', 8: 'Juggernaut', 9: 'Mirana', 10: 'Morphling',
  11: 'Shadow Fiend', 12: 'Phantom Lancer', 13: 'Puck', 14: 'Pudge', 15: 'Razor',
  16: 'Sand King', 17: 'Storm Spirit', 18: 'Sven', 19: 'Tiny', 20: 'Vengeful Spirit',
  21: 'Windranger', 22: 'Zeus', 23: 'Kunkka', 25: 'Lina', 26: 'Lion',
  27: 'Shadow Shaman', 28: 'Slardar', 29: 'Tidehunter', 30: 'Witch Doctor',
  31: 'Lich', 32: 'Riki', 33: 'Enigma', 34: 'Tinker', 35: 'Sniper',
  36: 'Necrophos', 37: 'Warlock', 38: 'Beastmaster', 39: 'Queen of Pain',
  40: 'Venomancer', 41: 'Faceless Void', 42: 'Wraith King', 43: 'Death Prophet',
  44: 'Phantom Assassin', 45: 'Pugna', 46: 'Templar Assassin', 47: 'Viper',
  48: 'Luna', 49: 'Dragon Knight', 50: 'Dazzle', 51: 'Clockwerk',
  52: 'Leshrac', 53: 'Nature Prophet', 54: 'Lifestealer', 55: 'Dark Seer',
  56: 'Clinkz', 57: 'Omniknight', 58: 'Enchantress', 59: 'Huskar',
  60: 'Night Stalker', 61: 'Broodmother', 62: 'Bounty Hunter', 63: 'Weaver',
  64: 'Jakiro', 65: 'Batrider', 66: 'Chen', 67: 'Spectre', 68: 'Ancient Apparition',
  69: 'Doom', 70: 'Ursa', 71: 'Spirit Breaker', 72: 'Gyrocopter', 73: 'Alchemist',
  74: 'Invoker', 75: 'Silencer', 76: 'Outworld Destroyer', 77: 'Lycan',
  78: 'Brewmaster', 79: 'Shadow Demon', 80: 'Lone Druid', 81: 'Chaos Knight',
  82: 'Meepo', 83: 'Treant Protector', 84: 'Ogre Magi', 85: 'Undying',
  86: 'Rubick', 87: 'Disruptor', 88: 'Nyx Assassin', 89: 'Naga Siren',
  90: 'Keeper of the Light', 91: 'Io', 92: 'Visage', 93: 'Slark',
  94: 'Medusa', 95: 'Troll Warlord', 96: 'Centaur Warrunner', 97: 'Magnus',
  98: 'Timbersaw', 99: 'Bristleback', 100: 'Tusk', 101: 'Skywrath Mage',
  102: 'Abaddon', 103: 'Elder Titan', 104: 'Legion Commander', 105: 'Techies',
  106: 'Ember Spirit', 107: 'Earth Spirit', 108: 'Underlord', 109: 'Terrorblade',
  110: 'Phoenix', 111: 'Oracle', 112: 'Winter Wyvern', 113: 'Arc Warden',
  114: 'Monkey King', 119: 'Dark Willow', 120: 'Pangolier', 121: 'Grimstroke',
  123: 'Hoodwink', 126: 'Void Spirit', 128: 'Snapfire', 129: 'Mars',
  135: 'Dawnbreaker', 136: 'Marci', 137: 'Primal Beast', 138: 'Muerta',
  139: 'Kez', 140: 'Ringmaster', 145: 'Innate'
};

function getHeroName(heroId) {
  return DOTA_HEROES[heroId] || `Hero #${heroId}`;
}

// ── Dota T1 Keywords ──
const DOTA_T1_KEYWORDS = ['esl', 'dreamleague', 'the international', 'pgl', 'betboom',
  'dpc', 'riyadh masters', 'bali major', 'major', 'champions league',
  'fissure', 'blast', 'parivision', 'elite league', 'gamers8',
  'thunderpick', 'pinnacle cup'];

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
  
  // Limites do novo Cache Engine para Oddspapi (1xBet)
  // Pré-jogo varre apenas a cada 30 min por padrão (poupa quota de 5.000 mensais)
  if (now - lastEsportsOddsUpdate < 30 * 60 * 1000) return;

  esportsOddsFetching = true;
  try {
    let cached = 0;
    
    // Rota da OddsPapi -> Filtramos por esports
    const url = `https://api.oddspapi.io/v1/fixtures?api_key=${ODDSPAPI_KEY}&sport=esports`;
    const r = await httpGet(url);
    
    if (r.status === 200) {
      const events = safeParse(r.body, []);
      for (const ev of events) {
        if (!ev.bookmakerOdds || !ev.bookmakerOdds['1xbet']) continue;
        
        const bk = ev.bookmakerOdds['1xbet'];
        if (!bk.markets) continue;

        // Na OddsPapi, o mercado "Vencedor da Partida" (Moneyline) costuma ter bookmakerMarketId = "1"
        // Os objetos com as odds vêm separados mas contêm esse ID
        const matchWinnerOutcomes = Object.values(bk.markets).filter(m => m.bookmakerMarketId === '1');
        if (matchWinnerOutcomes.length < 2) continue;

        // Extrai o preço (odd) das duas partições
        let prices = [];
        for (const out of matchWinnerOutcomes) {
          try {
            const outKey = Object.keys(out.outcomes)[0];
            const price = parseFloat(out.outcomes[outKey].players['0'].price);
            if (!isNaN(price)) prices.push(price);
          } catch(e) {}
        }
        
        if (prices.length < 2) continue;
        
        const t1Odd = prices[0];
        const t2Odd = prices[1];
        if (t1Odd < 1.01 || t2Odd < 1.01) continue;

        // Como a Oddspapi não devolveu nomes nativos nesse endpoint, fazemos dump da URL (ex: "drx-dn-soopers")
        const urlSlug = (bk.fixturePath || '').split('/').pop().replace(/^\d+-/, '').replace(/-/g, ' ');
        if (!urlSlug) continue;

        // O fuzzy match no bot verifica se 'vt1.includes(nt1)'. Se vt1=urlSlug, ele conterá ambos os nomes perfeitamente!
        const p1Name = urlSlug; 
        const p2Name = urlSlug;

        const entry = { t1: t1Odd.toFixed(2), t2: t2Odd.toFixed(2), bookmaker: '1xBet', t1Name: p1Name, t2Name: p2Name };
        const nameKey = ev.fixtureId || String(ev.participant1Id);
        
        // Salvamos com a chave do fixtureId no cache, mas o fuzzyFallback vai resgatar pesquisando o t1Name (slug)
        oddsCache[`esports_${nameKey}`] = entry;
        cached++;
      }
    }
    
    log('INFO', 'ODDS', `OddsPapi (1xBet): ${cached} partidas armazenadas em cache. Próximo Sync em 30 min.`);
    lastEsportsOddsUpdate = Date.now();
  } catch(e) {
    log('ERROR', 'ODDS', `OddsPapi Fetch: ${e.message}`);
  } finally {
    esportsOddsFetching = false;
  }
}

function findOdds(sport, t1, t2) {
  const key = norm(t1) + '_' + norm(t2);
  const cached = oddsCache[`${sport}_${key}`];
  if (cached) return { t1: cached.t1, t2: cached.t2, bookmaker: cached.bookmaker };

  // Reverse key (t2_t1 order)
  const revKey = norm(t2) + '_' + norm(t1);
  const revCached = oddsCache[`${sport}_${revKey}`];
  if (revCached) return { t1: revCached.t2, t2: revCached.t1, bookmaker: revCached.bookmaker };

  // Fuzzy fallback — only for entries that have real team names stored
  const nt1 = norm(t1), nt2 = norm(t2);
  for (const [cacheKey, val] of Object.entries(oddsCache)) {
    if (!cacheKey.startsWith(`${sport}_`)) continue;
    if (!val.t1Name || !val.t2Name) continue; // skip entries without names (prevents empty-string match)
    const vt1 = norm(val.t1Name), vt2 = norm(val.t2Name);
    if (!vt1 || !vt2) continue;
    if ((nt1.includes(vt1) || vt1.includes(nt1)) && (nt2.includes(vt2) || vt2.includes(nt2)))
      return { t1: val.t1, t2: val.t2, bookmaker: val.bookmaker };
    if ((nt1.includes(vt2) || vt2.includes(nt1)) && (nt2.includes(vt1) || vt1.includes(nt2)))
      return { t1: val.t2, t2: val.t1, bookmaker: val.bookmaker }; // swapped
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

// ── Dota Matches ──
async function getDotaMatches() {
  try {
    const liveR = await httpGet('https://api.opendota.com/api/live');
    const liveData = safeParse(liveR.body, []);

    const isDotaTier1 = name => {
      if (!name) return false;
      const lower = name.toLowerCase();
      return DOTA_T1_KEYWORDS.some(kw => lower.includes(kw));
    };

    // Resolve league names for all unique league IDs
    const candidates = (Array.isArray(liveData) ? liveData : [])
      .filter(m => (m.league_id > 0) || (m.team_name_radiant && m.team_name_dire))
      .sort((a, b) => (b.spectators || 0) - (a.spectators || 0))
      .slice(0, 30);

    const uniqueLeagueIds = [...new Set(candidates.map(m => m.league_id).filter(id => id > 0))];
    await Promise.all(uniqueLeagueIds.map(id => getLeagueName(id)));

    const live = candidates
      .filter(m => isDotaTier1(leagueNameCache[m.league_id] || m.league_name || ''))
      .slice(0, 15)
      .map(m => ({
        id: String(m.match_id),
        game: 'dota',
        league: leagueNameCache[m.league_id] || m.league_name || 'Dota 2 Pro',
        team1: m.team_name_radiant || 'Radiant',
        team2: m.team_name_dire || 'Dire',
        score1: m.radiant_score || 0,
        score2: m.dire_score || 0,
        goldDiff: m.radiant_lead || 0,
        status: 'live',
        time: m.activate_time ? new Date(m.activate_time * 1000).toISOString() : new Date().toISOString(),
        format: 'Bo3',
        spectators: m.spectators || 0,
        duration: m.game_time || 0
      }));

    const proR = await httpGet('https://api.opendota.com/api/proMatches');
    const proData = safeParse(proR.body, []);
    const cutoff24h = Date.now() / 1000 - 24 * 3600;

    const recent = (Array.isArray(proData) ? proData : [])
      .filter(m => m.start_time > cutoff24h && isDotaTier1(m.league_name))
      .filter(m => !live.find(l => l.id === String(m.match_id)))
      .slice(0, 10)
      .map(m => ({
        id: String(m.match_id),
        game: 'dota',
        league: m.league_name || 'Dota 2 Pro',
        team1: m.radiant_name || 'Radiant',
        team2: m.dire_name || 'Dire',
        score1: m.radiant_score || 0,
        score2: m.dire_score || 0,
        status: 'recent',
        time: new Date(m.start_time * 1000).toISOString(),
        duration: m.duration || 0,
        winner: m.radiant_win === true ? (m.radiant_name || 'Radiant') :
                m.radiant_win === false ? (m.dire_name || 'Dire') : null
      }));

    const result = [...live, ...recent]
      .filter((m, i, a) => a.findIndex(x => x.id === m.id) === i)
      .sort((a, b) => {
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (b.status === 'live' && a.status !== 'live') return 1;
        return new Date(b.time) - new Date(a.time);
      })
      .slice(0, 25);

    await fetchOdds('esports');
    result.forEach(m => {
      const o = findOdds('esports', m.team1, m.team2);
      if (o) m.odds = o;
    });

    return result;
  } catch(e) {
    log('ERROR', 'DOTA', e.message);
    return [];
  }
}

// Cache de nomes de liga por ID
const leagueNameCache = {};
async function getLeagueName(leagueId) {
  if (!leagueId || leagueId === 0) return null;
  if (leagueNameCache[leagueId] !== undefined) return leagueNameCache[leagueId];
  try {
    const r = await httpGet(`https://api.opendota.com/api/leagues/${leagueId}`);
    if (r.status === 200) {
      const data = safeParse(r.body, {});
      leagueNameCache[leagueId] = data.name || null;
      return leagueNameCache[leagueId];
    }
  } catch(_) {}
  leagueNameCache[leagueId] = null;
  return null;
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

  if (p === '/dota-matches') {
    sendJson(res, await getDotaMatches());
    return;
  }

  if (p === '/dota-live') {
    const matchId = parsed.query.matchId;
    if (!matchId) { sendJson(res, { error: 'Missing matchId' }, 400); return; }

    try {
      // Try /api/matches first (full stats if game is processed)
      const r = await httpGet(`https://api.opendota.com/api/matches/${matchId}`);
      if (r.status === 200) {
        const data = safeParse(r.body, {});
        if (data.duration > 0 || data.radiant_win !== undefined) {
          // Full stats available
          const players = (data.players || []).map(p => ({
            name: p.personaname || 'Player',
            hero: getHeroName(p.hero_id),
            side: p.isRadiant ? 'Radiant' : 'Dire',
            kills: p.kills || 0,
            deaths: p.deaths || 0,
            assists: p.assists || 0,
            gold: p.gold || 0,
            cs: (p.last_hits || 0) + (p.denies || 0),
            gpm: p.gold_per_min || 0,
            xpm: p.xp_per_min || 0,
            netWorth: p.net_worth || 0
          }));
          sendJson(res, {
            matchId,
            hasLiveStats: true,
            isRealtime: false,
            gameState: data.radiant_win !== undefined ? 'finished' : 'in_progress',
            duration: data.duration || 0,
            radiantTeam: { name: data.radiant_name || 'Radiant', kills: data.radiant_score || 0 },
            direTeam: { name: data.dire_name || 'Dire', kills: data.dire_score || 0 },
            winner: data.radiant_win === true ? (data.radiant_name || 'Radiant') :
                    data.radiant_win === false ? (data.dire_name || 'Dire') : null,
            fullStats: true,
            players
          });
          return;
        }
      }
    } catch(e) {}

    // Fall back to /api/live for in-progress game
    try {
      const liveR = await httpGet('https://api.opendota.com/api/live');
      const liveList = safeParse(liveR.body, []);
      const liveMatch = Array.isArray(liveList) ? liveList.find(m => String(m.match_id) === String(matchId)) : null;
      if (liveMatch) {
        const players = (liveMatch.players || []).map(p => ({
          name: p.name || p.personaname || 'Player',
          hero: getHeroName(p.hero_id),
          side: p.team === 0 ? 'Radiant' : 'Dire',
          kills: p.kills || 0,
          deaths: p.deaths || 0,
          assists: p.assists || 0,
          gold: p.gold || 0,
          cs: (p.last_hits || 0) + (p.denies || 0),
          gpm: p.gold_per_min || 0,
          netWorth: p.net_worth || 0
        }));
        sendJson(res, {
          matchId,
          hasLiveStats: true,
          isRealtime: true,
          gameState: 'in_progress',
          duration: liveMatch.game_time || 0,
          radiantTeam: { name: liveMatch.team_name_radiant || 'Radiant', kills: liveMatch.radiant_score || 0 },
          direTeam: { name: liveMatch.team_name_dire || 'Dire', kills: liveMatch.dire_score || 0 },
          goldDiff: liveMatch.radiant_lead || 0,
          spectators: liveMatch.spectators || 0,
          fullStats: true,
          players
        });
        return;
      }
    } catch(e) {}

    sendJson(res, { error: 'Match not found' }, 404);
    return;
  }

  if (p === '/dota-compositions') {
    const matchId = parsed.query.matchId;
    if (!matchId) { sendJson(res, { error: 'Missing matchId' }, 400); return; }

    // Check live feed first
    try {
      const liveR = await httpGet('https://api.opendota.com/api/live');
      const liveList = safeParse(liveR.body, []);
      const liveMatch = Array.isArray(liveList) ? liveList.find(m => String(m.match_id) === String(matchId)) : null;

      if (liveMatch) {
        const players = liveMatch.players || [];
        sendJson(res, {
          matchId,
          hasCompositions: true,
          duration: liveMatch.game_time || 0,
          radiantTeam: {
            name: liveMatch.team_name_radiant || 'Radiant',
            players: players.filter(p => p.team === 0).map(p => ({
              hero: getHeroName(p.hero_id),
              kills: p.kills || 0,
              deaths: p.deaths || 0,
              assists: p.assists || 0,
              gold: p.gold || 0,
              gpm: p.gold_per_min || 0
            }))
          },
          direTeam: {
            name: liveMatch.team_name_dire || 'Dire',
            players: players.filter(p => p.team === 1).map(p => ({
              hero: getHeroName(p.hero_id),
              kills: p.kills || 0,
              deaths: p.deaths || 0,
              assists: p.assists || 0,
              gold: p.gold || 0,
              gpm: p.gold_per_min || 0
            }))
          }
        });
        return;
      }
    } catch(e) {}

    // Fall back to /api/matches for completed games
    try {
      const r = await httpGet(`https://api.opendota.com/api/matches/${matchId}`);
      if (r.status === 200) {
        const data = safeParse(r.body, {});
        if (data.players?.length) {
          sendJson(res, {
            matchId,
            hasCompositions: true,
            duration: data.duration || 0,
            radiantTeam: {
              name: data.radiant_name || 'Radiant',
              players: data.players.filter(p => p.isRadiant).map(p => ({
                hero: getHeroName(p.hero_id),
                kills: p.kills || 0,
                deaths: p.deaths || 0,
                assists: p.assists || 0,
                gold: p.gold || 0,
                gpm: p.gold_per_min || 0
              }))
            },
            direTeam: {
              name: data.dire_name || 'Dire',
              players: data.players.filter(p => !p.isRadiant).map(p => ({
                hero: getHeroName(p.hero_id),
                kills: p.kills || 0,
                deaths: p.deaths || 0,
                assists: p.assists || 0,
                gold: p.gold || 0,
                gpm: p.gold_per_min || 0
              }))
            }
          });
          return;
        }
      }
    } catch(e) {}

    sendJson(res, { matchId, hasCompositions: false }, 404);
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

  if (p === '/upcoming-fights') {
    const days = parseInt(parsed.query.days) || 14;
    const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const fights = db.prepare(`
      SELECT m.*, e.date as ev_date, e.name as ev_name FROM matches m
      JOIN events e ON m.event_id = e.id
      WHERE m.sport = 'mma' AND m.winner IS NULL AND e.date >= date('now') AND e.date <= ?
      ORDER BY e.date ASC
    `).all(cutoff);
    fights.forEach(f => {
      if (!f.event_date && f.ev_date) f.event_date = f.ev_date;
      if (!f.event_name && f.ev_name) f.event_name = f.ev_name;
    });
    await fetchOdds('mma');
    fights.forEach(f => {
      const o = findOdds('mma', f.participant1_name, f.participant2_name);
      if (o) f.odds = o;
    });
    sendJson(res, fights);
    return;
  }

  if (p === '/pending-past-fights') {
    sendJson(res, stmts.getPendingPastMatches.all('mma'));
    return;
  }

  if (p === '/card-snapshot') {
    const eventId = parsed.query.eventId;
    if (!eventId) { sendJson(res, { error: 'Missing eventId' }, 400); return; }
    sendJson(res, stmts.getSnapshot.all(eventId, 'mma'));
    return;
  }

  if (p === '/save-card-snapshot' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { eventId, fights } = safeParse(body, {});
        if (!eventId || !Array.isArray(fights)) { sendJson(res, { error: 'Missing eventId or fights' }, 400); return; }
        for (const f of fights) {
          stmts.saveSnapshot.run(eventId, 'mma', f.id, f.participant1_name || f.fighter1_name, f.participant2_name || f.fighter2_name);
        }
        sendJson(res, { ok: true, saved: fights.length });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  if (p === '/settle-fight' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { fightId, matchId, winner, method, round } = safeParse(body, {});
        const id = fightId || matchId;
        if (!id || !winner) { sendJson(res, { error: 'Missing fightId/winner' }, 400); return; }
        db.prepare(`UPDATE matches SET winner=?, method=?, round=?, status='completed' WHERE id=?`)
          .run(winner, method || null, round || null, id);
        sendJson(res, { ok: true });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  if (p === '/match-result') {
    const matchId = parsed.query.matchId || '';
    const game = parsed.query.game || 'lol';
    try {
      if (game === 'dota') {
        const r = await httpGet(`https://api.opendota.com/api/matches/${matchId}`);
        if (r.status === 200) {
          const data = safeParse(r.body, {});
          if (data.radiant_win !== undefined && data.duration > 0) {
            const winner = data.radiant_win ? (data.radiant_name || 'Radiant') : (data.dire_name || 'Dire');
            stmts.upsertMatchResult.run(matchId, 'dota', data.radiant_name || 'Radiant', data.dire_name || 'Dire', winner, `${data.radiant_score||0}-${data.dire_score||0}`, data.league_name || '');
            sendJson(res, { matchId, game, winner, resolved: true });
            return;
          }
        }
      } else {
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
      }
      sendJson(res, { matchId, game, resolved: false });
    } catch(e) {
      sendJson(res, { matchId, game, resolved: false, error: e.message });
    }
    return;
  }

  if (p === '/dota-match-detail') {
    const matchId = parsed.query.matchId;
    if (!matchId) { sendJson(res, { error: 'Missing matchId' }, 400); return; }
    try {
      const r = await httpGet(`https://api.opendota.com/api/matches/${matchId}`);
      if (r.status !== 200) { sendJson(res, { error: 'Not found' }, 404); return; }
      const data = safeParse(r.body, {});
      const objectives = data.objectives || [];
      const roshanKills = objectives.filter(o => o.type === 'CHAT_MESSAGE_ROSHAN_KILL').length;
      const lastRoshan = objectives.filter(o => o.type === 'CHAT_MESSAGE_ROSHAN_KILL').pop();
      const aegisHolder = lastRoshan ? (lastRoshan.player_slot < 128 ? 'Radiant' : 'Dire') : null;
      const countBarracks = (status) => { let d = 0; for (let i = 0; i < 6; i++) if (!(status & (1 << i))) d++; return d; };
      const radiantBarracks = data.barracks_status_radiant ?? 63;
      const direBarracks = data.barracks_status_dire ?? 63;
      const coreItems = ['bkb', 'aghanims_scepter', 'refresher', 'divine_rapier', 'satanic', 'butterfly'];
      const itemTimings = (data.players || []).filter(p => [1,2].includes(p.lane_role) || p.net_worth > 15000).slice(0, 4)
        .map(p => {
          const timings = {};
          if (p.purchase_log) p.purchase_log.forEach(item => { if (coreItems.some(ci => item.key?.includes(ci))) timings[item.key] = Math.round(item.time/60)+'min'; });
          return { name: p.personaname||'Player', hero: getHeroName(p.hero_id), side: p.isRadiant?'Radiant':'Dire', items: timings };
        }).filter(p => Object.keys(p.items).length > 0);
      sendJson(res, { roshanKills, aegisHolder, barracksDestroyed: { radiant: countBarracks(direBarracks), dire: countBarracks(radiantBarracks) }, coreItemTimings: itemTimings });
    } catch(e) { sendJson(res, { error: e.message }, 500); }
    return;
  }

  // ── Unified Sport-Agnostic Endpoints (used by unified bot) ──
  if (p === '/events') {
    const sport = parsed.query.sport || 'mma';
    if (sport === 'mma' && SCRAPERS.mma) await SCRAPERS.mma.refreshEvents();
    sendJson(res, stmts.getEvents.all(sport, 10));
    return;
  }

  if (p === '/matches') {
    const sport = parsed.query.sport || 'mma';
    const eventId = parsed.query.eventId;
    if (!eventId) { sendJson(res, { error: 'Missing eventId' }, 400); return; }
    let matches = stmts.getMatchesByEvent.all(eventId, sport);
    if (!matches.length && sport === 'mma' && SCRAPERS.mma?.scrapeEventMatches) {
      matches = await SCRAPERS.mma.scrapeEventMatches(eventId);
    }
    await fetchOdds(sport);
    matches.forEach(m => {
      const o = findOdds(sport, m.participant1_name, m.participant2_name);
      if (o) m.odds = o;
    });
    sendJson(res, matches);
    return;
  }

  if (p === '/athlete') {
    try {
      const sport = parsed.query.sport || 'mma';
      let stats = null;
      if (parsed.query.url && SCRAPERS.mma?.scrapeAthlete) {
        stats = await SCRAPERS.mma.scrapeAthlete(parsed.query.url);
      } else if (parsed.query.name) {
        const rows = stmts.getAthletesByName.all(sport, `%${parsed.query.name}%`);
        if (rows.length > 0) stats = rows[0];
        if (!stats && sport === 'mma' && SCRAPERS.mma?.searchAthlete) {
          stats = await SCRAPERS.mma.searchAthlete(parsed.query.name);
        }
      }
      if (!stats) { sendJson(res, { error: 'Athlete not found' }, 404); return; }
      sendJson(res, stats);
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // ── MMA Endpoints (com scraper opcional) ──
  if (p === '/mma-events') {
    if (SCRAPERS.mma) {
      await SCRAPERS.mma.refreshEvents();
    }
    sendJson(res, stmts.getEvents.all('mma', 10));
    return;
  }

  if (p === '/mma-fights') {
    const eventId = parsed.query.eventId;
    if (!eventId) { sendJson(res, { error: 'Missing eventId' }, 400); return; }

    let fights = stmts.getMatchesByEvent.all(eventId, 'mma');
    if (!fights.length && SCRAPERS.mma?.scrapeEventMatches) {
      fights = await SCRAPERS.mma.scrapeEventMatches(eventId);
    }

    await fetchOdds('mma');
    fights.forEach(f => {
      const o = findOdds('mma', f.participant1_name, f.participant2_name);
      if (o) f.odds = o;
    });

    sendJson(res, fights);
    return;
  }

  if (p === '/fighter-stats') {
    try {
      let stats = null;
      if (parsed.query.url && SCRAPERS.mma?.scrapeAthlete) {
        stats = await SCRAPERS.mma.scrapeAthlete(parsed.query.url);
      } else if (parsed.query.name) {
        const rows = stmts.getAthletesByName.all('mma', `%${parsed.query.name}%`);
        if (rows.length > 0) {
          stats = rows[0];
        }
        if (!stats && SCRAPERS.mma?.searchAthlete) {
          stats = await SCRAPERS.mma.searchAthlete(parsed.query.name);
        }
      }
      if (!stats) { sendJson(res, { error: 'Fighter not found' }, 404); return; }
      sendJson(res, stats);
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // ── Shared Endpoints ──
  if (p === '/odds') {
    const sport = parsed.query.sport || 'esports';
    await fetchOdds(sport);
    const t1 = parsed.query.team1 || parsed.query.fighter1 || parsed.query.p1 || '';
    const t2 = parsed.query.team2 || parsed.query.fighter2 || parsed.query.p2 || '';
    const o = findOdds(sport, t1, t2);
    sendJson(res, o || { t1: null, t2: null, bookmaker: null });
    return;
  }

  if (p === '/odds-movement') {
    const sport = parsed.query.sport || 'esports';
    const t1 = parsed.query.team1 || parsed.query.fighter1 || parsed.query.p1 || '';
    const t2 = parsed.query.team2 || parsed.query.fighter2 || parsed.query.p2 || '';
    const key = norm(t1) + '_' + norm(t2);
    sendJson(res, { history: stmts.getOddsMovement.all(sport, key) });
    return;
  }

  if (p === '/team-form' || p === '/fighter-form' || p === '/form') {
    const name = parsed.query.team || parsed.query.name || '';
    const sport = parsed.query.sport || 'esports';
    const game = parsed.query.game || sport;
    const matches = db.prepare(`
      SELECT * FROM matches
      WHERE sport = ? AND (participant1_name LIKE ? OR participant2_name LIKE ?)
      AND winner IS NOT NULL
      ORDER BY event_date DESC LIMIT 10
    `).all(sport, `%${name}%`, `%${name}%`);

    let wins = 0, losses = 0;
    const recentMatches = matches.map(m => {
      const isP1 = norm(name).includes(norm(m.participant1_name));
      const won = m.winner ? norm(m.winner).includes(norm(name)) : null;
      if (won === true) wins++;
      else if (won === false) losses++;
      return {
        opponent: isP1 ? m.participant2_name : m.participant1_name,
        result: won === null ? '?' : won ? 'W' : 'L',
        event_date: m.event_date
      };
    });

    sendJson(res, {
      wins, losses,
      total: wins + losses,
      winRate: wins + losses > 0 ? Math.round(wins / (wins + losses) * 100) : 0,
      recentMatches
    });
    return;
  }

  if (p === '/h2h') {
    const t1 = parsed.query.team1 || parsed.query.fighter1 || parsed.query.p1 || '';
    const t2 = parsed.query.team2 || parsed.query.fighter2 || parsed.query.p2 || '';
    const sport = parsed.query.sport || 'esports';
    const matches = db.prepare(`
      SELECT * FROM matches
      WHERE sport = ? AND (
        (participant1_name LIKE ? AND participant2_name LIKE ?) OR
        (participant1_name LIKE ? AND participant2_name LIKE ?)
      )
      ORDER BY event_date DESC LIMIT 10
    `).all(sport, `%${t1}%`, `%${t2}%`, `%${t2}%`, `%${t1}%`);

    const t1Wins = matches.filter(m => m.winner && norm(m.winner).includes(norm(t1))).length;
    const t2Wins = matches.filter(m => m.winner && norm(m.winner).includes(norm(t2))).length;

    sendJson(res, {
      t1Wins, t2Wins,
      totalMatches: matches.length,
      matches: matches.slice(0, 5).map(m => ({
        winner: m.winner,
        event_date: m.event_date
      }))
    });
    return;
  }

  if (p === '/save-user' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { userId, username, subscribed, sportPrefs } = safeParse(body, {});
        const prefs = sportPrefs ? JSON.stringify(sportPrefs) : '[]';
        stmts.upsertUser.run(userId, username || '', subscribed ? 1 : 0, prefs);
        sendJson(res, { ok: true });
      } catch(e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  if (p === '/users') {
    const subscribed = parseInt(parsed.query.subscribed);
    if (subscribed === 1) {
      sendJson(res, stmts.getSubscribedUsers.all());
    } else {
      sendJson(res, db.prepare('SELECT * FROM users').all());
    }
    return;
  }

  if (p === '/record-tip' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const t = safeParse(body, {});
        // sport: prioriza query param, depois body, depois default
        const sport = parsed.query.sport || t.sport || 'esports';
        stmts.insertTip.run({
          sport,
          matchId: t.matchId || t.fightId || '',
          eventName: t.eventName || t.league || '',
          // aceita tanto p1/p2 (novo padrão do bot) quanto team1/fighter1 (legado)
          p1: t.p1 || t.team1 || t.fighter1 || '',
          p2: t.p2 || t.team2 || t.fighter2 || '',
          // aceita tipParticipant (novo padrão do bot) quanto tipTeam/tipFighter (legado)
          tipParticipant: t.tipParticipant || t.tipTeam || t.tipFighter || '',
          odds: parseFloat(t.odds) || 0,
          ev: parseFloat(t.ev) || 0,
          stake: t.stake || '1u',
          confidence: t.confidence || 'MÉDIA',
          isLive: t.isLive ? 1 : 0,
          botToken: t.botToken || ''
        });
        
        // Registrar a odd de abertura no banco
        try {
          stmts.updateTipOpenOdds.run(parseFloat(t.odds) || 0, t.matchId || t.fightId || '', sport);
        } catch(_) {}
        
        sendJson(res, { ok: true });
      } catch(e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  if (p === '/update-clv' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { matchId, clvOdds, sport } = safeParse(body, {});
        if (!matchId || !clvOdds) {
          sendJson(res, { error: 'Missing matchId or clvOdds' }, 400); 
          return;
        }
        stmts.updateTipCLV.run(parseFloat(clvOdds), matchId, sport || 'esports');
        sendJson(res, { ok: true });
      } catch(e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  if (p === '/settle-tip' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { matchId, winner, result } = safeParse(body, {});
        const sport = parsed.query.sport || 'esports';
        const resToSettle = result || (winner ? 'win' : 'loss');
        stmts.settleTip.run(resToSettle, matchId, sport);
        sendJson(res, { ok: true });
      } catch(e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  if (p === '/unsettled-tips') {
    const sport = parsed.query.sport || 'esports';
    sendJson(res, stmts.getUnsettledTips.all(sport, '-14 days'));
    return;
  }

  if (p === '/roi') {
    const sport = parsed.query.sport || 'esports';
    const overall = stmts.getROI.get(sport);
    const calibration = stmts.getCalibration.all(sport);

    const tips = db.prepare(`SELECT odds, stake, result FROM tips WHERE sport = ? AND result IS NOT NULL`).all(sport);
    let totalStaked = 0, totalProfit = 0;
    for (const tip of tips) {
      const s = parseFloat(String(tip.stake).replace('u', '')) || 1;
      totalStaked += s;
      if (tip.result === 'win') totalProfit += s * (parseFloat(tip.odds) - 1);
      else totalProfit -= s;
    }

    // Phase breakdown (live vs pre-game) — only relevant for esports
    let byPhase = null;
    if (sport === 'esports') {
      const calcPhase = (isLiveVal) => {
        const pts = db.prepare(`SELECT odds, stake, result FROM tips WHERE sport = ? AND is_live = ? AND result IS NOT NULL`).all(sport, isLiveVal);
        let staked = 0, profit = 0, wins = 0;
        for (const tip of pts) {
          const s = parseFloat(String(tip.stake).replace('u', '')) || 1;
          staked += s;
          if (tip.result === 'win') { profit += s * (parseFloat(tip.odds) - 1); wins++; }
          else profit -= s;
        }
        return { total: pts.length, wins, losses: pts.length - wins, staked: staked.toFixed(1), profit: profit.toFixed(2), roi: staked > 0 ? ((profit / staked) * 100).toFixed(1) : '0' };
      };
      byPhase = { live: calcPhase(1), preGame: calcPhase(0) };
    }

    sendJson(res, {
      overall: {
        ...overall,
        totalStaked: totalStaked.toFixed(1),
        totalProfit: totalProfit.toFixed(2),
        roi: totalStaked > 0 ? ((totalProfit / totalStaked) * 100).toFixed(1) : '0'
      },
      calibration,
      byPhase
    });
    return;
  }

  if (p === '/tips-history') {
    const sport = parsed.query.sport || 'esports';
    const limit = Math.min(parseInt(parsed.query.limit) || 20, 50);
    const filter = parsed.query.filter || 'all'; // 'all' | 'settled' | 'pending'
    let whereClause = 'WHERE sport = ?';
    if (filter === 'settled') whereClause += " AND result IS NOT NULL";
    else if (filter === 'pending') whereClause += " AND result IS NULL";
    const tips = db.prepare(`
      SELECT id, sport, event_name, participant1, participant2, tip_participant,
             odds, ev, stake, confidence, is_live, result, sent_at, settled_at
      FROM tips ${whereClause}
      ORDER BY sent_at DESC LIMIT ?
    `).all(sport, limit);
    sendJson(res, tips);
    return;
  }

  if (p === '/db-status') {
    const sport = parsed.query.sport || 'esports';
    const counts = stmts.getDBStatus.get(sport, sport, sport, sport, sport, sport);
    sendJson(res, counts);
    return;
  }

  if (p === '/pending-past') {
    const sport = parsed.query.sport || 'esports';
    sendJson(res, stmts.getPendingPastMatches.all(sport));
    return;
  }

  if (p === '/claude' && req.method === 'POST') {
    const claudeKey = req.headers['x-claude-key'] || CLAUDE_KEY;
    if (!claudeKey?.startsWith('sk-')) {
      sendJson(res, { error: 'Missing Claude API key' }, 401);
      return;
    }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const r = await httpsPost(
          'https://api.anthropic.com/v1/messages',
          safeParse(body, {}),
          { 'x-api-key': claudeKey, 'anthropic-version': '2023-06-01' }
        );
        if (r.status !== 200) {
          log('ERROR', 'CLAUDE', `Anthropic API status ${r.status}: ${r.body.slice(0, 300)}`);
        }
        res.writeHead(r.status, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(r.body);
      } catch(e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // ── Tennis Endpoints ──
  if (p === '/tennis-tournaments') {
    try {
      if (SCRAPERS.tennis) await SCRAPERS.tennis.refreshMatches();
      const now = new Date().toISOString();
      const cutoff = new Date(Date.now() + 14 * 86400000).toISOString();
      const events = db.prepare(`
        SELECT DISTINCT e.* FROM events e
        JOIN matches m ON m.event_id = e.id
        WHERE e.sport = 'tennis'
          AND m.winner IS NULL
          AND m.match_time >= ?
          AND m.match_time <= ?
        ORDER BY e.date ASC
        LIMIT 20
      `).all(now, cutoff);
      // Enrich with match count and surface
      const enriched = events.map(ev => {
        const matchCount = db.prepare(`
          SELECT COUNT(*) as c FROM matches
          WHERE sport='tennis' AND event_id=? AND winner IS NULL AND match_time >= ?
        `).get(ev.id, now);
        return { ...ev, matchCount: matchCount?.c || 0 };
      });
      sendJson(res, enriched);
    } catch(e) {
      log('ERROR', 'TENNIS-TOURNAMENTS', e.message);
      sendJson(res, []);
    }
    return;
  }

  if (p === '/tennis-matches') {
    const tournamentId = parsed.query.tournamentId;
    if (!tournamentId) { sendJson(res, { error: 'Missing tournamentId' }, 400); return; }
    try {
      await fetchTennisOdds();
      const matches = db.prepare(`
        SELECT * FROM matches
        WHERE sport = 'tennis' AND event_id = ?
          AND (winner IS NULL OR match_time >= datetime('now', '-2 hours'))
        ORDER BY match_time ASC
        LIMIT 30
      `).all(tournamentId);
      matches.forEach(m => {
        const o = findOdds('tennis', m.participant1_name, m.participant2_name);
        if (o) m.odds = o;
      });
      sendJson(res, matches);
    } catch(e) {
      log('ERROR', 'TENNIS-MATCHES', e.message);
      sendJson(res, []);
    }
    return;
  }

  if (p === '/tennis-player') {
    const name = parsed.query.name;
    if (!name) { sendJson(res, { error: 'Missing name' }, 400); return; }
    try {
      // DB first (fresh within 12h)
      const row = db.prepare(`
        SELECT * FROM athletes
        WHERE sport = 'tennis' AND name LIKE ?
          AND last_scraped > datetime('now', '-12 hours')
        LIMIT 1
      `).get(`%${name}%`);
      if (row) { sendJson(res, { ...safeParse(row.stats, {}), name: row.name }); return; }

      if (SCRAPERS.tennis?.getPlayerStats) {
        const stats = await SCRAPERS.tennis.getPlayerStats(name);
        if (stats) { sendJson(res, stats); return; }
      }
      sendJson(res, { error: 'Player not found' }, 404);
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/tennis-surface-form') {
    const player = parsed.query.player;
    const surface = parsed.query.surface;
    if (!player) { sendJson(res, { error: 'Missing player' }, 400); return; }
    try {
      // ── Partidas recentes (tabela matches — dados da temporada atual via The Odds API) ──
      const recentParams = [`%${player}%`, `%${player}%`];
      const recentSurfaceClause = surface ? 'AND category = ?' : '';
      if (surface) recentParams.push(surface);

      const recentRows = db.prepare(`
        SELECT participant1_name, participant2_name, winner, score, category, event_date, match_time
        FROM matches
        WHERE sport = 'tennis'
          AND (participant1_name LIKE ? OR participant2_name LIKE ?)
          AND winner IS NOT NULL
          ${recentSurfaceClause}
        ORDER BY match_time DESC LIMIT 10
      `).all(...recentParams);

      // ── Histórico (tabela match_results — seed Sackmann, game = surface) ──
      const histParams = [`%${player}%`, `%${player}%`];
      const histSurfaceClause = surface ? 'AND game = ?' : '';
      if (surface) histParams.push(surface);

      const histRows = db.prepare(`
        SELECT team1 as participant1_name, team2 as participant2_name,
               winner, final_score as score, game as category, resolved_at as match_time
        FROM match_results
        WHERE (team1 LIKE ? OR team2 LIKE ?)
          ${histSurfaceClause}
        ORDER BY resolved_at DESC LIMIT 30
      `).all(...histParams);

      // Combinar: recentes primeiro, depois histórico (sem duplicatas por score+oponente)
      const allMatches = [...recentRows, ...histRows];

      let wins = 0, losses = 0;
      const recentMatches = allMatches.map(m => {
        const won = m.winner ? norm(m.winner).includes(norm(player)) : null;
        if (won === true) wins++;
        else if (won === false) losses++;
        const isP1 = norm(m.participant1_name).includes(norm(player));
        return {
          opponent: isP1 ? m.participant2_name : m.participant1_name,
          result: won === null ? '?' : won ? 'W' : 'L',
          score: m.score,
          surface: m.category,
          date: (m.match_time || '').slice(0, 10)
        };
      });

      sendJson(res, {
        wins, losses,
        total: wins + losses,
        winRate: wins + losses > 0 ? Math.round(wins / (wins + losses) * 100) : 0,
        recentMatches: recentMatches.slice(0, 20),
        surface: surface || 'all',
        fromHistory: histRows.length
      });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/tennis-snapshot') {
    const tournamentId = parsed.query.tournamentId;
    if (!tournamentId) { sendJson(res, { error: 'Missing tournamentId' }, 400); return; }
    sendJson(res, stmts.getSnapshot.all(tournamentId, 'tennis'));
    return;
  }

  if (p === '/tennis-save-snapshot' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tournamentId, matches } = safeParse(body, {});
        if (!tournamentId || !Array.isArray(matches)) {
          sendJson(res, { error: 'Missing tournamentId or matches' }, 400); return;
        }
        for (const m of matches) {
          stmts.saveSnapshot.run(tournamentId, 'tennis', m.id, m.participant1_name, m.participant2_name);
        }
        sendJson(res, { ok: true, saved: matches.length });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  if (p === '/tennis-settle' && req.method === 'POST') {
    try {
      if (SCRAPERS.tennis) await SCRAPERS.tennis.settleResults();
      sendJson(res, { ok: true });
    } catch(e) { sendJson(res, { error: e.message }, 500); }
    return;
  }

  sendJson(res, { error: 'Not found' }, 404);
  } catch(e) {
    log('ERROR', 'SERVER', `Unhandled in ${p}: ${e.message}`);
    if (!res.headersSent) sendJson(res, { error: e.message }, 500);
  }
});

server.listen(PORT, () => {
  log('INFO', 'SERVER', `SportsEdge API em http://localhost:${PORT}`);
  log('INFO', 'SERVER', `Esportes: LoL, Dota (API) | MMA (scraper opcional)`);

  // Cleanup
  setInterval(() => {
    try { stmts.cleanOldOdds.run(); } catch(_) {}
  }, 6 * 60 * 60 * 1000);
});

module.exports = { server, db, stmts, fetchOdds, findOdds };

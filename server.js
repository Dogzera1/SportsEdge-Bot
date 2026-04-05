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
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
// Aceita múltiplos nomes de variável para a chave OddsPapi
const ODDSPAPI_KEY = process.env.ODDS_API_KEY
  || process.env.ODDSPAPI_KEY
  || process.env.ODDS_PAPI_KEY
  || process.env.ESPORTS_ODDS_KEY;
const LOL_KEY = process.env.LOL_API_KEY || '';
const PANDASCORE_TOKEN = process.env.PANDASCORE_TOKEN || '';

// DB_PATH allows pointing to a Railway volume (e.g. /data/sportsedge.db)
const fs = require('fs');
let DB_PATH = (process.env.DB_PATH || 'sportsedge.db').trim().replace(/^=+/, '');
// Ensure the directory exists — fall back to local path if creation fails (no volume mounted)
try {
  const dbDir = path.dirname(path.resolve(DB_PATH));
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
} catch(e) {
  log('WARN', 'DB', `Não foi possível criar diretório para ${DB_PATH}: ${e.message}. Usando sportsedge.db local.`);
  DB_PATH = 'sportsedge.db';
}
const { db, stmts } = initDatabase(DB_PATH);

// Limpeza de integridade: remove tips com odds inválidas (> 4.0) gravadas por versões anteriores
try {
  const cleaned = db.prepare("DELETE FROM tips WHERE CAST(odds AS REAL) > 4.0").run();
  if (cleaned.changes > 0) log('INFO', 'BOOT', `Limpeza: ${cleaned.changes} tip(s) com odds > 4.0 removidas`);
} catch(e) { log('WARN', 'BOOT', `Limpeza odds: ${e.message}`); }

// Apenas Esports suportado — sem scrapers externos

// ── Odds Cache ──
const oddsCache = {};
let lastOddsUpdate = 0;
const ODDS_TTL = 4 * 60 * 60 * 1000; // 4h — conserves The Odds API monthly quota (500 req free tier)

// Esports odds: OddsPapi (free 250 req/mês). TTL 6h + tournament cache 24h ≈ 180 req/mês
let lastEsportsOddsUpdate = 0;
let lastApiResponse = ''; // Para diagnóstico
let esportsOddsFetching = false;
// TTL por ciclo (1 req por ciclo com round-robin de 6 lotes).
// Plano free OddsPapi: 250 req/mês ≈ 8/dia → ciclo mínimo = 3h
// Com 6 lotes e 3h por ciclo: todos os torneios cobertos a cada ~18h
// Configurável via ESPORTS_ODDS_TTL_H (horas) no Railway
const ESPORTS_ODDS_TTL = (parseInt(process.env.ESPORTS_ODDS_TTL_H || '') || 3) * 60 * 60 * 1000;

// Tournament ID cache: refresh once per 24h (saves 2 req/dia)
const TOURNAMENT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// Per-batch timestamp: quando cada lote foi buscado pela última vez
const batchLastFetchedTs = {}; // { batchIndex: timestamp }



let lastAnalysisAt = null; // ISO timestamp of last successful auto-analysis cycle


// ── LoL Esports ──
const LOL_BASE = 'https://esports-api.lolesports.com/persisted/gw';
const LOL_LEAGUES = new Set([
  // Ligas Tier 1
  'worlds', 'msi', 'lcs', 'lck', 'lec', 'lpl', 'cblol-brazil', 'lla', 'pcs',
  'lco', 'vcs', 'ljl-japan', 'lcp',
  // Ligas Tier 2 / Regionais
  'emea_masters', 'emea-masters', 'lfl', 'nlc', 'lta_n', 'lta_s', 'lta',
  'turkiye-sampiyonluk-ligi', 'tcl', 'first_stand', 'americas_cup', 'nacl',
  'lck_challengers_league', 'lck-challengers-league', 'lck-cl',
  'primeleague', 'prime-league-pro-division', 'prime-league',
  'liga_portuguesa', 'lplol', 'lit', 'les', 'lrn', 'lrs',
  'hitpoint_masters', 'hitpoint-masters', 'hitpoint-winter',
  'esports_balkan_league', 'esport-balkan-league', 'ebl',
  'hellenic_legends_league', 'lta_cross',
  // Ligas adicionais da lista OddsPapi
  'gll', 'road-of-legends', 'road_of_legends', 'roadoflegends', 'ultraliga', 'elite-series', 'njcs', 'kjl',
  'arabian-league', 'lvp-superliga', 'ldl', 'cblol-academy',
  'circuito-desafiante', 'lcl', 'gll-pro-am', 'lfl-division-2',
  'finnish-pro-league-winter', 'finnish-pro-league',
  'asia-masters', 'asia-invitational',
  // EWC / Esports World Cup
  'road_to_ewc', 'road_to_ewc_lpl', 'road_to_ewc_lck', 'road_to_ewc_lec',
  'road_to_ewc_lcs', 'road_to_ewc_cblol', 'road_to_ewc_lcp',
  'ewc', 'ewc_lpl', 'esports_world_cup', 'esports_world_cup_lpl', 'esports-world-cup',
  // Slugs extras configuráveis via .env (ex: LOL_EXTRA_LEAGUES=slug1,slug2)
  ...(process.env.LOL_EXTRA_LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean),
]);

// Slugs vistos mas não reconhecidos — logados para diagnóstico
const unknownLolSlugs = new Set();

// ── Odds APIs ──
async function fetchOdds(sport) {
  if (sport === 'esports') return await fetchEsportsOdds();
}

// Backoff em caso de 429
let esportsBackoffUntil = 0;
const ESPORTS_BACKOFF_TTL = 2 * 60 * 60 * 1000;

// Round-robin: rastreia qual lote buscar no próximo ciclo
let esportsBatchCursor = 0;

// Cache de tournament IDs (24h)
let cachedEsportsTids = null;
let cachedEsportsTidsTs = 0;

// Torneios ordenados por prioridade:
// Lote 1 → T1 (LCS/LEC/LCK)
// Lote 2 → EU secundárias (Prime League, HLL, Road of Legends)
// Lote 3 → mais EU (LIT, Finnish, EMEA Masters)
// Lote 4 → CBLOL, NACL, LPL
// Lote 5 → LCK CL, LCP, outros
// Lote 6 → EWC e regionais restantes
const LOL_ACTIVE_TIDS = [
  // Lote 1 — T1
  2450,  // LCS
  2452,  // LEC
  2454,  // LCK
  // Lote 2 — EU secundárias prioritárias
  33814, // Prime League Pro Division (Alemanha)
  45623, // Hellenic Legends League (Grécia)
  45985, // Road of Legends (Portugal)
  // Lote 3 — mais EU
  50586, // LIT / LES (Itália / Espanha)
  50242, // Finnish Pro League (Finlândia)
  26590, // EMEA Masters
  // Lote 4 — América/Ásia
  26698, // CBLOL (Brasil)
  39009, // NACL
  39985, // LPL (China)
  // Lote 5 — secundárias Ásia/Pacífico
  36997, // LCK CL
  45589, // LCP (APAC)
  46117, // LRN
  // Lote 6 — regionais restantes
  46119, // LRS
  47864, // Esports World Cup
];

// Lista completa de todos os torneios de LoL conhecidos (fallback abrangente)
const LOL_ALL_TIDS = [
  2450, 2452, 2454, 2527, 2549,
  15488, 15490, 20918, 21962, 25019,
  26590, 26698, 26706, 26708, 27372, 28520, 29023, 31835,
  33678, 33680, 33814, 34012, 34018, 34020, 34460, 34466, 34676, 34678,
  36889, 36997, 39009, 39985, 39997, 40019,
  42873, 42997, 43193, 44181, 44639, 44641, 44643, 44645, 44647, 44659, 44673, 44903,
  45081, 45337, 45397, 45589, 45617, 45619, 45621, 45623, 45855, 45985,
  46117, 46119, 46121, 46331, 47864, 48993,
  50242, 50586, 50756, 50952, 50972,
];

// Busca tournament IDs dinamicamente via API; fallback para lista hardcoded
async function getEsportsTournamentIds() {
  const now = Date.now();
  if (cachedEsportsTids && (now - cachedEsportsTidsTs) < TOURNAMENT_CACHE_TTL) {
    return cachedEsportsTids;
  }

  // sportId=18 é o valor real do LoL na OddsPapi (confirmado pela resposta da API)
  const sid = parseInt(process.env.ODDSPAPI_ESPORTS_SPORT_ID || '18');
  try {
    const url = `https://api.oddspapi.io/v4/tournaments?sportId=${sid}&apiKey=${ODDSPAPI_KEY}`;
    const r = await httpGet(url).catch(() => null);
    if (r && r.status === 200) {
      const data = safeParse(r.body, null);
      const list = data ? (Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : [])) : [];
      const ids = list
        .filter(t => (t.futureFixtures || 0) + (t.upcomingFixtures || 0) + (t.liveFixtures || 0) > 0)
        .map(t => t.tournamentId || t.id).filter(Boolean);
      if (ids.length) {
        log('INFO', 'ODDS', `Torneios ativos via sportId=${sid}: ${ids.length}`);
        cachedEsportsTids = ids;
        cachedEsportsTidsTs = now;
        return cachedEsportsTids;
      }
    }
  } catch(_) {}

  // Fallback: usa lista de torneios ativos verificada
  log('INFO', 'ODDS', `Usando lista hardcoded: ${LOL_ACTIVE_TIDS.length} torneios ativos`);
  cachedEsportsTids = LOL_ACTIVE_TIDS;
  cachedEsportsTidsTs = now;
  return LOL_ACTIVE_TIDS;
}

// Extrai price de um outcome seguindo estrutura: outcome.price OU outcome.players[key].price
function extractPrice(outcome) {
  if (!outcome) return null;
  const p = parseFloat(outcome.price);
  if (!isNaN(p) && p > 1) return p;
  const players = outcome.players || {};
  for (const playerData of Object.values(players)) {
    const pp = parseFloat(playerData?.price);
    if (!isNaN(pp) && pp > 1) return pp;
  }
  return null;
}

// Normaliza a resposta da OddsPapi em array plano de fixtures
// Cobre: array plano, { data: [...] }, e agrupado por torneio { tournamentId, fixtures: [...] }
function normalizeFixtures(raw) {
  if (!raw) return [];
  let list = Array.isArray(raw) ? raw : (Array.isArray(raw.data) ? raw.data : []);
  // Se cada item tem .fixtures = agrupado por torneio
  if (list.length > 0 && list[0]?.fixtures) {
    return list.flatMap(t => t.fixtures || []);
  }
  return list;
}

/** Incorpora fixtures OddsPapi ao oddsCache (merge — não apaga chaves antigas). */
function ingestEsportsFixtures(allFixtures) {
  let cachedCount = 0;
  for (const f of allFixtures) {
    if (!f.bookmakerOdds) continue;

    const bkData = f.bookmakerOdds['1xbet'] || f.bookmakerOdds['1xBet']
      || Object.values(f.bookmakerOdds)[0];
    if (!bkData || !bkData.bookmakerIsActive) continue;

    let p1Name = f.participant1Name || f.homeName || '';
    let p2Name = f.participant2Name || f.awayName || '';
    let combinedSlug = '';

    if (!p1Name || !p2Name) {
      const fixturePath = bkData.fixturePath || '';
      if (fixturePath) {
        const lastSeg = fixturePath.split('/').pop() || '';
        const bkFid = bkData.bookmakerFixtureId || '';
        const teamsSlug = bkFid
          ? lastSeg.replace(new RegExp(`^${bkFid}-`), '')
          : lastSeg.replace(/^\d+-/, '');
        if (teamsSlug) {
          combinedSlug = teamsSlug;
          const parts = teamsSlug.split('-');
          if (parts.length >= 2) {
            const mid = Math.ceil(parts.length / 2);
            p1Name = parts.slice(0, mid).join('-');
            p2Name = parts.slice(mid).join('-');
          }
        }
      }
    }

    if (!combinedSlug && p1Name && p2Name) {
      combinedSlug = `${p1Name}-${p2Name}`;
    }

    if (!combinedSlug && !p1Name) continue;

    const markets = bkData.markets || {};
    const validMarkets = Object.entries(markets)
      .map(([mid, mData]) => {
        const outcomes = Object.values(mData.outcomes || {});
        if (outcomes.length !== 1) return null;
        const price = extractPrice(outcomes[0]);
        if (!price) return null;
        return { marketId: parseInt(mid) || 0, price };
      })
      .filter(Boolean)
      .sort((a, b) => a.marketId - b.marketId);

    if (validMarkets.length < 2) continue;

    const price1 = validMarkets[0].price;
    const price2 = validMarkets[1].price;

    const key = `esports_${f.fixtureId || norm(combinedSlug)}`;
    oddsCache[key] = {
      t1: price1.toFixed(2),
      t2: price2.toFixed(2),
      bookmaker: '1xBet',
      t1Name: p1Name || combinedSlug,
      t2Name: p2Name || '',
      combinedSlug: norm(combinedSlug),
      fixtureId: f.fixtureId || null,
      tournamentId: f.tournamentId || null,
    };
    log('DEBUG', 'ODDS', `Ingest: slug="${norm(combinedSlug)}" t1="${p1Name}" t2="${p2Name}" fid=${f.fixtureId||'?'}`);
    cachedCount++;
  }
  return cachedCount;
}

async function fetchEsportsOddsOneBatch(batch, batchIndex0, totalBatches) {
  log('INFO', 'ODDS', `Buscando odds: lote ${batchIndex0 + 1}/${totalBatches} tids=[${batch.join(',')}] (round-robin)`);

  const url = `https://api.oddspapi.io/v4/odds-by-tournaments?bookmaker=1xbet&tournamentIds=${batch.join(',')}&oddsFormat=decimal&apiKey=${ODDSPAPI_KEY}`;
  const r = await httpGet(url).catch(e => ({ status: 500, body: e.message }));

  log('DEBUG', 'ODDS', `Lote ${batchIndex0 + 1}: status=${r.status} body=${(r.body || '').slice(0, 100)}`);
  lastApiResponse = `Lote ${batchIndex0 + 1}/${totalBatches}: HTTP ${r.status} | ${(r.body || '').slice(0, 150)}`;

  const now = Date.now();
  if (r.status === 429) {
    esportsBackoffUntil = now + ESPORTS_BACKOFF_TTL;
    log('WARN', 'ODDS', '429 — backoff 2h ativado');
    return { ok: false, status: 429 };
  }
  if (r.status !== 200) {
    log('WARN', 'ODDS', `HTTP ${r.status} — sem atualização de odds`);
    return { ok: false, status: r.status };
  }

  const raw = safeParse(r.body, null);
  const allFixtures = raw ? normalizeFixtures(raw) : [];
  log('INFO', 'ODDS', `Fixtures recebidos: ${allFixtures.length} no lote ${batchIndex0 + 1}`);

  const cachedCount = ingestEsportsFixtures(allFixtures);
  log('INFO', 'ODDS', `Sync concluído: ${cachedCount}/${allFixtures.length} fixtures com odds`);
  return { ok: true, status: 200 };
}

async function fetchEsportsOdds() {
  if (!ODDSPAPI_KEY) { log('WARN', 'ODDS', 'ODDS_API_KEY não configurada — odds indisponíveis'); return; }
  if (esportsOddsFetching) return;
  const now = Date.now();
  if (now - lastEsportsOddsUpdate < ESPORTS_ODDS_TTL) return;
  if (now < esportsBackoffUntil) { log('INFO', 'ODDS', 'Em backoff — aguardando'); return; }

  esportsOddsFetching = true;
  lastApiResponse = 'Iniciando busca...';
  try {
    let tids = await getEsportsTournamentIds();
    log('DEBUG', 'ODDS', `getEsportsTournamentIds() retornou ${Array.isArray(tids) ? tids.length : typeof tids} IDs`);

    if (!Array.isArray(tids) || tids.length === 0) {
      log('WARN', 'ODDS', 'Lista de torneios inválida/vazia — usando LOL_ACTIVE_TIDS como fallback direto');
      tids = LOL_ACTIVE_TIDS;
      cachedEsportsTids = LOL_ACTIVE_TIDS;
    }

    const BATCH_SIZE = Math.max(1, parseInt(process.env.ODDSPAPI_BATCH_SIZE || '3') || 3);
    const batches = [];
    for (let i = 0; i < tids.length; i += BATCH_SIZE) {
      batches.push(tids.slice(i, i + BATCH_SIZE));
    }

    if (!batches.length) {
      log('WARN', 'ODDS', 'batches vazio após split — usando LOL_ACTIVE_TIDS completo');
      batches.push(LOL_ACTIVE_TIDS.slice(0, BATCH_SIZE));
    }

    const batchIndex = esportsBatchCursor % batches.length;
    esportsBatchCursor++;
    let batch = batches[batchIndex];

    if (!batch || !batch.length) {
      log('WARN', 'ODDS', `Batch[${batchIndex}] vazio — usando primeiro lote de LOL_ACTIVE_TIDS`);
      batch = LOL_ACTIVE_TIDS.slice(0, BATCH_SIZE);
    }

    const { ok } = await fetchEsportsOddsOneBatch(batch, batchIndex, batches.length);
    if (ok) {
      lastEsportsOddsUpdate = now;
      batchLastFetchedTs[batchIndex] = now;
    }
  } catch(e) {
    log('ERROR', 'ODDS', `fetchEsportsOdds: ${e.message}`);
  } finally {
    esportsOddsFetching = false;
  }
}

/** Após deploy só existia 1 lote no cache → poucos match (ex: 3/25). Opcional no Railway. */
let esportsOddsBootstrapRunning = false;
async function bootstrapEsportsOddsExtraBatches() {
  if (process.env.ODDSPAPI_BOOTSTRAP !== 'true' || !ODDSPAPI_KEY) return;
  if (esportsOddsBootstrapRunning || esportsOddsFetching) return;
  if (Date.now() < esportsBackoffUntil) {
    log('WARN', 'ODDS', 'Bootstrap odds ignorado (backoff ativo)');
    return;
  }

  esportsOddsBootstrapRunning = true;
  try {
    let tids = await getEsportsTournamentIds();
    if (!Array.isArray(tids) || tids.length === 0) tids = LOL_ACTIVE_TIDS;

    const BATCH_SIZE = Math.max(1, parseInt(process.env.ODDSPAPI_BATCH_SIZE || '3') || 3);
    const batches = [];
    for (let i = 0; i < tids.length; i += BATCH_SIZE) batches.push(tids.slice(i, i + BATCH_SIZE));
    if (batches.length <= 1) {
      log('INFO', 'ODDS', 'Bootstrap: apenas 1 lote de torneios — nada extra a buscar');
      return;
    }

    log('INFO', 'ODDS', `ODDSPAPI_BOOTSTRAP=true: buscando mais ${batches.length - 1} lote(s) para preencher cache após deploy`);

    const gapMs = Math.max(1000, parseInt(process.env.ODDSPAPI_BOOTSTRAP_MS || '2500', 10) || 2500);
    for (let i = 1; i < batches.length; i++) {
      if (Date.now() < esportsBackoffUntil) {
        log('WARN', 'ODDS', 'Bootstrap interrompido (backoff)');
        break;
      }
      await new Promise(r => setTimeout(r, gapMs));
      const { ok } = await fetchEsportsOddsOneBatch(batches[i], i, batches.length);
      if (!ok) break;
    }

    esportsBatchCursor = batches.length;
    lastEsportsOddsUpdate = Date.now();
    const n = Object.keys(oddsCache).filter(k => k.startsWith('esports_')).length;
    log('INFO', 'ODDS', `Bootstrap concluído — ~${n} entradas no cache esports`);
  } catch(e) {
    log('ERROR', 'ODDS', `bootstrapEsportsOdds: ${e.message}`);
  } finally {
    esportsOddsBootstrapRunning = false;
  }
}

// ── Mapeamento slug de liga → tournament ID (para force-fetch em partidas ao vivo) ──
const SLUG_TO_TID = {
  'lcs': 2450,
  'lec': 2452,
  'lck': 2454,
  'primeleague': 33814, 'prime-league': 33814, 'prime-league-pro-division': 33814,
  'hellenic_legends_league': 45623,
  'road-of-legends': 45985, 'road_of_legends': 45985, 'roadoflegends': 45985,
  'lit': 50586, 'les': 50586,
  'finnish-pro-league': 50242, 'finnish-pro-league-winter': 50242,
  'emea_masters': 26590, 'emea-masters': 26590,
  'cblol-brazil': 26698,
  'nacl': 39009,
  'lpl': 39985, 'ldl': 39985,
  'lck_challengers_league': 36997, 'lck-challengers-league': 36997, 'lck-cl': 36997,
  'lcp': 45589,
  'lrn': 46117,
  'lrs': 46119,
  'ewc': 47864, 'esports_world_cup': 47864, 'esports-world-cup': 47864,
  'gll': 45855, 'ultraliga': 45617, 'njcs': 45619, 'kjl': 45621,
  'circuito-desafiante': 26708, 'cblol-academy': 26708,
};

/** Force-fetch de odds para torneios específicos (ignora round-robin TTL). Usado para live matches. */
async function fetchEsportsOddsForTids(tids) {
  if (!ODDSPAPI_KEY || !tids || !tids.length) return;
  if (Date.now() < esportsBackoffUntil) { log('INFO', 'ODDS', 'Force-fetch ignorado (backoff ativo)'); return; }
  const BATCH_SIZE = Math.max(1, parseInt(process.env.ODDSPAPI_BATCH_SIZE || '3') || 3);
  const batches = [];
  for (let i = 0; i < tids.length; i += BATCH_SIZE) batches.push(tids.slice(i, i + BATCH_SIZE));
  log('INFO', 'ODDS', `Force-fetch live: ${tids.length} torneio(s) em ${batches.length} lote(s)`);
  for (let i = 0; i < batches.length; i++) {
    if (Date.now() < esportsBackoffUntil) break;
    const { ok } = await fetchEsportsOddsOneBatch(batches[i], i, batches.length);
    if (!ok) break;
    if (i < batches.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

// ── Suporte a Apelidos/Abreviações de Times ──
const LOL_ALIASES = {
  // LCK
  'nongshimredforce': ['ns', 'nongshim', 'nsredforce'],
  'hanwhalifeesports': ['hle', 'hanwha', 'hanwhalife'],
  'dpluskia': ['dk', 'dplus', 'dwg', 'damwon'],
  'kiwoomdrx': ['drx'],
  'ktrolster': ['kt'],
  'geng': ['gen', 'gengolden', 'gengaming'],
  't1': ['skt', 'skt1'],
  'hanwhajinbrion': ['brion', 'bro', 'hanjinbrion', 'jinbrion'],
  'brochallengers': ['bro', 'brion', 'hanwhajinbrion'],
  'dnsoopers': ['dns', 'soopers'],
  'dnschallengers': ['dns', 'dnsoopers'],
  'fearx': ['fearxesports', 'fx'],
  // LCS
  'cloud9': ['c9'],
  'teamliquid': ['tl', 'liquid'],
  'flyquest': ['fly', 'fq'],
  '100thieves': ['100t'],
  'digitalsports': ['dig', 'disguised', 'dsg'],
  'dignitas': ['dig', 'digs', 'team dignitas'],
  'disguised': ['dsg', 'dig'],
  'shopifyrebellion': ['sr', 'shopify', 'rebellion'],
  'sentinels': ['sen'],
  'lyongaming': ['lg', 'lyon'],
  // LEC
  'giantsgaming': ['gnt', 'giants'],
  'teamvitality': ['vit', 'vitality'],
  'fnatic': ['fnc'],
  'rogue': ['rog'],
  'movistarkoi': ['koi', 'movistar'],
  'natusvincere': ['navi', 'nv'],
  'skgaming': ['sk'],
  'teamheretics': ['th', 'heretics'],
  'giantx': ['gx'],
  'shifters': ['skgamingshifters'],
  'madlions': ['mad'],
  'bds': ['bdsgaming', 'bdsesport'],
  'g2esports': ['g2'],
  // LPL
  'jdggaming': ['jdg'],
  'beijingjdgesports': ['jdg', 'jdggaming'],
  'bilibiliblaze': ['blg', 'bilibili'],
  'bilibiligaming': ['blg', 'bilibili', 'bilibiliblaze'],
  'ninerosters': ['ninerosters', 'nip'],
  'weibo': ['wbg', 'weiboesports'],
  'topesports': ['tes'],
  'invictusgaming': ['ig'],
  'anyoneslegend': ['al', 'anyone'],
  // LPL — Riot API usa prefixo de cidade, OddsPapi não
  'xianteamwe': ['teamwe', 'we'],
  'shenzhenninjasinpyjamas': ['ninjasinpyjamas', 'nip', 'ninjas'],
  // CBLOL
  'paingaming': ['png', 'pain'],
  'redcanidskalunga': ['redcanids', 'red'],
  'fluxo': ['flx'],
  'kabum': ['kbm'],
  'loud': ['lod'],
  'isurus': ['isr'],
  'vivokeydstars': ['keydstars', 'keyd', 'vivo'],
  'keydstars': ['keyd', 'vivo', 'vivokeydstars'],
  // LLA / LTA
  'losleviatanesports': ['leviatan', 'losleviatan', 'los'],
  'leviatanesports': ['leviatan', 'losleviatan'],
  // Prime League (Alemanha)
  'berlininternationalgaming': ['big', 'berlin'],
  'g2nord': ['g2n'],
  'ewieeinfachesports': ['ewe', 'ewieeinfach'],
  'vfbstuttgart': ['vfb', 'stuttgart'],
  'vfbesports': ['vfb', 'stuttgart'],
  'eintrachtfrankfurt': ['sge', 'frankfurt', 'eintracht'],
  'eintrachtspandau': ['spandau', 'efs'],
  'kauflandhangryknights': ['hk', 'hangryknights'],
  'unicornsoflovesexyedition': ['uol', 'unicorns', 'unicornsoflove'],
  'rossmanncentaurs': ['centaurs', 'rossmann'],
  'teamorangegaming': ['tog', 'orange'],
  // Hellenic Legends League (Grécia)
  'goalesports': ['goal'],
  'theparadox': ['paradox'],
  // LoL Italian Tournament
  'gmblersesports': ['gmblers', 'gmb'],
  'aeternaesports': ['aeterna'],
  'colossalgaming': ['colossal', 'clg'],
  'zenaesports': ['zena'],
  'ekoesports': ['eko'],
  'stonehengeesports': ['stonehenge', 'shg'],
  'hmble': ['humble'],
  // Road of Legends (Portugal)
  'senshiesports': ['senshi'],
  'senshiesportsclub': ['senshi'],
  'fritesesportsclub': ['frites'],
  'mythesports': ['myth'],
  'onceuponateam': ['ouat'],
  // NACL
  'ccgesports': ['ccg', 'ccgesport'],
  'supernova': ['snv', 'supernovaesports', 'supernovagg'],
  'doradogaming': ['dorado'],
  'nrgesports': ['nrg'],
  'citadelgaming': ['citadel'],
  // LCP
  'relovedeepcrossgaming': ['deepcrossgaming', 'deepcross'],
  'groundzerogaming': ['gzg', 'gz'],
  'detonationfocusme': ['dfm'],
};

function findOdds(sport, t1, t2) {
  const nt1 = norm(t1), nt2 = norm(t2);
  if (!nt1 || !nt2) return null;

  // Expande um nome normalizado com seus aliases conhecidos
  const expandWithAliases = (n) => {
    const variants = new Set([n]);
    for (const [key, aliases] of Object.entries(LOL_ALIASES)) {
      if (n.includes(key) || key.includes(n) || aliases.includes(n)) {
        aliases.forEach(a => variants.add(a));
        variants.add(key);
      }
    }
    return variants;
  };

  const variants1 = expandWithAliases(nt1);
  const variants2 = expandWithAliases(nt2);

  // Verifica se alguma variante do nome está contida no slug alvo
  const anyMatch = (variants, targetSlug) =>
    [...variants].some(v => v.length >= 2 && targetSlug.includes(v));

  for (const [cacheKey, val] of Object.entries(oddsCache)) {
    if (!cacheKey.startsWith(`${sport}_`)) continue;

    // ── Modo 1: combinedSlug (formato OddsPapi — sem nomes separados) ──
    if (val.combinedSlug) {
      const cs = val.combinedSlug;
      if (anyMatch(variants1, cs) && anyMatch(variants2, cs)) {
        return { t1: val.t1, t2: val.t2, bookmaker: val.bookmaker };
      }
      continue;
    }

    // ── Modo 2: nomes individuais (formato legado) ──
    if (!val.t1Name || !val.t2Name) continue;
    const vt1 = norm(val.t1Name);
    const vt2 = norm(val.t2Name);

    if (anyMatch(variants1, vt1) && anyMatch(variants2, vt2)) {
      return { t1: val.t1, t2: val.t2, bookmaker: val.bookmaker };
    }
    // Ordem invertida
    if (anyMatch(variants1, vt2) && anyMatch(variants2, vt1)) {
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
    leagueSlug: slug,
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

    // ── 1. getLive primeiro — fonte mais confiável para matches ao vivo (especialmente LPL) ──
    const liveLeagues = new Set();
    try {
      const glr = await httpGet(LOL_BASE + '/getLive?hl=en-US', { 'x-api-key': LOL_KEY });
      const gld = safeParse(glr.body, {});
      const getLiveEvts = gld?.data?.schedule?.events || [];
      // Log bruto de TODOS os eventos do getLive para diagnóstico
      log('DEBUG', 'LOL', `getLive raw: ${getLiveEvts.length} eventos | ${getLiveEvts.map(e => `[${e.type}|${e.state}|${e.league?.slug}]`).join(' ')}`);
      getLiveEvts.filter(e => e.type === 'match' && e.match)
        .map(e => mapLoLEvent(e, 'live')).filter(Boolean)
        .forEach(m => { if (!live.find(l => l.id === m.id)) live.push(m); });
      getLiveEvts.filter(e => e.type === 'show' && e.state === 'inProgress')
        .forEach(e => { if (e.league?.name) liveLeagues.add(e.league.name); });
    } catch(e) { log('WARN', 'LOL', 'getLive err: ' + e.message); }

    // ── 1b. Também busca getLive com hl=zh-CN (LPL às vezes só aparece com locale chinês) ──
    try {
      const glrCN = await httpGet(LOL_BASE + '/getLive?hl=zh-CN', { 'x-api-key': LOL_KEY });
      const gldCN = safeParse(glrCN.body, {});
      const getLiveCN = gldCN?.data?.schedule?.events || [];
      if (getLiveCN.length) {
        log('DEBUG', 'LOL', `getLive zh-CN raw: ${getLiveCN.length} eventos | ${getLiveCN.map(e => `[${e.type}|${e.state}|${e.league?.slug}]`).join(' ')}`);
        getLiveCN.filter(e => e.type === 'match' && e.match)
          .map(e => mapLoLEvent(e, 'live')).filter(Boolean)
          .forEach(m => { if (!live.find(l => l.id === m.id)) live.push(m); });
        getLiveCN.filter(e => e.type === 'show' && e.state === 'inProgress')
          .forEach(e => { if (e.league?.name) liveLeagues.add(e.league.name); });
      }
    } catch(e) { log('WARN', 'LOL', 'getLive zh-CN err: ' + e.message); }

    // ── 2. getSchedule — schedule completo ──
    try {
      const sr = await httpGet(LOL_BASE + '/getSchedule?hl=en-US', { 'x-api-key': LOL_KEY });
      const sd = safeParse(sr.body, {});
      mainEvs = sd?.data?.schedule?.events || [];
      newerToken = sd?.data?.schedule?.pages?.newer;
    } catch(e) { log('WARN', 'LOL', 'Schedule err: ' + e.message); }

    // Log dos eventos LPL no schedule para diagnóstico
    const lplEvs = mainEvs.filter(e => e.league?.slug === 'lpl');
    if (lplEvs.length) log('DEBUG', 'LOL', `LPL no schedule: ${lplEvs.map(e => `[${e.type}|${e.state}|${e.match?.teams?.map(t=>t.code||t.name).join('v')||''}]`).join(' ')}`);
    else log('DEBUG', 'LOL', 'LPL no schedule: nenhum evento encontrado');

    // Adiciona liveLeagues do schedule (shows em progresso)
    mainEvs.filter(e => e.type === 'show' && e.state === 'inProgress' && LOL_LEAGUES.has(e.league?.slug))
      .forEach(e => { if (e.league?.name) liveLeagues.add(e.league.name); });

    // Matches explicitamente inProgress no schedule
    mainEvs.filter(e => e.type === 'match' && e.match && e.state === 'inProgress')
      .map(e => mapLoLEvent(e, 'live')).filter(Boolean)
      .forEach(m => { if (!live.find(l => l.id === m.id)) live.push(m); });

    // Matches com score parcial em ligas com transmissão ao vivo = LIVE
    const now = Date.now();
    const liveFromShows = mainEvs.filter(e => {
      if (e.type !== 'match' || !e.match || e.state !== 'unstarted') return false;
      if (!liveLeagues.has(e.league?.name)) return false;
      const t1 = e.match.teams?.[0], t2 = e.match.teams?.[1];
      const w1 = t1?.result?.gameWins || 0, w2 = t2?.result?.gameWins || 0;
      // Detecta live: tem score OU startTime já passou (jogo começou mas score ainda 0-0)
      const startedAgo = e.startTime ? (now - new Date(e.startTime).getTime()) / 60000 : -1;
      const hasScore = w1 > 0 || w2 > 0;
      const timeStarted = startedAgo > 2 && startedAgo < 300; // entre 2min e 5h atrás
      if (!hasScore && !timeStarted) return false;
      const boCount = e.match.strategy?.count || 3;
      const winsNeeded = Math.ceil(boCount / 2);
      return !(w1 >= winsNeeded || w2 >= winsNeeded);
    }).map(e => mapLoLEvent(e, 'live')).filter(Boolean);
    liveFromShows.forEach(m => { if (!live.find(l => l.id === m.id)) live.push(m); });

    // Matches sem score dentro de transmissão ao vivo = draft
    const upcomingInShow = mainEvs.filter(e => {
      if (e.type !== 'match' || !e.match || e.state !== 'unstarted') return false;
      if (!liveLeagues.has(e.league?.name)) return false;
      const startedAgo = e.startTime ? (now - new Date(e.startTime).getTime()) / 60000 : -1;
      if (startedAgo > 2) return false; // já deveria ter começado — não é draft
      const t1 = e.match.teams?.[0], t2 = e.match.teams?.[1];
      return (t1?.result?.gameWins || 0) === 0 && (t2?.result?.gameWins || 0) === 0;
    }).map(e => mapLoLEvent(e, 'draft')).filter(Boolean);

    upcoming = mainEvs.filter(e =>
      e.type === 'match' && e.match && e.state === 'unstarted' && !liveLeagues.has(e.league?.name)
    ).map(e => mapLoLEvent(e, 'upcoming')).filter(Boolean);
    upcoming = [...upcomingInShow, ...upcoming];

    if (!upcoming.length && newerToken) {
      try {
        const nr = await httpGet(LOL_BASE + '/getSchedule?hl=en-US&pageToken=' + encodeURIComponent(newerToken), { 'x-api-key': LOL_KEY });
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
    let oddsFound = 0;
    result.forEach(m => {
      const o = findOdds('esports', m.team1, m.team2);
      if (o) { m.odds = o; oddsFound++; }
    });

    // Force-fetch odds para partidas ao vivo / draft sem odds (ignora round-robin TTL)
    const liveNoOdds = result.filter(m => (m.status === 'live' || m.status === 'draft') && !m.odds);
    if (liveNoOdds.length > 0) {
      const tidsToFetch = new Set();
      for (const m of liveNoOdds) {
        // Tenta pelo slug da liga
        const tid = SLUG_TO_TID[m.leagueSlug];
        if (tid) tidsToFetch.add(tid);
        // Tenta pelo tournamentId já no cache (para partidas conhecidas)
        for (const v of Object.values(oddsCache)) {
          if (v.tournamentId && v.combinedSlug && (
            v.combinedSlug.includes(norm(m.team1)) || v.combinedSlug.includes(norm(m.team2))
          )) tidsToFetch.add(v.tournamentId);
        }
      }
      if (tidsToFetch.size > 0) {
        await fetchEsportsOddsForTids([...tidsToFetch]);
        liveNoOdds.forEach(m => {
          if (m.odds) return;
          const o = findOdds('esports', m.team1, m.team2);
          if (o) { m.odds = o; oddsFound++; }
        });
      }
    }

    const noOdds = result.filter(m => !m.odds).map(m => `${norm(m.team1)}v${norm(m.team2)}`);
    log('INFO', 'LOL', `${result.length} partidas (${live.length} live, ${upcoming.filter(m=>m.status==='draft').length} draft) | odds: ${oddsFound}/${result.length}${noOdds.length ? ` | sem match: ${noOdds.slice(0,3).join(', ')}` : ''}`);
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

    function psMatchList(body, fallbackLabel) {
      const p = safeParse(body, []);
      if (Array.isArray(p)) return p;
      if (p && Array.isArray(p.data)) return p.data;
      if (p && Array.isArray(p.results)) return p.results;
      if (p && typeof p === 'object') {
        log('WARN', 'PANDASCORE', `${fallbackLabel}: resposta não é lista (tipo ${typeof p}), ignorando`);
      }
      return [];
    }
    const running = psMatchList(runningRaw.body, 'running');
    const upcoming = psMatchList(upcomingRaw.body, 'upcoming');

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
    // Partidas live/draft: usa SOMENTE Riot API (evita duplicata de análise ao vivo)
    const riotHasLive = riotMatches.some(m => m.status === 'live' || m.status === 'draft');
    const combined = [...riotMatches];
    for (const pm of psMatches) {
      // Descarta live/draft da PandaScore se a Riot já tem ao vivo
      if (riotHasLive && (pm.status === 'live' || pm.status === 'draft')) continue;
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
      const sr = await httpGet(LOL_BASE + '/getSchedule?hl=en-US', { 'x-api-key': LOL_KEY });
      const sd = safeParse(sr.body, {});
      const evs = sd?.data?.schedule?.events || [];

      // Busca getLive também
      let liveEvs = [];
      try {
        const glr = await httpGet(LOL_BASE + '/getLive?hl=en-US', { 'x-api-key': LOL_KEY });
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
        const dr = await httpGet(`${LOL_BASE}/getEventDetails?hl=en-US&id=${matchId}`, { 'x-api-key': LOL_KEY });
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

  if (p === '/odds') {
    const t1 = parsed.query.team1 || parsed.query.p1 || '';
    const t2 = parsed.query.team2 || parsed.query.p2 || '';
    if (!t1 || !t2) { sendJson(res, { error: 'team1 e team2 obrigatórios' }, 400); return; }
    // force=1: bypassa TTL do cache (usado para partidas iminentes < 2h)
    if (parsed.query.force === '1') {
      lastEsportsOddsUpdate = 0;
      log('INFO', 'ODDS', `Force refresh solicitado para ${t1} vs ${t2} (partida iminente)`);
    }
    await fetchOdds('esports');
    const o = findOdds('esports', t1, t2);
    sendJson(res, o || { error: 'odds não encontradas' });
    return;
  }

  if (p === '/debug-odds') {
    const cacheEntries = Object.entries(oddsCache).filter(([k]) => k.startsWith('esports_'));
    const esportsAge = lastEsportsOddsUpdate > 0 ? Math.round((Date.now() - lastEsportsOddsUpdate) / 1000) : null;
    const backoffSec = esportsBackoffUntil > Date.now()
      ? Math.round((esportsBackoffUntil - Date.now()) / 1000)
      : 0;
    const BATCH_SIZE_DBG = parseInt(process.env.ODDSPAPI_BATCH_SIZE || '3');
    const tidsForDbg = cachedEsportsTids || LOL_ACTIVE_TIDS;
    const totalBatches = Math.ceil(tidsForDbg.length / BATCH_SIZE_DBG);
    const nextBatchIdx = esportsBatchCursor % totalBatches;
    const ttlHours = (parseInt(process.env.ESPORTS_ODDS_TTL_H || '') || 3);
    sendJson(res, {
      count: cacheEntries.length,
      lastSync: lastEsportsOddsUpdate ? new Date(lastEsportsOddsUpdate).toISOString() : 'nunca',
      lastSyncAgoSec: esportsAge,
      backoffRemainingSeconds: backoffSec,
      tournamentIdsCache: tidsForDbg.length,
      ttlHours,
      roundRobin: {
        cursor: esportsBatchCursor,
        nextBatch: nextBatchIdx + 1,
        totalBatches,
        nextTids: tidsForDbg.slice(nextBatchIdx * BATCH_SIZE_DBG, (nextBatchIdx + 1) * BATCH_SIZE_DBG),
        cycleCompletesIn: `${((totalBatches - (esportsBatchCursor % totalBatches)) * ttlHours)}h`,
      },
      lastApiResponse: lastApiResponse.slice(0, 300),
      slugs: cacheEntries.map(([k, v]) => ({
        slug: v.combinedSlug || norm(v.t1Name || '') + norm(v.t2Name || ''),
        t1: v.t1,
        t2: v.t2
      }))
    });
    return;
  }

  // Lista todos os times retornados pela API Riot + PandaScore com status de odds
  if (p === '/debug-teams') {
    try {
      const [riotMatches, psMatches] = await Promise.all([
        getLoLMatches().catch(() => []),
        getPandaScoreLolMatches().catch(() => [])
      ]);
      const allMatches = [...riotMatches, ...psMatches];
      const cacheCount = Object.keys(oddsCache).filter(k => k.startsWith('esports_')).length;
      const teamMap = allMatches.map(m => ({
        source: riotMatches.includes(m) ? 'riot' : 'pandascore',
        league: m.league,
        team1: m.team1,
        team2: m.team2,
        team1norm: norm(m.team1),
        team2norm: norm(m.team2),
        hasOdds: !!m.odds,
        odds: m.odds ? { t1: m.odds.t1, t2: m.odds.t2 } : null
      }));
      sendJson(res, {
        total: allMatches.length,
        withOdds: teamMap.filter(m => m.hasOdds).length,
        cacheSize: cacheCount,
        matches: teamMap
      });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // Diagnóstico de matching: testa se um par de times encontra odds no cache
  if (p === '/debug-match-odds') {
    const t1 = parsed.query.team1 || '';
    const t2 = parsed.query.team2 || '';
    const nt1 = norm(t1), nt2 = norm(t2);
    const expandWithAliases = n => {
      const variants = new Set([n]);
      for (const [key, aliases] of Object.entries(LOL_ALIASES)) {
        if (n.includes(key) || key.includes(n)) { aliases.forEach(a => variants.add(a)); variants.add(key); }
      }
      return [...variants];
    };
    const v1 = expandWithAliases(nt1), v2 = expandWithAliases(nt2);
    const anyMatch = (variants, slug) => variants.some(v => v.length >= 2 && slug.includes(v));
    const cacheEntries = Object.entries(oddsCache).filter(([k]) => k.startsWith('esports_'));
    const checks = cacheEntries.map(([k, val]) => {
      const cs = val.combinedSlug || '';
      return {
        slug: cs,
        t1InSlug: v1.filter(v => v.length >= 2 && cs.includes(v)),
        t2InSlug: v2.filter(v => v.length >= 2 && cs.includes(v)),
        matched: anyMatch(v1, cs) && anyMatch(v2, cs)
      };
    });
    const result = findOdds('esports', t1, t2);
    sendJson(res, {
      query: { team1: t1, team2: t2 },
      normalized: { nt1, nt2 },
      variants1: v1, variants2: v2,
      found: result,
      cacheSize: cacheEntries.length,
      checks
    });
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
      const sr = await httpGet(LOL_BASE + '/getSchedule?hl=en-US', { 'x-api-key': LOL_KEY });
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

  // ── Resultado PandaScore (settlement de tips ps_*) ──
  if (p === '/ps-result') {
    const rawId = parsed.query.matchId || '';
    const psId = rawId.replace('ps_', '');
    if (!psId) { sendJson(res, { resolved: false, error: 'matchId obrigatório' }, 400); return; }
    if (!PANDASCORE_TOKEN) { sendJson(res, { resolved: false, error: 'PANDASCORE_TOKEN não configurado' }); return; }
    try {
      const r = await httpGet(`https://api.pandascore.co/lol/matches/${psId}`, { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` });
      const m = safeParse(r.body, {});
      const winner = m.winner?.name || null;
      if (winner) {
        const t1 = m.opponents?.[0]?.opponent?.name || '';
        const t2 = m.opponents?.[1]?.opponent?.name || '';
        stmts.upsertMatchResult.run(rawId, 'lol', t1, t2, winner, '', m.league?.name || '');
        sendJson(res, { matchId: rawId, winner, resolved: true });
      } else {
        sendJson(res, { matchId: rawId, resolved: false });
      }
    } catch(e) {
      sendJson(res, { matchId: rawId, resolved: false, error: e.message });
    }
    return;
  }

  // ── Usuários ──
  if (p === '/users') {
    const subscribed = parsed.query.subscribed;
    const users = subscribed ? stmts.getSubscribedUsers.all() : db.prepare('SELECT * FROM users').all();
    sendJson(res, users);
    return;
  }

  if (p === '/save-user' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { userId, username, subscribed, sportPrefs } = safeParse(body, {});
        if (!userId) { sendJson(res, { error: 'Missing userId' }, 400); return; }
        stmts.upsertUser.run(userId, username || '', subscribed ? 1 : 0, JSON.stringify(sportPrefs || []));
        sendJson(res, { ok: true });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  // ── Tips ──
  if (p === '/unsettled-tips') {
    const sport = parsed.query.sport || 'esports';
    const days = parsed.query.days || '30';
    const tips = stmts.getUnsettledTips.all(sport, `-${days} days`);
    sendJson(res, tips.map(t => ({
      ...t,
      match_id: t.match_id,
      participant1: t.participant1,
      participant2: t.participant2,
      tip_participant: t.tip_participant,
    })));
    return;
  }

  if (p === '/record-tip' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const sport = parsed.query.sport || 'esports';
        const t = safeParse(body, {});
        if (!t.matchId) { sendJson(res, { error: 'Missing matchId' }, 400); return; }
        const isLive = t.isLive ? 1 : 0;
        const result = stmts.insertTip.run({
          sport, matchId: String(t.matchId), eventName: t.eventName || '',
          p1: t.p1 || t.team1 || t.fighter1 || '', p2: t.p2 || t.team2 || t.fighter2 || '',
          tipParticipant: t.tipParticipant || t.tipTeam || '', odds: parseFloat(t.odds) || 0,
          ev: parseFloat(t.ev) || 0, stake: String(t.stake || ''), confidence: t.confidence || 'MÉDIA',
          isLive, botToken: t.botToken || ''
        });
        // Calcula stake em reais com base na banca atual (1u = 1% da banca atual)
        try {
          const bk = stmts.getBankroll.get();
          if (bk && result.lastInsertRowid) {
            const unitValue = bk.current_banca / 100;
            const stakeUnits = parseFloat(String(t.stake || '1').replace('u','')) || 1;
            const stakeReais = parseFloat((stakeUnits * unitValue).toFixed(2));
            stmts.updateTipFinanceiro.run(stakeReais, null, result.lastInsertRowid);
          }
        } catch(_) {}
        // Grava odds de abertura para CLV tracking
        if (t.odds) {
          stmts.updateTipOpenOdds.run(parseFloat(t.odds), String(t.matchId), sport);
        }
        stmts.incrementApiUsage.run(sport, new Date().toISOString().slice(0,7));
        sendJson(res, { ok: true });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  if (p === '/resync-stats' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const payload = safeParse(body, {});
        const force = payload.force === true;
        log('INFO', 'ADMIN', `Re-sync de stats solicitado (force=${force})`);
        const result = await syncProStats({ forceResync: force });
        sendJson(res, result);
      } catch(e) { sendJson(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  if (p === '/reset-tips' && req.method === 'POST') {
    const sport = parsed.query.sport || 'esports';
    const count = db.prepare("SELECT COUNT(*) as c FROM tips WHERE sport = ?").get(sport).c;
    db.prepare("DELETE FROM tips WHERE sport = ?").run(sport);
    db.prepare("UPDATE bankroll SET current_banca = initial_banca, updated_at = datetime('now')").run();
    log('INFO', 'ADMIN', `Tips resetadas: ${count} registros removidos (sport=${sport})`);
    sendJson(res, { ok: true, deleted: count });
    return;
  }

  if (p === '/tips-history') {
    const sport = parsed.query.sport || 'esports';
    const limit = parseInt(parsed.query.limit) || 20;
    const filter = parsed.query.filter;
    let query = 'SELECT * FROM tips WHERE sport = ?';
    if (filter === 'settled') query += " AND result IS NOT NULL";
    else if (filter === 'pending') query += " AND result IS NULL";
    else if (filter === 'win') query += " AND result = 'win'";
    else if (filter === 'loss') query += " AND result = 'loss'";
    query += ` ORDER BY sent_at DESC LIMIT ${limit}`;
    sendJson(res, db.prepare(query).all(sport));
    return;
  }

  if (p === '/settle' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { matchId, winner } = safeParse(body, {});
        const sport = parsed.query.sport || 'esports';
        if (!matchId || !winner) { sendJson(res, { error: 'Missing matchId/winner' }, 400); return; }
        const tips = db.prepare("SELECT * FROM tips WHERE match_id = ? AND sport = ? AND result IS NULL").all(matchId, sport);
        let settled = 0;
        let bancaDelta = 0;
        for (const tip of tips) {
          const result = norm(tip.tip_participant).includes(norm(winner)) ? 'win' : 'loss';
          stmts.settleTip.run(result, matchId, sport);
          // Atualiza profit_reais e acumula delta da banca
          const stakeR = tip.stake_reais || (() => {
            const bk = stmts.getBankroll.get();
            const uv = bk ? bk.current_banca / 100 : 1;
            const su = parseFloat(String(tip.stake || '1').replace('u','')) || 1;
            return parseFloat((su * uv).toFixed(2));
          })();
          const odds = parseFloat(tip.odds) || 1;
          const profitR = result === 'win'
            ? parseFloat((stakeR * (odds - 1)).toFixed(2))
            : parseFloat((-stakeR).toFixed(2));
          db.prepare("UPDATE tips SET stake_reais = ?, profit_reais = ? WHERE id = ?")
            .run(stakeR, profitR, tip.id);
          bancaDelta += profitR;
          settled++;
        }
        // Atualiza banca total
        if (bancaDelta !== 0) {
          const bk = stmts.getBankroll.get();
          if (bk) {
            const nova = parseFloat((bk.current_banca + bancaDelta).toFixed(2));
            stmts.updateBankroll.run(nova);
            log('INFO', 'BANCA', `Settlement: delta R$${bancaDelta >= 0 ? '+' : ''}${bancaDelta.toFixed(2)} → banca agora R$${nova}`);
          }
        }
        sendJson(res, { ok: true, settled, bancaDelta: parseFloat(bancaDelta.toFixed(2)) });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  // ── ROI e Estatísticas ──
  if (p === '/roi') {
    const sport = parsed.query.sport || 'esports';
    const row = stmts.getROI.get(sport);
    const calibration = stmts.getCalibration.all(sport);

    const tips = db.prepare("SELECT odds, stake, result, ev, is_live, clv_odds, open_odds FROM tips WHERE sport = ? AND result IS NOT NULL").all(sport);
    let totalStaked = 0, totalProfit = 0;
    const liveTips = { wins: 0, losses: 0, total: 0, profit: 0, staked: 0 };
    const preTips  = { wins: 0, losses: 0, total: 0, profit: 0, staked: 0 };

    // CLV: calculado apenas em tips com clv_odds registrado
    let clvSum = 0, clvCount = 0, clvPositive = 0;
    const clvLive = { sum: 0, count: 0, positive: 0 };
    const clvPre  = { sum: 0, count: 0, positive: 0 };

    for (const t of tips) {
      const stake = parseFloat(t.stake) || 1;
      const odds  = parseFloat(t.odds)  || 1;
      const profit = t.result === 'win' ? stake * (odds - 1) : -stake;
      totalStaked  += stake;
      totalProfit  += profit;
      const bucket = t.is_live ? liveTips : preTips;
      bucket.total++;
      bucket.staked += stake;
      bucket.profit += profit;
      if (t.result === 'win') bucket.wins++; else bucket.losses++;

      // CLV = (tipOdds / closingOdds - 1) × 100 → positivo = compramos melhor que o mercado fechou
      const clvOdds = parseFloat(t.clv_odds);
      if (clvOdds > 1) {
        const clv = (odds / clvOdds - 1) * 100;
        clvSum += clv;
        clvCount++;
        if (clv > 0) clvPositive++;
        const cb = t.is_live ? clvLive : clvPre;
        cb.sum += clv; cb.count++; if (clv > 0) cb.positive++;
      }
    }

    const roi = totalStaked > 0 ? ((totalProfit / totalStaked) * 100).toFixed(2) : '0.00';
    const calcBucketROI = b => b.staked > 0 ? ((b.profit / b.staked) * 100).toFixed(2) : '0.00';
    const calcCLV = c => c.count > 0 ? {
      avg: parseFloat((c.sum / c.count).toFixed(2)),
      positiveRate: Math.round(c.positive / c.count * 100),
      count: c.count
    } : null;

    // Dados da banca em reais
    const bk = stmts.getBankroll.get();
    const bancaInfo = bk ? {
      initialBanca: bk.initial_banca,
      currentBanca: bk.current_banca,
      unitValue: parseFloat((bk.current_banca / 100).toFixed(4)),
      profitReais: parseFloat((bk.current_banca - bk.initial_banca).toFixed(2)),
      growthPct: parseFloat(((bk.current_banca - bk.initial_banca) / bk.initial_banca * 100).toFixed(2)),
      updatedAt: bk.updated_at
    } : null;

    sendJson(res, {
      overall: {
        total: row?.total || 0, wins: row?.wins || 0, losses: row?.losses || 0,
        roi, totalProfit: totalProfit.toFixed(2), totalStaked: totalStaked.toFixed(2),
        avg_ev: row?.avg_ev || 0, avg_odds: row?.avg_odds || 0
      },
      calibration: calibration.map(c => ({ ...c, win_rate: c.win_rate?.toFixed(1) || '0.0' })),
      byPhase: {
        live:    { ...liveTips, roi: calcBucketROI(liveTips) },
        preGame: { ...preTips,  roi: calcBucketROI(preTips)  }
      },
      clv: clvCount > 0 ? {
        avg: parseFloat((clvSum / clvCount).toFixed(2)),
        positiveRate: Math.round(clvPositive / clvCount * 100),
        count: clvCount,
        byPhase: { live: calcCLV(clvLive), preGame: calcCLV(clvPre) }
      } : null,
      banca: bancaInfo
    });
    return;
  }

  // ── Bankroll endpoints ──
  if (p === '/bankroll') {
    const bk = stmts.getBankroll.get();
    if (!bk) { sendJson(res, { error: 'Bankroll não inicializado' }, 500); return; }
    sendJson(res, {
      initialBanca: bk.initial_banca,
      currentBanca: bk.current_banca,
      unitValue: parseFloat((bk.current_banca / 100).toFixed(4)),
      profitReais: parseFloat((bk.current_banca - bk.initial_banca).toFixed(2)),
      growthPct: parseFloat(((bk.current_banca - bk.initial_banca) / bk.initial_banca * 100).toFixed(2)),
      updatedAt: bk.updated_at
    });
    return;
  }

  if (p === '/set-bankroll' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { valor } = safeParse(body, {});
        const v = parseFloat(valor);
        if (!v || v <= 0) { sendJson(res, { error: 'valor inválido' }, 400); return; }
        stmts.resetBankroll.run(v, v);
        log('INFO', 'BANCA', `Banca redefinida para R$${v.toFixed(2)}`);
        sendJson(res, { ok: true, currentBanca: v, unitValue: parseFloat((v / 100).toFixed(4)) });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  // ── Champion WR pro play ──
  if (p === '/champ-winrates') {
    const champList = (parsed.query.champs || '').split(',').map(s => s.trim()).filter(Boolean);
    const roleList  = (parsed.query.roles  || '').split(',').map(s => s.trim()).filter(Boolean);
    const result = {};
    for (let i = 0; i < champList.length; i++) {
      const champ = champList[i];
      const role  = roleList[i] || 'unknown';
      let stat = stmts.getChampStat.get(champ, role);
      if (!stat) stat = stmts.getChampStatAnyRole.get(champ); // fallback: any role
      if (stat && stat.total >= 5) {
        result[champ] = { role: stat.role, winRate: Math.round(stat.wins / stat.total * 100), total: stat.total };
      }
    }
    sendJson(res, result);
    return;
  }

  // ── Player+champ WR pro play ──
  if (p === '/player-champ-stats') {
    const players = (parsed.query.players || '').split(',').map(s => s.trim()).filter(Boolean);
    const champs  = (parsed.query.champs  || '').split(',').map(s => s.trim()).filter(Boolean);
    const result = {};
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      const champ  = champs[i];
      if (!player) continue;
      if (champ) {
        const stat = stmts.getPlayerChampStat.get(player, champ);
        if (stat && stat.total >= 3) {
          result[`${player}/${champ}`] = { winRate: Math.round(stat.wins / stat.total * 100), total: stat.total };
        }
      } else {
        // Retorna top champs do jogador
        const rows = stmts.getPlayerChampStats.all(player);
        result[player] = rows.filter(r => r.total >= 3).map(r => ({
          champion: r.champion,
          winRate: Math.round(r.wins / r.total * 100),
          total: r.total
        }));
      }
    }
    sendJson(res, result);
    return;
  }

  // ── Sync pro stats (PandaScore → pro_champ_stats + match_results) ──
  if (p === '/sync-pro-stats') {
    if (!PANDASCORE_TOKEN) { sendJson(res, { ok: false, error: 'PANDASCORE_TOKEN não configurado' }); return; }
    syncProStats().then(r => sendJson(res, r)).catch(e => sendJson(res, { ok: false, error: e.message }));
    return;
  }

  // ── Form e H2H ──
  if (p === '/team-form' || p === '/form') {
    const team = parsed.query.team || parsed.query.name || '';
    const game = parsed.query.game || 'lol';
    if (!team) { sendJson(res, { error: 'team param required' }, 400); return; }
    const rows = stmts.getTeamForm.all(team, team, game);
    if (!rows.length) { sendJson(res, { wins: 0, losses: 0, winRate: 0, streak: '—' }); return; }
    let wins = 0, losses = 0, streak = '', streakCount = 0;
    for (const r of rows) {
      const won = norm(r.winner) === norm(team);
      if (wins + losses === 0) { streak = won ? 'W' : 'L'; streakCount = 1; }
      else if ((streak[0] === 'W') === won) streakCount++;
      else break;
      if (won) wins++; else losses++;
    }
    sendJson(res, { wins, losses, winRate: rows.length > 0 ? Math.round(wins / rows.length * 100) : 0, streak: `${streakCount}${streak}` });
    return;
  }

  if (p === '/h2h') {
    const t1 = parsed.query.team1 || '', t2 = parsed.query.team2 || '';
    const game = parsed.query.game || 'lol';
    if (!t1 || !t2) { sendJson(res, { totalMatches: 0, t1Wins: 0, t2Wins: 0 }); return; }
    const rows = stmts.getH2H.all(t1, t2, t2, t1, game);
    let t1w = 0, t2w = 0;
    for (const r of rows) {
      if (norm(r.winner) === norm(t1)) t1w++; else t2w++;
    }
    sendJson(res, { totalMatches: rows.length, t1Wins: t1w, t2Wins: t2w });
    return;
  }

  if (p === '/odds-movement') {
    const t1 = parsed.query.team1 || '', t2 = parsed.query.team2 || '';
    const sport = parsed.query.sport || 'esports';
    const matchKey = `${norm(t1)}_${norm(t2)}`;
    const history = stmts.getOddsMovement.all(sport, matchKey);
    sendJson(res, { match: `${t1} vs ${t2}`, history: history.map(h => ({
      odds_t1: h.odds_p1, odds_t2: h.odds_p2, bookmaker: h.bookmaker, recorded_at: h.recorded_at
    })) });
    return;
  }

  // ── DB Status ──
  if (p === '/db-status') {
    const sport = parsed.query.sport || 'esports';
    try {
      const s = stmts.getDBStatus.get(sport, sport, sport, sport, sport, sport);
      sendJson(res, s || {});
    } catch(e) { sendJson(res, { error: e.message }, 500); }
    return;
  }

  // ── AI Proxy (DeepSeek ou Claude) ──
  if (p === '/claude' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const payload = safeParse(body, null);
        if (!payload) { sendJson(res, { error: 'Invalid JSON' }, 400); return; }

        const useDeepSeek = !!(DEEPSEEK_KEY && (payload.model?.startsWith('deepseek') || !CLAUDE_KEY));

        if (useDeepSeek) {
          // ── DeepSeek (OpenAI-compatible) ──
          const dsPayload = {
            model: payload.model?.startsWith('deepseek') ? payload.model : 'deepseek-chat',
            max_tokens: payload.max_tokens || 1800,
            messages: payload.messages
          };
          const r = await httpsPost('https://api.deepseek.com/chat/completions', dsPayload, {
            'Authorization': `Bearer ${DEEPSEEK_KEY}`,
            'content-type': 'application/json'
          });
          const ds = safeParse(r.body, {});
          const text = ds.choices?.[0]?.message?.content || '';
          if (!text && ds.error) {
            log('WARN', 'AI', `DeepSeek erro: ${ds.error?.message || JSON.stringify(ds.error)}`);
            sendJson(res, { error: ds.error?.message || 'DeepSeek sem resposta' }, r.status || 500);
            return;
          }
          // Normaliza para o formato Claude (content[].text) para compatibilidade com bot.js
          sendJson(res, { content: [{ type: 'text', text }], model: dsPayload.model, provider: 'deepseek' });
        } else {
          // ── Claude (Anthropic) ──
          const key = req.headers['x-claude-key'] || CLAUDE_KEY;
          if (!key) { sendJson(res, { error: 'Nenhuma AI key configurada (DEEPSEEK_API_KEY ou CLAUDE_API_KEY)' }, 401); return; }
          const r = await httpsPost('https://api.anthropic.com/v1/messages', payload, {
            'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'
          });
          res.writeHead(r.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(r.body);
        }
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  // ── CLV e Abertura ──
  if (p === '/update-clv' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const sport = parsed.query.sport || 'esports';
        const { matchId, clvOdds } = safeParse(body, {});
        if (matchId && clvOdds) stmts.updateTipCLV.run(parseFloat(clvOdds), matchId, sport);
        sendJson(res, { ok: true });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  sendJson(res, { error: 'Not found' }, 404);
  } catch(e) {
    log('ERROR', 'SERVER', `Unhandled in ${p}: ${e.message}`);
    if (!res.headersSent) sendJson(res, { error: e.message }, 500);
  }
});

// ── Re-fetch proativo de odds stale para partidas próximas (lotes tardios) ──
// Problema: lotes 4-6 podem ficar 15-18h sem refresh no round-robin de 3h.
// Solução: a cada 1h verifica se há odds > 6h no cache E partidas nas próximas 8h.
// Se sim, força um ciclo imediato sem gastar chamada extra além do round-robin normal.
let staleOddsCheckTs = 0;
async function checkStaleOddsForUpcoming() {
  if (!ODDSPAPI_KEY) return;
  if (esportsOddsFetching) return;
  const now = Date.now();
  if (now - staleOddsCheckTs < 60 * 60 * 1000) return; // no máximo 1x/h
  if (now < esportsBackoffUntil) return;
  staleOddsCheckTs = now;

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const EIGHT_HOURS = 8 * 60 * 60 * 1000;

  // Verifica se alguma entrada do cache de odds está > 6h
  let hasStale = false;
  for (const [key, entry] of Object.entries(oddsCache)) {
    if (!key.startsWith('esports_')) continue;
    if (entry.ts && (now - entry.ts) > SIX_HOURS) { hasStale = true; break; }
  }
  if (!hasStale) return;

  // Verifica se há partidas nas próximas 8h — só vale re-fetch se há jogo iminente
  let hasUpcoming = false;
  try {
    const r = await httpGet(`http://127.0.0.1:${PORT}/lol-matches`).catch(() => null);
    if (r && r.status === 200) {
      const matches = safeParse(r.body, []);
      if (Array.isArray(matches)) {
        hasUpcoming = matches.some(m => {
          const t = m.time ? new Date(m.time).getTime() : 0;
          return t > now && t - now < EIGHT_HOURS;
        });
      }
    }
  } catch(_) {}

  if (!hasUpcoming) return;

  log('INFO', 'ODDS', 'Odds > 6h detectadas com partidas nas próximas 8h — forçando re-fetch adicional');
  const saved = lastEsportsOddsUpdate;
  lastEsportsOddsUpdate = 0; // bypass TTL para este ciclo
  await fetchEsportsOdds().catch(e => {
    log('ERROR', 'ODDS', `Stale re-fetch falhou: ${e.message}`);
    lastEsportsOddsUpdate = saved; // restaura se falhou
  });
}

// ── Sync de stats pro via PandaScore ──
async function syncProStats({ forceResync = false } = {}) {
  if (!PANDASCORE_TOKEN) return { ok: false, error: 'sem token' };
  const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
  const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cutoffEnd = new Date().toISOString().slice(0, 10);

  // Busca até 4 páginas (400 partidas) para cobrir todos os times relevantes
  const MAX_PAGES = 4;
  const PER_PAGE = 100;
  const allMatches = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.pandascore.co/lol/matches?filter[status]=finished&sort=-begin_at&per_page=${PER_PAGE}&page=${page}&range[begin_at]=${cutoff},${cutoffEnd}`;
    const listR = await httpGet(url, headers).catch(() => null);
    if (!listR || listR.status !== 200) break;
    const batch = safeParse(listR.body, []);
    if (!Array.isArray(batch) || batch.length === 0) break;
    allMatches.push(...batch);
    if (batch.length < PER_PAGE) break; // última página
    await new Promise(r => setTimeout(r, 300));
  }
  const matches = allMatches;
  log('INFO', 'SYNC', `PandaScore: ${matches.length} partidas finalizadas coletadas (últimos 45 dias)`);

  let matchCount = 0, champEntries = 0, playerEntries = 0, skipped = 0;
  const champAgg = {}; // { "Champion_role": { wins, total } }
  const playerAgg = {}; // { "player_Champion": { wins, total } }

  const currentPatch = (process.env.LOL_PATCH_META || '').match(/\d+\.\d+/)?.[0] || 'current';

  for (const m of matches) {
    const psId = `ps_${m.id}`;
    if (!forceResync && stmts.isMatchSynced.get(psId)) { skipped++; continue; }

    const t1 = m.opponents?.[0]?.opponent;
    const t2 = m.opponents?.[1]?.opponent;
    const winnerName = m.winner?.name || null;
    if (!t1 || !t2) { stmts.markMatchSynced.run(psId, 'lol'); continue; }

    // Popula match_results (form dos times)
    if (winnerName) {
      stmts.upsertMatchResult.run(psId, 'lol', t1.name, t2.name, winnerName, '', m.league?.name || '');
      matchCount++;
    }

    // Busca detalhes do jogo para picks de campeões
    try {
      const detR = await httpGet(`https://api.pandascore.co/lol/matches/${m.id}`, headers);
      if (detR.status === 200) {
        const det = safeParse(detR.body, {});
        const games = Array.isArray(det.games) ? det.games : [];
        for (const g of games) {
          if (!g.winner || !Array.isArray(g.players) || g.players.length === 0) continue;
          const winnerId = g.winner.id;
          for (const pl of g.players) {
            const champ  = pl.champion?.name;
            const role   = pl.role;
            const player = pl.player?.name || pl.name;
            if (!champ || !role) continue;
            const won = pl.team_id === winnerId;

            // Champ stats (pool de campeões pro play)
            const cKey = `${champ}_${role}`;
            if (!champAgg[cKey]) champAgg[cKey] = { champion: champ, role, wins: 0, total: 0 };
            champAgg[cKey].total++;
            if (won) champAgg[cKey].wins++;

            // Player+champ stats
            if (player) {
              const pKey = `${player}_${champ}`;
              if (!playerAgg[pKey]) playerAgg[pKey] = { player, champion: champ, wins: 0, total: 0 };
              playerAgg[pKey].total++;
              if (won) playerAgg[pKey].wins++;
            }
          }
        }
      }
    } catch(_) {}

    stmts.markMatchSynced.run(psId, 'lol');
    await new Promise(r => setTimeout(r, 150)); // rate-limit gentil
  }

  // Upsert champ stats
  for (const s of Object.values(champAgg)) {
    stmts.addChampStat.run(s.champion, s.role, s.wins, s.total, currentPatch);
    champEntries++;
  }
  // Upsert player+champ stats
  for (const s of Object.values(playerAgg)) {
    stmts.addPlayerChampStat.run(s.player, s.champion, s.wins, s.total, currentPatch);
    playerEntries++;
  }

  try { stmts.cleanOldSynced.run(); } catch(_) {}
  log('INFO', 'SYNC', `Pro stats: ${matchCount} resultados, ${champEntries} champs, ${playerEntries} player+champ (${skipped} já sincronizados)`);
  return { ok: true, matchCount, champEntries, playerEntries, skipped };
}

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', 'SERVER', `SportsEdge API em http://0.0.0.0:${PORT}`);
  log('INFO', 'SERVER', `Esportes: LoL (Riot API + PandaScore)`);

  // Inicialização e Loop de Cache de Odds (OddsPapi 1xBet)
  (async () => {
    await fetchEsportsOdds();
    await bootstrapEsportsOddsExtraBatches();
  })().catch(e => log('ERROR', 'ODDS', e.message));
  setInterval(() => {
    fetchEsportsOdds();
  }, 15 * 60 * 1000); // Mantém o cache quente a cada 15 min

  // Stale odds check: 1x/h, força re-fetch se odds > 6h com partidas próximas
  setInterval(() => checkStaleOddsForUpcoming().catch(() => {}), 60 * 60 * 1000);

  // Sync inicial de stats pro + job recorrente a cada 12h
  if (PANDASCORE_TOKEN) {
    setTimeout(() => syncProStats().catch(e => log('ERROR', 'SYNC', e.message)), 5000);
    setInterval(() => syncProStats().catch(e => log('ERROR', 'SYNC', e.message)), 12 * 60 * 60 * 1000);
  }

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

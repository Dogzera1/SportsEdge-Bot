require('dotenv').config({ override: true });
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');
const initDatabase = require('./lib/database');
const { SPORTS, getSportById } = require('./lib/sports');
const { log, sendJson, safeParse, norm, httpGet, cachedHttpGet, aiPost, oddsApiAllowed, getMetricsLite } = require('./lib/utils');

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
// The Odds API — usado para MMA (20k req/mês)
const THE_ODDS_API_KEY = process.env.THE_ODDS_API_KEY || '';

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
  'circuito-desafiante', 'cd', 'lcl', 'gll-pro-am', 'lfl-division-2',
  // Slugs alternativos usados pela Riot API (já cobertos via PandaScore, suprime WARN)
  'south_regional_league', 'rift_legends',
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

// Cooldown por match para force refresh (anti-429)
const lastForceRefreshByPair = new Map(); // key -> ts
const FORCE_REFRESH_COOLDOWN_MS = (parseInt(process.env.ODDSPAPI_FORCE_COOLDOWN_S || '300', 10) || 300) * 1000; // 5min default

// Round-robin: rastreia qual lote buscar no próximo ciclo
let esportsBatchCursor = 0;

// Cache de tournament IDs (24h)
let cachedEsportsTids = null;
let cachedEsportsTidsTs = 0;

// ── Fila async (anti-429 / anti-spam) ──
function createAsyncQueue(concurrency = 1) {
  let running = 0;
  const q = [];
  const inFlightByKey = new Map();

  function pump() {
    while (running < concurrency && q.length) {
      const item = q.shift();
      if (!item) break;
      running++;
      Promise.resolve()
        .then(item.fn)
        .then(item.resolve, item.reject)
        .finally(() => {
          running--;
          inFlightByKey.delete(item.key);
          pump();
        });
    }
  }

  function enqueue(key, fn) {
    if (key && inFlightByKey.has(key)) return inFlightByKey.get(key);
    const p = new Promise((resolve, reject) => {
      q.push({ key, fn, resolve, reject });
      pump();
    });
    if (key) inFlightByKey.set(key, p);
    return p;
  }

  return { enqueue };
}

// OddsPapi (LoL esports) é agressivo em 429 → serializa requests
const oddsPapiQueue = createAsyncQueue(1);

// The Odds API (tennis/football/mma) — serializa + dedupe por URL
const theOddsQueue = createAsyncQueue(1);

function clampStr(v, maxLen) {
  const s = (v == null ? '' : String(v)).trim();
  if (!s) return '';
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function parseFiniteNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function badRequest(res, msg) {
  sendJson(res, { error: String(msg || 'invalid_payload') }, 400);
}

async function theOddsGet(theOddsUrl) {
  return await theOddsQueue.enqueue(`theodds:${theOddsUrl}`, async () => {
    const ttlMsRaw = parseInt(process.env.HTTP_CACHE_THEODDS_TTL_MS || '', 10);
    const ttlMs = Number.isFinite(ttlMsRaw) ? ttlMsRaw : 0;
    return await cachedHttpGet(theOddsUrl, { provider: 'theodds', ttlMs }).catch(() => ({ status: 500, body: '[]' }));
  });
}

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
    const r = await oddsPapiQueue.enqueue(`oddspapi:tournaments:${sid}`, async () => {
      const ttlMsRaw = parseInt(process.env.HTTP_CACHE_ODDSPAPI_TOURNAMENTS_TTL_MS || '', 10);
      const ttlMs = Number.isFinite(ttlMsRaw) ? ttlMsRaw : TOURNAMENT_CACHE_TTL;
      return await cachedHttpGet(url, { provider: 'oddspapi', ttlMs }).catch(() => null);
    });
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
  const r = await oddsPapiQueue.enqueue(`oddspapi:odds:${batch.join(',')}`, async () => {
    const ttlMsRaw = parseInt(process.env.HTTP_CACHE_ODDSPAPI_ODDS_TTL_MS || '', 10);
    const ttlMs = Number.isFinite(ttlMsRaw) ? ttlMsRaw : 0;
    return await cachedHttpGet(url, { provider: 'oddspapi', ttlMs }).catch(e => ({ status: 500, body: e.message }));
  });

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

// ── Map odds (LoL por mapa) via OddsPapi fixture markets ──
async function getMapMlOddsFromFixture(t1, t2, mapNumber) {
  const nt1 = norm(t1), nt2 = norm(t2);
  if (!nt1 || !nt2) return null;

  // Matching mais robusto (usa aliases e aceita ordem invertida)
  const expandWithAliases = n => {
    const variants = new Set([n]);
    for (const [key, aliases] of Object.entries(LOL_ALIASES)) {
      if (n.includes(key) || key.includes(n)) { aliases.forEach(a => variants.add(a)); variants.add(key); }
    }
    return [...variants];
  };
  const variants1 = expandWithAliases(nt1);
  const variants2 = expandWithAliases(nt2);
  const anyMatch = (variants, slug) => variants.some(v => v && v.length >= 2 && slug.includes(v));

  const entry = Object.values(oddsCache).find(v => {
    if (!v?.fixtureId) return false;
    const cs = v.combinedSlug || '';
    return (anyMatch(variants1, cs) && anyMatch(variants2, cs));
  });
  if (!entry?.fixtureId || !ODDSPAPI_KEY) return null;

  const fixtureId = entry.fixtureId;
  const url = `https://api.oddspapi.io/v4/odds-by-fixtures?bookmaker=1xbet&fixtureId=${fixtureId}&oddsFormat=decimal&apiKey=${ODDSPAPI_KEY}`;
  const ttlMsRaw = parseInt(process.env.HTTP_CACHE_ODDSPAPI_FIXTURE_TTL_MS || '', 10);
  const ttlMs = Number.isFinite(ttlMsRaw) ? ttlMsRaw : 0;
  const r = await cachedHttpGet(url, { provider: 'oddspapi', ttlMs }).catch(() => null);
  if (!r || r.status !== 200) return null;

  const data = safeParse(r.body, null);
  const allMarkets = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
  if (!allMarkets.length) return null;

  const n = parseInt(mapNumber, 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  // Filtra mercados relacionados a map/game e tenta achar o do mapa atual
  const mapMarkets = allMarkets.filter(m => {
    const name = (m.marketName || m.marketId || '').toString().toLowerCase();
    const isMap = name.includes('map') || name.includes('game');
    if (!isMap) return false;
    // match "map 1", "game 1", "map1", "game1", "#1", "1st map"
    return (
      name.includes(`map ${n}`) || name.includes(`map${n}`) ||
      name.includes(`game ${n}`) || name.includes(`game${n}`) ||
      name.includes(`#${n}`) ||
      name.includes(`${n}st map`) || name.includes(`${n}nd map`) || name.includes(`${n}rd map`) || name.includes(`${n}th map`)
    );
  });

  // Se não achou explícito, tenta qualquer mercado "map/game" (fallback)
  const candidates = mapMarkets.length
    ? mapMarkets
    : allMarkets.filter(m => {
        const name = (m.marketName || m.marketId || '').toString().toLowerCase();
        return name.includes('map') || name.includes('game');
      });
  if (!candidates.length) return null;

  // Heurística: preferir "winner" / "moneyline"
  const scored = candidates.map(m => {
    const name = (m.marketName || m.marketId || '').toString().toLowerCase();
    const outcomes = Array.isArray(m.outcomes) ? m.outcomes : [];
    const has2 = outcomes.length >= 2;
    const score =
      (name.includes('winner') ? 5 : 0) +
      (name.includes('moneyline') || name.includes('ml') ? 3 : 0) +
      (has2 ? 1 : 0);
    return { m, name, outcomes, score };
  }).sort((a, b) => b.score - a.score);

  for (const cand of scored) {
    const outcomes = cand.outcomes;
    if (!outcomes || outcomes.length < 2) continue;
    // Tenta mapear outcomes pelo nome do time (quando disponível)
    const o1 = outcomes.find(o => {
      const on = norm(o.name || '');
      return variants1.some(v => v && v.length >= 2 && (on === v || on.includes(v) || v.includes(on)));
    });
    const o2 = outcomes.find(o => {
      const on = norm(o.name || '');
      return variants2.some(v => v && v.length >= 2 && (on === v || on.includes(v) || v.includes(on)));
    });
    const p1 = extractPrice(o1 || outcomes[0]);
    const p2 = extractPrice(o2 || outcomes[1]);
    if (!p1 || !p2) continue;
    return { t1: String(p1), t2: String(p2), bookmaker: '1xBet', fixtureId, market: cand.name };
  }

  return null;
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
      // Se tivermos t1Name/t2Name, tenta preservar ordem correta (evita odds invertida)
      if (val.t1Name && val.t2Name) {
        const vt1 = norm(val.t1Name);
        const vt2 = norm(val.t2Name);
        if (anyMatch(variants1, vt1) && anyMatch(variants2, vt2)) {
          return { t1: val.t1, t2: val.t2, bookmaker: val.bookmaker };
        }
        if (anyMatch(variants1, vt2) && anyMatch(variants2, vt1)) {
          return { t1: val.t2, t2: val.t1, bookmaker: val.bookmaker };
        }
      }
      // Se slug carrega ordem (concat), usa a posição do primeiro match para decidir swap
      const firstIdx = (variants, target) => {
        let best = Infinity;
        for (const v of variants) {
          if (!v || v.length < 2) continue;
          const idx = target.indexOf(v);
          if (idx >= 0 && idx < best) best = idx;
        }
        return best;
      };
      const i1 = firstIdx(variants1, cs);
      const i2 = firstIdx(variants2, cs);
      if (i1 !== Infinity && i2 !== Infinity && i1 !== i2) {
        // cs: "...<teamA>...<teamB>..." ⇒ t1=teamA, t2=teamB
        if (i1 < i2) return { t1: val.t1, t2: val.t2, bookmaker: val.bookmaker };
        return { t1: val.t2, t2: val.t1, bookmaker: val.bookmaker };
      }
      // Fallback: match sem garantia de ordem
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

// ── Admin Auth + Rate Limit (in-memory) ──
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();

function getClientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').toString();
  const ip = xf.split(',')[0]?.trim();
  return ip || req.socket?.remoteAddress || 'unknown';
}

function isAdminRequest(req) {
  if (!ADMIN_KEY) return false;
  const xk = (req.headers['x-admin-key'] || '').toString().trim();
  if (xk && xk === ADMIN_KEY) return true;
  const auth = (req.headers['authorization'] || '').toString().trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token && token === ADMIN_KEY) return true;
  }
  return false;
}

function requireAdmin(req, res) {
  // Se ADMIN_KEY não configurada, não bloquear rotas internas.
  // (Sem isso, bot não consegue settlear tips em produção/local.)
  if (!ADMIN_KEY) return true;
  if (!isAdminRequest(req)) {
    sendJson(res, { ok: false, error: 'unauthorized' }, 401);
    return false;
  }
  return true;
}

const _rl = new Map(); // key -> { count, resetAt }
function rateLimit(req, res, limitPerMin, bucket) {
  const ip = getClientIp(req);
  const key = `${bucket}|${ip}`;
  const now = Date.now();
  const winMs = 60 * 1000;
  const cur = _rl.get(key);
  if (!cur || now >= cur.resetAt) {
    _rl.set(key, { count: 1, resetAt: now + winMs });
    return true;
  }
  if (cur.count >= limitPerMin) {
    const retryAfterSec = Math.max(1, Math.ceil((cur.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    sendJson(res, {
      ok: false,
      error: 'rate_limited',
      bucket,
      limitPerMin,
      retryAfterSec
    }, 429);
    return false;
  }
  cur.count++;
  return true;
}

const ADMIN_ROUTES_ANY = new Set([
  '/lol-raw',
  '/debug-odds',
  '/debug-teams',
  '/debug-match-odds',
  '/sync-pro-stats',
]);

const ADMIN_ROUTES_POST = new Set([
  '/record-analysis',
  '/save-user',
  '/record-tip',
  '/log-tip-factors',
  '/resync-stats',
  '/reset-tips',
  '/settle',
  '/set-bankroll',
  '/update-clv',
  '/update-open-tip',
  '/claude',
  '/ps-result',
  '/football-result',
]);

const EXPENSIVE_ROUTES = new Set([
  '/claude',
  '/odds',
  '/handicap-odds',
  '/mma-odds',
]);

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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key, x-claude-key, x-sport'
    });
    res.end();
    return;
  }

  // Rate limit (antes de rotas pesadas)
  const bucket = EXPENSIVE_ROUTES.has(p) ? `expensive:${p}` : `general:${p}`;
  const limit = EXPENSIVE_ROUTES.has(p) ? 10 : 60;
  if (!rateLimit(req, res, limit, bucket)) return;

  // Admin guard
  const needsAdmin =
    ADMIN_ROUTES_ANY.has(p) ||
    (req.method === 'POST' && ADMIN_ROUTES_POST.has(p)) ||
    (p === '/odds' && parsed.query.force === '1');
  if (needsAdmin && !requireAdmin(req, res)) return;

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
      const raw = parsed.query.matchId;
      const matchId = raw ? String(raw).replace(/^lol_/, '') : '';
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
    const mapNumber = parsed.query.map ? parseInt(parsed.query.map, 10) : null;
    // force=1: bypassa TTL do cache (usado para partidas iminentes < 2h)
    if (parsed.query.force === '1') {
      // Se backoff ativo, nunca force (só aumenta spam e não atualiza mesmo)
      if (Date.now() < esportsBackoffUntil) {
        const oNow = (mapNumber && mapNumber > 0)
          ? await getMapMlOddsFromFixture(t1, t2, mapNumber)
          : findOdds('esports', t1, t2);
        sendJson(res, oNow || { error: 'odds indisponíveis (backoff ativo)' });
        return;
      }
      // Evita spam/429: se já está buscando odds, não reseta TTL de novo
      if (esportsOddsFetching) {
        const oNow = (mapNumber && mapNumber > 0)
          ? await getMapMlOddsFromFixture(t1, t2, mapNumber)
          : findOdds('esports', t1, t2);
        sendJson(res, oNow || { error: 'odds não encontradas (fetch em andamento)' });
        return;
      }

      // Cooldown por par de times (mesmo que o bot chame em loop)
      const pairKey = `${norm(t1)}v${norm(t2)}`;
      const lastTs = lastForceRefreshByPair.get(pairKey) || 0;
      if (lastTs && (Date.now() - lastTs) < FORCE_REFRESH_COOLDOWN_MS) {
        const oNow = findOdds('esports', t1, t2);
        sendJson(res, oNow || { error: 'odds não encontradas' });
        return;
      }
      lastForceRefreshByPair.set(pairKey, Date.now());

      lastEsportsOddsUpdate = 0;
      log('INFO', 'ODDS', `Force refresh solicitado para ${t1} vs ${t2} (partida iminente)`);
    }
    await fetchOdds('esports');
    const o = (mapNumber && mapNumber > 0)
      ? await getMapMlOddsFromFixture(t1, t2, mapNumber)
      : findOdds('esports', t1, t2);
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

  if (p === '/handicap-odds') {
    const t1 = parsed.query.team1 || '';
    const t2 = parsed.query.team2 || '';
    if (!t1 || !t2) { sendJson(res, { error: 'team1 e team2 obrigatórios' }, 400); return; }
    try {
      const nt1 = norm(t1), nt2 = norm(t2);
      const entry = Object.values(oddsCache).find(v => {
        const cs = v.combinedSlug || '';
        return cs.includes(nt1) && cs.includes(nt2);
      });
      if (!entry || !entry.fixtureId) { sendJson(res, { error: 'not_found' }); return; }
      const { fixtureId } = entry;
      const url = `https://api.oddspapi.io/v4/odds-by-fixtures?bookmaker=1xbet&fixtureId=${fixtureId}&oddsFormat=decimal&apiKey=${ODDSPAPI_KEY}`;
      const ttlMsRaw = parseInt(process.env.HTTP_CACHE_ODDSPAPI_FIXTURE_TTL_MS || '', 10);
      const ttlMs = Number.isFinite(ttlMsRaw) ? ttlMsRaw : 0;
      const r = await cachedHttpGet(url, { provider: 'oddspapi', ttlMs }).catch(() => null);
      if (!r || r.status !== 200) { sendJson(res, { error: 'not_found' }); return; }
      const data = safeParse(r.body, null);
      const allMarkets = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
      const handicapMarkets = allMarkets.filter(m => {
        const name = (m.marketName || m.marketId || '').toString().toLowerCase();
        return name.includes('handicap') || name.includes('map');
      });
      const markets = handicapMarkets.map(m => {
        const outcomes = Array.isArray(m.outcomes) ? m.outcomes : [];
        return {
          name: m.marketName || m.marketId || '',
          t1Odds: outcomes[0] ? extractPrice(outcomes[0]) : null,
          t2Odds: outcomes[1] ? extractPrice(outcomes[1]) : null
        };
      });
      sendJson(res, { fixtureId, markets });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/mma-odds') {
    if (!THE_ODDS_API_KEY) { sendJson(res, { hasData: false, error: 'no_key' }); return; }
    const fighter1 = parsed.query.fighter1 || '';
    const fighter2 = parsed.query.fighter2 || '';
    const sport = parsed.query.sport || 'mma_mixed_martial_arts';
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${THE_ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
      const r = await theOddsGet(url);
      if (!r || r.status !== 200) { sendJson(res, { hasData: false }); return; }
      const events = safeParse(r.body, []);
      const nf1 = norm(fighter1), nf2 = norm(fighter2);
      let found = null;
      for (const ev of events) {
        const nh = norm(ev.home_team || ''), na = norm(ev.away_team || '');
        if ((nh.includes(nf1) || nf1.includes(nh)) && (na.includes(nf2) || nf2.includes(na))) {
          found = { home: ev.home_team, away: ev.away_team, bookmakers: ev.bookmakers };
          break;
        }
        if ((nh.includes(nf2) || nf2.includes(nh)) && (na.includes(nf1) || nf1.includes(na))) {
          found = { home: ev.away_team, away: ev.home_team, bookmakers: ev.bookmakers, swapped: true };
          break;
        }
      }
      if (!found) { sendJson(res, { hasData: false }); return; }
      const bk = (found.bookmakers || [])[0];
      const h2h = bk?.markets?.find(m => m.key === 'h2h');
      const outcomes = h2h?.outcomes || [];
      const homeOut = outcomes.find(o => norm(o.name) === norm(found.home));
      const awayOut = outcomes.find(o => norm(o.name) === norm(found.away));
      sendJson(res, {
        t1: homeOut?.price ?? null,
        t2: awayOut?.price ?? null,
        bookmaker: bk?.title || '',
        hasData: true
      });
    } catch(e) {
      sendJson(res, { hasData: false, error: e.message });
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
      oddsCacheSize: Object.keys(oddsCache).filter(k => k.startsWith('esports_')).length,
      metricsLite: getMetricsLite()
    });
    return;
  }

  if (p === '/metrics-lite') {
    sendJson(res, getMetricsLite());
    return;
  }

  if (p === '/record-analysis' && req.method === 'POST') {
    lastAnalysisAt = new Date().toISOString();
    sendJson(res, { ok: true });
    return;
  }

  if (p === '/match-result') {
    const raw = parsed.query.matchId || '';
    const matchId = String(raw).replace(/^lol_/, '');
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
          // Persist com o mesmo ID recebido (mantém compatibilidade com tips já gravadas)
          stmts.upsertMatchResult.run(String(raw || matchId), 'lol', t1?.name||'', t2?.name||'', winner, `${t1?.result?.gameWins||0}-${t2?.result?.gameWins||0}`, ev.league?.name||'');
          sendJson(res, { matchId: String(raw || matchId), game, winner, resolved: true });
          return;
        }
      }
      sendJson(res, { matchId: String(raw || matchId), game, resolved: false });
    } catch(e) {
      sendJson(res, { matchId: String(raw || matchId), game, resolved: false, error: e.message });
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

  // ── Resultado Futebol (settlement via API-Football) ──
  if (p === '/football-result') {
    const fixtureId = parsed.query.fixtureId || '';
    if (!fixtureId) { sendJson(res, { resolved: false, error: 'fixtureId obrigatório' }, 400); return; }
    try {
      const FOOTBALL_API_KEY = process.env.API_SPORTS_KEY || process.env.APIFOOTBALL_KEY || '';
      if (!FOOTBALL_API_KEY) { sendJson(res, { resolved: false, error: 'API_SPORTS_KEY não configurada' }); return; }

      const r = await httpGet(`https://v3.football.api-sports.io/fixtures?id=${fixtureId}`, {
        'x-rapidapi-key': FOOTBALL_API_KEY,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      });
      const data = safeParse(r.body, {});
      const fixture = data?.response?.[0];
      if (!fixture) { sendJson(res, { resolved: false }); return; }

      const statusShort = fixture.fixture?.status?.short;
      const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
      if (!FINISHED_STATUSES.includes(statusShort)) {
        sendJson(res, { resolved: false, status: statusShort }); return;
      }

      const homeGoals = fixture.goals?.home;
      const awayGoals = fixture.goals?.away;
      const homeName  = fixture.teams?.home?.name || '';
      const awayName  = fixture.teams?.away?.name || '';

      let winner;
      if (homeGoals > awayGoals)       winner = homeName;
      else if (awayGoals > homeGoals)  winner = awayName;
      else                             winner = 'Draw';

      const score = `${homeGoals}-${awayGoals}`;
      stmts.upsertMatchResult.run(
        String(fixtureId), 'football', homeName, awayName, winner, score,
        fixture.league?.name || ''
      );
      sendJson(res, { fixtureId, winner, score, homeName, awayName, resolved: true });
    } catch(e) {
      sendJson(res, { resolved: false, error: e.message });
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
        const uid = clampStr(userId, 80);
        if (!uid) { badRequest(res, 'userId obrigatório'); return; }
        const uname = clampStr(username, 80);
        const prefs = Array.isArray(sportPrefs) ? sportPrefs.slice(0, 50) : [];
        stmts.upsertUser.run(uid, uname, subscribed ? 1 : 0, JSON.stringify(prefs));
        sendJson(res, { ok: true });
      } catch(e) {
        sendJson(res, {
          error: e.message,
          code: e.code,
          provider: e.provider,
          retryAfterMs: e.retryAfterMs
        }, e.status || 500);
      }
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
        const matchId = clampStr(t.matchId, 128);
        if (!matchId) { badRequest(res, 'matchId obrigatório'); return; }
        const eventName = clampStr(t.eventName, 220);
        const p1 = clampStr(t.p1 || t.team1 || t.fighter1, 120);
        const p2 = clampStr(t.p2 || t.team2 || t.fighter2, 120);
        const tipParticipant = clampStr(t.tipParticipant || t.tipTeam, 120);
        const oddsN = parseFiniteNumber(t.odds);
        const evN = parseFiniteNumber(t.ev);
        if (!p1 || !p2) { badRequest(res, 'p1/p2 obrigatórios'); return; }
        if (!tipParticipant) { badRequest(res, 'tipParticipant obrigatório'); return; }
        if (oddsN == null || oddsN <= 1) { badRequest(res, 'odds inválidas'); return; }
        if (evN == null) { badRequest(res, 'ev inválido'); return; }
        // Guardrail: evita odds absurdas por bug de matching/mercado
        if (sport === 'esports') {
          const minOdds = parseFiniteNumber(process.env.LOL_MIN_ODDS) ?? 1.10;
          const maxOdds = parseFiniteNumber(process.env.LOL_MAX_ODDS) ?? 4.00;
          if (oddsN < minOdds || oddsN > maxOdds) {
            badRequest(res, `odds fora faixa esports (${minOdds}–${maxOdds})`);
            return;
          }
        }
        // Evitar tip duplicada para o mesmo match_id + sport
        const existing = stmts.tipExistsByMatch.get(String(matchId), sport);
        if (existing) { sendJson(res, { ok: true, skipped: true, reason: 'duplicate' }); return; }
        const isLive = t.isLive ? 1 : 0;
        const modelP1 = t.modelP1 != null ? parseFiniteNumber(t.modelP1) : null;
        const modelP2 = t.modelP2 != null ? parseFiniteNumber(t.modelP2) : null;
        const modelPPick = t.modelPPick != null ? parseFiniteNumber(t.modelPPick) : null;
        const modelLabel = clampStr(t.modelLabel, 60) || null;
        const tipReason = clampStr(t.tipReason, 600) || null;
        const stakeStr = clampStr(t.stake, 20);
        const confidenceStr = clampStr(t.confidence || 'MÉDIA', 20) || 'MÉDIA';
        const botTokenStr = clampStr(t.botToken, 180);
        const marketTypeStr = clampStr(t.market_type || 'ML', 20) || 'ML';
        const result = stmts.insertTip.run({
          sport, matchId: String(matchId), eventName,
          p1, p2,
          tipParticipant, odds: oddsN,
          ev: evN, stake: stakeStr, confidence: confidenceStr,
          isLive, botToken: botTokenStr, market_type: marketTypeStr,
          model_p1: modelP1,
          model_p2: modelP2,
          model_p_pick: modelPPick,
          model_label: modelLabel,
          tip_reason: tipReason
        });
        // Calcula stake em reais com base na banca atual (1u = 1% da banca atual)
        try {
          const bk = stmts.getBankroll.get(sport);
          if (bk && result.lastInsertRowid) {
            const unitValue = bk.current_banca / 100;
            const stakeUnits = parseFloat(String(t.stake || '1').replace('u','')) || 1;
            const stakeReais = parseFloat((stakeUnits * unitValue).toFixed(2));
            stmts.updateTipFinanceiro.run(stakeReais, null, result.lastInsertRowid);
          }
        } catch(_) {}
        // Grava odds de abertura para CLV tracking
        if (oddsN != null) {
          stmts.updateTipOpenOdds.run(oddsN, String(matchId), sport);
        }
        stmts.incrementApiUsage.run(sport, new Date().toISOString().slice(0,7));
        sendJson(res, { ok: true, tipId: result?.lastInsertRowid || null });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  if (p === '/log-tip-factors' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tipId, factors, predictedDir } = safeParse(body, {});
        const id = parseInt(tipId, 10);
        const dir = clampStr(predictedDir, 10);
        if (!Number.isFinite(id) || id <= 0) { badRequest(res, 'tipId inválido'); return; }
        if (!Array.isArray(factors) || !factors.length) { sendJson(res, { ok: true, inserted: 0 }); return; }
        if (dir !== 't1' && dir !== 't2') { badRequest(res, 'predictedDir inválido'); return; }
        if (factors.length > 80) { badRequest(res, 'factors grande demais'); return; }
        let inserted = 0;
        for (const f of factors) {
          const factor = clampStr(f, 240);
          if (!factor) continue;
          try { stmts.logTipFactor.run(id, factor, dir, null); inserted++; } catch(_) {}
        }
        sendJson(res, { ok: true, inserted });
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
    db.prepare("UPDATE bankroll SET current_banca = initial_banca, updated_at = datetime('now') WHERE sport = ?").run(sport);
    log('INFO', 'ADMIN', `Tips resetadas: ${count} registros removidos (sport=${sport})`);
    sendJson(res, { ok: true, deleted: count });
    return;
  }

  if (p === '/tips-history') {
    const sport = parsed.query.sport || 'esports';
    const limitRaw = parseInt(parsed.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 20;

    // status: open/settled (alias para pending/settled)
    const status = String(parsed.query.status || '').toLowerCase();
    const filter = String(parsed.query.filter || '').toLowerCase();

    // live: 0/1/true/false
    const liveRaw = parsed.query.live;
    const live = (liveRaw === '1' || liveRaw === 1 || liveRaw === true || liveRaw === 'true')
      ? 1
      : (liveRaw === '0' || liveRaw === 0 || liveRaw === false || liveRaw === 'false')
        ? 0
        : null;

    // confidence: ALTA/MÉDIA/BAIXA
    const confRaw = String(parsed.query.confidence || '').toUpperCase().trim();
    const confidence = (confRaw === 'ALTA' || confRaw === 'MÉDIA' || confRaw === 'MEDIA' || confRaw === 'BAIXA')
      ? (confRaw === 'MEDIA' ? 'MÉDIA' : confRaw)
      : '';

    // busca simples: time/atleta/evento
    const q = String(parsed.query.q || '').trim().slice(0, 80);

    // sort: ev/odds/date (default date desc)
    const sort = String(parsed.query.sort || '').toLowerCase();
    const dir = String(parsed.query.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const sortCol = sort === 'ev'
      ? 't.ev'
      : sort === 'odds'
        ? 't.odds'
        : 't.sent_at';

    let query = `
      SELECT t.*, m.match_time as match_time, m.event_date as match_date
      FROM tips t
      LEFT JOIN matches m ON t.match_id = m.id AND t.sport = m.sport
      WHERE t.sport = ?
    `;
    const params = [sport];

    if (status === 'settled') query += " AND t.result IS NOT NULL";
    else if (status === 'open') query += " AND t.result IS NULL";
    else if (filter === 'settled') query += " AND t.result IS NOT NULL";
    else if (filter === 'pending') query += " AND t.result IS NULL";
    else if (filter === 'win') query += " AND t.result = 'win'";
    else if (filter === 'loss') query += " AND t.result = 'loss'";

    if (live !== null) { query += " AND t.is_live = ?"; params.push(live); }
    if (confidence) { query += " AND UPPER(t.confidence) = ?"; params.push(confidence); }
    if (q) {
      query += " AND (t.event_name LIKE ? OR t.participant1 LIKE ? OR t.participant2 LIKE ? OR t.tip_participant LIKE ?)";
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    query += ` ORDER BY ${sortCol} ${dir}, t.id ${dir} LIMIT ?`;
    params.push(limit);

    sendJson(res, db.prepare(query).all(params));
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
            const bk = stmts.getBankroll.get(sport);
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
          const bk = stmts.getBankroll.get(sport);
          if (bk) {
            const nova = parseFloat((bk.current_banca + bancaDelta).toFixed(2));
            stmts.updateBankroll.run(nova, sport);
            log('INFO', 'BANCA', `Settlement [${sport}]: delta R$${bancaDelta >= 0 ? '+' : ''}${bancaDelta.toFixed(2)} → banca agora R$${nova}`);
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

    const tips = db.prepare("SELECT odds, stake, result, ev, is_live, clv_odds, open_odds, model_p_pick FROM tips WHERE sport = ? AND result IS NOT NULL").all(sport);
    let totalStaked = 0, totalProfit = 0;
    const liveTips = { wins: 0, losses: 0, total: 0, profit: 0, staked: 0 };
    const preTips  = { wins: 0, losses: 0, total: 0, profit: 0, staked: 0 };

    // CLV: calculado apenas em tips com clv_odds registrado
    let clvSum = 0, clvCount = 0, clvPositive = 0;
    const clvLive = { sum: 0, count: 0, positive: 0 };
    const clvPre  = { sum: 0, count: 0, positive: 0 };

    // Calibração probabilística: Brier Score e Log Loss
    let brierSum = 0, logLossSum = 0, calibCount = 0;

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

      // Brier Score e Log Loss: p derivado do EV e odds
      // EV armazenado como porcentagem (ex: 5.2 para 5.2%)
      // Fórmula: p = (1 + EV/100) / odds, onde EV em decimal = ev/100
      const ev = parseFloat(t.ev) || 0;
      if (odds > 1 && t.result) {
        const pStored = parseFloat(t.model_p_pick);
        let p = (isFinite(pStored) && pStored > 0 && pStored < 1)
          ? pStored
          : (ev > 0 ? (1 + ev / 100) / odds : 1 / odds);
        p = Math.max(0.01, Math.min(0.99, p));
        const o = t.result === 'win' ? 1 : 0;
        brierSum += (p - o) ** 2;
        logLossSum += -(o * Math.log(p) + (1 - o) * Math.log(1 - p));
        calibCount++;
      }
    }

    const roi = totalStaked > 0 ? ((totalProfit / totalStaked) * 100).toFixed(2) : '0.00';
    const calcBucketROI = b => b.staked > 0 ? ((b.profit / b.staked) * 100).toFixed(2) : '0.00';
    const calcCLV = c => c.count > 0 ? {
      avg: parseFloat((c.sum / c.count).toFixed(2)),
      positiveRate: Math.round(c.positive / c.count * 100),
      count: c.count
    } : null;

    // Dados da banca em reais — calcula current_banca a partir dos profits reais acumulados
    const bk = stmts.getBankroll.get(sport);
    let bancaInfo = null;

    if (bk) {
      // Backfill: tips arquivadas sem profit_reais calculado (coluna adicionada depois do settlement)
      const orphans = db.prepare(
        "SELECT id, result, odds, stake, stake_reais FROM tips WHERE sport = ? AND result IS NOT NULL AND profit_reais IS NULL"
      ).all(sport);
      if (orphans.length > 0) {
        const unitValue = bk.initial_banca / 100;
        const backfill = db.prepare("UPDATE tips SET stake_reais = ?, profit_reais = ? WHERE id = ?");
        for (const t of orphans) {
          const stakeR = t.stake_reais || parseFloat(((parseFloat(String(t.stake || '1').replace('u','')) || 1) * unitValue).toFixed(2));
          const odds = parseFloat(t.odds) || 1;
          const profitR = t.result === 'win'
            ? parseFloat((stakeR * (odds - 1)).toFixed(2))
            : parseFloat((-stakeR).toFixed(2));
          backfill.run(stakeR, profitR, t.id);
        }
        log('INFO', 'BANCA', `[${sport}] Backfill: ${orphans.length} tips sem profit_reais recalculadas`);
      }

      const profitRow = db.prepare(
        "SELECT COALESCE(SUM(profit_reais), 0) as total_profit FROM tips WHERE sport = ? AND result IS NOT NULL AND profit_reais IS NOT NULL"
      ).get(sport);
      const accumulatedProfit = parseFloat((profitRow?.total_profit || 0).toFixed(2));
      const currentBanca = parseFloat((bk.initial_banca + accumulatedProfit).toFixed(2));
      // Sincroniza o registro caso esteja desatualizado
      if (Math.abs(currentBanca - bk.current_banca) > 0.01) {
        stmts.updateBankroll.run(currentBanca, sport);
      }
      bancaInfo = {
        initialBanca: bk.initial_banca,
        currentBanca: currentBanca,
        unitValue: parseFloat((currentBanca / 100).toFixed(4)),
        profitReais: accumulatedProfit,
        growthPct: parseFloat((accumulatedProfit / bk.initial_banca * 100).toFixed(2)),
        updatedAt: bk.updated_at
      };
    } else {
      // Se não existe registro no bankroll, cria um com valores padrão
      db.prepare('INSERT OR IGNORE INTO bankroll (sport, initial_banca, current_banca) VALUES (?, 100.0, 100.0)').run(sport);
      const newBk = stmts.getBankroll.get(sport);
      if (newBk) {
        bancaInfo = {
          initialBanca: newBk.initial_banca,
          currentBanca: newBk.current_banca,
          unitValue: parseFloat((newBk.current_banca / 100).toFixed(4)),
          profitReais: 0,
          growthPct: 0,
          updatedAt: newBk.updated_at
        };
      }
    }

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
      calibration_metrics: calibCount >= 3 ? {
        brierScore: parseFloat((brierSum / calibCount).toFixed(4)),
        logLoss: parseFloat((logLossSum / calibCount).toFixed(4)),
        sampleSize: calibCount,
        interpretation: brierSum / calibCount < 0.20 ? 'boa' : brierSum / calibCount < 0.25 ? 'acima_da_media' : 'ruim'
      } : null,
      banca: bancaInfo
    });
    return;
  }

  if (p === '/dashboard' || p === '/') {
    const htmlPath = path.join(__dirname, 'public', 'dashboard.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(_) {
      res.writeHead(404); res.end('Dashboard not found');
    }
    return;
  }

  if (p === '/calibration') {
    const sport = parsed.query.sport || 'esports';
    try {
      const tips = db.prepare(
        `SELECT odds, ev, confidence, result, is_live, model_p_pick FROM tips WHERE sport = ? AND result IN ('win','loss')`
      ).all(sport);

      const NUM_BUCKETS = 10;
      const buckets = Array.from({ length: NUM_BUCKETS }, (_, i) => ({
        bucket: `${i*10}-${i*10+10}%`,
        predicted: i * 10 + 5,
        wins: 0,
        total: 0,
        actual: 0
      }));

      let brierSum = 0, logLossSum = 0, n = 0;

      for (const t of tips) {
        const odds = parseFloat(t.odds) || 0;
        if (odds <= 1) continue;
        const ev = parseFloat(String(t.ev || '0').replace('%','').replace('+','')) / 100;
        // Preferir p do modelo salvo (mais preciso). Fallback: derivar de EV+odds.
        const pStored = parseFloat(t.model_p_pick);
        const pRaw = (isFinite(pStored) && pStored > 0 && pStored < 1)
          ? pStored
          : ((ev + 1) / odds);
        const p = Math.max(0.01, Math.min(0.99, pRaw));
        const isWin = t.result === 'win' ? 1 : 0;

        const idx = Math.min(NUM_BUCKETS - 1, Math.floor(p * NUM_BUCKETS));
        buckets[idx].total++;
        buckets[idx].wins += isWin;

        // Brier score: (p - outcome)^2
        brierSum += Math.pow(p - isWin, 2);
        // Log loss: -(outcome * log(p) + (1-outcome) * log(1-p))
        logLossSum += -(isWin * Math.log(p) + (1 - isWin) * Math.log(1 - p));
        n++;
      }

      for (const b of buckets) {
        b.actual = b.total > 0 ? parseFloat((b.wins / b.total * 100).toFixed(1)) : null;
      }

      sendJson(res, {
        sport,
        buckets: buckets.filter(b => b.total > 0),
        brierScore: n > 0 ? brierSum / n : null,
        logLoss: n > 0 ? logLossSum / n : null,
        total: n
      });
    } catch(e) { sendJson(res, { error: e.message }, 500); }
    return;
  }

  // ── Bankroll endpoints ──
  if (p === '/bankroll') {
    const sport = parsed.query.sport || 'esports';
    const bk = stmts.getBankroll.get(sport);
    if (!bk) { sendJson(res, { error: 'Bankroll não inicializado' }, 500); return; }
    const profitRow = db.prepare(
      "SELECT COALESCE(SUM(profit_reais), 0) as total_profit FROM tips WHERE sport = ? AND result IS NOT NULL AND profit_reais IS NOT NULL"
    ).get(sport);
    const accumulatedProfit = parseFloat((profitRow?.total_profit || 0).toFixed(2));
    const currentBanca = parseFloat((bk.initial_banca + accumulatedProfit).toFixed(2));
    sendJson(res, {
      initialBanca: bk.initial_banca,
      currentBanca: currentBanca,
      unitValue: parseFloat((currentBanca / 100).toFixed(4)),
      profitReais: accumulatedProfit,
      growthPct: parseFloat((accumulatedProfit / bk.initial_banca * 100).toFixed(2)),
      updatedAt: bk.updated_at
    });
    return;
  }

  // ── Global Risk Snapshot (cross-sport) ──
  if (p === '/risk-snapshot') {
    try {
      const sports = ['esports', 'mma', 'tennis', 'football'];
      const bySport = {};
      let totalBanca = 0;
      let totalPendingReais = 0;

      for (const s of sports) {
        const bk = stmts.getBankroll.get(s);
        // Reusa lógica de /bankroll para currentBanca
        let currentBanca = bk?.current_banca;
        if (bk) {
          const profitRow = db.prepare(
            "SELECT COALESCE(SUM(profit_reais), 0) as total_profit FROM tips WHERE sport = ? AND result IS NOT NULL AND profit_reais IS NOT NULL"
          ).get(s);
          const accumulatedProfit = parseFloat((profitRow?.total_profit || 0).toFixed(2));
          currentBanca = parseFloat((bk.initial_banca + accumulatedProfit).toFixed(2));
        }
        currentBanca = parseFloat(currentBanca) || 0;

        const pending = db.prepare(
          "SELECT COALESCE(SUM(stake_reais), 0) as pending_reais, COUNT(*) as n FROM tips WHERE sport = ? AND result IS NULL"
        ).get(s);
        const pendingReais = parseFloat((pending?.pending_reais || 0).toFixed(2));

        bySport[s] = {
          currentBanca,
          pendingReais,
          pendingCount: pending?.n || 0,
          unitValue: parseFloat((currentBanca / 100).toFixed(4))
        };
        totalBanca += currentBanca;
        totalPendingReais += pendingReais;
      }

      sendJson(res, {
        totalBanca: parseFloat(totalBanca.toFixed(2)),
        totalPendingReais: parseFloat(totalPendingReais.toFixed(2)),
        bySport
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/set-bankroll' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { valor, sport: sportParam } = safeParse(body, {});
        const sport = (sportParam || parsed.query.sport || 'esports');
        const v = parseFloat(valor);
        if (!v || v <= 0) { sendJson(res, { error: 'valor inválido' }, 400); return; }
        stmts.resetBankroll.run(v, v, sport);
        log('INFO', 'BANCA', `Banca [${sport}] redefinida para R$${v.toFixed(2)}`);
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

    // Tentativa 1: match exato
    let rows = stmts.getTeamForm.all(team, team, game);

    // Tentativa 2: match parcial (LIKE) — captura divergências de nome como
    // "Hanwha Life" vs "Hanwha Life Esports" ou "T1" vs "T1 Academy"
    if (!rows.length) {
      const fuzzy = `%${team}%`;
      rows = stmts.getTeamFormFuzzy.all(fuzzy, fuzzy, game);
    }

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

    // Tentativa 1: match exato
    let rows = stmts.getH2H.all(t1, t2, t2, t1, game);

    // Tentativa 2: match parcial
    if (!rows.length) {
      rows = stmts.getH2HFuzzy.all(`%${t1}%`, `%${t2}%`, `%${t2}%`, `%${t1}%`, game);
    }

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

  if (p === '/ml-weights') {
    try {
      const rows = stmts.getAllFactorWeights.all();
      sendJson(res, { weights: rows.length ? rows : 'usando padrão', defaults: { forma: 0.25, h2h: 0.30, comp: 0.35 } });
    } catch(e) { sendJson(res, { error: e.message }, 500); }
    return;
  }

  // ── LoL role impact (gol.gg via PandaTobi repo) ──
  if (p === '/lol-role-impact') {
    try {
      const rows = db.prepare('SELECT * FROM golgg_role_impact ORDER BY role').all();
      sendJson(res, { ok: true, roles: rows });
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 500);
    }
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
          const r = await aiPost('deepseek', 'https://api.deepseek.com/chat/completions', dsPayload, {
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
          const r = await aiPost('claude', 'https://api.anthropic.com/v1/messages', payload, {
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
        const mid = clampStr(matchId, 128);
        const clv = parseFiniteNumber(clvOdds);
        if (!mid) { badRequest(res, 'matchId obrigatório'); return; }
        if (clv == null || clv <= 1) { badRequest(res, 'clvOdds inválido'); return; }
        stmts.updateTipCLV.run(clv, mid, sport);
        sendJson(res, { ok: true });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  if (p === '/update-open-tip' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const sport = parsed.query.sport || 'esports';
        const { matchId, currentOdds, currentEV, currentConfidence, markNotified } = safeParse(body, {});
        const mid = clampStr(matchId, 128);
        if (!mid) { badRequest(res, 'matchId obrigatório'); return; }
        const o = parseFiniteNumber(currentOdds);
        const ev = parseFiniteNumber(currentEV);
        const conf = clampStr(currentConfidence, 24) || null;
        if (o == null || o <= 1) { badRequest(res, 'currentOdds inválido'); return; }
        if (ev == null) { badRequest(res, 'currentEV inválido'); return; }
        if (markNotified) stmts.updateTipCurrentAndNotified.run(o, ev, conf, String(mid), sport);
        else stmts.updateTipCurrent.run(o, ev, conf, String(mid), sport);
        sendJson(res, { ok: true });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  if (p === '/mma-matches') {
    if (!THE_ODDS_API_KEY) { sendJson(res, []); return; }
    try {
      const mmaUrl = `https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds/?apiKey=${THE_ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
      const r = await theOddsGet(mmaUrl);
      if (r.status !== 200) { sendJson(res, []); return; }
      const raw = safeParse(r.body, []);
      const now = Date.now();
      const fights = raw
        .filter(e => new Date(e.commence_time).getTime() > now)
        .map(e => {
          const bm = e.bookmakers?.[0];
          const market = bm?.markets?.find(m => m.key === 'h2h');
          const out = market?.outcomes || [];
          const o1 = out.find(o => o.name === e.home_team);
          const o2 = out.find(o => o.name === e.away_team);
          return {
            id: e.id,
            game: 'mma',
            status: 'upcoming',
            team1: e.home_team,
            team2: e.away_team,
            league: e.sport_title || 'MMA',
            time: e.commence_time,
            odds: (o1 && o2) ? { t1: String(o1.price), t2: String(o2.price), bookmaker: bm.title } : null
          };
        })
        .filter(f => f.odds);
      sendJson(res, fights);
    } catch(e) {
      sendJson(res, []);
    }
    return;
  }

  if (p === '/tennis-matches') {
    if (!THE_ODDS_API_KEY) { sendJson(res, []); return; }
    try {
      const now = Date.now();
      const weekAhead = now + 7 * 24 * 60 * 60 * 1000;
      const LIVE_WINDOW_MS = parseInt(process.env.TENNIS_LIVE_WINDOW_H || '6', 10) * 60 * 60 * 1000; // default 6h

      // 1) Busca todos os sports ativos na API e filtra os de tênis
      if (!oddsApiAllowed('ODDS')) { sendJson(res, []); return; }
      const sportsR = await theOddsGet(`https://api.the-odds-api.com/v4/sports/?apiKey=${THE_ODDS_API_KEY}`);
      const allSports = safeParse(sportsR.body, []);
      const tennisKeys = allSports
        .filter(s => s.key && s.key.startsWith('tennis_') && s.active !== false)
        .map(s => s.key);

      if (!tennisKeys.length) { sendJson(res, []); return; }

      // 2) Busca odds em paralelo (limita a 10 torneios para não estourar quota)
      // Cada torneio = 1 request
      const maxKeys = Math.min(10, tennisKeys.length);
      const allowedKeys = [];
      for (const k of tennisKeys.slice(0, maxKeys)) {
        if (!oddsApiAllowed('ODDS')) break;
        allowedKeys.push(k);
      }
      const matches = [];
      for (const k of allowedKeys) {
        if (!oddsApiAllowed('ODDS')) break;
        const urlOdds = `https://api.the-odds-api.com/v4/sports/${k}/odds/?apiKey=${THE_ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
        const r2 = await theOddsGet(urlOdds);
        if (!r2 || r2.status !== 200) continue;
        const raw = safeParse(r2.body, []);
        for (const e of raw) {
          const t = new Date(e.commence_time).getTime();
          // upcoming: agora → 7d
          // live: começou há <= LIVE_WINDOW_MS (The Odds API pode manter o evento por um tempo)
          if (t > weekAhead) continue;
          if (t <= now && (now - t) > LIVE_WINDOW_MS) continue;
          const bm = e.bookmakers?.[0];
          const market = bm?.markets?.find(m => m.key === 'h2h');
          const out = market?.outcomes || [];
          const o1 = out.find(o => o.name === e.home_team);
          const o2 = out.find(o => o.name === e.away_team);
          if (!o1 || !o2) continue;
          matches.push({
            id: e.id,
            game: 'tennis',
            sport_key: k,
            status: (t <= now ? 'live' : 'upcoming'),
            team1: e.home_team,
            team2: e.away_team,
            league: e.sport_title || 'Tennis',
            time: e.commence_time,
            odds: { t1: String(o1.price), t2: String(o2.price), bookmaker: bm.title }
          });
        }
      }
      matches.sort((a, b) => {
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (b.status === 'live' && a.status !== 'live') return 1;
        return new Date(a.time) - new Date(b.time);
      });
      sendJson(res, matches);
    } catch(e) {
      sendJson(res, []);
    }
    return;
  }

  if (p === '/football-matches') {
    if (!THE_ODDS_API_KEY) { sendJson(res, []); return; }
    try {
      const now = Date.now();
      const weekAhead = now + 7 * 24 * 60 * 60 * 1000;
      const configured = (process.env.FOOTBALL_LEAGUES || 'soccer_brazil_serie_b,soccer_brazil_serie_c')
        .split(',').map(s => s.trim()).filter(Boolean);

      const matches = [];
      for (const k of configured) {
        if (!oddsApiAllowed('ODDS')) break;
        const urlOdds = `https://api.the-odds-api.com/v4/sports/${k}/odds/?apiKey=${THE_ODDS_API_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal`;
        const r2 = await theOddsGet(urlOdds);
        if (!r2 || r2.status !== 200) continue;
        const raw = safeParse(r2.body, []);
        for (const e of raw) {
          const t = new Date(e.commence_time).getTime();
          if (t <= now || t > weekAhead) continue;
          const bm = e.bookmakers?.[0];
          if (!bm) continue;
          const h2hMarket = bm.markets?.find(m => m.key === 'h2h');
          const totalsMarket = bm.markets?.find(m => m.key === 'totals');
          const out = h2hMarket?.outcomes || [];
          const oH = out.find(o => o.name === e.home_team);
          const oD = out.find(o => o.name === 'Draw');
          const oA = out.find(o => o.name === e.away_team);
          if (!oH || !oD || !oA) continue;
          const over = totalsMarket?.outcomes?.find(o => o.name === 'Over');
          const under = totalsMarket?.outcomes?.find(o => o.name === 'Under');
          const odds = {
            h: String(oH.price),
            d: String(oD.price),
            a: String(oA.price),
            bookmaker: bm.title
          };
          if (over && under) {
            odds.ou25 = { over: String(over.price), under: String(under.price), point: over.point };
          }
          matches.push({
            id: e.id,
            game: 'football',
            sport_key: k,
            status: 'upcoming',
            team1: e.home_team,
            team2: e.away_team,
            league: e.sport_title || 'Football',
            time: e.commence_time,
            odds
          });
        }
      }
      matches.sort((a, b) => new Date(a.time) - new Date(b.time));
      sendJson(res, matches);
    } catch(e) {
      sendJson(res, []);
    }
    return;
  }

  if (p === '/roi-by-market') {
    const sport = parsed.query.sport || 'esports';
    try {
      const rows = stmts.getRoiByMarket.all(sport);
      sendJson(res, rows);
    } catch(e) {
      sendJson(res, []);
    }
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

  const champNameOf = (pl) => {
    const c = pl?.champion;
    if (!c) return null;
    if (typeof c === 'string') return c;
    return c.name || c.slug || c.id || null;
  };
  const roleOf = (pl) => {
    const r = pl?.role || pl?.position || pl?.lane || pl?.player_role || pl?.playerRole;
    if (!r) return null;
    return String(r).toLowerCase();
  };
  const playerNameOf = (pl) => {
    const p = pl?.player;
    return p?.name || p?.slug || pl?.name || pl?.nickname || null;
  };

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
      // PandaScore: precisa de include para popular players/champions em alguns planos/versões
      const include = 'games.teams.players.player,games.teams.players.champion,games.winner';
      const detR = await httpGet(`https://api.pandascore.co/lol/matches/${m.id}?include=${encodeURIComponent(include)}`, headers);
      if (detR.status === 200) {
        const det = safeParse(detR.body, {});
        const games = Array.isArray(det.games) ? det.games : [];
        for (const g of games) {
          if (!g.winner) continue;
          const winnerId = g.winner.id;
          // PandaScore aninha players dentro de g.teams[].players (não g.players direto)
          const teams = Array.isArray(g.teams) ? g.teams : [];
          for (const teamObj of teams) {
            const teamId = teamObj.team?.id;
            const won = teamId === winnerId;
            const players = Array.isArray(teamObj.players) ? teamObj.players : (Array.isArray(teamObj?.players?.data) ? teamObj.players.data : []);
            for (const pl of players) {
              const champ = champNameOf(pl);
              const roleRaw = roleOf(pl);
              const player = playerNameOf(pl);
              const role = roleRaw ? roleRaw.replace(/[^a-z0-9]/g, '') : null;
              if (!champ || !role) continue;

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
    setTimeout(async () => {
      try {
        // Auto-detect: se pro_champ_stats está vazio mas synced_matches já tem entradas,
        // o DB foi recriado sem repopular os stats — força resync completo
        const champCount = db.prepare('SELECT COUNT(*) as cnt FROM pro_champ_stats').get();
        const syncedCount = db.prepare('SELECT COUNT(*) as cnt FROM synced_matches').get();
        const forceResync = (champCount?.cnt ?? 0) === 0 && (syncedCount?.cnt ?? 0) > 0;
        if (forceResync) {
          log('WARN', 'SYNC', `pro_champ_stats vazio mas ${syncedCount.cnt} matches já marcados como synced — forçando resync completo`);
        }
        await syncProStats({ forceResync });
      } catch(e) { log('ERROR', 'SYNC', e.message); }
    }, 5000);
    setInterval(() => syncProStats().catch(e => log('ERROR', 'SYNC', e.message)), 12 * 60 * 60 * 1000);
  }

  // Cleanup de DB
  setInterval(() => {
    try { stmts.cleanOldOdds.run(); } catch(_) {}
  }, 6 * 60 * 60 * 1000);

  // Weekly ML weight recalculation
  const { recalcWeights, settleFactorLogs } = require('./lib/ml-weights');
  // Settle factor logs diariamente (depende do settlement das tips).
  setInterval(() => {
    settleFactorLogs(stmts, log);
  }, 24 * 60 * 60 * 1000); // daily

  // Recalcula pesos semanalmente.
  setInterval(() => {
    settleFactorLogs(stmts, log);
    recalcWeights(stmts, log);
  }, 7 * 24 * 60 * 60 * 1000); // weekly

  // Boot: settle rápido + recalc após 5 min
  setTimeout(() => { settleFactorLogs(stmts, log); recalcWeights(stmts, log); }, 5 * 60 * 1000);
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

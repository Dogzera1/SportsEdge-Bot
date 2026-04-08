require('dotenv').config({ override: true });
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const initDatabase = require('./lib/database');
const { SPORTS, getSportById, getSportByToken, getTokenToSportMap } = require('./lib/sports');
const { log, calcKelly, calcKellyFraction, calcKellyWithP, norm, fmtDate, fmtDateTime, fmtDuration, safeParse } = require('./lib/utils');
const { adjustStakeUnits } = require('./lib/risk-manager');
const { esportsPreFilter } = require('./lib/ml');
const { fetchMatchNews } = require('./lib/news');

const SERVER = '127.0.0.1';
const PORT = parseInt(process.env.SERVER_PORT) || parseInt(process.env.PORT) || 8080;
const ADMIN_IDS = new Set((process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean));
const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
/** Header para /claude: Node rejeita undefined; com só DeepSeek, CLAUDE_KEY fica vazio. */
const AI_PROXY_KEY = CLAUDE_KEY || DEEPSEEK_KEY;

if (!CLAUDE_KEY && !DEEPSEEK_KEY) {
  console.error('❌ Configure CLAUDE_API_KEY ou DEEPSEEK_API_KEY no .env');
  process.exit(1);
}

const DB_PATH = (process.env.DB_PATH || 'sportsedge.db').trim().replace(/^=+/, '');
const { db, stmts } = initDatabase(DB_PATH);

// ── Patch Meta Persistência ──
// Salva no mesmo diretório do DB para sobreviver restarts no volume Railway
const PATCH_META_FILE = (() => {
  try {
    const dbDir = path.dirname(path.isAbsolute(DB_PATH) ? DB_PATH : path.resolve(DB_PATH));
    return path.join(dbDir, 'patch_meta.json');
  } catch(_) { return path.resolve('patch_meta.json'); }
})();

function loadPatchMetaFromFile() {
  try {
    if (!fs.existsSync(PATCH_META_FILE)) return;
    const data = safeParse(fs.readFileSync(PATCH_META_FILE, 'utf8'), null);
    if (!data) return;
    // Só restaura se o env ainda não tem valor configurado manualmente
    if (!process.env.LOL_PATCH_META && data.meta) {
      process.env.LOL_PATCH_META = data.meta;
      process.env.PATCH_META_DATE = data.date || '';
      log('INFO', 'PATCH', `Meta restaurado do arquivo: ${data.meta.slice(0, 60)}`);
    }
  } catch(_) {}
}

function savePatchMetaToFile(meta, date) {
  try {
    fs.writeFileSync(PATCH_META_FILE, JSON.stringify({ meta, date }), 'utf8');
  } catch(_) {}
}

// Carrega meta persistido imediatamente
loadPatchMetaFromFile();

// ── Bot Instances ──
const bots = {};
const tokenToSport = getTokenToSportMap();
const subscribedUsers = new Map(); // userId → Set<sport>

// Auto-analysis state
const analyzedMatches = new Map();
const analyzedMma = new Map();
const analyzedTennis = new Map();
const analyzedFootball = new Map();

// Settlement
const SETTLEMENT_INTERVAL = 30 * 60 * 1000;
let lastSettlementCheck = 0;

// Line movement
const lineAlerted = new Map();
const LINE_CHECK_INTERVAL = 30 * 60 * 1000;
let lastLineCheck = 0;



// Live notifications (esports)
const notifiedMatches = new Map();
let lastLiveCheck = 0;
const LIVE_CHECK_INTERVAL = 60 * 1000; // 1 minute
const RE_ANALYZE_INTERVAL = 10 * 60 * 1000; // 10 min between re-analyses of same live match
const UPCOMING_ANALYZE_INTERVAL = 30 * 60 * 1000; // 30m para acomodar a quota da OddsPapi (1xBet)
const UPCOMING_WINDOW_HOURS = 24; // analyze upcoming matches within next 24h

// Deduplicação de updates de tip (anti-spam)
const tipUpdateNotifyCache = new Map(); // key -> ts
const TIP_UPDATE_DEDUP_MS =
  (parseInt(process.env.TIP_UPDATE_DEDUP_MIN || '30', 10) || 30) * 60 * 1000;



// Patch meta alert
let lastPatchAlert = 0;
const PATCH_ALERT_INTERVAL = 24 * 60 * 60 * 1000;

// Auto patch meta fetch (ddragon)
let patchAutoFetchTs = 0;
const PATCH_AUTO_FETCH_INTERVAL = 12 * 60 * 60 * 1000; // verifica a cada 12h



// ── Telegram Request ──
function tgRequest(token, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Server Helpers ──
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();
const ADMIN_POST_PATHS = new Set([
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

function serverGet(path, sport) {
  return new Promise((resolve, reject) => {
    const sep = path.includes('?') ? '&' : '?';
    const sportParam = sport ? `${sep}sport=${sport}` : '';
    http.get({
      hostname: SERVER,
      port: PORT,
      path: path + sportParam,
      timeout: 15000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error(`JSON Parse Error: ${e.message} | Body: ${d.slice(0,50)}`)); }
      });
    }).on('error', e => reject(new Error(`HTTP Error on ${SERVER}:${PORT}${path}: ${e.message}`)));
  });
}

function serverPost(path, body, sport, extraHeaders) {
  return new Promise((resolve, reject) => {
    const s = JSON.stringify(body);
    const sportParam = sport ? `?sport=${sport}` : '';
    const adminHeaders = (ADMIN_KEY && ADMIN_POST_PATHS.has(path))
      ? { 'x-admin-key': ADMIN_KEY }
      : null;
    const req = http.request({
      hostname: SERVER,
      port: PORT,
      path: path + sportParam,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(s),
        ...(adminHeaders || {}),
        ...extraHeaders
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(s);
    req.end();
  });
}

// ── Global Risk Manager snapshot cache ──
let _riskSnapCache = null;
let _riskSnapTs = 0;
async function getRiskSnapshotCached() {
  const now = Date.now();
  if (_riskSnapCache && (now - _riskSnapTs) < 30 * 1000) return _riskSnapCache;
  const snap = await serverGet('/risk-snapshot').catch(() => null);
  if (snap) { _riskSnapCache = snap; _riskSnapTs = now; }
  return snap;
}

async function applyGlobalRisk(sport, desiredUnits) {
  const snap = await getRiskSnapshotCached();
  if (!snap) return { ok: true, units: desiredUnits, reason: 'no_snapshot' };
  const maxGlobalRiskPct = parseFloat(process.env.GLOBAL_RISK_PCT || '0.10');
  const maxSportRiskPct = parseFloat(process.env.SPORT_RISK_PCT || '0.20');
  return adjustStakeUnits(sport, desiredUnits, snap, { maxGlobalRiskPct, maxSportRiskPct, minUnits: 0.5 });
}

// ── Send Helpers ──
function send(token, chatId, text, extra) {
  return tgRequest(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    ...extra
  });
}

function sendDM(token, userId, text, extra) {
  return tgRequest(token, 'sendMessage', {
    chat_id: userId,
    text,
    parse_mode: 'Markdown',
    ...extra
  });
}

function kb(buttons) {
  return { reply_markup: { keyboard: buttons, resize_keyboard: true } };
}

// ── Sport-specific Menus (Inline Keyboard — callback_data) ──
function getMenu(sport) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔔 Notificações', callback_data: `menu_notif_${sport}` },
          { text: '📊 Tracking', callback_data: `menu_tracking_${sport}` }
        ],
        [
          { text: '📅 Próximas', callback_data: `menu_proximas_${sport}` },
          { text: '❓ Ajuda', callback_data: `menu_ajuda_${sport}` }
        ],
        [
          { text: '💰 Minhas Tips', callback_data: `tips_menu_${sport}` },
          { text: '⚖️ Fair Odds', callback_data: `menu_fairodds_${sport}` }
        ]
      ]
    }
  };
}

function getTipsMenu(sport) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '⏳ Em andamento', callback_data: `tips_pending_${sport}` },
          { text: '✅ Vencidas', callback_data: `tips_won_${sport}` },
          { text: '❌ Perdidas', callback_data: `tips_lost_${sport}` }
        ],
        [
          { text: '← Menu principal', callback_data: `tips_back_${sport}` }
        ]
      ]
    }
  };
}

// ── Hydrate tip maps from DB on startup (prevents re-sending after restart) ──
async function loadExistingTips() {
  try {
    // Importante: usar histórico (inclui settled) para evitar reenvio após restart.
    // Se usar apenas unsettled, tips já liquidadas voltam a ser analisadas/enviadas em jogos que reaparecem nas APIs.
    const [esportsTips, mmaTips, tennisTips, footballTips] = await Promise.all([
      serverGet('/tips-history?limit=400', 'esports').catch(() => []),
      serverGet('/tips-history?limit=400', 'mma').catch(() => []),
      serverGet('/tips-history?limit=400', 'tennis').catch(() => []),
      serverGet('/tips-history?limit=400', 'football').catch(() => [])
    ]);
    if (Array.isArray(esportsTips)) {
      for (const tip of esportsTips) {
        if (!tip.match_id) continue;
        const mid = String(tip.match_id);
        const rawId = mid.startsWith('lol_') ? mid.slice(4) : mid; // match.id do endpoint (/lol-matches)
        // Keys usados no bot:
        // - live/draft: `${match.game}_${match.id}` → "lol_<id>" / "lol_ps_<id>"
        // - upcoming:   `upcoming_${match.game}_${match.id}` → "upcoming_lol_<id>"
        analyzedMatches.set(`lol_${rawId}`, { ts: Date.now(), tipSent: true });
        analyzedMatches.set(`upcoming_lol_${rawId}`, { ts: Date.now(), tipSent: true });
      }
      if (esportsTips.length) log('INFO', 'BOOT', `LoL: ${esportsTips.length} tips existentes carregadas`);
    }
    if (Array.isArray(mmaTips)) {
      for (const tip of mmaTips) {
        if (!tip.match_id) continue;
        analyzedMma.set(`mma_${tip.match_id}`, { ts: Date.now(), tipSent: true });
      }
      if (mmaTips.length) log('INFO', 'BOOT', `MMA: ${mmaTips.length} tips existentes carregadas`);
    }
    if (Array.isArray(tennisTips)) {
      for (const tip of tennisTips) {
        if (!tip.match_id) continue;
        analyzedTennis.set(`tennis_${tip.match_id}`, { ts: Date.now(), tipSent: true });
      }
      if (tennisTips.length) log('INFO', 'BOOT', `Tênis: ${tennisTips.length} tips existentes carregadas`);
    }
    if (Array.isArray(footballTips)) {
      for (const tip of footballTips) {
        if (!tip.match_id) continue;
        analyzedFootball.set(`football_${tip.match_id}`, { ts: Date.now(), tipSent: true });
      }
      if (footballTips.length) log('INFO', 'BOOT', `Futebol: ${footballTips.length} tips existentes carregadas`);
    }
  } catch(e) {
    log('WARN', 'BOOT', `Erro ao carregar tips existentes: ${e.message}`);
  }
}

// ── Load Subscribers ──
async function loadSubscribedUsers() {
  try {
    const users = await serverGet('/users?subscribed=1');
    if (Array.isArray(users)) {
      for (const u of users) {
        const prefs = safeParse(u.sport_prefs, []);
        subscribedUsers.set(u.user_id, new Set(prefs));
      }
      log('INFO', 'BOOT', `${users.length} usuários carregados do DB`);
    }
  } catch(e) {
    log('WARN', 'BOOT', 'Erro ao carregar usuários: ' + e.message);
  }

  // Auto-subscribe admin users to all enabled sports (ensures tips are sent after cold redeploys)
  const allSports = new Set(Object.keys(SPORTS).filter(k => SPORTS[k]?.enabled && SPORTS[k]?.token));
  for (const adminId of ADMIN_IDS) {
    const id = parseInt(adminId);
    if (isNaN(id)) continue;
    if (!subscribedUsers.has(id) || subscribedUsers.get(id).size === 0) {
      subscribedUsers.set(id, new Set(allSports));
      log('INFO', 'BOOT', `Admin ${id} auto-inscrito em: ${[...allSports].join(', ')}`);
      // Persist to DB via server so it survives future restarts
      serverPost('/save-user', { userId: id, subscribed: true, sportPrefs: [...allSports] }).catch(() => {});
    }
  }

  if (subscribedUsers.size === 0) {
    log('WARN', 'BOOT', 'Nenhum usuário inscrito. Configure ADMIN_USER_IDS no .env para receber tips automaticamente.');
  } else {
    log('INFO', 'BOOT', `Total: ${subscribedUsers.size} usuários com notificações ativas`);
  }
}

// ── Auto Analysis: LoL live + upcoming ──
let autoAnalysisRunning = false;
const AUTO_ANALYSIS_MUTEX_STALE_MS =
  (parseInt(process.env.AUTO_ANALYSIS_MUTEX_STALE_MIN || '15', 10) || 15) * 60 * 1000;
const autoAnalysisMutex = { locked: false, since: 0 };

function canonicalMatchId(sport, rawId, opts = {}) {
  const id = String(rawId || '').trim();
  if (!id) return id;
  if (sport === 'esports') {
    // Mantém PandaScore (ps_*) e outros IDs já prefixados.
    if (id.startsWith('ps_')) return id;
    if (id.startsWith('lol_')) return id;
    // Riot LoL: normaliza para lol_<eventId>
    return `lol_${id}`;
  }
  if (sport === 'football') {
    if (id.startsWith('fb_')) return id;
    // Fallback: se for fixture numérico, prefixa
    if (/^\d+$/.test(id)) return `fb_${id}`;
    return id;
  }
  if (sport === 'mma') {
    if (id.startsWith('mma_')) return id;
    return `mma_${id}`;
  }
  if (sport === 'tennis') {
    if (id.startsWith('tennis_')) return id;
    return `tennis_${id}`;
  }
  return id;
}

async function withAutoAnalysisMutex(fn) {
  const now = Date.now();
  if (autoAnalysisMutex.locked) {
    if (now - autoAnalysisMutex.since > AUTO_ANALYSIS_MUTEX_STALE_MS) {
      log('WARN', 'AUTO', `Mutex stale (${Math.round((now - autoAnalysisMutex.since)/60000)}min) — liberando lock`);
      autoAnalysisMutex.locked = false;
    } else {
      log('INFO', 'AUTO', 'Análise anterior ainda em curso — pulando ciclo');
      return;
    }
  }
  autoAnalysisMutex.locked = true;
  autoAnalysisMutex.since = now;
  autoAnalysisRunning = true;
  try {
    return await fn();
  } finally {
    autoAnalysisRunning = false;
    autoAnalysisMutex.locked = false;
  }
}

async function runAutoAnalysis() {
  return withAutoAnalysisMutex(async () => {
  const now = Date.now();

  const esportsConfig = SPORTS['esports'];
  if (esportsConfig?.enabled) {
    try {
      const lolRaw = await serverGet('/lol-matches').catch(() => []);
      // Inclui 'draft': composições já disponíveis na API Riot antes do jogo começar.
      // Permite análise com draft real + odds pré-jogo (antes de cair para odds ao vivo).
      const lolLive = Array.isArray(lolRaw) ? lolRaw.filter(m => m.status === 'live' || m.status === 'draft') : [];

      // Deduplicar Riot+PandaScore: se Riot já cobre o mesmo confronto, descarta a cópia PandaScore
      const riotLive = new Set(lolLive.filter(m => !String(m.id).startsWith('ps_')).map(m => `${norm(m.team1)}_${norm(m.team2)}`));
      const allLive = lolLive.filter(m => {
        if (!String(m.id).startsWith('ps_')) return true;
        const key1 = `${norm(m.team1)}_${norm(m.team2)}`;
        const key2 = `${norm(m.team2)}_${norm(m.team1)}`;
        return !riotLive.has(key1) && !riotLive.has(key2);
      });
      log('INFO', 'AUTO', `LoL: ${lolRaw?.length||0} partidas (${allLive.filter(m=>m.status==='live').length} live, ${allLive.filter(m=>m.status==='draft').length} draft, ${lolLive.length-allLive.length} dupl. removidas) | inscritos=${subscribedUsers.size}`);

      for (const match of allLive) {
        const matchKey = `${match.game}_${match.id}`;
        const prev = analyzedMatches.get(matchKey);
        if (prev?.tipSent) continue; // uma tip por partida — não repetir
        // Matches sem edge recente aguardam 2× mais antes de chamar a IA novamente
        const liveCooldown = prev?.noEdge ? RE_ANALYZE_INTERVAL * 2 : RE_ANALYZE_INTERVAL;
        if (prev && (now - prev.ts < liveCooldown)) continue;

        const result = await autoAnalyzeMatch(esportsConfig.token, match);
        analyzedMatches.set(matchKey, { ts: now, tipSent: prev?.tipSent || false, noEdge: !result?.tipMatch });

        if (!result) continue;
        const hasRealOdds = !!(result.o?.t1 && parseFloat(result.o.t1) > 1);

        if (result.tipMatch) {
          const tipTeam = result.tipMatch[1].trim();
          const tipOdd = result.tipMatch[2].trim();
          const tipEV = result.tipMatch[3].trim();
          const tipConf = (result.tipMatch[5] || 'MÉDIA').trim().toUpperCase();
          // Kelly adaptado por confiança: ALTA → ¼ Kelly (max 4u) | MÉDIA → ⅙ Kelly (max 3u) | BAIXA → 1/10 Kelly (max 1.5u)
          const kellyFraction = tipConf === 'ALTA' ? 0.25 : tipConf === 'BAIXA' ? 0.10 : 1/6;
          // Usa p do modelo ML quando disponível (evita circularidade p←EV←IA)
          const isT1bet = norm(tipTeam).includes(norm(match.team1)) || norm(match.team1).includes(norm(tipTeam));
          const modelPForKelly = (result.modelP1 > 0) ? (isT1bet ? result.modelP1 : result.modelP2) : null;
          const tipStake = modelPForKelly
            ? calcKellyWithP(modelPForKelly, tipOdd, kellyFraction)
            : calcKellyFraction(tipEV, tipOdd, kellyFraction);
          // Global Risk Manager (cross-sport)
          const desiredUnits = parseFloat(String(tipStake).replace('u', '')) || 0;
          const riskAdj = await applyGlobalRisk('esports', desiredUnits);
          if (!riskAdj.ok) { log('INFO', 'RISK', `esports: bloqueada (${riskAdj.reason})`); continue; }
          const tipStakeAdj = `${riskAdj.units.toFixed(1).replace(/\.0$/, '')}u`;
          const gameIcon = '🎮';
          const oddsLabel = hasRealOdds ? '' : '\n⚠️ _Odds estimadas (sem mercado disponível)_';
          const mlEdgeLabel = result.mlScore > 0 ? ` | ML: ${result.mlScore.toFixed(1)}pp` : '';
          const baixaNote = tipConf === 'BAIXA' ? '\n⚠️ _Tip de confiança BAIXA — stake reduzido. Aposte com cautela._' : '';

          const modelLabel = (result.factorActive && result.factorActive.length)
            ? 'P modelo (forma/H2H/comp)'
            : 'Fair odds (de-juice)';
          const modelPPick = modelPForKelly;

          const rec = await serverPost('/record-tip', {
            matchId: canonicalMatchId('esports', match.id), eventName: match.league,
            p1: match.team1, p2: match.team2, tipParticipant: tipTeam,
            odds: tipOdd, ev: tipEV, stake: tipStakeAdj,
            confidence: tipConf, isLive: result.hasLiveStats,
            modelP1: result.modelP1,
            modelP2: result.modelP2,
            modelPPick: modelPPick,
            modelLabel: modelLabel,
            tipReason: result.tipReason || null
          }, 'esports');

          if (rec?.tipId && result.factorActive?.length && result.mlDirection) {
            await serverPost('/log-tip-factors', {
              tipId: rec.tipId,
              factors: result.factorActive,
              predictedDir: result.mlDirection
            }, 'esports').catch(() => {});
          }

          const isDraft = match.status === 'draft';
          const kellyLabel = tipConf === 'ALTA' ? '¼ Kelly' : tipConf === 'BAIXA' ? '1/10 Kelly' : '⅙ Kelly';
          const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔵' }[tipConf] || '🟡';

          // Identifica se é tip ao vivo num mapa específico ou análise de série/draft
          const liveMapa = result.liveGameNumber;
          const mapaLabel = liveMapa ? `🗺️ *Mapa ${liveMapa} ao vivo*` : null;
          // Linha de contexto da série: "T1 1-0 Gen.G" + formato se disponível
          const serieScore = `*${match.team1}* ${match.score1}-${match.score2} *${match.team2}*`;
          const formatLabel = match.format ? ` _(${match.format})_` : '';

          const analysisLabel = result.hasLiveStats
            ? `📊 Baseado em dados ao vivo — Mapa ${liveMapa || '?'}`
            : isDraft
              ? '📋 Análise de draft (composições conhecidas, jogo ainda não iniciado)'
              : '📋 Análise pré-jogo';

          const tipHeader = liveMapa
            ? `${gameIcon} 💰 *TIP ML AUTOMÁTICA — MAPA ${liveMapa}*`
            : `${gameIcon} 💰 *TIP ML AUTOMÁTICA*`;

          const whyLine = result.tipReason ? `\n🧠 Por quê: _${result.tipReason}_\n` : '\n';
          const tipMsg = `${tipHeader}\n` +
            `${serieScore}${formatLabel}\n` +
            (mapaLabel ? `${mapaLabel}\n` : '') +
            whyLine +
            `🎯 Aposta: *${tipTeam}* ML @ *${tipOdd}*\n` +
            `📈 EV: *${tipEV}*\n💵 Stake: *${tipStake}* _(${kellyLabel})_\n` +
            `${confEmoji} Confiança: *${tipConf}*${mlEdgeLabel}\n` +
            `📋 ${match.league}\n` +
            `_${analysisLabel}_` +
            `${oddsLabel}${baixaNote}\n\n` +
            `⚠️ _Aposte com responsabilidade._`;

          for (const [userId, prefs] of subscribedUsers) {
            if (!prefs.has('esports')) continue;
            try { await sendDM(esportsConfig.token, userId, tipMsg); }
            catch(e) { if (e.message?.includes('403')) subscribedUsers.delete(userId); }
          }
          analyzedMatches.set(matchKey, { ts: now, tipSent: true });
          log('INFO', 'AUTO-TIP', `Esports: ${tipTeam} @ ${tipOdd} (odds ${hasRealOdds ? 'reais' : 'estimadas'})`);

          // ── Handicap tip (se houver edge) ──
          try {
            const hOdds = await serverGet(`/handicap-odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}`).catch(() => null);
            if (hOdds?.markets?.length) {
              const { calcHandicapScore } = require('./lib/ml');
              const enrich = result.enrich || {};
              const hScore = calcHandicapScore(match, enrich, result.o);

              for (const mkt of hOdds.markets.slice(0, 2)) {
                const mktName = mkt.name || '';
                const hOdd1 = parseFloat(mkt.t1Odds);
                const hOdd2 = parseFloat(mkt.t2Odds);
                if (!hOdd1 || !hOdd2 || hOdd1 <= 1.0 || hOdd2 <= 1.0) continue;

                const isT1Fav = hScore.cleanSweepP1 >= hScore.cleanSweepP2;
                const modelP  = isT1Fav ? hScore.cleanSweepP1 : hScore.cleanSweepP2;
                const hOdd    = isT1Fav ? hOdd1 : hOdd2;
                const favTeam = isT1Fav ? match.team1 : match.team2;
                const hEV     = (modelP * hOdd - 1) * 100;

                if (hEV < 5.0) continue;
                if (hOdd < 1.30 || hOdd > 4.00) continue;

                const hStake = Math.max(0.5, Math.min(2.0, (hEV / 100) * 10)).toFixed(1);
                const hMsg = `🎮 ♟️ *TIP HANDICAP*\n` +
                  `*${match.team1}* vs *${match.team2}*\n📋 ${match.league}\n\n` +
                  `🎯 Aposta: *${favTeam}* ${mktName}\n` +
                  `📈 EV estimado: *+${hEV.toFixed(1)}%*\n` +
                  `💵 Stake: *${hStake}u*\n` +
                  `🔵 Confiança: BAIXA\n\n` +
                  `⚠️ _Mercado de handicap — menor liquidez. Aposte com cautela._`;

                await serverPost('/record-tip', {
                  matchId: canonicalMatchId('esports', String(match.id) + '_H'), eventName: match.league,
                  p1: match.team1, p2: match.team2, tipParticipant: favTeam,
                  odds: String(hOdd), ev: String(hEV.toFixed(1)), stake: String(hStake),
                  confidence: 'BAIXA', isLive: true, market_type: 'HANDICAP'
                }, 'esports');

                for (const [userId, prefs] of subscribedUsers) {
                  if (!prefs.has('esports')) continue;
                  try { await sendDM(esportsConfig.token, userId, hMsg); } catch(_) {}
                }
                break;
              }
            }
          } catch(hErr) {
            log('WARN', 'AUTO', `Handicap check falhou: ${hErr.message}`);
          }
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      // ── LoL UPCOMING: Analyze matches in next 24h ──
      const windowEnd = now + UPCOMING_WINDOW_HOURS * 60 * 60 * 1000;
      const upcomingRaw = Array.isArray(lolRaw) ? lolRaw.filter(m => {
        if (m.status !== 'upcoming') return false;
        const t = m.time ? new Date(m.time).getTime() : 0;
        return t > now && t <= windowEnd;
      }) : [];
      // Deduplicar: prioriza Riot sobre PandaScore para o mesmo confronto
      // Fase 1: dedup por nome normalizado (cobre maioria dos casos)
      const riotUpcoming = new Set(upcomingRaw.filter(m => !String(m.id).startsWith('ps_')).map(m => `${norm(m.team1)}_${norm(m.team2)}`));
      let allUpcoming = upcomingRaw.filter(m => {
        if (!String(m.id).startsWith('ps_')) return true;
        const key1 = `${norm(m.team1)}_${norm(m.team2)}`;
        const key2 = `${norm(m.team2)}_${norm(m.team1)}`;
        return !riotUpcoming.has(key1) && !riotUpcoming.has(key2);
      });
      // Fase 2: dedup por horário+adversário (cobre abreviações como "Gamespace M.C." vs "Gamespace Mediterranean College")
      // Se dois matches têm o mesmo horário (±5min) e um time em comum (parcial), mantém só o primeiro (Riot)
      const seenByTimeOpponent = new Map(); // "time_opponent" → true
      allUpcoming = allUpcoming.filter(m => {
        const t = m.time ? Math.round(new Date(m.time).getTime() / 300000) : 0; // bucket 5min
        const n1 = norm(m.team1), n2 = norm(m.team2);
        // Verifica se já há um match com mesmo horário e algum time que seja prefixo do atual ou vice-versa
        for (const [k] of seenByTimeOpponent) {
          const [kt, kn1, kn2] = k.split('|');
          if (kt !== String(t)) continue;
          if ((n1.startsWith(kn1.slice(0,8)) || kn1.startsWith(n1.slice(0,8))) &&
              (n2.startsWith(kn2.slice(0,8)) || kn2.startsWith(n2.slice(0,8)))) return false;
          if ((n1.startsWith(kn2.slice(0,8)) || kn2.startsWith(n1.slice(0,8))) &&
              (n2.startsWith(kn1.slice(0,8)) || kn1.startsWith(n2.slice(0,8)))) return false;
        }
        seenByTimeOpponent.set(`${t}|${n1}|${n2}`, true);
        return true;
      });

      if (allUpcoming.length > 0) {
        log('INFO', 'AUTO', `LoL próximas ${UPCOMING_WINDOW_HOURS}h: ${allUpcoming.length} partidas`);
        for (const match of allUpcoming) {
          const matchKey = `upcoming_${match.game}_${match.id}`;
          const prev = analyzedMatches.get(matchKey);
          if (prev?.tipSent) continue; // já enviou tip — não repetir

          // Item 1: Bo3/Bo5 — aguarda draft disponível (fase live/draft)
          // Controlável via LOL_PREGAME_BLOCK_BO3=false para testes / fase de calibração.
          const blockBo3 = (process.env.LOL_PREGAME_BLOCK_BO3 ?? 'true') !== 'false';
          if (blockBo3 && (match.format === 'Bo3' || match.format === 'Bo5')) {
            log('INFO', 'AUTO', `Upcoming ${match.format} ignorado (${match.team1} vs ${match.team2}) — aguardando draft (LOL_PREGAME_BLOCK_BO3=true)`);
            continue;
          }

          const matchStart = match.time ? new Date(match.time).getTime() : 0;
          const timeToMatch = matchStart > 0 ? matchStart - now : Infinity;
          const isImminentMatch = timeToMatch > 0 && timeToMatch < 2 * 60 * 60 * 1000;

          // Partida iminente (<2h) bypassa cooldown; matches sem edge aguardam 2× o intervalo
          const upcomingCooldown = prev?.noEdge ? UPCOMING_ANALYZE_INTERVAL * 2 : UPCOMING_ANALYZE_INTERVAL;
          if (!isImminentMatch && prev && (now - prev.ts < upcomingCooldown)) continue;

          // Item 3: força re-fetch de odds se a partida começa em < 2h
          const oddsPath = isImminentMatch
            ? `/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}&force=1`
            : `/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}`;

          if (isImminentMatch) {
            log('INFO', 'AUTO', `Upcoming < 2h: forçando re-fetch de odds para ${match.team1} vs ${match.team2}`);
          }

          const oddsCheck = await serverGet(oddsPath).catch(() => null);
          const hasRealOdds = !!(oddsCheck?.t1 && parseFloat(oddsCheck.t1) > 1);
          const matchTime = match.time ? new Date(match.time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }) : '—';
          log('INFO', 'AUTO', `Esports upcoming: ${match.team1} vs ${match.team2} (${match.league}) às ${matchTime}${hasRealOdds ? ' — odds disponíveis' : ' — odds estimadas'}${isImminentMatch ? ' [IMINENTE <2h]' : ''}`);

          const result = await autoAnalyzeMatch(esportsConfig.token, match);
          analyzedMatches.set(matchKey, { ts: now, tipSent: false, noEdge: !result?.tipMatch });

          if (!result) { await new Promise(r => setTimeout(r, 2000)); continue; }

          if (result.tipMatch) {
            const tipTeam = result.tipMatch[1].trim();
            const tipOdd = result.tipMatch[2].trim();
            const tipEV = result.tipMatch[3].trim();
            const tipConf = (result.tipMatch[5] || 'MÉDIA').trim().toUpperCase();

            // Pré-jogo: confiança BAIXA bloqueada salvo se mlEdge forte (≥8pp) compensar ausência de dados ao vivo
            if (tipConf === 'BAIXA' && result.mlScore < 8) {
              log('INFO', 'AUTO', `Upcoming ${match.team1} vs ${match.team2} → conf BAIXA ML-edge insuficiente (${result.mlScore.toFixed(1)}pp < 8.0pp mín.) → rejeitado (pré-jogo)`);
              analyzedMatches.set(matchKey, { ts: now, tipSent: false, noEdge: true });
              await new Promise(r => setTimeout(r, 3000)); continue;
            }

            // ALTA → ¼ Kelly (max 4u) | MÉDIA → ⅙ Kelly (max 3u) | BAIXA → 1/10 Kelly (max 1.5u)
            const kellyFraction = tipConf === 'ALTA' ? 0.25 : tipConf === 'BAIXA' ? 0.10 : 1/6;
            // Usa p do modelo ML quando disponível (evita circularidade p←EV←IA)
            const isT1bet = norm(tipTeam).includes(norm(match.team1)) || norm(match.team1).includes(norm(tipTeam));
            const modelPForKelly = (result.modelP1 > 0) ? (isT1bet ? result.modelP1 : result.modelP2) : null;
            const tipStake = modelPForKelly
              ? calcKellyWithP(modelPForKelly, tipOdd, kellyFraction)
              : calcKellyFraction(tipEV, tipOdd, kellyFraction);
            const gameIcon = '🎮';
            const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔵' }[tipConf] || '🟡';
            const kellyLabel = tipConf === 'ALTA' ? '¼ Kelly' : tipConf === 'BAIXA' ? '1/10 Kelly' : '⅙ Kelly';
            const mlEdgeLabel = result.mlScore > 0 ? ` | ML: ${result.mlScore.toFixed(1)}pp` : '';

            await serverPost('/record-tip', {
              matchId: canonicalMatchId('esports', match.id), eventName: match.league,
              p1: match.team1, p2: match.team2, tipParticipant: tipTeam,
              odds: tipOdd, ev: tipEV, stake: tipStake,
              confidence: tipConf, isLive: false
            }, 'esports');

            const imminentNote = isImminentMatch ? `⏰ _Odds atualizadas agora (< 2h para o jogo)_\n` : '';
            const baixaNote = tipConf === 'BAIXA' ? `⚠️ _Confiança BAIXA (ML-edge ${result.mlScore.toFixed(1)}pp) — stake reduzido. Aposte com cautela._\n` : '';
            const tipMsg = `${gameIcon} 💰 *TIP PRÉ-JOGO ESPORTS (Bo1)*\n` +
              `*${match.team1}* vs *${match.team2}*\n📋 ${match.league}\n` +
              (match.time ? `🕐 Início: *${matchTime}* (BRT)\n` : '') +
              `\n🎯 Aposta: *${tipTeam}* ML @ *${tipOdd}*\n` +
              `📈 EV: *${tipEV}*\n💵 Stake: *${tipStake}* _(${kellyLabel})_\n` +
              `${confEmoji} Confiança: *${tipConf}*${mlEdgeLabel}\n` +
              `${imminentNote}${baixaNote}` +
              `📋 _Formato Bo1 — análise por forma e H2H (draft não disponível antes do início)_\n\n` +
              `⚠️ _Aposte com responsabilidade._`;

            for (const [userId, prefs] of subscribedUsers) {
              if (!prefs.has('esports')) continue;
              try { await sendDM(esportsConfig.token, userId, tipMsg); }
              catch(e) { if (e.message?.includes('403')) subscribedUsers.delete(userId); }
            }
            analyzedMatches.set(matchKey, { ts: now, tipSent: true });
            log('INFO', 'AUTO-TIP', `Esports upcoming: ${tipTeam} @ ${tipOdd}`);
          }
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      // Clean old esports analyses (> 26h — keep upcoming entries until match starts + 2h)
      const cutoff3h = now - 3 * 60 * 60 * 1000;
      const cutoff26h = now - 26 * 60 * 60 * 1000;
      for (const [k, v] of analyzedMatches) {
        const isUpcoming = k.startsWith('upcoming_');
        if (isUpcoming && v.ts < cutoff26h) analyzedMatches.delete(k);
        else if (!isUpcoming && v.ts < cutoff3h) analyzedMatches.delete(k);
      }
    } catch(e) {
      log('ERROR', 'AUTO-ESPORTS', e.message);
    }
  }

  });
}

// ── Settlement ──
async function settleCompletedTips() {
  if (Date.now() - lastSettlementCheck < SETTLEMENT_INTERVAL) return;
  lastSettlementCheck = Date.now();

  for (const sport of Object.keys(SPORTS)) {
    if (!SPORTS[sport].enabled) continue;

    try {
      const unsettled = await serverGet('/unsettled-tips?days=30', sport);
      if (!Array.isArray(unsettled) || !unsettled.length) continue;

      let settled = 0;

      if (sport === 'mma') {
        const espnFights = await fetchEspnMmaFights().catch(() => []);
        for (const tip of unsettled) {
          if (!tip.match_id) continue;
          try {
            const espn = espnFights.find(f => {
              const n1 = normName(tip.participant1), n2 = normName(tip.participant2);
              const e1 = normName(f.name1), e2 = normName(f.name2);
              const fwd = (e1.includes(n1) || n1.includes(e1)) && (e2.includes(n2) || n2.includes(e2));
              const rev = (e1.includes(n2) || n2.includes(e1)) && (e2.includes(n1) || n1.includes(e2));
              return fwd || rev;
            });
            if (!espn || espn.statusState !== 'post' || !espn.winner) continue;
            await serverPost('/settle', { matchId: tip.match_id, winner: espn.winner }, 'mma');
            log('INFO', 'SETTLE', `mma: ${tip.participant1} vs ${tip.participant2} → ${espn.winner}`);
            settled++;
          } catch(e) {
            log('WARN', 'SETTLE', `mma tip ${tip.match_id}: ${e.message}`);
          }
        }
        if (settled > 0) log('INFO', 'SETTLE', `mma: ${settled} tips liquidadas`);
        continue;
      }

      if (sport === 'tennis') {
        const [atpEvent, wtaEvent] = await Promise.all([
          fetchEspnTennisEvent('ATP').catch(() => null),
          fetchEspnTennisEvent('WTA').catch(() => null)
        ]);
        const allResults = [
          ...(atpEvent?.recentResults || []),
          ...(wtaEvent?.recentResults || [])
        ];
        for (const tip of unsettled) {
          if (!tip.match_id) continue;
          try {
            const res = allResults.find(r => {
              if (!r.winner) return false;
              const n1 = normName(tip.participant1), n2 = normName(tip.participant2);
              const rp1 = normName(r.p1), rp2 = normName(r.p2);
              const fwd = (rp1.includes(n1) || n1.includes(rp1)) && (rp2.includes(n2) || n2.includes(rp2));
              const rev = (rp1.includes(n2) || n2.includes(rp1)) && (rp2.includes(n1) || n1.includes(rp2));
              return fwd || rev;
            });
            if (!res) continue;
            await serverPost('/settle', { matchId: tip.match_id, winner: res.winner }, 'tennis');
            log('INFO', 'SETTLE', `tennis: ${tip.participant1} vs ${tip.participant2} → ${res.winner}`);
            settled++;
          } catch(e) {
            log('WARN', 'SETTLE', `tennis tip ${tip.match_id}: ${e.message}`);
          }
        }
        if (settled > 0) log('INFO', 'SETTLE', `tennis: ${settled} tips liquidadas`);
        continue;
      }

      for (const tip of unsettled) {
        if (!tip.match_id) continue;
        try {
          let endpoint;
          if (sport === 'football') {
            // IDs de futebol são The Odds API event IDs; usamos API-Football via fixtureId guardado no match_id
            // Só tenta se o match_id parecer numérico (fixture ID da API-Football)
            // ou prefixado com "fb_"
            const fbId = String(tip.match_id).replace(/^fb_/, '');
            if (!/^\d+$/.test(fbId)) continue; // não é fixture ID numérico, pula
            endpoint = `/football-result?fixtureId=${encodeURIComponent(fbId)}`;
          } else {
            const isPanda = String(tip.match_id).startsWith('ps_');
            endpoint = isPanda
              ? `/ps-result?matchId=${encodeURIComponent(tip.match_id)}`
              : `/match-result?matchId=${encodeURIComponent(tip.match_id)}&game=lol`;
          }

          const result = await serverGet(endpoint).catch(() => null);
          if (!result?.resolved || !result?.winner) continue;

          // Para futebol, o "winner" pode ser "Draw" — tip em Draw vence se winner === 'Draw'
          let won;
          if (sport === 'football') {
            const mkt = tip.market_type || '';
            if (mkt === '1X2_D') {
              won = result.winner === 'Draw';
            } else if (mkt === 'OVER_2.5' || mkt === 'UNDER_2.5') {
              // Settlement de Over/Under: usa score para calcular total de gols
              const [g1, g2] = (result.score || '0-0').split('-').map(Number);
              const total = (g1 || 0) + (g2 || 0);
              won = mkt === 'OVER_2.5' ? total > 2.5 : total < 2.5;
              // Registra winner fictício para compatibilidade com /settle
              result.winner = won ? tip.tip_participant : '__loss__';
            } else {
              won = norm(result.winner).includes(norm(tip.tip_participant));
            }
          } else {
            won = norm(result.winner).includes(norm(tip.tip_participant));
          }

          await serverPost('/settle', { matchId: tip.match_id, winner: result.winner }, sport);

          log('INFO', 'SETTLE', `${sport}: ${tip.participant1} vs ${tip.participant2} → ${won ? 'WIN ✅' : 'LOSS ❌'} (${result.winner})`);
          settled++;
        } catch(e) {
          log('WARN', 'SETTLE', `Tip ${tip.match_id}: ${e.message}`);
        }
      }

      if (settled > 0) log('INFO', 'SETTLE', `${sport}: ${settled} tips liquidadas`);
    } catch(e) {
      log('WARN', 'SETTLE', `${sport}: ${e.message}`);
    }
  }
}

// ── Line Movement Alerts ──
async function checkLineMovement() {
  if (Date.now() - lastLineCheck < LINE_CHECK_INTERVAL) return;
  lastLineCheck = Date.now();

  const esportsConfig = SPORTS['esports'];
  if (!esportsConfig?.enabled || subscribedUsers.size === 0) return;

  try {
    // Usa /lol-matches que inclui odds no cache (campo .odds.t1/.odds.t2)
    const raw = await serverGet('/lol-matches');
    if (!Array.isArray(raw)) return;

    const now = Date.now();
    const windowEnd = now + 48 * 60 * 60 * 1000;

    for (const match of raw) {
      if (!match.odds?.t1 || !match.odds?.t2) continue;
      // Só monitora partidas nas próximas 48h
      const t = match.time ? new Date(match.time).getTime() : 0;
      if (t > 0 && t > windowEnd) continue;

      const t1 = match.team1 || match.participant1_name || '';
      const t2 = match.team2 || match.participant2_name || '';
      const key = `esports_${t1}_${t2}`;
      const cur = { t1: parseFloat(match.odds.t1), t2: parseFloat(match.odds.t2) };
      const prev = lineAlerted.get(key);

      if (!prev) {
        lineAlerted.set(key, cur);
        continue;
      }

      const d1 = Math.abs((cur.t1 - prev.t1) / prev.t1);
      const d2 = Math.abs((cur.t2 - prev.t2) / prev.t2);
      if (d1 < 0.10 && d2 < 0.10) {
        lineAlerted.set(key, cur);
        continue;
      }

      lineAlerted.set(key, cur);

      const arrow = (c, p) => c < p ? '📉' : '📈';
      const msg = `📊 *MOVIMENTO DE LINHA*\n\n` +
        `🎮 *${t1}* vs *${t2}*\n_${match.league || 'LoL'}_\n\n` +
        `${arrow(cur.t1, prev.t1)} ${t1}: ${prev.t1.toFixed(2)} → ${cur.t1.toFixed(2)}\n` +
        `${arrow(cur.t2, prev.t2)} ${t2}: ${prev.t2.toFixed(2)} → ${cur.t2.toFixed(2)}\n\n` +
        `💡 _Movimentos bruscos = sharp money ou lesão_`;

      for (const [userId, prefs] of subscribedUsers) {
        if (!prefs.has('esports')) continue;
        try { await sendDM(esportsConfig.token, userId, msg); }
        catch(e) { if (e.message?.includes('403')) subscribedUsers.delete(userId); }
      }

      log('INFO', 'LINE', `esports: ${t1} vs ${t2} Δ${(Math.max(d1,d2)*100).toFixed(1)}%`);
    }
  } catch(e) {
    log('ERROR', 'LINE', e.message);
  }
}

// ── Helpers ──
function normalizeEsportsMatch(m) {
  return {
    id: m.id,
    sport: 'esports',
    participant1_name: m.team1 || m.participant1_name,
    participant2_name: m.team2 || m.participant2_name,
    event_name: m.league || m.event_name || 'Esports',
    event_date: m.time || m.event_date || '',
    category: `${(m.game || 'esports').toUpperCase()}${m.format ? ' ' + m.format : ''}`,
    is_title: false,
    is_main: m.status === 'live',
    status: m.status || 'upcoming',
    odds: m.odds || null,
    // preserve raw fields for display
    game: m.game,
    league: m.league,
    score1: m.score1,
    score2: m.score2,
    duration: m.duration,
    winner: m.winner,
    format: m.format
  };
}



function fmtMatchTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  } catch(_) { return ''; }
}

// ── Helper Functions ──
function getPatchMetaAgeDays() {
  const dateStr = process.env.PATCH_META_DATE;
  if (!dateStr) return null;
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / (86400 * 1000));
  return isNaN(days) ? null : days;
}

async function checkPatchMetaStale(token) {
  if (!ADMIN_IDS.size) return;
  if (Date.now() - lastPatchAlert < PATCH_ALERT_INTERVAL) return;
  const age = getPatchMetaAgeDays();
  if (age !== null && age >= 14) {
    lastPatchAlert = Date.now();
    const msg = `⚠️ *PATCH META DESATUALIZADO*\n\n` +
      `O patch meta tem *${age} dias* sem atualização.\n\n` +
      `Atualize no \`.env\`:\n` +
      `• \`LOL_PATCH_META=Patch X.XX — ...\`\n` +
      `• \`PATCH_META_DATE=YYYY-MM-DD\`\n\n` +
      `_Análises de LoL estão usando meta desatualizado!_`;
    for (const adminId of ADMIN_IDS) {
      await sendDM(token, adminId, msg).catch(() => {});
    }
  }
}

// ── Auto Patch Meta (ddragon) ──
async function fetchLatestPatchMeta() {
  const now = Date.now();
  if (now - patchAutoFetchTs < PATCH_AUTO_FETCH_INTERVAL) return;
  patchAutoFetchTs = now;

  try {
    const versions = await new Promise((resolve, reject) => {
      https.get('https://ddragon.leagueoflegends.com/api/versions.json', res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });

    if (!Array.isArray(versions) || !versions[0]) return;
    const latestFull = versions[0]; // ex: "15.6.1"
    const patchShort = latestFull.split('.').slice(0, 2).join('.'); // "15.6"

    const currentMeta = process.env.LOL_PATCH_META || '';
    const metaAge = getPatchMetaAgeDays();

    // Se o usuário já configurou manualmente E a data é recente (< 14 dias) → não sobrescreve
    if (currentMeta && metaAge !== null && metaAge < 14) {
      log('INFO', 'PATCH', `Meta manual configurado (${metaAge}d) — auto-detect ignorado (ddragon: ${patchShort})`);
      return;
    }

    // Se o meta já menciona a versão do ddragon → nada a fazer
    if (currentMeta.includes(patchShort)) {
      log('INFO', 'PATCH', `Patch ${patchShort} já no contexto — sem atualização`);
      return;
    }

    // Só chega aqui se: meta vazio OU meta com > 14 dias sem atualização
    const prevMeta = currentMeta || '(não definido)';
    const patchNotesUrl = `https://www.leagueoflegends.com/en-us/news/game-updates/patch-${patchShort.replace('.', '-')}-notes/`;
    const newMeta = `Patch ${patchShort} (auto-detectado — revise buffs/nerfs relevantes)`;
    const newDate = new Date().toISOString().slice(0, 10);
    process.env.LOL_PATCH_META = newMeta;
    process.env.PATCH_META_DATE = newDate;
    savePatchMetaToFile(newMeta, newDate); // persiste no volume Railway
    lastPatchAlert = 0;

    log('INFO', 'PATCH', `Novo patch auto-detectado: ${patchShort} (anterior: ${prevMeta.slice(0, 40)})`);

    const esportsToken = SPORTS['esports']?.token;
    if (esportsToken && ADMIN_IDS.size) {
      const msg = `🔄 *NOVO PATCH DETECTADO: ${patchShort}*\n\n` +
        `O contexto da IA foi atualizado automaticamente para o Patch ${patchShort}.\n\n` +
        `📋 [Ver patch notes](${patchNotesUrl})\n\n` +
        `Para adicionar resumo manual de meta (opcional, melhora qualidade):\n` +
        `\`LOL_PATCH_META=Patch ${patchShort} — [buff/nerfs relevantes]\`\n\n` +
        `_Sem ação necessária — análises já refletem o patch atual._`;
      for (const adminId of ADMIN_IDS) {
        await sendDM(esportsToken, adminId, msg).catch(() => {});
      }
    }
  } catch(e) {
    log('WARN', 'PATCH', `Erro no auto-fetch de patch meta: ${e.message}`);
  }
}

// Live match notifications for esports
async function checkLiveNotifications() {
  if (Date.now() - lastLiveCheck < LIVE_CHECK_INTERVAL) return;
  if (subscribedUsers.size === 0) return;
  lastLiveCheck = Date.now();

  const esportsConfig = SPORTS['esports'];
  if (!esportsConfig?.enabled || !esportsConfig.token) return;
  const token = esportsConfig.token;

  try {
    const lolList = await serverGet('/lol-matches').catch(() => []);
    const allLive = Array.isArray(lolList) ? lolList.filter(m => m.status === 'live') : [];

    for (const match of allLive) {
      // Ignora jogos sem odds na The Odds API (reduz ruído desnecessário pro usuário)
      if (!match.odds?.t1 || parseFloat(match.odds.t1) <= 1.0) continue;

      const matchKey = `${match.game}_${match.id}`;
      if (!notifiedMatches.has(matchKey)) {
        notifiedMatches.set(matchKey, Date.now());
        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('esports')) continue;
          try {
            const o = match.odds;
            const gameIcon = '🎮';
            const txt = `${gameIcon} 🔴 *PARTIDA AO VIVO (COM MERCADO ABERTO)!*\n\n` +
              `*${match.team1}* ${match.score1}-${match.score2} *${match.team2}*\n` +
              `📋 ${match.league}\n` +
              `💰 ${match.team1}: ${o.t1} | ${match.team2}: ${o.t2}\n\n` +
              `_O bot efetuará a análise IA (se houver +EV) em breve, ou você pode requisitá-la agora._`;
            
            await sendDM(token, userId, txt);
          } catch(e) {
            if (e.message?.includes('403')) subscribedUsers.delete(userId);
          }
        }
      }
    }

    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [key, ts] of notifiedMatches) {
      if (ts < cutoff) notifiedMatches.delete(key);
    }
  } catch(e) {
    log('WARN', 'NOTIFY', e.message);
  }
}


// Collect live game stats for esports analysis
async function collectGameContext(game, matchId) {
  let gamesContext = '';
  let compScore = null; // pp advantage for t1 (blue) based on pro champion WRs
  let liveGameNumber = null; // número do mapa atualmente ao vivo (Game 1, 2, 3...)
  if (game === 'lol') {
    const isPandaScore = String(matchId).startsWith('ps_');

    if (isPandaScore) {
      // Fonte PandaScore — composições via /ps-compositions
      try {
        const gd = await serverGet(`/ps-compositions?matchId=${encodeURIComponent(matchId)}`);
        if (gd.hasCompositions && (gd.blueTeam?.players?.length || gd.redTeam?.players?.length)) {
          const roles = { top:'TOP', jungle:'JGL', mid:'MID', bottom:'ADC', support:'SUP', '?':'?' };
          const g = (v) => v >= 1000 ? (v/1000).toFixed(1)+'k' : String(v||0);
          const gameLabel = gd.gameNumber ? `GAME ${gd.gameNumber}` : 'GAME';
          const statusLabel = gd.gameStatus === 'running' ? 'AO VIVO' : gd.gameStatus || 'INFO';
          if (gd.gameStatus === 'running' && gd.gameNumber) liveGameNumber = gd.gameNumber;
          gamesContext += `\n[${gameLabel} — ${statusLabel} | Série: ${gd.seriesScore||'0-0'}]\n`;
          if (gd.hasLiveStats) {
            const blue = gd.blueTeam, red = gd.redTeam;
            const goldDiff = (blue.totalGold||0) - (red.totalGold||0);
            gamesContext += `Gold: ${blue.name} ${g(blue.totalGold)} vs ${red.name} ${g(red.totalGold)} (diff: ${goldDiff>0?'+':''}${g(goldDiff)})\n`;
          }
          const fmtComp = (team) => (team.players||[]).map(p => {
            const role = (roles[p.role]||'?').padEnd(4);
            const champ = (p.champion||'???').toString().slice(0,12).padEnd(12);
            const name = (p.name||'?').slice(0,10);
            if (gd.hasLiveStats) return `  ${role} ${champ} ${name} ${p.kills||0}/${p.deaths||0}/${p.assists||0} ${g(p.gold||0)}g`;
            return `  ${role} ${champ} ${name}`;
          }).join('\n');
          gamesContext += `${gd.blueTeam.name}:\n${fmtComp(gd.blueTeam)}\n`;
          gamesContext += `${gd.redTeam.name}:\n${fmtComp(gd.redTeam)}\n`;
          gamesContext += `_Fonte: PandaScore_\n`;

          // Buscar WR de campeões + jogadores em pro play
          try {
            const allPlayers = [...(gd.blueTeam?.players||[]), ...(gd.redTeam?.players||[])];
            const champNames   = allPlayers.map(p => p.champion).filter(c => c && c !== '?').join(',');
            const roleNames    = allPlayers.map(p => p.role || 'unknown').join(',');
            const playerNames  = allPlayers.map(p => p.name || '').join(',');
            const playerChamps = allPlayers.map(p => p.champion || '').join(',');

            const [wrData, pcData] = await Promise.all([
              champNames ? serverGet(`/champ-winrates?champs=${encodeURIComponent(champNames)}&roles=${encodeURIComponent(roleNames)}`).catch(() => ({})) : Promise.resolve({}),
              playerNames ? serverGet(`/player-champ-stats?players=${encodeURIComponent(playerNames)}&champs=${encodeURIComponent(playerChamps)}`).catch(() => ({})) : Promise.resolve({})
            ]);

            // Comp score por champ WR
            if (wrData && Object.keys(wrData).length >= 4) {
              let blueWR = 0, blueN = 0, redWR = 0, redN = 0;
              for (const pl of (gd.blueTeam?.players||[])) {
                const s = wrData[pl.champion];
                if (s) { blueWR += s.winRate; blueN++; }
              }
              for (const pl of (gd.redTeam?.players||[])) {
                const s = wrData[pl.champion];
                if (s) { redWR += s.winRate; redN++; }
              }
              if (blueN > 0 && redN > 0) {
                const blueAvg = blueWR / blueN;
                const redAvg  = redWR  / redN;
                compScore = blueAvg - redAvg;
                gamesContext += `META PRO (champ WR): ${gd.blueTeam.name} ${blueAvg.toFixed(1)}% vs ${gd.redTeam.name} ${redAvg.toFixed(1)}% (diff: ${compScore > 0 ? '+' : ''}${compScore.toFixed(1)}pp)\n`;
              }
            }

            // Player+champ WR
            if (pcData && Object.keys(pcData).length > 0) {
              const lines = [];
              for (const pl of allPlayers) {
                const key = `${pl.name}/${pl.champion}`;
                const stat = pcData[key];
                if (stat) lines.push(`${pl.name}(${pl.champion}): ${stat.winRate}% em ${stat.total} games`);
              }
              if (lines.length > 0) {
                gamesContext += `PLAYER CHAMP WR: ${lines.join(' | ')}\n`;
              }
            }
          } catch(_) {}
        }
      } catch(e) { log('WARN', 'PS-CONTEXT', e.message); }
    } else {
      // Fonte Riot (lolesports.com) — live-gameids + live-game
      const ids = await serverGet(`/live-gameids?matchId=${matchId}`).catch(() => []);
      if (Array.isArray(ids)) {
        for (const gid of ids) {
          try {
            const gd = await serverGet(`/live-game?gameId=${gid.gameId}`);
            if (gd.blueTeam?.players?.length) {
              const roles = { top:'TOP', jungle:'JGL', mid:'MID', bottom:'ADC', support:'SUP' };
              const g = (v) => v >= 1000 ? (v/1000).toFixed(1)+'k' : String(v||0);
              if (gd.hasLiveStats) {
                const blue = gd.blueTeam, red = gd.redTeam;
                const goldDiff = blue.totalGold - red.totalGold;
                const delayInfo = gd.dataDelay ? ` (dados de ~${gd.dataDelay}s atrás)` : '';
                const blueDragons = blue.dragonTypes?.length ? blue.dragonTypes.join(', ') : (blue.dragons||0);
                const redDragons = red.dragonTypes?.length ? red.dragonTypes.join(', ') : (red.dragons||0);
                if (gid.gameNumber) liveGameNumber = gid.gameNumber;
                gamesContext += `\n[GAME ${gid.gameNumber} — AO VIVO${delayInfo}]\nGold: ${blue.name} ${g(blue.totalGold)} vs ${red.name} ${g(red.totalGold)} (diff: ${goldDiff>0?'+':''}${g(goldDiff)})\nTorres: ${blue.towerKills||0}x${red.towerKills||0} | Dragões: ${blueDragons} vs ${redDragons}\nKills: ${blue.totalKills||0}x${red.totalKills||0} | Barões: ${blue.barons||0}x${red.barons||0} | Inibidores: ${blue.inhibitors||0}x${red.inhibitors||0}\n`;
                if (gd.goldTrajectory?.length > 0) {
                  gamesContext += 'Gold Trajectory: ' + gd.goldTrajectory.map(gt => `${gt.minute}min:${gt.diff>0?'+':''}${g(gt.diff)}`).join(' → ') + '\n';
                }
              }
              const fmtComp = (team) => team.players.map(p => {
                const role = (roles[p.role]||'?').padEnd(4);
                const champ = (p.champion||'???').toString().slice(0,12).padEnd(12);
                const name = (p.name||'?').slice(0,10);
                if (gd.hasLiveStats) return `  ${role} ${champ} ${name} ${p.kills||0}/${p.deaths||0}/${p.assists||0} ${g(p.gold||0)}g`;
                return `  ${role} ${champ} ${name}`;
              }).join('\n');
              gamesContext += `${gd.blueTeam.name}:\n${fmtComp(gd.blueTeam)}\n`;
              gamesContext += `${gd.redTeam.name}:\n${fmtComp(gd.redTeam)}\n`;

              // WR de campeões + jogadores pro play (Riot source)
              if (compScore === null) {
                try {
                  const allPlayers = [...(gd.blueTeam?.players||[]), ...(gd.redTeam?.players||[])];
                  const champNames   = allPlayers.map(p => p.champion).filter(c => c && c !== '?').join(',');
                  const roleNames    = allPlayers.map(p => p.role || 'unknown').join(',');
                  const playerNames  = allPlayers.map(p => p.name || '').join(',');
                  const playerChamps = allPlayers.map(p => p.champion || '').join(',');

                  const [wrData, pcData] = await Promise.all([
                    champNames ? serverGet(`/champ-winrates?champs=${encodeURIComponent(champNames)}&roles=${encodeURIComponent(roleNames)}`).catch(() => ({})) : Promise.resolve({}),
                    playerNames ? serverGet(`/player-champ-stats?players=${encodeURIComponent(playerNames)}&champs=${encodeURIComponent(playerChamps)}`).catch(() => ({})) : Promise.resolve({})
                  ]);

                  if (wrData && Object.keys(wrData).length >= 4) {
                    let blueWR = 0, blueN = 0, redWR = 0, redN = 0;
                    for (const pl of (gd.blueTeam?.players||[])) {
                      const s = wrData[pl.champion];
                      if (s) { blueWR += s.winRate; blueN++; }
                    }
                    for (const pl of (gd.redTeam?.players||[])) {
                      const s = wrData[pl.champion];
                      if (s) { redWR += s.winRate; redN++; }
                    }
                    if (blueN > 0 && redN > 0) {
                      const blueAvg = blueWR / blueN;
                      const redAvg  = redWR  / redN;
                      compScore = blueAvg - redAvg;
                      gamesContext += `META PRO (champ WR): ${gd.blueTeam.name} ${blueAvg.toFixed(1)}% vs ${gd.redTeam.name} ${redAvg.toFixed(1)}% (diff: ${compScore > 0 ? '+' : ''}${compScore.toFixed(1)}pp)\n`;
                    }
                  }
                  if (pcData && Object.keys(pcData).length > 0) {
                    const lines = [];
                    for (const pl of allPlayers) {
                      const stat = pcData[`${pl.name}/${pl.champion}`];
                      if (stat) lines.push(`${pl.name}(${pl.champion}): ${stat.winRate}% em ${stat.total} games`);
                    }
                    if (lines.length > 0) gamesContext += `PLAYER CHAMP WR: ${lines.join(' | ')}\n`;
                  }
                } catch(_) {}
              }
            }
          } catch(_) {}
        }
      }
    }
  }
  return { text: gamesContext, compScore, liveGameNumber };
}

async function fetchEnrichment(match) {
  const game = match.game;
  const data = { form1: null, form2: null, h2h: null, oddsMovement: null };
  try {
    const [f1, f2, h, om] = await Promise.all([
      serverGet(`/team-form?team=${encodeURIComponent(match.team1 || match.participant1_name)}&game=${game}`).catch(() => null),
      serverGet(`/team-form?team=${encodeURIComponent(match.team2 || match.participant2_name)}&game=${game}`).catch(() => null),
      serverGet(`/h2h?team1=${encodeURIComponent(match.team1 || match.participant1_name)}&team2=${encodeURIComponent(match.team2 || match.participant2_name)}&game=${game}`).catch(() => null),
      serverGet(`/odds-movement?team1=${encodeURIComponent(match.team1 || match.participant1_name)}&team2=${encodeURIComponent(match.team2 || match.participant2_name)}`).catch(() => null),
    ]);
    data.form1 = f1; data.form2 = f2; data.h2h = h; data.oddsMovement = om;
  } catch(_) {}
  return data;
}

function buildEnrichmentSection(match, enrich) {
  let txt = '';
  const t1 = match.team1 || match.participant1_name;
  const t2 = match.team2 || match.participant2_name;
  const f1 = enrich.form1, f2 = enrich.form2;
  if ((f1?.wins + f1?.losses > 0) || (f2?.wins + f2?.losses > 0)) {
    txt += '\nFORMA RECENTE:\n';
    if (f1?.wins + f1?.losses > 0) txt += `${t1}: ${f1.wins}W-${f1.losses}L (${f1.winRate}%) | Streak: ${f1.streak}\n`;
    if (f2?.wins + f2?.losses > 0) txt += `${t2}: ${f2.wins}W-${f2.losses}L (${f2.winRate}%) | Streak: ${f2.streak}\n`;
  }
  const h = enrich.h2h;
  if (h?.totalMatches > 0 || h?.totalGames > 0) {
    const total = h.totalMatches || h.totalGames || 0;
    txt += `\nH2H: ${t1} ${h.t1Wins}-${h.t2Wins} ${t2} (${total} jogos)\n`;
  }
  const om = enrich.oddsMovement;
  if (om?.history?.length >= 2) {
    const first = om.history[0], last = om.history[om.history.length - 1];
    const p1Key = 'odds_t1', p2Key = 'odds_t2';
    const dir1 = parseFloat(last[p1Key]) < parseFloat(first[p1Key]) ? 'caindo (sharp money?)' : 'subindo';
    txt += `\nLINE MOVEMENT:\nAbertura: ${t1}=${first[p1Key]} | ${t2}=${first[p2Key]}\nAtual: ${t1}=${last[p1Key]} | ${t2}=${last[p2Key]}\n${t1}: odds ${dir1}\n`;
  }
  if (match.game === 'lol') {
    const patchMeta = process.env.LOL_PATCH_META || '⚠️ Patch meta não configurado';
    const patchAge = getPatchMetaAgeDays();
    const patchAgeNote = patchAge !== null && patchAge >= 14 ? ` ⚠️ (${patchAge} dias desatualizado)` : '';
    txt += `\nPATCH META: ${patchMeta}${patchAgeNote}\n`;
  }
  if (match.format) {
    if (match.format === 'Bo1') txt += '\nCONTEXTO: Bo1 — alta variância, upset mais provável.\n';
    else if (match.format === 'Bo5') txt += '\nCONTEXTO: Bo5 — formato decisivo, favorece time mais consistente.\n';
  }
  return txt;
}

async function autoAnalyzeMatch(token, match) {
  const game = match.game;
  const matchId = String(match.id);
  try {
    const [o, gameCtx, enrich] = await Promise.all([
      serverGet(`/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}`).catch(() => null),
      collectGameContext(game, matchId),
      fetchEnrichment(match)
    ]);
    const gamesContext   = gameCtx.text;
    const compScore      = gameCtx.compScore;
    const liveGameNumber = gameCtx.liveGameNumber; // nº do mapa atual (null se não ao vivo)
    const hasLiveStats   = gamesContext.includes('AO VIVO');
    const enrichSection = buildEnrichmentSection(match, enrich);

    // ── Layer 1: Pré-filtro ML ──
    // Retorna { pass, direction, score, t1Edge, t2Edge }
    const mlPrefilterOn = (process.env.LOL_ML_PREFILTER ?? 'true') !== 'false';
    const mlResult = esportsPreFilter(match, o, enrich, hasLiveStats, gamesContext, compScore);
    if (mlPrefilterOn && !mlResult.pass) {
      log('INFO', 'AUTO', `Pré-filtro ML: edge insuficiente (${mlResult.score.toFixed(1)}pp) para ${match.team1} vs ${match.team2}. Pulando IA.`);
      return null;
    }

    const newsSectionEsports = await fetchMatchNews('esports', match.team1, match.team2).catch(() => '');
    const { text: prompt, evThreshold: adaptiveEV, sigCount } = buildEsportsPrompt(match, game, gamesContext, o, enrichSection, mlResult, newsSectionEsports);
    log('INFO', 'AUTO', `Analisando: ${match.team1} vs ${match.team2} | sinais=${sigCount}/6 | evThreshold=${adaptiveEV}% | mlEdge=${mlResult.score.toFixed(1)}pp`);

    const resp = await serverPost('/claude', {
      model: 'deepseek-chat',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    }, null, { 'x-claude-key': AI_PROXY_KEY });

    const text = resp.content?.map(b => b.text || '').join('');
    if (!text) {
      log('WARN', 'AUTO', `IA sem resposta para ${match.team1} vs ${match.team2} (provider: ${resp.provider || 'claude'})`);
      return null;
    }

    const tipResult = text.match(/TIP_ML:\s*([^@]+?)\s*@\s*([^|\]]+?)\s*\|EV:\s*([^|]+?)\s*\|STAKE:\s*([^|\]]+?)(?:\s*\|CONF:\s*(\w+))?(?:\]|$)/);
    const hasRealOdds = !!(o?.t1 && parseFloat(o.t1) > 1);

    const extractTipReason = (t) => {
      if (!t) return null;
      const before = t.split('TIP_ML:')[0] || '';
      const line = before.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
      const clean = line.replace(/^[-*•\s]+/, '').trim();
      if (!clean) return null;
      return clean.slice(0, 160);
    };
    const tipReason = extractTipReason(text);

    // Extrai resumo da análise da IA para logar mesmo quando não há tip
    const extractAnalysisSummary = (t) => {
      const parts = [];
      // P(time)=X% — linha de resumo do prompt
      const pMatch = t.match(/P\(([^)]+)\)\s*=\s*(\d+)%.*?P\(([^)]+)\)\s*=\s*(\d+)%/);
      if (pMatch) parts.push(`P(${pMatch[1]})=${pMatch[2]}% P(${pMatch[3]})=${pMatch[4]}%`);
      // EV(time)=[X%]
      const evMatches = [...t.matchAll(/EV\(([^)]+)\)\s*=\s*\[?([+-]?\d+\.?\d*)%?\]?/g)];
      if (evMatches.length) parts.push(evMatches.map(m => `EV(${m[1]})=${m[2]}%`).join(' '));
      // Sinais N/5
      const sinaisMatch = t.match(/Sinais:\s*(\d+\/\d+|\d+\s*\/\s*\d+)/i);
      if (sinaisMatch) parts.push(`Sinais:${sinaisMatch[1].replace(/\s/g,'')}`);
      return parts.length ? parts.join(' | ') : null;
    };

    // ── Layer 3: Gates pós-IA ──
    // Só aplicamos os gates se há uma tip sugerida pela IA
    // Cópia mutável para permitir rebaixamento de confiança sem rejeição
    let filteredTipResult = tipResult ? Array.from(tipResult) : null;
    if (filteredTipResult) {
      const tipTeam  = filteredTipResult[1].trim();
      const tipOdd   = parseFloat(filteredTipResult[2]);
      const tipEV    = parseFloat(String(filteredTipResult[3]).replace('%','').replace('+',''));
      let   tipConf  = (filteredTipResult[5] || 'MÉDIA').trim().toUpperCase();

      // Gate 0: Sem odds reais → rejeitar sempre (odds estimadas não garantem valor)
      if (!hasRealOdds) {
        log('INFO', 'AUTO', `Gate odds reais: ${match.team1} vs ${match.team2} → odds estimadas → rejeitado`);
        filteredTipResult = null;
      }

      const getConf = () => (filteredTipResult?.[5] || 'MÉDIA').trim().toUpperCase();

      // Gate 2: Odds fora da zona de valor
      // Abaixo de 1.50: margem da casa come todo o EV.
      // Acima de 4.00: alta variância; underdog legítimo em ligas tier-2 pode ter valor,
      //   mas exige EV mínimo maior para compensar a incerteza sem Pinnacle como referência.
      if (filteredTipResult && hasRealOdds) {
        const MIN_ODDS  = parseFloat(process.env.LOL_MIN_ODDS  ?? '1.50');
        const MAX_ODDS  = parseFloat(process.env.LOL_MAX_ODDS  ?? '4.00');
        const HIGH_ODDS = parseFloat(process.env.LOL_HIGH_ODDS ?? '3.00'); // acima disso → EV extra
        const HIGH_ODDS_EV_BONUS = parseFloat(process.env.LOL_HIGH_ODDS_EV_BONUS ?? '3.0'); // +3pp

        if (tipOdd < MIN_ODDS || tipOdd > MAX_ODDS) {
          log('INFO', 'AUTO', `Gate odds: ${match.team1} vs ${match.team2} → odd ${tipOdd} fora do range [${MIN_ODDS}, ${MAX_ODDS}] → rejeitado`);
          filteredTipResult = null;
        } else if (tipOdd > HIGH_ODDS && !isNaN(tipEV)) {
          // Odds altas passam mas exigem EV maior — aplicado antes do Gate 4 via adaptiveEV bump
          const required = adaptiveEV + HIGH_ODDS_EV_BONUS;
          if (tipEV < required) {
            log('INFO', 'AUTO', `Gate odds altas: ${match.team1} vs ${match.team2} → odd ${tipOdd} > ${HIGH_ODDS} mas EV ${tipEV}% < ${required.toFixed(1)}% → rejeitado`);
            filteredTipResult = null;
          }
        }
      }

      // Gate 3: Consenso de direção ML × IA
      // Divergência = incerteza, não erro. Rebaixa para MÉDIA em vez de rejeitar.
      // Raciocínio: a IA vê os mesmos dados + pode identificar padrões não-lineares.
      if (filteredTipResult && mlResult.direction && hasRealOdds && mlResult.score > 8) {
        const t1 = (match.team1 || '').toLowerCase();
        const tipTeamNorm = tipTeam.toLowerCase();
        const aiDirectionIsT1 = tipTeamNorm.includes(t1) || t1.includes(tipTeamNorm);
        const mlDirectionIsT1 = mlResult.direction === 't1';
        if (aiDirectionIsT1 !== mlDirectionIsT1) {
          const confAtual = getConf();
          if (confAtual === 'ALTA') {
            filteredTipResult[5] = 'MÉDIA';
            log('INFO', 'AUTO', `Gate consenso: ${match.team1} vs ${match.team2} → ML(${mlResult.direction}) ≠ IA(${tipTeam}) → rebaixado ALTA→MÉDIA (incerteza)`);
          } else if (confAtual === 'MÉDIA') {
            filteredTipResult[5] = 'BAIXA';
            log('INFO', 'AUTO', `Gate consenso: ${match.team1} vs ${match.team2} → ML(${mlResult.direction}) ≠ IA(${tipTeam}) → rebaixado MÉDIA→BAIXA (divergência ML×IA)`);
          } else {
            log('INFO', 'AUTO', `Gate consenso: ${match.team1} vs ${match.team2} → ML(${mlResult.direction}) ≠ IA(${tipTeam}) → incerteza ML×IA (conf BAIXA mantida)`);
          }
        }
      }

      // Gate 4: EV mínimo adaptativo por nível de confiança
      // ALTA: adaptiveEV (padrão) | MÉDIA: adaptiveEV-1.5% | BAIXA: adaptiveEV-3%
      if (filteredTipResult && hasRealOdds) {
        const confNow = getConf();
        const evOffset = confNow === 'ALTA' ? 0 : confNow === 'MÉDIA' ? -1.5 : -3;
        const confThreshold = Math.max(0.5, adaptiveEV + evOffset);
        if (!isNaN(tipEV) && tipEV < confThreshold) {
          log('INFO', 'AUTO', `Gate EV: ${match.team1} vs ${match.team2} → EV ${tipEV}% < threshold ${confThreshold.toFixed(1)}% [${confNow}] (${sigCount}/6 sinais) → rejeitado`);
          filteredTipResult = null;
        }
      }

      if (filteredTipResult) {
        const confFinal = getConf();
        const tierLabel = confFinal === 'ALTA' ? '🟢 ALTA' : confFinal === 'MÉDIA' ? '🟡 MÉDIA' : '🔵 BAIXA';
        log('INFO', 'AUTO', `Tip aprovada: ${tipTeam} @ ${tipOdd} | EV ${tipEV}% | Conf:${tierLabel} | ML-edge:${mlResult.score.toFixed(1)}pp`);
      }
    }

    if (!filteredTipResult) {
      const summary = extractAnalysisSummary(text);
      if (!tipResult) {
        // IA não gerou TIP_ML — sem edge detectado
        log('INFO', 'AUTO', `Sem tip: ${match.team1} vs ${match.team2} → IA sem edge${summary ? ` | ${summary}` : ''} | mlEdge=${mlResult.score.toFixed(1)}pp`);
      } else {
        // TIP_ML gerada mas bloqueada pelos gates (já logado individualmente acima)
        log('INFO', 'AUTO', `Tip bloqueada: ${match.team1} vs ${match.team2}${summary ? ` | ${summary}` : ''} | mlEdge=${mlResult.score.toFixed(1)}pp`);
      }
    } else {
      log('INFO', 'AUTO', `${match.team1} vs ${match.team2} | odds=${o?.t1||'N/A'} hasRealOdds=${hasRealOdds} tipMatch=true mlEdge=${mlResult.score.toFixed(1)}pp`);
    }
    return {
      text,
      tipMatch: filteredTipResult,
      hasLiveStats,
      liveGameNumber,
      match,
      o,
      mlScore: mlResult.score,
      modelP1: mlResult.modelP1,
      modelP2: mlResult.modelP2,
      mlDirection: mlResult.direction || null,
      factorActive: mlResult.factorActive || [],
      tipReason
    };
  } catch(e) {
    log('ERROR', 'AUTO', `Error for ${match.team1} vs ${match.team2}: ${e.message}`);
    return null;
  }
}

// ── Próximas Partidas Handler (OLD — mantido apenas para referência interna) ──

// ── Esports Prompt Builder ──
function buildEsportsPrompt(match, game, gamesContext, o, enrichSection, mlResult = null, newsSection = '') {
  const hasRealOdds = !!(o && o.t1 && parseFloat(o.t1) > 1);
  const t1 = match.team1 || match.participant1_name;
  const t2 = match.team2 || match.participant2_name;
  const serieScore = `${match.score1 || 0}-${match.score2 || 0}`;

  // Probabilidades do modelo (forma + H2H + mercado como prior bayesiano)
  // Quando factorCount=0 (sem dados), modelP1=impliedP1 (de-juice puro) — fair odds sempre calculadas
  const hasModelData = mlResult && (mlResult.factorCount > 0);
  const modelP1pct = mlResult ? (mlResult.modelP1 * 100).toFixed(1) : null;
  const modelP2pct = mlResult ? (mlResult.modelP2 * 100).toFixed(1) : null;
  const fairOddsLabel = hasModelData ? 'P modelo (forma+H2H+mercado)' : 'Fair odds (de-juice, sem dados de forma/H2H)';

  let oddsSection = '';
  if (hasRealOdds) {
    const raw1 = 1 / parseFloat(o.t1);
    const raw2 = 1 / parseFloat(o.t2);
    const overround = raw1 + raw2;
    const djP1 = (raw1 / overround * 100).toFixed(1);
    const djP2 = (raw2 / overround * 100).toFixed(1);
    const marginPct = ((overround - 1) * 100).toFixed(1);
    const bookName = o.bookmaker || '1xBet';
    const modelNote = hasModelData ? 'forma+H2H incorporados' : 'de-juice apenas, sem dados adicionais';
    oddsSection = `Odds ML (${bookName}): ${t1}=${o.t1} | ${t2}=${o.t2}\nMargem da casa: ${marginPct}% | P de-juiced (só margem): ${t1}=${djP1}% | ${t2}=${djP2}%\n${fairOddsLabel} (${modelNote}): ${t1}=${modelP1pct}% | ${t2}=${modelP2pct}%`;
  } else {
    oddsSection = `Odds ML: Não disponíveis`;
  }

  // Detect high-flux game state from gamesContext
  const gameTimeMatch = gamesContext.match(/(\d+)\s*(?:min|:)/);
  const gameMinute = gameTimeMatch ? parseInt(gameTimeMatch[1]) : null;
  const isEarlyGame = gameMinute !== null && gameMinute < 15;
  const hasRecentObjective = /baron|elder|roshan|aegis|soul/i.test(gamesContext);
  const highFlux = isEarlyGame || hasRecentObjective;

  const lineMovementWarning = enrichSection.includes('LINE MOVEMENT')
    ? `⚠️ LINE MOVEMENT DETECTADO: mercado se moveu. Trate isso como sinal contrário — o mercado provavelmente sabe algo. Ajuste sua estimativa de probabilidade 2-3pp na direção do movimento antes de calcular EV. Só mantenha sua estimativa original se tiver dados concretos que justifiquem a divergência.`
    : '';

  const highFluxWarning = highFlux
    ? `🚨 ATENÇÃO — ESTADO DE ALTO FLUXO: ${isEarlyGame ? `Jogo com apenas ${gameMinute}min (muito cedo para análise confiável).` : ''} ${hasRecentObjective ? 'Objetivo maior recente detectado — estado do jogo pode ter mudado completamente.' : ''} Com delay de ~90s, o que você está vendo já pode ser história. Confiança máxima neste contexto: BAIXA.`
    : '';

  const evBase      = parseFloat(process.env.LOL_EV_THRESHOLD ?? '5') || 5;
  const minEdgePp   = parseFloat(process.env.LOL_PINNACLE_MARGIN ?? '8') || 8;
  const noOddsConviction = parseInt(process.env.LOL_NO_ODDS_CONVICTION ?? '70');

  // ── Threshold adaptativo por quantidade de sinais disponíveis ──
  // Mais sinais = maior confiança na estimativa = threshold menor
  // Conta sinais pré-IA disponíveis no enrichment passado via match/enrichSection
  const sigCount = [
    hasRealOdds,                                          // odds disponíveis
    enrichSection.includes('FORMA RECENTE'),              // forma t1
    enrichSection.includes('W-') && enrichSection.split('W-').length > 2, // forma t2
    enrichSection.includes('H2H:'),                      // histórico direto
    enrichSection.includes('LINE MOVEMENT'),              // movimento de linha
    gamesContext.includes('AO VIVO'),                    // dados ao vivo
  ].filter(Boolean).length;
  // 6 sinais → 2% | 5 → 3% | 4 → 4% | 3 → 5% | 2 → 6% | ≤1 → 6%
  const evThreshold = Math.max(2, Math.min(6, evBase + (3 - sigCount)));

  const evThresholdMedia = Math.max(1, evThreshold - 1.5);
  const evThresholdBaixa = Math.max(0.5, evThreshold - 3);

  let bookMarginNote = '';
  let deJuiced = '';
  if (hasRealOdds) {
    const r1 = 1 / parseFloat(o.t1), r2 = 1 / parseFloat(o.t2);
    const or = r1 + r2;
    const marginReal = ((or - 1) * 100).toFixed(1);
    const dj1 = (r1 / or * 100).toFixed(1);
    const dj2 = (r2 / or * 100).toFixed(1);
    if (hasModelData) {
      // Referência principal = probabilidade do modelo (forma + H2H)
      // EV calculado contra a odd de mercado, mas a "fair" de referência é o modelo
      bookMarginNote = `AVISO: 1xBet tem margem de ${marginReal}%. O MODELO DO SISTEMA estima ${t1}=${modelP1pct}% | ${t2}=${modelP2pct}% (incorpora forma recente + H2H + odds como prior bayesiano). Esta é a referência de fair odd — NÃO o de-juice simples. EV = (sua_prob/100 × odd) − 1.`;
      deJuiced = `${fairOddsLabel}: ${t1}=${modelP1pct}% | ${t2}=${modelP2pct}% [De-juice bookie: ${t1}=${dj1}% | ${t2}=${dj2}%]\n   Sua P estimada deve superar a P do modelo em ≥${minEdgePp}pp E EV ≥ +${evThreshold}%.\n   Se EV negativo nos dois lados → SEM EDGE.`;
    } else {
      // Sem dados de forma/H2H — fair odds calculadas via de-juice (mínimo sempre disponível)
      bookMarginNote = `AVISO: 1xBet tem margem de ${marginReal}%. Fair odds (de-juice): ${t1}=${modelP1pct}% | ${t2}=${modelP2pct}%. Use como referência mínima — para lucro real sua probabilidade deve superar isso em ≥${minEdgePp}pp. Sem dados de forma/H2H para ajustar o prior.`;
      deJuiced = `${fairOddsLabel}: ${t1}=${modelP1pct}% | ${t2}=${modelP2pct}% (calculado via de-juice, sem dados adicionais)\n   P estimada deve superar fair odds em ≥${minEdgePp}pp E EV ≥ +${evThreshold}%.\n   Se EV negativo nos dois lados → SEM EDGE.`;
    }
  } else {
    deJuiced = `Sem odds disponíveis. Tip só se vantagem clara (>${noOddsConviction}%) com pelo menos 2 sinais independentes confirmando.`;
  }
  const tipInstruction = hasRealOdds
    ? `[DECISÃO OBRIGATÓRIA — avalie em ordem:
1. Se EV(qualquer lado) ≥ +${evThreshold}% E ≥2 sinais checklist → TIP_ML:[time]@[odd]|EV:[%]|STAKE:[u]|CONF:ALTA
2. Se EV(qualquer lado) ≥ +${evThresholdMedia}% E ≥1 sinal checklist → TIP_ML:[time]@[odd]|EV:[%]|STAKE:[u]|CONF:MÉDIA
3. Se EV(qualquer lado) ≥ +${evThresholdBaixa}% (sem sinal obrigatório) → TIP_ML:[time]@[odd]|EV:[%]|STAKE:[u]|CONF:BAIXA
4. Se EV negativo nos dois lados → não gere TIP_ML]`
    : `[NÃO gere tip sem odds reais disponíveis]`;

  const text = `Você é um analista de apostas LoL especializado. Siga o processo de decisão abaixo com rigor — omita TIP_ML SOMENTE se todos os EVs forem negativos ou se você não tiver base para estimar probabilidades.

PARTIDA: ${t1} vs ${t2} | ${match.league || 'Esports'} | ${match.format || 'Bo1/Bo3'} | ${match.status}
Placar: ${serieScore} | ${oddsSection}
${bookMarginNote ? `\n⚠️ ${bookMarginNote}` : ''}
${gamesContext ? `\nDADOS AO VIVO:\n${gamesContext}` : ''}
FORMA/H2H:${enrichSection}
${highFluxWarning ? `\n${highFluxWarning}` : ''}${lineMovementWarning ? `\n${lineMovementWarning}` : ''}${newsSection ? `\n${newsSection}` : ''}

REGRAS OBRIGATÓRIAS (não negociáveis):
• ALTA (EV ≥ +${evThreshold}%): exige ≥2 sinais independentes do checklist confirmando
• MÉDIA (EV ≥ +${evThresholdMedia}%): exige ≥1 sinal do checklist confirmando
• BAIXA (EV ≥ +${evThresholdBaixa}%): sem sinal obrigatório — stake reduzido (1/10 Kelly, max 1.5u)
• Se EV negativo nos dois lados → sem tip.
• Dados ausentes = use o que está disponível; ausência não bloqueia análise.

ANÁLISE (responda cada ponto):
1. Draft/Composição: qual time tem melhor comp? Early/late game? Counter-pick decisivo?
   → P(${t1})=__% | P(${t2})=__% | Justificativa: [1 frase objetiva]${modelP1pct ? `\n   [${fairOddsLabel}: ${t1}=${modelP1pct}% | ${t2}=${modelP2pct}% — para ter edge, sua P deve divergir claramente deste baseline]` : ''}
2. Edge quantitativo: ${deJuiced}
3. Sinais do checklist:
   [ ] Forma recente clara (≥60% winrate, diferença >15pp)
   [ ] H2H favorável (≥60% de vitórias no confronto direto)
   [ ] Draft/composição claramente superior
   [ ] Dados ao vivo confirmam (gold diff, objetivos)
   [ ] Odds com movimento favorável (sharp money)
${hasRealOdds ? '' : '   Virada possível se: gold diff <3k, scaling comp no perdedor, soul point ou baron pendente.\n'}
RESPOSTA (máximo 200 palavras):
P(${t1})=__% | P(${t2})=__% | ${hasRealOdds ? `EV(${t1})=[X%] | EV(${t2})=[X%]` : `Conf:[ALTA/MÉDIA/BAIXA]`} | Sinais:[N/6] | Confiança:[ALTA/MÉDIA/BAIXA]
${tipInstruction}`;

  return { text, evThreshold, sigCount };
}

// ── Admin ──
async function handleAdmin(token, chatId, command) {
  if (!ADMIN_IDS.has(String(chatId))) {
    await send(token, chatId, '❌ Comando restrito a administradores.');
    return;
  }
  
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0];
  const sport = parts[1] || 'esports';
  
  if (cmd === '/stats' || cmd === '/roi') {
    try {
      const [roi, history] = await Promise.all([
        serverGet('/roi', sport),
        serverGet('/tips-history?limit=10&filter=settled', sport).catch(() => [])
      ]);
      const o = roi.overall || {};
      const bk = roi.banca || {};
      const wins = o.wins || 0, losses = o.losses || 0, total = o.total || 0;
      const pending = total - wins - losses;
      const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
      const roiVal = parseFloat(o.roi || 0);
      let txt = `📊 *ESTATÍSTICAS ${sport.toUpperCase()}*\n\n`;
      // Banca
      if (bk.currentBanca !== undefined) {
        const profitR = bk.profitReais || 0;
        const growthPct = bk.growthPct || 0;
        txt += `💰 *Banca: R$${bk.currentBanca.toFixed(2)}*`;
        txt += ` (inicial: R$${(bk.initialBanca || 100).toFixed(2)})\n`;
        txt += `${profitR >= 0 ? '📈' : '📉'} Resultado: *${profitR >= 0 ? '+' : ''}R$${profitR.toFixed(2)}* (${growthPct >= 0 ? '+' : ''}${growthPct}%)\n`;
        txt += `🎲 Valor da unidade: *R$${(bk.unitValue || 1).toFixed(2)}*\n\n`;
      }
      txt += `Total de tips: *${total}*\n`;
      txt += `✅ Ganhas: *${wins}* | ❌ Perdidas: *${losses}*`;
      if (pending > 0) txt += ` | ⏳ Pendentes: *${pending}*`;
      txt += `\n📌 Win Rate: *${wr}%*\n`;
      txt += `${roiVal >= 0 ? '📈' : '📉'} ROI: *${roiVal >= 0 ? '+' : ''}${roiVal}%*\n`;
      txt += `💵 Profit: *${parseFloat(o.totalProfit || 0) >= 0 ? '+' : ''}${o.totalProfit || 0}u*\n`;
      txt += `📦 Volume: *${o.totalStaked || 0}u* | EV médio: *${o.avg_ev || 0}%*\n`;
      // CLV — única métrica que indica edge real independente de variance
      if (roi.clv) {
        const clv = roi.clv;
        const clvSign = clv.avg >= 0 ? '+' : '';
        const clvEmoji = clv.avg > 1.5 ? '🟢' : clv.avg > 0 ? '🟡' : '🔴';
        txt += `\n${clvEmoji} *CLV médio: ${clvSign}${clv.avg}%* _(${clv.count} tips)_\n`;
        txt += `📐 CLV positivo: *${clv.positiveRate}%* das tips\n`;
        if (clv.byPhase?.live?.count) {
          const lv = clv.byPhase.live;
          txt += `  ↳ Ao vivo: ${lv.avg >= 0 ? '+' : ''}${lv.avg}% (${lv.count} tips)\n`;
        }
        if (clv.byPhase?.preGame?.count) {
          const pg = clv.byPhase.preGame;
          txt += `  ↳ Pré-jogo: ${pg.avg >= 0 ? '+' : ''}${pg.avg}% (${pg.count} tips)\n`;
        }
        if (clv.avg < 0) txt += `  ⚠️ _CLV negativo: modelo pode não ter edge real_\n`;
      } else {
        txt += `\n📐 *CLV:* _aguardando tips com closing line registrada_\n`;
      }
      if (roi.calibration?.length) {
        txt += '\n🎯 *Calibração por confiança:*\n';
        const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' };
        roi.calibration.forEach(c => {
          txt += `${confEmoji[c.confidence] || '⚪'} ${c.confidence}: ${c.wins}/${c.total} (${c.win_rate}%)\n`;
        });
      }
      if (Array.isArray(history) && history.length > 0) {
        txt += `\n📋 *Últimas tips resolvidas:*\n`;
        history.slice(0, 8).forEach(t => {
          const res = t.result === 'win' ? '✅' : '❌';
          const date = (t.sent_at || '').slice(0, 10);
          const pr = t.profit_reais != null ? ` (${t.profit_reais >= 0 ? '+' : ''}R$${parseFloat(t.profit_reais).toFixed(2)})` : '';
          txt += `${res} ${t.tip_participant || '?'} @ ${t.odds}${pr} _(${date})_\n`;
        });
      }
      await send(token, chatId, txt);
    } catch(e) {
      await send(token, chatId, `❌ ${e.message}`);
    }
  } else if (cmd === '/users') {
    try {
      const s = await serverGet('/db-status', sport);
      await send(token, chatId,
        `👥 *STATUS*\n\n` +
        `Usuários: *${s.users}*\n` +
        `Inscritos: *${subscribedUsers.size}*\n` +
        `Athletes: *${s.athletes}*\n` +
        `Eventos: *${s.events}*\n` +
        `Matches: *${s.matches}*\n` +
        `Tips: *${s.tips}*\n` +
        `Pendentes: *${s.unsettled}*`
      );
    } catch(e) {
      await send(token, chatId, `❌ ${e.message}`);
    }
  } else if (cmd === '/resync') {
    await send(token, chatId, '⏳ Iniciando re-sync de stats (forma/H2H dos últimos 45 dias)...');
    try {
      const r = await serverPost('/resync-stats', { force: true }, sport);
      await send(token, chatId,
        `✅ *Re-sync concluído*\n` +
        `📊 Partidas: *${r.matchCount}*\n` +
        `🎮 Champs: *${r.champEntries}*\n` +
        `👤 Player+champ: *${r.playerEntries}*\n` +
        `⏭️ Pulados: *${r.skipped}*\n\n` +
        `_Form e H2H agora disponíveis para análise._`
      );
    } catch(e) { await send(token, chatId, `❌ ${e.message}`); }

  } else if (cmd === '/settle') {
    lastSettlementCheck = 0;
    await settleCompletedTips();
    await send(token, chatId, '✅ Settlement executado.');
  } else if (cmd === '/pending') {
    try {
      const unsettled = await serverGet('/unsettled-tips', sport);
      if (!Array.isArray(unsettled) || !unsettled.length) { await send(token, chatId, '✅ Nenhuma tip pendente.'); return; }
      let txt = `⏳ *TIPS PENDENTES (${unsettled.length})*\n\n`;
      unsettled.slice(0, 10).forEach(t => {
        txt += `ID: \`${String(t.match_id || t.fight_id || '').slice(0, 20)}\`\n`;
        txt += `${t.participant1 || t.fighter1 || t.team1} vs ${t.participant2 || t.fighter2 || t.team2}\n`;
        txt += `🎯 ${t.tip_participant || t.tip_fighter || t.tip_team} @ ${t.odds} | EV: ${t.ev}\n`;
        txt += `📅 ${String(t.sent_at || '').slice(0, 10)}\n\n`;
      });
      await send(token, chatId, txt);
    } catch(e) { await send(token, chatId, `❌ ${e.message}`); }
  } else if (cmd === '/refresh-open') {
    if (!ADMIN_IDS.has(String(chatId))) { await send(token, chatId, '❌ Admin only.'); return; }
    try {
      await send(token, chatId, '🔄 Reanalisando tips pendentes (odds/EV)...');
      await refreshOpenTips();
      await send(token, chatId, '✅ Updates enviados. Dashboard refletirá `current_odds/current_ev`.');
    } catch(e) { await send(token, chatId, `❌ ${e.message}`); }
  } else if (cmd === '/slugs') {
    // Mostra ligas LoL cobertas e slugs desconhecidos vistos no schedule
    try {
      const data = await serverGet('/lol-slugs');
      let txt = `🎮 *Slugs LoL Esports*\n\n`;
      if (data.unknown_seen?.length) {
        txt += `⚠️ *Slugs IGNORADOS (não cobertos):*\n`;
        data.unknown_seen.forEach(s => txt += `\`${s}\`\n`);
        txt += `\n💡 Adicione ao .env:\n\`LOL_EXTRA_LEAGUES=${data.unknown_seen.join(',')}\`\n`;
      } else {
        txt += `✅ Nenhum slug desconhecido detectado ainda.\n_(reinicie e aguarde o schedule ser buscado)_\n`;
      }
      txt += `\n📋 *Cobertos:* ${data.allowed?.length || 0} ligas`;
      await send(token, chatId, txt);
    } catch(e) { await send(token, chatId, `❌ ${e.message}`); }
  } else if (cmd === '/lolraw') {
    // Debug: mostra TODAS as ligas retornadas pela API sem nenhum filtro
    await send(token, chatId, '⏳ Buscando schedule bruto da API...');
    try {
      const data = await serverGet('/lol-raw');
      let txt = `🔍 *Schedule bruto — ${data.total_events} eventos*\n\n`;
      const entries = Object.entries(data.by_league || {})
        .sort((a, b) => b[1].count - a[1].count);
      for (const [slug, info] of entries) {
        const cover = info.inWhitelist ? '✅' : '❌';
        const states = Object.entries(info.states).map(([s, c]) => `${s}:${c}`).join(' ');
        txt += `${cover} \`${slug}\`\n`;
        txt += `   _${info.name}_ | ${states}\n`;
        if (info.sample) txt += `   ↳ ${info.sample}\n`;
        txt += '\n';
        if (txt.length > 3500) { txt += '_(lista truncada)_'; break; }
      }
      await send(token, chatId, txt);
    } catch(e) { await send(token, chatId, `❌ ${e.message}`); }
  } else if (cmd === '/reanalise') {
    if (!ADMIN_IDS.has(String(chatId))) { await send(token, chatId, '❌ Admin only.'); return; }
    const cleared = {};
    if (sport === 'esports' || sport === 'all') { analyzedMatches.clear(); cleared.esports = true; }
    if (sport === 'mma'     || sport === 'all') { analyzedMma.clear();     cleared.mma = true; }
    if (sport === 'tennis'  || sport === 'all') { analyzedTennis.clear();  cleared.tennis = true; }
    if (sport === 'football'|| sport === 'all') { analyzedFootball.clear(); cleared.football = true; }
    const clearedList = Object.keys(cleared).join(', ') || sport;
    await send(token, chatId,
      `🔄 *Reanálise ativada*\n\nMemória de análises limpa para: *${clearedList}*\n` +
      `As tips em andamento serão reavaliadas no próximo ciclo de análise automática.`
    );

  } else if (cmd === '/reset-tips') {
    if (!ADMIN_IDS.has(String(chatId))) { await send(token, chatId, '❌ Admin only.'); return; }
    try {
      const r = await serverPost('/reset-tips', {}, sport);
      analyzedMatches.clear();
      await send(token, chatId, `✅ *Tips resetadas*\n${r.deleted} registros removidos.\nBanca restaurada ao valor inicial.\nMemória de análises limpa.`);
    } catch(e) { await send(token, chatId, `❌ ${e.message}`); }

  } else if (cmd === '/health') {
    if (!ADMIN_IDS.has(String(chatId))) { await send(token, chatId, '❌ Admin only.'); return; }
    try {
      const h = await serverGet('/health').catch(e => ({ error: e.message }));
      const icon = h.status === 'ok' ? '✅' : '⚠️';
      let msg = `${icon} *Health — LoL Bot*\n\n`;
      msg += `Status: \`${h.status || 'erro'}\`\n`;
      msg += `DB: \`${h.db || 'desconhecido'}\`\n`;
      msg += `Última análise: ${h.lastAnalysis ? new Date(h.lastAnalysis).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'nunca'}\n`;
      msg += `Tips pendentes: ${h.pendingTips ?? '?'}\n`;
      msg += `OddsPapi: ${h.oddsApiUsage?.used ?? '?'}/${h.oddsApiUsage?.limit ?? 230} req\n`;
      if (h.error) msg += `\n❌ Erro: ${h.error}`;
      await send(token, chatId, msg);
    } catch(e) { await send(token, chatId, `❌ ${e.message}`); }

  } else if (cmd === '/debug') {
    if (!ADMIN_IDS.has(String(chatId))) { await send(token, chatId, '❌ Admin only.'); return; }
    try {
      const month = new Date().toISOString().slice(0, 7);
      const [lolMatches, dbStatus, unsettled] = await Promise.all([
        serverGet('/lol-matches').catch(() => []),
        serverGet('/db-status?sport=esports').catch(() => null),
        serverGet('/unsettled-tips', 'esports').catch(() => [])
      ]);
      const oddsUsageRow = stmts.getApiUsage.get('esports', month);
      const oddsUsed = oddsUsageRow?.count || 0;
      const live = Array.isArray(lolMatches) ? lolMatches.filter(m => m.status === 'live').length : 0;
      const upcoming = Array.isArray(lolMatches) ? lolMatches.filter(m => m.status === 'upcoming').length : 0;
      let msg = `🔍 *DEBUG — LoL Bot*\n\n`;
      msg += `🔴 *Ao vivo:* ${live} | 📅 *Próximas:* ${upcoming}\n`;
      msg += `📊 *Tips pendentes:* ${Array.isArray(unsettled) ? unsettled.length : '?'}\n`;
      msg += `🔑 *OddsPapi mês:* ${oddsUsed}/230 req\n`;
      if (dbStatus) {
        msg += `💾 *DB:* ${dbStatus.tips || 0} tips | ${dbStatus.matches || 0} matches\n`;
      }
      await send(token, chatId, msg);
    } catch(e) {
      await send(token, chatId, `❌ Erro no debug: ${e.message}`);
    }
  } else {
    await send(token, chatId,
      `📋 *Comandos Admin*\n\n` +
      `/health — status do bot e DB\n` +
      `/debug — partidas, tips pendentes, uso de API\n` +
      `/stats esports — ROI e calibração\n` +
      `/users — status do bot\n` +
      `/pending — tips pendentes\n` +
      `/settle — force settlement\n` +
      `/slugs — ligas LoL cobertas e slugs ignorados\n` +
      `/lolraw — dump bruto da API LoL (diagnóstico)\n`
    );
  }
}

async function handleNotificacoes(token, chatId, sport, action) {
  const config = SPORTS[sport];
  const userPrefs = subscribedUsers.get(chatId) || new Set();
  
  if (action === 'on') {
    userPrefs.add(sport);
    subscribedUsers.set(chatId, userPrefs);
    
    await serverPost('/save-user', {
      userId: chatId,
      subscribed: true,
      sportPrefs: [...userPrefs]
    });
    
    await send(token, chatId,
      `✅ Notificações ${config.name} ativadas!\n\n` +
      `Você receberá:\n` +
      `• ${config.icon} Tips automáticas com +EV\n` +
      `• 📉 Alertas de line movement > 10%\n\n` +
      `Use /notificacoes off para desativar`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '🔕 Desativar', callback_data: `notif_${sport}_off` }]]
        }
      }
    );
  } else if (action === 'off') {
    userPrefs.delete(sport);
    subscribedUsers.set(chatId, userPrefs);
    
    await serverPost('/save-user', {
      userId: chatId,
      subscribed: userPrefs.size > 0,
      sportPrefs: [...userPrefs]
    });
    
    await send(token, chatId,
      `🔕 Notificações ${config.name} desativadas.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '🔔 Ativar', callback_data: `notif_${sport}_on` }]]
        }
      }
    );
  } else {
    const isActive = userPrefs.has(sport);
    await send(token, chatId,
      `🔔 *Notificações ${config.name}*\n\n` +
      `Status: ${isActive ? '✅ Ativado' : '❌ Desativado'}\n\n` +
      `Comandos:\n` +
      `/notificacoes on — Ativar\n` +
      `/notificacoes off — Desativar`
    );
  }
}

async function handleProximas(token, chatId, sport) {
  try {
    await send(token, chatId, '⏳ _Buscando partidas..._');

    if (sport === 'mma') {
      const fights = await serverGet('/mma-matches').catch(() => []);
      const all = Array.isArray(fights) ? fights : [];

      if (!all.length) {
        await send(token, chatId,
          '❌ Nenhuma luta MMA encontrada no momento.\n' +
          '_Tente novamente mais tarde._',
          getMenu(sport)
        );
        return;
      }

      let txt = `🥊 *PRÓXIMAS LUTAS MMA*\n━━━━━━━━━━━━━━━━\n\n`;
      txt += `📅 *PRÓXIMAS (${all.length})*\n`;
      all.slice(0, 12).forEach(m => {
        const league = m.league ? `[${m.league}]` : '';
        txt += `🥊 ${league} *${m.team1}* vs *${m.team2}*\n`;
        if (m.time) {
          try {
            const dt = new Date(m.time).toLocaleString('pt-BR', {
              timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit',
              hour: '2-digit', minute: '2-digit'
            });
            txt += `  🕐 ${dt}\n`;
          } catch(_) {}
        }
        if (m.odds) txt += `  💰 ${m.team1}: \`${m.odds.t1}\` | ${m.team2}: \`${m.odds.t2}\`\n`;
        else txt += `  _Sem odds ainda_\n`;
      });

      await send(token, chatId, txt, getMenu(sport));
      return;
    }

    if (sport === 'tennis') {
      const matches = await serverGet('/tennis-matches').catch(() => []);
      const all = Array.isArray(matches) ? matches : [];

      if (!all.length) {
        await send(token, chatId,
          '❌ Nenhuma partida de tênis encontrada.\n_Tente novamente mais tarde._',
          getMenu(sport)
        );
        return;
      }

      let txt = `🎾 *PRÓXIMAS PARTIDAS TÊNIS*\n━━━━━━━━━━━━━━━━\n\n`;
      let lastLeague = '';
      all.slice(0, 15).forEach(m => {
        if (m.league !== lastLeague) {
          txt += `\n📋 *${m.league}*\n`;
          lastLeague = m.league;
        }
        txt += `🎾 *${m.team1}* vs *${m.team2}*\n`;
        if (m.time) {
          try {
            const dt = new Date(m.time).toLocaleString('pt-BR', {
              timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit',
              hour: '2-digit', minute: '2-digit'
            });
            txt += `  🕐 ${dt}\n`;
          } catch(_) {}
        }
        if (m.odds) txt += `  💰 ${m.team1}: \`${m.odds.t1}\` | ${m.team2}: \`${m.odds.t2}\`\n`;
      });

      await send(token, chatId, txt, getMenu(sport));
      return;
    }

    if (sport === 'football') {
      const matches = await serverGet('/football-matches').catch(() => []);
      const all = Array.isArray(matches) ? matches : [];

      if (!all.length) {
        await send(token, chatId,
          '❌ Nenhuma partida de futebol encontrada.\n_Tente novamente mais tarde._',
          getMenu(sport)
        );
        return;
      }

      let txt = `⚽ *PRÓXIMAS PARTIDAS FUTEBOL*\n━━━━━━━━━━━━━━━━\n\n`;
      let lastLeague = '';
      all.slice(0, 15).forEach(m => {
        if (m.league !== lastLeague) {
          txt += `\n📋 *${m.league}*\n`;
          lastLeague = m.league;
        }
        txt += `⚽ *${m.team1}* vs *${m.team2}*\n`;
        if (m.time) {
          try {
            const dt = new Date(m.time).toLocaleString('pt-BR', {
              timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit',
              hour: '2-digit', minute: '2-digit'
            });
            txt += `  🕐 ${dt}\n`;
          } catch(_) {}
        }
        if (m.odds) {
          txt += `  💰 Casa: \`${m.odds.h}\` | Empate: \`${m.odds.d}\` | Fora: \`${m.odds.a}\`\n`;
          if (m.odds.ou25) txt += `  📊 O2.5: \`${m.odds.ou25.over}\` | U2.5: \`${m.odds.ou25.under}\`\n`;
        }
      });

      await send(token, chatId, txt, getMenu(sport));
      return;
    }

    const lolMatches = await serverGet('/lol-matches').catch(() => []);
    const all = Array.isArray(lolMatches) ? lolMatches : [];

    if (!all.length) {
      await send(token, chatId,
        '❌ Nenhuma partida encontrada no momento.\n' +
        '_A API da Riot só retorna partidas da semana atual. Tente novamente mais tarde._'
      );
      return;
    }

    // Separar live e upcoming
    const live = all.filter(m => m.status === 'live' || m.status === 'draft');
    const upcoming = all.filter(m => m.status === 'upcoming');

    let txt = `🎮 *PARTIDAS LoL*\n━━━━━━━━━━━━━━━━\n\n`;

    if (live.length) {
      txt += `🔴 *AO VIVO / EM DRAFT (${live.length})*\n`;
      live.slice(0, 5).forEach(m => {
        const league = m.league ? `[${m.league}]` : '';
        txt += `🎮 ${league} *${m.team1}* vs *${m.team2}*`;
        if (m.score1 !== undefined || m.score2 !== undefined) {
          txt += ` (${m.score1 ?? 0}-${m.score2 ?? 0})`;
        }
        if (m.format) txt += ` _${m.format}_`;
        txt += '\n';
        if (m.odds) txt += `  💰 ${m.team1}: \`${m.odds.t1}\` | ${m.team2}: \`${m.odds.t2}\`\n`;
      });
      txt += '\n';
    }

    if (upcoming.length) {
      txt += `📅 *PRÓXIMAS (${upcoming.length})*\n`;
      upcoming.slice(0, 10).forEach(m => {
        const league = m.league ? `[${m.league}]` : '';
        txt += `🎮 ${league} *${m.team1}* vs *${m.team2}*`;
        if (m.format) txt += ` _${m.format}_`;
        txt += '\n';
        if (m.time) {
          try {
            const dt = new Date(m.time).toLocaleString('pt-BR', {
              timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit',
              hour: '2-digit', minute: '2-digit'
            });
            txt += `  🕐 ${dt}\n`;
          } catch(_) {}
        }
        if (m.odds) txt += `  💰 ${m.team1}: \`${m.odds.t1}\` | ${m.team2}: \`${m.odds.t2}\`\n`;
        else txt += `  _Sem odds ainda_\n`;
      });
    }

    if (!live.length && !upcoming.length) {
      txt += '_Nenhuma partida disponível no momento._';
    }

    await send(token, chatId, txt, getMenu(sport));
  } catch (e) {
    await send(token, chatId, `❌ Erro ao buscar partidas: ${e.message}`);
  }
}

// ── Helpers ESPN → formato enrich do modelo ML ──

// Converte record "W-L-D" do ESPN em objeto enrich compatível com esportsPreFilter
function mmaRecordToEnrich(record1, record2) {
  function parse(rec) {
    const parts = (rec || '0-0').split('-').map(n => parseInt(n) || 0);
    const wins = parts[0] || 0, losses = parts[1] || 0, draws = parts[2] || 0;
    const total = wins + losses + draws;
    return { wins, losses, winRate: total > 0 ? Math.round(wins / total * 100) : 50 };
  }
  return {
    form1: parse(record1),
    form2: parse(record2),
    h2h: { t1Wins: 0, t2Wins: 0, totalMatches: 0 },
    oddsMovement: null
  };
}

// Converte rankings ATP/WTA em enrich compatível com esportsPreFilter
// Usa modelo Elo-like (log-ranking): rank #1 vs #100 → ~73% favorito
function rankingToEnrich(rankStr1, rankStr2) {
  function parseRank(str) {
    if (!str) return null;
    const m = (str || '').match(/^#(\d+)/);
    return m ? parseInt(m[1]) : null;
  }
  const r1 = parseRank(rankStr1), r2 = parseRank(rankStr2);
  if (r1 === null && r2 === null) return null;

  const base1 = r1 || 500, base2 = r2 || 500;
  // P(1 ganha) = 1 / (1 + sqrt(rank1/rank2)) — favorece rank menor (melhor jogador)
  const wr1 = Math.round(100 / (1 + Math.sqrt(base1 / base2)));
  const wr2 = 100 - wr1;
  // wins/losses sintéticos — apenas para o esportsPreFilter usar o winRate
  return {
    form1: { wins: wr1, losses: wr2, winRate: wr1 },
    form2: { wins: wr2, losses: wr1, winRate: wr2 },
    h2h: { t1Wins: 0, t2Wins: 0, totalMatches: 0 },
    oddsMovement: null
  };
}

async function handleFairOdds(token, chatId, sport) {
  try {
    await send(token, chatId, '⏳ _Calculando fair odds do modelo..._');

    const endpoint = sport === 'mma' ? '/mma-matches' : sport === 'tennis' ? '/tennis-matches' : sport === 'football' ? '/football-matches' : '/lol-matches';
    const matches = await serverGet(endpoint).catch(() => []);
    const all = Array.isArray(matches) ? matches : [];

    const withOdds = sport === 'football' || sport === 'mma' || sport === 'tennis'
      ? all.filter(m => m.odds)
      : all.filter(m => m.odds?.t1 && m.odds?.t2); // LoL: todas com odds (live, draft e upcoming)

    if (!withOdds.length) {
      const noOddsMsg = sport === 'mma'
        ? '❌ *Nenhuma luta MMA com odds disponíveis.*\n\n_Tente novamente mais tarde._'
        : sport === 'tennis'
        ? '❌ *Nenhuma partida de tênis com odds disponíveis.*\n\n_Tente novamente mais tarde._'
        : sport === 'football'
        ? '❌ *Nenhuma partida de futebol com odds disponíveis.*\n\n_Tente novamente mais tarde._'
        : '❌ *Nenhuma partida ao vivo com odds disponíveis.*\n\n_Odds reais são necessárias para calcular fair odds._';
      await send(token, chatId, noOddsMsg, getMenu(sport));
      return;
    }

    const title = sport === 'mma' ? '⚖️ *FAIR ODDS — MMA*' : sport === 'tennis' ? '⚖️ *FAIR ODDS — TÊNIS*' : sport === 'football' ? '⚖️ *FAIR ODDS — FUTEBOL*' : '⚖️ *FAIR ODDS — AO VIVO*';
    let txt = `${title}\n━━━━━━━━━━━━━━━━\n`;
    txt += `_Fair odd = estimativa do modelo (forma + H2H + mercado como prior)_\n\n`;

    const slice = withOdds.slice(0, 10);

    if (sport === 'football') {
      const { calcFootballScore } = require('./lib/football-ml');

      for (const m of slice) {
        const oH = parseFloat(m.odds?.h), oD = parseFloat(m.odds?.d), oA = parseFloat(m.odds?.a);
        if (!oH || !oD || !oA || oH <= 1 || oD <= 1 || oA <= 1) continue;

        const rawH = 1/oH, rawD = 1/oD, rawA = 1/oA;
        const totalVig = rawH + rawD + rawA;
        const margin = ((totalVig - 1) * 100).toFixed(1);
        const mktH = (rawH/totalVig*100).toFixed(1);
        const mktA = (rawA/totalVig*100).toFixed(1);

        const homeFormData = null, awayFormData = null, h2hData = { results: [] };
        const enrichTag = ' _(home adv. aplicado)_';

        const mlScore = calcFootballScore(
          { form: homeFormData?.form || null, homeForm: homeFormData?.homeForm || null, goalsFor: homeFormData?.goalsFor ?? null, goalsAgainst: homeFormData?.goalsAgainst ?? null, position: null, fatigue: 7 },
          { form: awayFormData?.form || null, awayForm: awayFormData?.awayForm || null, goalsFor: awayFormData?.goalsFor ?? null, goalsAgainst: awayFormData?.goalsAgainst ?? null, position: null, fatigue: 7 },
          h2hData,
          { h: oH, d: oD, a: oA, ou25: m.odds?.ou25 ? { over: parseFloat(m.odds.ou25.over), under: parseFloat(m.odds.ou25.under) } : null },
          {}
        );
        if (!mlScore || mlScore.reason === 'sem_odds_validas') continue;

        const mH = mlScore.modelH, mD = mlScore.modelD, mA = mlScore.modelA;
        const edgeH = (mH - parseFloat(mktH)).toFixed(1);
        const edgeA = (mA - parseFloat(mktA)).toFixed(1);

        const league = m.league ? `[${m.league}] ` : '';
        let dtStr = '';
        if (m.time) {
          try { dtStr = ` _(${new Date(m.time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })})_`; } catch(_) {}
        }
        txt += `⚽ ${league}*${m.team1}* vs *${m.team2}*${dtStr}\n`;
        txt += `  🏷️ Bookie: \`${oH}\`/\`${oD}\`/\`${oA}\` _(margem: ${margin}%)_\n`;
        txt += `  🤖 Modelo${enrichTag}: \`${(100/mH).toFixed(2)}\`/\`${(100/mD).toFixed(2)}\`/\`${(100/mA).toFixed(2)}\`\n`;
        txt += `  📊 P: *${mH}%* / *${mD}%* / *${mA}%* | Edge Casa: ${parseFloat(edgeH)>=0?'+':''}${edgeH}pp | Fora: ${parseFloat(edgeA)>=0?'+':''}${edgeA}pp\n\n`;
      }

    } else {
      // LoL, MMA, Tennis — obtém enrich de cada esporte
      let espnFightsForFair = [];
      let espnRankingsForFair = { atp: [], wta: [] };
      if (sport === 'mma') {
        espnFightsForFair = await fetchEspnMmaFights().catch(() => []);
      } else if (sport === 'tennis') {
        espnRankingsForFair = await fetchEspnTennisRankings().catch(() => ({ atp: [], wta: [] }));
      }

      // LoL: usa DB local. MMA/Tennis: ESPN. Roda em paralelo para LoL, serial para outros.
      const enrichments = sport === 'lol'
        ? await Promise.all(slice.map(m => fetchEnrichment(m).catch(() => ({ form1: null, form2: null, h2h: null, oddsMovement: null }))))
        : await Promise.all(slice.map(async m => {
            if (sport === 'mma') {
              const espn = findEspnFight(espnFightsForFair, m.team1, m.team2);
              let rec1 = espn ? (normName(espn.name1).includes(normName(m.team1)) ? espn.record1 : espn.record2) : '';
              let rec2 = espn ? (normName(espn.name1).includes(normName(m.team1)) ? espn.record2 : espn.record1) : '';
              if (!espn) {
                const [r1, r2] = await Promise.all([
                  fetchEspnFighterRecord(m.team1).catch(() => null),
                  fetchEspnFighterRecord(m.team2).catch(() => null)
                ]);
                if (r1) rec1 = r1;
                if (r2) rec2 = r2;
              }
              if (rec1 || rec2) return mmaRecordToEnrich(rec1, rec2);
              return { form1: null, form2: null, h2h: null, oddsMovement: null };
            } else if (sport === 'tennis') {
              const tour = (m.sport_key || '').includes('_wta_') ? 'WTA' : 'ATP';
              const rankList = tour === 'WTA' ? espnRankingsForFair.wta : espnRankingsForFair.atp;
              const rank1 = getTennisPlayerRank(rankList, m.team1);
              const rank2 = getTennisPlayerRank(rankList, m.team2);
              return rankingToEnrich(rank1, rank2) || { form1: null, form2: null, h2h: null, oddsMovement: null };
            }
            return { form1: null, form2: null, h2h: null, oddsMovement: null };
          }));

      for (let i = 0; i < slice.length; i++) {
        const m = slice[i];
        const enrich = enrichments[i];

        const o1 = parseFloat(m.odds.t1);
        const o2 = parseFloat(m.odds.t2);
        if (!o1 || !o2 || o1 <= 1 || o2 <= 1) continue;

        const raw1 = 1/o1, raw2 = 1/o2;
        const totalVig = raw1 + raw2;
        const margin = ((totalVig - 1) * 100).toFixed(1);

        const mlResult = esportsPreFilter(m, m.odds, enrich, false, '', null);
        const { modelP1, modelP2, factorCount } = mlResult;

        const fairO1 = (1 / modelP1).toFixed(2);
        const fairO2 = (1 / modelP2).toFixed(2);

        const hasEnrichData = factorCount > 0;
        const enrichSource = sport === 'mma' ? 'ESPN record' : sport === 'tennis' ? 'ESPN ranking' : 'forma+H2H';
        const enrichTag = hasEnrichData ? ` _(${enrichSource})_` : ` _(sem dados — apenas de-juice)_`;

        const edgePp1 = mlResult.t1Edge.toFixed(1);
        const edgePp2 = mlResult.t2Edge.toFixed(1);

        const league = m.league ? `[${m.league}] ` : '';
        const icon = sport === 'mma' ? '🥊' : sport === 'tennis' ? '🎾' : (m.status === 'draft' ? '📋' : '🔴');

        if ((sport === 'mma' || sport === 'tennis') && m.time) {
          try {
            const dt = new Date(m.time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            txt += `${icon} ${league}*${m.team1}* vs *${m.team2}* _(${dt})_\n`;
          } catch(_) {
            txt += `${icon} ${league}*${m.team1}* vs *${m.team2}*\n`;
          }
        } else {
          const score = (m.score1 !== undefined && m.score2 !== undefined) ? ` (${m.score1}-${m.score2})` : '';
          txt += `${icon} ${league}*${m.team1}* vs *${m.team2}*${score}\n`;
        }

        txt += `  🏷️ Bookie: \`${o1}\` / \`${o2}\` _(margem: ${margin}%)_\n`;
        txt += `  🤖 Modelo${enrichTag}: \`${fairO1}\` / \`${fairO2}\`\n`;
        txt += `  📊 P: *${(modelP1*100).toFixed(1)}%* / *${(modelP2*100).toFixed(1)}%*`;
        if (hasEnrichData) {
          txt += ` | Edge: ${parseFloat(edgePp1)>=0?'+':''}${edgePp1}pp / ${parseFloat(edgePp2)>=0?'+':''}${edgePp2}pp`;
        }
        txt += `\n\n`;
      }
    }

    txt += `_Atualizado: ${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}_`;
    await send(token, chatId, txt, getMenu(sport));
  } catch (e) {
    await send(token, chatId, `❌ Erro ao calcular fair odds: ${e.message}`);
  }
}

// ── Polling per Bot ──
async function poll(token, sport) {
  const config = SPORTS[sport];
  if (!config?.enabled) return;
  
  let offset = 0;
  let consecutiveErrors = 0;
  const MAX_BACKOFF = 30000;
  
  async function loop() {
    try {
      const res = await tgRequest(token, 'getUpdates', {
        offset,
        timeout: 30,
        limit: 10,
        allowed_updates: ['message', 'callback_query']
      });
      
      if (!res.ok) {
        consecutiveErrors++;
        const backoff = Math.min(500 * Math.pow(2, consecutiveErrors), MAX_BACKOFF);
        setTimeout(loop, backoff);
        return;
      }
      
      consecutiveErrors = 0;
      
      for (const update of res.result) {
        offset = update.update_id + 1;
        
        if (update.message) {
          const chatId = update.message.chat.id;
          const text = update.message.text || '';
          
          if (text === '/start' || text === '« Menu') {
            await serverPost('/save-user', {
              userId: chatId,
              username: update.message.from?.username || '',
              subscribed: subscribedUsers.get(chatId)?.has(sport) || false,
              sportPrefs: [...(subscribedUsers.get(chatId) || new Set())]
            });
            await send(token, chatId,
              `${config.icon} *${config.name} Bot*\n\n` +
              `As tips chegam automaticamente quando o sistema identifica valor.\n\n` +
              `• 🤖 Análise por IA com Kelly Criterion\n` +
              `• 💰 Só tips com EV positivo são enviadas\n` +
              `• 🔔 Ative notificações para receber as tips\n\n` +
              `_Use os botões abaixo_ 👇`,
              getMenu(sport)
            );
          } else if (text === '🔔 Notificações') {
            await handleNotificacoes(token, chatId, sport);
          } else if (text === '📊 Tracking') {
            // mesmo handler do /tracking
            try {
              const [roi, history, marketRows] = await Promise.all([
                serverGet('/roi', sport),
                serverGet('/tips-history?limit=10&filter=settled', sport).catch(() => []),
                serverGet('/roi-by-market', sport).catch(() => [])
              ]);
              const o = roi.overall || {};
              const wins = o.wins || 0, losses = o.losses || 0, total = o.total || 0;
              const pending = total - wins - losses;
              const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
              const roiVal = parseFloat(o.roi || 0);
              const roiSign = roiVal > 0 ? '+' : '';
              const roiEmoji = roiVal > 0 ? '📈' : roiVal < 0 ? '📉' : '➡️';
              let txt = `📊 *TRACKING DE TIPS — ${config.name}*\n`;
              txt += `━━━━━━━━━━━━━━━━\n\n`;
              if (total === 0) {
                txt += `_Nenhuma tip registrada ainda._\n`;
                txt += `As tips automáticas são gravadas assim que enviadas.`;
              } else {
                txt += `🎯 *Acertos:* ${wins}/${total - pending} (${pending > 0 ? `+${pending} pend.` : 'todas resolvidas'})\n`;
                txt += `✅ Ganhas: *${wins}* | ❌ Perdidas: *${losses}*\n`;
                txt += `📌 Win Rate: *${wr}%*\n`;
                txt += `${roiEmoji} ROI: *${roiSign}${roiVal}%*\n`;
                txt += `💵 Profit total: *${roiVal >= 0 ? '+' : ''}${o.totalProfit || 0}u*\n`;
                txt += `📦 Volume: *${o.totalStaked || 0}u* apostados\n`;
                txt += `📐 EV médio: *${o.avg_ev || 0}%* | Odd média: *${o.avg_odds || 0}*\n`;
                if (roi.calibration?.length) {
                  txt += `\n🎯 *Calibração:*\n`;
                  const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' };
                  roi.calibration.forEach(c => {
                    txt += `${confEmoji[c.confidence]||'⚪'} ${c.confidence}: ${c.wins}/${c.total} (${c.win_rate}%)\n`;
                  });
                }
                if (Array.isArray(marketRows) && marketRows.length > 1) {
                  txt += `\n📊 *Por mercado:*\n`;
                  for (const row of marketRows) {
                    const mktEmoji = row.market_type === 'HANDICAP' ? '♟️' : row.market_type === 'METHOD' ? '🥊' : '🎯';
                    txt += `${mktEmoji} ${row.market_type}: ${row.wins}/${row.total} | ROI: ${row.roi > 0 ? '+' : ''}${row.roi}%\n`;
                  }
                }
                if (Array.isArray(history) && history.length > 0) {
                  txt += `\n📋 *Últimas tips:*\n`;
                  history.slice(0, 5).forEach(t => {
                    const res = t.result === 'win' ? '✅' : t.result === 'loss' ? '❌' : '⏳';
                    txt += `${res} *${t.tip_participant||'?'}* @ ${t.odds} _(${(t.sent_at||'').slice(0,10)})_\n`;
                  });
                }
              }
              txt += `\n_Use /tracking para atualizar_`;
              await send(token, chatId, txt);
            } catch(e) { await send(token, chatId, '❌ Erro ao buscar tracking: ' + e.message); }
          } else if (text === '❓ Ajuda') {
            await send(token, chatId,
              `📖 *${config.name} Bot*\n\n` +
              `🤖 *Como funciona:*\n` +
              `O bot analisa partidas automaticamente e envia tips quando encontra valor (+EV). Você não precisa fazer nada — só ativar as notificações.\n\n` +
              `📊 *Comandos:*\n` +
              `*/tracking* — acertos, ROI, histórico completo\n` +
              `*/meustats* — resumo rápido de performance\n\n` +
              `🔔 *Notificações:* ative pelo botão abaixo para receber as tips.\n\n` +
              `⚠️ _Aposte com responsabilidade._`,
              getMenu(sport)
            );
          } else if (text === '/debug_odds') {
            try {
              const debug = await serverGet('/debug-odds', sport);
              const lastSync = new Date(debug.lastSync).toLocaleTimeString();
              await send(token, chatId, `🔍 *Diagnóstico OddsPapi*\n\n` +
                `• Cache: ${debug.count} partidas\n` +
                `• Último Sync: ${lastSync}\n` +
                `• Status API: ${debug.status || 'OK'}`);
            } catch(e) {
              await send(token, chatId, `❌ Erro no Debug: ${e.message}`);
            }
          } else if (text === '📅 Próximas') {
            await handleProximas(token, chatId, sport);
          } else if (text === '⚖️ Fair Odds') {
            await handleFairOdds(token, chatId, sport);
          } else if (text.startsWith('/notificacoes') || text.startsWith('/notificações')) {
            const action = text.split(' ')[1];
            await handleNotificacoes(token, chatId, sport, action);
          } else if (text === '/meustats') {
            try {
              const roi = await serverGet('/roi', sport);
              const o = roi.overall || {};
              const bk = roi.banca || {};
              const wins = o.wins || 0, total = o.total || 0;
              const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
              let txt = `📊 *${config.name} — Performance*\n\n`;
              if (bk.currentBanca !== undefined) {
                const profitR = bk.profitReais || 0;
                txt += `💰 *Banca: R$${bk.currentBanca.toFixed(2)}* (${profitR >= 0 ? '+' : ''}R$${profitR.toFixed(2)})\n`;
                txt += `🎲 1u = R$${(bk.unitValue || 1).toFixed(2)}\n\n`;
              }
              txt += `Tips registradas: *${total}*\n`;
              txt += `✅ Ganhas: *${wins}* | ❌ Perdidas: *${o.losses || 0}*\n`;
              txt += `🎯 Win Rate: *${wr}%*\n`;
              if (o.roi !== undefined) txt += `💰 ROI: *${o.roi > 0 ? '+' : ''}${o.roi}%*\n`;
              txt += `\n_Apenas tips com odds reais e +EV são registradas._`;
              await send(token, chatId, txt);
            } catch(e) { await send(token, chatId, '❌ Erro ao buscar stats.'); }
          } else if (text === '/tracking' || text.startsWith('/tracking ')) {
            try {
              const [roi, history, marketRows] = await Promise.all([
                serverGet('/roi', sport),
                serverGet('/tips-history?limit=10&filter=settled', sport).catch(() => []),
                serverGet('/roi-by-market', sport).catch(() => [])
              ]);
              const o = roi.overall || {};
              const bk = roi.banca || {};
              const wins = o.wins || 0, losses = o.losses || 0, total = o.total || 0;
              const pending = total - wins - losses;
              const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
              const roiVal = parseFloat(o.roi || 0);
              const roiSign = roiVal > 0 ? '+' : '';
              const roiEmoji = roiVal > 0 ? '📈' : roiVal < 0 ? '📉' : '➡️';

              let txt = `📊 *TRACKING DE TIPS — ${config.name}*\n`;
              txt += `━━━━━━━━━━━━━━━━\n\n`;

              // Bloco de banca
              if (bk.currentBanca !== undefined) {
                const profitR = bk.profitReais || 0;
                const growthPct = bk.growthPct || 0;
                txt += `💰 *BANCA*\n`;
                txt += `Inicial: R$${(bk.initialBanca || 100).toFixed(2)} → Atual: *R$${bk.currentBanca.toFixed(2)}*\n`;
                txt += `${profitR >= 0 ? '📈' : '📉'} ${profitR >= 0 ? '+' : ''}R$${profitR.toFixed(2)} (${growthPct >= 0 ? '+' : ''}${growthPct}%)\n`;
                txt += `🎲 1 unidade = *R$${(bk.unitValue || 1).toFixed(2)}*\n\n`;
              }

              if (total === 0) {
                txt += `_Nenhuma tip registrada ainda._\n`;
                txt += `As tips automáticas são gravadas assim que enviadas.`;
              } else {
                txt += `🎯 *Acertos:* ${wins}/${total - pending} (${pending > 0 ? `+${pending} pend.` : 'todas resolvidas'})\n`;
                txt += `✅ Ganhas: *${wins}* | ❌ Perdidas: *${losses}*\n`;
                txt += `📌 Win Rate: *${wr}%*\n`;
                txt += `${roiEmoji} ROI: *${roiSign}${roiVal}%*\n`;
                txt += `💵 Profit total: *${roiVal >= 0 ? '+' : ''}${o.totalProfit || 0}u*\n`;
                txt += `📦 Volume: *${o.totalStaked || 0}u* apostados\n`;
                txt += `📐 EV médio: *${o.avg_ev || 0}%* | Odd média: *${o.avg_odds || 0}*\n`;

                // Calibração por confiança
                if (roi.calibration?.length) {
                  txt += `\n🎯 *Calibração por confiança:*\n`;
                  const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' };
                  roi.calibration.forEach(c => {
                    const ce = confEmoji[c.confidence] || '⚪';
                    txt += `${ce} ${c.confidence}: ${c.wins}/${c.total} (${c.win_rate}%)\n`;
                  });
                }

                // Pré-jogo vs Ao Vivo (esports only)
                if (roi.byPhase && sport === 'esports') {
                  const { live: lv, preGame: pg } = roi.byPhase;
                  txt += `\n🎮 *Pré-jogo vs Ao Vivo:*\n`;
                  if (pg.total > 0) {
                    const pgWR = Math.round((pg.wins / pg.total) * 100);
                    const pgRoi = parseFloat(pg.roi);
                    txt += `📋 Pré-jogo: ${pg.wins}/${pg.total} (${pgWR}%) | ROI ${pgRoi >= 0 ? '+' : ''}${pgRoi}%\n`;
                    txt += `   _⚠️ Sem draft — baseia-se em forma/histórico_\n`;
                  } else {
                    txt += `📋 Pré-jogo: sem tips registradas\n`;
                  }
                  if (lv.total > 0) {
                    const lvWR = Math.round((lv.wins / lv.total) * 100);
                    const lvRoi = parseFloat(lv.roi);
                    txt += `⚡ Ao Vivo: ${lv.wins}/${lv.total} (${lvWR}%) | ROI ${lvRoi >= 0 ? '+' : ''}${lvRoi}%\n`;
                  } else {
                    txt += `⚡ Ao Vivo: sem tips registradas\n`;
                  }
                }

                // Breakdown por mercado
                if (Array.isArray(marketRows) && marketRows.length > 1) {
                  txt += `\n📊 *Por mercado:*\n`;
                  for (const row of marketRows) {
                    const mktEmoji = row.market_type === 'HANDICAP' ? '♟️' : row.market_type === 'METHOD' ? '🥊' : '🎯';
                    txt += `${mktEmoji} ${row.market_type}: ${row.wins}/${row.total} | ROI: ${row.roi > 0 ? '+' : ''}${row.roi}%\n`;
                  }
                }

                // Últimas tips resolvidas
                if (Array.isArray(history) && history.length > 0) {
                  txt += `\n📋 *Últimas tips resolvidas:*\n`;
                  history.slice(0, 5).forEach(t => {
                    const res = t.result === 'win' ? '✅' : t.result === 'loss' ? '❌' : '⏳';
                    const name = t.tip_participant || '?';
                    const date = (t.sent_at || '').slice(0, 10);
                    const pr = t.profit_reais != null ? ` (${t.profit_reais >= 0 ? '+' : ''}R$${parseFloat(t.profit_reais).toFixed(2)})` : '';
                    txt += `${res} *${name}* @ ${t.odds}${pr} _(${date})_\n`;
                  });
                }
              }

              txt += `\n_Use /tracking para atualizar_`;
              await send(token, chatId, txt, getTipsMenu(sport));
            } catch(e) { await send(token, chatId, '❌ Erro ao buscar tracking: ' + e.message); }
          } else if (text.startsWith('/stats') || text.startsWith('/roi') || text.startsWith('/users') ||
                     text.startsWith('/settle') || text.startsWith('/pending') || text.startsWith('/resync') ||
                     text.startsWith('/slugs') || text.startsWith('/lolraw') ||
                     text.startsWith('/health') || text.startsWith('/debug')) {
            await handleAdmin(token, chatId, text);
          }
        }
        
        if (update.callback_query) {
          const cq = update.callback_query;
          const chatId = cq.message.chat.id;
          const data = cq.data;
          // Always ack the callback to remove the spinner
          await tgRequest(token, 'answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
          
          if (data.startsWith('notif_')) {
            // notif_{sport}_{on|off}
            const [, s, action] = data.split('_');
            await handleNotificacoes(token, chatId, s, action === 'on' ? 'on' : 'off');
          } else if (data.startsWith('tips_')) {
            // tips_{action}_{sport}  — menu | pending | won | lost
            const parts = data.split('_');
            const action = parts[1];
            const s = parts[2] || sport;

            if (action === 'back') {
              await send(token, chatId, '🏠 *Menu principal*', getMenu(s));
            } else if (action === 'menu') {
              await send(token, chatId, '💰 *Minhas Tips* — escolha uma categoria:', getTipsMenu(s));
            } else if (action === 'pending' || action === 'won' || action === 'lost') {
              try {
                const filterMap = { pending: 'pending', won: 'win', lost: 'loss' };
                const labelMap  = { pending: '⏳ Em andamento', won: '✅ Vencidas', lost: '❌ Perdidas' };
                const tips = await serverGet(`/tips-history?limit=20&filter=${filterMap[action]}`, s).catch(() => []);
                if (!Array.isArray(tips) || tips.length === 0) {
                  await send(token, chatId, `${labelMap[action]}: _Nenhuma tip encontrada._`, getTipsMenu(s));
                  return;
                }
                let txt = `${labelMap[action]} _(${tips.length})_\n━━━━━━━━━━━━━━━━\n\n`;
                for (const t of tips.slice(0, 15)) {
                  const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' }[t.confidence] || '⚪';
                  const resEmoji  = t.result === 'win' ? '✅' : t.result === 'loss' ? '❌' : '⏳';
                  const date = (t.sent_at || '').slice(0, 10);
                  const profitStr = t.profit_reais != null
                    ? ` | ${t.profit_reais >= 0 ? '+' : ''}R$${parseFloat(t.profit_reais).toFixed(2)}`
                    : '';
                  const liveTag = t.is_live ? ' 🔴' : '';

                  // Show opponent (participant2) if available
                  const opponent = t.participant2 ? ` vs ${t.participant2}` : '';

                  // Show match time if available (from matches table)
                  let matchTimeInfo = '';
                  if (t.match_time) {
                    const matchTime = t.match_time.slice(0, 16).replace('T', ' ');
                    matchTimeInfo = ` — ${matchTime}`;
                  } else if (t.match_date) {
                    matchTimeInfo = ` — ${t.match_date.slice(0, 10)}`;
                  }

                  txt += `${resEmoji} *${t.tip_participant || '?'}*${opponent} @ ${t.odds}${liveTag}\n`;
                  txt += `   ${confEmoji} ${t.confidence || '?'} | ${t.stake || '?'} | EV: ${t.ev || '?'}%${profitStr}\n`;
                  txt += `   _${t.event_name || '?'} — ${date}${matchTimeInfo}_\n\n`;
                }
                if (tips.length > 15) txt += `_...e mais ${tips.length - 15} tips_\n`;
                await send(token, chatId, txt, getTipsMenu(s));
              } catch(e) { await send(token, chatId, '❌ Erro ao buscar tips: ' + e.message, getTipsMenu(s)); }
            }
          } else if (data.startsWith('menu_')) {
            // menu_{action}_{sport}
            const parts = data.split('_'); // ['menu', action, sport]
            const action = parts[1];
            const s = parts[2] || sport;
            
            if (action === 'notif') {
              await handleNotificacoes(token, chatId, s);
            } else if (action === 'tracking') {
              try {
                const [roi, history, marketRows] = await Promise.all([
                  serverGet('/roi', s),
                  serverGet('/tips-history?limit=10&filter=settled', s).catch(() => []),
                  serverGet('/roi-by-market', s).catch(() => [])
                ]);
                const o = roi.overall || {};
                const bk = roi.banca || {};
                const wins = o.wins || 0, losses = o.losses || 0, total = o.total || 0;
                const pending = total - wins - losses;
                const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
                const roiVal = parseFloat(o.roi || 0);
                const roiSign = roiVal > 0 ? '+' : '';
                const roiEmoji = roiVal > 0 ? '📈' : roiVal < 0 ? '📉' : '➡️';
                let txt = `📊 *TRACKING DE TIPS — ${config.name}*\n`;
                txt += `━━━━━━━━━━━━━━━━\n\n`;
                if (bk.currentBanca !== undefined) {
                  const profitR = bk.profitReais || 0;
                  txt += `💰 *Banca: R$${bk.currentBanca.toFixed(2)}* (${profitR >= 0 ? '+' : ''}R$${profitR.toFixed(2)})\n`;
                  txt += `🎲 1u = R$${(bk.unitValue || 1).toFixed(2)}\n\n`;
                }
                if (total === 0) {
                  txt += `_Nenhuma tip registrada ainda._\n`;
                  txt += `As tips automáticas são gravadas assim que enviadas.`;
                } else {
                  txt += `🎯 *Acertos:* ${wins}/${total - pending} (${pending > 0 ? `+${pending} pend.` : 'todas resolvidas'})\n`;
                  txt += `✅ Ganhas: *${wins}* | ❌ Perdidas: *${losses}*\n`;
                  txt += `📋 Win Rate: *${wr}%*\n`;
                  txt += `${roiEmoji} ROI: *${roiSign}${roiVal}%*\n`;
                  txt += `💵 Profit total: *${roiVal >= 0 ? '+' : ''}${o.totalProfit || 0}u*\n`;
                  txt += `📦 Volume: *${o.totalStaked || 0}u* apostados\n`;
                  if (roi.calibration?.length) {
                    txt += `\n🎯 *Calibração:*\n`;
                    const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' };
                    roi.calibration.forEach(c => {
                      txt += `${confEmoji[c.confidence]||'⚪'} ${c.confidence}: ${c.wins}/${c.total} (${c.win_rate}%)\n`;
                    });
                  }
                  if (Array.isArray(marketRows) && marketRows.length > 1) {
                    txt += `\n📊 *Por mercado:*\n`;
                    for (const row of marketRows) {
                      const mktEmoji = row.market_type === 'HANDICAP' ? '♟️' : row.market_type === 'METHOD' ? '🥊' : '🎯';
                      txt += `${mktEmoji} ${row.market_type}: ${row.wins}/${row.total} | ROI: ${row.roi > 0 ? '+' : ''}${row.roi}%\n`;
                    }
                  }
                  if (Array.isArray(history) && history.length > 0) {
                    txt += `\n📋 *Últimas tips:*\n`;
                    history.slice(0, 5).forEach(t => {
                      const res = t.result === 'win' ? '✅' : t.result === 'loss' ? '❌' : '⏳';
                      const pr = t.profit_reais != null ? ` (${t.profit_reais >= 0 ? '+' : ''}R$${parseFloat(t.profit_reais).toFixed(2)})` : '';
                      txt += `${res} *${t.tip_participant||'?'}* @ ${t.odds}${pr} _(${(t.sent_at||'').slice(0,10)})_\n`;
                    });
                  }
                }
                txt += `\n_Use /tracking para atualizar_`;
                await send(token, chatId, txt);
              } catch(e) { await send(token, chatId, '❌ Erro ao buscar tracking: ' + e.message); }
            } else if (action === 'proximas') {
              await handleProximas(token, chatId, s);
            } else if (action === 'fairodds') {
              await handleFairOdds(token, chatId, s);
            } else if (action === 'ajuda') {
              await send(token, chatId,
                `📖 *${config.name} Bot*\n\n` +
                `🤖 *Como funciona:*\n` +
                `O bot analisa partidas automaticamente e envia tips quando encontra valor (+EV). Você não precisa fazer nada — só ativar as notificações.\n\n` +
                `📊 *Comandos:*\n` +
                `*/tracking* — acertos, ROI, histórico completo\n` +
                `*/meustats* — resumo rápido de performance\n\n` +
                `🔔 *Notificações:* ative pelo botão abaixo para receber as tips.\n\n` +
                `⚠️ _Aposte com responsabilidade._`,
                getMenu(s)
              );
            }
          }
        }
      }
    } catch(e) {
      console.error(`[POLL ${sport}]`, e.message);
      consecutiveErrors++;
    }
    
    const backoff = consecutiveErrors > 0
      ? Math.min(500 * Math.pow(2, consecutiveErrors), 10000)
      : 500;
    setTimeout(loop, backoff);
  }
  
  loop();
}

// ── ESPN Tennis data (rankings + torneio atual) ──
let espnTennisCache = { atp: [], wta: [], ts: 0 };
const ESPN_TENNIS_TTL = 3 * 60 * 60 * 1000; // 3h

async function espnGet(path) {
  const r = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'site.api.espn.com',
      path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('ESPN timeout')));
    req.end();
  });
  return r;
}

async function fetchEspnTennisRankings() {
  if (Date.now() - espnTennisCache.ts < ESPN_TENNIS_TTL) return espnTennisCache;
  try {
    const [atpR, wtaR] = await Promise.all([
      espnGet('/apis/site/v2/sports/tennis/atp/rankings').catch(() => ({ status: 500, body: '{}' })),
      espnGet('/apis/site/v2/sports/tennis/wta/rankings').catch(() => ({ status: 500, body: '{}' }))
    ]);
    const parseRanks = body => {
      const j = safeParse(body, {});
      return (j.rankings?.[0]?.ranks || []).map(r => ({
        rank: r.current,
        points: r.points,
        name: r.athlete?.displayName || '',
        id: r.athlete?.id || ''
      }));
    };
    espnTennisCache = {
      atp: parseRanks(atpR.body),
      wta: parseRanks(wtaR.body),
      ts: Date.now()
    };
    log('INFO', 'ESPN-TENNIS', `Rankings: ATP ${espnTennisCache.atp.length} | WTA ${espnTennisCache.wta.length}`);
  } catch(e) {
    log('WARN', 'ESPN-TENNIS', `Falha rankings: ${e.message}`);
  }
  return espnTennisCache;
}

async function fetchEspnTennisEvent(tour) {
  // Busca partidas agendadas e resultados recentes do torneio atual
  try {
    const league = tour === 'WTA' ? 'wta' : 'atp';
    const r = await espnGet(`/apis/site/v2/sports/tennis/${league}/scoreboard`).catch(() => ({ status: 500, body: '{}' }));
    if (r.status !== 200) return null;
    const j = safeParse(r.body, {});
    const ev = j.events?.[0];
    if (!ev) return null;

    const recentResults = []; // últimos resultados do torneio
    const scheduledMatches = []; // próximas do torneio

    for (const grp of (ev.groupings || [])) {
      for (const comp of (grp.competitions || [])) {
        const state = comp.status?.type?.state;
        const c1 = comp.competitors?.[0]?.athlete?.displayName || '';
        const c2 = comp.competitors?.[1]?.athlete?.displayName || '';
        if (state === 'post') {
          const winnerComp = comp.competitors?.find(c => c.winner === true);
          const winner = winnerComp?.athlete?.displayName || '';
          const score = comp.status?.displayClock
            || comp.competitors?.map(c => c.score).join('-')
            || '';
          recentResults.push({ p1: c1, p2: c2, winner, score, date: comp.date || '' });
        } else if (state === 'pre' || state === 'in') {
          scheduledMatches.push({ p1: c1, p2: c2, court: comp.venue?.court, date: comp.date });
        }
      }
    }
    return {
      eventName: ev.name,
      surface: ev.name?.toLowerCase().includes('monte') || ev.name?.toLowerCase().includes('clay') ? 'saibro'
        : ev.name?.toLowerCase().includes('wimbledon') || ev.name?.toLowerCase().includes('halle') || ev.name?.toLowerCase().includes('queen') ? 'grama'
        : 'dura',
      recentResults: recentResults.slice(-20), // últimos 20 resultados
      scheduledMatches
    };
  } catch(e) {
    return null;
  }
}

function getTennisPlayerRank(rankings, name) {
  const n = normName(name);
  const found = rankings.find(r => {
    const rn = normName(r.name);
    return rn === n || rn.includes(n) || n.includes(rn);
  });
  return found ? `#${found.rank} (${found.points}pts)` : null;
}

function getTennisRecentForm(recentResults, name) {
  // Extrai W/L do jogador nos resultados recentes do torneio
  const n = normName(name);
  const results = [];
  for (const r of recentResults) {
    // Suporta objetos estruturados { p1, p2, winner, score } e strings legadas
    if (r && typeof r === 'object') {
      const rp1 = normName(r.p1), rp2 = normName(r.p2);
      const nShort = n.slice(0, 5);
      if (!rp1.includes(nShort) && !rp2.includes(nShort)) continue;
      const won = normName(r.winner).includes(nShort);
      results.push(won ? `W ${r.score || ''}`.trim() : `L ${r.score || ''}`.trim());
    } else {
      const note = String(r);
      const lower = normName(note);
      if (!lower.includes(n.slice(0, 5))) continue;
      const won = lower.indexOf(n.slice(0, 5)) < lower.indexOf(' bt ') + 4 &&
                  lower.includes(' bt ');
      const scoreMatch = note.match(/(\d-\d(?: \d-\d)*(?:\(\d+\))?(?:,? \d-\d(?:\(\d+\))?)*)$/);
      const score = scoreMatch ? scoreMatch[0] : '';
      results.push(won ? `W ${score}` : `L ${score}`);
    }
  }
  return results.length ? results.slice(-5).join(', ') : null;
}

// ── ESPN MMA data fetcher (sem chave de API) ──
let espnMmaCache = { data: [], ts: 0 };
const ESPN_MMA_TTL = 15 * 60 * 1000; // 15min para capturar lutas recém-concluídas

async function fetchEspnMmaFights() {
  if (Date.now() - espnMmaCache.ts < ESPN_MMA_TTL && espnMmaCache.data.length) return espnMmaCache.data;
  try {
    const r = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'site.api.espn.com',
        path: '/apis/site/v2/sports/mma/ufc/scoreboard',
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('ESPN timeout')));
      req.end();
    });

    if (r.status !== 200) return espnMmaCache.data;
    const json = safeParse(r.body, {});
    const fights = [];
    for (const event of (json.events || [])) {
      for (const comp of (event.competitions || [])) {
        const comps = comp.competitors || [];
        if (comps.length < 2) continue;
        const f1 = comps.find(c => c.order === 1) || comps[0];
        const f2 = comps.find(c => c.order === 2) || comps[1];
        const rec = c => (c.records || []).find(r => r.name === 'overall')?.summary || '';
        const athleteName = a => a?.fullName || a?.displayName || a?.shortName || '';
        const winnerComp = comps.find(c => c.winner === true);
        const winnerName = winnerComp
          ? (athleteName(winnerComp.athlete) || winnerComp.displayName || winnerComp.name || '')
          : '';
        fights.push({
          name1: athleteName(f1.athlete) || f1.displayName || f1.name || '',
          name2: athleteName(f2.athlete) || f2.displayName || f2.name || '',
          record1: rec(f1),
          record2: rec(f2),
          weightClass: comp.type?.abbreviation || comp.type?.text || '',
          rounds: comp.format?.regulation?.periods || 3,
          eventName: event.name || '',
          date: comp.date || '',
          statusState: comp.status?.type?.state || 'pre',
          winner: winnerName
        });
      }
    }
    espnMmaCache = { data: fights, ts: Date.now() };
    log('INFO', 'ESPN-MMA', `${fights.length} lutas carregadas da ESPN`);
    return fights;
  } catch(e) {
    log('WARN', 'ESPN-MMA', `Falha ao buscar dados ESPN: ${e.message}`);
    return espnMmaCache.data;
  }
}

function normName(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

// Cache de records individuais de lutadores buscados via ESPN/Wikipedia
const espnFighterCache = new Map(); // normName → { record, ts }
const ESPN_FIGHTER_TTL = 6 * 60 * 60 * 1000; // 6h

/**
 * Busca record de um lutador via Wikipedia REST API.
 * Cobre lutadores de todas as promoções que tenham página na Wikipedia.
 * Gratuito, sem API key, estável.
 */
async function fetchWikipediaFighterRecord(name) {
  const cacheKey = `wiki_${normName(name)}`;
  const cached = espnFighterCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ESPN_FIGHTER_TTL) return cached.record;
  const cache = rec => { espnFighterCache.set(cacheKey, { record: rec, ts: Date.now() }); return rec; };

  try {
    // Tenta nome exato, depois tenta com underscore
    const title = name.trim().replace(/\s+/g, '_');
    const r = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'en.wikipedia.org',
        path: `/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
        method: 'GET',
        headers: { 'User-Agent': 'SportsEdgeBot/1.0', 'Accept': 'application/json' }
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      req.setTimeout(8000, () => req.destroy(new Error('Wiki timeout')));
      req.end();
    })
      .catch(() => null);
    if (!r || r.status !== 200) return cache(null);

    const j = safeParse(r.body, {});
    // Só queremos páginas de lutadores (categoria MMA/boxing)
    const desc = (j.description || '').toLowerCase();
    const isFighter = desc.includes('martial') || desc.includes('fighter') || desc.includes('boxer')
      || desc.includes('wrestler') || desc.includes('kickbox');
    if (!isFighter) return cache(null);

    const text = j.extract || '';
    // Captura padrões como "14-0", "22–4–0", "22–4"
    // Busca a PRIMEIRA ocorrência que pareça um record de luta (not "born 14-3-1997")
    const matches = [...text.matchAll(/\b(\d{1,3})\s*[–\-]\s*(\d{1,2})(?:\s*[–\-]\s*(\d{1,2}))?\b/g)];
    for (const m of matches) {
      const w = parseInt(m[1]), l = parseInt(m[2]), d = m[3] ? parseInt(m[3]) : 0;
      // Sanity: record plausível de MMA (max ~50 lutas)
      if (w + l + d > 0 && w + l + d <= 60 && w <= 50) {
        return cache(`${w}-${l}-${d}`);
      }
    }
    return cache(null);
  } catch(_) {
    return cache(null);
  }
}

// Busca record de um lutador individualmente na ESPN quando não está no scoreboard.
// Passo 1: search para obter o ID do atleta
// Passo 2: GET /athletes/{id} para obter o record completo
async function fetchEspnFighterRecord(name) {
  const key = normName(name);
  const cached = espnFighterCache.get(key);
  if (cached && Date.now() - cached.ts < ESPN_FIGHTER_TTL) return cached.record;

  const cache = rec => { espnFighterCache.set(key, { record: rec, ts: Date.now() }); return rec; };

  try {
    // Passo 1 — search (tenta nome completo, depois só sobrenome como fallback)
    const trySearch = async (query) => {
      const r = await espnGet(`/apis/site/v2/sports/mma/ufc/athletes?limit=5&search=${encodeURIComponent(query)}`)
        .catch(() => ({ status: 500, body: '{}' }));
      if (r.status !== 200) return null;
      const json = safeParse(r.body, {});
      const athletes = json.athletes || json.items || json.results || [];
      if (!athletes.length) return null;
      const n = normName(query);
      return athletes.find(a => {
        const an = normName(a.displayName || a.fullName || a.name || '');
        return an === n || an.includes(n) || n.includes(an);
      }) || null;
    };

    let hit = await trySearch(name.trim());
    // Fallback: tenta só o sobrenome
    if (!hit) {
      const lastName = name.trim().split(/\s+/).pop();
      if (lastName && lastName !== name.trim()) hit = await trySearch(lastName);
    }
    if (!hit) return cache(null);

    // Tenta extrair record diretamente do objeto de search
    const inline = hit.record?.displayValue
      || hit.record?.summary
      || hit.recordSummary
      || (hit.wins !== undefined ? `${hit.wins}-${hit.losses}-${hit.draws ?? 0}` : null);
    if (inline) return cache(inline);

    // Passo 2 — busca perfil individual pelo ID para obter o record
    const athleteId = hit.id || hit.uid?.replace(/[^0-9]/g, '');
    if (!athleteId) return cache(null);

    const r2 = await espnGet(`/apis/site/v2/sports/mma/ufc/athletes/${athleteId}`)
      .catch(() => ({ status: 500, body: '{}' }));
    if (r2.status !== 200) return cache(null);

    const j2 = safeParse(r2.body, {});
    // Perfil pode ter athlete.record ou diretamente record
    const athlete = j2.athlete || j2;
    const rec = athlete.record?.displayValue
      || athlete.record?.summary
      || athlete.recordSummary
      || (athlete.wins !== undefined ? `${athlete.wins}-${athlete.losses}-${athlete.draws ?? 0}` : null);

    return cache(rec);
  } catch(_) {
    return cache(null);
  }
}

function findEspnFight(espnFights, team1, team2) {
  const n1 = normName(team1), n2 = normName(team2);
  return espnFights.find(f => {
    const e1 = normName(f.name1), e2 = normName(f.name2);
    const fwd = (e1.includes(n1) || n1.includes(e1)) && (e2.includes(n2) || n2.includes(e2));
    const rev = (e1.includes(n2) || n2.includes(e1)) && (e2.includes(n1) || n1.includes(e2));
    return fwd || rev;
  }) || null;
}

// ── MMA Auto-analysis loop ──
async function pollMma() {
  const mmaConfig = SPORTS['mma'];
  if (!mmaConfig?.enabled || !mmaConfig?.token) return;
  const token = mmaConfig.token;

  const MMA_INTERVAL = 6 * 60 * 60 * 1000; // Re-analisa a cada 6h

  async function loop() {
    try {
      const [fights, espnFights] = await Promise.all([
        serverGet('/mma-matches').catch(() => []),
        fetchEspnMmaFights().catch(() => [])
      ]);

      if (!Array.isArray(fights) || !fights.length) {
        setTimeout(loop, 30 * 60 * 1000); return;
      }

      log('INFO', 'AUTO-MMA', `${fights.length} lutas MMA com odds | ESPN: ${espnFights.length} lutas`);

      const now = Date.now();
      const endOfWeek = (() => {
        const d = new Date();
        // Domingo da semana atual às 23:59
        const sunday = new Date(d);
        sunday.setDate(d.getDate() + (7 - d.getDay()) % 7 || 7);
        sunday.setHours(23, 59, 59, 999);
        return sunday.getTime();
      })();

      for (const fight of fights) {
        const key = `mma_${fight.id}`;
        const prev = analyzedMma.get(key);
        if (prev?.tipSent) continue;
        if (prev && (now - prev.ts < MMA_INTERVAL)) continue;

        const o = fight.odds;
        if (!o?.t1 || !o?.t2) continue;

        const fightTs = fight.time ? new Date(fight.time).getTime() : 0;
        // Descartar lutas já passadas (dado stale da API)
        if (fightTs && fightTs < now) {
          log('INFO', 'AUTO-MMA', `Ignorando luta passada: ${fight.team1} vs ${fight.team2}`);
          continue;
        }
        // Descartar lutas sem data ou com data > 60 dias — provavelmente históricas/inválidas no feed
        const MAX_FUTURE_MS = 60 * 24 * 60 * 60 * 1000;
        if (!fightTs || fightTs > now + MAX_FUTURE_MS) {
          log('INFO', 'AUTO-MMA', `Ignorando luta sem data válida: ${fight.team1} vs ${fight.team2}`);
          continue;
        }
        const isThisWeek = fightTs > 0 && fightTs <= endOfWeek;
        // Lutas fora da semana: só analisa, não bloqueia ainda — gate de CONF depois
        if (!isThisWeek) {
          // Marca para análise restrita (só ALTA passa)
          fight._futureWeek = true;
        }

        const fightTime = fight.time ? new Date(fight.time).toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit',
          hour: '2-digit', minute: '2-digit'
        }) : '—';

        // Dados calculados das odds
        const r1 = 1 / parseFloat(o.t1), r2 = 1 / parseFloat(o.t2);
        const or = r1 + r2;
        const fairP1 = (r1 / or * 100).toFixed(1);
        const fairP2 = (r2 / or * 100).toFixed(1);
        const marginPct = ((or - 1) * 100).toFixed(1);

        // Enriquecer com dados ESPN — scoreboard primeiro, athlete search como fallback
        const espn = findEspnFight(espnFights, fight.team1, fight.team2);
        let rec1 = espn ? (normName(espn.name1).includes(normName(fight.team1)) ? espn.record1 : espn.record2) : '';
        let rec2 = espn ? (normName(espn.name1).includes(normName(fight.team1)) ? espn.record2 : espn.record1) : '';
        const weightClass = espn?.weightClass || '';
        const rounds = espn?.rounds || 3;
        const isTitleFight = rounds === 5;

        // Fallback: busca record individual (ESPN → Wikipedia)
        if (!espn) {
          const [e1, e2] = await Promise.all([
            fetchEspnFighterRecord(fight.team1).catch(() => null),
            fetchEspnFighterRecord(fight.team2).catch(() => null)
          ]);
          if (e1) rec1 = e1;
          if (e2) rec2 = e2;
          // Segunda camada: Wikipedia para quem ESPN não encontrou
          const [w1, w2] = await Promise.all([
            !rec1 ? fetchWikipediaFighterRecord(fight.team1).catch(() => null) : Promise.resolve(null),
            !rec2 ? fetchWikipediaFighterRecord(fight.team2).catch(() => null) : Promise.resolve(null)
          ]);
          if (w1) { rec1 = w1; }
          if (w2) { rec2 = w2; }
          const source1 = e1 ? 'ESPN' : w1 ? 'Wiki' : '—';
          const source2 = e2 ? 'ESPN' : w2 ? 'Wiki' : '—';
          if (rec1 || rec2) {
            log('INFO', 'AUTO-MMA', `Records: ${fight.team1}=${rec1||'?'}(${source1}) | ${fight.team2}=${rec2||'?'}(${source2})`);
          }
        }

        // ── Pré-filtro ML com dados ESPN (record → win rate) ──
        const hasEspnRecord = !!(rec1 || rec2);
        const mmaEnrich = hasEspnRecord ? mmaRecordToEnrich(rec1, rec2) : { form1: null, form2: null, h2h: null, oddsMovement: null };
        const mlResultMma = esportsPreFilter(fight, o, mmaEnrich, false, '', null);
        if (!mlResultMma.pass) {
          log('INFO', 'AUTO-MMA', `Pré-filtro ML: edge insuficiente (${mlResultMma.score.toFixed(1)}pp) para ${fight.team1} vs ${fight.team2}. Pulando IA.`);
          await new Promise(r => setTimeout(r, 500)); continue;
        }

        const hasModelDataMma = mlResultMma.factorCount > 0;
        // Fair odds sempre disponíveis: quando sem ESPN, modelP1=impliedP1 (de-juice puro)
        const modelP1Mma = (mlResultMma.modelP1 * 100).toFixed(1);
        const modelP2Mma = (mlResultMma.modelP2 * 100).toFixed(1);
        const fairLabelMma = hasModelDataMma ? 'P modelo (record ESPN)' : 'Fair odds (de-juice, sem record ESPN)';

        const espnSection = espn
          ? `\nREGISTRO: ${fight.team1}=${rec1 || '?'} | ${fight.team2}=${rec2 || '?'}\nCategoria: ${weightClass || fight.league} | ${rounds} rounds${isTitleFight ? ' (TITLE FIGHT)' : ''}`
          : '';

        const fairOddsRef = hasModelDataMma
          ? `${fairLabelMma}: ${fight.team1}=${modelP1Mma}% | ${fight.team2}=${modelP2Mma}%\nP de-juiced bookie: ${fight.team1}=${fairP1}% | ${fight.team2}=${fairP2}%`
          : `${fairLabelMma}: ${fight.team1}=${modelP1Mma}% | ${fight.team2}=${modelP2Mma}% (use como mínimo — sem dados históricos para ajustar o prior)`;

        const newsSectionMma = await fetchMatchNews('mma', fight.team1, fight.team2).catch(() => '');

        const prompt = `Você é um analista especializado em MMA/UFC. Analise esta luta e identifique edge real se existir.

LUTA: ${fight.team1} vs ${fight.team2}
Evento: ${fight.league} | Data: ${fightTime} (BRT)${espnSection}

ODDS (${o.bookmaker || 'EU'}):
${fight.team1}: ${o.t1} | ${fight.team2}: ${o.t2}
Margem bookie: ${marginPct}%
${fairOddsRef}
AVISO: ${hasModelDataMma ? `modelo base usa record histórico como prior — sua estimativa deve superar a P do modelo em ≥8pp para ter edge real.` : `fair odds calculadas via de-juice (sem record ESPN) — use apenas como referência mínima; para edge real, sua estimativa deve superar ≥8pp.`}
${newsSectionMma ? `\n${newsSectionMma}\n` : ''}

ANÁLISE REQUERIDA — seja específico:
1. Vantagem técnica: quem domina grappling, striking e wrestling?
2. Form recente: últimas 3 lutas de cada — tendência de melhora ou queda?
3. Matchup estilístico: por que esse estilo X bate estilo Y nessa luta?
4. Confiança na análise (1-10): você tem dados suficientes sobre ambos?

DECISÃO FINAL:
- Se EV ≥ +5% E confiança ≥ 7: TIP_ML:[lutador]@[odd]|EV:[%]|STAKE:[1-3]u|CONF:[ALTA/MÉDIA/BAIXA]
- Se edge inexistente ou confiança < 7: SEM_EDGE

Máximo 220 palavras. Seja direto e fundamentado.`;

        const espnTag = espn ? ` (ESPN card: ${weightClass}, ${rounds}R)` : hasEspnRecord ? ` (ESPN athlete: ${rec1||'?'} | ${rec2||'?'})` : ' (sem dados ESPN)';
        log('INFO', 'AUTO-MMA', `Analisando: ${fight.team1} vs ${fight.team2}${espnTag}`);
        analyzedMma.set(key, { ts: now, tipSent: false });

        let resp;
        try {
          resp = await serverPost('/claude', {
            model: 'deepseek-chat',
            max_tokens: 450,
            messages: [{ role: 'user', content: prompt }]
          }, null, { 'x-claude-key': AI_PROXY_KEY });
        } catch(e) {
          log('WARN', 'AUTO-MMA', `Claude error: ${e.message}`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        const text = resp?.content?.map(b => b.text || '').join('') || '';
        const extractReasonTennis = (t) => {
          if (!t) return null;
          const before = t.split('TIP_ML:')[0] || '';
          const line = before.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
          const clean = line.replace(/^[-*•\s]+/, '').trim();
          return clean ? clean.slice(0, 160) : null;
        };
        const tipReasonTennis = extractReasonTennis(text);
        const tipMatch = text.match(/TIP_ML:([^@]+)@([\d.]+)\|EV:([+-]?[\d.]+)%\|STAKE:([\d.]+)u?\|CONF:(ALTA|MÉDIA|BAIXA)/i);

        if (!tipMatch) {
          log('INFO', 'AUTO-MMA', `Sem tip: ${fight.team1} vs ${fight.team2}`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        const tipTeam  = tipMatch[1].trim();
        const tipOdd   = parseFloat(tipMatch[2]);
        const tipEV    = parseFloat(tipMatch[3]);
        const tipStake = tipMatch[4];
        const tipConf  = tipMatch[5].toUpperCase();

        // Lutas fora da semana: só ALTA passa
        if (fight._futureWeek && tipConf !== 'ALTA') {
          log('INFO', 'AUTO-MMA', `Gate semana: ${fight.team1} vs ${fight.team2} é luta futura — descartado (CONF=${tipConf}, exige ALTA)`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }
        if (tipOdd < 1.40 || tipOdd > 5.00) {
          log('INFO', 'AUTO-MMA', `Gate odds: ${tipOdd} fora do range 1.40-5.00`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }
        if (tipEV < 5.0) {
          log('INFO', 'AUTO-MMA', `Gate EV: ${tipEV}% < 5%`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' }[tipConf] || '🟡';
        const recLine = espn ? `\n📊 Registros: ${fight.team1} ${rec1||'?'} | ${fight.team2} ${rec2||'?'}` : '';
        const catLine = espn ? `\n🏷️ ${weightClass || fight.league}${isTitleFight ? ' — TITLE FIGHT' : ''}` : '';

        const extractReasonMma = (t) => {
          if (!t) return null;
          const before = t.split('TIP_ML:')[0] || '';
          const line = before.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
          const clean = line.replace(/^[-*•\s]+/, '').trim();
          return clean ? clean.slice(0, 160) : null;
        };
        const tipReasonMma = extractReasonMma(text);
        const whyLineMma = tipReasonMma ? `\n🧠 Por quê: _${tipReasonMma}_\n` : '\n';

        const tipMsg = `🥊 💰 *TIP MMA*\n` +
          `*${fight.team1}* vs *${fight.team2}*\n📋 ${fight.league}\n` +
          `🕐 ${fightTime} (BRT)${recLine}${catLine}\n\n` +
          whyLineMma +
          `🎯 Aposta: *${tipTeam}* @ *${tipOdd}*\n` +
          `📈 EV: *+${tipEV}%* | De-juice: ${tipTeam === fight.team1 ? fairP1 : fairP2}%\n` +
          `💵 Stake: *${tipStake}u*\n` +
          `${confEmoji} Confiança: *${tipConf}*\n\n` +
          `⚠️ _Aposte com responsabilidade._`;

        const pickIsT1Mma = norm(tipTeam) === norm(fight.team1);
        const modelPPickMma = pickIsT1Mma ? mlResultMma.modelP1 : mlResultMma.modelP2;

        const desiredUnitsMma = parseFloat(String(tipStake)) || 0;
        const riskAdjMma = await applyGlobalRisk('mma', desiredUnitsMma);
        if (!riskAdjMma.ok) { log('INFO', 'RISK', `mma: bloqueada (${riskAdjMma.reason})`); await new Promise(r => setTimeout(r, 3000)); continue; }
        const tipStakeAdjMma = String(riskAdjMma.units.toFixed(1).replace(/\.0$/, ''));

        const rec = await serverPost('/record-tip', {
          matchId: String(fight.id), eventName: fight.league,
          p1: fight.team1, p2: fight.team2, tipParticipant: tipTeam,
          odds: String(tipOdd), ev: String(tipEV), stake: tipStakeAdjMma,
          confidence: tipConf, isLive: false, market_type: 'ML',
          modelP1: mlResultMma.modelP1,
          modelP2: mlResultMma.modelP2,
          modelPPick: modelPPickMma,
          modelLabel: fairLabelMma,
          tipReason: tipReasonMma
        }, 'mma');

        if (rec?.tipId && mlResultMma.factorActive?.length && mlResultMma.direction) {
          await serverPost('/log-tip-factors', {
            tipId: rec.tipId,
            factors: mlResultMma.factorActive,
            predictedDir: mlResultMma.direction
          }, 'mma').catch(() => {});
        }

        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('mma')) continue;
          try { await sendDM(token, userId, tipMsg); } catch(_) {}
        }
        analyzedMma.set(key, { ts: now, tipSent: true });
        log('INFO', 'AUTO-MMA', `Tip enviada: ${tipTeam} @ ${tipOdd} | EV:${tipEV}% | ${tipConf}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch(e) {
      log('ERROR', 'AUTO-MMA', e.message);
    }
    setTimeout(loop, 30 * 60 * 1000);
  }
  loop();
}

// ── Tennis Auto-analysis loop ──
async function pollTennis() {
  const tennisConfig = SPORTS['tennis'];
  if (!tennisConfig?.enabled || !tennisConfig?.token) return;
  const token = tennisConfig.token;

  const TENNIS_INTERVAL = 4 * 60 * 60 * 1000; // Re-analisa a cada 4h

  async function loop() {
    try {
      const matches = await serverGet('/tennis-matches').catch(() => []);
      if (!Array.isArray(matches) || !matches.length) {
        setTimeout(loop, 30 * 60 * 1000); return;
      }

      log('INFO', 'AUTO-TENNIS', `${matches.length} partidas tênis com odds`);

      // Buscar rankings ESPN e dados do torneio atual em paralelo
      const rankings = await fetchEspnTennisRankings().catch(() => ({ atp: [], wta: [] }));
      const atpEvent = await fetchEspnTennisEvent('ATP').catch(() => null);
      const wtaEvent = await fetchEspnTennisEvent('WTA').catch(() => null);

      const now = Date.now();
      for (const match of matches) {
        const key = `tennis_${match.id}`;
        const prev = analyzedTennis.get(key);
        if (prev?.tipSent) continue;
        if (prev && (now - prev.ts < TENNIS_INTERVAL)) continue;

        const o = match.odds;
        if (!o?.t1 || !o?.t2) continue;

        const isLiveTennis = match.status === 'live';

        const matchTime = match.time ? new Date(match.time).toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit',
          hour: '2-digit', minute: '2-digit'
        }) : '—';

        const r1 = 1 / parseFloat(o.t1), r2 = 1 / parseFloat(o.t2);
        const totalVig = r1 + r2;
        const fairP1 = (r1 / totalVig * 100).toFixed(1);
        const fairP2 = (r2 / totalVig * 100).toFixed(1);
        const marginPct = ((totalVig - 1) * 100).toFixed(1);
        const o1f = parseFloat(o.t1), o2f = parseFloat(o.t2);
        const isFav1 = o1f < o2f;

        const key2 = match.sport_key || '';
        const isGrandSlam = ['aus_open', 'french_open', 'wimbledon', 'us_open'].some(k => key2.includes(k));
        const isMasters = ['indian_wells', 'miami', 'madrid', 'italian', 'canadian', 'cincinnati', 'shanghai', 'paris', 'monte'].some(k => key2.includes(k));
        const tour = key2.includes('_wta_') ? 'WTA' : 'ATP';
        const espnEvent = tour === 'WTA' ? wtaEvent : atpEvent;

        // Superfície: ESPN event tem priority, senão inferir pelo torneio
        const surface = espnEvent?.surface
          || (key2.includes('french') || key2.includes('monte') || key2.includes('madrid') || key2.includes('italian') ? 'saibro'
          : key2.includes('wimbledon') || key2.includes('halle') || key2.includes('queens') ? 'grama'
          : 'dura');
        const surfacePT = { saibro: 'Saibro (Clay)', grama: 'Grama', dura: 'Quadra dura' }[surface] || surface;

        const eventType = isGrandSlam ? `Grand Slam — best-of-5 (ATP) / best-of-3 (WTA)`
          : isMasters ? `Masters 1000 / WTA 1000`
          : `Torneio ${tour}`;

        // Rankings reais ESPN
        const rankList = tour === 'WTA' ? rankings.wta : rankings.atp;
        const rank1 = getTennisPlayerRank(rankList, match.team1);
        const rank2 = getTennisPlayerRank(rankList, match.team2);

        // Form recente no torneio atual via ESPN
        const form1 = espnEvent ? getTennisRecentForm(espnEvent.recentResults, match.team1) : null;
        const form2 = espnEvent ? getTennisRecentForm(espnEvent.recentResults, match.team2) : null;

        // ── Pré-filtro ML com ranking ESPN como prior ──
        const tennisEnrich = rankingToEnrich(rank1, rank2);
        const mlResultTennis = esportsPreFilter(match, o, tennisEnrich || { form1: null, form2: null, h2h: null, oddsMovement: null }, false, '', null);
        if (!mlResultTennis.pass) {
          log('INFO', 'AUTO-TENNIS', `Pré-filtro ML: edge insuficiente (${mlResultTennis.score.toFixed(1)}pp) para ${match.team1} vs ${match.team2}. Pulando IA.`);
          await new Promise(r => setTimeout(r, 500)); continue;
        }

        const hasModelDataTennis = mlResultTennis.factorCount > 0;
        // Fair odds sempre disponíveis: quando sem ranking, modelP1=impliedP1 (de-juice puro)
        const modelP1Tennis = (mlResultTennis.modelP1 * 100).toFixed(1);
        const modelP2Tennis = (mlResultTennis.modelP2 * 100).toFixed(1);
        const fairLabelTennis = hasModelDataTennis ? 'P modelo (ranking ESPN)' : 'Fair odds (de-juice, sem ranking ESPN)';

        // Montar seção de dados reais
        const dataSection = [
          rank1 ? `Ranking ${match.team1}: ${rank1}` : null,
          rank2 ? `Ranking ${match.team2}: ${rank2}` : null,
          form1 ? `Form ${match.team1} (torneio atual): ${form1}` : null,
          form2 ? `Form ${match.team2} (torneio atual): ${form2}` : null,
          espnEvent ? `Torneio em andamento: ${espnEvent.eventName}` : null
        ].filter(Boolean).join('\n');

        const hasRealData = !!(rank1 || rank2 || form1 || form2);

        const fairOddsLineTennis = hasModelDataTennis
          ? `${fairLabelTennis}: ${match.team1}=${modelP1Tennis}% | ${match.team2}=${modelP2Tennis}%\nP de-juiced bookie: ${match.team1}=${fairP1}% | ${match.team2}=${fairP2}%`
          : `${fairLabelTennis}: ${match.team1}=${modelP1Tennis}% | ${match.team2}=${modelP2Tennis}% (use como mínimo — sem ranking para ajustar o prior)`;

        const newsSectionTennis = await fetchMatchNews('tennis', match.team1, match.team2).catch(() => '');

        const prompt = `Você é um analista especializado em tênis profissional. Analise com rigor — prefira SEM_EDGE a inventar edge inexistente.

PARTIDA: ${match.team1} vs ${match.team2}
Torneio: ${match.league} | ${eventType}
Status: ${isLiveTennis ? 'AO VIVO' : 'PRÉ-JOGO'} | Superfície: ${surfacePT} | Data: ${matchTime} (BRT)

ODDS REAIS (${o.bookmaker || 'EU'}):
${match.team1}: ${o.t1} | ${match.team2}: ${o.t2}
Margem bookie: ${marginPct}%
${fairOddsLineTennis}
${isFav1 ? match.team1 : match.team2} é o favorito do mercado.

${dataSection ? `DADOS REAIS (ESPN):\n${dataSection}\n` : 'AVISO: sem dados ESPN disponíveis — use apenas conhecimento de treino confiável.\n'}${newsSectionTennis ? `${newsSectionTennis}\n` : ''}
INSTRUÇÕES:
1. Estime a probabilidade REAL de vitória de cada jogador com base em: ranking, superfície, H2H, form recente, estilo.
2. Compare sua estimativa com a ${fairLabelTennis} (${match.team1}=${modelP1Tennis}% | ${match.team2}=${modelP2Tennis}%):
   - Se sua estimativa para ${match.team1} > ${modelP1Tennis}%: edge em ${match.team1} (EV = (sua_prob/100 * ${o.t1}) - 1)
   - Se sua estimativa para ${match.team2} > ${modelP2Tennis}%: edge em ${match.team2} (EV = (sua_prob/100 * ${o.t2}) - 1)
3. Confiança (1-10): baseada em quão bem você conhece esses jogadores E nessa superfície.
   - Se não tiver certeza sobre ranking atual ou form real: máximo confiança 6 → SEM_EDGE.

DECISÃO:
- Edge real (EV ≥ +4%) E confiança ≥ 7: TIP_ML:[jogador]@[odd]|EV:[%]|STAKE:[1-3]u|CONF:[ALTA/MÉDIA/BAIXA]
- Caso contrário: SEM_EDGE

Máximo 200 palavras. Mostre seu raciocínio brevemente antes da decisão.`;

        log('INFO', 'AUTO-TENNIS', `Analisando: ${match.team1} vs ${match.team2} | ${surfacePT}${hasRealData ? ' [ESPN+]' : ''}`);
        analyzedTennis.set(key, { ts: now, tipSent: false });

        log('INFO', 'AUTO-TENNIS', `Analisando: ${match.team1} vs ${match.team2} | ${match.league}`);
        analyzedTennis.set(key, { ts: now, tipSent: false });

        let resp;
        try {
          resp = await serverPost('/claude', {
            model: 'deepseek-chat',
            max_tokens: 450,
            messages: [{ role: 'user', content: prompt }]
          }, null, { 'x-claude-key': AI_PROXY_KEY });
        } catch(e) {
          log('WARN', 'AUTO-TENNIS', `AI error: ${e.message}`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        const text = resp?.content?.map(b => b.text || '').join('') || '';
        const tipMatch2 = text.match(/TIP_ML:([^@]+)@([\d.]+)\|EV:([+-]?[\d.]+)%\|STAKE:([\d.]+)u?\|CONF:(ALTA|MÉDIA|BAIXA)/i);

        if (!tipMatch2) {
          log('INFO', 'AUTO-TENNIS', `Sem tip: ${match.team1} vs ${match.team2}`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        const tipPlayer = tipMatch2[1].trim();
        const tipOdd    = parseFloat(tipMatch2[2]);
        const tipEV     = parseFloat(tipMatch2[3]);
        const tipStake  = tipMatch2[4];
        const tipConf   = tipMatch2[5].toUpperCase();

        if (tipOdd < 1.30 || tipOdd > 5.00) {
          log('INFO', 'AUTO-TENNIS', `Gate odds: ${tipOdd} fora do range 1.30-5.00`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }
        if (tipEV < 4.0) {
          log('INFO', 'AUTO-TENNIS', `Gate EV: ${tipEV}% < 4%`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' }[tipConf] || '🟡';
        const surfaceEmoji = { saibro: '🟤', grama: '💚', dura: '🔵' }[surface] || '🎾';
        const grandSlamBadge = isGrandSlam ? ' 🏆' : isMasters ? ' ⭐' : '';

        const whyLineTennis = tipReasonTennis ? `\n🧠 Por quê: _${tipReasonTennis}_\n` : '\n';
        const tipMsg = `🎾 💰 *TIP TÊNIS${isLiveTennis ? ' (AO VIVO)' : ''}*\n` +
          `*${match.team1}* vs *${match.team2}*\n` +
          `📋 ${match.league}${grandSlamBadge}\n` +
          `${surfaceEmoji} ${surface.charAt(0).toUpperCase() + surface.slice(1)} | 🕐 ${matchTime} (BRT)\n\n` +
          whyLineTennis +
          `🎯 Aposta: *${tipPlayer}* @ *${tipOdd}*\n` +
          `📈 EV: *+${tipEV}%* | De-juice: ${tipPlayer === match.team1 ? fairP1 : fairP2}%\n` +
          `💵 Stake: *${tipStake}u*\n` +
          `${confEmoji} Confiança: *${tipConf}*\n\n` +
          `⚠️ _Aposte com responsabilidade._`;

        const pickIsT1 = norm(tipPlayer) === norm(match.team1);
        const modelPPick = pickIsT1 ? mlResultTennis.modelP1 : mlResultTennis.modelP2;

        const desiredUnitsTennis = parseFloat(String(tipStake)) || 0;
        const riskAdjTennis = await applyGlobalRisk('tennis', desiredUnitsTennis);
        if (!riskAdjTennis.ok) { log('INFO', 'RISK', `tennis: bloqueada (${riskAdjTennis.reason})`); await new Promise(r => setTimeout(r, 3000)); continue; }
        const tipStakeAdjTennis = String(riskAdjTennis.units.toFixed(1).replace(/\.0$/, ''));

        const rec = await serverPost('/record-tip', {
          matchId: String(match.id), eventName: match.league,
          p1: match.team1, p2: match.team2, tipParticipant: tipPlayer,
          odds: String(tipOdd), ev: String(tipEV), stake: tipStakeAdjTennis,
          confidence: tipConf, isLive: isLiveTennis, market_type: 'ML',
          modelP1: mlResultTennis.modelP1,
          modelP2: mlResultTennis.modelP2,
          modelPPick: modelPPick,
          modelLabel: fairLabelTennis,
          tipReason: tipReasonTennis
        }, 'tennis');

        if (rec?.tipId && mlResultTennis.factorActive?.length && mlResultTennis.direction) {
          await serverPost('/log-tip-factors', {
            tipId: rec.tipId,
            factors: mlResultTennis.factorActive,
            predictedDir: mlResultTennis.direction
          }, 'tennis').catch(() => {});
        }

        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('tennis')) continue;
          try { await sendDM(token, userId, tipMsg); } catch(_) {}
        }
        analyzedTennis.set(key, { ts: now, tipSent: true });
        log('INFO', 'AUTO-TENNIS', `Tip enviada: ${tipPlayer} @ ${tipOdd} | EV:${tipEV}% | ${tipConf}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch(e) {
      log('ERROR', 'AUTO-TENNIS', e.message);
    }
    setTimeout(loop, 20 * 60 * 1000); // verifica a cada 20min
  }
  loop();
}

// ── Football Auto-analysis loop ──
async function pollFootball() {
  const fbConfig = SPORTS['football'];
  if (!fbConfig?.enabled || !fbConfig?.token) return;
  const token = fbConfig.token;

  const { calcFootballScore } = require('./lib/football-ml');

  const FOOTBALL_INTERVAL = 6 * 60 * 60 * 1000;
  const EV_THRESHOLD   = parseFloat(process.env.FOOTBALL_EV_THRESHOLD  || '5.0');
  const DRAW_MIN_ODDS  = parseFloat(process.env.FOOTBALL_DRAW_MIN_ODDS  || '2.80');

  // Formata array de resultados ['W','D','L',...] → string "WDLWW"
  function fmtForm(arr) {
    if (!Array.isArray(arr) || !arr.length) return 'N/D';
    return arr.slice(0, 5).join('');
  }

  async function loop() {
    try {
      const matches = await serverGet('/football-matches').catch(() => []);
      if (!Array.isArray(matches) || !matches.length) {
        setTimeout(loop, 30 * 60 * 1000); return;
      }
      log('INFO', 'AUTO-FOOTBALL', `${matches.length} partidas futebol com odds (modo odds-only)`);

      const now = Date.now();
      for (const match of matches) {
        const key = `football_${match.id}`;
        const prev = analyzedFootball.get(key);
        if (prev?.tipSent) continue;
        if (prev && (now - prev.ts < FOOTBALL_INTERVAL)) continue;

        const o = match.odds;
        if (!o?.h || !o?.d || !o?.a) continue;

        const oH = parseFloat(o.h), oD = parseFloat(o.d), oA = parseFloat(o.a);
        if (!oH || !oD || !oA || oH <= 1 || oD <= 1 || oA <= 1) continue;
        if (Math.min(oH, oA) > 5.0) continue;

        const rawH = 1/oH, rawD = 1/oD, rawA = 1/oA;
        const overround = rawH + rawD + rawA;
        const mktH = (rawH/overround*100).toFixed(1);
        const mktD = (rawD/overround*100).toFixed(1);
        const mktA = (rawA/overround*100).toFixed(1);
        const marginPct = ((overround - 1) * 100).toFixed(1);

        const matchTime = match.time ? new Date(match.time).toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit',
          hour: '2-digit', minute: '2-digit'
        }) : '—';

        const oddsInput = { h: oH, d: oD, a: oA, ou25: o.ou25 ? { over: parseFloat(o.ou25.over), under: parseFloat(o.ou25.under) } : null };

        // ── Pré-filtro rápido com só odds (sem chamadas externas) ──
        // Descarta partidas onde nenhum mercado tem EV > 0 mesmo ignorando margem
        const rawEvH = (0.5 * oH) - 1; // estimativa trivial
        if (rawEvH < -0.30 && (0.5 * oD - 1) < -0.30 && (0.5 * oA - 1) < -0.30) {
          // odds tão desfavoráveis que não vale nem buscar dados
          await new Promise(r => setTimeout(r, 500)); continue;
        }

        // Modo odds-only: sem enriquecimento externo
        const fixtureInfo = null;
        const homeFormData = null, awayFormData = null;
        const h2hData = { results: [] };
        const standingsData = {};
        const homeFatigue = 7, awayFatigue = 7;

        // ── ML com dados reais (ou nulls se API indisponível) ──
        const homeStandings = fixtureInfo ? standingsData[fixtureInfo.homeId] : null;
        const awayStandings = fixtureInfo ? standingsData[fixtureInfo.awayId] : null;

        const mlScore = calcFootballScore(
          {
            form:         homeFormData?.form         || null,
            homeForm:     homeFormData?.homeForm      || null,
            goalsFor:     homeFormData?.goalsFor      ?? null,
            goalsAgainst: homeFormData?.goalsAgainst  ?? null,
            position:     homeStandings?.position     ?? null,
            fatigue:      homeFatigue
          },
          {
            form:         awayFormData?.form         || null,
            awayForm:     awayFormData?.awayForm      || null,
            goalsFor:     awayFormData?.goalsFor      ?? null,
            goalsAgainst: awayFormData?.goalsAgainst  ?? null,
            position:     awayStandings?.position     ?? null,
            fatigue:      awayFatigue
          },
          h2hData,
          oddsInput,
          { leagueId: fixtureInfo?.leagueId ?? null }
        );

        // Se temos dados reais e o ML diz sem edge → pular (economiza chamada de IA)
        if (fixtureInfo && !mlScore.pass) {
          log('INFO', 'AUTO-FOOTBALL', `ML sem edge: ${match.team1} vs ${match.team2} | best EV: ${mlScore.bestEv}%`);
          analyzedFootball.set(key, { ts: now, tipSent: false });
          await new Promise(r => setTimeout(r, 1000)); continue;
        }

        // ── Montar contexto para IA ──
        const ou25Line = o.ou25
          ? `Over 2.5: ${o.ou25.over} | Under 2.5: ${o.ou25.under}`
          : 'Não disponível';

        // Bloco de contexto quantitativo (só inclui se temos dados reais)
        let contextBlock = '';
        if (fixtureInfo && homeFormData && awayFormData) {
          const hPos  = homeStandings ? `${homeStandings.position}º (${homeStandings.points}pts, ${homeStandings.played}J)` : 'N/D';
          const aPos  = awayStandings ? `${awayStandings.position}º (${awayStandings.points}pts, ${awayStandings.played}J)` : 'N/D';
          const h2hSummary = h2hData.results.length
            ? h2hData.results.slice(0, 5).map(r => `${r.home} ${r.homeGoals}-${r.awayGoals} ${r.away} (${r.date?.slice(0,10) || '?'})`).join('\n  ')
            : 'Sem H2H recente';
          contextBlock = `
DADOS QUANTITATIVOS (API-Football):
${match.team1} (casa):
  Forma últimos 5: ${fmtForm(homeFormData.form)} | Em casa: ${fmtForm(homeFormData.homeForm)}
  Gols/jogo: ${homeFormData.goalsFor?.toFixed(2) ?? 'N/D'} marcados | ${homeFormData.goalsAgainst?.toFixed(2) ?? 'N/D'} sofridos
  Tabela: ${hPos} | Descanso: ${homeFatigue} dias

${match.team2} (fora):
  Forma últimos 5: ${fmtForm(awayFormData.form)} | Fora: ${fmtForm(awayFormData.awayForm)}
  Gols/jogo: ${awayFormData.goalsFor?.toFixed(2) ?? 'N/D'} marcados | ${awayFormData.goalsAgainst?.toFixed(2) ?? 'N/D'} sofridos
  Tabela: ${aPos} | Descanso: ${awayFatigue} dias

H2H (últimos ${Math.min(h2hData.results.length, 5)} jogos):
  ${h2hSummary}

MODELO QUANTITATIVO (pré-análise):
  Prob. modelo: Casa ${mlScore.modelH}% | Empate ${mlScore.modelD}% | Fora ${mlScore.modelA}%
  Prob. mercado: Casa ${mlScore.mktH}% | Empate ${mlScore.mktD}% | Fora ${mlScore.mktA}%
  Home advantage desta liga: ${mlScore.homeAdv}pp
  Over 2.5 (Poisson): ${mlScore.over25Prob ?? 'N/D'}% | λ casa: ${mlScore.lambdaHome ?? 'N/D'} | λ fora: ${mlScore.lambdaAway ?? 'N/D'}
  Melhor edge quantitativo: ${mlScore.direction} @ ${mlScore.bestOdd} (EV ${mlScore.bestEv}%)
`;
        }

        const newsSection = await fetchMatchNews('football', match.team1, match.team2).catch(() => '');

        const prompt = `Você é um analista especializado em futebol de ligas secundárias (Série B/C Brasil, Sul-America, League One/Two, 3. Liga). Analise com rigor — prefira SEM_EDGE a inventar edge.

PARTIDA: ${match.team1} (casa) vs ${match.team2} (fora)
Liga: ${match.league}
Data/Hora: ${matchTime} (BRT)

ODDS REAIS (${o.bookmaker || 'EU'}):
Casa: ${oH} → de-juiced: ${mktH}% | Empate: ${oD} → ${mktD}% | Fora: ${oA} → ${mktA}%
Margem bookie: ${marginPct}%
${fixtureInfo && contextBlock ? '' : `Fair odds (de-juice, sem dados quantitativos): Casa=${mktH}% | Empate=${mktD}% | Fora=${mktA}% — use como referência mínima; sua estimativa deve superar ≥8pp para ter edge real.\n`}Totais: ${ou25Line}
${contextBlock}${newsSection ? `\n${newsSection}\n` : ''}
INSTRUÇÕES:
1. ${fixtureInfo ? 'Use os dados quantitativos acima como base. Complemente com seu conhecimento contextual (lesões, motivação, histórico recente não capturado).' : 'Use seu conhecimento sobre os times nessa liga. Se não conhecer os times, seja conservador na estimativa de probabilidade e na confiança.'}
2. Estime probabilidades reais (home%, draw%, away%) somando 100%.
3. Calcule EV: EV = (prob/100 × odd) − 1 × 100
   Casa: (X/100 × ${oH} − 1) × 100 | Empate: (X/100 × ${oD} − 1) × 100 | Fora: (X/100 × ${oA} − 1) × 100
4. Para Over/Under 2.5, use médias de gols${fixtureInfo ? ' (já calculadas acima)' : ''} + contexto tático.
5. Confiança (1-10): ${fixtureInfo ? 'reflita incerteza residual após dados quantitativos.' : 'reflita quanto você conhece os times e o quão claro é o edge. Confiança 7+ só se o edge for real e você tiver base para estimar.'}
   - Empate com odds < ${DRAW_MIN_ODDS}? Raramente tem valor.

DECISÃO (melhor opção apenas):
- Edge (EV ≥ +${EV_THRESHOLD}%) E confiança ≥ 7:
  TIP_FB:[mercado]:[seleção]@[odd]|EV:[%]|STAKE:[1-3]u|CONF:[ALTA/MÉDIA/BAIXA]
  Mercados: 1X2_H, 1X2_D, 1X2_A, OVER_2.5, UNDER_2.5
- Caso contrário: SEM_EDGE

Máximo 200 palavras.`;

        log('INFO', 'AUTO-FOOTBALL', `Analisando: ${match.team1} vs ${match.team2} | ${match.league}${fixtureInfo ? ' [com dados]' : ' [sem dados]'}`);
        analyzedFootball.set(key, { ts: now, tipSent: false });

        let resp;
        try {
          resp = await serverPost('/claude', {
            model: 'deepseek-chat',
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }]
          }, null, { 'x-claude-key': AI_PROXY_KEY });
        } catch(e) {
          log('WARN', 'AUTO-FOOTBALL', `AI error: ${e.message}`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        const text = resp?.content?.map(b => b.text || '').join('') || '';
        const tipMatch = text.match(/TIP_FB:([\w_.]+):([^@]+)@([\d.]+)\|EV:([+-]?[\d.]+)\|STAKE:([\d.]+)u?\|CONF:(ALTA|MÉDIA|BAIXA)/i);

        if (!tipMatch) {
          log('INFO', 'AUTO-FOOTBALL', `Sem tip: ${match.team1} vs ${match.team2}`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        const tipMarket = tipMatch[1].toUpperCase();
        const tipTeam   = tipMatch[2].trim();
        const tipOdd    = parseFloat(tipMatch[3]);
        const tipEV     = parseFloat(tipMatch[4]);
        const tipStake  = tipMatch[5];
        const tipConf   = tipMatch[6].toUpperCase();

        if (tipOdd < 1.30 || tipOdd > 6.00) {
          log('INFO', 'AUTO-FOOTBALL', `Gate odds: ${tipOdd} fora do range 1.30-6.00`);
          await new Promise(r => setTimeout(r, 2000)); continue;
        }
        if (tipEV < EV_THRESHOLD) {
          log('INFO', 'AUTO-FOOTBALL', `Gate EV: ${tipEV}% < ${EV_THRESHOLD}%`);
          await new Promise(r => setTimeout(r, 2000)); continue;
        }
        if (tipMarket === '1X2_D' && tipOdd < DRAW_MIN_ODDS) {
          log('INFO', 'AUTO-FOOTBALL', `Gate draw odds: ${tipOdd} < ${DRAW_MIN_ODDS}`);
          await new Promise(r => setTimeout(r, 2000)); continue;
        }

        const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' }[tipConf] || '🟡';
        const marketLabel = {
          '1X2_H':    `⚽ Casa — *${match.team1}*`,
          '1X2_D':    `🤝 Empate`,
          '1X2_A':    `✈️ Fora — *${match.team2}*`,
          'OVER_2.5': `📈 Over 2.5 gols`,
          'UNDER_2.5':`📉 Under 2.5 gols`
        }[tipMarket] || tipMarket;

        const probMkt = tipMarket === '1X2_H' ? mktH : tipMarket === '1X2_D' ? mktD : tipMarket === '1X2_A' ? mktA : '—';
        const probMdl = tipMarket === '1X2_H' ? mlScore.modelH : tipMarket === '1X2_D' ? mlScore.modelD : tipMarket === '1X2_A' ? mlScore.modelA : null;

        const tipMsg = `⚽ 💰 *TIP FUTEBOL*\n` +
          `*${match.team1}* vs *${match.team2}*\n` +
          `📋 ${match.league}\n` +
          `🕐 ${matchTime} (BRT)\n\n` +
          `🎯 Aposta: ${marketLabel} @ *${tipOdd}*\n` +
          `📈 EV: *+${tipEV}%* | Mercado: ${probMkt}%${probMdl ? ` | Modelo: ${probMdl}%` : ''}\n` +
          `💵 Stake: *${tipStake}u*\n` +
          `${confEmoji} Confiança: *${tipConf}*\n` +
          (fixtureInfo && homeFormData ? `📊 Forma: ${fmtForm(homeFormData.form)} vs ${fmtForm(awayFormData?.form)}\n` : '') +
          `\n⚠️ _Aposte com responsabilidade._`;

        const recordMatchId = fixtureInfo ? `fb_${fixtureInfo.fixtureId}` : String(match.id);

        const desiredUnitsFb = parseFloat(String(tipStake)) || 0;
        const riskAdjFb = await applyGlobalRisk('football', desiredUnitsFb);
        if (!riskAdjFb.ok) { log('INFO', 'RISK', `football: bloqueada (${riskAdjFb.reason})`); await new Promise(r => setTimeout(r, 2000)); continue; }
        const tipStakeAdjFb = String(riskAdjFb.units.toFixed(1).replace(/\.0$/, ''));

        await serverPost('/record-tip', {
          matchId: recordMatchId, eventName: match.league,
          p1: match.team1, p2: match.team2, tipParticipant: tipTeam,
          odds: String(tipOdd), ev: String(tipEV), stake: tipStakeAdjFb,
          confidence: tipConf, isLive: false, market_type: tipMarket
        }, 'football');

        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('football')) continue;
          try { await sendDM(token, userId, tipMsg); } catch(_) {}
        }
        analyzedFootball.set(key, { ts: now, tipSent: true });
        log('INFO', 'AUTO-FOOTBALL', `Tip enviada: ${tipTeam} @ ${tipOdd} | ${tipMarket} | EV:${tipEV}% | ${tipConf}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch(e) {
      log('ERROR', 'AUTO-FOOTBALL', e.message);
    }
    setTimeout(loop, 30 * 60 * 1000);
  }
  loop();
}

// ── Start ──
log('INFO', 'BOOT', 'SportsEdge Bot iniciando...');
log('INFO', 'BOOT', `ENV: ESPORTS_ENABLED=${process.env.ESPORTS_ENABLED || '(não definida)'}`);
log('INFO', 'BOOT', `ENV: TELEGRAM_TOKEN_ESPORTS=${process.env.TELEGRAM_TOKEN_ESPORTS ? '✅ definida' : '❌ AUSENTE'}`);
log('INFO', 'BOOT', `ENV: DEEPSEEK_API_KEY=${process.env.DEEPSEEK_API_KEY ? '✅ definida' : '❌ AUSENTE'}`);
log('INFO', 'BOOT', `ENV: CLAUDE_API_KEY=${process.env.CLAUDE_API_KEY ? '✅ definida' : '❌ AUSENTE (fallback)'}`);
const oddsKeyPresent = !!(process.env.ODDS_API_KEY || process.env.ODDSPAPI_KEY || process.env.ODDS_PAPI_KEY || process.env.ESPORTS_ODDS_KEY);
log('INFO', 'BOOT', `ENV: ODDS_API_KEY=${oddsKeyPresent ? '✅ definida' : '❌ AUSENTE — odds indisponíveis'}`);
log('INFO', 'BOOT', `Sports carregados: ${JSON.stringify(Object.entries(SPORTS).map(([k,v]) => ({id: k, enabled: v.enabled, hasToken: !!v.token})))}`);

(async () => {
  await loadSubscribedUsers();

  // Garantir que admins estão inscritos em todos os sports ativos
  const allEnabledSports = Object.entries(SPORTS).filter(([,v]) => v.enabled).map(([k]) => k);
  for (const adminId of ADMIN_IDS) {
    const id = parseInt(adminId);
    if (!id) continue;
    const existing = stmts.getUser.get(id);
    const prefs = JSON.stringify(allEnabledSports);
    if (!existing) {
      stmts.upsertUser.run(id, 'admin', 1, prefs);
      log('INFO', 'BOOT', `Admin ${id} inserido no banco com subscribed=1`);
    } else if (!existing.subscribed) {
      stmts.upsertUser.run(id, existing.username || 'admin', 1, prefs);
      log('INFO', 'BOOT', `Admin ${id} reativado (subscribed=1)`);
    }
    if (!subscribedUsers.has(id)) subscribedUsers.set(id, new Set());
    for (const s of allEnabledSports) subscribedUsers.get(id).add(s);
    log('INFO', 'BOOT', `Admin ${id} inscrito em: ${allEnabledSports.join(', ')}`);
  }

  await loadExistingTips();
  
  // Start polling for each enabled sport
  for (const [sport, config] of Object.entries(SPORTS)) {
    if (!config.enabled || !config.token) {
      log('WARN', 'BOOT', `${sport}: disabled or no token`);
      continue;
    }
    
    // Verify token
    const r = await tgRequest(config.token, 'getMe', {});
    if (r.ok) {
      log('INFO', 'BOOT', `${sport}: ${r.result.first_name} (@${r.result.username})`);
      poll(config.token, sport);
      bots[sport] = config.token;
    } else {
      log('ERROR', 'BOOT', `${sport}: Token inválido`);
    }
  }

  // MMA polling (independente do loop de sports genérico)
  pollMma();

  // Football polling
  pollFootball();

  // Tennis polling
  pollTennis();

  // Background tasks
  setTimeout(() => runAutoAnalysis().catch(e => log('ERROR', 'AUTO', e.message)), 15 * 1000); // 1ª análise 15s após boot
  setInterval(() => runAutoAnalysis().catch(e => log('ERROR', 'AUTO', e.message)), 6 * 60 * 1000);
  setInterval(() => settleCompletedTips().catch(e => log('ERROR', 'SETTLE', e.message)), SETTLEMENT_INTERVAL);
  setInterval(() => checkLineMovement().catch(e => log('ERROR', 'LINE', e.message)), LINE_CHECK_INTERVAL);
  if (SPORTS.esports?.enabled) {
    setInterval(() => checkLiveNotifications().catch(e => log('ERROR', 'NOTIFY', e.message)), LIVE_CHECK_INTERVAL);
    setInterval(() => checkCLV().catch(e => log('ERROR', 'CLV', e.message)), 5 * 60 * 1000);
    setInterval(() => refreshOpenTips().catch(() => {}), 10 * 60 * 1000);
    // Auto-patch meta: verifica novo patch a cada 12h via ddragon
    fetchLatestPatchMeta().catch(e => log('WARN', 'PATCH', e.message)); // executa imediatamente no boot
    setInterval(() => fetchLatestPatchMeta().catch(e => log('WARN', 'PATCH', e.message)), PATCH_AUTO_FETCH_INTERVAL);
  }
  
  log('INFO', 'BOOT', `Bots ativos: ${Object.keys(bots).join(', ')}`);
  log('INFO', 'BOOT', 'Pronto! Mande /start em cada bot no Telegram');
})();

// Função para registrar o Closing Line Value (CLV) antes do jogo
// CLV só é válido se registrado próximo ao fechamento da linha (< 1h antes do início)
async function checkCLV() {
  if (subscribedUsers.size === 0) return;
  try {
    const unsettled = await serverGet('/unsettled-tips', 'esports');
    if (!Array.isArray(unsettled)) return;
    const now = Date.now();
    // Busca partidas para cruzar horário de início
    const lolMatches = await serverGet('/lol-matches').catch(() => []);
    const matchTimeMap = {};
    if (Array.isArray(lolMatches)) {
      for (const m of lolMatches) {
        if (m.time) {
          const k1 = norm(m.team1 || '') + '_' + norm(m.team2 || '');
          const k2 = norm(m.team2 || '') + '_' + norm(m.team1 || '');
          matchTimeMap[k1] = new Date(m.time).getTime();
          matchTimeMap[k2] = new Date(m.time).getTime();
        }
      }
    }
    for (const tip of unsettled) {
      if (tip.clv_odds) continue; // já registrado
      // Verifica se partida começa em < 1h (janela ideal para CLV)
      const tipKey = norm(tip.participant1 || '') + '_' + norm(tip.participant2 || '');
      const matchStart = matchTimeMap[tipKey] || 0;
      const timeToMatch = matchStart > 0 ? matchStart - now : null;
      if (timeToMatch === null || timeToMatch > 60 * 60 * 1000 || timeToMatch < -5 * 60 * 1000) continue;
      const o = await serverGet(`/odds?team1=${encodeURIComponent(tip.participant1)}&team2=${encodeURIComponent(tip.participant2)}`).catch(() => null);
      if (o && parseFloat(o.t1) > 1) {
        const clvOdds = norm(tip.tip_participant) === norm(tip.participant1) ? o.t1 : o.t2;
        await serverPost('/update-clv', { matchId: tip.match_id, clvOdds }, 'esports').catch(() => {});
        log('INFO', 'CLV', `Registrado CLV ${clvOdds} para ${tip.participant1} vs ${tip.participant2}`);
      }
    }
  } catch(e) {}
}

// Reanalisa tips pendentes: atualiza odds/EV no DB e envia update no Telegram.
// Não chama IA: mantém p implícita da tip original e recalcula EV com odds atuais.
async function refreshOpenTips() {
  try {
    const enabledSports = Object.entries(SPORTS)
      .filter(([_, s]) => s && s.enabled && s.token)
      .map(([id]) => id);

    for (const sport of enabledSports) {
      const unsettled = await serverGet('/unsettled-tips?days=30', sport).catch(() => []);
      if (!Array.isArray(unsettled) || unsettled.length === 0) continue;

      const minMovePct = parseFloat(process.env.TIP_UPDATE_MIN_MOVE_PCT || '3'); // 3%
      const now = Date.now();

      for (const tip of unsettled) {
        const p1 = tip.participant1 || '';
        const p2 = tip.participant2 || '';
        const pick = tip.tip_participant || '';
        const oldOdds = parseFloat(tip.odds) || 0;
        const oldEv = parseFloat(tip.ev) || 0;
        if (!p1 || !p2 || !pick || oldOdds <= 1) continue;

        let currentOdds = null;
        if (sport === 'esports') {
          const o = await serverGet(`/odds?team1=${encodeURIComponent(p1)}&team2=${encodeURIComponent(p2)}`).catch(() => null);
          if (o && parseFloat(o.t1) > 1) {
            currentOdds = norm(pick) === norm(p1) ? parseFloat(o.t1) : parseFloat(o.t2);
          }
        } else {
          // fallback: sem odds atuais padronizadas por esporte aqui
          continue;
        }

        if (!currentOdds || !isFinite(currentOdds) || currentOdds <= 1) continue;

        const movePct = Math.abs((currentOdds - oldOdds) / oldOdds) * 100;
        if (movePct < minMovePct) continue;

        // p implícita do EV original: p = (1 + EV/100) / odds
        const p = Math.max(0.01, Math.min(0.99, (1 + oldEv / 100) / oldOdds));
        const newEv = ((p * currentOdds) - 1) * 100;

        // Dedup: notificação deve ser mostrada apenas 1 vez por tip
        const key = `${sport}|${String(tip.match_id || '')}|${norm(pick)}|${String(tip.market_type || 'ML')}`;
        const cachedTs = tipUpdateNotifyCache.get(key) || 0;
        const dbTs = tip.last_notified_at ? new Date(String(tip.last_notified_at)).getTime() : 0;
        const everNotified = !!cachedTs || (!!dbTs && isFinite(dbTs));
        const shouldNotify = !everNotified;

        await serverPost('/update-open-tip', {
          matchId: tip.match_id,
          currentOdds: currentOdds,
          currentEV: parseFloat(newEv.toFixed(2)),
          currentConfidence: tip.confidence || null,
          markNotified: shouldNotify ? 1 : 0
        }, sport).catch(() => null);

        if (!shouldNotify) continue;

        tipUpdateNotifyCache.set(key, now);
        // NÃO limpar: 1x por tip (evita repetir)

        // Notifica inscritos do esporte
        const msg =
          `🔄 *Atualização Tip (em andamento)*\n\n` +
          `🎮 *${p1} vs ${p2}*\n` +
          `✅ Pick: *${pick}*\n` +
          `📈 Odds: *${oldOdds.toFixed(2)}* → *${currentOdds.toFixed(2)}* (${movePct >= 0 ? '+' : ''}${movePct.toFixed(1)}%)\n` +
          `🧮 EV (recalc): *${newEv >= 0 ? '+' : ''}${newEv.toFixed(2)}%*\n` +
          `🕒 ${new Date(now).toLocaleString('pt-BR')}`;

        for (const [userId, prefs] of subscribedUsers.entries()) {
          if (prefs && prefs.has && prefs.has(sport)) {
            await sendDM(SPORTS[sport].token, userId, msg).catch(() => {});
          }
        }
      }
    }
  } catch(_) {}
}

module.exports = { bots, subscribedUsers };
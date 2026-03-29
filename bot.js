require('dotenv').config({ override: true });
const https = require('https');
const http = require('http');
const initDatabase = require('./lib/database');
const { SPORTS, getSportById, getSportByToken, getTokenToSportMap } = require('./lib/sports');
const { log, calcKelly, fuzzyName, fmtDate, fmtDateTime, httpGet, httpsPost, safeParse } = require('./lib/utils');

const SERVER = 'localhost';
const PORT = parseInt(process.env.SERVER_PORT) || 3000;
const ADMIN_IDS = new Set((process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean));
const CLAUDE_KEY = process.env.CLAUDE_API_KEY;

if (!CLAUDE_KEY) {
  console.error('❌ Configure CLAUDE_API_KEY no .env');
  process.exit(1);
}

const DB_PATH = process.env.DB_PATH || 'sportsedge.db';
const { db, stmts } = initDatabase(DB_PATH);

// ── Bot Instances ──
const bots = {};
const tokenToSport = getTokenToSportMap();
const subscribedUsers = new Map(); // userId → Set<sport>

// Auto-analysis state
const analyzedMatches = new Map();
const AUTO_ANALYZE_INTERVAL = 6 * 60 * 60 * 1000;
let lastAutoAnalyze = 0;

// Settlement
const SETTLEMENT_INTERVAL = 30 * 60 * 1000;
let lastSettlementCheck = 0;

// Line movement
const lineAlerted = new Map();
const LINE_CHECK_INTERVAL = 30 * 60 * 1000;
let lastLineCheck = 0;

// Late replacement
const REPLACEMENT_INTERVAL = 2 * 60 * 60 * 1000;
let lastReplacementCheck = 0;

// Live notifications (esports)
const notifiedMatches = new Map();
let lastLiveCheck = 0;
const LIVE_CHECK_INTERVAL = 60 * 1000; // 1 minute
const RE_ANALYZE_INTERVAL = 10 * 60 * 1000; // 10 min between re-analyses of same live match

// MMA event-day notifications
const notifiedMMAEvents = new Map();
let lastMMADayCheck = 0;
const MMA_DAY_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

// Tennis match-start notifications
const notifiedTennisStarts = new Map();
let lastTennisStartCheck = 0;
const TENNIS_START_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Patch meta alert
let lastPatchAlert = 0;
const PATCH_ALERT_INTERVAL = 24 * 60 * 60 * 1000;

// MMA phase tracking — separate from esports analyzedMatches
const analyzedFights = new Map(); // fightId → { ts, phase: 'early'|'final' }

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
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function serverPost(path, body, sport, extraHeaders) {
  return new Promise((resolve, reject) => {
    const s = JSON.stringify(body);
    const sportParam = sport ? `?sport=${sport}` : '';
    const req = http.request({
      hostname: SERVER,
      port: PORT,
      path: path + sportParam,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(s),
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

// ── Sport-specific Menus ──
function getMenu(sport) {
  return kb([['🔔 Notificações', '📊 Tracking'], ['❓ Ajuda']]);
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

// ── Auto Analysis (esports: live every 3min; MMA: upcoming 6h with phases) ──
async function runAutoAnalysis() {
  const now = Date.now();

  // ── ESPORTS: Analyze LIVE matches every RE_ANALYZE_INTERVAL ──
  const esportsConfig = SPORTS['esports'];
  if (esportsConfig?.enabled) {
    try {
      const [lolRaw, dotaRaw] = await Promise.all([
        serverGet('/lol-matches').catch(() => []),
        serverGet('/dota-matches').catch(() => [])
      ]);
      const lolLive = Array.isArray(lolRaw) ? lolRaw.filter(m => m.status === 'live') : [];
      const dotaLive = Array.isArray(dotaRaw) ? dotaRaw.filter(m => m.status === 'live') : [];
      const allLive = [...lolLive, ...dotaLive];
      log('INFO', 'AUTO', `Esports: ${lolRaw?.length||0} LoL, ${dotaRaw?.length||0} Dota (${allLive.length} ao vivo) | inscritos=${subscribedUsers.size}`);

      for (const match of allLive) {
        const matchKey = `${match.game}_${match.id}`;
        const prev = analyzedMatches.get(matchKey);
        if (prev && (now - prev.ts < RE_ANALYZE_INTERVAL)) continue;

        log('INFO', 'AUTO', `Esports: ${match.team1} vs ${match.team2} (${match.league})`);
        const result = await autoAnalyzeMatch(esportsConfig.token, match);
        analyzedMatches.set(matchKey, { ts: now, tipSent: prev?.tipSent || false });

        if (!result) continue;
        const hasRealOdds = !!(result.o?.t1 && parseFloat(result.o.t1) > 1);

        if (result.tipMatch && hasRealOdds) {
          const tipTeam = result.tipMatch[1].trim();
          const tipOdd = result.tipMatch[2].trim();
          const tipEV = result.tipMatch[3].trim();
          const tipStake = calcKelly(tipEV, tipOdd);
          const gameIcon = match.game === 'lol' ? '⚽' : '🛡️';

          await serverPost('/record-tip', {
            matchId: String(match.id), eventName: match.league,
            p1: match.team1, p2: match.team2, tipParticipant: tipTeam,
            odds: tipOdd, ev: tipEV, stake: tipStake,
            confidence: result.tipMatch[5]?.trim() || 'MÉDIA', isLive: result.hasLiveStats
          }, 'esports');

          const tipMsg = `${gameIcon} 💰 *TIP ML AUTOMÁTICA*\n` +
            `*${match.team1}* ${match.score1}-${match.score2} *${match.team2}*\n\n` +
            `🎯 Aposta: *${tipTeam}* ML @ *${tipOdd}*\n` +
            `📈 EV: *${tipEV}*\n💵 Stake: *${tipStake}* _(¼ Kelly)_\n` +
            `📋 ${match.league}\n` +
            `_${result.hasLiveStats ? '📊 Baseado em dados ao vivo' : '📋 Análise pré-jogo'}_\n\n` +
            `⚠️ _Aposte com responsabilidade._`;

          for (const [userId, prefs] of subscribedUsers) {
            if (!prefs.has('esports')) continue;
            try { await sendDM(esportsConfig.token, userId, tipMsg); }
            catch(e) { if (e.message?.includes('403')) subscribedUsers.delete(userId); }
          }
          analyzedMatches.set(matchKey, { ts: now, tipSent: true });
          log('INFO', 'AUTO-TIP', `Esports: ${tipTeam} @ ${tipOdd}`);
        } else if (result.fairOdds && !prev?.tipSent) {
          const fo = result.fairOdds;
          const fo1 = parseFloat(fo[2]).toFixed(2), fo2 = parseFloat(fo[4]).toFixed(2);
          const gameIcon = match.game === 'lol' ? '⚽' : '🛡️';
          const fairMsg = `${gameIcon} 💡 *ODDS DE REFERÊNCIA*\n` +
            `*${match.team1}* vs *${match.team2}*\n_${match.league}_\n\n` +
            `• *${fo[1].trim()}:* *${fo1}*\n• *${fo[3].trim()}:* *${fo2}*\n\n` +
            `💡 _Odds ACIMA desses valores = +EV_\n⚠️ _Aposte com responsabilidade._`;
          for (const [userId, prefs] of subscribedUsers) {
            if (!prefs.has('esports')) continue;
            try { await sendDM(esportsConfig.token, userId, fairMsg); }
            catch(e) { if (e.message?.includes('403')) subscribedUsers.delete(userId); }
          }
          analyzedMatches.set(matchKey, { ts: now, tipSent: true });
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      // Clean old esports analyses (> 3h)
      const cutoff3h = now - 3 * 60 * 60 * 1000;
      for (const [k, v] of analyzedMatches) {
        if (v.ts < cutoff3h) analyzedMatches.delete(k);
      }
    } catch(e) {
      log('ERROR', 'AUTO-ESPORTS', e.message);
    }
  }

  // ── MMA: Analyze upcoming fights every 6h with phase tracking ──
  const mmaConfig = SPORTS['mma'];
  if (mmaConfig?.enabled && now - lastAutoAnalyze >= AUTO_ANALYZE_INTERVAL) {
    lastAutoAnalyze = now;
    try {
      const fights = await serverGet('/upcoming-fights?days=3', 'mma');
      if (!Array.isArray(fights) || !fights.length) return;
      log('INFO', 'AUTO-MMA', `${fights.length} lutas nos próximos 3 dias`);

      for (const fight of fights) {
        const key = fight.id;
        const eventMs = new Date((fight.event_date || '') + 'T00:00:00').getTime();
        const hoursToEvent = (eventMs - now) / 3600000;
        if (isNaN(hoursToEvent) || hoursToEvent > 48 || hoursToEvent < -2) continue;

        const entry = analyzedFights.get(key);
        if (entry) {
          // Re-análise pós-pesagem: analisou cedo (>24h) e agora estamos dentro de 24h
          if (entry.phase === 'early' && hoursToEvent <= 24) {
            log('INFO', 'AUTO-MMA', `Re-análise pós-pesagem: ${fight.participant1_name} vs ${fight.participant2_name}`);
            analyzedFights.delete(key);
          } else {
            continue;
          }
        }

        const phase = hoursToEvent > 24 ? 'early' : 'final';
        log('INFO', 'AUTO-MMA', `Analisando ${fight.participant1_name} vs ${fight.participant2_name} [${phase}]`);

        const [p1Stats, p2Stats, odds, form1, form2, h2h] = await Promise.all([
          fight.participant1_url
            ? serverGet(`/athlete?url=${encodeURIComponent(fight.participant1_url)}`, 'mma').catch(() => null)
            : serverGet(`/athlete?name=${encodeURIComponent(fight.participant1_name)}`, 'mma').catch(() => null),
          fight.participant2_url
            ? serverGet(`/athlete?url=${encodeURIComponent(fight.participant2_url)}`, 'mma').catch(() => null)
            : serverGet(`/athlete?name=${encodeURIComponent(fight.participant2_name)}`, 'mma').catch(() => null),
          serverGet(`/odds?p1=${encodeURIComponent(fight.participant1_name)}&p2=${encodeURIComponent(fight.participant2_name)}`, 'mma').catch(() => null),
          serverGet(`/form?name=${encodeURIComponent(fight.participant1_name)}`, 'mma').catch(() => null),
          serverGet(`/form?name=${encodeURIComponent(fight.participant2_name)}`, 'mma').catch(() => null),
          serverGet(`/h2h?p1=${encodeURIComponent(fight.participant1_name)}&p2=${encodeURIComponent(fight.participant2_name)}`, 'mma').catch(() => null),
        ]);

        const effectiveOdds = odds?.t1 ? odds : fight.odds?.t1 ? fight.odds : null;
        const prompt = buildMMAPrompt(fight, p1Stats, p2Stats, effectiveOdds, form1, form2, h2h, null);

        const resp = await serverPost('/claude', {
          model: 'claude-sonnet-4-6', max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }]
        }, null, { 'x-claude-key': CLAUDE_KEY });

        const text = resp.content?.map(b => b.text || '').join('');
        if (!text) { analyzedFights.set(key, { ts: now, phase }); continue; }

        const tipResult = text.match(/TIP_ML:\s*([^@]+?)\s*@\s*([^|\]]+?)\s*\|EV:\s*([^|]+?)\s*\|STAKE:\s*([^|\]]+?)(?:\s*\|CONF:\s*(\w+))?(?:\]|$)/);
        const fairOddsMatch = text.match(/FAIR_ODDS:([^=]+)=([^|]+)\|([^=]+)=([^\s\n\]]+)/);
        analyzedFights.set(key, { ts: now, phase });

        const hasRealOdds = !!(effectiveOdds?.t1 && parseFloat(effectiveOdds.t1) > 1);

        if (tipResult && hasRealOdds) {
          const tipFighter = tipResult[1].trim(), tipOdd = tipResult[2].trim(), tipEV = tipResult[3].trim();
          const tipStake = calcKelly(tipEV, tipOdd);

          await serverPost('/record-tip', {
            matchId: String(fight.id), eventName: fight.event_name || '',
            p1: fight.participant1_name, p2: fight.participant2_name,
            tipParticipant: tipFighter, odds: tipOdd, ev: tipEV, stake: tipStake,
            confidence: tipResult[5]?.trim() || 'MÉDIA'
          }, 'mma');

          const tipMsg = `🥊 💰 *TIP AUTOMÁTICA MMA*\n` +
            `*${fight.participant1_name}* vs *${fight.participant2_name}*\n\n` +
            `🎯 Aposte: *${tipFighter}* ML @ *${tipOdd}*\n` +
            `📈 EV: *${tipEV}*\n💵 Stake: *${tipStake}* _(¼ Kelly)_\n` +
            `⚖️ ${fight.category || '—'} | ${fight.event_name || ''}\n` +
            `📅 ${fmtDate(fight.event_date)}\n\n` +
            `⚠️ _Aposte com responsabilidade._`;

          for (const [userId, prefs] of subscribedUsers) {
            if (!prefs.has('mma')) continue;
            try { await sendDM(mmaConfig.token, userId, tipMsg); }
            catch(e) { if (e.message?.includes('403')) subscribedUsers.delete(userId); }
          }
          log('INFO', 'AUTO-TIP-MMA', `${tipFighter} @ ${tipOdd}`);
        } else if (fairOddsMatch && !hasRealOdds) {
          const fo1 = parseFloat(fairOddsMatch[2]).toFixed(2), fo2 = parseFloat(fairOddsMatch[4]).toFixed(2);
          const msg = `🥊 💡 *ODDS DE REFERÊNCIA MMA*\n` +
            `*${fight.participant1_name}* vs *${fight.participant2_name}*\n` +
            `_${fight.event_name || ''} — ${fmtDate(fight.event_date)}_\n\n` +
            `• *${fairOddsMatch[1].trim()}:* ${fo1}\n• *${fairOddsMatch[3].trim()}:* ${fo2}\n\n` +
            `💡 _Odds ACIMA = +EV_\n⚠️ _Aposte com responsabilidade._`;
          for (const [userId, prefs] of subscribedUsers) {
            if (!prefs.has('mma')) continue;
            try { await sendDM(mmaConfig.token, userId, msg); }
            catch(e) { if (e.message?.includes('403')) subscribedUsers.delete(userId); }
          }
        }
        await new Promise(r => setTimeout(r, 3000));
      }

      // Clean old MMA analyses (> 3 days)
      const cutoff3d = now - 3 * 24 * 60 * 60 * 1000;
      for (const [k, v] of analyzedFights) { if (v.ts < cutoff3d) analyzedFights.delete(k); }
    } catch(e) {
      log('ERROR', 'AUTO-MMA', e.message);
    }
  }
}

// ── Settlement ──
async function settleCompletedTips() {
  if (Date.now() - lastSettlementCheck < SETTLEMENT_INTERVAL) return;
  lastSettlementCheck = Date.now();

  // Tennis: trigger result scraping first
  if (SPORTS['tennis']?.enabled) {
    serverPost('/tennis-settle', {}).catch(() => {});
  }
  
  for (const sport of Object.keys(SPORTS)) {
    if (!SPORTS[sport].enabled) continue;
    
    try {
      const unsettled = await serverGet('/unsettled-tips?days=14', sport);
      if (!Array.isArray(unsettled) || !unsettled.length) continue;
      
      const pastMatches = await serverGet('/pending-past', sport);
      const matchResults = new Map(pastMatches.map(m => [m.match_id, m]));
      
      for (const tip of unsettled) {
        const match = matchResults.get(tip.match_id);
        if (!match?.winner) continue;
        
        const won = norm(match.winner).includes(norm(tip.tip_participant));
        await serverPost('/settle-tip', {
          matchId: tip.match_id,
          winner: match.winner
        }, sport);
        
        log('INFO', 'SETTLE', `${sport}: ${tip.participant1} vs ${tip.participant2} → ${won ? 'WIN' : 'LOSS'}`);
      }
    } catch(e) {
      log('WARN', 'SETTLE', `${sport}: ${e.message}`);
    }
  }
}

// ── Line Movement Alerts ──
async function checkLineMovement() {
  if (Date.now() - lastLineCheck < LINE_CHECK_INTERVAL) return;
  lastLineCheck = Date.now();
  
  for (const [sport, config] of Object.entries(SPORTS)) {
    if (!config.enabled || subscribedUsers.size === 0) continue;
    
    try {
      const matches = await serverGet('/matches?days=7', sport);
      if (!Array.isArray(matches)) continue;
      
      for (const match of matches) {
        if (!match.odds?.t1 || !match.odds?.t2) continue;
        
        const key = `${sport}_${match.participant1_name}_${match.participant2_name}`;
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
          `${config.icon} *${match.participant1_name}* vs *${match.participant2_name}*\n\n` +
          `${arrow(cur.t1, prev.t1)} ${match.participant1_name}: ${prev.t1} → ${cur.t1}\n` +
          `${arrow(cur.t2, prev.t2)} ${match.participant2_name}: ${prev.t2} → ${cur.t2}\n\n` +
          `💡 _Movimentos bruscos = sharp money ou lesão_`;
        
        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has(sport)) continue;
          try { await sendDM(config.token, userId, msg); }
          catch(e) { if (e.message?.includes('403')) subscribedUsers.delete(userId); }
        }
        
        log('INFO', 'LINE', `${sport}: Δ${(d1*100).toFixed(1)}%`);
      }
    } catch(e) {
      log('ERROR', 'LINE', `${sport}: ${e.message}`);
    }
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

function fmtDuration(secs) {
  if (!secs || secs <= 0) return '';
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
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

// Live match notifications for esports
async function checkLiveNotifications() {
  if (Date.now() - lastLiveCheck < LIVE_CHECK_INTERVAL) return;
  if (subscribedUsers.size === 0) return;
  lastLiveCheck = Date.now();

  const esportsConfig = SPORTS['esports'];
  if (!esportsConfig?.enabled || !esportsConfig.token) return;
  const token = esportsConfig.token;

  try {
    const [lolList, dotaList] = await Promise.all([
      serverGet('/lol-matches').catch(() => []),
      serverGet('/dota-matches').catch(() => [])
    ]);

    const lolLive = Array.isArray(lolList) ? lolList.filter(m => m.status === 'live' || m.status === 'draft') : [];
    const dotaLive = Array.isArray(dotaList) ? dotaList.filter(m => m.status === 'live') : [];
    const allLive = [...lolLive, ...dotaLive];

    for (const match of allLive) {
      const isDraft = match.status === 'draft';
      const matchKey = `${match.game}_${match.id}${isDraft ? '_draft' : ''}`;
      if (!notifiedMatches.has(matchKey)) {
        notifiedMatches.set(matchKey, Date.now());
        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('esports')) continue;
          try {
            const o = match.odds || { t1: '?', t2: '?', bookmaker: '' };
            const gameIcon = match.game === 'lol' ? '⚽' : '🛡️';
            let txt;
            if (isDraft) {
              txt = `${gameIcon} 🟡 *EM PREPARAÇÃO — DRAFT!*\n\n` +
                `*${match.team1}* vs *${match.team2}*\n` +
                `📋 ${match.league}\n` +
                `💰 ${match.team1}: ${o.t1} | ${match.team2}: ${o.t2}\n\n` +
                `_O draft está acontecendo agora. A partida começa em breve._`;
            } else {
              txt = `${gameIcon} 🔴 *PARTIDA AO VIVO!*\n\n` +
                `*${match.team1}* ${match.score1}-${match.score2} *${match.team2}*\n` +
                `📋 ${match.league}\n` +
                `💰 ${match.team1}: ${o.t1} | ${match.team2}: ${o.t2}\n\n` +
                `_Use o botão Análise IA para recomendação_`;
            }
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

// ── MMA Event-Day Notifications ──
async function checkMMAEventDay() {
  if (Date.now() - lastMMADayCheck < MMA_DAY_CHECK_INTERVAL) return;
  if (subscribedUsers.size === 0) return;
  lastMMADayCheck = Date.now();

  const mmaConfig = SPORTS['mma'];
  if (!mmaConfig?.enabled || !mmaConfig.token) return;

  try {
    // Fights today or tomorrow (UFC events typically start late at night in BRT)
    const fights = db.prepare(`
      SELECT m.*, e.name as ev_name, e.date as ev_date, e.location as ev_location
      FROM matches m
      JOIN events e ON m.event_id = e.id
      WHERE m.sport = 'mma' AND m.winner IS NULL
        AND e.date >= date('now') AND e.date <= date('now', '+1 day')
      ORDER BY e.date ASC, m.is_main DESC
    `).all();

    if (!fights.length) return;

    // Group by event
    const byEvent = new Map();
    for (const f of fights) {
      if (!byEvent.has(f.event_id)) byEvent.set(f.event_id, { name: f.ev_name, date: f.ev_date, location: f.ev_location, fights: [] });
      byEvent.get(f.event_id).fights.push(f);
    }

    for (const [eventId, ev] of byEvent) {
      if (notifiedMMAEvents.has(eventId)) continue;
      notifiedMMAEvents.set(eventId, Date.now());

      const isToday = ev.date === new Date().toISOString().slice(0, 10);
      const dayLabel = isToday ? 'HOJE' : 'AMANHÃ';

      const mainEvent = ev.fights.find(f => f.is_main) || ev.fights[0];
      const cardLines = ev.fights.slice(0, 5).map(f =>
        `• ${f.participant1_name} vs ${f.participant2_name}${f.is_title ? ' 🏆' : ''}${f.is_main ? ' _(Main Event)_' : ''}`
      ).join('\n');

      const txt =
        `🥊 *UFC ${dayLabel}!*\n\n` +
        `*${ev.name}*\n` +
        (ev.location ? `📍 ${ev.location}\n` : '') +
        `📅 ${fmtDate(ev.date)}\n\n` +
        `*Card principal:*\n${cardLines}\n\n` +
        `_A análise IA será enviada automaticamente._`;

      for (const [userId, prefs] of subscribedUsers) {
        if (!prefs.has('mma')) continue;
        await sendDM(mmaConfig.token, userId, txt).catch(e => {
          if (e.message?.includes('403')) subscribedUsers.delete(userId);
        });
      }

      log('INFO', 'MMA-DAY', `Notificação enviada: ${ev.name}`);
    }

    // Clean up old entries
    const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
    for (const [k, ts] of notifiedMMAEvents) {
      if (ts < cutoff) notifiedMMAEvents.delete(k);
    }
  } catch(e) {
    log('WARN', 'MMA-DAY', e.message);
  }
}

// ── Tennis Match-Start Notifications ──
async function checkTennisMatchStart() {
  if (Date.now() - lastTennisStartCheck < TENNIS_START_CHECK_INTERVAL) return;
  if (subscribedUsers.size === 0) return;
  lastTennisStartCheck = Date.now();

  const tennisConfig = SPORTS['tennis'];
  if (!tennisConfig?.enabled || !tennisConfig.token) return;

  try {
    // Matches starting in the next 30 minutes
    const matches = db.prepare(`
      SELECT * FROM matches
      WHERE sport = 'tennis' AND winner IS NULL
        AND match_time >= datetime('now')
        AND match_time <= datetime('now', '+35 minutes')
    `).all();

    for (const m of matches) {
      if (notifiedTennisStarts.has(m.id)) continue;
      notifiedTennisStarts.set(m.id, Date.now());

      const surface = m.category || 'hard';
      const surfIcon = surface === 'clay' ? '🟤' : surface === 'grass' ? '🟢' : '🔵';
      const timeStr = m.match_time ? new Date(m.match_time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '';

      const txt =
        `🎾 *PARTIDA COMEÇA EM ~30 MIN!*\n\n` +
        `*${m.participant1_name}* vs *${m.participant2_name}*\n` +
        `${surfIcon} ${surface.charAt(0).toUpperCase() + surface.slice(1)} · ${m.event_name || ''}\n` +
        (timeStr ? `⏰ ${timeStr} (horário de Brasília)\n` : '') +
        `\n_A análise será enviada automaticamente se houver valor._`;

      for (const [userId, prefs] of subscribedUsers) {
        if (!prefs.has('tennis')) continue;
        await sendDM(tennisConfig.token, userId, txt).catch(e => {
          if (e.message?.includes('403')) subscribedUsers.delete(userId);
        });
      }

      log('INFO', 'TENNIS-START', `Notificação: ${m.participant1_name} vs ${m.participant2_name}`);
    }

    // Clean up entries older than 3 hours
    const cutoff = Date.now() - 3 * 60 * 60 * 1000;
    for (const [k, ts] of notifiedTennisStarts) {
      if (ts < cutoff) notifiedTennisStarts.delete(k);
    }
  } catch(e) {
    log('WARN', 'TENNIS-START', e.message);
  }
}

// Collect live game stats for esports analysis
async function collectGameContext(game, matchId) {
  let gamesContext = '';
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
            }
          } catch(_) {}
        }
      }
    }
  } else if (game === 'dota') {
    try {
      const stats = await serverGet(`/dota-live?matchId=${matchId}`);
      if (stats.radiantTeam?.players?.length) {
        const g = (v) => v >= 1000 ? (v/1000).toFixed(1)+'k' : String(v||0);
        const goldDiff = stats.goldDiff !== undefined ? stats.goldDiff : 0;
        const stateTag = stats.gameState === 'finished' ? 'FINALIZADO 📊'
          : stats.isRealtime ? 'AO VIVO ⚡ (live feed)' : 'AO VIVO 📊';
        const goldLeader = goldDiff > 0 ? `${stats.radiantTeam.name} +${g(Math.abs(goldDiff))}`
          : goldDiff < 0 ? `${stats.direTeam.name} +${g(Math.abs(goldDiff))}` : 'Empatado';
        gamesContext += `\n[DOTA 2 — ${stateTag}]\nDuração: ${fmtDuration(stats.duration)}\n`;
        gamesContext += `Kills: ${stats.radiantTeam.name} ${stats.radiantTeam.kills||0} - ${stats.direTeam.kills||0} ${stats.direTeam.name}\n`;
        if (goldDiff !== 0) gamesContext += `Gold Diff: ${goldLeader}\n`;
        gamesContext += '\n';
        const fmtP = (p) => {
          const heroStr = (p.hero||'?').padEnd(15);
          const nameStr = (p.name||'?').slice(0,12).padEnd(12);
          if (stats.fullStats) return `  ${heroStr} ${nameStr} K:${p.kills||0}/${p.deaths||0}/${p.assists||0} G:${g(p.gold||0)} CS:${p.cs||0} GPM:${p.gpm||0}`;
          return `  ${heroStr} ${nameStr}`;
        };
        gamesContext += `${stats.radiantTeam.name}:\n${stats.radiantTeam.players.map(fmtP).join('\n')}\n\n`;
        gamesContext += `${stats.direTeam.name}:\n${stats.direTeam.players.map(fmtP).join('\n')}\n`;
      }
    } catch(e) { log('WARN', 'DOTA-LIVE', e.message); }
  }
  return gamesContext;
}

async function fetchEnrichment(match) {
  const game = match.game;
  const data = { form1: null, form2: null, h2h: null, oddsMovement: null, dotaDetail: null };
  try {
    const [f1, f2, h, om] = await Promise.all([
      serverGet(`/team-form?team=${encodeURIComponent(match.team1 || match.participant1_name)}&game=${game}`).catch(() => null),
      serverGet(`/team-form?team=${encodeURIComponent(match.team2 || match.participant2_name)}&game=${game}`).catch(() => null),
      serverGet(`/h2h?team1=${encodeURIComponent(match.team1 || match.participant1_name)}&team2=${encodeURIComponent(match.team2 || match.participant2_name)}&game=${game}`).catch(() => null),
      serverGet(`/odds-movement?team1=${encodeURIComponent(match.team1 || match.participant1_name)}&team2=${encodeURIComponent(match.team2 || match.participant2_name)}`).catch(() => null),
    ]);
    data.form1 = f1; data.form2 = f2; data.h2h = h; data.oddsMovement = om;
  } catch(_) {}
  if (game === 'dota' && match.status === 'live') {
    try { data.dotaDetail = await serverGet(`/dota-match-detail?matchId=${match.id}`); } catch(_) {}
  }
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
  const dd = enrich.dotaDetail;
  if (dd && !dd.error) {
    txt += '\nDOTA AVANÇADO:\n';
    if (dd.roshanKills > 0) txt += `Roshan kills: ${dd.roshanKills} | Aegis: ${dd.aegisHolder || 'Ninguém'}\n`;
    if (dd.barracksDestroyed?.radiant > 0 || dd.barracksDestroyed?.dire > 0)
      txt += `Barracks destruídas: Radiant=${dd.barracksDestroyed.radiant}/6 | Dire=${dd.barracksDestroyed.dire}/6\n`;
    if (dd.coreItemTimings?.length > 0) {
      txt += 'Itens-chave:\n';
      dd.coreItemTimings.forEach(p => {
        const items = Object.entries(p.items).map(([k,v]) => `${k}@${v}`).join(', ');
        txt += `  ${p.name} (${p.hero}, ${p.side}): ${items}\n`;
      });
    }
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
    const [o, gamesContext, enrich] = await Promise.all([
      serverGet(`/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}`).catch(() => null),
      collectGameContext(game, matchId),
      fetchEnrichment(match)
    ]);
    const hasLiveStats = gamesContext.includes('AO VIVO');
    const enrichSection = buildEnrichmentSection(match, enrich);
    const prompt = buildEsportsPrompt(match, game, gamesContext, o, enrichSection);

    const resp = await serverPost('/claude', {
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    }, null, { 'x-claude-key': CLAUDE_KEY });

    const text = resp.content?.map(b => b.text || '').join('');
    if (!text) {
      log('WARN', 'AUTO', `Claude sem resposta para ${match.team1} vs ${match.team2}`);
      return null;
    }

    const tipResult = text.match(/TIP_ML:\s*([^@]+?)\s*@\s*([^|\]]+?)\s*\|EV:\s*([^|]+?)\s*\|STAKE:\s*([^|\]]+?)(?:\s*\|CONF:\s*(\w+))?(?:\]|$)/);
    const fairOddsMatch = text.match(/FAIR_ODDS:([^=]+)=([^|]+)\|([^=]+)=([^\s\n\]]+)/);
    const hasRealOdds = !!(o?.t1 && parseFloat(o.t1) > 1);
    log('INFO', 'AUTO', `${match.team1} vs ${match.team2} | odds=${o?.t1||'N/A'} hasRealOdds=${hasRealOdds} tipMatch=${!!tipResult}`);
    return { text, tipMatch: tipResult, fairOdds: fairOddsMatch, hasLiveStats, match, o };
  } catch(e) {
    log('ERROR', 'AUTO', `Error for ${match.team1} vs ${match.team2}: ${e.message}`);
    return null;
  }
}

async function checkLateReplacements() {
  if (Date.now() - lastReplacementCheck < REPLACEMENT_INTERVAL) return;
  lastReplacementCheck = Date.now();

  const mmaConfig = SPORTS['mma'];
  if (!mmaConfig?.enabled) return;

  try {
    const events = await serverGet('/events', 'mma').catch(() => null);
    if (!Array.isArray(events) || !events.length) return;

    const now = Date.now();
    const upcoming = events.filter(e => {
      if (!e.date) return false;
      const ms = new Date(e.date + 'T00:00:00').getTime();
      return ms >= now && ms <= now + 14 * 86400000;
    });

    for (const event of upcoming) {
      const currentFights = await serverGet(`/matches?eventId=${event.id}`, 'mma').catch(() => null);
      if (!Array.isArray(currentFights) || !currentFights.length) continue;

      const snapshot = await serverGet(`/card-snapshot?eventId=${event.id}`).catch(() => []);
      const snapMap = {};
      if (Array.isArray(snapshot)) snapshot.forEach(s => { snapMap[s.match_id] = s; });

      // Save current snapshot
      await serverPost('/save-card-snapshot', {
        eventId: event.id,
        fights: currentFights.map(f => ({ id: f.id, participant1_name: f.participant1_name, participant2_name: f.participant2_name }))
      }).catch(() => {});

      if (!Object.keys(snapMap).length) continue;

      for (const fight of currentFights) {
        const snap = snapMap[fight.id];
        if (!snap) continue;

        const f1Changed = !fuzzyName(snap.participant1_name, fight.participant1_name);
        const f2Changed = !fuzzyName(snap.participant2_name, fight.participant2_name);
        if (!f1Changed && !f2Changed) continue;

        const oldFighter = f1Changed ? snap.participant1_name : snap.participant2_name;
        const newFighter = f1Changed ? fight.participant1_name : fight.participant2_name;

        log('WARN', 'REPLACE', `${event.name}: ${oldFighter} → ${newFighter}`);

        const alert = `⚠️ *LATE REPLACEMENT DETECTADO*\n\n` +
          `🥊 ${event.name}\n` +
          `❌ ~~${oldFighter}~~ → ✅ *${newFighter}*\n` +
          `Luta: *${fight.participant1_name}* vs *${fight.participant2_name}*\n\n` +
          `📊 _Substituto tem desvantagem de camp — reavalie odds_\n` +
          `💡 _A linha vai mover. Verifique a análise atualizada._`;

        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('mma')) continue;
          sendDM(mmaConfig.token, userId, alert).catch(() => {});
        }
        for (const adminId of ADMIN_IDS) {
          sendDM(mmaConfig.token, adminId, alert).catch(() => {});
        }
        analyzedFights.delete(fight.id);
      }
    }
  } catch(e) {
    log('ERROR', 'REPLACE', e.message);
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
      `• 📊 Alertas de line movement > 10%\n` +
      `• ⚠️ Late replacements (MMA)\n\n` +
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

// ── Esports Prompt Builder ──
function buildEsportsPrompt(match, game, gamesContext, o, enrichSection) {
  const hasRealOdds = !!(o && o.t1 && parseFloat(o.t1) > 1);
  const t1 = match.team1 || match.participant1_name;
  const t2 = match.team2 || match.participant2_name;
  const serieScore = `${match.score1 || 0}-${match.score2 || 0}`;

  let oddsSection = '';
  if (hasRealOdds) {
    const prob1 = (1 / parseFloat(o.t1) * 100).toFixed(1);
    const prob2 = (1 / parseFloat(o.t2) * 100).toFixed(1);
    oddsSection = `Odds ML: ${t1}=${o.t1} | ${t2}=${o.t2}${o.bookmaker ? ' (' + o.bookmaker + ')' : ''}\nOdds implícitas: ${t1}=${prob1}% | ${t2}=${prob2}%`;
  } else {
    oddsSection = `Odds ML: Não disponíveis\n⚠️ SEM ODDS REAIS — estime FAIR_ODDS com juice 6%`;
  }

  const oddsInstructions = hasRealOdds
    ? `5. Compare as odds implícitas da casa com sua probabilidade estimada\n6. Calcule o EV: EV = (prob_real × odd) - 1. EV >= 0.02 (2%) = valor`
    : `5. Estime a probabilidade de vitória de cada time (soma = 100%)\n   Odd justa c/ juice 6%: odd = 1/(prob * 1.06)\n   FAIR_ODDS:[time1]=[odd1]|[time2]=[odd2]`;

  const tipInstruction = hasRealOdds
    ? `[Se +EV >= 2% e confiança ALTA, MÉDIA ou BAIXA: TIP_ML:[time]@[odd]|EV:[%]|STAKE:[u]|CONF:[ALTA/MÉDIA/BAIXA]]`
    : `[Sem odds reais, apenas FAIR_ODDS — não emita TIP_ML]`;

  return `Você é um analista profissional de apostas esportivas de ${game === 'lol' ? 'League of Legends' : 'Dota 2'}.
Sua análise deve ser 100% baseada nos dados fornecidos.

═══════════════════════════════════════
SÉRIE: ${t1} vs ${t2}
Liga: ${match.league || match.event_name || 'Esports'} | Formato: ${match.format || 'Bo1/Bo3'}
Placar da série: ${t1} ${serieScore} ${t2}
Status: ${match.status}
${oddsSection}
═══════════════════════════════════════
${gamesContext || '\n[Sem dados ao vivo — análise pré-jogo]\n'}
═══════════════════════════════════════
${enrichSection}
═══════════════════════════════════════

INSTRUÇÕES:
1. Analise os dados ao vivo com PESO BALANCEADO
2. Considere forma recente e H2H
3. Verifique line movement — odds caindo indicam sharp money

${game === 'lol' ? `4. ANÁLISE DE VIRADA (LoL):
   a) COMPOSIÇÃO: time perdendo tem comp de late-game/scaling? Virada é plausível
   b) OBJETIVOS: mais dragões? Soul point? Baron buff?
   c) GOLD DIFF < 3k COM torres intactas ≠ jogo decidido
   d) TIMING: antes dos 20min = cedo demais. 25-35min = janela crítica
   e) KDA dos carries: carry com KDA positivo e item core completo = ameaça real` : `4. ANÁLISE DE VIRADA (Dota 2):
   a) Roshan/Aegis ativo muda completamente a equação
   b) Barracks destruídas = mega creeps = jogo quase encerrado
   c) BKB nos carries não prontos = janela de virada aberta`}

5. PROBABILIDADE REAL: seja honesto. Gold diff de 2k em 20min = 50-55% para quem lidera, NÃO 70%+
${oddsInstructions}
7. NÃO invente dados históricos
8. ⏱️ DELAY: stats LoL têm ~90s de atraso — calibre a confiança

FORMATO:
📊 ANÁLISE — [Time1] vs [Time2]
Estado atual: [quem lidera e por quê]
⚠️ Potencial de virada: [ALTO/MÉDIO/BAIXO]

⚡ VEREDITO ML:
- Favorito: [time] (X% prob) | Underdog: [time] (Y% prob)
- Odd justa (c/ juice 6%): ${t1}=X.XX | ${t2}=Y.YY
${hasRealOdds ? '- EV: [+X% ou -X%]' : '- Busque odds ACIMA dos valores estimados'}
- Confiança: [ALTA/MÉDIA/BAIXA]

FAIR_ODDS:${t1}=[odd]|${t2}=[odd]
${tipInstruction}

Máximo 500 palavras.`;
}

// ── MMA Prompt Builder ──
function buildMMAPrompt(match, p1Stats, p2Stats, odds, form1, form2, h2h, oddsMovement) {
  const hasOdds = !!(odds?.t1 && parseFloat(odds.t1) > 1);
  const context = match.is_title ? '🏆 DISPUTA DE CINTURÃO' : match.is_main ? 'Main Event' : 'Card';
  const f1 = match.participant1_name;
  const f2 = match.participant2_name;

  let oddsSection = '';
  if (hasOdds) {
    const p1 = (1 / parseFloat(odds.t1) * 100).toFixed(1);
    const p2 = (1 / parseFloat(odds.t2) * 100).toFixed(1);
    oddsSection = `Odds: ${f1}=${odds.t1} (imp. ${p1}%) | ${f2}=${odds.t2} (imp. ${p2}%)\nBookmaker: ${odds.bookmaker || 'N/A'}`;
  } else {
    oddsSection = `Odds: Não disponíveis\n⚠️ SEM ODDS REAIS — estime FAIR_ODDS c/ juice 6%`;
  }

  let lineMovement = '';
  if (oddsMovement?.history?.length >= 2) {
    const first = oddsMovement.history[0], last = oddsMovement.history[oddsMovement.history.length - 1];
    const dir = parseFloat(last.odds_p1) < parseFloat(first.odds_p1) ? 'caindo (sharp money?)' : 'subindo';
    lineMovement = `\nLINE MOVEMENT:\nAbertura: ${f1}=${first.odds_p1} | ${f2}=${first.odds_p2}\nAtual: ${f1}=${last.odds_p1} | ${f2}=${last.odds_p2}\n${f1}: linha ${dir}`;
  }

  let h2hStr = '';
  if (h2h?.totalMatches > 0) {
    h2hStr = `\nH2H: ${f1} ${h2h.t1Wins}-${h2h.t2Wins} ${f2} (${h2h.totalMatches} luta${h2h.totalMatches > 1 ? 's' : ''})`;
  }

  const oddsInstructions = hasOdds
    ? `5. Compare probabilidades implícitas com sua estimativa\n6. EV = (prob_real × odd) - 1. Value se EV > 2%`
    : `5. Estime prob de vitória (soma = 100%)\n6. Odd justa c/ juice 6%: odd = (1/prob) / 1.06\n   Marque: FAIR_ODDS:[lutador1]=[odd1]|[lutador2]=[odd2]`;

  const tipInstruction = hasOdds
    ? `[Se +EV >= 2% e confiança ALTA, MÉDIA ou BAIXA: TIP_ML:[lutador]@[odd]|EV:[%]|STAKE:[u]|CONF:[ALTA/MÉDIA/BAIXA]]`
    : `[Sem odds reais, NÃO emita TIP_ML. Apenas FAIR_ODDS]`;

  return `Você é analista especializado em apostas de MMA. Análise 100% baseada em dados estatísticos objetivos.

═══════════════════════════════════════
LUTA: ${f1} vs ${f2}
Categoria: ${match.category || '—'} | ${context}
Evento: ${match.event_name || '—'} — ${fmtDate(match.event_date)}
${oddsSection}${lineMovement}${h2hStr}
═══════════════════════════════════════

LUTADOR 1:
${formatAthleteBlock(f1, p1Stats, form1)}

LUTADOR 2:
${formatAthleteBlock(f2, p2Stats, form2)}

═══════════════════════════════════════

INSTRUÇÕES:
1. MATCHUP TÉCNICO — compare diretamente:
   • Striking: SLpM, Str Acc, SApM, Str Def
   • Grappling: TD Avg vs TD Def adversária
   • Sub game: Sub Avg vs TD Def
   • Reach/Stance: southpaw vs orthodox
2. FORMA RECENTE — vitórias por KO/TKO/SUB indicam poder
3. ESTILO implícito: SLpM > 6 = striker. TD Avg > 3 = wrestler. Sub Avg > 1 = finalizador
4. CONTEXTO: title fights → maior motivação. Late replacement = desvantagem de camp
${oddsInstructions}
7. NÃO invente estatísticas. Se faltar dado, diga explicitamente
8. MMA tem alta variância — calibre confiança com honestidade

FORMATO:
🥊 ANÁLISE — ${f1} vs ${f2}
Categoria: ${match.category || '—'} | ${context}

📊 MATCHUP:
- Striking: [comparação direta]
- Grappling: [TD Avg vs TD Def]
- Físico: [reach/stance se relevante]

📋 FORMA RECENTE:
- [análise de ambos]

⚡ VEREDITO ML:
- Favorito: [lutador] (X% prob) | Underdog: [lutador] (Y% prob)
- Odd justa (c/ juice 6%): ${f1}=X.XX | ${f2}=Y.YY
${hasOdds ? `- EV: [+X% ou -X%]` : `- 💡 Busque odds ACIMA desses valores`}
- Confiança: [ALTA/MÉDIA/BAIXA]

FAIR_ODDS:${f1}=[odd]|${f2}=[odd]
${tipInstruction}

Máximo 500 palavras.`;
}

// ── Tennis Prompt Builder ──
function buildTennisPrompt(match, p1Stats, p2Stats, odds, surfForm1, surfForm2, h2h, oddsMovement) {
  const p1 = match.participant1_name;
  const p2 = match.participant2_name;
  const surface = match.category || 'hard';
  const tournament = match.event_name || match.league || 'Torneio';
  const hasOdds = !!(odds?.t1 && parseFloat(odds.t1) > 1);

  const surfLabel = surface === 'clay' ? 'Terra batida (clay)' : surface === 'grass' ? 'Grama (grass)' : 'Quadra dura (hard)';

  let oddsSection = '';
  if (hasOdds) {
    const prob1 = (1 / parseFloat(odds.t1) * 100).toFixed(1);
    const prob2 = (1 / parseFloat(odds.t2) * 100).toFixed(1);
    oddsSection = `Odds: ${p1}=${odds.t1} (imp. ${prob1}%) | ${p2}=${odds.t2} (imp. ${prob2}%)\nBookmaker: ${odds.bookmaker || 'N/A'}`;
  } else {
    oddsSection = `Odds: Não disponíveis\n⚠️ SEM ODDS REAIS — estime FAIR_ODDS c/ juice 5%`;
  }

  let lineMovement = '';
  if (oddsMovement?.history?.length >= 2) {
    const first = oddsMovement.history[0], last = oddsMovement.history[oddsMovement.history.length - 1];
    const dir = parseFloat(last.odds_p1) < parseFloat(first.odds_p1) ? 'caindo (sharp money?)' : 'subindo';
    lineMovement = `\nLINE MOVEMENT:\nAbertura: ${p1}=${first.odds_p1} | ${p2}=${first.odds_p2}\nAtual: ${p1}=${last.odds_p1} | ${p2}=${last.odds_p2}\n${p1}: linha ${dir}`;
  }

  let h2hStr = '';
  if (h2h?.totalMatches > 0) {
    h2hStr = `\nH2H: ${p1} ${h2h.t1Wins}-${h2h.t2Wins} ${p2} (${h2h.totalMatches} confronto${h2h.totalMatches > 1 ? 's' : ''})`;
    if (h2h.matches?.length) {
      h2hStr += '\n' + h2h.matches.slice(0, 3).map(m => `  ${m.winner} venceu (${(m.event_date||'').slice(0,10)})`).join('\n');
    }
  }

  const fmtPlayerBlock = (name, stats, form) => {
    let block = `${name}`;
    if (stats?.ranking) block += ` | Ranking: #${stats.ranking}`;
    if (stats?.rankingPeak) block += ` | Peak: #${stats.rankingPeak}`;
    if (stats?.nationality) block += ` | ${stats.nationality}`;
    if (stats?.hand) block += ` | Mão: ${stats.hand}`;

    if (form?.total > 0) {
      block += `\nForma geral: ${form.wins}W-${form.losses}L (${form.winRate}%)`;
    }
    if (form?.recentMatches?.length) {
      const surf = form.recentMatches.filter(m => m.surface === surface);
      if (surf.length) {
        const sw = surf.filter(m => m.result === 'W').length;
        block += `\nForma em ${surface}: ${sw}W-${surf.length - sw}L (${surf.length} partidas)`;
        block += '\nÚltimas em ' + surface + ':\n' + surf.slice(0, 4).map(m =>
          `  ${m.result} vs ${m.opponent}${m.score ? ' ' + m.score : ''}`
        ).join('\n');
      }
      block += '\nÚltimas 5 (geral):\n' + form.recentMatches.slice(0, 5).map(m =>
        `  ${m.result} vs ${m.opponent}${m.surface ? ' [' + m.surface + ']' : ''}${m.score ? ' ' + m.score : ''}`
      ).join('\n');
    } else {
      block += '\n_Forma local: sem dados — use conhecimento geral_';
    }
    return block;
  };

  const tipInstruction = hasOdds
    ? `[Se +EV >= 2% e confiança ALTA, MÉDIA ou BAIXA: TIP_ML:[jogador]@[odd]|EV:[%]|STAKE:[u]|CONF:[ALTA/MÉDIA/BAIXA]]`
    : `[Sem odds reais, NÃO emita TIP_ML. Apenas FAIR_ODDS]`;

  const oddsInstructions = hasOdds
    ? `5. Compare probabilidades implícitas com sua estimativa\n6. EV = (prob_real × odd) - 1. Value se EV > 2%`
    : `5. Estime prob de vitória (soma = 100%)\n6. Odd justa c/ juice 5%: odd = (1/prob) / 1.05\n   Marque: FAIR_ODDS:[jogador1]=[odd1]|[jogador2]=[odd2]`;

  return `Você é analista especializado em apostas de tênis, com foco em mercados ineficientes (Challenger/ITF).
Análise 100% baseada em dados objetivos. Superfície é o fator mais importante — ignore rankings gerais.

═══════════════════════════════════════
PARTIDA: ${p1} vs ${p2}
Torneio: ${tournament}
Superfície: ${surfLabel}
${oddsSection}${lineMovement}${h2hStr}
═══════════════════════════════════════

JOGADOR 1:
${fmtPlayerBlock(p1, p1Stats, surfForm1)}

JOGADOR 2:
${fmtPlayerBlock(p2, p2Stats, surfForm2)}

═══════════════════════════════════════

INSTRUÇÕES:
1. SUPERFÍCIE é o contexto central:
   • Clay: baseliners, construtores de pontos, alta defesa. 1º serviço menos dominante.
   • Hard: equilibrado, serve + volta mais direto.
   • Grass: serve-and-volley, aces, rallies curtos. Grande favorece servidor.
2. MÉTRICAS CHAVE (se disponíveis):
   • % 1º serviço, pontos ganhos com 1º e 2º serviço
   • Break points convertidos/salvos — decisivo em Challenger
   • Tie-breaks: vencedor de sets fechados tem vantagem psicológica
3. RANKING vs FORMA RECENTE — em Challenger, forma recente supera ranking
4. H2H NA MESMA SUPERFÍCIE tem mais peso que H2H geral
${oddsInstructions}
7. NÃO invente dados. Se faltar info, declare explicitamente
8. Challengers têm alta variância — calibre confiança com honestidade

FORMATO:
🎾 ANÁLISE — ${p1} vs ${p2}
Torneio: ${tournament} | ${surfLabel}

🏟️ CONTEXTO DE SUPERFÍCIE:
- [como cada jogador performa nessa superfície]

📊 MATCHUP:
- [comparação técnica: serviço, devolução, movimento]
- H2H: [análise]

📋 FORMA RECENTE:
- [análise de ambos na superfície]

⚡ VEREDITO ML:
- Favorito: [jogador] (X% prob) | Underdog: [jogador] (Y% prob)
- Odd justa (c/ juice 5%): ${p1}=X.XX | ${p2}=Y.YY
${hasOdds ? `- EV: [+X% ou -X%]` : `- 💡 Busque odds ACIMA desses valores`}
- Confiança: [ALTA/MÉDIA/BAIXA]

FAIR_ODDS:${p1}=[odd]|${p2}=[odd]
${tipInstruction}

Máximo 500 palavras.`;
}

// ── Generic Prompt Dispatcher ──
function buildPrompt(sport, match, p1Stats, p2Stats, odds, form1, form2, h2h, oddsMovement) {
  if (sport === 'mma') {
    return buildMMAPrompt(match, p1Stats, p2Stats, odds, form1, form2, h2h, oddsMovement);
  }
  if (sport === 'tennis') {
    return buildTennisPrompt(match, p1Stats, p2Stats, odds, form1, form2, h2h, oddsMovement);
  }
  // Esports: use buildEsportsPrompt with basic enrichSection
  const enrichSection = `\nFORMA:\n${form1 ? `${match.participant1_name}: ${form1.wins}W-${form1.losses}L (${form1.winRate}%)` : ''}\n${form2 ? `${match.participant2_name}: ${form2.wins}W-${form2.losses}L (${form2.winRate}%)` : ''}`;
  const fakeOdds = odds?.t1 ? odds : null;
  return buildEsportsPrompt({ ...match, team1: match.participant1_name, team2: match.participant2_name }, match.game || 'esports', '', fakeOdds, enrichSection);
}

function formatAthleteBlock(name, stats, form) {
  if (!stats || stats.error) return `${name}\n_Estatísticas não disponíveis_`;
  
  let block = `${name}`;
  if (stats.wins !== undefined) block += ` (${stats.wins}-${stats.losses}-${stats.draws || 0})`;
  
  if (stats.height) block += ` | Altura: ${stats.height}`;
  if (stats.reach) block += ` | Reach: ${stats.reach}`;
  
  if (stats.slpm !== undefined) {
    block += `\nStriking: SLpM ${stats.slpm} | Acc ${stats.str_acc}% | Def ${stats.str_def}%`;
  }
  if (stats.td_avg !== undefined) {
    block += `\nGrappling: TD ${stats.td_avg} | Acc ${stats.td_acc}% | Def ${stats.td_def}%`;
  }
  
  if (form?.recentMatches?.length) {
    block += '\nÚltimas 5:\n' + form.recentMatches.slice(0, 5).map(f =>
      `${f.result} vs ${f.opponent}${f.method ? ` (${f.method})` : ''}`
    ).join('\n');
    if (form.streak) block += `\nStreak: ${form.streak}`;
  }
  
  return block;
}

// ── Tennis Withdrawal Detection ──
let lastWithdrawCheck = 0;
const WITHDRAW_CHECK_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours

async function checkTennisWithdrawals() {
  if (Date.now() - lastWithdrawCheck < WITHDRAW_CHECK_INTERVAL) return;
  lastWithdrawCheck = Date.now();

  const tennisConfig = SPORTS['tennis'];
  if (!tennisConfig?.enabled || !tennisConfig.token) return;

  try {
    const events = await serverGet('/tennis-tournaments').catch(() => []);
    if (!Array.isArray(events) || !events.length) return;

    for (const ev of events.slice(0, 5)) {
      const [current, snapshot] = await Promise.all([
        serverGet(`/tennis-matches?tournamentId=${encodeURIComponent(ev.id)}`).catch(() => []),
        serverGet(`/tennis-snapshot?tournamentId=${encodeURIComponent(ev.id)}`).catch(() => [])
      ]);

      if (!Array.isArray(current) || !Array.isArray(snapshot) || !snapshot.length) continue;

      const snapMap = {};
      snapshot.forEach(s => { snapMap[s.match_id] = s; });

      for (const match of current) {
        const snap = snapMap[match.id];
        if (!snap) continue;

        const p1Changed = !fuzzyName(snap.participant1_name, match.participant1_name);
        const p2Changed = !fuzzyName(snap.participant2_name, match.participant2_name);
        if (!p1Changed && !p2Changed) continue;

        const old = p1Changed ? snap.participant1_name : snap.participant2_name;
        const newp = p1Changed ? match.participant1_name : match.participant2_name;

        log('WARN', 'TENNIS-WITHDRAW', `${ev.name}: ${old} → ${newp}`);

        const surfIcon = { clay: '🟠', grass: '🟢', hard: '🔵' };
        const surf = match.category || 'hard';
        const alert = `⚠️ *WITHDRAWAL / SUBSTITUIÇÃO DETECTADA*\n\n` +
          `🎾 ${ev.name}\n` +
          `${surfIcon[surf] || ''} Superfície: ${surf}\n\n` +
          `❌ ~~${old}~~ → ✅ *${newp}*\n` +
          `Partida: *${match.participant1_name}* vs *${match.participant2_name}*\n\n` +
          `📊 _Lucky loser/substituto pode ter desvantagem de preparação_\n` +
          `💡 _Verifique a análise atualizada antes de apostar_`;

        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('tennis')) continue;
          sendDM(tennisConfig.token, userId, alert).catch(() => {});
        }
        for (const adminId of ADMIN_IDS) {
          sendDM(tennisConfig.token, adminId, alert).catch(() => {});
        }
      }
    }
  } catch(e) {
    log('ERROR', 'TENNIS-WITHDRAW', e.message);
  }
}

// ── Tennis Auto-Analysis ──
let lastTennisAutoAnalyze = 0;
const TENNIS_AUTO_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours (volume control)
const analyzedTennisMatches = new Map();

async function runAutoAnalysisTennis() {
  if (Date.now() - lastTennisAutoAnalyze < TENNIS_AUTO_INTERVAL) return;
  lastTennisAutoAnalyze = Date.now();

  const tennisConfig = SPORTS['tennis'];
  if (!tennisConfig?.enabled || !tennisConfig.token) return;

  try {
    const events = await serverGet('/tennis-tournaments').catch(() => []);
    log('INFO', 'AUTO-TENNIS', `${events?.length || 0} torneios encontrados`);
    if (!Array.isArray(events) || !events.length) return;

    // Priorizar por tier: Grand Slam > Masters/WTA 1000 > ATP/WTA 500 > ATP 250 > Challenger > ITF
    const tierOrder = { 'Grand Slam': 0, 'Masters 1000': 1, 'WTA 1000': 1, 'ATP 500': 2, 'WTA 500': 2, 'ATP 250': 3, 'WTA': 3, 'Challenger': 4, 'ITF': 5 };
    const sortedEvents = [...events].sort((a, b) => (tierOrder[a.tier] ?? 99) - (tierOrder[b.tier] ?? 99));

    let analyzed = 0;
    const MAX_ANALYSES = 6;

    for (const ev of sortedEvents.slice(0, 6)) {
      if (analyzed >= MAX_ANALYSES) break;
      const matches = await serverGet(`/tennis-matches?tournamentId=${encodeURIComponent(ev.id)}`).catch(() => []);
      if (!Array.isArray(matches)) continue;

      // Filter: only matches with odds within next 6 hours, sorted by soonest first
      const soon = new Date(Date.now() + 6 * 3600000).toISOString();
      const due = matches
        .filter(m => m.odds && m.match_time && m.match_time <= soon)
        .sort((a, b) => (a.match_time || '').localeCompare(b.match_time || ''));

      for (const match of due.slice(0, 2)) { // max 2 per tournament
        if (analyzed >= MAX_ANALYSES) break;
        const key = `tennis_${match.id}`;
        const prev = analyzedTennisMatches.get(key);
        if (prev && Date.now() - prev < TENNIS_AUTO_INTERVAL) continue;

        analyzedTennisMatches.set(key, Date.now());
        analyzed++;

        const p1enc = encodeURIComponent(match.participant1_name);
        const p2enc = encodeURIComponent(match.participant2_name);
        const surface = match.category || '';

        const [p1Stats, p2Stats, odds, form1, form2, h2h, oddsMovement] = await Promise.all([
          serverGet(`/tennis-player?name=${p1enc}`).catch(() => null),
          serverGet(`/tennis-player?name=${p2enc}`).catch(() => null),
          serverGet(`/odds?p1=${p1enc}&p2=${p2enc}&sport=tennis`).catch(() => null),
          serverGet(`/tennis-surface-form?player=${p1enc}${surface ? '&surface=' + encodeURIComponent(surface) : ''}`).catch(() => null),
          serverGet(`/tennis-surface-form?player=${p2enc}${surface ? '&surface=' + encodeURIComponent(surface) : ''}`).catch(() => null),
          serverGet(`/h2h?p1=${p1enc}&p2=${p2enc}&sport=tennis`).catch(() => null),
          serverGet(`/odds-movement?p1=${p1enc}&p2=${p2enc}&sport=tennis`).catch(() => null)
        ]);

        const prompt = buildTennisPrompt(match, p1Stats, p2Stats, odds, form1, form2, h2h, oddsMovement);

        const resp = await serverPost('/claude', {
          model: 'claude-sonnet-4-6',
          max_tokens: 1200,
          messages: [{ role: 'user', content: prompt }]
        }, null, { 'x-claude-key': CLAUDE_KEY });

        const text = resp.content?.map(b => b.text || '').join('');
        if (!text) continue;

        const tipResult = text.match(/TIP_ML:\s*([^@]+?)\s*@\s*([^|\]]+?)\s*\|EV:\s*([^|]+?)\s*\|STAKE:\s*([^|\]]+?)(?:\s*\|CONF:\s*(\w+))?(?:\]|$)/);
        const hasRealOdds = !!(odds?.t1 && parseFloat(odds.t1) > 1);

        if (tipResult && hasRealOdds) {
          const tipPlayer = tipResult[1].trim();
          const tipOdd = tipResult[2].trim();
          const tipEV = tipResult[3].trim();
          const tipStake = calcKelly(tipEV, tipOdd);
          const surfIcon = { clay: '🟠', grass: '🟢', hard: '🔵' };

          await serverPost('/record-tip', {
            matchId: String(match.id), eventName: match.event_name || ev.name,
            p1: match.participant1_name, p2: match.participant2_name,
            tipParticipant: tipPlayer, odds: tipOdd, ev: tipEV, stake: tipStake,
            confidence: tipResult[5]?.trim() || 'MÉDIA', sport: 'tennis'
          }, 'tennis');

          const tipMsg = `🎾 💰 *TIP AUTOMÁTICA TÊNIS*\n` +
            `${surfIcon[match.category] || ''} *${match.participant1_name}* vs *${match.participant2_name}*\n\n` +
            `🎯 Aposte: *${tipPlayer}* ML @ *${tipOdd}*\n` +
            `📈 EV: *${tipEV}* | 💵 Stake: *${tipStake}* _(¼ Kelly)_\n` +
            `📋 ${match.event_name || ev.name}\n` +
            `🏟️ Superfície: *${match.category || 'hard'}*\n` +
            (match.match_time ? `📅 ${fmtMatchTime(match.match_time)}\n` : '') +
            `\n⚠️ _Aposte com responsabilidade._`;

          for (const [userId, prefs] of subscribedUsers) {
            if (!prefs.has('tennis')) continue;
            try { await sendDM(tennisConfig.token, userId, tipMsg); }
            catch(e) { if (e.message?.includes('403')) subscribedUsers.delete(userId); }
          }
          log('INFO', 'AUTO-TIP-TENNIS', `${tipPlayer} @ ${tipOdd}`);
        }

        await new Promise(r => setTimeout(r, 3000));
        if (analyzed >= 6) break; // max 6 analyses per run (cost control)
      }
      if (analyzed >= 6) break;
    }
  } catch(e) {
    log('ERROR', 'AUTO-TENNIS', e.message);
  }
}

// ── Admin ──
async function handleAdmin(token, chatId, command) {
  if (!ADMIN_IDS.has(String(chatId))) {
    await send(token, chatId, '❌ Comando restrito a administradores.');
    return;
  }
  
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0];
  const sport = parts[1] || 'mma';
  
  if (cmd === '/stats' || cmd === '/roi') {
    try {
      const [roi, history] = await Promise.all([
        serverGet('/roi', sport),
        serverGet('/tips-history?limit=10&filter=settled', sport).catch(() => [])
      ]);
      const o = roi.overall || {};
      const wins = o.wins || 0, losses = o.losses || 0, total = o.total || 0;
      const pending = total - wins - losses;
      const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
      const roiVal = parseFloat(o.roi || 0);
      let txt = `📊 *ESTATÍSTICAS ${sport.toUpperCase()}*\n\n`;
      txt += `Total de tips: *${total}*\n`;
      txt += `✅ Ganhas: *${wins}* | ❌ Perdidas: *${losses}*`;
      if (pending > 0) txt += ` | ⏳ Pendentes: *${pending}*`;
      txt += `\n📌 Win Rate: *${wr}%*\n`;
      txt += `${roiVal >= 0 ? '📈' : '📉'} ROI: *${roiVal >= 0 ? '+' : ''}${roiVal}%*\n`;
      txt += `💵 Profit: *${parseFloat(o.totalProfit || 0) >= 0 ? '+' : ''}${o.totalProfit || 0}u*\n`;
      txt += `📦 Volume: *${o.totalStaked || 0}u* | EV médio: *${o.avg_ev || 0}%*\n`;
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
          txt += `${res} ${t.tip_participant || '?'} @ ${t.odds} _(${date})_\n`;
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
  } else if (cmd === '/rescrape') {
    if (sport !== 'mma') { await send(token, chatId, '❌ Apenas para MMA.'); return; }
    const name = parts.slice(1).join(' ');
    if (!name) { await send(token, chatId, '❌ Use: /rescrape <nome do lutador>'); return; }
    await send(token, chatId, `⏳ Rebuscando *${name}*...`);
    try {
      const stats = await serverGet(`/athlete?name=${encodeURIComponent(name)}`, 'mma');
      if (stats?.error) { await send(token, chatId, `❌ ${stats.error}`); return; }
      await send(token, chatId, `✅ *${stats.name}* atualizado:\nCartel: ${stats.wins}-${stats.losses}-${stats.draws || 0}\nSLpM: ${stats.slpm || stats.str_acc} | TD Avg: ${stats.td_avg}`);
    } catch(e) { await send(token, chatId, `❌ ${e.message}`); }
  } else if (cmd === '/force-analyze') {
    if (sport !== 'mma') { await send(token, chatId, '❌ Apenas para MMA.'); return; }
    const fightId = parts[1];
    if (!fightId) {
      try {
        const fights = await serverGet('/upcoming-fights?days=7', 'mma');
        if (!Array.isArray(fights) || !fights.length) { await send(token, chatId, '❌ Nenhuma luta próxima.'); return; }
        let txt = '⚡ *Force Analyze — Lutas disponíveis:*\n\n';
        fights.slice(0, 8).forEach(f => {
          const analyzed = analyzedFights.has(f.id) ? ' _(analisada)_' : '';
          txt += `ID: \`${f.id.slice(0, 20)}\`\n${f.participant1_name} vs ${f.participant2_name}${analyzed}\n\n`;
        });
        txt += '_Use: /force-analyze <fightId>_';
        await send(token, chatId, txt);
      } catch(e) { await send(token, chatId, `❌ ${e.message}`); }
      return;
    }
    analyzedFights.delete(fightId);
    lastAutoAnalyze = 0;
    await send(token, chatId, `✅ Cache de \`${fightId.slice(0, 20)}\` limpo.`);
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
  } else {
    await send(token, chatId,
      `📋 *Comandos Admin*\n\n` +
      `/stats [sport] — ROI e calibração\n` +
      `/users — status do bot\n` +
      `/pending — tips pendentes\n` +
      `/settle — force settlement\n` +
      `/slugs — slugs ignorados recentes\n` +
      `/lolraw — dump bruto da API LoL (diagnóstico)\n` +
      `${sport === 'mma' ? '/rescrape <nome> — rebuscar stats de lutador\n/force-analyze [fightId] — forçar re-análise\n' : ''}` +
      `\n_IDs aparecem no /pending e /force-analyze_`
    );
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
              const [roi, history] = await Promise.all([
                serverGet('/roi', sport),
                serverGet('/tips-history?limit=10&filter=settled', sport).catch(() => [])
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
          } else if (text.startsWith('/notificacoes') || text.startsWith('/notificações')) {
            const action = text.split(' ')[1];
            await handleNotificacoes(token, chatId, sport, action);
          } else if (text === '/meustats') {
            try {
              const roi = await serverGet('/roi', sport);
              const o = roi.overall || {};
              const wins = o.wins || 0, total = o.total || 0;
              const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
              let txt = `📊 *${config.name} — Performance*\n\n`;
              txt += `Tips registradas: *${total}*\n`;
              txt += `✅ Ganhas: *${wins}* | ❌ Perdidas: *${o.losses || 0}*\n`;
              txt += `🎯 Win Rate: *${wr}%*\n`;
              if (o.roi !== undefined) txt += `💰 ROI: *${o.roi > 0 ? '+' : ''}${o.roi}%*\n`;
              txt += `\n_Apenas tips com odds reais e +EV são registradas._`;
              await send(token, chatId, txt);
            } catch(e) { await send(token, chatId, '❌ Erro ao buscar stats.'); }
          } else if (text === '/tracking' || text.startsWith('/tracking ')) {
            try {
              const [roi, history] = await Promise.all([
                serverGet('/roi', sport),
                serverGet('/tips-history?limit=10&filter=settled', sport).catch(() => [])
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

                // Calibração por confiança
                if (roi.calibration?.length) {
                  txt += `\n🎯 *Calibração por confiança:*\n`;
                  const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' };
                  roi.calibration.forEach(c => {
                    const ce = confEmoji[c.confidence] || '⚪';
                    txt += `${ce} ${c.confidence}: ${c.wins}/${c.total} (${c.win_rate}%)\n`;
                  });
                }

                // Últimas tips resolvidas
                if (Array.isArray(history) && history.length > 0) {
                  txt += `\n📋 *Últimas tips resolvidas:*\n`;
                  history.slice(0, 5).forEach(t => {
                    const res = t.result === 'win' ? '✅' : t.result === 'loss' ? '❌' : '⏳';
                    const name = t.tip_participant || '?';
                    const date = (t.sent_at || '').slice(0, 10);
                    txt += `${res} *${name}* @ ${t.odds} _(${date})_\n`;
                  });
                }
              }

              txt += `\n_Use /tracking para atualizar_`;
              await send(token, chatId, txt);
            } catch(e) { await send(token, chatId, '❌ Erro ao buscar tracking: ' + e.message); }
          } else if (text.startsWith('/stats') || text.startsWith('/roi') || text.startsWith('/users') ||
                     text.startsWith('/settle') || text.startsWith('/pending') ||
                     text.startsWith('/rescrape') || text.startsWith('/force-analyze') ||
                     text.startsWith('/slugs') || text.startsWith('/lolraw')) {
            await handleAdmin(token, chatId, text);
          }
        }
        
        if (update.callback_query) {
          const chatId = update.callback_query.message.chat.id;
          const data = update.callback_query.data;
          await tgRequest(token, 'answerCallbackQuery', {
            callback_query_id: update.callback_query.id
          });
          
          if (data.startsWith('notif_')) {
            const [, s, action] = data.split('_');
            await handleNotificacoes(token, chatId, s, action === 'on' ? 'on' : 'off');
          }
        }
      }
    } catch(e) {
      console.error(`[POLL ${sport}]`, e.message);
      consecutiveErrors++;
    }
    
    const backoff = consecutiveErrors > 0
      ? Math.min(500 * Math.pow(2, consecutiveErrors), MAX_BACKOFF)
      : 500;
    setTimeout(loop, backoff);
  }
  
  loop();
}

// ── Start ──
log('INFO', 'BOOT', 'SportsEdge Bot iniciando...');

(async () => {
  await loadSubscribedUsers();
  
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
  
  // Background tasks
  // Run auto-analysis frequently (esports checks live, MMA has internal rate limiting)
  setInterval(() => runAutoAnalysis().catch(e => log('ERROR', 'AUTO', e.message)), 3 * 60 * 1000);
  setInterval(() => settleCompletedTips().catch(e => log('ERROR', 'SETTLE', e.message)), SETTLEMENT_INTERVAL);
  setInterval(() => checkLineMovement().catch(e => log('ERROR', 'LINE', e.message)), LINE_CHECK_INTERVAL);
  setInterval(() => checkLateReplacements().catch(e => log('ERROR', 'REPLACE', e.message)), REPLACEMENT_INTERVAL);
  setInterval(() => checkLiveNotifications().catch(e => log('ERROR', 'NOTIFY', e.message)), LIVE_CHECK_INTERVAL);
  setInterval(() => checkMMAEventDay().catch(e => log('ERROR', 'MMA-DAY', e.message)), MMA_DAY_CHECK_INTERVAL);
  setInterval(() => checkTennisMatchStart().catch(e => log('ERROR', 'TENNIS-START', e.message)), TENNIS_START_CHECK_INTERVAL);
  setInterval(() => checkTennisWithdrawals().catch(e => log('ERROR', 'TENNIS-WITHDRAW', e.message)), WITHDRAW_CHECK_INTERVAL);
  setInterval(() => runAutoAnalysisTennis().catch(e => log('ERROR', 'AUTO-TENNIS', e.message)), 30 * 60 * 1000);
  
  log('INFO', 'BOOT', `Bots ativos: ${Object.keys(bots).join(', ')}`);
  log('INFO', 'BOOT', 'Pronto! Mande /start em cada bot no Telegram');
})();

module.exports = { bots, subscribedUsers };
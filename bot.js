require('dotenv').config({ override: true });
const https = require('https');
const http = require('http');
const initDatabase = require('./lib/database');
const { SPORTS, getSportById, getSportByToken, getTokenToSportMap } = require('./lib/sports');
const { log, calcKelly, norm, fmtDate, fmtDateTime, fmtDuration, safeParse } = require('./lib/utils');
const { esportsPreFilter } = require('./lib/ml');

const SERVER = '127.0.0.1';
const PORT = parseInt(process.env.SERVER_PORT) || parseInt(process.env.PORT) || 8080;
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



// Patch meta alert
let lastPatchAlert = 0;
const PATCH_ALERT_INTERVAL = 24 * 60 * 60 * 1000;



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
        catch(e) { reject(new Error(`JSON Parse Error: ${e.message} | Body: ${d.slice(0,50)}`)); }
      });
    }).on('error', e => reject(new Error(`HTTP Error on ${SERVER}:${PORT}${path}: ${e.message}`)));
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
        ]
      ]
    }
  };
}

// ── Hydrate tip maps from DB on startup (prevents re-sending after restart) ──
async function loadExistingTips() {
  try {
    // Esports
    const esportsTips = await serverGet('/unsettled-tips', 'esports').catch(() => []);
    if (Array.isArray(esportsTips)) {
      for (const tip of esportsTips) {
        if (!tip.match_id) continue;
        const id = tip.match_id;
        // Mark all possible key formats for this match ID
        for (const prefix of ['lol_', 'upcoming_lol_']) {
          analyzedMatches.set(`${prefix}${id}`, { ts: Date.now(), tipSent: true });
        }
      }
      if (esportsTips.length) log('INFO', 'BOOT', `LoL: ${esportsTips.length} tips existentes carregadas (não serão repetidas)`);
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
async function runAutoAnalysis() {
  const now = Date.now();

  const esportsConfig = SPORTS['esports'];
  if (esportsConfig?.enabled) {
    try {
      const lolRaw = await serverGet('/lol-matches').catch(() => []);
      // Inclui 'draft': composições já disponíveis na API Riot antes do jogo começar.
      // Permite análise com draft real + odds pré-jogo (antes de cair para odds ao vivo).
      const lolLive = Array.isArray(lolRaw) ? lolRaw.filter(m => m.status === 'live' || m.status === 'draft') : [];
      const allLive = lolLive;
      log('INFO', 'AUTO', `LoL: ${lolRaw?.length||0} partidas (${allLive.filter(m=>m.status==='live').length} live, ${allLive.filter(m=>m.status==='draft').length} draft) | inscritos=${subscribedUsers.size}`);

      for (const match of allLive) {
        const matchKey = `${match.game}_${match.id}`;
        const prev = analyzedMatches.get(matchKey);
        if (prev?.tipSent) continue; // uma tip por partida — não repetir
        if (prev && (now - prev.ts < RE_ANALYZE_INTERVAL)) continue;

        log('INFO', 'AUTO', `Esports: ${match.team1} vs ${match.team2} (${match.league})`);
        const result = await autoAnalyzeMatch(esportsConfig.token, match);
        analyzedMatches.set(matchKey, { ts: now, tipSent: prev?.tipSent || false });

        if (!result) continue;
        const hasRealOdds = !!(result.o?.t1 && parseFloat(result.o.t1) > 1);

        if (result.tipMatch) {
          const tipTeam = result.tipMatch[1].trim();
          const tipOdd = result.tipMatch[2].trim();
          const tipEV = result.tipMatch[3].trim();
          const tipStake = calcKelly(tipEV, tipOdd);
          const gameIcon = '🎮';
          const oddsLabel = hasRealOdds ? '' : '\n⚠️ _Odds estimadas (sem mercado disponível)_';

          await serverPost('/record-tip', {
            matchId: String(match.id), eventName: match.league,
            p1: match.team1, p2: match.team2, tipParticipant: tipTeam,
            odds: tipOdd, ev: tipEV, stake: tipStake,
            confidence: result.tipMatch[5]?.trim() || 'MÉDIA', isLive: result.hasLiveStats
          }, 'esports');

          const isDraft = match.status === 'draft';
          const analysisLabel = result.hasLiveStats
            ? '📊 Baseado em dados ao vivo'
            : isDraft
              ? '📋 Análise de draft (composições conhecidas, jogo ainda não iniciado)'
              : '📋 Análise pré-jogo';
          const tipMsg = `${gameIcon} 💰 *TIP ML AUTOMÁTICA*\n` +
            `*${match.team1}* ${match.score1}-${match.score2} *${match.team2}*\n\n` +
            `🎯 Aposta: *${tipTeam}* ML @ *${tipOdd}*\n` +
            `📈 EV: *${tipEV}*\n💵 Stake: *${tipStake}* _(¼ Kelly)_\n` +
            `📋 ${match.league}\n` +
            `_${analysisLabel}_` +
            `${oddsLabel}\n\n` +
            `⚠️ _Aposte com responsabilidade._`;

          for (const [userId, prefs] of subscribedUsers) {
            if (!prefs.has('esports')) continue;
            try { await sendDM(esportsConfig.token, userId, tipMsg); }
            catch(e) { if (e.message?.includes('403')) subscribedUsers.delete(userId); }
          }
          analyzedMatches.set(matchKey, { ts: now, tipSent: true });
          log('INFO', 'AUTO-TIP', `Esports: ${tipTeam} @ ${tipOdd} (odds ${hasRealOdds ? 'reais' : 'estimadas'})`);
        } else if (result.fairOdds && !prev?.tipSent) {
          const fo = result.fairOdds;
          const fo1 = parseFloat(fo[2]).toFixed(2), fo2 = parseFloat(fo[4]).toFixed(2);
          const gameIcon = '🎮';
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

      // ── LoL UPCOMING: Analyze matches in next 24h ──
      const windowEnd = now + UPCOMING_WINDOW_HOURS * 60 * 60 * 1000;
      const allUpcoming = Array.isArray(lolRaw) ? lolRaw.filter(m => {
        if (m.status !== 'upcoming') return false;
        const t = m.time ? new Date(m.time).getTime() : 0;
        return t > now && t <= windowEnd;
      }) : [];

      if (allUpcoming.length > 0) {
        log('INFO', 'AUTO', `LoL próximas ${UPCOMING_WINDOW_HOURS}h: ${allUpcoming.length} partidas`);
        for (const match of allUpcoming) {
          const matchKey = `upcoming_${match.game}_${match.id}`;
          const prev = analyzedMatches.get(matchKey);
          if (prev?.tipSent) continue; // já enviou tip — não repetir

          if (prev && (now - prev.ts < UPCOMING_ANALYZE_INTERVAL)) continue;

          // Verificar odds (enriquece contexto se disponíveis, mas não bloqueia análise)
          const oddsCheck = await serverGet(`/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}`).catch(() => null);
          const hasRealOdds = !!(oddsCheck?.t1 && parseFloat(oddsCheck.t1) > 1);
          const matchTime = match.time ? new Date(match.time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }) : '—';
          log('INFO', 'AUTO', `Esports upcoming: ${match.team1} vs ${match.team2} (${match.league}) às ${matchTime}${hasRealOdds ? ' — odds disponíveis' : ' — odds estimadas'}`);

          const result = await autoAnalyzeMatch(esportsConfig.token, match);
          analyzedMatches.set(matchKey, { ts: now, tipSent: false });

          if (!result) { await new Promise(r => setTimeout(r, 2000)); continue; }

          if (result.tipMatch) {
            const tipTeam = result.tipMatch[1].trim();
            const tipOdd = result.tipMatch[2].trim();
            const tipEV = result.tipMatch[3].trim();
            const tipStake = calcKelly(tipEV, tipOdd);
            const gameIcon = '🎮';

            await serverPost('/record-tip', {
              matchId: String(match.id), eventName: match.league,
              p1: match.team1, p2: match.team2, tipParticipant: tipTeam,
              odds: tipOdd, ev: tipEV, stake: tipStake,
              confidence: result.tipMatch[5]?.trim() || 'MÉDIA', isLive: false
            }, 'esports');

            const tipMsg = `${gameIcon} 💰 *TIP PRÉ-JOGO ESPORTS*\n` +
              `*${match.team1}* vs *${match.team2}*\n📋 ${match.league}\n` +
              (match.time ? `🕐 Início: *${matchTime}* (BRT)\n` : '') +
              `\n🎯 Aposta: *${tipTeam}* ML @ *${tipOdd}*\n` +
              `📈 EV: *${tipEV}*\n💵 Stake: *${tipStake}* _(¼ Kelly)_\n` +
              `📋 _Análise pré-draft: forma e histórico (sem acesso às comps)_\n\n` +
              `⚠️ _Aposte com responsabilidade._`;

            for (const [userId, prefs] of subscribedUsers) {
              if (!prefs.has('esports')) continue;
              try { await sendDM(esportsConfig.token, userId, tipMsg); }
              catch(e) { if (e.message?.includes('403')) subscribedUsers.delete(userId); }
            }
            analyzedMatches.set(matchKey, { ts: now, tipSent: true });
            log('INFO', 'AUTO-TIP', `Esports upcoming: ${tipTeam} @ ${tipOdd}`);
          } else if (result.fairOdds && !prev?.tipSent) {
            const fo = result.fairOdds;
            const fo1 = parseFloat(fo[2]).toFixed(2), fo2 = parseFloat(fo[4]).toFixed(2);
            const gameIcon = '🎮';
            const fairMsg = `${gameIcon} 💡 *ODDS PRÉ-JOGO*\n` +
              `*${match.team1}* vs *${match.team2}*\n_${match.league}_\n` +
              (match.time ? `🕐 Início: *${matchTime}* (BRT)\n` : '') +
              `\n• *${fo[1].trim()}:* *${fo1}*\n• *${fo[3].trim()}:* *${fo2}*\n\n` +
              `💡 _Odds ACIMA desses valores = +EV_\n⚠️ _Aposte com responsabilidade._`;
            for (const [userId, prefs] of subscribedUsers) {
              if (!prefs.has('esports')) continue;
              try { await sendDM(esportsConfig.token, userId, fairMsg); }
              catch(e) { if (e.message?.includes('403')) subscribedUsers.delete(userId); }
            }
            analyzedMatches.set(matchKey, { ts: now, tipSent: true });
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


}

// ── Settlement ──
async function settleCompletedTips() {
  if (Date.now() - lastSettlementCheck < SETTLEMENT_INTERVAL) return;
  lastSettlementCheck = Date.now();

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
  }
  return gamesContext;
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
    const [o, gamesContext, enrich] = await Promise.all([
      serverGet(`/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}`).catch(() => null),
      collectGameContext(game, matchId),
      fetchEnrichment(match)
    ]);
    const hasLiveStats = gamesContext.includes('AO VIVO');
    const enrichSection = buildEnrichmentSection(match, enrich);

    // Pré-filtro ML Local: se o modelo quantitativo não detectar chance de +EV matemático, pulamos o Claude (economia de tokens).
    if (!esportsPreFilter(match, o, enrich, hasLiveStats, gamesContext)) {
      log('INFO', 'AUTO', `Pré-filtro ML: matemática sem borda detectada para ${match.team1} vs ${match.team2}. Ignorando IA subjetiva.`);
      return null;
    }

    const prompt = buildEsportsPrompt(match, game, gamesContext, o, enrichSection);

    const resp = await serverPost('/claude', {
      model: 'claude-sonnet-4-6',
      max_tokens: 1800,
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

// ── Próximas Partidas Handler (OLD — mantido apenas para referência interna) ──

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
    oddsSection = `Odds ML: Não disponíveis — você irá estimar FAIR_ODDS`;
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

  const tipInstruction = hasRealOdds
    ? `[Se EV >= +2% E confiança não foi rebaixada para BAIXA por alto fluxo: TIP_ML:[time]@[odd]|EV:[%]|STAKE:[u]|CONF:[ALTA/MÉDIA/BAIXA]]`
    : `[Se confiança ALTA ou MÉDIA e sem rebaixamento por alto fluxo: TIP_ML:[time]@[fair_odd]|EV:estimado|STAKE:[u]|CONF:[ALTA/MÉDIA]]`;

  return `Você é um analista de apostas de League of Legends. Seu trabalho é identificar edge REAL — não fabricar recomendações.

REGRA FUNDAMENTAL: "Sem edge identificado" é uma resposta válida e frequentemente a correta. A maioria das partidas não tem EV real. Resist the urge to always find a bet.

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
${highFluxWarning ? '\n' + highFluxWarning + '\n' : ''}${lineMovementWarning ? '\n' + lineMovementWarning + '\n' : ''}
ETAPA 1 — LEITURA DO DRAFT (COMPOSIÇÕES E META):
Baseado nas composições listadas e no patch meta fornecido:
→ Qual equipe possui a melhor composição para o Early Game? E para o Lategame (Scaling)?
→ Existe alguma sinergia ou resposta brutal (counter-pick) no Top ou Mid que desequilibra o jogo?
→ Estime de forma seca: P(${t1})=__% | P(${t2})=__%
→ Principal justificativa: [1 frase focada na composição]

ETAPA 2 — VERIFICAÇÃO DE EDGE MATEMÁTICO:
${hasRealOdds
  ? `Odds implícitas do mercado da Pinnacle: ${t1}=${(1/parseFloat(o.t1)*100).toFixed(1)}% | ${t2}=${(1/parseFloat(o.t2)*100).toFixed(1)}%
→ Se a sua estimativa baseada no Draft for < 3pp em relação à Pinnacle: escreva "SEM EDGE" e não emita TIP_ML.
→ Se a composição favorecer assustadoramente uma equipe e a margem for ≥ 3pp: calcule EV = (prob_real × odd) - 1. Só emita tip se EV >= +2%.`
  : `Sem odds de mercado disponíveis (Pinnacle indisponível).
→ Estime P(${t1}) e P(${t2}) baseado puramente na força deste Draft.
→ Estime FAIR_ODDS = 1/prob. (Ex: 65% = 1.54).
→ Só emita TIP_ML se a vantagem da composição for incontestavelmente esmagadora (>65%). Caso contrário, não emita.`}

ANÁLISE DE VIRADA:
• Composição late-game/scaling no time perdedor → virada possível
• Gold diff < 3k com torres intactas → jogo aberto
• Soul point ou Baron buff → fator decisivo
• Carries com KDA+ e item core completo → ameaça real
• Antes dos 20min = cedo demais; 25-35min = janela crítica

NÃO invente dados históricos. Se não tiver dado, diga explicitamente.

FORMATO DE RESPOSTA:
📊 ${t1} vs ${t2}
Estado: [situação atual em 1-2 frases]
Potencial de virada: [ALTO/MÉDIO/BAIXO + motivo]

ETAPA 1 — P(${t1})=__% | P(${t2})=__% | Fator principal: [X] | Incerteza: [Y]
ETAPA 2 — ${hasRealOdds ? `EV(${t1})=[X%] | EV(${t2})=[X%] | Edge: [SIM/NÃO]` : `Fair odds: ${t1}=[X.XX] | ${t2}=[X.XX] | Vantagem clara: [SIM/NÃO]`}
Confiança: [ALTA/MÉDIA/BAIXA] | Motivo do nível: [1 frase]

FAIR_ODDS:${t1}=[1/prob_sem_juice]|${t2}=[1/prob_sem_juice]
${tipInstruction}
${!hasRealOdds ? `\n⚠️ Lembre: sua estimativa sem dados de mercado pode divergir muito do preço real. Só emita TIP_ML com alta convicção (>65% + múltiplos fatores).` : ''}
Máximo 450 palavras.`;
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
          } else if (data.startsWith('menu_')) {
            // menu_{action}_{sport}
            const parts = data.split('_'); // ['menu', action, sport]
            const action = parts[1];
            const s = parts[2] || sport;
            
            if (action === 'notif') {
              await handleNotificacoes(token, chatId, s);
            } else if (action === 'tracking') {
              try {
                const [roi, history] = await Promise.all([
                  serverGet('/roi', s),
                  serverGet('/tips-history?limit=10&filter=settled', s).catch(() => [])
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
            } else if (action === 'proximas') {
              await handleProximas(token, chatId, s);
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

// ── Start ──
log('INFO', 'BOOT', 'SportsEdge Bot iniciando...');
log('INFO', 'BOOT', `ENV: ESPORTS_ENABLED=${process.env.ESPORTS_ENABLED || '(não definida)'}`);
log('INFO', 'BOOT', `ENV: TELEGRAM_TOKEN_ESPORTS=${process.env.TELEGRAM_TOKEN_ESPORTS ? '✅ definida' : '❌ AUSENTE'}`);
log('INFO', 'BOOT', `ENV: CLAUDE_API_KEY=${process.env.CLAUDE_API_KEY ? '✅ definida' : '❌ AUSENTE'}`);
log('INFO', 'BOOT', `ENV: THE_ODDS_API_KEY=${process.env.THE_ODDS_API_KEY ? '✅ definida' : '❌ AUSENTE'}`);
log('INFO', 'BOOT', `Sports carregados: ${JSON.stringify(Object.entries(SPORTS).map(([k,v]) => ({id: k, enabled: v.enabled, hasToken: !!v.token})))}`);

(async () => {
  await loadSubscribedUsers();

  // Garantir que admins estão inscritos em esports no banco
  for (const adminId of ADMIN_IDS) {
    const id = parseInt(adminId);
    if (!id) continue;
    const existing = stmts.getUser.get(id);
    const prefs = JSON.stringify(['esports']);
    if (!existing) {
      stmts.upsertUser.run(id, 'admin', 1, prefs);
      log('INFO', 'BOOT', `Admin ${id} inserido no banco com subscribed=1`);
    } else if (!existing.subscribed) {
      stmts.upsertUser.run(id, existing.username || 'admin', 1, prefs);
      log('INFO', 'BOOT', `Admin ${id} reativado (subscribed=1)`);
    }
    if (!subscribedUsers.has(id)) subscribedUsers.set(id, new Set());
    subscribedUsers.get(id).add('esports');
    log('INFO', 'BOOT', `Admin ${id} inscrito em: esports`);
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
  
  // Background tasks
  setInterval(() => runAutoAnalysis().catch(e => log('ERROR', 'AUTO', e.message)), 6 * 60 * 1000);
  setInterval(() => settleCompletedTips().catch(e => log('ERROR', 'SETTLE', e.message)), SETTLEMENT_INTERVAL);
  setInterval(() => checkLineMovement().catch(e => log('ERROR', 'LINE', e.message)), LINE_CHECK_INTERVAL);
  if (SPORTS.esports?.enabled) {
    setInterval(() => checkLiveNotifications().catch(e => log('ERROR', 'NOTIFY', e.message)), LIVE_CHECK_INTERVAL);
    setInterval(() => checkCLV().catch(e => log('ERROR', 'CLV', e.message)), 5 * 60 * 1000);
  }
  
  log('INFO', 'BOOT', `Bots ativos: ${Object.keys(bots).join(', ')}`);
  log('INFO', 'BOOT', 'Pronto! Mande /start em cada bot no Telegram');
})();

// Função para registrar o Closing Line Value (CLV) antes do jogo
async function checkCLV() {
  if (subscribedUsers.size === 0) return;
  try {
    const unsettled = await serverGet('/unsettled-tips', 'esports');
    if (!Array.isArray(unsettled)) return;
    for (const tip of unsettled) {
      if (tip.clv_odds) continue; // já registrado
      const o = await serverGet(`/odds?team1=${encodeURIComponent(tip.participant1)}&team2=${encodeURIComponent(tip.participant2)}`).catch(() => null);
      if (o && o.t1 > 1) {
        // Assume que se tiver odds reais perto da hora, salvamos como CLV se estiver prestes a começar
        await serverPost('/update-clv', { matchId: tip.match_id, clvOdds: tip.tip_participant === tip.participant1 ? o.t1 : o.t2 }).catch(() => {});
      }
    }
  } catch(e) {}
}

module.exports = { bots, subscribedUsers };
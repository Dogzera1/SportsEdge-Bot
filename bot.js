require('dotenv').config({ override: true });
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const initDatabase = require('./lib/database');
const { SPORTS, getSportById, getSportByToken, getTokenToSportMap } = require('./lib/sports');
const { log, calcKelly, calcKellyFraction, calcKellyWithP, norm, fmtDate, fmtDateTime, fmtDuration, safeParse, cachedHttpGet } = require('./lib/utils');
const { adjustStakeUnits } = require('./lib/risk-manager');
const { esportsPreFilter } = require('./lib/ml');
const { getLolProbability } = require('./lib/lol-model');
const { getFootballProbability } = require('./lib/football-model');
const { getTennisProbability, detectSurface } = require('./lib/tennis-model');
const { fetchMatchNews } = require('./lib/news');
const { tennisPairMatchesPlayers } = require('./lib/tennis-match');

const SERVER = '127.0.0.1';
const PORT = parseInt(process.env.SERVER_PORT) || parseInt(process.env.PORT) || 8080;
const ADMIN_IDS = new Set((process.env.ADMIN_USER_IDS || '').split(',').filter(Boolean));
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

if (!DEEPSEEK_KEY) {
  console.error('❌ Configure DEEPSEEK_API_KEY no .env');
  process.exit(1);
}

// Valida consistência aritmética entre EV reportado pela IA e EV calculado a partir de P + odd.
// IA frequentemente emite P e EV contraditórios (ex: P=95% @ 1.2 mas EV=+8.6% quando o correto seria +14%).
// Retorna {valid, reason, reportedEv, computedEv, p}. Tolerância padrão = 3pp.
/**
 * EV determinístico a partir da probabilidade do modelo (ML/Elo/enrich),
 * em vez de confiar no EV que a IA (Claude/DeepSeek) reporta no `TIP_ML:`.
 *
 * Histórico: a IA às vezes chuta probabilidade P≈50% pra underdog, retornando
 * EV = 0.5 × odds − 1, o que infla o valor em relação ao que o modelo acredita.
 * Aqui a gente recalcula usando `modelPPick × odds − 1` quando há modelP válido.
 * Retorna null se o modelP não estiver disponível (aí o caller pode manter o EV da IA).
 */
function _modelEv(modelPPick, odds) {
  const p = typeof modelPPick === 'number' ? modelPPick : parseFloat(modelPPick);
  const o = typeof odds === 'number' ? odds : parseFloat(odds);
  if (!Number.isFinite(p) || !Number.isFinite(o) || p <= 0 || p >= 1 || o <= 1) return null;
  return +((p * o - 1) * 100).toFixed(1);
}

function _validateTipEvP(text, pickOdd, reportedEvPct, tolerancePp = 3) {
  const pMatch = String(text || '').match(/\|P:\s*([0-9.]+)\s*%?/i);
  if (!pMatch) return { valid: true, reason: 'no_p_field' };
  const p = parseFloat(pMatch[1]);
  const odd = parseFloat(pickOdd);
  const evR = parseFloat(String(reportedEvPct).replace(/[+%\s]/g, ''));
  if (!Number.isFinite(p) || !Number.isFinite(odd) || !Number.isFinite(evR) || odd <= 1 || p <= 0 || p > 100) {
    return { valid: true, reason: 'invalid_numbers' };
  }
  const evC = (p / 100 * odd - 1) * 100;
  const diff = Math.abs(evC - evR);
  if (diff > tolerancePp) {
    return { valid: false, reason: `EV inconsistente: reportado=${evR.toFixed(1)}% vs calculado=${evC.toFixed(1)}% (P=${p}% @ ${odd}) diff=${diff.toFixed(1)}pp`, reportedEv: evR, computedEv: evC, p, odd };
  }
  return { valid: true, reportedEv: evR, computedEv: evC, p, odd };
}

/**
 * Parseia resposta IA TIP_ML num layout compatível com o antigo (6 grupos).
 * Aceita ambos formatos:
 *   - Novo: TIP_ML:time@odd|P:X%|STAKE:Yu|CONF:...
 *   - Antigo: TIP_ML:time@odd|EV:X%|P:Y%|STAKE:Zu|CONF:...
 * EV ausente é recalculado via P × odd − 1 (fonte da verdade = P).
 *
 * @returns {Array|null} [full, team, odd, evStr, stake, conf] compatível com código legado
 */
function _parseTipMl(text) {
  const raw = String(text || '').match(
    /TIP_ML:\s*([^@]+?)\s*@\s*([^|\]]+?)\s*\|\s*(?:EV:\s*([+-]?[\d.]+)\s*%?\s*\|\s*)?P:\s*([\d.]+)\s*%?\s*\|\s*STAKE:\s*([^|\]]+?)(?:\s*\|\s*CONF:\s*([A-Za-zÀ-ÿ]+))?(?=\]|\s|$)/i
  );
  if (!raw) return null;
  const team = raw[1].trim();
  const oddStr = raw[2].trim();
  const evTxt = raw[3] != null ? String(raw[3]).replace(/[+%\s]/g, '') : null;
  const pTxt = raw[4];
  const stake = raw[5];
  const conf = raw[6];
  const pNum = parseFloat(pTxt);
  const odd = parseFloat(oddStr);
  let evFinal;
  if (evTxt != null && Number.isFinite(parseFloat(evTxt))) {
    evFinal = String(evTxt);
  } else if (Number.isFinite(pNum) && Number.isFinite(odd) && odd > 1) {
    evFinal = ((pNum / 100 * odd - 1) * 100).toFixed(1); // recalcula EV de P
  } else {
    evFinal = '0';
  }
  return [raw[0], team, oddStr, evFinal, stake, conf];
}

/**
 * Valida P reportado pela IA contra P do modelo determinístico.
 * Source of truth = modelP. Se IA escreveu P divergente → rejeita (IA ignorou modelo).
 * Se IA só errou EV (P bate com modelo), aceita — EV será recalculado via _modelEv downstream.
 *
 * @param {string} text       — resposta completa da IA
 * @param {number} modelP     — probabilidade do modelo (0..1)
 * @param {number} [tolPp=8]  — tolerância em pp entre P texto e P modelo
 * @returns {{ valid: boolean, reason?: string, textP?: number, modelP?: number, diffPp?: number }}
 */
function _validateTipPvsModel(text, modelP, tolPp = 8) {
  if (!Number.isFinite(modelP) || modelP <= 0 || modelP >= 1) return { valid: true, reason: 'no_model_p' };
  const pMatch = String(text || '').match(/\|P:\s*([0-9.]+)\s*%?/i);
  if (!pMatch) return { valid: true, reason: 'no_text_p' };
  const textP = parseFloat(pMatch[1]) / 100;
  if (!Number.isFinite(textP) || textP <= 0 || textP >= 1) return { valid: true, reason: 'invalid_text_p' };
  const diffPp = Math.abs(textP - modelP) * 100;
  if (diffPp > tolPp) {
    return { valid: false, reason: `P divergente do modelo: IA=${(textP*100).toFixed(1)}% vs modelo=${(modelP*100).toFixed(1)}% diff=${diffPp.toFixed(1)}pp`, textP, modelP, diffPp };
  }
  return { valid: true, textP, modelP, diffPp };
}

/**
 * Gate de divergência modelo vs mercado sharp (Pinnacle/Betfair).
 * Em book sharp, edges reais são tipicamente 1-8pp. Divergência grande sem razão clara
 * = quase sempre erro do modelo (dado faltando, sample pequeno, viés). Apostar tipsum
 * com edge fictício leva a Kelly inflado e ruína de bankroll a longo prazo.
 *
 * @param {object} args
 * @param {object} args.oddsObj   — { t1, t2, bookmaker } da partida
 * @param {number} args.modelP    — P do modelo pra pick (0..1)
 * @param {number} args.impliedP  — P implícita dejuiced do mercado pra pick (0..1)
 * @param {number} args.maxPp     — limite de divergência em pp (sport-specific)
 * @returns {{ ok: boolean, divPp: number|null, reason: string|null }}
 */
function _sharpDivergenceGate({ oddsObj, modelP, impliedP, maxPp }) {
  if (!Number.isFinite(modelP) || !Number.isFinite(impliedP) || modelP <= 0 || impliedP <= 0) return { ok: true, divPp: null, reason: null };
  const bookmaker = String(oddsObj?.bookmaker || '').toLowerCase();
  const isSharp = /pinnacle|betfair/.test(bookmaker);
  if (!isSharp) return { ok: true, divPp: null, reason: 'not_sharp_book' };
  const divPp = Math.abs(modelP - impliedP) * 100;
  if (divPp > maxPp) {
    return { ok: false, divPp, reason: `Divergência modelP=${(modelP*100).toFixed(1)}% vs ${bookmaker} dejuiced=${(impliedP*100).toFixed(1)}% Δ${divPp.toFixed(1)}pp > ${maxPp}pp cap` };
  }
  return { ok: true, divPp, reason: null };
}

/**
 * Calcula impliedP1/impliedP2 dejuiced a partir de odds {t1, t2}.
 */
function _impliedFromOdds(oddsObj) {
  const o1 = parseFloat(oddsObj?.t1);
  const o2 = parseFloat(oddsObj?.t2);
  if (!Number.isFinite(o1) || !Number.isFinite(o2) || o1 <= 1 || o2 <= 1) return null;
  const r1 = 1 / o1, r2 = 1 / o2;
  const vig = r1 + r2;
  return { impliedP1: r1 / vig, impliedP2: r2 / vig };
}

/**
 * IA "segunda opinião" compartilhada por bots sem IA própria (Valorant/Darts/Snooker/TT).
 * Recebe contexto pronto (modelo já calculou pick/P/EV); IA decide se concorda.
 *
 * @param {object} args
 * @param {string} args.sport         — log tag ('valorant', 'darts', etc.)
 * @param {string} args.matchLabel    — "team1 vs team2"
 * @param {string} args.league        — nome da liga
 * @param {string} args.pickTeam      — pick do modelo
 * @param {number} args.pickOdd       — odd da pick
 * @param {number} args.pickP         — probabilidade do modelo (0..1)
 * @param {number} args.evPct         — EV em %
 * @param {string} args.contextBlock  — bloco multiline com Elo/form/H2H/live
 * @param {boolean}[args.isLive=false]
 * @param {number} [args.tolPp=10]    — tolerância P-modelo vs P-IA em pp
 * @returns {Promise<{passed: boolean, reason: string|null, conf: string|null}>}
 */
async function _aiSecondOpinion(args) {
  const { sport, matchLabel, league, pickTeam, pickOdd, pickP, evPct, contextBlock, isLive = false, tolPp = 10, oddsObj = null, impliedP = null, maxDivPp = null } = args;
  const tag = `AUTO-${String(sport).toUpperCase()}`;

  // Pré-gate: divergência modelo vs Pinnacle/Betfair (sharp anchor). Bloqueia ANTES da IA pra economizar tokens.
  if (oddsObj && Number.isFinite(impliedP) && Number.isFinite(maxDivPp)) {
    const _div = _sharpDivergenceGate({ oddsObj, modelP: pickP, impliedP, maxPp: maxDivPp });
    if (!_div.ok) return { passed: false, reason: _div.reason, conf: null };
  }

  const prompt = `Análise ${sport.toUpperCase()} — ${matchLabel} (${league}) ${isLive ? '[AO VIVO]' : '[PRÉ-JOGO]'}

${contextBlock}

Pick proposta pelo modelo: ${pickTeam} @ ${pickOdd} (P=${(pickP*100).toFixed(1)}%, EV=${evPct.toFixed(1)}%)

Avalie:
1. P do modelo é razoável dado contexto (form, H2H, ranking, dados live)?
2. Modelo pode estar inflando edge se: amostra pequena, time/jogador pouco conhecido, surface/condição atípica.
3. Mercados sharp (Pinnacle/Betfair) raramente erram >10pp — divergência grande sem razão clara = modelo errado.

DECISÃO:
TIP_ML:[time]@[odd]|P:[%]|STAKE:[1-3]u|CONF:[ALTA/MÉDIA/BAIXA]
(Só forneça P inteiro 0-100; sistema calcula EV. Use a MESMA pick do modelo se concordar.)
ou SEM_EDGE (se modelo está errado / dados insuficientes / risco alto)

Máximo 150 palavras.`;

  let iaResp = '';
  try {
    const iaRaw = await serverPost('/claude', { messages: [{ role: 'user', content: prompt }], max_tokens: 350 }).catch(() => null);
    iaResp = iaRaw?.content?.[0]?.text || iaRaw?.result || iaRaw?.text || '';
  } catch (e) {
    log('WARN', tag, `IA erro: ${e.message}`);
    return { passed: true, reason: 'ia_error', conf: null }; // fail-open: IA indisponível não bloqueia
  }

  if (!iaResp) return { passed: true, reason: 'ia_no_response', conf: null };
  if (/SEM_EDGE/i.test(iaResp)) return { passed: false, reason: 'IA SEM_EDGE', conf: null };

  const iaTip = _parseTipMl(iaResp);
  if (!iaTip) return { passed: true, reason: 'ia_no_tipml', conf: null };

  // Pick deve ser a mesma
  const iaPick = String(iaTip[1] || '').trim();
  const samePick = norm(iaPick) === norm(pickTeam)
    || norm(pickTeam).includes(norm(iaPick))
    || norm(iaPick).includes(norm(pickTeam));
  if (!samePick) return { passed: false, reason: `IA pick diferente (modelo=${pickTeam} IA=${iaPick})`, conf: null };

  // Validador P-vs-modelo
  const _v = _validateTipPvsModel(iaResp, pickP, tolPp);
  if (!_v.valid) return { passed: false, reason: _v.reason, conf: null };

  const conf = (iaTip[5] || '').toUpperCase().replace('MEDIA', 'MÉDIA') || null;
  return { passed: true, reason: null, conf };
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
  } catch(e) { log('WARN', 'PATCH', `Erro ao carregar patch meta: ${e.message}`); }
}

function savePatchMetaToFile(meta, date) {
  try {
    fs.writeFileSync(PATCH_META_FILE, JSON.stringify({ meta, date }), 'utf8');
  } catch(e) { log('WARN', 'PATCH', `Erro ao salvar patch meta: ${e.message}`); }
}

// Carrega meta persistido imediatamente
loadPatchMetaFromFile();

// ── Bot Instances ──
const bots = {};
const tokenToSport = getTokenToSportMap();
const subscribedUsers = new Map(); // userId → Set<sport>

// Auto-analysis state
const analyzedMatches = new Map();
// Serie-level dedup LoL: evita re-tip entre mapas quando placar nao mudou e EV e semelhante.
// key = match.id da serie | value = { pick, ev, score1, score2, ts, mapNum }
const lolSeriesLastTip = new Map();
const analyzedMma = new Map();
const analyzedTennis = new Map();
const analyzedFootball = new Map();
const analyzedDota = new Map();
const analyzedDarts = new Map();
const analyzedSnooker = new Map();
const analyzedTT = new Map();
const analyzedCs = new Map();
const analyzedValorant = new Map();

// ── Gate global de prioridade LIVE ──────────────────────────────────────
// Cada esporte registra 'esporte' em _livePhase enquanto processa live matches.
// Antes do primeiro upcoming, chama _waitOthersLiveDone(self) — bloqueia até
// nenhum outro esporte ter live pendente. Garante que TODO live do sistema
// é analisado antes de qualquer upcoming de qualquer esporte.
const _livePhase = new Set();
async function _waitOthersLiveDone(self, timeoutMs = 3 * 60 * 1000) {
  const start = Date.now();
  while (true) {
    const others = [..._livePhase].filter(s => s !== self);
    if (others.length === 0) return;
    if (Date.now() - start > timeoutMs) {
      log('WARN', 'AUTO', `live-gate timeout (${self}), prosseguindo. others=${others.join(',')}`);
      return;
    }
    await new Promise(r => setTimeout(r, 500));
  }
}
function _livePhaseEnter(sport) { _livePhase.add(sport); }
function _livePhaseExit(sport)  { _livePhase.delete(sport); }

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
let lastDotaLiveCheck = 0;
const DOTA_LIVE_CHECK_INTERVAL = 5 * 60 * 1000; // 5 min (evita spam de requests)
const RE_ANALYZE_INTERVAL = 10 * 60 * 1000; // 10 min between re-analyses of same live match
// Pré-jogo: intervalo maior para economizar tokens IA (odds pré-jogo mudam pouco).
// Default 2h (antes 30min). Configurável via LOL_UPCOMING_INTERVAL_MIN.
// Live continua usando RE_ANALYZE_INTERVAL (10min) — mercado muda rápido.
const UPCOMING_ANALYZE_INTERVAL = Math.max(10, parseInt(process.env.LOL_UPCOMING_INTERVAL_MIN || '120', 10) || 120) * 60 * 1000;
const UPCOMING_WINDOW_HOURS = 24; // analyze upcoming matches within next 24h

// Deduplicação de updates de tip (anti-spam)
const tipUpdateNotifyCache = new Map(); // key -> ts
const TIP_UPDATE_DEDUP_MS =
  (parseInt(process.env.TIP_UPDATE_DEDUP_MIN || '30', 10) || 30) * 60 * 1000;

// Throttle de "force refresh" odds (evita 5 chamadas simultâneas)
let _forceOddsChain = Promise.resolve();
const FORCE_ODDS_GAP_MS = Math.max(500, parseInt(process.env.FORCE_ODDS_GAP_MS || '2500', 10) || 2500);
function forceOddsRefreshQueued(team1, team2, game = '') {
  const t1 = String(team1 || '');
  const t2 = String(team2 || '');
  const gameQ = game ? `&game=${encodeURIComponent(game)}` : '';
  const path = `/odds?team1=${encodeURIComponent(t1)}&team2=${encodeURIComponent(t2)}&force=1${gameQ}`;
  const p = _forceOddsChain.then(async () => {
    const r = await serverGet(path).catch(() => null);
    await _sleep(FORCE_ODDS_GAP_MS);
    return r;
  });
  // Mantém cadeia viva mesmo se job falhar
  _forceOddsChain = p.catch(() => {}).then(() => {});
  return p;
}



// Patch meta alert
let lastPatchAlert = 0;
const PATCH_ALERT_INTERVAL = 24 * 60 * 60 * 1000;

// ── Constantes de confiança ──
const CONF = { ALTA: 'ALTA', MEDIA: 'MÉDIA', BAIXA: 'BAIXA' };





// ── Telegram Request ──
function tgRequestOnce(token, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      family: 4, // força IPv4 — Railway tem problemas de conectividade IPv6 com Telegram
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
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('TelegramTimeout'), { code: 'ETIMEDOUT' })));
    req.write(body);
    req.end();
  });
}

function tgRequest(token, method, params) {
  const timeoutMs = Math.max(15000, Math.min(120000, parseInt(process.env.TELEGRAM_HTTP_TIMEOUT_MS || '50000', 10) || 50000));
  const maxAttempts = Math.max(1, Math.min(4, parseInt(process.env.TELEGRAM_HTTP_ATTEMPTS || '2', 10) || 2));
  return (async () => {
    let lastErr;
    for (let a = 1; a <= maxAttempts; a++) {
      try {
        return await tgRequestOnce(token, method, params, timeoutMs);
      } catch (e) {
        lastErr = e;
        const msg = String(e && e.message || '');
        if (a < maxAttempts && (msg.includes('TelegramTimeout') || msg.includes('ETIMEDOUT'))) {
          await new Promise(r => setTimeout(r, 1500 * a));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  })();
}

// Handler global para promises não tratadas — evita crash do processo
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  // Erros de rede do Telegram são esperados em instabilidades — não crashar
  if (msg.includes('ETIMEDOUT') || msg.includes('ENETUNREACH') || msg.includes('ECONNREFUSED') || msg.includes('TelegramTimeout')) {
    log('WARN', 'NET', `Telegram connection error (ignored): ${msg}`);
  } else {
    log('ERROR', 'UNCAUGHT', `unhandledRejection: ${msg}`);
  }
});

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
        try {
          const parsed = JSON.parse(d);
          // Stamp _oddsFetchedAt em respostas de matches e odds para tracking de freshness
          const now = Date.now();
          if (Array.isArray(parsed)) {
            for (const m of parsed) {
              if (m?.odds && !m.odds._fetchedAt) m.odds._fetchedAt = now;
            }
          } else if (parsed?.t1 && parsed?.t2 && !parsed._fetchedAt) {
            parsed._fetchedAt = now;
          }
          resolve(parsed);
        }
        catch(e) { reject(new Error(`JSON Parse Error: ${e.message} | Body: ${d.slice(0,50)}`)); }
      });
    }).on('error', e => reject(new Error(`HTTP Error on ${SERVER}:${PORT}${path}: ${e.message}`)));
  });
}

// ── Odds freshness validation ──
// Live: odds > 2min são stale (mercado muda a cada jogada)
// Pregame: odds > 10min são stale (linhas movem mais devagar)
const ODDS_MAX_AGE_LIVE_MS = parseInt(process.env.ODDS_MAX_AGE_LIVE_SEC || '120', 10) * 1000;   // 2min
const ODDS_MAX_AGE_PRE_MS  = parseInt(process.env.ODDS_MAX_AGE_PRE_SEC  || '600', 10) * 1000;   // 10min

function isOddsFresh(odds, isLive) {
  if (!odds?._fetchedAt) return true; // sem timestamp = não bloquear (backward compat)
  const age = Date.now() - odds._fetchedAt;
  const maxAge = isLive ? ODDS_MAX_AGE_LIVE_MS : ODDS_MAX_AGE_PRE_MS;
  return age <= maxAge;
}

function oddsAgeStr(odds) {
  if (!odds?._fetchedAt) return '?';
  const sec = Math.round((Date.now() - odds._fetchedAt) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
}

// ── Sharp line validation (Pinnacle como referência) ──
// Se temos a linha sharp (Pinnacle) e a odd usada é PIOR que Pinnacle para o lado apostado,
// não há edge real — o soft book já ajustou ou o mercado é eficiente.
// Retorna { ok, reason, sharpOdd, betOdd } ou { ok: true } se sem sharp disponível.
const SHARP_LINE_ENABLED = (process.env.SHARP_LINE_CHECK ?? 'true') !== 'false';

function checkSharpLine(odds, tipParticipant, team1, team2) {
  if (!SHARP_LINE_ENABLED) return { ok: true };
  if (!odds?._sharp?.t1) return { ok: true }; // sem sharp disponível — não bloquear
  const sharp = odds._sharp;
  const isT1 = norm(tipParticipant).includes(norm(team1)) || norm(team1).includes(norm(tipParticipant));
  const betOdd = isT1 ? parseFloat(odds.t1) : parseFloat(odds.t2);
  const sharpOdd = isT1 ? parseFloat(sharp.t1) : parseFloat(sharp.t2);
  if (!betOdd || !sharpOdd || betOdd <= 1 || sharpOdd <= 1) return { ok: true };
  // A odd do soft book tem que ser >= Pinnacle para ter value
  // Tolerância: 2% (soft book pode ter margem ligeiramente diferente)
  if (betOdd < sharpOdd * 0.98) {
    return { ok: false, reason: `soft ${betOdd.toFixed(2)} < sharp ${sharpOdd.toFixed(2)} (Pinnacle)`, sharpOdd, betOdd };
  }
  return { ok: true, sharpOdd, betOdd };
}

// ── Odds history logging (1x por análise) ──
const _oddsHistoryLogged = new Map(); // matchId → lastLoggedAt
function logOddsHistory(sport, matchId, p1, p2, odds) {
  if (!odds?.t1 || !odds?.t2) return;
  const key = `${sport}_${matchId}`;
  const lastLog = _oddsHistoryLogged.get(key) || 0;
  if (Date.now() - lastLog < 5 * 60 * 1000) return; // max 1x a cada 5min por match
  _oddsHistoryLogged.set(key, Date.now());
  // Fire-and-forget — não bloquear a análise
  serverPost('/log-odds-history', {
    sport, matchKey: String(matchId), p1, p2,
    oddsP1: parseFloat(odds.t1) || 0, oddsP2: parseFloat(odds.t2) || 0,
    bookmaker: odds.bookmaker || '?'
  }).catch(() => {});
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
        try {
          const parsed = JSON.parse(d);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsed.__status = res.statusCode;
            parsed.__path = path;
          }
          resolve(parsed);
        }
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

// Multiplicadores de stake por liga (tier-2/3 = mais variância, menor Kelly)
// Configurável via LOL_LEAGUE_RISK_MULTIPLIERS no .env (JSON)
const _leagueRiskMultipliers = (() => {
  try {
    const custom = process.env.LOL_LEAGUE_RISK_MULTIPLIERS;
    if (custom) return JSON.parse(custom);
  } catch(_) {}
  return {
    // T1 — sem redução
    lck: 1.0, lcs: 1.0, lec: 1.0, lpl: 1.0, worlds: 1.0, msi: 1.0,
    cblol: 0.9, 'cblol-brazil': 0.9, lla: 0.9, pcs: 0.9, lco: 0.9, vcs: 0.9,
    // T2 — redução de 25-40%
    'prime-league': 0.7, primeleague: 0.7, 'emea-masters': 0.75, 'lck-cl': 0.75,
    lfl: 0.7, nlc: 0.7, 'ultraliga': 0.7, lit: 0.65, les: 0.65, lrn: 0.65, lrs: 0.65,
    'road-of-legends': 0.65, nacl: 0.7, ldl: 0.75,
    // T3 — redução de 50%
    default: 0.6,
  };
})();

function getLeagueRiskMultiplier(leagueSlug) {
  if (!leagueSlug) return _leagueRiskMultipliers.default ?? 0.6;
  const slug = String(leagueSlug).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return _leagueRiskMultipliers[slug] ?? _leagueRiskMultipliers.default ?? 0.6;
}

// Ligas bloqueadas — controlado por LOL_BLOCK_MAIN_LEAGUES (default: false = sem bloqueio)
const _LOL_BLOCK_MAIN = /^(1|true|yes)$/i.test(String(process.env.LOL_BLOCK_MAIN_LEAGUES || 'false'));
const LOL_MAIN_LEAGUES = new Set([
  'lck', 'lcs', 'lec', 'lpl', 'worlds', 'msi',
  'cblol', 'cblolbrazil', 'lla', 'pcs', 'lco', 'vcs',
]);
function isMainLeague(leagueSlug) {
  if (!_LOL_BLOCK_MAIN) return false;
  if (!leagueSlug) return false;
  const slug = String(leagueSlug).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return LOL_MAIN_LEAGUES.has(slug);
}
// Detecta se liga LoL é tier1 (premier). Pra ligas tier 2-3 endurecemos gates pós-bleed
// histórico: ROI -56% em tier2plus por EV inflado em Prime League/LFL/Rift Legends/etc.
function isLolTier1(leagueOrSlug) {
  if (!leagueOrSlug) return false;
  const slug = String(leagueOrSlug).toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (LOL_MAIN_LEAGUES.has(slug)) return true;
  // Match por nome também (event_name vs leagueSlug)
  return /\b(lck|lec|lcs|lpl|msi|worlds|cblol|cbloldbrazil|lla|pcs|lco|vcs|esports world cup)\b/i.test(String(leagueOrSlug));
}

// Cache de drawdown por sport (atualizado a cada chamada de risk)
const _drawdownCache = new Map(); // sport → { pct, checkedAt }
const DRAWDOWN_CACHE_TTL = 5 * 60 * 1000; // refresh a cada 5min
const DRAWDOWN_HARD_LIMIT = parseFloat(process.env.DRAWDOWN_HARD_LIMIT || '0.25'); // 25% = bloqueia
const DRAWDOWN_SOFT_LIMIT = parseFloat(process.env.DRAWDOWN_SOFT_LIMIT || '0.15'); // 15% = reduz 50%

async function applyGlobalRisk(sport, desiredUnits, leagueSlug) {
  if (!desiredUnits || desiredUnits <= 0) return { ok: false, units: 0, reason: 'stake_zero' };

  // ── Drawdown check: reduz/bloqueia stakes quando banca está em queda ──
  let drawdownMult = 1.0;
  const cached = _drawdownCache.get(sport);
  if (!cached || Date.now() - cached.checkedAt > DRAWDOWN_CACHE_TTL) {
    try {
      const bk = await serverGet(`/bankroll`, sport).catch(() => null);
      if (bk?.initialBanca && bk?.currentBanca && bk.initialBanca > 0) {
        const drawdown = (bk.initialBanca - bk.currentBanca) / bk.initialBanca;
        _drawdownCache.set(sport, { pct: drawdown, checkedAt: Date.now() });
        if (drawdown >= DRAWDOWN_HARD_LIMIT) {
          log('WARN', 'RISK', `${sport}: drawdown ${(drawdown * 100).toFixed(1)}% ≥ ${DRAWDOWN_HARD_LIMIT * 100}% — BLOQUEADO`);
          return { ok: false, units: 0, reason: `drawdown_${(drawdown * 100).toFixed(0)}pct` };
        }
        if (drawdown >= DRAWDOWN_SOFT_LIMIT) {
          drawdownMult = 0.5;
          log('INFO', 'RISK', `${sport}: drawdown ${(drawdown * 100).toFixed(1)}% ≥ ${DRAWDOWN_SOFT_LIMIT * 100}% — stakes ×0.5`);
        }
      }
    } catch (_) {}
  } else if (cached.pct >= DRAWDOWN_HARD_LIMIT) {
    return { ok: false, units: 0, reason: `drawdown_${(cached.pct * 100).toFixed(0)}pct` };
  } else if (cached.pct >= DRAWDOWN_SOFT_LIMIT) {
    drawdownMult = 0.5;
  }

  // Ajuste por liga (tier-2/3 = stake reduzido proporcionalmente) — apenas esports/LoL
  const leagueMult = (sport === 'esports' && leagueSlug) ? getLeagueRiskMultiplier(leagueSlug) : 1.0;

  // Stake multiplier dinâmico (performance histórica): league ROI × streak × daily stop-loss
  let perfMult = 1.0;
  let perfReasons = [];
  if (leagueSlug) {
    try {
      const sm = await serverGet(`/stake-multiplier?sport=${encodeURIComponent(sport)}&league=${encodeURIComponent(leagueSlug)}`, sport).catch(() => null);
      if (sm && typeof sm.multiplier === 'number') {
        perfMult = sm.multiplier;
        perfReasons = Array.isArray(sm.reasons) ? sm.reasons : [];
        if (sm.blocked) {
          log('WARN', 'RISK', `${sport} (${leagueSlug}): ${sm.blocked} — BLOQUEADO | ${perfReasons.join(' | ')}`);
          return { ok: false, units: 0, reason: sm.blocked };
        }
      }
    } catch (_) {}
  }

  const adjusted = Math.max(0.5, Math.round(desiredUnits * leagueMult * drawdownMult * perfMult * 2) / 2);
  const reason = drawdownMult < 1 ? 'drawdown_reduction'
               : perfMult !== 1.0 ? 'perf_adjusted'
               : leagueMult < 1 ? 'league_tier_reduction'
               : 'ok';
  if (adjusted !== desiredUnits) {
    const perfStr = perfMult !== 1.0 ? ` perf=${perfMult}(${perfReasons.slice(0,2).join(';')})` : '';
    log('INFO', 'RISK', `${sport}${leagueSlug ? ` (${leagueSlug})` : ''}: ${desiredUnits}u→${adjusted}u (league=${leagueMult} drawdown=${drawdownMult}${perfStr})`);
  }
  return { ok: true, units: adjusted, reason };
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
    const [esportsTips, dotaTips, mmaTips, tennisTips, footballTips] = await Promise.all([
      serverGet('/tips-history?limit=400', 'esports').catch(() => []),
      serverGet('/tips-history?limit=400&game=dota2', 'esports').catch(() => []),
      serverGet('/tips-history?limit=400', 'mma').catch(() => []),
      serverGet('/tips-history?limit=400', 'tennis').catch(() => []),
      serverGet('/tips-history?limit=400', 'football').catch(() => [])
    ]);
    if (Array.isArray(esportsTips)) {
      for (const tip of esportsTips) {
        if (!tip.match_id) continue;
        const mid = String(tip.match_id);
        if (mid.startsWith('dota2_')) continue; // tratado em dotaTips
        const rawId = mid.startsWith('lol_') ? mid.slice(4) : mid;
        analyzedMatches.set(`lol_${rawId}`, { ts: Date.now(), tipSent: true });
        analyzedMatches.set(`upcoming_lol_${rawId}`, { ts: Date.now(), tipSent: true });
      }
      if (esportsTips.length) log('INFO', 'BOOT', `LoL: ${esportsTips.length} tips existentes carregadas`);
    }
    if (Array.isArray(dotaTips)) {
      for (const tip of dotaTips) {
        if (!tip.match_id) continue;
        const mid = tip.match_id;
        // Chave por matchId (evita prefixo duplicado dota2_dota2_)
        const idKey = mid.startsWith('dota2_') ? mid : `dota2_${mid}`;
        const tipTs = tip.sent_at ? new Date(tip.sent_at).getTime() : Date.now();
        analyzedDota.set(idKey, { ts: tipTs, tipSent: true });
        // Chave por nomes normalizados — impede duplicata quando matchId muda entre fontes
        const p1n = norm(tip.participant1 || '');
        const p2n = norm(tip.participant2 || '');
        if (p1n && p2n) {
          analyzedDota.set(`dota2_pair_${p1n}_${p2n}`, { ts: tipTs, tipSent: true });
        }
      }
      if (dotaTips.length) log('INFO', 'BOOT', `Dota 2: ${dotaTips.length} tips existentes carregadas (${analyzedDota.size} chaves dedup)`);
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
        const k = `tennis_${tip.match_id}`;
        const existing = analyzedTennis.get(k) || { ts: Date.now() };
        if (tip.is_live) existing.tipSentLive = true; else existing.tipSentPre = true;
        analyzedTennis.set(k, existing);
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

/** ESPN `post` usa data de início; exige fim estimado ≥ sent_at para não pegar H2H antigo.
 *  Buffer padrão: 3h (cobre jogos longos do mesmo dia sem pegar rodadas anteriores do torneio).
 *  Resultados sem data são rejeitados para evitar falsos positivos. */
function tennisEspnRecentResultEligibleForTip(r, tipMs) {
  if (!Number.isFinite(tipMs)) return true;
  const d = r?.date;
  if (!d) return false; // sem data → não confiável, rejeita
  const startMs = Date.parse(String(d).includes('T') ? String(d) : String(d).replace(' ', 'T'));
  if (!Number.isFinite(startMs)) return false; // data inválida → rejeita
  // Buffer: jogo deve ter COMEÇADO no máximo `h` horas antes do tip.
  // 3h cobre partidas longas do mesmo dia; evita pegar rodadas de dias anteriores.
  const h = Math.max(0, Math.min(6, parseInt(process.env.TENNIS_ESPN_POST_BUFFER_H || '3', 10) || 3));
  return startMs + h * 3600000 >= tipMs;
}

/** Remove prefixo interno para comparar com id do The Odds API */
function stripTheOddsMatchId(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('tennis_')) s = s.slice(7);
  else if (s.startsWith('mma_')) s = s.slice(4);
  return s;
}

/** Nomes de tenistas/lutadores: abreviação vs nome completo */
function fuzzyPlayerNameMatch(displayA, displayB) {
  const na = norm(displayA), nb = norm(displayB);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 5 && nb.length >= 5 && (na.includes(nb) || nb.includes(na))) return true;
  const tokensA = String(displayA || '').trim().split(/\s+/).filter(Boolean);
  const tokensB = String(displayB || '').trim().split(/\s+/).filter(Boolean);
  const la = tokensA.length ? norm(tokensA[tokensA.length - 1]) : '';
  const lb = tokensB.length ? norm(tokensB[tokensB.length - 1]) : '';
  return la.length >= 4 && lb.length >= 4 && la === lb;
}

/** Alinha tip pendente com evento atual da API (id ou nomes) */
function findTheOddsH2hMatch(list, tip) {
  if (!Array.isArray(list) || !list.length) return null;
  const mid = stripTheOddsMatchId(tip.match_id);
  const p1 = tip.participant1 || '';
  const p2 = tip.participant2 || '';
  let m = list.find(x => x && mid && String(x.id) === mid);
  if (m) return m;
  const n1 = norm(p1), n2 = norm(p2);
  m = list.find(x => {
    const a1 = norm(x.team1 || ''), a2 = norm(x.team2 || '');
    return (a1 === n1 && a2 === n2) || (a1 === n2 && a2 === n1);
  });
  if (m) return m;
  return list.find(x =>
    (fuzzyPlayerNameMatch(p1, x.team1) && fuzzyPlayerNameMatch(p2, x.team2)) ||
    (fuzzyPlayerNameMatch(p1, x.team2) && fuzzyPlayerNameMatch(p2, x.team1))
  ) || null;
}

function h2hDecimalOddsForPick(m, pick) {
  if (!m?.odds) return null;
  const t1 = m.odds.t1 != null ? m.odds.t1 : m.odds.h;
  const t2 = m.odds.t2 != null ? m.odds.t2 : m.odds.a;
  const o1 = parseFloat(t1);
  const o2 = parseFloat(t2);
  const pickN = norm(pick);
  if (pickN === norm(m.team1) || fuzzyPlayerNameMatch(pick, m.team1)) return o1;
  if (pickN === norm(m.team2) || fuzzyPlayerNameMatch(pick, m.team2)) return o2;
  return null;
}

async function withAutoAnalysisMutex(fn) {
  const now = Date.now();
  // Verifica se há lock ativo
  if (autoAnalysisMutex.locked) {
    const age = now - autoAnalysisMutex.since;
    if (age > AUTO_ANALYSIS_MUTEX_STALE_MS) {
      // Lock stale: provavelmente ficou preso por crash/exception — libera
      log('WARN', 'AUTO', `Mutex stale (${Math.round(age / 60000)}min) — liberando lock forçado`);
      autoAnalysisMutex.locked = false;
    } else {
      log('INFO', 'AUTO', `Análise anterior ainda em curso (${Math.round(age / 1000)}s) — pulando ciclo`);
      return;
    }
  }
  // Adquire lock atomicamente (JS é single-threaded, então isso é seguro dentro do mesmo processo)
  autoAnalysisMutex.locked = true;
  autoAnalysisMutex.since = now;
  autoAnalysisRunning = true;
  try {
    return await fn();
  } finally {
    autoAnalysisRunning = false;
    autoAnalysisMutex.locked = false;
    autoAnalysisMutex.since = 0;
  }
}

async function runAutoAnalysis() {
  return withAutoAnalysisMutex(async () => {
  const now = Date.now();

  // usado depois em sharedCaches (CLV/refreshOpenTips)
  let lolRaw = [];

  const esportsConfig = SPORTS['esports'];
  if (esportsConfig?.enabled) {
    try {
      lolRaw = await serverGet('/lol-matches').catch(() => []);
      // Inclui 'draft' (comp disponível antes do jogo) e 'live' (odds ao vivo via SX.Bet).
      const lolLive = Array.isArray(lolRaw) ? lolRaw.filter(m => m.status === 'draft' || m.status === 'live') : [];

      // Deduplicar Riot+PandaScore: se Riot já cobre o mesmo confronto, descarta a cópia PandaScore
      const riotLive = new Set(lolLive.filter(m => !String(m.id).startsWith('ps_')).map(m => `${norm(m.team1)}_${norm(m.team2)}`));
      const allLive = lolLive.filter(m => {
        if (!String(m.id).startsWith('ps_')) return true;
        const key1 = `${norm(m.team1)}_${norm(m.team2)}`;
        const key2 = `${norm(m.team2)}_${norm(m.team1)}`;
        return !riotLive.has(key1) && !riotLive.has(key2);
      });
      log('INFO', 'AUTO', `LoL: ${lolRaw?.length||0} partidas (${allLive.filter(m=>m.status==='live').length} live, ${allLive.filter(m=>m.status==='draft').length} draft, ${lolLive.length-allLive.length} dupl. removidas) | inscritos=${subscribedUsers.size}`);
      // Feed do dashboard: lista cada partida live pelos nomes (dashboard só classifica live quando
      // o nome do confronto aparece numa linha com marker "ao vivo"). Partidas puladas pelos gates
      // nunca chegam ao log "Analisando [AO VIVO]", então emitimos aqui ANTES dos filtros.
      for (const _m of allLive) {
        if (_m.status === 'live') log('INFO', 'AUTO', `LoL AO VIVO: ${_m.team1} vs ${_m.team2} (${_m.league || '?'})`);
      }

      const _hasLiveLol = allLive.length > 0;
      if (_hasLiveLol) _livePhaseEnter('lol');

      for (const match of allLive) {
        // Ao vivo: dedup por mapa atual (uma tip por mapa, não por série inteira)
        const liveIds = (match.status === 'live')
          ? await serverGet(`/live-gameids?matchId=${encodeURIComponent(String(match.id))}`).catch(() => [])
          : [];
        const currentMap = Array.isArray(liveIds) ? (liveIds.find(x => x.hasLiveData)?.gameNumber || null) : null;
        const mapSuffix = (match.status === 'live' && currentMap) ? `_MAP${currentMap}` : '';
        const matchKey = `${match.game}_${match.id}${mapSuffix}`;
        // Bloqueia ligas principais — tips apenas em ligas secundárias
        if (isMainLeague(match.leagueSlug || match.league)) { log('INFO', 'AUTO', `Liga principal ignorada (draft): ${match.league} (${match.team1} vs ${match.team2})`); continue; }
        const prev = analyzedMatches.get(matchKey);
        if (prev?.tipSent) continue; // uma tip por partida — não repetir
        // Live matches: cooldown agressivo pra pegar janela quando Riot popula feed.
        //   - Sem stats antes (hasLiveStats=false): 3 min (pode aparecer a qualquer momento)
        //   - Com stats mas sem edge: 8 min (IA já analisou com dados reais, improvável mudar rápido)
        // Draft/upcoming: 10/20 min (comportamento anterior).
        const isLiveMatch = match.status === 'live' || match.status === 'inprogress';
        const LIVE_FAST_RETRY = 2 * 60 * 1000;   // 2 min pra live sem stats
        const LIVE_NORMAL_COOLDOWN = 3 * 60 * 1000; // 3 min pra live que já teve stats
        const liveCooldown = isLiveMatch
          ? (prev?.hadLiveStats ? LIVE_NORMAL_COOLDOWN : LIVE_FAST_RETRY)
          : (prev?.noEdge ? RE_ANALYZE_INTERVAL * 2 : RE_ANALYZE_INTERVAL);
        if (prev && (now - prev.ts < liveCooldown)) continue;

        const result = await autoAnalyzeMatch(esportsConfig.token, match);
        // Persiste se teve stats nesse ciclo pra ajustar cooldown na próxima
        analyzedMatches.set(matchKey, {
          ts: now,
          tipSent: prev?.tipSent || false,
          noEdge: !result?.tipMatch,
          hadLiveStats: !!result?.hasLiveStats || prev?.hadLiveStats || false,
        });

        if (!result) continue;
        const hasRealOdds = !!(result.o?.t1 && parseFloat(result.o.t1) > 1);

        if (result.tipMatch) {
          const tipTeam = result.tipMatch[1].trim();
          const tipOdd = result.tipMatch[2].trim();
          const tipEV = result.tipMatch[3].trim();
          const tipConf = (result.tipMatch[5] || CONF.MEDIA).trim().toUpperCase();
          // EV sanity: bloqueia EV absurdamente alto (erro de cálculo da IA) — espelha gate do upcoming.
          const tipEVnumLive = parseFloat(String(tipEV).replace(/[%+]/g, ''));
          if (!isNaN(tipEVnumLive) && tipEVnumLive > 50) {
            log('WARN', 'AUTO', `Gate EV sanity LIVE: ${match.team1} vs ${match.team2} → EV ${tipEVnumLive}% > 50% (provável erro de cálculo da IA) → rejeitado`);
            analyzedMatches.set(matchKey, { ts: now, tipSent: false, noEdge: true });
            continue;
          }
          // Cap LoL tier 2-3: histórico ROI -56% nessas ligas (Prime League/LFL/Rift Legends/etc) por EV inflado.
          // Em tier 2-3, EV reportado > 25% é red flag de modelo errado; rebaixa conf.
          const _lolTier1Live = isLolTier1(match.leagueSlug || match.league);
          if (!_lolTier1Live && !isNaN(tipEVnumLive) && tipEVnumLive > 25) {
            log('WARN', 'AUTO', `Gate LoL tier2+ LIVE: ${match.team1} vs ${match.team2} (${match.league}) → EV ${tipEVnumLive}% > 25% em liga não-premier → rejeitado`);
            analyzedMatches.set(matchKey, { ts: now, tipSent: false, noEdge: true });
            continue;
          }
          // Gate BAIXA endurecido (2026-04-15): histórico mostra BAIXA perdendo muito em LoL.
          // Exige ML-edge ≥10pp E EV ≥ 8% pra compensar baixa confiança da IA.
          if (tipConf === CONF.BAIXA) {
            if (result.mlScore < 10) {
              log('INFO', 'AUTO', `LIVE BAIXA rejeitada: ${match.team1} vs ${match.team2} | ML-edge ${result.mlScore.toFixed(1)}pp < 10pp`);
              analyzedMatches.set(matchKey, { ts: now, tipSent: false, noEdge: true });
              continue;
            }
            if (!isNaN(tipEVnumLive) && tipEVnumLive < 8) {
              log('INFO', 'AUTO', `LIVE BAIXA rejeitada: ${match.team1} vs ${match.team2} | EV ${tipEVnumLive}% < 8%`);
              analyzedMatches.set(matchKey, { ts: now, tipSent: false, noEdge: true });
              continue;
            }
          }
          // ── Sharp line check (Pinnacle reference) ──
          const sharpCheck = checkSharpLine(result.o, tipTeam, match.team1, match.team2);
          if (!sharpCheck.ok) {
            log('INFO', 'AUTO', `Sharp line gate: ${tipTeam} — ${sharpCheck.reason} | ${match.team1} vs ${match.team2}`);
            analyzedMatches.set(matchKey, { ts: now, tipSent: false, noEdge: true });
            continue;
          }

          // Kelly adaptado por confiança: ALTA → ¼ Kelly (max 4u) | MÉDIA → ⅙ Kelly (max 3u) | BAIXA → 1/10 Kelly (max 1.5u)
          const kellyFraction = tipConf === CONF.ALTA ? 0.25 : tipConf === CONF.BAIXA ? 0.10 : 1/6;
          const isT1bet = norm(tipTeam).includes(norm(match.team1)) || norm(match.team1).includes(norm(tipTeam));
          const modelPForKelly = (result.modelP1 > 0) ? (isT1bet ? result.modelP1 : result.modelP2) : null;
          const tipStake = modelPForKelly
            ? calcKellyWithP(modelPForKelly, tipOdd, kellyFraction)
            : calcKellyFraction(tipEV, tipOdd, kellyFraction);
          // Kelly negativo → não apostar
          if (tipStake === '0u') { log('INFO', 'AUTO', `Kelly negativo para ${tipTeam} @ ${tipOdd} — tip abortada`); continue; }
          // Global Risk Manager (cross-sport)
          const desiredUnits = parseFloat(String(tipStake).replace('u', '')) || 0;
          const riskAdj = await applyGlobalRisk('esports', desiredUnits, match.leagueSlug || match.league);
          if (!riskAdj.ok) { log('INFO', 'RISK', `esports: bloqueada (${riskAdj.reason})`); continue; }
          const tipStakeAdj = `${riskAdj.units.toFixed(1).replace(/\.0$/, '')}u`;
          const gameIcon = '🎮';
          // Linha de bookmaker — Pinnacle prioritário; mostra alternativa (SX.Bet) se houver linha melhor.
          const _bmSrcLol = String(result.o?.bookmaker || '').trim();
          const _altLol = result.o?._alternative;
          const _altLine = _altLol ? ` (alt ${_altLol.bookmaker}: ${_altLol.t1}/${_altLol.t2})` : '';
          const bookLineLol = _bmSrcLol
            ? `🏦 Casa: *${_bmSrcLol}*${_altLine}\n`
            : '';
          const oddsLabel = hasRealOdds ? '' : '\n⚠️ _Odds estimadas (sem mercado disponível)_';
          const mlEdgeLabel = result.mlScore > 0 ? ` | ML: ${result.mlScore.toFixed(1)}pp` : '';
          const baixaNote = tipConf === 'BAIXA' ? '\n⚠️ _Tip de confiança BAIXA — stake reduzido. Aposte com cautela._' : '';

          const modelLabel = (result.factorActive && result.factorActive.length)
            ? 'P modelo (forma/H2H/comp)'
            : 'Fair odds (de-juice)';
          const modelPPick = modelPForKelly;

          // Ao vivo: registrar por mapa para não sobrescrever série inteira
          const liveMapa = result.hasLiveStats ? result.liveGameNumber : null;
          const mapTag = (result.hasLiveStats && liveMapa) ? `_MAP${liveMapa}` : '';

          // Dedup por FASE (pregame / map1 / map2 / ...): suprime re-tip na MESMA fase
          // quando placar e EV mal mexeram. Transição entre fases (pregame→map1, map1→map2)
          // passa livre — max 1 tip por mapa é garantido por analyzedMatches + matchId+_MAP{N}.
          const serieId = String(match.id);
          const lastSerieTip = lolSeriesLastTip.get(serieId);
          if (lastSerieTip && (lastSerieTip.mapNum || null) === (liveMapa || null)) {
            const samePick = norm(lastSerieTip.pick) === norm(tipTeam);
            const sameScore = (lastSerieTip.score1 || 0) === (match.score1 || 0) && (lastSerieTip.score2 || 0) === (match.score2 || 0);
            const evDiff = Math.abs(parseFloat(tipEV) - parseFloat(lastSerieTip.ev));
            const recentMs = now - lastSerieTip.ts;
            const DEDUP_WINDOW_MS = 15 * 60 * 1000;
            const EV_TOLERANCE = parseFloat(process.env.LOL_SERIES_EV_TOLERANCE || '2.0');
            if (samePick && sameScore && evDiff < EV_TOLERANCE && recentMs < DEDUP_WINDOW_MS) {
              const phaseLabel = liveMapa ? `map${liveMapa}` : 'pregame';
              log('INFO', 'AUTO', `Dedup [${phaseLabel}]: ${match.team1} vs ${match.team2} — mesma pick/placar, EV ${lastSerieTip.ev}% → ${tipEV}% (diff ${evDiff.toFixed(1)}pp)`);
              continue;
            }
          }

          const rec = await serverPost('/record-tip', {
            matchId: canonicalMatchId('esports', String(match.id) + mapTag), eventName: match.league,
            p1: match.team1, p2: match.team2, tipParticipant: tipTeam,
            odds: tipOdd, ev: tipEV, stake: tipStakeAdj,
            confidence: tipConf, isLive: result.hasLiveStats,
            modelP1: result.modelP1,
            modelP2: result.modelP2,
            modelPPick: modelPPick,
            modelLabel: modelLabel,
            tipReason: result.tipReason || null
          }, 'esports');

          // Aborta se DB recusou (erro ou duplicata já registrada)
          if (!rec?.tipId && !rec?.skipped) {
            log('WARN', 'AUTO', `record-tip falhou para ${tipTeam} @ ${tipOdd} (${match.team1} vs ${match.team2}) — tip abortada`);
            continue;
          }

          if (rec?.skipped) {
            analyzedMatches.set(matchKey, { ts: now, tipSent: true });
            log('INFO', 'AUTO', `Tip duplicada (já registrada), Telegram ignorado: ${match.team1} vs ${match.team2}`);
            continue;
          }

          if (rec?.tipId && result.factorActive?.length && result.mlDirection) {
            await serverPost('/log-tip-factors', {
              tipId: rec.tipId,
              factors: result.factorActive,
              predictedDir: result.mlDirection
            }, 'esports').catch(() => {});
          }

          const isDraft = match.status === 'draft';
          const kellyLabel = tipConf === CONF.ALTA ? '¼ Kelly' : tipConf === CONF.BAIXA ? '1/10 Kelly' : '⅙ Kelly';
          const confEmoji = { [CONF.ALTA]: '🟢', [CONF.MEDIA]: '🟡', [CONF.BAIXA]: '🔵' }[tipConf] || '🟡';

          // Identifica se é tip ao vivo num mapa específico
          const mapaLabel = liveMapa ? `🗺️ *Mapa ${liveMapa} ao vivo*` : null;
          // Linha de contexto da série: "T1 1-0 Gen.G" + formato se disponível
          const serieScore = `*${match.team1}* ${match.score1}-${match.score2} *${match.team2}*`;
          const formatLabel = match.format ? ` _(${match.format})_` : '';

          const analysisLabel = result.hasLiveStats
            ? `📊 Baseado em dados ao vivo — Mapa ${liveMapa || '?'}`
            : isDraft
              ? '📋 Análise de draft (composições conhecidas, jogo ainda não iniciado)'
              : '📋 Análise pré-jogo';

          const tipHeader = (result.hasLiveStats && liveMapa)
            ? `${gameIcon} 💰 *TIP ML AUTOMÁTICA — MAPA ${liveMapa}*`
            : `${gameIcon} 💰 *TIP ML AUTOMÁTICA*`;

          const whyLine = result.tipReason ? `\n🧠 Por quê: _${result.tipReason}_\n` : '\n';
          const minTakeOdds = calcMinTakeOdds(tipOdd);
          const minTakeLine = minTakeOdds ? `📉 Odd mínima: *${minTakeOdds}*\n` : '';
          const tipMsg = `${tipHeader}\n` +
            `${serieScore}${formatLabel}\n` +
            (mapaLabel ? `${mapaLabel}\n` : '') +
            whyLine +
            `🎯 Aposta: *${tipTeam}* ML @ *${tipOdd}*\n` +
            bookLineLol +
            minTakeLine +
            `📈 EV: *${tipEV}*\n💵 Stake: *${tipStakeAdj}* _(${kellyLabel})_\n` +
            `${confEmoji} Confiança: *${tipConf}*${mlEdgeLabel}\n` +
            `📋 ${match.league}\n` +
            `_${analysisLabel}_` +
            `${oddsLabel}${baixaNote}\n\n` +
            `⚠️ _Aposte com responsabilidade._`;

          for (const [userId, prefs] of subscribedUsers) {
            if (!prefs.has('esports')) continue;
            try { await sendDM(esportsConfig.token, userId, tipMsg); }
            catch(e) {
              if (e.message?.includes('403')) {
                subscribedUsers.delete(userId);
                serverPost('/save-user', { userId: String(userId), subscribed: false }, 'esports').catch(() => {});
              }
            }
          }
          analyzedMatches.set(matchKey, { ts: now, tipSent: true });
          // Registra a tip na serie-level dedup map (suprime re-tip no proximo mapa sem mudanca de estado).
          lolSeriesLastTip.set(String(match.id), {
            pick: tipTeam, ev: tipEV,
            score1: match.score1 || 0, score2: match.score2 || 0,
            ts: now, mapNum: liveMapa || null,
          });
          log('INFO', 'AUTO-TIP', `Esports: ${tipTeam} @ ${tipOdd} (odds ${hasRealOdds ? 'reais' : 'estimadas'})`);
          // Log curto + variáveis consideradas (para auditoria)
          if (result.debugVars) {
            log('INFO', 'TIP-VARS', `${tipTeam} @ ${tipOdd} | ${result.tipReason || '-'} | ${match.team1} vs ${match.team2}`, result.debugVars);
          }

          // Ao vivo: apenas ML do mapa (não enviar outros mercados após live)
          // ── Handicap tip (desativado em live) ──
          try {
            if (result.hasLiveStats) throw new Error('skip_live_markets');
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
            if (hErr.message !== 'skip_live_markets') log('WARN', 'AUTO', `Handicap check falhou: ${hErr.message}`);
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

      // Sai da live phase (se estava dentro) e espera outros esportes terminarem live
      if (_hasLiveLol) _livePhaseExit('lol');
      await _waitOthersLiveDone('lol');

      if (allUpcoming.length > 0) {
        log('INFO', 'AUTO', `LoL próximas ${UPCOMING_WINDOW_HOURS}h: ${allUpcoming.length} partidas`);
        let blockedBo3Count = 0;
        const blockBo3 = (process.env.LOL_PREGAME_BLOCK_BO3 ?? 'true') !== 'false';
        for (const match of allUpcoming) {
          const matchKey = `upcoming_${match.game}_${match.id}`;
          // Bloqueia ligas principais — tips apenas em ligas secundárias
          if (isMainLeague(match.leagueSlug || match.league)) { log('INFO', 'AUTO', `Liga principal ignorada (upcoming): ${match.league} (${match.team1} vs ${match.team2})`); continue; }
          const prev = analyzedMatches.get(matchKey);
          if (prev?.tipSent) continue; // já enviou tip — não repetir

          // Item 1: Bo3/Bo5 — aguarda draft disponível (fase live/draft)
          // Controlável via LOL_PREGAME_BLOCK_BO3=false para testes / fase de calibração.
          if (blockBo3 && (match.format === 'Bo3' || match.format === 'Bo5')) {
            blockedBo3Count++;
            continue;
          }

          const matchStart = match.time ? new Date(match.time).getTime() : 0;
          const timeToMatch = matchStart > 0 ? matchStart - now : Infinity;
          const isImminentMatch = timeToMatch > 0 && timeToMatch < 2 * 60 * 60 * 1000;

          // Partida iminente (<2h) bypassa cooldown; matches sem edge aguardam 2× o intervalo
          const upcomingCooldown = prev?.noEdge ? UPCOMING_ANALYZE_INTERVAL * 2 : UPCOMING_ANALYZE_INTERVAL;
          if (!isImminentMatch && prev && (now - prev.ts < upcomingCooldown)) continue;

          // Item 3: força re-fetch de odds se a partida começa em < 2h
          if (isImminentMatch) {
            log('INFO', 'AUTO', `Upcoming < 2h: forçando re-fetch de odds para ${match.team1} vs ${match.team2}`);
          }

          const oddsCheck = isImminentMatch
            ? await forceOddsRefreshQueued(match.team1, match.team2, 'lol')
            : await serverGet(`/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}&game=lol`).catch(() => null);
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
            const tipConf = (result.tipMatch[5] || CONF.MEDIA).trim().toUpperCase();

            // Pré-jogo BAIXA endurecido (2026-04-15): exige mlEdge ≥10pp E EV ≥ 10%
            if (tipConf === CONF.BAIXA) {
              const tipEVnumUp = parseFloat(String(tipEV).replace(/[%+]/g, ''));
              if (result.mlScore < 10) {
                log('INFO', 'AUTO', `Upcoming BAIXA rejeitada: ${match.team1} vs ${match.team2} → ML-edge ${result.mlScore.toFixed(1)}pp < 10pp`);
                analyzedMatches.set(matchKey, { ts: now, tipSent: false, noEdge: true });
                await new Promise(r => setTimeout(r, 3000)); continue;
              }
              if (!isNaN(tipEVnumUp) && tipEVnumUp < 10) {
                log('INFO', 'AUTO', `Upcoming BAIXA rejeitada: ${match.team1} vs ${match.team2} → EV ${tipEVnumUp}% < 10%`);
                analyzedMatches.set(matchKey, { ts: now, tipSent: false, noEdge: true });
                await new Promise(r => setTimeout(r, 3000)); continue;
              }
            }

            // EV sanity: bloqueia EV absurdamente alto (erro de cálculo da IA)
            const tipEVnum = parseFloat(String(tipEV).replace('%', '').replace('+', ''));
            if (!isNaN(tipEVnum) && tipEVnum > 50) {
              log('WARN', 'AUTO', `Gate EV sanity upcoming: ${match.team1} vs ${match.team2} → EV ${tipEVnum}% > 50% (provável erro de cálculo da IA) → rejeitado`);
              analyzedMatches.set(matchKey, { ts: now, tipSent: false, noEdge: true });
              await new Promise(r => setTimeout(r, 3000)); continue;
            }
            // Cap LoL tier 2-3 upcoming: bleed histórico ROI -56% por EV inflado em ligas não-premier.
            const _lolTier1Up = isLolTier1(match.leagueSlug || match.league);
            if (!_lolTier1Up && !isNaN(tipEVnum) && tipEVnum > 25) {
              log('WARN', 'AUTO', `Gate LoL tier2+ upcoming: ${match.team1} vs ${match.team2} (${match.league}) → EV ${tipEVnum}% > 25% em liga não-premier → rejeitado`);
              analyzedMatches.set(matchKey, { ts: now, tipSent: false, noEdge: true });
              await new Promise(r => setTimeout(r, 3000)); continue;
            }

            // ALTA → ¼ Kelly (max 4u) | MÉDIA → ⅙ Kelly (max 3u) | BAIXA → 1/10 Kelly (max 1.5u)
            const kellyFraction = tipConf === CONF.ALTA ? 0.25 : tipConf === CONF.BAIXA ? 0.10 : 1/6;
            // Usa p do modelo ML quando disponível (evita circularidade p←EV←IA)
            const isT1bet = norm(tipTeam).includes(norm(match.team1)) || norm(match.team1).includes(norm(tipTeam));
            const modelPForKelly = (result.modelP1 > 0) ? (isT1bet ? result.modelP1 : result.modelP2) : null;
            const tipStake = modelPForKelly
              ? calcKellyWithP(modelPForKelly, tipOdd, kellyFraction)
              : calcKellyFraction(tipEV, tipOdd, kellyFraction);
            if (tipStake === '0u') {
              log('INFO', 'AUTO', `Kelly negativo upcoming ${tipTeam} @ ${tipOdd} — tip abortada`);
              await new Promise(r => setTimeout(r, 3000)); continue;
            }
            // Risk Manager cross-sport (faltava no upcoming — bug fix mid-Abr 2026)
            const desiredUnitsUp = parseFloat(String(tipStake).replace('u', '')) || 0;
            const riskAdjUp = await applyGlobalRisk('esports', desiredUnitsUp, match.leagueSlug || match.league);
            if (!riskAdjUp.ok) {
              log('INFO', 'RISK', `esports upcoming: bloqueada (${riskAdjUp.reason})`);
              await new Promise(r => setTimeout(r, 3000)); continue;
            }
            const tipStakeAdj = `${riskAdjUp.units.toFixed(1).replace(/\.0$/, '')}u`;
            const gameIcon = '🎮';
            const confEmoji = { [CONF.ALTA]: '🟢', [CONF.MEDIA]: '🟡', [CONF.BAIXA]: '🔵' }[tipConf] || '🟡';
            const kellyLabel = tipConf === CONF.ALTA ? '¼ Kelly' : tipConf === CONF.BAIXA ? '1/10 Kelly' : '⅙ Kelly';
            const mlEdgeLabel = result.mlScore > 0 ? ` | ML: ${result.mlScore.toFixed(1)}pp` : '';

            const recUp = await serverPost('/record-tip', {
              matchId: canonicalMatchId('esports', match.id), eventName: match.league,
              p1: match.team1, p2: match.team2, tipParticipant: tipTeam,
              odds: tipOdd, ev: tipEV, stake: tipStakeAdj,
              confidence: tipConf, isLive: false,
              modelP1: result.modelP1, modelP2: result.modelP2,
              modelPPick: modelPForKelly,
              modelLabel: result.modelLabel || 'esports-ml',
              tipReason: result.tipReason || null
            }, 'esports');

            if (!recUp?.tipId && !recUp?.skipped) {
              log('WARN', 'AUTO', `record-tip upcoming falhou para ${tipTeam} @ ${tipOdd} — tip abortada`);
              await new Promise(r => setTimeout(r, 3000)); continue;
            }

            const imminentNote = isImminentMatch ? `⏰ _Odds atualizadas agora (< 2h para o jogo)_\n` : '';
            const baixaNote = tipConf === 'BAIXA' ? `⚠️ _Confiança BAIXA (ML-edge ${result.mlScore.toFixed(1)}pp) — stake reduzido. Aposte com cautela._\n` : '';
            const minTakeOdds = calcMinTakeOdds(tipOdd);
            const minTakeLine = minTakeOdds ? `📉 Odd mínima: *${minTakeOdds}*\n` : '';
            const tipMsg = `${gameIcon} 💰 *TIP PRÉ-JOGO ESPORTS (Bo1)*\n` +
              `*${match.team1}* vs *${match.team2}*\n📋 ${match.league}\n` +
              (match.time ? `🕐 Início: *${matchTime}* (BRT)\n` : '') +
              `\n🎯 Aposta: *${tipTeam}* ML @ *${tipOdd}*\n` +
              minTakeLine +
              `📈 EV: *${tipEV}*\n💵 Stake: *${tipStakeAdj}* _(${kellyLabel})_\n` +
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
        if (blockedBo3Count > 0) {
          log('DEBUG', 'AUTO', `${blockedBo3Count} partida(s) Bo3/Bo5 ignoradas (aguardando draft, LOL_PREGAME_BLOCK_BO3=true)`);
        }
      }

    } catch(e) {
      log('ERROR', 'AUTO-ESPORTS', e.message);
      _livePhaseExit('lol');
    }
  }

  // Caches compartilhados para CLV e Updates
  const sharedCaches = { esports: lolRaw || [] };

  // ── Execução PARALELA dos esportes (antes era série → MMA bloqueava ~15min o resto)
  // Cada poll já tem error handling interno; Promise.allSettled garante isolamento total.
  const parallel = [];
  if (SPORTS['esports']?.enabled) {
    parallel.push(pollDota(true).catch(e => log('ERROR', 'AUTO', `Dota2 unified: ${e.message}`)));
  }
  if (SPORTS['mma']?.enabled) {
    parallel.push(pollMma(true).catch(e => log('ERROR', 'AUTO', `MMA unified: ${e.message}`)));
  }
  if (SPORTS['football']?.enabled) {
    parallel.push(pollFootball(true).then(v => { sharedCaches.football = v; })
      .catch(e => log('ERROR', 'AUTO', `Football unified: ${e.message}`)));
  }
  if (SPORTS['tennis']?.enabled) {
    parallel.push(pollTennis(true).then(v => { sharedCaches.tennis = v; })
      .catch(e => log('ERROR', 'AUTO', `Tennis unified: ${e.message}`)));
  }
  if (SPORTS['tabletennis']?.enabled) {
    parallel.push(pollTableTennis(true).then(v => { sharedCaches.tabletennis = v; })
      .catch(e => log('ERROR', 'AUTO', `TableTennis unified: ${e.message}`)));
  }
  if (SPORTS['cs']?.enabled) {
    parallel.push(pollCs(true).then(v => { sharedCaches.cs = v; })
      .catch(e => log('ERROR', 'AUTO', `CS2 unified: ${e.message}`)));
  }
  if (SPORTS['valorant']?.enabled) {
    parallel.push(pollValorant(true).then(v => { sharedCaches.valorant = v; })
      .catch(e => log('ERROR', 'AUTO', `Valorant unified: ${e.message}`)));
  }
  await Promise.allSettled(parallel);

  // Tarefas de fundo agora usam os dados baixados acima (mais rápido e seguro)
  await new Promise(r => setTimeout(r, 2000));
  await checkCLV(sharedCaches).catch(e => log('ERROR', 'AUTO', `CLV internal: ${e.message}`));
  await refreshOpenTips(sharedCaches).catch(e => log('ERROR', 'AUTO', `Refresh internal: ${e.message}`));

  });
}

// ── Daily P&L Summary ──
let _lastDailySummary = 0;
async function sendDailySummary() {
  // Roda 1x por dia, após 23:00 BRT (02:00 UTC)
  const now = new Date();
  const utcH = now.getUTCHours();
  if (utcH < 2 || utcH > 3) return; // só entre 23:00-00:00 BRT
  const todayKey = now.toISOString().slice(0, 10);
  if (_lastDailySummary === todayKey) return;
  _lastDailySummary = todayKey;

  try {
    const lines = ['📊 *Resumo Diário — SportsEdge Bot*\n'];
    let totalProfit = 0, totalTips = 0, totalWins = 0;

    for (const sportKey of Object.keys(SPORTS)) {
      const cfg = SPORTS[sportKey];
      if (!cfg?.enabled || !cfg?.token) continue;
      const sport = sportKey === 'esports' ? 'esports' : sportKey;
      try {
        const roi = await serverGet(`/roi`, sport).catch(() => null);
        if (!roi || !roi.total) continue;
        const bk = roi.bankroll;
        const dayTips = roi.total;
        const dayWins = roi.wins || 0;
        const dayLosses = roi.losses || 0;
        const roiPct = roi.roi != null ? `${roi.roi >= 0 ? '+' : ''}${roi.roi}%` : '—';
        const profitR = roi.profitReais != null ? `R$${roi.profitReais >= 0 ? '+' : ''}${roi.profitReais}` : '';
        const bancaR = bk?.current != null ? `R$${bk.current}` : '';
        const sportEmoji = { esports: '🎮', mma: '🥊', tennis: '🎾', football: '⚽', darts: '🎯', snooker: '🎱', tabletennis: '🏓', cs: '🔫' }[sportKey] || '📌';

        lines.push(`${sportEmoji} *${sportKey.toUpperCase()}*: ${dayWins}W/${dayLosses}L (${dayTips} tips) | ROI ${roiPct} ${profitR} | Banca: ${bancaR}`);
        totalProfit += (roi.profitReais || 0);
        totalTips += dayTips;
        totalWins += dayWins;
      } catch (_) {}
    }

    if (totalTips === 0) return; // sem atividade no dia
    lines.push(`\n💰 *Total*: ${totalTips} tips | ${totalWins}W | Profit: R$${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)}`);

    const msg = lines.join('\n');
    // Coleta usuários únicos (qualquer sport inscrito) e envia 1 DM/user via primeiro token disponível.
    // Bug fix mid-Abr 2026: `break` antigo saía após primeiro sport, então users inscritos
    // só em outros sports não recebiam o resumo.
    const firstActive = Object.values(SPORTS).find(c => c?.enabled && c?.token);
    if (firstActive) {
      const uniqueUsers = new Set();
      for (const [uid, prefs] of subscribedUsers) {
        if (prefs && prefs.size > 0) uniqueUsers.add(uid);
      }
      let sent = 0;
      for (const uid of uniqueUsers) {
        try { await sendDM(firstActive.token, uid, msg); sent++; } catch(_) {}
      }
      log('INFO', 'DAILY', `Resumo enviado a ${sent}/${uniqueUsers.size} users: ${totalTips} tips, R$${totalProfit.toFixed(2)}`);
    }
  } catch(e) {
    log('WARN', 'DAILY', `Erro no resumo diário: ${e.message}`);
  }
}

// ── Odds movement alerts + Tip expiry ──
const _alertedTips = new Set(); // evita alertar a mesma tip múltiplas vezes
const TIP_EXPIRY_MS = parseInt(process.env.TIP_EXPIRY_MIN || '30', 10) * 60 * 1000; // 30min default
const ODDS_DROP_THRESHOLD = parseFloat(process.env.ODDS_DROP_ALERT_PCT || '12') / 100; // 12% default

async function checkPendingTipsAlerts() {
  try {
    for (const sportKey of Object.keys(SPORTS)) {
      const cfg = SPORTS[sportKey];
      if (!cfg?.enabled || !cfg?.token) continue;
      const sport = sportKey === 'esports' ? 'esports' : sportKey;
      const unsettled = await serverGet('/unsettled-tips?days=1', sport).catch(() => []);
      if (!Array.isArray(unsettled) || !unsettled.length) continue;

      for (const tip of unsettled) {
        const alertKey = `${sport}_${tip.id}`;
        if (_alertedTips.has(alertKey)) continue;

        const sentMs = tip.sent_at ? Date.parse(String(tip.sent_at).replace(' ', 'T')) : 0;
        if (!sentMs || !Number.isFinite(sentMs)) continue;
        const age = Date.now() - sentMs;

        // Tip expiry: log only (sem DM — user não quer notificações extras)
        if (age > TIP_EXPIRY_MS && age < TIP_EXPIRY_MS + SETTLEMENT_INTERVAL) {
          _alertedTips.add(alertKey);
          log('INFO', 'EXPIRY', `${sport}: tip ${tip.id} expirada (${Math.round(age / 60000)}min) — ${tip.participant1} vs ${tip.participant2}`);
        }
      }
    }
  } catch(e) {
    log('WARN', 'ALERTS', `checkPendingTipsAlerts: ${e.message}`);
  }
}

// ── Settlement ──
async function settleCompletedTips() {
  if (Date.now() - lastSettlementCheck < SETTLEMENT_INTERVAL) return;
  lastSettlementCheck = Date.now();

  for (const sport of Object.keys(SPORTS)) {
    if (!SPORTS[sport].enabled) continue;

    try {
      const unsettledDays = sport === 'tennis'
        ? Math.min(365, Math.max(30, parseInt(process.env.TENNIS_UNSETTLED_DAYS || '120', 10) || 120))
        : sport === 'mma'
          ? Math.min(365, Math.max(30, parseInt(process.env.MMA_UNSETTLED_DAYS || '90', 10) || 90))
          : 30;
      const unsettled = await serverGet(`/unsettled-tips?days=${unsettledDays}`, sport);
      if (!Array.isArray(unsettled) || !unsettled.length) continue;

      let settled = 0;

      if (sport === 'mma') {
        const espnFights = await fetchEspnMmaFights().catch(() => []);
        for (const tip of unsettled) {
          if (!tip.match_id) continue;
          try {
            const espn = findEspnFight(espnFights, tip.participant1, tip.participant2);
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
        // ESPN scoreboard → match_results (CSV Sackmann 2025+ costuma 404 no GitHub).
        await serverGet('/sync-tennis-espn-results?force=1', 'tennis').catch(() => {});
        // The Odds API não publica scores para tênis — settlement via DB + ESPN.
        const scores = await serverGet('/tennis-scores?daysFrom=3', 'tennis').catch(() => []);
        const scoresById = new Map((Array.isArray(scores) ? scores : []).map(s => [String(s.id), s]));

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
            const dbRes = await serverGet(
              `/tennis-db-result?p1=${encodeURIComponent(tip.participant1 || '')}&p2=${encodeURIComponent(tip.participant2 || '')}&sentAt=${encodeURIComponent(tip.sent_at || '')}`,
              'tennis'
            ).catch(() => null);
            if (dbRes?.resolved && dbRes.winner) {
              await serverPost('/settle', { matchId: tip.match_id, winner: dbRes.winner }, 'tennis');
              log('INFO', 'SETTLE', `tennis: ${tip.participant1} vs ${tip.participant2} → ${dbRes.winner} (DB)`);
              settled++;
              continue;
            }

            // 2) The Odds (se no futuro houver scores)
            const mid = stripTheOddsMatchId(tip.match_id);
            const s = mid ? scoresById.get(String(mid)) : null;
            const tipMsTn = tip.sent_at
              ? Date.parse(String(tip.sent_at).includes('T') ? String(tip.sent_at) : String(tip.sent_at).replace(' ', 'T'))
              : NaN;
            if (s?.completed && Array.isArray(s.scores) && s.scores.length >= 2) {
              let oddsOldEvent = false;
              if (Number.isFinite(tipMsTn) && s.commence_time) {
                const cMs = Date.parse(String(s.commence_time));
                if (Number.isFinite(cMs) && cMs + 12 * 3600000 < tipMsTn) oddsOldEvent = true;
              }
              if (!oddsOldEvent) {
                const a = s.scores[0], b = s.scores[1];
                const sa = parseFloat(a?.score), sb = parseFloat(b?.score);
                const winner = (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb)
                  ? (sa > sb ? a.name : b.name)
                  : null;
                if (winner) {
                  await serverPost('/settle', { matchId: tip.match_id, winner }, 'tennis');
                  log('INFO', 'SETTLE', `tennis: ${tip.participant1} vs ${tip.participant2} → ${winner}`);
                  settled++;
                  continue;
                }
              }
            }

            // 3) ESPN (evento atual)
            const res = allResults.find(r => {
              if (!r.winner) return false;
              if (!tennisEspnRecentResultEligibleForTip(r, tipMsTn)) return false;
              return tennisPairMatchesPlayers(tip.participant1, tip.participant2, r.p1, r.p2);
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
            endpoint = `/football-result?matchId=${encodeURIComponent(tip.match_id)}&team1=${encodeURIComponent(tip.participant1 || '')}&team2=${encodeURIComponent(tip.participant2 || '')}&sentAt=${encodeURIComponent(tip.sent_at || '')}`;
          } else if (sport === 'darts') {
            endpoint = `/darts-result?matchId=${encodeURIComponent(tip.match_id)}`;
          } else if (sport === 'snooker') {
            endpoint = `/snooker-result?matchId=${encodeURIComponent(tip.match_id)}&team1=${encodeURIComponent(tip.participant1 || '')}&team2=${encodeURIComponent(tip.participant2 || '')}&sentAt=${encodeURIComponent(tip.sent_at || '')}`;
          } else if (sport === 'cs') {
            endpoint = `/cs-result?matchId=${encodeURIComponent(tip.match_id)}&team1=${encodeURIComponent(tip.participant1 || '')}&team2=${encodeURIComponent(tip.participant2 || '')}&sentAt=${encodeURIComponent(tip.sent_at || '')}`;
          } else if (sport === 'valorant') {
            endpoint = `/valorant-result?matchId=${encodeURIComponent(tip.match_id)}&team1=${encodeURIComponent(tip.participant1 || '')}&team2=${encodeURIComponent(tip.participant2 || '')}&sentAt=${encodeURIComponent(tip.sent_at || '')}`;
          } else {
            const mid = String(tip.match_id);
            if (mid.startsWith('dota2_')) {
              endpoint = `/dota-result?matchId=${encodeURIComponent(mid)}`;
            } else {
              const isPanda = mid.startsWith('ps_');
              endpoint = isPanda
                ? `/ps-result?matchId=${encodeURIComponent(mid)}`
                : `/match-result?matchId=${encodeURIComponent(mid)}&game=lol`;
            }
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

          const settleBody = { matchId: tip.match_id, winner: result.winner };
          if (sport === 'football') {
            settleBody.home = tip.participant1 || '';
            settleBody.away = tip.participant2 || '';
          }
          await serverPost('/settle', settleBody, sport);

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

function calcMinTakeOdds(tipOdd) {
  const o = parseFloat(tipOdd);
  if (!Number.isFinite(o) || o <= 1) return null;
  const pctRaw = parseFloat(process.env.ODDS_MIN_TAKE_PCT || '0.97'); // 3% pior por default
  const pct = Number.isFinite(pctRaw) ? Math.min(1, Math.max(0.5, pctRaw)) : 0.97;
  const min = Math.max(1.01, o * pct);
  return min.toFixed(2);
}

// ── Helper Functions ──
function getPatchMetaAgeDays() {
  const dateStr = process.env.PATCH_META_DATE;
  if (!dateStr) return null;
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / (86400 * 1000));
  return isNaN(days) ? null : days;
}

// ── Alertas críticos: polling do /alerts do server → DM admins (throttled por alert id) ──
const _criticalAlertCooldown = new Map(); // alertId → lastNotifiedTs
const CRITICAL_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1h entre re-notificações do mesmo alert

// Mapeia alert.id → sport bot que deve enviar o aviso (ou 'system' para enviar no primeiro ativo).
// Evita que, por ex., MMA receba alertas de OddsPapi (que só afeta esports).
function _alertSportFor(alertId) {
  if (!alertId) return 'system';
  if (alertId.startsWith('oddspapi_')) return 'esports';       // OddsPapi cobre só LoL
  if (alertId.startsWith('theodds_'))  return 'system';        // The Odds API afeta mma/tennis/football
  if (alertId === 'db_error')          return 'system';
  if (alertId === 'analysis_stale')    return 'esports';       // lastAnalysisAt é do esports
  return 'system';
}

function _pickTokenForAlert(alertId) {
  const preferred = _alertSportFor(alertId);
  if (preferred !== 'system') {
    const cfg = SPORTS[preferred];
    if (cfg?.enabled && cfg?.token) return { token: cfg.token, sport: preferred };
  }
  // Fallback: primeiro esporte não-shadow (para que o admin veja o alerta no bot que usa)
  const firstActive = Object.values(SPORTS).find(s => s?.enabled && s?.token && !s?.shadowMode);
  if (firstActive) return { token: firstActive.token, sport: firstActive.id };
  // Último recurso: qualquer bot ativo
  const any = Object.values(SPORTS).find(s => s?.enabled && s?.token);
  return any ? { token: any.token, sport: any.id } : null;
}

async function checkCriticalAlerts() {
  if (!ADMIN_IDS.size) return;
  const resp = await serverGet('/alerts').catch(() => null);
  if (!resp || !Array.isArray(resp.alerts) || !resp.alerts.length) return;
  const now = Date.now();
  for (const alert of resp.alerts) {
    const last = _criticalAlertCooldown.get(alert.id) || 0;
    if (now - last < CRITICAL_ALERT_COOLDOWN_MS) continue;

    // Rotear alerta para o bot do esporte afetado (ou fallback)
    const routed = _pickTokenForAlert(alert.id);
    if (!routed) continue;

    // Se o alerta é específico de um esporte e esse esporte não está ativo, pula
    const preferredSport = _alertSportFor(alert.id);
    if (preferredSport !== 'system' && !SPORTS[preferredSport]?.enabled) {
      log('INFO', 'ALERT', `Alerta ${alert.id} suprimido (${preferredSport} desligado)`);
      _criticalAlertCooldown.set(alert.id, now);
      continue;
    }

    _criticalAlertCooldown.set(alert.id, now);
    const icon = alert.severity === 'critical' ? '🚨' : '⚠️';
    const msg = `${icon} *ALERTA SISTEMA* (${alert.severity})\n\n` +
      `\`${alert.id}\`\n${alert.msg}\n\n` +
      `_Enviado via bot [${routed.sport}] — próxima em ${Math.round(CRITICAL_ALERT_COOLDOWN_MS/60000)}min se persistir._`;
    for (const adminId of ADMIN_IDS) {
      await sendDM(routed.token, adminId, msg).catch(() => {});
    }
    log('WARN', 'ALERT', `[${alert.severity}] ${alert.id} → bot [${routed.sport}]: ${alert.msg}`);
  }
}

// Auto-shadow: avalia CLV recente por sport; se persistentemente negativo, flipa shadowMode=true.
// Defesa anti-bleed: para de mandar DMs em sports sem edge real (CLV é proxy de edge sustentável).
const _autoShadowOriginal = new Map(); // sport → original shadowMode (pra restaurar se CLV recuperar)
const _autoShadowState = new Map();    // sport → { reason, since, lastCheck }
const AUTO_SHADOW_CHECK_INTERVAL_MS = parseInt(process.env.AUTO_SHADOW_CHECK_INTERVAL_HOURS || '6', 10) * 60 * 60 * 1000;
let _lastAutoShadowCheck = 0;

async function checkAutoShadow() {
  if (!/^(1|true|yes)$/i.test(String(process.env.AUTO_SHADOW_NEGATIVE_CLV ?? 'false'))) return;
  const now = Date.now();
  if (now - _lastAutoShadowCheck < AUTO_SHADOW_CHECK_INTERVAL_MS) return;
  _lastAutoShadowCheck = now;

  const minN = parseInt(process.env.AUTO_SHADOW_MIN_N || '30', 10);
  const cutoffClvBad = parseFloat(process.env.AUTO_SHADOW_CLV_CUTOFF || '-1.0'); // CLV avg < -1%
  const recoveryClvOk = parseFloat(process.env.AUTO_SHADOW_RECOVERY_CLV || '0.0'); // pra desfazer

  for (const sport of Object.keys(SPORTS)) {
    const cfg = SPORTS[sport];
    if (!cfg?.enabled || !cfg?.token) continue;
    if (!_autoShadowOriginal.has(sport)) _autoShadowOriginal.set(sport, !!cfg.shadowMode);
    const orig = _autoShadowOriginal.get(sport);

    let clvData = null;
    try { clvData = await serverGet(`/clv-decay?sport=${encodeURIComponent(sport)}&days=14`).catch(() => null); }
    catch (_) {}
    if (!clvData?.series?.length) continue;
    const totalN = clvData.series.reduce((a, b) => a + (b.n || 0), 0);
    if (totalN < minN) continue;
    const weightedSum = clvData.series.reduce((a, b) => a + (b.clv_avg || 0) * (b.n || 0), 0);
    const meanClv = totalN > 0 ? weightedSum / totalN : 0;

    const wasAutoShadowed = _autoShadowState.has(sport);
    if (meanClv < cutoffClvBad && !cfg.shadowMode) {
      // Flip: ativa shadow
      cfg.shadowMode = true;
      _autoShadowState.set(sport, { reason: `CLV ${meanClv.toFixed(2)}% < ${cutoffClvBad}% (n=${totalN}, 14d)`, since: now, lastCheck: now });
      log('WARN', 'AUTO-SHADOW', `[FLIP→SHADOW] ${sport}: CLV ${meanClv.toFixed(2)}% < ${cutoffClvBad}% em ${totalN} tips. DMs suspensos até CLV recuperar ≥ ${recoveryClvOk}%.`);
      // Notifica admin
      const tokenForAlert = Object.values(SPORTS).find(s => s?.enabled && s?.token)?.token;
      if (tokenForAlert) {
        const msg = `🛑 *AUTO-SHADOW ATIVADO — ${sport.toUpperCase()}*\n\nCLV médio (14d): *${meanClv.toFixed(2)}%* em ${totalN} tips\nCutoff: ${cutoffClvBad}%\n\nTips continuam sendo geradas e gravadas no DB (com \`is_shadow=1\`), mas DMs suspensos.\n\n_Auto-restaura quando CLV ≥ ${recoveryClvOk}% (mesmo \`AUTO_SHADOW_NEGATIVE_CLV\`)._`;
        for (const adminId of ADMIN_IDS) await sendDM(tokenForAlert, adminId, msg).catch(() => {});
      }
    } else if (wasAutoShadowed && meanClv >= recoveryClvOk && cfg.shadowMode === true && orig === false) {
      // Recovery: desfaz auto-shadow se CLV recuperou
      cfg.shadowMode = false;
      _autoShadowState.delete(sport);
      log('INFO', 'AUTO-SHADOW', `[RESTORE→ATIVO] ${sport}: CLV recuperou ${meanClv.toFixed(2)}% ≥ ${recoveryClvOk}%. DMs reativados.`);
      const tokenForAlert = Object.values(SPORTS).find(s => s?.enabled && s?.token)?.token;
      if (tokenForAlert) {
        const msg = `✅ *AUTO-SHADOW RESTAURADO — ${sport.toUpperCase()}*\n\nCLV (14d): *+${meanClv.toFixed(2)}%* em ${totalN} tips\n\nDMs reativados.`;
        for (const adminId of ADMIN_IDS) await sendDM(tokenForAlert, adminId, msg).catch(() => {});
      }
    } else if (wasAutoShadowed) {
      _autoShadowState.get(sport).lastCheck = now;
    }
  }
}

// Live Scout gap monitor: alerta admin via Telegram quando gap (no_gameids/stats_disabled/coverage_missing/etc)
// persiste por mais que LIVE_SCOUT_ALERT_THRESHOLD_MIN. Anti-spam: cada gap key alerta uma vez por janela.
const _liveScoutGapFirstSeen = new Map(); // gapKey -> { firstTs, lastTs, info, alerted }
const LIVE_SCOUT_ALERT_THRESHOLD_MIN = parseInt(process.env.LIVE_SCOUT_ALERT_THRESHOLD_MIN || '5', 10);
const LIVE_SCOUT_ALERT_COOLDOWN_MS = parseInt(process.env.LIVE_SCOUT_ALERT_COOLDOWN_MIN || '60', 10) * 60 * 1000;
let _lastLiveScoutCheck = 0;
const LIVE_SCOUT_CHECK_INTERVAL_MS = parseInt(process.env.LIVE_SCOUT_CHECK_INTERVAL_MIN || '3', 10) * 60 * 1000;

async function checkLiveScoutGaps() {
  if (!ADMIN_IDS.size) return;
  if (!/^(1|true|yes)$/i.test(String(process.env.LIVE_SCOUT_ALERTS ?? 'true'))) return;
  const now = Date.now();
  if (now - _lastLiveScoutCheck < LIVE_SCOUT_CHECK_INTERVAL_MS) return;
  _lastLiveScoutCheck = now;

  let scout = null;
  try {
    const dashboard = require('./lib/dashboard');
    scout = await dashboard.runLiveScout(`http://127.0.0.1:${process.env.PORT || 8080}`);
  } catch (e) {
    log('WARN', 'LIVE-SCOUT-ALERT', `runLiveScout falhou: ${e.message}`);
    return;
  }
  if (!scout?.ok || !Array.isArray(scout.gaps)) return;

  // Marca todos os gaps atuais
  const currentKeys = new Set();
  for (const gap of scout.gaps) {
    const primaryFlag = (gap.flags && gap.flags[0]) || 'unknown';
    const key = `${gap.sport}|${gap.matchId || gap.teams || ''}|${primaryFlag}`;
    currentKeys.add(key);
    const prev = _liveScoutGapFirstSeen.get(key);
    if (!prev) {
      _liveScoutGapFirstSeen.set(key, { firstTs: now, lastTs: now, info: gap, alerted: false, lastAlertTs: 0 });
    } else {
      prev.lastTs = now;
      prev.info = gap; // refresh com info mais recente
    }
  }

  // Limpa entradas que sumiram (gap resolvido)
  for (const [key, st] of _liveScoutGapFirstSeen.entries()) {
    if (!currentKeys.has(key)) {
      _liveScoutGapFirstSeen.delete(key);
    }
  }

  // Dispara alertas pra gaps persistentes
  const grouped = []; // agrupa pra enviar única mensagem
  for (const [key, st] of _liveScoutGapFirstSeen.entries()) {
    const ageMin = (now - st.firstTs) / 60000;
    if (ageMin < LIVE_SCOUT_ALERT_THRESHOLD_MIN) continue;
    if (st.alerted && (now - st.lastAlertTs) < LIVE_SCOUT_ALERT_COOLDOWN_MS) continue;
    st.alerted = true; st.lastAlertTs = now;
    grouped.push({ key, ageMin, ...st.info });
  }
  if (!grouped.length) return;

  // Pega bot token genérico (esports preferido)
  const sportsOrder = ['esports', 'cs', 'valorant', 'tennis', 'mma', 'football'];
  let token = null, botSport = null;
  for (const sp of sportsOrder) {
    if (SPORTS[sp]?.enabled && SPORTS[sp]?.token) { token = SPORTS[sp].token; botSport = sp; break; }
  }
  if (!token) return;

  const lines = grouped.slice(0, 12).map(g => {
    const teamsStr = g.teams || g.matchId || '?';
    const flagsStr = (g.flags || []).slice(0, 3).join(', ');
    const leagueStr = g.league ? ` (${g.league})` : '';
    return `• ${g.sport.toUpperCase()} | ${teamsStr}${leagueStr}\n  └─ ${flagsStr} | há ${g.ageMin.toFixed(1)}min`;
  }).join('\n');
  const more = grouped.length > 12 ? `\n_(+${grouped.length - 12} outros gaps)_` : '';
  const msg = `🔍 *LIVE SCOUT — ${grouped.length} gap(s) persistente(s)*\n\n${lines}${more}\n\n` +
    `_Threshold ${LIVE_SCOUT_ALERT_THRESHOLD_MIN}min | cooldown ${Math.round(LIVE_SCOUT_ALERT_COOLDOWN_MS/60000)}min/gap_`;

  for (const adminId of ADMIN_IDS) {
    await sendDM(token, adminId, msg).catch(() => {});
  }
  log('WARN', 'LIVE-SCOUT-ALERT', `${grouped.length} gap(s) persistentes alertados via bot [${botSport}]`);
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

// ── Patch Meta: lido do env (LOL_PATCH_META no Railway) — sem auto-detect ──

// Live match notifications for esports — DESATIVADO (user não quer notificações de partida live)
async function checkLiveNotifications() {
  return;

  const esportsConfig = SPORTS['esports'];
  if (!esportsConfig?.enabled || !esportsConfig.token) return;
  const token = esportsConfig.token;

  try {
    const now = Date.now();
    const lolList = await serverGet('/lol-matches').catch(() => []);
    const allLive = Array.isArray(lolList) ? lolList.filter(m => m.status === 'live') : [];

    for (const match of allLive) {
      // Ao vivo: determinar mapa atual via Riot OU via placar da série (PS-only)
      const liveIds = await serverGet(`/live-gameids?matchId=${encodeURIComponent(String(match.id))}`).catch(() => []);
      let currentMap = Array.isArray(liveIds) ? (liveIds.find(x => x.hasLiveData)?.gameNumber || null) : null;
      // Fallback: mapa = games já decididos + 1 (Bo3/Bo5 com placar 1-0 → mapa 2)
      if (!currentMap && Number.isFinite(match.score1) && Number.isFinite(match.score2)) {
        const inferred = (match.score1 || 0) + (match.score2 || 0) + 1;
        if (inferred >= 1 && inferred <= 5) {
          currentMap = inferred;
          log('DEBUG', 'NOTIFY', `Mapa inferido pelo placar ${match.score1}-${match.score2} → mapa ${currentMap}: ${match.team1} vs ${match.team2}`);
        }
      }

      const fmt = match.format ? `&format=${encodeURIComponent(String(match.format))}` : '';
      const s1 = Number.isFinite(match.score1) ? `&score1=${encodeURIComponent(String(match.score1))}` : '';
      const s2 = Number.isFinite(match.score2) ? `&score2=${encodeURIComponent(String(match.score2))}` : '';

      let mapOdds = null;
      if (currentMap) {
        mapOdds = await serverGet(`/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}&map=${encodeURIComponent(String(currentMap))}${fmt}${s1}${s2}&force=1&game=lol`).catch(() => null);
      }
      // Fallback: odds de série (quando mapa ainda não disponível — Pinnacle per-map retornou vazio)
      if (!mapOdds?.t1 || parseFloat(mapOdds.t1) <= 1.0) {
        mapOdds = await serverGet(`/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}&game=lol`).catch(() => null);
      }
      if (!mapOdds?.t1 || parseFloat(mapOdds.t1) <= 1.0) continue;

      // Dedup por SÉRIE (não por mapa) para não duplicar notificações em cada mapa
      const matchKey = `${match.game}_${match.id}`;
      if (!notifiedMatches.has(matchKey)) {
        notifiedMatches.set(matchKey, now);
        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('esports')) continue;
          try {
            const o = mapOdds;
            const gameIcon = '🎮';
            const isMapMarket = (o.mapMarket === true);
            const marketLabel = isMapMarket ? 'ML do mapa' : 'ML da série';
            const mapHeader = currentMap ? `🗺️ *Mapa ${currentMap} (${marketLabel})*\n\n` : '';
            const mapNote = !isMapMarket
              ? `⚠️ *Mercado ML do mapa indisponível* — exibindo ML da série\n`
              : '';
            const txt = `${gameIcon} 🔴 *PARTIDA AO VIVO (COM MERCADO ABERTO)!*\n` +
              mapHeader +
              `*${match.team1}* ${match.score1}-${match.score2} *${match.team2}*\n` +
              `📋 ${match.league}\n` +
              mapNote +
              `💰 ${match.team1}: ${o.t1} | ${match.team2}: ${o.t2}\n\n` +
              (isMapMarket
                ? `_A partir de agora: apenas ML do mapa atual. Odds acima são do mapa._`
                : `_Odds de série disponíveis. Quando mercado do mapa abrir, odds serão do mapa._`);

            await sendDM(token, userId, txt);
          } catch(e) {
            if (e.message?.includes('403')) subscribedUsers.delete(userId);
          }
        }
      }
    }

    // Dota 2: notificar quando odds ao vivo estiverem acessíveis
    if (now - lastDotaLiveCheck >= DOTA_LIVE_CHECK_INTERVAL) {
      lastDotaLiveCheck = now;
      const maxCfg = parseInt(process.env.DOTA_LIVE_NOTIFY_MAX || '4', 10);
      const maxN = Math.min(10, Math.max(1, Number.isFinite(maxCfg) ? maxCfg : 4));
      const dotaList = await serverGet('/dota-matches').catch(() => []);
      const dotaLive = Array.isArray(dotaList) ? dotaList.filter(m => m.status === 'live') : [];
      let liveWithOdds = 0;
      for (const match of dotaLive.slice(0, maxN)) {
        const o = await serverGet(`/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}&game=dota2&live=1`).catch(() => null);
        if (!o?.t1 || !o?.t2 || parseFloat(o.t1) <= 1.0) continue;
        liveWithOdds++;
        const matchKey = `dota2_${match.id}`;
        if (notifiedMatches.has(matchKey)) continue;
        notifiedMatches.set(matchKey, now);
        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('esports')) continue;
          try {
            const txt = `🕹️ 🔴 *DOTA 2 AO VIVO (ODDS AO VIVO DISPONÍVEIS)!*\n\n` +
              `*${match.team1}* ${match.score1||0}-${match.score2||0} *${match.team2}*\n` +
              `📋 ${match.league || 'Dota 2'} | ${match.format || 'Bo?'}\n` +
              `💰 ${match.team1}: ${o.t1} | ${match.team2}: ${o.t2}\n` +
              `_Fonte: ${o.bookmaker || 'odds'}_`;
            await sendDM(token, userId, txt);
          } catch(e) {
            if (e.message?.includes('403')) subscribedUsers.delete(userId);
          }
        }
      }
      if (dotaLive.length && liveWithOdds === 0) {
        log('INFO', 'NOTIFY', `Dota 2 ao vivo: ${dotaLive.length} | odds ao vivo: 0 (sem aviso)`);
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
async function collectGameContext(game, matchId, team1, team2) {
  let gamesContext = '';
  let compScore = null; // pp advantage for t1 (blue) based on pro champion WRs
  let liveGameNumber = null; // número do mapa atualmente ao vivo (Game 1, 2, 3...)
  let hasLiveStats = false;
  let draftComplete = false; // composições completas (10 champs definidos)
  if (game === 'lol') {
    const isPandaScore = String(matchId).startsWith('ps_');
    const isChampValid = (c) => {
      const s = String(c || '').trim();
      if (!s) return false;
      const low = s.toLowerCase();
      return low !== '?' && low !== '???' && low !== 'unknown' && low !== 'null' && low !== 'undefined';
    };
    const isDraftCompleteTeam = (team) => {
      const pls = team?.players || [];
      if (pls.length !== 5) return false;
      return pls.every(p => isChampValid(p?.champion));
    };

    if (isPandaScore) {
      // Fonte PandaScore — composições via /ps-compositions.
      // Para LPL/matches ps_*: se PS falhar, tenta fallback Riot via team names (descoberto 2026-04-15).
      try {
        const gd = await serverGet(`/ps-compositions?matchId=${encodeURIComponent(matchId)}`);
        log('INFO', 'LIVE-STATS', `LoL PandaScore ${matchId}: hasComps=${!!gd.hasCompositions} hasLiveStats=${!!gd.hasLiveStats} game=${gd.gameNumber||'?'} status=${gd.gameStatus||'?'}`);
        if (gd.hasCompositions && (gd.blueTeam?.players?.length || gd.redTeam?.players?.length)) {
          const thisDraftComplete = isDraftCompleteTeam(gd.blueTeam) && isDraftCompleteTeam(gd.redTeam);
          if (thisDraftComplete) draftComplete = true;
          const roles = { top:'TOP', jungle:'JGL', mid:'MID', bottom:'ADC', support:'SUP', '?':'?' };
          const g = (v) => v >= 1000 ? (v/1000).toFixed(1)+'k' : String(v||0);
          const gameLabel = gd.gameNumber ? `GAME ${gd.gameNumber}` : 'GAME';
          const statusLabel = gd.gameStatus === 'running' ? 'AO VIVO' : gd.gameStatus || 'INFO';
          const liveNow = gd.gameStatus === 'running' && gd.hasLiveStats && gd.gameNumber;
          if (liveNow) { liveGameNumber = gd.gameNumber; hasLiveStats = true; }
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
          gamesContext += `_Fonte: PandaScore_${thisDraftComplete ? '' : ' | ⚠️ draft incompleto'}_\n`;

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

            // Comp score por champ WR (pro play DB: PandaScore sync + opcional gol.gg CSV seed)
            if (wrData && Object.keys(wrData).length >= 4) {
              let blueWR = 0, blueN = 0, redWR = 0, redN = 0;
              let blueTot = 0, redTot = 0;
              for (const pl of (gd.blueTeam?.players||[])) {
                const s = wrData[pl.champion];
                if (s) { blueWR += s.winRate; blueTot += (s.total || 0); blueN++; }
              }
              for (const pl of (gd.redTeam?.players||[])) {
                const s = wrData[pl.champion];
                if (s) { redWR += s.winRate; redTot += (s.total || 0); redN++; }
              }
              if (blueN > 0 && redN > 0) {
                const blueAvg = blueWR / blueN;
                const redAvg  = redWR  / redN;
                compScore = blueAvg - redAvg;
                const blueAvgN = Math.round(blueTot / blueN);
                const redAvgN  = Math.round(redTot  / redN);
                gamesContext += `META PRO (champ WR): ${gd.blueTeam.name} ${blueAvg.toFixed(1)}% (n~${blueAvgN}) vs ${gd.redTeam.name} ${redAvg.toFixed(1)}% (n~${redAvgN}) (diff: ${compScore > 0 ? '+' : ''}${compScore.toFixed(1)}pp)\n`;
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
          } catch(e) { log('WARN', 'PS-CONTEXT', `Champ/player WR fetch falhou: ${e.message}`); }
        }
      } catch(e) { log('WARN', 'PS-CONTEXT', e.message); }
      // Fallback Riot por team names quando PS não deu live stats (caso típico LPL no plano atual).
      // /live-gameids com team1/team2 procura no getSchedule (zh-CN + en-US) e resolve o Riot matchId.
      if (!hasLiveStats && team1 && team2) {
        try {
          const ids = await serverGet(`/live-gameids?team1=${encodeURIComponent(team1)}&team2=${encodeURIComponent(team2)}`).catch(() => []);
          log('INFO', 'LIVE-STATS', `LoL Riot fallback (PS→teams): ${team1} vs ${team2} → ${Array.isArray(ids) ? ids.length : 0} gameId(s)`);
          for (const gid of (Array.isArray(ids) ? ids : [])) {
            const gd = await serverGet(`/live-game?gameId=${gid.gameId}`);
            log('INFO', 'LIVE-STATS', `LoL Riot game ${gid.gameId}: state=${gd.gameState||'?'} hasLiveStats=${!!gd.hasLiveStats} gold=${gd.blueTeam?.totalGold||0}/${gd.redTeam?.totalGold||0}`);
            if (gd.hasLiveStats && (gd.gameState === 'in_game' || gd.gameState === 'paused')) {
              hasLiveStats = true;
              if (gid.gameNumber) liveGameNumber = gid.gameNumber;
              const gfn = (v) => v >= 1000 ? (v/1000).toFixed(1)+'k' : String(v||0);
              const blue = gd.blueTeam, red = gd.redTeam;
              const goldDiff = (blue.totalGold||0) - (red.totalGold||0);
              const blueDragons = blue.dragonTypes?.length ? blue.dragonTypes.join(', ') : (blue.dragons||0);
              const redDragons  = red.dragonTypes?.length  ? red.dragonTypes.join(', ')  : (red.dragons||0);
              gamesContext += `\n[GAME ${gid.gameNumber || '?'} — AO VIVO | Riot fallback]\nGold: ${blue.name} ${gfn(blue.totalGold)} vs ${red.name} ${gfn(red.totalGold)} (diff: ${goldDiff>0?'+':''}${gfn(goldDiff)})\nTorres: ${blue.towerKills||0}x${red.towerKills||0} | Dragões: ${blueDragons} vs ${redDragons}\nKills: ${blue.totalKills||0}x${red.totalKills||0} | Barões: ${blue.barons||0}x${red.barons||0}\n`;
              break;
            }
          }
        } catch(e) { log('WARN', 'RIOT-FALLBACK', `${team1} vs ${team2}: ${e.message}`); }
      }
    } else {
      // Fonte Riot (lolesports.com) — live-gameids + live-game
      const ids = await serverGet(`/live-gameids?matchId=${matchId}`).catch(() => []);
      log('INFO', 'LIVE-STATS', `LoL Riot ${matchId}: ${Array.isArray(ids) ? ids.length : 0} gameId(s)`);
      if (Array.isArray(ids)) {
        for (const gid of ids) {
          try {
            const gd = await serverGet(`/live-game?gameId=${gid.gameId}`);
            // STATS_DISABLED = Riot bloqueou feed (ligas tier-2); sem ação, não polui log.
            if (gd.statsDisabled) {
              log('DEBUG', 'LIVE-STATS', `LoL Riot game ${gid.gameId}: STATS_DISABLED pela Riot`);
            } else {
              log('INFO', 'LIVE-STATS', `LoL Riot game ${gid.gameId}: state=${gd.gameState||'?'} hasLiveStats=${!!gd.hasLiveStats} hasDraft=${!!gd.hasDraft} gold=${gd.blueTeam?.totalGold||0}/${gd.redTeam?.totalGold||0}`);
            }
            if (gd.blueTeam?.players?.length) {
              const thisDraftComplete = isDraftCompleteTeam(gd.blueTeam) && isDraftCompleteTeam(gd.redTeam);
              if (thisDraftComplete) draftComplete = true;
              const roles = { top:'TOP', jungle:'JGL', mid:'MID', bottom:'ADC', support:'SUP' };
              const g = (v) => v >= 1000 ? (v/1000).toFixed(1)+'k' : String(v||0);
              // LPL bug fix 2026-04-15: Riot schedule marca LPL games como "unstarted" mesmo
              // quando está in_game. Não depender de gid.hasLiveData — usar só o que veio do feed real.
              const liveNow = !!(gd.hasLiveStats && (gd.gameState === 'in_game' || gd.gameState === 'paused'));
              if (liveNow) {
                const blue = gd.blueTeam, red = gd.redTeam;
                const goldDiff = blue.totalGold - red.totalGold;
                const delayInfo = gd.dataDelay ? ` (dados de ~${gd.dataDelay}s atrás)` : '';
                const blueDragons = blue.dragonTypes?.length ? blue.dragonTypes.join(', ') : (blue.dragons||0);
                const redDragons = red.dragonTypes?.length ? red.dragonTypes.join(', ') : (red.dragons||0);
                if (gid.gameNumber) liveGameNumber = gid.gameNumber;
                hasLiveStats = true;
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
              if (!thisDraftComplete && !liveNow) {
                gamesContext += `_Fonte: Riot | ⚠️ draft incompleto_\n`;
              }

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
                    let blueTot = 0, redTot = 0;
                    for (const pl of (gd.blueTeam?.players||[])) {
                      const s = wrData[pl.champion];
                      if (s) { blueWR += s.winRate; blueTot += (s.total || 0); blueN++; }
                    }
                    for (const pl of (gd.redTeam?.players||[])) {
                      const s = wrData[pl.champion];
                      if (s) { redWR += s.winRate; redTot += (s.total || 0); redN++; }
                    }
                    if (blueN > 0 && redN > 0) {
                      const blueAvg = blueWR / blueN;
                      const redAvg  = redWR  / redN;
                      compScore = blueAvg - redAvg;
                      const blueAvgN = Math.round(blueTot / blueN);
                      const redAvgN  = Math.round(redTot  / redN);
                      gamesContext += `META PRO (champ WR): ${gd.blueTeam.name} ${blueAvg.toFixed(1)}% (n~${blueAvgN}) vs ${gd.redTeam.name} ${redAvg.toFixed(1)}% (n~${redAvgN}) (diff: ${compScore > 0 ? '+' : ''}${compScore.toFixed(1)}pp)\n`;
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
                } catch(e) { log('WARN', 'RIOT-CONTEXT', `Champ/player WR fetch falhou: ${e.message}`); }
              }
            }
          } catch(e) { log('WARN', 'RIOT-CONTEXT', `Erro ao processar game ${gid?.gameId}: ${e.message}`); }
        }
      }
    }
  }
  return { text: gamesContext, compScore, liveGameNumber, hasLiveStats, draftComplete };
}

async function fetchEnrichment(match) {
  const game = match.game;
  const data = { form1: null, form2: null, h2h: null, oddsMovement: null, grid: null };
  const useGrid = game === 'lol' && (process.env.LOL_GRID_ENRICH ?? 'true') !== 'false';
  try {
    const t1 = match.team1 || match.participant1_name;
    const t2 = match.team2 || match.participant2_name;
    const parts = [
      serverGet(`/team-form?team=${encodeURIComponent(t1)}&game=${game}`).catch(() => null),
      serverGet(`/team-form?team=${encodeURIComponent(t2)}&game=${game}`).catch(() => null),
      serverGet(`/h2h?team1=${encodeURIComponent(t1)}&team2=${encodeURIComponent(t2)}&game=${game}`).catch(() => null),
      serverGet(`/odds-movement?team1=${encodeURIComponent(t1)}&team2=${encodeURIComponent(t2)}`).catch(() => null),
    ];
    if (useGrid) {
      parts.push(serverGet(`/grid-enrich?team1=${encodeURIComponent(t1)}&team2=${encodeURIComponent(t2)}&game=lol`).catch(() => null));
    }
    const out = await Promise.all(parts);
    data.form1 = out[0]; data.form2 = out[1]; data.h2h = out[2]; data.oddsMovement = out[3];
    if (useGrid) data.grid = out[4];
  } catch(e) { log('WARN', 'ENRICH', `Erro ao buscar enrichment para ${match?.team1} vs ${match?.team2}: ${e.message}`); }
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
  const gr = enrich.grid;
  if (gr?.ok && (gr.h2h || gr.form1 || gr.form2)) {
    txt += '\nGRID (séries oficiais — janela configurável no server):\n';
    if (gr.form1 && (gr.form1.wins + gr.form1.losses) > 0) {
      txt += `${t1}: ${gr.form1.wins}W-${gr.form1.losses}L (${gr.form1.winRate}%) [GRID]\n`;
    }
    if (gr.form2 && (gr.form2.wins + gr.form2.losses) > 0) {
      txt += `${t2}: ${gr.form2.wins}W-${gr.form2.losses}L (${gr.form2.winRate}%) [GRID]\n`;
    }
    if (gr.h2h && (gr.h2h.t1Wins + gr.h2h.t2Wins) > 0) {
      txt += `H2H GRID: ${t1} ${gr.h2h.t1Wins}-${gr.h2h.t2Wins} ${t2} (${gr.h2h.totalMatches} séries com resultado)\n`;
    }
  }
  return txt;
}

async function autoAnalyzeMatch(token, match) {
  const game = match.game;
  const matchId = String(match.id);
  try {
    const [o, gameCtx, enrich] = await Promise.all([
      serverGet(`/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}&game=${encodeURIComponent(game)}`).catch(() => null),
      collectGameContext(game, matchId, match.team1, match.team2),
      fetchEnrichment(match)
    ]);
    const gamesContext   = gameCtx.text;
    const compScore      = gameCtx.compScore;
    const liveGameNumber = gameCtx.liveGameNumber; // nº do mapa atual (null se não ao vivo)
    const hasLiveStats   = !!gameCtx.hasLiveStats;
    const draftComplete  = !!gameCtx.draftComplete;
    const enrichSection = buildEnrichmentSection(match, enrich);

    // Draft: só analisar quando draft completo (evita tip com base em comp parcial)
    if (match.status === 'draft' && !hasLiveStats && !draftComplete) {
      log('INFO', 'AUTO', `Draft incompleto: pulando ${match.team1} vs ${match.team2} (aguardando comp completa)`);
      return null;
    }

    // Ao vivo: usar odds do MAPA atual. Se Riot live-game não forneceu liveGameNumber
    // (partida PandaScore-only), inferir pelo placar: mapa atual = score1 + score2 + 1.
    // Isso evita o bug de análise com odds de série em partida live.
    let oddsToUse = o;
    let effectiveMapNumber = null;
    if (match.status === 'live') {
      if (hasLiveStats && liveGameNumber) {
        effectiveMapNumber = liveGameNumber;
      } else if (Number.isFinite(match.score1) && Number.isFinite(match.score2)) {
        const inferred = (match.score1 || 0) + (match.score2 || 0) + 1;
        if (inferred >= 1 && inferred <= 5) {
          effectiveMapNumber = inferred;
          log('DEBUG', 'AUTO', `Mapa inferido pelo placar ${match.score1}-${match.score2} → mapa ${inferred}: ${match.team1} vs ${match.team2}`);
        }
      }
    }
    if (effectiveMapNumber) {
      const fmt = match.format ? `&format=${encodeURIComponent(String(match.format))}` : '';
      const s1 = Number.isFinite(match.score1) ? `&score1=${encodeURIComponent(String(match.score1))}` : '';
      const s2 = Number.isFinite(match.score2) ? `&score2=${encodeURIComponent(String(match.score2))}` : '';
      const mo = await serverGet(`/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}&map=${encodeURIComponent(String(effectiveMapNumber))}${fmt}${s1}${s2}&force=1&game=${encodeURIComponent(game)}`).catch(() => null);
      if (mo?.t1 && mo?.t2) oddsToUse = mo;
    }

    // ── Odds freshness gate ──
    const isLiveLoL = match.status === 'live' || match.status === 'inprogress';
    if (oddsToUse?.t1 && !isOddsFresh(oddsToUse, isLiveLoL)) {
      log('INFO', 'AUTO', `Odds stale (${oddsAgeStr(oddsToUse)}): ${match.team1} vs ${match.team2} — pulando`);
      return null;
    }

    // ── Layer 1: Pré-filtro ML ──
    // Retorna { pass, direction, score, t1Edge, t2Edge }
    const mlPrefilterOn = (process.env.LOL_ML_PREFILTER ?? 'true') !== 'false';
    const mlResult = esportsPreFilter(match, oddsToUse, enrich, hasLiveStats, gamesContext, compScore);

    // ── Layer 1b: Modelo LoL específico (Elo + Draft + Form) ──
    // Gera probabilidades melhores que o ML genérico. Usado para:
    // 1. Resgatar matches que o ML genérico rejeitou mas o modelo específico vê edge
    // 2. Melhorar a estimativa de P para Kelly sizing
    let lolModel = null;
    try {
      lolModel = getLolProbability(db, match, oddsToUse, enrich, compScore);
      if (lolModel && lolModel.confidence > 0.3) {
        // Merge: se o modelo específico tem confiança alta, usa suas probabilidades
        if (lolModel.modelP1 > 0 && lolModel.modelP2 > 0) {
          mlResult.modelP1 = mlResult.modelP1 > 0
            ? mlResult.modelP1 * 0.4 + lolModel.modelP1 * 0.6  // blend: 60% modelo específico
            : lolModel.modelP1;
          mlResult.modelP2 = 1 - mlResult.modelP1;
        }
        // Se modelo específico vê edge forte (>5pp) e ML genérico rejeitou, resgata
        const lolEdge = Math.abs(lolModel.modelP1 - lolModel.modelP2) > 0
          ? Math.max(
              (lolModel.modelP1 - (1 / parseFloat(oddsToUse?.t1 || 2))) * 100,
              (lolModel.modelP2 - (1 / parseFloat(oddsToUse?.t2 || 2))) * 100
            ) : 0;
        if (!mlResult.pass && lolEdge >= 5 && lolModel.confidence >= 0.5) {
          mlResult.pass = true;
          mlResult.score = lolEdge;
          mlResult.direction = lolModel.modelP1 > lolModel.modelP2 ? 't1' : 't2';
          log('INFO', 'AUTO', `Modelo LoL resgatou: ${match.team1} vs ${match.team2} | edge=${lolEdge.toFixed(1)}pp conf=${lolModel.confidence.toFixed(2)} method=${lolModel.method}`);
        }
        log('DEBUG', 'LOL-MODEL', `${match.team1} vs ${match.team2}: P1=${(lolModel.modelP1*100).toFixed(1)}% conf=${lolModel.confidence.toFixed(2)} factors=${lolModel.factors?.join('+')}`);
      }
    } catch(e) { log('DEBUG', 'LOL-MODEL', `Erro: ${e.message}`); }

    if (mlPrefilterOn && !mlResult.pass) {
      log('INFO', 'AUTO', `Pré-filtro ML: edge insuficiente (${mlResult.score.toFixed(1)}pp) para ${match.team1} vs ${match.team2}. Pulando IA.`);
      return null;
    }

    const hasRealOdds = !!(oddsToUse?.t1 && parseFloat(oddsToUse.t1) > 1);
    // Sem odds reais: não chamar IA (não dá para gerar TIP_ML/EV)
    if (!hasRealOdds) {
      // Ao vivo: esperar mercado abrir; pré-jogo: esperar odds aparecer
      return null;
    }

    const newsSectionEsports = await fetchMatchNews('esports', match.team1, match.team2).catch(() => '');
    const { text: prompt, evThreshold: adaptiveEV, sigCount } = buildEsportsPrompt(match, game, gamesContext, oddsToUse, enrichSection, mlResult, newsSectionEsports);
    const liveTag = (match.status === 'live' || match.status === 'inprogress') ? ' [AO VIVO]' : '';
    log('INFO', 'AUTO', `Analisando${liveTag}: ${match.team1} vs ${match.team2} | sinais=${sigCount}/6 | evThreshold=${adaptiveEV}% | mlEdge=${mlResult.score.toFixed(1)}pp`);

    // Backoff IA: evita spam quando DeepSeek responde 429 (rate_limited)
    const FALLBACK_MIN_ODDS = parseFloat(process.env.LOL_MIN_ODDS ?? '1.50');
    const FALLBACK_MAX_ODDS = parseFloat(process.env.LOL_MAX_ODDS ?? '4.00');
    if (!global.__deepseekBackoffUntil) global.__deepseekBackoffUntil = 0;
    if (!global.__deepseekLastCallTs) global.__deepseekLastCallTs = 0;
    // Cooldown mínimo entre chamadas (evita 429 por múltiplos live matches simultâneos)
    // O backoff pós-429 só é setado após a resposta chegar — este cooldown é preventivo
    const DS_COOLDOWN_MS = Math.max(3000, parseInt(process.env.DEEPSEEK_CALL_COOLDOWN_MS || '20000', 10) || 20000);
    const sinceLastCall = Date.now() - global.__deepseekLastCallTs;
    if (sinceLastCall < DS_COOLDOWN_MS && global.__deepseekLastCallTs > 0) {
      const remainMs = DS_COOLDOWN_MS - sinceLastCall;
      const MAX_WAIT_MS = Math.max(3000, parseInt(process.env.DEEPSEEK_COOLDOWN_MAX_WAIT_MS || '25000', 10) || 25000);
      if (remainMs <= MAX_WAIT_MS) {
        log('INFO', 'AUTO', `DeepSeek cooldown (${Math.round(remainMs/1000)}s) — aguardando para ${match.team1} vs ${match.team2}`);
        await _sleep(remainMs + 100);
      } else {
        log('INFO', 'AUTO', `DeepSeek cooldown (${Math.round(remainMs/1000)}s restantes >${Math.round(MAX_WAIT_MS/1000)}s) — pulando ${match.team1} vs ${match.team2}`);
        return null;
      }
    }
    if (Date.now() < global.__deepseekBackoffUntil) {
      const direction = mlResult.direction;
      const pickTeam = direction === 't2' ? match.team2 : match.team1;
      const pickOdd = direction === 't2' ? parseFloat(oddsToUse?.t2) : parseFloat(oddsToUse?.t1);
      const pickP = direction === 't2' ? mlResult.modelP2 : mlResult.modelP1;
      const evPct = (pickP && pickOdd) ? ((pickP * pickOdd - 1) * 100) : 0;
      if (pickOdd >= FALLBACK_MIN_ODDS && pickOdd <= FALLBACK_MAX_ODDS && evPct >= 5 && mlResult.score >= 5) {
        const stake = calcKellyWithP(pickP, pickOdd, 0.15);
        log('WARN', 'AUTO', `IA em backoff; fallback modelo: ${pickTeam} @ ${pickOdd} EV=${evPct.toFixed(1)}% edge=${mlResult.score.toFixed(1)}pp`);
        return {
          ok: true,
          tipMatch: [
            `TIP_ML: ${pickTeam} @ ${pickOdd} |EV: +${evPct.toFixed(1)}% |STAKE: ${String(stake || '1u')} |CONF: MÉDIA`,
            String(pickTeam),
            String(pickOdd),
            `+${evPct.toFixed(1)}%`,
            String(stake || '1u'),
            CONF.MEDIA
          ],
          tipTeam: pickTeam,
          tipOdd: pickOdd,
          tipEV: parseFloat(evPct.toFixed(1)),
          tipStake: String(stake || '1u'),
          tipConf: CONF.MEDIA,
          tipReason: 'Value detectado pelo modelo (fallback em backoff IA)',
          debugVars: {
            source: 'fallback_backoff',
            game,
            status: match.status,
            league: match.league,
            t1: match.team1,
            t2: match.team2,
            hasLiveStats,
            liveGameNumber,
            odds: { t1: oddsToUse?.t1, t2: oddsToUse?.t2, bookmaker: oddsToUse?.bookmaker, market: oddsToUse?.market, mapMarket: oddsToUse?.mapMarket },
            modelP1: mlResult.modelP1,
            modelP2: mlResult.modelP2,
            pick: { team: pickTeam, odd: pickOdd, p: pickP, evPct: parseFloat(evPct.toFixed(1)), stake: String(stake || '1u'), conf: CONF.MEDIA },
            ml: { pass: mlResult.pass, direction: mlResult.direction, edgePp: parseFloat(mlResult.score.toFixed(1)), factors: mlResult.factorActive || [], factorCount: mlResult.factorCount || 0 },
            signals: { sigCount, evThreshold: adaptiveEV },
            compScore
          }
        };
      }
      if (Number.isFinite(pickOdd)) {
        log('INFO', 'AUTO', `Fallback backoff rejeitado: ${pickTeam} @ ${pickOdd} — fora do range [${FALLBACK_MIN_ODDS}, ${FALLBACK_MAX_ODDS}] ou EV/edge insuficiente`);
      }
      return null;
    }

    if (process.env.LOG_IA_PROMPT === 'true') {
      log('DEBUG', 'IA-PROMPT', `${match.team1} vs ${match.team2}: ${prompt.slice(0, 400)}...`);
    }

    global.__deepseekLastCallTs = Date.now(); // marca antes de chamar — cooldown preventivo
    const resp = await serverPost('/claude', {
      model: 'deepseek-chat',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });
    if (resp?.__status === 429 || String(resp?.error || '').toLowerCase().includes('rate')) {
      const ttl = Math.max(60 * 1000, parseInt(process.env.DEEPSEEK_BACKOFF_MS || '180000', 10) || 180000);
      global.__deepseekBackoffUntil = Date.now() + ttl;
      log('WARN', 'AUTO', `DeepSeek 429: backoff ${Math.round(ttl/60000)}min ativado`);
    }

    const text = resp.content?.map(b => b.text || '').join('');
    if (process.env.LOG_IA_PROMPT === 'true' && text) {
      log('DEBUG', 'IA-RESP', `${match.team1} vs ${match.team2}: ${text.slice(0, 400)}...`);
    }
    if (!text) {
      // Fallback sem IA: envia tip baseada no modelo quando há edge claro
      const direction = mlResult.direction;
      const pickTeam = direction === 't2' ? match.team2 : match.team1;
      const pickOdd = direction === 't2' ? parseFloat(oddsToUse?.t2) : parseFloat(oddsToUse?.t1);
      const pickP = direction === 't2' ? mlResult.modelP2 : mlResult.modelP1;
      const evPct = (pickP && pickOdd) ? ((pickP * pickOdd - 1) * 100) : 0;
      if (pickOdd >= FALLBACK_MIN_ODDS && pickOdd <= FALLBACK_MAX_ODDS && evPct >= 5 && mlResult.score >= 5) {
        const stake = calcKellyWithP(pickP, pickOdd, 0.15); // ~1/6 Kelly
        const errShort = resp?.error ? String(resp.error).slice(0, 140) : '';
        const st = resp?.__status ? String(resp.__status) : '';
        log('WARN', 'AUTO', `IA sem resposta; fallback modelo: ${pickTeam} @ ${pickOdd} EV=${evPct.toFixed(1)}% edge=${mlResult.score.toFixed(1)}pp${st ? ` | status=${st}` : ''}${errShort ? ` | err=${errShort}` : ''}`);
        return {
          ok: true,
          // Compatível com runAutoAnalysis(): precisa tipMatch estilo regex
          tipMatch: [
            `TIP_ML: ${pickTeam} @ ${pickOdd} |EV: +${evPct.toFixed(1)}% |STAKE: ${String(stake || '1u')} |CONF: MÉDIA`,
            String(pickTeam),
            String(pickOdd),
            `+${evPct.toFixed(1)}%`,
            String(stake || '1u'),
            CONF.MEDIA
          ],
          tipTeam: pickTeam,
          tipOdd: pickOdd,
          tipEV: parseFloat(evPct.toFixed(1)),
          tipStake: String(stake || '1u'),
          tipConf: CONF.MEDIA,
          tipReason: 'Value detectado pelo modelo (fallback sem IA)',
          debugVars: {
            source: 'fallback_no_ai',
            game,
            status: match.status,
            league: match.league,
            t1: match.team1,
            t2: match.team2,
            hasLiveStats,
            liveGameNumber,
            odds: { t1: oddsToUse?.t1, t2: oddsToUse?.t2, bookmaker: oddsToUse?.bookmaker, market: oddsToUse?.market, mapMarket: oddsToUse?.mapMarket },
            modelP1: mlResult.modelP1,
            modelP2: mlResult.modelP2,
            pick: { team: pickTeam, odd: pickOdd, p: pickP, evPct: parseFloat(evPct.toFixed(1)), stake: String(stake || '1u'), conf: CONF.MEDIA },
            ml: { pass: mlResult.pass, direction: mlResult.direction, edgePp: parseFloat(mlResult.score.toFixed(1)), factors: mlResult.factorActive || [], factorCount: mlResult.factorCount || 0 },
            signals: { sigCount, evThreshold: adaptiveEV },
            compScore
          }
        };
      }
      if (Number.isFinite(pickOdd)) {
        log('INFO', 'AUTO', `Fallback sem IA rejeitado: ${pickTeam} @ ${pickOdd} — fora do range [${FALLBACK_MIN_ODDS}, ${FALLBACK_MAX_ODDS}] ou EV/edge insuficiente`);
      }
      const errShort = resp?.error ? String(resp.error).slice(0, 220) : '';
      const st = resp?.__status ? String(resp.__status) : '';
      log('WARN', 'AUTO', `IA sem resposta para ${match.team1} vs ${match.team2} (provider: ${resp.provider || 'deepseek'})${st ? ` | status=${st}` : ''}${errShort ? ` | err=${errShort}` : ''}`);
      return null;
    }

    // Parse via helper — aceita formato novo (|P:X|STAKE:...) e antigo (|EV:X|P:Y|STAKE:...).
    // EV recalculado automaticamente de P×odd quando ausente. Layout [1]=team, [2]=odd, [3]=EV, [4]=stake, [5]=conf.
    let tipResult = _parseTipMl(text);
    // Log quando a IA gerou resposta mas o padrão TIP_ML não foi encontrado (ajuda a detectar mudança de formato)
    if (!tipResult && text && text.length > 20 && !text.toLowerCase().includes('sem edge') && !text.toLowerCase().includes('sem tip') && !/\bsem_?tip\b/i.test(text)) {
      const snippet = text.slice(0, 200).replace(/\n/g, ' ');
      log('DEBUG', 'IA-PARSE', `Sem TIP_ML na resposta para ${match.team1} vs ${match.team2}: "${snippet}"`);
    }
    if (tipResult) {
      // Valida P-texto vs P-modelo. EV será recalculado via _modelEv downstream.
      const _pickIsT1V = norm(tipResult[1].trim()) === norm(match.team1)
        || norm(match.team1).includes(norm(tipResult[1].trim()))
        || norm(tipResult[1].trim()).includes(norm(match.team1));
      const _modelPV = _pickIsT1V ? mlResult.modelP1 : mlResult.modelP2;
      const _v = _validateTipPvsModel(text, _modelPV);
      if (!_v.valid) {
        log('WARN', 'AUTO', `Tip rejeitada (${match.team1} vs ${match.team2}): ${_v.reason}`);
        tipResult = null;
      }
      // Gate divergência modelo vs Pinnacle (sharp anchor).
      if (tipResult) {
        const _impPV = _pickIsT1V ? mlResult.impliedP1 : mlResult.impliedP2;
        const _maxDivLol = parseFloat(process.env.LOL_MAX_DIVERGENCE_PP ?? '15');
        const _div = _sharpDivergenceGate({ oddsObj: oddsToUse, modelP: _modelPV, impliedP: _impPV, maxPp: _maxDivLol });
        if (!_div.ok) {
          log('WARN', 'AUTO', `Tip rejeitada (${match.team1} vs ${match.team2}): ${_div.reason}`);
          tipResult = null;
        }
      }
    }
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
      let   tipConf  = (filteredTipResult[5] || CONF.MEDIA).trim().toUpperCase();

      // Validação numérica: rejeitar tip se odd ou EV não são números válidos
      if (!Number.isFinite(tipOdd) || tipOdd <= 1.0) {
        log('WARN', 'AUTO', `Tip com odd inválida rejeitada: "${filteredTipResult[2]}" (${match.team1} vs ${match.team2})`);
        filteredTipResult = null;
      } else if (!Number.isFinite(tipEV)) {
        log('WARN', 'AUTO', `Tip com EV inválido rejeitada: "${filteredTipResult[3]}" (${match.team1} vs ${match.team2})`);
        filteredTipResult = null;
      } else if (!tipTeam) {
        log('WARN', 'AUTO', `Tip sem time rejeitada (${match.team1} vs ${match.team2})`);
        filteredTipResult = null;
      }

      // Gate 0.5: Validação cruzada EV da IA vs modelo (quando modelP disponível)
      // Previne tip quando IA reporta EV muito acima do que o modelo calcula
      // Ex: modelo calcula EV=+2%, IA reporta EV=+12% — divergência de 10pp → suspeito
      //
      // IMPORTANTE — política de Kelly/stake:
      //   • O stake NUNCA usa a P implícita da IA; sempre usa modelP do ML (ou calcKellyFraction
      //     quando factorCount=0). Isso evita que a IA infle o stake ao exagerar edge.
      //   • Este gate serve para rebaixar CONFIANÇA quando IA e modelo divergem — não mexe no stake.
      //   • Assimetria intencional: IA > modelo → penaliza (IA otimista demais); IA < modelo → OK
      //     (IA sendo cautelosa pode refletir sinal qualitativo que o ML não captura).
      if (filteredTipResult && mlResult.modelP1 > 0 && mlResult.factorCount >= 1) {
        const isT1Tip = filteredTipResult[1] && (norm(filteredTipResult[1]).includes(norm(match.team1)) || norm(match.team1).includes(norm(filteredTipResult[1].trim())));
        const modelP  = isT1Tip ? mlResult.modelP1 : mlResult.modelP2;
        const modelEV = (modelP * tipOdd - 1) * 100;
        const evDivergence = tipEV - modelEV;
        // Se IA reporta EV >10pp acima do modelo, rebaixa confiança
        if (evDivergence > 10) {
          const confAtual = (filteredTipResult[5] || CONF.MEDIA).trim().toUpperCase();
          if (confAtual === CONF.ALTA) {
            filteredTipResult[5] = CONF.MEDIA;
            log('INFO', 'AUTO', `Gate EV-modelo: ${match.team1} vs ${match.team2} → IA EV=${tipEV.toFixed(1)}% vs modeloEV=${modelEV.toFixed(1)}% (Δ${evDivergence.toFixed(1)}pp) → ALTA→MÉDIA`);
          } else if (confAtual === CONF.MEDIA && evDivergence > 15) {
            filteredTipResult[5] = CONF.BAIXA;
            log('INFO', 'AUTO', `Gate EV-modelo: ${match.team1} vs ${match.team2} → IA EV diverge ${evDivergence.toFixed(1)}pp → MÉDIA→BAIXA`);
          }
        }

        // Gate 0.6: Divergência simétrica de MAGNITUDE de P (direção concordante mas P distante)
        // Preferimos P REPORTADO explicitamente pela IA (novo campo `|P:XX%|` no formato TIP_ML).
        // Fallback: derivação `P_ai = (1 + EV/100) / odd` se IA não forneceu P.
        // Se |P_ml − P_ai| > 0.10, há ruído grande entre os dois estimadores — rebaixa um nível
        // (mesmo que a direção bata). Stake permanece com modelP do ML.
        const reportedPMatch = String(text || '').match(/\|P:\s*([0-9.]+)\s*%?/i);
        const reportedP = reportedPMatch ? Math.max(0.01, Math.min(0.99, parseFloat(reportedPMatch[1]) / 100)) : null;
        const pAiImplied = reportedP != null ? reportedP : (1 + tipEV / 100) / tipOdd;
        const pDivergence = Math.abs(modelP - pAiImplied);
        if (pDivergence > 0.10) {
          const confAtual = (filteredTipResult[5] || CONF.MEDIA).trim().toUpperCase();
          if (confAtual === CONF.ALTA) {
            filteredTipResult[5] = CONF.MEDIA;
            log('INFO', 'AUTO', `Gate P-magnitude: ${match.team1} vs ${match.team2} → |P_ml(${(modelP*100).toFixed(1)}%) − P_ai(${(pAiImplied*100).toFixed(1)}%)| = ${(pDivergence*100).toFixed(1)}pp > 10pp → ALTA→MÉDIA`);
          } else if (confAtual === CONF.MEDIA && pDivergence > 0.15) {
            filteredTipResult[5] = CONF.BAIXA;
            log('INFO', 'AUTO', `Gate P-magnitude: ${match.team1} vs ${match.team2} → |ΔP| = ${(pDivergence*100).toFixed(1)}pp > 15pp → MÉDIA→BAIXA`);
          }
        }

        // EV determinístico: substitui o EV reportado pela IA por (modelP × odds − 1).
        // A IA continua escolhendo lado/confiança; o EV mostrado e salvo passa a ser o do modelo.
        // Isso evita números inflados tipo IA=42.5% quando modelo calcula +21%.
        if (filteredTipResult && Number.isFinite(modelEV)) {
          const _detSigned = modelEV >= 0 ? `+${modelEV.toFixed(1)}%` : `${modelEV.toFixed(1)}%`;
          if (Math.abs(modelEV - tipEV) >= 3) {
            log('INFO', 'EV-RECALC', `esports ${match.team1} vs ${match.team2}: IA=${tipEV.toFixed(1)}% → modelo=${modelEV.toFixed(1)}% (P=${(modelP*100).toFixed(1)}% @ ${tipOdd})`);
          }
          filteredTipResult[3] = _detSigned;
        }
      }

      // Gate 0: Sem odds reais → rejeitar sempre (odds estimadas não garantem valor)
      if (filteredTipResult && !hasRealOdds) {
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
      // Com dados suficientes (factorCount>=2, score>=3pp), divergência ML×IA é sinal forte.
      // Score >8pp: rejeita BAIXA, rebaixa ALTA/MÉDIA
      // Score 3-8pp: rebaixa um nível
      if (filteredTipResult && mlResult.direction && hasRealOdds && mlResult.factorCount >= 2 && mlResult.score >= 3) {
        const t1 = (match.team1 || '').toLowerCase();
        const tipTeamNorm = tipTeam.toLowerCase();
        const aiDirectionIsT1 = tipTeamNorm.includes(t1) || t1.includes(tipTeamNorm);
        const mlDirectionIsT1 = mlResult.direction === 't1';
        if (aiDirectionIsT1 !== mlDirectionIsT1) {
          const confAtual = getConf();
          if (mlResult.score > 8) {
            // ML fortemente em outra direção: BAIXA → rejeita, MÉDIA/ALTA → rebaixa
            if (confAtual === CONF.BAIXA) {
              log('INFO', 'AUTO', `Gate consenso forte: ${match.team1} vs ${match.team2} → ML(${mlResult.direction}) ≠ IA edge=${mlResult.score.toFixed(1)}pp → BAIXA rejeitada`);
              filteredTipResult = null;
            } else if (confAtual === CONF.ALTA) {
              filteredTipResult[5] = CONF.MEDIA;
              log('INFO', 'AUTO', `Gate consenso forte: ${match.team1} vs ${match.team2} → ML(${mlResult.direction}) ≠ IA → ALTA→MÉDIA`);
            } else {
              filteredTipResult[5] = CONF.BAIXA;
              log('INFO', 'AUTO', `Gate consenso forte: ${match.team1} vs ${match.team2} → ML(${mlResult.direction}) ≠ IA → MÉDIA→BAIXA`);
            }
          } else {
            // ML moderadamente divergente: rebaixa um nível
            if (confAtual === CONF.ALTA) {
              filteredTipResult[5] = CONF.MEDIA;
              log('INFO', 'AUTO', `Gate consenso: ${match.team1} vs ${match.team2} → ML(${mlResult.direction}) ≠ IA edge=${mlResult.score.toFixed(1)}pp → ALTA→MÉDIA`);
            } else if (confAtual === CONF.MEDIA) {
              filteredTipResult[5] = CONF.BAIXA;
              log('INFO', 'AUTO', `Gate consenso: ${match.team1} vs ${match.team2} → ML(${mlResult.direction}) ≠ IA → MÉDIA→BAIXA`);
            }
          }
        }
      }

      // Gate 3.5: sem dados ML (factorCount=0), bloqueia BAIXA e exige EV maior para MÉDIA
      // Razão: sem forma/H2H/comp, o EV reportado pela IA é circular (deriva do de-juice que já está no prompt)
      if (filteredTipResult && mlResult.factorCount === 0) {
        const confNow = getConf();
        if (confNow === CONF.BAIXA) {
          log('INFO', 'AUTO', `Gate sem-dados: ${match.team1} vs ${match.team2} → factorCount=0, conf BAIXA bloqueada (sem dados objetivos)`);
          filteredTipResult = null;
        } else if (confNow === CONF.MEDIA && tipEV < 8) {
          log('INFO', 'AUTO', `Gate sem-dados: ${match.team1} vs ${match.team2} → factorCount=0, conf MÉDIA exige EV≥8% (atual ${tipEV}%) → rejeitado`);
          filteredTipResult = null;
        }
      }

      // Gate 4: EV mínimo adaptativo por nível de confiança
      // ALTA: adaptiveEV (padrão) | MÉDIA: adaptiveEV-1.5% | BAIXA: adaptiveEV-3%
      if (filteredTipResult && hasRealOdds) {
        const confNow = getConf();
        const evOffset = confNow === CONF.ALTA ? 0 : confNow === CONF.MEDIA ? -1.5 : -3;
        // Mínimo absoluto de 3% — abaixo disso a margem da 1xBet já come o EV
        const confThreshold = Math.max(3.0, adaptiveEV + evOffset);
        if (!isNaN(tipEV) && tipEV < confThreshold) {
          log('INFO', 'AUTO', `Gate EV: ${match.team1} vs ${match.team2} → EV ${tipEV}% < threshold ${confThreshold.toFixed(1)}% [${confNow}] (${sigCount}/6 sinais) → rejeitado`);
          filteredTipResult = null;
        }
      }

      // Gate 4b: EV sanity — bloqueia EV absurdamente alto (erro de cálculo da IA)
      if (filteredTipResult && !isNaN(tipEV) && tipEV > 50) {
        log('WARN', 'AUTO', `Gate EV sanity: ${match.team1} vs ${match.team2} → EV ${tipEV}% > 50% (provável erro de cálculo da IA) → rejeitado`);
        filteredTipResult = null;
      }

      if (filteredTipResult) {
        const confFinal = getConf();
        const tierLabel = confFinal === CONF.ALTA ? '🟢 ALTA' : confFinal === CONF.MEDIA ? '🟡 MÉDIA' : '🔵 BAIXA';
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
      o: oddsToUse,
      mlScore: mlResult.score,
      modelP1: mlResult.modelP1,
      modelP2: mlResult.modelP2,
      mlDirection: mlResult.direction || null,
      factorActive: mlResult.factorActive || [],
      tipReason,
      debugVars: filteredTipResult ? (() => {
        const tipTeam = String(filteredTipResult[1] || '').trim();
        const tipOdd = parseFloat(filteredTipResult[2]);
        const tipEV = parseFloat(String(filteredTipResult[3]).replace('%','').replace('+',''));
        const tipStake = String(filteredTipResult[4] || '').trim();
        const tipConf = String(filteredTipResult[5] || CONF.MEDIA).trim().toUpperCase();
        return {
          source: 'ai',
          game,
          status: match.status,
          league: match.league,
          t1: match.team1,
          t2: match.team2,
          hasLiveStats,
          liveGameNumber,
          odds: { t1: oddsToUse?.t1, t2: oddsToUse?.t2, bookmaker: oddsToUse?.bookmaker, market: oddsToUse?.market, mapMarket: oddsToUse?.mapMarket },
          modelP1: mlResult.modelP1,
          modelP2: mlResult.modelP2,
          pick: { team: tipTeam, odd: tipOdd, evPct: Number.isFinite(tipEV) ? tipEV : null, stake: tipStake, conf: tipConf },
          ml: { pass: mlResult.pass, direction: mlResult.direction, edgePp: parseFloat(mlResult.score.toFixed(1)), factors: mlResult.factorActive || [], factorCount: mlResult.factorCount || 0 },
          signals: { sigCount, evThreshold: adaptiveEV },
          compScore,
          tipReason
        };
      })() : null
    };
  } catch(e) {
    log('ERROR', 'AUTO', `Error for ${match.team1} vs ${match.team2}: ${e.message}`);
    return null;
  }
}

// ── Próximas Partidas Handler (OLD — mantido apenas para referência interna) ──

// ── Esports Prompt Builder ──
// Teses de edge da literatura quant LoL (ex.: pipelines GRID + ensemble). Sem dados GRID aqui — IA só aplica se draft/DADOS AO VIVO suportarem.
const LOL_PROMPT_RESEARCH_HINTS = `TESES A CONSIDERAR (use só se draft ou "DADOS AO VIVO" derem base concreta; não invente números nem cite fontes):
• Ritmo early: path de jungle e prioridade de rio/córrego costumam definir quem impõe o primeiro arco do jogo.
• Objetivos majores: ouro líquido nem sempre reflete controle real de Baron/Elder — visão, ondas e quem força o play importam para fechar mapa ou virar série.
• Bo3/Bo5: mapa atual + draft da série e side — não reduza P() da série só ao snapshot de um mapa sem encadear o contexto da série.

`;

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
    enrichSection.includes('GRID ('),                     // GRID forma/H2H oficiais
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
    ? `REGRAS DE CONF (aplicar na LINHA 1):
• ALTA: EV ≥ +${evThreshold}% E ≥2 sinais checklist
• MÉDIA: EV ≥ +${evThresholdMedia}% E ≥1 sinal checklist
• BAIXA: EV ≥ +${evThresholdBaixa}% (sem sinal obrigatório)
• Se EV negativo nos dois lados → escreva literalmente SEM_TIP na linha 1
P = sua probabilidade (0-100). Consistência: EV = (P/100 × odd − 1) × 100`
    : `Sem odds reais disponíveis — escreva SEM_TIP na linha 1.`;

  const isTargetSeries = match.format && typeof match.format === 'string' && match.format.toLowerCase() !== 'bo1';
  const seriesWarning = (match.status === 'live' && isTargetSeries)
    ? `\n🚨 CRÍTICO: Partida em andamento (LIVE - Bo3/Bo5). As ODDS ML referem-se ao VENCEDOR DA SÉRIE COMPLETA (Match Winner), NÃO ao vencedor do mapa atual!\nSua estimativa P() deve refletir a chance de ganhar a SÉRIE (placar atual + draft). Se a chance da equipe virar/vencer a série inteira não gerar EV positivo, NÃO envie tip.`
    : '';

  const oddsTitle = (o && o.mapRequested)
    ? (o.mapMarket ? `Odds ML (Vencedor do MAPA ${o.mapRequested})` : `Odds ML (Vencedor do MAPA ${o.mapRequested} — estimada/sem mercado)`)
    : `Odds ML (Match Winner da SÉRIE)`;

  const text = `Você é um analista de apostas LoL especializado. FORMATO CRÍTICO: sua resposta DEVE começar na linha 1 com "TIP_ML:..." (ou "SEM_TIP"). Nenhum texto antes. A análise vem DEPOIS.

${LOL_PROMPT_RESEARCH_HINTS}
PARTIDA: ${t1} vs ${t2} | ${match.league || 'Esports'} | ${match.format || 'Bo1/Bo3'} | ${match.status}
Placar da Série: ${serieScore} | ${oddsSection.replace('Odds ML', oddsTitle)}${seriesWarning}
${bookMarginNote ? `\n⚠️ ${bookMarginNote}` : ''}
${gamesContext ? `\nDADOS AO VIVO (Mapa Atual):\n${gamesContext}` : ''}
${gamesContext && /META PRO \(champ WR\):|PLAYER CHAMP WR:/i.test(gamesContext)
  ? `\nDADOS PRO (gol.gg/PandaScore via DB) — COMO USAR:
• Se (n~) < 10: sinal fraco (não force tip).
• Se (n~) 10–29: sinal médio.
• Se (n~) ≥ 30: sinal forte.
• Use META PRO/PLAYER CHAMP WR como ajuste fino de draft, não como substituto de odds/EV.
`
  : ''}
FORMA/H2H:${enrichSection}
${highFluxWarning ? `\n${highFluxWarning}` : ''}${lineMovementWarning ? `\n${lineMovementWarning}` : ''}${newsSection ? `\n${newsSection}` : ''}

REGRAS OBRIGATÓRIAS (não negociáveis):
• ALTA (EV ≥ +${evThreshold}%): exige ≥2 sinais independentes do checklist confirmando
• MÉDIA (EV ≥ +${evThresholdMedia}%): exige ≥1 sinal do checklist confirmando
• BAIXA (EV ≥ +${evThresholdBaixa}%): sem sinal obrigatório — stake reduzido (1/10 Kelly, max 1.5u)
• Se EV negativo nos dois lados → sem tip.
• Dados ausentes = use o que está disponível; ausência não bloqueia análise.

ANÁLISE (responda cada ponto):
1. Draft/Série: Qual time ganha a série? (Se LIVE: avalie o draft do mapa atual e seu impacto na virada/conclusão da série inteira)
   → P(${t1})=__% | P(${t2})=__% | Justificativa: [1 frase objetiva]${modelP1pct ? `\n   [${fairOddsLabel}: ${t1}=${modelP1pct}% | ${t2}=${modelP2pct}% — para ter edge, sua P deve divergir claramente deste baseline]` : ''}
2. Edge quantitativo: ${deJuiced}
3. Sinais do checklist:
   [ ] Forma recente clara (≥60% winrate, diferença >15pp)
   [ ] H2H favorável (≥60% de vitórias no confronto direto)
   [ ] Draft/composição claramente superior
   [ ] Dados ao vivo confirmam (gold diff, objetivos)
   [ ] Leitura de objetivos (Baron/Elder/dragões) coerente com mapa/visão, não só ouro bruto
   [ ] Ritmo early (jungle/rio) alinhado com quem está na frente, se houver dados ao vivo
   [ ] Odds com movimento favorável (sharp money)
${hasRealOdds ? '' : '   Virada possível se: gold diff <3k, scaling comp no perdedor, soul point ou baron pendente.\n'}
${tipInstruction}

RESPOSTA OBRIGATÓRIA — siga exatamente esta ordem:
LINHA 1 (primeira linha, SEM texto antes): TIP_ML:[time]@[odd]|P:[X%]|STAKE:[1-3]u|CONF:[ALTA/MÉDIA/BAIXA]
        (Só forneça P — sua probabilidade estimada 0-100. O sistema calcula EV automaticamente como (P/100 × odd − 1) × 100.)
        (ou apenas "SEM_TIP" se EV negativo nos dois lados)
LINHA 2+ (máx 150 palavras): P(${t1})=__% | P(${t2})=__% | ${hasRealOdds ? `EV(${t1})=[X%] | EV(${t2})=[X%]` : `Conf:[ALTA/MÉDIA/BAIXA]`} | Sinais:[N/8] | ConfPré:[${sigCount}/6]
+ justificativa curta (draft, forma, H2H, movimento de linha).`;

  return { text, evThreshold, sigCount };
}

// ── Admin ──
async function handleAdmin(token, chatId, command, callerSport = 'esports') {
  if (!ADMIN_IDS.has(String(chatId))) {
    await send(token, chatId, '❌ Comando restrito a administradores.');
    return;
  }

  const parts = command.trim().split(/\s+/);
  const cmd = parts[0];
  // Argumento explícito do comando (ex: /stats darts) tem prioridade sobre o bot que recebeu
  const sport = parts[1] || callerSport;
  
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
    if (sport === 'esports' || sport === 'all') { analyzedMatches.clear(); analyzedDota.clear(); cleared.esports = true; }
    if (sport === 'mma'     || sport === 'all') { analyzedMma.clear();     cleared.mma = true; }
    if (sport === 'tennis'  || sport === 'all') { analyzedTennis.clear();  cleared.tennis = true; }
    if (sport === 'football'|| sport === 'all') { analyzedFootball.clear(); cleared.football = true; }
    if (sport === 'darts'   || sport === 'all') { analyzedDarts.clear();   cleared.darts = true; }
    if (sport === 'snooker' || sport === 'all') { analyzedSnooker.clear(); cleared.snooker = true; }
    if (sport === 'tabletennis' || sport === 'all') { analyzedTT.clear(); cleared.tabletennis = true; }
    if (sport === 'cs'      || sport === 'all') { analyzedCs.clear();    cleared.cs = true; }
    if (sport === 'valorant'|| sport === 'all') { analyzedValorant.clear(); cleared.valorant = true; }
    const clearedList = Object.keys(cleared).join(', ') || sport;
    await send(token, chatId,
      `🔄 *Reanálise ativada*\n\nMemória de análises limpa para: *${clearedList}*\n` +
      `As tips em andamento serão reavaliadas no próximo ciclo de análise automática.`
    );

  } else if (cmd === '/shadow') {
    if (!ADMIN_IDS.has(String(chatId))) { await send(token, chatId, '❌ Admin only.'); return; }
    // Argumento opcional: /shadow darts | /shadow snooker → default 'darts'
    const parts = String(text || '').trim().split(/\s+/);
    const sportArg = parts[1]?.toLowerCase() || 'darts';
    try {
      const data = await serverGet(`/shadow-tips?sport=${encodeURIComponent(sportArg)}&limit=100`);
      if (data?.error) { await send(token, chatId, `❌ ${data.error}`); return; }
      const s = data.summary || {};
      let txt = `🕶️ *SHADOW TIPS — ${sportArg.toUpperCase()}*\n\n`;
      txt += `Total: *${s.total || 0}*\n`;
      txt += `✅ W: ${s.wins || 0} | ❌ L: ${s.losses || 0} | ⚪ Void: ${s.voids || 0} | ⏳ Pend: ${s.pending || 0}\n`;
      if (s.winRate != null) txt += `Win rate: *${s.winRate}%*\n`;
      if (s.avgClvPct != null) txt += `CLV médio: *${s.avgClvPct > 0 ? '+' : ''}${s.avgClvPct}%* (n=${s.clvSamples})\n`;
      txt += `\n_Critério de graduação sugerido: ≥30 tips, CLV médio positivo, WR calibrado._\n`;
      txt += `_Desligar shadow: env ${sportArg.toUpperCase()}_SHADOW=false + restart._`;
      // Últimas 5 tips pra visão rápida
      const recent = (data.tips || []).slice(0, 5);
      if (recent.length) {
        txt += `\n\n*Últimas 5:*\n`;
        recent.forEach(r => {
          const emoji = r.result === 'win' ? '✅' : r.result === 'loss' ? '❌' : r.result === 'void' ? '⚪' : '⏳';
          txt += `${emoji} ${r.tip_participant} @ ${r.odds} | EV:${r.ev}% | ${String(r.sent_at || '').slice(0, 10)}\n`;
        });
      }
      await send(token, chatId, txt);
    } catch(e) { await send(token, chatId, `❌ ${e.message}`); }

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

    if (sport === 'tabletennis') {
      const matches = await serverGet('/tabletennis-matches').catch(() => []);
      const all = Array.isArray(matches) ? matches : [];
      if (!all.length) {
        await send(token, chatId,
          '❌ Nenhuma partida de tênis de mesa encontrada.\n_Tente novamente mais tarde._',
          getMenu(sport));
        return;
      }
      let txt = `🏓 *PRÓXIMAS PARTIDAS TÊNIS DE MESA*\n━━━━━━━━━━━━━━━━\n\n`;
      let lastLeague = '';
      all.slice(0, 15).forEach(m => {
        if (m.league !== lastLeague) {
          txt += `\n📋 *${m.league}*\n`;
          lastLeague = m.league;
        }
        const liveTag = m.status === 'live' ? ' 🔴' : '';
        txt += `🏓${liveTag} *${m.team1}* vs *${m.team2}*\n`;
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

    if (sport === 'cs') {
      const matches = await serverGet('/cs-matches').catch(() => []);
      const all = Array.isArray(matches) ? matches : [];
      if (!all.length) {
        await send(token, chatId,
          '❌ Nenhuma partida de CS2 encontrada.\n_Tente novamente mais tarde._',
          getMenu(sport));
        return;
      }
      let txt = `🔫 *PRÓXIMAS PARTIDAS CS2*\n━━━━━━━━━━━━━━━━\n\n`;
      let lastLeague = '';
      all.slice(0, 15).forEach(m => {
        if (m.league !== lastLeague) {
          txt += `\n📋 *${m.league}*\n`;
          lastLeague = m.league;
        }
        const liveTag = m.status === 'live' ? ' 🔴' : '';
        const fmt = m.format ? ` (${m.format})` : '';
        txt += `🔫${liveTag} *${m.team1}* vs *${m.team2}*${fmt}\n`;
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

    if (sport === 'valorant') {
      const matches = await serverGet('/valorant-matches').catch(() => []);
      const all = Array.isArray(matches) ? matches : [];
      if (!all.length) {
        await send(token, chatId,
          '❌ Nenhuma partida de Valorant encontrada.\n_Tente novamente mais tarde._',
          getMenu(sport));
        return;
      }
      let txt = `🎯 *PRÓXIMAS PARTIDAS VALORANT*\n━━━━━━━━━━━━━━━━\n\n`;
      let lastLeague = '';
      all.slice(0, 15).forEach(m => {
        if (m.league !== lastLeague) {
          txt += `\n📋 *${m.league}*\n`;
          lastLeague = m.league;
        }
        const liveTag = m.status === 'live' ? ' 🔴' : '';
        const fmt = m.format ? ` (${m.format})` : '';
        txt += `🎯${liveTag} *${m.team1}* vs *${m.team2}*${fmt}\n`;
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

    if (sport === 'darts' || sport === 'snooker') {
      const endpoint = sport === 'darts' ? '/darts-matches' : '/snooker-matches';
      const emoji = sport === 'darts' ? '🎯' : '🎱';
      const title = sport === 'darts' ? 'PRÓXIMAS DARTS' : 'PRÓXIMAS SNOOKER';
      const matches = await serverGet(endpoint).catch(() => []);
      const all = Array.isArray(matches) ? matches : [];
      if (!all.length) {
        await send(token, chatId,
          `❌ Nenhuma partida de ${sport} encontrada.\n_Tente novamente mais tarde._`,
          getMenu(sport));
        return;
      }
      let txt = `${emoji} *${title}*\n━━━━━━━━━━━━━━━━\n\n`;
      all.slice(0, 12).forEach(m => {
        const liveTag = m.status === 'live' ? ' 🔴' : '';
        txt += `${emoji} [${m.league}]${liveTag} *${m.team1}* vs *${m.team2}*\n`;
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

    // Dota 2 — bot esports também cobre Dota 2 (mesma infra)
    try {
      const dotaMatches = await serverGet('/dota-matches').catch(() => []);
      const dotaAll = Array.isArray(dotaMatches) ? dotaMatches : [];
      if (dotaAll.length) {
        const dotaLive = dotaAll.filter(m => m.status === 'live');
        const dotaUp   = dotaAll.filter(m => m.status !== 'live');
        txt += `\n\n🕹️ *PARTIDAS DOTA 2*\n━━━━━━━━━━━━━━━━\n`;
        if (dotaLive.length) {
          txt += `\n🔴 *AO VIVO (${dotaLive.length})*\n`;
          dotaLive.slice(0, 5).forEach(m => {
            const league = m.league ? `[${m.league}]` : '';
            txt += `🕹️ ${league} *${m.team1}* vs *${m.team2}*`;
            if (m.score1 !== undefined || m.score2 !== undefined) txt += ` (${m.score1 ?? 0}-${m.score2 ?? 0})`;
            if (m.format) txt += ` _${m.format}_`;
            txt += '\n';
            if (m.odds?.t1 && m.odds?.t2) txt += `  💰 ${m.team1}: \`${m.odds.t1}\` | ${m.team2}: \`${m.odds.t2}\`\n`;
          });
        }
        if (dotaUp.length) {
          txt += `\n📅 *PRÓXIMAS (${dotaUp.length})*\n`;
          dotaUp.slice(0, 8).forEach(m => {
            const league = m.league ? `[${m.league}]` : '';
            txt += `🕹️ ${league} *${m.team1}* vs *${m.team2}*`;
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
            if (m.odds?.t1 && m.odds?.t2) txt += `  💰 ${m.team1}: \`${m.odds.t1}\` | ${m.team2}: \`${m.odds.t2}\`\n`;
            else txt += `  _Sem odds ainda_\n`;
          });
        }
      }
    } catch(_) {}

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
// Usa modelo logístico calibrado para o tênis (chance real, suavizada): log(r2/r1)
function rankingToEnrich(rankStr1, rankStr2, surface = 'dura') {
  function parseRank(str) {
    if (!str) return null;
    const m = (str || '').match(/^#(\d+)/);
    return m ? parseInt(m[1]) : null;
  }
  const r1 = parseRank(rankStr1), r2 = parseRank(rankStr2);
  if (r1 === null && r2 === null) return null;

  const base1 = r1 || 800, base2 = r2 || 800; // Penaliza mais a falta de rank no tênis
  
  // Tênis usa modelo logístico: diff = log2(base2/base1). Cap em ±3.5 (~70% favorito max limit para prevenir overconfidence extrema)
  const diff = Math.max(-3.5, Math.min(3.5, Math.log2(base2 / base1)));
  
  // Ajuste por superfície: reduz o peso do ranking puro no saibro e grama onde especialistas brilham mais
  const multiplier = surface === 'saibro' ? 0.75 : surface === 'grama' ? 0.85 : 1.0;
  
  // P1 base score (0.5 = 50%) => scale: diff 1 = +4%, cap 70%
  const p1 = 0.5 + (diff * multiplier * 0.055);
  const wr1 = Math.max(10, Math.min(90, Math.round(p1 * 100)));
  const wr2 = 100 - wr1;
  
  // wins/losses sintéticos — para calibração do balanceamento H2H
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

    const endpoint = sport === 'mma' ? '/mma-matches'
      : sport === 'tennis' ? '/tennis-matches'
      : sport === 'football' ? '/football-matches'
      : sport === 'darts' ? '/darts-matches'
      : sport === 'snooker' ? '/snooker-matches'
      : sport === 'tabletennis' ? '/tabletennis-matches'
      : '/lol-matches';
    const matches = await serverGet(endpoint).catch(() => []);
    const all = Array.isArray(matches) ? matches : [];

    const withOdds = sport === 'football' || sport === 'mma' || sport === 'tennis' || sport === 'darts' || sport === 'snooker' || sport === 'tabletennis'
      ? all.filter(m => m.odds)
      : all.filter(m => m.odds?.t1 && m.odds?.t2); // LoL: todas com odds (live, draft e upcoming)

    if (!withOdds.length) {
      await send(token, chatId,
        `❌ *Nenhuma partida de ${sport} com odds disponíveis.*\n\n_Tente novamente mais tarde._`,
        getMenu(sport));
      return;
    }

    const titleMap = { mma: 'MMA', tennis: 'TÊNIS', football: 'FUTEBOL', darts: 'DARTS', snooker: 'SNOOKER', tabletennis: 'TÊNIS DE MESA' };
    const title = `⚖️ *FAIR ODDS — ${titleMap[sport] || 'AO VIVO'}*`;
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

                const [w1, w2] = await Promise.all([
                  !rec1 ? fetchWikipediaFighterRecord(m.team1).catch(() => null) : Promise.resolve(null),
                  !rec2 ? fetchWikipediaFighterRecord(m.team2).catch(() => null) : Promise.resolve(null)
                ]);
                if (w1) rec1 = w1;
                if (w2) rec2 = w2;

                const [s1, s2] = await Promise.all([
                  !rec1 ? fetchSherdogFighterRecord(m.team1).catch(() => null) : Promise.resolve(null),
                  !rec2 ? fetchSherdogFighterRecord(m.team2).catch(() => null) : Promise.resolve(null)
                ]);
                if (s1) rec1 = s1;
                if (s2) rec2 = s2;

                const [t1, t2] = await Promise.all([
                  !rec1 ? fetchTapologyFighterRecord(m.team1).catch(() => null) : Promise.resolve(null),
                  !rec2 ? fetchTapologyFighterRecord(m.team2).catch(() => null) : Promise.resolve(null)
                ]);
                if (t1) rec1 = t1;
                if (t2) rec2 = t2;
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
                     text.startsWith('/health') || text.startsWith('/debug') ||
                     text.startsWith('/shadow')) {
            // Passa `sport` da poll (qual bot recebeu) para evitar default 'esports'
            await handleAdmin(token, chatId, text, sport);
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
                const [roi, history, marketRows, leagueRoi] = await Promise.all([
                  serverGet('/roi', s),
                  serverGet('/tips-history?limit=10&filter=settled', s).catch(() => []),
                  serverGet('/roi-by-market', s).catch(() => []),
                  serverGet(`/league-roi?sport=${encodeURIComponent(s)}&min=5`, s).catch(() => ({ leagues: [] })),
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
                  const leagues = Array.isArray(leagueRoi?.leagues) ? leagueRoi.leagues : [];
                  if (leagues.length > 1) {
                    // Top 5 por profit absoluto + bottom 3 (perdedoras)
                    const sorted = [...leagues].sort((a, b) => (b.profit || 0) - (a.profit || 0));
                    const top = sorted.slice(0, 5);
                    const bottom = sorted.slice(-3).reverse().filter(l => !top.includes(l));
                    txt += `\n🏆 *Por campeonato (≥5 tips):*\n`;
                    for (const lg of top) {
                      const roiEm = lg.roi > 5 ? '🟢' : lg.roi < -5 ? '🔴' : '🟡';
                      const name = String(lg.league || '').slice(0, 30);
                      txt += `${roiEm} ${name}: ${lg.wins}-${lg.losses} | ROI: ${lg.roi > 0 ? '+' : ''}${lg.roi}%\n`;
                    }
                    if (bottom.length) {
                      txt += `\n⚠️ *Perdedoras:*\n`;
                      for (const lg of bottom) {
                        const name = String(lg.league || '').slice(0, 30);
                        txt += `🔴 ${name}: ${lg.wins}-${lg.losses} | ROI: ${lg.roi}%\n`;
                      }
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

// ── ESPN Tennis data (via lib/tennis-data) ──
const tennisData = require('./lib/tennis-data');

let espnTennisCache = { atp: [], wta: [], ts: 0 };
const ESPN_TENNIS_TTL = 3 * 60 * 60 * 1000; // 3h

async function fetchEspnTennisRankings() {
  if (Date.now() - espnTennisCache.ts < ESPN_TENNIS_TTL) return espnTennisCache;
  try {
    const [atp, wta] = await Promise.all([
      tennisData.getRankings('atp', 250).catch(() => []),
      tennisData.getRankings('wta', 250).catch(() => [])
    ]);
    espnTennisCache = { atp, wta, ts: Date.now() };
    log('INFO', 'ESPN-TENNIS', `Rankings: ATP ${atp.length} | WTA ${wta.length}`);
  } catch(e) {
    log('WARN', 'ESPN-TENNIS', `Falha rankings: ${e.message}`);
  }
  return espnTennisCache;
}

async function fetchEspnTennisEvent(tour) {
  try {
    const slug = tour === 'WTA' ? 'wta' : 'atp';
    const j = await tennisData.getScoreboard(slug).catch(() => null);
    const events = Array.isArray(j?.events) ? j.events : [];
    if (!events.length) return null;

    const recentResults = [];
    const scheduledMatches = [];
    for (const ev of events) {
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
            recentResults.push({ p1: c1, p2: c2, winner, score, date: comp.date || '', eventName: ev.name || '' });
          } else if (state === 'pre' || state === 'in') {
            scheduledMatches.push({ p1: c1, p2: c2, court: comp.venue?.court, date: comp.date });
          }
        }
      }
    }
    const ev0 = events[0];
    const name0 = String(ev0?.name || '');
    return {
      eventName: events.map(e => e.name).filter(Boolean).join(' | ') || name0,
      surface: name0.toLowerCase().includes('monte') || name0.toLowerCase().includes('clay') ? 'saibro'
        : name0.toLowerCase().includes('wimbledon') || name0.toLowerCase().includes('halle') || name0.toLowerCase().includes('queen') ? 'grama'
        : 'dura',
      recentResults: recentResults.slice(-80),
      scheduledMatches
    };
  } catch(_) {
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

function _espnMmaYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function _espnMmaSlugPair(f) {
  const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const a = slug(f.name1);
  const b = slug(f.name2);
  return a && b ? (a < b ? `${a}|${b}` : `${b}|${a}`) : '';
}

function parseEspnMmaScoreboardJson(json) {
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
  return fights;
}

function _httpsEspnScoreboardGet(path) {
  return new Promise((resolve, reject) => {
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
    req.setTimeout(12000, () => req.destroy(new Error('ESPN timeout')));
    req.end();
  });
}

async function fetchEspnMmaFights() {
  if (Date.now() - espnMmaCache.ts < ESPN_MMA_TTL && espnMmaCache.data.length) return espnMmaCache.data;
  try {
    const futureWeeks = Math.max(1, Math.min(18, parseInt(process.env.MMA_ESPN_SCOREBOARD_WEEKS || '12', 10) || 12));
    const pastWeeks   = Math.max(1, Math.min(26, parseInt(process.env.MMA_ESPN_PAST_WEEKS || '13', 10) || 13));
    const base = new Date();
    base.setHours(0, 0, 0, 0);

    const addWindows = (prefix, start, count, dir) => {
      const out = [];
      for (let w = 0; w < count; w++) {
        const a = new Date(start);
        a.setDate(a.getDate() + dir * w * 7);
        const b = new Date(a);
        b.setDate(b.getDate() + dir * 6);
        const [from, to] = dir >= 0 ? [a, b] : [b, a];
        out.push(`${prefix}?dates=${_espnMmaYmd(from)}-${_espnMmaYmd(to)}`);
      }
      return out;
    };

    const paths = [
      '/apis/site/v2/sports/mma/ufc/scoreboard',
      '/apis/site/v2/sports/boxing/scoreboard',
      ...addWindows('/apis/site/v2/sports/mma/ufc/scoreboard',     base, futureWeeks,  1),
      ...addWindows('/apis/site/v2/sports/boxing/scoreboard',      base, futureWeeks,  1),
      ...addWindows('/apis/site/v2/sports/mma/ufc/scoreboard',     base, pastWeeks,   -1),
      ...addWindows('/apis/site/v2/sports/boxing/scoreboard',      base, pastWeeks,   -1),
    ];

    const results = await Promise.all(paths.map(p => _httpsEspnScoreboardGet(p).catch(() => ({ status: 0, body: '{}' }))));
    const merged = new Map();
    for (const r of results) {
      if (r.status !== 200) continue;
      const json = safeParse(r.body, {});
      for (const f of parseEspnMmaScoreboardJson(json)) {
        const key = _espnMmaSlugPair(f);
        if (key && !merged.has(key)) merged.set(key, f);
      }
    }

    const fights = [...merged.values()];
    espnMmaCache = { data: fights, ts: Date.now() };
    log('INFO', 'ESPN-MMA', `${fights.length} lutas carregadas da ESPN (${paths.length} janelas: ${futureWeeks}f+${pastWeeks}p semanas, UFC+Boxe)`);
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

function _normalizeWld(rec) {
  const s = String(rec || '').trim();
  if (!s) return null;
  const m = s.match(/\b(\d{1,3})\s*[-–]\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b/);
  if (!m) return null;
  const w = parseInt(m[1], 10) || 0;
  const l = parseInt(m[2], 10) || 0;
  const d = m[3] != null ? (parseInt(m[3], 10) || 0) : 0;
  if (w + l + d <= 0) return null;
  if (w + l + d > 120) return null;
  return `${w}-${l}-${d}`;
}

async function fetchSherdogFighterRecord(name) {
  const cacheKey = `sh_${normName(name)}`;
  const cached = espnFighterCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ESPN_FIGHTER_TTL) return cached.record;
  const cache = rec => { espnFighterCache.set(cacheKey, { record: rec, ts: Date.now() }); return rec; };

  try {
    const searchUrl = `https://www.sherdog.com/stats/fightfinder?SearchTxt=${encodeURIComponent(name.trim())}`;
    const r1 = await cachedHttpGet(searchUrl, { ttlMs: ESPN_FIGHTER_TTL, provider: 'sherdog' }).catch(() => null);
    if (!r1 || r1.status !== 200 || !r1.body) return cache(null);

    const body1 = String(r1.body || '');
    const m = body1.match(/href="(\/fighter\/[^"]+)"/i);
    if (!m) return cache(null);
    const fighterPath = m[1];

    const profileUrl = `https://www.sherdog.com${fighterPath}`;
    const r2 = await cachedHttpGet(profileUrl, { ttlMs: ESPN_FIGHTER_TTL, provider: 'sherdog' }).catch(() => null);
    if (!r2 || r2.status !== 200 || !r2.body) return cache(null);

    const body2 = String(r2.body || '');
    const recRaw = body2.match(/class="record"\s*>\s*([\d]{1,3}\s*[-–]\s*[\d]{1,2}(?:\s*[-–]\s*[\d]{1,2})?)\s*</i)?.[1];
    return cache(_normalizeWld(recRaw));
  } catch (_) {
    return cache(null);
  }
}

async function fetchTapologyFighterRecord(name) {
  const cacheKey = `tp_${normName(name)}`;
  const cached = espnFighterCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ESPN_FIGHTER_TTL) return cached.record;
  const cache = rec => { espnFighterCache.set(cacheKey, { record: rec, ts: Date.now() }); return rec; };

  try {
    const searchUrl = `https://www.tapology.com/search?term=${encodeURIComponent(name.trim())}`;
    const r1 = await cachedHttpGet(searchUrl, {
      ttlMs: ESPN_FIGHTER_TTL,
      provider: 'tapology',
      headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }).catch(() => null);
    if (!r1 || r1.status !== 200 || !r1.body) return cache(null);

    const body1 = String(r1.body || '');
    const m = body1.match(/href="(\/fightcenter\/fighters\/[^"]+)"/i);
    if (!m) return cache(null);
    const fighterPath = m[1];

    const profileUrl = `https://www.tapology.com${fighterPath}`;
    const r2 = await cachedHttpGet(profileUrl, {
      ttlMs: ESPN_FIGHTER_TTL,
      provider: 'tapology',
      headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }).catch(() => null);
    if (!r2 || r2.status !== 200 || !r2.body) return cache(null);

    const body2 = String(r2.body || '');
    const idx = body2.search(/Pro\s*Record|Record/i);
    const window = idx >= 0 ? body2.slice(Math.max(0, idx - 500), idx + 1500) : body2.slice(0, 2500);
    const recRaw = window.match(/\b(\d{1,3})-(\d{1,2})-(\d{1,2})\b/)?.[0]
      || window.match(/\b(\d{1,3})-(\d{1,2})\b/)?.[0];
    return cache(_normalizeWld(recRaw));
  } catch (_) {
    return cache(null);
  }
}

/** GET site.api.espn.com (path completo incluindo query). */
function espnGet(path) {
  return new Promise((resolve, reject) => {
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
    req.setTimeout(12000, () => req.destroy(new Error('ESPN timeout')));
    req.end();
  });
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

/** ESPN vs feed de odds: nomes completos vs apelidos (ex.: Paulo Henrique Costa vs Paulo Costa). */
function fighterNamesMatch(espnSideName, oddsSideName) {
  const e = normName(espnSideName), o = normName(oddsSideName);
  if (!e || !o) return false;
  if (e === o) return true;
  if (e.includes(o) || o.includes(e)) return true;
  const tokens = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().split(/\s+/).filter(Boolean);
  const te = tokens(espnSideName), to = tokens(oddsSideName);
  if (!te.length || !to.length) return false;
  const le = te[te.length - 1], lo = to[to.length - 1];
  if (le && lo && le === lo && (te[0]?.[0] || '') === (to[0]?.[0] || '')) return true;
  return false;
}

function findEspnFight(espnFights, team1, team2) {
  return espnFights.find(f => {
    const fwd = fighterNamesMatch(f.name1, team1) && fighterNamesMatch(f.name2, team2);
    const rev = fighterNamesMatch(f.name1, team2) && fighterNamesMatch(f.name2, team1);
    return fwd || rev;
  }) || null;
}

// ── Dota 2 Auto-analysis ──
let _pollDotaRunning = false;
async function pollDota(runOnce = false) {
  if (_pollDotaRunning) { log('DEBUG', 'AUTO-DOTA', 'Já em execução (mutex), pulando ciclo'); return; }
  _pollDotaRunning = true;
  try { await _pollDotaInner(runOnce); } finally { _pollDotaRunning = false; }
}
async function _pollDotaInner(runOnce = false) {
  const esportsConfig = SPORTS['esports'];
  if (!esportsConfig?.enabled || !esportsConfig?.token) return;
  const token = esportsConfig.token;
  const DOTA_INTERVAL = 4 * 60 * 60 * 1000;
  // Cooldown live adaptativo: 90s quando temos Steam RT (delay ~15s) ou stats live frescas;
  // 3min quando só OpenDota (delay nativo 3min — não vale re-analisar antes).
  const DOTA_LIVE_COOLDOWN_FAST = 90 * 1000;
  const DOTA_LIVE_COOLDOWN_SLOW = 3 * 60 * 1000;
  const _dotaHasSteamRT = !!process.env.STEAM_WEBAPI_KEY;
  const DOTA_LIVE_COOLDOWN = _dotaHasSteamRT ? DOTA_LIVE_COOLDOWN_FAST : DOTA_LIVE_COOLDOWN_SLOW;
  let _hasLiveDota = false;

  try {
    log('INFO', 'AUTO-DOTA', 'Iniciando verificação de partidas Dota 2...');
    const matches = await serverGet('/dota-matches').catch(() => []);
    if (!Array.isArray(matches) || !matches.length) {
      log('INFO', 'AUTO-DOTA', 'Sem partidas Dota 2 disponíveis');
      // não return — precisa chegar ao setTimeout no final
    } else {

    const now = Date.now();
    const liveCount = matches.filter(m => m.status === 'live').length;
    log('INFO', 'AUTO-DOTA', `${matches.length} partidas (${liveCount} live, ${matches.length - liveCount} upcoming)`);

    // Prioridade: live primeiro, depois upcoming por horário asc
    matches.sort((a, b) => {
      const la = a.status === 'live' ? 0 : 1;
      const lb = b.status === 'live' ? 0 : 1;
      if (la !== lb) return la - lb;
      return new Date(a.time || 0) - new Date(b.time || 0);
    });

    const _hasLive = matches.some(m => m.status === 'live');
    _hasLiveDota = _hasLive;
    if (_hasLive) _livePhaseEnter('dota');
    let _drained = false;

    for (const match of matches) {
      // Gate global: antes do primeiro upcoming, espera outros esportes terminarem live
      if (match.status !== 'live' && !_drained) {
        if (_hasLive) _livePhaseExit('dota');
        await _waitOthersLiveDone('dota');
        _drained = true;
      }
      const isLive = match.status === 'live';

      // ── Dedup / cooldown ──
      // Dedup primário: por matchId + score (permite re-análise por mapa em live)
      // Dedup secundário: por nomes normalizados (impede duplicata quando matchId muda entre fontes)
      // Dedup terciário: pair sem serieKey — bloqueia duplicata pre→live na mesma série (até 12h)
      const serieKey = isLive ? `_${match.score1||0}x${match.score2||0}` : '';
      const key = `dota2_${match.id}${serieKey}`;
      const pairKey = `dota2_pair_${norm(match.team1)}_${norm(match.team2)}${serieKey}`;
      const pairKeyBase = `dota2_pair_${norm(match.team1)}_${norm(match.team2)}`;
      const setDotaAnalyzed = (val) => {
        analyzedDota.set(key, val);
        analyzedDota.set(pairKey, val);
        // Só marca pairKeyBase quando tipSent=true — evita bloquear análise de outros mapas
        if (val?.tipSent) analyzedDota.set(pairKeyBase, val);
      };
      // Bloqueia duplicata pre→live ou re-cadastro com novo event ID no começo.
      // Permite tips em mapas diferentes do Bo3/Bo5 (score já avançou).
      const prevBase = analyzedDota.get(pairKeyBase);
      const isStartOfSerie = !isLive || ((match.score1 || 0) === 0 && (match.score2 || 0) === 0);
      if (isStartOfSerie && prevBase?.tipSent && (now - prevBase.ts) < 12 * 60 * 60 * 1000) {
        log('DEBUG', 'AUTO-DOTA', `Skip ${match.team1} vs ${match.team2} (${match.status}): tip já enviada no início dessa série (${Math.round((now-prevBase.ts)/60000)}min atrás)`);
        continue;
      }
      const prev = analyzedDota.get(key) || analyzedDota.get(pairKey);
      if (prev?.tipSent) continue;
      const cooldown = isLive ? DOTA_LIVE_COOLDOWN : DOTA_INTERVAL;
      if (prev && (now - prev.ts < cooldown)) continue;

      // ── Filtro de data (só upcoming; ao vivo passa sempre) ──
      if (!isLive) {
        const matchTs = match.time ? new Date(match.time).getTime() : 0;
        if (!matchTs || matchTs < now || matchTs > now + 7 * 24 * 60 * 60 * 1000) continue;
      }

      // ── Odds: ao vivo, infere mapa pelo placar e pede odds do MAPA específico via Pinnacle
      //   (Pinnacle period=N) ou SX.Bet. Pré-jogo usa odds da série.
      let o = (!isLive && match.odds?.t1) ? match.odds : null;
      let dotaMapNum = null;
      if (isLive && Number.isFinite(match.score1) && Number.isFinite(match.score2)) {
        const inferred = (match.score1 || 0) + (match.score2 || 0) + 1;
        if (inferred >= 1 && inferred <= 5) {
          dotaMapNum = inferred;
          log('DEBUG', 'AUTO-DOTA', `Mapa inferido pelo placar ${match.score1}-${match.score2} → mapa ${inferred}: ${match.team1} vs ${match.team2}`);
        }
      }
      if (!o?.t1 || !o?.t2) {
        const liveFlag = isLive ? '&live=1' : '';
        const mapFlag = dotaMapNum ? `&map=${dotaMapNum}` : '';
        o = await serverGet(`/odds?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}&game=dota2${liveFlag}${mapFlag}`).catch(() => null);
      }
      if (!o?.t1 || !o?.t2) {
        log('DEBUG', 'AUTO-DOTA', `Sem odds ${isLive ? 'ao vivo' : ''}${dotaMapNum ? ` (mapa ${dotaMapNum})` : ''}: ${match.team1} vs ${match.team2}`);
        setDotaAnalyzed({ ts: now, tipSent: false, noEdge: true });
        continue;
      }
      if (!isOddsFresh(o, isLive)) {
        log('INFO', 'AUTO-DOTA', `Odds stale (${oddsAgeStr(o)}): ${match.team1} vs ${match.team2} — pulando`);
        continue;
      }
      logOddsHistory('dota2', match.id, match.team1, match.team2, o);

      // ── Forma + H2H ──
      const [form1, form2, h2h] = await Promise.all([
        serverGet(`/team-form?team=${encodeURIComponent(match.team1)}&game=dota2`).catch(() => null),
        serverGet(`/team-form?team=${encodeURIComponent(match.team2)}&game=dota2`).catch(() => null),
        serverGet(`/h2h?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}&game=dota2`).catch(() => null)
      ]);

      const enrich = {
        form1: form1?.winRate != null ? { winRate: form1.winRate / 100, recent: form1.recent || [] } : null,
        form2: form2?.winRate != null ? { winRate: form2.winRate / 100, recent: form2.recent || [] } : null,
        h2h: h2h?.totalMatches > 0 ? { t1Wins: h2h.t1Wins, t2Wins: h2h.t2Wins, total: h2h.totalMatches } : null,
        oddsMovement: null
      };

      // ── Live stats (OpenDota + PandaScore em paralelo) ──
      // Lanca as duas fontes simultaneamente e usa a primeira que retornar hasLiveStats=true
      // (prioridade: OpenDota quando disponivel). Antes era sequencial → timeout OpenDota
      // bloqueava PandaScore por 10-30s.
      let dotaLiveContext = '';
      let dotaHasLiveStats = false;
      if (isLive) {
        const g = (v) => v >= 1000 ? (v/1000).toFixed(1)+'k' : String(v||0);
        const fmtTeam = (team) => (team.players||[]).map(p =>
          `  ${(p.hero||'?').padEnd(14)} ${(p.name||'?').slice(0,12).padEnd(12)} ${p.kills}/${p.deaths}/${p.assists} lvl${p.level} ${g(p.gold)}g`
        ).join('\n');

        const isPsMatch = String(match.id).startsWith('ps_');
        const [odRes, psRes] = await Promise.allSettled([
          serverGet(`/opendota-live?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}`),
          isPsMatch
            ? serverGet(`/ps-dota-live?matchId=${encodeURIComponent(match.id)}`)
            : Promise.resolve(null),
        ]);

        const od = odRes.status === 'fulfilled' ? odRes.value : null;
        const ps = psRes.status === 'fulfilled' ? psRes.value : null;
        if (odRes.status === 'rejected') log('WARN', 'AUTO-DOTA', `OpenDota fetch falhou: ${odRes.reason?.message || odRes.reason}`);
        if (isPsMatch && psRes.status === 'rejected') log('WARN', 'AUTO-DOTA', `PS live fetch falhou: ${psRes.reason?.message || psRes.reason}`);

        // Mede staleness: Steam RT tem delay ~15s; OpenDota agg ~3min nativo.
        // Se source = opendota-only e gameTime > 5min, dado pode estar muito velho.
        const sourceIsRT = String(od?._source || '').includes('steam-rt');
        const ageHint = sourceIsRT ? '~15s' : (od?.hasPlayerStats ? '~30s' : '~3min anti-cheat');
        log('INFO', 'LIVE-STATS', `Dota OpenDota ${match.team1} vs ${match.team2}: hasLiveStats=${!!od?.hasLiveStats} playerStats=${!!od?.hasPlayerStats} agg=${!!od?.hasAggregateStats} source=${od?._source || '?'} delayEst=${ageHint}${od?.error?` err=${od.error}`:''}`);
        if (isPsMatch) log('INFO', 'LIVE-STATS', `Dota PandaScore ${match.id}: hasLiveStats=${!!ps?.hasLiveStats} game=${ps?.gameNumber||'?'} status=${ps?.gameStatus||'?'}`);

        // Gate stale: se sem Steam RT E gameTime ainda no early game (<8min) E partida live há tempo,
        // dado é provavelmente velho — bloqueia tip pra evitar agir em snapshot defasado.
        if (od?.hasLiveStats && !sourceIsRT && od.gameTime && od.gameTime < 8 * 60) {
          const matchTs = match.time ? new Date(match.time).getTime() : 0;
          const matchAgeMin = matchTs ? (Date.now() - matchTs) / 60000 : 0;
          if (matchAgeMin > 15) {
            log('INFO', 'AUTO-DOTA', `Stats stale: gameTime=${Math.round(od.gameTime/60)}min mas partida começou há ${matchAgeMin.toFixed(0)}min — pulando ${match.team1} vs ${match.team2}`);
            setDotaAnalyzed({ ts: now, tipSent: false, noEdge: true });
            continue;
          }
        }

        // Preferencia: OpenDota se hasLiveStats; senao, PandaScore.
        if (od?.hasLiveStats) {
          dotaHasLiveStats = true;
          const blue = od.blueTeam, red = od.redTeam;
          const goldDiff = (blue.totalGold||0) - (red.totalGold||0);
          const gt = od.gameTime ? Math.round(od.gameTime/60) : 0;
          const sourceNote = od.hasPlayerStats ? 'OpenDota' : 'OpenDota agg (gold estimado)';
          dotaLiveContext += `\n[AO VIVO — ${gt}min | ${sourceNote}]\n`;
          dotaLiveContext += `Gold: ${blue.name} ${g(blue.totalGold)} vs ${red.name} ${g(red.totalGold)} (diff: ${goldDiff>0?'+':''}${g(goldDiff)})\n`;
          dotaLiveContext += `Kills: ${blue.totalKills||0}x${red.totalKills||0}\n`;
          if (od.hasPlayerStats) {
            dotaLiveContext += `${blue.name}:\n${fmtTeam(blue)}\n${red.name}:\n${fmtTeam(red)}\n`;
          } else {
            const heroLine = (team) => (team.players||[]).map(p => p.hero || '?').filter(h => h !== '?').join(', ');
            if (heroLine(blue)) dotaLiveContext += `${blue.name} heroes: ${heroLine(blue)}\n`;
            if (heroLine(red))  dotaLiveContext += `${red.name} heroes: ${heroLine(red)}\n`;
          }
        } else if (ps?.hasLiveStats) {
          dotaHasLiveStats = true;
          const blue = ps.blueTeam, red = ps.redTeam;
          const goldDiff = (blue.totalGold||0) - (red.totalGold||0);
          dotaLiveContext += `\n[GAME ${ps.gameNumber} — AO VIVO | Série: ${ps.seriesScore||'0-0'} | PandaScore]\n`;
          dotaLiveContext += `Gold: ${blue.name} ${g(blue.totalGold)} vs ${red.name} ${g(red.totalGold)} (diff: ${goldDiff>0?'+':''}${g(goldDiff)})\n`;
          dotaLiveContext += `Kills: ${blue.totalKills||0}x${red.totalKills||0}\n`;
          dotaLiveContext += `${blue.name}:\n${fmtTeam(blue)}\n${red.name}:\n${fmtTeam(red)}\n`;
        }
      }

      // Gate: partida live sem nenhuma fonte de stats (OpenDota + Steam RT + PandaScore).
      // Sem feed real, só Elo/H2H → IA vira coin-flip. Default ON (DOTA_LIVE_REQUIRE_STATS=true).
      if (isLive && !dotaHasLiveStats && /^(1|true|yes)$/i.test(String(process.env.DOTA_LIVE_REQUIRE_STATS ?? 'true'))) {
        log('INFO', 'AUTO-DOTA', `Sem stats live (OpenDota/Steam RT/PS) — pulando: ${match.team1} vs ${match.team2}`);
        setDotaAnalyzed({ ts: now, tipSent: false, noEdge: true });
        continue;
      }

      // ── Pré-filtro ML ──
      // maxDivergence: Dota tier-2 com small-sample (3-0 vs 0-3) infla modelP; clamp a ±15pp
      // impede a IA de derivar EV absurdo (>50%) que o sanity gate em bot.js rejeita.
      const dotaMaxDiv = parseFloat(process.env.DOTA_ML_MAX_DIVERGENCE ?? '0.15') || 0.15;
      const mlResult = esportsPreFilter(match, o, enrich, isLive, dotaLiveContext, null, null, { maxDivergence: dotaMaxDiv });
      if (!mlResult.pass) {
        log('INFO', 'AUTO-DOTA', `Pré-filtro: edge insuficiente (${mlResult.score.toFixed(1)}pp) para ${match.team1} vs ${match.team2}`);
        setDotaAnalyzed({ ts: now, tipSent: false, noEdge: true });
        continue;
      }
      if ((mlResult.rawEdge || 0) > 15) {
        log('DEBUG', 'AUTO-DOTA', `ML edge bruto=${mlResult.rawEdge.toFixed(1)}pp (clamped→${mlResult.score.toFixed(1)}pp) | modelP1Raw=${(mlResult.modelP1Raw*100).toFixed(1)}% impliedP1=${(mlResult.impliedP1*100).toFixed(1)}% scorePts=${(mlResult.scorePoints||0).toFixed(1)} factors=[${(mlResult.factorActive||[]).join(',')}] ${match.team1} vs ${match.team2}`);
      }

      // ── Dados para o prompt ──
      const r1 = 1 / parseFloat(o.t1), r2 = 1 / parseFloat(o.t2);
      const overround = r1 + r2;
      const djP1 = (r1 / overround * 100).toFixed(1);
      const djP2 = (r2 / overround * 100).toFixed(1);
      const marginPct = ((overround - 1) * 100).toFixed(1);
      const modelP1 = (mlResult.modelP1 * 100).toFixed(1);
      const modelP2 = (mlResult.modelP2 * 100).toFixed(1);
      const hasModelData = mlResult.factorCount > 0;

      const formSection = [
        form1 ? `${match.team1}: ${form1.wins}V-${form1.losses}D (${form1.winRate}%) | Streak: ${form1.streak} | ${(form1.recent||[]).join('')}` : `${match.team1}: sem dados`,
        form2 ? `${match.team2}: ${form2.wins}V-${form2.losses}D (${form2.winRate}%) | Streak: ${form2.streak} | ${(form2.recent||[]).join('')}` : `${match.team2}: sem dados`,
      ].join('\n');
      const h2hSection = h2h?.totalMatches > 0
        ? `H2H (${h2h.totalMatches} jogos): ${match.team1} ${h2h.t1Wins}V x ${h2h.t2Wins}V ${match.team2}`
        : 'H2H: sem histórico';

      const matchTime = match.time ? new Date(match.time).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      }) : '—';

      const fairLabel = hasModelData ? 'P modelo (forma+H2H)' : 'Fair odds (de-juice)';
      const evThreshold = hasModelData ? 5 : 6;
      const minOdds = parseFloat(process.env.DOTA_MIN_ODDS || '1.30');
      const maxOdds = parseFloat(process.env.DOTA_MAX_ODDS || '5.00');

      const liveSection = isLive
        ? `\nESTADO DA SÉRIE (AO VIVO): ${match.team1} ${match.score1||0} x ${match.score2||0} ${match.team2} | Formato: ${match.format || 'Bo?'}\n⚠️ Partida ao vivo — odds refletem o estado atual da série. Só tip se edge for claro e odds forem favoráveis.${dotaHasLiveStats ? '\n\nSTATS AO VIVO:' + dotaLiveContext : ''}`
        : '';

      const prompt = `Você é um analista especializado em Dota 2 esports. Analise esta partida e identifique edge real se existir.

PARTIDA: ${match.team1} vs ${match.team2}
Liga: ${match.league} | Formato: ${match.format || 'Bo?'} | Data: ${matchTime} (BRT)${liveSection}

ODDS (${o.bookmaker || 'SX.Bet'}):
${match.team1}: ${o.t1} | ${match.team2}: ${o.t2}
Margem: ${marginPct}% | P de-juiced: ${match.team1}=${djP1}% | ${match.team2}=${djP2}%
${fairLabel}: ${match.team1}=${modelP1}% | ${match.team2}=${modelP2}%

FORMA RECENTE (DB interno, últimos 45 dias):
${formSection}
${h2hSection}

ANÁLISE (seja específico — Dota 2):
1. Forma e momentum: série atual, consistência, nível de oposição.
2. Estilo: teamfight/Roshan vs split push/farm — qual favorece cada time.
3. Meta do patch: estilos/heróis dominantes e adaptação de cada time.
4. Vantagem individual: carry (pos 1), mid (pos 2), offlaner, suportes.
5. Contexto da série ao vivo (se aplicável): placar, pressão psicológica, fadiga.

REGRAS: Odds ${minOdds}–${maxOdds} | EV ≥ ${evThreshold}%${isLive ? ' | Ao vivo: só ALTA ou MÉDIA com edge claro' : ''}

CÁLCULO DE EV — OBRIGATÓRIO VALIDAR ANTES DE REPORTAR:
  Fórmula: EV% = (P/100 × odd − 1) × 100
  Exemplo: P=55%, odd=2.00 → EV = (0.55 × 2.00 − 1) × 100 = +10%
  Exemplo: P=60%, odd=1.70 → EV = (0.60 × 1.70 − 1) × 100 = +2%
Se EV reportado ≠ cálculo da fórmula, sua tip será REJEITADA automaticamente.
⚠️ EV > 40% é quase sempre erro — revise seu cálculo se chegar nisso.

DECISÃO FINAL (escolha UMA):
TIP_ML:[time]@[odd]|P:[%]|STAKE:[1-3]u|CONF:[ALTA/MÉDIA/BAIXA]
(Só forneça P — sua prob estimada 0-100 inteiro. Sistema calcula EV automaticamente.)
ou SEM_EDGE

Máximo 200 palavras.`;

      log('INFO', 'AUTO-DOTA', `Analisando${isLive ? ' [AO VIVO]' : ''}: ${match.team1} vs ${match.team2} (${match.league}) | mlEdge=${mlResult.score.toFixed(1)}pp`);
      setDotaAnalyzed({ ts: now, tipSent: false, noEdge: false });

      let iaResp = '';
      try {
        const iaRaw = await serverPost('/claude', {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 400
        }).catch(() => null);
        // /claude retorna formato Claude-compatível: { content: [{ type:'text', text }] }
        iaResp = iaRaw?.content?.[0]?.text || iaRaw?.result || iaRaw?.text || '';
      } catch(e) {
        log('WARN', 'AUTO-DOTA', `IA erro: ${e.message}`);
        continue;
      }

      let tipMatch = typeof iaResp === 'string' ? _parseTipMl(iaResp) : null;

      if (tipMatch) {
        const _pickIsT1V = norm(tipMatch[1].trim()) === norm(match.team1)
          || norm(match.team1).includes(norm(tipMatch[1].trim()))
          || norm(tipMatch[1].trim()).includes(norm(match.team1));
        const _modelPV = _pickIsT1V ? mlResult.modelP1 : mlResult.modelP2;
        const _v = _validateTipPvsModel(iaResp, _modelPV);
        if (!_v.valid) {
          log('WARN', 'AUTO-DOTA', `Tip rejeitada (${match.team1} vs ${match.team2}): ${_v.reason}`);
          tipMatch = null;
        } else {
          // Gate divergência modelo vs Pinnacle.
          const _impPV = _pickIsT1V ? mlResult.impliedP1 : mlResult.impliedP2;
          const _maxDivDota = parseFloat(process.env.DOTA_MAX_DIVERGENCE_PP ?? '15');
          const _div = _sharpDivergenceGate({ oddsObj: o, modelP: _modelPV, impliedP: _impPV, maxPp: _maxDivDota });
          if (!_div.ok) {
            log('WARN', 'AUTO-DOTA', `Tip rejeitada (${match.team1} vs ${match.team2}): ${_div.reason}`);
            tipMatch = null;
          }
        }
      }

      if (!tipMatch) {
        log('INFO', 'AUTO-DOTA', `Sem tip: ${match.team1} vs ${match.team2}`);
        setDotaAnalyzed({ ts: now, tipSent: false, noEdge: true });
        await _sleep(2000);
        continue;
      }

      const tipTeam = tipMatch[1].trim();
      const tipOdd = tipMatch[2].trim();
      const tipEvIa = tipMatch[3].trim(); // EV bruto da IA
      const tipConf = (tipMatch[5] || 'MÉDIA').trim().toUpperCase().replace('MEDIA', 'MÉDIA');

      // Recalcula EV via modelP (ML) — evita IA inflar edge em underdogs.
      const _pickIsT1D = norm(tipTeam).includes(norm(match.team1)) || norm(match.team1).includes(norm(tipTeam));
      const _modelPPickD = _pickIsT1D ? mlResult.modelP1 : mlResult.modelP2;
      const _detEvD = _modelEv(_modelPPickD, tipOdd);
      const _iaEvNumD = parseFloat(String(tipEvIa).replace('%','').replace('+',''));
      const tipEV = _detEvD != null ? `+${_detEvD.toFixed(1)}%` : tipEvIa;
      if (_detEvD != null && Number.isFinite(_iaEvNumD) && Math.abs(_detEvD - _iaEvNumD) >= 3) {
        log('INFO', 'EV-RECALC', `dota2 ${match.team1} vs ${match.team2}: IA=${_iaEvNumD}% → modelo=${_detEvD}% (P=${(_modelPPickD*100).toFixed(1)}% @ ${tipOdd})`);
      }

      // Ao vivo: bloqueia confiança BAIXA (muito risco com delay de odds)
      if (isLive && tipConf === 'BAIXA') {
        log('INFO', 'AUTO-DOTA', `Ao vivo: conf BAIXA rejeitada para ${match.team1} vs ${match.team2}`);
        setDotaAnalyzed({ ts: now, tipSent: false, noEdge: true });
        await _sleep(2000); continue;
      }

      const oddVal = parseFloat(tipOdd);
      if (oddVal < minOdds || oddVal > maxOdds) {
        log('INFO', 'AUTO-DOTA', `Odd fora do range (${oddVal}): pulando`);
        setDotaAnalyzed({ ts: now, tipSent: false, noEdge: true });
        await _sleep(2000); continue;
      }
      const evVal = parseFloat(String(tipEV).replace('%', '').replace('+', ''));
      if (evVal < evThreshold) {
        log('INFO', 'AUTO-DOTA', `EV insuficiente (${evVal}% < ${evThreshold}%): pulando`);
        setDotaAnalyzed({ ts: now, tipSent: false, noEdge: true });
        await _sleep(2000); continue;
      }
      // EV sanity: bloqueia EV absurdamente alto (erro de cálculo da IA)
      if (evVal > 50) {
        log('WARN', 'AUTO-DOTA', `Gate EV sanity: EV ${evVal}% > 50% — provável erro de cálculo da IA → rejeitado`);
        setDotaAnalyzed({ ts: now, tipSent: false, noEdge: true });
        await _sleep(2000); continue;
      }

      // ── Sharp line check (Pinnacle reference) ──
      const sharpCheckDota = checkSharpLine(o, tipTeam, match.team1, match.team2);
      if (!sharpCheckDota.ok) {
        log('INFO', 'AUTO-DOTA', `Sharp line gate: ${tipTeam} — ${sharpCheckDota.reason}`);
        setDotaAnalyzed({ ts: now, tipSent: false, noEdge: true });
        await _sleep(2000); continue;
      }

      const isT1bet = norm(tipTeam).includes(norm(match.team1)) || norm(match.team1).includes(norm(tipTeam));
      const kellyFraction = tipConf === 'ALTA' ? 0.25 : tipConf === 'BAIXA' ? 0.10 : 1/6;
      const modelPForKelly = mlResult.modelP1 > 0 ? (isT1bet ? mlResult.modelP1 : mlResult.modelP2) : null;
      const tipStake = modelPForKelly
        ? calcKellyWithP(modelPForKelly, tipOdd, kellyFraction)
        : calcKellyFraction(tipEV, tipOdd, kellyFraction);
      if (tipStake === '0u') { log('INFO', 'AUTO-DOTA', `Kelly negativo: ${tipTeam} @ ${tipOdd}`); await _sleep(2000); continue; }

      const riskAdj = await applyGlobalRisk('esports', parseFloat(String(tipStake).replace('u', '')) || 0, match.league);
      if (!riskAdj.ok) { log('INFO', 'RISK', `dota2: bloqueada (${riskAdj.reason})`); continue; }
      const tipStakeAdj = `${riskAdj.units.toFixed(1).replace(/\.0$/, '')}u`;

      const matchId = `dota2_${match.id}`;
      const liveTag = isLive ? ' 🔴 AO VIVO' : '';
      const minTakeOdds = calcMinTakeOdds(tipOdd);
      const minTakeLine = minTakeOdds ? `\n📉 Odd mínima: *${minTakeOdds}*` : '';
      const msg = `🎮 *DOTA 2 — ${match.league}*${liveTag}\n${match.team1} vs ${match.team2} | ${match.format || ''}\n📅 ${matchTime} BRT\n\n✅ *TIP: ${tipTeam} @ ${tipOdd}*${minTakeLine}\n💰 Stake: ${tipStakeAdj} | EV: ${tipEV} | Conf: ${tipConf}\n🏦 ${o.bookmaker || 'SX.Bet'}`;

      try {
        const rec = await serverPost('/record-tip', {
          matchId,
          eventName: match.league,
          p1: match.team1,
          p2: match.team2,
          tipParticipant: tipTeam,
          odds: String(tipOdd),
          ev: String(evVal),
          stake: tipStakeAdj,
          confidence: tipConf,
          isLive: isLive ? 1 : 0,
          market_type: 'ML',
          modelP1: mlResult.modelP1,
          modelP2: mlResult.modelP2,
          modelPPick: modelPForKelly,
          modelLabel: `dota-ml (${mlResult.factorActive?.join('+') || 'base'})`,
          tipReason: iaResp ? iaResp.split('TIP_ML:')[0].trim().split('\n').filter(Boolean).pop()?.slice(0, 160) || null : null,
          isShadow: esportsConfig.shadowMode ? 1 : 0,
          oddsFetchedAt: o._fetchedAt || null
        }, 'esports');
        if (rec?.skipped) {
          log('INFO', 'AUTO-DOTA', `Tip já existe (duplicate): ${tipTeam} @ ${tipOdd}`);
          setDotaAnalyzed({ ts: now, tipSent: true, noEdge: false });
          await _sleep(2000); continue;
        }
        for (const [uid, sports] of subscribedUsers) {
          if (!sports.has('esports')) continue;
          await sendDM(token, uid, msg).catch(() => {});
        }
        log('INFO', 'AUTO-DOTA', `TIP${isLive ? ' [LIVE]' : ''}: ${tipTeam} @ ${tipOdd} (${tipStakeAdj})`);
        setDotaAnalyzed({ ts: now, tipSent: true, noEdge: false });
      } catch(e) {
        log('WARN', 'AUTO-DOTA', `Erro ao gravar tip: ${e.message}`);
      }
      await _sleep(3000);
    }
    if (!_drained && _hasLive) _livePhaseExit('dota');

    // ── Fase 3: Tips por mapa (independente da tip ML-série) ──
    // Pra cada live com mapOdds Pinnacle, roda modelo de mapa e emite tip MAP{N} se EV+edge.
    for (const match of matches.filter(m => m.status === 'live' && m.mapOdds)) {
      try {
        await analyzeDotaMapTip(match, token);
      } catch (e) {
        log('WARN', 'AUTO-DOTA-MAP', `${match.team1} vs ${match.team2}: ${e.message}`);
      }
    }
    } // end else (has matches)
  } catch(e) {
    log('ERROR', 'AUTO-DOTA', e.message);
    _livePhaseExit('dota');
  }
  // Dual-mode: 60s live (com Steam RT) / 2min sem RT / 15min idle.
  // RT delay ~15s + loop 60s + cooldown 90s + IA 5s → tip atualizada em ~90-120s no pior caso.
  if (!runOnce) {
    const _hasRT = !!process.env.STEAM_WEBAPI_KEY;
    const livePollMs = _hasRT ? (60 * 1000) : (2 * 60 * 1000);
    const dotaNextMs = _hasLiveDota ? livePollMs : (15 * 60 * 1000);
    log('INFO', 'AUTO-DOTA', `Próximo ciclo em ${Math.round(dotaNextMs / 1000)}s (${_hasLiveDota ? 'LIVE' + (_hasRT ? ' [Steam RT]' : '') : 'idle'})`);
    setTimeout(() => pollDota().catch(e => log('ERROR', 'AUTO-DOTA', e.message)), dotaNextMs);
  }
}

// ── Análise e emissão de tip por mapa ──
// Chamado pelo AUTO-DOTA principal pra cada match live com match.mapOdds.
// Usa lib/dota-map-model pra calcular P(mapa atual) com live stats OpenDota/Steam RT.
async function analyzeDotaMapTip(match, token) {
  const { predictMapWinner } = require('./lib/dota-map-model');
  const DOTA_MAP_MIN_EV = parseFloat(process.env.DOTA_MAP_MIN_EV || '8');
  const DOTA_MAP_MIN_CONF = parseFloat(process.env.DOTA_MAP_MIN_CONF || '0.5');

  const mapN = match.mapOdds?.period;
  if (!mapN) return;
  const psId = match._psId || null;
  const mapMatchId = psId
    ? `dota2_ps_${psId}_MAP${mapN}`
    : `${match.id}_MAP${mapN}`;

  // Dedup: se já temos tip deste mapa em memória, pula
  const mapKey = `dota2_${mapMatchId}`;
  const prevMap = analyzedDota.get(mapKey);
  if (prevMap?.tipSent) return;
  const now = Date.now();
  if (prevMap && (now - prevMap.ts < 5 * 60 * 1000)) return; // cooldown 5min

  // Staleness guard: confirma que o mapa ainda está em andamento via PandaScore games.
  // Match.score1/score2 do endpoint /dota-matches pode vir de cache de 1-2min,
  // tempo suficiente pra mapa acabar e mapa seguinte começar.
  if (psId) {
    const mapResult = await serverGet(`/dota-map-result?psId=${encodeURIComponent(psId)}&map=${mapN}`).catch(() => null);
    if (mapResult?.resolved) {
      log('INFO', 'AUTO-DOTA-MAP', `Skip: mapa ${mapN} já finalizado (winner=${mapResult.winner}) — score cache estava velho`);
      analyzedDota.set(mapKey, { ts: now, tipSent: false, reason: 'map_already_finished' });
      return;
    }
    if (mapResult?.reason === 'map_not_found') {
      // Mapa N ainda não criado no PandaScore — série pode estar entre mapas
      log('DEBUG', 'AUTO-DOTA-MAP', `Skip: mapa ${mapN} ainda não iniciado no PS`);
      analyzedDota.set(mapKey, { ts: now, tipSent: false, reason: 'map_not_started' });
      return;
    }
  }

  const od = await serverGet(`/opendota-live?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}`).catch(() => null);
  if (!od?.hasLiveStats) {
    analyzedDota.set(mapKey, { ts: now, tipSent: false, reason: 'no_live_stats' });
    return;
  }

  // Game-time sanity: opendota-live sem game_time significa partida não começou ou já terminou.
  // Evita tip em brecha entre mapas quando OpenDota ainda mostra lobby/draft.
  if ((od.gameTime || 0) < 60) {
    log('DEBUG', 'AUTO-DOTA-MAP', `Skip: gameTime=${od.gameTime}s muito baixo (lobby/draft)`);
    analyzedDota.set(mapKey, { ts: now, tipSent: false, reason: 'lobby_or_draft' });
    return;
  }

  // Baseline: de-juice das odds do mapa
  const o1 = parseFloat(match.mapOdds.t1), o2 = parseFloat(match.mapOdds.t2);
  if (!o1 || !o2 || o1 <= 1 || o2 <= 1) return;
  const r1 = 1 / o1, r2 = 1 / o2;
  const vig = r1 + r2;
  const baselineP1 = r1 / vig;

  const pred = predictMapWinner({
    liveStats: od,
    seriesScore: { score1: match.score1 || 0, score2: match.score2 || 0, team1: match.team1, team2: match.team2 },
    baselineP: baselineP1,
    team1Name: match.team1,
  });

  // Avalia ambos lados e escolhe melhor EV
  const pT1 = pred.p;
  const pT2 = 1 - pT1;
  const evT1 = (pT1 * o1 - 1) * 100;
  const evT2 = (pT2 * o2 - 1) * 100;
  const pickDir = evT1 >= evT2 ? 't1' : 't2';
  const pickTeam = pickDir === 't1' ? match.team1 : match.team2;
  const pickOdd  = pickDir === 't1' ? o1 : o2;
  const pickP    = pickDir === 't1' ? pT1 : pT2;
  const pickEv   = pickDir === 't1' ? evT1 : evT2;

  log('INFO', 'AUTO-DOTA-MAP', `Map ${mapN} ${match.team1} vs ${match.team2}: pT1=${(pT1*100).toFixed(1)}% EV_t1=${evT1.toFixed(1)}% EV_t2=${evT2.toFixed(1)}% conf=${pred.confidence} | ${pred.reason}`);

  if (pred.confidence < DOTA_MAP_MIN_CONF) {
    analyzedDota.set(mapKey, { ts: now, tipSent: false, reason: 'low_confidence' });
    return;
  }
  if (pickEv < DOTA_MAP_MIN_EV) {
    analyzedDota.set(mapKey, { ts: now, tipSent: false, reason: 'low_ev' });
    return;
  }

  // Stake Kelly fracionado conservador (1/8 — igual demais tips sem IA)
  const stake = calcKellyWithP(pickP, pickOdd, 1/8);
  if (stake === '0u') { analyzedDota.set(mapKey, { ts: now, tipSent: false, reason: 'zero_stake' }); return; }
  const desiredU = parseFloat(stake) || 0;
  const riskAdj = await applyGlobalRisk('esports', desiredU, match.league);
  if (!riskAdj.ok) {
    log('INFO', 'RISK', `dota map: bloqueada (${riskAdj.reason})`);
    analyzedDota.set(mapKey, { ts: now, tipSent: false, reason: 'risk_blocked' });
    return;
  }
  const stakeAdj = String(riskAdj.units.toFixed(1).replace(/\.0$/, '')) + 'u';

  const tipConf = pickEv >= 15 ? 'ALTA' : pickEv >= 8 ? 'MÉDIA' : 'BAIXA';
  const msg = `🟥 💰 *TIP DOTA2 MAPA ${mapN} (AO VIVO 🔴)*\n` +
    `${match.team1} vs ${match.team2} — série ${match.score1||0}-${match.score2||0}\n` +
    `Pick: *${pickTeam}* (mapa ${mapN})\n` +
    `Odd: ${pickOdd.toFixed(2)} | EV: ${pickEv.toFixed(1)}% | Stake: ${stakeAdj}\n` +
    `Modelo: gold/kill diff + momentum (conf ${(pred.confidence*100).toFixed(0)}%)`;

  try {
    const rec = await serverPost('/record-tip', {
      matchId: mapMatchId,
      eventName: match.league,
      p1: match.team1, p2: match.team2,
      tipParticipant: pickTeam,
      odds: String(pickOdd),
      ev: String(pickEv.toFixed(1)),
      stake: stakeAdj,
      confidence: tipConf,
      isLive: 1,
      market_type: `MAP${mapN}_WINNER`,
      modelP1: pT1, modelP2: pT2,
      modelPPick: pickP,
      modelLabel: `dota-map-${mapN} (${pred.factors.map(f => f.name).join('+') || 'base'})`,
      tipReason: pred.reason.slice(0, 160),
      isShadow: SPORTS['esports']?.shadowMode ? 1 : 0,
      oddsFetchedAt: null,
    }, 'esports');
    if (rec?.skipped) {
      log('INFO', 'AUTO-DOTA-MAP', `Tip mapa ${mapN} duplicada: ${pickTeam} @ ${pickOdd}`);
      analyzedDota.set(mapKey, { ts: now, tipSent: true });
      return;
    }
    for (const [uid, sports] of subscribedUsers) {
      if (!sports.has('esports')) continue;
      await sendDM(token, uid, msg).catch(() => {});
    }
    log('INFO', 'AUTO-DOTA-MAP', `TIP MAPA ${mapN}: ${pickTeam} @ ${pickOdd} (EV ${pickEv.toFixed(1)}%, conf ${pred.confidence})`);
    analyzedDota.set(mapKey, { ts: now, tipSent: true });
  } catch (e) {
    log('WARN', 'AUTO-DOTA-MAP', `record-tip falhou: ${e.message}`);
  }
}

// ── MMA Auto-analysis loop ──
async function pollMma(runOnce = false) {
  const mmaConfig = SPORTS['mma'];
  if (!mmaConfig?.enabled || !mmaConfig?.token) return;
  const token = mmaConfig.token;

  // Re-analisa a cada MMA_INTERVAL_H (default 12h — MMA odds são muito estáveis)
  const MMA_INTERVAL = Math.max(1, parseInt(process.env.MMA_INTERVAL_H || '12', 10) || 12) * 60 * 60 * 1000;

  async function loop() {
    try {
      log('INFO', 'AUTO-MMA', 'Iniciando verificação de lutas MMA...');
      const [fights, espnFights] = await Promise.all([
        serverGet('/mma-matches').catch(() => []),
        fetchEspnMmaFights().catch(() => [])
      ]);

      if (!Array.isArray(fights) || !fights.length) {
        if (!runOnce) setTimeout(loop, 30 * 60 * 1000); return;
      }

      const mmaCount = fights.filter(f => f.game === 'mma').length;
      const boxCount = fights.filter(f => f.game === 'boxing').length;
      log('INFO', 'AUTO-MMA', `${fights.length} lutas com odds (MMA: ${mmaCount} | Boxe: ${boxCount}) | ESPN: ${espnFights.length} lutas`);

      const now = Date.now();
      // BOXING_MAX_DAYS_BEFORE_FIGHT: boxe só se a luta em ≤ N dias (default 10); além disso pula
      const boxingMaxDays = Math.max(1, Math.min(60, parseInt(process.env.BOXING_MAX_DAYS_BEFORE_FIGHT || '10', 10) || 10));
      const boxingMaxMs = boxingMaxDays * 24 * 60 * 60 * 1000;
      let boxingSkippedLead = 0;
      let noDateSkipped = 0;
      let mmaIaCallsThisCycle = 0;
      const mmaIaCap = Math.max(0, parseInt(process.env.MMA_MAX_IA_CALLS_PER_CYCLE || '18', 10) || 18);
      const endOfWeek = (() => {
        const d = new Date();
        // Domingo da semana atual às 23:59
        const sunday = new Date(d);
        sunday.setDate(d.getDate() + (7 - d.getDay()) % 7 || 7);
        sunday.setHours(23, 59, 59, 999);
        return sunday.getTime();
      })();

      // Prioridade: lutas live/imminent (próximas 3h) primeiro
      const imminentMs = 3 * 60 * 60 * 1000;
      const isPriorityFight = (f) => {
        if (f.status === 'live') return true;
        const t = new Date(f.time || 0).getTime();
        return t > 0 && (t - now) < imminentMs;
      };
      fights.sort((a, b) => {
        const la = isPriorityFight(a) ? 0 : 1;
        const lb = isPriorityFight(b) ? 0 : 1;
        if (la !== lb) return la - lb;
        return new Date(a.time || 0) - new Date(b.time || 0);
      });
      const _hasLiveMma = fights.some(isPriorityFight);
      if (_hasLiveMma) _livePhaseEnter('mma');
      let _drainedMma = false;
      for (const fight of fights) {
        if (!isPriorityFight(fight) && !_drainedMma) {
          if (_hasLiveMma) _livePhaseExit('mma');
          await _waitOthersLiveDone('mma');
          _drainedMma = true;
        }
        const isBoxing = fight.game === 'boxing';

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
          noDateSkipped++;
          continue;
        }
        // Boxe: só dentro da janela de N dias (pula se ainda falta > N dias)
        if (isBoxing && fightTs - now > boxingMaxMs) {
          boxingSkippedLead++;
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

        // Boxe: não tenta records/ESPN/Wiki/Sherdog (ruído). Usa de-juice apenas.
        if (isBoxing) {
          rec1 = '';
          rec2 = '';
        }

        // Fallback: busca record individual (ESPN → Wikipedia → Sherdog → Tapology)
        if (!isBoxing && !espn) {
          const [e1, e2] = await Promise.all([
            fetchEspnFighterRecord(fight.team1).catch(() => null),
            fetchEspnFighterRecord(fight.team2).catch(() => null)
          ]);
          if (e1) rec1 = e1;
          if (e2) rec2 = e2;

          const [w1, w2] = await Promise.all([
            !rec1 ? fetchWikipediaFighterRecord(fight.team1).catch(() => null) : Promise.resolve(null),
            !rec2 ? fetchWikipediaFighterRecord(fight.team2).catch(() => null) : Promise.resolve(null)
          ]);
          if (w1) rec1 = w1;
          if (w2) rec2 = w2;

          const [s1, s2] = await Promise.all([
            !rec1 ? fetchSherdogFighterRecord(fight.team1).catch(() => null) : Promise.resolve(null),
            !rec2 ? fetchSherdogFighterRecord(fight.team2).catch(() => null) : Promise.resolve(null)
          ]);
          if (s1) rec1 = s1;
          if (s2) rec2 = s2;

          const [t1, t2] = await Promise.all([
            !rec1 ? fetchTapologyFighterRecord(fight.team1).catch(() => null) : Promise.resolve(null),
            !rec2 ? fetchTapologyFighterRecord(fight.team2).catch(() => null) : Promise.resolve(null)
          ]);
          if (t1) rec1 = t1;
          if (t2) rec2 = t2;

          const source1 = e1 ? 'ESPN' : w1 ? 'Wiki' : s1 ? 'Sherdog' : t1 ? 'Tapology' : '—';
          const source2 = e2 ? 'ESPN' : w2 ? 'Wiki' : s2 ? 'Sherdog' : t2 ? 'Tapology' : '—';
          if (rec1 || rec2) {
            log('INFO', 'AUTO-MMA', `Records: ${fight.team1}=${rec1||'?'}(${source1}) | ${fight.team2}=${rec2||'?'}(${source2})`);
          }
        }

        // ── Pré-filtro ML com dados ESPN (record → win rate) + Sofascore fallback ──
        const hasEspnRecord = !!(rec1 || rec2);
        let mmaEnrich = hasEspnRecord ? mmaRecordToEnrich(rec1, rec2) : { form1: null, form2: null, h2h: null, oddsMovement: null };
        const sofascoreMma = require('./lib/sofascore-mma');
        // Sofascore: preenche forma quando ESPN/Wiki/Sherdog/Tapology não deram record
        if (!hasEspnRecord) {
          try {
            const sofa = await sofascoreMma.enrichMatch(fight.team1, fight.team2, fight.time).catch(() => null);
            if (sofa && (sofa.form1 || sofa.form2)) {
              mmaEnrich = {
                form1: sofa.form1 || mmaEnrich.form1,
                form2: sofa.form2 || mmaEnrich.form2,
                h2h: mmaEnrich.h2h || { t1Wins: 0, t2Wins: 0, totalMatches: 0 },
                oddsMovement: null
              };
              log('DEBUG', 'AUTO-MMA', `Sofascore event ${sofa.eventId}: ${fight.team1} vs ${fight.team2}`);
              if (sofa.org) fight._org = sofa.org;
              if (sofa.eventName) fight._eventName = sofa.eventName;
            }
          } catch (_) {}
        }
        // Sempre resolve org/eventName (TheOddsAPI só dá "MMA"/"Boxing" genérico).
        // resolver: Sofascore → ESPN scoreboards (UFC/PFL/Bellator/boxing) como fallback.
        if (!fight._org) {
          try {
            const { resolveOrg } = require('./lib/mma-org-resolver');
            const orgInfo = await resolveOrg(fight.team1, fight.team2, fight.time).catch(() => null);
            if (orgInfo?.org) fight._org = orgInfo.org;
            if (orgInfo?.eventName) fight._eventName = orgInfo.eventName;
          } catch (_) {}
        }

        // UFC Stats: stats avançadas de striking/grappling/físico (só UFC/não-boxe)
        let ufcStats1 = null, ufcStats2 = null;
        const isUfc = String(fight._org || fight.league || '').toUpperCase().includes('UFC');
        if (!isBoxing && isUfc) {
          try {
            const ufcStats = require('./lib/ufcstats');
            [ufcStats1, ufcStats2] = await Promise.all([
              ufcStats.getFighterByName(fight.team1).catch(() => null),
              ufcStats.getFighterByName(fight.team2).catch(() => null),
            ]);
            if (ufcStats1 || ufcStats2) {
              log('DEBUG', 'AUTO-MMA', `UFC Stats: ${fight.team1}=${ufcStats1 ? 'ok' : 'n/a'} | ${fight.team2}=${ufcStats2 ? 'ok' : 'n/a'}`);
            }
          } catch (_) {}
        }

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

        // Seção stats UFC (quando disponível): striking/grappling avançado
        const fmtUfc = (name, s) => {
          if (!s) return null;
          const parts = [];
          if (s.slpm != null) parts.push(`SLpM ${s.slpm}`);
          if (s.strAcc != null) parts.push(`Acc ${Math.round(s.strAcc * 100)}%`);
          if (s.sapm != null) parts.push(`SApM ${s.sapm}`);
          if (s.strDef != null) parts.push(`Def ${Math.round(s.strDef * 100)}%`);
          if (s.tdAvg != null) parts.push(`TD ${s.tdAvg}/15min`);
          if (s.tdAcc != null) parts.push(`TDAcc ${Math.round(s.tdAcc * 100)}%`);
          if (s.tdDef != null) parts.push(`TDDef ${Math.round(s.tdDef * 100)}%`);
          if (s.subAvg != null) parts.push(`Sub ${s.subAvg}/15min`);
          if (s.reach != null) parts.push(`Reach ${s.reach}"`);
          if (s.stance) parts.push(s.stance);
          return `${name}: ${parts.join(' | ')}`;
        };
        const ufcLine1 = fmtUfc(fight.team1, ufcStats1);
        const ufcLine2 = fmtUfc(fight.team2, ufcStats2);
        const ufcStatsSection = (ufcLine1 || ufcLine2)
          ? `\n\nUFC STATS (striking/grappling por 15min):\n${[ufcLine1, ufcLine2].filter(Boolean).join('\n')}`
          : '';

        const fairOddsRef = hasModelDataMma
          ? `${fairLabelMma}: ${fight.team1}=${modelP1Mma}% | ${fight.team2}=${modelP2Mma}%\nP de-juiced bookie: ${fight.team1}=${fairP1}% | ${fight.team2}=${fairP2}%`
          : `${fairLabelMma}: ${fight.team1}=${modelP1Mma}% | ${fight.team2}=${modelP2Mma}% (use como mínimo — sem dados históricos para ajustar o prior)`;

        const newsSectionMma = await fetchMatchNews('mma', fight.team1, fight.team2).catch(() => '');

        const prompt = isBoxing
          ? `Você é um analista especializado em BOXE. Seja conservador — prefira SEM_EDGE a apostar em margem duvidosa.

LUTA: ${fight.team1} vs ${fight.team2}
Evento: ${fight.league} | Data: ${fightTime} (BRT)${espnSection}

ODDS (${o.bookmaker || 'EU'}):
${fight.team1}: ${o.t1} | ${fight.team2}: ${o.t2}
Margem bookie: ${marginPct}%
${fairOddsRef}
${newsSectionMma ? `\n${newsSectionMma}\n` : ''}
ANÁLISE REQUERIDA — seja específico:
1. Striking: volume, potência, defesa, timing, alcance.
2. Record e nível de oposição: quem enfrentou adversários de nível mais alto?
3. Matchup estilístico: brawler vs técnico, volume vs potência, etc.
4. Risco: variância por decisão vs KO/TKO — lutas com alta chance de KO são mais imprevisíveis.
5. Confiança (1-10): dados suficientes sobre AMBOS os lutadores?

DECISÃO FINAL:
- Se P × odd ≥ 1.05 E confiança ≥ 7: TIP_ML:[lutador]@[odd]|P:[%]|STAKE:[1-3]u|CONF:[ALTA/MÉDIA/BAIXA] (P = sua prob 0-100 inteiro; sistema calcula EV automaticamente)
- Se edge inexistente ou confiança < 7: SEM_EDGE

Máximo 220 palavras. Seja direto e fundamentado.`
          : `Você é um analista especializado em MMA/UFC. Analise esta luta e identifique edge real se existir.

LUTA: ${fight.team1} vs ${fight.team2}
Evento: ${fight.league} | Data: ${fightTime} (BRT)${espnSection}${ufcStatsSection}

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
4. Confiança (1-10): você tem dados suficientes sobre ambos?

DECISÃO FINAL:
- Se P × odd ≥ 1.05 E confiança ≥ 7: TIP_ML:[lutador]@[odd]|P:[%]|STAKE:[1-3]u|CONF:[ALTA/MÉDIA/BAIXA] (P = sua prob 0-100 inteiro; sistema calcula EV automaticamente)
- Se edge inexistente ou confiança < 7: SEM_EDGE

Máximo 220 palavras. Seja direto e fundamentado.`;

        if (mmaIaCap > 0 && mmaIaCallsThisCycle >= mmaIaCap) {
          log('INFO', 'AUTO-MMA', `Ciclo: limite ${mmaIaCap} IA(s) — resto no próximo (~30min). Ajuste MMA_MAX_IA_CALLS_PER_CYCLE.`);
          break;
        }
        mmaIaCallsThisCycle++;

        const espnTag = espn ? ` (ESPN card: ${weightClass}, ${rounds}R)` : hasEspnRecord ? ` (ESPN athlete: ${rec1||'?'} | ${rec2||'?'})` : ' (sem dados ESPN)';
        log('INFO', 'AUTO-MMA', `Analisando: ${fight.team1} vs ${fight.team2}${espnTag}`);
        analyzedMma.set(key, { ts: now, tipSent: false });

        let resp;
        try {
          resp = await serverPost('/claude', {
            model: 'deepseek-chat',
            max_tokens: 450,
            messages: [{ role: 'user', content: prompt }]
          });
        } catch(e) {
          log('WARN', 'AUTO-MMA', `AI error: ${e.message}`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        const text = resp?.content?.map(b => b.text || '').join('') || '';
        const extractTipReasonMma = (t) => {
          if (!t) return null;
          const before = t.split('TIP_ML:')[0] || '';
          const line = before.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
          const clean = line.replace(/^[-*•\s]+/, '').trim();
          return clean ? clean.slice(0, 160) : null;
        };
        const tipReasonTennis = extractTipReasonMma(text);
        let tipMatch = _parseTipMl(text);

        if (tipMatch) {
          // Valida P (IA) contra P (modelo determinístico). Se modelo tem P, ele é source of truth;
          // basta o P do texto bater — erros só no EV são corrigidos via _modelEv downstream.
          const _pickIsT1V = norm(tipMatch[1].trim()) === norm(fight.team1)
            || norm(fight.team1).includes(norm(tipMatch[1].trim()))
            || norm(tipMatch[1].trim()).includes(norm(fight.team1));
          const _modelPPickV = _pickIsT1V ? mlResultMma.modelP1 : mlResultMma.modelP2;
          const _vP = _validateTipPvsModel(text, _modelPPickV);
          if (!_vP.valid) {
            log('WARN', 'AUTO-MMA', `Tip rejeitada (${fight.team1} vs ${fight.team2}): ${_vP.reason}`);
            tipMatch = null;
          } else if (_vP.diffPp != null) {
            log('DEBUG', 'AUTO-MMA', `P consistente (Δ${_vP.diffPp.toFixed(1)}pp): IA=${(_vP.textP*100).toFixed(1)}% modelo=${(_vP.modelP*100).toFixed(1)}%`);
          }
          // Gate divergência modelo vs Pinnacle (MMA Pinnacle é muito sharp, threshold menor).
          if (tipMatch) {
            const _impPV = _pickIsT1V ? mlResultMma.impliedP1 : mlResultMma.impliedP2;
            const _maxDivMma = parseFloat(process.env.MMA_MAX_DIVERGENCE_PP ?? '10');
            const _div = _sharpDivergenceGate({ oddsObj: o, modelP: _modelPPickV, impliedP: _impPV, maxPp: _maxDivMma });
            if (!_div.ok) {
              log('WARN', 'AUTO-MMA', `Tip rejeitada (${fight.team1} vs ${fight.team2}): ${_div.reason}`);
              tipMatch = null;
            }
          }
        }

        if (!tipMatch) {
          log('INFO', 'AUTO-MMA', `Sem tip: ${fight.team1} vs ${fight.team2}`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        const tipTeam  = tipMatch[1].trim();
        const tipOdd   = parseFloat(tipMatch[2]);
        const tipEvIa  = parseFloat(tipMatch[3]); // EV reportado pela IA (mantido p/ log)
        const tipStake = tipMatch[4];
        const tipConf  = tipMatch[5].toUpperCase();

        // Recalcula EV usando P do modelo determinístico (source of truth).
        // IA às vezes erra só o cálculo do EV; validação P-vs-modelo acima garante que P é bom.
        const _pickIsT1Ev = norm(tipTeam) === norm(fight.team1)
          || norm(fight.team1).includes(norm(tipTeam))
          || norm(tipTeam).includes(norm(fight.team1));
        const _modelPPickEv = _pickIsT1Ev ? mlResultMma.modelP1 : mlResultMma.modelP2;
        const _detEv = _modelEv(_modelPPickEv, tipOdd);
        const tipEV = _detEv != null ? _detEv : tipEvIa;
        if (_detEv != null && Math.abs(_detEv - tipEvIa) >= 3) {
          log('INFO', 'EV-RECALC', `mma ${fight.team1} vs ${fight.team2}: IA=${tipEvIa}% → modelo=${_detEv}% (P=${(_modelPPickEv*100).toFixed(1)}% @ ${tipOdd}) [usando modelo]`);
        }

        // Lutas fora da semana: só ALTA passa
        if (fight._futureWeek && tipConf !== 'ALTA') {
          log('INFO', 'AUTO-MMA', `Gate semana: ${fight.team1} vs ${fight.team2} é luta futura — descartado (CONF=${tipConf}, exige ALTA)`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }
        if (tipOdd < 1.40 || tipOdd > 5.00) {
          log('INFO', 'AUTO-MMA', `Gate odds: ${tipOdd} fora do range 1.40-5.00`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }
        // Detecta book sharp (Pinnacle/Betfair). MMA TheOddsAPI pode entregar BetOnline.ag,
        // BetMGM, FanDuel etc — todos non-sharp. Sem ground truth sharp, edge é mais arriscado.
        const _bookmakerMma = String(o?.bookmaker || '').toLowerCase();
        const _isSharpBookMma = /pinnacle|betfair/.test(_bookmakerMma);
        const _mmaMinEvSharp = parseFloat(process.env.MMA_MIN_EV ?? '5.0');
        const _mmaMinEvSoft = parseFloat(process.env.MMA_MIN_EV_NONSHARP ?? '12.0');
        const _minEvForBook = _isSharpBookMma ? _mmaMinEvSharp : _mmaMinEvSoft;

        if (tipEV < _minEvForBook) {
          log('INFO', 'AUTO-MMA', `Gate EV: ${tipEV}% < ${_minEvForBook}% (${_isSharpBookMma ? 'sharp' : 'non-sharp ' + _bookmakerMma})`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }
        // Confiança BAIXA: bloqueia — MMA tem variância alta, BAIXA não compensa
        if (tipConf === 'BAIXA') {
          log('INFO', 'AUTO-MMA', `Gate conf BAIXA rejeitado: ${fight.team1} vs ${fight.team2}`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        // Cap conservador pra book non-sharp: rebaixa ALTA → MÉDIA (Kelly menor) e limita stake.
        // Sem Pinnacle/Betfair como ground truth, "edge" pode ser ilusório.
        let _confEffMma = tipConf;
        if (!_isSharpBookMma && _confEffMma === 'ALTA') {
          log('INFO', 'AUTO-MMA', `Conf rebaixada ALTA→MÉDIA (book non-sharp ${_bookmakerMma})`);
          _confEffMma = 'MÉDIA';
        }

        const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' }[_confEffMma] || '🟡';
        const recLine = espn ? `\n📊 Registros: ${fight.team1} ${rec1||'?'} | ${fight.team2} ${rec2||'?'}` : '';
        const catLine = espn ? `\n🏷️ ${weightClass || fight.league}${isTitleFight ? ' — TITLE FIGHT' : ''}` : '';

        const tipReasonMma = extractTipReasonMma(text);
        const whyLineMma = tipReasonMma ? `\n🧠 Por quê: _${tipReasonMma}_\n` : '\n';
        const minTakeOdds = calcMinTakeOdds(tipOdd);
        const minTakeLine = minTakeOdds ? `📉 Odd mínima: *${minTakeOdds}*\n` : '';
        const bookSourceLine = !_isSharpBookMma ? `\n⚠️ _Odds ${o.bookmaker || 'non-sharp'} — sem Pinnacle como referência. Stake/conf reduzidos._\n` : '';

        const kellyLabelMma = _confEffMma === 'ALTA' ? '¼ Kelly' : '⅙ Kelly';

        const pickIsT1Mma = norm(tipTeam) === norm(fight.team1);
        const modelPPickMma = pickIsT1Mma ? mlResultMma.modelP1 : mlResultMma.modelP2;

        // Kelly fracionado: ALTA → ¼ Kelly (max 4u) | MÉDIA → ⅙ Kelly (max 3u)
        const kellyFractionMma = _confEffMma === 'ALTA' ? 0.25 : 1/6;
        const kellyStakeMma = modelPPickMma > 0
          ? calcKellyWithP(modelPPickMma, tipOdd, kellyFractionMma)
          : calcKellyFraction(tipEV, tipOdd, kellyFractionMma);
        if (kellyStakeMma === '0u') {
          log('INFO', 'AUTO-MMA', `Kelly negativo ${tipTeam} @ ${tipOdd} — tip abortada`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }
        let desiredUnitsMma = parseFloat(kellyStakeMma) || 0;
        // Cap stake pra book non-sharp: max 1u (mesma filosofia do CS tier 2+).
        const _mmaMaxStakeNonSharp = parseFloat(process.env.MMA_MAX_STAKE_NONSHARP ?? '1.0');
        if (!_isSharpBookMma && desiredUnitsMma > _mmaMaxStakeNonSharp) {
          log('INFO', 'AUTO-MMA', `Stake cap ${desiredUnitsMma.toFixed(1)}u → ${_mmaMaxStakeNonSharp}u (book non-sharp ${_bookmakerMma})`);
          desiredUnitsMma = _mmaMaxStakeNonSharp;
        }
        const riskAdjMma = await applyGlobalRisk('mma', desiredUnitsMma, fight.league);
        if (!riskAdjMma.ok) { log('INFO', 'RISK', `mma: bloqueada (${riskAdjMma.reason})`); await new Promise(r => setTimeout(r, 3000)); continue; }
        const tipStakeAdjMma = String(riskAdjMma.units.toFixed(1).replace(/\.0$/, ''));

        const orgLabel = (() => {
          if (isBoxing) return '🥊 💰 *TIP BOXE*';
          // fight._org vem do Sofascore uniqueTournament.name (UFC/PFL/Bellator/etc).
          // Prioriza sobre fight.league que TheOddsAPI retorna como "MMA" genérico.
          const src = [fight._org, fight.league].filter(Boolean).join(' ').toLowerCase();
          if (/\bufc\b/.test(src)) return '🥋 💰 *TIP UFC*';
          if (/\bpfl\b/.test(src)) return '🥋 💰 *TIP PFL*';
          if (/oktagon/.test(src)) return '🥋 💰 *TIP OKTAGON*';
          if (/bellator/.test(src)) return '🥋 💰 *TIP BELLATOR*';
          if (/\bone\b|one championship|one fc/.test(src)) return '🥋 💰 *TIP ONE*';
          if (/\bksw\b/.test(src)) return '🥋 💰 *TIP KSW*';
          if (/\brizin\b/.test(src)) return '🥋 💰 *TIP RIZIN*';
          if (/\bcage warriors|\bcw\b/.test(src)) return '🥋 💰 *TIP CAGE WARRIORS*';
          if (/\blfa\b|legacy fighting/.test(src)) return '🥋 💰 *TIP LFA*';
          if (/\bbkfc\b|bare knuckle/.test(src)) return '🥋 💰 *TIP BKFC*';
          if (fight._org) return `🥋 💰 *TIP ${String(fight._org).toUpperCase()}*`;
          return '🥋 💰 *TIP MMA*';
        })();
        const leagueLine = fight._eventName
          ? `${fight._org ? fight._org + ' — ' : ''}${fight._eventName}`
          : fight.league;
        const tipMsg = `${orgLabel}\n` +
          `*${fight.team1}* vs *${fight.team2}*\n📋 ${leagueLine}\n` +
          `🕐 ${fightTime} (BRT)${recLine}${catLine}\n\n` +
          whyLineMma +
          `🎯 Aposta: *${tipTeam}* @ *${tipOdd}*\n` +
          minTakeLine +
          `📈 EV: *+${tipEV}%* | De-juice: ${tipTeam === fight.team1 ? fairP1 : fairP2}%\n` +
          `💵 Stake: *${tipStakeAdjMma}u* _(${kellyLabelMma})_\n` +
          `${confEmoji} Confiança: *${_confEffMma}*${bookSourceLine}\n` +
          `⚠️ _Aposte com responsabilidade._`;

        // eventName: prioriza org + eventName (ex: "UFC — UFC 305") sobre o "MMA" genérico do TheOddsAPI.
        // Se nenhum resolver achou org (leagueLine vira "MMA" puro), marca como
        // "MMA (não identificado)" pra não contaminar o bucket rollup das orgs conhecidas.
        const _trim = String(leagueLine || '').trim();
        const recEventName = (!_trim || /^mma$/i.test(_trim))
          ? (isBoxing ? 'Boxing (não identificado)' : 'MMA (não identificado)')
          : leagueLine;
        const rec = await serverPost('/record-tip', {
          matchId: String(fight.id), eventName: recEventName,
          p1: fight.team1, p2: fight.team2, tipParticipant: tipTeam,
          odds: String(tipOdd), ev: String(tipEV), stake: tipStakeAdjMma,
          confidence: _confEffMma, isLive: false, market_type: 'ML',
          modelP1: mlResultMma.modelP1,
          modelP2: mlResultMma.modelP2,
          modelPPick: modelPPickMma,
          modelLabel: fairLabelMma,
          tipReason: tipReasonMma,
          isShadow: mmaConfig.shadowMode ? 1 : 0
        }, 'mma');

        if (!rec?.tipId && !rec?.skipped) {
          log('WARN', 'AUTO-MMA', `record-tip falhou para ${tipTeam} @ ${tipOdd} (${fight.team1} vs ${fight.team2}) — tip abortada`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        if (rec?.skipped) {
          analyzedMma.set(key, { ts: now, tipSent: true });
          log('INFO', 'AUTO-MMA', `Tip duplicada (já registrada), Telegram ignorado: ${fight.team1} vs ${fight.team2}`);
          continue;
        }

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
      if (noDateSkipped > 0) {
        log('DEBUG', 'AUTO-MMA', `${noDateSkipped} luta(s) ignoradas (sem data válida ou >60d)`);
      }
      if (boxingSkippedLead > 0) {
        log('INFO', 'AUTO-MMA', `Boxe: ${boxingSkippedLead} luta(s) ignoradas (>${boxingMaxDays}d até o combate)`);
      }
      if (!_drainedMma && _hasLiveMma) _livePhaseExit('mma');
    } catch(e) {
      log('ERROR', 'AUTO-MMA', e.message);
      _livePhaseExit('mma');
    }
    if (!runOnce) setTimeout(loop, 30 * 60 * 1000);
    return []; // fallback
  }
  const result = await loop();
  return runOnce ? (result || []) : undefined;
}

// ── Tennis Auto-analysis loop ──
async function pollTennis(runOnce = false) {
  const tennisConfig = SPORTS['tennis'];
  if (!tennisConfig?.enabled || !tennisConfig?.token) return;
  const token = tennisConfig.token;

  // Live: cooldown curto (15min) para re-análise com score atualizado
  // Pré-jogo: usa TENNIS_PREGAME_INTERVAL_H (default 6h)
  const TENNIS_LIVE_INTERVAL = Math.max(1, parseInt(process.env.TENNIS_LIVE_INTERVAL_MIN || '3', 10)) * 60 * 1000; // 3min default
  const TENNIS_PREGAME_INTERVAL = Math.max(1, parseInt(process.env.TENNIS_PREGAME_INTERVAL_H || '6', 10) || 6) * 60 * 60 * 1000;
  const TENNIS_GATE_MIN_ODDS = parseFloat(process.env.TENNIS_MIN_ODDS ?? '1.40');
  const TENNIS_GATE_MAX_ODDS = parseFloat(process.env.TENNIS_MAX_ODDS ?? '5.00');
  // Dual-mode polling: 2min quando há live, 30min quando só upcoming
  const TENNIS_POLL_LIVE_MS = Math.max(60, parseInt(process.env.TENNIS_POLL_LIVE_SEC || '120', 10)) * 1000; // 2min
  const TENNIS_POLL_IDLE_MS = 30 * 60 * 1000; // 30min

  async function loop() {
    try {
      log('INFO', 'AUTO-TENNIS', 'Iniciando verificação de partidas de Tênis...');
      const matches = await serverGet('/tennis-matches').catch(() => []);
      if (!Array.isArray(matches) || !matches.length) {
        if (!runOnce) setTimeout(loop, 30 * 60 * 1000);
        return [];
      }

      log('INFO', 'AUTO-TENNIS', `${matches.length} partidas tênis com odds`);

      // Buscar rankings ESPN e dados do torneio atual em paralelo
      const rankings = await fetchEspnTennisRankings().catch(() => ({ atp: [], wta: [] }));
      const atpEvent = await fetchEspnTennisEvent('ATP').catch(() => null);
      const wtaEvent = await fetchEspnTennisEvent('WTA').catch(() => null);

      const now = Date.now();
      // Prioridade: live primeiro
      matches.sort((a, b) => {
        const la = a.status === 'live' ? 0 : 1;
        const lb = b.status === 'live' ? 0 : 1;
        if (la !== lb) return la - lb;
        return new Date(a.time || 0) - new Date(b.time || 0);
      });
      const _hasLiveT = matches.some(m => m.status === 'live');
      if (_hasLiveT) _livePhaseEnter('tennis');
      let _drainedT = false;
      for (const match of matches) {
        if (match.status !== 'live' && !_drainedT) {
          if (_hasLiveT) _livePhaseExit('tennis');
          await _waitOthersLiveDone('tennis');
          _drainedT = true;
        }
        const key = `tennis_${match.id}`;
        const prev = analyzedTennis.get(key);
        const isLivePhase = match.status === 'live';
        const phaseTipSent = isLivePhase ? prev?.tipSentLive : prev?.tipSentPre;
        if (phaseTipSent) {
          log('DEBUG', 'AUTO-TENNIS', `Skip ${match.team1} vs ${match.team2} (${match.status}): tip já enviada nesta fase`);
          continue;
        }
        // Live: 15min | Pré-jogo: 6h (configurável)
        const cooldown = isLivePhase ? TENNIS_LIVE_INTERVAL : TENNIS_PREGAME_INTERVAL;
        const phaseTs = isLivePhase ? (prev?.tsLive || 0) : (prev?.tsPre || 0);
        if (phaseTs && (now - phaseTs < cooldown)) {
          log('DEBUG', 'AUTO-TENNIS', `Skip ${match.team1} vs ${match.team2} (${match.status}): cooldown ${Math.round((cooldown-(now-phaseTs))/1000)}s restante`);
          continue;
        }

        const o = match.odds;
        if (!o?.t1 || !o?.t2) {
          log('DEBUG', 'AUTO-TENNIS', `Skip ${match.team1} vs ${match.team2} (${match.status}): odds incompletas (t1=${o?.t1||'null'} t2=${o?.t2||'null'})`);
          continue;
        }

        const isLiveTennis = match.status === 'live';
        if (!isOddsFresh(o, isLiveTennis)) {
          log('INFO', 'AUTO-TENNIS', `Odds stale (${oddsAgeStr(o)}): ${match.team1} vs ${match.team2} — pulando`);
          continue;
        }
        logOddsHistory('tennis', match.id, match.team1, match.team2, o);

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

        // Superfície: ESPN event tem priority, senão usa detectSurface (lista completa
        // com Barcelona, Hamburg, Lyon, Bastad, Kitzbuhel, Gstaad, Marrakech, Rio, etc).
        // Fix 2026-04-17: lista local era curta — Barcelona caía em 'dura' quebrando Elo.
        const { detectSurface: _detectSurfaceTn } = require('./lib/tennis-model');
        const surface = espnEvent?.surface || _detectSurfaceTn(match.league || '');
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

        // ── Pré-filtro ML com Dados do ML (Form/H2H DB + Ranking ESPN) ──
        const [dbForm1, dbForm2, dbH2h] = await Promise.all([
          serverGet(`/team-form?team=${encodeURIComponent(match.team1)}&game=tennis&days=730&limit=20`).catch(() => null),
          serverGet(`/team-form?team=${encodeURIComponent(match.team2)}&game=tennis&days=730&limit=20`).catch(() => null),
          serverGet(`/h2h?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}&game=tennis&days=730&limit=15`).catch(() => null),
        ]);

        // ── Elo ML model (surface-adjusted, from Sackmann data) ──
        // r1/r2/totalVig already computed above
        const imp1Elo = r1 / totalVig;
        const imp2Elo = r2 / totalVig;

        const eloResult = await serverGet(
          `/tennis-elo?p1=${encodeURIComponent(match.team1)}&p2=${encodeURIComponent(match.team2)}&surface=${surface}&imp1=${imp1Elo.toFixed(4)}&imp2=${imp2Elo.toFixed(4)}`
        ).catch(() => null);

        // Sofascore enrichment (cobertura superior a ESPN em challengers/WTA 250/ITF)
        let sofaEnrich = null;
        let serveStats1 = null, serveStats2 = null;
        let liveScoreData = null;
        try {
          const sofascoreTennis = require('./lib/sofascore-tennis');
          sofaEnrich = await sofascoreTennis.enrichMatch(match.team1, match.team2, match.time).catch(() => null);
          if (sofaEnrich) {
            log('DEBUG', 'AUTO-TENNIS', `Sofascore event ${sofaEnrich.eventId}: ${match.team1} vs ${match.team2}`);
            // Serve/return stats dos últimos 5 matches (apenas se event encontrado — evita requests perdidos)
            [serveStats1, serveStats2] = await Promise.all([
              sofaEnrich.player1Id ? sofascoreTennis.getPlayerServeStats(sofaEnrich.player1Id, 5).catch(() => null) : null,
              sofaEnrich.player2Id ? sofascoreTennis.getPlayerServeStats(sofaEnrich.player2Id, 5).catch(() => null) : null,
            ]);
            // Live score: placar em tempo real para partidas ao vivo
            if (isLiveTennis) {
              liveScoreData = await sofascoreTennis.getLiveScore(sofaEnrich.eventId).catch(() => null);
              if (liveScoreData?.isLive) {
                log('DEBUG', 'AUTO-TENNIS', `Live score ${match.team1} vs ${match.team2}: sets ${liveScoreData.setsHome}-${liveScoreData.setsAway} | set ${liveScoreData.currentSet}`);
              } else if (liveScoreData?.isFinished) {
                log('INFO', 'AUTO-TENNIS', `Partida já finalizada (Sofascore): ${match.team1} vs ${match.team2} — pulando`);
                await new Promise(r => setTimeout(r, 500)); continue;
              }
            }
          } else if (isLiveTennis) {
            // Tenta buscar live score diretamente sem enrichMatch (pode ser mais rápido)
            liveScoreData = await sofascoreTennis.getLiveMatchScore(match.team1, match.team2, match.time).catch(() => null);
            if (liveScoreData) liveScoreData = liveScoreData.liveScore;
            if (liveScoreData?.isFinished) {
              log('INFO', 'AUTO-TENNIS', `Partida já finalizada (Sofascore direct): ${match.team1} vs ${match.team2} — pulando`);
              await new Promise(r => setTimeout(r, 500)); continue;
            }
          }
        } catch (_) {}

        // Fallback em cascata: DB → Sofascore → ranking
        const rankEnrich = rankingToEnrich(rank1, rank2, surface);
        const pickForm = (db, sofa, rank) => {
          if (db && (db.wins + db.losses) >= 3) return db;
          if (sofa && (sofa.wins + sofa.losses) >= 3) return sofa;
          return rank || null;
        };
        const pickH2h = (db, sofa) => {
          if (db && db.totalMatches > 0) return db;
          if (sofa && sofa.totalMatches > 0) return sofa;
          return { t1Wins: 0, t2Wins: 0, totalMatches: 0 };
        };
        const tennisEnrich = {
          form1: pickForm(dbForm1, sofaEnrich?.form1, rankEnrich?.form1),
          form2: pickForm(dbForm2, sofaEnrich?.form2, rankEnrich?.form2),
          h2h: pickH2h(dbH2h, sofaEnrich?.h2h),
          oddsMovement: null
        };

        // Usa override ML env para tênis com base 4.0pp — exige edge mais robusto para reduzir false positives
        const envScoreBase = process.env.TENNIS_MIN_EDGE ? parseFloat(process.env.TENNIS_MIN_EDGE) : 4.0;

        // ── Modelo Tennis Específico (Elo + Serve/Return + Fatigue + H2H Surface) ──
        let tennisModelResult = null;
        try {
          const surfaceForModel = detectSurface(match.league || '');
          const tennisModelEnrich = {
            ...tennisEnrich,
            ranking1: rank1 ? parseInt(String(rank1).replace(/[^\d]/g, ''), 10) || null : null,
            ranking2: rank2 ? parseInt(String(rank2).replace(/[^\d]/g, ''), 10) || null : null,
            serveStats1, serveStats2,
          };
          tennisModelResult = getTennisProbability(db, match, o, tennisModelEnrich, surfaceForModel || surface);
          if (tennisModelResult && tennisModelResult.confidence > 0.3) {
            log('DEBUG', 'TENNIS-MODEL', `${match.team1} vs ${match.team2}: P1=${(tennisModelResult.modelP1*100).toFixed(1)}% conf=${tennisModelResult.confidence.toFixed(2)} factors=${tennisModelResult.factors?.join('+')}`);
          }
        } catch(e) { log('DEBUG', 'TENNIS-MODEL', `Erro: ${e.message}`); }

        let mlResultTennis;
        if (tennisModelResult && tennisModelResult.confidence >= 0.4) {
          // Modelo específico de tennis tem confiança suficiente — usar como primário
          const edgePp = Math.max(
            (tennisModelResult.modelP1 - (r1 / totalVig)) * 100,
            (tennisModelResult.modelP2 - (r2 / totalVig)) * 100
          );
          mlResultTennis = {
            pass: edgePp >= envScoreBase,
            modelP1: tennisModelResult.modelP1,
            modelP2: tennisModelResult.modelP2,
            score: edgePp,
            factorCount: tennisModelResult.factors?.length || 1,
            direction: tennisModelResult.modelP1 > tennisModelResult.modelP2 ? 't1' : 't2',
            _tennisModel: tennisModelResult,
            _eloResult: eloResult,
          };
          // Se Elo antigo também está disponível, faz blend
          if (eloResult && eloResult.found1 && eloResult.found2 && eloResult.score > 0) {
            mlResultTennis.modelP1 = mlResultTennis.modelP1 * 0.6 + eloResult.modelP1 * 0.4;
            mlResultTennis.modelP2 = 1 - mlResultTennis.modelP1;
            const blendEdge = Math.max(
              (mlResultTennis.modelP1 - (r1 / totalVig)) * 100,
              (mlResultTennis.modelP2 - (r2 / totalVig)) * 100
            );
            mlResultTennis.score = blendEdge;
            mlResultTennis.pass = blendEdge >= envScoreBase;
          }
        } else if (eloResult && eloResult.found1 && eloResult.found2) {
          // Fallback: Elo antigo (sem modelo específico com confiança)
          mlResultTennis = {
            pass: eloResult.score >= envScoreBase,
            modelP1: eloResult.modelP1,
            modelP2: eloResult.modelP2,
            score: eloResult.score,
            factorCount: eloResult.factorCount,
            direction: eloResult.direction,
            _eloResult: eloResult,
          };
        } else {
          // Fallback: ranking-based esportsPreFilter
          mlResultTennis = esportsPreFilter(match, o, tennisEnrich || { form1: null, form2: null, h2h: null, oddsMovement: null }, false, '', null);
          if (mlResultTennis.factorCount >= 1 && mlResultTennis.score < envScoreBase) {
            mlResultTennis.pass = false;
          } else {
            mlResultTennis.pass = true;
          }
        }

        if (!mlResultTennis.pass) {
          log('INFO', 'AUTO-TENNIS', `Pré-filtro ML: edge insuficiente (${mlResultTennis.score.toFixed(1)}pp) para ${match.team1} vs ${match.team2}. Pulando IA.`);
          await new Promise(r => setTimeout(r, 500)); continue;
        }

        const hasModelDataTennis = mlResultTennis.factorCount > 0;
        const usingEloModel = !!(eloResult && eloResult.found1 && eloResult.found2);
        // Fair odds sempre disponíveis: quando sem ranking, modelP1=impliedP1 (de-juice puro)
        const modelP1Tennis = (mlResultTennis.modelP1 * 100).toFixed(1);
        const modelP2Tennis = (mlResultTennis.modelP2 * 100).toFixed(1);
        const fairLabelTennis = usingEloModel
          ? 'P modelo (Elo superfície)'
          : (hasModelDataTennis ? 'P modelo (ML H2H/Ranking)' : 'Fair odds (de-juice, sem ranking/ML)');

        // Montar seção de dados reais
        let dataSection = [
          rank1 ? `Ranking ${match.team1}: ${rank1}` : null,
          rank2 ? `Ranking ${match.team2}: ${rank2}` : null,
          form1 ? `Form ${match.team1} (torneio atual): ${form1}` : null,
          form2 ? `Form ${match.team2} (torneio atual): ${form2}` : null,
          espnEvent ? `Torneio em andamento: ${espnEvent.eventName}` : null
        ].filter(Boolean).join('\n');

        if (usingEloModel) {
          const er = eloResult;
          if (er.found1) dataSection += `\nElo ${match.team1}: ${er.elo1} (${er.eloMatches1} partidas, ${er.surfMatches1} em ${surfacePT})`;
          if (er.found2) dataSection += `\nElo ${match.team2}: ${er.elo2} (${er.eloMatches2} partidas, ${er.surfMatches2} em ${surfacePT})`;
          if (!er.found1) dataSection += `\nElo ${match.team1}: não encontrado no histórico`;
          if (!er.found2) dataSection += `\nElo ${match.team2}: não encontrado no histórico`;
        }

        if (dbH2h && (dbH2h.t1Wins + dbH2h.t2Wins > 0)) {
           dataSection += `\nHistórico Direto (H2H): ${match.team1} ${dbH2h.t1Wins} x ${dbH2h.t2Wins} ${match.team2}`;
        }
        if (dbForm1 && dbForm1.totalGames > 0) {
           dataSection += `\nForma geral (${match.team1}): ${dbForm1.wins}W-${dbForm1.losses}L (${dbForm1.winRate}%)`;
        }
        if (dbForm2 && dbForm2.totalGames > 0) {
           dataSection += `\nForma geral (${match.team2}): ${dbForm2.wins}W-${dbForm2.losses}L (${dbForm2.winRate}%)`;
        }

        // Live score section — placar e momentum em tempo real
        if (isLiveTennis && liveScoreData?.isLive) {
          const ls = liveScoreData;
          const setsLine = ls.sets.map(s => `${s.home}-${s.away}`).join(', ');
          const gameLine = (ls.currentGameHome != null && ls.currentGameAway != null)
            ? `Game atual: ${ls.currentGameHome}-${ls.currentGameAway}` : '';
          const servingLine = ls.serving === 'home' ? `Sacando: ${match.team1}` : ls.serving === 'away' ? `Sacando: ${match.team2}` : '';
          // Momentum: quem ganhou mais games no set atual
          const curSet = ls.sets[ls.sets.length - 1];
          let momentumLine = '';
          if (curSet) {
            const diff = curSet.home - curSet.away;
            if (Math.abs(diff) >= 2) {
              momentumLine = `Momentum: ${diff > 0 ? match.team1 : match.team2} lidera ${Math.max(curSet.home, curSet.away)}-${Math.min(curSet.home, curSet.away)} no set atual`;
            }
          }
          dataSection += `\n\nPLACAR AO VIVO:`;
          dataSection += `\nSets: ${match.team1} ${ls.setsHome} x ${ls.setsAway} ${match.team2}`;
          if (setsLine) dataSection += `\nDetalhe sets: ${setsLine}`;
          if (gameLine) dataSection += `\n${gameLine}`;
          if (servingLine) dataSection += `\n${servingLine}`;
          if (momentumLine) dataSection += `\n${momentumLine}`;
        }

        // Serve/return stats (últimos 5 matches — identifica specialists de superfície com saque fraco)
        const fmtServe = (name, s) => {
          if (!s || s.games < 2) return null;
          return `${name} (últ. ${s.games}): 1ºsv ${s.firstServePct ?? '?'}% | pts 1ºsv ${s.firstServePointsPct ?? '?'}% | pts 2ºsv ${s.secondServePointsPct ?? '?'}% | BP saved ${s.breakPointsSavedPct ?? '?'}% | aces ${s.acesPerMatch}/m | DFs ${s.dfsPerMatch}/m`;
        };
        const svLine1 = fmtServe(match.team1, serveStats1);
        const svLine2 = fmtServe(match.team2, serveStats2);
        if (svLine1 || svLine2) {
          dataSection += `\n\nSERVE/RETURN STATS:\n${[svLine1, svLine2].filter(Boolean).join('\n')}`;
        }

        const hasRealData = !!(rank1 || rank2 || form1 || form2 || dbH2h || usingEloModel);

        const fairOddsLineTennis = hasModelDataTennis
          ? `${fairLabelTennis}: ${match.team1}=${modelP1Tennis}% | ${match.team2}=${modelP2Tennis}%\nP de-juiced bookie: ${match.team1}=${fairP1}% | ${match.team2}=${fairP2}%`
          : `${fairLabelTennis}: ${match.team1}=${modelP1Tennis}% | ${match.team2}=${modelP2Tennis}% (use como mínimo — sem ranking para ajustar o prior)`;

        const newsSectionTennis = await fetchMatchNews('tennis', match.team1, match.team2).catch(() => '');

        const hasLiveScore = isLiveTennis && liveScoreData?.isLive;
        const liveInstructions = hasLiveScore ? `
ANÁLISE IN-PLAY (PARTIDA AO VIVO):
- O placar atual está nos DADOS acima. Use-o para avaliar momentum e probabilidade condicional.
- Considere: quem está sacando, vantagem de break, sets já ganhos.
- Odds ao vivo já refletem o placar — edge in-play requer análise mais profunda (fadiga, estilo vs momento do jogo, clutch ability).
- Se um jogador perdeu o 1º set mas é favorito claro no Elo, pode haver valor se odds reagiram excessivamente.
- Se placar é equilibrado e odds são próximas: SEM_EDGE (mercado eficiente in-play).
` : '';

        const prompt = `Você é um analista especializado em tênis profissional. Seja MUITO conservador — prefira SEM_EDGE a apostar em margem duvidosa. Só dê tip quando o edge for claro e robusto.

PARTIDA: ${match.team1} vs ${match.team2}
Torneio: ${match.league} | ${eventType}
Status: ${isLiveTennis ? 'AO VIVO' : 'PRÉ-JOGO'} | Superfície: ${surfacePT} | Data: ${matchTime} (BRT)

ODDS REAIS (${o.bookmaker || 'EU'}):
${match.team1}: ${o.t1} | ${match.team2}: ${o.t2}
Margem bookie: ${marginPct}%
${fairOddsLineTennis}
${isFav1 ? match.team1 : match.team2} é o favorito do mercado.

${dataSection ? `DADOS REAIS (ESPN/DB):\n${dataSection}\n` : 'AVISO: sem dados ESPN/DB disponíveis — use apenas conhecimento de treino confiável.\n'}${newsSectionTennis ? `${newsSectionTennis}\n` : ''}${liveInstructions}
INSTRUÇÕES:
1. Analise: ranking, superfície (peso ALTO — clay specialists, grass specialists), H2H direto, forma recente (últimos 5 jogos), estilo de jogo vs superfície.
2. O modelo Elo calculou: ${match.team1}=${modelP1Tennis}% | ${match.team2}=${modelP2Tennis}% (${fairLabelTennis}).
   - Use o modelo como ÂNCORA. Só desvie se tiver motivo CONCRETO (H2H dominante, lesão confirmada, forma terrível recente, especialista em superfície).
   - Sem motivo concreto para desviar → SEM_EDGE.
3. Se identificar edge: calcule EV = (sua_prob/100 * odd) - 1. Exija EV ≥ +5%.
4. Confiança (1-10): baseada em quão bem conhece os jogadores E na superfície.
   - Dados insuficientes ou dúvida sobre contexto atual → máximo 6 → SEM_EDGE.
   - Apenas ALTA (≥8) ou MÉDIA (7): exige edge claro. BAIXA (≤6): apenas se edge > +8%.

DECISÃO:
- P × odd ≥ 1.05 E confiança ≥ 7: TIP_ML:[jogador]@[odd]|P:[%]|STAKE:[1-3]u|CONF:[ALTA/MÉDIA/BAIXA] (P = sua prob 0-100 inteiro; sistema calcula EV automaticamente)
- Caso contrário: SEM_EDGE

Máximo 200 palavras. Raciocínio breve antes da decisão.`;

        log('INFO', 'AUTO-TENNIS', `Analisando: ${match.team1} vs ${match.team2} | ${match.league} | ${surfacePT}${usingEloModel ? ' [Elo]' : (hasRealData ? ' [ESPN/DB+]' : '')}`);
        analyzedTennis.set(key, Object.assign({}, prev || {}, { ts: now, [isLivePhase ? 'tsLive' : 'tsPre']: now }));

        let resp;
        try {
          resp = await serverPost('/claude', {
            model: 'deepseek-chat',
            max_tokens: 450,
            messages: [{ role: 'user', content: prompt }]
          });
        } catch(e) {
          log('WARN', 'AUTO-TENNIS', `AI error: ${e.message}`);
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
        let tipMatch2 = _parseTipMl(text);

        if (tipMatch2) {
          const _pickIsT1V = norm(tipMatch2[1].trim()) === norm(match.team1)
            || norm(match.team1).includes(norm(tipMatch2[1].trim()))
            || norm(tipMatch2[1].trim()).includes(norm(match.team1));
          const _modelPV = _pickIsT1V ? mlResultTennis.modelP1 : mlResultTennis.modelP2;
          const _v = _validateTipPvsModel(text, _modelPV);
          if (!_v.valid) {
            log('WARN', 'AUTO-TENNIS', `Tip rejeitada (${match.team1} vs ${match.team2}): ${_v.reason}`);
            tipMatch2 = null;
          } else {
            // Gate divergência modelo vs Pinnacle (tennis Pinnacle é sharp em ATP/WTA).
            const _impPair = _impliedFromOdds(o);
            const _impPV = _impPair ? (_pickIsT1V ? _impPair.impliedP1 : _impPair.impliedP2) : null;
            const _maxDivTennis = parseFloat(process.env.TENNIS_MAX_DIVERGENCE_PP ?? '12');
            const _div = _sharpDivergenceGate({ oddsObj: o, modelP: _modelPV, impliedP: _impPV, maxPp: _maxDivTennis });
            if (!_div.ok) {
              log('WARN', 'AUTO-TENNIS', `Tip rejeitada (${match.team1} vs ${match.team2}): ${_div.reason}`);
              tipMatch2 = null;
            }
          }
        }

        if (!tipMatch2) {
          log('INFO', 'AUTO-TENNIS', `Sem tip: ${match.team1} vs ${match.team2}`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        const tipPlayer = tipMatch2[1].trim();
        const tipOdd    = parseFloat(tipMatch2[2]);
        const tipEvIa   = parseFloat(tipMatch2[3]); // EV reportado pela IA
        const tipStake  = tipMatch2[4];
        const tipConf   = tipMatch2[5].toUpperCase();

        // Recalcula EV via modelP (Elo/ML) — IA tende a inflar EV em underdogs.
        const _pickIsT1Tn = norm(tipPlayer) === norm(match.team1)
          || norm(match.team1).includes(norm(tipPlayer))
          || norm(tipPlayer).includes(norm(match.team1));
        const _modelPPickTn = _pickIsT1Tn ? mlResultTennis.modelP1 : mlResultTennis.modelP2;
        const _detEvTn = _modelEv(_modelPPickTn, tipOdd);
        const tipEV = _detEvTn != null ? _detEvTn : tipEvIa;
        if (_detEvTn != null && Math.abs(_detEvTn - tipEvIa) >= 3) {
          log('INFO', 'EV-RECALC', `tennis ${match.team1} vs ${match.team2}: IA=${tipEvIa}% → modelo=${_detEvTn}% (P=${(_modelPPickTn*100).toFixed(1)}% @ ${tipOdd})`);
        }

        if (tipOdd < TENNIS_GATE_MIN_ODDS || tipOdd > TENNIS_GATE_MAX_ODDS) {
          log('INFO', 'AUTO-TENNIS', `Gate odds: ${tipOdd} fora do range ${TENNIS_GATE_MIN_ODDS}-${TENNIS_GATE_MAX_ODDS}`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }
        if (tipEV < 7.0) {
          log('INFO', 'AUTO-TENNIS', `Gate EV: ${tipEV}% < 7%`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }
        if (tipEV > 15) {
          log('INFO', 'AUTO-TENNIS', `EV alto (${tipEV}%): ${tipPlayer} @ ${tipOdd} | P=${(_modelPPickTn*100).toFixed(1)}% | Elo ${_pickIsT1Tn?mlResultTennis.elo1:mlResultTennis.elo2}/${_pickIsT1Tn?mlResultTennis.elo2:mlResultTennis.elo1}`);
        }
        // Small-sample gate: Elo com poucos jogos gera EV inflado por ruído.
        // Se qualquer jogador tem <10 partidas no DB OU <5 na superfície, exige EV ≥ 10% e confiança ≥ MÉDIA.
        if (usingEloModel) {
          const er = eloResult;
          const minAll  = Math.min(er.eloMatches1, er.eloMatches2);
          const minSurf = Math.min(er.surfMatches1, er.surfMatches2);
          const smallSample = minAll < 10 || minSurf < 5;
          if (smallSample) {
            if (tipEV < 10.0) {
              log('INFO', 'AUTO-TENNIS', `Gate small-sample: EV ${tipEV}% < 10% (min jogos=${minAll}, superfície=${minSurf})`);
              await new Promise(r => setTimeout(r, 3000)); continue;
            }
            if (tipConf === 'BAIXA') {
              log('INFO', 'AUTO-TENNIS', `Gate small-sample: conf BAIXA rejeitada (min jogos=${minAll}, superfície=${minSurf})`);
              await new Promise(r => setTimeout(r, 3000)); continue;
            }
          }
        } else {
          // Sem Elo (fallback ranking): ainda mais conservador
          if (tipEV < 10.0) {
            log('INFO', 'AUTO-TENNIS', `Gate sem-Elo: EV ${tipEV}% < 10%`);
            await new Promise(r => setTimeout(r, 3000)); continue;
          }
        }
        // Confiança BAIXA: requer edge ML forte (≥6pp) para compensar incerteza
        if (tipConf === 'BAIXA' && mlResultTennis.score < 6.0) {
          log('INFO', 'AUTO-TENNIS', `Gate conf BAIXA: ML-edge ${mlResultTennis.score.toFixed(1)}pp < 6.0pp — rejeitado: ${match.team1} vs ${match.team2}`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        // ── Re-validação de odds AO VIVO antes do DM ──
        // Em sets decisivos as odds tennis Pinnacle podem mexer 30-50% em poucos minutos.
        // Se odds atuais movem >12% contra a tip (favorito virou underdog ou pick virou favorito),
        // aborta — usuário receberia tip com odd já desatualizada.
        if (isLiveTennis) {
          try {
            const fresh = await serverGet(`/tennis-matches`).catch(() => null);
            const freshM = Array.isArray(fresh) ? fresh.find(x => String(x.id) === String(match.id)) : null;
            if (freshM?.odds?.t1 && freshM?.odds?.t2) {
              const pickIsT1Fresh = norm(tipPlayer) === norm(match.team1);
              const freshPickOdd = parseFloat(pickIsT1Fresh ? freshM.odds.t1 : freshM.odds.t2);
              const tipOddNum = parseFloat(tipOdd);
              if (Number.isFinite(freshPickOdd) && freshPickOdd > 1 && tipOddNum > 1) {
                const driftPct = ((tipOddNum - freshPickOdd) / tipOddNum) * 100;
                // drift positivo = mercado precificou pra pior (odd diminuiu) → edge sumiu
                if (driftPct > 12) {
                  log('WARN', 'AUTO-TENNIS', `Odds stale: tip @ ${tipOddNum} mas mercado agora ${freshPickOdd} (drift ${driftPct.toFixed(1)}%) — abortando ${tipPlayer}`);
                  await new Promise(r => setTimeout(r, 3000)); continue;
                }
              }
            }
          } catch (_) {}
        }

        const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' }[tipConf] || '🟡';
        const surfaceEmoji = { saibro: '🟤', grama: '💚', dura: '🔵' }[surface] || '🎾';
        const grandSlamBadge = isGrandSlam ? ' 🏆' : isMasters ? ' ⭐' : '';

        const whyLineTennis = tipReasonTennis ? `\n🧠 Por quê: _${tipReasonTennis}_\n` : '\n';
        const minTakeOdds = calcMinTakeOdds(tipOdd);
        const minTakeLine = minTakeOdds ? `📉 Odd mínima: *${minTakeOdds}*\n` : '';
        // Linha de placar live na mensagem do Telegram
        let liveScoreLine = '';
        if (hasLiveScore) {
          const ls = liveScoreData;
          const setsDetail = ls.sets.map(s => `${s.home}-${s.away}`).join(' · ');
          liveScoreLine = `📊 Placar: *${ls.setsHome}-${ls.setsAway}* (${setsDetail})\n`;
        }

        const tipMsg = `🎾 💰 *TIP TÊNIS${isLiveTennis ? ' (AO VIVO 🔴)' : ''}*\n` +
          `*${match.team1}* vs *${match.team2}*\n` +
          `📋 ${match.league}${grandSlamBadge}\n` +
          `${surfaceEmoji} ${surface.charAt(0).toUpperCase() + surface.slice(1)} | 🕐 ${matchTime} (BRT)\n` +
          liveScoreLine + '\n' +
          whyLineTennis +
          `🎯 Aposta: *${tipPlayer}* @ *${tipOdd}*\n` +
          minTakeLine +
          `📈 EV: *+${tipEV}%* | De-juice: ${tipPlayer === match.team1 ? fairP1 : fairP2}%\n` +
          `💵 Stake: *${tipStake}u*\n` +
          `${confEmoji} Confiança: *${tipConf}*\n\n` +
          `⚠️ _Aposte com responsabilidade._`;

        const pickIsT1 = norm(tipPlayer) === norm(match.team1);
        const modelPPick = pickIsT1 ? mlResultTennis.modelP1 : mlResultTennis.modelP2;

        const desiredUnitsTennis = parseFloat(String(tipStake)) || 0;
        const riskAdjTennis = await applyGlobalRisk('tennis', desiredUnitsTennis, match.league);
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
          tipReason: tipReasonTennis,
          isShadow: tennisConfig.shadowMode ? 1 : 0,
          oddsFetchedAt: o._fetchedAt || null
        }, 'tennis');

        if (!rec?.tipId && !rec?.skipped) {
          log('WARN', 'AUTO-TENNIS', `record-tip falhou para ${tipPlayer} @ ${tipOdd} (${match.team1} vs ${match.team2}) — tip abortada`);
          await new Promise(r => setTimeout(r, 3000)); continue;
        }

        if (rec?.skipped) {
          analyzedTennis.set(key, Object.assign({}, analyzedTennis.get(key) || {}, { ts: now, [isLivePhase ? 'tipSentLive' : 'tipSentPre']: true, [isLivePhase ? 'tsLive' : 'tsPre']: now }));
          log('INFO', 'AUTO-TENNIS', `Tip duplicada (já registrada), Telegram ignorado: ${match.team1} vs ${match.team2}`);
          continue;
        }

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
        analyzedTennis.set(key, Object.assign({}, analyzedTennis.get(key) || {}, { ts: now, [isLivePhase ? 'tipSentLive' : 'tipSentPre']: true, [isLivePhase ? 'tsLive' : 'tsPre']: now }));
        log('INFO', 'AUTO-TENNIS', `Tip enviada${isLivePhase ? ' (LIVE)' : ''}: ${tipPlayer} @ ${tipOdd} | EV:${tipEV}% | ${tipConf}`);
        await new Promise(r => setTimeout(r, 5000));
      }
      if (!_drainedT && _hasLiveT) _livePhaseExit('tennis');
    } catch(e) {
      log('ERROR', 'AUTO-TENNIS', e.message);
      _livePhaseExit('tennis');
    }
    // Dual-mode: ciclo rápido (3min) se havia partidas live, lento (30min) se só upcoming
    if (!runOnce) {
      const hadLive = typeof _hasLiveT !== 'undefined' && _hasLiveT;
      const nextMs = hadLive ? TENNIS_POLL_LIVE_MS : TENNIS_POLL_IDLE_MS;
      log('INFO', 'AUTO-TENNIS', `Próximo ciclo em ${Math.round(nextMs / 1000)}s (${hadLive ? 'LIVE mode' : 'idle mode'})`);
      setTimeout(loop, nextMs);
    }
    return typeof matches !== 'undefined' ? matches : [];
  }
  const result = await loop();
  return runOnce ? (result || []) : undefined;
}

// ── Football Auto-analysis loop ──
async function pollFootball(runOnce = false) {
  const fbConfig = SPORTS['football'];
  if (!fbConfig?.enabled || !fbConfig?.token) return;
  const token = fbConfig.token;

  const { calcFootballScore } = require('./lib/football-ml');
  const footballData = require('./lib/football-data');
  const sofascoreFootball = require('./lib/sofascore-football');
  const apiFootball = require('./lib/api-football');

  const FOOTBALL_PREGAME_INTERVAL = 6 * 60 * 60 * 1000;
  const FOOTBALL_LIVE_INTERVAL = 10 * 60 * 1000; // live: re-análise a cada 10min
  const FOOTBALL_POLL_LIVE_MS = 3 * 60 * 1000;  // polling: 3min quando há live
  const FOOTBALL_POLL_IDLE_MS = 60 * 60 * 1000;  // polling: 1h idle
  const EV_THRESHOLD   = parseFloat(process.env.FOOTBALL_EV_THRESHOLD  || '5.0');
  const DRAW_MIN_ODDS  = parseFloat(process.env.FOOTBALL_DRAW_MIN_ODDS  || '2.80');

  // Formata array de resultados ['W','D','L',...] → string "WDLWW"
  function fmtForm(arr) {
    if (!Array.isArray(arr) || !arr.length) return 'N/D';
    return arr.slice(0, 5).join('');
  }

  async function loop() {
    try {
      log('INFO', 'AUTO-FOOTBALL', 'Iniciando verificação de partidas de Futebol...');
      const matches = await serverGet('/football-matches').catch(() => []);
      if (!Array.isArray(matches) || !matches.length) {
        if (!runOnce) setTimeout(loop, 60 * 60 * 1000);
        return [];
      }
      const hasFootballDataOrg = !!(process.env.FOOTBALL_DATA_TOKEN || process.env.FOOTBALL_DATA_KEY);
      const hasSofaProxy = !!(process.env.SOFASCORE_PROXY_BASE || '').trim();
      const hasApiFootball = !!(process.env.API_FOOTBALL_KEY || process.env.API_SPORTS_KEY || process.env.APISPORTS_KEY);
      const src = [hasFootballDataOrg && 'football-data.org', hasSofaProxy && 'Sofascore-proxy', hasApiFootball && 'api-football'].filter(Boolean).join('+') || 'odds-only';
      log('INFO', 'AUTO-FOOTBALL', `${matches.length} partidas futebol com odds (${src})`);

      const now = Date.now();
      // Prioridade: live primeiro
      matches.sort((a, b) => {
        const la = a.status === 'live' ? 0 : 1;
        const lb = b.status === 'live' ? 0 : 1;
        if (la !== lb) return la - lb;
        return new Date(a.time || 0) - new Date(b.time || 0);
      });
      const _hasLiveFb = matches.some(m => m.status === 'live');
      if (_hasLiveFb) _livePhaseEnter('football');
      let _drainedFb = false;
      for (const match of matches) {
        if (match.status !== 'live' && !_drainedFb) {
          if (_hasLiveFb) _livePhaseExit('football');
          await _waitOthersLiveDone('football');
          _drainedFb = true;
        }
        const key = `football_${match.id}`;
        const prev = analyzedFootball.get(key);
        if (prev?.tipSent) continue;
        const isFbLiveMatch = match.status === 'live';
        const fbCooldown = isFbLiveMatch ? FOOTBALL_LIVE_INTERVAL : FOOTBALL_PREGAME_INTERVAL;
        if (prev && (now - prev.ts < fbCooldown)) continue;

        const o = match.odds;
        if (!o?.h || !o?.d || !o?.a) continue;
        const isFbLive = match.status === 'live';
        if (!isOddsFresh(o, isFbLive)) {
          log('INFO', 'AUTO-FOOTBALL', `Odds stale (${oddsAgeStr(o)}): ${match.team1} vs ${match.team2} — pulando`);
          continue;
        }

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

        // Enrichment via football-data.org (se token disponível)
        let fixtureInfo = null;
        let homeFormData = null, awayFormData = null;
        let h2hData = { results: [] };
        let standingsData = {};
        let homeFatigue = 7, awayFatigue = 7;

        // Fallback: football-data.org (temporadas atuais, dependendo do plano/competição)
        if (!fixtureInfo && (process.env.FOOTBALL_DATA_TOKEN || process.env.FOOTBALL_DATA_KEY)) {
          try {
            const compCode = footballData.getCompetitionCode(match.sport_key);
            if (compCode) {
              const fx = await footballData.findScheduledMatchByTeams(compCode, match.team1, match.team2, match.time).catch(() => null);
              if (fx?.matchId && fx.homeId && fx.awayId) {
                fixtureInfo = { fixtureId: fx.matchId, homeId: fx.homeId, awayId: fx.awayId, leagueId: fx.competitionId, season: fx.seasonStartYear };
                standingsData = await footballData.getStandings(compCode).catch(() => ({})) || {};
                const [hf, af, hh] = await Promise.all([
                  footballData.getTeamRecentForm(fx.homeId, { competitionId: fx.competitionId, limit: 10 }).catch(() => null),
                  footballData.getTeamRecentForm(fx.awayId, { competitionId: fx.competitionId, limit: 10 }).catch(() => null),
                  footballData.getHeadToHead(fx.matchId, { limit: 10 }).catch(() => ({ results: [] })),
                ]);
                homeFormData = hf;
                awayFormData = af;
                h2hData = hh || { results: [] };
                homeFatigue = 7; awayFatigue = 7;
              }
            }
          } catch(_) {}
        }

        // Sofascore (via proxy TLS — ver SOFASCORE_PROXY_BASE) preenche forma/H2H quando football-data/DB vazios
        if (!fixtureInfo) {
          try {
            const ss = await sofascoreFootball.enrichMatch(match.team1, match.team2, match.time).catch(() => null);
            if (ss) {
              if (!homeFormData?.form?.length && ss.homeFormData?.form?.length) homeFormData = ss.homeFormData;
              if (!awayFormData?.form?.length && ss.awayFormData?.form?.length) awayFormData = ss.awayFormData;
              if (!h2hData?.results?.length && ss.h2hData?.results?.length) h2hData = ss.h2hData;
              if (ss.eventId) log('DEBUG', 'AUTO-FOOTBALL', `Sofascore event ${ss.eventId}: ${match.team1} vs ${match.team2}`);
            }
          } catch (_) {}
        }

        // api-football (api-sports.io): cobre ~900 ligas incluindo Superettan, Série B, La Liga 2 etc.
        // Só chama quando football-data.org e Sofascore não preencheram os dados
        if (!fixtureInfo && (!homeFormData?.form?.length || !awayFormData?.form?.length)) {
          try {
            const af = await apiFootball.enrichMatch(match.team1, match.team2, match.sport_key, match.time).catch(() => null);
            if (af) {
              if (!homeFormData?.form?.length && af.homeFormData?.form?.length) homeFormData = af.homeFormData;
              else if (!homeFormData && af.homeFormData) homeFormData = af.homeFormData;
              if (!awayFormData?.form?.length && af.awayFormData?.form?.length) awayFormData = af.awayFormData;
              else if (!awayFormData && af.awayFormData) awayFormData = af.awayFormData;
              if (!h2hData?.results?.length && af.h2hData?.results?.length) h2hData = af.h2hData;
              if (af.fixtureId) fixtureInfo = { fixtureId: af.fixtureId, homeId: null, awayId: null, leagueId: apiFootball.getLeagueId(match.sport_key), season: new Date().getFullYear() };
              if (af.homeFormData || af.awayFormData) log('DEBUG', 'AUTO-FOOTBALL', `api-football enrich OK: ${match.team1} vs ${match.team2}`);
            }
          } catch (_) {}
        }

        // Fallback final: usar base interna (match_results) para forma/H2H quando APIs falharem
        if (!fixtureInfo) {
          try {
            const [f1, f2, h2hDb] = await Promise.all([
              serverGet(`/team-form?team=${encodeURIComponent(match.team1)}&game=football`).catch(() => null),
              serverGet(`/team-form?team=${encodeURIComponent(match.team2)}&game=football`).catch(() => null),
              serverGet(`/h2h?team1=${encodeURIComponent(match.team1)}&team2=${encodeURIComponent(match.team2)}&game=football`).catch(() => null),
            ]);
            // Adaptar formato para calcFootballScore
            const toFormArr = (obj) => {
              const arr = Array.isArray(obj?.recent) ? obj.recent : null;
              return arr && arr.length ? arr : null;
            };
            const toAvgGoals = (obj, key) => (obj && typeof obj[key] === 'number') ? obj[key] : null;

            // Só sobrescreve forma se DB tiver dados e Sofascore/api-football ainda não preencheram
            if (f1 && toFormArr(f1) && !homeFormData?.form?.length) {
              homeFormData = {
                form: toFormArr(f1),
                homeForm: null,
                awayForm: null,
                goalsFor: toAvgGoals(f1, 'goalsFor'),
                goalsAgainst: toAvgGoals(f1, 'goalsAgainst'),
                games: f1?.totalGames || null
              };
            }
            if (f2 && toFormArr(f2) && !awayFormData?.form?.length) {
              awayFormData = {
                form: toFormArr(f2),
                homeForm: null,
                awayForm: null,
                goalsFor: toAvgGoals(f2, 'goalsFor'),
                goalsAgainst: toAvgGoals(f2, 'goalsAgainst'),
                games: f2?.totalGames || null
              };
            }
            if (h2hDb && Array.isArray(h2hDb.results) && h2hDb.results.length && !h2hData?.results?.length) {
              h2hData = { results: h2hDb.results.slice(0, 10) };
            }
          } catch(_) {}
        }

        // ── ML com dados reais (ou nulls se API indisponível) ──
        const homeStandings = fixtureInfo ? standingsData[fixtureInfo.homeId] : null;
        const awayStandings = fixtureInfo ? standingsData[fixtureInfo.awayId] : null;

        // Elo local (aprende só com resultados já liquidados no DB)
        let elo = null;
        try {
          const e = await serverGet(`/football-elo?home=${encodeURIComponent(match.team1)}&away=${encodeURIComponent(match.team2)}`).catch(() => null);
          if (e?.homeRating && e?.awayRating) elo = e;
        } catch (_) {}

        const mlScore = calcFootballScore(
          {
            form:         homeFormData?.form         || null,
            homeForm:     homeFormData?.homeForm      || null,
            goalsFor:     homeFormData?.goalsFor      ?? null,
            goalsAgainst: homeFormData?.goalsAgainst  ?? null,
            position:     homeStandings?.position     ?? null,
            fatigue:      homeFatigue,
            elo:          elo?.homeRating ?? null
          },
          {
            form:         awayFormData?.form         || null,
            awayForm:     awayFormData?.awayForm      || null,
            goalsFor:     awayFormData?.goalsFor      ?? null,
            goalsAgainst: awayFormData?.goalsAgainst  ?? null,
            position:     awayStandings?.position     ?? null,
            fatigue:      awayFatigue,
            elo:          elo?.awayRating ?? null
          },
          h2hData,
          oddsInput,
          { leagueId: fixtureInfo?.leagueId ?? null }
        );

        // ── Modelo Football Específico (Poisson + Elo + Form) ──
        let fbModel = null;
        try {
          const fbEnrich = {
            form1: homeFormData, form2: awayFormData,
            h2h: h2hData, standings: standingsData,
          };
          fbModel = getFootballProbability(db, match, o, fbEnrich);
          if (fbModel && fbModel.confidence > 0.3) {
            log('DEBUG', 'FB-MODEL', `${match.team1} vs ${match.team2}: pH=${(fbModel.pH*100).toFixed(1)}% pD=${(fbModel.pD*100).toFixed(1)}% pA=${(fbModel.pA*100).toFixed(1)}% conf=${fbModel.confidence.toFixed(2)} method=${fbModel.method}`);
            // Melhorar estimativa do mlScore com probabilidades do modelo Poisson
            if (mlScore && fbModel.pH > 0 && fbModel.pD > 0 && fbModel.pA > 0) {
              // Blend: 60% modelo específico, 40% ML genérico (quando disponível)
              const blend = 0.6;
              if (mlScore.pH) mlScore.pH = mlScore.pH * (1 - blend) + fbModel.pH * blend;
              if (mlScore.pD) mlScore.pD = mlScore.pD * (1 - blend) + fbModel.pD * blend;
              if (mlScore.pA) mlScore.pA = mlScore.pA * (1 - blend) + fbModel.pA * blend;
              // Normalizar
              const total = (mlScore.pH || 0) + (mlScore.pD || 0) + (mlScore.pA || 0);
              if (total > 0) { mlScore.pH /= total; mlScore.pD /= total; mlScore.pA /= total; }
              mlScore._fbModel = fbModel;
            }
          }
        } catch(e) { log('DEBUG', 'FB-MODEL', `Erro: ${e.message}`); }

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
        const hasRealData = !!(fixtureInfo || homeFormData?.form?.length || awayFormData?.form?.length || h2hData?.results?.length);
        if (hasRealData && homeFormData && awayFormData) {
          const hPos  = homeStandings ? `${homeStandings.position}º (${homeStandings.points}pts, ${homeStandings.played}J)` : 'N/D';
          const aPos  = awayStandings ? `${awayStandings.position}º (${awayStandings.points}pts, ${awayStandings.played}J)` : 'N/D';
          const h2hSummary = h2hData.results.length
            ? h2hData.results.slice(0, 5).map(r => `${r.home} ${r.homeGoals}-${r.awayGoals} ${r.away} (${r.date?.slice(0,10) || '?'})`).join('\n  ')
            : 'Sem H2H recente';
          contextBlock = `
DADOS QUANTITATIVOS (football-data.org / Sofascore / DB):
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
${hasRealData && contextBlock ? '' : `Fair odds (de-juice, sem dados quantitativos): Casa=${mktH}% | Empate=${mktD}% | Fora=${mktA}% — use como referência mínima; sua estimativa deve superar ≥8pp para ter edge real.\n`}Totais: ${ou25Line}
${contextBlock}${newsSection ? `\n${newsSection}\n` : ''}
INSTRUÇÕES:
1. ${hasRealData ? 'Use os dados quantitativos acima como base. Complemente com seu conhecimento contextual (lesões, motivação, histórico recente não capturado).' : 'Use seu conhecimento sobre os times nessa liga. Se não conhecer os times, seja conservador na estimativa de probabilidade e na confiança.'}
2. Estime probabilidades reais (home%, draw%, away%) somando 100%.
3. Calcule EV: EV = (prob/100 × odd) − 1 × 100
   Casa: (X/100 × ${oH} − 1) × 100 | Empate: (X/100 × ${oD} − 1) × 100 | Fora: (X/100 × ${oA} − 1) × 100
4. Para Over/Under 2.5, use médias de gols${hasRealData ? ' (já calculadas acima)' : ''} + contexto tático.
5. Confiança (1-10): ${hasRealData ? 'reflita incerteza residual após dados quantitativos.' : 'reflita quanto você conhece os times e o quão claro é o edge. Confiança 7+ só se o edge for real e você tiver base para estimar.'}
   - Empate com odds < ${DRAW_MIN_ODDS}? Raramente tem valor.

DECISÃO (melhor opção apenas):
- Edge (EV ≥ +${EV_THRESHOLD}%) E confiança ≥ 7:
  TIP_FB:[mercado]:[seleção]@[odd]|EV:[%]|P:[%]|STAKE:[1-3]u|CONF:[ALTA/MÉDIA/BAIXA] (P = sua prob 0-100; EV = (P/100×odd−1)×100)
  Mercados: 1X2_H, 1X2_D, 1X2_A, OVER_2.5, UNDER_2.5
- Caso contrário: SEM_EDGE

Máximo 200 palavras.`;

        log('INFO', 'AUTO-FOOTBALL', `Analisando: ${match.team1} vs ${match.team2} | ${match.league}${hasRealData ? ' [com dados]' : ' [sem dados]'}`);
        analyzedFootball.set(key, { ts: now, tipSent: false });

        let resp;
        try {
          resp = await serverPost('/claude', {
            model: 'deepseek-chat',
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }]
          });
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

        // Gate divergência modelo vs Pinnacle (football Pinnacle = sharp).
        {
          let _modelPFb = null, _impPFb = null;
          if (tipMarket === '1X2_H') { _modelPFb = mlScore.modelH ? mlScore.modelH/100 : null; _impPFb = parseFloat(mktH)/100; }
          else if (tipMarket === '1X2_D') { _modelPFb = mlScore.modelD ? mlScore.modelD/100 : null; _impPFb = parseFloat(mktD)/100; }
          else if (tipMarket === '1X2_A') { _modelPFb = mlScore.modelA ? mlScore.modelA/100 : null; _impPFb = parseFloat(mktA)/100; }
          else if (/OVER|UNDER/i.test(tipMarket) && o.ou25) {
            const oOver = parseFloat(o.ou25.over), oUnder = parseFloat(o.ou25.under);
            if (oOver > 1 && oUnder > 1) {
              const rO = 1/oOver, rU = 1/oUnder, vigOu = rO + rU;
              _impPFb = /OVER/i.test(tipMarket) ? rO/vigOu : rU/vigOu;
              _modelPFb = 1/tipOdd; // sem modelo dedicado pra OU; usa derivação simples
            }
          }
          if (_modelPFb != null && _impPFb != null) {
            const _maxDivFb = parseFloat(process.env.FOOTBALL_MAX_DIVERGENCE_PP ?? '10');
            const _div = _sharpDivergenceGate({ oddsObj: o, modelP: _modelPFb, impliedP: _impPFb, maxPp: _maxDivFb });
            if (!_div.ok) {
              log('WARN', 'AUTO-FOOTBALL', `Tip rejeitada (${match.team1} vs ${match.team2}, ${tipMarket}): ${_div.reason}`);
              await new Promise(r => setTimeout(r, 2000)); continue;
            }
          }
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
        const minTakeOdds = calcMinTakeOdds(tipOdd);
        const minTakeLine = minTakeOdds ? `📉 Odd mínima: *${minTakeOdds}*\n` : '';

        const tipMsg = `⚽ 💰 *TIP FUTEBOL*\n` +
          `*${match.team1}* vs *${match.team2}*\n` +
          `📋 ${match.league}\n` +
          `🕐 ${matchTime} (BRT)\n\n` +
          `🎯 Aposta: ${marketLabel} @ *${tipOdd}*\n` +
          minTakeLine +
          `📈 EV: *+${tipEV}%* | Mercado: ${probMkt}%${probMdl ? ` | Modelo: ${probMdl}%` : ''}\n` +
          `💵 Stake: *${tipStake}u*\n` +
          `${confEmoji} Confiança: *${tipConf}*\n` +
          (fixtureInfo && homeFormData ? `📊 Forma: ${fmtForm(homeFormData.form)} vs ${fmtForm(awayFormData?.form)}\n` : '') +
          `\n⚠️ _Aposte com responsabilidade._`;

        // API-Football removida: manter match_id como eventId do provedor de odds
        const recordMatchId = String(match.id);

        const desiredUnitsFb = parseFloat(String(tipStake)) || 0;
        const riskAdjFb = await applyGlobalRisk('football', desiredUnitsFb, match.league);
        if (!riskAdjFb.ok) { log('INFO', 'RISK', `football: bloqueada (${riskAdjFb.reason})`); await new Promise(r => setTimeout(r, 2000)); continue; }
        const tipStakeAdjFb = String(riskAdjFb.units.toFixed(1).replace(/\.0$/, ''));

        const fbModelP1 = mlScore?.modelH ? parseFloat(mlScore.modelH) / 100 : null;
        const fbModelP2 = mlScore?.modelA ? parseFloat(mlScore.modelA) / 100 : null;
        const fbModelPPick = tipMarket === '1X2_H' ? fbModelP1 : tipMarket === '1X2_A' ? fbModelP2 : (mlScore?.modelD ? parseFloat(mlScore.modelD) / 100 : null);
        const fbTipReason = text ? text.split('TIP_FB:')[0].trim().split('\n').filter(Boolean).pop()?.slice(0, 160) || null : null;

        const recFb = await serverPost('/record-tip', {
          matchId: recordMatchId, eventName: match.league,
          p1: match.team1, p2: match.team2, tipParticipant: tipTeam,
          odds: String(tipOdd), ev: String(tipEV), stake: tipStakeAdjFb,
          confidence: tipConf, isLive: false, market_type: tipMarket,
          modelP1: fbModelP1, modelP2: fbModelP2, modelPPick: fbModelPPick,
          modelLabel: elo ? 'football-elo+poisson' : 'football-poisson',
          tipReason: fbTipReason
        }, 'football');

        if (!recFb?.tipId && !recFb?.skipped) {
          log('WARN', 'AUTO-FOOTBALL', `record-tip falhou para ${tipTeam} @ ${tipOdd} (${match.team1} vs ${match.team2}) — tip abortada`);
          await new Promise(r => setTimeout(r, 2000)); continue;
        }

        if (recFb?.skipped) {
          analyzedFootball.set(key, { ts: now, tipSent: true });
          log('INFO', 'AUTO-FOOTBALL', `Tip duplicada (já registrada), Telegram ignorado: ${match.team1} vs ${match.team2}`);
          continue;
        }

        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('football')) continue;
          try { await sendDM(token, userId, tipMsg); } catch(_) {}
        }
        analyzedFootball.set(key, { ts: now, tipSent: true });
        log('INFO', 'AUTO-FOOTBALL', `Tip enviada: ${tipTeam} @ ${tipOdd} | ${tipMarket} | EV:${tipEV}% | ${tipConf}`);
        await new Promise(r => setTimeout(r, 5000));
      }
      if (!_drainedFb && _hasLiveFb) _livePhaseExit('football');
    } catch(e) {
      log('ERROR', 'AUTO-FOOTBALL', e.message);
      _livePhaseExit('football');
    }
    if (!runOnce) {
      const hadLiveFb = typeof _hasLiveFb !== 'undefined' && _hasLiveFb;
      const nextMs = hadLiveFb ? FOOTBALL_POLL_LIVE_MS : FOOTBALL_POLL_IDLE_MS;
      log('INFO', 'AUTO-FOOTBALL', `Próximo ciclo em ${Math.round(nextMs / 1000)}s (${hadLiveFb ? 'LIVE' : 'idle'})`);
      setTimeout(loop, nextMs);
    }
    return typeof matches !== 'undefined' ? matches : [];
  }
  const result = await loop();
  return runOnce ? (result || []) : undefined;
}

// ── Table Tennis loop (shadow-first) ──
// MVP conservador: Elo (empty no início, bootstrap via settlement) + Sofascore
// enrich (form/H2H) + esportsPreFilter. Sem IA no MVP — só ML-based.
// Shadow default: TABLETENNIS_SHADOW=false para promover.
async function pollTableTennis(runOnce = false) {
  const ttConfig = SPORTS['tabletennis'];
  if (!ttConfig?.enabled || !ttConfig?.token) return [];
  const token = ttConfig.token;

  const TT_INTERVAL = 30 * 60 * 1000; // 30 min (volume alto, match curto)
  const TT_MIN_ODDS = parseFloat(process.env.TABLETENNIS_MIN_ODDS ?? '1.40');
  const TT_MAX_ODDS = parseFloat(process.env.TABLETENNIS_MAX_ODDS ?? '4.00');
  const TT_MIN_EV = parseFloat(process.env.TABLETENNIS_MIN_EV ?? '5.0');
  const { getTableTennisElo } = require('./lib/tabletennis-ml');
  const sofaTT = require('./lib/sofascore-tabletennis');

  async function loop() {
    try {
      log('INFO', 'AUTO-TT', `Iniciando verificação de Table Tennis${ttConfig.shadowMode ? ' [SHADOW]' : ''}...`);
      const matches = await serverGet('/tabletennis-matches').catch(() => []);
      if (!Array.isArray(matches) || !matches.length) {
        log('INFO', 'AUTO-TT', '0 partidas TT com odds');
        if (!runOnce) setTimeout(loop, TT_INTERVAL);
        return [];
      }
      log('INFO', 'AUTO-TT', `${matches.length} partidas TT com odds`);

      const now = Date.now();
      // Filtra: só matches nas próximas 6h (pregame ou live) — TT tem matches curtos, não vale analisar semana inteira
      const windowMs = 6 * 60 * 60 * 1000;
      const relevant = matches.filter(m => {
        const t = new Date(m.time || 0).getTime();
        return t > 0 && (t - now) < windowMs && (t - now) > -60 * 60 * 1000; // até 1h no passado (live)
      });
      // Prioridade: live primeiro
      relevant.sort((a, b) => {
        const la = a.status === 'live' ? 0 : 1;
        const lb = b.status === 'live' ? 0 : 1;
        if (la !== lb) return la - lb;
        return new Date(a.time || 0) - new Date(b.time || 0);
      });
      if (!relevant.length) {
        log('INFO', 'AUTO-TT', '0 matches em janela de 6h');
        if (!runOnce) setTimeout(loop, TT_INTERVAL);
        return [];
      }
      const _hasLiveTT = relevant.some(m => m.status === 'live');
      if (_hasLiveTT) _livePhaseEnter('tabletennis');
      let _drainedTT = false;

      for (const match of relevant) {
        if (match.status !== 'live' && !_drainedTT) {
          if (_hasLiveTT) _livePhaseExit('tabletennis');
          await _waitOthersLiveDone('tabletennis');
          _drainedTT = true;
        }
        const key = `tt_${match.id}`;
        const prev = analyzedTT.get(key);
        if (prev?.tipSent) continue;
        if (prev && (now - prev.ts < 30 * 60 * 1000)) continue; // re-check 30min

        if (!match.odds?.t1 || !match.odds?.t2) continue;
        const isTTLive = match.status === 'live';
        if (!isOddsFresh(match.odds, isTTLive)) {
          log('INFO', 'AUTO-TT', `Odds stale (${oddsAgeStr(match.odds)}): ${match.team1} vs ${match.team2} — pulando`);
          continue;
        }
        const o1 = parseFloat(match.odds.t1);
        const o2 = parseFloat(match.odds.t2);
        if (!o1 || !o2 || o1 <= 1 || o2 <= 1) continue;

        // Odds range gate
        const bestOdd = Math.max(o1, o2);
        const worstOdd = Math.min(o1, o2);
        if (worstOdd < TT_MIN_ODDS || bestOdd > TT_MAX_ODDS + 10) {
          analyzedTT.set(key, { ts: now, tipSent: false });
          continue;
        }

        // Implied + Elo
        const r1 = 1 / o1, r2 = 1 / o2;
        const vig = r1 + r2;
        const impliedP1 = r1 / vig;
        const impliedP2 = r2 / vig;
        const elo = getTableTennisElo(db, match.team1, match.team2, impliedP1, impliedP2);

        // Enrich Sofascore (form + H2H)
        const sofa = await sofaTT.enrichMatch(match.team1, match.team2, match.time).catch(() => null);

        // Monta enrich pra esportsPreFilter
        const enrich = {
          form1: sofa?.form1 || null,
          form2: sofa?.form2 || null,
          h2h: sofa?.h2h || { t1Wins: 0, t2Wins: 0, totalMatches: 0 },
          oddsMovement: null,
        };

        const { esportsPreFilter } = require('./lib/ml');
        const mlResult = esportsPreFilter(match, match.odds, enrich, false, '', null);

        // Prioridade: Elo se confiável (both players in DB, ≥5 jogos cada), senão esportsPreFilter
        const useElo = elo.pass && elo.found1 && elo.found2 && Math.min(elo.eloMatches1, elo.eloMatches2) >= 5;
        const modelP1 = useElo ? elo.modelP1 : mlResult.modelP1;
        const modelP2 = useElo ? elo.modelP2 : mlResult.modelP2;
        const direction = useElo
          ? (elo.direction === 'p1' ? 't1' : elo.direction === 'p2' ? 't2' : null)
          : mlResult.direction;
        const mlScore = useElo ? elo.score : mlResult.score;
        const factorCount = useElo ? elo.factorCount : mlResult.factorCount;

        if (!direction || mlScore < 3.0) {
          analyzedTT.set(key, { ts: now, tipSent: false });
          log('INFO', 'AUTO-TT', `Sem edge: ${match.team1} vs ${match.team2} | edge=${mlScore.toFixed(1)}pp factors=${factorCount} ${useElo ? '[Elo]' : '[Sofa]'}`);
          continue;
        }

        const pickTeam = direction === 't1' ? match.team1 : match.team2;
        const pickOdd = direction === 't1' ? o1 : o2;
        const pickP = direction === 't1' ? modelP1 : modelP2;
        const evPct = (pickP * pickOdd - 1) * 100;

        if (evPct < TT_MIN_EV) {
          analyzedTT.set(key, { ts: now, tipSent: false });
          log('INFO', 'AUTO-TT', `EV baixo (${evPct.toFixed(1)}%): ${match.team1} vs ${match.team2}`);
          continue;
        }
        if (pickOdd < TT_MIN_ODDS || pickOdd > TT_MAX_ODDS) {
          analyzedTT.set(key, { ts: now, tipSent: false });
          continue;
        }

        // ── IA segunda opinião ──
        let _aiConfTT = null;
        if (/^(1|true|yes)$/i.test(String(process.env.TT_USE_AI ?? 'true'))) {
          const ctxLines = [
            `Odds: ${match.team1}@${o1} | ${match.team2}@${o2} (implied ${(impliedP1*100).toFixed(1)}%/${(impliedP2*100).toFixed(1)}%)`,
            `Elo: ${match.team1}=${elo.elo1||'?'} (${elo.eloMatches1||0}j) | ${match.team2}=${elo.elo2||'?'} (${elo.eloMatches2||0}j)`,
            sofa?.form1 || sofa?.form2 ? `Form Sofascore: ${match.team1}=${sofa.form1?.wins||0}V-${sofa.form1?.losses||0}D | ${match.team2}=${sofa.form2?.wins||0}V-${sofa.form2?.losses||0}D` : 'Form: Sofascore indisponível',
            sofa?.h2h?.totalMatches ? `H2H (${sofa.h2h.totalMatches}j): ${sofa.h2h.t1Wins}-${sofa.h2h.t2Wins}` : 'H2H: sem histórico',
            `Modelo: P1=${(modelP1*100).toFixed(1)}% P2=${(modelP2*100).toFixed(1)}% | edge=${mlScore.toFixed(1)}pp factors=${factorCount} ${useElo ? '[Elo]' : '[Sofa]'}`,
          ].filter(Boolean).join('\n');
          const aiR = await _aiSecondOpinion({
            sport: 'tt', matchLabel: `${match.team1} vs ${match.team2}`, league: match.league || '?',
            pickTeam, pickOdd, pickP, evPct, contextBlock: ctxLines, isLive: isTTLive,
            oddsObj: match.odds,
            impliedP: direction === 't1' ? impliedP1 : impliedP2,
            maxDivPp: parseFloat(process.env.TT_MAX_DIVERGENCE_PP ?? '20'),
          });
          if (!aiR.passed) {
            analyzedTT.set(key, { ts: now, tipSent: false });
            log('INFO', 'AUTO-TT', `IA bloqueou: ${aiR.reason} | ${pickTeam} @ ${pickOdd}`);
            continue;
          }
          _aiConfTT = aiR.conf;
        }

        // Kelly 1/8 conservador (sem IA → fração menor)
        const stake = calcKellyWithP(pickP, pickOdd, 1/8);
        if (stake === '0u') { analyzedTT.set(key, { ts: now, tipSent: false }); continue; }
        const desiredU = parseFloat(stake) || 0;
        const riskAdj = await applyGlobalRisk('tabletennis', desiredU, match.league);
        if (!riskAdj.ok) { log('INFO', 'RISK', `tabletennis: bloqueada (${riskAdj.reason})`); continue; }
        const stakeAdj = String(riskAdj.units.toFixed(1).replace(/\.0$/, ''));

        let conf = useElo && elo.eloMatches1 >= 20 && elo.eloMatches2 >= 20 ? 'ALTA'
                 : factorCount >= 2 ? 'MÉDIA' : 'BAIXA';
        if (_aiConfTT === 'BAIXA' || (_aiConfTT === 'MÉDIA' && conf === 'ALTA')) conf = _aiConfTT;
        const tipReason = useElo
          ? `Elo: ${match.team1}=${elo.elo1} (${elo.eloMatches1}j) vs ${match.team2}=${elo.elo2} (${elo.eloMatches2}j)`
          : `Sofa form/H2H: factors=${factorCount}, edge=${mlScore.toFixed(1)}pp`;

        const rec = await serverPost('/record-tip', {
          matchId: String(match.id), eventName: match.league,
          p1: match.team1, p2: match.team2, tipParticipant: pickTeam,
          odds: String(pickOdd), ev: evPct.toFixed(1), stake: stakeAdj,
          confidence: conf,
          isLive: match.status === 'live' ? 1 : 0,
          market_type: 'ML',
          modelP1, modelP2, modelPPick: pickP,
          modelLabel: useElo ? 'tabletennis-elo' : 'tabletennis-ml',
          tipReason,
          isShadow: ttConfig.shadowMode ? 1 : 0,
        }, 'tabletennis');

        if (!rec?.tipId && !rec?.skipped) {
          log('WARN', 'AUTO-TT', `record-tip falhou: ${pickTeam} @ ${pickOdd}`);
          continue;
        }
        analyzedTT.set(key, { ts: now, tipSent: true });
        if (rec?.skipped) continue;

        if (ttConfig.shadowMode) {
          log('INFO', 'AUTO-TT', `[SHADOW] ${pickTeam} @ ${pickOdd} | EV:${evPct.toFixed(1)}% | ${stakeAdj}u | ${conf} | ${tipReason}`);
          continue;
        }

        const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' }[conf] || '🟡';
        const fightTime = match.time ? new Date(match.time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
        const msg = `🏓 💰 *TIP TÊNIS DE MESA*\n\n` +
          `*${match.team1}* vs *${match.team2}*\n📋 ${match.league}\n🕐 ${fightTime} (BRT)\n\n` +
          `🎯 Aposta: *${pickTeam}* @ *${pickOdd}*\n` +
          `📈 EV: *+${evPct.toFixed(1)}%*\n` +
          `💵 Stake: *${stakeAdj}u*\n` +
          `${confEmoji} Confiança: *${conf}*\n` +
          `_${tipReason}_\n\n` +
          `⚠️ _Aposte com responsabilidade._`;

        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('tabletennis')) continue;
          try { await sendDM(token, userId, msg); } catch (_) {}
        }
        log('INFO', 'AUTO-TT', `Tip enviada: ${pickTeam} @ ${pickOdd} | EV:${evPct.toFixed(1)}% | ${conf}`);
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!_drainedTT && _hasLiveTT) _livePhaseExit('tabletennis');
    } catch (e) {
      log('ERROR', 'AUTO-TT', e.message);
      _livePhaseExit('tabletennis');
    }
    if (!runOnce) setTimeout(loop, TT_INTERVAL);
    return [];
  }
  const result = await loop();
  return runOnce ? (result || []) : undefined;
}

// ── CS2 loop (shadow inicial, mesma estrutura do TT) ──────────────────
async function pollCs(runOnce = false) {
  const csConfig = SPORTS['cs'];
  if (!csConfig?.enabled || !csConfig?.token) return [];
  const token = csConfig.token;

  const CS_POLL_LIVE_MS = 2 * 60 * 1000;  // 2min quando há live
  const CS_POLL_IDLE_MS = 5 * 60 * 1000;  // 5min idle
  let _hadLiveCs = false;
  const CS_MIN_ODDS = parseFloat(process.env.CS_MIN_ODDS ?? '1.40');
  const CS_MAX_ODDS = parseFloat(process.env.CS_MAX_ODDS ?? '4.50');
  const CS_MIN_EV = parseFloat(process.env.CS_MIN_EV ?? '5.0');
  const CS_MAX_DIVERGENCE_PP = parseFloat(process.env.CS_MAX_DIVERGENCE_PP ?? '12'); // gate Elo vs Pinnacle
  const CS_TIER2_MIN_EV = parseFloat(process.env.CS_TIER2_MIN_EV ?? '8.0');
  const CS_TIER2_MAX_STAKE = parseFloat(process.env.CS_TIER2_MAX_STAKE ?? '1.0');
  const CS_USE_AI = /^(1|true|yes)$/i.test(String(process.env.CS_USE_AI ?? 'true'));
  // Filtra DM por confiança: 'ALL' | 'ALTA' | 'ALTA_MEDIA'. Default ALL (sem gate).
  const CS_LIVE_CONF = String(process.env.CS_LIVE_CONF || 'ALL').toUpperCase();
  const { getCsElo } = require('./lib/cs-ml');
  const hltv = require('./lib/hltv');

  // Tier-1 keywords: Major, IEM/ESL/BLAST séries premier, Cologne/Katowice/Rio/Shanghai, EPL.
  const CS_TIER1_RE = /(major|iem\b|katowice|cologne|esl pro league|epl|blast premier|blast world|blast fall|blast spring|esports world cup|ewc|austin|rio|shanghai|paris)/i;
  const isCsTier1 = (league) => CS_TIER1_RE.test(String(league || ''));

  async function loop() {
    try {
      log('INFO', 'AUTO-CS', `Iniciando verificação de CS2${csConfig.shadowMode ? ' [SHADOW]' : ''}...`);
      const matches = await serverGet('/cs-matches').catch(() => []);
      if (!Array.isArray(matches) || !matches.length) {
        log('INFO', 'AUTO-CS', '0 partidas CS2 com odds');
        if (!runOnce) { const _n = _hadLiveCs ? CS_POLL_LIVE_MS : CS_POLL_IDLE_MS; log('INFO', 'AUTO-CS', `Próximo ciclo em ${Math.round(_n/1000)}s (${_hadLiveCs ? 'LIVE' : 'idle'})`); setTimeout(loop, _n); }
        return [];
      }
      log('INFO', 'AUTO-CS', `${matches.length} partidas CS2`);

      const now = Date.now();
      const windowMs = 6 * 60 * 60 * 1000;
      const relevant = matches.filter(m => {
        const t = new Date(m.time || 0).getTime();
        return t > 0 && (t - now) < windowMs && (t - now) > -3 * 60 * 60 * 1000;
      });
      // Prioridade: live primeiro
      relevant.sort((a, b) => {
        const la = a.status === 'live' ? 0 : 1;
        const lb = b.status === 'live' ? 0 : 1;
        if (la !== lb) return la - lb;
        return new Date(a.time || 0) - new Date(b.time || 0);
      });
      if (!relevant.length) {
        log('INFO', 'AUTO-CS', '0 matches em janela de 6h');
        if (!runOnce) { const _n = _hadLiveCs ? CS_POLL_LIVE_MS : CS_POLL_IDLE_MS; log('INFO', 'AUTO-CS', `Próximo ciclo em ${Math.round(_n/1000)}s (${_hadLiveCs ? 'LIVE' : 'idle'})`); setTimeout(loop, _n); }
        return [];
      }
      const _hasLiveCs = relevant.some(m => m.status === 'live');
      _hadLiveCs = _hasLiveCs;
      if (_hasLiveCs) _livePhaseEnter('cs');
      let _drainedCs = false;

      for (const match of relevant) {
        if (match.status !== 'live' && !_drainedCs) {
          if (_hasLiveCs) _livePhaseExit('cs');
          await _waitOthersLiveDone('cs');
          _drainedCs = true;
        }
        const isLiveCs = match.status === 'live';
        // Fase: pregame=0, mapN = s1+s2+1 durante live.
        // Cada fase pode gerar 1 tip própria; pregame não bloqueia map1, map1 não bloqueia map2.
        const csMapNum = isLiveCs ? ((Number(match.score1) || 0) + (Number(match.score2) || 0) + 1) : 0;
        const csMapTag = csMapNum > 0 ? `_MAP${csMapNum}` : '';
        const key = `cs_${match.id}_${csMapNum}`;
        const prev = analyzedCs.get(key);
        if (prev?.tipSent) continue;
        const csCooldown = isLiveCs ? (3 * 60 * 1000) : (30 * 60 * 1000); // live: 3min, pregame: 30min
        if (prev && (now - prev.ts < csCooldown)) continue;

        if (!match.odds?.t1 || !match.odds?.t2) continue;
        if (!isOddsFresh(match.odds, isLiveCs)) {
          log('INFO', 'AUTO-CS', `Odds stale (${oddsAgeStr(match.odds)}): ${match.team1} vs ${match.team2} — pulando`);
          continue;
        }
        const o1 = parseFloat(match.odds.t1);
        const o2 = parseFloat(match.odds.t2);
        if (!o1 || !o2 || o1 <= 1 || o2 <= 1) continue;

        const bestOdd = Math.max(o1, o2);
        const worstOdd = Math.min(o1, o2);
        if (worstOdd < CS_MIN_ODDS || bestOdd > CS_MAX_ODDS + 10) {
          analyzedCs.set(key, { ts: now, tipSent: false });
          continue;
        }

        const r1 = 1 / o1, r2 = 1 / o2;
        const vig = r1 + r2;
        const impliedP1 = r1 / vig;
        const impliedP2 = r2 / vig;
        const elo = getCsElo(db, match.team1, match.team2, impliedP1, impliedP2);

        const hltvData = await hltv.enrichMatch(match.team1, match.team2, match.time).catch(() => null);

        // Live-only: resolve HLTV match_id e lê scorebot (round, score, bomba, HP/money)
        let scoreboard = null;
        let hltvMatchId = null;
        if (match.status === 'live') {
          const found = await hltv.getHltvMatchId(match.team1, match.team2, match.time).catch(() => null);
          if (found?.matchId) {
            hltvMatchId = found.matchId;
            const raw = await hltv.getScoreboard(found.matchId, 10).catch(() => null);
            scoreboard = hltv.summarizeScoreboard(raw);
            if (scoreboard) {
              log('INFO', 'AUTO-CS', `Scorebot ${match.team1} vs ${match.team2}: ${scoreboard.mapName} ${scoreboard.scoreT}-${scoreboard.scoreCT} (round ${scoreboard.round})`);
            }
          }
        }

        const enrich = {
          form1: hltvData?.form1 || null,
          form2: hltvData?.form2 || null,
          h2h: hltvData?.h2h || { t1Wins: 0, t2Wins: 0, totalMatches: 0 },
          oddsMovement: null,
          liveContext: scoreboard,
        };

        const { esportsPreFilter } = require('./lib/ml');
        const mlResult = esportsPreFilter(match, match.odds, enrich, false, '', null);

        const useElo = elo.pass && elo.found1 && elo.found2 && Math.min(elo.eloMatches1, elo.eloMatches2) >= 5;
        const modelP1 = useElo ? elo.modelP1 : mlResult.modelP1;
        const modelP2 = useElo ? elo.modelP2 : mlResult.modelP2;
        const direction = useElo
          ? (elo.direction === 'p1' ? 't1' : elo.direction === 'p2' ? 't2' : null)
          : mlResult.direction;
        const mlScore = useElo ? elo.score : mlResult.score;
        const factorCount = useElo ? elo.factorCount : mlResult.factorCount;

        if (!direction || mlScore < 3.0) {
          analyzedCs.set(key, { ts: now, tipSent: false });
          log('INFO', 'AUTO-CS', `Sem edge: ${match.team1} vs ${match.team2} | edge=${mlScore.toFixed(1)}pp factors=${factorCount} ${useElo ? '[Elo]' : '[HLTV]'}`);
          continue;
        }

        const pickTeam = direction === 't1' ? match.team1 : match.team2;
        const pickOdd = direction === 't1' ? o1 : o2;
        const pickP = direction === 't1' ? modelP1 : modelP2;
        const pickImpliedP = direction === 't1' ? impliedP1 : impliedP2;
        const evPct = (pickP * pickOdd - 1) * 100;

        // Gate A: divergência modelo vs Pinnacle/Betfair (sharp anchor). >12pp = quase sempre erro do modelo.
        const _divCs = _sharpDivergenceGate({ oddsObj: match.odds, modelP: pickP, impliedP: pickImpliedP, maxPp: CS_MAX_DIVERGENCE_PP });
        const divergencePp = _divCs.divPp ?? 0;
        const isPinnacleOdds = /pinnacle/i.test(String(match.odds?.bookmaker || ''));
        if (!_divCs.ok) {
          analyzedCs.set(key, { ts: now, tipSent: false });
          log('INFO', 'AUTO-CS', `${_divCs.reason}: ${match.team1} vs ${match.team2}`);
          continue;
        }

        // Gate B: tier de liga. Não-Tier1 = mais conservador (EV mín ↑, stake máx ↓, conf máx MÉDIA).
        const isTier1 = isCsTier1(match.league);
        const minEvForTier = isTier1 ? CS_MIN_EV : CS_TIER2_MIN_EV;

        if (evPct < minEvForTier) {
          analyzedCs.set(key, { ts: now, tipSent: false });
          log('INFO', 'AUTO-CS', `EV baixo (${evPct.toFixed(1)}% < ${minEvForTier}% ${isTier1 ? 'tier1' : 'tier2+'}): ${match.team1} vs ${match.team2}`);
          continue;
        }
        if (pickOdd < CS_MIN_ODDS || pickOdd > CS_MAX_ODDS) {
          analyzedCs.set(key, { ts: now, tipSent: false });
          continue;
        }

        // Gate C: IA como segunda opinião (DeepSeek). Valida P do modelo Elo.
        // Se IA discorda fortemente de P (Δ>10pp pra ser tolerante a noise da IA), rejeita.
        let aiConf = null;
        let aiReason = null;
        if (CS_USE_AI) {
          const tierLabel = isTier1 ? 'TIER 1 (premier)' : 'TIER 2/3 (regional/academy)';
          const formStr = enrich.form1 && enrich.form2
            ? `Form últimos jogos: ${match.team1} ${(enrich.form1.wins||0)}V-${(enrich.form1.losses||0)}D | ${match.team2} ${(enrich.form2.wins||0)}V-${(enrich.form2.losses||0)}D`
            : 'Form: dados HLTV indisponíveis';
          const h2hStr = enrich.h2h && enrich.h2h.totalMatches > 0
            ? `H2H (${enrich.h2h.totalMatches} jogos): ${match.team1} ${enrich.h2h.t1Wins}V x ${enrich.h2h.t2Wins}V ${match.team2}`
            : 'H2H: sem histórico';
          const liveStr = scoreboard
            ? `\nLIVE: ${scoreboard.mapName} T:${scoreboard.scoreT}-CT:${scoreboard.scoreCT} round ${scoreboard.round}${scoreboard.bombPlanted ? ' (bomba)' : ''}`
            : '';
          const prompt = `Análise CS2 — ${match.team1} vs ${match.team2} (${match.league}) ${match.status === 'live' ? '[AO VIVO]' : '[PRÉ-JOGO]'}
Liga: ${tierLabel}
Odds Pinnacle: ${match.team1}@${o1} | ${match.team2}@${o2}
Implied: ${(impliedP1*100).toFixed(1)}% / ${(impliedP2*100).toFixed(1)}% (de-juiced)
Modelo Elo: ${match.team1}=${elo.elo1||'?'} (${elo.eloMatches1||0}j) | ${match.team2}=${elo.elo2||'?'} (${elo.eloMatches2||0}j)
Modelo P: ${(modelP1*100).toFixed(1)}% / ${(modelP2*100).toFixed(1)}%
${formStr}
${h2hStr}${liveStr}

Pick proposta pelo modelo: ${pickTeam} @ ${pickOdd} (P=${(pickP*100).toFixed(1)}%, EV=${evPct.toFixed(1)}%)

Avalie:
1. P do modelo é razoável dado contexto (roster, tier, form, H2H)?
2. Se for time academy/feeder ou tier 3-4, modelo pode estar inflando edge.
3. Pinnacle é sharp em CS — se modelo diverge muito de Pinnacle (>10pp) sem razão clara, modelo está errado.

DECISÃO:
TIP_ML:[time]@[odd]|P:[%]|STAKE:[1-3]u|CONF:[ALTA/MÉDIA/BAIXA]
(Só forneça P inteiro 0-100; sistema calcula EV. Use a MESMA pick do modelo se concordar.)
ou SEM_EDGE (se modelo está errado / dados insuficientes / time academy não confiável)

Máximo 150 palavras.`;

          let iaResp = '';
          try {
            const iaRaw = await serverPost('/claude', { messages: [{ role: 'user', content: prompt }], max_tokens: 350 }).catch(() => null);
            iaResp = iaRaw?.content?.[0]?.text || iaRaw?.result || iaRaw?.text || '';
          } catch (e) {
            log('WARN', 'AUTO-CS', `IA erro: ${e.message}`);
          }

          if (!iaResp || /SEM_EDGE/i.test(iaResp)) {
            analyzedCs.set(key, { ts: now, tipSent: false });
            log('INFO', 'AUTO-CS', `IA SEM_EDGE: ${pickTeam} @ ${pickOdd} (modelP=${(pickP*100).toFixed(1)}% EV=${evPct.toFixed(1)}%)`);
            continue;
          }

          const iaTip = _parseTipMl(iaResp);
          if (!iaTip) {
            analyzedCs.set(key, { ts: now, tipSent: false });
            log('INFO', 'AUTO-CS', `IA sem TIP_ML parseável: ${match.team1} vs ${match.team2}`);
            continue;
          }

          const iaPickIsT1 = norm(iaTip[1].trim()) === norm(match.team1)
            || norm(match.team1).includes(norm(iaTip[1].trim()))
            || norm(iaTip[1].trim()).includes(norm(match.team1));
          const iaPickedSamePick = (iaPickIsT1 && direction === 't1') || (!iaPickIsT1 && direction === 't2');
          if (!iaPickedSamePick) {
            analyzedCs.set(key, { ts: now, tipSent: false });
            log('INFO', 'AUTO-CS', `IA discorda da pick (modelo=${pickTeam}, IA=${iaTip[1].trim()}): rejeitado`);
            continue;
          }

          const _v = _validateTipPvsModel(iaResp, pickP, 10);
          if (!_v.valid) {
            analyzedCs.set(key, { ts: now, tipSent: false });
            log('WARN', 'AUTO-CS', `Tip rejeitada (${match.team1} vs ${match.team2}): ${_v.reason}`);
            continue;
          }
          aiConf = (iaTip[5] || '').toUpperCase().replace('MEDIA', 'MÉDIA');
          aiReason = String(iaResp).split('TIP_ML:')[0].trim().slice(0, 160) || null;
        }

        const stake = calcKellyWithP(pickP, pickOdd, 1/8);
        if (stake === '0u') { analyzedCs.set(key, { ts: now, tipSent: false }); continue; }
        const desiredU = parseFloat(stake) || 0;
        const riskAdj = await applyGlobalRisk('cs', desiredU, match.league);
        if (!riskAdj.ok) { log('INFO', 'RISK', `cs: bloqueada (${riskAdj.reason})`); continue; }
        let appliedUnits = riskAdj.units;
        // Cap de stake em tier 2+: limita exposição em ligas de menor confiabilidade do modelo.
        if (!isTier1 && appliedUnits > CS_TIER2_MAX_STAKE) appliedUnits = CS_TIER2_MAX_STAKE;
        const stakeAdj = String(appliedUnits.toFixed(1).replace(/\.0$/, ''));

        let conf = useElo && elo.eloMatches1 >= 20 && elo.eloMatches2 >= 20 ? 'ALTA'
                 : factorCount >= 2 ? 'MÉDIA' : 'BAIXA';
        // Cap de confiança em tier 2+: nunca ALTA em liga regional/academy.
        if (!isTier1 && conf === 'ALTA') conf = 'MÉDIA';
        // IA pode rebaixar confiança (mas não promover).
        if (aiConf === 'BAIXA' || (aiConf === 'MÉDIA' && conf === 'ALTA')) conf = aiConf;
        const liveCtx = scoreboard
          ? ` | LIVE ${scoreboard.mapName} T:${scoreboard.scoreT} CT:${scoreboard.scoreCT} r${scoreboard.round}${scoreboard.bombPlanted ? ' 💣' : ''}`
          : '';
        const tierTag = isTier1 ? '' : ' [tier2+]';
        const divTag = isPinnacleOdds ? ` | Δ${divergencePp.toFixed(1)}pp` : '';
        const aiTag = aiReason ? ` | IA: ${aiReason.slice(0, 80)}` : '';
        const tipReason = (useElo
          ? `Elo: ${match.team1}=${elo.elo1} (${elo.eloMatches1}j) vs ${match.team2}=${elo.elo2} (${elo.eloMatches2}j)${divTag}${tierTag}`
          : `HLTV form/H2H: factors=${factorCount}, edge=${mlScore.toFixed(1)}pp${divTag}${tierTag}`) + liveCtx + aiTag;

        const rec = await serverPost('/record-tip', {
          matchId: String(match.id) + csMapTag, eventName: match.league,
          p1: match.team1, p2: match.team2, tipParticipant: pickTeam,
          odds: String(pickOdd), ev: evPct.toFixed(1), stake: stakeAdj,
          confidence: conf,
          isLive: match.status === 'live' ? 1 : 0,
          market_type: 'ML',
          modelP1, modelP2, modelPPick: pickP,
          modelLabel: useElo ? 'cs-elo' : 'cs-ml',
          tipReason,
          isShadow: csConfig.shadowMode ? 1 : 0,
          sport: 'cs',
        }, 'cs');

        if (!rec?.tipId && !rec?.skipped) {
          log('WARN', 'AUTO-CS', `record-tip falhou: ${pickTeam} @ ${pickOdd}`);
          continue;
        }
        analyzedCs.set(key, { ts: now, tipSent: true });
        if (rec?.skipped) continue;

        if (csConfig.shadowMode) {
          log('INFO', 'AUTO-CS', `[SHADOW] ${pickTeam} @ ${pickOdd} | EV:${evPct.toFixed(1)}% | ${stakeAdj}u | ${conf} | ${tipReason}`);
          continue;
        }

        // Gate de confiança para saída do shadow: só envia DM se conf passar CS_LIVE_CONF.
        // 'ALTA' (default): só Elo com ≥20 jogos ambos lados.
        // 'ALTA_MEDIA': ALTA + MÉDIA (factors≥2).
        // 'ALL': sem filtro.
        const confAllowed = CS_LIVE_CONF === 'ALL'
          || (CS_LIVE_CONF === 'ALTA' && conf === 'ALTA')
          || (CS_LIVE_CONF === 'ALTA_MEDIA' && (conf === 'ALTA' || conf === 'MÉDIA'));
        if (!confAllowed) {
          log('INFO', 'AUTO-CS', `[GATE ${CS_LIVE_CONF}] ${pickTeam} @ ${pickOdd} | EV:${evPct.toFixed(1)}% | ${conf} — tip gravada mas DM suprimido`);
          continue;
        }

        const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' }[conf] || '🟡';
        const matchTime = match.time ? new Date(match.time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
        const phaseLabel = csMapNum > 0 ? ` — MAPA ${csMapNum} (série ${match.score1||0}-${match.score2||0})` : '';
        const msg = `🔫 💰 *TIP CS2${phaseLabel}*\n\n` +
          `*${match.team1}* vs *${match.team2}*\n📋 ${match.league}${match.format ? ` (${match.format})` : ''}\n🕐 ${matchTime} (BRT)\n\n` +
          `🎯 Aposta: *${pickTeam}* @ *${pickOdd}*\n` +
          `📈 EV: *+${evPct.toFixed(1)}%*\n` +
          `💵 Stake: *${stakeAdj}u*\n` +
          `${confEmoji} Confiança: *${conf}*\n` +
          `_${tipReason}_\n\n` +
          `⚠️ _Aposte com responsabilidade._`;

        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('cs')) continue;
          try { await sendDM(token, userId, msg); } catch (_) {}
        }
        log('INFO', 'AUTO-CS', `Tip enviada: ${pickTeam} @ ${pickOdd} | EV:${evPct.toFixed(1)}% | ${conf}`);
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!_drainedCs && _hasLiveCs) _livePhaseExit('cs');
    } catch (e) {
      log('ERROR', 'AUTO-CS', e.message);
      _livePhaseExit('cs');
    }
    if (!runOnce) setTimeout(loop, CS_INTERVAL);
    return [];
  }
  const result = await loop();
  return runOnce ? (result || []) : undefined;
}

// ── Valorant loop (fork de pollCs — sem HLTV scorebot) ────────────────
async function pollValorant(runOnce = false) {
  const valConfig = SPORTS['valorant'];
  if (!valConfig?.enabled || !valConfig?.token) return [];
  const token = valConfig.token;

  const VAL_POLL_LIVE_MS = 2 * 60 * 1000;
  const VAL_POLL_IDLE_MS = 5 * 60 * 1000;
  let _hadLiveVal = false;
  const VAL_MIN_ODDS = parseFloat(process.env.VALORANT_MIN_ODDS ?? '1.40');
  const VAL_MAX_ODDS = parseFloat(process.env.VALORANT_MAX_ODDS ?? '4.50');
  const VAL_MIN_EV = parseFloat(process.env.VALORANT_MIN_EV ?? '5.0');
  const VAL_LIVE_CONF = String(process.env.VALORANT_LIVE_CONF || 'ALL').toUpperCase();
  const { getValorantModel } = require('./lib/valorant-ml');

  async function loop() {
    try {
      log('INFO', 'AUTO-VAL', `Iniciando verificação de Valorant${valConfig.shadowMode ? ' [SHADOW]' : ''}...`);
      const matches = await serverGet('/valorant-matches').catch(() => []);
      if (!Array.isArray(matches) || !matches.length) {
        log('INFO', 'AUTO-VAL', '0 partidas Valorant com odds');
        if (!runOnce) { const _n = _hadLiveVal ? VAL_POLL_LIVE_MS : VAL_POLL_IDLE_MS; log('INFO', 'AUTO-VAL', `Próximo ciclo em ${Math.round(_n/1000)}s (${_hadLiveVal ? 'LIVE' : 'idle'})`); setTimeout(loop, _n); }
        return [];
      }
      log('INFO', 'AUTO-VAL', `${matches.length} partidas Valorant`);

      const now = Date.now();
      const windowMs = 6 * 60 * 60 * 1000;
      const relevant = matches.filter(m => {
        const t = new Date(m.time || 0).getTime();
        return t > 0 && (t - now) < windowMs && (t - now) > -3 * 60 * 60 * 1000;
      });
      relevant.sort((a, b) => {
        const la = a.status === 'live' ? 0 : 1;
        const lb = b.status === 'live' ? 0 : 1;
        if (la !== lb) return la - lb;
        return new Date(a.time || 0) - new Date(b.time || 0);
      });
      if (!relevant.length) {
        log('INFO', 'AUTO-VAL', '0 matches em janela de 6h');
        if (!runOnce) { const _n = _hadLiveVal ? VAL_POLL_LIVE_MS : VAL_POLL_IDLE_MS; log('INFO', 'AUTO-VAL', `Próximo ciclo em ${Math.round(_n/1000)}s (${_hadLiveVal ? 'LIVE' : 'idle'})`); setTimeout(loop, _n); }
        return [];
      }
      const _hasLiveVal = relevant.some(m => m.status === 'live');
      _hadLiveVal = _hasLiveVal;
      if (_hasLiveVal) _livePhaseEnter('valorant');
      let _drainedVal = false;

      for (const match of relevant) {
        if (match.status !== 'live' && !_drainedVal) {
          if (_hasLiveVal) _livePhaseExit('valorant');
          await _waitOthersLiveDone('valorant');
          _drainedVal = true;
        }
        const isLiveVal = match.status === 'live';
        const valMapNum = isLiveVal ? ((Number(match.score1) || 0) + (Number(match.score2) || 0) + 1) : 0;
        const valMapTag = valMapNum > 0 ? `_MAP${valMapNum}` : '';
        const key = `valorant_${match.id}_${valMapNum}`;
        const prev = analyzedValorant.get(key);
        if (prev?.tipSent) continue;
        const valCooldown = isLiveVal ? (3 * 60 * 1000) : (30 * 60 * 1000);
        if (prev && (now - prev.ts < valCooldown)) continue;

        if (!match.odds?.t1 || !match.odds?.t2) continue;
        if (!isOddsFresh(match.odds, isLiveVal)) {
          log('INFO', 'AUTO-VAL', `Odds stale (${oddsAgeStr(match.odds)}): ${match.team1} vs ${match.team2} — pulando`);
          continue;
        }
        const o1 = parseFloat(match.odds.t1);
        const o2 = parseFloat(match.odds.t2);
        if (!o1 || !o2 || o1 <= 1 || o2 <= 1) continue;

        const bestOdd = Math.max(o1, o2);
        const worstOdd = Math.min(o1, o2);
        if (worstOdd < VAL_MIN_ODDS || bestOdd > VAL_MAX_ODDS + 10) {
          analyzedValorant.set(key, { ts: now, tipSent: false });
          continue;
        }

        const r1 = 1 / o1, r2 = 1 / o2;
        const vig = r1 + r2;
        const impliedP1 = r1 / vig;
        const impliedP2 = r2 / vig;

        const boMatch = String(match.format || '').match(/Bo(\d+)/i);
        const bo = boMatch ? parseInt(boMatch[1], 10) : 3;

        // Live context via VLR.gg — PandaScore não dá mapa atual enquanto game roda,
        // nem lado (CT/Atk) nem score de rounds. VLR preenche esses gaps via scraping.
        let vlrLive = null;
        if (isLiveVal) {
          try {
            const vlr = require('./lib/vlr');
            const found = await vlr.findLiveMatch(match.team1, match.team2).catch(() => null);
            if (found?.matchId) {
              const stats = await vlr.getMatchStats(found.matchId).catch(() => null);
              if (stats) vlrLive = vlr.summarizeLive(stats, match.team1, match.team2);
              if (vlrLive) {
                const conf = vlrLive.sideConfident ? '✓' : (vlrLive.overtime ? 'OT' : '~');
                log('INFO', 'AUTO-VAL', `VLR[${conf}] ${match.team1} vs ${match.team2}: ${vlrLive.currentMap || '?'} R${vlrLive.currentRound} | ${vlrLive.t1.name} ${vlrLive.t1.score}(${vlrLive.t1.side}; CT${vlrLive.t1.ct}/A${vlrLive.t1.atk}) vs ${vlrLive.t2.name} ${vlrLive.t2.score}(${vlrLive.t2.side}; CT${vlrLive.t2.ct}/A${vlrLive.t2.atk})`);
              }
            }
          } catch (_) {}
        }
        // Usa VLR.currentMap quando PandaScore entregou null (partida em andamento de game N)
        const mapHint = match.currentMap || vlrLive?.currentMap || null;
        const ctx = { bo, score1: match.score1, score2: match.score2, currentMap: mapHint };
        const elo = getValorantModel(db, match.team1, match.team2, impliedP1, impliedP2, ctx);

        const useElo = elo.pass && elo.found1 && elo.found2 && Math.min(elo.eloMatches1, elo.eloMatches2) >= 5;
        if (!useElo) {
          analyzedValorant.set(key, { ts: now, tipSent: false });
          log('INFO', 'AUTO-VAL', `Sem Elo (${match.team1}=${elo.eloMatches1}j, ${match.team2}=${elo.eloMatches2}j): ${match.team1} vs ${match.team2}`);
          continue;
        }

        const modelP1 = elo.modelP1;
        const modelP2 = elo.modelP2;
        const direction = elo.direction === 'p1' ? 't1' : elo.direction === 'p2' ? 't2' : null;
        const mlScore = elo.score;
        const factorCount = elo.factorCount;

        if (elo.inSeriesAdjusted) {
          log('INFO', 'AUTO-VAL', `Série ${match.score1||0}-${match.score2||0} Bo${bo}: P mapa=${elo.mapP1.toFixed(3)} → P série=${modelP1.toFixed(3)}`);
        }

        if (!direction || mlScore < 3.0) {
          analyzedValorant.set(key, { ts: now, tipSent: false });
          log('INFO', 'AUTO-VAL', `Sem edge: ${match.team1} vs ${match.team2} | edge=${mlScore.toFixed(1)}pp`);
          continue;
        }

        const pickTeam = direction === 't1' ? match.team1 : match.team2;
        const pickOdd  = direction === 't1' ? o1 : o2;
        const pickP    = direction === 't1' ? modelP1 : modelP2;
        const evPct = (pickP * pickOdd - 1) * 100;

        if (evPct < VAL_MIN_EV) {
          analyzedValorant.set(key, { ts: now, tipSent: false });
          log('INFO', 'AUTO-VAL', `EV baixo (${evPct.toFixed(1)}%): ${match.team1} vs ${match.team2}`);
          continue;
        }
        if (pickOdd < VAL_MIN_ODDS || pickOdd > VAL_MAX_ODDS) {
          analyzedValorant.set(key, { ts: now, tipSent: false });
          continue;
        }

        // ── Gates específicos de LIVE (mitigam limitações do VLR) ──
        // Preview da confidence (mesma fórmula do bloco original abaixo).
        const _confPreview = (elo.eloMatches1 >= 20 && elo.eloMatches2 >= 20 && factorCount >= 3) ? 'ALTA'
                           : factorCount >= 2 ? 'MÉDIA' : 'BAIXA';
        if (isLiveVal) {
          const VAL_LIVE_MIN_EV_NO_VLR = parseFloat(process.env.VAL_LIVE_MIN_EV_NO_VLR || '8');
          const VAL_LIVE_MIN_EV_AMBIG  = parseFloat(process.env.VAL_LIVE_MIN_EV_AMBIG  || '6');
          if (!vlrLive) {
            // Sem contexto live: tip live às cegas (sem mapa/side/round). Endurece.
            if (evPct < VAL_LIVE_MIN_EV_NO_VLR) {
              analyzedValorant.set(key, { ts: now, tipSent: false });
              log('INFO', 'AUTO-VAL', `Gate live-sem-VLR: EV ${evPct.toFixed(1)}% < ${VAL_LIVE_MIN_EV_NO_VLR}% (partida live sem contexto) — rejeitado`);
              continue;
            }
            if (_confPreview === 'BAIXA') {
              analyzedValorant.set(key, { ts: now, tipSent: false });
              log('INFO', 'AUTO-VAL', `Gate live-sem-VLR: conf BAIXA rejeitada (sem contexto live)`);
              continue;
            }
          } else if (!vlrLive.sideConfident) {
            // VLR com side ambíguo (overtime ou sem round 1 parseável). EV mínimo maior.
            if (evPct < VAL_LIVE_MIN_EV_AMBIG) {
              analyzedValorant.set(key, { ts: now, tipSent: false });
              log('INFO', 'AUTO-VAL', `Gate live-ambíguo (${vlrLive.overtime ? 'OT' : 'sem round1'}): EV ${evPct.toFixed(1)}% < ${VAL_LIVE_MIN_EV_AMBIG}% — rejeitado`);
              continue;
            }
            if (_confPreview === 'BAIXA') {
              analyzedValorant.set(key, { ts: now, tipSent: false });
              log('INFO', 'AUTO-VAL', `Gate live-ambíguo: conf BAIXA rejeitada`);
              continue;
            }
          }
          // Mapa avançado (R20+ em half 2): resultado virtualmente decidido; rejeita tips novas.
          if (vlrLive && vlrLive.currentRound >= 20 && !vlrLive.overtime) {
            const leader = Math.max(vlrLive.t1.score, vlrLive.t2.score);
            const trailing = Math.min(vlrLive.t1.score, vlrLive.t2.score);
            if (leader >= 12 && (leader - trailing) >= 3) {
              analyzedValorant.set(key, { ts: now, tipSent: false });
              log('INFO', 'AUTO-VAL', `Gate map-closing: R${vlrLive.currentRound} ${vlrLive.t1.score}-${vlrLive.t2.score} — resultado próximo, tip rejeitada`);
              continue;
            }
          }
        }

        // ── IA segunda opinião ──
        if (/^(1|true|yes)$/i.test(String(process.env.VAL_USE_AI ?? 'true'))) {
          const ctx = [
            `Odds: ${match.team1}@${o1} | ${match.team2}@${o2} (implied ${(impliedP1*100).toFixed(1)}%/${(impliedP2*100).toFixed(1)}%)`,
            `Elo: ${match.team1}=${elo.elo1||'?'} (${elo.eloMatches1||0}j) | ${match.team2}=${elo.elo2||'?'} (${elo.eloMatches2||0}j)`,
            `Modelo: P1=${(modelP1*100).toFixed(1)}% P2=${(modelP2*100).toFixed(1)}% | edge ML=${mlScore.toFixed(1)}pp factors=${factorCount}`,
            vlrLive ? `LIVE VLR: ${vlrLive.currentMap||'?'} R${vlrLive.currentRound} | ${vlrLive.t1.name} ${vlrLive.t1.score}(${vlrLive.t1.side}) vs ${vlrLive.t2.name} ${vlrLive.t2.score}(${vlrLive.t2.side})` : (isLiveVal ? 'LIVE: sem contexto VLR' : 'Pré-jogo'),
            match.score1 != null || match.score2 != null ? `Série: ${match.score1||0}-${match.score2||0} (Bo${bo})` : '',
          ].filter(Boolean).join('\n');
          const aiR = await _aiSecondOpinion({
            sport: 'val', matchLabel: `${match.team1} vs ${match.team2}`, league: match.league || '?',
            pickTeam, pickOdd, pickP, evPct, contextBlock: ctx, isLive: isLiveVal,
            oddsObj: match.odds,
            impliedP: direction === 't1' ? impliedP1 : impliedP2,
            maxDivPp: parseFloat(process.env.VAL_MAX_DIVERGENCE_PP ?? '12'),
          });
          if (!aiR.passed) {
            analyzedValorant.set(key, { ts: now, tipSent: false });
            log('INFO', 'AUTO-VAL', `IA bloqueou: ${aiR.reason} | ${pickTeam} @ ${pickOdd}`);
            continue;
          }
          var _aiConfVal = aiR.conf || null;
        }

        const stake = calcKellyWithP(pickP, pickOdd, 1/8);
        if (stake === '0u') { analyzedValorant.set(key, { ts: now, tipSent: false }); continue; }
        const desiredU = parseFloat(stake) || 0;
        const riskAdj = await applyGlobalRisk('valorant', desiredU, match.league);
        if (!riskAdj.ok) { log('INFO', 'RISK', `valorant: bloqueada (${riskAdj.reason})`); continue; }
        const stakeAdj = String(riskAdj.units.toFixed(1).replace(/\.0$/, ''));

        let conf = (elo.eloMatches1 >= 20 && elo.eloMatches2 >= 20 && factorCount >= 3) ? 'ALTA'
                 : factorCount >= 2 ? 'MÉDIA' : 'BAIXA';
        // IA pode rebaixar (nunca promover)
        if (typeof _aiConfVal !== 'undefined') {
          if (_aiConfVal === 'BAIXA' || (_aiConfVal === 'MÉDIA' && conf === 'ALTA')) conf = _aiConfVal;
        }
        const formStr = (elo.form1 && elo.form2)
          ? ` | Form: ${(elo.form1.winRate*100).toFixed(0)}% (${elo.form1.games}j) vs ${(elo.form2.winRate*100).toFixed(0)}% (${elo.form2.games}j)`
          : '';
        const h2hStr = elo.h2h ? ` | H2H ${elo.h2h.t1Wins}-${elo.h2h.t2Wins}` : '';
        const mapStr = (elo.mapRate1 && elo.mapRate2 && elo.currentMap)
          ? ` | ${elo.currentMap}: ${(elo.mapRate1.winRate*100).toFixed(0)}%(${elo.mapRate1.games}j) vs ${(elo.mapRate2.winRate*100).toFixed(0)}%(${elo.mapRate2.games}j)`
          : '';
        const seriesStr = elo.inSeriesAdjusted
          ? ` | série ${match.score1||0}-${match.score2||0} Bo${bo}`
          : '';
        const liveStr = vlrLive
          ? ` | LIVE ${vlrLive.currentMap || '?'} R${vlrLive.currentRound} ${vlrLive.t1.score}-${vlrLive.t2.score} (CT ${vlrLive.t1.ct}/${vlrLive.t2.ct} | Atk ${vlrLive.t1.atk}/${vlrLive.t2.atk})`
          : '';
        const tipReason = `Elo: ${match.team1}=${elo.elo1} (${elo.eloMatches1}j) vs ${match.team2}=${elo.elo2} (${elo.eloMatches2}j)${formStr}${h2hStr}${mapStr}${seriesStr}${liveStr}`;

        const rec = await serverPost('/record-tip', {
          matchId: String(match.id) + valMapTag, eventName: match.league,
          p1: match.team1, p2: match.team2, tipParticipant: pickTeam,
          odds: String(pickOdd), ev: evPct.toFixed(1), stake: stakeAdj,
          confidence: conf,
          isLive: match.status === 'live' ? 1 : 0,
          market_type: 'ML',
          modelP1, modelP2, modelPPick: pickP,
          modelLabel: 'valorant-elo',
          tipReason,
          isShadow: valConfig.shadowMode ? 1 : 0,
          sport: 'valorant',
        }, 'valorant');

        if (!rec?.tipId && !rec?.skipped) {
          log('WARN', 'AUTO-VAL', `record-tip falhou: ${pickTeam} @ ${pickOdd}`);
          continue;
        }
        analyzedValorant.set(key, { ts: now, tipSent: true });
        if (rec?.skipped) continue;

        if (valConfig.shadowMode) {
          log('INFO', 'AUTO-VAL', `[SHADOW] ${pickTeam} @ ${pickOdd} | EV:${evPct.toFixed(1)}% | ${stakeAdj}u | ${conf} | ${tipReason}`);
          continue;
        }

        const confAllowed = VAL_LIVE_CONF === 'ALL'
          || (VAL_LIVE_CONF === 'ALTA' && conf === 'ALTA')
          || (VAL_LIVE_CONF === 'ALTA_MEDIA' && (conf === 'ALTA' || conf === 'MÉDIA'));
        if (!confAllowed) {
          log('INFO', 'AUTO-VAL', `[GATE ${VAL_LIVE_CONF}] ${pickTeam} @ ${pickOdd} | EV:${evPct.toFixed(1)}% | ${conf} — tip gravada mas DM suprimido`);
          continue;
        }

        const confEmoji = { ALTA: '🟢', MÉDIA: '🟡', BAIXA: '🔴' }[conf] || '🟡';
        const matchTime = match.time ? new Date(match.time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
        const phaseLabel = valMapNum > 0 ? ` — MAPA ${valMapNum} (série ${match.score1||0}-${match.score2||0})` : '';
        const msg = `🎯 💰 *TIP VALORANT${phaseLabel}*\n\n` +
          `*${match.team1}* vs *${match.team2}*\n📋 ${match.league}${match.format ? ` (${match.format})` : ''}\n🕐 ${matchTime} (BRT)\n\n` +
          `🎯 Aposta: *${pickTeam}* @ *${pickOdd}*\n` +
          `📈 EV: *+${evPct.toFixed(1)}%*\n` +
          `💵 Stake: *${stakeAdj}u*\n` +
          `${confEmoji} Confiança: *${conf}*\n` +
          `_${tipReason}_\n\n` +
          `⚠️ _Aposte com responsabilidade._`;

        for (const [userId, prefs] of subscribedUsers) {
          if (!prefs.has('valorant')) continue;
          try { await sendDM(token, userId, msg); } catch (_) {}
        }
        log('INFO', 'AUTO-VAL', `Tip enviada: ${pickTeam} @ ${pickOdd} | EV:${evPct.toFixed(1)}% | ${conf}`);
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!_drainedVal && _hasLiveVal) _livePhaseExit('valorant');
    } catch (e) {
      log('ERROR', 'AUTO-VAL', e.message);
      _livePhaseExit('valorant');
    }
    return [];
  }
  const result = await loop();
  return runOnce ? (result || []) : undefined;
}

// ── Darts loop (INDEPENDENTE de pollFootball) ──────────────────────────
// Motivo: dentro de pollFootball, Football serializa ~25min bloqueando
// darts/snooker. Loops separados garantem que rodem em intervalo próprio.
async function runAutoDarts() {
  const dartsConfig = SPORTS['darts'];
  if (!dartsConfig?.enabled) return;
  // Dual-mode: 5min quando há live, 15min idle
  const DARTS_POLL_LIVE_MS = 2 * 60 * 1000;     // polling: 2min quando há live
  const DARTS_POLL_IDLE_MS = 15 * 60 * 1000;    // polling: 15min idle
  const DARTS_LIVE_COOLDOWN = 3 * 60 * 1000;    // re-análise live: 3min
  const DARTS_PREGAME_COOLDOWN = 60 * 60 * 1000; // pregame: 1h
  let _hadLiveDarts = false;
  try {
      const { dartsPreFilter } = require('./lib/darts-ml');
      const sofaDarts = require('./lib/sofascore-darts');
      const now = Date.now();
      log('INFO', 'AUTO-DARTS', `Iniciando verificação de darts${dartsConfig.shadowMode ? ' [SHADOW]' : ''}...`);
      const matches = await serverGet('/darts-matches').catch(() => []);
      if (!Array.isArray(matches) || !matches.length) {
        log('INFO', 'AUTO-DARTS', '0 partidas darts com odds');
      } else {
        log('INFO', 'AUTO-DARTS', `${matches.length} partidas darts com odds`);
        // Prioridade: live primeiro
        matches.sort((a, b) => {
          const la = a.status === 'live' ? 0 : 1;
          const lb = b.status === 'live' ? 0 : 1;
          if (la !== lb) return la - lb;
          return new Date(a.time || 0) - new Date(b.time || 0);
        });
        _hadLiveDarts = matches.some(m => m.status === 'live');
        if (_hadLiveDarts) _livePhaseEnter('darts');
        let _drainedDarts = false;
        for (const match of matches) {
          const isLiveDarts = match.status === 'live';
          // Live-priority gate: ao primeiro upcoming, espera outros sports drenarem live
          if (!isLiveDarts && !_drainedDarts) {
            if (_hadLiveDarts) _livePhaseExit('darts');
            await _waitOthersLiveDone('darts');
            _drainedDarts = true;
          }
          const key = `darts_${match.id}`;
          const prev = analyzedDarts.get(key);
          if (prev?.tipSent) continue;
          const cooldown = isLiveDarts ? DARTS_LIVE_COOLDOWN : DARTS_PREGAME_COOLDOWN;
          if (prev && (now - prev.ts < cooldown)) continue;
          if (!isOddsFresh(match.odds, isLiveDarts)) {
            log('INFO', 'AUTO-DARTS', `Odds stale (${oddsAgeStr(match.odds)}): ${match.team1} vs ${match.team2} — pulando`);
            continue;
          }

          // Enriquecimento: 3-dart avg recente (últimos 10 jogos) + H2H entre os dois + live score se aplicável
          const [recentP1, recentP2, h2h, liveScore] = await Promise.all([
            match.playerId1 ? sofaDarts.getPlayerRecentAvg(match.playerId1, 10).catch(() => null) : null,
            match.playerId2 ? sofaDarts.getPlayerRecentAvg(match.playerId2, 10).catch(() => null) : null,
            (match.playerId1 && match.playerId2)
              ? sofaDarts.getHeadToHead(match.playerId1, match.playerId2).catch(() => null)
              : null,
            isLiveDarts && match.sofaEventId
              ? sofaDarts.getLiveScore(match.sofaEventId).catch(() => null)
              : null,
          ]);

          if (isLiveDarts && liveScore?.isFinished) {
            analyzedDarts.set(key, { ts: now, tipSent: false });
            log('INFO', 'AUTO-DARTS', `Partida finalizada (Sofascore): ${match.team1} vs ${match.team2} — pulando`);
            continue;
          }

          const enrich = {
            avgP1: recentP1?.avgLast || null,
            avgP2: recentP2?.avgLast || null,
            winRateP1: recentP1?.winRate || null,
            winRateP2: recentP2?.winRate || null,
            gamesP1: recentP1?.games || 0,
            gamesP2: recentP2?.games || 0,
            h2hP1Wins: h2h?.p1Wins ?? null,
            h2hP2Wins: h2h?.p2Wins ?? null,
            // checkoutP1/P2: TODO — extrair de getPlayerRecentAvg (já disponível no stats)
          };
          if (h2h) {
            log('DEBUG', 'AUTO-DARTS', `H2H ${match.team1} vs ${match.team2}: ${h2h.p1Wins}-${h2h.p2Wins}`);
          }
          if (liveScore?.isLive) {
            log('INFO', 'AUTO-DARTS', `Live ${match.team1} vs ${match.team2}: sets ${liveScore.setsHome}-${liveScore.setsAway} | leg ${liveScore.pointsHome ?? '?'}-${liveScore.pointsAway ?? '?'}`);
          }

          const ml = dartsPreFilter(match, enrich);
          if (!ml.pass) {
            analyzedDarts.set(key, { ts: now, tipSent: false });
            log('INFO', 'AUTO-DARTS', `Sem edge: ${match.team1} vs ${match.team2} | edge=${ml.score}pp factors=${ml.factorCount}`);
            continue;
          }

          // Direção, odd e stake Kelly
          const pickTeam = ml.direction === 't1' ? match.team1 : match.team2;
          const pickOdd = ml.direction === 't1' ? parseFloat(match.odds.t1) : parseFloat(match.odds.t2);
          const pickP   = ml.direction === 't1' ? ml.modelP1 : ml.modelP2;
          const evPct   = ((pickP * pickOdd - 1) * 100);

          // Guard live: não tippar quem está perdendo em sets por margem ≥ 2
          if (liveScore?.isLive && liveScore.setsHome != null && liveScore.setsAway != null) {
            const pickDiff = ml.direction === 't1'
              ? (liveScore.setsHome - liveScore.setsAway)
              : (liveScore.setsAway - liveScore.setsHome);
            if (pickDiff <= -2) {
              analyzedDarts.set(key, { ts: now, tipSent: false });
              log('INFO', 'AUTO-DARTS', `Live guard: ${pickTeam} perdendo ${liveScore.setsHome}-${liveScore.setsAway} em sets — tip rejeitada`);
              continue;
            }
          }

          const MIN_EV_DARTS = parseFloat(process.env.DARTS_MIN_EV || '5');
          if (evPct < MIN_EV_DARTS) {
            analyzedDarts.set(key, { ts: now, tipSent: false });
            log('INFO', 'AUTO-DARTS', `EV baixo (${evPct.toFixed(1)}% < ${MIN_EV_DARTS}%): ${match.team1} vs ${match.team2}`);
            continue;
          }
          if (ml.factorCount === 1 && evPct < 8) {
            analyzedDarts.set(key, { ts: now, tipSent: false });
            log('INFO', 'AUTO-DARTS', `BAIXA confiança (1 fator, EV ${evPct.toFixed(1)}%<8%): ${match.team1} vs ${match.team2}`);
            continue;
          }

          // ── IA segunda opinião ──
          let _aiConfDarts = null;
          if (/^(1|true|yes)$/i.test(String(process.env.DARTS_USE_AI ?? 'true'))) {
            const ctxLines = [
              `Odds: ${match.team1}@${match.odds.t1} | ${match.team2}@${match.odds.t2}`,
              `3-dart avg (últimos 10j): ${match.team1}=${enrich.avgP1 ?? 'n/a'} | ${match.team2}=${enrich.avgP2 ?? 'n/a'}`,
              `Win rate: ${match.team1}=${enrich.winRateP1 ?? 'n/a'}% (${enrich.gamesP1}j) | ${match.team2}=${enrich.winRateP2 ?? 'n/a'}% (${enrich.gamesP2}j)`,
              enrich.h2hP1Wins != null ? `H2H: ${enrich.h2hP1Wins}-${enrich.h2hP2Wins}` : 'H2H: sem histórico',
              `Modelo: P1=${(ml.modelP1*100).toFixed(1)}% P2=${(ml.modelP2*100).toFixed(1)}% | edge=${ml.score}pp factors=${ml.factorCount}`,
              liveScore?.isLive ? `LIVE: sets ${liveScore.setsHome}-${liveScore.setsAway} | leg ${liveScore.pointsHome ?? '?'}-${liveScore.pointsAway ?? '?'}` : '',
            ].filter(Boolean).join('\n');
            const _impDarts = _impliedFromOdds(match.odds);
            const aiR = await _aiSecondOpinion({
              sport: 'darts', matchLabel: `${match.team1} vs ${match.team2}`, league: match.league || '?',
              pickTeam, pickOdd, pickP, evPct, contextBlock: ctxLines, isLive: !!liveScore?.isLive,
              oddsObj: match.odds,
              impliedP: _impDarts ? (ml.direction === 't1' ? _impDarts.impliedP1 : _impDarts.impliedP2) : null,
              maxDivPp: parseFloat(process.env.DARTS_MAX_DIVERGENCE_PP ?? '15'),
            });
            if (!aiR.passed) {
              analyzedDarts.set(key, { ts: now, tipSent: false });
              log('INFO', 'AUTO-DARTS', `IA bloqueou: ${aiR.reason} | ${pickTeam} @ ${pickOdd}`);
              continue;
            }
            _aiConfDarts = aiR.conf;
          }

          // Kelly fracionado conservador (sem IA → 1/8 Kelly)
          const stake = calcKellyWithP(pickP, pickOdd, 1/8);
          if (stake === '0u') { analyzedDarts.set(key, { ts: now, tipSent: false }); continue; }
          const desiredU = parseFloat(stake) || 0;
          const riskAdj = await applyGlobalRisk('darts', desiredU, match.league);
          if (!riskAdj.ok) { log('INFO', 'RISK', `darts: bloqueada (${riskAdj.reason})`); continue; }
          const stakeAdj = String(riskAdj.units.toFixed(1).replace(/\.0$/, ''));

          const tipReason = `3-dart avg: ${match.team1}=${enrich.avgP1 ?? 'n/a'} vs ${match.team2}=${enrich.avgP2 ?? 'n/a'} | WR: ${enrich.winRateP1 ?? 'n/a'}% vs ${enrich.winRateP2 ?? 'n/a'}%`;

          let _confDarts = ml.factorCount >= 2 ? 'MÉDIA' : 'BAIXA';
          if (_aiConfDarts === 'BAIXA' || (_aiConfDarts === 'MÉDIA' && _confDarts !== 'BAIXA')) _confDarts = _aiConfDarts;
          // Registra tip com flag shadow
          const rec = await serverPost('/record-tip', {
            matchId: String(match.id), eventName: match.league,
            p1: match.team1, p2: match.team2, tipParticipant: pickTeam,
            odds: String(pickOdd), ev: evPct.toFixed(1), stake: stakeAdj,
            confidence: _confDarts,
            isLive: match.status === 'live' ? 1 : 0,
            market_type: 'ML',
            modelP1: ml.modelP1, modelP2: ml.modelP2, modelPPick: pickP,
            modelLabel: 'darts-ml (3DA + WR)',
            tipReason,
            isShadow: dartsConfig.shadowMode ? 1 : 0
          }, 'darts');

          if (!rec?.tipId && !rec?.skipped) {
            log('WARN', 'AUTO-DARTS', `record-tip falhou: ${pickTeam} @ ${pickOdd}`);
            continue;
          }
          analyzedDarts.set(key, { ts: now, tipSent: true });
          if (rec?.skipped) continue;

          // Shadow mode: NÃO envia DM — apenas loga
          if (dartsConfig.shadowMode) {
            log('INFO', 'AUTO-DARTS', `[SHADOW] Tip registrada: ${pickTeam} @ ${pickOdd} | EV:${evPct.toFixed(1)}% | ${stakeAdj}u | edge=${ml.score}pp`);
            continue;
          }

          const tipMsg = `🎯 💰 *TIP DARTS${isLiveDarts ? ' (AO VIVO 🔴)' : ''}*\n` +
            `*${match.team1}* vs *${match.team2}*\n📋 ${match.league}\n\n` +
            `🎯 Aposta: *${pickTeam}* @ *${pickOdd}*\n` +
            `📈 EV: *+${evPct.toFixed(1)}%*\n` +
            `💵 Stake: *${stakeAdj}u* _(1/8 Kelly)_\n` +
            `🧠 Por quê: _${tipReason}_\n\n` +
            `⚠️ _Aposte com responsabilidade._`;

          for (const [userId, prefs] of subscribedUsers) {
            if (!prefs.has('darts')) continue;
            try { await sendDM(dartsConfig.token, userId, tipMsg); } catch(_) {}
          }
          log('INFO', 'AUTO-DARTS', `Tip enviada: ${pickTeam} @ ${pickOdd} | EV:${evPct.toFixed(1)}%`);
          await new Promise(r => setTimeout(r, 3000));
        }
        if (!_drainedDarts && _hadLiveDarts) _livePhaseExit('darts');
      }
  } catch(e) {
    log('ERROR', 'AUTO-DARTS', e.message);
    _livePhaseExit('darts');
  }
  return _hadLiveDarts;
}

// ── Snooker loop (INDEPENDENTE do mutex runAutoAnalysis) ───────────────
async function runAutoSnooker() {
  const snookerConfig = SPORTS['snooker'];
  if (!snookerConfig?.enabled) return;
  const SNOOKER_LIVE_COOLDOWN = 3 * 60 * 1000;    // live: re-análise a cada 3min
  const SNOOKER_PREGAME_COOLDOWN = 60 * 60 * 1000; // pregame: 1h
  let _hadLiveSnooker = false;
  try {
      const { snookerPreFilter } = require('./lib/snooker-ml');
      const now = Date.now();
      log('INFO', 'AUTO-SNOOKER', `Iniciando verificação de snooker${snookerConfig.shadowMode ? ' [SHADOW]' : ''}...`);
      const matches = await serverGet('/snooker-matches').catch(() => []);
      if (!Array.isArray(matches) || !matches.length) {
        log('INFO', 'AUTO-SNOOKER', '0 partidas snooker com odds Betfair');
      } else {
        log('INFO', 'AUTO-SNOOKER', `${matches.length} partidas snooker com odds`);
        // Prioridade: live primeiro
        matches.sort((a, b) => {
          const la = a.status === 'live' ? 0 : 1;
          const lb = b.status === 'live' ? 0 : 1;
          if (la !== lb) return la - lb;
          return new Date(a.time || 0) - new Date(b.time || 0);
        });
        _hadLiveSnooker = matches.some(m => m.status === 'live');
        if (_hadLiveSnooker) _livePhaseEnter('snooker');
        let _drainedSnooker = false;
        for (const match of matches) {
          const isLiveSnooker = match.status === 'live';
          if (!isLiveSnooker && !_drainedSnooker) {
            if (_hadLiveSnooker) _livePhaseExit('snooker');
            await _waitOthersLiveDone('snooker');
            _drainedSnooker = true;
          }
          const key = `snooker_${match.id}`;
          const prev = analyzedSnooker.get(key);
          if (prev?.tipSent) continue;
          const cooldown = isLiveSnooker ? SNOOKER_LIVE_COOLDOWN : SNOOKER_PREGAME_COOLDOWN;
          if (prev && (now - prev.ts < cooldown)) continue;
          if (!isOddsFresh(match.odds, isLiveSnooker)) {
            log('INFO', 'AUTO-SNOOKER', `Odds stale (${oddsAgeStr(match.odds)}): ${match.team1} vs ${match.team2} — pulando`);
            continue;
          }

          // Enrichment via CueTracker (scraping HTML) — win rate da temporada atual.
          // Sem ranking oficial (snooker.org precisa email approval), mas win rate já
          // dá ao modelo o segundo fator necessário para gerar edge.
          const cuetracker = require('./lib/cuetracker');
          const [stats1, stats2, h2h] = await Promise.all([
            cuetracker.getPlayerStats(match.team1).catch(() => null),
            cuetracker.getPlayerStats(match.team2).catch(() => null),
            cuetracker.getHeadToHead(match.team1, match.team2).catch(() => null),
          ]);
          const enrich = {
            rankP1: null, rankP2: null,
            winRateP1: stats1?.winRate ?? null,
            winRateP2: stats2?.winRate ?? null,
            gamesP1: stats1?.totalMatches ?? 0,
            gamesP2: stats2?.totalMatches ?? 0,
            centuriesP1: stats1?.centuries ?? null,
            centuriesP2: stats2?.centuries ?? null,
            h2hP1Wins: h2h?.p1Wins ?? null,
            h2hP2Wins: h2h?.p2Wins ?? null,
          };
          if (stats1 || stats2) {
            log('DEBUG', 'AUTO-SNOOKER', `CueTracker: ${match.team1}=${stats1?.winRate ?? 'n/a'}% (${stats1?.totalMatches ?? 0} jogos) | ${match.team2}=${stats2?.winRate ?? 'n/a'}% (${stats2?.totalMatches ?? 0} jogos)${h2h ? ` | H2H ${h2h.p1Wins}-${h2h.p2Wins}` : ''}`);
          }

          const ml = snookerPreFilter(match, enrich);
          if (!ml.pass) {
            analyzedSnooker.set(key, { ts: now, tipSent: false });
            log('INFO', 'AUTO-SNOOKER', `Sem edge: ${match.team1} vs ${match.team2} | edge=${ml.score}pp factors=${ml.factorCount}`);
            continue;
          }

          const pickTeam = ml.direction === 't1' ? match.team1 : match.team2;
          const pickOdd = ml.direction === 't1' ? parseFloat(match.odds.t1) : parseFloat(match.odds.t2);
          const pickP   = ml.direction === 't1' ? ml.modelP1 : ml.modelP2;
          const evPct   = ((pickP * pickOdd - 1) * 100);
          if (evPct < 3) { analyzedSnooker.set(key, { ts: now, tipSent: false }); continue; }

          // ── IA segunda opinião ──
          let _aiConfSnooker = null;
          if (/^(1|true|yes)$/i.test(String(process.env.SNOOKER_USE_AI ?? 'true'))) {
            const ctxLines = [
              `Odds: ${match.team1}@${match.odds.t1} | ${match.team2}@${match.odds.t2} (${match.odds.bookmaker || 'Pinnacle'})`,
              `Win rate (temporada): ${match.team1}=${enrich.winRateP1 ?? 'n/a'}% (${enrich.gamesP1}j) | ${match.team2}=${enrich.winRateP2 ?? 'n/a'}% (${enrich.gamesP2}j)`,
              enrich.centuriesP1 != null ? `Centuries: ${match.team1}=${enrich.centuriesP1} | ${match.team2}=${enrich.centuriesP2}` : '',
              enrich.h2hP1Wins != null ? `H2H: ${enrich.h2hP1Wins}-${enrich.h2hP2Wins}` : 'H2H: sem histórico',
              `Modelo: P1=${(ml.modelP1*100).toFixed(1)}% P2=${(ml.modelP2*100).toFixed(1)}% | edge=${ml.score}pp factors=${ml.factorCount}`,
            ].filter(Boolean).join('\n');
            const _impSnooker = _impliedFromOdds(match.odds);
            const aiR = await _aiSecondOpinion({
              sport: 'snooker', matchLabel: `${match.team1} vs ${match.team2}`, league: match.league || '?',
              pickTeam, pickOdd, pickP, evPct, contextBlock: ctxLines, isLive: isLiveSnooker,
              oddsObj: match.odds,
              impliedP: _impSnooker ? (ml.direction === 't1' ? _impSnooker.impliedP1 : _impSnooker.impliedP2) : null,
              maxDivPp: parseFloat(process.env.SNOOKER_MAX_DIVERGENCE_PP ?? '15'),
            });
            if (!aiR.passed) {
              analyzedSnooker.set(key, { ts: now, tipSent: false });
              log('INFO', 'AUTO-SNOOKER', `IA bloqueou: ${aiR.reason} | ${pickTeam} @ ${pickOdd}`);
              continue;
            }
            _aiConfSnooker = aiR.conf;
          }

          const stake = calcKellyWithP(pickP, pickOdd, 1/8);
          if (stake === '0u') { analyzedSnooker.set(key, { ts: now, tipSent: false }); continue; }
          const desiredU = parseFloat(stake) || 0;
          const riskAdj = await applyGlobalRisk('snooker', desiredU, match.league);
          if (!riskAdj.ok) { log('INFO', 'RISK', `snooker: bloqueada (${riskAdj.reason})`); continue; }
          const stakeAdj = String(riskAdj.units.toFixed(1).replace(/\.0$/, ''));

          const tipReason = `Rank: ${match.team1}=${enrich.rankP1 ?? 'n/a'} vs ${match.team2}=${enrich.rankP2 ?? 'n/a'} | edge=${ml.score}pp`;

          let _confSnooker = ml.factorCount >= 2 ? 'MÉDIA' : 'BAIXA';
          if (_aiConfSnooker === 'BAIXA' || (_aiConfSnooker === 'MÉDIA' && _confSnooker !== 'BAIXA')) _confSnooker = _aiConfSnooker;
          const rec = await serverPost('/record-tip', {
            matchId: String(match.id), eventName: match.league,
            p1: match.team1, p2: match.team2, tipParticipant: pickTeam,
            odds: String(pickOdd), ev: evPct.toFixed(1), stake: stakeAdj,
            confidence: _confSnooker,
            isLive: match.status === 'live' ? 1 : 0,
            market_type: 'ML',
            modelP1: ml.modelP1, modelP2: ml.modelP2, modelPPick: pickP,
            modelLabel: 'snooker-ml (rank + WR)',
            tipReason,
            isShadow: snookerConfig.shadowMode ? 1 : 0
          }, 'snooker');

          if (!rec?.tipId && !rec?.skipped) {
            log('WARN', 'AUTO-SNOOKER', `record-tip falhou: ${pickTeam} @ ${pickOdd}`);
            continue;
          }
          analyzedSnooker.set(key, { ts: now, tipSent: true });
          if (rec?.skipped) continue;

          if (snookerConfig.shadowMode) {
            log('INFO', 'AUTO-SNOOKER', `[SHADOW] Tip: ${pickTeam} @ ${pickOdd} | EV:${evPct.toFixed(1)}% | ${stakeAdj}u | edge=${ml.score}pp`);
            continue;
          }

          const tipMsg = `🎱 💰 *TIP SNOOKER${isLiveSnooker ? ' (AO VIVO 🔴)' : ''}*\n` +
            `*${match.team1}* vs *${match.team2}*\n📋 ${match.league}\n\n` +
            `🎯 Aposta: *${pickTeam}* @ *${pickOdd}*\n` +
            `📈 EV: *+${evPct.toFixed(1)}%*\n` +
            `💵 Stake: *${stakeAdj}u*\n` +
            `🧠 ${tipReason}\n\n` +
            `⚠️ _Odds Pinnacle._`;

          for (const [userId, prefs] of subscribedUsers) {
            if (!prefs.has('snooker')) continue;
            try { await sendDM(snookerConfig.token, userId, tipMsg); } catch(_) {}
          }
          log('INFO', 'AUTO-SNOOKER', `Tip enviada: ${pickTeam} @ ${pickOdd} | EV:${evPct.toFixed(1)}%`);
          await new Promise(r => setTimeout(r, 3000));
        }
        if (!_drainedSnooker && _hadLiveSnooker) _livePhaseExit('snooker');
      }
  } catch(e) {
    log('ERROR', 'AUTO-SNOOKER', e.message);
    _livePhaseExit('snooker');
  }
  return _hadLiveSnooker;
}
log('INFO', 'BOOT', 'SportsEdge Bot iniciando...');

// ── Validação de variáveis de ambiente ──
(function validateEnv() {
  const oddsKeyPresent = !!(process.env.ODDS_API_KEY || process.env.ODDSPAPI_KEY || process.env.ODDS_PAPI_KEY || process.env.ESPORTS_ODDS_KEY);
  // Chaves globais obrigatórias para operação mínima
  const globalRequired = [
    ['DEEPSEEK_API_KEY', !!process.env.DEEPSEEK_API_KEY, 'IA desativada — nenhuma tip será gerada'],
    ['ODDS_API_KEY',     oddsKeyPresent,                  'odds esports indisponíveis'],
  ];
  for (const [key, present, reason] of globalRequired) {
    if (!present) log('WARN', 'ENV', `${key} ausente — ${reason}`);
  }
  // Por esporte: avisa se habilitado sem token
  for (const [sport, cfg] of Object.entries(SPORTS)) {
    if (!cfg.enabled) continue;
    if (!cfg.token) log('WARN', 'ENV', `${sport}: ENABLED=true mas token Telegram ausente — sport ignorado`);
  }
  // Variáveis opcionais úteis
  const optionals = [
    ['PANDASCORE_TOKEN',   process.env.PANDASCORE_TOKEN,   'dados PandaScore indisponíveis (LoL)'],
    ['THE_ODDS_API_KEY',   process.env.THE_ODDS_API_KEY,   'odds tênis/MMA via TheOdds indisponíveis'],
    ['API_SPORTS_KEY',     process.env.API_SPORTS_KEY || process.env.APISPORTS_KEY, 'dados futebol via API-Sports indisponíveis'],
  ];
  for (const [key, present, reason] of optionals) {
    if (!present) log('WARN', 'ENV', `${key} ausente — ${reason}`);
  }
  log('INFO', 'ENV', `Sports: ${JSON.stringify(Object.entries(SPORTS).map(([k,v]) => ({id: k, enabled: v.enabled, hasToken: !!v.token})))}`);
})();

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
  
  // Suprime notificações de partidas já ao vivo no boot (restart).
  // Marca como "já notificada" para não enviar de novo quando o bot reinicia.
  try {
    const lolList = await serverGet('/lol-matches').catch(() => []);
    const allLive = Array.isArray(lolList) ? lolList.filter(m => m.status === 'live') : [];
    for (const match of allLive.slice(0, 30)) {
      const liveIds = await serverGet(`/live-gameids?matchId=${encodeURIComponent(String(match.id))}`).catch(() => []);
      const currentMap = Array.isArray(liveIds) ? (liveIds.find(x => x.hasLiveData)?.gameNumber || null) : null;
      if (!currentMap) continue;
      const matchKey = `${match.game}_${match.id}`;
      if (!notifiedMatches.has(matchKey)) notifiedMatches.set(matchKey, Date.now());
    }
    if (allLive.length) log('INFO', 'BOOT', `Live notify suprimido no boot: ${allLive.length} partida(s) ao vivo`);
  } catch(_) {}

  // Suprime notificações Dota ao vivo no boot
  try {
    const dotaList = await serverGet('/dota-matches').catch(() => []);
    const live = Array.isArray(dotaList) ? dotaList.filter(m => m.status === 'live') : [];
    for (const match of live.slice(0, 30)) {
      const k = `dota2_${match.id}`;
      if (!notifiedMatches.has(k)) notifiedMatches.set(k, Date.now());
    }
  } catch(_) {}

  // Start polling for each enabled sport
  const polledTokens = new Set();
  for (const [sport, config] of Object.entries(SPORTS)) {
    if (!config.enabled || !config.token) {
      log('WARN', 'BOOT', `${sport}: disabled or no token`);
      continue;
    }

    // Verify token
    const r = await tgRequest(config.token, 'getMe', {});
    if (r.ok) {
      log('INFO', 'BOOT', `${sport}: ${r.result.first_name} (@${r.result.username})`);
      // Dedup: se token é compartilhado (ex: valorant reusa CS), poll só 1x.
      // Callbacks carregam sport em callback_data, então roteamento continua correto.
      if (!polledTokens.has(config.token)) {
        poll(config.token, sport);
        polledTokens.add(config.token);
      } else {
        log('INFO', 'BOOT', `${sport}: compartilha token — poll já iniciado por outro esporte`);
      }
      bots[sport] = config.token;
    } else {
      log('ERROR', 'BOOT', `${sport}: Token inválido`);
    }
  }

  // Background tasks - Agora tudo é unificado via runAutoAnalysis
  setTimeout(() => runAutoAnalysis().catch(e => log('ERROR', 'AUTO', e.message)), 15 * 1000); // 1ª análise 15s após boot
  setInterval(() => runAutoAnalysis().catch(e => log('ERROR', 'AUTO', e.message)), 6 * 60 * 1000);
  // Darts e Snooker: loops independentes (fora do mutex runAutoAnalysis) para não ser
  // bloqueados pelo Football que serializa ~25min por ciclo.
  // Darts: dual-mode scheduling (rápido se live, lento se idle)
  (function scheduleDarts() {
    setTimeout(async () => {
      const hadLive = await runAutoDarts().catch(e => { log('ERROR', 'AUTO-DARTS', e.message); return false; });
      const nextMs = hadLive ? (2 * 60 * 1000) : (15 * 60 * 1000); // 2min live, 15min idle
      log('INFO', 'AUTO-DARTS', `Próximo ciclo em ${Math.round(nextMs / 1000)}s (${hadLive ? 'LIVE' : 'idle'})`);
      scheduleDarts._nextMs = nextMs;
      scheduleDarts();
    }, scheduleDarts._nextMs || 45 * 1000);
  })();
  // Snooker: dual-mode scheduling (rápido se live, lento se idle)
  (function scheduleSnooker() {
    setTimeout(async () => {
      const hadLive = await runAutoSnooker().catch(e => { log('ERROR', 'AUTO-SNOOKER', e.message); return false; });
      const nextMs = hadLive ? (2 * 60 * 1000) : (15 * 60 * 1000); // 2min live, 15min idle
      log('INFO', 'AUTO-SNOOKER', `Próximo ciclo em ${Math.round(nextMs / 1000)}s (${hadLive ? 'LIVE' : 'idle'})`);
      scheduleSnooker._nextMs = nextMs;
      scheduleSnooker();
    }, scheduleSnooker._nextMs || 60 * 1000);
  })();
  setInterval(() => {
    settleCompletedTips().catch(e => log('ERROR', 'SETTLE', e.message));
    checkPendingTipsAlerts().catch(e => log('WARN', 'ALERTS', e.message));
    sendDailySummary().catch(e => log('WARN', 'DAILY', e.message));
  }, SETTLEMENT_INTERVAL);

  // Auto-tune de pesos ML: recalcWeights roda 1x/semana (segunda às 06:00 UTC).
  // Settle de factor logs roda junto com settlement pra manter dados atualizados.
  const WEIGHTS_RECALC_INTERVAL = 6 * 60 * 60 * 1000; // check a cada 6h
  async function runWeeklyRecalc() {
    try {
      const now = new Date();
      const lastRun = global.__lastWeightsRecalc || 0;
      const daysSince = (Date.now() - lastRun) / (24 * 60 * 60 * 1000);
      // Só recalcula se passou ≥7 dias OU é segunda-feira e passou ≥6 dias (buffer)
      const isMonday = now.getUTCDay() === 1 && now.getUTCHours() >= 6;
      if (daysSince < 6) return;
      if (daysSince < 7 && !isMonday) return;

      const { recalcWeights, settleFactorLogs } = require('./lib/ml-weights');
      settleFactorLogs(stmts, log);
      recalcWeights(stmts, log);
      global.__lastWeightsRecalc = Date.now();
    } catch (e) {
      log('ERROR', 'ML-WEIGHTS', `Recalc weekly: ${e.message}`);
    }
  }
  setInterval(() => runWeeklyRecalc().catch(() => {}), WEIGHTS_RECALC_INTERVAL);
  setTimeout(() => runWeeklyRecalc().catch(() => {}), 5 * 60 * 1000); // primeiro check 5min pós-boot
  // Notificações de line movement desativadas a pedido do usuário
  // setInterval(() => checkLineMovement().catch(e => log('ERROR', 'LINE', e.message)), LINE_CHECK_INTERVAL);
  // Alertas críticos: polling /alerts a cada 10 min → DM admins (throttled 1h por alert id)
  setInterval(() => checkCriticalAlerts().catch(e => log('ERROR', 'ALERT', e.message)), 10 * 60 * 1000);
  setTimeout(() => checkCriticalAlerts().catch(() => {}), 30 * 1000); // primeiro check 30s pós-boot

  // Live Scout gaps: alerta admin quando partida live tem stats faltando >5min
  setInterval(() => checkLiveScoutGaps().catch(e => log('ERROR', 'LIVE-SCOUT-ALERT', e.message)), LIVE_SCOUT_CHECK_INTERVAL_MS);
  setTimeout(() => checkLiveScoutGaps().catch(() => {}), 60 * 1000); // primeiro check 60s pós-boot

  // Auto-shadow: avalia CLV a cada 6h e flipa shadowMode pra sports com edge negativo persistente.
  // Default OFF — ativar via AUTO_SHADOW_NEGATIVE_CLV=true
  setInterval(() => checkAutoShadow().catch(e => log('ERROR', 'AUTO-SHADOW', e.message)), AUTO_SHADOW_CHECK_INTERVAL_MS);
  setTimeout(() => checkAutoShadow().catch(() => {}), 5 * 60 * 1000); // primeiro check 5min pós-boot (DB já tá warm)

  // ── Cashout monitor ──
  // Varre tips live pendentes, recomputa P via live stats, notifica admins
  // quando tip está "morrendo". Cada (tipId, verdict) notificado só 1x.
  const _cashoutNotified = new Map(); // key: `${tipId}_${verdict}` → ts
  async function runCashoutMonitor() {
    const { checkTipHealth } = require('./lib/cashout-monitor');
    const sofaDarts = require('./lib/sofascore-darts');
    const nowMs = Date.now();

    // GC: remove entries > 48h pra evitar memory growth em longos uptimes
    for (const [k, ts] of _cashoutNotified) {
      if (nowMs - ts > 48 * 60 * 60 * 1000) _cashoutNotified.delete(k);
    }

    const snap = await serverGet('/live-snapshot').catch(() => ({ sports: {} }));
    const normPair = (a, b) => `${String(a||'').toLowerCase().replace(/[^a-z0-9]/g,'')}_${String(b||'').toLowerCase().replace(/[^a-z0-9]/g,'')}`;

    for (const sport of ['esports', 'lol', 'tennis', 'darts']) {
      const tips = stmts.getUnsettledTips.all(sport, '-3 days').filter(t => t.is_live);
      if (!tips.length) continue;

      for (const tip of tips) {
        const liveCtx = { sport: tip.sport };
        const tipPair = normPair(tip.participant1, tip.participant2);
        const lookupSnap = (sportKey) => (snap.sports?.[sportKey] || []).find(m => {
          const [a, b] = (m.teams || '').split(' vs ');
          return normPair(a, b) === tipPair || normPair(b, a) === tipPair;
        });

        if (tip.sport === 'esports' || tip.sport === 'lol') {
          const m = lookupSnap('lol');
          liveCtx.gameData = m?.summary ? { summary: m.summary } : null;
        } else if (tip.sport === 'tennis') {
          const m = lookupSnap('tennis');
          if (m?.summary?.score) {
            const [sh, sa] = String(m.summary.score).split('-').map(x => parseInt(x, 10));
            liveCtx.liveScore = { isLive: true, setsHome: sh, setsAway: sa };
          }
        } else if (tip.sport === 'darts') {
          const sid = String(tip.match_id || '').replace(/^darts_/, '');
          const ls = await sofaDarts.getLiveScore(sid).catch(() => null);
          if (ls) liveCtx.liveScore = ls;
        }

        const health = checkTipHealth(tip, liveCtx);
        if (health.verdict !== 'dying' && health.verdict !== 'alert') continue;

        const notifyKey = `${tip.id}_${health.verdict}`;
        if (_cashoutNotified.has(notifyKey)) continue;

        const emoji = health.verdict === 'dying' ? '🚨' : '⚠️';
        const label = health.verdict === 'dying' ? 'CASHOUT FORTEMENTE SUGERIDO' : 'Considerar cashout';
        const text = `${emoji} *${label}*\n\n` +
          `Tip #${tip.id}: *${tip.tip_participant}* @ ${tip.odds}\n` +
          `${tip.participant1} vs ${tip.participant2}\n\n` +
          `Prob original: ${(health.originalP * 100).toFixed(0)}%\n` +
          `Prob atual: *${(health.currentP * 100).toFixed(0)}%* (Δ${(health.deltaP * 100).toFixed(0)}pp)\n` +
          `EV atual: *${health.currentEv}%*\n\n` +
          `_${health.reason}_`;

        const token = tip.bot_token || SPORTS[tip.sport]?.token || SPORTS.esports?.token;
        if (!token) continue;
        for (const adminId of ADMIN_IDS) {
          try { await sendDM(token, adminId, text); } catch (_) {}
        }
        _cashoutNotified.set(notifyKey, nowMs);
        log('INFO', 'CASHOUT', `Alert ${health.verdict} enviado: tip #${tip.id} (${tip.tip_participant}) | P ${(health.originalP*100).toFixed(0)}→${(health.currentP*100).toFixed(0)}% EV ${health.currentEv}%`);
      }
    }
  }
  setInterval(() => runCashoutMonitor().catch(e => log('ERROR', 'CASHOUT', e.message)), 2 * 60 * 1000);
  setTimeout(() => runCashoutMonitor().catch(() => {}), 90 * 1000); // primeiro check 90s pós-boot
  if (SPORTS.esports?.enabled) {
    setInterval(() => checkLiveNotifications().catch(e => log('ERROR', 'NOTIFY', e.message)), LIVE_CHECK_INTERVAL);
  }
  // CLV e Refresh de Tips agora são chamados internamente pelo runAutoAnalysis


  // Live odds polling: força atualização de odds para partidas ao vivo a cada 2 min
  // Captura oportunidades quando casas demoram a ajustar linha mid-game
  if (SPORTS.esports?.enabled) {
    setInterval(async () => {
      try {
        const lolRaw = await serverGet('/lol-matches').catch(() => []);
        const live = Array.isArray(lolRaw) ? lolRaw.filter(m => m.status === 'live') : [];
        for (const m of live) {
          await serverGet(`/odds?team1=${encodeURIComponent(m.team1)}&team2=${encodeURIComponent(m.team2)}&force=1&game=lol`).catch(() => null);
        }
        if (live.length > 0) log('DEBUG', 'LIVE-ODDS', `Refresh odds live: ${live.length} partida(s)`);
      } catch(e) { /* silencioso */ }
    }, 2 * 60 * 1000); // a cada 2 min
  }
  
  log('INFO', 'BOOT', `Bots ativos: ${Object.keys(bots).join(', ')}`);
  log('INFO', 'BOOT', 'Pronto! Mande /start em cada bot no Telegram');
})();

// Função para registrar o Closing Line Value (CLV) antes do jogo
// CLV só é válido se registrado próximo ao fechamento da linha (< 1h antes do início)
async function checkCLV(caches = {}) {
  if (subscribedUsers.size === 0) return;
  try {
    const now = Date.now();

    const sportsToTrack = Object.entries(SPORTS)
      .filter(([id, s]) => s && s.enabled && s.token && (id === 'esports' || id === 'football' || id === 'tennis' || id === 'mma' || id === 'darts' || id === 'snooker'))
      .map(([id]) => id);
    if (!sportsToTrack.length) return;

    for (const sport of sportsToTrack) {
      const unsettled = await serverGet('/unsettled-tips', sport).catch(() => []);
      if (!Array.isArray(unsettled) || unsettled.length === 0) continue;

      // Mapa de horário de início por confronto
      const matchTimeMap = {};
      if (sport === 'esports') {
        const lolMatches = caches.esports || await serverGet('/lol-matches').catch(() => []);
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
      } else if (sport === 'football') {
        const matches = caches.football || await serverGet('/football-matches').catch(() => []);
        if (Array.isArray(matches)) {
          for (const m of matches) {
            if (m.time) {
              const k1 = norm(m.team1 || '') + '_' + norm(m.team2 || '');
              const k2 = norm(m.team2 || '') + '_' + norm(m.team1 || '');
              const ts = new Date(m.time).getTime();
              matchTimeMap[k1] = ts;
              matchTimeMap[k2] = ts;
            }
          }
        }
      } else if (sport === 'tennis') {
        const matches = caches.tennis || await serverGet('/tennis-matches').catch(() => []);
        if (Array.isArray(matches)) {
          for (const m of matches) {
            if (m.time) {
              const k1 = norm(m.team1 || '') + '_' + norm(m.team2 || '');
              const k2 = norm(m.team2 || '') + '_' + norm(m.team1 || '');
              const ts = new Date(m.time).getTime();
              matchTimeMap[k1] = ts;
              matchTimeMap[k2] = ts;
            }
          }
        }
      } else if (sport === 'mma') {
        const matches = caches.mma || await serverGet('/mma-matches').catch(() => []);
        caches.mma = matches;
        if (Array.isArray(matches)) {
          for (const m of matches) {
            if (m.time) {
              const k1 = norm(m.team1 || '') + '_' + norm(m.team2 || '');
              const k2 = norm(m.team2 || '') + '_' + norm(m.team1 || '');
              const ts = new Date(m.time).getTime();
              matchTimeMap[k1] = ts;
              matchTimeMap[k2] = ts;
            }
          }
        }
      } else if (sport === 'darts' || sport === 'snooker') {
        const matches = caches[sport] || await serverGet(`/${sport}-matches`).catch(() => []);
        caches[sport] = matches;
        if (Array.isArray(matches)) {
          for (const m of matches) {
            if (m.time) {
              const k1 = norm(m.team1 || '') + '_' + norm(m.team2 || '');
              const k2 = norm(m.team2 || '') + '_' + norm(m.team1 || '');
              const ts = new Date(m.time).getTime();
              matchTimeMap[k1] = ts;
              matchTimeMap[k2] = ts;
            }
          }
        }
      }

      // Reuso de carregamento para evitar N chamadas /matches
      const currentSportMatches = caches[sport] || await serverGet(`/${sport}-matches`).catch(() => []);
      
      for (const tip of unsettled) {
        if (tip.clv_odds) continue; // já registrado

        // Janela CLV: < 3h antes do início (odds já refletem mercado maduro)
        // Antes era 1h — muito restritivo, muitas tips ficavam sem CLV
        const tipKey = norm(tip.participant1 || '') + '_' + norm(tip.participant2 || '');
        const matchStart = matchTimeMap[tipKey] || 0;
        const timeToMatch = matchStart > 0 ? matchStart - now : null;
        if (timeToMatch === null || timeToMatch > 3 * 60 * 60 * 1000 || timeToMatch < -5 * 60 * 1000) continue;

        let clvOdds = null;
        if (sport === 'esports') {
          const o = await serverGet(`/odds?team1=${encodeURIComponent(tip.participant1)}&team2=${encodeURIComponent(tip.participant2)}&game=lol`).catch(() => null);
          if (o && parseFloat(o.t1) > 1) {
            clvOdds = (norm(tip.tip_participant) === norm(tip.participant1)) ? o.t1 : o.t2;
          }
        } else if (sport === 'football') {
          const list = Array.isArray(footballMatches) ? footballMatches : [];
          const p1 = norm(tip.participant1 || '');
          const p2 = norm(tip.participant2 || '');
          const pick = String(tip.tip_participant || '');
          const pickN = norm(pick);
          const m = list.find(x => {
            const a1 = norm(x.team1 || '');
            const a2 = norm(x.team2 || '');
            return (a1 === p1 && a2 === p2) || (a1 === p2 && a2 === p1);
          });
          if (m?.odds) {
            if (pickN === norm(m.team1)) clvOdds = m.odds.h;
            else if (pickN === norm(m.team2)) clvOdds = m.odds.a;
            else if (pickN === 'draw' || pickN === norm('empate')) clvOdds = m.odds.d;
          }
        } else if (sport === 'tennis') {
          const list = Array.isArray(tennisMatches) ? tennisMatches : [];
          const m = findTheOddsH2hMatch(list, tip);
          if (m?.odds) {
            const o = h2hDecimalOddsForPick(m, tip.tip_participant);
            if (o && o > 1) clvOdds = String(o);
          }
        } else if (sport === 'mma') {
          const list = caches.mma || await serverGet('/mma-matches').catch(() => []);
          if (Array.isArray(list) && list.length) {
            const m = findTheOddsH2hMatch(list, tip);
            if (m?.odds) {
              const o = h2hDecimalOddsForPick(m, tip.tip_participant);
              if (o && o > 1) clvOdds = String(o);
            }
          }
        } else if (sport === 'darts' || sport === 'snooker') {
          // Darts/Snooker: compara odds atuais (Sofascore/Pinnacle) com as odds de abertura da tip
          const list = caches[sport] || [];
          const p1n = norm(tip.participant1 || '');
          const p2n = norm(tip.participant2 || '');
          const m = list.find(x => {
            const a1 = norm(x.team1 || ''), a2 = norm(x.team2 || '');
            return (a1 === p1n && a2 === p2n) || (a1 === p2n && a2 === p1n);
          });
          if (m?.odds?.t1 && m?.odds?.t2) {
            const pickN = norm(tip.tip_participant || '');
            const a1 = norm(m.team1 || '');
            clvOdds = pickN === a1 ? m.odds.t1 : m.odds.t2;
          }
        }

        const clvN = parseFloat(clvOdds);
        if (clvN && clvN > 1) {
          await serverPost('/update-clv', { matchId: tip.match_id, clvOdds: clvN }, sport).catch(() => {});
          log('INFO', 'CLV', `Registrado CLV ${clvN} (${sport}) para ${tip.participant1} vs ${tip.participant2}`);
        }
      }
    }
  } catch(e) {}
}

// Reanalisa tips pendentes: atualiza odds/EV no DB e envia update no Telegram.
// Não chama IA: mantém p implícita da tip original e recalcula EV com odds atuais.
async function refreshOpenTips(caches = {}) {
  try {
    const enabledSports = Object.entries(SPORTS)
      .filter(([_, s]) => s && s.enabled && s.token)
      .map(([id]) => id);

    for (const sport of enabledSports) {
      const unsettled = await serverGet('/unsettled-tips?days=30', sport).catch(() => []);
      if (!Array.isArray(unsettled) || unsettled.length === 0) continue;

      const minMovePct = parseFloat(process.env.TIP_UPDATE_MIN_MOVE_PCT || '3'); // 3%
      const now = Date.now();

      // Nunca atualizar odds de partidas em andamento, mesmo se tip.is_live estiver falso.
      let esportsLivePairs = null; // Set("t1|t2")
      let esportsStartedByMatchId = null; // Map<baseId,bool>
      if (sport === 'esports') {
        try {
          const lolList = await serverGet('/lol-matches').catch(() => []);
          const live = Array.isArray(lolList) ? lolList.filter(m => m.status === 'live' || m.status === 'draft') : [];
          esportsLivePairs = new Set(
            live.map(m => {
              const a = norm(m.team1 || ''), b = norm(m.team2 || '');
              return a < b ? `${a}|${b}` : `${b}|${a}`;
            }).filter(Boolean)
          );
        } catch(_) {
          esportsLivePairs = null;
        }
        esportsStartedByMatchId = new Map();
      }

      for (const tip of unsettled) {
        // Esports ao vivo: congela linha; MMA/tênis/futebol podem atualizar odds no dashboard
        if (tip.is_live && sport === 'esports') continue;
        if (sport === 'esports' && String(tip.match_id || '').includes('_MAP')) continue; // tip por mapa = jogo em andamento
        const p1 = tip.participant1 || '';
        const p2 = tip.participant2 || '';
        const pick = tip.tip_participant || '';
        const oldOdds = parseFloat(tip.odds) || 0;
        const oldEv = parseFloat(tip.ev) || 0;
        if (!p1 || !p2 || !pick || oldOdds <= 1) continue;

        // Bloqueio extra: partida atualmente live/draft
        if (sport === 'esports' && esportsLivePairs) {
          const a = norm(p1), b = norm(p2);
          const k = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (esportsLivePairs.has(k)) continue;
        }

        // Bloqueio por match_id: se Riot já reporta games ativos para esse matchId, não atualizar.
        if (sport === 'esports' && esportsStartedByMatchId) {
          const rawMatchId = String(tip.match_id || '');
          const baseId = rawMatchId.replace(/^lol_/, '').replace(/_MAP\d+$/i, '');
          if (baseId && /^\d+$/.test(baseId)) {
            if (!esportsStartedByMatchId.has(baseId)) {
              try {
                const liveIds = await serverGet(`/live-gameids?matchId=${encodeURIComponent(baseId)}`).catch(() => []);
                esportsStartedByMatchId.set(baseId, Array.isArray(liveIds) && liveIds.length > 0);
              } catch(_) {
                esportsStartedByMatchId.set(baseId, false);
              }
            }
            if (esportsStartedByMatchId.get(baseId)) continue;
          }
        }

        let currentOdds = null;
        if (sport === 'esports') {
          const o = await serverGet(`/odds?team1=${encodeURIComponent(p1)}&team2=${encodeURIComponent(p2)}&game=lol`).catch(() => null);
          if (o && parseFloat(o.t1) > 1) {
            currentOdds = norm(pick) === norm(p1) ? parseFloat(o.t1) : parseFloat(o.t2);
          }
        } else if (sport === 'mma') {
          const fights = caches.mma || await serverGet('/mma-matches').catch(() => []);
          if (Array.isArray(fights) && fights.length) {
            const m = findTheOddsH2hMatch(fights, tip);
            if (m?.odds) currentOdds = h2hDecimalOddsForPick(m, pick);
          }
        } else if (sport === 'football') {
          const matches = caches.football || await serverGet('/football-matches').catch(() => []);
          if (matches.length) {
            const n1 = norm(p1), n2 = norm(p2);
            const m = matches.find(x => {
              const a1 = norm(x.team1 || '');
              const a2 = norm(x.team2 || '');
              return (a1 === n1 && a2 === n2) || (a1 === n2 && a2 === n1);
            });
            if (m && (m.status === 'live' || m.status === 'draft')) continue;
            if (m?.odds) {
              const pickN = norm(pick);
              if (pickN === norm(m.team1)) currentOdds = parseFloat(m.odds.h);
              else if (pickN === norm(m.team2)) currentOdds = parseFloat(m.odds.a);
              else if (pickN === 'draw' || pickN === norm('empate')) currentOdds = parseFloat(m.odds.d);
            }
          }
        } else if (sport === 'tennis') {
          const matches = caches.tennis || await serverGet('/tennis-matches').catch(() => []);
          if (matches.length) {
            const m = findTheOddsH2hMatch(matches, tip);
            if (m?.odds) currentOdds = h2hDecimalOddsForPick(m, pick);
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
          `${sport === 'mma' ? '🥊' : '🎮'} *${p1} vs ${p2}*\n` +
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
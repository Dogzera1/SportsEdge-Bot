require('dotenv').config({ override: true });
const TelegramBot = require('node-telegram-bot-api');
const { log, httpGet, fmtDateTime, sleep, safeParse } = require('./lib/utils');
const { initExchange, fetchOHLCV, fetchPrice } = require('./lib/data-engine');
const { generateSignal } = require('./lib/financial-ml');
const { calcStakeUsdt, calcStopTakeProfit, checkCircuitBreaker, checkRiskGuards } = require('./lib/risk-manager');
const { paperOpen, paperClose, checkStopTakeProfit } = require('./lib/executor');
const initDatabase = require('./lib/database');

const SERVER_URL = process.env.SERVER_URL || `http://127.0.0.1:${process.env.SERVER_PORT || 3001}`;
const MODE = (process.env.MODE || 'paper').toLowerCase();
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();
const CYCLE_MIN = parseInt(process.env.CYCLE_MIN || '60'); // ciclo a cada N minutos
const SYMBOLS = (process.env.SYMBOLS || 'BTC/USDT,ETH/USDT').split(',').map(s => s.trim());
const TIMEFRAME = process.env.TIMEFRAME || '1h';
const MIN_CONFIDENCE = process.env.MIN_CONFIDENCE || 'MÉDIA'; // BAIXA | MÉDIA | ALTA
const MIN_EV = parseFloat(process.env.MIN_EV || '3'); // EV mínimo % para abrir trade

let DB_PATH = (process.env.DB_PATH || 'financeedge.db').trim().replace(/^=+/, '');
const { db, stmts } = initDatabase(DB_PATH);

// Configura exchange
const EXCHANGE_NAME = process.env.EXCHANGE_NAME || 'binance';
const EXCHANGE_KEY = process.env.EXCHANGE_API_KEY || '';
const EXCHANGE_SECRET = process.env.EXCHANGE_API_SECRET || '';
if (EXCHANGE_KEY && EXCHANGE_SECRET) {
  initExchange(EXCHANGE_NAME, { apiKey: EXCHANGE_KEY, secret: EXCHANGE_SECRET });
} else {
  initExchange(EXCHANGE_NAME, {});
}

const confidencePriority = { 'ALTA': 3, 'MÉDIA': 2, 'BAIXA': 1 };

/** IDs para alertas e (se definido) restrição de comandos */
function parseChatIds() {
  const raw = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function isCommandAllowed(chatId) {
  const allowed = parseChatIds();
  if (!allowed.length) return true;
  return allowed.some(a => String(chatId) === String(a));
}

let tgBot = null;
/** Token normalizado após init (para gravar em trade se precisar) */
let effectiveTelegramToken = '';

function normalizeTelegramToken(raw) {
  if (raw == null) return '';
  let t = String(raw).trim().replace(/^=+/, '');
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    t = t.slice(1, -1).trim();
  t = t.replace(/^Bearer\s+/i, '').trim();
  return t;
}

async function initTelegramBot() {
  const token = normalizeTelegramToken(process.env.TELEGRAM_TOKEN);
  if (!token) {
    log('WARN', 'TG', 'TELEGRAM_TOKEN ausente — sem polling nem comandos');
    return null;
  }

  const meUrl = `https://api.telegram.org/bot${token}/getMe`;
  const check = await httpGet(meUrl).catch(e => ({ status: 0, body: e.message }));
  const me = safeParse(check.body, {});
  if (check.status !== 200 || me.ok !== true) {
    log('ERROR', 'TG', 'Token Telegram inválido ou revogado (401). Gere outro em @BotFather → /newbot ou /token. No .env: sem aspas, sem espaços, linha TELEGRAM_TOKEN=123456:ABC...');
    if (me.description) log('ERROR', 'TG', `API: ${me.description}`);
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });
  let pollingStopped = false;
  bot.on('polling_error', err => {
    const code = err.response?.statusCode || err.response?.status;
    const msg = String(err.message || err);
    if (!pollingStopped && (code === 401 || msg.includes('401'))) {
      pollingStopped = true;
      try { bot.stopPolling({ cancel: true }); } catch (_) {}
      log('ERROR', 'TG', '401 no polling — token morto. Polling parado. Atualize TELEGRAM_TOKEN e reinicie.');
      return;
    }
    if (!pollingStopped) log('WARN', 'TG', `polling: ${msg}`);
  });

  async function reply(chatId, text, opts = {}) {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts });
  }

  async function guard(msg) {
    if (!isCommandAllowed(msg.chat.id)) {
      await reply(msg.chat.id, '⛔ Chat não autorizado. Configure <code>TELEGRAM_CHAT_ID</code> com este ID ou deixe vazio para aceitar qualquer chat.');
      return false;
    }
    return true;
  }

  function welcomeText(chatId) {
    return [
      '🤖 <b>FinanceEdge</b>',
      '',
      'Comandos:',
      '/status — banca, modo, trades abertos',
      '/abertos — lista de posições abertas',
      '/analise [par] — sinal agora (ex: <code>/analise BTC/USDT</code>)',
      '/sinais — últimos sinais gravados',
      '/ciclo — força uma rodada de análise',
      '/ajuda — esta mensagem',
      '',
      `Seu <code>chat_id</code>: <code>${chatId}</code>`,
      'Use esse valor em <code>TELEGRAM_CHAT_ID</code> no .env para alertas.',
      'Se o ID já estiver no .env e os outros comandos falharem, confira se o número bate exatamente (grupos têm ID negativo).',
    ].join('\n');
  }

  const onCmd = (re, handler, opts = {}) => {
    bot.onText(re, async (msg, match) => {
      try {
        if (!opts.skipGuard && !(await guard(msg))) return;
        await handler(msg, match);
      } catch (e) {
        log('ERROR', 'TG', e.message);
        try { await reply(msg.chat.id, `Erro: ${String(e.message).slice(0, 200)}`); } catch (_) {}
      }
    });
  };

  onCmd(/^\/start(?:@\S+)?$/i, async msg => {
    await reply(msg.chat.id, welcomeText(msg.chat.id));
  }, { skipGuard: true });

  onCmd(/^\/ajuda(?:@\S+)?$/i, async msg => {
    await reply(msg.chat.id, welcomeText(msg.chat.id));
  }, { skipGuard: true });

  onCmd(/^\/status(?:@\S+)?$/i, async msg => {
    const bk = stmts.getBankroll.get();
    const roi = stmts.getROI.get();
    const openCount = stmts.openTradeCount.get()?.c || 0;
    if (!bk) {
      await reply(msg.chat.id, 'Banca não inicializada.');
      return;
    }
    const growthPct = ((bk.current_usdt - bk.initial_usdt) / bk.initial_usdt * 100).toFixed(2);
    const winRate = (roi?.total || 0) > 0 ? ((roi.wins / roi.total) * 100).toFixed(1) : '0.0';
    await reply(msg.chat.id, [
      '📊 <b>Status</b>',
      '',
      `Modo: <b>${MODE.toUpperCase()}</b> | TF: <code>${TIMEFRAME}</code>`,
      `Banca: <b>$${bk.current_usdt.toFixed(2)}</b> (${growthPct >= 0 ? '+' : ''}${growthPct}%)`,
      `Trades abertos: <b>${openCount}</b>`,
      `Histórico: ${roi?.wins || 0}W / ${roi?.losses || 0}L (${winRate}% WR)`,
      `P&amp;L fechado: $${(roi?.total_pnl_usdt || 0).toFixed(2)}`,
    ].join('\n'));
  });

  onCmd(/^\/abertos(?:@\S+)?$/i, async msg => {
    const rows = stmts.getOpenTrades.all();
    if (!rows.length) {
      await reply(msg.chat.id, 'Nenhum trade aberto.');
      return;
    }
    const lines = ['📈 <b>Trades abertos</b>', ''];
    for (const t of rows) {
      const price = await fetchPrice(t.symbol).catch(() => null);
      const unr = price ? ` | spot ~$${price.toFixed(4)}` : '';
      lines.push(`#${t.id} <b>${t.symbol}</b> ${t.direction?.toUpperCase()} @ $${parseFloat(t.entry_price).toFixed(4)}${unr}`);
    }
    await reply(msg.chat.id, lines.join('\n'));
  });

  onCmd(/^\/analise(?:@\S+)?(?:\s+(.+))?$/i, async (msg, match) => {
    let sym = (match[1] || '').trim().replace(/_/g, '/');
    if (!sym) sym = SYMBOLS[0];
    if (!sym.includes('/')) sym = `${sym}/USDT`;
    const candles = await fetchOHLCV(sym, TIMEFRAME, 200);
    const signal = generateSignal(candles, sym, TIMEFRAME);
    if (!signal) {
      await reply(msg.chat.id, `Sem sinal claro para <code>${sym}</code> (${TIMEFRAME}).`);
      return;
    }
    stmts.insertSignal.run({
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      direction: signal.direction,
      confidence: signal.confidence,
      evPct: signal.evPct,
      rsi: signal.rsi,
      macdHist: signal.macdHist,
      bbPosition: signal.bbPosition,
      atr: signal.atr,
      price: signal.price,
      volume: signal.volume,
    });
    const odds = 2.0;
    const bk = stmts.getBankroll.get();
    let stakeUsdt = null;
    let stopLoss;
    let takeProfit;
    if (bk) {
      const st = calcStakeUsdt(bk.current_usdt, signal.evPct, odds, signal.confidence);
      stakeUsdt = st.stakeUsdt;
      const stp = calcStopTakeProfit(signal.price, signal.direction, signal.atr, 1.5, 2.0);
      stopLoss = stp.stopLoss;
      takeProfit = stp.takeProfit;
    }
    await reply(msg.chat.id, formatSignalMsg(signal, stakeUsdt, stopLoss, takeProfit));
  });

  onCmd(/^\/sinais(?:@\S+)?$/i, async msg => {
    const rows = stmts.getLatestSignals.all(8);
    if (!rows.length) {
      await reply(msg.chat.id, 'Nenhum sinal gravado ainda.');
      return;
    }
    const lines = ['📡 <b>Últimos sinais</b>', ''];
    for (const r of rows) {
      lines.push(`${r.symbol} ${r.direction || '—'} ${r.confidence || ''} EV ${r.ev_pct}% @ ${fmtDateTime(r.generated_at)}`);
    }
    await reply(msg.chat.id, lines.join('\n'));
  });

  onCmd(/^\/ciclo(?:@\S+)?$/i, async msg => {
    await reply(msg.chat.id, '⏳ Rodando análise…');
    await runAnalysisCycle();
    await reply(msg.chat.id, '✅ Ciclo concluído.');
  });

  bot.setMyCommands([
    { command: 'start', description: 'Ajuda e seu chat_id' },
    { command: 'status', description: 'Banca e resumo' },
    { command: 'abertos', description: 'Trades abertos' },
    { command: 'analise', description: 'Sinal agora (opcional: par)' },
    { command: 'sinais', description: 'Últimos sinais' },
    { command: 'ciclo', description: 'Forçar análise' },
    { command: 'ajuda', description: 'Ajuda' },
  ]).catch(e => log('WARN', 'TG', `setMyCommands: ${e.message}`));

  effectiveTelegramToken = token;
  log('INFO', 'TG', `Telegram OK @${me.result?.username || '?'} — comandos /start, /status, …`);
  return bot;
}

// ── Telegram (alertas push) ──
async function sendTelegram(msg) {
  if (!tgBot) return;
  const chats = parseChatIds();
  if (!chats.length) {
    log('WARN', 'TG', 'TELEGRAM_CHAT_ID vazio — alertas não enviados (use /start no bot para ver seu chat_id)');
    return;
  }
  for (const chatId of chats) {
    try {
      await tgBot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    } catch (e) {
      log('WARN', 'TG', `sendMessage ${chatId}: ${e.message}`);
    }
  }
}

function formatSignalMsg(signal, stakeUsdt, stopLoss, takeProfit) {
  const emoji = signal.direction === 'long' ? '📈' : '📉';
  const conf = signal.confidence === 'ALTA' ? '🔥' : signal.confidence === 'MÉDIA' ? '⚡' : '💡';
  const lines = [
    `${emoji} <b>SINAL ${signal.direction.toUpperCase()}</b> — ${signal.symbol}`,
    ``,
    `${conf} <b>Confiança:</b> ${signal.confidence}`,
    `📊 <b>EV:</b> ${signal.evPct}%`,
    `💰 <b>Entrada:</b> $${signal.price.toFixed(4)}`,
    `🛑 <b>Stop-Loss:</b> $${stopLoss?.toFixed(4) || '—'}`,
    `🎯 <b>Take-Profit:</b> $${takeProfit?.toFixed(4) || '—'}`,
    `💵 <b>Stake:</b> $${stakeUsdt?.toFixed(2) || '—'} USDT`,
    ``,
    `📉 RSI: ${signal.rsi} | MACD: ${signal.macdHist?.toFixed(4) || '—'}`,
    `📊 BB Pos: ${(signal.bbPosition * 100).toFixed(1)}% | ATR: ${signal.atr?.toFixed(4) || '—'}`,
    ``,
    `💡 ${signal.reasons?.slice(0, 3).join(' | ') || ''}`,
    `⏰ ${fmtDateTime(new Date().toISOString())} | ${TIMEFRAME} | ${MODE.toUpperCase()}`,
  ];
  return lines.join('\n');
}

function formatTradeClosedMsg(trade, closeResult) {
  const emoji = closeResult.result === 'win' ? '✅' : '❌';
  const pnlStr = closeResult.pnlUsdt >= 0
    ? `+$${closeResult.pnlUsdt.toFixed(2)}`
    : `-$${Math.abs(closeResult.pnlUsdt).toFixed(2)}`;
  return [
    `${emoji} <b>TRADE FECHADO</b> — ${trade.symbol}`,
    ``,
    `📌 <b>Direção:</b> ${trade.direction?.toUpperCase()}`,
    `📈 <b>Entrada:</b> $${parseFloat(trade.entry_price).toFixed(4)}`,
    `📉 <b>Saída:</b> $${closeResult.exitPrice.toFixed(4)}`,
    `💰 <b>P&L:</b> ${pnlStr} (${closeResult.pnlPct.toFixed(2)}%)`,
    `💸 <b>Fees:</b> $${closeResult.feesUsdt.toFixed(4)}`,
    `⏰ ${fmtDateTime(new Date().toISOString())}`,
  ].join('\n');
}

// ── Settlement de trades abertos ──
async function checkOpenTrades() {
  const openTrades = stmts.getOpenTrades.all();
  if (!openTrades.length) return;

  for (const trade of openTrades) {
    try {
      const candles = await fetchOHLCV(trade.symbol, trade.timeframe || TIMEFRAME, 5);
      if (!candles || !candles.length) continue;
      const lastCandle = candles[candles.length - 1];
      const trigger = checkStopTakeProfit(trade, lastCandle);

      if (trigger) {
        const closeResult = paperClose(trade, trigger.exitPrice);
        stmts.closeTrade.run(
          closeResult.exitPrice,
          closeResult.result,
          closeResult.pnlUsdt,
          closeResult.pnlPct,
          closeResult.feesUsdt,
          trade.id
        );

        // Atualiza banca
        const bk = stmts.getBankroll.get();
        if (bk) {
          const newBanca = parseFloat((bk.current_usdt + closeResult.pnlUsdt).toFixed(4));
          stmts.updateBankroll.run(newBanca);
          log('INFO', 'SETTLE', `#${trade.id} ${trade.symbol} ${trigger.triggered} | P&L: $${closeResult.pnlUsdt} | banca: $${newBanca}`);
          await sendTelegram(formatTradeClosedMsg(trade, closeResult));
        }
      }
    } catch (e) {
      log('WARN', 'SETTLE', `Erro ao verificar trade #${trade.id}: ${e.message}`);
    }
  }
}

// ── Ciclo principal de análise ──
async function runAnalysisCycle() {
  log('INFO', 'BOT', `Iniciando ciclo de análise (${SYMBOLS.length} símbolos, ${TIMEFRAME})`);

  // Verifica circuit breaker
  const bk = stmts.getBankroll.get();
  if (bk) {
    const recentLosses = db.prepare(`
      SELECT COALESCE(SUM(ABS(pnl_usdt)), 0) as losses
      FROM trades
      WHERE result = 'loss' AND closed_at >= datetime('now', '-24 hours')
    `).get();
    const circuitTripped = checkCircuitBreaker(bk.current_usdt, bk.initial_usdt, recentLosses?.losses || 0);
    if (circuitTripped) {
      log('WARN', 'BOT', 'Circuit breaker ativo — ciclo cancelado');
      await sendTelegram('🚨 <b>CIRCUIT BREAKER ATIVO</b>\nBot pausado por excesso de perdas nas últimas 24h.');
      return;
    }
  }

  // Verifica e fecha trades que atingiram SL/TP
  await checkOpenTrades();

  // Gera sinais para cada símbolo
  const signals = [];
  for (const symbol of SYMBOLS) {
    try {
      const candles = await fetchOHLCV(symbol, TIMEFRAME, 200);
      const signal = generateSignal(candles, symbol, TIMEFRAME);
      if (signal) {
        // Salva sinal no DB
        stmts.insertSignal.run({
          symbol: signal.symbol,
          timeframe: signal.timeframe,
          direction: signal.direction,
          confidence: signal.confidence,
          evPct: signal.evPct,
          rsi: signal.rsi,
          macdHist: signal.macdHist,
          bbPosition: signal.bbPosition,
          atr: signal.atr,
          price: signal.price,
          volume: signal.volume,
        });
        signals.push(signal);
      }
      await sleep(500);
    } catch (e) {
      log('WARN', 'BOT', `Análise ${symbol}: ${e.message}`);
    }
  }

  log('INFO', 'BOT', `${signals.length} sinais gerados`);

  // Filtra e age sobre os melhores sinais
  const confLevel = confidencePriority[MIN_CONFIDENCE] || 2;
  const actionable = signals.filter(s =>
    (confidencePriority[s.confidence] || 0) >= confLevel &&
    s.evPct >= MIN_EV
  );

  for (const signal of actionable) {
    // Verifica se já tem trade aberto para este símbolo
    const alreadyOpen = stmts.tradeExistsOpen.get(signal.symbol);
    if (alreadyOpen) {
      log('INFO', 'BOT', `${signal.symbol}: trade já aberto — pulando`);
      continue;
    }

    const currentBk = stmts.getBankroll.get();
    if (!currentBk) continue;

    const openCount = stmts.openTradeCount.get()?.c || 0;
    const openTrades = stmts.getOpenTrades.all();
    const totalExposure = openTrades.reduce((s, t) => s + (t.stake_usdt || 0), 0);

    const odds = 2.0;
    const { stakeUsdt, stakePct, kellyFraction } = calcStakeUsdt(currentBk.current_usdt, signal.evPct, odds, signal.confidence);
    const { stopLoss, takeProfit } = calcStopTakeProfit(signal.price, signal.direction, signal.atr, 1.5, 2.0);

    const riskCheck = checkRiskGuards(currentBk.current_usdt, openCount, stakeUsdt, totalExposure);
    if (!riskCheck.ok) {
      log('WARN', 'BOT', `${signal.symbol}: risco recusado — ${riskCheck.errors.join(', ')}`);
      continue;
    }

    // Executa paper trade
    const execution = paperOpen(signal, stakeUsdt, stopLoss, takeProfit);
    const result = stmts.insertTrade.run({
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice: execution.entryPrice,
      stopLoss: execution.stopLoss,
      takeProfit: execution.takeProfit,
      stakeUsdt: execution.stakeUsdt,
      stakePct,
      signalConfidence: signal.confidence,
      signalEv: signal.evPct,
      kellyFraction,
      timeframe: TIMEFRAME,
      mode: MODE,
      botToken: effectiveTelegramToken,
    });

    log('INFO', 'BOT', `Trade aberto: ${signal.symbol} ${signal.direction} @ ${execution.entryPrice} | $${execution.stakeUsdt}`);

    // Alerta Telegram
    await sendTelegram(formatSignalMsg(signal, stakeUsdt, stopLoss, takeProfit));
  }

  // Notifica ciclo sem sinais acionáveis
  if (actionable.length === 0 && signals.length === 0) {
    log('INFO', 'BOT', 'Sem sinais no ciclo atual');
  }

  // Registra análise no server
  try {
    const headers = ADMIN_KEY ? { 'x-admin-key': ADMIN_KEY } : {};
    await httpGet(`${SERVER_URL}/record-analysis`, headers).catch(() => {});
  } catch (_) {}
}

// ── Status periódico ──
async function sendStatusReport() {
  const bk = stmts.getBankroll.get();
  const roi = stmts.getROI.get();
  const openCount = stmts.openTradeCount.get()?.c || 0;

  if (!bk) return;
  const growthPct = ((bk.current_usdt - bk.initial_usdt) / bk.initial_usdt * 100).toFixed(2);
  const winRate = (roi?.total || 0) > 0
    ? ((roi.wins / roi.total) * 100).toFixed(1)
    : '0.0';

  const msg = [
    `📊 <b>FinanceEdge — Status Diário</b>`,
    ``,
    `💰 Banca: $${bk.current_usdt.toFixed(2)} (${growthPct >= 0 ? '+' : ''}${growthPct}%)`,
    `🏆 Win Rate: ${winRate}% (${roi?.wins || 0}W / ${roi?.losses || 0}L)`,
    `📈 Trades abertos: ${openCount}`,
    `💵 P&L Total: $${(roi?.total_pnl_usdt || 0).toFixed(2)}`,
    ``,
    `⏰ ${fmtDateTime(new Date().toISOString())} | ${MODE.toUpperCase()}`,
  ].join('\n');

  await sendTelegram(msg);
}

// ── Loop principal ──
async function main() {
  tgBot = await initTelegramBot();

  log('INFO', 'BOT', `FinanceEdge Bot iniciado | modo=${MODE.toUpperCase()} | ciclo=${CYCLE_MIN}min`);
  await sendTelegram(`🚀 <b>FinanceEdge Bot iniciado</b>\nModo: ${MODE.toUpperCase()} | Símbolos: ${SYMBOLS.join(', ')}`);

  // Ciclo inicial
  await runAnalysisCycle().catch(e => log('ERROR', 'BOT', `Ciclo inicial: ${e.message}`));

  // Loop recorrente
  setInterval(async () => {
    await runAnalysisCycle().catch(e => log('ERROR', 'BOT', `Ciclo: ${e.message}`));
  }, CYCLE_MIN * 60 * 1000);

  // Status diário às 9h
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 9 && now.getMinutes() < CYCLE_MIN) {
      await sendStatusReport().catch(() => {});
    }
  }, 60 * 60 * 1000);
}

main().catch(e => {
  log('ERROR', 'BOT', `Fatal: ${e.message}`);
  process.exit(1);
});

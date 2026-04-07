/**
 * backtest.js
 * Backtesting engine para validação estatística da estratégia.
 * Executa a estratégia em dados históricos OHLCV e calcula métricas.
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { generateSignal } = require('./lib/financial-ml');
const { calcStakeUsdt, calcStopTakeProfit } = require('./lib/risk-manager');
const { paperOpen, paperClose } = require('./lib/executor');

// Configuração
const SYMBOL = process.env.BACKTEST_SYMBOL || 'BTC/USDT';
const TIMEFRAME = process.env.BACKTEST_TIMEFRAME || '1h';
const INITIAL_BANKROLL = parseFloat(process.env.BACKTEST_BANKROLL || '10000');
const MIN_CONFIDENCE = process.env.MIN_CONFIDENCE || 'MÉDIA';
const MIN_EV = parseFloat(process.env.MIN_EV || '3');
const ODDS = 2.0; // R:R 2:1

const confidencePriority = { 'ALTA': 3, 'MÉDIA': 2, 'BAIXA': 1 };

/**
 * Carrega dados históricos de arquivo CSV.
 * Formato esperado: timestamp,open,high,low,close,volume
 */
function loadHistoricalData(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Arquivo não encontrado: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  const candles = [];

  // Pula header se existir
  let startIdx = lines[0].includes('timestamp') ? 1 : 0;

  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].trim().split(',');
    if (parts.length < 6) continue;

    candles.push({
      ts: parseInt(parts[0]),
      open: parseFloat(parts[1]),
      high: parseFloat(parts[2]),
      low: parseFloat(parts[3]),
      close: parseFloat(parts[4]),
      volume: parseFloat(parts[5])
    });
  }

  console.log(`📊 Carregados ${candles.length} candles de ${filePath}`);
  return candles;
}

/**
 * Simula trade e calcula P&L.
 */
function simulateTrade(signal, entryCandleIndex, historicalData, bankroll) {
  const entryCandle = historicalData[entryCandleIndex];
  const entryPrice = entryCandle.close;

  // Calcula stake
  const { stakeUsdt } = calcStakeUsdt(bankroll, signal.evPct, ODDS, signal.confidence);
  const { stopLoss, takeProfit } = calcStopTakeProfit(entryPrice, signal.direction, signal.atr, 1.5, 2.0);

  // Executa trade
  const execution = paperOpen(signal, stakeUsdt, stopLoss, takeProfit);

  // Encontra candle onde trade é fechado (SL ou TP)
  for (let i = entryCandleIndex + 1; i < historicalData.length; i++) {
    const candle = historicalData[i];
    const trigger = checkStopTakeProfitBacktest(execution, candle);

    if (trigger) {
      const closeResult = paperClose(execution, trigger.exitPrice);
      return {
        symbol: signal.symbol,
        direction: signal.direction,
        entryPrice: execution.entryPrice,
        exitPrice: closeResult.exitPrice,
        stopLoss,
        takeProfit,
        stakeUsdt: execution.stakeUsdt,
        result: closeResult.result,
        pnlUsdt: closeResult.pnlUsdt,
        pnlPct: closeResult.pnlPct,
        entryIndex: entryCandleIndex,
        exitIndex: i,
        duration: i - entryCandleIndex,
        confidence: signal.confidence,
        evPct: signal.evPct
      };
    }
  }

  // Se não fechou nos dados disponíveis, fecha no último candle
  const lastCandle = historicalData[historicalData.length - 1];
  const closeResult = paperClose(execution, lastCandle.close);
  return {
    symbol: signal.symbol,
    direction: signal.direction,
    entryPrice: execution.entryPrice,
    exitPrice: closeResult.exitPrice,
    stopLoss,
    takeProfit,
    stakeUsdt: execution.stakeUsdt,
    result: closeResult.pnlUsdt >= 0 ? 'win' : 'loss',
    pnlUsdt: closeResult.pnlUsdt,
    pnlPct: closeResult.pnlPct,
    entryIndex: entryCandleIndex,
    exitIndex: historicalData.length - 1,
    duration: historicalData.length - 1 - entryCandleIndex,
    confidence: signal.confidence,
    evPct: signal.evPct,
    note: 'Fechado no final dos dados'
  };
}

/**
 * Verifica SL/TP para backtesting.
 */
function checkStopTakeProfitBacktest(trade, candle) {
  const { stopLoss, takeProfit, direction } = trade;

  if (direction === 'long') {
    if (candle.low <= stopLoss) {
      return { triggered: 'stop_loss', exitPrice: stopLoss };
    }
    if (takeProfit && candle.high >= takeProfit) {
      return { triggered: 'take_profit', exitPrice: takeProfit };
    }
  } else {
    if (candle.high >= stopLoss) {
      return { triggered: 'stop_loss', exitPrice: stopLoss };
    }
    if (takeProfit && candle.low <= takeProfit) {
      return { triggered: 'take_profit', exitPrice: takeProfit };
    }
  }
  return null;
}

/**
 * Calcula métricas estatísticas dos trades.
 */
function calculateMetrics(trades, initialBankroll) {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      message: 'Nenhum trade executado'
    };
  }

  const wins = trades.filter(t => t.result === 'win');
  const losses = trades.filter(t => t.result === 'loss');
  const total = trades.length;
  const winRate = (wins.length / total) * 100;

  const totalPnlUsdt = trades.reduce((sum, t) => sum + t.pnlUsdt, 0);
  const totalPnlPct = (totalPnlUsdt / initialBankroll) * 100;

  const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnlUsdt, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + t.pnlUsdt, 0) / losses.length : 0;
  const avgWinPct = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((sum, t) => sum + t.pnlPct, 0) / losses.length : 0;

  // Profit Factor
  const grossProfit = wins.reduce((sum, t) => sum + Math.abs(t.pnlUsdt), 0);
  const grossLoss = losses.reduce((sum, t) => sum + Math.abs(t.pnlUsdt), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Expectancy
  const expectancy = (winRate/100 * avgWin) - ((100-winRate)/100 * Math.abs(avgLoss));

  // Maximum Drawdown
  let bankroll = initialBankroll;
  let peak = bankroll;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  for (const trade of trades) {
    bankroll += trade.pnlUsdt;
    if (bankroll > peak) peak = bankroll;
    const drawdown = peak - bankroll;
    const drawdownPct = (drawdown / peak) * 100;
    if (drawdownPct > maxDrawdownPct) {
      maxDrawdown = drawdown;
      maxDrawdownPct = drawdownPct;
    }
  }

  // Sharpe Ratio (simplificado)
  const returns = trades.map(t => t.pnlPct / 100);
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? (meanReturn * Math.sqrt(365*24)) / stdDev : 0; // Annualizado

  // Estatísticas por confiança
  const byConfidence = {};
  trades.forEach(trade => {
    const conf = trade.confidence;
    if (!byConfidence[conf]) {
      byConfidence[conf] = { trades: [], wins: 0, losses: 0, totalPnl: 0 };
    }
    byConfidence[conf].trades.push(trade);
    if (trade.result === 'win') byConfidence[conf].wins++;
    else byConfidence[conf].losses++;
    byConfidence[conf].totalPnl += trade.pnlUsdt;
  });

  // Calcular win rate por confiança
  Object.keys(byConfidence).forEach(conf => {
    const data = byConfidence[conf];
    data.winRate = data.trades.length > 0 ? (data.wins / data.trades.length) * 100 : 0;
    data.avgPnl = data.trades.length > 0 ? data.totalPnl / data.trades.length : 0;
  });

  return {
    totalTrades: total,
    wins: wins.length,
    losses: losses.length,
    winRate: parseFloat(winRate.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalPnlUsdt: parseFloat(totalPnlUsdt.toFixed(2)),
    totalPnlPct: parseFloat(totalPnlPct.toFixed(2)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    avgWinPct: parseFloat(avgWinPct.toFixed(2)),
    avgLossPct: parseFloat(avgLossPct.toFixed(2)),
    expectancy: parseFloat(expectancy.toFixed(2)),
    maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
    maxDrawdownPct: parseFloat(maxDrawdownPct.toFixed(2)),
    sharpeRatio: parseFloat(sharpeRatio.toFixed(3)),
    finalBankroll: parseFloat(bankroll.toFixed(2)),
    growthPct: parseFloat(((bankroll - initialBankroll) / initialBankroll * 100).toFixed(2)),
    byConfidence,
    trades // retorna todos os trades para análise detalhada
  };
}

/**
 * Executa backtesting.
 */
async function runBacktest(dataFile) {
  console.log('🚀 Iniciando backtesting...');
  console.log(`📈 Símbolo: ${SYMBOL} | Timeframe: ${TIMEFRAME}`);
  console.log(`💰 Banca inicial: $${INITIAL_BANKROLL.toFixed(2)}`);
  console.log(`🎯 Filtros: Confiança ≥ ${MIN_CONFIDENCE}, EV ≥ ${MIN_EV}%`);

  const historicalData = loadHistoricalData(dataFile);
  if (historicalData.length < 200) {
    console.error('❌ Dados insuficientes para backtesting (mínimo 200 candles)');
    process.exit(1);
  }

  const trades = [];
  let bankroll = INITIAL_BANKROLL;
  const confLevel = confidencePriority[MIN_CONFIDENCE] || 2;

  // Janela deslizante de análise
  const lookback = 200; // candles para análise técnica
  const step = 1; // avança 1 candle por vez

  for (let i = lookback; i < historicalData.length - 1; i += step) {
    const window = historicalData.slice(i - lookback, i);

    try {
      const signal = generateSignal(window, SYMBOL, TIMEFRAME);

      if (signal) {
        // Aplica filtros
        if ((confidencePriority[signal.confidence] || 0) >= confLevel && signal.evPct >= MIN_EV) {
          const trade = simulateTrade(signal, i, historicalData, bankroll);
          trades.push(trade);
          bankroll += trade.pnlUsdt;

          // Pula para após o fechamento do trade
          i = trade.exitIndex;
        }
      }
    } catch (error) {
      console.error(`Erro no candle ${i}: ${error.message}`);
    }

    // Progresso
    if (i % 100 === 0) {
      const progress = ((i / historicalData.length) * 100).toFixed(1);
      console.log(`⏳ Progresso: ${progress}% (${i}/${historicalData.length})`);
    }
  }

  console.log('✅ Backtesting concluído!');
  console.log(`📊 Trades executados: ${trades.length}`);

  const metrics = calculateMetrics(trades, INITIAL_BANKROLL);

  // Relatório
  console.log('\n' + '='.repeat(60));
  console.log('📈 RELATÓRIO DE BACKTESTING');
  console.log('='.repeat(60));
  console.log(`Período: ${historicalData.length} candles`);
  console.log(`Trades: ${metrics.totalTrades} (${metrics.wins}W / ${metrics.losses}L)`);
  console.log(`Win Rate: ${metrics.winRate}%`);
  console.log(`Profit Factor: ${metrics.profitFactor}`);
  console.log(`P&L Total: $${metrics.totalPnlUsdt} (${metrics.totalPnlPct}%)`);
  console.log(`Banca Final: $${metrics.finalBankroll} (${metrics.growthPct}%)`);
  console.log(`Max Drawdown: $${metrics.maxDrawdown} (${metrics.maxDrawdownPct}%)`);
  console.log(`Expectancy: $${metrics.expectancy}`);
  console.log(`Sharpe Ratio: ${metrics.sharpeRatio}`);

  console.log('\n📊 Por Confiança:');
  Object.keys(metrics.byConfidence).forEach(conf => {
    const data = metrics.byConfidence[conf];
    console.log(`  ${conf}: ${data.trades.length} trades | WR: ${data.winRate.toFixed(1)}% | P&L médio: $${data.avgPnl.toFixed(2)}`);
  });

  // Salva resultados em arquivo
  const resultsFile = `backtest_results_${Date.now()}.json`;
  fs.writeFileSync(
    resultsFile,
    JSON.stringify({
      config: { SYMBOL, TIMEFRAME, INITIAL_BANKROLL, MIN_CONFIDENCE, MIN_EV },
      metrics,
      trades: trades.map(t => ({
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        direction: t.direction,
        result: t.result,
        pnlUsdt: t.pnlUsdt,
        pnlPct: t.pnlPct,
        confidence: t.confidence,
        evPct: t.evPct,
        duration: t.duration
      }))
    }, null, 2)
  );

  console.log(`\n💾 Resultados salvos em: ${resultsFile}`);

  return metrics;
}

// Execução
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Uso: node backtest.js <arquivo_csv>');
    console.log('Exemplo: node backtest.js btc_1h_2024.csv');
    console.log('\nFormato CSV esperado: timestamp,open,high,low,close,volume');
    process.exit(1);
  }

  const dataFile = args[0];
  runBacktest(dataFile).catch(error => {
    console.error('❌ Erro no backtesting:', error);
    process.exit(1);
  });
}

module.exports = { runBacktest, calculateMetrics, loadHistoricalData };